/**
 * 盘中情绪。
 *
 * 为什么需要它：整套择时（档位、盘面强度、情绪温度）走的是**日线截面**，而当日日线
 * 要 22:00 夜间任务才落库 —— 于是盘中任何时刻问"现在情绪怎么样"，拿到的都是昨收的
 * 结论。这是有意设计（拿没数据的今天去判横截面因子，全市场 5888 只会一起落进
 * unknown，盘面强度退回占位值 50，档位整天卡中性、候选恒空），但它留了一个洞：
 * **盘中突发转弱时，系统不会有任何反应**，只有已持仓的票破止损才会响。
 *
 * 这个模块改用 `quote_snapshot`（盘中每 5 分钟一次的全市场快照）现算情绪，补上那个洞。
 * 它**不替代**日线口径的择时：买入候选继续用 T-1 数据选（推荐理由来自昨日主线、昨日
 * 涨停池，那些盘中本来就算不出来）。它只回答一件事：
 *
 *   **从开盘到现在，市场的情绪是在好转还是在恶化？**
 *
 * ─────────────────────── 为什么用「日内轨迹」而不是「跟昨收比」 ───────────────────────
 *
 * 一开始的想法是拿盘中跟昨收比，实测否决了：日间 Δbreadth 的 sd = 0.324（1060 个
 * 交易日），比日内波动还大 —— 那一夜的隔夜信息、跳空开盘全混在里面，阈值放到
 * ±0.3 才不误报，而放到 ±0.3 就什么都报不出来。
 *
 * 改用**同一天内相隔 30 分钟的两个时点**比，sd 立刻降到 0.055（34 个交易日、
 * 1868 个窗口），小了 6 倍。这个量级才抓得住"盘中正在发生的变化"。
 *
 * ─────────────────────── 阈值从哪来 ───────────────────────
 *
 * 全部由 analysis/盘中情绪-阈值校准.cjs 实测得出，不拍脑袋：
 *
 *   30 分钟窗口 Δbreadth   sd 0.055   p05 −0.085   p01 −0.160   p95 +0.087   p99 +0.175
 *   30 分钟窗口 ΔavgPct    sd 0.252   p05 −0.406   p01 −0.659   p95 +0.406   p99 +0.767
 *   全时点 breadth         sd 0.186   p05  0.133   p01  0.098   p95  0.762   p99  0.806
 *
 * 取 p05/p95 当 warn（约 1.55σ）、p01/p99 当 critical（约 2.9σ）。
 * 也就是说：warn 大约每 20 个窗口响一次，critical 每 100 个窗口响一次 ——
 * 这是"异常"该有的频率，不是"每次刷新都弹窗"。
 *
 * ─────────────────────── 口径差异（必须知道） ───────────────────────
 *
 * 与日线口径的情绪截面有两处不可消除的差异，这里**如实标注**而不是假装对齐：
 *
 *   1. 涨停判定用涨幅阈值，不是精确涨停价 + 收盘 == 最高。快照里没有最高价，
 *      所以"盘中触及过涨停又打开"的票这里算涨停 —— 涨停家数是**上界**。
 *   2. 不排除 ST。日线口径排除 ST（戴帽股的连板是另一种博弈），快照里没有
 *      ST 标记（要解析 is_st_history_json，SQL 里做不了），所以会**多算**几只。
 *
 * 结论：这里的涨跌停家数与 sentiment_daily 的 zt/dt **不是同一个数**，
 * 别拿它们互相校验。但作为"盘中变化"的监测够用 —— 两处偏差都是系统性的，
 * 同一天里从开盘到收盘偏差方向一致，做差时基本抵消。
 */
import type { Db } from "@/lib/db";
import { shanghaiTs } from "@/lib/data/clock";

