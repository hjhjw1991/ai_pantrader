# PanTrader

A 股盘面量化系统 · 本地优先 · 人在环上 · 闭环自校准

一台机器上跑完整条链路：采集 → 因子 → 策略 → 信号 → 台账对账 → 参数回写建议。
数据留在本地，不依赖任何付费数据源，不需要服务器。

> **红线：系统不会自动下单。** 下单在券商 App 手敲，回来在持仓页回填成交。
> 自动化要等券商权限到位 **且** paper 模式连续跑满一个季度并达标。前端里不存在下单能力，也没给它留配置口子。

---

## 一键安装

需要 **Node 22**（不是"≥ 22"，上界也卡死：`node -v` 检查；没有就 `nvm install 22 && nvm use 22`，仓库根目录有 `.nvmrc`）。

> 为什么不许更高版本：`better-sqlite3` 是原生模块，预编译的 `.node` 绑定 Node ABI，换大版本就装载失败；
> 而 `install-launchd` / `install-schtasks` 写进定时任务的解释器，是**安装当时那个 Node 的绝对路径**。
> 用两个 Node 会出现"采集在写库、网页说连不上库"这种撕裂状态。
>
> 拦截分三层：`.npmrc` 里的 `engine-strict=true` 让**任何 `pnpm` 入口**在版本不对时启动即失败（不再是一行 WARN 照跑）；
> `node scripts/setup.mjs --check` 会额外真装载一次 `.node`，把"版本号对但 ABI 不匹配"也探出来；
> 万一还是漏到了运行时，网页的 503 会把 ABI 号翻成"换回 Node 几"的具体动作。

```bash
git clone <仓库地址> pantrader
cd pantrader
node scripts/setup.mjs --start
```

这条命令会：检查环境 → 装依赖 → 建库跑迁移 → 灌证券清单与交易日历（打网络，1–3 分钟）→ 构建 → 启动网页 **http://localhost:3111**

Windows 一样这条命令，PowerShell 或 CMD 都行——脚本是纯 Node，没有 `.sh` / `.ps1` 两份实现。

### 其它开关

| 命令 | 用途 |
|---|---|
| `node scripts/setup.mjs --check` | 只检查环境，**不改任何东西** |
| `node scripts/setup.mjs --no-data` | 跳过灌数据，不打网络。先看界面结构 |
| `node scripts/setup.mjs --dev` | 开发模式启动（热更新，比生产模式慢） |
| `node scripts/setup.mjs` | 装完就停，不启动 |

装完之后日常只用 `pnpm start`。

### 手动安装（想逐步看清每一步）

```bash
pnpm install            # 装依赖
pnpm run migrate        # 建库 + 跑迁移（数据库落在 ~/PanTraderData/）
pnpm run seed-strategies # 从 config/strategies/*.yaml.example 播种策略实文件
pnpm run bootstrap      # 灌证券清单 + 交易日历。可中断，重跑自动续拉
pnpm build              # 构建
pnpm start              # 启动 → http://localhost:3111
```

`seed-strategies` 不能省：**策略实文件不进 git**，仓库里只有 `.yaml.example` 模板。
原因是 `持仓:` 段的键名就是你自己的账户 id，那是个人数据，不该躺在发行源里。
这一步幂等 —— 实文件已存在就跳过，不会覆盖你改过的阈值。

`pnpm` 没装就 `npm i -g pnpm`。用 npm 也能跑，但仓库带 `pnpm-lock.yaml`，npm 会忽略锁文件里的确定版本。

---

## 装完先做三件事

**1. 建账户** → http://localhost:3111/positions 最下面

系统**不预置任何账户**。账户是你组织自己资金的方式，程序无权替你起名。

三个字段：`账户 id`（台账主键，建后别改）、`显示名`、`类型标签`（自由文本，仅用于分组展示）。

**2. 把策略里的账户键名改成你的 id** → `config/strategies/default.yaml` 的 `持仓:` 段

每账户的止损规则来自这一段，**按账户 id 作键**。键名对不上，那个账户就没有硬线规则——
持仓页会用一个红色面板点名"这些 YAML 键在 account 表里不存在"并列出真正拿到规则的账户，不会静默失效。

