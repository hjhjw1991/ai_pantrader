import fs from "node:fs";
import path from "node:path";

/**
 * 策略 YAML 的写前备份。
 *
 * 为什么在 lib/backup/ 而不是 lib/strategy/：lib/strategy 是决策层，
 * tests/strategy/purity.test.ts 只放行 loader/package/registry 碰文件系统 ——
 * 那条断言守的是「决策逻辑不掺存储关切」，而备份纯属存储/运维关切。
 * 把它塞进白名单会为了一个文件削弱一条架构断言，所以搬到 .ptbak 导入导出的同一层。
 *
 * 为什么必须有：策略文件是**唯一真相源**，而它的价值大半在注释里 ——
 * 那些 `#` 记着每个阈值是哪次复盘换来的。原文编辑器一次全文替换就能把它们清空，
 * 而 git 只在用户自己 commit 过之后才救得回来（config/ 进 git，但工作区的未提交版本不进）。
 * 所以写之前先留一份，代价是几 KB，收益是"改错了还能拿回来"。
 *
 * 为什么落在 dataDir 而不是 config/strategies/ 旁边：
 *   1. config/strategies/ 是真相源目录，registry 按 `<id>.yaml` 约定读它，
 *      往里堆几十个备份会让 `git status` 长期脏着，人就开始忽略 git status；
 *   2. dataDir（默认 ~/PanTraderData）本来就是"不可再生、要独立备份、不被 git clean 删掉"
 *      那一类数据的家 —— 策略的历史版本正是这一类。
 *
 * **不做自动清理**：备份是用户的东西，几 KB 一份。程序替用户删历史版本，
 * 恰好会在他最需要翻旧版本的那次已经删掉了。
 */

/** 备份目录名，挂在 dataDir 下 */
export const BACKUP_DIR_NAME = "strategy-backups";

/**
 * 时间戳后缀：本地时间 `YYYYMMDD-HHmmss`。
 *
 * 用本地时间而不是 UTC / epoch：这个名字是给人看的，用户在文件列表里要能一眼
 * 对上"我下午三点那次改动"。字典序 = 时间序，所以 ls 出来天然按时间排。
 */
export function stampOf(now: Date): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}` +
    `-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`
  );
}

export interface BackupResult {
  /** 备份文件绝对路径 */
  path: string;
  bytes: number;
  stamp: string;
}

/**
 * 把 srcPath 复制一份到 backupDir，文件名 = 原名 + "." + 时间戳。
 *
 * 同一秒内连续两次保存会撞名，这里往后加 `-2`、`-3`：
 * 直接覆盖等于把用户上一次的原文吃掉，而这个函数存在的唯一理由就是别吃掉原文。
 *
 * now 由调用方传入而不是内部取 —— 这样测试测的是真实命名逻辑，不用打时钟补丁。
 */
export function backupFile(srcPath: string, backupDir: string, now: Date): BackupResult {
  const raw = fs.readFileSync(srcPath);        // 先读，读不出来就别建目录
  const stamp = stampOf(now);
  const base = `${path.basename(srcPath)}.${stamp}`;

  fs.mkdirSync(backupDir, { recursive: true });
  let target = path.join(backupDir, base);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(backupDir, `${base}-${n}`);

  fs.writeFileSync(target, raw);
  return { path: target, bytes: raw.byteLength, stamp };
}

/** 列出某个策略的备份，最新在前。界面要能看见"我有哪些版本可以退回去" */
export function listBackups(backupDir: string, fileName: string): Array<{ path: string; name: string; bytes: number; mtime: string }> {
  if (!fs.existsSync(backupDir)) return [];
  return fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith(`${fileName}.`))
    .sort()
    .reverse()
    .map((f) => {
      const p = path.join(backupDir, f);
      const st = fs.statSync(p);
      return { path: p, name: f, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString() };
    });
}
