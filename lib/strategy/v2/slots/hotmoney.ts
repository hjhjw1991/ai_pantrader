/**
 * 游资打法槽位。
 *
 * 存在理由：现有五个槽表达不出游资打法之间的差别。
 *
 *   候选源  三路（涨停池/主线领涨/量价）不区分连板高度，而"只做二板三板"与
 *           "只做首板"是两套完全不同的生意 —— 高度决定对手盘是谁
 *   评估器  触发价来自 YAML `选股.买点`（全局 −3% 折让），所有变体共用一个数字。
 *           "打板"要挂在涨停价、"半路"要在红盘追、"首阴"要贴着 MA5 接，
 *           这些差异根本不在现有参数里
 *   离场器  只有一个"账户纪律"（−10% 机械止损、收盘确认）。游资最锋利的地方
 *           恰恰在离场：−8% 硬砍、炸板就走、破 5 日线就走
 *
 * 于是这里各出一版，让它们在影子盘里与 baseline 同场赛马。
 *
 * **一条必须先说清的边界**：本文件的"打板"是**以涨停价成交的假设**，不是真的
 * 排到了板。真实打板要通道、要盯盘、要秒级决策 —— 影子盘记的是"如果按这个
 * 价成交，后来会怎样"，它回答的是"这套选股与离场有没有 alpha"，不是"你执行
 * 得了"。执行不了的打法即便跑赢也毕不了业，这一点在报告里要写明白。
 *
 * 约束与因子层一致（spec §17）：零网络、零存储、不取系统时间、不用随机数，
 * 数据只从 ctx.view 进，"现在"只能是 ctx.date。
 */
import type {
  Candidate, EnvAssessment, EvaluatedCandidate, EvaluatorSlot, ExitSlot, FactorResult,
  PoolRow, SlotCtx, SlotParams, SourceSlot, StrategyEngineInput,
} from "@/lib/contracts";
import {
  accountBoards, candidatePool, decideHolding, evaluateRow, type FactorRunner,
} from "@/lib/strategy/engine";
import { structureTarget } from "@/lib/strategy/v2/slots/structure-pricing";

const V = "1.0.0";
const round2 = (x: number): number => Math.round(x * 100) / 100;
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;

/**
 * baseline 里那两个适配器本文件要各用一次。
 *
 * 不 import 是为了保持 baseline 的导出面不变 —— 它是**对照组**，签名每动一次
 * 就多一处 parity 风险。这两个函数各三行，重复代价远小于耦合代价。
 */
function runnerOf(ctx: SlotCtx): FactorRunner {
  return {
    run: (name, extra) => ctx.runFactor(name, extra),
    has: name => ctx.registry.get(name) !== undefined,
  };
}

function inputOf(ctx: SlotCtx): StrategyEngineInput {
  return {
    view: ctx.view, config: ctx.config, phase: ctx.phase,
    positions: [], sectorOf: ctx.sectorOf, sectorMapAt: ctx.sectorMapAt,
  };
}

/** 涨跌幅限制。ST 不在 Board 里（它是状态标记），这里按板块粗分，够定价用 */
function limitPct(board: string): number {
  if (board === "创业板" || board === "科创板") return 0.20;
  if (board === "北交所") return 0.30;
  return 0.10;
}

/* --------------------------- ③ 候选源：连板梯队 --------------------------- */

/**
 * 只要涨停池里处在某个连板高度区间的票。
 *
 * 与「涨停池」路的差别只有一层过滤，但这层过滤就是打法的分水岭：
 *   首板  → 隔日套利，博的是"次日有没有人接力"
 *   二板  → 定龙头的经典位置（"二板定龙头"）
 *   四板+ → 接力，对手盘从散户换成游资，赢面与回撤同时放大
 * 高度不同的票混在一个池子里比，等于把三种生意的样本倒进同一个分母。
 */
