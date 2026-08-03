import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/live/**", "node_modules/**"],
  },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});
