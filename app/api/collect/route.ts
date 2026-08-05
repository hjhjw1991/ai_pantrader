import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { getConfig } from "@/lib/config";
import { createClient } from "@/lib/data/client";
import { runJob } from "@/lib/data/jobs";
import { shanghaiTs } from "@/lib/data/clock";
import { pushNotification } from "@/lib/ui/notify";
import { SCHEDULE } from "@/lib/data/schedule";
import { jobOutcome } from "@/lib/data/jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 手动触发采集（页面上的"立即采集"按钮）。
 *
 * 三条保护，都是必要的：
 *   1. **最小间隔**。全市场一轮 5885 只、99 个批次，实测约 45 秒。
 *      连点按钮会让多轮叠着跑，把免费源打到限频 —— 实测东财十几次请求就整体掉线。
 *   2. **单飞**。同一时刻只允许一轮在跑，用模块级标志（同进程内够用；
 *      跨进程由 job_run 的主键兜底）。
 *   3. **独立的 slot 命名**。手动采集记成 `manual:HH:MM:SS`，
 *      绝不占用计划时点的身份 —— 占了会让那个计划时点被当成已完成，
 *      于是真正的定时采集被跳过，覆盖率反而更差。
 */
/**
 * 最小间隔取自时刻表里 intraday 的 durationMin，而不是拍一个数。
 *
 * 上一版写 20 秒是错的：一轮实测 42 秒，所以顺序点两次永远绕得过，
 * 第二次直接把 gtimg 打到限频 —— 99 个批次全失败、0 条写入。
 * 间隔必须 ≥ 一轮真实耗时，否则这个保护形同不存在。
 */
const INTRADAY = SCHEDULE.find(j => j.job === "intraday");
const MIN_INTERVAL_MS = (INTRADAY?.durationMin ?? 2) * 60_000;
/** 计时从**结束**算起，不是从开始算起 —— 从开始算会把耗时算进间隔里 */
let lastAt = 0;
let inFlight = false;

export async function POST(): Promise<Response> {
  const now = Date.now();
  if (inFlight) {
    return Response.json({ ok: false, reason: "已有一轮采集在进行中" }, { status: 429 });
  }
  const wait = Math.ceil((MIN_INTERVAL_MS - (now - lastAt)) / 1000);
  if (wait > 0) {
    return Response.json(
      { ok: false, reason: `采集间隔保护：请 ${wait} 秒后再试（一轮全市场约 45 秒）` },
      { status: 429 }
    );
  }

  inFlight = true;
  const db = openDb(getConfig().dbPath);
  try {
    runMigrations(db);
    const clients = {
      sina: createClient("sina", { db, minIntervalMs: 350 }),
      tencent: createClient("tencent", { db, minIntervalMs: 250 }),
      eastmoney: createClient("eastmoney", { db, minIntervalMs: 600 }),
    };
    const at = new Date();
    const ts = shanghaiTs(at);
    const slot = `manual:${ts.slice(11, 19)}`;

    db.prepare(
      `INSERT OR REPLACE INTO job_run (date, job, slot, status, started_at, runner)
       VALUES (?, 'intraday', ?, 'running', ?, 'manual')`
    ).run(ts.slice(0, 10), slot, ts);

    try {
      const result = await runJob("intraday", { db, clients, now: at });
      // 没抛错 ≠ 成功：0 条写入 + 99 个批次失败也会正常返回，记成 done 就是撒谎
      const outcome = jobOutcome("intraday", result.stats);
      db.prepare(
        `UPDATE job_run SET status = ?, finished_at = ?, stats_json = ?, error = ?
         WHERE date = ? AND job = 'intraday' AND slot = ?`
      ).run(outcome.ok ? "done" : "failed", shanghaiTs(), JSON.stringify(result.stats),
            outcome.reason ?? null, ts.slice(0, 10), slot);
      if (!outcome.ok) {
        pushNotification(db, {
          kind: "collect_failed", severity: "warn",
          title: "手动采集未取到数据", body: outcome.reason,
        });
        return Response.json({ ok: false, slot, reason: outcome.reason, ...result }, { status: 502 });
      }
      return Response.json({ ok: true, slot, ...result });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      db.prepare(
        `UPDATE job_run SET status = 'failed', finished_at = ?, error = ?
         WHERE date = ? AND job = 'intraday' AND slot = ?`
      ).run(shanghaiTs(), msg, ts.slice(0, 10), slot);
      // 手动采集失败要通知：用户正等着这次结果
      pushNotification(db, {
        kind: "collect_failed", severity: "warn",
        title: "手动采集失败", body: msg,
      });
      return Response.json({ ok: false, reason: msg }, { status: 502 });
    }
  } finally {
    inFlight = false;
    lastAt = Date.now();     // 从结束计时
    db.close();
  }
}
