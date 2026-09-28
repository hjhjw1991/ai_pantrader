import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Db } from "@/lib/db";

export const SCHEMA_VERSION = "1";

/**
 * 调 tar 时的 stdio：**不给 stdin**。
 *
 * 打包/解包都不读标准输入，但 execFileSync 默认会给子进程接一根 stdin 管道。
 * 在受限的 shell / CI 环境里（父进程的 stdin 不是可继承的常规句柄时），
 * 建这根管道会直接 EBUSY —— 表现为「导出备份失败」，而 tar 本身一点问题没有。
 *
 * 关掉 stdin 顺带堵掉另一个隐患：万一 tar 因为参数异常想去读输入，
 * 有管道就会挂在那里等到超时，没管道则立刻失败并报出真正的错。
 * stdout/stderr 仍走 pipe，tar 的诊断信息照常能拿到。
 */
export const TAR_STDIO: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];

/**
 * 备份包用哪个 tar 打/解。
 *
 * 不能简单地调 `tar` 了事 —— Windows 上 **PATH 里第一个 tar 是什么完全看运气**，
 * 而 Git for Windows 的 GNU tar 在 Windows 路径上有两个实测踩到的坑：
 *
 *   1. 盘符被当成远程主机。GNU tar 的 `主机:文件` 语法把 `C:\...\x.ptbak`
 *      里的 `C` 读成主机名，真的去连：
 *        tar (child): Cannot connect to C: resolve failed
 *        tar: Child returned status 128
 *      报错跟「路径写错了」毫无相似之处，不查根本想不到是打包命令的问题。
 *      要 `--force-local` 才关得掉。
 *   2. 反斜杠被它转义坏掉。`-C C:\Users\...` 会被转成
 *        tar: C\:\\Users\\Admin\\...: Cannot open: No such file or directory
 *      路径必须给成正斜杠才对。
 *
 * 麻烦在于**两个 tar 对 `--force-local` 互斥**：
 *   GNU tar(MSYS) 要它；系统自带的 bsdtar 不认它（`Option --force-local is not supported`）。
 * 没有一套参数能通吃，所以直接选实现：Windows 上用系统自带的 bsdtar
 * （Win10 17063+ 内置，路径语义正常），找不到再退回 PATH 上的 tar 并补 --force-local。
 *
 * macOS / Linux 一律走 PATH 里的原生 tar，行为与此前完全一致。
 */
export const TAR: { bin: string; extra: string[] } = pickTar();

function pickTar(): { bin: string; extra: string[] } {
  if (process.platform !== "win32") return { bin: "tar", extra: [] };
  const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  const sysTar = path.join(root, "System32", "tar.exe");
  return fs.existsSync(sysTar)
    ? { bin: sysTar, extra: [] }
    : { bin: "tar", extra: ["--force-local"] };
}

/**
 * 传给 tar 的路径一律用正斜杠。
 *
 * Windows 的文件 API 本来就认正斜杠，所以这个转换对调用方无感；
 * 但对 MSYS 版的 GNU tar 是必须的（见上面第 2 条），否则反斜杠会被转义坏。
 */
