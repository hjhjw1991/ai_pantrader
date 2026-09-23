import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { fetchHoldingChangeNotices, isReductionPlanTitle } from "@/lib/data/sources/eastmoney";
import { fetchHoldingPlans } from "@/lib/data/sources/ths";
import { recordGap, resolveGap, resolveGapsForKind, today } from "@/lib/data/gap";

export interface CollectPlanOpts {
  /** 公告日区间 */
  from: string;
  to: string;
  date?: string;
  pauseMs?: number;
}

export interface CollectPlanResult {
  notices: number;
  planCodes: number;
  plans: number;
  failed: Array<{ code: string; error: string }>;
}

/**
 * 股东减持计划采集，两段式：
 *
 *   1. 东财公告列表（f_node=7 持股变动）→ 按标题筛出**计划类**公告 → 得到代码清单
 *   2. 只对这些票抓同花顺 F10 事件页 → 模板句解析出起止日、上限、比例
 *
 * 为什么不全市场抓同花顺：它没有列表接口，全市场是 5000+ 次请求，
 * 而每天真正发预披露的只有二三十只。先用公告列表缩小到这二三十只，
 * 请求量少两个数量级，被封的风险也跟着降下来。
 *
 * F10 页上的计划**全部入库**（包括已过期的旧计划和增持计划）：
 * 源这层只管如实记录，"哪些还在执行窗口里"是下游按评估日判断的事。
 */
export async function collectReductionPlans(
  db: Db, clients: { em: SourceClient; ths: SourceClient }, o: CollectPlanOpts
): Promise<CollectPlanResult> {
  const date = o.date ?? today();
  const failed: CollectPlanResult["failed"] = [];

  let notices;
  try {
    notices = await fetchHoldingChangeNotices(clients.em, o.from, o.to);
    resolveGap(db, date, clients.em.source, "reduction_plan:notices");
  } catch (e) {
    const msg = (e as Error).message;
    recordGap(db, date, clients.em.source, "reduction_plan:notices", `公告列表拉取失败：${msg}`, true);
    failed.push({ code: "notices", error: msg });
    return { notices: 0, planCodes: 0, plans: 0, failed };
  }

  /**
   * 只对**在市股票**抓 F10。
   *
   * 东财"持股变动"栏目里混着可转债公告（110074 / 111009 …），同花顺没有债券的 F10 页，
   * 返回空响应体。实测 2026-09-23：3 只可转债的空响应就打开了同花顺的熔断，
   * 后面 591 只全部 "circuit open" —— 其中 556 只是真股票，全成了连带伤害。
   *
   * 证券表为空时不过滤：空表多半是还没灌清单，不该因此一只都不抓。
   */
  const known = new Set<string>(
    db.prepare("SELECT code FROM security WHERE delist_date IS NULL").all().map((r: any) => String(r.code))
  );
  const codes = [...new Set(
    notices.filter(n => isReductionPlanTitle(n.title)).map(n => n.code)
      .filter(c => known.size === 0 || known.has(c))
  )].sort();

  /**
   * first_seen 取最早：同一条计划第二次被看到时，不能把"我们知道它的日子"往后挪 ——
   * 那会让回放在那几天之间突然"忘记"一条早就公告了的减持。
   */
  const upsert = db.prepare(
    `INSERT INTO reduction_plan
       (code, actor, direction, start_date, end_date, max_shares, max_ratio, first_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(code, actor, start_date) DO UPDATE SET
       direction  = excluded.direction,
       end_date   = excluded.end_date,
       max_shares = excluded.max_shares,
       max_ratio  = excluded.max_ratio,
       first_seen = MIN(reduction_plan.first_seen, excluded.first_seen)`
  );

  let written = 0;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    try {
      const ps = await fetchHoldingPlans(clients.ths, code);
      db.transaction(() => {
        for (const p of ps) {
          upsert.run(code, p.actor, p.direction, p.startDate, p.endDate, p.maxShares, p.maxRatio, date);
        }
      })();
      written += ps.length;
      // F10 页每次都是整页重读，成功一次就覆盖了之前任何一次失败
      resolveGapsForKind(db, clients.ths.source, `reduction_plan:${code}`);
    } catch (e) {
      const msg = (e as Error).message;
      /**
       * 熔断打开就**立刻收手**。
       *
       * 继续循环的话，剩下每一只都会拿到 "circuit open"，各记一条缺口 ——
       * 缺口表里凭空多出几百条，而它们描述的是**同一件事**（主机被熔断了），
       * 不是几百只票各自出了问题。更糟的是那几百条会把真正的逐只失败淹掉。
       * 所以记一条聚合缺口、点名有多少只没抓到，交给下一晚重来。
       */
      if (/circuit open/.test(msg)) {
        const rest = codes.slice(i);
        for (const c of rest) failed.push({ code: c, error: msg });
        recordGap(db, date, clients.ths.source, "reduction_plan:circuit",
          `同花顺被熔断，${rest.length} 只计划类公告的票本轮没抓到（首只 ${rest[0]}），下一晚重来`, true);
        break;
      }
      recordGap(db, date, clients.ths.source, `reduction_plan:${code}`, msg, true);
      failed.push({ code, error: msg });
    }
    if ((o.pauseMs ?? 0) > 0) await new Promise(r => setTimeout(r, o.pauseMs));
  }
  // 整轮没被熔断，说明之前那次熔断造成的缺口已被这一轮覆盖
  if (!failed.some(f => /circuit open/.test(f.error))) {
    resolveGapsForKind(db, clients.ths.source, "reduction_plan:circuit");
  }

  return { notices: notices.length, planCodes: codes.length, plans: written, failed };
}
