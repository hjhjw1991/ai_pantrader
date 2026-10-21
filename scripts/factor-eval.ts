/**
 * 因子评估报表：`pnpm factor:eval`。
 *
 * 把 P1 落库的因子读数（prediction_factor）跑成一张可读的表：
 * 每个因子的横截面 IC / IR / t / 判读，以及分组检验的各组均值与头部超额。
 *
 * 只读。样本不够时如实报「样本不足」，不给可用性结论 —— 那正是这套东西
 * 和"拍脑袋调权重"的区别：样本不够就不许下结论。
 */
import { loadCliEnv } from "@/lib/config";
loadCliEnv();
import { openDb } from "@/lib/db";
import type { EvalHorizon } from "@/lib/ledger/query";
import { MIN_OBS, evalFactorIc, evalFactorQuantiles } from "@/lib/ledger/factor-eval";

const args = process.argv.slice(2);
const horizonArg = args.find((a) => a.startsWith("--horizon="));
const horizon = horizonArg ? Number(horizonArg.split("=")[1]) as EvalHorizon : undefined;
const groupsArg = args.find((a) => a.startsWith("--groups="));
const groups = groupsArg ? Number(groupsArg.split("=")[1]) : 5;

const db = openDb();

const factors = db.prepare(
  `SELECT factor_name, scope, COUNT(*) n, SUM(value IS NULL) nulls
   FROM prediction_factor GROUP BY factor_name, scope ORDER BY scope, factor_name`
).all() as Array<{ factor_name: string; scope: "stock" | "env"; n: number; nulls: number }>;

if (factors.length === 0) {
  console.log("prediction_factor 一行都没有 —— 因子读数还没有落过库。");
  console.log("P1 的落库在每次出推荐批次时写，等下一个批次跑完再来。");
  db.close();
  process.exit(0);
}

const pct = (x: number | null, d = 2) => (x === null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`);
const num = (x: number | null, d = 3) => (x === null ? "—" : x.toFixed(d));

console.log(`# 因子评估（horizon=${horizon ?? "全部"}，分组数=${groups}，最少样本 ${MIN_OBS}）\n`);

for (const f of factors) {
  if (f.nulls === f.n) {
    console.log(`## ${f.factor_name}（${f.scope}）· ${f.n} 条\n- 全是定性读数（value 为 NULL），不做数值评估（硬转数字就是伪造）\n`);
    continue;
  }
  const opts = horizon ? { horizon } : {};
  const ic = evalFactorIc(db, f.factor_name, f.scope, opts);
  const q = f.scope === "stock"
    ? evalFactorQuantiles(db, f.factor_name, f.scope, { ...opts, groups })
    : null;

  console.log(`## ${f.factor_name}（${f.scope}）· 读数 ${f.n} 条（其中 ${f.nulls} 条定性）`);
  if (ic.nObs === 0) {
    console.log("- 没有可评估观测（取不到基准价或 horizon 末价，或样本全被排除）\n");
    continue;
  }
  console.log(
    `- IC 均值 ${num(ic.icMean)}（横截面 ${ic.nCross} 个 / 观测 ${ic.nObs} 条）` +
    `　IC 标准差 ${num(ic.icStd)}　IR ${num(ic.ir)}　t ${num(ic.tStat)}　→ **${ic.verdict}**`
  );
  if (ic.verdict === "样本不足") {
    console.log(`- 样本不足 ${MIN_OBS} 条，不下可用性结论\n`);
    continue;
  }
  if (q) {
    const g = q.groups
      .map((x) => `G${x.g}:${x.n === 0 ? "—" : pct(x.meanFwdPct)}`)
      .join("  ");
    console.log(`- 各组均值　${g}`);
    console.log(
      `- 头部（G${groups}）${pct(q.headMeanPct)}　全样本 ${pct(q.baseMeanPct)}　` +
      `**头部超额 ${pct(q.headEdgePct)}**　单调性 ${num(q.monotonicity)}`
    );
    if (q.headEdgePct !== null && q.headEdgePct <= 0 && (ic.icMean ?? 0) > 0) {
      console.log("- ⚠ IC 为正但头部无超额：因子靠「排除差的」贡献相关，真正会按它买的那一段没有超额 —— 不能按它加权重");
    }
  }
  console.log();
}

db.close();
