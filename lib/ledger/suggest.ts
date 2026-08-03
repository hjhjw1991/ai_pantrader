import type { Db } from "@/lib/db";
import type { AccountType, ErrorType, ParamSuggestion } from "@/lib/contracts";
import { predWhere, round, type LedgerFilter } from "@/lib/ledger/query";

/**
 * 参数反馈（spec §11 第 4 步）。
 *
 * 只出建议，绝不改 strategy.yaml。
 * 一个能拿几笔交易就自动重调参数的系统没人能 debug —— 出问题时你分不清是行情变了、
 * 还是它昨晚自己把止损改了。YAML 是唯一真相源（D7），改它必须是人的动作。
 *
 * 所以本模块是纯读：不写库、不改传进来的 config 对象。
 */

/**
 * 同类错误达到 3 次才提建议。
 *
 * 取 3 的理由：1 次是意外，2 次可能是同一波行情的两个切片（同一天两只票破位很常见），
 * 3 次才勉强算"模式"。这不是统计显著，只是把"别拿单次意外改参数"写成了规则。
 * 门槛低了会追噪声，高了则错误已经重犯很多次 —— 而闭环的目标就是"不重犯"。
 */
export const SUGGEST_MIN_OCCURRENCES = 3;

/**
 * 只看近 60 天（约一个季度的交易日）。
 * 老错误如果已经改过规则，不该被反复提；真没改，60 天内一定会再攒够 3 次。
 */
export const SUGGEST_LOOKBACK_DAYS = 60;

export interface SuggestOptions {
  /** 当前 strategy.yaml 解析出的对象，用来取 current 值。不传则 current 一律为 null */
  config?: unknown;
  filter?: LedgerFilter;
  minOccurrences?: number;
  lookbackDays?: number;
  asOf?: string;
}

/** 按点路径取值，取不到返回 null（区别于"取到了 null"——本项目参数不会存 null） */
function readPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object" || !(key in cur)) return null;
    cur = cur[key];
  }
  return cur ?? null;
}

/**
 * 止损收紧 25%。
 * 参数可能写成小数（0.08）也可能写成百分数（8），按 <=1 判断形态，各自留地板值：
 * 收得没有下限会把策略变成"一抖就走"，那是用另一个错误覆盖当前的错误。
 */
function tightenStop(current: unknown): number | null {
  if (typeof current !== "number" || current <= 0) return null;
  const isFraction = current <= 1;
  const floor = isFraction ? 0.03 : 3;
  return round(Math.max(current * 0.75, floor), isFraction ? 4 : 2);
}

function tightenCap(current: unknown): number | null {
  if (typeof current !== "number" || current <= 0) return null;
  const isFraction = current <= 1;
  const floor = isFraction ? 0.1 : 10;
  return round(Math.max(current * 0.8, floor), isFraction ? 4 : 2);
}

function widenTopN(current: unknown): number {
  if (typeof current !== "number" || current <= 0) return 15;
  return Math.min(Math.round(current * 1.5), 30);
}

interface Bucket {
  errorType: ErrorType;
  account: AccountType | null;
  occurrences: number;
}

/**
 * 错因 → 参数路径的固定映射。
 *
 * 其他 类没有映射：归不到具体规则就没有可调的参数，硬编一个建议出来是最坏的做法
 * ——它会让面板看起来"闭环在工作"，其实只是在乱调。
 * 必查链 也刻意没有映射：它在 spec §8.2 里写死不可关闭，不接受"建议缩短"。
 */
