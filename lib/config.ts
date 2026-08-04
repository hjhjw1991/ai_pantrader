import path from "node:path";

export interface PanConfig {
  dataDir: string;
  dbPath: string;
  snapshotDir: string;
}

/**
 * env 用 Partial：这里只读 HOME 与 PANTRADER_DATA_DIR，不该要求调用方凑出完整环境。
 * Next 引入的 next-env.d.ts 把 NODE_ENV 变成 ProcessEnv 的必填项，
 * 用完整 ProcessEnv 做参数类型会让 `getConfig({ HOME: "/x" })` 这种正常调用编译不过。
 */
export function getConfig(env: Partial<NodeJS.ProcessEnv> = process.env): PanConfig {
  const home = env.HOME ?? "/tmp";
  const dataDir = env.PANTRADER_DATA_DIR ?? path.join(home, "PanTraderData");
  return {
    dataDir,
    dbPath: path.join(dataDir, "pantrader.db"),
    snapshotDir: path.join(dataDir, "snapshots"),
  };
}
