import { err, ok, parseBody } from "@/lib/ui/api";
import { ManualFillSchema } from "@/lib/ui/validate";
import { accountExists, recordManualFill } from "@/lib/ui/mutations";
import { writeDb } from "@/lib/ui/db";
import { executionMode } from "@/lib/ui/status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 回填一笔**已经在券商 App 里成交**的交易（spec §12 ManualBroker）。
 *
 * 这不是下单接口。系统里不存在下单接口 —— 红线是券商权限到位且 paper 跑满
 * 一个季度之前不自动下单（spec §18.2）。这条路由只把既成事实记下来。
 *
 * 账户必须先存在：自动建账户会让"记错账户"这类错误静默通过，
 * 而不同账户的止损规则可以完全不同（一个按价格比例、一个按逻辑破坏），套错就是纪律失效。
 */
export async function POST(req: Request) {
  const b = await parseBody(req, ManualFillSchema);
  if (!b.ok) return b.res;
  const f = b.value;

  const db = writeDb();
  if (!accountExists(db, f.accountId)) {
    return err(400, `账户不存在：${f.accountId}。先在设置页建账户，再回填成交`);
  }
  try {
    const r = recordManualFill(db, f);
    return ok({
      ...r,
      mode: executionMode(),
      note: "已记录为 manual 成交。系统不下单，此接口只登记既成事实",
    });
  } catch (e) {
    // 卖超持仓这类错误必须原样抛给用户，不静默截断数量
    return err(400, (e as Error).message);
  }
}
