import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import {
  fetchZtPool, fetchSectorRank, fetchDtPool, fetchMacroQuote, fetchSectorMembers,
} from "@/lib/data/sources/eastmoney";
import { recordGap, resolveGap } from "@/lib/data/gap";
import { shanghaiTs } from "@/lib/data/clock";

/** 东财涨停池接口用 YYYYMMDD，库里统一存 YYYY-MM-DD */
const dashDate = (yyyymmdd: string) =>
  `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

/**
 * 涨停池。实测东财的 date 参数无效——只能拿当日，历史不可回补。
 * 所以这是纯增量资产，失败必须显式记 gap。
 */
export async function collectZtPool(
  db: Db, client: SourceClient, date: string
): Promise<number> {
  const d = dashDate(date);
  let rows;
  try {
    rows = await fetchZtPool(client, date);
  } catch (e: any) {
    recordGap(db, d, client.source, "zt_pool", e.message, false);
    throw e;
  }

  const stmt = db.prepare(
    `INSERT OR REPLACE INTO zt_pool
     (date, code, name, lbc, seal_amt, open_times, first_seal_ts, last_seal_ts, sector, turnover)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const r of rows) {
      stmt.run(d, r.code, r.name, r.lbc, r.sealAmt, r.openTimes,
               r.firstSealTs, r.lastSealTs, r.sector, r.turnover);
    }
  })();
  resolveGap(db, d, client.source, "zt_pool");
  return rows.length;
}

/**
 * 板块涨幅榜。
 *
 * rounds 默认 **1**（不做主机轮换重试）：轮换带 15 秒退避、最坏 45 秒，
 * 而盘中一轮采集本身就要 45 秒、5 分钟一个时点 —— 在里面重试会把整轮撑爆。
 * 盘中真正的重试是"下一轮"。收盘那次是当天最后机会，调用方会显式调大 rounds。
 *
 * 一天内多次写入，主键是 (date, ts, sector) —— 盘中每轮采集留一个时点快照，
 * 因子那边只取当天最后一个 ts（见 lib/factors/sectors.ts 的 latestRankBySector）。
 * 保留过程量是有意的：主线是"谁一直在榜上"，只留收盘那一张看不出这件事。
 */
export async function collectSectorRank(
  db: Db, client: SourceClient, date: string,
  o: { rounds?: number } = {}
): Promise<number> {
  const d = dashDate(date);
  let rows;
  try {
    rows = await fetchSectorRank(client, { rounds: o.rounds ?? 1 });
  } catch (e: any) {
    // 板块榜是盘中现场，错过就没有，与涨停池同属不可回补
    recordGap(db, d, client.source, "sector_rank", e.message, false);
    throw e;
  }

  const ts = shanghaiTs();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO sector_rank (date, ts, sector, pct, leader_code)
     VALUES (?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const r of rows) stmt.run(d, ts, r.sector, r.pct, r.leaderCode);
  })();
  resolveGap(db, d, client.source, "sector_rank");
  return rows.length;
}

/**
 * 跌停池。
 *
 * 空池是合法结果，不记 gap：今天没有跌停是真实且有意义的信号
 * （择时的"跌停家数 > 30 转防守"正靠它），把它当失败会让那道闸口永远读不到"稳"。
 */
