import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Db } from "@/lib/db";

export const SCHEMA_VERSION = "1";

export interface BakMeta {
  schemaVersion: string;
  createdAt: string;
  dateFrom: string | null;
  dateTo: string | null;
  tableCounts: Record<string, number>;
  sha256: string;
}

export const BAK_TABLES = [
  "kline_daily", "kline_min", "quote_snapshot", "zt_pool", "dt_pool",
  "sector_rank", "lhb", "lhb_seat", "macro", "security", "trading_calendar",
  "data_gap", "source_health",
  // 策略与台账。预测/成交/持仓是不可再生的历史资产，必须跟数据一起搬。
  // strategy 另有 .ptstrat 单独导出（spec §9.2），但 .ptbak 也带一份，
  // 否则换机后台账里的 strategy_id 会指向不存在的策略。
  "strategy", "watchpool", "prediction", "outcome", "advisor_output",
  "account", "position", "trade", "ord",
  // 调度台账：哪些时点漏采过是不可再生的覆盖率史，换机后不该丢
  "job_run",
];

/**
 * **故意不进 .ptbak** 的表，以及理由。
 *
 * 这份清单必须显式存在：db 测试断言"每张表要么在 BAK_TABLES、要么在这里"，
 * 于是新加一张真正的数据表时不可能被忘掉，而刻意排除的也留下了理由。
 * 只写一句"测试放宽一下"就会让那条防线失效。
 */
export const EPHEMERAL_TABLES = [
  // 界面告警队列。易失的提示，不是历史资产；搬到新机器上重算信号会重新产生
  "notification",
  // 信号状态摘要，纯派生缓存，只为"和上次比有没有变"服务。
  // 搬过去反而有害：旧状态会让第一次比对得出错误的"变化"，凭空弹一堆通知
  "signal_state",
];

function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

export async function exportBak(db: Db, _dbPath: string, outPath: string): Promise<BakMeta> {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "ptbak-"));
  const dbCopy = path.join(stage, "pantrader.db");

  try {
    // VACUUM INTO 产出一致性副本，且不锁住原库的后续写入
    db.prepare("VACUUM INTO ?").run(dbCopy);

    const tableCounts: Record<string, number> = {};
    for (const t of BAK_TABLES) {
      const r = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any;
      tableCounts[t] = r.n;
    }

    const range = db.prepare(
      `SELECT MIN(date) a, MAX(date) b FROM (
         SELECT date FROM kline_daily UNION ALL SELECT date FROM zt_pool
         UNION ALL SELECT date FROM lhb)`
    ).get() as any;

    const meta: BakMeta = {
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      dateFrom: range?.a ?? null,
      dateTo: range?.b ?? null,
      tableCounts,
      sha256: sha256File(dbCopy),
    };
    fs.writeFileSync(path.join(stage, "meta.json"), JSON.stringify(meta, null, 2));

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    execFileSync("tar", ["-czf", outPath, "-C", stage, "pantrader.db", "meta.json"]);
    return meta;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
