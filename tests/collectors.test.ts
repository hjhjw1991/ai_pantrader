import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { collectMarketSnapshot } from "@/lib/data/collectors/market-snapshot";
import { collectZtPool } from "@/lib/data/collectors/cross-section";
import { collectWatchMinute } from "@/lib/data/collectors/watch-minute";
import { collectDaily } from "@/lib/data/collectors/daily";
import { collectLhb } from "@/lib/data/collectors/lhb";

let dir: string, db: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const gtimgLine = (code: string, name: string, price: string) => {
  const f = Array(88).fill("1");
  f[1] = name; f[2] = code; f[3] = price; f[4] = "12.0"; f[5] = "12.1";
  f[32] = "1.5"; f[33] = "13.2"; f[34] = "12.8"; f[38] = "2.2"; f[43] = "3.1";
  return `v_${code.startsWith("6") ? "sh" : "sz"}${code}="${f.join("~")}";`;
};

function clientReturning(text: string, ok = true) {
  return {
    source: "stub-source",
    breaker: { isOpen: () => false, record() {}, reset() {} } as any,
    async get() {
      return ok
        ? { ok: true as const, text, status: 200, latencyMs: 3 }
        : { ok: false as const, error: "empty response body", latencyMs: 3 };
    },
  };
}

describe("collectMarketSnapshot", () => {
  it("落库快照并返回写入条数", async () => {
    const text = [gtimgLine("601012", "隆基绿能", "13.0"),
                  gtimgLine("000001", "平安银行", "11.0")].join("\n");
    const r = await collectMarketSnapshot(db, clientReturning(text) as any, ["601012", "000001"]);
    expect(r.written).toBe(2);
    expect(r.failedBatches).toBe(0);
    const n = db.prepare("SELECT COUNT(*) n FROM quote_snapshot").get() as any;
    expect(n.n).toBe(2);
  });

  it("批次失败时记 data_gap，不抛穿也不静默", async () => {
    const r = await collectMarketSnapshot(db, clientReturning("", false) as any, ["601012"]);
    expect(r.written).toBe(0);
    expect(r.failedBatches).toBe(1);
    const gaps = db.prepare("SELECT * FROM data_gap").all();
    expect(gaps.length).toBe(1);
    expect((gaps[0] as any).recoverable).toBe(0);   // 快照不可回补
    expect((gaps[0] as any).kind).toBe("quote_snapshot");
  });

  it("超过 60 只自动分批", async () => {
    const codes = Array.from({ length: 130 }, (_, i) => String(600000 + i));
    const text = codes.map(c => gtimgLine(c, "x", "1.0")).join("\n");
    const r = await collectMarketSnapshot(db, clientReturning(text) as any, codes);
    // 3 批 (60+60+10)，每批 stub 都返回全部 130 行
    expect(r.failedBatches).toBe(0);
    expect(r.written).toBeGreaterThan(0);
  });
});

describe("collectZtPool", () => {
  it("落库涨停池", async () => {
    const payload = JSON.stringify({
      data: { qdate: 20260731, tc: 1, pool: [
        { c: "000593", n: "德龙汇能", lbc: 1, fund: 1000, zbc: 0,
          fbt: 93005, lbt: 145900, hybk: "燃气", hs: 1.81 }] },
    });
    const n = await collectZtPool(db, clientReturning(payload) as any, "20260731");
    expect(n).toBe(1);
    const row = db.prepare("SELECT * FROM zt_pool").get() as any;
    expect(row.code).toBe("000593");
    expect(row.date).toBe("2026-07-31");
    expect(row.first_seal_ts).toBe("09:30:05");
  });

  it("涨停池抓取失败记不可回补 gap 并抛错", async () => {
    await expect(collectZtPool(db, clientReturning("", false) as any, "20260731"))
      .rejects.toThrow();
    const gaps = db.prepare("SELECT * FROM data_gap WHERE kind='zt_pool'").all();
    expect(gaps.length).toBe(1);
    expect((gaps[0] as any).recoverable).toBe(0);
    expect((gaps[0] as any).date).toBe("2026-07-31");
  });
});

