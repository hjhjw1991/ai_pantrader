/**
 * 风险层因子：超买超卖 / ST 状态 / 解禁压力。
 *
 * 按三层分离的设计，这批因子**不进选股打分**，它们只回答一个问题：
 * "这只票现在有没有一个足以一票否决、或者该让持仓人警觉的风险？"
 * 混进打分里加权，一个 ST 戴帽会被三个好看的技术分冲淡 —— 而戴帽不该被冲淡。
 *
 * 价格一律走 adjClose（后复权）：除权那天原始价会凭空跌一截，
 * 拿原始价算 RSI，每个分红季都会造出一批不存在的"超卖"。
 */
import type { DailyBar, FactorSpec, PointInTimeView } from "@/lib/contracts";
import { adjClose, barsUpTo, mean, pnum, requireCode, round6, evalDate } from "@/lib/factors/util";
import { wasSt } from "@/lib/factors/limit-up";

const V = "1.0.0";

/* -------------------------------- 纯函数 -------------------------------- */

/**
 * 通达信的 SMA(X, N, M)：Y = (M·X + (N−M)·Y') / N，首值取 X[0]。
 *
 * 不是简单均线。RSI、KDJ 在 A 股软件里都用它，若换成 Wilder 或 EMA，
 * 算出来的数字与用户在券商 App 上看到的对不上 —— 那种"系统说超买、
 * 我软件上看才 70"的对不上，会让人整个不信这套东西。
 */
export function tdxSma(xs: number[], n: number, m: number): number[] {
  const out: number[] = [];
  let y = xs.length > 0 ? xs[0] : 0;
  for (let i = 0; i < xs.length; i++) {
    y = i === 0 ? xs[0] : (m * xs[i] + (n - m) * y) / n;
    out.push(y);
  }
  return out;
}

/** RSI(n)。样本不足返回 null；完全横盘（涨跌都为 0）返回 50 而不是 NaN */
export function rsi(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const up: number[] = [], abs: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    up.push(Math.max(d, 0));
    abs.push(Math.abs(d));
  }
  const a = tdxSma(up, n, 1), b = tdxSma(abs, n, 1);
  const num = a[a.length - 1], den = b[b.length - 1];
  if (den === 0) return 50;
  return round6((num / den) * 100);
}

/** 乖离率 BIAS(n)，单位百分点 */
export function bias(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  const ma = mean(closes.slice(closes.length - n));
  if (ma === 0) return null;
  return round6(((closes[closes.length - 1] - ma) / ma) * 100);
}

/** KDJ(n, m1, m2)。RSV 用 N 日最高最低；区间为零（一字）时 RSV 取 50 */
export function kdj(
  highs: number[], lows: number[], closes: number[], n: number, m1: number, m2: number
): { k: number; d: number; j: number } | null {
  if (closes.length < n) return null;
  const rsv: number[] = [];
  for (let i = n - 1; i < closes.length; i++) {
    const hh = Math.max(...highs.slice(i - n + 1, i + 1));
    const ll = Math.min(...lows.slice(i - n + 1, i + 1));
    rsv.push(hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100);
  }
  const ks = tdxSma(rsv, m1, 1);
  const dsr = tdxSma(ks, m2, 1);
  const k = ks[ks.length - 1], d = dsr[dsr.length - 1];
  return { k: round6(k), d: round6(d), j: round6(3 * k - 2 * d) };
}

/* ------------------------------- 超买超卖 ------------------------------- */

/**
 * 超买超卖：RSI / 乖离率 / KDJ 三项投票。
 *
 * 值域 [−4, +4]，正为超买、负为超卖。三项分开投票而不是合成一个数，
 * 为的是卡片上看得出**是哪一项在报警**：RSI 90 与乖离 30% 是两种不同的过热。
 *
 * 20cm 板（创业板/科创板）的乖离容忍更宽：同样 +15% 的乖离，
 * 主板是四天连板的量级，创业板只是一个大阳。用同一把尺子会把创业板的正常波动全判成过热。
 *
 * **这个因子与"不限制打板"天然有张力**：连板股的 RSI 几乎一定在 90 以上。
 * 所以筛那一侧默认只在"严重超买"时否决，普通超买只上卡片提示，阈值都在 YAML 里可调。
 */
