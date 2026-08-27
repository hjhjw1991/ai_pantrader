/**
 * 单次执行一个采集 job。OS 级定时任务（launchd / schtasks）走的就是这条路径。
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
 */
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { createClient } from "@/lib/data/client";
import { runJob, type JobName } from "@/lib/data/jobs";
import { claimSlot, finishSlot, type Runner } from "@/lib/data/scheduler";
import { slotForNow } from "@/lib/data/schedule";
import { shanghaiTs } from "@/lib/data/clock";
import { runPreopenPlan } from "@/lib/plan/preopen";
import { runSignalWatch } from "@/lib/plan/watch";

const argv = process.argv.slice(2);
const name = argv[0] as JobName;
const force = argv.includes("--force");
if (!name || name.startsWith("--")) {
  console.error("usage: pnpm job <selfcheck|preopen|intraday|close|post|night> [--force]");
  process.exit(2);
}

/**
 * 谁在跑。安装脚本把 `--runner=launchd` / `--runner=schtasks` 写进任务命令行 ——
 * 用命令行而不是环境变量，是因为 schtasks 的 /TR 只接受一条命令，
 * 塞环境变量得再套一层 cmd /c，两个平台的做法就分叉了。
 *
 * 不按平台猜：macOS 上手敲一次 `pnpm job night` 并不是 launchd 跑的，
 * 记成 launchd 会让日后查"这条是自动跑的还是人补的"永远查不清。
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
};

try {
  // 同 daemon：组装根负责把上层实现注进来
  const r = await runJob(name, { db, clients, now, planPreopen: runPreopenPlan, signalWatch: runSignalWatch });
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
