/**
 * 五段状态机择时器：情绪阶段 → 档位。
 *
 * baseline 的三档阈值只看"今天盘面强不强"，分不出"强但在退"与"弱但在起"——
 * 高潮日的盘面强度往往最高，而那恰是该收手的时候。本槽改看情绪周期的阶段：
 *
 *   冰点 → 中性   冰点是建仓的时候，不是空仓的时候（与退潮分开的全部意义）
 *   启动 → 进攻
 *   发酵 → 进攻
 *   高潮 → 中性   不追，只做确定性最高的
 *   退潮 → 防守   空仓
 *
 * 映射可在 YAML `槽位.择时器.参数.阶段档位` 里改。两条护栏不随阶段变：
 *   - 防守触发（跌停潮、权重杀跌、外围 risk_off）一旦成立就是防守，阶段推不翻 ——
 *     状态机看的是接力情绪，看不见"跌停 80 家"这种系统性风险
 *   - 映射到进攻却没有主线 → 中性，与三档阈值同一条规则
 *
 * 阶段判不出来（派生表没建、样本不足）就整个沿用三档阈值，并在卡片上说出来。
 * 不给 stage —— 猜一个阶段出来，影子盘按阶段分组的统计就被污染了。
 */
import type {
  CycleStage, EnvAssessment, EnvGear, MainlineResult, SlotCtx, SlotParams, TimerSlot,
} from "@/lib/contracts";
import { LOW_CONFIDENCE } from "@/lib/strategy/engine";
import { 择时器_三档阈值 } from "@/lib/strategy/v2/slots/baseline";

export const 默认阶段档位: Record<CycleStage, EnvGear> = {
  冰点: "中性", 启动: "进攻", 发酵: "进攻", 高潮: "中性", 退潮: "防守",
};

const STAGES: CycleStage[] = ["冰点", "启动", "发酵", "高潮", "退潮"];
const GEARS: EnvGear[] = ["进攻", "中性", "防守"];
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

function mappingFrom(params: SlotParams, warn: (m: string) => void): Record<CycleStage, EnvGear> {
  const raw = params["阶段档位"];
  if (raw === undefined) return 默认阶段档位;
  if (raw === null || typeof raw !== "object") {
    warn(`阶段档位配置无法解释（${JSON.stringify(raw)}），本轮用默认映射`);
    return 默认阶段档位;
  }
  const out = { ...默认阶段档位 };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!STAGES.includes(k as CycleStage) || !GEARS.includes(v as EnvGear)) {
      warn(`阶段档位.${k}: ${JSON.stringify(v)} 无法解释（阶段须是五段之一、档位须是 进攻/中性/防守），忽略这一项`);
      continue;
    }
    out[k as CycleStage] = v as EnvGear;
  }
  return out;
}

export const 择时器_五段状态机: TimerSlot = {
  kind: "择时器", name: "五段状态机", version: "1.0.0",
  assess(ctx: SlotCtx, params: SlotParams, mainline: MainlineResult) {
    const { env: base } = 择时器_三档阈值.assess(ctx, params, mainline);
    const st = ctx.runFactor("情绪阶段");
    const stage = st !== null && st.confidence > 0 && STAGES.includes(st.label as CycleStage)
      ? (st.label as CycleStage) : null;
    if (stage === null) {
      ctx.warn(`情绪阶段判不出来（${st?.label ?? "拿不到读数"}），本轮沿用三档阈值的档位`);
      return { env: base };
    }

    const hard = base.reasons.filter(r => r.includes("防守触发"));
    const mapped = mappingFrom(params, ctx.warn)[stage];
    const heat = typeof st!.inputs?.["热度"] === "number" ? st!.inputs["热度"] as number : null;
    const days = st!.inputs?.["持续天数"];
    const head = `情绪阶段 ${stage}（热度 ${heat === null ? "—" : round6(heat)}，持续 ${days ?? "—"} 天）`;

    const reasons: string[] = [];
    let gear: EnvGear;
    if (hard.length > 0) {
      gear = "防守";
      reasons.push(`${head} → ${mapped}，但防守触发成立，档位取防守`, ...hard);
    } else if (mapped === "进攻" && mainline.names.length === 0) {
      gear = "中性";
      reasons.push(`${head} → 进攻`, "没有识别到主线，进攻降为中性");
    } else {
      gear = mapped;
      reasons.push(`${head} → ${gear}`);
    }
    if (gear === "防守") reasons.push("防守档 = 0 仓：不留过冬仓位，也不开新仓");

    const 档位仓位 = ctx.config.择时.仓位档位[gear] ?? 0;
    const 上限 = ctx.config.组合风控.总仓位上限;
    const targetPosition = gear === "防守" ? 0 : round6(Math.min(档位仓位, 上限));
    if (gear !== "防守" && 档位仓位 > 上限) reasons.push(`档位仓位 ${档位仓位} 被总仓位上限 ${上限} 压到 ${targetPosition}`);

    const factors = [...base.factors.filter(f => f.name !== st!.name), st!]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const env: EnvAssessment = {
      gear, targetPosition, reasons, factors,
      lowConfidenceFactors: factors.filter(f => f.confidence < LOW_CONFIDENCE).map(f => f.name).sort(),
    };
    return { env, stage };
  },
};
