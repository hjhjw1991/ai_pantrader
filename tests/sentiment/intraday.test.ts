import { describe, expect, it } from "vitest";
import { makeTempDb, insQuote, insSecurity, type TempDb } from "../pit/helpers";
import { intradayMood, moodTemp, tradeClockMs, type MoodPoint } from "@/lib/sentiment/intraday";

/**
 * 盘中情绪。
 *
 * 用真库而不是替身：这个模块的价值全在 SQL 有没有被 asOf 与日期范围夹住，
 * 替身测等于测替身。
 */

const DAY = "2026-09-24";
/** 时点数少于 1000 的快照会被丢弃（采集半途的产物），所以夹具要够这么多票 */
const N = 1000;

/**
 * 造一个时点：前 upRatio 比例的票涨 pctUp，其余跌 pctDown。
 * 造 N=1000 条是必须的 —— 少于此会被 MIN_SAMPLE 当成坏时点整行丢掉，
 * 而"整行丢掉"的表现是 mood 恒为 null，看不出是夹具的问题。
 */
function seedPoint(db: TempDb["db"], ts: string, upRatio: number, pctUp = 1, pctDown = -1): void {
  const ins = db.prepare(
    `INSERT OR REPLACE INTO quote_snapshot (ts, code, price, pct, turnover, amplitude, bid_ask_json)
     VALUES (?, ?, ?, ?, 1, 1, NULL)`
  );
  const nUp = Math.round(N * upRatio);
  db.transaction(() => {
    for (let i = 0; i < N; i++) {
      const code = `6${String(i).padStart(5, "0")}`;
      const up = i < nUp;
      ins.run(ts, code, 10, up ? pctUp : pctDown);
    }
  })();
}

function setup(): TempDb {
  const t = makeTempDb();
  const ins = t.db.prepare(
    `INSERT OR REPLACE INTO security (code, name, list_date, delist_date, board, is_st_history_json)
     VALUES (?, ?, '2010-01-01', NULL, '主板', NULL)`
  );
  db_transaction(t.db, () => {
    for (let i = 0; i < N; i++) ins.run(`6${String(i).padStart(5, "0")}`, `S${i}`);
  });
  return t;
}

function db_transaction(db: TempDb["db"], fn: () => void): void {
  db.transaction(fn)();
}

