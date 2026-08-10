import type { Unavailable } from "@/lib/ui/derive";
import type { DbUnavailable } from "@/lib/ui/db";

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

/**
 * 接不上库：这不是"没数据"，是根本没接上库。
 *
 * 文案必须分两种。"库不在"要人去建库，"库打不开"要人去修环境 ——
 * 把后者说成前者，人会拿着正确的路径查一整圈（真发生过，见 lib/ui/db.ts 注释）。
 */
export function NoDatabase({ why }: { why: DbUnavailable }) {
  const missing = why.kind === "missing";
  return (
    <div className="border border-danger/60 bg-danger/5 rounded-sm px-4 py-4">
      <div className="text-danger font-medium">
        {missing ? "数据库不存在" : "数据库打不开（文件在，连接失败）"}
      </div>
      <p className="mt-1 text-ink-2">
        {missing ? "期望路径" : "库文件路径"}：<code className="num text-ink">{why.path}</code>
      </p>
      {missing ? (
        <p className="mt-2 text-ink-3 text-[12px]">
          先跑 <code className="text-ink-2">pnpm migrate</code> 建库，再跑{" "}
          <code className="text-ink-2">pnpm bootstrap</code> 灌基础数据。
          路径可通过环境变量 <code className="text-ink-2">PANTRADER_DATA_DIR</code> 改。
        </p>
      ) : (
        <>
          <pre className="mt-2 whitespace-pre-wrap break-all text-[11px] text-ink-2 bg-panel-2/60 border border-line-2 rounded px-2 py-1.5">
            {why.detail}
          </pre>
          <p className="mt-2 text-ink-3 text-[12px]">
            路径是对的，别去查路径。报错里出现 <code className="text-ink-2">NODE_MODULE_VERSION</code>{" "}
            就是 Node 版本与 better-sqlite3 预编译包不匹配：本项目按 Node 22 部署（launchd/计划任务里写死的也是它），
            执行 <code className="text-ink-2">nvm use 22</code> 后重启即可。
          </p>
        </>
      )}
    </div>
  );
}
