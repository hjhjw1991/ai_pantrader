import { describe, expect, it } from "vitest";
import type { Position } from "@/lib/contracts/execution";
import type { ZtRow } from "@/lib/contracts/pit";
import {
  hardLineAlerts,
  healthVerdict,
  portfolioRisk,
  positionPnl,
  triggerDistance,
  unavailable,
  ztStats,
} from "@/lib/ui/derive";

function pos(o: Partial<Position> = {}): Position {
  return {
    account: "贼王",
    code: "600519",
    qty: 1000,
    cost: 10,
    openDate: "2026-07-01",
    stopPx: null,
    thesis: "",
    ...o,
  };
}

describe("距离触发价：按回踩低吸定义", () => {
  it("跌到触发价及以下才算到位（用户不打板不追高）", () => {
    expect(triggerDistance(9.8, 10).reached).toBe(true);
    expect(triggerDistance(10, 10).reached).toBe(true);
    expect(triggerDistance(10.2, 10).reached).toBe(false);
  });

  it("差价与差价比例", () => {
    const d = triggerDistance(10.5, 10);
    expect(d.delta).toBeCloseTo(0.5, 10);
    expect(d.deltaRatio).toBeCloseTo(0.05, 10);
  });

  it("缺现价或缺触发价时给 null，不给 0", () => {
    expect(triggerDistance(null, 10).delta).toBeNull();
    expect(triggerDistance(10, null).delta).toBeNull();
    expect(triggerDistance(10, 0).delta).toBeNull(); // 0 触发价会让比例除爆
    expect(triggerDistance(NaN, 10).deltaRatio).toBeNull();
  });

  it("无现价时不许标成已到买点", () => {
    expect(triggerDistance(null, 10).reached).toBe(false);
  });
});

describe("浮动盈亏", () => {
  it("有报价时正常算", () => {
    const r = positionPnl(pos({ cost: 10, qty: 1000 }), 11);
    expect(r.marketValue).toBe(11000);
    expect(r.costValue).toBe(10000);
    expect(r.pnl).toBe(1000);
    expect(r.pnlRatio).toBeCloseTo(0.1, 10);
  });

  it("停牌/无快照时市值与浮盈亏都是 null —— 不拿成本价冒充现价", () => {
    const r = positionPnl(pos(), null);
    expect(r.marketValue).toBeNull();
    expect(r.pnl).toBeNull();
    expect(r.pnlRatio).toBeNull();
    // 成本是已知事实，仍然给
    expect(r.costValue).toBe(10000);
  });
});

describe("硬线告警", () => {
  const rules = { 贼王: { 止损: -0.05, 灾难位: -0.08, 止盈: [0.08, 0.15] } };

  it("逐票止损价被破 → danger", () => {
    const a = hardLineAlerts(
      [{ position: pos({ stopPx: 9.5 }), price: 9.4, stopPx: 9.5 }],
      rules
    );
    expect(a.some((x) => x.line === "止损" && x.level === "danger")).toBe(true);
  });

  it("破灾难位 → danger，且不再降级成普通止损", () => {
    const a = hardLineAlerts([{ position: pos(), price: 9.1, stopPx: null }], rules);
    const lines = a.map((x) => x.line);
    expect(lines).toContain("灾难位");
    expect(a.find((x) => x.line === "灾难位")!.level).toBe("danger");
  });

  it("过止盈档 → warn", () => {
    const a = hardLineAlerts([{ position: pos(), price: 11.6, stopPx: null }], rules);
    expect(a.some((x) => x.line === "止盈")).toBe(true);
  });

  it("没有配置账户规则时不套内置默认线（否则用户以为那是自己设的线）", () => {
    const a = hardLineAlerts([{ position: pos(), price: 8, stopPx: null }], {});
    expect(a).toHaveLength(0);
  });

  it("两个账户的规则不串用", () => {
    const a = hardLineAlerts(
      [{ position: pos({ account: "价值" }), price: 9.1, stopPx: null }],
      rules // 只配了贼王
    );
    expect(a).toHaveLength(0);
  });

  it("无报价的持仓不产生告警（拿不到价就无法判断是否破线）", () => {
    const a = hardLineAlerts([{ position: pos(), price: null, stopPx: 9.5 }], rules);
    expect(a).toHaveLength(0);
  });
});