describe("盘中情绪 — 聚合", () => {
  it("涨跌家数与 breadth 算得对", () => {
    const t = setup();
    seedPoint(t.db, `${DAY} 10:00:00.000`, 0.6, 1, -1);
    const m = intradayMood(t.db, `${DAY} 10:05:00.000`);
    expect(m.now).not.toBeNull();
    expect(m.now!.n).toBe(N);
    expect(m.now!.up).toBe(600);
    expect(m.now!.down).toBe(400);
    // (600 + 0.5×0) / 1000
    expect(m.now!.breadth).toBeCloseTo(0.6, 6);
    // 600×1 + 400×(−1) = 200 → /1000
    expect(m.now!.avgPct).toBeCloseTo(0.2, 6);
    t.close();
  });

  it("平盘算半个上涨 —— 平盘是横盘不是下跌，全算进下跌会把窄幅震荡读成崩盘", () => {
    const t = setup();
    const ins = t.db.prepare(
      `INSERT OR REPLACE INTO quote_snapshot (ts, code, price, pct, turnover, amplitude, bid_ask_json)
       VALUES (?, ?, 10, ?, 1, 1, NULL)`
    );
    db_transaction(t.db, () => {
      for (let i = 0; i < N; i++) {
        const pct = i < 200 ? 2 : i < 400 ? -2 : 0;
        ins.run(`${DAY} 10:00:00.000`, `6${String(i).padStart(5, "0")}`, pct);
      }
    });
    const m = intradayMood(t.db, `${DAY} 10:05:00.000`);
    expect(m.now!.up).toBe(200);
    expect(m.now!.down).toBe(200);
    expect(m.now!.flat).toBe(600);
    // (200 + 0.5×600)/1000 = 0.5 —— 平盘全算下跌的话这里会是 0.2，那叫崩盘
    expect(m.now!.breadth).toBeCloseTo(0.5, 6);
    t.close();
  });

  it("涨停按板块阈值判，创业板 20% 不算涨停", () => {
    const t = setup();
    // 主板 600000 涨 10% = 涨停；创业板 300000 涨 10% 不是（要 20%）
    const ins = t.db.prepare(
      `INSERT OR REPLACE INTO quote_snapshot (ts, code, price, pct, turnover, amplitude, bid_ask_json)
       VALUES (?, ?, 10, ?, 1, 1, NULL)`
    );
    const sec = t.db.prepare(
      `INSERT OR REPLACE INTO security (code, name, list_date, delist_date, board, is_st_history_json)
       VALUES (?, ?, '2010-01-01', NULL, ?, NULL)`
    );
    sec.run("600000", "主板票", "主板");
    sec.run("300000", "创业板票", "创业板");
    db_transaction(t.db, () => {
      ins.run(`${DAY} 10:00:00.000`, "600000", 10);
      ins.run(`${DAY} 10:00:00.000`, "300000", 10);
      for (let i = 2; i < N; i++) ins.run(`${DAY} 10:00:00.000`, `6${String(i).padStart(5, "0")}`, 0);
    });
    const m = intradayMood(t.db, `${DAY} 10:05:00.000`);
    expect(m.now!.limitUp).toBe(1);   // 只算主板那只
    t.close();
  });

  it("样本不足的时点整行丢弃 —— 采集半途的残缺快照混进来会把情绪算成假崩盘", () => {
    const t = setup();
    const ins = t.db.prepare(
      `INSERT OR REPLACE INTO quote_snapshot (ts, code, price, pct, turnover, amplitude, bid_ask_json)
       VALUES (?, ?, 10, ?, 1, 1, NULL)`
    );
    db_transaction(t.db, () => {
      for (let i = 0; i < 50; i++) ins.run(`${DAY} 10:00:00.000`, `6${String(i).padStart(5, "0")}`, -9);
    });
    const m = intradayMood(t.db, `${DAY} 10:05:00.000`);
    expect(m.now).toBeNull();
    expect(m.points).toBe(0);
    t.close();
  });
});

describe("盘中情绪 — asOf 截断", () => {
  it("10:00 看盘中，不会读到 15:00 的收盘状态", () => {
    const t = setup();
    seedPoint(t.db, `${DAY} 10:00:00.000`, 0.7);   // 开盘强
    seedPoint(t.db, `${DAY} 15:00:00.000`, 0.1);   // 收盘崩
    const m = intradayMood(t.db, `${DAY} 10:30:00.000`);
    expect(m.now!.ts.slice(11, 16)).toBe("10:00");
    expect(m.now!.breadth).toBeCloseTo(0.7, 6);
    // 反过来：站在收盘看，才是崩的那根
    const late = intradayMood(t.db, `${DAY} 15:30:00.000`);
    expect(late.now!.breadth).toBeCloseTo(0.1, 6);
    t.close();
  });

  it("时点数只数 asOf 之前的 —— 否则'今日已采 N 个时点'会恒等于全天", () => {
    const t = setup();
    for (const hhmm of ["09:30", "10:00", "10:30", "11:00", "14:00"]) {
      seedPoint(t.db, `${DAY} ${hhmm}:00.000`, 0.5);
    }
    expect(intradayMood(t.db, `${DAY} 10:31:00.000`).points).toBe(3);
    expect(intradayMood(t.db, `${DAY} 23:00:00.000`).points).toBe(5);
    t.close();
  });
});

