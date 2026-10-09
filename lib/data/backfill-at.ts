import type { JobName } from "@/lib/data/jobs";
import { SCHEDULE, slotForNow } from "@/lib/data/schedule";
import { shanghaiTs } from "@/lib/data/clock";

/**
 * 补数 CLI 的**纯计算部分**：把"补哪个时刻"翻译成"跑哪一天、占哪个时点"。
 *
 * ── 为什么要有它 ──
 *
 * 补数据一直是靠临时写一个小脚本（`.backfill-1008.ts` 那种），里头手写
 * `runJob("close", { ...deps, now: new Date("2026-10-08T15:05:00+08:00") })`，
 * 跑完就删。写过两遍，也删过两遍，每删一次下次补数就得从记忆里重新拼。
 *
 * 而"给一个过去的 now"这件事有个不显眼的坑：**runJob 里所有日期都从 now 推**。
 * 对 night / post 这类"源上有历史接口"的 job 这正合用；对 close / intraday /
 * plan 这类"源上只有此刻现场"的 job，给一个过去的 now 只会把**今天的现场**写成
 * 那天的数据 —— 库里看着补齐了，实际是拿假数据把覆盖率填满，比留个 missed 更糟
 * （schedule.ts 里 backfillsAcrossDays 那一段就是在说这件事）。
 *
 * 所以翻译结果里带一个 `crossDayUnsafe`，由 CLI 决定要不要拦下来。
 */

export interface BackfillPlan {
  /** 补数时"当作几点"，原样交给 runJob 的 deps.now */
  at: Date;
  /** 上海日期 —— 认领 job_run 的 date，也是 runJob 内部写库的日期 */
  date: string;
  /** 落在时刻表上的哪个时点（认领 job_run 的 slot） */
  slot: string;
  /**
   * true = 这个 job 跨天补不回来，而目标日期又不是今天：
   * 跑它拿到的是"此刻的现场"，却会被写成那天的数据。必须 --force 才放行。
   */
  crossDayUnsafe: boolean;
  /** 补的是过去的某天（不是今天）。night 会顺带对账与结算影子盘，值得先说一句 */
  pastDay: boolean;
}

export type BackfillPlanResult =
  | { ok: true; plan: BackfillPlan }
  | { ok: false; error: string };

/** 末尾带时区后缀（Z 或 ±HH:MM / ±HHMM）就不补，否则按上海挂钟解释 */
const HAS_TZ = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 把 `--at` 给的字符串解析成一个 Date。
 *
 * 不带时区时按 **Asia/Shanghai** 解释，不按宿主时区：时刻表里所有时点都是上海挂钟，
 * 而这台机器出国/改时区就会让 `2026-10-08T22:00` 悄悄错开几小时，
 * 错开之后 slotForNow 认不到 22:00 这个坑，补数就变成了"跑了一次没记账的执行"。
 */
function parseAt(raw: string, job: JobName, specSlots: string[]): Date | null {
  const s = raw.trim();
  if (BARE_DATE.test(s)) {
    /**
     * 只给日期：只有**单时点**的 job 才知道该算几点（night→22:00、close→15:05）。
     * intraday 有 48 个时点，猜一个等于替用户决定"补哪一分钟的盘口"——不该猜。
     */
    if (specSlots.length !== 1) return null;
    return new Date(`${s}T${specSlots[0]}:00+08:00`);
  }
  const iso = HAS_TZ.test(s) ? s : `${s}+08:00`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 时点太多时只报首尾，别把 48 个时点糊人一脸 */
function slotHint(slots: string[]): string {
  return slots.length <= 3
    ? slots.join(" / ")
    : `${slots[0]} … ${slots[slots.length - 1]}（共 ${slots.length} 个）`;
}

/**
 * 把 `--at` 翻译成计划。不改任何状态，纯函数，便于测试。
 *
 * @param raw      `--at` 的值，如 `2026-10-08` 或 `2026-10-08T22:00:00+08:00`
 * @param job      要补的 job
 * @param realNow  真实的"现在"。用来拒绝未来时刻、判断"今天"是哪天
 */
export function planBackfill(raw: string, job: JobName, realNow: Date): BackfillPlanResult {
  const spec = SCHEDULE.find(j => j.job === job);
  if (spec === undefined) {
    return { ok: false, error: `${job} 不在采集时刻表上，没有时点可补` };
  }

  const at = parseAt(raw, job, spec.slots);
  if (at === null) {
    return spec.slots.length === 1
      ? { ok: false, error: `--at 解析不出来：${raw}。要 ISO 时间，如 ${shanghaiTs(realNow).slice(0, 10)}T${spec.slots[0]}:00+08:00；不带时区按上海挂钟解释` }
      : { ok: false, error: `--at 解析不出来：${raw}。${job} 有 ${spec.slots.length} 个时点，必须写明时间，如 2026-10-08T14:50:00+08:00` };
  }

  /**
   * 补未来 = 拿一份还没发生的现场当历史。这除了把账本搞乱没有任何用处，
   * 而它最容易出现的形式是手抖把年份打错（2027 → 直接被这里挡住）。
   */
  if (at.getTime() > realNow.getTime()) {
    return { ok: false, error: `--at 是未来时刻（${shanghaiTs(at)}），补数只能补已经过去的时点` };
  }

  /**
   * 必须落在一个真实时点上，否则这一趟在 job_run 里看不见
   * ——调度器下次还会把它当没跑过再跑一遍，等于白烧一遍限频额度。
   * slotForNow 给 60 分钟迟到余量（休眠唤醒补跑靠的就是它）。
   */
  const slot = slotForNow(job, at);
  if (slot === null) {
    return {
      ok: false,
      error: `${shanghaiTs(at).slice(11, 16)} 不落在 ${job} 的任何时点上（${slotHint(spec.slots)}，迟到 60 分钟内仍算该时点）。补数必须落在真实时点上，否则账本上看不见这一趟`,
    };
  }

  const date = shanghaiTs(at).slice(0, 10);
  const today = shanghaiTs(realNow).slice(0, 10);
  return {
    ok: true,
    plan: {
      at, date, slot,
      crossDayUnsafe: !spec.backfillsAcrossDays && date !== today,
      pastDay: date !== today,
    },
  };
}

/**
 * 跨天不可回补的 job 补到过去的某天 —— 打印给人的解释。
 *
 * 措辞要具体到"会发生什么"，不能只说"不允许"：真要补的人是**知道了仍然要补**
 * （比如刚收盘、源上还挂着那一天的现场，凌晨补昨天那一趟就是这么来的），
 * 他要能判断这一次是不是那种情况。
 */
export function crossDayWarning(job: JobName, date: string, today: string): string {
  return (
    `${job} 跨天补不回来：源上没有历史接口，拿到的是此刻的现场，` +
    `却会被写成 ${date} 的数据（今天是 ${today}）—— 那是用假数据把覆盖率填满，比留着缺口更糟。\n` +
    `确认源上仍挂着 ${date} 的现场（例如当日收盘后、次日凌晨补跑）就加 --force。`
  );
}