改法有两条：直接编辑那个文件，或用 http://localhost:3111/settings 的「策略原文编辑」——
后者保存前会做 schema 校验、给 diff、并把原文备份成 `~/PanTraderData/strategy-backups/<文件名>.YYYYMMDD-HHmmss`。

> 这个文件被 `.gitignore` 忽略（模板 `default.yaml.example` 才进 git），所以你改它不会让 `git status` 变脏。
> 代价是策略演化史不能用 `git diff` 看了 —— 载体换成上面那个备份目录，每次写回都留一份带时间戳的全文，
> 且随 `~/PanTraderData` 一起备份，不会被 `git clean` 或重装项目连带删掉。

**3. 看一眼数据健康** → http://localhost:3111/settings

数据源全是免费非官方接口，会掉线、会限频、会改字段。这一页摊开源健康明细与缺口清单：陈旧独立成一档，不会并进"正常"。

---

## 页面

| 路径 | 内容 |
|---|---|
| `/today` | 今日信号卡：环境档位、目标仓位、买入候选、硬线告警 |
| `/positions` | 持仓、盈亏、止损距离、成交回填、**账户管理** |
| `/watchpool` | 观察池：每只带触发价 + 止损价 + 一句话逻辑 |
| `/ledger` | 预测台账与对账：胜率、偏差归因、参数回写建议 |
| `/lab` | 回测与 walk-forward |
| `/settings` | 数据源健康、缺口、调度状态、**策略管理**、参数面板、导入导出 |

页面每 60 秒自刷，另有 SSE 推送——档位切换 / 新增买入候选 / 硬线破位会弹桌面通知，例行数据刷新不弹。

---

## 数据采集

**只要跑起这个系统，采集就自动开始。** 跨平台进程内调度，不依赖 launchd / cron / 计划任务。

| 时间（上海） | Job | 内容 | 跨天可回补 |
|---|---|---|---|
| 08:50 | `selfcheck` | 缺口扫描 + 覆盖率 | ✅ |
| 09:00 | `preopen` | 同步交易日历 | ✅ |
| 09:35–11:30 / 13:00–14:55 每 5 分钟 | `intraday` | 全市场快照 + 关注池分钟线 | ❌ |
| 15:05 | `close` | 收盘快照 + 涨停池 | ❌ |
| 18:40 | `post` | 龙虎榜 + 营业部席位 | ✅ |
| 22:00 | `night` | 全量日线 + 缺口回补 + 龙虎榜标签重拉 | ✅ |

"跨天可回补"那一列是真实约束，不是标注习惯：**盘中快照是过去某一刻的现场，源上没有历史接口，缺一天就永久缺一天。** 所以漏采的时点如实记 `missed`，不记成成功——那等于伪造覆盖率。

想不开网页也采集：

```bash
pnpm run daemon          # 独立守护进程，带 PID 锁，不会起两个
```

装成开机级任务（可选）：

```bash
pnpm run install-launchd    # macOS
pnpm run install-schtasks   # Windows
```

### 唤醒补偿

系统重新活过来时（进程重启，或机器休眠后醒来）先问一句"上次干活是什么时候、漏了什么"：

- 回收卡在 `running` 的时点（休眠打断进程会留下这种残留，不回收就永不重跑也永不记 missed）
- 先同步交易日历，**再**判断漏了哪些交易日——日历是从指数历史 K 线推出来的，永远不含未来日期，不先同步就查不到沉睡期间任何一天
- 可回补的数据跑一次 `night` 做结构性覆盖（拉 1023 根日线 + 刷近 30 个交易日龙虎榜），不逐日重放
- 不可回补的时点如实记 `missed`

判据是"有交易日的可回补数据没落地"，不是"沉睡超过 N 小时"。后者会同时犯两种错：周末关机 60 小时其实一天都没漏，而周四到周五只隔 10 小时却漏掉了整个周五。

---

## 策略

策略是文件，不是数据库行：

```
config/strategies/<id>.yaml           可编辑的真相源，可增可删。**不进 git**
config/strategies/<id>.yaml.example   去个人化模板，进 git，供 seed-strategies 播种
config/strategies/ACTIVE              单行文本，当前生效的是哪个
```

实文件不进 git 是因为 `持仓:` 段的键名是你自己的账户 id。历史版本靠
`~/PanTraderData/strategy-backups/<文件名>.YYYYMMDD-HHmmss` 留存：每次写回（含面板改一个数）
都先备份，同一秒内连续保存加 `-2` 后缀，不做自动清理。