describe("盘中情绪 — 转变信号", () => {
  it("30 分钟内 width 塌了 → 转弱，且越塌级别越高", () => {
    const t = setup();
    seedPoint(t.db, `${DAY} 10:00:00.000`, 0.70, 1, -1);
    seedPoint(t.db, `${DAY} 10:30:00.000`, 0.45, 1, -1);   // −0.25，远超 −0.16
    const m = intradayMood(t.db, `${DAY} 10:31:00.000`);
    const s = m.signals.find(x => x.kind === "mood_shift" && x.title.includes("转弱"));
    expect(s).toBeDefined();
    expect(s!.level).toBe("critical");
    // 同一天同一件事只留一条，否则每 5 分钟重复弹同一条；critical 有自己的键
    expect(s!.dedupeKey).toBe(`mood:weak:critical:${DAY}`);
    expect(s!.supersededBy).toBeUndefined();
    t.close();
  });

  it("warn → critical 升级不能被 warn 的去重键吞掉；critical 之后的 warn 由 supersededBy 压掉", () => {
    const t = setup();
    seedPoint(t.db, `${DAY} 10:00:00.000`, 0.60, 1, -1);
    seedPoint(t.db, `${DAY} 10:30:00.000`, 0.50, 1, -1);   // −0.10：warn 档
    const w = intradayMood(t.db, `${DAY} 10:31:00.000`).signals
      .find(x => x.title === "盘中情绪转弱")!;
    expect(w.level).toBe("warn");
    seedPoint(t.db, `${DAY} 11:00:00.000`, 0.30, 1, -1);   // −0.20：critical 档
    const c = intradayMood(t.db, `${DAY} 11:01:00.000`).signals
      .find(x => x.title === "盘中情绪转弱")!;
    expect(c.level).toBe("critical");
    expect(c.dedupeKey).not.toBe(w.dedupeKey);
    expect(w.supersededBy).toBe(c.dedupeKey);
    t.close();
  });

  it("小幅回落不响 —— 阈值取实测 p05，日常波动不该弹窗", () => {
    const t = setup();
    seedPoint(t.db, `${DAY} 10:00:00.000`, 0.55, 1, -1);
    seedPoint(t.db, `${DAY} 10:30:00.000`, 0.52, 1, -1);   // −0.03，正常波动
    const m = intradayMood(t.db, `${DAY} 10:31:00.000`);
    expect(m.signals.filter(x => x.kind === "mood_shift")).toHaveLength(0);
    t.close();
  });

  it("开盘未满 30 分钟 → 不出转变信号，而不是拿开盘第一根跟自己比出 0", () => {
    const t = setup();
    seedPoint(t.db, `${DAY} 09:30:00.000`, 0.5);
    const m = intradayMood(t.db, `${DAY} 09:45:00.000`);
    expect(m.delta30).toBeNull();
    expect(m.signals.filter(x => x.kind === "mood_shift")).toHaveLength(0);
    t.close();
  });

  it("开盘急跌：还不到 30 分钟就塌了 —— 30 分钟窗口此时恒为 null，不能因此一条都不响", () => {
    const t = setup();
    seedPoint(t.db, `${DAY} 09:25:00.000`, 0.39, 1, -1);
    seedPoint(t.db, `${DAY} 09:50:00.000`, 0.20, 1, -1);   // −0.19，25 分钟内
    const m = intradayMood(t.db, `${DAY} 09:51:00.000`);
    expect(m.delta30).toBeNull();                  // 前提：确实拿不到 30 分钟窗口
    const s = m.signals.find(x => x.title === "开盘急跌");
    expect(s).toBeDefined();
    expect(s!.level).toBe("critical");
    t.close();
  });

  it("开盘小幅回落不响急跌 —— 高开回落在开盘阶段是常态", () => {
    const t = setup();
    seedPoint(t.db, `${DAY} 09:25:00.000`, 0.50, 1, -1);
    seedPoint(t.db, `${DAY} 09:50:00.000`, 0.45, 1, -1);   // −0.05
    const m = intradayMood(t.db, `${DAY} 09:51:00.000`);
    expect(m.signals.some(x => x.title === "开盘急跌")).toBe(false);
    t.close();
  });

  it("从开盘一路阴跌、且最近仍在下行 → 持续走弱；跌完了在反弹则不响", () => {
    const t = setup();
    seedPoint(t.db, `${DAY} 09:30:00.000`, 0.60, 1, -1);
    seedPoint(t.db, `${DAY} 13:00:00.000`, 0.44, 1, -1);   // 自开盘 −0.16
    seedPoint(t.db, `${DAY} 13:30:00.000`, 0.41, 1, -1);   // 最近仍在下行
    const down = intradayMood(t.db, `${DAY} 13:31:00.000`);
    expect(down.signals.some(x => x.title.includes("持续走弱"))).toBe(true);
    t.close();

    // 同样跌到 −0.16，但最近 30 分钟在反弹 → 是"跌完了"，不是"还在跌"
    const t2 = setup();
    seedPoint(t2.db, `${DAY} 09:30:00.000`, 0.60, 1, -1);
    seedPoint(t2.db, `${DAY} 13:00:00.000`, 0.40, 1, -1);
    seedPoint(t2.db, `${DAY} 13:30:00.000`, 0.44, 1, -1);   // 反弹
    const rec = intradayMood(t2.db, `${DAY} 13:31:00.000`);
    expect(rec.signals.some(x => x.title.includes("持续走弱"))).toBe(false);
    t2.close();
  });

  it("跌停潮 → critical，与日线口径的防守触发同一条线", () => {
    const t = setup();
    seedPoint(t.db, `${DAY} 10:00:00.000`, 0.3, 1, -1);
    const dins = t.db.prepare(
      `INSERT OR REPLACE INTO quote_snapshot (ts, code, price, pct, turnover, amplitude, bid_ask_json)
       VALUES (?, ?, 10, -10, 1, 1, NULL)`
    );
    db_transaction(t.db, () => {
      for (let i = 0; i < 35; i++) dins.run(`${DAY} 10:30:00.000`, `0${String(i).padStart(5, "0")}`);
    });
    seedPoint(t.db, `${DAY} 10:30:00.000`, 0.3, 1, -1);
    const m = intradayMood(t.db, `${DAY} 10:31:00.000`);
    const s = m.signals.find(x => x.kind === "limit_down_wave");
    expect(s).toBeDefined();
    expect(s!.level).toBe("critical");
    t.close();
  });
});

