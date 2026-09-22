/**
 * v1 ↔ v2 引擎对照：真实因子 + 真实库 + 最近 N 个交易日。
 *
 * 用法：pnpm parity [天数]     默认 40 天。不一致或抛错时退出码非 0。
 *
 * 为什么不做成单元测试：它要读 ~/PanTraderData 的真库，而单元测试一律跑在
 * mkdtemp 的临时库上（真库有定时任务在写）。所以它是脚本，不是 test。
 *
 * 为什么必须有它：parity 单测里的因子全是手捏的桩，覆盖不到真实因子在真实数据上
 * 会走的分支 —— 空截面、低置信降级、代理重建、行业映射缺失。第 0 期的教训很直接：
 * 单元测试全绿的时候，两个真缺陷（半张快照堵重试、采成功不销账）一个都没暴露。
 *
 * **v2 的 baseline 槽组合必须与 v1 逐字段一致**，这是"新策略必须打赢 baseline
 * 才准毕业"那条门槛的前提：对照组若与历史口径对不上，赢了输了都说明不了任何事。
 * 所以 v1 退役之前，每次动 v2 都该跑一遍这个。
 *
 * 已知的唯一合法差异是 warnings 的**顺序**：v2 把主线识别拆成了独立的槽，
 * 于是它先于环境因子求值。内容一条不少一条不多，所以这里按集合比。
 */
import { openDb } from "@/lib/db";
import { createSqliteView } from "@/lib/pit/sqlite-view";
import { defaultRegistry } from "@/lib/factors";
import { createStrategyEngine } from "@/lib/strategy/engine";
import { createV2Engine, createSlotRegistry, BASELINE_SLOTS } from "@/lib/strategy/v2";
import { loadStrategyFile } from "@/lib/strategy/loader";
import { activeStrategyPath } from "@/lib/strategy/registry";
import { positions as loadPositions, sectorMap } from "@/lib/ui/queries";

const N = Number(process.argv[2] ?? 40);

function diffCard(a: any, b: any): string[] {
  const out: string[] = [];
  const eq = (k: string, x: unknown, y: unknown) => {
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push(k);
  };
  eq("ts", a.ts, b.ts);
  eq("phase", a.phase, b.phase);
  eq("strategyId", a.strategyId, b.strategyId);
  eq("strategyName", a.strategyName, b.strategyName);
  eq("env.gear", a.env.gear, b.env.gear);
  eq("env.targetPosition", a.env.targetPosition, b.env.targetPosition);
  eq("env.reasons", a.env.reasons, b.env.reasons);
  eq("env.lowConfidenceFactors", a.env.lowConfidenceFactors, b.env.lowConfidenceFactors);
  // 比全量而不是只比名字：value / confidence / label 变了必须能看见
  eq("env.factors", a.env.factors, b.env.factors);
  eq("candidates", a.candidates, b.candidates);
  eq("holdings", a.holdings, b.holdings);
  // warnings 比集合：v2 把主线识别拆成独立槽，告警产生**顺序**变了，内容不该变
  eq("warnings(set)", [...a.warnings].sort(), [...b.warnings].sort());
  return out;
}

async function main() {
  const db = openDb();
  const path = activeStrategyPath();
  if (path === null) throw new Error("没有生效的策略文件");
  const { config } = loadStrategyFile(path);

  const v1 = createStrategyEngine({ registry: defaultRegistry });
  const v2 = createV2Engine({
    registry: defaultRegistry,
    slots: createSlotRegistry([...BASELINE_SLOTS]),
  });

  const days: string[] = db.prepare(
    "SELECT date FROM trading_calendar WHERE is_open = 1 AND date <= date('now') ORDER BY date DESC LIMIT ?"
  ).all(N).map((r: any) => r.date).reverse();

  const pos = loadPositions(db).map((p: any) => ({
    account: p.account, code: p.code, cost: p.cost, qty: p.qty, stopPx: p.stopPx,
  }));
  const sm = sectorMap(db);

  let ok = 0, mismatch = 0, errored = 0;
  const gears: Record<string, number> = {};
  const problems: Array<{ date: string; fields: string[] }> = [];
  let candTotal = 0, holdTotal = 0, warnTotal = 0;

  for (const date of days) {
    const asOf = `${date} 15:05:00`;
    try {
      const mk = () => ({
        view: createSqliteView(db, asOf), config, phase: "盘后" as const, positions: pos,
        sectorOf: (code: string) => sm.byCode.get(code) ?? null,
        ...(sm.at === null ? {} : { sectorMapAt: sm.at }),
      });
      const a = v1(mk());
      const b = v2(mk());
      gears[a.env.gear] = (gears[a.env.gear] ?? 0) + 1;
      candTotal += a.candidates.length;
      holdTotal += a.holdings.length;
      warnTotal += a.warnings.length;
      const d = diffCard(a, b);
      if (d.length === 0) ok++;
      else { mismatch++; problems.push({ date, fields: d }); }
    } catch (e) {
      errored++;
      problems.push({ date, fields: [`抛错: ${(e as Error).message}`] });
    }
  }

  console.log(JSON.stringify({
    交易日数: days.length, 区间: [days[0], days[days.length - 1]],
    一致: ok, 不一致: mismatch, 抛错: errored,
    档位分布: gears,
    v1候选合计: candTotal, v1持仓动作合计: holdTotal, v1告警合计: warnTotal,
    问题明细: problems.slice(0, 10),
  }, null, 2));
  db.close();
  if (mismatch > 0 || errored > 0) process.exit(1);
}
main().catch(e => { console.error("FAILED:", e); process.exit(1); });
