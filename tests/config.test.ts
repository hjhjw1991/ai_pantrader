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

  /**
   * 这条盯的是一次真实的跨平台事故：原先 home 解析写成 `env.HOME ?? "/tmp"`，
   * 而 Windows 根本不设 HOME。用户把库拷到 C:\\Users\\名字\\PanTraderData，
   * 系统却去 C:\\tmp\\PanTraderData 开了个空库，界面显示"没有数据"。
   */
  it("Windows 没有 HOME 时用 USERPROFILE，不落到 /tmp", () => {
    const c = getConfig({ USERPROFILE: OTHER });
    // 非 Windows 上 USERPROFILE 不参与解析，会回落到真实 home —— 两种情况都不该是 /tmp
    expect(c.dataDir.startsWith(path.join(path.sep, "tmp"))).toBe(false);
    if (process.platform === "win32") {
      expect(c.dataDir).toBe(path.join(OTHER, "PanTraderData"));
    }
  });

  it("PANTRADER_DATA_DIR 压过一切，换机器换盘靠它", () => {
    const c = getConfig({ HOME, USERPROFILE: OTHER, PANTRADER_DATA_DIR: OTHER });
    expect(c.dataDir).toBe(OTHER);
  });

  it("什么都没给也不会把库放进临时目录", () => {
    expect(getConfig({}).dataDir.startsWith(path.join(path.sep, "tmp"))).toBe(false);
  });

  it("数据库路径绝不落在项目目录内", () => {
    const c = getConfig({ HOME });
    expect(c.dbPath.includes(path.join("pantrader", "lib"))).toBe(false);
    expect(c.dbPath.startsWith(path.join(HOME, "PanTraderData"))).toBe(true);
  });
});
