import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // Vite/vitest 的 SSR 转译缓存默认落在 os.tmpdir()（本机是 AppData\Local\Temp），
  // 在受限环境里那个目录不可写，导入 next/server 的路由测试会偶发 EPERM。
  // 收回到工程内，既不依赖系统临时目录，也不会被 .gitignore 漏掉。
  cacheDir: ".vitest-cache",
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/live/**", "node_modules/**"],
    // 干净克隆上策略实文件还没播种，两个测试会失败。见该文件注释
    globalSetup: ["tests/global-setup.ts"],
  },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});
