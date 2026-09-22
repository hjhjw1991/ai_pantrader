import type { Db } from "@/lib/db";

/**
 * 周线 / 月线：从**后复权日线**本地聚合。
 *
 * 为什么不直接采东财的 klt=102/103：跨源的后复权算法不是同一套
 * （实测浦发 1999 年吻合、2005 年差 2.5%、2026 年差 61%，且比值随时间漂移）。
 * 而库里的日线是新浪的。混用会让日线 MACD 与周线 MACD 跑在两条不同的价格序列上 ——
 * 这种不一致不报错，只让多周期共振时对时错，查不出为什么。
 *
 * **只写已经走完的周/月。** 这条是硬约束，不是保守：
 * 一根还没走完的周线，其 key（该周最后一个交易日）明天就会变，
 * 于是同一周的 bar 会被后来的数据反复覆盖 —— 回测重放到周二时，
 * 读到的却是包含周五收盘的那根。那是最隐蔽的一类未来函数，
 * 因为它不越界读数据，而是让历史数据本身随时间改变。
 *
 * 代价是周线信号最多滞后到本周收盘。而周线 MACD 本来就是在周收盘评估的，
 * 盘中的半根周线既不稳定也没人用。
 */

export interface PeriodBar {
  date: string;   // 该周/该月最后一个交易日
  o: number; h: number; l: number; c: number;
  vol: number; amount: number;
}

/**
 * ISO 周键，形如 `2026-W29`。
 *
 * 用 ISO 周而不是"按交易日历数五天"：跨年周只有 ISO 周能算对 ——
 * 2026-12-28(周一) 到 2027-01-01(周五) 属于同一个 ISO 周 2026-W53，
 * 而按自然年切会把它劈成两半，造出两根残缺的周线。
 */
export function isoWeekKey(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  // ISO：周四决定这一周属于哪一年
  const day = (d.getUTCDay() + 6) % 7;            // 周一=0
  d.setUTCDate(d.getUTCDate() - day + 3);
  const year = d.getUTCFullYear();
  const firstThu = new Date(Date.UTC(year, 0, 4));
  const firstDay = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDay + 3);
  // round 不是 floor：两个时间戳都被挪到了各自那一周的**周四 UTC 午夜**，
  // 差值必然是 7 天的整数倍，用哪个都一样。选 round 是因为它能容忍浮点毛刺 ——
  // 万一差值算成 (n×7天 − ε)，floor 会整整错一周，而 round 不会。
  const week = 1 + Math.round((d.getTime() - firstThu.getTime()) / (7 * 86400000));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const monthKey = (date: string): string => date.slice(0, 7);

interface DailyRow {
  date: string; o: number; h: number; l: number; c: number;
  vol: number; amount: number; adj: number;
}

function aggregate(rows: DailyRow[], keyOf: (d: string) => string): PeriodBar[] {
  const groups = new Map<string, DailyRow[]>();
  const order: string[] = [];
  for (const r of rows) {
    const k = keyOf(r.date);
    let g = groups.get(k);
    if (g === undefined) { g = []; groups.set(k, g); order.push(k); }
    g.push(r);
  }

  const out: PeriodBar[] = [];
  // 最后一组一律丢掉：它是否走完取决于"有没有更晚的数据"，而我们手上没有，
  // 所以只能当它没走完。宁可少一根，不可造一根会被明天改写的。
  for (let i = 0; i < order.length - 1; i++) {
    const g = groups.get(order[i])!;
    const first = g[0], last = g[g.length - 1];
    out.push({
      date: last.date,
      o: first.o * first.adj,
      h: Math.max(...g.map(r => r.h * r.adj)),
      l: Math.min(...g.map(r => r.l * r.adj)),
      c: last.c * last.adj,
      // 量与额不复权：复权调的是价格。量乘上因子的话，"放量"判定会在除权日前后凭空翻倍
      vol: g.reduce((s, r) => s + r.vol, 0),
      amount: g.reduce((s, r) => s + r.amount, 0),
    });
  }
  return out;
}

/**
 * 重建指定标的的周线与月线。
 *
 * 全量重算而不是增量追加：增量要维护"上次算到哪"，而复权因子是会**回头改**的
 * （一次除权会把该票**全部历史**的因子重写一遍），增量必然算错。
 * 全量的代价可以接受 —— 一只票千余根日线，聚合是纯内存操作。
 */
export function buildPeriodBars(db: Db, codes: string[]): { codes: number; bars: number } {
  const read = db.prepare(
    `SELECT date, o, h, l, c, vol, amount, adj_factor AS adj
       FROM kline_daily
      WHERE code = ? AND o IS NOT NULL AND h IS NOT NULL
        AND l IS NOT NULL AND c IS NOT NULL
      ORDER BY date`
  );
  const del = db.prepare("DELETE FROM kline_period WHERE code = ? AND period = ?");
  const ins = db.prepare(
    `INSERT OR REPLACE INTO kline_period (code, period, date, o, h, l, c, vol, amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let bars = 0;
  for (const code of codes) {
    const rows = read.all(code).map((r: any) => ({
      date: String(r.date),
      o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c),
      vol: Number(r.vol ?? 0), amount: Number(r.amount ?? 0),
      // NULL 因子按 1：spec R1 说了有一段没有复权参照，读的人靠 adjFactor===1 判断
      adj: Number(r.adj ?? 1) || 1,
    }));
    if (rows.length === 0) continue;

    const w = aggregate(rows, isoWeekKey);
    const m = aggregate(rows, monthKey);
    db.transaction(() => {
      // 先删后插：全量重算时旧行必须清掉，否则改了复权因子之后
      // 老的（错的）周线会留在表里，而它的 key 恰好还在，永远不会被覆盖
      del.run(code, "W");
      del.run(code, "M");
      for (const b of w) ins.run(code, "W", b.date, b.o, b.h, b.l, b.c, b.vol, b.amount);
      for (const b of m) ins.run(code, "M", b.date, b.o, b.h, b.l, b.c, b.vol, b.amount);
    })();
    bars += w.length + m.length;
  }
  return { codes: codes.length, bars };
}
