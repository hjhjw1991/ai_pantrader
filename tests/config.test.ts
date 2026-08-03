import { describe, it, expect } from "vitest";
import { getConfig } from "@/lib/config";

describe("getConfig", () => {
  it("默认数据目录在 home 下的 PanTraderData", () => {
    const c = getConfig({ HOME: "/Users/tester" });
    expect(c.dataDir).toBe("/Users/tester/PanTraderData");
    expect(c.dbPath).toBe("/Users/tester/PanTraderData/pantrader.db");
    expect(c.snapshotDir).toBe("/Users/tester/PanTraderData/snapshots");
  });

  it("PANTRADER_DATA_DIR 可覆盖数据目录", () => {
    const c = getConfig({ HOME: "/Users/tester", PANTRADER_DATA_DIR: "/tmp/pt" });
    expect(c.dataDir).toBe("/tmp/pt");
    expect(c.dbPath).toBe("/tmp/pt/pantrader.db");
  });

  it("数据库路径绝不落在项目目录内", () => {
    const c = getConfig({ HOME: "/Users/tester" });
    expect(c.dbPath.includes("/pantrader/lib")).toBe(false);
    expect(c.dbPath.startsWith("/Users/tester/PanTraderData")).toBe(true);
  });
});
