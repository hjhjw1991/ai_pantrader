import type { Db } from "@/lib/db";

/**
 * 由行业快照差分出时间区间。
 *
 * 快照表回答的是"某次采集时这只票属于哪个行业"，而回测要问的是
 * "2024-03-15 这天它属于哪个行业"。后者只能靠相邻快照比对推出来 ——
 * 申万把变更轨迹的对外渠道停了（带结束日期的文件冻结在 2022-03-25 且该列全空），
 * 这条路是唯一的。
 *
 * **变更日期是精确的，不打折。** 申万的 beginningdate 给的就是计入日，
 * 所以差分只负责两件事：发现"变了"，以及"上一个是谁"。日期本身来自 beginningdate。
 * 周频快照的 ≤7 天滞后影响的是**发现**的及时性，不是区间端点的准确性 ——
 * 这一点当初设计时估保守了，实际比预期好。
 *
 * 不补 beginningdate 之前那一段：那段是真的不知道。74.6% 的票 beginningdate
 * 压在 2021-12-13（2021 版基期），在那之前申万这套分类根本不存在，
 * 硬补一段等于用今天的行业定义去解释历史，而那正是要避免的未来函数。
 */

export interface IndustrySpan {
  code: string;
  level: number;
  indexCode: string;
  indexName: string;
  fromDate: string;
  /** null = 至今有效。区间按 [fromDate, toDate) 半开理解 */
  toDate: string | null;
}

interface SnapRow {
  snapshotDate: string;
  indexCode: string;
  indexName: string;
  beginningDate: string;
}

/**
 * 一只票一个层级的快照序列 → 区间序列。
 *
 * 只在 index_code 发生变化时切段。同一个行业连采 N 次仍然是一段 ——
 * 按快照日切段的话，采得越勤区间越碎，而碎片之间并没有任何真实事件。
 */
export function spansFrom(rows: SnapRow[]): Array<{ indexCode: string; indexName: string; fromDate: string; toDate: string | null }> {
  const sorted = [...rows].sort((a, b) =>
    a.snapshotDate < b.snapshotDate ? -1 : a.snapshotDate > b.snapshotDate ? 1 : 0);
  if (sorted.length === 0) return [];

  const out: Array<{ indexCode: string; indexName: string; fromDate: string; toDate: string | null }> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && last.indexCode === r.indexCode) continue;   // 没变，不切
    if (last !== undefined) {
      // 上一段在新行业的**计入日**收口，而不是在发现它的那次快照日收口
      last.toDate = r.beginningDate;
    }
    out.push({
      indexCode: r.indexCode, indexName: r.indexName,
      fromDate: r.beginningDate, toDate: null,
    });
  }
  return out;
}

/**
 * 重建行业区间表。
 *
 * 全量重算而不是增量：区间的端点会**回头改**（新一张快照能让上一段收口），
 * 增量追加必然留下一堆永远不收口的开区间。
 * 重算是纯本地操作，不打任何源。
 */
export function buildIndustrySpans(db: Db, codes?: string[]): { codes: number; spans: number } {
  const targets: string[] = codes ?? db.prepare(
    "SELECT DISTINCT code FROM sw_industry_snapshot ORDER BY code"
  ).all().map((r: any) => String(r.code));

  const read = db.prepare(
    `SELECT snapshot_date, level, index_code, index_name, beginning_date
       FROM sw_industry_snapshot WHERE code = ? ORDER BY level, snapshot_date`
  );
  const del = db.prepare("DELETE FROM sw_industry_span WHERE code = ?");
  const ins = db.prepare(
    `INSERT OR REPLACE INTO sw_industry_span
       (code, level, index_code, index_name, from_date, to_date)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  let total = 0;
  for (const code of targets) {
    const rows: any[] = read.all(code);
    const byLevel = new Map<number, SnapRow[]>();
    for (const r of rows) {
      const lv = Number(r.level);
      let g = byLevel.get(lv);
      if (g === undefined) { g = []; byLevel.set(lv, g); }
      g.push({
        snapshotDate: String(r.snapshot_date),
        indexCode: String(r.index_code),
        indexName: String(r.index_name),
        beginningDate: String(r.beginning_date ?? ""),
      });
    }

    db.transaction(() => {
      // 先删后插：新快照会让旧的开区间收口，而收口后的行主键不变、
      // 旧行也不会被"覆盖"——只靠 INSERT OR REPLACE 会把没收口的那版留在表里
      del.run(code);
      for (const [level, g] of byLevel) {
        for (const s of spansFrom(g)) {
          ins.run(code, level, s.indexCode, s.indexName, s.fromDate, s.toDate);
          total++;
        }
      }
    })();
  }
  return { codes: targets.length, spans: total };
}
