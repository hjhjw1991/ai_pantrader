import type { Db } from "@/lib/db";

/**
 * 盘中临时盯的票：**这一轮还在候选池里就盯，掉出去就停**。
 *
 * 为什么单独记一份，不直接用盘前计划（prediction）：
 * 计划是早上那一版候选的快照，写下去就定死了。而盘中每 5 分钟重算一次信号卡，
 * 板块榜在变、主线在变，10:40 才冒出来的票计划里根本没有 —— 分钟线又是不可
 * 回补的，等晚上再看就什么都没有了。
 *
 * 也**不去改 prediction**：那是评估台账，一行动作一个 horizon，
 * 拿它当"现在该采谁"的开关会把对账口径搅乱（掉出候选 ≠ 这条预测作废）。
 *
 * "掉出就停"为什么可以这么干脆：新浪一次给最近 240 根 5 分钟线（约 5 个
 * 交易日），所以中途掉出去再回来，回来那轮会把这段时间的分钟线一并带回来 ——
 * 抖一下不会在序列上留洞。真会留洞的是"从没进过池"，那才是要防的。
 */

export interface IntradayCandidate {
  code: string;
  name?: string | null;
  thesis?: string | null;
  score?: number | null;
}

export interface IntradayWatchSync {
  date: string;
  /** 这一轮还在候选池里的只数 */
  seen: number;
  /** 这天第一次被盯 */
  entered: number;
  /** 掉出去过又回来 */
  revived: number;
  /** 这一轮掉出候选 */
  dropped: number;
}

export interface SyncIntradayInput {
  date: string;
  ts: string;
  /**
   * 这一轮的候选。**null 表示这一轮没算出候选**（策略配置缺失、引擎报错），
   * 与"候选为空"是两件事 —— 后者是"今天没有可买的"，前者是"不知道"。
   * 传 null 时一个字都不改：把"不知道"当成"都不满足条件"，
   * 会让一次引擎报错清空整张盯守名单，那一整段盘中序列就永久没了。
   */
  candidates: IntradayCandidate[] | null;
}

export function syncIntradayWatch(db: Db, o: SyncIntradayInput): IntradayWatchSync | null {
  if (o.candidates === null) return null;

  // 同一轮里重复的代码只算一次：卡片不该出重复票，但出了也不能把它数两遍
  const now = new Map<string, IntradayCandidate>();
  for (const c of o.candidates) {
    const code = String(c.code ?? "");
    if (code === "" || now.has(code)) continue;
    now.set(code, c);
  }

  const rows = db
    .prepare(`SELECT code, active FROM intraday_watch WHERE date = ?`)
    .all(o.date) as Array<{ code: string; active: number }>;
  const before = new Map(rows.map(r => [r.code, r.active === 1]));

  let entered = 0;
  let revived = 0;
  let dropped = 0;

  const upsert = db.prepare(
    `INSERT INTO intraday_watch (date, code, name, thesis, score, first_ts, last_ts, drop_ts, rounds, active)
     VALUES (@date, @code, @name, @thesis, @score, @ts, @ts, NULL, 1, 1)
     ON CONFLICT(date, code) DO UPDATE SET
       name = excluded.name,
       thesis = excluded.thesis,
       score = excluded.score,
       last_ts = excluded.last_ts,
       drop_ts = NULL,
       active = 1,
       rounds = intraday_watch.rounds + 1`
  );
  const drop = db.prepare(
    `UPDATE intraday_watch SET active = 0, drop_ts = ? WHERE date = ? AND code = ? AND active = 1`
  );

  db.transaction(() => {
    for (const [code, c] of now) {
      if (!before.has(code)) entered++;
      else if (before.get(code) === false) revived++;
      upsert.run({
        date: o.date,
        code,
        name: c.name ?? null,
        thesis: c.thesis ?? null,
        score: typeof c.score === "number" && Number.isFinite(c.score) ? c.score : null,
        ts: o.ts,
      });
    }
    for (const [code, wasActive] of before) {
      if (wasActive && !now.has(code)) {
        drop.run(o.ts, o.date, code);
        dropped++;
      }
    }
  })();

  return { date: o.date, seen: now.size, entered, revived, dropped };
}

/**
 * 当天还在盯的票，先进先采。
 *
 * 排序按 first_ts：先被点名的先拿到额度 —— 与池子里"自选排最前"同一个道理，
 * 截断时砍的是最后才冒出来的那批。
 */
export function liveIntradayWatch(db: Db, date: string): string[] {
  return db
    .prepare(`SELECT code FROM intraday_watch WHERE date = ? AND active = 1 ORDER BY first_ts, code`)
    .all(date)
    .map((r: any) => String(r.code));
}
