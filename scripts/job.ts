/**
 * 手动执行一个采集 job（补数据、排查用）。日常采集由守护进程的进程内调度完成。
 *
 * **必须先认领 job_run 再执行**：进程内调度器靠 (date, job, slot) 主键去重，
 * 这里若直接调 runJob，两套机制就互相看不见 —— 实测 2026-08-21，launchd 在 18:40
 * 和 22:00 跑完 post/night 之后，网页一启动，进程内调度器发现表里没记录，
 * 又把两个 job 整个跑了一遍。盘中 48 个时点各拉 5887 只快照，翻倍就是白烧一天的
 * 限频额度，而几个免费源都很容易限频（东财实测十几次请求就整体掉线）。
 *
 * 用法：
 *   pnpm job <selfcheck|preopen|intraday|close|post|night>
 *   pnpm job night --force    不认领、也不受已认领影响，强制跑一次（人工补数据用）
 *   pnpm job sector           只刷 代码→行业 映射（不计入调度时点，也不看 7 天过期）
 *   pnpm job adjfix            把写坏的复权因子按「顺延上一根」纠正（纯本地，幂等）
 *
 * sector 是单独开的口子：映射表默认 7 天一刷，而它一旦是空的/缺一大半，
 * 「量价」候选来源会整路关掉（engine 查不到行业就不出候选）。补数据的时候
 * 不可能等下一次 night，所以要有即跑即生效的入口。
 */
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { createClient } from "@/lib/data/client";
import { runJob, type JobName } from "@/lib/data/jobs";
import { refreshSectorMembers } from "@/lib/data/collectors/cross-section";
import { repairTrailingAdjFactors } from "@/lib/data/collectors/daily";
import { claimSlot, finishSlot, type Runner } from "@/lib/data/scheduler";
import { slotForNow } from "@/lib/data/schedule";
import { shanghaiTs } from "@/lib/data/clock";
import { runPreopenPlan } from "@/lib/plan/preopen";
import { runSignalWatch } from "@/lib/plan/watch";
import { runWeeklyReview } from "@/lib/plan/review";
import { runNightlyDerived } from "@/lib/plan/derived";
// CLI 不读 .env.local（只有 next 会读），这里补上，免得在默认目录上新建/操作一个空库
import { loadCliEnv } from "@/lib/config";
loadCliEnv();

const argv = process.argv.slice(2);
/** 原始参数名。sector 不是 JobName（它不落在调度时点上），所以比类型宽一档 */
const argvName = argv[0] ?? "";
const name = argvName as JobName;
const force = argv.includes("--force");
if (!argvName || argvName.startsWith("--")) {
  console.error("usage: pnpm job <selfcheck|preopen|intraday|close|post|night|sector> [--force]");
  process.exit(2);
}

/**
 * 谁在跑：默认 manual，可用 --runner=… 指定。旧版的 launchd / schtasks 任务就是这样标明身份的，
 * 旧机器上若还有残留任务在跑，job_run 里能认出来（pnpm env:doctor 会提示删掉它们）。
 */
const RUNNERS: Runner[] = ["scheduler", "launchd", "schtasks", "manual"];
const isRunner = (v: string | undefined): v is Runner =>
  v !== undefined && (RUNNERS as string[]).includes(v);

const flagRunner = argv.find(a => a.startsWith("--runner="))?.slice("--runner=".length);
const runner: Runner = isRunner(flagRunner)
  ? flagRunner
  : isRunner(process.env.PANTRADER_RUNNER) ? process.env.PANTRADER_RUNNER : "manual";

const db = openDb();
runMigrations(db);

const now = new Date();
const date = shanghaiTs(now).slice(0, 10);

const slot = force ? null : slotForNow(name, now);

// 落在某个时点上就去抢；抢不到说明别人已经在跑或跑完了，本次直接放手。
// 不落在任何时点上（人手临时执行、或迟到太多）则照跑但不认领，别去占调度器的坑。
if (slot !== null && !claimSlot(db, date, name, slot, runner)) {
  console.log(JSON.stringify({ name, slot, skipped: true, reason: "该时点已被其它 runner 认领" }));
  db.close();
  process.exit(0);
}

const clients = {
  sina: createClient("sina", { minIntervalMs: 300, db }),
  tencent: createClient("tencent", { minIntervalMs: 300, db }),
  eastmoney: createClient("eastmoney", { minIntervalMs: 500, db }),
  sw: createClient("sw", { minIntervalMs: 800, db }),
  ths: createClient("ths", { minIntervalMs: 800, db }),
};

/**
 * sector：只刷 代码→行业 映射。不认领调度时点、不看 7 天过期 ——
 * 它是人工补数据的口子，不该去占调度器的坑（占了会让进程内调度以为已经跑过）。
 */
if (argvName === "sector") {
  try {
    const r = await refreshSectorMembers(db, clients.eastmoney);
    console.log(JSON.stringify(r));
    db.close();
    process.exit(0);
  } catch (e: any) {
    console.error(JSON.stringify({ name, error: e?.message ?? String(e) }));
    db.close();
    process.exit(1);
  }
}

/**
 * adjfix：只把写坏的复权因子按"顺延上一根"纠正回来。纯本地 SQL、不发网络请求、
 * 幂等 —— 怀疑 K 线跳了一个数量级的时候先跑它，比重新拉一遍日线便宜三个数量级。
 * 与 sector 一样不占调度时点。
 */
if (argvName === "adjfix") {
  const n = repairTrailingAdjFactors(db);
  console.log(JSON.stringify({ name: "adjfix", fixedRows: n }));
  db.close();
  process.exit(0);
}

try {
  // 同 daemon：组装根负责把上层实现注进来
  const r = await runJob(name, {
    db, clients, now,
    planPreopen: runPreopenPlan, signalWatch: runSignalWatch, weeklyReview: runWeeklyReview,
    buildDerived: runNightlyDerived,
  });
  // 认领了就必须回填，否则这个时点会永远卡在 running，
  // 下次唤醒补偿会把它当成残留回收，等于白跑一趟
  if (slot !== null) finishSlot(db, date, name, slot, "done", r.stats);
  console.log(JSON.stringify(slot === null ? r : { ...r, slot, runner }));
  db.close();
  process.exit(0);
} catch (e: any) {
  const msg = e?.message ?? String(e);
  if (slot !== null) finishSlot(db, date, name, slot, "failed", undefined, msg);
  console.error(JSON.stringify({ name, slot, error: msg }));
  db.close();
  process.exit(1);
}
