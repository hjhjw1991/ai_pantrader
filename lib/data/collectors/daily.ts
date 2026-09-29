import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { fetchSinaKline, fetchSinaKlineBySymbol, SourceNoData } from "@/lib/data/sources/sina";
import type { IndexDef } from "@/lib/data/indices";
import { recordGap, resolveGapsForKind, today } from "@/lib/data/gap";

/**
 * 无序列代码占比的告警阈值。
 *
 * 单只票没有 K 线是正常的（新股、定向转让代码），但限频也可能表现成大面积无数据。
 * 两者靠"是不是一小撮"来区分：实测正常水位是 14/5888 ≈ 0.24%。
 * 超过 5% 就不再当"正常缺序列"，记缺口告警 —— 宁可误报，不可把一次限频
 * 事故当成"这 3000 只票本来就没数据"咽下去。
 */
const NO_DATA_ALERT_RATIO = 0.05;
const NO_DATA_ALERT_MIN_BATCH = 100;

/**
 * 日线。可回补（新浪 scale=240 一次 1023 根，约到 2022-05），
 * 所以失败记的是 recoverable gap，夜间 job 会重来。
 *
 * 注：新浪日线不复权，adj_factor 保留既有值，复权因子计算属于 M0 之外（见 spec R1）。
 *
 * **新一根的因子必须向前顺延，不能落回默认 1.0**（2026-09-27 修）。
 * 复权因子是台阶函数：两次除权之间恒定不变。所以"上一根是什么因子，今天就是什么因子"。
 * 但回填任务（collectors/adjust-factor.ts）的 tail 语句是 `WHERE date >= 起点`，
 * 只覆盖**它跑的那一刻已存在**的行；之后日线采集新插入的行轮不到它，
 * 于是最新一根永远是 1.0，直到下一次回填——而回填一旦因断网没跑成，就一直挂着。
 *
 * 后果不是"最新一根偏一点"，而是**整张图全错**：
 * 前复权价 = 后复权价 ÷ **最新一根的因子**（见 lib/ui/adapters/chart.ts）。
 * 基准因子被写成 1，等于没做归一化，历史整段按后复权价原样显示。
 * 实测太极实业 600667：2026-09-23 真实收盘 20.59，图上显示成 119.50（× 5.80），
 * 而 9-24 那根因为因子恰好是 1 反而显示成对的 19.41 —— 一眼看上去像"只有一天是对的"。
 * 同一处还会污染结构位与 ATR（factors/structure.ts 也用最新一根的因子做归一化）。
 *
 * COALESCE 是短路求值的：绝大多数行是既有行，第一个子查询就命中，
 * 顺延子查询不会执行，没有额外开销。
 */
