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
 *   pnpm job <selfcheck|preopen|plan|intraday|close|post|night>
 *   pnpm job night --force    不认领、也不受已认领影响，强制跑一次（人工补数据用）
 *   pnpm job sector           只刷 代码→行业 映射（不计入调度时点，也不看 7 天过期）
 *   pnpm job adjfix            把写坏的复权因子按「顺延上一根」纠正（纯本地，幂等）
 *
 * 补历史数据用 `--at`（`pnpm backfill` 是它的同义入口，见下）：
 *   pnpm backfill night --at 2026-10-08         单时点的 job 可以只给日期
 *   pnpm backfill close --at 2026-10-08T15:05:00+08:00
 *   pnpm backfill night --at 2026-10-08 --derived=light
 *
 * `--at` 给的是"当作几点"，runJob 里所有日期都由它推出来，所以补哪一趟就认领
 * 那一天那一个时点 —— 补完账本上是真的补齐了，不再需要临时脚本。
 * 硬闸见 lib/data/backfill-at.ts：落在时刻表之外、补到未来、以及给源上没有历史
 * 接口的 job（close/intraday/plan）补一个非今天的日期，都会被挡下来。
 *
 * `--derived` 只对 night 生效：
 *   full（默认）整条派生链，含影子盘结算与毕业判定
 *   light        只建情绪截面 + 代理截面（盘中补数的口径，不动影子盘与策略文件）
 *   skip         派生表整个不跑
 * light 是故意开的口子：夜里那一趟会结算影子盘、判定毕业并改写策略 YAML，
 * 补一个历史日期时不该顺手动这些。
 *
 * sector 是单独开的口子：映射表默认 7 天一刷，而它一旦是空的/缺一大半，
 * 「量价」候选来源会整路关掉（engine 查不到行业就不出候选）。补数据的时候
 * 不可能等下一次 night，所以要有即跑即生效的入口。
 */
import { openDb, type Db } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { createClient } from "@/lib/data/client";
import { runJob, type JobName } from "@/lib/data/jobs";
import { refreshSectorMembers } from "@/lib/data/collectors/cross-section";
import { repairTrailingAdjFactors } from "@/lib/data/collectors/daily";
import { claimSlot, reclaimSlot, finishSlot, type Runner } from "@/lib/data/scheduler";
import { slotForNow } from "@/lib/data/schedule";
import { planBackfill, crossDayWarning, type BackfillPlan } from "@/lib/data/backfill-at";
import { shanghaiTs, addDays } from "@/lib/data/clock";
import { runPreopenPlan } from "@/lib/plan/preopen";
import { runSignalWatch } from "@/lib/plan/watch";
import { runWeeklyReview } from "@/lib/plan/review";
import { runNightlyDerived, buildSentiment, buildCrossProxy } from "@/lib/plan/derived";
import { flushPushes, readPushConfig } from "@/lib/ui/push";
// CLI 不读 .env.local（只有 next 会读），这里补上，免得在默认目录上新建/操作一个空库
import { loadCliEnv } from "@/lib/config";
loadCliEnv();

const argv = process.argv.slice(2);
/** 原始参数名。sector 不是 JobName（它不落在调度时点上），所以比类型宽一档 */
const argvName = argv[0] ?? "";
const name = argvName as JobName;
const force = argv.includes("--force");
if (!argvName || argvName.startsWith("--")) {
  console.error(
    "usage: pnpm job <selfcheck|preopen|plan|intraday|close|post|night|sector|adjfix> [--force]\n" +
    "       pnpm backfill <job> --at <ISO> [--derived=full|light|skip]"
  );
  process.exit(2);
}