describe("collectWatchMinute", () => {
  it("落库分钟线", async () => {
    const bars = JSON.stringify([
      { day: "2026-07-31 14:55:00", open: "1", high: "2", low: "0.5", close: "1.5", volume: "100" },
    ]);
    const r = await collectWatchMinute(db, clientReturning(bars) as any, ["601012"], 5);
    expect(r.written).toBe(1);
    const row = db.prepare("SELECT * FROM kline_min").get() as any;
    expect(row.period).toBe("m5");
    expect(row.code).toBe("601012");
  });

  it("单只失败不影响其他，每只各记一条可回补 gap", async () => {
    const r = await collectWatchMinute(db, clientReturning("", false) as any, ["601012", "000001"], 5);
    expect(r.failed).toEqual(["601012", "000001"]);
    // 窗口内的瞬时失败是可回补的：下一轮的 240 根会带回来
    const gaps = db.prepare("SELECT COUNT(*) n FROM data_gap WHERE recoverable = 1").get() as any;
    expect(gaps.n).toBe(2);
  });
});

describe("collectDaily", () => {
  it("落库日线", async () => {
    const bars = JSON.stringify([
      { day: "2026-07-31", open: "1", high: "2", low: "0.5", close: "1.5", volume: "100" },
    ]);
    const r = await collectDaily(db, clientReturning(bars) as any, ["601012"], 10);
    expect(r.written).toBe(1);
    const row = db.prepare("SELECT * FROM kline_daily").get() as any;
    expect(row.date).toBe("2026-07-31");
    expect(row.adj_factor).toBe(1.0);
  });

  it("日线失败记的是可回补 gap", async () => {
    await collectDaily(db, clientReturning("", false) as any, ["601012"], 10);
    const g = db.prepare("SELECT * FROM data_gap").get() as any;
    expect(g.recoverable).toBe(1);
  });
});

describe("collectLhb", () => {
  /**
   * collectLhb 依次请求 明细 / 买方席位 / 卖方席位，所以桩要按调用顺序回不同的 payload。
   */
  function seqClient(payloads: string[]) {
    let i = 0;
    return {
      source: "eastmoney",
      async get() {
        const text = payloads[Math.min(i++, payloads.length - 1)];
        return { ok: true as const, text, status: 200, latencyMs: 1 };
      },
    };
  }

  const detail = (rows: any[]) => JSON.stringify({ result: { pages: 1, data: rows } });
  const noSeats = detail([]);

  it("落库龙虎榜并解决既有 gap", async () => {
    const payload = detail([{
      SECURITY_CODE: "601012", SECURITY_NAME_ABBR: "隆基绿能", CHANGE_TYPE: "137001001",
      TRADE_ID: 1, BILLBOARD_NET_AMT: 100, BILLBOARD_BUY_AMT: 200, BILLBOARD_SELL_AMT: 100,
      EXPLANATION: "日振幅值达到15%的前5只证券", EXPLAIN: "3家机构买入，成功率38%",
      TURNOVERRATE: 12.3, D1_CLOSE_ADJCHRATE: 1.2,
      D5_CLOSE_ADJCHRATE: null, D10_CLOSE_ADJCHRATE: null,
    }]);
    const r = await collectLhb(db, seqClient([payload, noSeats, noSeats]) as any, "2026-07-31");
    expect(r.fetched).toBe(1);
    expect(r.stored).toBe(1);
    const row = db.prepare("SELECT * FROM lhb").get() as any;
    expect(row.d1_chg).toBe(1.2);
    expect(row.d10_chg).toBe(null);
    expect(row.explanation).toBe("日振幅值达到15%的前5只证券");
    expect(row.explain_stat).toBe("3家机构买入，成功率38%");
  });

  it("同票多条上榜原因全部落库，不折叠", async () => {
    const mk = (ct: string, net: number) => ({
      SECURITY_CODE: "002131", SECURITY_NAME_ABBR: "利欧股份", CHANGE_TYPE: ct,
      BILLBOARD_NET_AMT: net, BILLBOARD_BUY_AMT: net, BILLBOARD_SELL_AMT: 0,
      EXPLANATION: `原因${ct}`, EXPLAIN: "stat",
    });
    const payload = detail([mk("137001004001", 1), mk("137001002001001", 2), mk("137001002001002", 3)]);
    const r = await collectLhb(db, seqClient([payload, noSeats, noSeats]) as any, "2026-07-31");
    expect(r.stored).toBe(3);
    const n = db.prepare("SELECT COUNT(*) n FROM lhb WHERE code='002131'").get() as any;
    expect(n.n).toBe(3);
  });

  it("落库行数少于抓取行数就抛错 —— 这是防主键折叠静默丢数据的断言", async () => {
    // 同一 (date, code, change_type) 出现两次：主键会折叠，stored 必然小于 fetched
    const same = {
      SECURITY_CODE: "002131", CHANGE_TYPE: "137001001",
      BILLBOARD_NET_AMT: 1, BILLBOARD_BUY_AMT: 1, BILLBOARD_SELL_AMT: 0,
      EXPLANATION: "x", EXPLAIN: "y",
    };
    const payload = detail([same, { ...same, BILLBOARD_NET_AMT: 2 }]);
    await expect(
      collectLhb(db, seqClient([payload, noSeats, noSeats]) as any, "2026-07-31")
    ).rejects.toThrow(/row loss/i);
    const g = db.prepare("SELECT * FROM data_gap").get() as any;
    expect(g.recoverable).toBe(1);
  });

  it("席位明细落库，重复采集同一天不翻倍", async () => {
    const seat = (dept: string, net: number) => ({
      SECURITY_CODE: "002131", CHANGE_TYPE: "137001001",
      OPERATEDEPT_CODE: "0", OPERATEDEPT_NAME: dept,
      BUY: 10, SELL: 1, NET: net, RISE_PROBABILITY_3DAY: 38.4,
    });
    // 两条都是 dept_code=0（机构专用），业务键做主键会丢一条
    const buy = detail([seat("机构专用", 9), seat("机构专用", 8)]);
    const payloads = [detail([]), buy, detail([])];
    const r1 = await collectLhb(db, seqClient(payloads) as any, "2026-07-31");
    expect(r1.seatsStored).toBe(2);
    const r2 = await collectLhb(db, seqClient(payloads) as any, "2026-07-31");
    expect(r2.seatsStored).toBe(2);
  });

  it("龙虎榜失败记的是可回补 gap", async () => {
    await expect(collectLhb(db, clientReturning("", false) as any, "2026-07-31"))
      .rejects.toThrow();
    const g = db.prepare("SELECT * FROM data_gap").get() as any;
    expect(g.recoverable).toBe(1);
  });
});

