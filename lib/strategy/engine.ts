/**
 * 规则引擎：因子读数 + strategy.yaml → 信号卡。
 *
 * 三条硬约束（spec §4.1 / §17）：
 *   1. 只读，且**只通过 PointInTimeView 拿数据** —— 本目录不许出现任何存储访问。
 *   2. 不取系统时间。"现在" = input.view.asOf。回测喂历史视图、实盘喂当日视图，
 *      同一份策略代码两边跑，这是它成立的前提。
 *   3. 因子经 FactorRegistry 接口注入，不 import 具体因子实现 ——
 *      引擎的正确性应当能在手捏的因子读数上被证明。
 *
 * 一条产品约束：**缺数据不许静默通过**。
 * 没有对应因子的防守条件、未判定的筛子、低置信的因子，全部抬到信号卡的 warnings 上。
 * 静默放过等于宣称"条件都查过了"，那是这套系统里最贵的一种假阳性。
 */
import type {
  AccountId, AccountType, Action, Candidate, EnvAssessment, EnvGear, FactorRegistry, FactorResult,
  Phase, PointInTimeView, PoolRow, SignalCard, StrategyConfig, StrategyEngine, StrategyEngineInput } from "@/lib/contracts";
import { accountRule, takeProfitRules, unparsedTakeProfit } from "@/lib/strategy/loader";
// 视图层的工具，不是因子实现 —— 引擎只依赖 PointInTimeView 这个契约
import { completeDate } from "@/lib/pit/complete-date";
import { crossRowsFor, swSectorOf } from "@/lib/pit/snapshot-or-proxy";
import { normalizeAccountKey } from "@/lib/strategy/schema";

/** 低置信线。spec §10.3：代理因子 ρ<0.8 要在回测报告首页标红，信号卡同一把尺子 */
export const LOW_CONFIDENCE = 0.8;

/** 盘面强度进攻线。盘面强度是 0~100 的归一化分，65 以上因子自己标"强" */
export const ATTACK_STRENGTH = 65;

/**
 * hasGap 只回布尔，拿不到"缺了什么"，所以按已知的缺口种类逐个问一遍。
 * 名字要与 data 层 recordGap 的 kind 对齐，漏一个就是那类缺口永远不上卡。
 */
export const KNOWN_GAP_KINDS = [
  "kline_daily", "kline_min", "quote_snapshot", "zt_pool", "dt_pool",
  "sector_rank", "lhb", "lhb_seat", "macro",
] as const;

/** 环境档位要用到的因子。少一个就降档，不硬撑 */
const ENV_FACTOR_NAMES = [
  "盘面强度", "情绪温度", "赚钱效应", "涨停家数", "跌停家数", "连板高度", "炸板率", "外围传导",
] as const;

/** 个股面的因子，用于组 thesis 与打分 */
const STOCK_FACTOR_NAMES = [
  "均线方向", "量能", "洗盘vs派发", "龙虎榜净买", "游资席位识别",
] as const;

/**
 * 布尔型防守条件 → 靠哪个因子的哪个判据。
 * 不在这张表里的布尔条件一律"未判定"，不当 false 放过 ——
 * 比如 权重杀跌 需要指数成分股口径，当前没有数据源。
 */
const BOOL_CONDITIONS: Record<string, { factor: string; test: (r: FactorResult<any>) => boolean; why: string }> = {
  外围risk_off: {
    factor: "外围传导",
    test: r => r.label === "risk_off",
    why: "外围传导判为 risk_off",
  },
};

export interface EngineDeps {
  registry: FactorRegistry;
}

/* -------------------------------- 小工具 -------------------------------- */

const round2 = (x: number): number => Math.round(x * 100) / 100;
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const pct = (x: number): string => `${round2(x * 100)}%`;

const asNum = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * 每账户可交易的板块，来自 strategy.yaml 的 `持仓.<账户>.可交易板块`。
 * 账户名与权限都是用户的配置 —— 早期版本把 "主板→A 账户 / 创业板→B 账户" 写死在这里，
 * 那等于我替用户决定了他有几个账户、各自开了什么权限。
 */
export function accountBoards(config: StrategyConfig): Array<{ account: AccountId; boards: string[] }> {
  const held = (config as unknown as { 持仓?: Record<string, unknown> }).持仓;
  if (held === null || typeof held !== "object") return [];
  const out: Array<{ account: AccountId; boards: string[] }> = [];
  for (const key of Object.keys(held)) {
    const account = normalizeAccountKey(key);
    if (account.length === 0) continue;
    out.push({ account, boards: strArray(accountRule(config, account)["可交易板块"]) });
  }
  return out;
}

/**
 * 板块 → 账户。命中多个账户时取 YAML 里靠前的那个（顺序即优先级，用户可自行调整）。
 * 没有任何账户能交易这个板块就返回 null，该标的不进候选 —— 出一个买不进的信号更糟。
 */
export function accountForBoard(
  perms: Array<{ account: AccountId; boards: string[] }>, board: string
): AccountId | null {
  for (const { account, boards } of perms) if (boards.includes(board)) return account;
  return null;
}

/**
 * 板块名与主线名的匹配。
 *
 * 主线识别 返回的可能是板块榜里的板块名（"半导体"），也可能是必查链名（"半导体全链"），
 * 而 zt_pool.sector 是东财的板块措辞。链名→关键词的权威映射在因子层
 * （lib/factors 的 必查链关键词），引擎不 import 它，所以这里只做包含关系的双向匹配。
 * 代价是偶尔会多收一只同名板块的票，好过整条主线漏掉。
 */
export function matchesMainline(sector: string | null, mainlines: string[]): string | null {
  if (sector === null || sector.length === 0) return null;
  for (const m of mainlines) {
    if (m.length === 0) continue;
    if (sector === m || sector.includes(m) || m.includes(sector)) return m;
  }
  return null;
}

