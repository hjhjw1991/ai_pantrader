"use client";

/**
 * 日期输入。用原生 `<input type="date">`，不引第三方日历组件 ——
 * 这个项目的依赖表刻意很短（next/react/zod/better-sqlite3/js-yaml），
 * 为一个日期选择器引一整套 UI 库不划算；原生控件还自带键盘操作与本地化。
 *
 * 原生 date 控件的 value 恰好就是 `YYYY-MM-DD`，与 DateSchema 的正则、
 * 与库里 `date` 列的存法完全一致，所以不需要任何格式转换 ——
 * 有转换的地方迟早会在时区上出错（把本地午夜转成 UTC 会整体差一天）。
 *
 * min / max 传的是**库里真有数据的区间**，不是随便给的上下界：
 * 回测选到日历之外的日期，engine 拿不到交易日，跑出来的是一份空成绩单，
 * 而空成绩单会被当成"这个策略不交易"来读。选不到，比选到再解释便宜。
 */
export function DateInput({
  value,
  onChange,
  min,
  max,
  className = "",
  required,
}: {
  value: string;
  onChange: (v: string) => void;
  /** 可选下界，空串/undefined 表示不限（库里没有日历时就是这种情况） */
  min?: string;
  max?: string;
  className?: string;
  required?: boolean;
}) {
  return (
    <input
      type="date"
      // 不用 .num：等宽右对齐是给数字列用的，日期控件右对齐会把日历图标挤到文字里
      className={
        "bg-panel-2 border border-line-2 rounded-sm px-2 py-1 text-ink " +
        "font-mono text-[12px] " + className
      }
      value={value}
      min={min === "" ? undefined : min}
      max={max === "" ? undefined : max}
      required={required}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
