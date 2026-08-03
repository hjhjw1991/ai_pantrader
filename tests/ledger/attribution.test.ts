import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "@/lib/db";
import {
  DEFAULT_RUNUP_CAP_PCT,
  attributeOutcome,
  buildAttributionInput,
  classifyError,
  type AttributionInput,
} from "@/lib/ledger/attribution";
import { reconcile, settleOne } from "@/lib/ledger/reconcile";
import { recordPrediction } from "@/lib/ledger/record";
import { cleanup, mkPred, seedCalendar, seedDaily, seedSnapshot, tmpDb, weekdays } from "./helpers";

function input(over: Partial<AttributionInput> = {}): AttributionInput {
  return {
    verdict: "偏差",
    action: "买入",
    quoteAgeSec: 10,
    decisionPxDeviationPct: 0.2,
    mainlineSector: null,
    mandatoryChain: [],
    scannedSectors: null,
    stopBreached: false,
    exitSignalAfterBreach: false,
    priorRunupPct: 5,
    runupCapPct: DEFAULT_RUNUP_CAP_PCT,
    ...over,
  };
}

describe("ledger/attribution 规则", () => {
  it("没判偏差就不归错因 —— 命中/中性的 errorType 必须是 null", () => {
    expect(classifyError(input({ verdict: "命中", stopBreached: true })).errorType).toBeNull();
    expect(classifyError(input({ verdict: "中性", stopBreached: true })).errorType).toBeNull();
  });

  it("瞬时价误判：决策用的报价已经放了 20 分钟（旧缓存价）", () => {
    const r = classifyError(input({ quoteAgeSec: 1200 }));
    expect(r.errorType).toBe("瞬时价误判");
    expect(r.attribution).toContain("1200");
  });

  it("瞬时价误判：信号价与当日收盘偏离 8%（拿盘中抖动价下的判断）", () => {
    expect(classifyError(input({ decisionPxDeviationPct: -8 })).errorType).toBe("瞬时价误判");
  });

  it("板块漏扫：主线在必查链里却没被扫到（2026-07-27 的根因）", () => {
    const r = classifyError(input({
      mainlineSector: "半导体设备",
      mandatoryChain: ["半导体设备", "光模块"],
      scannedSectors: ["光模块", "军工"],
    }));
    expect(r.errorType).toBe("板块漏扫");
    expect(r.attribution).toContain("半导体设备");
  });

  it("板块漏扫：主线扫到了就不算漏扫；主线不在必查链里也不算（那是选链问题）", () => {
    expect(classifyError(input({
      mainlineSector: "半导体设备",
      mandatoryChain: ["半导体设备"],
      scannedSectors: ["半导体设备"],
    })).errorType).toBe("其他");
    expect(classifyError(input({
      mainlineSector: "食品饮料",
      mandatoryChain: ["半导体设备"],
      scannedSectors: [],
    })).errorType).toBe("其他");
  });

  it("逆势扛：破了止损而且此后没出过减仓/清仓信号", () => {
    const r = classifyError(input({ priorRunupPct: 5, stopBreached: true, exitSignalAfterBreach: false }));
    expect(r.errorType).toBe("逆势扛");
    // 破位后出了离场信号 = 有纪律，不算逆势扛
    expect(classifyError(input({ stopBreached: true, exitSignalAfterBreach: true })).errorType)
      .toBe("其他");
  });

  it("追高：买入前累计涨幅 45% 已超位置涨幅上限 30%", () => {
    const r = classifyError(input({ priorRunupPct: 45 }));
    expect(r.errorType).toBe("追高");
    expect(r.attribution).toContain("45");
    // 卖出动作谈不上追高
    expect(classifyError(input({ action: "清仓", priorRunupPct: 45 })).errorType).toBe("其他");
  });

  it("优先级：输入价错 > 板块漏扫 > 追高 > 逆势扛（越靠前越是根因）", () => {
    const all = input({
      quoteAgeSec: 1200,
      mainlineSector: "半导体设备",
      mandatoryChain: ["半导体设备"],
      scannedSectors: [],
      priorRunupPct: 45,
      stopBreached: true,
    });
    expect(classifyError(all).errorType).toBe("瞬时价误判");
    expect(classifyError({ ...all, quoteAgeSec: 10 }).errorType).toBe("板块漏扫");
    expect(classifyError({ ...all, quoteAgeSec: 10, mainlineSector: null }).errorType).toBe("追高");
    expect(classifyError({
      ...all, quoteAgeSec: 10, mainlineSector: null, priorRunupPct: 5,
    }).errorType).toBe("逆势扛");
  });

  it("什么线索都没有时落在 其他，不编原因", () => {
    const r = classifyError(input({ quoteAgeSec: null, decisionPxDeviationPct: null, priorRunupPct: null }));
    expect(r.errorType).toBe("其他");
    expect(r.rule).toBeNull();
  });
});

