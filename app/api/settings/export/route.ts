import path from "node:path";
import { err, ok, parseBody } from "@/lib/ui/api";
import { ExportSchema } from "@/lib/ui/validate";
import { getConfig } from "@/lib/config";
import { exportBak } from "@/lib/backup/export";
import { writeDb } from "@/lib/ui/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 导出 .ptbak（VACUUM INTO 一致性快照 + 快照目录）。
 *
 * 输出目录**固定**在 dataDir 下，文件名只允许 [A-Za-z0-9._-]：
 * 从浏览器传进来的任意路径能把文件写到磁盘上任何地方，这个便利不值得要。
 *
 * 用 openDb（可写连接）：VACUUM INTO 在只读连接上不可用。
 */
export async function POST(req: Request) {
  const b = await parseBody(req, ExportSchema);
  if (!b.ok) return b.res;

  const cfg = getConfig();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = b.value.fileName ?? `pantrader-${stamp}.ptbak`;
  const outPath = path.join(cfg.dataDir, name);
  // 双保险：schema 已禁掉路径分隔符，这里再确认结果没跳出 dataDir
  if (path.dirname(outPath) !== cfg.dataDir) return err(400, "输出路径必须位于 dataDir 内");

  try {
    const db = writeDb();
    const meta = await exportBak(db, cfg.dbPath, outPath);
    return ok({ outPath, meta });
  } catch (e) {
    return err(500, `导出失败：${(e as Error).message}`);
  }
}
