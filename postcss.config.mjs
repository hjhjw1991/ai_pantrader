/**
 * Tailwind v4 的官方 PostCSS 插件。
 *
 * 这里曾经挂着一个自建适配器（lib/ui/tailwind-postcss-shim.cjs），
 * 因为当时 @tailwindcss/postcss 不在依赖里、且写这部分的人不能加依赖。
 * 那个适配器自带一个手写的 class 扫描器，代价是**所有 className 必须是静态字面量**，
 * 一旦有人写运行时拼接的类名，样式会静默消失 —— 这种坑不值得留着。
 * 依赖补上后换回官方插件，适配器已删除。
 *
 * autoprefixer 不再需要：Tailwind v4 内部已经处理前缀。
 */
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
