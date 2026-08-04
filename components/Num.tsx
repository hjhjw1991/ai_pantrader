import {
  DASH,
  dirClass,
  fmtAmount,
  fmtInt,
  fmtPct,
  fmtPx,
  fmtQty,
  fmtRatio,
} from "@/lib/ui/format";

export type NumKind = "px" | "pct" | "ratio" | "amount" | "qty" | "int";

/**
 * 数字单元。右对齐 + 等宽 + tabular-nums，一列扫下来小数点不跳。
 *
 * `dir` 打开时按值正负上色（红涨绿跌）。默认关闭 —— 不是所有数字都有方向语义，
 * 给"持仓数量"上涨跌色只会制造噪音。
 */
export function Num({
  v,
  kind = "px",
  dir = false,
  digits,
  title,
}: {
  v: number | null | undefined;
  kind?: NumKind;
  dir?: boolean;
  digits?: number;
  title?: string;
}) {
  let text: string;
  switch (kind) {
    case "pct":
      text = fmtPct(v, digits ?? 2);
      break;
    case "ratio":
      text = fmtRatio(v, digits ?? 1);
      break;
    case "amount":
      text = fmtAmount(v);
      break;
    case "qty":
      text = fmtQty(v);
      break;
    case "int":
      text = fmtInt(v);
      break;
    default:
      text = fmtPx(v, digits ?? 2);
  }
  const cls = dir ? dirClass(v) : text === DASH ? "text-ink-3" : "text-ink";
  return (
    <span className={`num ${cls}`} title={title}>
      {text}
    </span>
  );
}

/** 表格里的数字格 */
export function TdNum(props: React.ComponentProps<typeof Num>) {
  return (
    <td className="num">
      <Num {...props} />
    </td>
  );
}