describe("盘中情绪 — 温度分与陈旧", () => {
  it("温度分落在 0~100，且普涨高于普跌", () => {
    const t = setup();
    seedPoint(t.db, `${DAY} 10:00:00.000`, 0.9, 3, -0.5);
    const hot = intradayMood(t.db, `${DAY} 10:05:00.000`);
    expect(hot.temp!).toBeGreaterThan(60);
    expect(hot.temp!).toBeLessThanOrEqual(100);
    t.close();

    const t2 = setup();
    seedPoint(t2.db, `${DAY} 10:00:00.000`, 0.05, 0.2, -5);
    const cold = intradayMood(t2.db, `${DAY} 10:05:00.000`);
    expect(cold.temp!).toBeLessThan(40);
    expect(cold.temp!).toBeGreaterThanOrEqual(0);
    t2.close();
  });

  it("极端值不会溢出 0~100", () => {
    const base: MoodPoint = {
      ts: "x", n: 1000, up: 0, down: 0, flat: 0, limitUp: 0, limitDown: 0, avgPct: 0, breadth: 0,
    };
    expect(moodTemp({ ...base, breadth: 1, avgPct: 10 })).toBe(100);
    expect(moodTemp({ ...base, breadth: 0, avgPct: -10 })).toBe(0);
  });

  it("快照超过 15 分钟没更新 → 标记陈旧（收盘后别拿 15:00 当现在）", () => {
    const t = setup();
    seedPoint(t.db, `${DAY} 10:00:00.000`, 0.5);
    expect(intradayMood(t.db, `${DAY} 10:05:00.000`).stale).toBe(false);
    expect(intradayMood(t.db, `${DAY} 11:00:00.000`).stale).toBe(true);
    expect(intradayMood(t.db, `${DAY} 23:00:00.000`).stale).toBe(true);
    t.close();
  });

  it("午休不算陈旧：11:30 最后一根，整个午休直到 13:15 都不该显示过期", () => {
    const t = setup();
    seedPoint(t.db, `${DAY} 11:30:00.000`, 0.5);
    expect(intradayMood(t.db, `${DAY} 11:50:00.000`).stale).toBe(false);
    expect(intradayMood(t.db, `${DAY} 12:45:00.000`).stale).toBe(false);
    expect(intradayMood(t.db, `${DAY} 13:10:00.000`).stale).toBe(false);   // 交易时间才过 10 分钟
    expect(intradayMood(t.db, `${DAY} 13:20:00.000`).stale).toBe(true);    // 下午开盘 20 分钟还没新快照
    t.close();
  });

  it("当天没有快照（休市）→ 整份为空，不拿昨天的数据冒充今天", () => {
    const t = setup();
    const m = intradayMood(t.db, `${DAY} 10:00:00.000`);
    expect(m.now).toBeNull();
    expect(m.temp).toBeNull();
    expect(m.signals).toHaveLength(0);
    t.close();
  });
});

