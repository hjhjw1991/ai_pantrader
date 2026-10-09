import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { stockAnalysis, trendVerdict } from "@/lib/ui/adapters/analyze";
import { upsertWatch } from "@/lib/ui/mutations";
import { config } from "../strategy/helpers";

/**
 * 单票按需分析。**跑在临时库上** —— 绝不碰 ~/PanTraderData/pantrader.db。
 *
 * 重点不是"返回了东西"，而是**结论能不能被复核**：趋势那个词是三项打分加出来的，
 * 规则原文一起返回，改了阈值就该被测试抓住（下面 trendVerdict 的分档逐条覆盖）。
 */

let dir: string;
let db: Database.Database;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pantrader-analyze-"));
  db = new Database(path.join(dir, "t.db"));
  runMigrations(db);
});

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("trendVerdict：三项打分合成一个词", () => {
  it("全多头 → 多头；全空头 → 空头", () => {
    expect(trendVerdict(2, "金叉", "金叉")).toMatchObject({ verdict: "多头", score: 6 });
    expect(trendVerdict(-2, "死叉", "死叉")).toMatchObject({ verdict: "空头", score: -6 });
  });

  it("分档边界：4 多头 / 3 偏多 / 2 偏多 / 1 震荡 / 0 震荡 / −1 震荡 / −2 偏空 / −3 偏空 / −4 空头", () => {
    // 均线 2 + 日线多头 1 + 周线 1 = 4
    expect(trendVerdict(2, "多头", "多头").verdict).toBe("多头");
    expect(trendVerdict(2, "多头", null).verdict).toBe("偏多");       // 3
    expect(trendVerdict(2, null, null).verdict).toBe("偏多");          // 2
    expect(trendVerdict(1, null, null).verdict).toBe("震荡");          // 1
    expect(trendVerdict(0, "多头", "空头").verdict).toBe("震荡");      // 0
    expect(trendVerdict(-1, null, null).verdict).toBe("震荡");         // −1
    expect(trendVerdict(-2, null, null).verdict).toBe("偏空");         // −2
    expect(trendVerdict(-2, "空头", null).verdict).toBe("偏空");       // −3
    expect(trendVerdict(-2, "空头", "空头").verdict).toBe("空头");     // −4
  });

  it("互相打架时落在震荡，不取决于谁先写（均线多头 vs 日周双死叉）", () => {
    // 2 − 2 − 1 = −1；写成 if 链的话会被第一条"均线多头"直接判成多头
    expect(trendVerdict(2, "死叉", "空头")).toMatchObject({ verdict: "震荡", score: -1 });
  });

  it("三个读数都取不到 → 数据不足，不是「震荡」", () => {
    expect(trendVerdict(null, null, null).verdict).toBe("数据不足");
    expect(trendVerdict(null, null, null).score).toBe(0);
  });

  it("部分缺失不算数据不足：缺的那项按 0 计，缺多少要说出来", () => {
    const only = trendVerdict(2, null, null);
    expect(only.verdict).toBe("偏多");
    expect(only.rule).toMatch(/规则判定/);
  });

  it("分数钳在 ±2：均线方向传越界值不能把总分顶飞", () => {
    expect(trendVerdict(99, null, null).score).toBe(2);
    expect(trendVerdict(-99, null, null).score).toBe(-2);
    expect(trendVerdict(NaN, null, null).verdict).toBe("数据不足");
  });

  it("认不出的 MACD 标签（样本不足等）按 0 计，不当成利空", () => {
    expect(trendVerdict(0, "样本不足", "无近期数据")).toMatchObject({ verdict: "震荡", score: 0 });
  });
});

/** 120 个工作日，从 2026-04-01 起 */
function tradingDates(n: number): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(2026, 3, 1));
  while (out.length < n) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const DATES = tradingDates(120);
const LAST = DATES[DATES.length - 1];
const CODE = "600519";

/** 一段明确的上涨：10 → 13，均线自然多头排列 */
function seedUptrend(code: string): void {
  const ins = db.prepare(
    `INSERT INTO kline_daily (code,date,o,h,l,c,vol,amount,adj_factor) VALUES (?,?,?,?,?,?,?,?,?)`
  );
  const cal = db.prepare(`INSERT OR IGNORE INTO trading_calendar (date,is_open,source) VALUES (?,1,'test')`);
  DATES.forEach((date, i) => {
    const c = 10 + (3 * i) / (DATES.length - 1);
    ins.run(code, date, c - 0.1, c + 0.15, c - 0.2, c, 100000 + i * 100, null, 1.0);
    cal.run(date);
  });
  db.prepare(`INSERT OR REPLACE INTO security (code,name,board,list_date) VALUES (?,?,'主板',?)`)
    .run(code, "测试白酒", DATES[0]);
  db.prepare(`INSERT OR REPLACE INTO quote_snapshot (ts,code,price,pct) VALUES (?,?,?,?)`)
    .run(`${LAST} 15:05:00`, code, 13, 1.24);
}

describe("stockAnalysis", () => {
  it("没有日线：趋势是数据不足，不是编一个中性出来", () => {
    const r = stockAnalysis(db, "000001", `${LAST} 15:05:00`, config());
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.trend.verdict).toBe("数据不足");
    expect(r.trend.spark).toEqual([]);
    expect(r.trend.readouts).toEqual([]);
    // 引擎今天没有这只票的判定，要有话直说，不能留下一个空的"买卖点"
    expect(r.plan).toBeNull();
    expect(r.planReason).toBeTruthy();
  });

  it("一段明确上涨：趋势读出多头/偏多，打分与规则一起返回", () => {
    seedUptrend(CODE);
    const r = stockAnalysis(db, CODE, `${LAST} 15:05:00`, config());
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.name).toBe("测试白酒");
    expect(r.trend.date).toBe(LAST);
    expect(r.trend.spark).toHaveLength(60);
    expect(["多头", "偏多"]).toContain(r.trend.verdict);
    expect(r.trend.score).toBeGreaterThanOrEqual(3);
    // 打分依据要跟着结论一起给出：只看到一个"多头"标签没法复核
    expect(r.trend.basis.maDir).toBe(2);
    expect(r.trend.rule).toMatch(/均线方向/);
    expect(r.trend.readouts.map((x) => x.name)).toContain("日线MACD");
    expect(r.trend.readouts.map((x) => x.name)).toContain("均线方向");
    // 现价来自快照，结构位里的"现价"缺了也有得填
    expect(r.price).toBe(13);
    expect(r.trend.levels.price).toBe(13);
  });

  it("手填的触发价/止损会带出来，与引擎给的那套并排显示", () => {
    upsertWatch(db, { code: CODE, account: "卫星账户", triggerPx: 12.5, stopPx: 11.8, thesis: "回踩 20 日线" });
    const r = stockAnalysis(db, CODE, `${LAST} 15:05:00`, config());
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.mine).toMatchObject({ triggerPx: 12.5, stopPx: 11.8, thesis: "回踩 20 日线" });
    expect(r.mine!.addedAt).toBeTruthy();
  });

  it("不在观察池里的票：mine 是 null，不假装有一套手填价", () => {
    const r = stockAnalysis(db, "000002", `${LAST} 15:05:00`, config());
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.mine).toBeNull();
  });
});
