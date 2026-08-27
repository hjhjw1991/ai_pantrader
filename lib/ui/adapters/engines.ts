import type Database from "better-sqlite3";
import type { Phase, SignalCard, StrategyConfig } from "@/lib/contracts/strategy";
import type { BacktestReport, Constraints, SweepReport } from "@/lib/contracts/backtest";
import { unavailable, type Avail } from "@/lib/ui/derive";
import { createSqliteView, universeQuality, type UniverseQuality } from "@/lib/pit/sqlite-view";
import { createStrategyEngine } from "@/lib/strategy/engine";
import { defaultRegistry } from "@/lib/factors";
import { runBacktest as replay } from "@/lib/backtest";
import { runBacktestAsync as replayAsync, ReplayAborted, type ReplayProgress } from "@/lib/backtest/replay";
import { gridPoints, heatmap, optimize, type ParamGrid } from "@/lib/backtest/optimizer";
import { canonicalJson } from "@/lib/backtest/hash";
import { overrideConfigParams } from "@/lib/ui/adapters/strategy";
import { positions as loadPositions, sectorMap } from "@/lib/ui/queries";

/**
 * 信号引擎 / 回测器适配器。
 *
 * 前端不实现任何决策逻辑：档位、候选、过滤、约束全部来自 lib/strategy + lib/factors
 * + lib/backtest。这里只做三件事 —— 组装 PIT 视图、传入配置与持仓、把异常翻译成
 * 页面能渲染的空态。任何一层抛错时**不返回半成品信号卡**：半份候选池比空白危险。
 */

type Db = Database.Database;

const engine = createStrategyEngine({ registry: defaultRegistry });

/** 时段按 Asia/Shanghai 的钟点判，不用 UTC —— 收盘后会被算成前一天的盘中 */
export function phaseAt(now: Date): Phase {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const mins = (Number(m.hour) % 24) * 60 + Number(m.minute);
  if (mins < 9 * 60 + 15) return "盘前";
  if (mins <= 15 * 60 + 5) return "盘中";
  return "盘后";
}

export interface SignalCardResult {
  card: SignalCard;
  phase: Phase;
  asOf: string;
  /** 幸存者过滤的实际覆盖率：list_date 未知的票逃过了过滤，折扣要能量化（spec §10.2） */
  universe: UniverseQuality;
}

/**
 * 当日信号卡。
 *
 * asOf 由调用方给（页面传当前时刻），不在这里取 Date.now() ——
 * 因子层禁用 Date.now，视图时点必须是显式的一个值，否则同一次渲染里
 * 不同因子可能看到不同的"现在"。
 */
export function todaySignalCard(
  db: Db,
  asOf: string,
  config: StrategyConfig
): Avail<SignalCardResult> {
  try {
    const view = createSqliteView(db, asOf);
    const phase = phaseAt(new Date(asOf));
    const pos = loadPositions(db).map((p) => ({
      account: p.account,
      code: p.code,
      cost: p.cost,
      qty: p.qty,
      stopPx: p.stopPx,
    }));
    // 代码→行业 映射走输入注入（视图是冻结契约，见 StrategyEngineInput.sectorOf 的说明）
    const sm = sectorMap(db);
    const card = engine({
      view, config, phase, positions: pos,
      sectorOf: (code: string) => sm.byCode.get(code) ?? null,
      ...(sm.at === null ? {} : { sectorMapAt: sm.at }),
    });
    return { available: true, card, phase, asOf, universe: universeQuality(db, asOf) };
  } catch (e) {
    return unavailable(
      `信号引擎执行失败：${(e as Error).message}`,
      "多半是当日截面数据缺失（zt_pool / sector_rank / macro）或视图越界。缺口明细见设置页；此处不显示部分结果 —— 半份候选池比空白危险"
    );
  }
}

export { ReplayAborted, type ReplayProgress };

