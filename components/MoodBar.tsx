import { Panel, Tag } from "@/components/Panel";
import type { IntradayMood } from "@/lib/sentiment/intraday";

/**
 * 盘中情绪条。
 *
 * 它显示的东西与页面上方那张决策卡**不是同一套**：决策卡的档位、盘面强度、情绪温度
 * 走日线截面，当日日线要 22:00 才落库，所以盘中看到的永远是昨收的结论。
 * 这里走 quote_snapshot（每 5 分钟一次的全市场快照），回答的是另一件事：
 *
 *   **从开盘到现在，市场是在好转还是在恶化。**
 *
 * 买入候选不因这里变化 —— 推荐理由来自昨日主线与昨日涨停池，那些盘中本来也算不出来。
 * 变的是"当下该不该动手、手里的该不该留"。
 *
 * 陈旧（stale）必须显式标出：收盘后最后一根快照还在库里，不标就会拿 15:00 的状态
 * 当"现在"，而那正是最容易误判的时候。
 */

const pct1 = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}pp`;
const pct2 = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

/** 温度分 → 颜色。分位来自实测分布：34 个交易日、2072 个时点 */
function tempClass(t: number): string {
  if (t >= 70) return "text-up";
  if (t <= 30) return "text-down";
  return "text-ink";
}

function tempWord(t: number): string {
  if (t >= 80) return "过热";
  if (t >= 65) return "偏强";
  if (t >= 35) return "中性";
  if (t >= 20) return "偏弱";
  return "冰点";
}

export function MoodBar({ mood }: { mood: IntradayMood | null }) {
  if (mood === null || mood.now === null) return null;
  const n = mood.now;
  const d30 = mood.delta30;
  const dOp = mood.deltaOpen;

  const tone = mood.signals.some(s => s.level === "critical")
    ? "danger"
    : mood.signals.some(s => s.level === "warn")
      ? "warn"
      : "normal";

  return (
    <Panel
      title="盘中情绪"
      tone={tone}
      hint="快照实时算，与上方决策卡（日线口径、昨收结论）不是同一套"
      right={
        mood.stale
          ? <span className="text-warn">快照已陈旧 · 非盘中</span>
          : <span>{n.ts.slice(11, 16)} 采集 · 今日 {mood.points} 个时点</span>
      }
    >
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 px-1 py-1">
        <span className="text-ink-3 text-[11px]">温度</span>
        <span className={`num text-lg font-medium ${tempClass(mood.temp ?? 50)}`}>
          {mood.temp === null ? "—" : mood.temp.toFixed(0)}
        </span>
        <span className={`text-[12px] ${tempClass(mood.temp ?? 50)}`}>
          {tempWord(mood.temp ?? 50)}
        </span>

        <span className="text-ink-3 text-[11px] ml-2">上涨占比</span>
        <span className="num text-ink">{(n.breadth * 100).toFixed(0)}%</span>

        <span className="text-ink-3 text-[11px] ml-2">涨跌家数</span>
        <span className="num">
          <span className="text-up">{n.up}</span>
          <span className="text-ink-3"> / </span>
          <span className="text-down">{n.down}</span>
        </span>

        <span className="text-ink-3 text-[11px] ml-2">涨停 / 跌停</span>
        <span className="num">
          <span className="text-up">{n.limitUp}</span>
          <span className="text-ink-3"> / </span>
          <span className={n.limitDown > 0 ? "text-down" : "text-ink-3"}>{n.limitDown}</span>
        </span>

        <span className="text-ink-3 text-[11px] ml-2">平均涨幅</span>
        <span className={`num ${n.avgPct >= 0 ? "text-up" : "text-down"}`}>{pct2(n.avgPct)}</span>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 px-1 pb-1 text-[11px] text-ink-3">
        <span>近 30 分钟</span>
        {d30 === null ? (
          <span>开盘未满 30 分钟</span>
        ) : (
          <span className="num">
            上涨占比 <span className={d30.breadth >= 0 ? "text-up" : "text-down"}>{pct1(d30.breadth)}</span>
            <span className="mx-1">·</span>
            平均涨幅 <span className={d30.avgPct >= 0 ? "text-up" : "text-down"}>{pct2(d30.avgPct)}</span>
          </span>
        )}
        {dOp === null ? null : (
          <>
            <span className="ml-2">自开盘</span>
            <span className="num">
              上涨占比 <span className={dOp.breadth >= 0 ? "text-up" : "text-down"}>{pct1(dOp.breadth)}</span>
              <span className="mx-1">·</span>
              平均涨幅 <span className={dOp.avgPct >= 0 ? "text-up" : "text-down"}>{pct2(dOp.avgPct)}</span>
            </span>
          </>
        )}
      </div>

      {mood.signals.length > 0 ? (
        <ul className="flex flex-col gap-1 px-1 pb-1">
          {mood.signals.map((s, i) => (
            <li
              key={i}
              className={`px-2 py-1 border rounded-sm ${
                s.level === "critical"
                  ? "border-danger/60 bg-danger/10"
                  : s.level === "warn"
                    ? "border-warn/50 bg-warn/10"
                    : "border-line bg-panel-2"
              }`}
            >
              <Tag tone={s.level === "critical" ? "danger" : s.level === "warn" ? "warn" : "info"}>
                {s.level === "critical" ? "严重" : s.level === "warn" ? "警告" : "提示"}
              </Tag>
              <span className="ml-2 text-ink">{s.title}</span>
              <span className="ml-2 text-ink-2">{s.body}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-1 pb-1 text-[11px] text-ink-3">
          近 30 分钟无明显转变。阈值取实测 30 分钟窗口的 p05/p95 分位，
          约每 20 个窗口响一次 —— 频繁弹窗等于没有弹窗。
        </p>
      )}
    </Panel>
  );
}

/** 相对强度标签：个股涨幅减市场平均。给持仓与观察池的每一行用 */
export function VsMarketTag({ vs, weak }: { vs: number | null; weak: boolean }) {
  if (vs === null) return <span className="text-ink-3">—</span>;
  if (weak && vs < -1) {
    return (
      <Tag tone="danger">
        跑输 {vs.toFixed(1)}pp
      </Tag>
    );
  }
  if (vs >= 1) return <Tag tone="up">跑赢 {vs.toFixed(1)}pp</Tag>;
  if (vs <= -1) return <Tag tone="down">跑输 {Math.abs(vs).toFixed(1)}pp</Tag>;
  return <span className="num text-ink-3">{vs >= 0 ? "+" : ""}{vs.toFixed(1)}</span>;
}
