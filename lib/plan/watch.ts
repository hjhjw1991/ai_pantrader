import type { Db } from "@/lib/db";
import { shanghaiTs } from "@/lib/data/clock";
import { readStrategyConfig } from "@/lib/ui/adapters/strategy";
import { todaySignalCard } from "@/lib/ui/adapters/engines";
import { positionsView } from "@/lib/ui/views";
import { intradayMood } from "@/lib/sentiment/intraday";
import { diffAndNotify, pushNotification } from "@/lib/ui/notify";
import { syncIntradayWatch, type IntradayWatchSync } from "@/lib/data/intraday-watch";

/**
 * 盘中信号盯守：每轮采集之后重算信号卡，与上次比对，把**需要人做动作的变化**写成通知。
 *
 * 为什么必须由采集守护来做，而不是等页面去算：
 * diffAndNotify 至今只挂在 /api/signal 上，而前端从来不请求那个接口 ——
 * 作战台是服务端直接算卡片渲染的，绕开了它。结果是 notification 表**一条都没有**，
 * 桌面通知自然从来没响过。通知的意义恰恰在于人没盯着屏幕的时候还能收到，
 * 挂在"有人打开页面"上等于没有。
 *
 * migration 010 也是这么设计的：落库让任意进程当生产者、网页当消费者。
 *
 * 失败不上抛：通知是增强，算不出来绝不能让采集这一轮变成失败。
 */
export async function runSignalWatch(
  db: Db
): Promise<{ notified: number; reason?: string; watch?: IntradayWatchSync }> {
  /**
   * 两段互不依赖：日线信号卡算不出来（策略配置缺失、卡片不可用）时，
   * 盘中情绪照样要算 —— 以前这里提前 return，情绪通知就整段跳过了，
   * 而情绪告警只依赖快照，跟策略配置一点关系都没有。
   */
  let notified = 0;
  let reason: string | undefined;
  let watch: IntradayWatchSync | undefined;
  try {
    const r = cardNotify(db);
    notified += r.notified;
    reason = r.reason;
    watch = r.watch;
  } catch (e) {
    // 卡片这段出错不该挡住情绪那段
    reason = `信号卡计算出错：${(e as Error)?.message ?? e}`;
  }

  const moodNotified = moodNotify(db);
  return {
    notified: notified + moodNotified,
    ...(reason !== undefined ? { reason } : {}),
    ...(watch !== undefined ? { watch } : {}),
  };
}

/** 日线口径的信号卡：档位、候选、硬线告警的变化 */
function cardNotify(db: Db): { notified: number; reason?: string; watch?: IntradayWatchSync } {
  const cfg = readStrategyConfig();
  if (!cfg.available) return { notified: 0, reason: `策略配置不可用：${cfg.reason}` };

  const ts = shanghaiTs();
  const out = todaySignalCard(db, ts, cfg.config);
  if (!out.available) return { notified: 0, reason: out.reason };

  /**
   * 顺手把"这一轮还在候选池里的票"抄给采集层 —— 这是唯一一处每 5 分钟
   * 真算过候选的地方，另起一次引擎跑一遍纯属浪费（作战台实测 2~8 秒）。
   *
   * 卡片算不出来时传 null：那不是"今天没有候选"，是"不知道"。把不知道
   * 当成空，一次引擎报错就会清空盯守名单，那一整段盘中分钟线就永久没了。
   *
   * 落在 signalWatch 里而不是采集之前，是因为候选要拿这一轮刚写进去的快照算。
   * 代价是新候选从下一轮才开始采（约 5 分钟），但新浪一次返回最近 240 根
   * （约 5 个交易日），当天更早的分钟线会一并带回来，所以不会有洞。
   */
  let watch: IntradayWatchSync | undefined;
  let reason: string | undefined;
  try {
    const r = syncIntradayWatch(db, {
      date: ts.slice(0, 10), ts, candidates: out.card.candidates,
    });
    if (r !== null) watch = r;
  } catch (e) {
    // 名单写不进去不该让这一轮的通知停掉
    reason = `盘中盯守名单更新失败：${(e as Error)?.message ?? e}`;
  }

  // 硬线告警数从持仓视图来：破止损/破灾难位是 critical 级，必须响
  let alerts = 0;
  try {
    alerts = positionsView(db, cfg.config).alerts.length;
  } catch {
    // 持仓算不出来不该挡住档位与候选的通知
  }
  return {
    notified: diffAndNotify(db, out.card, alerts).length,
    ...(reason !== undefined ? { reason } : {}),
    ...(watch !== undefined ? { watch } : {}),
  };
}

/** 通知表里是否已经有这个去重键 */
function alreadyNotified(db: Db, dedupeKey: string): boolean {
  return db.prepare(`SELECT 1 FROM notification WHERE dedupe_key = ? LIMIT 1`).get(dedupeKey) !== undefined;
}

/**
 * 盘中情绪。
 * 上面那张卡是日线口径，盘中永远是昨收的结论，突发转弱它不会有任何反应。
 * 这里补上快照口径的情绪转变。失败不上抛：通知是增强。
 */
function moodNotify(db: Db): number {
  let moodNotified = 0;
  try {
    const mood = intradayMood(db, shanghaiTs());
    for (const s of mood.signals) {
      // info 级不弹："转强"与"过热"是让人知道，不是要求人做动作。
      // 通知的原则是"要求人做动作的才响"，弹多了连 critical 一起被无视
      if (s.level === "info") continue;
      // 更重的同类今天已经响过（critical 的转弱之后再来 warn 的转弱）：降级不再吵人
      if (s.supersededBy && alreadyNotified(db, s.supersededBy)) continue;
      if (pushNotification(db, {
        kind: `mood_${s.kind}`, severity: s.level,
        title: s.title, body: s.body, dedupeKey: s.dedupeKey,
      })) moodNotified++;
    }
  } catch {
    // 情绪算不出来不该挡住档位与候选的通知
  }
  return moodNotified;
}
