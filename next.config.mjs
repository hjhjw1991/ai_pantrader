/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

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
