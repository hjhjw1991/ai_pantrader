import type { Db } from "@/lib/db";
import { shanghaiTs } from "@/lib/data/clock";
import { readStrategyConfig } from "@/lib/ui/adapters/strategy";
import { todaySignalCard } from "@/lib/ui/adapters/engines";
import { positionsView } from "@/lib/ui/views";
import { intradayMood } from "@/lib/sentiment/intraday";
import { diffAndNotify, pushNotification } from "@/lib/ui/notify";

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
export async function runSignalWatch(db: Db): Promise<{ notified: number; reason?: string }> {
  /**
   * 两段互不依赖：日线信号卡算不出来（策略配置缺失、卡片不可用）时，
   * 盘中情绪照样要算 —— 以前这里提前 return，情绪通知就整段跳过了，
   * 而情绪告警只依赖快照，跟策略配置一点关系都没有。
   */
  let notified = 0;
  let reason: string | undefined;
  try {
    const r = cardNotify(db);
    notified += r.notified;
    reason = r.reason;
  } catch (e) {
    // 卡片这段出错不该挡住情绪那段
    reason = `信号卡计算出错：${(e as Error)?.message ?? e}`;
  }

  const moodNotified = moodNotify(db);
  return { notified: notified + moodNotified, ...(reason !== undefined ? { reason } : {}) };
}

/** 日线口径的信号卡：档位、候选、硬线告警的变化 */
function cardNotify(db: Db): { notified: number; reason?: string } {
  const cfg = readStrategyConfig();
  if (!cfg.available) return { notified: 0, reason: `策略配置不可用：${cfg.reason}` };

  const out = todaySignalCard(db, shanghaiTs(), cfg.config);
  if (!out.available) return { notified: 0, reason: out.reason };

  // 硬线告警数从持仓视图来：破止损/破灾难位是 critical 级，必须响
  let alerts = 0;
  try {
    alerts = positionsView(db, cfg.config).alerts.length;
  } catch {
    // 持仓算不出来不该挡住档位与候选的通知
  }
  return { notified: diffAndNotify(db, out.card, alerts).length };
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
