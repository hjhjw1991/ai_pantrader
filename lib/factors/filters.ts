/**
 * 七道筛（spec §8 过滤器组，阈值全参数化）。
 *
 * 七道筛的原始定义来自 ghzw 情绪妖股过滤器，任一红灯即降级/剔除：
 *   1. 位置        近 N 日涨幅过大 / 创新高追高段
 *   2. 换手·振幅   天量换手、日内巨振 = 高位剧烈分歧
 *   3. 估值vs基本面 PE 畸高、纯概念无业绩            ← 系统尚未采集基本面
 *   4. 催化真伪    硬催化（政策/订单/涨价函/业绩）还是游资情绪 ← 系统尚未采集公告与新闻
 *   5. 权限×账户   主板→贼王；创业板/科创板→仅价值；北交所→都不做
 *   6. 打法匹配    需盯盘秒级应对的大振幅妖股，用户执行不了
 *   7. 目标匹配    真业绩 + 合理估值 + 不追高（业绩/估值部分同样缺数据源）
 *
 * 关键设计：**未判定 ≠ 通过**。缺数据源的筛子返回 evaluated: false，
 * 既不算命中也不算否决，而是进 unevaluated 列表，由信号卡显式告警。
 * 如果让缺数据的筛子静默 pass，系统就会宣称"七道筛全过"，
 * 而实际上第 3、4 道从来没跑过 —— 那是最危险的一种假阳性。
 */
import type { AccountType, Board, DailyBar, FactorSpec, PointInTimeView, SecurityRow } from "@/lib/contracts";
import { adjClose, barsUpTo, mean, pctChange, pobj, requireCode, round6, evalDate } from "@/lib/factors/util";
import { judgeBarLimitUp } from "@/lib/factors/limit-up";

export const FILTER_NAMES = [
  "位置", "换手振幅", "估值基本面", "催化真伪", "权限账户", "打法匹配", "目标匹配",
] as const;
export type FilterName = typeof FILTER_NAMES[number];

/**
 * 当前数据地基支撑不了的筛子。这份清单是要往回测报告与信号卡上抬的，
 * 不是注释里的免责声明。
 */
export const UNSUPPORTED_FILTERS: Array<{ name: FilterName; missing: string; reason: string }> = [
  {
    name: "估值基本面",
    missing: "PE / PB / 营收 / 净利润",
    reason: "无数据源：M0 只采了行情、涨停池、龙虎榜，没有财务表",
  },
  {
    name: "催化真伪",
    missing: "公告 / 新闻 / 政策事件",
    reason: "无数据源：消息面 NLP 粗分类质量未验证（spec §19.2 未决），未进决策路径",
  },
];

export interface FilterParams {
  位置涨幅上限: number;
  位置回溯日: number;
  新高回溯日: number;
  /** 创新高本身是否直接否决。默认否 —— 主线龙头回踩后再创新高是买点，不是剔除理由 */
  新高即否决: boolean;
  /** 回溯窗口内的涨停次数上限（"连续涨停偏离上龙虎榜"那一条） */
  近期涨停次数上限: number;
  换手上限: number;
  振幅上限: number;
  平均振幅回溯日: number;
  止损幅度: number;
  振幅容忍倍数: number;
  MA20偏离上限: number;
  账户可交易板块: Record<AccountType, Board[]>;
}

/** 默认值对齐 spec §9.1 的 YAML 示例：位置涨幅上限 50 / 换手上限 15 / 振幅上限 10 */
export const DEFAULT_FILTER_PARAMS: FilterParams = {
  位置涨幅上限: 50,
  位置回溯日: 20,
  新高回溯日: 60,
  新高即否决: false,
  近期涨停次数上限: 3,
  换手上限: 15,
  振幅上限: 10,
  平均振幅回溯日: 10,
  止损幅度: 5,
  振幅容忍倍数: 2,
  MA20偏离上限: 20,
  /**
   * 每个账户能交易哪些板块，由用户按自己的开通权限配置（strategy.yaml）。
   * 默认留空：这里不预设任何账户名，也不替用户假设他开了哪些权限 ——
   * 猜错的两个方向都有害（少给权限漏掉可交易标的，多给权限给出买不进的信号）。
   * 未配置的账户，这道筛报"未判定"而不是默默放行或默默否决。
   */
  账户可交易板块: {},
};

