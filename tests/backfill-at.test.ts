import { describe, it, expect } from "vitest";
import { planBackfill, crossDayWarning } from "@/lib/data/backfill-at";
import { shanghaiTs } from "@/lib/data/clock";

/**
 * 补数 CLI 的判据。
 *
 * 起因：补数据一直是临时写一个小脚本（`.backfill-1008.ts` 那种），手写
 * `runJob("close", { ...deps, now: new Date("2026-10-08T15:05:00+08:00") })`，跑完就删。
 * 写过两遍、删过两遍，每删一次下次补数就要从记忆里重新拼一遍写法。
 *
 * 而"给一个过去的 now"有个不显眼的坑：**runJob 里所有日期都从 now 推**。
 * 对 night / post（源上有历史接口）这正合用；对 close / intraday / plan
 * （源上只有此刻现场）它会把**今天的现场**写成那天的数据 —— 库里看着补齐了，
 * 实际是拿假数据把覆盖率填满，比留个 missed 更糟。所以翻译结果必须带
 * crossDayUnsafe，由 CLI 拦下来。
 */

/** 上海时间字符串 → Date */
const sh = (s: string) => new Date(`${s.replace(" ", "T")}+08:00`);

/** 2026-10-09 是"现在"，补的是 10-08 */
const realNow = sh("2026-10-09 10:00:00");

describe("planBackfill：把 --at 翻译成哪一天哪个时点", () => {
  it("只给日期时，单时点的 job 自己知道该算几点（night→22:00）", () => {
    const r = planBackfill("2026-10-08", "night", realNow);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.date).toBe("2026-10-08");
    expect(r.plan.slot).toBe("22:00");
    expect(shanghaiTs(r.plan.at).slice(0, 19)).toBe("2026-10-08 22:00:00");
  });

  it("给完整 ISO 时照用，时点由时刻表反查", () => {
    const r = planBackfill("2026-10-08T15:05:00+08:00", "close", realNow);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.date).toBe("2026-10-08");
    expect(r.plan.slot).toBe("15:05");
  });

  /**
   * 不带时区按上海挂钟解释，不按宿主时区：时刻表上所有时点都是上海挂钟，
   * 而这台机器改时区/出国时 `2026-10-08T22:00` 会悄悄错开几小时 ——
   * 错开之后 slotForNow 认不到 22:00 这个坑，补数就变成"跑了一次没记账的执行"。
   */
  it("不带时区按 +08:00 解释，不是宿主时区", () => {
    const r = planBackfill("2026-10-08T22:00:00", "night", realNow);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(shanghaiTs(r.plan.at).slice(0, 19)).toBe("2026-10-08 22:00:00");
    expect(r.plan.slot).toBe("22:00");
  });

  it("迟到 60 分钟内仍算同一个时点 —— 休眠唤醒补跑靠的就是这条", () => {
    const r = planBackfill("2026-10-08T22:30:00+08:00", "night", realNow);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.slot).toBe("22:00");
  });

  it("--at= 等号写法与空格写法等价", () => {
    // CLI 层两种都收（scripts/job.ts 的 flagValue），这里只保证值本身被正确解析
    const a = planBackfill("2026-10-08T15:05:00+08:00", "close", realNow);
    const b = planBackfill("2026-10-08 15:05:00".replace(" ", "T"), "close", realNow);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.plan.slot).toBe(b.plan.slot);
  });

  it("解析不出来就是错误，不猜", () => {
    const r = planBackfill("上周五", "night", realNow);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("--at 解析不出来");
  });

  it("补未来 = 拿一份还没发生的现场当历史，挡掉（手抖打错年份多半撞在这里）", () => {
    const r = planBackfill("2027-10-08", "night", realNow);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("未来时刻");
  });

  /**
   * 必须落在一个真实时点上，否则这一趟在 job_run 里看不见：
   * 调度器下次还会把它当没跑过再跑一遍，等于白烧一遍限频额度。
   */
  it("给的时刻不在任何时点上 → 拒绝，并告诉用户时点在哪", () => {
    const r = planBackfill("2026-10-08T14:00:00+08:00", "night", realNow);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("不落在 night 的任何时点上");
    expect(r.error).toContain("22:00");
  });

  it("多时点的 job 只给日期 → 拒绝（替用户决定补哪一分钟的盘口 = 猜）", () => {
    const r = planBackfill("2026-10-08", "intraday", realNow);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("必须写明时间");
  });

  it("不在时刻表上的 job 没有时点可补", () => {
    const r = planBackfill("2026-10-08", "sector" as never, realNow);
    expect(r.ok).toBe(false);
  });
});

describe("planBackfill：跨天补不回来的 job 要标出来", () => {
  it("close 补到非今天 → crossDayUnsafe：源上没有历史接口，拿到的是此刻现场", () => {
    const r = planBackfill("2026-10-08T15:05:00+08:00", "close", realNow);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.crossDayUnsafe).toBe(true);
    expect(r.plan.pastDay).toBe(true);
  });

  it("close 补今天 → 正常，不必 --force", () => {
    const r = planBackfill("2026-10-09T15:05:00+08:00", "close", sh("2026-10-09 23:00:00"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.crossDayUnsafe).toBe(false);
    expect(r.plan.pastDay).toBe(false);
  });

  it("night 补到哪天都安全：它拉的是 1023 根日线，源上有历史", () => {
    const r = planBackfill("2026-10-08", "night", realNow);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.crossDayUnsafe).toBe(false);
    expect(r.plan.pastDay).toBe(true);
  });

  it("post 同样跨天可补（龙虎榜按日期查）", () => {
    const r = planBackfill("2026-10-08T18:40:00+08:00", "post", realNow);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.crossDayUnsafe).toBe(false);
  });

  it("plan 补到非今天 → unsafe：拿今天的数据算出一份上周五的计划 = 捏造", () => {
    const r = planBackfill("2026-10-08T09:15:00+08:00", "plan", realNow);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.crossDayUnsafe).toBe(true);
  });
});

describe("crossDayWarning：措辞要说清会发生什么，不只说不允许", () => {
  it("点明拿到的是此刻现场、会被写成那天的数据", () => {
    const w = crossDayWarning("close", "2026-10-08", "2026-10-09");
    expect(w).toContain("2026-10-08");
    expect(w).toContain("2026-10-09");
    expect(w).toContain("--force");
  });
});
