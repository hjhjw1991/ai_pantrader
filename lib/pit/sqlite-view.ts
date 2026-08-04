/**
 * PointInTimeView 的 SQLite 实现。
 *
 * 为什么放在 lib/pit/ 而不是 lib/strategy/pit-view：
 *   spec §15 的目录树把 pit-view 画在 lib/strategy/ 下，
 *   而 spec §17 断言 3 要求 `grep -rE "\bdb\.|prisma\.|sqlite" lib/strategy/` 零命中。
 *   两条互斥 —— 断言是进 CI 的硬门，目录树只是示意，所以存储实现落在 lib/pit/，
 *   lib/strategy/ 保持零存储访问。
 *
 * 本文件唯一的职责是：**每一条 SQL 都被 asOf 夹住**。
 * 越界（问 asOf 之后的截面日期）抛错而不是返回空数组 —— 空数组会被因子读成
 * "当天没有涨停"，而不是"你问错日期了"，回测里就是一整段静默失真。
 */
import type {
  Board, DailyBar, DtRow, LhbRow, LhbSeatRow, MacroRow, MinuteBar,
  PointInTimeView, Quote, SectorRankRow, SecurityRow, ZtRow,
} from "@/lib/contracts";
import type { Db } from "@/lib/db";

/* ------------------------------ 时间戳归一化 ------------------------------ */

/**
 * 库里的时间戳有两种写法，混着做字符串比较会错 8 小时：
 *   quote_snapshot / macro / data_gap —— `new Date().toISOString()`，UTC 带 Z
 *   kline_min / sector_rank          —— 数据源原样的上海挂钟时间 "YYYY-MM-DD HH:MM:SS"
 *
 * UTC 看起来永远比上海"早"，于是 asOf=10:00 会读到当天 14:00（=06:00Z）的快照 ——
 * 一个不会报错、只会让回测变漂亮的未来函数。所以统一折算成上海挂钟再比。
 *
 * （这是契约缺口：PointInTimeView 没有规定 asOf 的时区与格式。见最终报告。）
 */
const SHANGHAI_OFFSET_H = 8;

function isUtcMarked(ts: string): boolean {
  return /(Z|[+-]\d{2}:?\d{2})$/.test(ts);
}

/** 归一到 "YYYY-MM-DDTHH:MM:SS" 的上海挂钟时间。非法输入返回 null，由调用方决定怎么报错。 */
function toLocalWall(ts: string, dateOnlyEnd: boolean): string | null {
  if (typeof ts !== "string") return null;
  const s = ts.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;

  if (s.length === 10) {
    // 只给日期：作为上界时取当日末刻（"截至这一天"含当天全部数据），
    // 作为下界时取零点。
    return dateOnlyEnd ? `${s}T23:59:59` : `${s}T00:00:00`;
  }
  if (isUtcMarked(s)) {
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms + SHANGHAI_OFFSET_H * 3600_000).toISOString().slice(0, 19);
  }
  return s.slice(0, 19).replace(" ", "T");
}

/**
 * SQL 侧的同一套折算。写成表达式而不是在 TS 里过滤，是为了让 LIMIT 在库里生效 ——
 * 全市场 5545 只票的快照表，全捞回 JS 再切会把盘中扫描拖成分钟级。
 */
function tsLocalExpr(col: string): string {
  return `(CASE WHEN ${col} LIKE '%Z'
                THEN strftime('%Y-%m-%dT%H:%M:%S', ${col}, '+${SHANGHAI_OFFSET_H} hours')
                ELSE REPLACE(SUBSTR(${col}, 1, 19), ' ', 'T') END)`;
}

/* --------------------------------- 行映射 --------------------------------- */