/** 一个时点上的全市场状态 */
export interface MoodPoint {
  ts: string;
  /** 参与统计的样本数 */
  n: number;
  up: number;
  down: number;
  flat: number;
  /** 涨幅 ≥ 板块涨停阈值的家数（上界，见文件头口径差异） */
  limitUp: number;
  limitDown: number;
  /** 平均涨幅，百分点 */
  avgPct: number;
  /** 市场宽度 (up + 0.5×flat) / n ∈ [0,1]。平盘算半个上涨 */
  breadth: number;
}

export interface MoodSignal {
  kind: "mood_shift" | "limit_down_wave" | "ice_point" | "overheat";
  level: "critical" | "warn" | "info";
  title: string;
  body: string;
  /** 通知去重键：同一天同一件事只响一次 */
  dedupeKey: string;
  /**
   * 已经响过这个键的通知，本条就不必再响（更重的同类已覆盖它）。
   * 例：critical 的"盘中情绪转弱"响过之后，同一天再来 warn 级的转弱是降级，不该再吵人。
   */
  supersededBy?: string;
}

export interface IntradayMood {
  /** 最新时点。null = 今天还没有快照 */
  now: MoodPoint | null;
  /** 30 分钟前的时点，用于算变化。null = 开盘还没到 30 分钟 */
  ago30: MoodPoint | null;
  /** 今天第一个时点（约 09:25 集合竞价后） */
  open: MoodPoint | null;
  /** 今天已采集的有效时点数 */
  points: number;
  /** 与 30 分钟前的变化 */
  delta30: { breadth: number; avgPct: number } | null;
  /** 与今日开盘的变化 */
  deltaOpen: { breadth: number; avgPct: number } | null;
  /** 盘中温度分 0~100。null = 算不出来 */
  temp: number | null;
  /**
   * 快照是否已陈旧。
   * 收盘后 / 未开盘时最后一根快照还在库里，但那是几小时前的状态 ——
   * 界面必须如实标出来，否则会拿 15:00 的数据当"现在"。
   */
  stale: boolean;
  signals: MoodSignal[];
}

// ───────────────── 阈值：实测得出，见 analysis/盘中情绪-阈值校准.cjs ─────────────────

/** 30 分钟窗口 Δbreadth 的 p05 / p01（sd = 0.055） */
const SHIFT_WARN_BREADTH = 0.085;
const SHIFT_CRIT_BREADTH = 0.160;
/** 30 分钟窗口 ΔavgPct 的 p05 / p01（百分点，sd = 0.252） */
const SHIFT_WARN_AVG = 0.41;
const SHIFT_CRIT_AVG = 0.66;

/**
 * 日内累计漂移的告警线。
 *
 * 开盘→收盘的 Δbreadth 实测 sd = 0.173、p05 = −0.329。这里取 −0.12（约 0.7σ）
 * 而不是 p05：这条要抓的是"滑了一整天"的持续状态，靠"最近 30 分钟仍在下行"
 * 那个硬条件来压误报，所以位移线本身可以设得比统计分位松一些 ——
 * 真跌到 p05 那种日子（−33pp）往往是崩盘，早就先被 30 分钟突变警报覆盖了。
 */
const TREND_OPEN_BREADTH = 0.12;
const TREND_OPEN_AVG = 1.0;

/** 全时点 breadth 的 p05 / p95 —— 用来判"现在算冰点还是过热" */
const ICE_BREADTH = 0.133;
const HOT_BREADTH = 0.762;

/**
 * 跌停潮的家数线。取自策略 YAML 的 `择时.防守触发.跌停家数>: 30`，
 * 与日线口径的防守档用同一条线 —— 盘中发现跌停潮，就应当按同样的纪律处理。
 */
const LIMIT_DOWN_WAVE = 30;

/** 温度分的基准：全时点 breadth / avgPct 的均值与标准差 */
const TEMP_BREADTH_MEAN = 0.468, TEMP_BREADTH_SD = 0.186;
const TEMP_AVG_MEAN = 0.027, TEMP_AVG_SD = 1.017;