/**
 * 整张信号卡的评估日：asOf 当日或之前最近的交易日，**再回落到数据完整的那一天**。
 *
 * 回落这一步是必须的，而且必须在这里做一次、只做一次：
 * 当天日线要夜间全量拉取（22:00）才落库，涨停池要 15:05 收盘后才有。
 * 盘中拿「今天」去评估，横截面因子全体落空（盘面强度退回占位值 50，低于进攻阈值），
 * 候选池的来源涨停池也是 0 行 —— 于是**整个交易日档位卡在中性、候选恒为空**。
 * 实测：同一个库，asOf 落在昨天收盘后是「进攻 / 2 只候选」，落在今天任意时刻都是
 * 「中性 / 0 候选」，分水岭是 09:35 那轮采集把今天写进日历的一刻。
 *
 * 放在这里而不是每个因子各自回落：`date` 同时喂给因子参数、涨停池选池、缺口告警，
 * 分头回落迟早出现"档位算的是昨天、候选选的是今天"这种自相矛盾的卡片。
 *
 * 回放历史某天时它是恒等的（那天数据本来就完整），回测行为不变。
 */
export function resolveDate(view: PointInTimeView): string {
  const asOfDate = view.asOf.slice(0, 10);
  const from = new Date(`${asOfDate}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 30);
  const days = view.tradingDays(from.toISOString().slice(0, 10), asOfDate);
  const calendarDay = days.length === 0 ? asOfDate : days[days.length - 1];
  return completeDate(view, calendarDay);
}

/** 去重且保序的告警收集器。顺序确定 = 同份输入两次结果哈希一致 */
export function makeWarnings() {
  const seen = new Set<string>();
  const list: string[] = [];
  return {
    add(msg: string): void {
      if (seen.has(msg)) return;
      seen.add(msg);
      list.push(msg);
    },
    list,
  };
}

/* ------------------------------- 因子求值 ------------------------------- */

export interface FactorRunner {
  /** 拿不到读数时返回 null（未注册 / 求值抛错），并已记好告警。调用方必须判 null */
  run(name: string, extra?: Record<string, unknown>): FactorResult<any> | null;
  /**
   * 该因子是否已注册。只给"叠加项"用：持仓风险预警是在纪律线之上加的一层，
   * 注册表里没有风险因子（测试替身常见）时应当安静地不叠加，
   * 而不是每只持仓都报一条"因子未注册"把告警刷满。
   */
  has?(name: string): boolean;
}

export function makeRunner(
  registry: FactorRegistry, config: StrategyConfig, view: PointInTimeView,
  date: string, warn: (m: string) => void
): FactorRunner {
  const seenLowConf = new Set<string>();
  return {
    has: name => registry.get(name) !== undefined,
    run(name, extra = {}) {
      const spec = registry.get(name);
      if (spec === undefined) {
        warn(`因子未注册：${name} —— 相关判断按"未判定"处理，不当成通过`);
        return null;
      }
      const overrides = config.因子参数 === undefined ? {} : config.因子参数[name] ?? {};
      const params = { ...spec.defaults, ...overrides, 日期: date, ...extra };
      let r: FactorResult<any>;
      try {
        r = spec.fn({ view, params });
      } catch (e) {
        // 一个因子炸掉不该让整张卡出不来，但必须留痕
        warn(`因子求值失败：${name} —— ${(e as Error).message}`);
        return null;
      }
      // 个股因子会被多只票各求一次，低置信告警只报一次，否则卡上会刷满同一条
      if (r.confidence < LOW_CONFIDENCE && !seenLowConf.has(name)) {
        seenLowConf.add(name);
        const suffix = r.label === undefined ? "" : `（${r.label}）`;
        warn(`低置信因子：${name} confidence=${round6(r.confidence)}${suffix}`);
      }
      return r;
    },
  };
}

/* ------------------------------- 环境评估 ------------------------------- */

/**
 * 把因子读数收进一张按名字索引的表。env.factors 最终就是它排序后的产物，
 * 所以谁往里塞、塞的顺序如何，直接决定卡片上那串因子。
 */
export type FactsMap = Map<string, FactorResult<any>>;

function needInto(
  facts: FactsMap, runner: FactorRunner, name: string, extra?: Record<string, unknown>
): FactorResult<any> | null {
  const r = runner.run(name, extra);
  if (r !== null) facts.set(name, r);
  return r;
}

/** 环境档位要用的那批因子。单独抽出来是为了让 v2 的择时器槽能复用同一套读数 */
export function collectEnvFacts(runner: FactorRunner): FactsMap {
  const facts: FactsMap = new Map();
  for (const name of ENV_FACTOR_NAMES) needInto(facts, runner, name);
  return facts;
}

/**
 * 主线识别。从 assessEnv 里切出来，因为 v2 把「择时」与「主线识别」拆成了两个槽 ——
 * 想换一种识别主线的算法，不该被迫连档位判定一起换掉。
 *
 * facts 是传进来的：识别过程中求值的 主线识别 / 龙头温度计 要落进同一张表，
 * 否则它们就不会出现在 env.factors 上，卡片上会少两条归因。
 */
export function detectMainlines(
  config: StrategyConfig, runner: FactorRunner, warn: (m: string) => void, facts: FactsMap
): string[] {
  const need = (name: string, extra?: Record<string, unknown>) =>
    needInto(facts, runner, name, extra);

  const 主线 = need("主线识别", {
    板块涨幅榜TopN: config.选股.主线识别.板块涨幅榜TopN,
    必查链: config.选股.主线识别.必查链,
  });
  /**
   * 主线名单。
   *
   * 除了链名/板块名本身，还要把因子给出的**真实板块名**并进来：
   * 必查链的名字是"半导体全链"，而板块榜与涨停池里的名字是"半导体材料 / 半导体设备"，
   * 子串互含一个都匹配不上 —— 于是"按主线选票"对必查链型主线整个失效，
   * 表现只是候选少了几只，不报错也不告警。链→板块的对应只有因子层知道，
   * 所以它通过 inputs.明细[].sectors 交出来（见 lib/factors/sectors.ts）。
   */
  const mainlineNames = 主线 === null ? [] : strArray(主线.value);
  const 明细 = Array.isArray(主线?.inputs?.["明细"]) ? 主线!.inputs!["明细"] as unknown[] : [];
  const realSectors = 明细.flatMap(m =>
    m !== null && typeof m === "object" ? strArray((m as { sectors?: unknown }).sectors) : []);
  const mainlines = [...new Set([...mainlineNames, ...realSectors])];
  if (mainlines.length === 0) {
    warn("未识别到主线板块 —— 候选池只会剩下必查链兜底能捞到的票，注意是不是板块榜快照缺了");
  }
  if (mainlines.length > 0) need("龙头温度计", { 板块: mainlines[0] });
  return mainlines;
}

/**
 * 档位判定。输入是**已经算好的**环境因子读数与主线名单，
 * 所以换一个主线识别算法不会连带影响这里，反过来也一样。
 */
export function assessGear(
  config: StrategyConfig, runner: FactorRunner, warn: (m: string) => void,
  /** 日历认定的当前交易日。横截面因子实际评估的日期可能比它早，见下方说明 */
  calendarDate: string, facts: FactsMap, mainlines: string[]
): EnvAssessment {
  const need = (name: string, extra?: Record<string, unknown>) =>
    needInto(facts, runner, name, extra);

  /* 防守触发 */
  const fired: string[] = [];
  for (const [key, raw] of Object.entries(config.择时.防守触发)) {
    const cmp = /^(.*?)([><])$/.exec(key);
    if (cmp !== null) {
      const fname = cmp[1];
      const threshold = asNum(raw);
      const r = facts.get(fname) ?? need(fname);
      if (threshold === null) {
        warn(`防守触发.${key} 未判定：阈值不是数字（${JSON.stringify(raw)}）`);
        continue;
      }
      if (r === null) {
        warn(`防守触发.${key} 未判定：因子 ${fname} 拿不到读数，未参与档位判断`);
        continue;
      }
      const v = asNum(r.value);
      if (v === null || r.confidence === 0) {
        // 没数据 ≠ 条件成立。把缺数据当触发会让系统永久防守，
        // 当成不触发则会在真跌停潮里满仓 —— 所以两边都不选，明确报"未判定"。
        warn(`防守触发.${key} 未判定：因子 ${fname} 无有效读数（${r.label ?? "无标签"}），未参与档位判断`);
        continue;
      }
      const hit = cmp[2] === ">" ? v > threshold : v < threshold;
      if (hit) fired.push(`${fname} ${v} ${cmp[2]} ${threshold}（防守触发）`);
      continue;
    }

    if (typeof raw === "boolean") {
      if (!raw) continue;                       // 开关关掉，不评估
      const cond = BOOL_CONDITIONS[key];
      if (cond === undefined) {
        warn(`防守触发.${key} 未判定：没有对应因子，未参与档位判断 —— 不等于该条件不成立`);
        continue;
      }
      const r = facts.get(cond.factor) ?? need(cond.factor);
      if (r === null || r.confidence === 0) {
        warn(`防守触发.${key} 未判定：因子 ${cond.factor} 无有效读数（${r?.label ?? "拿不到"}），未参与档位判断`);
        continue;
      }
      if (cond.test(r)) fired.push(`${cond.why}（防守触发 ${key}）`);
      continue;
    }

    warn(`防守触发.${key} 未判定：值 ${JSON.stringify(raw)} 无法解释成阈值或开关`);
  }

  /* 档位 */
  const 档位 = config.择时.仓位档位;
  const 强度 = facts.get("盘面强度");
  /**
   * 横截面因子实际评估的是哪一天，必须写在卡片上。
   *
   * 当天日线要 22:00 才落库，所以盘中这些因子评估的是**昨天**（见 factors/util 的
   * completeDate）。这是对的 —— 拿一个没有数据的今天去算，全市场都会落进 unknown，
   * 档位会永远停在中性。但如果不说，人看到的就是一个像"今天的判断"的昨天判断，
   * 而那两件事在盘中差别很大。
   */
  {
    const evalOn = (强度?.inputs as { 日期?: unknown } | undefined)?.日期;
    if (typeof evalOn === "string" && evalOn.length > 0 && evalOn !== calendarDate) {
      warn(
        `环境因子评估日 ${evalOn}，不是 ${calendarDate} —— 当日日线要夜间全量拉取后才有，` +
        `盘中横截面读的是上一个完整交易日。个股价距（现价 vs 触发价）仍用实时快照。`
      );
    }
  }
  const 强度值 = 强度 === undefined ? null : asNum(强度.value);
  const 外围 = facts.get("外围传导");
  const reasons: string[] = [];
  let gear: EnvGear;

  if (fired.length > 0) {
    gear = "防守";
    reasons.push(...fired);
    reasons.push("防守档 = 0 仓：不留过冬仓位，也不开新仓");
  } else if (强度值 === null) {
    // 拿不到盘面强度就不敢开进攻档。宁可少赚，不要在看不见盘面时加仓。
    gear = "中性";
    reasons.push("盘面强度不可用，档位保守取中性");
  } else if (强度值 >= ATTACK_STRENGTH && mainlines.length > 0 && 外围?.label !== "risk_off") {
    gear = "进攻";
    reasons.push(`盘面强度 ${round6(强度值)} ≥ ${ATTACK_STRENGTH}`);
    reasons.push(`主线明确：${mainlines.join(" / ")}`);
  } else {
    gear = "中性";
    if (强度值 < ATTACK_STRENGTH) reasons.push(`盘面强度 ${round6(强度值)} < ${ATTACK_STRENGTH}`);
    if (mainlines.length === 0) reasons.push("没有识别到主线");
    if (外围?.label === "risk_off") reasons.push("外围 risk_off，不开进攻档");
  }

  const 上限 = config.组合风控.总仓位上限;
  const 档位仓位 = asNum(档位[gear]) ?? 0;
  const targetPosition = gear === "防守" ? 0 : round6(Math.min(档位仓位, 上限));
  if (gear !== "防守" && 档位仓位 > 上限) {
    reasons.push(`档位仓位 ${档位仓位} 被总仓位上限 ${上限} 压到 ${targetPosition}`);
  }

  const lowConfidenceFactors = [...facts.values()]
    .filter(f => f.confidence < LOW_CONFIDENCE)
    .map(f => f.name)
    .sort();

  return {
    gear, targetPosition, reasons,
    factors: [...facts.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    lowConfidenceFactors,
  };
}

/**
 * v1 的环境评估：环境因子 → 主线 → 档位，顺序与拆分前逐字一致。
 *
 * 求值顺序必须保持，因为 warn 是按发生顺序累积的，而 warnings 的顺序
 * 参与结果哈希（同份输入两次跑出来要字节相同）。
 */
function assessEnv(
  config: StrategyConfig, runner: FactorRunner, warn: (m: string) => void,
  calendarDate: string
): { env: EnvAssessment; mainlines: string[] } {
  const facts = collectEnvFacts(runner);
  const mainlines = detectMainlines(config, runner, warn, facts);
  return { env: assessGear(config, runner, warn, calendarDate, facts, mainlines), mainlines };
}

/* -------------------------------- 候选池 -------------------------------- */

export interface RawCandidate {
  code: string;
  name: string;
  account: AccountType;
  sector: string;
  mainline: string;
  triggerPx: number;
  stopPx: number | null;
  thesis: string;
  passedFilters: string[];
  factors: FactorResult<any>[];
  score: number;
  /** 带定价的评估器才给（v2）。v1 永远不带，见 Candidate.targetPx */
  targetPx?: number | null;
  rrRatio?: number | null;
}

/** 进池的理由。写进 thesis，也让人在卡片上看得出这只票是怎么被捞出来的 */
type PoolSource = "涨停池" | "主线领涨" | "量价";

/**
 * 候选池的一行。直接用契约里的定义，不再本地复制一份 ——
 * v2 的候选源槽产出的也是它，两边各定义一份必然分岔。
 *
 * 注意 source 是开放的 string 而不是窄联合：新槽会带来新的来源名，
 * 窄联合会让"加一个候选源"变成要改契约类型的事。
 */
export type { PoolRow };

const 量价默认 = { 均量窗口: 5, 放量倍数: 1.5, 新高窗口: 20, 多头排列: true };

/**
 * 买点默认值。
 *
 * 昨收 -1%、不压 MA5。这是**为了让台账能攒出样本**而选的临时值，不是最优参数。
 *
 * 原先写死 min(昨收, MA5)（"不追高，等回踩到位"）。方向没错，但和候选池的
 * 人口结构对不上：候选主要来自昨日涨停池，刚涨停的票 MA5 必然远在收盘价之下，
 * 次日通常还要高开，买点从生成的那一刻起就在市价下方 5~10%。
 * 实测 4 年回测（964 个交易日）21 条买入决策**成交 0 笔**，触发率 0% ——
 * 于是台账永远是空的，胜率、盈亏比全都无从谈起。
 *
 * 放宽挂单有效期也救不回来（实测同一批推荐：3 天 6%、5 天 6%、10 天 25%，
 * 而等到第 7~12 天才回踩，当初"昨日涨停 + 主线"的理由早就不在了）。
 *
 * -1% 这个数只有 21 条样本支撑（触发率 48%、盈亏比 2.28），
 * 远低于 review.ts 的 MIN_SAMPLE=30，**是噪声，不是结论**。
 * 它的作用是让推荐开始真的成交、开始产生可复盘的样本；
 * 等台账攒够之后按 lib/ledger/review 的三关数据回来重定。
 */
const 买点默认 = { 相对昨收: -0.01, 不高于MA5: false };

/**
 * 放量突破 + 均线多头排列。
 *
 * 两条同时满足才算数：放量抓的是"资金刚进来"，多头排列排掉"放量但趋势已坏"的出货。
 * 只看放量会捞到一批高位放量滞涨，只看多头排列会捞到一批缩量上行的慢牛
 * —— 后者不是坏事，但那是另一种策略，不该混在同一个信号里不做区分。
 *
 * 用原始收盘价而非复权价：与触发价同源。窗口只有几十天，除权概率低，
 * 混用的误差远小于"复权因子本身缺失"（spec R1）带来的误差。
 */
export function passesVolumePrice(
  view: PointInTimeView, code: string, date: string,
  p: { 均量窗口: number; 放量倍数: number; 新高窗口: number; 多头排列: boolean }
): boolean {
  const need = Math.max(p.均量窗口, p.新高窗口, 20) + 1;
  const bars = view.dailyBars(code, need);
  if (bars.length < Math.max(p.均量窗口 + 1, 20)) return false;
  const last = bars[bars.length - 1];
  // 评估日当天必须有这根 bar，否则比的是别的日子
  if (last.date !== date) return false;

  const volWin = bars.slice(-1 - p.均量窗口, -1);
  if (volWin.length < p.均量窗口) return false;
  const avgVol = volWin.reduce((a, b) => a + b.vol, 0) / volWin.length;
  if (!(avgVol > 0) || !(last.vol >= avgVol * p.放量倍数)) return false;

  const highWin = bars.slice(-p.新高窗口);
  const maxClose = Math.max(...highWin.slice(0, -1).map(b => b.c));
  if (!(last.c >= maxClose)) return false;

  if (p.多头排列) {
    const ma = (n: number) => {
      const w = bars.slice(-n);
      return w.length < n ? null : w.reduce((a, b) => a + b.c, 0) / n;
    };
    const [m5, m10, m20] = [ma(5), ma(10), ma(20)];
    if (m5 === null || m10 === null || m20 === null) return false;
    if (!(m5 > m10 && m10 > m20 && last.c > m5)) return false;
  }
  return true;
}

/**
 * 候选池：三路来源汇成一个列表，后面的主线筛 / 七道筛 / 回踩触发价对三路一视同仁。
 *
 * 为什么要多路：只从涨停池选，等于"入场手法是回踩低吸，标的池的人口结构却是打板股"
 * —— 主线里没涨停但形态好的票永远进不来。
 *
 * 三路都保留 sector，因为"不在主线上的不追"这条纪律对三路一律有效。
 * 量价那一路**先按行业过滤再拉日线**：先筛主线成分（一次哈希查找）再取 bar，
 * 全市场 5,888 只降到几百只。反过来写的话，光这一路就要给回测每天加约 0.3 秒，
 * 相对现在 0.38 秒/交易日 是近乎翻倍。
 */
export function candidatePool(
  input: StrategyEngineInput, mainlines: string[], date: string, warn: (m: string) => void
): PoolRow[] {
  const { view, config } = input;
  const 开关 = config.选股.候选来源 ?? {};
  const on = (k: "涨停池" | "主线领涨" | "量价"): boolean => 开关[k] !== false;
  const seen = new Set<string>();
  const out: PoolRow[] = [];
  const push = (r: PoolRow): void => {
    if (seen.has(r.code)) return;   // 多路命中同一只票时，先到的来源胜出（顺序即优先级）
    seen.add(r.code);
    out.push(r);
  };

  // 那天没有真涨停池 / 板块榜时退回日线重建的代理截面（申万行业口径），并在卡片上说出来
  const cr = crossRowsFor(view, date);
  if (cr.ztProxy || cr.sectorProxy) {
    warn(`候选池：${date} 没有真${cr.ztProxy ? "涨停池与" : ""}板块榜，` +
      `用日线重建的代理截面（申万三级行业口径${cr.ztProxy ? "，无封单额" : "，涨停池仍是真快照"}）`);
  }

  if (on("涨停池")) {
    for (const r of cr.zt) {
      // 代理行的封单额是 NaN（不知道），进池子按 0 排 —— 排序与打分都不能吃 NaN
      push({ code: r.code, sector: r.sector, lbc: r.lbc ?? 0, sealAmt: Number.isFinite(r.sealAmt) ? r.sealAmt : 0, source: "涨停池" });
    }
  }

  if (on("主线领涨")) {
    // 同一天板块榜有多个时点，取每个板块最后一个时点的领涨股
    const latest = new Map<string, { ts: string; leaderCode: string | null }>();
    for (const r of cr.sectors) {
      const prev = latest.get(r.sector);
      if (prev === undefined || r.ts >= prev.ts) latest.set(r.sector, { ts: r.ts, leaderCode: r.leaderCode });
    }
    for (const [sector, v] of latest) {
      if (v.leaderCode === null) continue;
      if (matchesMainline(sector, mainlines) === null) continue;
      push({ code: v.leaderCode, sector, lbc: 0, sealAmt: 0, source: "主线领涨" });
    }
  }

  if (on("量价")) {
    /**
     * 代理日的主线名是申万三级行业名，行业映射也必须换成同一套名字，否则一只都匹配不上。
     * 申万归属有历史区间，按视图那天取，没有前视 —— 所以回放里这一路也能开起来。
     */
    const sectorOf = cr.swNames ? swSectorOf(view) : input.sectorOf;
    if (sectorOf === undefined) {
      warn("候选来源.量价 未启用：没有 代码→行业 映射，无法判断标的是否在主线上 —— 查不到行业不等于不在主线上");
    } else {
      const p = { ...量价默认, ...(config.选股.量价条件 ?? {}) };
      // 映射是"当前"的行业归属，没有历史版本：回放早于采集时间的日期时带一点前视（代理日用申万历史归属，没有这个问题）
      if (!cr.swNames && input.sectorMapAt !== undefined && input.sectorMapAt.slice(0, 10) > date) {
        warn(
          `候选来源.量价：代码→行业 映射采于 ${input.sectorMapAt.slice(0, 10)}，晚于评估日 ${date}` +
          ` —— 行业归属没有历史版本，这一路在回放上存在轻微前视`
        );
      }
      let scanned = 0;
      for (const sec of view.universe()) {
        const sector = sectorOf(sec.code);
        if (sector === null) continue;                       // 查不到行业：不猜
        if (matchesMainline(sector, mainlines) === null) continue;
        scanned++;
        if (passesVolumePrice(view, sec.code, date, p)) {
          push({ code: sec.code, sector, lbc: 0, sealAmt: 0, source: "量价" });
        }
      }
      if (scanned === 0 && mainlines.length > 0) {
        warn("候选来源.量价：主线板块下一只成分股都没查到 —— 多半是 代码→行业 映射还没采全");
      }
    }
  }

  // 排序先定死：连板高 → 封单大 → 代码。名次会影响风控分配，抖动就是结果不可复现。
  // 非涨停来源的 lbc/sealAmt 是 0，自然排在涨停股之后 —— 这是有意的优先级。
  return out.sort((a, b) =>
    b.lbc - a.lbc || b.sealAmt - a.sealAmt || (a.code < b.code ? -1 : 1));
}

function buildCandidates(
  input: StrategyEngineInput, runner: FactorRunner, mainlines: string[],
  heldCodes: Set<string>, date: string, warn: (m: string) => void
): RawCandidate[] {
  const { view, config } = input;
  const 阈值 = config.选股.过滤器阈值;
  // 账户与其板块权限全部来自 YAML，顺序即优先级
  const perms = accountBoards(config);
  const out: RawCandidate[] = [];

  const pool = candidatePool(input, mainlines, date, warn);

  for (const row of pool) {
    if (heldCodes.has(row.code)) continue;              // 已持仓的走 holdings，不重复开仓
    const mainline = matchesMainline(row.sector, mainlines);
    if (mainline === null) continue;                    // 不在主线上的不追

    const c = evaluateRow(input, runner, row, mainline, perms, 阈值, warn);
    if (c !== null) out.push(c);
  }

  return out.sort((a, b) => b.score - a.score || (a.code < b.code ? -1 : 1));
}

/**
 * 一行候选 → 过筛、定价、讲逻辑、打分。返回 null = 被否决（原因已写进 warnings）。
 *
 * 从 buildCandidates 的循环体里原样切出来，因为 v2 把「评估」做成了可替换的槽：
 * 想换一种定价或打分方式，不该被迫连候选源一起换掉。
 */
export function evaluateRow(
  input: StrategyEngineInput, runner: FactorRunner, row: PoolRow, mainline: string,
  perms: Array<{ account: AccountId; boards: string[] }>,
  阈值: Record<string, number>, warn: (m: string) => void
): RawCandidate | null {
  const { view, config } = input;
  {
    const sec = view.security(row.code);
    if (sec === null) {
      warn(`标的元数据缺失：${row.code} 查不到板与上市信息，跳过（不猜板别就不会猜错涨跌幅限制）`);
      return null;
    }
    const account = accountForBoard(perms, sec.board);
    // 没有账户开通该板块权限：不出信号（出了也买不进）
    if (account === null) return null;

    const filt = runner.run("过滤器", { ...阈值, code: row.code, 账户: account });
    if (filt === null) return null;
    const rejected = strArray(filt.inputs?.["否决"]);
    const unevaluated = strArray(filt.inputs?.["未判定"]);
    if (unevaluated.length > 0) {
      warn(`过滤器未判定：${unevaluated.join(" / ")}（缺数据）—— 未判定不等于通过`);
    }
    if (rejected.length > 0) {
      warn(`${row.code} 被过滤器否决：${rejected.join(" / ")}，不进候选池`);
      return null;
    }

    const bars = view.dailyBars(row.code, 20);
    if (bars.length === 0) {
      warn(`${row.code} 没有日线，定不出触发价，跳过`);
      return null;
    }
    // 用原始收盘价而不是复权价：触发价是要挂进券商的真实价格。
    // 5 日窗口内除权概率极低，MA5 与收盘价混用的误差可以忽略。
    const closes = bars.map(b => b.c);
    const lastClose = closes[closes.length - 1];
    const win = closes.slice(Math.max(0, closes.length - 5));
    const ma5 = win.reduce((a, b) => a + b, 0) / win.length;
    // 买点从配置来，不写死 —— 它直接决定推荐能不能成交，是要按台账数据反复调的那类参数。
    // 默认值与"为什么不再压 MA5"见 买点默认。
    const bp = { ...买点默认, ...(config.选股.买点 ?? {}) };
    const base = lastClose * (1 + bp.相对昨收);
    const triggerPx = round2(bp.不高于MA5 ? Math.min(base, ma5) : base);
    if (!(triggerPx > 0)) {
      warn(`${row.code} 算不出正的触发价，跳过`);
      return null;
    }

    const 止损 = asNum(accountRule(config, account)["止损"]);
    const stopPx = 止损 === null ? null : round2(triggerPx * (1 + 止损));

    /* thesis：讲不出逻辑的不进池 */
    const stockFacts: FactorResult<any>[] = [filt];
    const parts: string[] = [`主线${mainline}`];
    // 进池的理由写进 thesis：三路来源的票在卡片上长得一样，
    // 不写清楚就没法判断"这只是昨天涨停的"还是"这只是量价选出来的"
    if (row.source !== "涨停池") parts.push(`来源${row.source}`);
    if (row.lbc > 1) parts.push(`${row.lbc} 连板`);
    const 温度 = runner.run("龙头温度计", { 板块: mainline });
    if (温度 !== null && 温度.confidence > 0 && 温度.label !== undefined) {
      parts.push(`龙头${温度.label}`);
      stockFacts.push(温度);
    }
    for (const name of STOCK_FACTOR_NAMES) {
      const r = runner.run(name, { code: row.code });
      if (r === null) return null;
      stockFacts.push(r);
      // confidence 0 的因子只是"没数据"，不能当成论据
      if (r.confidence > 0 && r.label !== undefined && r.label.length > 0 && asNum(r.value) !== null) {
        parts.push(`${name}${r.label}`);
      }
    }
    // 只有"主线xx"一句不算逻辑：那是板块判断，不是买这只票的理由
    if (parts.length <= 1) {
      warn(`${row.code} 讲不出买入逻辑（因子读数不足），不进候选池`);
      return null;
    }

    const dir = asNum(stockFacts.find(f => f.name === "均线方向")?.value) ?? 0;
    const vol = asNum(stockFacts.find(f => f.name === "量能")?.value) ?? 1;
    const netAmt = asNum(stockFacts.find(f => f.name === "龙虎榜净买")?.value) ?? 0;
    const score = round6(
      0.30 * clamp01(row.lbc / 5) +
      0.20 * clamp01(row.sealAmt / 3e8) +
      0.20 * (dir > 0 ? 1 : 0) +
      0.15 * clamp01(vol / 2) +
      0.15 * (netAmt > 0 ? 1 : 0)
    );

    return {
      code: row.code, name: sec.name, account,
      sector: row.sector ?? mainline, mainline,
      triggerPx, stopPx,
      thesis: parts.join("；"),
      passedFilters: strArray(filt.inputs?.["通过"]),
      factors: stockFacts,
      score,
    };
  }
}

/* ------------------------------- 组合风控 ------------------------------- */

/**
 * 上限分配。
 *
 * 被挤掉的票降级为"观察"而不是删掉：它通过了筛子、也有逻辑，只是这一轮没额度。
 * 留在卡上人能看见"想买但满了"，删掉就变成静默丢弃。
 */
export function applyPortfolioCaps(
  cands: RawCandidate[], config: StrategyConfig, targetPosition: number
): Candidate[] {
  const 风控 = config.组合风控;
  const 比例 = 风控.核心卫星比例;
  /**
   * 每账户占核心/卫星哪个桶，来自 `持仓.<账户>.仓位桶`（值为 核心 或 卫星）。
   * 早期版本把"哪个账户吃哪个桶"写死在代码里，改个账户名预算就变 0 且不报错。
   * 没配 仓位桶 的账户预算为 0，但会在卡片 warnings 里点名，不静默吞掉。
   */
  const bucketShare: Record<string, number> = {};
  const missingBucket: string[] = [];
  for (const { account } of accountBoards(config)) {
    const bucket = accountRule(config, account)["仓位桶"];
    if (bucket === "卫星") bucketShare[account] = asNum(比例.卫星) ?? 0;
    else if (bucket === "核心") bucketShare[account] = asNum(比例.核心) ?? 0;
    else { bucketShare[account] = 0; missingBucket.push(account); }
  }

  const usedTotal = { v: 0 };
  const usedAccount: Record<string, number> = {};
  for (const a of Object.keys(bucketShare)) usedAccount[a] = 0;
  const usedSector = new Map<string, number>();

  const out: Candidate[] = [];
  for (const c of cands) {
    const accountBudget = round6(targetPosition * (bucketShare[c.account] ?? 0));
    const sectorUsed = usedSector.get(c.sector) ?? 0;
    const limits: Array<{ room: number; label: string }> = [
      { room: 风控.单票最大占比, label: `单票最大占比 ${风控.单票最大占比}` },
      { room: targetPosition - usedTotal.v, label: `总仓位预算 ${round6(targetPosition)} 已用满` },
      { room: accountBudget - (usedAccount[c.account] ?? 0), label: `${c.account}账户占比上限 ${accountBudget}（核心卫星比例）已用满` },
      { room: 风控.单行业最大占比 - sectorUsed, label: `单行业最大占比 ${风控.单行业最大占比}（${c.sector}）已用满` },
    ];
    const binding = limits.reduce((m, x) => (x.room < m.room ? x : m), limits[0]);
    const size = round6(Math.max(0, binding.room));

    const base = {
      code: c.code, name: c.name, account: c.account,
      triggerPx: c.triggerPx, stopPx: c.stopPx,
      thesis: c.thesis, passedFilters: c.passedFilters,
      factors: c.factors, score: c.score,
      // 只在有目标位时才带上这两个键：baseline 的 targetPx 是 null，带上 null 就改了对照组的卡片形状
      ...(typeof c.targetPx === "number" ? { targetPx: c.targetPx, rrRatio: c.rrRatio ?? null } : {}),
    };

    if (size <= 1e-9) {
      out.push({ ...base, action: "观察" as Action, size: 0, rejectedBy: [`组合风控：${binding.label}`] });
      continue;
    }
    usedTotal.v = round6(usedTotal.v + size);
    usedAccount[c.account] = round6((usedAccount[c.account] ?? 0) + size);
    usedSector.set(c.sector, round6(sectorUsed + size));
    out.push({ ...base, action: "买入" as Action, size });
  }
  return out;
}

/* -------------------------------- 持仓动作 -------------------------------- */

function buildHoldings(
  input: StrategyEngineInput, gear: EnvGear, date: string, warn: (m: string) => void,
  runner?: FactorRunner
): Candidate[] {
  const sorted = [...input.positions].sort((a, b) =>
    (a.account < b.account ? -1 : a.account > b.account ? 1 : 0) || (a.code < b.code ? -1 : 1));
  return sorted.map(p => decideHolding(input, p, gear, warn, runner));
}

/**
 * 单笔持仓的动作判定。从 buildHoldings 的循环体里原样切出来 ——
 * v2 把「离场」做成可替换的槽：不同账户的离场纪律本来就可以完全不同
 * （吃波动的按价格机械止损、扛逻辑的按逻辑破坏），换其中一套不该牵动另一套。
 *
 * 判定顺序即优先级，不可重排：
 * 无价格 → 防守清仓 → 灾难位 → 破止损 → 止盈 → 非价格止损复核 → 持有。
 */
/**
 * 持仓动作 = 纪律判定 + 风险叠加。
 *
 * 叠加而不是插进纪律判定里：那段判定的**顺序即优先级**，是一次次复盘排出来的，
 * 把风险检查塞进中间就得重新论证每一处先后。放在出口处叠加，
 * 纪律线一条都不动，风险只能"加重"动作、永远不能"减轻"它。
 *
 *   - ST 戴帽 → 清仓。结构性风险（涨跌幅 5%、有退市风险），与浮盈浮亏无关
 *   - 解禁/减持严重、严重超买 → 原本"持有"的改"观察"；其余动作只附注原因
 *   - 预警级不改动作：只有越线才动，否则每只持仓天天都在"观察"，信号就失效了
 */
export function decideHolding(
  input: StrategyEngineInput,
  p: { account: AccountId; code: string; cost: number; qty: number; stopPx: number | null },
  gear: EnvGear, warn: (m: string) => void, runner?: FactorRunner
): Candidate {
  const base = decideHoldingCore(input, p, gear, warn);
  if (runner === undefined) return base;

  const read = (name: string) =>
    runner.has !== undefined && !runner.has(name) ? null : runner.run(name, { code: p.code });

  const st = read("ST状态");
  const isSt = st !== null && st.confidence > 0 && st.value === 1;

  const severe: string[] = [];
  const lift = read("解禁压力");
  if (lift !== null && lift.label === "严重") {
    severe.push(`未来 90 天解禁 ${pct(asNum(lift.value) ?? 0)} 流通股（最近 ${lift.inputs?.["最近解禁日"] ?? "—"}）`);
  }
  const plan = read("减持计划");
  if (plan !== null && plan.confidence > 0 && plan.label === "严重") {
    severe.push(`股东减持计划上限 ${pct(asNum(plan.value) ?? 0)} 总股本`);
  }
  const ob = read("超买超卖");
  if (ob !== null && ob.confidence > 0 && ob.label === "严重超买") {
    severe.push("严重超买，可考虑兑现一部分");
  }

  if (isSt) {
    const why = `处于风险警示期（ST：涨跌幅 5%、有退市风险）`;
    if (base.action === "清仓") return { ...base, thesis: `${base.thesis}；另：${why}` };
    return { ...base, action: "清仓", size: 0, thesis: `${why}，与盈亏无关，走；原判定：${base.thesis}` };
  }
  if (severe.length === 0) return base;

  const note = `风险：${severe.join("；")}`;
  if (base.action === "持有") {
    return { ...base, action: "观察", thesis: `${base.thesis}；${note}` };
  }
  return { ...base, thesis: `${base.thesis}；${note}` };
}

/** 纪律判定本体。顺序即优先级，不可重排 —— 风险叠加见 decideHolding */
function decideHoldingCore(
  input: StrategyEngineInput,
  p: { account: AccountId; code: string; cost: number; qty: number; stopPx: number | null },
  gear: EnvGear, warn: (m: string) => void
): Candidate {
  const { view, config, phase } = input;
  {
    const rule = accountRule(config, p.account);
    const 止损 = asNum(rule["止损"]);
    const 灾难位 = asNum(rule["灾难位"]);
    const 止损确认 = typeof rule["止损确认"] === "string" ? rule["止损确认"] as string : "";
    const tp = takeProfitRules(config, p.account);
    for (const raw of unparsedTakeProfit(config, p.account)) {
      warn(`止盈规则看不懂，未生效：${p.account}账户 "${raw}" —— 按"减半/清"这类写法改，或手工执行`);
    }

    const sec = view.security(p.code);
    const q = view.quote(p.code);
    const bars = view.dailyBars(p.code, 1);
    const px = q !== null ? q.price : bars.length > 0 ? bars[bars.length - 1].c : null;
    const stopPx = p.stopPx !== null ? p.stopPx : 止损 === null ? null : round2(p.cost * (1 + 止损));

    const base = {
      code: p.code, name: sec?.name ?? p.code, account: p.account,
      triggerPx: null as number | null, stopPx,
      passedFilters: [] as string[], factors: [] as FactorResult<any>[], score: 0,
    };

    if (px === null) {
      warn(`持仓 ${p.code} 拿不到价格（停牌或当日未采集），动作无法判定`);
      return { ...base, action: "观察", size: 1, thesis: "无价格数据（停牌或未采集），本轮不判定，人工确认" };
    }

    const pnl = p.cost === 0 ? 0 : px / p.cost - 1;

    if (gear === "防守") {
      return {
        ...base, action: "清仓", size: 0,
        thesis: `防守档目标仓位 0，清空持仓（现价 ${px}，浮动 ${pct(pnl)}）`,
      };
    }

    if (灾难位 !== null && pnl <= 灾难位) {
      // 灾难位存在的唯一理由就是越过"收盘确认"：跌到这儿再等收盘已经不是纪律问题了
      return {
        ...base, action: "清仓", size: 0,
        thesis: `跌破灾难位 ${pct(灾难位)}（当前 ${pct(pnl)}），不等收盘确认，直接走`,
      };
    }

    const brokeStop = (stopPx !== null && px <= stopPx) || (止损 !== null && pnl <= 止损);
    if (brokeStop) {
      if (止损确认 === "收盘" && phase === "盘中") {
        // 政策底/外围硬驱动的反弹日，盘中单次冲高回落多数是洗盘不是见光死（2026-07-21 实盘验证）
        return {
          ...base, action: "观察", size: 1,
          thesis: `已破止损${stopPx === null ? "" : ` ${stopPx}`}（现价 ${px}，浮动 ${pct(pnl)}），按"止损确认=收盘"等收盘再决定`,
        };
      } else {
        return {
          ...base, action: "清仓", size: 0,
          thesis: `破止损${stopPx === null ? "" : ` ${stopPx}`}（现价 ${px}，浮动 ${pct(pnl)}），按纪律出`,
        };
      }
    }

    // 止盈从高到低找第一个命中的档
    const hit = [...tp].reverse().find(r => pnl >= r.pnl);
    if (hit !== undefined) {
      return {
        ...base,
        action: hit.action,
        // 持仓动作的 size 是**对该笔持仓的操作比例**（0=清空，0.5=减半，1=不动），
        // 与新开仓 Candidate.size（占总资产比例）语义不同 —— 契约里没区分，见最终报告
        size: hit.action === "清仓" ? 0 : 0.5,
        thesis: `浮盈 ${pct(pnl)} 触发止盈档 ${hit.raw}（现价 ${px}）`,
      };
    }

    if (止损 === null && pnl < 0) {
      const 止损说明 = typeof rule["止损"] === "string" ? rule["止损"] as string : "未配置";
      return {
        ...base, action: "观察", size: 1,
        thesis: `浮亏 ${pct(pnl)}，该账户止损条件是"${止损说明}"（非价格），需人工复核逻辑是否已破`,
      };
    }

    return {
      ...base, action: "持有", size: 1,
      thesis: `未触发任何纪律线（现价 ${px}，浮动 ${pct(pnl)}）`,
    };
  }
}

/* --------------------------------- 引擎 --------------------------------- */

export function createStrategyEngine(deps: EngineDeps): StrategyEngine {
  return (input: StrategyEngineInput): SignalCard => {
    const { view, config, phase } = input;
    const w = makeWarnings();
    const warn = (m: string): void => { w.add(m); };
    const date = resolveDate(view);

    // 数据缺口必须上卡（spec §10.5）：缺口日的判断可信度天然打折
    for (const kind of KNOWN_GAP_KINDS) {
      if (view.hasGap(date, kind)) {
        warn(`数据缺口未修复：${kind}@${date} —— 当日判断可信度下降`);
      }
    }
    if (view.hasGap(date)) {
      warn(`${date} 存在未修复的数据缺口，回测须计入覆盖率`);
    }

    const runner = makeRunner(deps.registry, config, view, date, warn);
    // 拿 asOf 的日期部分做对照：date 已经回落过，用它自己比自己永远相等
    const { env, mainlines } = assessEnv(config, runner, warn, view.asOf.slice(0, 10));

    const heldCodes = new Set(input.positions.map(p => p.code));
    if (input.positions.length > 0) {
      /**
       * 引擎不知道账户有多少钱，这是**设计决定，不是待办**。
       *
       * StrategyEngineInput 里刻意没有总资产/现金字段，也不打算加：
       * 引擎只出比例，把比例换算成多少钱由人来做。这条边界同时兜住了
       * 「系统不会自动下单」那条红线 —— 一个算不出下单金额的引擎，
       * 没法被顺手接到自动交易上。
       *
       * 代价就是这条警告：算不出现有持仓占了多少仓位，所以新开仓预算是
       * 按目标仓位全额给的，没扣已有持仓。人必须自己核对。
       * 假装能算出来才是真危险 —— 那会在已经满仓时继续发买入信号。
       *
       * 所以别"修"它：把权益接进来等于同时拆掉上面那道边界。
       */
      warn(
        `组合风控：引擎按设计不接账户资金（只出比例，换算成金额由人做），` +
        `新开仓预算按目标仓位 ${env.targetPosition} 全额计算，未扣除现有 ${input.positions.length} 笔持仓的占比，请人工核对`
      );
    }

    const candidates = env.gear === "防守"
      ? []
      : applyPortfolioCaps(
          buildCandidates(input, runner, mainlines, heldCodes, date, warn),
          config, env.targetPosition);

    const holdings = buildHoldings(input, env.gear, date, warn, runner);

    return {
      // 时间只来自视图。这里读一次系统时钟，就等于回测与实盘走了两条不同的路径
      ts: view.asOf,
      phase: phase as Phase,
      strategyId: config.id,
      strategyName: config.名称 ?? config.id,
      env,
      candidates,
      holdings,
      warnings: w.list,
      // Advisor 是侧挂的：要不要改这张卡由 advisor 层决定，引擎自己不调它
      advisorInfluenced: false,
    };
  };
}
