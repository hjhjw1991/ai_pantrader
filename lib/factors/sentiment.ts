/**
 * 情绪截面：一次全市场遍历，算出情绪周期要用的全部原料。
 *
 * 五段状态机（冰点 / 启动 / 发酵 / 高潮 / 退潮）判的是**接力资金的赚钱与亏钱**，
 * 光看涨停家数不够 —— 高潮末期涨停家数最多，而那正是该走的时候。
 * 真正区分阶段的是这几样：
 *
 *   - 晋级率：昨天的首板今天有多少走成二板、昨天的连板今天有多少继续
 *   - 溢价：昨天涨停的票今天平均赚多少（首板 / 连板 / 炸板分三桶看）
 *   - 高度板溢价：昨天最高的那只今天怎么样 —— 龙头断板往往是退潮的第一声
 *   - 炸板率与涨跌中位数：封板的承接力与市场整体的冷暖
 *
 * 这些全部由**日线重建**（涨停池真快照 2026-08 才开始攒），口径与 marketBreadth 相同：
 * 复权后的涨幅 ≥ 阈值且收盘 == 最高 即为涨停。炸板 = 盘中最高触及阈值但收盘没封住。
 * 日线看不到"盘中开过又封回"，那种票这里算涨停而不是炸板，所以炸板率是**下界**。
 *
 * **ST 不进涨停类统计**（涨停 / 炸板 / 晋级 / 溢价），只进涨跌家数与中位数。
 * 这是东财涨停池与市场通行的口径：ST 的涨停是另一种博弈（摘帽、重组），
 * 混进来会让"接力情绪"被几只戴帽股的连板拉高。实测不排除时每天比真快照多 3~8 家，
 * 全是 ST。局限：ST 历史从 2026-08-04 才开始观测，此前的 ST 排除不掉。
 *
 * 单位：家数为整数；比率在 [0, 1]；涨幅与溢价为**百分点**（与 judge 的 pct 一致）。
 * 分母为 0 的比率与均值一律 null —— 昨天没有涨停时"溢价为 0"会被读成"全体吃面"。
 */
import type { PointInTimeView, SentimentRow } from "@/lib/contracts";
import { adjClose, barsUpTo, mean, pctChange, round6 } from "@/lib/factors/util";
import { DEFAULT_LIMIT_THRESHOLDS, judgeBarLimitUp, wasSt } from "@/lib/factors/limit-up";

/** 与契约层的 SentimentRow 是同一个形状：派生表存的就是这个 */
export type SentimentSnapshot = SentimentRow;

/**
 * 口径版本。改了任何一条统计口径都要升它 —— 派生表里版本不同的行会被夜间任务重算，
 * 不升的话新旧口径的行混在同一条分位序列里，阈值学出来是两种口径的平均。
 */
export const SENTIMENT_ALGO_VERSION = "1.0.0";

/** 连板最多往回数这么多根。更高的板极少，数不到顶的按上限计，不影响晋级率 */
export const LBC_CAP = 15;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const avg = (xs: number[]): number | null => (xs.length === 0 ? null : round6(mean(xs)));
const ratio = (a: number, b: number): number | null => (b === 0 ? null : round6(a / b));

/**
 * 分位：严格小于 x 的占比 + 与 x 相等的一半。null 被忽略，空样本返回 null。
 * 取"并列算一半"是为了让常数序列落在 0.5 而不是 0 或 1 —— 否则一段平淡的行情
 * 会被读成"极冷"或"极热"。
 */
export function percentileRank(xs: Array<number | null>, x: number): number | null {
  const v = xs.filter((y): y is number => y !== null && Number.isFinite(y));
  if (v.length === 0) return null;
  let lt = 0, eq = 0;
  for (const y of v) { if (y < x) lt++; else if (y === x) eq++; }
  return round6((lt + eq / 2) / v.length);
}

export function sentimentSnapshot(view: PointInTimeView, date: string): SentimentSnapshot {
  const t = DEFAULT_LIMIT_THRESHOLDS;
  const prevDay = view.prevTradingDay(date);
  const pull = LBC_CAP + 3 + (date === view.asOf.slice(0, 10) ? 0 : view.tradingDays(date, view.asOf).length);

  let up = 0, down = 0, flat = 0, unknown = 0, zt = 0, dt = 0, zb = 0, maxLbc = 0, lbCount = 0;
  const pcts: number[] = [];
  const first: number[] = [], multi: number[] = [], zbNext: number[] = [], opens: number[] = [];
  let firstUp = 0, multiUp = 0;
  const byPrevLbc: Array<{ lbc: number; pct: number }> = [];

  for (const sec of view.universe()) {
    const bars = barsUpTo(view, sec.code, date, LBC_CAP + 2, pull);
    const n = bars.length;
    const cur = n > 0 ? bars[n - 1] : null;
    if (cur === null || cur.date !== date || n < 2) { unknown++; continue; }
    const prev = bars[n - 2];
    const j = judgeBarLimitUp(sec, cur, prev, t);
    if (j.pct === null) { unknown++; continue; }
    const pct = j.pct;
    pcts.push(pct);
    if (pct > 0) up++; else if (pct < 0) down++; else flat++;
    if (wasSt(sec, date)) continue;

    // 板数：从某一根往回数连续涨停
    const zAt = (i: number) => i >= 1 && judgeBarLimitUp(sec, bars[i], bars[i - 1], t).limitUp;
    const lbcAt = (i: number) => { let k = 0; while (k < LBC_CAP && zAt(i - k)) k++; return k; };

    if (j.limitUp) {
      zt++;
      const l = lbcAt(n - 1);
      if (l > maxLbc) maxLbc = l;
      if (l >= 2) lbCount++;
    } else if (j.touchedUp) {
      zb++;
    }
    if (j.limitDown) dt++;

    // 昨日身份：必须是**全市场的**上一交易日，停牌隔天复牌的不算"昨天涨停"
    if (prevDay === null || prev.date !== prevDay || n < 3) continue;
    const pj = judgeBarLimitUp(sec, prev, bars[n - 3], t);
    if (pj.limitUp) {
      const l = lbcAt(n - 2);
      opens.push(pctChange(adjClose(prev), cur.o * cur.adjFactor));
      byPrevLbc.push({ lbc: l, pct });
      if (l === 1) { first.push(pct); if (j.limitUp) firstUp++; }
      else { multi.push(pct); if (j.limitUp) multiUp++; }
    } else if (pj.touchedUp) {
      zbNext.push(pct);
    }
  }

  const highLbcPrev = byPrevLbc.reduce((m, x) => Math.max(m, x.lbc), 0);
  const high = highLbcPrev >= 2 ? byPrevLbc.filter(x => x.lbc === highLbcPrev).map(x => x.pct) : [];
  const med = median(pcts);

  return {
    date, up, down, flat, unknown,
    medianPct: med === null ? null : round6(med), avgPct: avg(pcts),
    zt, dt, zb, zbRate: ratio(zb, zt + zb),
    maxLbc, lbCount,
    firstPrev: first.length, firstPromo: ratio(firstUp, first.length),
    multiPrev: multi.length, multiPromo: ratio(multiUp, multi.length),
    ztPrem: avg([...first, ...multi]), ztOpenPrem: avg(opens),
    firstPrem: avg(first), multiPrem: avg(multi), zbPrem: avg(zbNext),
    highLbcPrev, highPrem: avg(high),
  };
}