/** 时点数少于这么多的快照是采集半途的产物，不参与统计 */
const MIN_SAMPLE = 1000;

/** 最后一个时点距今超过这么多**交易时间**就算陈旧（收盘后 / 未开盘）。午休不计，见 tradeClockMs */
const STALE_MS = 15 * 60_000;

/** 午休 11:30 ~ 13:00（上海挂钟，日内毫秒） */
const LUNCH_START_MS = (11 * 60 + 30) * 60_000;
const LUNCH_END_MS = 13 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/**
 * 把挂钟毫秒折算成"交易时钟"：午休那 90 分钟不走表。
 *
 * 为什么要折：快照只在交易时段采，午休整整 90 分钟没有新时点。按挂钟算的话
 *   - 11:45 起情绪就被标成"陈旧"，整个午休界面都在说数据过期 —— 其实市场根本没动；
 *   - 13:00 ~ 13:30 的"30 分钟窗口"会去跟 11:30 之前比（挂钟往前 30 分钟落在午休里，
 *     取到的是 11:30 那根），等于拿 2 小时的跨度冒充 30 分钟，按 30 分钟校准的阈值全部失真。
 * 折算后：午休内任意时刻都等同 11:30；13:00 之后整体往前挪 90 分钟，13:00 紧接 11:30。
 */
export function tradeClockMs(ms: number): number {
  if (!Number.isFinite(ms)) return ms;
  const dayStart = Math.floor(ms / DAY_MS) * DAY_MS;
  const tod = ms - dayStart;
  if (tod <= LUNCH_START_MS) return ms;
  if (tod < LUNCH_END_MS) return dayStart + LUNCH_START_MS;
  return ms - (LUNCH_END_MS - LUNCH_START_MS);
}

/**
 * 时间戳列归一到上海挂钟。库里两种口径并存（migration 006 之后是挂钟串，之前是 UTC ISO），
 * 直接拿 ts 做字符串比较会因为 'T' > ' ' 把 UTC 串全排到后面。
 */
function wall(col: string): string {
  return `(CASE WHEN ${col} LIKE '%Z'
                THEN strftime('%Y-%m-%d %H:%M:%f', ${col}, '+8 hours')
                ELSE REPLACE(${col}, 'T', ' ') END)`;
}

/**
 * 某天所有有效时点的聚合序列，按时间升序。
 *
 * 过滤必须用 `ts >= day AND ts < 次日` 的范围，不能写 `substr(wall(ts),1,10) = day` ——
 * 后者是逐行函数，走不了主键 (ts, code) 的索引，1220 万行全表扫描实测 2125ms，
 * 范围查询 12ms，差 177 倍。盘中每 5 分钟要算一次，这个差决定了能不能用。
 *
 * 范围写法只覆盖挂钟格式的串。migration 006 之前的库里存的是 UTC ISO（带 Z），
 * 那种串不在这个区间内 —— 实测当前库 1222 万行**全是挂钟格式、0 条 ISO**，
 * 而那些旧日子本来也没有完整的盘中序列，不计入正好。
 */
