import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import type { ErrorType, Prediction, Verdict } from "@/lib/contracts";

/**
 * 台账测试全部跑临时库。
 * 绝不碰 ~/PanTraderData/pantrader.db —— 那库有定时 job 在写，
 * 测试插脏数据会直接污染真实胜率统计。
 */
export function tmpDb(): { db: Db; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-ledger-"));
  const db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
  return { db, dir };
}

export function cleanup(db: Db, dir: string): void {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 生成 count 个工作日（跳周末），当交易日历用。 */
export function weekdays(from: string, count: number): string[] {
  const out: string[] = [];
  let t = Date.parse(`${from}T00:00:00Z`);
  while (out.length < count) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    t += 86400_000;
  }
  return out;
}

export function seedCalendar(db: Db, dates: string[]): void {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO trading_calendar (date, is_open, source) VALUES (?, 1, 'test')"
  );
  db.transaction(() => { for (const d of dates) stmt.run(d); })();
}

export function seedDaily(
  db: Db,
  code: string,
  bars: Array<{ date: string; c: number; l?: number; h?: number }>
): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO kline_daily (code, date, o, h, l, c, vol, amount, adj_factor)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1.0)`
  );
  db.transaction(() => {
    for (const b of bars) {
      stmt.run(code, b.date, b.c, b.h ?? b.c, b.l ?? b.c, b.c);
    }
  })();
}

/** ts 传完整 ISO（quote_snapshot 里存的是 UTC ISO 串，见 market-snapshot 采集器） */
export function seedSnapshot(db: Db, ts: string, code: string, price: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO quote_snapshot (ts, code, price, pct, turnover, amplitude, bid_ask_json)
     VALUES (?, ?, ?, 0, 0, 0, NULL)`
  ).run(ts, code, price);
}

export function mkPred(over: Partial<Prediction> = {}): Prediction {
  return {
    id: "p1",
    ts: "2026-08-03T15:30:00+08:00",
    phase: "盘后",
    code: "300502",
    strategyId: "s1",
    action: "买入",
    account: "卫星",
    triggerPx: 10,
    stopPx: 9,
    size: 0.1,
    thesis: "测试用",
    gear: "中性",
    evalHorizon: 5,
    validUntil: "2026-08-10",
    advisorInfluenced: false,
    ...over,
  };
}

/** 直接插预测行，绕过 record.ts 的校验，用于统计层的测试铺数据 */
export function insertPredRow(db: Db, p: Prediction): void {
  db.prepare(
    `INSERT INTO prediction (id, ts, phase, code, strategy_id, action, account, trigger_px,
       stop_px, size, thesis, gear, eval_horizon, valid_until, advisor_influenced)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(p.id, p.ts, p.phase, p.code, p.strategyId, p.action, p.account, p.triggerPx,
        p.stopPx, p.size, p.thesis, p.gear, p.evalHorizon, p.validUntil,
        p.advisorInfluenced ? 1 : 0);
}

export function insertOutcomeRow(
  db: Db,
  predId: string,
  verdict: Verdict,
  actualPct: number,
  errorType: ErrorType | null = null,
  settledAt = "2026-08-11T00:00:00.000Z"
): void {
  db.prepare(
    `INSERT INTO outcome (pred_id, verdict, actual_pct, error_type, attribution, settled_at)
     VALUES (?,?,?,?,?,?)`
  ).run(predId, verdict, actualPct, errorType, "test", settledAt);
}

/** 铺 n 条「预测 + 结果」，用于胜率 / 仪表盘统计 */
export function seedSettled(
  db: Db,
  n: number,
  opts: {
    idPrefix: string;
    hits: number;
    advisorInfluenced: boolean;
    phase?: Prediction["phase"];
    code?: string;
    errorType?: ErrorType | null;
    ts?: string;
    account?: Prediction["account"];
  }
): void {
  for (let i = 0; i < n; i++) {
    const id = `${opts.idPrefix}${i}`;
    const hit = i < opts.hits;
    insertPredRow(db, mkPred({
      id,
      ts: opts.ts ?? "2026-08-03T15:30:00+08:00",
      phase: opts.phase ?? "盘后",
      code: opts.code ?? "300502",
      account: opts.account ?? "卫星",
      advisorInfluenced: opts.advisorInfluenced,
    }));
    insertOutcomeRow(db, id, hit ? "命中" : "偏差", hit ? 8 : -6,
      hit ? null : (opts.errorType ?? "逆势扛"));
  }
}