export interface FilterOutcome {
  name: FilterName;
  pass: boolean;
  /** false = 数据不足/无数据源，本道筛没跑成。不计入通过，也不计入否决 */
  evaluated: boolean;
  /** true = 只判了一部分（另一部分缺数据源） */
  partial?: boolean;
  reason: string;
}

export interface FilterReport {
  code: string;
  account: AccountType | null;
  /** 无任何"已判定且否决" */
  passedAll: boolean;
  outcomes: FilterOutcome[];
  passed: FilterName[];
  rejected: FilterName[];
  unevaluated: FilterName[];
  params: FilterParams;
}

/** 窗口内涨停次数。用分板阈值 + 当日 ST 状态判，不是简单的"涨幅 > 9.8%" */
function countLimitUps(sec: SecurityRow, bars: DailyBar[], back: number): number {
  const from = Math.max(1, bars.length - back);
  let n = 0;
  for (let i = from; i < bars.length; i++) {
    if (judgeBarLimitUp(sec, bars[i], bars[i - 1]).limitUp) n++;
  }
  return n;
}

function mergeParams(p: Partial<FilterParams> = {}): FilterParams {
  return {
    ...DEFAULT_FILTER_PARAMS, ...p,
    账户可交易板块: { ...DEFAULT_FILTER_PARAMS.账户可交易板块, ...(p.账户可交易板块 ?? {}) },
  };
}