/**
 * 异步版回测。与 runBacktest 同一段回放实现（generator 的两个驱动器），
 * 区别只是每个交易日让出一次事件循环，顺便报进度、收取消。
 *
 * 页面上的回测必须走这条：实测 0.38 秒/交易日，四年约 968 个交易日 ≈ 6 分钟，
 * 而 Node 是单线程 —— 同步跑意味着这 6 分钟里整个网站冻住。
 *
 * 取消不吞：ReplayAborted 原样抛出去，调用方要能把"用户主动取消"和"回测出错"
 * 分开报 —— 把取消报成失败，用户会以为是自己的策略配置有问题。
 */
export async function runBacktestAsync(
  db: Db,
  i: BacktestRunInput,
  a: { onProgress?: (p: ReplayProgress) => void; signal?: { aborted: boolean } } = {}
): Promise<Avail<{ report: BacktestReport }>> {
  try {
    const out = await replayAsync({
      from: i.from,
      to: i.to,
      viewFactory: (asOf: string) => createSqliteView(db, asOf),
      strategy: engine,
      config: i.config,
      initialCash: i.initialCash,
      ...(i.constraints ? { constraints: i.constraints } : {}),
      generatedAt: i.generatedAt,
    }, a);
    return { available: true, report: out.report };
  } catch (e) {
    if (e instanceof ReplayAborted) throw e;
    return unavailable(
      `回测失败：${(e as Error).message}`,
      "不返回部分净值曲线 —— 一条不完整的净值曲线会被当成策略成绩读"
    );
  }
}

export interface BacktestRunInput {
  from: string;
  to: string;
  config: StrategyConfig;
  initialCash: number;
  constraints?: Constraints;
  /** 报告信封时间戳，必须外部注入：重放路径内不许出现 Date.now()（spec §17 断言 4） */
  generatedAt: string;
}

/**
 * 参数扫描点数上限。
 *
 * 每个网格点是一次**完整回测**，且和单次回测一样同步跑在请求线程里
 * （见 /api/backtest 的注释）。36 是"卡一会儿"与"卡到以为挂了"之间的线：
 * 6×6 已经够看出峰形，再大就该改成后台 job + 进度上报，那是另一个工程。
 * 超了直接拒并把点数告诉用户 —— 不静默截断网格，截断过的热力图是错的图。
 */
export const SWEEP_MAX_POINTS = 36;

export interface SweepRunInput extends BacktestRunInput {
  /** 轴名是点路径，如 "择时.仓位档位.进攻" */
  grid: Record<string, unknown[]>;
  axisX: string;
  axisY: string;
}

/**
 * 跑参数扫描 → 热力图。
 *
 * 三条前置检查全在真跑之前做完，一条不过就整体拒：
 *   1. 点数上限（见 SWEEP_MAX_POINTS）；
 *   2. 两条轴必须都在 grid 里 —— 画的图必须是扫过的轴；
 *   3. **每个网格点的配置先全部校验一遍**，任一点非法就拒。
 *      不能边跑边跳过非法点：跳过会让网格悄悄变小，而热力图上的空洞
 *      看起来和"这里成绩差"没有区别。
 */
/** 扫描进度：第几个网格点、该点跑到第几个交易日 */
export interface SweepProgress {
  point: number;
  points: number;
  day: number;
  days: number;
  date: string;
  params: Record<string, unknown>;
}

/**
 * 异步版参数扫描。
 *
 * 每个网格点是一次**完整回测**：36 点 × 四年跨度 ≈ 3.7 小时（实测 0.38 秒/交易日）。
 * 同步跑意味着这几个小时里整个网站冻住，而且没有任何办法叫停 —— 这比单次回测那 6 分钟
 * 严重一个数量级。
 *
 * 结构上没有动 lib/backtest/optimizer.ts：先异步把所有网格点跑完存进 metrics 表，
 * 再把一个**纯查表**的 evaluate 交给现有的 optimize()。这样敏感度/峰值/警告那套逻辑
 * 仍然只有一份实现。refineRounds 默认 0，optimize 要的点恰好就是预先跑过的那些；
 * 万一将来开了 refine 而问到没跑过的点，就按契约破了抛错，不悄悄补一个空格子。
 */