export const 候选源_连板梯队: SourceSlot = {
  kind: "候选源", name: "连板梯队", version: V,
  scan(ctx: SlotCtx, params: SlotParams, mainlines: string[]): PoolRow[] {
    const min = num(params["板数下限"]) ?? 1;
    const max = num(params["板数上限"]) ?? 99;
    const onlyLeader = params["只要龙头"] === true;

    // 复用 v1 的 candidatePool 拿涨停池（含板块、连板数、封单额），行为与 baseline 逐字一致
    const input: StrategyEngineInput = {
      ...inputOf(ctx),
      config: {
        ...ctx.config,
        选股: {
          ...ctx.config.选股,
          候选来源: { 涨停池: true, 主线领涨: false, 量价: false },
        },
      },
    };
    const rows = candidatePool(input, mainlines, ctx.date, ctx.warn);
    const band = rows.filter(r => r.lbc >= min && r.lbc <= max);
    if (band.length === 0) {
      ctx.warn(`连板梯队：涨停池里没有 ${min}~${max} 板的票（池内 ${rows.length} 只）`);
      return [];
    }

    const tagged: PoolRow[] =
      band.map(r => ({ ...r, source: r.lbc >= 2 ? `${r.lbc}连板` : "首板" }));

    if (!onlyLeader) return tagged;

    /**
     * 每条主线只留连板最高的那只。
     *
     * "宁做龙头回调，不做杂毛反弹"——同板块里高度最高的那只是资金合力所在，
     * 后排跟风在分歧日先塌。同高度时取封单大的：封单是当天的真金白银。
     */
    const best = new Map<string, PoolRow>();
    for (const r of tagged) {
      const key = r.sector ?? "未分类";
      const cur = best.get(key);
      if (cur === undefined || r.lbc > cur.lbc
        || (r.lbc === cur.lbc && r.sealAmt > cur.sealAmt)) best.set(key, r);
    }
    return [...best.values()].map(r => ({ ...r, source: `${r.source}·龙头` }));
  },
};

/* -------------------------- ④ 评估器：游资手法 -------------------------- */

export type 手法 = "打板" | "半路" | "低吸" | "首阴";
const 手法集: 手法[] = ["打板", "半路", "低吸", "首阴"];

/**
 * 各手法的默认筛阈值放宽。
 *
 * **这是本文件最需要解释的一段**，因为它在系统性地关掉几道筛：
 *
 *   位置涨幅上限 50 → 放宽    连板股 20 日涨幅普遍 > 50%，不放松池子直接空
 *   超买否决分   3 → 放宽    连板股 RSI 必在 90 以上，这道筛本就是为"不追高"设的
 *   近期涨停次数 3 → 放宽    同上，连板股天然超限
 *   振幅容忍倍数 2 → 关掉    「打法匹配」筛的原文是"用户不盯盘，止损会被秒破"
 *
 * 最后一条要特别说明：把它关掉**不等于**宣称这套打法适合执行。影子盘是虚拟盘，
 * 拦一道"人执行不了"的筛只会让挑战者的样本永远是空的，那是把问题藏起来而不是
 * 回答问题。真正的把关放在毕业环节——跑赢也执行不了的打法，人可以不批准切换。
 * 这里在 thesis 上留痕（"放宽：…"），任何一张卡片都能看出它是在宽松口径下出的。
 */
const 放宽默认: Record<手法, Record<string, number>> = {
  打板: { 位置涨幅上限: 300, 换手上限: 40, 振幅上限: 20, 超买否决分: 5,
    近期涨停次数上限: 99, MA20偏离上限: 80, 振幅容忍倍数: 99, 止损幅度: 8 },
  半路: { 位置涨幅上限: 300, 换手上限: 40, 振幅上限: 20, 超买否决分: 5,
    近期涨停次数上限: 99, MA20偏离上限: 60, 振幅容忍倍数: 99, 止损幅度: 8 },
  低吸: { 位置涨幅上限: 120, 换手上限: 25, 振幅上限: 15, 超买否决分: 4,
    近期涨停次数上限: 10, MA20偏离上限: 40, 振幅容忍倍数: 4, 止损幅度: 8 },
  首阴: { 位置涨幅上限: 120, 换手上限: 25, 振幅上限: 15, 超买否决分: 4,
    近期涨停次数上限: 10, MA20偏离上限: 40, 振幅容忍倍数: 3, 止损幅度: 8 },
};

