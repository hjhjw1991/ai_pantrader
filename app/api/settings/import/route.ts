import fs from "node:fs";
import { err, ok, parseBody } from "@/lib/ui/api";
import { ImportDryRunSchema } from "@/lib/ui/validate";
import { getConfig } from "@/lib/config";
import { importBak } from "@/lib/backup/import";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 导入 —— **只做 dry-run**。
 *
 * replace 会整库替换、merge 会按 prefer 覆盖字段；这两种都能一次抹掉本机全部
 * 不可再生资产（分钟线、涨停池、台账）。这种操作不该由一次浏览器点击触发，
 * 必须在终端里显式执行、看得见输出：
 *
 *     pnpm db:import <file.ptbak> --mode replace
 *
 * 这里只回答"如果导入会发生什么"。
 */
export async function POST(req: Request) {
  const b = await parseBody(req, ImportDryRunSchema);
  if (!b.ok) return b.res;
  if (!fs.existsSync(b.value.bakPath)) return err(400, `文件不存在：${b.value.bakPath}`);

  try {
    const report = await importBak(b.value.bakPath, getConfig().dbPath, { mode: "dry-run" });
    return ok({
      report,
      note: "dry-run 未落盘。replace / merge 请用 CLI：pnpm db:import <file> --mode <replace|merge>",
    });
  } catch (e) {
    return err(400, `包校验失败：${(e as Error).message}`);
  }
}
