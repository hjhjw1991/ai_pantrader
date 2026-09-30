import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "@/lib/config";

export type Db = Database.Database;

export function openDb(dbPath?: string): Db {
  const p = dbPath ?? getConfig().dbPath;
  const existed = fs.existsSync(p);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new Database(p);
  /**
   * 第一次打开就新建库是想要的（装机引导），**悄悄新建一个没人想要的库不是**。
   *
   * 实测：`.env.local` 里 PANTRADER_DATA_DIR=E:/project/PanTraderData/data，
   * 但只有 Next 会读 .env.local —— `pnpm job adjfix` 走的是默认路径
   * ~/PanTraderData/pantrader.db，于是"修了 0 行"看起来像"数据本来就是好的"，
   * 而真正的库还在坏着。不发声的话，这种错会以"命令跑成功但什么都没发生"的形式
   * 这里新建时会打印路径（见 console.warn），CLI 侧的补读见 lib/config.ts 的 loadCliEnv。
   */
  if (!existed && dbPath === undefined) {
    console.warn(
      `[数据库] 新建了库文件 ${p}\n` +
      `[数据库] 如果这是 CLI 跑出来的，多半是 PANTRADER_DATA_DIR 没传进来：` +
      `next 会读 .env.local，裸 tsx 不会。带上环境变量再跑：` +
      `PANTRADER_DATA_DIR=<你的数据目录> pnpm job <名字>`
    );
  }
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  return db;
}