function 手法of(params: SlotParams, warn: (m: string) => void): 手法 {
  const raw = params["手法"];
  if (raw === undefined) return "低吸";
  if (typeof raw !== "string" || !手法集.includes(raw as 手法)) {
    warn(`游资手法：手法 "${JSON.stringify(raw)}" 无法解释（须是 ${手法集.join("/")}），本轮按低吸`);
    return "低吸";
  }
  return raw as 手法;
}

/** 触发价相对昨收的折让。打板直接挂涨停价 —— 打板的成交价就是那个价 */
function 折让of(手法_: 手法, params: SlotParams, board: string): number {
  const given = num(params["折让"]);
  if (given !== null) return given;
  switch (手法_) {
    case "打板": return limitPct(board);
    case "半路": return 0.05;
    case "首阴": return -0.05;
    default: return -0.03;
  }
}

/** 昨日收阴且缩量。"首阴"要的是第一次分歧，不是下跌中继 */
function 是首阴(ctx: SlotCtx, code: string): boolean {
  const bars = ctx.view.dailyBars(code, 5);
  if (bars.length < 3) return false;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (!(prev.vol > 0)) return last.c < last.o;
  return last.c < last.o && last.vol < prev.vol;
}

export const 评估器_游资手法: EvaluatorSlot = {
  kind: "评估器", name: "游资手法", version: V,
  evaluate(
    ctx: SlotCtx, params: SlotParams, row: PoolRow, mainline: string
  ): EvaluatedCandidate | null {
    const 手法_ = 手法of(params, ctx.warn);
    const sec = ctx.view.security(row.code);
    if (sec === null) {
      ctx.warn(`游资手法：${row.code} 查不到证券元数据（定不出涨跌幅限制），跳过`);
      return null;
    }
    if (手法_ === "首阴" && !是首阴(ctx, row.code)) {
      ctx.warn(`游资手法：${row.code} 昨日不是「收阴缩量」，首阴不成立，跳过`);
      return null;
    }

    const 折让 = 折让of(手法_, params, sec.board);
    // 贴着 MA5 接。首阴手法强制开（龙头首次分歧的支撑就在那儿），
    // 其余手法按需开 —— "回踩 5/10 日线缩量企稳低吸"与"首阴低吸"是同一条纪律的松紧两档。
    // true = 必须跌破 MA5；数字 = 贴到 MA5×倍数即可。后者是给"严格版触发率只剩 7.8%"
    // 留的活口：质量与样本量的平衡点要靠这一档找，见 lib/strategy/engine.ts 同段注释。
    const 容差 = params["不高于MA5"];
    const 贴MA5 = 容差 === true || 手法_ === "首阴" ? true
      : typeof 容差 === "number" ? 容差
        : false;
    const 容差说明 = typeof 贴MA5 === "number" ? `MA5×${贴MA5}` : "MA5";

    /**
     * `沿用默认筛` 是专门为**单因子对照**留的开关。
     *
     * 默认不放宽（放宽默认）时，换上本槽等于同时换了两样东西：进场手法 + 宽松筛。
     * 那样赢了也分不清是哪一样起的作用 —— 这恰恰是"整套照搬"的老毛病。
     * 要测"贴着 MA5 接到底好不好"这种单一问题时，必须让筛子保持原样。
     */
    const 沿用默认筛 = params["沿用默认筛"] === true;
    const 放宽 = 沿用默认筛 ? {} : { ...放宽默认[手法_], ...(对象参数(params["放宽"])) };
    const 阈值: Record<string, number> = { ...ctx.config.选股.过滤器阈值, ...放宽 };

    /**
     * 触发价与筛子都走 evaluateRow，只是喂给它改过的 config / 阈值。
     *
     * 不自己算触发价，是因为"用原始收盘价而不是复权价""MA5 取 5 根原始收盘"
     * 这些口径在 v1 里已经踩过一遍（触发价是要挂进券商的真实价格）。抄一遍
     * 迟早与 baseline 漂移，而漂移的后果是影子盘里两套策略的价格不同源。
     */
    const input: StrategyEngineInput = {
      ...inputOf(ctx),
      config: {
        ...ctx.config,
        选股: {
          ...ctx.config.选股,
          买点: { 相对昨收: 折让, 不高于MA5: 贴MA5 },
        },
      },
    };
    const raw = evaluateRow(
      input, runnerOf(ctx), row, mainline, accountBoards(ctx.config), 阈值, ctx.warn
    );
    if (raw === null) return null;

    // 止损覆写：游资的止损是打法的一部分，不该沿用账户那套（账户纪律 −10% 且收盘确认）
    const 止损 = num(params["止损"]);
    const stopPx = 止损 === null ? raw.stopPx : round2(raw.triggerPx * (1 + 止损));

    const minRr = num(params["最低盈亏比"]);
    const atrK = num(params["ATR目标倍数"]) ?? 3;
    const struct = ctx.runFactor("结构位", { code: row.code });
    const atrF = ctx.runFactor("ATR", { code: row.code });
    const extra: FactorResult<any>[] =
      [struct, atrF].filter((f): f is FactorResult<any> => f !== null);
    const st = structureTarget(
      raw.triggerPx, stopPx,
      num(struct?.inputs?.["阻力"]), num(atrF?.inputs?.["ATR"]), atrK
    );

    let rrRatio: number | null = null;
    let targetPx: number | null = null;
    let 定价说明 = "未定价";
    if (st !== null) {
      targetPx = st.target;
      rrRatio = st.rr;
      定价说明 = `目标 ${st.target}（${st.source}）`;
      if (minRr !== null && rrRatio !== null && rrRatio < minRr) {
        ctx.warn(`游资手法：${row.code} 盈亏比 ${rrRatio.toFixed(2)} < 门槛 ${minRr}，不进候选`);
        return null;
      }
    }

    const 手法说明 = 手法_ === "打板"
      ? `打板（涨停价 ${raw.triggerPx}，${sec.board} 限幅 ${pct(limitPct(sec.board))}）`
      : `${手法_}（相对昨收 ${pct(折让)}${贴MA5 === false ? "" : `，且不高于 ${容差说明}`}）`;

    return {
      code: raw.code, name: raw.name, account: raw.account,
      sector: raw.sector, mainline: raw.mainline,
      triggerPx: raw.triggerPx, stopPx, targetPx, rrRatio,
      thesis: `${raw.thesis}；${手法说明}，${定价说明}`
        + `${rrRatio === null ? "" : `，盈亏比 ${rrRatio.toFixed(2)}`}`
        + `${止损 === null ? "" : `，硬止损 ${pct(止损)}`}`
        + (沿用默认筛 ? "" : `；放宽筛（${Object.keys(放宽).length} 项）`),
      passedFilters: raw.passedFilters,
      factors: [...raw.factors, ...extra],
      score: raw.score,
    };
  },
};

