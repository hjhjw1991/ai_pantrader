/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // 构建产物目录可覆盖。默认 .next；给它一个开关是为了能在 dev 跑着的时候
  // 另建一份生产产物做对比 —— 两个进程共用 .next 会互相把对方的产物清掉
  // （踩过：dev 与 build 同时跑，页面直接 404）。
  distDir: process.env.PANTRADER_DIST_DIR ?? ".next",

  // better-sqlite3 是原生模块（.node 二进制），打进 server bundle 后运行时找不到二进制。
  // 必须让 Node 自己 require —— 前端所有 DB 读取都在 server component / route handler 里，
  // 走的就是这条路径。
  experimental: {
    // 让 instrumentation.ts 在服务启动时执行（Next 14 需显式开启）——
    // 这是"跑起系统就自动采集"的钩子
    instrumentationHook: true,
    serverComponentsExternalPackages: ["better-sqlite3"],
  },

  // 本机单人工具，不需要遥测；也没装 eslint，构建时别去找它
  eslint: { ignoreDuringBuilds: true },

  // 类型错误必须炸构建。这是交易界面，编译期能抓的错不留到运行期
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
