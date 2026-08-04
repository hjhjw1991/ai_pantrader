import type { Unavailable } from "@/lib/ui/derive";

/**
 * 空态。**这个组件是本项目最重要的一个组件**。
 *
 * 交易界面上一个假数字比一片空白危险得多 —— 用户会拿真钱照着它下单。
 * 所以凡是生产该数据的层还没建好，就走这里：明确说出"数据源不可用"、
 * 缺的是谁、补齐它需要什么。不显示 0、不显示占位样例、不显示"加载中"糊过去。
 */
export function EmptyState({
  u,
  compact = false,
}: {
  u: Unavailable;
  compact?: boolean;
}) {
  return (
    <div
      className={`border border-dashed border-line-2 rounded-sm bg-panel-2/40 ${
        compact ? "px-3 py-2" : "px-4 py-6"
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-warn text-[11px] border border-warn/50 rounded px-1">
          数据源不可用
        </span>
        <span className="text-ink-2">{u.reason}</span>
      </div>
      {u.needs ? <p className="mt-1.5 text-ink-3 text-[12px]">补齐条件：{u.needs}</p> : null}
      <p className="mt-1.5 text-ink-3 text-[11px]">
        此处不显示任何占位数值 —— 假数字会被当成真信号。
      </p>
    </div>
  );
}

/** 表有数据源但确实是 0 行（不是缺层）。措辞必须与上面区分开 */
export function NoRows({ what, hint }: { what: string; hint?: string }) {
  return (
    <div className="border border-dashed border-line rounded-sm px-3 py-3 text-ink-3">
      <span className="text-ink-2">{what}</span>
      {hint ? <span className="ml-2 text-[11px]">{hint}</span> : null}
    </div>
  );
}

/** 库文件都不存在：这不是"没数据"，是根本没接上库 */
export function NoDatabase({ path }: { path: string }) {
  return (
    <div className="border border-danger/60 bg-danger/5 rounded-sm px-4 py-4">
      <div className="text-danger font-medium">数据库不存在</div>
      <p className="mt-1 text-ink-2">
        期望路径：<code className="num text-ink">{path}</code>
      </p>
      <p className="mt-2 text-ink-3 text-[12px]">
        先跑 <code className="text-ink-2">pnpm migrate</code> 建库，再跑{" "}
        <code className="text-ink-2">pnpm bootstrap</code> 灌基础数据。
        路径可通过环境变量 <code className="text-ink-2">PANTRADER_DATA_DIR</code> 改。
      </p>
    </div>
  );
}
