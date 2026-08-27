import type { Db } from "@/lib/db";
import { shanghaiTs } from "@/lib/data/clock";
import { readStrategyConfig } from "@/lib/ui/adapters/strategy";
import { todaySignalCard } from "@/lib/ui/adapters/engines";
import { positionsView } from "@/lib/ui/views";
import { diffAndNotify } from "@/lib/ui/notify";

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