export function runFilters(
  view: PointInTimeView, code: string, account: AccountType | null,
  overrides: Partial<FilterParams> = {}, date = view.asOf
): FilterReport {
  const p = mergeParams(overrides);
  const sec = view.security(code);
  const need = Math.max(p.位置回溯日, p.新高回溯日, p.平均振幅回溯日, 20) + 2;
  const bars = barsUpTo(view, code, date, need);
  const closes = bars.map(adjClose);
  const cur = bars.length > 0 ? bars[bars.length - 1] : null;
  const q = view.quote(code);

  const outcomes: FilterOutcome[] = [];

  /* 1. 位置 */
  if (cur === null || closes.length < p.位置回溯日 + 1) {
    outcomes.push({ name: "位置", pass: false, evaluated: false, reason: `日线不足 ${p.位置回溯日 + 1} 根，位置无法判定` });
  } else {
    const gain = round6(pctChange(closes[closes.length - 1 - p.位置回溯日], closes[closes.length - 1]));
    const hiWin = closes.slice(Math.max(0, closes.length - p.新高回溯日 - 1), closes.length - 1);
    const 创新高 = hiWin.length > 0 && closes[closes.length - 1] > Math.max(...hiWin);
    // 连续涨停偏离上龙虎榜 = 短期已被资金抬到显眼位置，接力风险陡增。
    // 数涨停次数要用分板阈值与当日 ST 状态，所以走 judgeBarLimitUp 而不是"涨幅 > 9.8"。
    const 涨停次数 = sec === null ? 0 : countLimitUps(sec, bars, p.位置回溯日);
    const 涨幅超限 = gain > p.位置涨幅上限;
    const 涨停超限 = sec !== null && 涨停次数 > p.近期涨停次数上限;
    const 新高否决 = p.新高即否决 && 创新高;
    const bad = 涨幅超限 || 涨停超限 || 新高否决;
    outcomes.push({
      name: "位置", pass: !bad, evaluated: true,
      reason: bad
        ? [
          涨幅超限 ? `${p.位置回溯日}日涨幅 ${gain}% > 上限 ${p.位置涨幅上限}%` : "",
          涨停超限 ? `近${p.位置回溯日}日涨停 ${涨停次数} 次 > 上限 ${p.近期涨停次数上限}` : "",
          新高否决 ? `已创 ${p.新高回溯日} 日新高` : "",
        ].filter(s => s !== "").join("；") + "，属高位追高段"
        : `${p.位置回溯日}日涨幅 ${gain}% / 涨停 ${涨停次数} 次${创新高 ? `（已创 ${p.新高回溯日} 日新高，注意追高）` : ""}`,
    });
  }

  /* 2. 换手·振幅 */
  if (q === null) {
    // 换手率要流通股本，日线里没有 → 只能来自实时快照。没有快照就是没判，不是通过。
    outcomes.push({ name: "换手振幅", pass: false, evaluated: false, reason: "无实时快照，换手率与日内振幅无法判定" });
  } else {
    const 换手超限 = q.turnover > p.换手上限;
    const 振幅超限 = q.amplitude > p.振幅上限;
    outcomes.push({
      name: "换手振幅", pass: !换手超限 && !振幅超限, evaluated: true,
      reason: 换手超限 || 振幅超限
        ? `${换手超限 ? `换手 ${q.turnover}% > ${p.换手上限}% ` : ""}${振幅超限 ? `振幅 ${q.amplitude}% > ${p.振幅上限}%` : ""}`.trim()
        : `换手 ${q.turnover}% / 振幅 ${q.amplitude}%`,
    });
  }

  /* 3 & 4. 缺数据源，硬编码为未判定 */
  for (const u of UNSUPPORTED_FILTERS) {
    outcomes.push({ name: u.name, pass: false, evaluated: false, reason: `${u.reason}（缺 ${u.missing}）` });
  }

  /* 5. 权限×账户 */
  if (sec === null) {
    outcomes.push({ name: "权限账户", pass: false, evaluated: false, reason: "security 表没有这个代码，板块未知" });
  } else if (account === null) {
    outcomes.push({
      name: "权限账户", pass: false, evaluated: false,
      reason: "未指定账户，无法判定板块权限",
    });
  } else if (p.账户可交易板块[account] === undefined) {
    // 关键：没配置 ≠ 什么都不能买。空数组会让这道筛否决一切，
    // 看起来像"策略很严格"，实际是配置缺失被当成了结论
    outcomes.push({
      name: "权限账户", pass: false, evaluated: false,
      reason: `账户 ${account} 未配置可交易板块（strategy.yaml 持仓段），本道筛未判定`,
    });
  } else {
    const allowed = p.账户可交易板块[account];
    const ok = allowed.includes(sec.board);
    outcomes.push({
      name: "权限账户", pass: ok, evaluated: true,
      reason: ok ? `${sec.board} 可在${account}账户交易` : `${sec.board} 不在${account}账户可交易范围 ${JSON.stringify(allowed)}`,
    });
  }

  /* 6. 打法匹配（用户不盯盘：固定止损在大振幅里会被秒破） */
  if (bars.length < p.平均振幅回溯日 + 1) {
    outcomes.push({ name: "打法匹配", pass: false, evaluated: false, reason: "日线不足，平均振幅无法判定" });
  } else {
    const win = bars.slice(bars.length - p.平均振幅回溯日);
    const amps = win.map((b, i) => {
      const prev = bars[bars.length - p.平均振幅回溯日 + i - 1];
      return prev.c === 0 ? 0 : (b.h - b.l) / prev.c * 100;
    });
    const avgAmp = round6(mean(amps));
    const 容忍 = p.止损幅度 * p.振幅容忍倍数;
    const 超限 = avgAmp > 容忍;
    outcomes.push({
      name: "打法匹配", pass: !超限, evaluated: true,
      reason: 超限
        ? `近${p.平均振幅回溯日}日平均振幅 ${avgAmp}% > 容忍 ${容忍}%（${p.止损幅度}% 止损会被日内波动秒破，用户不盯盘接不了）`
        : `近${p.平均振幅回溯日}日平均振幅 ${avgAmp}%`,
    });
  }

  /* 7. 目标匹配：只能判"不追高"这一半，业绩与估值缺数据源 */
  if (cur === null || closes.length < 20) {
    outcomes.push({
      name: "目标匹配", pass: false, evaluated: false, partial: true,
      reason: "日线不足 20 根，偏离度无法判定；业绩/估值部分本就缺数据源",
    });
  } else {
    const ma20 = mean(closes.slice(closes.length - 20));
    const dev = round6(pctChange(ma20, closes[closes.length - 1]));
    const 超限 = dev > p.MA20偏离上限;
    outcomes.push({
      name: "目标匹配", pass: !超限, evaluated: true, partial: true,
      reason: 超限
        ? `距 MA20 偏离 ${dev}% > 上限 ${p.MA20偏离上限}%，与"不追高"目标冲突（业绩/估值部分未判定）`
        : `距 MA20 偏离 ${dev}%（业绩/估值部分未判定）`,
    });
  }

  // 按 FILTER_NAMES 的顺序输出，保证同一份输入的报告字段顺序稳定（哈希可比）
  const ordered = FILTER_NAMES.map(n => outcomes.find(o => o.name === n)!);
  return {
    code, account,
    passedAll: ordered.every(o => !o.evaluated || o.pass),
    outcomes: ordered,
    passed: ordered.filter(o => o.evaluated && o.pass).map(o => o.name),
    rejected: ordered.filter(o => o.evaluated && !o.pass).map(o => o.name),
    unevaluated: ordered.filter(o => !o.evaluated).map(o => o.name),
    params: p,
  };
}

