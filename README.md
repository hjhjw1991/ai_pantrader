# PanTrader

A股盘面量化系统 · 本地优先 · 人在环上 · 闭环自校准

设计文档：`../docs/superpowers/specs/2026-08-03-pantrader-design.md`
实施计划：`../docs/superpowers/plans/2026-08-03-pantrader-m0-data-foundation.md`

## 当前阶段：M0 数据地基

已完成：采集、多源降级与熔断、交易日历、缺口检测与回补、launchd 调度、数据库导入导出。

**尚不包含**：因子、策略、回测、前端（M1–M4）。

## 快速开始

```bash
pnpm install
pnpm bootstrap     # 首次：灌证券清单 + 交易日历（可中断，重跑自动续拉）
pnpm job selfcheck                # 缺口与覆盖率自检
pnpm install-launchd   # 安装 6 个定时任务
```

## 数据位置

数据库与快照在 `~/PanTraderData/`，**不在本仓库内** —— 免费数据源随时被封，
攒下来的快照是不可再生资产，必须能独立备份和搬迁。

用 `PANTRADER_DATA_DIR` 覆盖路径。

## 常用命令

| 命令 | 用途 |
|---|---|
| `pnpm job <name>` | 手动跑 job：`selfcheck` / `preopen` / `intraday` / `close` / `post` / `night` |
| `pnpm db:export [out.ptbak]` | 导出数据库（VACUUM 一致性快照 + meta + sha256） |
| `pnpm db:import <f.ptbak> [replace\|merge\|dry-run] [newer\|local\|incoming]` | 导入 |
| `pnpm test` | 单元测试（不打网络） |
| `pnpm test:live` | 打真实接口的 smoke 测试 |

## 调度

| 时间 | Job | 内容 |
|---|---|---|
| 08:50 | `selfcheck` | 缺口扫描 + 覆盖率 |
| 09:00 | `preopen` | 同步交易日历 |
| 09:35–11:30 / 13:00–14:55 每 5min | `intraday` | 全市场快照 + 关注池分钟线 |
| 15:05 | `close` | 全市场快照 + 涨停池 |
| 17:00 | `post` | 龙虎榜 |
| 22:00 | `night` | 日线全量 + 可回补缺口回补 |

所有 job 执行前先查 `trading_calendar`，非交易日立即退出。全部用 `caffeinate -i` 包住防休眠。

卸载：
```bash
launchctl unload ~/Library/LaunchAgents/com.pantrader.*.plist
rm ~/Library/LaunchAgents/com.pantrader.*.plist
```

## 数据源现状（实测，2026-08-03）

| 数据 | 源 | 可回补 |
|---|---|---|
| 分钟线 1/5/15/30/60 | 新浪 `getKLineData` | ❌ 无 end-date 参数，只能拿最近 1023 根 |
| 实时快照 | 腾讯 `qt.gtimg.cn`，60 只/请求 | ❌ |
| 日线 | 新浪 `scale=240` | ✅ 一次 1023 根，约到 2022-05 |
| 涨停池 / 板块榜 | 东财 `push2ex` / `push2` | ❌ 只有当日 |
| 龙虎榜 | 东财 `datacenter` | ✅ 按历史日期回补，自带 D1/D5/D10 后续涨跌 |
| 交易日历 | 新浪 上证指数日线 | ✅ |

### 踩过的坑（都已在代码里处理，改动前先读）

1. **单源必死** —— 东财约 15 次请求即整体限流，5 个 `push2his` 主机同时返回空。已做多主机轮换 + 轮间退避。
2. **熔断必须 per-host** —— 限流是 per-host 的，源级熔断会在轮换到第 3 个主机时掐死剩余 7 个（全返回 `circuit open`，一次真实请求都没发）。
3. **空响应体不是"没数据"** —— 是限流的典型表现。静默当成空会让策略误判"今天没涨停"。`httpGet` 一律判失败。
4. **长任务要增量落库** —— 拉 56 页攒内存里最后写，第 28 页失败会丢掉前 27 页 2700 只。
5. **分页要按代码排序** —— 按涨幅 `fid=f3` 分页，盘中价格变动导致行漂移，实测 36 页重复 229 条，有重复就有遗漏。
6. **日历要用 `sh000001`** —— `sinaSymbol("000001")` 会算成 `sz000001`（平安银行），个股停牌会让日历漏交易日。
7. **不可回补的数据缺一天永久缺一天** —— 分钟线、涨停池、板块榜的采集失败必须告警，不能静默重试了事。
8. **北交所要用 `bj` 前缀** —— `sz832317` / `sh832317` 都返回 `v_pv_none_match`，只有 `bj832317` 有数据。少了这条，全市场快照会静静地少 343 条还报成功。
9. **交易日历不能只靠日线** —— 当日日线要收盘后才有，盘中查表会判成非交易日，所有盘中 job 全部跳过。用实时行情时间戳兜底（`ensureTradingDay`）。
10. **`pnpm import` / `pnpm export` 是 pnpm 内置命令** —— 会劫持同名 script。所以用 `db:import` / `db:export`。
11. **live 测试需要独立 config** —— 主 config 把 `tests/live` 放进 `exclude`，`--dir` 不覆盖 exclude。

## 已知残留

- 4 只证券取不到实时快照（1 主板 + 3 北交所），覆盖率 5884/5888 = 99.93%，推测长期停牌
- launchd plist 里的 node 路径是安装时的 `process.execPath`（当前指向 nvm）。切换 node 版本后需重跑 `pnpm install-launchd`
- 复权因子未实现（spec R1）：新浪日线不复权，腾讯 qfq 只回溯到 2023-12，2022-05~2023-12 无复权参照

## 架构约束

- `lib/data/` 是**唯一**允许发网络请求的目录
- 采集失败**永不静默返回空**，必须抛错或记 `data_gap`
- 回测遇到 `data_gap` 日直接跳过，并在报告里标注覆盖率（M3）
