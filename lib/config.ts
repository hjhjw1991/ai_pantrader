import os from "node:os";
import path from "node:path";

export interface PanConfig {
  dataDir: string;
  dbPath: string;
  snapshotDir: string;
}

/**
 * 解析用户主目录。
 *
 * Windows 上 **HOME 通常不存在** —— 系统用的是 USERPROFILE。原先写成
 * `env.HOME ?? "/tmp"`，于是 Windows 上悄悄落到 `C:\tmp\PanTraderData`：
 * 用户把 2.6 GB 的库拷到 `C:\Users\<名字>\PanTraderData`，系统却在另一个
 * 目录开了个空库，界面显示"没有数据"，而数据一直好好躺在那儿。
 *
 * 就算 Windows 上有 HOME 也不能优先信它：git-bash / MSYS 会把它设成
 * `/c/Users/xxx` 这种 POSIX 风格路径，`path.join` 拼出来是错的盘符语义。
 *
 * 兜底用 os.homedir() 而不是 "/tmp"：把交易台账放进一个会被系统清理的
 * 临时目录，是比"找不到目录"更坏的失败方式 —— 它要等到数据没了才暴露。
 */
function resolveHome(env: Partial<NodeJS.ProcessEnv>): string {
  if (process.platform === "win32") {
    return env.USERPROFILE ?? env.HOME ?? os.homedir();
  }
  return env.HOME ?? os.homedir();
}

/**
 * env 用 Partial：这里只读 HOME / USERPROFILE / PANTRADER_DATA_DIR，
 * 不该要求调用方凑出完整环境。
 * Next 引入的 next-env.d.ts 把 NODE_ENV 变成 ProcessEnv 的必填项，
 * 用完整 ProcessEnv 做参数类型会让 `getConfig({ HOME: "/x" })` 这种正常调用编译不过。
 *
 * PANTRADER_DATA_DIR 永远优先：换机器、换盘、把数据放到移动硬盘都靠它。
 */
export function getConfig(env: Partial<NodeJS.ProcessEnv> = process.env): PanConfig {
  const dataDir = env.PANTRADER_DATA_DIR ?? path.join(resolveHome(env), "PanTraderData");
  return {
    dataDir,
    dbPath: path.join(dataDir, "pantrader.db"),
    snapshotDir: path.join(dataDir, "snapshots"),
  };
}