function daySeries(db: Db, day: string): MoodPoint[] {
  const rows = db.prepare(
    `SELECT ${wall("ts")} AS ts,
            COUNT(*)                                                        AS n,
            SUM(CASE WHEN q.pct > 0 THEN 1 ELSE 0 END)                      AS up,
            SUM(CASE WHEN q.pct < 0 THEN 1 ELSE 0 END)                      AS down,
            SUM(CASE WHEN q.pct = 0 THEN 1 ELSE 0 END)                      AS flat,
            AVG(q.pct)                                                      AS avg,
            SUM(CASE WHEN q.pct >= CASE s.board
                          WHEN '创业板' THEN 19.8 WHEN '科创板' THEN 19.8
                          WHEN '北交所' THEN 29.7 ELSE 9.8 END
                     THEN 1 ELSE 0 END)                                     AS lu,
            SUM(CASE WHEN q.pct <= CASE s.board
                          WHEN '创业板' THEN -19.8 WHEN '科创板' THEN -19.8
                          WHEN '北交所' THEN -29.7 ELSE -9.8 END
                     THEN 1 ELSE 0 END)                                     AS ld
       FROM quote_snapshot q
       LEFT JOIN security s ON s.code = q.code
      WHERE q.ts >= ? AND q.ts < ? AND q.pct IS NOT NULL
      GROUP BY ts HAVING n >= ?
      ORDER BY ts`
  ).all(day, nextDay(day), MIN_SAMPLE) as Array<Record<string, number | string>>;

  return rows.map(r => {
    const n = Number(r.n);
    return {
      ts: String(r.ts),
      n,
      up: Number(r.up),
      down: Number(r.down),
      flat: Number(r.flat),
      limitUp: Number(r.lu),
      limitDown: Number(r.ld),
      avgPct: Number(r.avg),
      breadth: n === 0 ? 0 : (Number(r.up) + 0.5 * Number(r.flat)) / n,
    };
  });
}

/** "2026-09-28 09:25:35.265" → 毫秒（按上海挂钟解析，不带时区后缀）。解析不出来返回 NaN */
function tsMs(ts: string): number {
  return Date.parse(`${ts.slice(0, 10)}T${ts.slice(11)}Z`);
}

/** 次日的 'YYYY-MM-DD'，用作范围查询的 exclusive 上界 */
function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** 序列里找交易时钟 <= target 的最后一个时点（target 也是交易时钟） */
function lastAtOrBefore(s: MoodPoint[], targetMs: number): MoodPoint | null {
  let hit: MoodPoint | null = null;
  for (const p of s) {
    const m = tradeClockMs(tsMs(p.ts));
    if (!Number.isFinite(m) || m > targetMs) break;
    hit = p;
  }
  return hit;
}

const clip = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 温度分：breadth 与 avgPct 各自的 z 分数加权，映射到 0~100 */
export function moodTemp(p: MoodPoint): number {
  const zb = (p.breadth - TEMP_BREADTH_MEAN) / TEMP_BREADTH_SD;
  const za = (p.avgPct - TEMP_AVG_MEAN) / TEMP_AVG_SD;
  return clip(50 + 10 * zb + 6 * za, 0, 100);
}

/**
 * 由 30 分钟变化判定情绪转变。
 *
 * 两个维度（宽度 breadth、幅度 avgPct）**各自独立**达标即算转变 ——
 * 它们的 30 分钟窗口相关性只有中等，要求同时达标会漏掉"指数横盘但个股在崩"
 * （breadth 塌、avgPct 不动）这种最该响的情形。
 */
function shiftSignal(d: { breadth: number; avgPct: number }, day: string): MoodSignal | null {
  const worse = (bd: number, av: number) => bd <= -SHIFT_WARN_BREADTH || av <= -SHIFT_WARN_AVG;
  const worseCrit = (bd: number, av: number) => bd <= -SHIFT_CRIT_BREADTH || av <= -SHIFT_CRIT_AVG;
  const better = (bd: number, av: number) => bd >= SHIFT_WARN_BREADTH || av >= SHIFT_WARN_AVG;

  if (worse(d.breadth, d.avgPct)) {
    const crit = worseCrit(d.breadth, d.avgPct);
    /**
     * warn 与 critical 必须用**不同**的去重键。
     * 以前共用 `mood:weak:${day}`：上午先响过一次 warn，下午真崩到 critical 时
     * 被通知表的唯一索引当成"已通知过"静默吞掉 —— 升级恰恰是最该响的那一次。
     * 反方向（critical 之后又来 warn）是降级，由 supersededBy 压掉。
     */
    return {
      kind: "mood_shift",
      level: crit ? "critical" : "warn",
      title: "盘中情绪转弱",
      body:
        `30 分钟内上涨占比 ${fmtDelta(d.breadth)}、平均涨幅 ${fmtPct(d.avgPct)}。` +
        `持仓留意跌破日内低点，观察池推迟买入。`,
      dedupeKey: crit ? `mood:weak:critical:${day}` : `mood:weak:${day}`,
      ...(crit ? {} : { supersededBy: `mood:weak:critical:${day}` }),
    };
  }
  if (better(d.breadth, d.avgPct)) {
    return {
      kind: "mood_shift",
      level: "info",
      title: "盘中情绪转强",
      body: `30 分钟内上涨占比 ${fmtDelta(d.breadth)}、平均涨幅 ${fmtPct(d.avgPct)}。`,
      dedupeKey: `mood:strong:${day}`,
    };
  }
  return null;
}

