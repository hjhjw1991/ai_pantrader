import type { JobName } from "@/lib/data/jobs";
import { shanghaiTs } from "@/lib/data/clock";

/**
 * 采集时刻表。**平台无关的唯一真相源**，随源码走。
 *
 * 以前时刻表只存在于 scripts/install-launchd.ts 里，也就是只存在于 macOS 的
 * plist 生成逻辑里：换台 Linux/Windows 就得重写一份，两份还会互相漂移。
 * 现在它是纯数据，被三个消费者共用：
 *   lib/data/scheduler.ts        进程内调度（跨平台，跑起系统就自动采集）
 *   scripts/install-launchd.ts   macOS launchd（可选的开机级注册）
 *   scripts/install-schtasks.ts  Windows 计划任务（同上）
 *
 * 时点一律是 Asia/Shanghai 挂钟时间，与宿主时区无关 ——
 * A 股的开盘收盘是上海时间定义的，用本机时区会让出国/改时区直接错位。
 */

export interface JobSlot {
  job: JobName;
  /** "HH:MM"，Asia/Shanghai */
  slots: string[];
  /**
   * 补跑策略。系统中午才启动时，上午错过的时点怎么处理：
   *   all    —— 全部补跑。适合每天单次、且晚跑仍有意义的 job
   *   latest —— 只补最后一个，其余记成 missed。
   *             盘中快照属于这类：连补 6 次拿到的是同一份当前行情，
   *             既没补回历史，又白烧 6 × 5888 次请求的限频额度。
   *             更重要的是不能把没跑过的时点记成成功，那是伪造覆盖率。
   */
  catchUp: "all" | "latest";
  /**
   * **跨天**是否还补得回来。注意这和 catchUp 是两个不同的轴，别混用 ——
   * 混用过一次：close 是 catchUp="all"（16:00 才开机跑它仍能拿到当日涨停池，
   * 日内补跑确实有意义），但它内部用的日期是"今天"，
   * 对上周五的暗日跑一遍只会再拿一份今天的涨停池，等于什么都没补回来。
   *
   *   true  —— 今天跑一次就能把过去若干天的数据一并带回来。
   *            night 拉 1023 根日线、preopen 同步未来 60 天日历，都属于这类。
   *   false —— 绑定在某个过去时点上的现场，只能如实记 missed。
   */
  backfillsAcrossDays: boolean;
  /** 给人看的说明，装任务时打印 */
  desc: string;
  /**
   * 预计耗时（分钟）。用于推算防休眠时段的结束时间 ——
   * 固定 padding 是错的模型：night 拉全市场 5888 只日线实测约 30 分钟，
   * 按 15 分钟 padding 算，机器会在日线拉到一半时睡过去。
   */
  durationMin: number;
}