const num = (v: unknown, dflt: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : dflt;

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * 契约里是 number（不可空）的列，NULL 时**整行不返回**，绝不补 0。
 *
 * 这不是洁癖，是回测里最贵的一类假利润：涨停成交概率按
 * `p = 1/(1 + 封单额/成交额 / sealHalfRatio)` 算，`sealAmt=0` 读出来是"没封单"，
 * p=1 —— 一只根本买不进的涨停票被算成买到了。而行整个缺失时回测判 p=0（买不进），
 * 方向是保守的。所以"缺数据"必须表现为**没有这一行**，不是一行零。
 *
 * 同理跌停封单（卖不出）、日线的 o/h/l/c（0 价 = -100%）、
 * 快照的换手（0 换手会让"换手上限"这道筛假通过）、龙虎榜净买（0 = 没资金动作）。
 *
 * 唯一的例外是 kline_daily.amount：数据源（新浪日线）不给成交额，
 * 采集器对整张表写的都是 NULL，排掉它等于一根日线都返回不了。
 * 而它当前唯一的消费者（回测的封板模型）对 amount<=0 做了保守处理，所以 0 在这里是安全的。
 * 这一条在最终报告里单列，等成交额有了数据源就该收紧。
 */
const NOT_NULL = (...cols: string[]): string =>
  cols.map(c => `${c} IS NOT NULL`).join(" AND ");

const BOARDS: Board[] = ["主板", "创业板", "科创板", "北交所"];

/**
 * board 兜底：bootstrap 的 clist 只写了 name/board，实测有空值。
 * 板决定涨跌幅限制与账户权限（filters 的第 5 道筛），猜错比空着更糟，
 * 所以按代码前缀推 —— 这个映射是交易所规则，不是启发式。
 */
function boardOf(code: string, stored: unknown): Board {
  if (typeof stored === "string" && (BOARDS as string[]).includes(stored)) return stored as Board;
  if (code.startsWith("688") || code.startsWith("689")) return "科创板";
  if (code.startsWith("300") || code.startsWith("301")) return "创业板";
  if (code.startsWith("8") || code.startsWith("43") || code.startsWith("4")) return "北交所";
  return "主板";
}

/**
 * ST 历史。坏 JSON 一律当"无记录"而不是抛错：
 * 元数据脏一条不该让整轮扫描崩掉，而 wasSt() 读到空数组只会少判一次 5% 限幅。
 *
 * from 晚于 asOf 的区间要剔掉 —— 2022 年的回测不该知道这只票 2027 年会戴帽。
 */
function parseStHistory(raw: unknown, asOfDate: string): SecurityRow["isStHistory"] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: SecurityRow["isStHistory"] = [];
  for (const seg of parsed) {
    if (seg === null || typeof seg !== "object") continue;
    const from = (seg as Record<string, unknown>)["from"];
    const to = (seg as Record<string, unknown>)["to"];
    if (typeof from !== "string" || from.length === 0) continue;
    if (from > asOfDate) continue;
    out.push({ from, to: typeof to === "string" && to.length > 0 ? to : null });
  }
  return out;
}

function mapSecurity(r: Record<string, unknown>, asOfDate: string): SecurityRow {
  const code = String(r["code"]);
  return {
    code,
    name: typeof r["name"] === "string" ? r["name"] : code,
    listDate: typeof r["list_date"] === "string" ? r["list_date"] : null,
    delistDate: typeof r["delist_date"] === "string" ? r["delist_date"] : null,
    board: boardOf(code, r["board"]),
    isStHistory: parseStHistory(r["is_st_history_json"], asOfDate),
  };
}

/* --------------------------------- 视图 --------------------------------- */