const fmtDelta = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}pp`;
const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

/**
 * 算盘中情绪。
 *
 * 只在有快照的日子有意义；休市日 series 为空，返回 now=null，调用方据此不展示。
 */
export function intradayMood(db: Db, asOf = shanghaiTs()): IntradayMood {
  const day = asOf.slice(0, 10);
  const series = daySeries(db, day);
  const asOfMs = tsMs(asOf);

  /**
   * 只看 asOf 之前已经采集到的时点。
   *
   * 一天 49 根快照全在库里，而"现在"是 asOf 那一刻 —— 不截断的话，
   * 10:00 问"现在情绪怎么样"会拿到 15:00 收盘的答案。这不只是实时显示错，
   * 回放到历史某天盘中时整个序列会退化成一根常数，日内轨迹完全消失。
   */
  const visible = Number.isFinite(asOfMs)
    ? series.filter(p => { const m = tsMs(p.ts); return Number.isFinite(m) && m <= asOfMs; })
    : series;

  const now = visible.length > 0 ? visible[visible.length - 1] : null;

  if (now === null) {
    return {
      now: null, ago30: null, open: null, points: 0,
      delta30: null, deltaOpen: null, temp: null, stale: true, signals: [],
    };
  }

  const nowMs = tsMs(now.ts);
  // 30 分钟按交易时钟量：13:10 的"30 分钟前"是 11:10，而不是落在午休里的 12:40
  const ago30 = Number.isFinite(nowMs) ? lastAtOrBefore(visible, tradeClockMs(nowMs) - 30 * 60_000) : null;
  const open = visible[0];

  const sub = (a: MoodPoint, b: MoodPoint) => ({
    breadth: a.breadth - b.breadth,
    avgPct: a.avgPct - b.avgPct,
  });

  const delta30 = ago30 === null ? null : sub(now, ago30);
  const deltaOpen = open.ts === now.ts ? null : sub(now, open);

  const signals: MoodSignal[] = [];
  if (delta30 !== null) {
    const s = shiftSignal(delta30, day);
    if (s !== null) signals.push(s);
  } else if (deltaOpen !== null && deltaOpen.breadth <= -SHIFT_CRIT_BREADTH) {
    /**
     * 开盘急跌：开盘还不到 30 分钟，宽度已经塌掉这么多。
     *
     * 为什么必须单列一条：30 分钟窗口是主判据，但它在开盘前半小时内恒为 null ——
     * 于是"09:25 到 09:50 从 39% 掉到 20%"这种开盘即崩（实测 2026-09-28 真实发生过）
     * **一条警报都不会响**，而开盘半小时恰恰是一天里最该反应的时段。
     * 拿不到 30 分钟窗口时，只能退而用"自开盘"的位移，阈值相应提到 critical 线
     * （开盘阶段的位移本来就比盘中大，用 warn 线会把正常的高开回落全算进去）。
     */
    signals.push({
      kind: "mood_shift",
      level: "critical",
      title: "开盘急跌",
      body:
        `自开盘上涨占比 ${fmtDelta(deltaOpen.breadth)}、平均涨幅 ${fmtPct(deltaOpen.avgPct)}，` +
        `开盘未满 30 分钟，还不能用 30 分钟窗口判定，但位移已达急跌量级。`,
      dedupeKey: `mood:opencrash:${day}`,
    });
  }

  /**
   * 日内趋势：30 分钟窗口抓的是**突变**，抓不到"从开盘一路阴跌"。
   * 后者每一段都落在正常波动里（9/24 实测：全天 breadth 从 39% 掉到 24%，
   * 但任何 30 分钟窗口都没超过 −5.3pp，一次突变警报都不会响），
   * 可它恰恰是最该被看见的情形 —— 温水煮青蛙比闪崩更容易让人不设防。
   *
   * 所以另立一条：从开盘累计已经走弱这么多，**且最近 30 分钟仍在往下**，才算。
   * 后半句是硬条件 —— 累计跌了但最近在反弹，那是"跌完了"，不是"还在跌"。
   */
  if (deltaOpen !== null && delta30 !== null) {
    const down = deltaOpen.breadth <= -TREND_OPEN_BREADTH || deltaOpen.avgPct <= -TREND_OPEN_AVG;
    if (down && delta30.breadth < 0) {
      signals.push({
        kind: "mood_shift",
        level: "warn",
        title: "盘中情绪持续走弱",
        body:
          `自开盘上涨占比 ${fmtDelta(deltaOpen.breadth)}、平均涨幅 ${fmtPct(deltaOpen.avgPct)}，` +
          `且最近 30 分钟仍在下行。不是单点波动，是全天在滑。`,
        dedupeKey: `mood:trend:${day}`,
      });
    }
  }

  // 跌停潮：与日线口径的防守触发同一条线，盘中直接按纪律处理
  if (now.limitDown >= LIMIT_DOWN_WAVE) {
    signals.push({
      kind: "limit_down_wave",
      level: "critical",
      title: `盘中出现跌停潮：${now.limitDown} 家跌停`,
      body:
        `与防守档的触发线（跌停 ${LIMIT_DOWN_WAVE} 家）一致。日线口径的档位要等收盘才反映，` +
        `但纪律不等数据 —— 不开新仓，持仓按止损位执行。`,
      dedupeKey: `dtwave:${day}`,
    });
  }

  // 水位：不看变化、只看当前绝对位置。冰点/过热都是要人留意的极端状态
  if (now.breadth <= ICE_BREADTH) {
    signals.push({
      kind: "ice_point",
      level: "warn",
      title: `市场冰点：上涨占比 ${(now.breadth * 100).toFixed(0)}%`,
      body: `低于历史 ${(0.05 * 100).toFixed(0)}% 分位（${(ICE_BREADTH * 100).toFixed(0)}%）。`,
      dedupeKey: `ice:${day}`,
    });
  } else if (now.breadth >= HOT_BREADTH) {
    signals.push({
      kind: "overheat",
      level: "info",
      title: `市场过热：上涨占比 ${(now.breadth * 100).toFixed(0)}%`,
      body: `高于历史 95% 分位（${(HOT_BREADTH * 100).toFixed(0)}%）。普涨末端更该守纪律。`,
      dedupeKey: `hot:${day}`,
    });
  }

  // 陈旧同样按交易时钟：午休时最后一根停在 11:30 是正常的，不算过期
  const ageMs = Number.isFinite(nowMs) ? tradeClockMs(asOfMs) - tradeClockMs(nowMs) : NaN;

  return {
    now, ago30, open,
    // 数 asOf 之前已采集到的时点，不是全天 ——
    // "今日已采 N 个时点"在 10:31 就该是 3，写成全天会在开盘就显示 49
    points: visible.length,
    delta30, deltaOpen,
    temp: moodTemp(now),
    stale: !Number.isFinite(ageMs) || ageMs > STALE_MS,
    signals,
  };
}
