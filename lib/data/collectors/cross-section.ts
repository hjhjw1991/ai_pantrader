import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import {
  fetchZtPool, fetchSectorRank, fetchDtPool, fetchMacroQuote, fetchSectorMembers,
  fetchMarketIndustryPage, CLIST_PAGE_MAX,
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
 * ────────── 全市场 代码 → 行业板块 映射 ──────────
 *
 * 这是本项目对东财最重的一次调用，所以**不每天跑**：行业归属只在并购、主业变更时
 * 才动，按"整张表多久没更新过"判，默认 7 天一次，放在夜间 job
 * （那时没人等结果，且限流影响不到盘中采集）。
 *
 * 有两条路，主路是 `collectSectorMembersFromListing`（全市场列表带行业字段，
 * 约 60 次请求），老路 `collectSectorMembers`（逐个板块拉成分，约 800 次请求）
 * 退为兜底。两者共用的多轮重试机制在 `runWithPasses`。
 *
 * 部分失败照样写入已拿到的部分并如实报数：拿到 400 个行业的映射，
 * 比因为 96 个失败就整批丢弃有用得多 —— 缺的那部分下次刷新时补，
 * 而映射缺失的票在策略层会被主线筛挡下（那是"未判定不等于通过"，不是错判）。
 */
interface PassRunOpts {
  passes?: number;
  pausePassMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 逐项执行，失败的攒起来等熔断冷却后重来一轮。
 *
 * ── 为什么必须是"多轮 + 轮间重置熔断器" ──
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
 *   4. 等 10 个主机全开，剩下的每一项都在 `circuit open` 上瞬间失败，
 *      **一个请求都不会真发出去**。实测 496 个行业：成功 63、失败 433，
 *      而那 433 个是在几秒内"失败"完的。
 *
 * 所以慢下来没用（实测 800ms 间隔反而更差，那是噪声），加大单次退避也没用 ——
 * 要的是把失败的攒起来，等熔断冷却之后重来一轮。
 *
 * 轮间显式重置熔断器是**故意**的，也是安全的：熔断器的职责是"别再捶一台已经死了的
 * 主机"，而这里每台主机刚刚都成功返回过几十次，它们没死，只是抖。
 * 真正的退避是轮间那 5 分钟停顿本身。
 */
async function runWithPasses<T>(
  client: SourceClient, items: T[], run: (item: T) => Promise<void>, o: PassRunOpts = {}
): Promise<{ failed: T[]; passes: number }> {
  const passes = Math.max(1, o.passes ?? DEFAULT_PASSES);
  const pause = o.pausePassMs ?? PASS_PAUSE_MS;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));

  let remaining = items;
  let used = 0;
  // 救场次数按**整次调用**计，不按轮 —— 否则 3 轮 × 3 次 × 5 分钟 = 45 分钟，
  // 夜间 job 的防休眠窗口容不下，机器会在 job 跑完之前睡过去
  let rescues = 0;

  for (let pass = 1; pass <= passes && remaining.length > 0; pass++) {
    if (pass > 1) {
      // 先停顿再重置：顺序反过来的话，主机还没喘过气就又被放行了
      await sleep(pause);
      client.breakers.reset();
    }
    used = pass;
    const stillFailed: T[] = [];
    for (const it of remaining) {
      /**
       * 10 个主机的熔断器全开时，后面每一项都会在 circuit open 上瞬间失败，
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
        await run(it);
      } catch {
        stillFailed.push(it);
      }
    }
    remaining = stillFailed;
  }
  return { failed: remaining, passes: used };
}

/**
 * 【老路】逐个行业板块拉成分股，拼出 代码 → 行业 映射。
 *
 * 现在只作为兜底保留：全市场列表那一路（collectSectorMembersFromListing）
 * 约 60 次请求就能拿到同一份映射，而这一路要 496 个板块、翻页后约 800 次请求，
 * 实测只能成功 146 个行业。列表路拿不到东西时才退回这里。
 */
export async function collectSectorMembers(
  db: Db, client: SourceClient, sectors: Array<{ bk: string; sector: string }>,
  o: SectorMembersOpts = {}
): Promise<{ sectors: number; codes: number; failed: string[]; passes: number }> {
  const ts = shanghaiTs();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO security_sector (code, sector, bk, ts) VALUES (?, ?, ?, ?)"
  );

  let codes = 0, done = 0;
  const { failed: remaining, passes: used } = await runWithPasses(
    client, sectors,
    async (s) => {
      // retries:0 —— 单次快速失败，重试交给外层的多轮。
      // 不这么做的话，一个注定失败的行业要耗掉 10 主机 × 3 次尝试 ≈ 40 秒
      // （httpGet 的重试之间还要睡 1s、2s），实测 4 分钟只能走完 68 个行业
      const members = await fetchSectorMembers(client, s.bk, { rounds: 1, retries: 0 });
      db.transaction(() => {
        for (const m of members) stmt.run(m.code, s.sector, s.bk, ts);
      })();
      codes += members.length;
      done++;
    },
    { passes: o.passes, pausePassMs: o.pausePassMs, sleep: o.sleep }
  );

  const failed = remaining.map(s => `${s.sector}(${s.bk})`);
  recordSectorGap(db, ts, client.source, failed, sectors.length, used);
  return { sectors: done, codes, failed, passes: used };
}

/**
 * 【主路】全市场列表一次取行业，建 代码 → 行业 映射。
 *
 * ── 为什么换这条路 ──
 *
 * 老路是「逐个行业板块拉成分」：496 个板块 × 翻页 ≈ 800 次请求，而这个接口
 * 单次失败率 30~50%，实测 496 个行业只成功 146 个 —— 库里 5,888 只票只有
 * 3,248 只有行业。用户看到的就是「这只有 K 线、有量价，就是查不到行业」：
 * 600667 太极实业、603155 新亚强 所属的板块恰好都在失败的那 350 个里。
 *
 * 而全市场列表本身就带行业字段（f100），按代码升序翻一遍约 60 页即可，
 * 请求数少一个数量级，失败面也小一个数量级。
 *
 * ── 关于 bk ──
 * 列表只给行业名，不给板块代码。用板块清单（boards）把名字翻成 bk；
 * 翻不出来就留空串 —— 表上 bk 是 NOT NULL，而目前没有任何地方读它，
 * 拿不到板块代码不该让这一行的行业归属一起丢掉。
 *
 * ── 分页失败要重试，不能就此收尾 ──
 * 按代码升序翻页时，中途失败一页意味着**后面所有页都拿不到**（实测第 21 页
 * 失败时只拿到 2000/5920 行，全是 000/002 开头，600/300/920 一只没有）。
 * 那不是"部分成功"，是系统性偏到半个市场，所以失败的页必须攒起来重来。
 */
export async function collectSectorMembersFromListing(
  db: Db, client: SourceClient, boards: Array<{ bk: string; sector: string }>,
  o: SectorMembersOpts = {}
): Promise<{ codes: number; failed: string[]; passes: number; sectors: number; total: number | null }> {
  const ts = shanghaiTs();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO security_sector (code, sector, bk, ts) VALUES (?, ?, ?, ?)"
  );
  const bkByName = new Map(boards.map(b => [b.sector, b.bk]));

  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  let codes = 0;
  let total: number | null = null;
  // 本次刷新实际落库的行业。不能事后去 SELECT DISTINCT 整张表 ——
  // 表里还留着以前刷进去的行业，那样报出来的是"历史累计"，不是这一次
  const sectorsSeen = new Set<string>();
  // 每一页拿到的行直接落库，别攒在内存里 —— 60 页 × 100 行不算大，
  // 但中途崩掉时"已经落库的那部分"才是有用的东西
  const write = (rows: Array<{ code: string; sector: string }>) => {
    if (rows.length === 0) return;
    db.transaction(() => {
      for (const m of rows) stmt.run(m.code, m.sector, bkByName.get(m.sector) ?? "", ts);
    })();
    for (const m of rows) sectorsSeen.add(m.sector);
    codes += rows.length;
  };

  // 先探第一页拿到 total，才知道一共要翻多少页。第一页失败就是整路失败。
  const first = await fetchMarketIndustryPage(client, 1, { rounds: 3 });
  if (first.total === null && first.rows.length === 0) {
    throw new Error("东财全市场列表第一页既没有 total 也没有数据，拒绝按未知页数翻页");
  }
  total = first.total;
  write(first.rows);
  if (first.rows.length === 0) {
    return { codes, failed: [], passes: 0, total, sectors: sectorsSeen.size };
  }

  const maxPages = total === null ? MARKET_LISTING_MAX_PAGES
    : Math.min(MARKET_LISTING_MAX_PAGES, Math.ceil(total / CLIST_PAGE_MAX));

  const pages: number[] = [];
  for (let pn = 2; pn <= maxPages; pn++) pages.push(pn);

  const { failed: failedPages, passes } = await runWithPasses(
    client, pages,
    async (pn) => {
      const p = await fetchMarketIndustryPage(client, pn, { rounds: 1, retries: 0 });
      write(p.rows);
      // 不满页/空页说明后面没有了，但这里只在"真的到最后一页"时才停；
      // 中间页不满是异常，交给调用方按缺口数判断
      if (p.rows.length === 0) throw new Error(`第 ${pn} 页空`);
    },
    { passes: o.passes, pausePassMs: o.pausePassMs ?? LISTING_PASS_PAUSE_MS, sleep }
  );

  const failed = failedPages.map(p => `第${p}页`);
  recordSectorGap(db, ts, client.source, failed, pages.length + 1, passes);
  return {
    codes, failed, passes, total,
    // 列表路不逐个行业计数，报**这次**落库的行业数，意义与之对齐
    sectors: sectorsSeen.size,
  };
}

/** 列表路最多翻多少页。5,920 只 ÷ 100 = 60 页，留一倍余量防源侧膨胀 */
const MARKET_LISTING_MAX_PAGES = 120;

/**
 * 列表路的轮间停顿，比老路短得多。
 *
 * 5 分钟（PASS_PAUSE_MS）是为"496 个板块 × 翻页 ≈ 800 次请求"那批定的 —— 那种
 * 强度会把东财压进持续好几分钟的惩罚状态。列表路一共才 60 次请求，压不出那种状态，
 * 沿用 5 分钟只会把它拖到十几分钟（实测：盘中跑一次 3 轮 × 5 分钟 + 3 次救场，
 * 15 分钟都没跑完）。60 秒足够躲开一小段限流，又不至于让整路跑不完。
 */
const LISTING_PASS_PAUSE_MS = 60_000;

/**
 * 列表路拿到这个比例以上就算成功，不再退回去跑 800 次请求的逐板块路。
 *
 * 判比例而不是判绝对条数：市场在扩容，写死一个数字会逐渐失效。
 * 0.8 留的余量是给"退市老代码没有行业名"那部分（列表 total 5920，其中有
 * 行业名的约 5,500 只，比例天然到不了 1）。
 */
const LISTING_OK_RATIO = 0.8;

export interface SectorMembersRefresh {
  codes: number;
  sectors: number;
  failed: string[];
  passes: number;
  /** 列表路看到的全市场总数，用来算这次到底覆盖了多少 */
  total: number | null;
  /**
   * 实际生效的是哪条路。夜间 job 要记下来 —— 只有看到它才知道源在往哪边劣化：
   * listing = 干净拿下；listing-partial = 通了但被限流砍掉一部分（下次重新跑即可）；
   * boards = 列表路完全拿不到，退回了 800 次请求的逐板块路。
   */
  route: "listing" | "listing-partial" | "boards";
}

/**
 * 刷 代码 → 行业 映射（夜间 job 与 `pnpm job sector` 的唯一入口）。
 *
 * 主路走全市场列表。**只有列表路完全拿不到东西时才退回逐板块那一路** ——
 * 列表路"少拿了一部分"就退回，等于为了省事去烧 800 次请求：实测盘中刷一次，
 * 列表路几十秒就有结果，兜底路跑 20 分钟还没完（它还添麻烦：要和 5 分钟一轮的
 * 盘中快照抢限流额度）。少拿的那部分由 `sectorMembersRefreshDue` 判漏、
 * 下一次夜里再补 —— 列表路重试很便宜。
 *
 * 板块清单（boards）只用来把行业名翻成 bk 代码，拿不到也照刷 ——
 * 行业名本身才是策略层用的东西。
 */
export async function refreshSectorMembers(
  db: Db, client: SourceClient, o: SectorMembersOpts = {}
): Promise<SectorMembersRefresh> {
  /**
   * 每一段开始前都先重置熔断器。
   *
   * 熔断是**进程内**的（3 次失败即开、冷却 5 分钟），而一次刷新要连着跑好几段：
   * 板块清单 → 全市场列表 →（必要时）逐板块。上一段把 10 台主机各试炸 3 次之后
   * 它们就全开了，带着开着的熔断进下一段，**一个请求都发不出去** ——
   * 实测第二次跑就是这样：清单那段 fetch 全挂，列表段紧接着以
   * "circuit open"（而不是真的请求）失败，整次刷新零产出。
   */
  const freshStart = () => client.breakers.reset();

  let boards: Array<{ bk: string; sector: string }> = [];
  freshStart();
  try {
    boards = await collectSectorRankList(db, client);
  } catch (e: any) {
    console.warn(`[sector] 板块清单拉取失败，映射继续但不带板块代码：${e?.message ?? e}`);
  }

  freshStart();
  try {
    const r = await collectSectorMembersFromListing(db, client, boards, o);
    // 一条都没拿到就是这条路没通（源那侧的问题），交给下面的兜底；
    // 拿到了但没够才算"被限流砍掉一部分"
    if (r.codes > 0) {
      const coverage = r.total !== null && r.total > 0 ? r.codes / r.total : 1;
      return { ...r, route: coverage >= LISTING_OK_RATIO ? "listing" : "listing-partial" };
    }
    console.warn("[sector] 全市场列表路一条都没拿到，退回逐板块路");
  } catch (e: any) {
    console.warn(`[sector] 全市场列表路失败，退回逐板块路：${e?.message ?? e}`);
  }

  freshStart();
  const r = await collectSectorMembers(db, client, boards, o);
  return { ...r, total: null, route: "boards" };
}

/**
 * security 里没有行业归属的比例。
 *
 * 用来让"过期才刷"升级成"过期**或**仍有缺口才刷"：映射是按 MAX(ts) 判 7 天一刷的，
 * 而 ts 每次跑都会更新 —— 一旦某次只有一半成功，剩下的那批会安静地缺失整整一周。
 * 让调度按"还有多少没查到"来补，缺的部分下一夜就补上，而不是等到期。
 */
export function sectorMembersMissingRatio(db: Db): number {
  if (!hasColumn(db, "security", "code")) return 0;
  const r = db.prepare(
    `SELECT (SELECT COUNT(*) FROM security) AS all_n,
            (SELECT COUNT(*) FROM security s
              WHERE EXISTS (SELECT 1 FROM security_sector x WHERE x.code = s.code)) AS hit_n`
  ).get() as { all_n: number; hit_n: number } | undefined;
  const all = Number(r?.all_n ?? 0);
  if (all === 0) return 0;
  return 1 - Number(r?.hit_n ?? 0) / all;
}

/**
 * 缺这么多以上就别等 7 天，今夜再刷一次。
 *
 * 0.10 是留了地板的：security 里有退市/老三板的历史代码，东财不给它们行业名
 * （f100 回 '-'），那部分是**永远查不到**的。取 0.10 而不是 0.02，是为了别让
 * "本来就拿不到"的那批把 job 变成每夜必跑。
 */
export const SECTOR_MISSING_REFRESH_RATIO = 0.10;

/** 有没有 security / security_sector 这两张表缺列 —— 迁移没跑到时不该让夜间 job 挂掉 */
function hasColumn(db: Db, table: string, col: string): boolean {
  try {
    const names = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return names.some(c => c.name === col);
  } catch {
    return false;
  }
}

/** 部分失败记缺口，全成功销缺口 —— 两条路共用，口径要一致 */
function recordSectorGap(
  db: Db, ts: string, source: string, failed: string[], total: number, passes: number
): void {
  if (failed.length > 0) {
    recordGap(db, ts.slice(0, 10), source, "security_sector",
      `${failed.length}/${total} 项拉取失败（已重试 ${passes} 轮）：` +
      `${failed.slice(0, 5).join(", ")}${failed.length > 5 ? " …" : ""}`, true);
  } else {
    resolveGap(db, ts.slice(0, 10), source, "security_sector");
  }
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