export async function runSweepAsync(
  db: Db,
  i: SweepRunInput,
  a: { onProgress?: (p: SweepProgress) => void; signal?: { aborted: boolean } } = {}
): Promise<Avail<{ report: SweepReport }>> {
  const axes = Object.keys(i.grid);
  for (const ax of [i.axisX, i.axisY]) {
    if (!axes.includes(ax)) return unavailable(`轴 ${ax} 不在扫描网格里`, "只能画扫过的轴");
  }
  const points = gridPoints(i.grid as ParamGrid);
  if (points.length > SWEEP_MAX_POINTS) {
    return unavailable(
      `网格 ${points.length} 点，超过上限 ${SWEEP_MAX_POINTS}`,
      "每个点是一次完整回测。减少取值个数，或分两次扫"
    );
  }

  // 先把所有点的配置都校验出来，一次性失败，别跑到一半才发现
  const configs = new Map<string, StrategyConfig>();
  for (const p of points) {
    const r = overrideConfigParams(i.config, p);
    if (!r.ok) {
      return unavailable(
        `网格点 ${JSON.stringify(p)} 非法：${r.reason}`,
        "整体拒绝而不是跳过该点 —— 跳过会让网格悄悄变小，热力图上的空洞和'成绩差'看起来一样"
      );
    }
    configs.set(canonicalJson(p), r.config);
  }

  const reports = new Map<string, BacktestReport>();
  const metricsByKey = new Map<string, BacktestReport["metrics"]>();

  try {
    for (let n = 0; n < points.length; n++) {
      const key = canonicalJson(points[n]);
      const out = await replayAsync({
        from: i.from,
        to: i.to,
        viewFactory: (asOf: string) => createSqliteView(db, asOf),
        strategy: engine,
        config: configs.get(key)!,
        initialCash: i.initialCash,
        ...(i.constraints ? { constraints: i.constraints } : {}),
        generatedAt: i.generatedAt,
      }, {
        signal: a.signal,
        onProgress: d => a.onProgress?.({
          point: n + 1, points: points.length,
          day: d.done, days: d.total, date: d.date, params: points[n],
        }),
      });
      reports.set(key, out.report);
      metricsByKey.set(key, out.report.metrics);
    }

    const result = optimize({
      grid: i.grid as ParamGrid,
      evaluate: (params) => {
        const k = canonicalJson(params);
        const m = metricsByKey.get(k);
        // 预跑覆盖了全部网格点；问到别的说明 refine 被打开了，那是契约变更，不是可以吞掉的意外
        if (!m) throw new Error(`网格点未预跑：${k}（refine 不该在此启用）`);
        return m;
      },
    });

    const bestReport = reports.get(canonicalJson(result.best.params));
    if (!bestReport) throw new Error("最优点没有对应报告，覆盖率无从取得");

    return {
      available: true,
      report: {
        strategyId: bestReport.strategyId,
        strategyVersion: bestReport.strategyVersion,
        range: bestReport.range,
        constraints: bestReport.constraints,
        grid: i.grid,
        evaluated: result.evaluations.length,
        best: { params: result.best.params, metrics: result.best.metrics },
        heatmap: heatmap(result.evaluations, i.axisX, i.axisY),
        sensitivity: result.sensitivity,
        peak: result.peak,
        coverage: bestReport.coverage,
        warnings: result.warnings,
        generatedAt: i.generatedAt,
      },
    };
  } catch (e) {
    if (e instanceof ReplayAborted) throw e;
    return unavailable(
      `参数扫描失败：${(e as Error).message}`,
      "不返回部分热力图 —— 缺格的热力图会被当成'那片参数不好'读"
    );
  }
}