const 超买超卖: FactorSpec<number> = {
  name: "超买超卖", version: V, group: "tech",
  defaults: {
    RSI周期: 6, RSI超买: 80, RSI严重超买: 90, RSI超卖: 20, RSI严重超卖: 10,
    乖离周期: 5, 乖离上限: 15, 乖离上限_20cm: 25,
    KDJ周期: 9, KDJ超买: 100, KDJ超卖: 0,
  },
  fn: ctx => {
    const code = requireCode(ctx.params, "超买超卖");
    const date = evalDate(ctx.view, ctx.params);
    const p = (k: string, d: number) => pnum(ctx.params, k, d);

    const bars: DailyBar[] = barsUpTo(ctx.view, code, date, 40);
    // RSI(6)/KDJ(9) 各自的平滑都要预热，20 根以下的读数随首值漂得厉害，不可信
    if (bars.length < 20) {
      return {
        name: "超买超卖", version: V, value: 0, label: "样本不足",
        provenance: "real", confidence: 0,
        inputs: { 代码: code, 日期: date, 日线根数: bars.length },
      };
    }

    const cs = bars.map(adjClose);
    const hs = bars.map(b => b.h * (b.adjFactor ?? 1));
    const ls = bars.map(b => b.l * (b.adjFactor ?? 1));

    const r = rsi(cs, p("RSI周期", 6));
    const bi = bias(cs, p("乖离周期", 5));
    const kd = kdj(hs, ls, cs, p("KDJ周期", 9), 3, 3);

    const board = ctx.view.security(code)?.board;
    const wide = board === "创业板" || board === "科创板";
    const 乖离阈 = wide ? p("乖离上限_20cm", 25) : p("乖离上限", 15);

    let v = 0;
    if (r !== null) {
      if (r >= p("RSI严重超买", 90)) v += 2;
      else if (r >= p("RSI超买", 80)) v += 1;
      else if (r <= p("RSI严重超卖", 10)) v -= 2;
      else if (r <= p("RSI超卖", 20)) v -= 1;
    }
    const 乖离超限 = bi !== null && bi >= 乖离阈;
    if (乖离超限) v += 1;
    else if (bi !== null && bi <= -乖离阈) v -= 1;
    if (kd !== null) {
      if (kd.j > p("KDJ超买", 100)) v += 1;
      else if (kd.j < p("KDJ超卖", 0)) v -= 1;
    }

    const label = v >= 3 ? "严重超买" : v >= 1 ? "超买" : v <= -3 ? "严重超卖" : v <= -1 ? "超卖" : "中性";
    return {
      name: "超买超卖", version: V, value: v, label,
      provenance: "real", confidence: 1,
      inputs: {
        代码: code, 日期: date,
        RSI: r, 乖离率: bi, 乖离阈值: 乖离阈, 乖离超限,
        KDJ_J: kd === null ? null : kd.j,
      },
    };
  },
};

/* -------------------------------- ST 状态 -------------------------------- */

/**
 * 评估日那天是不是 ST / *ST。
 *
 * ST 票涨跌幅 5%、退市风险真实存在，而且摘帽之前它就是那个票 ——
 * 这个判据**不该**被别的好看的读数冲淡，所以它只做否决，不参与打分。
 *
 * **观测起点问题**：库里的 ST 区间是从证券简称里观测出来的，而观测从系统上线那天
 * （2026-08-04）才开始 —— 实测 328 只 ST 票的区间**全部**从这一天起算。
 * 所以早于观测起点的日期，"没有 ST 区间"不代表"不是 ST"，只代表"没看见"。
 * 这里如实返回 confidence 0，而不是说"不是 ST" —— 后者会让回测在 2024 年
 * 放心地买进一只当时正戴着帽的票。
 */
const ST状态: FactorSpec<number> = {
  name: "ST状态", version: V, group: "filter",
  defaults: { ST观测起点: "2026-08-04" },
  fn: ctx => {
    const code = requireCode(ctx.params, "ST状态");
    const date = evalDate(ctx.view, ctx.params);
    const sec = ctx.view.security(code);
    const since = typeof ctx.params["ST观测起点"] === "string"
      ? ctx.params["ST观测起点"] as string : "2026-08-04";

    if (sec === null) {
      return {
        name: "ST状态", version: V, value: 0, label: "证券未知",
        provenance: "real", confidence: 0, inputs: { 代码: code, 日期: date },
      };
    }
    const st = wasSt(sec, date);
    // 观测起点之前：是 ST 就是 ST（区间确实覆盖到了），不是就只能说"没看见"
    if (!st && date < since) {
      return {
        name: "ST状态", version: V, value: 0, label: "未观测",
        provenance: "real", confidence: 0,
        inputs: { 代码: code, 日期: date, 观测起点: since },
      };
    }
    return {
      name: "ST状态", version: V, value: st ? 1 : 0, label: st ? "ST" : "非ST",
      provenance: "real", confidence: 1,
      inputs: { 代码: code, 日期: date, 名称: sec.name },
    };
  },
};