/** 盘中 09:35–11:30、13:00–14:55，每 5 分钟，避开午休 */
export function intradaySlots(): string[] {
  const out: string[] = [];
  for (const h of [9, 10, 11, 13, 14]) {
    for (let m = 0; m < 60; m += 5) {
      const t = h * 60 + m;
      if (t < 9 * 60 + 35) continue;
      if (t > 11 * 60 + 30 && t < 13 * 60) continue;
      if (t > 14 * 60 + 55) continue;
      out.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return out;
}

/**
 * 盘中采集的轮次间隔（分钟），**从时刻表推出来**。
 *
 * 界面上要告诉用户"候选池多久变一次"。那个数字不能手打：作战台的候选池是渲染时
 * 现算的，真正让它变化的是采集轮次，所以时刻表一改、界面上那句话必须跟着改。
 * 手打的常数不会跟着改，于是界面会一直说一个已经不成立的节奏 —— 比不说更糟。
 *
 * 取**最小**相邻间隔而不是平均：时点里夹着午休那段 90 分钟的空档，
 * 平均会被它拉成十几分钟，而实际节奏是 5 分钟。
 */
export function intradayIntervalMin(): number {
  const slots = SCHEDULE.find(j => j.job === "intraday")?.slots ?? [];
  if (slots.length < 2) return 0;
  let min = Number.POSITIVE_INFINITY;
  for (let i = 1; i < slots.length; i++) {
    const gap = hmToMinutes(slots[i]) - hmToMinutes(slots[i - 1]);
    if (gap > 0 && gap < min) min = gap;
  }
  return Number.isFinite(min) ? min : 0;
}

export const SCHEDULE: JobSlot[] = [
  // 自检是对一个日期区间出报告，今天跑一次就把暗日一并算进去了
  { job: "selfcheck", slots: ["08:50"], catchUp: "all", backfillsAcrossDays: true,
    durationMin: 1, desc: "缺口自检与覆盖率" },
  { job: "preopen", slots: ["09:00"], catchUp: "all", backfillsAcrossDays: true,
    durationMin: 1, desc: "同步交易日历" },
  /*
   * 盘前作战计划。09:15 = 集合竞价开始。
   *
   * 放在盘前不是凑时间：候选池读的是日线与截面，而当天的日线要等 22:00 才落库 ——
   * 选股结论在开盘前就已经定了，那它就该在开盘前交到人手上。
   *
   * catchUp=all + 跨天不可回补：中午才开机也值得算一份今天的计划（数据没变），
   * 但绝不为上周五补一份 —— 那会拿今天的数据算出一份"上周五的计划"，纯属捏造。
   */
  { job: "plan", slots: ["09:15"], catchUp: "all", backfillsAcrossDays: false,
    durationMin: 1, desc: "盘前作战计划（候选池推送）" },
  {
    job: "intraday", slots: intradaySlots(), catchUp: "latest",
    // 过去某一刻的盘口，源上不存在历史查询接口，永久丢失
    backfillsAcrossDays: false,
    // 实测一轮 5885 只快照 + 50 只分钟线约 45 秒
    durationMin: 2,
    desc: "全市场快照 + 关注池分钟线（不可回补）",
  },
  // catchUp=all 但 backfillsAcrossDays=false：日内补跑有意义（涨停池收盘后才全），
  // 跨天补跑没意义（内部日期写死是"今天"）
  { job: "close", slots: ["15:05"], catchUp: "all", backfillsAcrossDays: false,
    durationMin: 3, desc: "收盘快照 + 涨停池（不可回补）" },
  // 17:00 太早：龙虎榜逐步发布，实测当日 17:00 只有 35 行、18:50 已 58 行
  // 跨天由 night 的 lhbRefreshDates 覆盖近 30 个交易日，不必逐日补跑 post
  { job: "post", slots: ["18:40"], catchUp: "all", backfillsAcrossDays: true,
    durationMin: 3, desc: "龙虎榜 + 营业部席位" },
  // 实测 2026-08-03：写入 5,672,962 根日线，22:00 → 22:29
  { job: "night", slots: ["22:00"], catchUp: "all", backfillsAcrossDays: true,
    durationMin: 40, desc: "全量日线 + 缺口回补" },
];

/**
 * OS 级任务允许迟到多久，仍算作它那个时点。
 *
 * 需要余量是因为 launchd / schtasks **只保证不早于**日历时间触发：机器休眠期间
 * 时点不会到点执行，唤醒后才补一次。半小时之内补上，做的还是那个时点该做的事。
 * 超过就不认了 —— 14:55 的盘口在 16:30 拿到的是收盘价，把它记成 14:55 跑过，
 * 等于用一份假数据把覆盖率填满，比留个 missed 缺口还糟。
 */
const SLOT_LATE_TOLERANCE_MIN = 60;

/**
 * 把"现在几点"反查成时刻表里的时点，供 OS 级任务认领 job_run 用。
 *
 * 取的是**刚过去的那个**时点，不是最近的那个：10:09 属于 10:05，不属于还没发生的
 * 10:10。所以这里不给"提前触发"留余量 —— 留了就会把 10:09 认成 10:10，
 * 抢占一个尚未发生的坑。
 *
 * 返回 null 表示这次执行不落在任何时点上（人手敲的临时执行，或迟到太多），
 * 调用方应当照跑但**不认领**，别去占调度器的位置。
 */
export function slotForNow(job: JobName, at: Date): string | null {
  const j = SCHEDULE.find(x => x.job === job);
  if (j === undefined) return null;

  const hm = shanghaiTs(at).slice(11, 16);
  const nowMin = hmToMinutes(hm);

  let best: string | null = null;
  for (const s of j.slots) {
    const t = hmToMinutes(s);
    if (t > nowMin) continue;                          // 还没到，不认
    if (nowMin - t > SLOT_LATE_TOLERANCE_MIN) continue; // 迟到太多，不认
    if (best === null || t > hmToMinutes(best)) best = s;
  }
  return best;
}

/** 时刻表里所有 job 的所有时点，升序展开，用于装 OS 级任务 */
export function allSlots(): Array<{ job: JobName; slot: string }> {
  return SCHEDULE.flatMap(j => j.slots.map(slot => ({ job: j.job, slot })))
    .sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
}

export function hmToMinutes(hm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hm);
  if (m === null) throw new Error(`bad slot format: ${hm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * 需要机器保持唤醒的时段，由时刻表自动推出，不手写 —— 手写会和时刻表漂移。
 * 结束时间用该时段内最后一个 job 的 durationMin，而不是固定 padding。
 */
export function awakeWindows(padBeforeMin = 5, padAfterMin = 5): Array<{
  from: string; to: string; seconds: number;
}> {
  const withDur = SCHEDULE.flatMap(j =>
    j.slots.map(slot => ({ slot, t: hmToMinutes(slot), dur: j.durationMin })))
    .sort((a, b) => a.t - b.t);

  const groups: Array<{ start: number; end: number }> = [];
  for (const { t, dur } of withDur) {
    const finish = t + dur;
    const last = groups[groups.length - 1];
    // 间隔超过 90 分钟就算另一个时段（盘中连续、盘后离散）
    if (last !== undefined && t - last.end <= 90) last.end = Math.max(last.end, finish);
    else groups.push({ start: t, end: finish });
  }
  const fmt = (mins: number) =>
    `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  return groups.map(g => {
    const from = Math.max(0, g.start - padBeforeMin);
    const to = g.end + padAfterMin;
    return { from: fmt(from), to: fmt(to), seconds: (to - from) * 60 };
  });
}