export function runSweep(db: Db, i: SweepRunInput): Avail<{ report: SweepReport }> {
  const axes = Object.keys(i.grid);
  for (const a of [i.axisX, i.axisY]) {
    if (!axes.includes(a)) return unavailable(`轴 ${a} 不在扫描网格里`, "只能画扫过的轴");
  }
  const points = gridPoints(i.grid as ParamGrid);
  if (points.length > SWEEP_MAX_POINTS) {
    return unavailable(
      `网格 ${points.length} 点，超过上限 ${SWEEP_MAX_POINTS}`,
      "每个点是一次完整回测且同步跑完。减少取值个数，或分两次扫"
    );
  }

  // 先把所有点的配置都校验出来，一次性失败，别跑到一半才发现
  const configs = new Map<string, StrategyConfig>();
  for (const p of points) {
    const r = overrideConfigParams(i.config, p);
    if (!r.ok) {
      return unavailable(
        `网格点 ${JSON.stringify(p)} 非法：${r.reason}`,
        "整体拒绝而不是跳过该点 —— 跳过会让网格悄悄变小，热力图上的空洞和'成绩差'看起来一样"
      );
    }
    configs.set(canonicalJson(p), r.config);
  }

  try {
    const reports = new Map<string, BacktestReport>();
    const result = optimize({
      grid: i.grid as ParamGrid,
      evaluate: (params) => {
        const key = canonicalJson(params);
        const cfg = configs.get(key);
        // optimize 的 refineRounds 默认 0，所以不会出现网格外的点；真出现就是契约破了
        if (!cfg) throw new Error(`网格点未预校验：${key}（refine 不该在此启用）`);
        const out = replay({
          from: i.from,
          to: i.to,
          viewFactory: (asOf: string) => createSqliteView(db, asOf),
          strategy: engine,
          config: cfg,
          initialCash: i.initialCash,
          ...(i.constraints ? { constraints: i.constraints } : {}),
          generatedAt: i.generatedAt,
        });
        reports.set(key, out.report);
        return out.report.metrics;
      },
    });

    const bestKey = canonicalJson(result.best.params);
    const bestReport = reports.get(bestKey);
    if (!bestReport) throw new Error("最优点没有对应报告，覆盖率无从取得");
    const h = heatmap(result.evaluations, i.axisX, i.axisY);

    return {
      available: true,
      report: {
        strategyId: bestReport.strategyId,
        strategyVersion: bestReport.strategyVersion,
        range: bestReport.range,
        constraints: bestReport.constraints,
        grid: i.grid,
        evaluated: result.evaluations.length,
        best: { params: result.best.params, metrics: result.best.metrics },
        heatmap: h,
        sensitivity: result.sensitivity,
        peak: result.peak,
        coverage: bestReport.coverage,
        warnings: result.warnings,
        generatedAt: i.generatedAt,
      },
    };
  } catch (e) {
    return unavailable(
      `参数扫描失败：${(e as Error).message}`,
      "不返回部分热力图 —— 缺格的热力图会被当成'那片参数不好'读"
    );
  }
}

/**
 * 跑一次回测。
 *
 * 约束一律用回测层的默认值（T+1 / 涨停买不进 / 跌停卖不出 / 停牌不成交 / 滑点 / 费率）——
 * 前端不提供关闭开关：关掉任何一条都会让回测虚高，而虚高的成绩决定投多少钱。
 */
export function runBacktest(db: Db, i: BacktestRunInput): Avail<{ report: BacktestReport }> {
  try {
    const out = replay({
      from: i.from,
      to: i.to,
      viewFactory: (asOf: string) => createSqliteView(db, asOf),
      strategy: engine,
      config: i.config,
      initialCash: i.initialCash,
      ...(i.constraints ? { constraints: i.constraints } : {}),
      generatedAt: i.generatedAt,
    });
    return { available: true, report: out.report };
  } catch (e) {
    return unavailable(
      `回测失败：${(e as Error).message}`,
      "不返回部分净值曲线 —— 一条不完整的净值曲线会被当成策略成绩读"
    );
  }
}
