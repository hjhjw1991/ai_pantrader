/**
 * 持仓与观察池的每日建议。
 *
 * 两层，权重不同：
 *   - **纪律**（持仓）/ **正式评估**（观察池）是结论：持仓动作来自离场器（破止损、到止盈档），
 *     观察池"能不能买"来自正式评估器（同一套筛、同一个触发价与止损）
 *   - **技术面提示**只是参考：MACD、结构位、M 顶 W 底读数翻译成人话，
 *     不会把"持有"改成"清仓"，也不会让一只被否决的票变成可买
 *
 * 提示规则是纯函数，只吃因子读数，方便单测、也方便以后换成影子盘验证过的版本。
 */
import type { FactorResult, TechContext, TechHint } from "@/lib/contracts";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const live = (f: FactorResult<any> | null | undefined): f is FactorResult<any> => f != null && f.confidence > 0;

/** 把几个技术因子的读数翻译成提示。held = 持仓（关心离场），否则是观察（关心买点） */
export function techContext(
  f: { daily?: FactorResult<any> | null; weekly?: FactorResult<any> | null; structure?: FactorResult<any> | null; pattern?: FactorResult<any> | null; atr?: FactorResult<any> | null },
  held: boolean,
): TechContext {
  const hints: TechHint[] = [];
  const daily = live(f.daily) ? f.daily.label ?? null : null;
  const weekly = live(f.weekly) ? f.weekly.label ?? null : null;
  const si = live(f.structure) ? (f.structure.inputs ?? {}) as Record<string, unknown> : {};
  const pi = live(f.pattern) ? (f.pattern.inputs ?? {}) as Record<string, unknown> : {};
  const resistance = num(si["阻力"]), support = num(si["支撑"]), price = num(si["现价"]);
  const atr = live(f.atr) ? num((f.atr.inputs ?? {})["ATR"]) : null;
  const pattern = live(f.pattern) && f.pattern.label !== "无" ? f.pattern.label ?? null : null;

  if (weekly === "死叉") hints.push({ tone: "负面", text: "周线 MACD 刚死叉，中期转弱" });
  else if (weekly === "金叉") hints.push({ tone: "正面", text: "周线 MACD 刚金叉，中期转强" });
  else if (weekly === "空头" && held) hints.push({ tone: "负面", text: "周线 MACD 在空头区" });
  if (daily === "死叉") hints.push({ tone: "负面", text: "日线 MACD 刚死叉" });
  else if (daily === "金叉") hints.push({ tone: "正面", text: "日线 MACD 刚金叉" });

  const neck = num(pi["颈线"]);
  if (pattern === "M顶确认") hints.push({ tone: "负面", text: `M 顶已跌破颈线${neck === null ? "" : ` ${neck.toFixed(2)}`}` + (held ? "，考虑减仓" : "，不宜买") });
  else if (pattern === "M顶形成中") hints.push({ tone: "负面", text: `M 顶形成中${neck === null ? "" : `，跌破颈线 ${neck.toFixed(2)} 即确认`}` });
  else if (pattern === "W底确认") hints.push({ tone: "正面", text: `W 底已上破颈线${neck === null ? "" : ` ${neck.toFixed(2)}`}` });
  else if (pattern === "W底形成中") hints.push({ tone: "中性", text: `W 底形成中${neck === null ? "" : `，上破颈线 ${neck.toFixed(2)} 才确认`}` });

  // 1 个 ATR：结构位因子已经跳过了离现价不到 0.5 ATR 的拐点，阈值再小这两条永远不会触发
  if (price !== null && resistance !== null) {
    const near = atr !== null ? resistance - price <= atr : resistance / price - 1 <= 0.03;
    if (near) hints.push({ tone: held ? "中性" : "负面", text: held ? `接近前高阻力 ${resistance.toFixed(2)}，可考虑分批止盈` : `离前高阻力 ${resistance.toFixed(2)} 太近，上方空间小` });
  }
  if (price !== null && support !== null && atr !== null && price - support <= atr) {
    hints.push({ tone: "中性", text: `贴近结构支撑 ${support.toFixed(2)}，跌破就是结构破位` });
  }
  return { daily, weekly, pattern, resistance, support, atr, price, hints };
}

/** 持仓的技术面倾向（参考）。纪律动作另算，这里不覆盖它 */
export function holdingLean(t: TechContext): "持有" | "留意" | "考虑减仓" {
  const neg = t.hints.filter(h => h.tone === "负面").length;
  if (t.pattern === "M顶确认" || (t.weekly === "死叉" && t.daily === "死叉")) return "考虑减仓";
  return neg > 0 ? "留意" : "持有";
}