/* ------------------------------- 解禁压力 ------------------------------- */

/**
 * 未来 N 天（默认 90）的限售解禁，占**解禁前流通股**的比例之和。
 *
 * 分母是流通股而不是总股本：抛压是冲着流通盘去的。一只流通盘很小的票，
 * 解禁 5% 总股本可能等于流通盘翻倍 —— 用总股本口径会把这种最危险的情形算轻。
 *
 * 比例缺失的批次不当成 0：不知道多少不等于没有，confidence 按缺失批次打折。
 */
const 解禁压力: FactorSpec<number> = {
  name: "解禁压力", version: V, group: "filter",
  defaults: { 前瞻天数: 90, 预警比例: 0.05, 严重比例: 0.15 },
  fn: ctx => {
    const code = requireCode(ctx.params, "解禁压力");
    const date = evalDate(ctx.view, ctx.params);
    const days = pnum(ctx.params, "前瞻天数", 90);
    const lifts = ctx.view.liftsAhead(code, days);

    const known = lifts.filter(l => l.freeRatio !== null);
    const sum = round6(known.reduce((a, l) => a + (l.freeRatio as number), 0));
    const missing = lifts.length - known.length;
    const 预警 = pnum(ctx.params, "预警比例", 0.05), 严重 = pnum(ctx.params, "严重比例", 0.15);

    const label = lifts.length === 0 ? "无解禁"
      : sum >= 严重 ? "严重" : sum >= 预警 ? "预警" : "小额";
    return {
      name: "解禁压力", version: V, value: sum, label,
      provenance: "real",
      confidence: lifts.length === 0 ? 1 : round6(known.length / lifts.length),
      inputs: {
        代码: code, 日期: date, 前瞻天数: days, 批次: lifts.length, 比例缺失批次: missing,
        最近解禁日: lifts.length > 0 ? lifts[0].date : null,
        明细: lifts.map(l => ({ 日期: l.date, 占流通: l.freeRatio, 类型: l.shareType })),
      },
    };
  },
};

/* ------------------------------- 减持计划 ------------------------------- */

/**
 * 执行窗口与未来 N 天有交集的股东减持计划，计划上限占**总股本**的比例之和。
 *
 * 分母与解禁压力不同（这里是总股本，那里是流通股），所以两者**不能相加**，
 * 分成两个因子。上限是"不超过"，实际减持往往少于它 —— 这是压力的上界，不是预测。
 *
 * 观测起点问题同 ST：源（同花顺 F10）每只票只留最近约 2 条，
 * 所以接入之前的日期"查不到计划"只代表"没看见"，如实返回 confidence 0。
 */
const 减持计划: FactorSpec<number> = {
  name: "减持计划", version: V, group: "filter",
  defaults: { 前瞻天数: 90, 预警比例: 0.01, 严重比例: 0.03, 观测起点: "2026-09-23" },
  fn: ctx => {
    const code = requireCode(ctx.params, "减持计划");
    const date = evalDate(ctx.view, ctx.params);
    const since = typeof ctx.params["观测起点"] === "string" ? ctx.params["观测起点"] as string : "2026-09-23";
    const days = pnum(ctx.params, "前瞻天数", 90);
    const plans = ctx.view.reductionPlans(code, days);

    if (plans.length === 0 && date < since) {
      return {
        name: "减持计划", version: V, value: 0, label: "未观测",
        provenance: "real", confidence: 0,
        inputs: { 代码: code, 日期: date, 观测起点: since },
      };
    }

    const sum = round6(plans.reduce((a, p) => a + (p.maxRatio ?? 0), 0));
    const 预警 = pnum(ctx.params, "预警比例", 0.01), 严重 = pnum(ctx.params, "严重比例", 0.03);
    const label = plans.length === 0 ? "无计划"
      : sum >= 严重 ? "严重" : sum >= 预警 ? "预警" : "有计划";
    return {
      name: "减持计划", version: V, value: sum, label,
      provenance: "real", confidence: 1,
      inputs: {
        代码: code, 日期: date, 前瞻天数: days, 计划数: plans.length,
        明细: plans.map(p => ({
          股东: p.actor, 起: p.startDate, 止: p.endDate, 上限占总股本: p.maxRatio,
        })),
      },
    };
  },
};

export const RISK_FACTORS: FactorSpec<any>[] = [超买超卖, ST状态, 解禁压力, 减持计划];

/** 仅供类型推断与测试使用 */
export type { PointInTimeView };
