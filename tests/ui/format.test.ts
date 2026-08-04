import { describe, expect, it } from "vitest";
import {
  DASH,
  ageMinutes,
  dirClass,
  fmtAge,
  fmtAmount,
  fmtInt,
  fmtPct,
  fmtPx,
  fmtQty,
  fmtRatio,
  fmtTs,
  gearClass,
} from "@/lib/ui/format";
import { dbTsToMs, toShanghaiWall } from "@/lib/ui/time";

/**
 * 格式化层最重要的性质：**缺失渲染成破折号，不是 0**。
 * 0 在交易界面里是有意义的数值（平盘、零仓位、零净买额），
 * 把"不知道"渲染成 0 就是把假数字摆到用户面前。
 */
describe("缺失值不得渲染成 0", () => {
  const missing = [null, undefined, NaN, Infinity, -Infinity];

  it("价格", () => {
    for (const v of missing) expect(fmtPx(v as number | null)).toBe(DASH);
    expect(fmtPx(0)).toBe("0.00"); // 真的 0 要照实显示
  });

  it("涨跌幅 / 比例 / 金额 / 数量 / 整数", () => {
    for (const v of missing) {
      expect(fmtPct(v as number | null)).toBe(DASH);
      expect(fmtRatio(v as number | null)).toBe(DASH);
      expect(fmtAmount(v as number | null)).toBe(DASH);
      expect(fmtQty(v as number | null)).toBe(DASH);
      expect(fmtInt(v as number | null)).toBe(DASH);
    }
  });

  it("真实的 0 与缺失可区分", () => {
    expect(fmtPct(0)).toBe("0.00%");
    expect(fmtRatio(0)).toBe("0.0%");
    expect(fmtAmount(0)).toBe("0");
    expect(fmtPct(null)).not.toBe(fmtPct(0));
  });
});

describe("涨跌方向色：红涨绿跌（中国市场惯例）", () => {
  it("正为红、负为绿、零与缺失为中性", () => {
    expect(dirClass(1.2)).toBe("text-up");
    expect(dirClass(-1.2)).toBe("text-down");
    expect(dirClass(0)).toBe("text-flat");
    expect(dirClass(null)).toBe("text-flat");
    expect(dirClass(NaN)).toBe("text-flat");
  });

  it("绝不把上涨映射到绿色（写反的代价是下反向单）", () => {
    expect(dirClass(5)).not.toBe("text-down");
    expect(dirClass(-5)).not.toBe("text-up");
  });
});

describe("涨跌幅带符号", () => {
  it("上涨带 +，下跌带 -", () => {
    expect(fmtPct(3.456)).toBe("+3.46%");
    expect(fmtPct(-3.456)).toBe("-3.46%");
  });
});

describe("金额单位", () => {
  it("按万/亿收敛，负号保留", () => {
    expect(fmtAmount(1234)).toBe("1234");
    expect(fmtAmount(12345)).toBe("1万");
    expect(fmtAmount(199_000_000)).toBe("1.99亿");
    expect(fmtAmount(-199_000_000)).toBe("-1.99亿");
  });
});

/**
 * 库里有两种时间戳口径：migration 006 之后是上海挂钟串（`2026-08-03 15:10:49.052`），
 * 之前是 UTC ISO（`2026-08-03T07:10:49.052Z`）。显示层必须两种都认对。
 *
 * 认错的后果不是"差 8 小时"：把 UTC 的 07:10 当挂钟显示，看上去是盘前数据，
 * 实际是收盘价 —— 拿它当现价判断会直接下错单。
 */
describe("时间一律按上海时间显示，两种库内口径都认", () => {
  it("UTC ISO 串按 +8 折算：07:10Z → 15:10", () => {
    expect(fmtTs("2026-08-03T07:10:49.052Z")).toBe("15:10:49");
    expect(fmtTs("2026-08-03T07:10:49.052Z", true)).toBe("08/03 15:10:49");
  });

  it("上海挂钟串原样显示，不再二次加 8 小时", () => {
    expect(fmtTs("2026-08-03 15:10:49.052")).toBe("15:10:49");
    expect(fmtTs("2026-08-03 15:10:49.052", true)).toBe("08/03 15:10:49");
    // 分钟线/板块榜给的是不带毫秒的挂钟串
    expect(fmtTs("2026-08-03 14:55:00")).toBe("14:55:00");
  });

  it("跨零点的 UTC 时间归到正确的北京日期", () => {
    // UTC 2026-08-03T16:30 = 北京 2026-08-04 00:30
    expect(fmtTs("2026-08-03T16:30:00Z", true)).toBe("08/04 00:30:00");
  });

  it("带显式偏移的串也按绝对时刻折算", () => {
    expect(fmtTs("2026-08-03T15:10:49+08:00")).toBe("15:10:49");
  });

  it("空值与非法值不编造时间", () => {
    expect(fmtTs(null)).toBe(DASH);
    expect(fmtTs("")).toBe(DASH);
    expect(fmtTs("not-a-date")).toBe("not-a-date");
  });
});

describe("时间戳归一（lib/ui/time）", () => {
  it("两种口径归到同一个挂钟串", () => {
    expect(toShanghaiWall("2026-08-03T07:10:49.052Z")).toBe("2026-08-03 15:10:49.052");
    expect(toShanghaiWall("2026-08-03 15:10:49.052")).toBe("2026-08-03 15:10:49.052");
    expect(toShanghaiWall("2026-08-03")).toBe("2026-08-03 00:00:00");
    expect(toShanghaiWall("乱写")).toBeNull();
    expect(toShanghaiWall(null)).toBeNull();
  });

  it("两种口径归到同一个绝对时刻（挂钟按 +08:00 解释，不按本机时区）", () => {
    const a = dbTsToMs("2026-08-03T07:10:49.052Z");
    const b = dbTsToMs("2026-08-03 15:10:49.052");
    expect(a).toBe(Date.parse("2026-08-03T07:10:49.052Z"));
    expect(b).toBe(a);
  });

  it("非法输入给 null，不回落到「现在」", () => {
    expect(dbTsToMs(null)).toBeNull();
    expect(dbTsToMs("garbage")).toBeNull();
  });
});

describe("新鲜度", () => {
  const now = new Date("2026-08-04T02:00:00Z");

  it("按分钟计龄，缺失为 null 而非 0", () => {
    expect(ageMinutes("2026-08-04T01:30:00Z", now)).toBe(30);
    expect(ageMinutes(null, now)).toBeNull();
    expect(ageMinutes("garbage", now)).toBeNull();
  });

  it("挂钟串与 UTC 串算出同一个年龄（不受本机时区影响）", () => {
    // 2026-08-04T01:30Z = 北京 09:30
    expect(ageMinutes("2026-08-04 09:30:00", now)).toBe(30);
  });

  it("人类可读", () => {
    expect(fmtAge(null)).toBe(DASH);
    expect(fmtAge(0.5)).toBe("刚刚");
    expect(fmtAge(30)).toBe("30分钟前");
    expect(fmtAge(19 * 60)).toBe("19小时前");
    expect(fmtAge(3 * 1440)).toBe("3天前");
  });
});

describe("环境档位色", () => {
  it("三档各有色，未知不套默认档", () => {
    expect(gearClass("进攻")).toBe("text-gear-attack");
    expect(gearClass("中性")).toBe("text-gear-neutral");
    expect(gearClass("防守")).toBe("text-gear-defend");
    expect(gearClass(null)).toBe("text-ink-3");
    expect(gearClass("乱写")).toBe("text-ink-3");
  });
});
