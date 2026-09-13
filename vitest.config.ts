import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/live/**", "node_modules/**"],
    // 干净克隆上策略实文件还没播种，两个测试会失败。见该文件注释
    globalSetup: ["tests/global-setup.ts"],
  },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});