function build(b: Bucket, cfg: unknown): ParamSuggestion | null {
  switch (b.errorType) {
    case "逆势扛": {
      // 止损是按账户分的，贼王与价值的止损语义完全不同，不能混着提
      const account = b.account ?? "贼王";
      const paramPath = `持仓.${account}.止损`;
      const current = readPath(cfg, paramPath);
      const suggested = tightenStop(current);
      return {
        errorType: b.errorType, occurrences: b.occurrences, paramPath, current,
        suggested: suggested ?? 0.06,
        rationale: suggested == null
          ? `${b.occurrences} 次逆势扛（破止损未走）。当前止损值无法解析（${JSON.stringify(current)}），需人工设定；建议先按 6% 收紧`
          : `${b.occurrences} 次逆势扛（破止损未走）。建议把 ${account} 账户止损从 ${current} 收紧到 ${suggested}（-25%），让破位更早触发离场`,
      };
    }
    case "追高": {
      const paramPath = "选股.过滤器阈值.位置涨幅上限";
      const current = readPath(cfg, paramPath);
      const suggested = tightenCap(current);
      return {
        errorType: b.errorType, occurrences: b.occurrences, paramPath, current,
        suggested: suggested ?? 20,
        rationale: `${b.occurrences} 次追高（在位置涨幅上限外买入）。建议把上限从 ${current} 下调到 ${suggested ?? 20}（-20%），把入场位置压回来`,
      };
    }
    case "板块漏扫": {
      const paramPath = "选股.主线识别.板块涨幅榜TopN";
      const current = readPath(cfg, paramPath);
      const suggested = widenTopN(current);
      return {
        errorType: b.errorType, occurrences: b.occurrences, paramPath, current,
        suggested,
        rationale: `${b.occurrences} 次板块漏扫。必查链本身写死不可调，可放宽的是扫描广度：`
          + `建议 TopN 从 ${current} 放宽到 ${suggested}（板块榜均值会掩盖链内龙头封板）`,
      };
    }
    case "瞬时价误判": {
      // 这一类的根因是数据新鲜度，当前 strategy.yaml 里没有对应参数
      const paramPath = "选股.过滤器阈值.报价最大延迟秒";
      const current = readPath(cfg, paramPath);
      const suggested = typeof current === "number" && current > 0
        ? Math.max(round(current * 0.5, 0), 30)
        : 60;
      return {
        errorType: b.errorType, occurrences: b.occurrences, paramPath, current,
        suggested,
        rationale: current == null
          ? `${b.occurrences} 次瞬时价误判（用了旧缓存价/抖动价）。该参数当前不存在，建议新增 ${paramPath}=${suggested}，超时就强制重取实时价`
          : `${b.occurrences} 次瞬时价误判。建议把报价最大延迟从 ${current}s 收紧到 ${suggested}s`,
      };
    }
    default:
      return null;
  }
}

/**
 * 生成参数调整建议。频次降序，方便面板直接展示 —— 最该先处理的排最前。
 */
export function suggestParamChanges(db: Db, opts: SuggestOptions = {}): ParamSuggestion[] {
  const min = opts.minOccurrences ?? SUGGEST_MIN_OCCURRENCES;
  const lookback = opts.lookbackDays ?? SUGGEST_LOOKBACK_DAYS;
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${asOf}T00:00:00Z`) - lookback * 86400_000)
    .toISOString().slice(0, 10);

  const filter: LedgerFilter = { from, to: asOf, ...(opts.filter ?? {}) };
  const w = predWhere(filter);
  const rows = db.prepare(
    `SELECT o.error_type et, p.account acc, COUNT(*) n
     FROM prediction p JOIN outcome o ON o.pred_id = p.id
     WHERE o.error_type IS NOT NULL${w.sql}
     GROUP BY o.error_type, p.account`
  ).all(...w.params) as Array<{ et: ErrorType; acc: AccountType | null; n: number }>;

  // 逆势扛 按账户分桶（止损参数按账户分），其余错因跨账户合并计数
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    const account = r.et === "逆势扛" ? (r.acc ?? null) : null;
    const key = `${r.et}|${account ?? ""}`;
    const b = buckets.get(key) ?? { errorType: r.et, account, occurrences: 0 };
    b.occurrences += r.n;
    buckets.set(key, b);
  }

  const out: ParamSuggestion[] = [];
  for (const b of buckets.values()) {
    if (b.occurrences < min) continue;
    const s = build(b, opts.config);
    if (s) out.push(s);
  }
  return out.sort((a, b) =>
    b.occurrences - a.occurrences || a.paramPath.localeCompare(b.paramPath));
}
