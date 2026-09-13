import { describe, it, expect } from "vitest";
import path from "node:path";
import { getConfig } from "@/lib/config";

/**
 * 期望值用 path.join 拼，不写死 "/" —— Windows 上 join 给的是反斜杠。
 * 写死斜杠会把"产品代码在 Windows 上行为正确"误报成失败（实测 CI 上就是这样）。
 */
const HOME = path.join(path.sep, "Users", "tester");
const OTHER = path.join(path.sep, "tmp", "pt");

describe("getConfig", () => {
  it("默认数据目录在 home 下的 PanTraderData", () => {
    const c = getConfig({ HOME });
    expect(c.dataDir).toBe(path.join(HOME, "PanTraderData"));
    expect(c.dbPath).toBe(path.join(HOME, "PanTraderData", "pantrader.db"));
    expect(c.snapshotDir).toBe(path.join(HOME, "PanTraderData", "snapshots"));
  });

  it("PANTRADER_DATA_DIR 可覆盖数据目录", () => {
    const c = getConfig({ HOME, PANTRADER_DATA_DIR: OTHER });
    expect(c.dataDir).toBe(OTHER);
    expect(c.dbPath).toBe(path.join(OTHER, "pantrader.db"));
  });

  it("数据库路径绝不落在项目目录内", () => {
    const c = getConfig({ HOME });
    expect(c.dbPath.includes(path.join("pantrader", "lib"))).toBe(false);
    expect(c.dbPath.startsWith(path.join(HOME, "PanTraderData"))).toBe(true);
  });
});