export function createSqliteView(db: Db, asOf: string): PointInTimeView {
  const asOfLocal = toLocalWall(asOf, true);
  if (asOfLocal === null) {
    throw new Error(`createSqliteView: asOf 不是合法时间戳：${JSON.stringify(asOf)}`);
  }
  const asOfDate = asOfLocal.slice(0, 10);

  /**
   * 越界即抛（spec §4.2），并把参数归一成 YYYY-MM-DD。
   *
   * 归一是必须的：因子层的 evalDate 默认把 view.asOf 原样当日期传进来，
   * 那可能是 "2026-08-03 10:00:00"。截面表是按 date 列存的，
   * 拿带时间的字符串去 `WHERE date = ?` 会静默查不到任何行 —— 又一个不报错的失真。
   *
   * 方法名带进错误消息里，否则堆栈里看不出是谁问错了日期。
   */
  const assertNotFuture = (date: string, method: string): string => {
    const d = String(date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      throw new Error(`${method}("${date}") 的日期格式不合法，应为 YYYY-MM-DD`);
    }
    if (d > asOfDate) {
      throw new Error(`${method}("${date}") 越过了视图时点 asOf=${asOf}（asOfDate=${asOfDate}）`);
    }
    return d;
  };

  const rows = (sql: string, ...params: unknown[]): Array<Record<string, unknown>> =>
    db.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>>;

  const one = (sql: string, ...params: unknown[]): Record<string, unknown> | null =>
    (db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined) ?? null;

  return {
    asOf,

    dailyBars(code: string, n: number): DailyBar[] {
      if (n <= 0) return [];
      const rs = rows(
        `SELECT code, date, o, h, l, c, vol, amount, adj_factor
           FROM kline_daily
          WHERE code = ? AND date <= ? AND ${NOT_NULL("o", "h", "l", "c", "vol")}
          ORDER BY date DESC LIMIT ?`,
        code, asOfDate, n
      );
      return rs.reverse().map(r => ({
        code: String(r["code"]), date: String(r["date"]),
        o: num(r["o"], 0), h: num(r["h"], 0), l: num(r["l"], 0), c: num(r["c"], 0),
        vol: num(r["vol"], 0),
        // amount 全表 NULL（新浪日线不给成交额），见 NOT_NULL 的注释
        amount: num(r["amount"], 0),
        // NULL 复权因子按 1（spec R1：2022-05~2023-12 无复权参照），读的人靠 adjFactor===1 判断
        adjFactor: num(r["adj_factor"], 1),
      }));
    },

    minuteBars(code: string, period: number, n: number): MinuteBar[] {
      if (n <= 0) return [];
      const expr = tsLocalExpr("ts");
      // 库里 period 存的是 'm5'（watch-minute 写的），也容忍纯数字写法
      const rs = rows(
        `SELECT code, ts, period, o, h, l, c, vol
           FROM kline_min
          WHERE code = ? AND period IN (?, ?) AND ${expr} <= ?
            AND ${NOT_NULL("o", "h", "l", "c", "vol")}
          ORDER BY ${expr} DESC LIMIT ?`,
        code, `m${period}`, String(period), asOfLocal, n
      );
      return rs.reverse().map(r => ({
        code: String(r["code"]), ts: String(r["ts"]), period,
        o: num(r["o"], 0), h: num(r["h"], 0), l: num(r["l"], 0), c: num(r["c"], 0),
        vol: num(r["vol"], 0),
      }));
    },

    quote(code: string): Quote | null {
      const expr = tsLocalExpr("ts");
      // price > 0 直接写进 WHERE：停牌时 gtimg 回 0 价，返回 0 会被因子读成崩盘。
      // 契约明写"不许返回 0 价"，所以宁可退回更早的一条正常快照。
      // 换手/振幅缺失同样整条不要：0 换手会让"换手上限"那道筛假通过。
      const r = one(
        `SELECT ts, code, price, pct, turnover, amplitude
           FROM quote_snapshot
          WHERE code = ? AND ${expr} <= ? AND price > 0
            AND ${NOT_NULL("price", "pct", "turnover", "amplitude")}
          ORDER BY ${expr} DESC LIMIT 1`,
        code, asOfLocal
      );
      if (r === null) return null;
      return {
        code: String(r["code"]), ts: String(r["ts"]),
        price: num(r["price"], 0), pct: num(r["pct"], 0),
        turnover: num(r["turnover"], 0), amplitude: num(r["amplitude"], 0),
      };
    },

    ztPool(date: string): ZtRow[] {
      const d = assertNotFuture(date, "ztPool");
      // 封单额/连板数/炸板次数缺一个就整行不返回：涨停池是一次写入的快照产物，
      // 半行数据意味着写错了，而不是"这只票的封单确实是 0"。
      // 回测对"没有这一行"判成交概率 0（买不进），对 sealAmt=0 判 1（买到了）—— 差别就是假利润。
      return rows(
        `SELECT date, code, lbc, seal_amt, open_times, first_seal_ts, last_seal_ts, sector
           FROM zt_pool
          WHERE date = ? AND ${NOT_NULL("lbc", "seal_amt", "open_times")}
          ORDER BY code`, d
      ).map(r => ({
        date: String(r["date"]), code: String(r["code"]),
        lbc: num(r["lbc"], 0), sealAmt: num(r["seal_amt"], 0), openTimes: num(r["open_times"], 0),
        firstSealTs: typeof r["first_seal_ts"] === "string" ? r["first_seal_ts"] : null,
        lastSealTs: typeof r["last_seal_ts"] === "string" ? r["last_seal_ts"] : null,
        sector: typeof r["sector"] === "string" ? r["sector"] : null,
      }));
    },

    dtPool(date: string): DtRow[] {
      const d = assertNotFuture(date, "dtPool");
      // 跌停封单同理：0 封单会让回测以为跌停也能卖出去
      return rows(
        `SELECT date, code, seal_amt FROM dt_pool
          WHERE date = ? AND ${NOT_NULL("seal_amt")} ORDER BY code`, d
      ).map(r => ({
        date: String(r["date"]), code: String(r["code"]), sealAmt: num(r["seal_amt"], 0),
      }));
    },

    sectorRank(date: string): SectorRankRow[] {
      const d = assertNotFuture(date, "sectorRank");
      return rows(
        `SELECT date, ts, sector, pct, leader_code FROM sector_rank
          WHERE date = ? AND ${NOT_NULL("pct")} ORDER BY ts, sector`, d
      ).map(r => ({
        date: String(r["date"]), ts: String(r["ts"]), sector: String(r["sector"]),
        pct: num(r["pct"], 0),
        leaderCode: typeof r["leader_code"] === "string" ? r["leader_code"] : null,
      }));
    },

    lhb(date: string): LhbRow[] {
      const d = assertNotFuture(date, "lhb");
      // 主键是 (date, code, change_type)：一只票一天可有多个上榜原因，
      // 实测利欧股份同日三条。按 code 去重会丢近一半的行 —— 不去重。
      // 三个金额列缺任一则整行不返回：净买 0 会被资金因子读成"上榜但没资金动作"。
      return rows(
        `SELECT date, code, change_type, name, explanation, explain_stat,
                net_amt, buy_amt, sell_amt, turnover_rate, deal_amount_ratio,
                close_price, change_rate, d1_chg, d5_chg, d10_chg, d20_chg, d30_chg
           FROM lhb
          WHERE date = ? AND ${NOT_NULL("net_amt", "buy_amt", "sell_amt")}
          ORDER BY code, change_type`, d
      ).map(r => ({
        date: String(r["date"]), code: String(r["code"]),
        changeType: String(r["change_type"]),
        name: typeof r["name"] === "string" ? r["name"] : String(r["code"]),
        // EXPLANATION 是真正的上榜原因，EXPLAIN 只是统计口径 blurb，两者不能混
        explanation: typeof r["explanation"] === "string" ? r["explanation"] : "",
        explainStat: typeof r["explain_stat"] === "string" ? r["explain_stat"] : "",
        netAmt: num(r["net_amt"], 0), buyAmt: num(r["buy_amt"], 0), sellAmt: num(r["sell_amt"], 0),
        turnoverRate: numOrNull(r["turnover_rate"]),
        dealAmountRatio: numOrNull(r["deal_amount_ratio"]),
        closePrice: numOrNull(r["close_price"]),
        changeRate: numOrNull(r["change_rate"]),
        // 后续涨跌幅随时间回填，未回填是 null 不是 0 —— 当监督标签用时两者意思完全不同
        d1Chg: numOrNull(r["d1_chg"]), d5Chg: numOrNull(r["d5_chg"]),
        d10Chg: numOrNull(r["d10_chg"]), d20Chg: numOrNull(r["d20_chg"]),
        d30Chg: numOrNull(r["d30_chg"]),
      }));
    },

    lhbSeats(date: string): LhbSeatRow[] {
      const d = assertNotFuture(date, "lhbSeats");
      // 机构专用席位共用 dept_code='0'，没有稳定业务主键，按 id 排序保证顺序确定
      return rows(
        `SELECT date, code, change_type, side, dept_code, dept_name,
                buy_amt, sell_amt, net_amt, rise_prob_3d, buyer_times_3d
           FROM lhb_seat
          WHERE date = ? AND ${NOT_NULL("buy_amt", "sell_amt", "net_amt")}
          ORDER BY code, change_type, side, id`, d
      ).map(r => ({
        date: String(r["date"]), code: String(r["code"]),
        changeType: String(r["change_type"]),
        side: r["side"] === "sell" ? "sell" : "buy",
        deptCode: typeof r["dept_code"] === "string" ? r["dept_code"] : "",
        deptName: typeof r["dept_name"] === "string" ? r["dept_name"] : "",
        buyAmt: num(r["buy_amt"], 0), sellAmt: num(r["sell_amt"], 0), netAmt: num(r["net_amt"], 0),
        riseProb3d: numOrNull(r["rise_prob_3d"]),
        buyerTimes3d: numOrNull(r["buyer_times_3d"]),
      }));
    },

    macro(symbol: string, n: number): MacroRow[] {
      if (n <= 0) return [];
      const expr = tsLocalExpr("ts");
      // macro 表当前是空的（上线起攒，没有历史）。返回 [] 而不是抛错，
      // 因子契约要求外围类因子能接受空数组并降 confidence。
      const rs = rows(
        `SELECT ts, symbol, price, pct FROM macro
          WHERE symbol = ? AND ${expr} <= ? AND ${NOT_NULL("price", "pct")}
          ORDER BY ${expr} DESC LIMIT ?`,
        symbol, asOfLocal, n
      );
      return rs.reverse().map(r => ({
        ts: String(r["ts"]), symbol: String(r["symbol"]),
        price: num(r["price"], 0), pct: num(r["pct"], 0),
      }));
    },

    universe(): SecurityRow[] {
      // spec §10.2：用当前在市清单回测 2022 年 = 假装当年买的没一只退市，收益系统性高估。
      // list_date IS NULL 放行 —— bootstrap 的 clist 不带上市日期，
      // 若把未知当"未上市"排除，这个方法在真库上会返回空池（静默的灾难性失败）。
      // 未知量由 universeQuality() 暴露，回测覆盖率报告要标出来。
      return rows(
        `SELECT code, name, list_date, delist_date, board, is_st_history_json
           FROM security
          WHERE (list_date IS NULL OR list_date <= ?)
            AND (delist_date IS NULL OR delist_date > ?)
          ORDER BY code`,
        asOfDate, asOfDate
      ).map(r => mapSecurity(r, asOfDate));
    },

    security(code: string): SecurityRow | null {
      const r = one(
        `SELECT code, name, list_date, delist_date, board, is_st_history_json
           FROM security WHERE code = ?`, code
      );
      return r === null ? null : mapSecurity(r, asOfDate);
    },

    tradingDays(from: string, to: string): string[] {
      // to 越过 asOf 时**截断而不抛错**：契约写的是"asOf 及之前的交易日"，
      // 调用方传一个开区间上界（回测区间末、年末）是正常用法，抛错会把重放循环打断。
      // 这与截面访问器的"越界即抛"不矛盾：那些是问"某一天的数据"，这个是问"哪些天"。
      const lo = String(from).slice(0, 10);
      const hiRaw = String(to).slice(0, 10);
      const hi = hiRaw > asOfDate ? asOfDate : hiRaw;
      if (lo > hi) return [];
      return rows(
        `SELECT date FROM trading_calendar
          WHERE is_open = 1 AND date >= ? AND date <= ? ORDER BY date`,
        lo, hi
      ).map(r => String(r["date"]));
    },

    prevTradingDay(date: string, back = 1): string | null {
      if (!Number.isInteger(back) || back < 1) return null;
      const d = String(date).slice(0, 10);
      const hi = d > asOfDate ? asOfDate : d;
      const r = one(
        `SELECT date FROM trading_calendar
          WHERE is_open = 1 AND date < ? AND date <= ?
          ORDER BY date DESC LIMIT 1 OFFSET ?`,
        d, hi, back - 1
      );
      return r === null ? null : String(r["date"]);
    },

    hasGap(date: string, kind?: string): boolean {
      const d = assertNotFuture(date, "hasGap");
      const r = one(
        `SELECT 1 AS x FROM data_gap
          WHERE date = ? AND resolved_at IS NULL ${kind === undefined ? "" : "AND kind = ?"}
          LIMIT 1`,
        ...(kind === undefined ? [d] : [d, kind])
      );
      return r !== null;
    },
  };
}