function 对象参数(v: unknown): Record<string, number> {
  if (v === null || typeof v !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const n = num(val);
    if (n !== null) out[k] = n;
  }
  return out;
}

/* -------------------------- ⑤ 离场器：游资纪律 -------------------------- */

/**
 * 游资的离场比进场更锋利。
 *
 * baseline 的账户纪律是 −10% 机械止损 + 收盘确认（依据是回放：8% 止损把毛利
 * 从 +0.670%/笔 拉到 +0.584%/笔，砍掉的几乎全是后来弹回去的）。游资反着来：
 * 止损更浅但**更硬**——他们靠的是"错单立刻认"，用次数换掉单笔深度。
 * 这两种做法谁更好，是影子盘该回答的问题，不是该在代码里预设答案的问题。
 *
 * 实现上走"先问 baseline，再叠加"而不是重写：账户权限、停牌、ST 那些边界
 * 条件 decideHolding 已经处理过一遍（v1 的 127 个测试盖着），重写的收益是零，
 * 漏掉一条的代价是持仓页给出错误的动作。
 */
export const 离场器_游资纪律: ExitSlot = {
  kind: "离场器", name: "游资纪律", version: V,
  decide(
    ctx: SlotCtx, params: SlotParams,
    position: { account: string; code: string; cost: number; qty: number; stopPx: number | null },
    env: EnvAssessment
  ): Candidate {
    const base = decideHolding(inputOf(ctx), position, env.gear, ctx.warn, runnerOf(ctx));
    const bars = ctx.view.dailyBars(position.code, 30);
    if (bars.length === 0) {
      return { ...base, thesis: `${base.thesis}；游资纪律：无日线，沿用账户纪律` };
    }

    const last = bars[bars.length - 1];
    const 止损 = num(params["止损"]) ?? -0.08;
    const 止盈 = num(params["止盈"]);
    // 破线：不写（undefined）= 默认 MA5；显式写 null = 关掉这条。
    // 之前 null 也回落成 MA5，于是"不要破线离场"根本配不出来
    const 破线 = params["破线"] === null ? null : typeof params["破线"] === "string" ? params["破线"] : "MA5";
    const 炸板走 = params["炸板走"] !== false;

    const pnl = position.cost > 0 ? last.c / position.cost - 1 : 0;
    const reasons: string[] = [];

    if (pnl <= 止损) reasons.push(`浮亏 ${pct(pnl)} ≤ 硬止损 ${pct(止损)}`);
    if (止盈 !== null && pnl >= 止盈) reasons.push(`浮盈 ${pct(pnl)} ≥ 止盈 ${pct(止盈)}`);

    if (破线 === "MA5" || 破线 === "MA10") {
      const n = 破线 === "MA5" ? 5 : 10;
      if (bars.length >= n) {
        const ma = bars.slice(bars.length - n).reduce((a, b) => a + b.c, 0) / n;
        if (last.c < ma) reasons.push(`收盘 ${last.c} 跌破${破线} ${round2(ma)}`);
      }
    }

    /**
     * 炸板就走：昨日盘中触板却没封住。
     *
     * 用日线口径近似（最高价触涨停价、收盘没站住）。真实炸板是一分钟级的事，
     * 这里只能判到"当天没封住"——够用来表达"不格局"这条纪律，不够用来复盘秒级。
     */
    if (炸板走 && bars.length >= 2) {
      const board = ctx.view.security(position.code)?.board ?? "主板";
      const prevC = bars[bars.length - 2].c;
      const limitPx = round2(prevC * (1 + limitPct(board)));
      if (prevC > 0 && last.h >= limitPx * 0.999 && last.c < limitPx * 0.999) {
        reasons.push(`炸板未封（触 ${limitPx} 收 ${last.c}）`);
      }
    }

    if (reasons.length === 0) {
      return {
        ...base,
        thesis: `${base.thesis}；游资纪律未触发（浮${pnl >= 0 ? "盈" : "亏"} ${pct(pnl)}）`,
      };
    }
    // size 0 = 清掉这一笔（与 decideHolding 的清仓口径一致）
    return {
      ...base, action: "清仓", size: 0, triggerPx: null, stopPx: null,
      thesis: `${base.thesis}；游资纪律清仓：${reasons.join("、")}`,
    };
  },
};

export const HOTMONEY_SLOTS = [候选源_连板梯队, 评估器_游资手法, 离场器_游资纪律];