/** `--flag=value` 与 `--flag value` 两种写法都收 */
function flagValue(args: string[], flag: string): string | undefined {
  const eq = args.find(a => a.startsWith(`${flag}=`));
  if (eq !== undefined) return eq.slice(flag.length + 1);
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(msg: string): never {
  console.error(msg);
  process.exit(2);
}

/** 补历史数据的时刻。`--at` 一出现，本次就是"当作那个时刻在跑" */
const atRaw = flagValue(argv, "--at");
if (argv.includes("--at") && (atRaw === undefined || atRaw.startsWith("--"))) {
  usage("--at 缺值。要一个时刻：--at 2026-10-08 或 --at 2026-10-08T15:05:00+08:00");
}
/** 派生表口径，只对 night 有意义 */
const derivedRaw = flagValue(argv, "--derived");
const derived = (derivedRaw ?? "full") as "full" | "light" | "skip";
if (derivedRaw !== undefined && !["full", "light", "skip"].includes(derivedRaw)) {
  usage(`--derived 只能是 full / light / skip，收到 ${derivedRaw}`);
}
if (derivedRaw !== undefined && name !== "night") {
  console.warn(`--derived 只对 night 生效，${name} 这一趟忽略它`);
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

const realNow = new Date();
let now = realNow;
/** 补数模式：本次的"现在"与要占的时点都由 --at 推出来 */
let backfill: BackfillPlan | null = null;
if (atRaw !== undefined) {
  const p = planBackfill(atRaw, name, realNow);
  if (!p.ok) usage(p.error);
  backfill = p.plan;
  if (backfill.crossDayUnsafe && !force) {
    usage(crossDayWarning(name, backfill.date, shanghaiTs(realNow).slice(0, 10)));
  }
  if (backfill.pastDay) {
    console.warn(`补 ${backfill.date}（今天 ${shanghaiTs(realNow).slice(0, 10)}）：runJob 里所有日期都按 ${backfill.date} 推`);
    if (name === "night" && derived === "full") {
      console.warn("night 的 full 口径会顺带对账台账、结算影子盘并跑毕业判定；只要派生表就加 --derived=light");
    }
  }
  now = backfill.at;
}

const date = shanghaiTs(now).slice(0, 10);

/**
 * 补数模式固定用推出来的时点 —— 这一趟必须落在账本上看得见的地方，
 * 否则调度器下次还会把它当没跑过再跑一遍。
 * 平时按"现在几点"反查；--force 不认领，维持原语义。
 */
const slot = backfill !== null ? backfill.slot : (force ? null : slotForNow(name, now));

// 落在某个时点上就去抢；抢不到说明别人已经在跑或跑完了，本次直接放手。
// 不落在任何时点上（人手临时执行、或迟到太多）则照跑但不认领，别去占调度器的坑。
//
// 补数走 reclaimSlot 而不是 claimSlot：要补的坑上多半已经记着 missed / failed，
// 用 claimSlot 会因主键冲突直接放手 —— 补数永远补不上，而那个坑一直写着 missed。
if (slot !== null && !force) {
  const got = backfill !== null
    ? reclaimSlot(db, date, name, slot, runner)
    : claimSlot(db, date, name, slot, runner);
  if (!got) {
    console.log(JSON.stringify({
      name, date, slot, skipped: true,
      reason: backfill !== null
        ? "该时点已 done 或正被别的进程跑着（卡住的 running 交给唤醒回收判定），本次不重跑"
        : "该时点已被其它 runner 认领",
    }));
    db.close();
    process.exit(0);
  }
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

/**
 * 退出前等在途推送落地。
 *
 * 推送是 fire-and-forget（pushOutbound 不返回 Promise），守护进程常驻无所谓，
 * 但这里跑完就 process.exit —— 盘中信号、盘前计划在 `pnpm job` 里触发的推送
 * 会被半路掐断：库里有通知，手机上没有。有上限地等：走代理失败还会直连重试一次，
 * 所以给两倍单次超时再加一点余量；等不完也照退，不能让推送卡住 job。
 */
async function exitAfterPushes(code: number): Promise<never> {
  try {
    const t = readPushConfig().timeoutMs;
    await flushPushes((Number.isFinite(t) && t > 0 ? t : 8000) * 2 + 1000);
  } catch { /* 推送是增强，等它失败也照常退出 */ }
  process.exit(code);
}

/**
 * 派生表口径的组装（只对 night 生效）。
 *
 * light 那条是**盘中补数**的口径：只建情绪截面与代理截面，不结算影子盘、不跑毕业
 * 判定、不改写策略 YAML。夜里那一趟会顺手动这三样，而补一个历史日期时不该动它们
 * —— 影子盘结算按 asOf 重结会把已结清的样本再结一遍，毕业判定改的是明天要用的策略文件。
 */
function derivedBuilder(): ((db: Db, date: string) => Record<string, number>) | undefined {
  if (derived === "skip") return undefined;
  if (derived === "light") {
    return (d, day) => {
      const s = buildSentiment(d, { from: addDays(day, -20), to: day });
      const c = buildCrossProxy(d, { from: addDays(day, -20), to: day });
      return {
        sentimentBuilt: s.built, sentimentKept: s.kept, sentimentThin: s.thin,
        crossProxyBuilt: c.built, crossProxyKept: c.kept, crossProxyThin: c.thin,
      };
    };
  }
  return runNightlyDerived;
}

try {
  // 同 daemon：组装根负责把上层实现注进来。
  // buildDerived 用条件展开而不是直接给 undefined：runJob 那边靠"有没有注入"
  // 区分"没接上"与"跑了但没建"（derivedSkipped），塞个 undefined 会把两件事混成一个数。
  const buildDerived = derivedBuilder();
  const r = await runJob(name, {
    db, clients, now,
    planPreopen: runPreopenPlan, signalWatch: runSignalWatch, weeklyReview: runWeeklyReview,
    ...(buildDerived ? { buildDerived } : {}),
  });
  // 认领了就必须回填，否则这个时点会永远卡在 running，
  // 下次唤醒补偿会把它当成残留回收，等于白跑一趟
  if (slot !== null) finishSlot(db, date, name, slot, "done", r.stats);
  console.log(JSON.stringify(slot === null ? r : { ...r, slot, runner }));
  db.close();
  await exitAfterPushes(0);
} catch (e: any) {
  const msg = e?.message ?? String(e);
  if (slot !== null) finishSlot(db, date, name, slot, "failed", undefined, msg);
  console.error(JSON.stringify({ name, slot, error: msg }));
  db.close();
  await exitAfterPushes(1);
}