export async function collectDaily(
  db: Db, client: SourceClient, codes: string[], datalen: number
): Promise<{ written: number; failed: string[]; noData: string[]; adjFixed: number }> {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO kline_daily (code, date, o, h, l, c, vol, amount, adj_factor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(
       (SELECT adj_factor FROM kline_daily WHERE code = ? AND date = ?),
       (SELECT adj_factor FROM kline_daily WHERE code = ? AND date < ?
          ORDER BY date DESC LIMIT 1),
       1.0))`
  );
  let written = 0; const failed: string[] = []; const noData: string[] = [];

  for (const code of codes) {
    try {
      const bars = await fetchSinaKline(client, code, 240, datalen);
      db.transaction(() => {
        for (const b of bars) {
          const d = b.ts.slice(0, 10);
          stmt.run(code, d, b.o, b.h, b.l, b.c, b.vol, null, code, d, code, d);
        }
      })();
      written += bars.length;
      /**
       * 拉到了就把这只票**所有日期**的未解决缺口销掉。
       *
       * 不能只销"今天"：缺口记在当初失败的那一天，而一次拉取覆盖 1023 个交易日，
       * 成功即意味着那只票的历史整段都填上了。
       *
       * 不销的后果是实测出来的 —— 库里 5 条未解决的日线缺口，4 条数据早就补上了，
       * 只是没人销账。于是 selfcheck 的 unresolvedGaps 只增不减，
       * 而回测里 hasGap(date) 是不带 kind 调的：那天只要挂着任何一条未解决缺口，
       * 整个交易日对全部 5,888 只票直接跳过。一只票的一次 timeout，
       * 会让此后所有回测永久少掉一整天。
       */
      resolveGapsForKind(db, client.source, `kline_daily:${code}`);
    } catch (e: any) {
      if (e instanceof SourceNoData) {
        // 源上没有这条序列，不是缺口：记成缺口就永远回补不掉
        noData.push(code);
        continue;
      }
      failed.push(code);
      recordGap(db, today(), client.source, `kline_daily:${code}`, e.message, true);
    }
  }

  const adjFixed = repairTrailingAdjFactors(db, codes);

  if (codes.length >= NO_DATA_ALERT_MIN_BATCH &&
      noData.length / codes.length > NO_DATA_ALERT_RATIO) {
    recordGap(
      db, today(), client.source, "kline_daily:no_data_spike",
      `${noData.length}/${codes.length} 只无 K 线序列，超过 ${NO_DATA_ALERT_RATIO * 100}% ——` +
      ` 大概率是限频而非真的没数据，不要当正常情况忽略`,
      true
    );
  }

  return { written, failed, noData, adjFixed };
}

/**
 * 把因子为 1.0、但前一交易日不为 1.0 的行，顺延成前一交易日的因子。
 *
 * ── 为什么需要它，而不是只靠插入时那条 COALESCE ──
 *
 * 插入时的顺延只能管**新行**。而同一套 SQL 里排在最前面的是
 * "先取既有值、保住它"——那是为了不让日线采集覆盖掉回填任务算出来的正确值，
 * 但它同时也意味着：**一旦某行被写成了 1.0，此后每次重采都会把这个错值保住**。
 * 写坏的那一刻起，错值是自我延续的，再跑多少次采集都不会好。
 *
 * 实测就是这么发生的（2026-09-29）：9-27 夜里修好了插入时的顺延，但负责采集的
 * daemon 是 22:21 随 dev server 拉起的常驻进程，代码冻结在那一刻 —— 它没看到修复。
 * 9-28 收盘采集写入的最新一根又是 1.0，**全市场 5,534 行无一幸免**，
 * 于是 600667 图上出现 9-24 收 112.65（19.41 × 5.80）、9-28 收 17.81 的断崖。
 *
 * 所以顺延这件事不能只押在"这次运行的代码是对的"上。这一步**幂等**，
 * 挂在每次采集末尾，写坏了下次自动爬起来。
 *
 * ── 为什么不误伤 ──
 *
 * 复权因子是单调递增的台阶：两次除权之间恒定，除权后变大，**不会从非 1 变回 1**。
 * 所以"前一根 ≠ 1 而这一根 = 1"几乎只能是写坏了。
 * 真没有除权记录的票整段都是 1.0（前一根也是 1.0），北交所那些源不支持的票同理 ——
 * 两者都找不到"≠ 1.0 的前一根"，不会被这条规则碰到。
 * 指数 code 形如 sh000001，不是 6 位纯数字，也天然排除（指数本来就固定 1.0）。
 *
 * @param codes 只修这些票。不传则全表（CLI 手动兜底用）
 * @returns 实际修正的行数
 */
export function repairTrailingAdjFactors(db: Db, codes?: string[]): number {
  const targets = codes ?? (
    db.prepare(
      "SELECT DISTINCT code FROM kline_daily WHERE code GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'"
    ).all() as Array<{ code: string }>
  ).map(r => r.code);

  const fix = db.prepare(
    `UPDATE kline_daily AS k
       SET adj_factor = (
         SELECT p.adj_factor FROM kline_daily p
          WHERE p.code = k.code AND p.date < k.date AND p.adj_factor != 1.0
          ORDER BY p.date DESC LIMIT 1
       )
     WHERE k.code = ?
       AND k.adj_factor = 1.0
       AND EXISTS (
         SELECT 1 FROM kline_daily p
          WHERE p.code = k.code AND p.date < k.date AND p.adj_factor != 1.0
       )`
  );

  // 每票一条 UPDATE，走 (code, date) 主键 —— 5888 次点查，全表扫不起
  const run = db.transaction((list: string[]) => {
    let n = 0;
    for (const c of list) n += fix.run(c).changes;
    return n;
  });
  return run(targets);
}

/**
 * 指数日线。
 *
 * 与个股日线写同一张 kline_daily，code 存**带前缀的 symbol**（sh000001）——
 * 指数代码不遵循"6 开头即沪市"，而 security 表里也没有它们，
 * 所以 allCodes() 的全市场遍历天然不会把指数当成股票混进去。
 *
 * 单独一个函数而不是塞进 collectDaily：后者按 6 位代码拼 symbol，
 * 传指数进去会被拼错市场（sz000001 是平安银行）。
 */
export async function collectIndexDaily(
  db: Db, client: SourceClient, indices: IndexDef[], datalen: number
): Promise<{ written: number; failed: string[] }> {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO kline_daily (code, date, o, h, l, c, vol, amount, adj_factor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1.0)`
  );
  let written = 0;
  const failed: string[] = [];

  for (const idx of indices) {
    try {
      const bars = await fetchSinaKlineBySymbol(client, idx.symbol, 240, datalen);
      db.transaction(() => {
        for (const b of bars) {
          // 指数没有复权概念，adj_factor 固定 1.0（不 COALESCE 既有值：那是给个股的除权保护）
          stmt.run(idx.symbol, b.ts.slice(0, 10), b.o, b.h, b.l, b.c, b.vol, null);
        }
      })();
      written += bars.length;
      resolveGapsForKind(db, client.source, `kline_daily:${idx.symbol}`);
    } catch (e: any) {
      failed.push(idx.symbol);
      // 可回补：指数日线和个股日线一样，下次全量拉取会带回来
      recordGap(db, today(), client.source, `kline_daily:${idx.symbol}`, e.message, true);
    }
  }
  return { written, failed };
}
