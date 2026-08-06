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
  Phase, PointInTimeView, SignalCard, StrategyConfig, StrategyEngine, StrategyEngineInput } from "@/lib/contracts";
import { accountRule, takeProfitRules, unparsedTakeProfit } from "@/lib/strategy/loader";
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
function accountBoards(config: StrategyConfig): Array<{ account: AccountId; boards: string[] }> {
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
function accountForBoard(
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
function matchesMainline(sector: string | null, mainlines: string[]): string | null {
  if (sector === null || sector.length === 0) return null;
  for (const m of mainlines) {
    if (m.length === 0) continue;
    if (sector === m || sector.includes(m) || m.includes(sector)) return m;
  }
  return null;
}

/** asOf 当日或之前最近的交易日。日历为空时退回 asOf 的日期部分 */
function resolveDate(view: PointInTimeView): string {
  const asOfDate = view.asOf.slice(0, 10);
  const from = new Date(`${asOfDate}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 30);
  const days = view.tradingDays(from.toISOString().slice(0, 10), asOfDate);
  return days.length === 0 ? asOfDate : days[days.length - 1];
}

/** 去重且保序的告警收集器。顺序确定 = 同份输入两次结果哈希一致 */
function makeWarnings() {
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

interface FactorRunner {
  /** 拿不到读数时返回 null（未注册 / 求值抛错），并已记好告警。调用方必须判 null */
  run(name: string, extra?: Record<string, unknown>): FactorResult<any> | null;
}

function makeRunner(
  registry: FactorRegistry, config: StrategyConfig, view: PointInTimeView,
  date: string, warn: (m: string) => void
): FactorRunner {
  const seenLowConf = new Set<string>();
  return {
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

function assessEnv(
  config: StrategyConfig, runner: FactorRunner, warn: (m: string) => void
): { env: EnvAssessment; mainlines: string[] } {
  const facts = new Map<string, FactorResult<any>>();
  const need = (name: string, extra?: Record<string, unknown>): FactorResult<any> | null => {
    const r = runner.run(name, extra);
    if (r !== null) facts.set(name, r);
    return r;
  };

  for (const name of ENV_FACTOR_NAMES) need(name);

  const 主线 = need("主线识别", {
    板块涨幅榜TopN: config.选股.主线识别.板块涨幅榜TopN,
    必查链: config.选股.主线识别.必查链,
  });
  const mainlines = 主线 === null ? [] : strArray(主线.value);
  if (mainlines.length === 0) {
    warn("未识别到主线板块 —— 候选池只会剩下必查链兜底能捞到的票，注意是不是板块榜快照缺了");
  }
  if (mainlines.length > 0) need("龙头温度计", { 板块: mainlines[0] });

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
    env: {
      gear, targetPosition, reasons,
      factors: [...facts.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      lowConfidenceFactors,
    },
    mainlines,
  };
}

/* -------------------------------- 候选池 -------------------------------- */

interface RawCandidate {
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

  // 排序先定死：连板高 → 封单大 → 代码。名次会影响风控分配，抖动就是结果不可复现
  const pool = [...view.ztPool(date)].sort((a, b) =>
    (b.lbc ?? 0) - (a.lbc ?? 0) ||
    (b.sealAmt ?? 0) - (a.sealAmt ?? 0) ||
    (a.code < b.code ? -1 : 1));

  for (const row of pool) {
    if (heldCodes.has(row.code)) continue;              // 已持仓的走 holdings，不重复开仓
    const mainline = matchesMainline(row.sector, mainlines);
    if (mainline === null) continue;                    // 不在主线上的不追

    const sec = view.security(row.code);
    if (sec === null) {
      warn(`标的元数据缺失：${row.code} 查不到板与上市信息，跳过（不猜板别就不会猜错涨跌幅限制）`);
      continue;
    }
    const account = accountForBoard(perms, sec.board);
    // 没有账户开通该板块权限：不出信号（出了也买不进）
    if (account === null) continue;

    const filt = runner.run("过滤器", { ...阈值, code: row.code, 账户: account });
    if (filt === null) continue;
    const rejected = strArray(filt.inputs?.["否决"]);
    const unevaluated = strArray(filt.inputs?.["未判定"]);
    if (unevaluated.length > 0) {
      warn(`七道筛未判定：${unevaluated.join(" / ")}（无数据源）—— 未判定不等于通过`);
    }
    if (rejected.length > 0) {
      warn(`${row.code} 被七道筛否决：${rejected.join(" / ")}，不进候选池`);
      continue;
    }

    const bars = view.dailyBars(row.code, 20);
    if (bars.length === 0) {
      warn(`${row.code} 没有日线，定不出触发价，跳过`);
      continue;
    }
    // 用原始收盘价而不是复权价：触发价是要挂进券商的真实价格。
    // 5 日窗口内除权概率极低，MA5 与收盘价混用的误差可以忽略。
    const closes = bars.map(b => b.c);
    const lastClose = closes[closes.length - 1];
    const win = closes.slice(Math.max(0, closes.length - 5));
    const ma5 = win.reduce((a, b) => a + b, 0) / win.length;
    // 不追高：触发价取"最新收盘与 MA5 的较低者"，等回踩到位才动手。
    // 用户的目标是牛市长期稳定盈利、不打板不超短，追板价对他没有可执行性。
    const triggerPx = round2(Math.min(lastClose, ma5));
    if (!(triggerPx > 0)) {
      warn(`${row.code} 算不出正的触发价，跳过`);
      continue;
    }

    const 止损 = asNum(accountRule(config, account)["止损"]);
    const stopPx = 止损 === null ? null : round2(triggerPx * (1 + 止损));

    /* thesis：讲不出逻辑的不进池 */
    const stockFacts: FactorResult<any>[] = [filt];
    const parts: string[] = [`主线${mainline}`];
    if (row.lbc > 1) parts.push(`${row.lbc} 连板`);
    const 温度 = runner.run("龙头温度计", { 板块: mainline });
    if (温度 !== null && 温度.confidence > 0 && 温度.label !== undefined) {
      parts.push(`龙头${温度.label}`);
      stockFacts.push(温度);
    }
    for (const name of STOCK_FACTOR_NAMES) {
      const r = runner.run(name, { code: row.code });
      if (r === null) continue;
      stockFacts.push(r);
      // confidence 0 的因子只是"没数据"，不能当成论据
      if (r.confidence > 0 && r.label !== undefined && r.label.length > 0 && asNum(r.value) !== null) {
        parts.push(`${name}${r.label}`);
      }
    }
    // 只有"主线xx"一句不算逻辑：那是板块判断，不是买这只票的理由
    if (parts.length <= 1) {
      warn(`${row.code} 讲不出买入逻辑（因子读数不足），不进候选池`);
      continue;
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

    out.push({
      code: row.code, name: sec.name, account,
      sector: row.sector ?? mainline, mainline,
      triggerPx, stopPx,
      thesis: parts.join("；"),
      passedFilters: strArray(filt.inputs?.["通过"]),
      factors: stockFacts,
      score,
    });
  }

  return out.sort((a, b) => b.score - a.score || (a.code < b.code ? -1 : 1));
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
  input: StrategyEngineInput, gear: EnvGear, date: string, warn: (m: string) => void
): Candidate[] {
  const { view, config, phase, positions } = input;
  const out: Candidate[] = [];

  const sorted = [...positions].sort((a, b) =>
    (a.account < b.account ? -1 : a.account > b.account ? 1 : 0) || (a.code < b.code ? -1 : 1));

  for (const p of sorted) {
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
      out.push({ ...base, action: "观察", size: 1, thesis: "无价格数据（停牌或未采集），本轮不判定，人工确认" });
      continue;
    }

    const pnl = p.cost === 0 ? 0 : px / p.cost - 1;

    if (gear === "防守") {
      out.push({
        ...base, action: "清仓", size: 0,
        thesis: `防守档目标仓位 0，清空持仓（现价 ${px}，浮动 ${pct(pnl)}）`,
      });
      continue;
    }

    if (灾难位 !== null && pnl <= 灾难位) {
      // 灾难位存在的唯一理由就是越过"收盘确认"：跌到这儿再等收盘已经不是纪律问题了
      out.push({
        ...base, action: "清仓", size: 0,
        thesis: `跌破灾难位 ${pct(灾难位)}（当前 ${pct(pnl)}），不等收盘确认，直接走`,
      });
      continue;
    }

    const brokeStop = (stopPx !== null && px <= stopPx) || (止损 !== null && pnl <= 止损);
    if (brokeStop) {
      if (止损确认 === "收盘" && phase === "盘中") {
        // 政策底/外围硬驱动的反弹日，盘中单次冲高回落多数是洗盘不是见光死（2026-07-21 实盘验证）
        out.push({
          ...base, action: "观察", size: 1,
          thesis: `已破止损${stopPx === null ? "" : ` ${stopPx}`}（现价 ${px}，浮动 ${pct(pnl)}），按"止损确认=收盘"等收盘再决定`,
        });
      } else {
        out.push({
          ...base, action: "清仓", size: 0,
          thesis: `破止损${stopPx === null ? "" : ` ${stopPx}`}（现价 ${px}，浮动 ${pct(pnl)}），按纪律出`,
        });
      }
      continue;
    }

    // 止盈从高到低找第一个命中的档
    const hit = [...tp].reverse().find(r => pnl >= r.pnl);
    if (hit !== undefined) {
      out.push({
        ...base,
        action: hit.action,
        // 持仓动作的 size 是**对该笔持仓的操作比例**（0=清空，0.5=减半，1=不动），
        // 与新开仓 Candidate.size（占总资产比例）语义不同 —— 契约里没区分，见最终报告
        size: hit.action === "清仓" ? 0 : 0.5,
        thesis: `浮盈 ${pct(pnl)} 触发止盈档 ${hit.raw}（现价 ${px}）`,
      });
      continue;
    }

    if (止损 === null && pnl < 0) {
      const 止损说明 = typeof rule["止损"] === "string" ? rule["止损"] as string : "未配置";
      out.push({
        ...base, action: "观察", size: 1,
        thesis: `浮亏 ${pct(pnl)}，该账户止损条件是"${止损说明}"（非价格），需人工复核逻辑是否已破`,
      });
      continue;
    }

    out.push({
      ...base, action: "持有", size: 1,
      thesis: `未触发任何纪律线（现价 ${px}，浮动 ${pct(pnl)}）`,
    });
  }

  return out;
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
    const { env, mainlines } = assessEnv(config, runner, warn);

    const heldCodes = new Set(input.positions.map(p => p.code));
    if (input.positions.length > 0) {
      // 老实说清楚：没有总资产/现金输入，就算不出现有持仓占了多少仓位。
      // 假装能算出来才是真危险 —— 那会在已经满仓时继续发买入信号。
      warn(
        `组合风控：引擎没有总资产/现金输入（StrategyEngineInput 未提供），` +
        `新开仓预算按目标仓位 ${env.targetPosition} 全额计算，未扣除现有 ${input.positions.length} 笔持仓的占比，请人工核对`
      );
    }

    const candidates = env.gear === "防守"
      ? []
      : applyPortfolioCaps(
          buildCandidates(input, runner, mainlines, heldCodes, date, warn),
          config, env.targetPosition);

    const holdings = buildHoldings(input, env.gear, date, warn);

    return {
      // 时间只来自视图。这里读一次系统时钟，就等于回测与实盘走了两条不同的路径
      ts: view.asOf,
      phase: phase as Phase,
      strategyId: config.id,
      env,
      candidates,
      holdings,
      warnings: w.list,
      // Advisor 是侧挂的：要不要改这张卡由 advisor 层决定，引擎自己不调它
      advisorInfluenced: false,
    };
  };
}
