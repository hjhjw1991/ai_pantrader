import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { runSweep, runSweepAsync, ReplayAborted } from "@/lib/ui/adapters/engines";
import { readStrategyConfig } from "@/lib/ui/adapters/strategy";

/**
 * 异步版参数扫描。
 *
 * 存在理由：一个点 = 一次完整回测。36 点 × 四年跨度 ≈ 3.7 小时（实测 0.38 秒/交易日），
 * 同步跑等于把整个网站冻这么久，而且没有任何办法叫停。
 *
 * 底线和单次回测一样：异步版与同步版必须给出**同一份报告** ——
 * 热力图算错的表现是一张看起来很正常的图，人会照着它去调参数、投真钱。
 *
 * 这里用空库：策略引擎在没有截面数据时会正常产出"无候选"，回放照跑，
 * 指标全是零值但结构完整 —— 足够验证驱动器本身，也不用为了测驱动器去造一整套行情。
 */
let dir: string, db: any;
function setup() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-sweep-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
  const cal = db.prepare("INSERT INTO trading_calendar (date, is_open, source) VALUES (?,1,'t')");
  for (const d of ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06"]) cal.run(d);
}
function teardown() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }

const cfg = readStrategyConfig();
const RANGE = { from: "2026-08-03", to: "2026-08-06", initialCash: 100_000 };

describe.skipIf(!cfg.available)("runSweepAsync", () => {
  const base = () => ({
    ...RANGE,
    config: (cfg as { config: any }).config,
    // 用真实存在的参数路径。写一个不存在的路径会在预校验阶段整体拒绝，
    // 于是测试测到的是"拒绝得对不对"，而不是驱动器本身
    grid: { "选股.过滤器阈值.换手上限": [15, 20] },
    axisX: "选股.过滤器阈值.换手上限",
    axisY: "选股.过滤器阈值.换手上限",
    generatedAt: "2026-08-06 22:00:00.000",
  });

  it("与同步版给出同一份报告", async () => {
    setup();
    try {
      const sync = runSweep(db, base());
      const async_ = await runSweepAsync(db, base());
      expect(async_.available).toBe(sync.available);
      if (sync.available && async_.available) {
        expect(async_.report).toEqual(sync.report);
      }
    } finally { teardown(); }
  });

  it("进度带着点序与日序：3.7 小时的活，只报'进行中'等于没报", async () => {
    setup();
    try {
      const seen: Array<{ point: number; points: number; day: number; days: number }> = [];
      const r = await runSweepAsync(db, base(), { onProgress: p => seen.push({ ...p }) });
      expect(r.available).toBe(true);
      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen.map(p => p.points)).size).toBe(1);
      expect(seen[0].points).toBe(2);
      expect(seen[seen.length - 1].point).toBe(2);
      // 每个点内部日序单调；点序不回头
      expect(seen.every((p, i) => i === 0 || p.point >= seen[i - 1].point)).toBe(true);
    } finally { teardown(); }
  });

  it("取消在网格点中间也生效，不用等这个点跑完", async () => {
    setup();
    try {
      const signal = { aborted: false };
      await expect(
        runSweepAsync(db, base(), {
          signal,
          onProgress: p => { if (p.point === 1 && p.day >= 2) signal.aborted = true; },
        })
      ).rejects.toThrow(ReplayAborted);
    } finally { teardown(); }
  });

  it("取消之后不再开下一个网格点 —— 取消了还在烧 CPU 等于没取消", async () => {
    setup();
    try {
      const signal = { aborted: false };
      let maxPoint = 0;
      try {
        await runSweepAsync(db, base(), {
          signal,
          onProgress: p => { maxPoint = Math.max(maxPoint, p.point); if (p.day >= 2) signal.aborted = true; },
        });
      } catch { /* 预期 */ }
      expect(maxPoint).toBe(1);
    } finally { teardown(); }
  });
});
