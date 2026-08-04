import { describe, expect, it } from "vitest";
import {
  AccountUpsertSchema,
  BacktestRunSchema,
  CodeSchema,
  CodesQuerySchema,
  DateSchema,
  ExportSchema,
  ImportDryRunSchema,
  ManualFillSchema,
  StrategyParamWriteSchema,
  WatchpoolUpsertSchema,
} from "@/lib/ui/validate";
import { executionMode, inSession, shanghaiParts } from "@/lib/ui/status";
import { phaseAt } from "@/lib/ui/adapters/engines";

/**
 * API 入参校验。这些路由只监听 localhost，但浏览器里任何页面都能对 127.0.0.1
 * 发请求，而它们能改观察池、能落成交记录。所以校验不过必须拒绝，不做兜底猜测。
 */

describe("代码与日期", () => {
  it("代码必须是 6 位数字", () => {
    for (const good of ["600519", "000001", "301082", "832000"]) {
      expect(CodeSchema.safeParse(good).success).toBe(true);
    }
    for (const bad of ["60051", "6005199", "sh600519", "60051a", "", "'; DROP--", "600519 "]) {
      expect(CodeSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("日期必须是 YYYY-MM-DD", () => {
    expect(DateSchema.safeParse("2026-08-03").success).toBe(true);
    for (const bad of ["2026-8-3", "20260803", "2026/08/03", "yesterday"]) {
      expect(DateSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("codes 列表拆分并逐个校验，上限 200", () => {
    const r = CodesQuerySchema.safeParse("600519, 000001 ,301082");
    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual(["600519", "000001", "301082"]);
    expect(CodesQuerySchema.safeParse("600519,abc").success).toBe(false);
    expect(CodesQuerySchema.safeParse("").success).toBe(false);
    const many = new Array(201).fill("600519").join(",");
    expect(CodesQuerySchema.safeParse(many).success).toBe(false);
  });
});

describe("观察池条目", () => {
  it("接受留空的触发价/止损价（先记下标的也合理）", () => {
    expect(
      WatchpoolUpsertSchema.safeParse({ code: "600519", account: "贼王" }).success
    ).toBe(true);
    expect(
      WatchpoolUpsertSchema.safeParse({
        code: "600519",
        account: "价值",
        triggerPx: null,
        stopPx: null,
      }).success
    ).toBe(true);
  });

  it("账户只能是两个之一", () => {
    expect(WatchpoolUpsertSchema.safeParse({ code: "600519", account: "别的" }).success).toBe(false);
  });

  it("价格必须为正、有限", () => {
    for (const px of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        WatchpoolUpsertSchema.safeParse({ code: "600519", account: "贼王", triggerPx: px }).success
      ).toBe(false);
    }
  });
});

describe("手工成交回填", () => {
  const base = { accountId: "zw", code: "600519", side: "buy", px: 10, qty: 100 };

  it("完整合法输入通过", () => {
    expect(ManualFillSchema.safeParse(base).success).toBe(true);
  });

  it("方向只能 buy/sell", () => {
    expect(ManualFillSchema.safeParse({ ...base, side: "short" }).success).toBe(false);
  });

  it("价与量必须为正 —— 不接受「按市价」这种没有价的成交", () => {
    expect(ManualFillSchema.safeParse({ ...base, px: 0 }).success).toBe(false);
    expect(ManualFillSchema.safeParse({ ...base, qty: 0 }).success).toBe(false);
    expect(ManualFillSchema.safeParse({ ...base, px: "market" }).success).toBe(false);
  });

  it("非法时间戳被拒", () => {
    expect(ManualFillSchema.safeParse({ ...base, ts: "刚刚" }).success).toBe(false);
    expect(ManualFillSchema.safeParse({ ...base, ts: "2026-08-03T07:00:00Z" }).success).toBe(true);
  });

  it("费用不能为负", () => {
    expect(ManualFillSchema.safeParse({ ...base, fee: -1 }).success).toBe(false);
  });
});

describe("账户", () => {
  it("类型只能是贼王/价值（决定套哪套止损规则）", () => {
    expect(AccountUpsertSchema.safeParse({ id: "a", name: "n", type: "贼王" }).success).toBe(true);
    expect(AccountUpsertSchema.safeParse({ id: "a", name: "n", type: "融资" }).success).toBe(false);
  });
});

describe("回测参数", () => {
  it("初始资金必填且为正 —— 不替用户假设账户规模", () => {
    expect(
      BacktestRunSchema.safeParse({ from: "2024-01-01", to: "2024-06-30" }).success
    ).toBe(false);
    expect(
      BacktestRunSchema.safeParse({ from: "2024-01-01", to: "2024-06-30", initialCash: 0 }).success
    ).toBe(false);
    expect(
      BacktestRunSchema.safeParse({ from: "2024-01-01", to: "2024-06-30", initialCash: 1e6 }).success
    ).toBe(true);
  });
});

describe("策略参数写回", () => {
  it("路径不许含空格，值只能是纯量或纯量数组", () => {
    expect(StrategyParamWriteSchema.safeParse({ path: "持仓.贼王账户.止损", value: -0.05 }).success).toBe(true);
    expect(StrategyParamWriteSchema.safeParse({ path: "a b", value: 1 }).success).toBe(false);
    expect(StrategyParamWriteSchema.safeParse({ path: "a.b", value: { x: 1 } }).success).toBe(false);
  });
});

describe("导入导出路径", () => {
  it("导出只接受安全文件名，不接受任何路径分隔符", () => {
    expect(ExportSchema.safeParse({ fileName: "backup-1.ptbak" }).success).toBe(true);
    expect(ExportSchema.safeParse({}).success).toBe(true);
    for (const bad of ["../../etc/x.ptbak", "/tmp/x.ptbak", "a/b.ptbak", "x.db", "x.ptbak\n"]) {
      expect(ExportSchema.safeParse({ fileName: bad }).success).toBe(false);
    }
  });

  it("导入只接受 .ptbak", () => {
    expect(ImportDryRunSchema.safeParse({ bakPath: "/tmp/a.ptbak" }).success).toBe(true);
    expect(ImportDryRunSchema.safeParse({ bakPath: "/tmp/a.db" }).success).toBe(false);
  });
});

describe("执行模式：live 永远读不出来（红线 §18.2）", () => {
  // NODE_ENV 是 next 对 NodeJS.ProcessEnv 的必填增强（next/types/global.d.ts），
  // 不带它构造不出这个类型
  const env = (v?: string): NodeJS.ProcessEnv =>
    ({ NODE_ENV: "test", ...(v === undefined ? {} : { PANTRADER_EXECUTION_MODE: v }) });

  it("环境变量写 live 也降回 manual", () => {
    expect(executionMode(env("live"))).toBe("manual");
    expect(executionMode(env("LIVE"))).toBe("manual");
    expect(executionMode(env())).toBe("manual");
    expect(executionMode(env("真的要下单"))).toBe("manual");
  });

  it("paper 可用", () => {
    expect(executionMode(env("paper"))).toBe("paper");
  });
});

describe("交易时段与相位（Asia/Shanghai）", () => {
  it("按北京时间取日期，UTC 深夜不会算成前一天", () => {
    // UTC 2026-08-03T16:30 = 北京 2026-08-04 00:30
    expect(shanghaiParts(new Date("2026-08-03T16:30:00Z")).date).toBe("2026-08-04");
    expect(shanghaiParts(new Date("2026-08-03T07:10:00Z")).date).toBe("2026-08-03");
  });

  it("集合竞价与两个连续竞价时段算盘中", () => {
    expect(inSession(new Date("2026-08-03T01:20:00Z"))).toBe(true); // 09:20
    expect(inSession(new Date("2026-08-03T05:30:00Z"))).toBe(true); // 13:30
    expect(inSession(new Date("2026-08-03T04:00:00Z"))).toBe(false); // 12:00 午休
    expect(inSession(new Date("2026-08-03T08:00:00Z"))).toBe(false); // 16:00 收盘后
  });

  it("周末不算盘中", () => {
    // 2026-08-01 是周六
    expect(inSession(new Date("2026-08-01T02:00:00Z"))).toBe(false);
  });

  it("相位切分：盘前 / 盘中 / 盘后", () => {
    expect(phaseAt(new Date("2026-08-03T00:30:00Z"))).toBe("盘前"); // 08:30
    expect(phaseAt(new Date("2026-08-03T01:20:00Z"))).toBe("盘中"); // 09:20
    expect(phaseAt(new Date("2026-08-03T08:00:00Z"))).toBe("盘后"); // 16:00
  });
});