/* ------------------------------ 契约外的补充 ------------------------------ */

/**
 * 某日未修复的缺口种类。
 *
 * PointInTimeView 是冻结契约，只有布尔 hasGap，策略层拿不到"缺了什么"。
 * 信号卡与回测覆盖率报告需要写具体是哪一类缺口，所以这里另开一个函数，
 * 不往视图上挂私有方法（挂了策略层就会开始依赖契约外的东西）。
 */
export function gapKinds(db: Db, date: string): string[] {
  return (db.prepare(
    `SELECT DISTINCT kind FROM data_gap WHERE date = ? AND resolved_at IS NULL`
  ).all(date) as Array<Record<string, unknown>>).map(r => String(r["kind"]));
}

export interface UniverseQuality {
  total: number;
  /** list_date 为空的只数。这些票逃过了幸存者过滤 */
  unknownListDate: number;
  unknownRatio: number;
}

/**
 * 幸存者过滤的实际覆盖率。
 *
 * universe() 放行了 list_date 未知的票，所以"已按当日在市筛选"这句话是有折扣的。
 * 折扣多少必须能量化出来贴到回测报告首页，否则等于把 §10.2 的坑用注释盖上。
 */
export function universeQuality(db: Db, asOf: string): UniverseQuality {
  const asOfLocal = toLocalWall(asOf, true);
  if (asOfLocal === null) throw new Error(`universeQuality: asOf 不是合法时间戳：${JSON.stringify(asOf)}`);
  const d = asOfLocal.slice(0, 10);
  const r = db.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN list_date IS NULL THEN 1 ELSE 0 END) AS unknown
       FROM security
      WHERE (list_date IS NULL OR list_date <= ?)
        AND (delist_date IS NULL OR delist_date > ?)`
  ).get(d, d) as Record<string, unknown>;
  const total = num(r["total"], 0);
  const unknown = num(r["unknown"], 0);
  return {
    total, unknownListDate: unknown,
    unknownRatio: total === 0 ? 0 : Math.round((unknown / total) * 1e6) / 1e6,
  };
}
