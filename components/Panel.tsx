import type { ReactNode } from "react";

/** 面板容器。标题栏右侧留一格给"数据时点/来源"，每块数据都要能自证新鲜度 */
export function Panel({
  title,
  hint,
  right,
  children,
  tone = "normal",
}: {
  title: string;
  hint?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  tone?: "normal" | "warn" | "danger";
}) {
  const border =
    tone === "danger"
      ? "border-danger/60"
      : tone === "warn"
        ? "border-warn/50"
        : "border-line";
  return (
    <section className={`bg-panel border ${border} rounded-sm`}>
      <header className="flex items-baseline gap-3 px-3 py-1.5 border-b border-line bg-panel-2">
        <h2 className="text-ink font-medium tracking-wide">{title}</h2>
        {hint ? <span className="text-ink-3 text-[11px]">{hint}</span> : null}
        <div className="ml-auto text-[11px] text-ink-3">{right}</div>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

/** 键值行。持仓/风控这类"标签 + 数字"的展示统一走它，数字列才对得齐 */
export function KV({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline gap-2 border-b border-line/50 py-1 last:border-0">
      <span className="text-ink-2 shrink-0">{label}</span>
      {hint ? <span className="text-ink-3 text-[11px]">{hint}</span> : null}
      <span className="ml-auto num">{children}</span>
    </div>
  );
}

export function Tag({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "up" | "down" | "warn" | "danger" | "info";
}) {
  const cls =
    tone === "up"
      ? "border-up/50 text-up"
      : tone === "down"
        ? "border-down/50 text-down"
        : tone === "warn"
          ? "border-warn/50 text-warn"
          : tone === "danger"
            ? "border-danger/60 text-danger"
            : tone === "info"
              ? "border-info/50 text-info"
              : "border-line-2 text-ink-2";
  return (
    <span className={`inline-block border ${cls} rounded px-1 text-[11px] leading-4 align-middle`}>
      {children}
    </span>
  );
}