/* --------------------------------- 因子 --------------------------------- */

function paramsFrom(raw: Record<string, unknown>): Partial<FilterParams> {
  const out: Partial<FilterParams> = {};
  for (const k of [
    "位置涨幅上限", "位置回溯日", "新高回溯日", "近期涨停次数上限", "换手上限", "振幅上限",
    "平均振幅回溯日", "止损幅度", "振幅容忍倍数", "MA20偏离上限",
  ] as const) {
    const v = raw[k];
    if (typeof v === "number" && Number.isFinite(v)) (out as Record<string, unknown>)[k] = v;
  }
  if (typeof raw["新高即否决"] === "boolean") out.新高即否决 = raw["新高即否决"];
  const boards = pobj(raw, "账户可交易板块");
  if (Object.keys(boards).length > 0) out.账户可交易板块 = boards as Record<AccountType, Board[]>;
  return out;
}

const 过滤器: FactorSpec<number> = {
  name: "过滤器", version: "1.0.0", group: "filter",
  // 账户不设默认值：账户名由用户定义，代码猜一个名字必然是错的
  defaults: { ...DEFAULT_FILTER_PARAMS },
  fn: ctx => {
    const code = requireCode(ctx.params, "过滤器");
    const date = evalDate(ctx.view, ctx.params);
    // 没传账户就是"不按账户过滤"，权限筛会因此报未判定并压低 confidence，
    // 而不是套用某个猜出来的账户的权限
    const account = typeof ctx.params["账户"] === "string"
      ? (ctx.params["账户"] as AccountType) : null;
    const rep = runFilters(ctx.view, code, account, paramsFrom(ctx.params), date);
    return {
      name: "过滤器", version: "1.0.0",
      value: rep.rejected.length,
      label: rep.rejected.length === 0
        ? `七道筛无否决（${rep.unevaluated.length} 道未判定）`
        : `否决：${rep.rejected.join("/")}`,
      provenance: "real",
      // 置信度 = 真正跑过的筛数 / 7。缺基本面与消息面时它上不去 5/7，这个数字要露出来
      confidence: round6((rep.passed.length + rep.rejected.length) / FILTER_NAMES.length),
      inputs: {
        代码: code, 日期: date, 账户: account ?? "未指定",
        通过: rep.passed, 否决: rep.rejected, 未判定: rep.unevaluated,
        明细: rep.outcomes.map(o => ({ 筛: o.name, 通过: o.pass, 已判定: o.evaluated, 说明: o.reason })),
      },
    };
  },
};

export const FILTER_FACTORS: FactorSpec<any>[] = [过滤器];
