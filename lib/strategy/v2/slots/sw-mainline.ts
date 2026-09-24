/**
 * 主线识别器「申万聚集」：主线由申万行业分类与当天的涨停分布决定，不预设任何名单。
 *
 * 与 baseline「板块榜叠加必查链」并存：baseline 保留必查链当对照组，
 * 这一份组成新组合进影子盘比，赢了再按毕业流程换上去（用户 2026-09-24 选定）。
 *
 * 名单 = 主线的行业名 ∪ 各主线成员实际出现过的板块名（见 lib/factors/sw-mainline.ts）。
 * 只给行业名的话，候选源里东财口径的板块名（"半导体"）对不上申万一级（"电子"），
 * 按主线选票就整个失效 —— 而且不报错，只是候选少了。
 */
import type { MainlineResult, MainlineSlot, SlotCtx, SlotParams } from "@/lib/contracts";

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);

export const 主线识别器_申万聚集: MainlineSlot = {
  kind: "主线识别器", name: "申万聚集", version: "1.0.0",
  detect(ctx: SlotCtx, params: SlotParams): MainlineResult {
    const f = ctx.runFactor("申万主线", params as Record<string, unknown>);
    if (f === null) return { names: [], factors: [] };
    const 明细 = Array.isArray(f.inputs?.["明细"]) ? (f.inputs!["明细"] as Array<Record<string, unknown>>) : [];
    const names = [...new Set([...strs(f.value), ...明细.flatMap(m => strs(m["sectors"]))])];
    if (names.length === 0) ctx.warn(`申万聚集：${f.label ?? "没有识别到主线"} —— 今天按主线选票会是空的`);
    const factors = [f];
    // 龙头温度计按第一条主线龙头所在的原板块名去找龙头：它按板块名精确匹配涨停池
    const leaderSector = typeof 明细[0]?.["leaderSector"] === "string" ? 明细[0]["leaderSector"] as string : null;
    if (leaderSector !== null) {
      const t = ctx.runFactor("龙头温度计", { 板块: leaderSector });
      if (t !== null) factors.push(t);
    }
    return { names, factors };
  },
};
