/**
 * 影子盘毕业与切换的命令行。
 *
 * 用法：
 *   pnpm shadow:switch                         看板：在任者、各挑战者离毕业还差什么、待批提案、切换历史
 *   pnpm shadow:switch approve <id>            批准待批提案（写策略文件、升版本号，明天盘前起生效）
 *   pnpm shadow:switch reject <id> [理由]       否决；该变体再攒 20 个交易日新样本才重新参评
 *   pnpm shadow:switch rollback [理由]          撤销最近一次切换；之后要人重新批 2 次才恢复自动
 *   pnpm shadow:switch add <id> <名称> '<槽位JSON>' [说明]   新增一个变体，次日盘前起出信号
 *   pnpm shadow:switch retire <id>             退役一个变体（样本保留）
 *
 * 例：pnpm shadow:switch add cycle+weighted 五段+可配权重 '{"择时器":{"用":"五段状态机"},"评估器":{"用":"可配权重打分"}}'
 */
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { switchStatus, approveSwitch, rejectSwitch, rollbackSwitch, type GradCheck } from "@/lib/shadow/switch";
import { addVariant, retireVariant, seedVariants } from "@/lib/shadow/book";

const db = openDb();
runMigrations(db);
seedVariants(db);
const [cmd, ...args] = process.argv.slice(2);

const pct = (x: number | null) => (x === null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`);
const line = (g: GradCheck) =>
  `${g.passed ? "✔" : " "} ${g.name}（${g.variant}）| ${g.days} 天 ${g.settled} 笔 | 期望 ${pct(g.meanNet)} 对 ${pct(g.incumbentMean)} | ` +
  `t ${g.t?.toFixed(2) ?? "—"} | 回撤 ${g.maxDrawdown?.toFixed(1) ?? "—"} 对 ${g.incumbentMaxDrawdown?.toFixed(1) ?? "—"}` +
  (g.failures.length > 0 ? `\n      还差：${g.failures.join("；")}` : "");

try {
  switch (cmd) {
    case undefined:
    case "status": {
      const s = switchStatus(db);
      console.log(`正式策略 ${s.strategyId}@${s.version}，在任组合：${s.incumbent ?? "（槽位没有登记为变体，无从比较）"}`);
      console.log(`自动切换：${s.autoAllowed ? "已开启" : `未开启（再人批 ${s.approvalsUntilAuto} 次）`}`);
      console.log("\n挑战者（只看实盘影子样本、与在任者共同结清的交易日）：");
      for (const g of s.board) console.log(line(g));
      if (s.pending !== null) console.log(`\n待批提案 #${s.pending.id}：${s.pending.fromVariant} → ${s.pending.toVariant}`);
      if (s.history.length > 0) {
        console.log("\n切换历史：");
        for (const h of s.history) {
          console.log(`  #${h.id} ${h.kind} ${h.status} ${h.fromVariant} → ${h.toVariant}` +
            `${h.decidedBy ? `（${h.decidedBy === "human" ? "人批" : "自动"}）` : ""} ${h.proposedAt.slice(0, 10)}` +
            `${h.toVersion ? ` 版本 ${h.fromVersion} → ${h.toVersion}` : ""}${h.note ? ` · ${h.note}` : ""}`);
        }
      }
      break;
    }
    case "approve": {
      const r = approveSwitch(db, Number(args[0]), "human");
      console.log(`已切换：${r.fromVariant} → ${r.toVariant}，策略版本 ${r.fromVersion} → ${r.toVersion}`);
      break;
    }
    case "reject": {
      const r = rejectSwitch(db, Number(args[0]), args[1] ?? null);
      console.log(`已否决 #${r.id}（${r.toVariant}）`);
      break;
    }
    case "rollback": {
      const r = rollbackSwitch(db, args[0] === undefined ? {} : { note: args[0] });
      console.log(`已回滚：${r.fromVariant} → ${r.toVariant}，策略版本 ${r.fromVersion} → ${r.toVersion}`);
      break;
    }
    case "add": {
      const [id, name, json, note] = args;
      if (!id || !name || !json) throw new Error("用法：add <id> <名称> '<槽位JSON>' [说明]");
      addVariant(db, { id, name, slots: JSON.parse(json), note: note ?? "" });
      console.log(`已登记变体 ${id}，下一次盘前计划起出信号`);
      break;
    }
    case "retire": {
      retireVariant(db, args[0], switchStatus(db).incumbent);
      console.log(`已退役 ${args[0]}`);
      break;
    }
    default:
      throw new Error(`不认识的子命令：${cmd}`);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  db.close();
}
