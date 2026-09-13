# 架构约束

> **这份文档是从代码反推的，不是原始 spec。**
>
> 代码里有 193 处 `spec §N` 引用，分布在 103 个文件里，但那份设计文档没有进过仓库。
> 对外部贡献者来说，这等于 193 条查不到出处的"规矩"。
>
> 所以这里把每个被引用的章节号，按**引用处自己写明的内容**整理成索引。
> 凡是能对应到测试的，都标了测试文件 —— 那才是约束的真正执行者，
> 这份文档只是导航。文档与代码冲突时，**以代码和测试为准**。

## 怎么用

看到代码里写 `spec §10.4`，来这里查 [§10.4](#104-参数寻优的目标是-calmar)。
要改动某条约束，先看它对应的测试：改了约束而测试没红，说明约束根本没被守住，那是另一个 bug。

---

## 分层与依赖方向

```
app/            页面与 API 路由（Next App Router）
components/     纯展示组件
lib/ui/         页面要的查询与适配（这一层可以碰数据库）
lib/strategy/   规则引擎 —— 零存储访问
lib/factors/    因子实现 —— 零存储、零网络、零时钟、零随机
lib/pit/        PointInTimeView 实现（唯一允许读库的"喂数据"层）
lib/backtest/   回放、寻优、指标、覆盖率
lib/ledger/     台账与自校准闭环
lib/data/       采集器、数据源、调度
lib/db/         迁移与连接
lib/contracts/  类型契约（各层之间只认它）
```

依赖方向是单向的：`factors` 和 `strategy` 只认 `contracts` 里的 `PointInTimeView`，
**不认数据库**。数据怎么来是 `lib/pit/` 的事。这条线是整套系统能同时跑实盘和回测的前提：
同一份策略代码，实盘喂当日视图、回测喂历史视图，不存在两套实现。

---

## §17 四条 CI 断言 —— 最硬的约束

这四条是其余所有约束的地基，也是本仓库最容易被无意破坏的地方。
它们**已经有测试守着**，不是口头约定。

### 断言 1：`ADVISOR=null` 时全套测试必须绿

AI 顾问是可选层。默认实现是 `lib/advisor/null.ts`，什么都不改。

> 为什么：有 AI / 无 AI 如果是两套代码路径，其中一套永远缺测试。
> 见 `lib/advisor/index.ts`。

### 断言 2：`lib/factors/` 不许有 IO 与未来函数

零网络、零存储、不取系统时间、不用随机数、无可变模块级状态。
"现在"一律是 `ctx.view.asOf`（见 `lib/factors/util.ts`）。

- 测试：`tests/factors/purity.test.ts`
- 禁用字面量：`fetch`、`axios`、`Date.now`

### 断言 3：`lib/strategy/` 与 `lib/factors/` 里 grep 不到存储访问

```
grep -rE "\bdb\.|prisma\.|sqlite" lib/factors/ lib/strategy/    # 必须零命中
```

- 测试：`tests/strategy/purity.test.ts`、`tests/factors/purity.test.ts`

> **这条断言按字面 grep，连注释里都不能出现那几个标识符。**
> 所以测试自己写成了 `"f" + "etch"` 这种拼接 —— 不是故作聪明，是不这么写测试文件自己就会命中。
> 这也是 `lib/pit/` 单独成目录的原因：spec §15 的目录树本来把 pit-view 画在 `lib/strategy/` 下，
> 但那样这条断言就不可能成立。同理 `lib/ledger/strategy-snapshot.ts` 放在 ledger 而不是 strategy。

### 断言 4：同一份输入跑两次，结果哈希必须一致

回放路径里**不许出现 `Date.now()`、`new Date()`、随机数**。

- 哈希实现：`lib/backtest/hash.ts`（只覆盖输入与结果序列，**不含** `generatedAt`）
- 时间戳一律外部注入：见 `lib/ui/adapters/engines.ts`、`app/api/backtest/route.ts`
- 滑点方向固定、不做随机：`lib/backtest/constraints.ts`
- 寻优用网格而非随机搜索：`lib/backtest/optimizer.ts`
- 测试：`tests/backtest/determinism.test.ts`、`tests/strategy/engine.test.ts`

---

## §4 策略层契约

### §4.1 规则引擎的三条硬约束

见 `lib/strategy/engine.ts` 文件头：

1. 只读，且**只通过 `PointInTimeView` 拿数据**；
2. 不取系统时间，"现在" = `input.view.asOf`；
3. 因子经 `FactorRegistry` 接口注入，不 import 具体因子实现。

外加一条产品约束：**缺数据不许静默通过**。没有对应因子的防守条件、未判定的筛子、
低置信因子，全部抬到信号卡的 `warnings` 上。静默放过等于宣称"条件都查过了"。

### §4.2 越界访问必须抛异常

`PointInTimeView` 读到 `asOf` 之后的数据要抛，**不能返回空数组**。

> 返回空会被因子当成"当天没涨停"，一个本该炸掉的 bug 变成一个安静的错误读数。

- 实现：`lib/pit/sqlite-view.ts`
- 测试：`tests/pit/no-lookahead.test.ts`

---

## §5 AI 顾问层

### §5.1 实现选择顺序

探测到 `claude` CLI → 用子进程（`lib/advisor/claude-cli.ts`）；
探测到 `ANTHROPIC_API_KEY` → 直连 Messages API（`lib/advisor/claude-api.ts`）；
`ADVISOR` 环境变量显式指定时优先（设置页可强制）。

- 入口：`lib/advisor/index.ts` · 测试：`tests/advisor/factory.test.ts`

### §5.2 每次填槽都要留结构化快照

快照含**提示词哈希 + 输入快照哈希**，两者分开。时间戳取 `view.asOf` 而非 `Date.now()`。

> 没有快照，回测就不可复现，断言 4 直接不成立。

- `lib/advisor/prompt.ts`、`lib/advisor/store.ts`、`lib/contracts/advisor.ts`

### §5.3 Advisor 的 with/without A/B

`advisorInfluenced` 必须是真布尔值，且只标记**真的改过信号**的那些快照。
只知道"顾问跑过"没用 —— 量化 AI 的边际贡献要靠这个字段分组。

- `lib/advisor/apply.ts`、`lib/ledger/winrate.ts`、迁移 `007_advisor_run_id.sql`
- 前端：台账页的「Advisor A/B」面板

---

## 编号决策

代码里另有两处按 `D<n>` 引用的决策：

- **D2** —— `lib/advisor/index.ts` 的工厂是**全系统唯一允许对 Advisor 模式分支的地方**。
  别处再出现 `if (hasClaude)` 就说明设计歪了：那意味着有/无 Claude 变成两套代码路径，
  其中一套永远缺测试，§17 断言 1 也就失去意义。
- **D7** —— 策略 YAML 是参数的唯一真相源，见 [§9.1](#91-yaml-是参数的唯一真相源决策-d7)。

---

## §7 策略、信号与账户的存储模型

对应迁移 `lib/db/migrations/004_strategy_signal.sql`。

> 代码里只有这一处引用，本节内容在引用处没有展开。

---

## §8 因子体系

因子分组：环境 / 外围传导 / 技术 / 资金 / 过滤器 / 主线与温度计。
`tests/factors/registry.test.ts` 断言**每个组都有因子**。

| 组 | 文件 | 内容 |
|---|---|---|
| 环境 | `lib/factors/env.ts` | 盘面强度 / 情绪温度 / 赚钱效应 / 连板高度 |
| 外围 | `lib/factors/macro.ts` | A50 / 费半 / 金油 → 今天开盘方向 |
| 技术 | `lib/factors/tech.ts` | 布林(位置%/带宽) · MA5/20 方向 · 量能 · 洗盘vs派发 |
| 资金 | `lib/factors/fund.ts` | 龙虎榜净买聚类 · 游资席位识别 · 板块净流入 |
| 过滤器 | `lib/factors/filters.ts` | 七道筛，阈值全参数化 |
| 主线 | `lib/factors/sectors.ts` | 主线识别与龙头温度计 |

### §8.1 涨跌停的分板阈值

日线数据里没有"是否涨停"这个字段，要用 `pct` 与 `close == high` 重建。

- ST 优先于板块：戴帽期间不论哪个板都按风险警示档，但**北交所不适用 ST 5%**
- 上市首日无涨跌幅限制 → 排除，不计入涨停家数
- 判封板 = `pct` 达阈值 **且** `close == high`
- 阈值留了零股与四舍五入的余量

实现：`lib/factors/limit-up.ts`、`lib/backtest/constraints.ts`
测试：`tests/factors/limit-up.test.ts`、`tests/backtest/constraints.test.ts`

### §8.2 必查链写死，不可关闭

必查链是**叠加项**，不是替换项：策略 YAML 里写空数组也照扫那四条链。

- schema 层直接否决空数组：`lib/strategy/schema.ts`
- 参数建议层刻意不给它映射：`lib/ledger/suggest.ts`（不接受"建议缩短必查链"）
- 测试：`tests/strategy/schema.test.ts`

---

## §9 策略配置

### §9.1 YAML 是参数的唯一真相源（决策 D7）

参数面板只是 YAML 的投影，不存在数据库里的第二份副本。

- **系统不自动改写 YAML**：自动改写需要猜缩进与注释归属，猜错会破坏原文。
  那些注释记的是"为什么是这个数"，是几次真金白银的复盘留下来的。
- 组合风控四项：总仓位上限 / 单票最大占比 / 单行业最大占比 / 核心卫星比例
- 测试 `tests/strategy/schema.test.ts` 断言**字段与 spec 一字不差**；
  `tests/factors/filters.test.ts` 断言默认阈值与 spec 的 YAML 示例一致

### §9.2 三重校验 + 行号定位

1. 结构校验（`lib/contracts/strategy.ts` 定结构）
2. 取值区间校验（`lib/strategy/schema.ts`）
3. `.ptstrat` 策略包的 `factors.lock`：因子缺失 / 版本不匹配要列清单（`lib/factors/registry.ts`）

**导入非法值必须报出具体行号** —— 为此有 `lib/strategy/yaml-pos.ts` 这一整个模块。

版本号语义：改阈值升 patch，改规则结构升 minor。否则历史回测结论无法归因到具体哪一版参数。

---

## §10 回测

### §10.1 A 股约束默认全开

T+1、涨跌停、滑点、手续费。**关掉任何一条回测都会虚高**，所以 `DEFAULT_CONSTRAINTS` 全开。

`lib/backtest/constraints.ts`、`lib/contracts/backtest.ts`

### §10.2 幸存者偏差

标的池只能来自 `view.universe()`，按当日 `listDate`/`delistDate` 过滤。

> 用当前在市清单回测 2022 年 = 假装当年买的没一只退市，收益系统性高估。

- 持仓票掉出当日标的池 → **强制清算**（`lib/backtest/replay.ts`）
- `list_date` 未知的票会逃过过滤，所以**这个折扣要能量化**：
  `lib/ui/adapters/engines.ts` 暴露实际覆盖率，页面上明写
- 测试：`tests/pit/no-lookahead.test.ts`、`tests/backtest/replay.test.ts`

### §10.3 代理因子必须标红，不藏

情绪类因子由日线代理重建，不是真值。

- 每个因子带 `provenance` 与 `confidence`（`lib/contracts/factor.ts`）
- **ρ < 0.8 的代理因子进回测报告首页标红清单**（`LOW_CONFIDENCE = 0.8`）
- 信号卡用同一把尺子（`lib/strategy/engine.ts`）
- 相关性结论要攒够真快照天数才允许出（`lib/backtest/proxy-audit.ts`）
- 测试：`tests/factors/purity.test.ts`、`tests/backtest/proxy-audit.test.ts`

### §10.4 参数寻优的目标是 Calmar

**Calmar = 年化 / 最大回撤，不是纯收益。**

- 网格 + 由粗到精，不用随机搜索（随机会破坏断言 4）
- 热力图单元格也是 Calmar，与 `optimize()` 目标一致
- **样本内/外 7:3 滚动切分。样本外不过就是不过，不许回头调样本内**
- 看热力图要看"峰陡不陡"——峰陡是过拟合信号，比最优点更该看
- `lib/backtest/optimizer.ts`、`walkforward.ts`、`metrics.ts`

### §10.5 报告首页必含四项

覆盖率 · 缺口天数 · 低置信因子 · 有效区间。这四个不是可选装饰。

- **缺口日跳过并计数，绝不插值、绝不顺延决策**（`lib/backtest/replay.ts`）
- 缺口必须上信号卡，不能只写进日志（`components/SignalCardView.tsx`）
- 拿不到值的因子 → `value = null` + `confidence = 0`，进低置信清单
- `lib/backtest/coverage.ts` · 测试 `tests/backtest/coverage.test.ts`

---

## §11 台账与自校准闭环

**诚实定义**（`lib/ledger/query.ts` 原话）：这一层不是模型自训练，
是**规则库 + 参数随实盘对账进化**。

五个步骤，各有落点：

| 步 | 做什么 | 文件 |
|---|---|---|
| 1 | 信号落台账 | `lib/ledger/record.ts` |
| 2 | 到期对账 | `lib/ledger/reconcile.ts` |
| 3 | 错误聚类 | `lib/ledger/attribution.ts` |
| 4 | 参数调整建议 | `lib/ledger/suggest.ts` |
| 5 | 胜率统计 | `lib/ledger/winrate.ts`、`dashboard.ts` |

> 第 4 步**只出建议，不自动改 YAML** —— 与 §9.1 是同一条原则。

---

## §12 执行层

`execution.mode` 切换，**策略层零感知**（`lib/contracts/execution.ts`）。

当前只有 `ManualBroker`：回填一笔**已经在券商 App 里成交**的交易。
必须带真实成交价与时间，**不接受"按市价"**（`lib/ui/validate.ts`）。

---

## §13 页面

| 页面 | 内容 |
|---|---|
| 今日作战台 | 环境档位灯 / 候选池 / 持仓动作 / 龙头温度计 |
| 观察池 | 每只标的的买入条件 / 触发价 / 止损 + 实时距离 |
| 持仓 | 账户分离、浮盈亏、止损止盈线、硬线告警、组合风控占比 |
| 台账 | 命中率仪表盘、错误类型分布、预测 vs 实际时间线 |
| 实验室 | 选策略 + 调参 → 回测 → 净值/回撤/参数热力图/覆盖率 |
| 设置 | 数据库路径、导入导出、Advisor 模式、源健康、调度状态 |

推送走 SSE（`app/api/events/route.ts`）。**只有关键信号才响** ——
只有 `critical` / `warn` 才弹桌面通知。

---

## §15 目录树

spec 的目录树把 pit-view 画在 `lib/strategy/` 下，但那样 §17 断言 3 不可能成立，
所以实现挪到了 `lib/pit/`。见 `lib/pit/index.ts` 的说明。

---

## §18.2 红线：不自动下单

**券商权限到位 且 paper 模式连续跑满一个季度并达标之前，系统里不存在下单能力。**

- `lib/ui/status.ts` 里 live 模式被挡的原因**永远非空**
- `app/api/signal/fill/route.ts` 只把既成事实记下来，不下单

配套要求：**调度失败必须告警，不可静默**。

> 静默陈旧是这套系统里最不能发生的事：调度不跑 = 分钟线与截面数据每天永久缺失。
> **分钟线缺一天就永远缺一天**（不可回补），所以这类行必须顶到主页面，
> 不能收进详情抽屉。见 `components/StatusRail.tsx`、`lib/ui/queries.ts`。

---

## §19.2 未决事项

消息面 NLP 粗分类：**质量未验证，未进决策路径**（`lib/factors/filters.ts`）。

---

## 还没写进本文档的

这些约束在代码里有实现，但没有 `spec §` 引用，所以不在上面的索引里：

- **数据源熔断**：每个主机独立熔断器，连续失败开闸、冷却后半开。见 `lib/data/client.ts`
- **调度去重**：launchd/schtasks 与进程内调度器可能同时触发同一个 job，
  靠 `job_run` 表的 `(date, job, slot)` 声明去重。见 `lib/data/scheduler.ts`
- **PID 锁**：`~/PanTraderData/scheduler.pid` 保证只有一个采集进程。见 `scripts/daemon.ts`
- **引擎不接账户资金**：引擎只出比例，换算成金额由人做。这是设计边界，不是待办
