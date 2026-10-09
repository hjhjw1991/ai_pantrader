/**
 * 盘中信号盯守：日线信号卡与盘中情绪两段互不依赖。
 *
 * 起因：策略配置不可用 / 信号卡算不出来时，runSignalWatch 以前直接 return，
 * 于是只依赖快照的盘中情绪告警整段被跳过 —— 最该响的时候一条都不响。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDb, type TempDb } from "../pit/helpers";
import type { MoodSignal } from "@/lib/sentiment/intraday";

const state = vi.hoisted(() => ({
  strategy: { available: false, reason: "测试：没有策略文件" } as Record<string, unknown>,
  signals: [] as MoodSignal[],
  moodThrows: false,
}));

vi.mock("@/lib/ui/adapters/strategy", () => ({
  readStrategyConfig: () => state.strategy,
}));
vi.mock("@/lib/sentiment/intraday", () => ({
  intradayMood: () => {
    if (state.moodThrows) throw new Error("快照表坏了");
    return { signals: state.signals };
  },
}));
// 绝不真的外发
vi.mock("@/lib/ui/push", () => ({ pushOutbound: () => {} }));

const { runSignalWatch } = await import("@/lib/plan/watch");

const DAY = "2026-09-24";
const weak = (level: "warn" | "critical"): MoodSignal => ({
  kind: "mood_shift", level, title: "盘中情绪转弱", body: "x",
  dedupeKey: level === "critical" ? `mood:weak:critical:${DAY}` : `mood:weak:${DAY}`,
  ...(level === "warn" ? { supersededBy: `mood:weak:critical:${DAY}` } : {}),
});

let t: TempDb;
beforeEach(() => {
  t = makeTempDb();
  state.strategy = { available: false, reason: "测试：没有策略文件" };
  state.signals = [];
  state.moodThrows = false;
});
afterEach(() => { t.close(); });

const keys = () => (t.db.prepare("SELECT dedupe_key FROM notification ORDER BY id").all() as Array<{ dedupe_key: string }>)
  .map(r => r.dedupe_key);

describe("runSignalWatch", () => {
  it("策略配置不可用时，盘中情绪通知照样发", async () => {
    state.signals = [weak("critical")];
    const r = await runSignalWatch(t.db);
    expect(r.notified).toBe(1);
    expect(r.reason).toContain("策略配置不可用");
    expect(keys()).toEqual([`mood:weak:critical:${DAY}`]);
  });

  it("信号卡那段抛异常也不挡情绪，且整体不抛", async () => {
    state.strategy = { get available(): boolean { throw new Error("yaml 解析炸了"); } };
    state.signals = [weak("warn")];
    const r = await runSignalWatch(t.db);
    expect(r.notified).toBe(1);
    expect(r.reason).toContain("yaml 解析炸了");
  });

  it("情绪算不出来也不抛", async () => {
    state.moodThrows = true;
    await expect(runSignalWatch(t.db)).resolves.toMatchObject({ notified: 0 });
  });

  it("info 级不弹", async () => {
    state.signals = [{ kind: "overheat", level: "info", title: "过热", body: "", dedupeKey: `hot:${DAY}` }];
    expect((await runSignalWatch(t.db)).notified).toBe(0);
  });

  it("warn 之后升级到 critical 照样响；critical 之后再来 warn 不再响", async () => {
    state.signals = [weak("warn")];
    expect((await runSignalWatch(t.db)).notified).toBe(1);
    state.signals = [weak("critical")];
    expect((await runSignalWatch(t.db)).notified).toBe(1);
    expect(keys()).toEqual([`mood:weak:${DAY}`, `mood:weak:critical:${DAY}`]);

    // 另一种顺序：先 critical，再 warn
    t.db.prepare("DELETE FROM notification").run();
    state.signals = [weak("critical")];
    expect((await runSignalWatch(t.db)).notified).toBe(1);
    state.signals = [weak("warn")];
    expect((await runSignalWatch(t.db)).notified).toBe(0);
    expect(keys()).toEqual([`mood:weak:critical:${DAY}`]);
  });
});