describe("ledger/attribution 取事实", () => {
  let db: Db, dir: string;
  beforeEach(() => {
    ({ db, dir } = tmpDb());
    seedCalendar(db, weekdays("2026-07-01", 60));
  });
  afterEach(() => cleanup(db, dir));

  it("buildAttributionInput 从库里算出破止损、离场信号、买前涨幅、报价陈旧度", () => {
    const d = weekdays("2026-07-01", 30);
    const base = d[22];
    // d[3] 是 20 日窗口内的最低点 7.0，基准日收 10.0 → 买前已涨 42.8%
    const bars = d.slice(0, 23).map((day, i) => ({
      date: day, c: i === 3 ? 7 : 9.5, l: i === 3 ? 7 : 9.4,
    }));
    bars[22] = { date: base, c: 10, l: 10 };
    bars.push({ date: d[23], c: 8.9, l: 8.5 });   // horizon 末日，盘中破了 9 的止损
    seedDaily(db, "300502", bars);
    // 决策时刻前 30 分钟的快照 —— 用来算报价陈旧度
    seedSnapshot(db, `${base}T06:30:00.000Z`, "300502", 10);

    const p = mkPred({
      id: "f1", ts: `${base}T07:00:00.000Z`, phase: "盘后",
      stopPx: 9, evalHorizon: 1, validUntil: d[23],
    });
    const att = settleOne(db, p, {});
    expect(att.ok).toBe(true);

    const inp = buildAttributionInput(db, p, att.facts!, att.outcome!.verdict);
    expect(inp.stopBreached).toBe(true);
    expect(inp.exitSignalAfterBreach).toBe(false);
    expect(inp.priorRunupPct).toBeGreaterThan(40);
    expect(inp.quoteAgeSec).toBeCloseTo(1800, 0);
  });

  it("attributeOutcome 把错因写回已结算的 outcome 行", () => {
    seedDaily(db, "300502", [
      { date: "2026-07-01", c: 10 },
      { date: "2026-07-02", c: 8.5, l: 8.4 },
    ]);
    recordPrediction(db, mkPred({
      id: "w1", ts: "2026-07-01T15:30:00+08:00", stopPx: 9,
      evalHorizon: 1, validUntil: "2026-07-02",
    }));
    reconcile(db, { asOf: "2026-07-03" });

    const r = attributeOutcome(db, "w1");
    expect(r!.errorType).toBe("逆势扛");
    const row = db.prepare("SELECT error_type, attribution FROM outcome WHERE pred_id='w1'").get() as any;
    expect(row.error_type).toBe("逆势扛");
    expect(row.attribution).toContain("逆势扛");
    // 原有的对账事实不能被覆盖掉
    expect(row.attribution).toContain("kline_daily");
  });

  it("reconcile 传入 attribute 钩子时可以一次落地错因", () => {
    seedDaily(db, "300502", [
      { date: "2026-07-01", c: 10 },
      { date: "2026-07-02", c: 8.5, l: 8.4 },
    ]);
    recordPrediction(db, mkPred({
      id: "h1", ts: "2026-07-01T15:30:00+08:00", stopPx: 9,
      evalHorizon: 1, validUntil: "2026-07-02",
    }));
    const rep = reconcile(db, {
      asOf: "2026-07-03",
      attribute: (pred, facts, verdict) =>
        classifyError(buildAttributionInput(db, pred, facts, verdict)),
    });
    expect(rep.settled[0].errorType).toBe("逆势扛");
  });
});
