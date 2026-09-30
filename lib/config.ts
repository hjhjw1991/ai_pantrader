import fsSync from "node:fs";
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

/**
 * CLI 补读 .env.local（Next 会自动读，裸 tsx 不会）。
 *
 * 为什么必须做：本机 `.env.local` 里 PANTRADER_DATA_DIR 指向 E:\project\PanTraderData\data，
 * 而 `pnpm job adjfix` 走的是默认路径 —— 于是它在另一个目录上**新建了一个空库**，
 * 回一句 `{"fixedRows":0}`，看上去像"数据本来就是好的"，真正的库里 5,411 行坏数据一行没动。
 * 命令成功但什么都没发生，是最难发现的一类错。
 *
 * 只补**没有设置过**的变量：命令行显式传的、CI 里的、以及 Next 传下来的，一律不覆盖。
 * 用 `process.loadEnvFile` 达不到这个要求（它会无条件覆盖），所以这里自己解析。
 */
export function loadCliEnv(file = ".env.local"): void {
  try {
    const p = path.resolve(process.cwd(), file);
    if (!fsSync.existsSync(p)) return;
    for (const line of fsSync.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m || m[1] === "") continue;
      let v = m[2].trim();
      // 去掉成对引号；# 行内注释只在值没被引号包起来时才认
      if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
      else {
        const hash = v.indexOf(" #");
        if (hash >= 0) v = v.slice(0, hash).trim();
      }
      if (process.env[m[1]] === undefined && v !== "") process.env[m[1]] = v;
    }
  } catch {
    // 读不到就当没有：网页那边本来也不靠这一步，CLI 顶多退回默认路径
  }
}