export const tarPath = (p: string): string => p.replace(/\\/g, "/");

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
  // 周/月线。看着像派生数据（确实能由日线重算），但重算依赖复权因子，
  // 而因子要重新打 5888 次新浪 —— 换机后到下一次刷新之间，多周期指标全是空的。
  // 体积也不大：一只票四年约 200 根周线 + 48 根月线。
  "kline_period",
  "sector_rank", "lhb", "lhb_seat", "macro", "security", "trading_calendar",
  "data_gap", "source_health",
  // 策略与台账。预测/成交/持仓是不可再生的历史资产，必须跟数据一起搬。
  // strategy 另有 .ptstrat 单独导出（spec §9.2），但 .ptbak 也带一份，
  // 否则换机后台账里的 strategy_id 会指向不存在的策略。
  "strategy", "watchpool", "prediction", "outcome", "advisor_output",
  "account", "position", "trade", "ord",
  // 调度台账：哪些时点漏采过是不可再生的覆盖率史，换机后不该丢
  "job_run",
  // 回测/扫描存档。看着像派生数据，其实不可再生：一份报告是"**当时那份 YAML**
  // 配合当时那段数据"算出来的，参数改过之后今天重跑给不出同一个答案。
  // 而重算的代价很实在 —— 四年跨度单次回测约 6 分钟，36 点扫描约 3.7 小时。
  // 体积可以忽略：最多留 50 份，一份四年跨度约 50 KB。
  "backtest_report",
  // 代码→行业映射。可以重采，但重采一次要 100+ 个请求、按周刷新，
  // 换机后到下一次刷新之间可能空好几天 —— 而它一空，主线筛会把新来源的候选
  // 全部挡掉（"未判定不等于通过"），表现为候选池悄悄缩回只剩涨停股。
  // 5,888 行，带上几乎不占地方。
  "security_sector",
  // 申万行业快照。**最不可再生的一张**：申万只给"当前成分"，历史变更轨迹的对外渠道
  // 已经停了（带结束日期的文件冻结在 2022-03-25 且该列全空）。退出日期只能靠相邻两张
  // 快照差分推出来，所以这张表的价值完全来自"攒了多久"——丢一次等于把行业变更史
  // 清零重来，而且丢掉的那段永远补不回来（今天去采只能采到今天的归属）。
  "sw_industry_snapshot",
  // 估值快照。和涨停池同属"当日现场"：东财只给此刻的 PE/PB，没有历史接口。
  // 丢了就是从丢的那天起重新攒，之前那段永远补不回来。
  "valuation_daily",
  // 解禁日历。严格说可以重拉（东财给的是 2010→2035 的完整日历），
  // 但它 3 万多行、带上几乎不占地方，而换机后到下次刷新之间解禁判据会整个失明
  "lift_schedule",
  // 减持计划。同花顺每只票只留最近约 2 条，旧的会被挤掉 —— 丢了就永远拿不回来
  "reduction_plan",
  // 两融、互联互通、已实施增减持。三者都能从东财重拉，但回补两年两融要 4000+ 次请求、
  // 约 45 分钟，换机后这段时间里杠杆资金类判据全部失明；体积不大，带上
  "margin_market", "margin_stock", "mutual_deal", "mutual_top10", "holder_change",
  // 情绪截面派生表。能从日线重算，但三年约 750 天 × 0.3 秒，而且没有它
  // 情绪周期因子全报"未构建"；一天一行，体积可以忽略
  "sentiment_daily",
  // 影子盘。live 样本不可再生（那天 09:15 的判断只发生一次），回放样本可重算但要几十分钟；
  // 毕业判定完全建在这几张表上，丢了等于把所有变体的考核清零重来
  "shadow_variant", "shadow_pred", "shadow_outcome", "strategy_switch",
  // 代理截面。可由日线重算，但 1000+ 天要十来分钟，而没有它 2026-08 以前的主线与候选全是空的
  "zt_proxy", "sector_rank_proxy", "cross_proxy_built",
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
  /**
   * 行业区间表，纯派生：由 sw_industry_snapshot 差分重算，而那张表在 BAK_TABLES 里。
   * 重算是纯本地操作、不打任何源，所以没必要占备份体积。
   *
   * 与 kline_period 的差别就在这儿 —— 那张表虽然也"能重算"，但重算依赖复权因子，
   * 而因子要重新打 5,888 次新浪；换机后到下一次刷新之间，多周期指标全是空的。
   */
  "sw_industry_span",
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
    execFileSync(TAR.bin, [...TAR.extra, "-czf", tarPath(outPath), "-C", tarPath(stage), "pantrader.db", "meta.json"], { stdio: TAR_STDIO });
    return meta;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