describe("组合风控占比", () => {
  const rows = [
    { position: pos({ code: "600519", qty: 100, cost: 10 }), price: 20 },
    { position: pos({ code: "000001", qty: 200, cost: 5, account: "价值" as const }), price: 10 },
  ];

  it("总资产未记录时占比一律 null，不用持仓市值当分母", () => {
    const r = portfolioRisk(rows, null);
    expect(r.totalMarketValue).toBe(4000);
    expect(r.totalPositionRatio).toBeNull();
    expect(r.maxSingleRatio).toBeNull();
  });

  it("给了总资产才算占比", () => {
    const r = portfolioRisk(rows, 100000);
    expect(r.totalPositionRatio).toBeCloseTo(0.04, 10);
    expect(r.maxSingleRatio).toBeCloseTo(0.02, 10);
    expect(r.maxSingleCode).toBe("600519");
  });

  it("行业占比恒为 null —— 库里没有行业分类，不拿上市板冒充", () => {
    expect(portfolioRisk(rows, 100000).maxIndustryRatio).toBeNull();
  });

  it("任一票缺报价时合计为 null 并点名该票", () => {
    const r = portfolioRisk([...rows, { position: pos({ code: "300750" }), price: null }], 100000);
    expect(r.totalMarketValue).toBeNull();
    expect(r.totalPositionRatio).toBeNull();
    expect(r.missingQuoteCodes).toEqual(["300750"]);
  });

  it("按账户分别汇总", () => {
    const r = portfolioRisk(rows, null);
    expect(r.byAccount.find((a) => a.account === "贼王")!.marketValue).toBe(2000);
    expect(r.byAccount.find((a) => a.account === "价值")!.marketValue).toBe(2000);
  });
});

describe("涨停池原始聚合", () => {
  function zt(o: Partial<ZtRow>): ZtRow {
    return {
      date: "2026-08-03",
      code: "000001",
      lbc: 1,
      sealAmt: 1e7,
      openTimes: 0,
      firstSealTs: null,
      lastSealTs: null,
      sector: null,
      ...o,
    };
  }

  it("空池不编造任何数字", () => {
    const s = ztStats([]);
    expect(s.count).toBe(0);
    expect(s.maxLbc).toBeNull();
    expect(s.sealAmtMedian).toBeNull();
    expect(s.ladder).toEqual([]);
  });

  it("连板分布、最高板、炸板合计", () => {
    const s = ztStats([
      zt({ code: "a", lbc: 6, openTimes: 0 }),
      zt({ code: "b", lbc: 2, openTimes: 22 }),
      zt({ code: "c", lbc: 1, openTimes: 3 }),
      zt({ code: "d", lbc: 2, openTimes: 1 }),
    ]);
    expect(s.count).toBe(4);
    expect(s.maxLbc).toBe(6);
    expect(s.openTimesTotal).toBe(26);
    expect(s.byLbc).toEqual([
      { lbc: 6, n: 1 },
      { lbc: 2, n: 2 },
      { lbc: 1, n: 1 },
    ]);
    // 梯队只含 2 板及以上，按连板降序
    expect(s.ladder.map((r) => r.code)).toEqual(["a", "b", "d"]);
  });

  it("封单额中位数按偶数样本取中间两者均值", () => {
    const s = ztStats([
      zt({ code: "a", sealAmt: 100 }),
      zt({ code: "b", sealAmt: 200 }),
      zt({ code: "c", sealAmt: 300 }),
      zt({ code: "d", sealAmt: 400 }),
    ]);
    expect(s.sealAmtMedian).toBe(250);
  });

  it("板块计数按家数降序", () => {
    const s = ztStats([
      zt({ code: "a", sector: "电网" }),
      zt({ code: "b", sector: "电网" }),
      zt({ code: "c", sector: "军工" }),
      zt({ code: "d", sector: null }),
    ]);
    expect(s.bySector[0]).toEqual({ sector: "电网", n: 2 });
    expect(s.bySector).toHaveLength(2); // null 板块不成组
  });
});

describe("源健康判定：陈旧独立成一档", () => {
  it("上次成功但数据过时 → stale，不算 ok", () => {
    expect(
      healthVerdict({ lastOk: true, ageMinutes: 120, okRate: 1, staleAfterMinutes: 10 })
    ).toBe("stale");
  });

  it("从未有记录 → down", () => {
    expect(
      healthVerdict({ lastOk: true, ageMinutes: null, okRate: null, staleAfterMinutes: 10 })
    ).toBe("down");
  });

  it("最近一次失败 → down", () => {
    expect(
      healthVerdict({ lastOk: false, ageMinutes: 1, okRate: 0.9, staleAfterMinutes: 10 })
    ).toBe("down");
  });

  it("成功率低 → failing", () => {
    expect(
      healthVerdict({ lastOk: true, ageMinutes: 1, okRate: 0.5, staleAfterMinutes: 10 })
    ).toBe("failing");
  });

  it("新鲜 + 成功 + 高成功率 → ok", () => {
    expect(
      healthVerdict({ lastOk: true, ageMinutes: 1, okRate: 0.99, staleAfterMinutes: 10 })
    ).toBe("ok");
  });
});

describe("不可用状态", () => {
  it("必须带原因，可带补齐条件", () => {
    const u = unavailable("引擎未就绪", "等 M1");
    expect(u.available).toBe(false);
    expect(u.reason).toBe("引擎未就绪");
    expect(u.needs).toBe("等 M1");
  });
});
