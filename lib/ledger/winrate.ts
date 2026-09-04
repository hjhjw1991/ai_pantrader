import type { Db } from "@/lib/db";
import type { ErrorType, Phase, Verdict, WinRateStats } from "@/lib/contracts";
import { countsTowardWinRate } from "@/lib/contracts";
import { PHASES, predWhere, round, type LedgerFilter } from "@/lib/ledger/query";

/**
 * 胜率统计（spec §11 第 5 步）+ Advisor 的 A/B 分组（spec §5.3）。
 *
 * 口径写在这里，别处不要另算：
 *   - 分母 total 只算有方向的判定（命中 + 偏差），判据集中在 countsTowardWinRate。
 *     中性是"没方向承诺"或"落在中性带里"，算进分母会让胜率随中性带宽度变动，
 *     那是在量测阈值而不是量测判断力。
 *   - 未触发同样不进分母，但它和中性是两回事：价格没够到推荐的买点，
 *     这笔推荐从未成为一个仓位。它的统计口径在 lib/ledger/review（触发率），
 *     混进胜率会把"买点定得够不到"伪装成"看得准"。
 *   - settled / neutral / untriggered 单独给出，调用方要看全貌时不用再查库。
 */

export const ERROR_TYPES: ErrorType[] = ["瞬时价误判", "板块漏扫", "逆势扛", "追高", "其他"];

/**
 * A/B 两臂各自的最小样本量。
 *
 * 取 30：命中率在 50% 附近时单臂标准误 ≈ 0.5/sqrt(n)，n=30 已经有 ~9pp，
 * 两臂之差的标准误约 13pp —— 也就是说 30 条起才勉强能分辨 25pp 以上的差距。
 * 低于这个数的差值几乎全是噪声，报出来只会让人以为"Claude 提升了 X 个点"。
 *
 * 所以这不是"到 30 就可信"，而是"不到 30 连看都不该看"。
 * 到了阈值也只描述样本差异，不声称因果 —— 两臂不是随机分配的，
 * Claude 更可能在难判的局面被调用，选择偏差始终存在。
 */
export const AB_MIN_SAMPLE_PER_ARM = 30;

export interface ABReport {
  comparable: boolean;
  minSamplePerArm: number;
  withRate: number | null;
  withoutRate: number | null;
  /** 百分点差（with - without）。样本不足时为 null，不给数字 */
  deltaPct: number | null;
  note: string;
}

export interface LedgerWinRateStats extends WinRateStats {
  /** 全部已结算条数，含中性与未触发 */
  settled: number;
  neutral: number;
  /** 价格没够到推荐买点的条数。不进胜率分母，但它是复盘的第一道闸 */
  untriggered: number;
  ab: ABReport;
}

interface Row {
  phase: Phase;
  verdict: string;
  error_type: ErrorType | null;
  advisor_influenced: number;
}

function rate(hit: number, total: number): number {
  return total > 0 ? round(hit / total, 6) : 0;
}

export function winRate(db: Db, filter: LedgerFilter = {}): LedgerWinRateStats {
  const w = predWhere(filter);
  const rows = db.prepare(
    `SELECT p.phase, o.verdict, o.error_type, p.advisor_influenced
     FROM prediction p JOIN outcome o ON o.pred_id = p.id
     WHERE 1=1${w.sql}`
  ).all(...w.params) as Row[];

  const byPhase = Object.fromEntries(
    PHASES.map(p => [p, { total: 0, hit: 0 }])
  ) as Record<Phase, { total: number; hit: number }>;
  // 五类键预置为 0：前端不用判空，也能一眼看出"这类一次都没发生"
  const byErrorType: Record<string, number> = Object.fromEntries(ERROR_TYPES.map(e => [e, 0]));
  const ab = { with: { total: 0, hit: 0 }, without: { total: 0, hit: 0 } };

  let total = 0, hit = 0, neutral = 0, untriggered = 0;
  for (const r of rows) {
    if (r.error_type) byErrorType[r.error_type] = (byErrorType[r.error_type] ?? 0) + 1;
    if (!countsTowardWinRate(r.verdict as Verdict)) {
      if (r.verdict === "未触发") untriggered++; else neutral++;
      continue;
    }

    const isHit = r.verdict === "命中";
    total++; if (isHit) hit++;
    if (byPhase[r.phase]) {
      byPhase[r.phase].total++;
      if (isHit) byPhase[r.phase].hit++;
    }
    const arm = r.advisor_influenced === 1 ? ab.with : ab.without;
    arm.total++; if (isHit) arm.hit++;
  }

  return {
    total, hit, rate: rate(hit, total),
    settled: rows.length, neutral, untriggered,
    byPhase, byErrorType,
    advisorAB: ab,
    ab: abReport(ab),
  };
}

function abReport(ab: WinRateStats["advisorAB"]): ABReport {
  const comparable = ab.with.total >= AB_MIN_SAMPLE_PER_ARM
    && ab.without.total >= AB_MIN_SAMPLE_PER_ARM;
  const withRate = ab.with.total ? rate(ab.with.hit, ab.with.total) : null;
  const withoutRate = ab.without.total ? rate(ab.without.hit, ab.without.total) : null;

  if (!comparable) {
    return {
      comparable: false, minSamplePerArm: AB_MIN_SAMPLE_PER_ARM, withRate, withoutRate,
      deltaPct: null,
      note: `样本不足：有 Advisor ${ab.with.total} 条 / 无 Advisor ${ab.without.total} 条，`
        + `任一臂 < ${AB_MIN_SAMPLE_PER_ARM} 时两者之差在噪声范围内，不给差值也不作结论`,
    };
  }
  const deltaPct = round((withRate! - withoutRate!) * 100, 4);
  return {
    comparable: true, minSamplePerArm: AB_MIN_SAMPLE_PER_ARM, withRate, withoutRate, deltaPct,
    note: `有 Advisor ${ab.with.total} 条命中率 ${(withRate! * 100).toFixed(1)}%，`
      + `无 Advisor ${ab.without.total} 条命中率 ${(withoutRate! * 100).toFixed(1)}%，`
      + `相差 ${deltaPct.toFixed(1)} 个百分点。仅描述这批样本，两臂非随机分配，不等于因果`,
  };
}
