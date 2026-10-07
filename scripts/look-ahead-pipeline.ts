/**
 * 全流水线未来函数检测。
 *
 * t13 只测了 identifyMainlines 一个环节，而回放数字来自整条链路
 * （主线 → 候选源 → 评估器 → 买点 → size）。任一步偷看未来，694 天的
 * 所有结论作废，且不报错。所以这里对 runShadowDay 整体做截断重算对比。
 *
 * 插入方式：克隆变体 id（加 #probe 后缀）。判重键是 (变体, 来源, 基准日)，
 * 新 id 不会撞已有行；算完从主库删掉这些探针行，主库维持原状。
 */
import { loadCliEnv } from "@/lib/config";
loadCliEnv();
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { loadStrategyFile } from "@/lib/strategy/loader";
import { activeStrategyPath } from "@/lib/strategy/registry";
import { activeVariants, runShadowDay, seedVariants, type ActiveVariant } from "@/lib/shadow/book";

const D = process.argv[2] ?? "2025-06-10";
const SCRATCH = "E:/project/PanTraderData/data/lookahead_probe.db";
const main = openDb();
runMigrations(main);
seedVariants(main);
const path = activeStrategyPath();
if (path === null) throw new Error("没有生效的策略文件");
const { config } = loadStrategyFile(path);
const base = activeVariants(main);
const probe: ActiveVariant[] = base.map(v => ({ ...v, id: `${v.id}#probe` } satisfies ActiveVariant));

function run(db: ReturnType<typeof openDb>, tag: string) {
  const t0 = Date.now();
  const r = runShadowDay(db, {
    // 必须是一个合法的 Phase。早先这里写的是 "collect"（不是 Phase 的取值），
    // tsx 不做类型检查所以跑得起来，行为上等同于盘后（ decideHolding 只判 phase === "盘中" ），
    // 结论不受影响 —— 但任由一个非法值留在测试脚本里，下次改判据时就会咬人。
    decidedOn: D, baseDate: D, asOf: `${D} 15:05:00`, phase: "盘后",
    config, source: "replay", variants: probe,
  });
  console.log(`${tag}: 变体 ${r.variants} 记录 ${r.recorded} 跳过 ${r.skipped.length} 失败 ${r.failed.length} (${Math.round((Date.now()-t0)/1000)}s)`);
  if (r.failed.length) console.log("   失败明细:", r.failed.slice(0,3).map(f=>`${f.variant}: ${f.error}`).join(" | "));
  return r;
}
const rowsOf = (db: ReturnType<typeof openDb>) =>
  (db.prepare(`SELECT variant_id, code, trigger_px, stop_px, target_px, size, score, stage
     FROM shadow_pred WHERE source='replay' AND base_date=? AND variant_id LIKE '%#probe'
     ORDER BY variant_id, code`).all(D) as any[])
   .map(r => [r.variant_id, r.code, r.trigger_px, r.stop_px, r.target_px, r.size, r.score, r.stage].join("|"));

run(main, "主库（全量）");
const a = rowsOf(main);
main.prepare(`DELETE FROM shadow_outcome WHERE pred_id IN (SELECT id FROM shadow_pred WHERE variant_id LIKE '%#probe' AND base_date=?)`).run(D);
main.prepare(`DELETE FROM shadow_pred WHERE variant_id LIKE '%#probe' AND base_date=?`).run(D);
const 剩余 = main.prepare(`SELECT COUNT(*) c FROM shadow_pred WHERE variant_id LIKE '%#probe'`).get() as { c: number } | undefined;
console.log(`主库已清理探针行，剩余: ${剩余?.c ?? "?"}`);
main.close();

const scratch = openDb(SCRATCH);
runMigrations(scratch);
seedVariants(scratch);
run(scratch, "副本（已删未来）");
const b = rowsOf(scratch);
scratch.close();

console.log(`\n基准日 ${D}：主库 ${a.length} 行 / 副本 ${b.length} 行`);
if (a.length !== b.length) {
  console.log(">>> 行数不同 ✗");
  const sa = new Set(a), sb = new Set(b);
  for (const x of a.filter(v=>!sb.has(v)).slice(0,8)) console.log("  仅主库:", x);
  for (const x of b.filter(v=>!sa.has(v)).slice(0,8)) console.log("  仅副本:", x);
} else {
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { if (diff < 8) console.log(`  第${i}行 主库[${a[i]}] 副本[${b[i]}]`); diff++; }
  console.log(diff === 0 ? ">>> 未检出未来函数：全流水线输出逐字段一致 ✓" : `>>> 检出 ${diff} 处不一致 ✗`);
}