export async function collectDtPool(
  db: Db, client: SourceClient, date: string
): Promise<number> {
  const d = dashDate(date);
  let rows;
  try {
    rows = await fetchDtPool(client, date);
  } catch (e: any) {
    recordGap(db, d, client.source, "dt_pool", e.message, false);
    throw e;
  }

  const stmt = db.prepare(
    `INSERT OR REPLACE INTO dt_pool (date, code, name, seal_amt) VALUES (?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const r of rows) stmt.run(d, r.code, r.name, r.sealAmt);
  })();
  resolveGap(db, d, client.source, "dt_pool");
  return rows.length;
}

/**
 * 外围标的行情（A50 / 费半 / 黄金 / 原油）。
 *
 * 逐个标的独立成败：费半拿不到不该连累 A50 —— 外围传导因子本来就按
 * "拿到多少权重"折算置信度，缺一个它会自己降权，缺全部才判为不可用。
 * 所以这里返回 written/failed，让上层照实统计，而不是一个失败就整体抛。
 */
export async function collectMacro(
  db: Db, client: SourceClient, symbols: string[]
): Promise<{ written: number; failed: Array<{ symbol: string; error: string }> }> {
  const ts = shanghaiTs();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO macro (ts, symbol, price, pct) VALUES (?, ?, ?, ?)"
  );
  let written = 0;
  const failed: Array<{ symbol: string; error: string }> = [];

  for (const symbol of symbols) {
    try {
      const q = await fetchMacroQuote(client, symbol);
      stmt.run(ts, q.symbol, q.price, q.pct);
      written++;
    } catch (e: any) {
      failed.push({ symbol, error: e?.message ?? String(e) });
      // 记 gap 但按不可回补：外围报价是时点现场，过去某一刻的读数拿不回来
      recordGap(db, ts.slice(0, 10), client.source, `macro:${symbol}`, e?.message ?? String(e), false);
    }
  }
  return { written, failed };
}

export interface SectorMembersOpts {
  /**
   * 总轮数（含第一轮）。失败的行业进下一轮重试，成功的不再重复请求。
   *
   * 为什么必须多轮，而不是把单次请求的 rounds 调高：单次 rounds 的退避是
   * 15s、30s 串在**这一个**行业上，496 个行业里只要有几十个走到退避，
   * 整批就要多花十几分钟；而失败是零散、随机、且下一轮多半就好了的，
   * 攒到下一轮统一重试便宜得多。
   */
  passes?: number;
  /** 轮间停顿。默认 5 分钟，见 PASS_PAUSE_MS 的实测依据 */
  pausePassMs?: number;
  /** 注入点：测试里不真睡 */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 轮间停顿。
 *
 * 取 5 分钟而不是更短，有两个实测依据：
 *   1. 客户端熔断器的冷却就是 5 分钟。虽然这里会显式重置，但停够冷却时长
 *      意味着即使重置逻辑将来被改掉，行为仍然是对的。
 *   2. 更要紧的是源本身：连续重压之后东财这个接口会进入一个明显的惩罚状态，
 *      实测持续好几分钟都只能放行零星请求（本次调试连续压了一小时之后，
 *      496 个行业里 20 分钟只走完 82 个）。90 秒明显不够它缓过来。
 *
 * 代价可以接受：这一路每 7 天才跑一次，跑在夜间 job 里，没有人在等结果。
 */
const PASS_PAUSE_MS = 300_000;
/** 一轮之内最多因"全部主机熔断"就地救场几次 */
const MAX_MID_PASS_RESCUES = 3;
const DEFAULT_PASSES = 3;

/**
 * 全市场 代码 → 行业板块 映射。
 *
 * 逐个行业拉成分股。行业数实测 496，每个一个请求 —— 这是本项目对东财最重的一次调用，
 * 所以**不每天跑**：行业归属只在并购、主业变更时才动，按"整张表多久没更新过"判，
 * 默认 7 天一次，放在夜间 job（那时没人等结果，且限流影响不到盘中采集）。
 *
 * ── 为什么是多轮 + 轮间重置熔断器 ──
 *
 * 这一路曾经连续 5 个夜里整批失败（security_sector 一直是 0 行，「量价」候选来源
 * 因此从来没工作过）。实测下来的机制是：
 *
 *   1. 东财这个接口本身是**间歇性抖动**的，单次请求实测失败率 30~50%
 *      （同一时刻 curl 也一样失败，不是我们客户端的问题）；
 *   2. httpGet 的重试 + 10 主机轮换本来能把抖动吸收掉 —— 实测前 150 个行业
 *      成功 149 个；
 *   3. 但每次失败都会记进**按主机**的熔断器（3 次连续失败即开、冷却 5 分钟）。
 *      批越长，开的主机越多：75 个行业时 0/10 开，100 个时 3/10，150 个时 6/10；
 *   4. 等 10 个主机全开，剩下的行业每个都在 `circuit open` 上瞬间失败，
 *      **一个请求都不会真发出去**。实测 496 个行业：成功 63、失败 433，
 *      而那 433 个是在几秒内"失败"完的。
 *
 * 所以慢下来没用（实测 800ms 间隔反而更差，那是噪声），加大单次退避也没用 ——
 * 要的是把失败的攒起来，等熔断冷却之后重来一轮。
 *
 * 轮间显式重置熔断器是**故意**的，也是安全的：熔断器的职责是"别再捶一台已经死了的
 * 主机"，而这里每台主机刚刚都成功返回过几十次，它们没死，只是抖。
 * 真正的退避是轮间那 90 秒停顿本身。
 *
 * 部分失败照样写入已拿到的部分并如实报数：拿到 400 个行业的映射，
 * 比因为 96 个失败就整批丢弃有用得多 —— 缺的那部分下次刷新时补，
 * 而映射缺失的票在策略层会被主线筛挡下（那是"未判定不等于通过"，不是错判）。
 */
export async function collectSectorMembers(
  db: Db, client: SourceClient, sectors: Array<{ bk: string; sector: string }>,
  o: SectorMembersOpts = {}
): Promise<{ sectors: number; codes: number; failed: string[]; passes: number }> {
  const ts = shanghaiTs();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO security_sector (code, sector, bk, ts) VALUES (?, ?, ?, ?)"
  );
  const passes = Math.max(1, o.passes ?? DEFAULT_PASSES);
  const pause = o.pausePassMs ?? PASS_PAUSE_MS;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));

  let codes = 0, done = 0, used = 0;
  // 救场次数按**整次调用**计，不按轮 —— 否则 3 轮 × 3 次 × 5 分钟 = 45 分钟，
  // 夜间 job 的防休眠窗口容不下，机器会在 job 跑完之前睡过去
  let rescues = 0;
  let remaining = sectors;

  for (let pass = 1; pass <= passes && remaining.length > 0; pass++) {
    if (pass > 1) {
      // 先停顿再重置：顺序反过来的话，主机还没喘过气就又被放行了
      await sleep(pause);
      client.breakers.reset();
    }
    used = pass;
    const stillFailed: Array<{ bk: string; sector: string }> = [];
    for (const s of remaining) {
      /**
       * 10 个主机的熔断器全开时，后面每个行业都会在 circuit open 上瞬间失败，
       * 一个请求都发不出去 —— 那正是"496 个行业几秒内失败 433 个"的成因。
       * 与其把这一轮剩下的几百个白白烧掉（它们还要等下一轮才重试），
       * 不如就地停一下、放行，接着往下跑。
       *
       * 限次数（整次调用共 MAX_MID_PASS_RESCUES 次）：真的是源挂了的时候，
       * 不能变成无限期干等，也不能把夜间 job 的防休眠窗口撑爆。
       */
      if (rescues < MAX_MID_PASS_RESCUES && client.breakers.allOpen()) {
        await sleep(pause);
        client.breakers.reset();
        rescues++;
      }
      try {
        // retries:0 —— 单次快速失败，重试交给外层的多轮。
        // 不这么做的话，一个注定失败的行业要耗掉 10 主机 × 3 次尝试 ≈ 40 秒
        // （httpGet 的重试之间还要睡 1s、2s），实测 4 分钟只能走完 68 个行业
        const members = await fetchSectorMembers(client, s.bk, { rounds: 1, retries: 0 });
        db.transaction(() => {
          for (const m of members) stmt.run(m.code, s.sector, s.bk, ts);
        })();
        codes += members.length;
        done++;
      } catch {
        stillFailed.push(s);
      }
    }
    remaining = stillFailed;
  }

  const failed = remaining.map(s => `${s.sector}(${s.bk})`);
  if (failed.length > 0) {
    recordGap(db, ts.slice(0, 10), client.source, "security_sector",
      `${failed.length}/${sectors.length} 个行业成分拉取失败（已重试 ${used} 轮）：` +
      `${failed.slice(0, 5).join(", ")}${failed.length > 5 ? " …" : ""}`, true);
  } else {
    resolveGap(db, ts.slice(0, 10), client.source, "security_sector");
  }
  return { sectors: done, codes, failed, passes: used };
}

/** 映射表最后一次更新是什么时候（上海挂钟串）。空表返回 null */
export function sectorMembersUpdatedAt(db: Db): string | null {
  const r = db.prepare("SELECT MAX(ts) AS t FROM security_sector").get() as { t: string | null };
  return r.t ?? null;
}

/**
 * 取当前的行业板块清单（bk + 名称），供成分股拉取使用。
 * 与 collectSectorRank 共用同一个接口，但**不写库** —— 这里要的是清单，不是当日涨幅快照。
 */
export async function collectSectorRankList(
  db: Db, client: SourceClient
): Promise<Array<{ bk: string; sector: string }>> {
  // 必须翻页：接口单页上限 100，而行业总数实测 496。
  // 只拿第一页会让三分之二的票查不到行业，然后被主线筛静默挡掉。
  const rows = await fetchSectorRank(client, { rounds: 3, allPages: true });
  return rows
    .filter(r => r.bk.length > 0)
    .map(r => ({ bk: r.bk, sector: r.sector }));
}