**YAML 是参数的唯一真相源。** 参数面板只是它的投影，不存第二份状态。面板改一个数字 = 在原文上替换一个纯量，注释与排版一个字节不动——那些注释记着每个阈值的由来，比面板改参的便利更值钱。

在 `/settings` 的「策略」面板里新增 / 切换 / 删除。新增是**复制现有策略的原文**（含全部注释），只改 `id:` 那一行；不是生成空模板，那会让你从"不知道这些数该是多少"开始。

跑出第一条预测时，策略原文会自动快照进 `strategy` 表（幂等，只留第一份）。这是删除能安全存在的前提：`prediction.strategy_id` 是台账归因键，快照在，文件就可以随便删，历史结论仍解释得清。

---

## 数据位置

```
~/PanTraderData/
├── pantrader.db          SQLite（WAL 模式）
├── snapshots/            原始响应留档
└── *.ptbak               导出包
```

`PANTRADER_DATA_DIR` 可以整体挪走。

**刻意放在仓库之外**：免费数据源随时会封，攒下来的历史是不可再生资产，必须能独立备份搬迁，也不该被 `git clean` 或重装项目连带删掉。

```bash
pnpm db:export                      # VACUUM 一致性快照 + meta + sha256
pnpm db:import <f.ptbak> dry-run    # 先看会发生什么
pnpm db:import <f.ptbak> merge newer
```

---

## 常用命令

| 命令 | 用途 |
|---|---|
| `pnpm start` / `pnpm dev` | 启动网页（生产 / 开发） |
| `pnpm run daemon` | 独立采集守护进程 |
| `pnpm run job <name>` | 手动跑一个 job：`selfcheck` `preopen` `intraday` `close` `post` `night` |
| `pnpm test` | 单元测试（**不打网络**） |
| `pnpm test:live` | 打真实接口的 smoke 测试 |
| `pnpm run migrate` | 跑迁移 |
| `pnpm run seed-strategies` | 从 `*.yaml.example` 播种策略实文件（幂等，不覆盖已有） |

> `pnpm import` / `pnpm export` 是 pnpm 内置命令，会劫持同名 script。所以叫 `db:import` / `db:export`。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PANTRADER_DATA_DIR` | `~/PanTraderData` | 数据库与快照位置 |
| `PANTRADER_CONFIG_ROOT` | 仓库根 | `config/` 的位置（测试用） |
| `PANTRADER_NO_SCHEDULER` | — | 设 `1` 禁用进程内采集器。跑回测/导入导出时用，避免抢限频额度 |
| `PORT` | `3111` | 网页端口 |

---

## 架构约束

这几条是硬约束，CI 里有断言守着，改动前先读：

- **`lib/data/` 是唯一允许发网络请求的目录**（唯一例外：advisor 传输层，已单独标注）
- **因子层与策略层不许碰数据库、不许读系统时间**。数据只能从 `PointInTimeView` 进来，"现在"只能是 `view.asOf`——否则回测会偷看未来，而看不出来
- **采集失败永不静默返回空**。必须抛错或记 `data_gap`。空响应体是限流的典型表现，不是"今天没数据"
- **时间戳一律上海挂钟时间**，毫秒精度（`source_health` 的主键需要）
- **台账只追加不改写**。同 id 同内容视为重复投递，同 id 不同内容直接报错

## 已知限制

- **复权因子未实现**：新浪日线不复权，腾讯前复权只回溯到 2023-12，2022-05~2023-12 段无复权参照 → 有效回测窗口约 2.6 年
- **组合风控三条限额算不出来**：需要账户权益/现金、行业分类、核心卫星标记，这三样目前没有输入源。引擎会把它们列进信号卡的"未判定条件"，**不会当成通过悄悄放过**
- **两个 advisor 传输层未对真实端点验证**
- **macOS 合盖休眠拦不住**：`caffeinate` 无法阻止 clamshell sleep。要盘中数据完整就得开着盖
- 少数证券取不到实时快照（长期停牌 / 部分北交所），全市场覆盖率约 99.9%

## 免责

本项目不构成投资建议。数据源为免费非官方接口，会掉线、限频、改字段，**非交易级**。
盈亏自负。
