import path from "node:path";

export interface PanConfig {
  dataDir: string;
  dbPath: string;
  snapshotDir: string;
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): PanConfig {
  const home = env.HOME ?? "/tmp";
  const dataDir = env.PANTRADER_DATA_DIR ?? path.join(home, "PanTraderData");
  return {
    dataDir,
    dbPath: path.join(dataDir, "pantrader.db"),
    snapshotDir: path.join(dataDir, "snapshots"),
  };
}