describe("collectDaily 的无序列处理", () => {
  const nullClient = {
    source: "sina",
    async get() { return { ok: true as const, text: "null", status: 200, latencyMs: 1 }; },
  };

  it("无序列的代码不记缺口 —— 记了就永远回补不掉", async () => {
    const r = await collectDaily(db, nullClient as any, ["001232"], 10);
    expect(r.noData).toEqual(["001232"]);
    expect(r.failed).toEqual([]);
    const g = db.prepare("SELECT COUNT(*) n FROM data_gap").get() as any;
    expect(g.n).toBe(0);
  });

  it("无序列占比过高时反而要告警 —— 大面积无数据更可能是限频", async () => {
    const codes = Array.from({ length: 120 }, (_, i) => String(600000 + i));
    const r = await collectDaily(db, nullClient as any, codes, 10);
    expect(r.noData.length).toBe(120);
    const g = db.prepare(
      "SELECT * FROM data_gap WHERE kind = 'kline_daily:no_data_spike'").get() as any;
    expect(g).toBeDefined();
    expect(g.reason).toMatch(/限频/);
  });

  it("正常水位（14/5888 量级）不触发告警", async () => {
    // 前 2 只无序列，其余正常 —— 2/120 远低于 5% 阈值
    let i = 0;
    const mixed = {
      source: "sina",
      async get() {
        const text = i++ < 2 ? "null" : JSON.stringify(
          [{ day: "2026-08-03", open: 1, high: 2, low: 1, close: 2, volume: 100 }]);
        return { ok: true as const, text, status: 200, latencyMs: 1 };
      },
    };
    const codes = Array.from({ length: 120 }, (_, k) => String(600000 + k));
    const r = await collectDaily(db, mixed as any, codes, 10);
    expect(r.noData.length).toBe(2);
    const g = db.prepare(
      "SELECT COUNT(*) n FROM data_gap WHERE kind = 'kline_daily:no_data_spike'").get() as any;
    expect(g.n).toBe(0);
  });
});

