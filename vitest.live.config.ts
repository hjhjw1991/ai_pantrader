import { defineConfig } from "vitest/config";
import path from "node:path";

// 独立 config：主 config 把 tests/live 放进 exclude，
// 而 --dir 不会覆盖 exclude，所以 live 测试必须单独一份配置。
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/live/**/*.test.ts"],
    testTimeout: 60_000,
  },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});