describe("盘中情绪 — 午休", () => {
  it("交易时钟：午休不走表，13:00 紧接 11:30", () => {
    const ms = (hhmm: string) => Date.parse(`${DAY}T${hhmm}:00Z`);
    expect(tradeClockMs(ms("10:00"))).toBe(ms("10:00"));
    expect(tradeClockMs(ms("11:30"))).toBe(ms("11:30"));
    expect(tradeClockMs(ms("12:15"))).toBe(ms("11:30"));
    expect(tradeClockMs(ms("13:00"))).toBe(ms("11:30"));
    expect(tradeClockMs(ms("13:30")) - tradeClockMs(ms("11:00"))).toBe(60 * 60_000);
  });

  it("13:00 ~ 13:30 的 30 分钟窗口按交易时间往回数，而不是拿 11:30 冒充 30 分钟前", () => {
    const t = setup();
    seedPoint(t.db, `${DAY} 10:40:00.000`, 0.70, 1, -1);
    seedPoint(t.db, `${DAY} 11:00:00.000`, 0.66, 1, -1);
    seedPoint(t.db, `${DAY} 11:30:00.000`, 0.62, 1, -1);
    seedPoint(t.db, `${DAY} 13:10:00.000`, 0.60, 1, -1);
    const m = intradayMood(t.db, `${DAY} 13:11:00.000`);
    // 13:10 往回 30 个交易分钟 = 11:10 → 取到 11:00 那根
    expect(m.ago30!.ts.startsWith(`${DAY} 11:00`)).toBe(true);
    expect(m.delta30!.breadth).toBeCloseTo(-0.06, 6);

    const at13 = intradayMood(t.db, `${DAY} 13:00:30.000`);
    // 13:00 之前最后一根是 11:30 → 再往回 30 个交易分钟是 11:00
    expect(at13.now!.ts.startsWith(`${DAY} 11:30`)).toBe(true);
    expect(at13.ago30!.ts.startsWith(`${DAY} 11:00`)).toBe(true);
    t.close();
  });

  it("下午开盘不久、凑不满 30 个交易分钟 → 窗口为空，不拿上午更早的点放大位移", () => {
    const t = setup();
    seedPoint(t.db, `${DAY} 11:20:00.000`, 0.62, 1, -1);
    seedPoint(t.db, `${DAY} 11:30:00.000`, 0.62, 1, -1);
    seedPoint(t.db, `${DAY} 13:05:00.000`, 0.55, 1, -1);
    const m = intradayMood(t.db, `${DAY} 13:06:00.000`);
    // 13:05 → 交易时钟 11:35，往回 30 分钟 = 11:05，之前没有点 → 窗口为空
    expect(m.ago30).toBeNull();
    t.close();
  });
});