describe("collectWatchMinute 的无序列处理", () => {
  const nullClient = {
    source: "sina",
    async get() { return { ok: true as const, text: "null", status: 200, latencyMs: 1 }; },
  };

  it("无分钟序列的代码不记缺口 —— 分钟线 recoverable=0，记了就永远挂在告警里", async () => {
    const r = await collectWatchMinute(db, nullClient as any, ["000003"], 5);
    expect(r.noData).toEqual(["000003"]);
    expect(r.failed).toEqual([]);
    const n = db.prepare("SELECT COUNT(*) n FROM data_gap").get() as any;
    expect(n.n).toBe(0);
  });

  it("瞬时失败记可回补 —— 下一轮的 240 根会把它带回来", async () => {
    const r = await collectWatchMinute(db, clientReturning("", false) as any, ["601012"], 5);
    expect(r.failed).toEqual(["601012"]);
    expect(r.noData).toEqual([]);
    const g = db.prepare("SELECT * FROM data_gap").get() as any;
    // 早期版本标 0，一次限频就留 50 条永远消不掉的缺口，把真告警淹掉
    expect(g.recoverable).toBe(1);
  });

  it("下一轮成功会自动解决上一轮的缺口", async () => {
    await collectWatchMinute(db, clientReturning("", false) as any, ["601012"], 5);
    expect((db.prepare(
      "SELECT COUNT(*) n FROM data_gap WHERE resolved_at IS NULL").get() as any).n).toBe(1);

    const bars = JSON.stringify([
      { day: "2026-07-31 14:55:00", open: "1", high: "2", low: "0.5", close: "1.5", volume: "100" },
    ]);
    await collectWatchMinute(db, clientReturning(bars) as any, ["601012"], 5);
    expect((db.prepare(
      "SELECT COUNT(*) n FROM data_gap WHERE resolved_at IS NULL").get() as any).n).toBe(0);
  });
});

/**
 * 批次进度回调。
 *
 * 手动采集一轮全市场约 99 个批次、实测 45 秒，界面要画进度条。
 * 三条要求都是从"进度条骗人会怎样"倒推出来的：
 *   done 单调递增（失败批次也要计数，否则失败一批进度就永远卡在那里，看起来像挂了）；
 *   total 一开始就是最终值（中途变大的话进度条会倒退）；
 *   最后一次回调的 written / failedBatches 必须与返回值一致（结尾数字对不上会让人以为丢了数据）。
 */
describe("collectMarketSnapshot 的进度回调", () => {
  const codes = Array.from({ length: 130 }, (_, i) => String(600000 + i));

  it("每批一次回调，done 单调递增到 total", async () => {
    const text = gtimgLine("601012", "隆基绿能", "13.0");
    const seen: Array<{ done: number; total: number }> = [];
    const r = await collectMarketSnapshot(
      db, clientReturning(text) as any, codes,
      p => seen.push({ done: p.done, total: p.total })
    );
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((p, i) => i === 0 || p.done === seen[i - 1].done + 1)).toBe(true);
    expect(seen[seen.length - 1].done).toBe(seen[0].total);
    expect(r.written).toBeGreaterThan(0);
  });

  it("total 从第一条起就是最终值 —— 中途变大会让进度条倒退", async () => {
    const seen: number[] = [];
    await collectMarketSnapshot(
      db, clientReturning(gtimgLine("601012", "x", "13.0")) as any, codes,
      p => seen.push(p.total)
    );
    expect(new Set(seen).size).toBe(1);
  });

  it("批次失败也报进度，并把失败数带出来 —— 卡住的进度条会被当成程序死了", async () => {
    const failing = {
      source: "tencent",
      breaker: { isOpen: () => false, record() {}, reset() {} },
      async get() { return { ok: false as const, error: "boom", latencyMs: 1 }; },
    };
    const seen: Array<{ done: number; failedBatches: number }> = [];
    const r = await collectMarketSnapshot(
      db, failing as any, codes,
      p => seen.push({ done: p.done, failedBatches: p.failedBatches })
    );
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1].done).toBe(seen.length);
    expect(seen[seen.length - 1].failedBatches).toBe(r.failedBatches);
    expect(r.failedBatches).toBeGreaterThan(0);
  });

  it("不传回调也照常工作 —— 定时任务没人看着，不该为进度付开销", async () => {
    const r = await collectMarketSnapshot(
      db, clientReturning(gtimgLine("601012", "x", "13.0")) as any, ["601012"]
    );
    expect(r.written).toBe(1);
  });
});
