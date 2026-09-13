# 参与贡献

English: see [Contributing](#english) below.

欢迎。这个项目是一套**自用的** A 股盘面量化系统，开源是为了让它被更多真实场景检验。
下面的约定大多不是风格偏好，是踩过的坑 —— 先读一遍能省下被打回的时间。

## 先跑起来

```bash
node scripts/doctor.mjs        # 环境体检：缺什么、怎么补。只读，装依赖前就能跑
pnpm install
pnpm test                      # 1100+ 单元测试，不打网络
```

改代码前，`pnpm test` 应该是全绿的。如果你在**干净的仓库**上就红了，那本身是个 bug，
请直接开 issue 并附上 `node scripts/doctor.mjs` 的输出。

不想灌真实数据也能看界面：

```bash
node scripts/setup.mjs --no-data --dev
```

## 提 PR 前

```bash
pnpm exec tsc --noEmit    # 类型
pnpm test                 # 测试
pnpm build                # 生产构建
```

CI 会在 **Linux / macOS / Windows × Node 22 / 24** 六个组合上跑同样三条。
本地过了但 CI 挂了，大概率是路径分隔符或大小写敏感 —— 那正是 CI 存在的理由。

## 这个仓库的硬约束

**动核心逻辑前请先读 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。**
那里按章节号索引了代码里 193 处 `spec §N` 引用背后的规矩。

最容易无意踩到的四条：

1. **`lib/factors/` 和 `lib/strategy/` 不许碰存储、网络、时钟、随机数。**
   数据一律从 `PointInTimeView` 进来，"现在" 是 `view.asOf`。
   这条断言是**按字面 grep** 的，连注释里都不能出现 `db.` / `sqlite` / `Date.now` /
   `fetch` 这些字样 —— 测试文件自己都得写成 `"f" + "etch"` 来绕开。

2. **同一份输入跑两次，回测结果哈希必须一致。**
   回放路径里出现 `Date.now()`、`new Date()` 或随机数就会破坏它。时间戳一律外部注入。

3. **不许看未来。** `PointInTimeView` 读到 `asOf` 之后的数据要**抛异常**，不能返回空 ——
   返回空会被因子当成"当天没涨停"，把一个该炸的 bug 变成一个安静的错误读数。

4. **缺数据不许静默通过。** 查不到的条件、低置信的因子、有缺口的日子，
   全部抬到信号卡的 `warnings` 或回测报告首页。静默放过等于宣称"条件都查过了"，
   那是这套系统里最贵的一种假阳性。

前三条都有测试守着（`tests/*/purity.test.ts`、`tests/backtest/determinism.test.ts`、
`tests/pit/no-lookahead.test.ts`）。你改坏了会看到红，不用背。

## 注释写"为什么"，不写"是什么"

这是本仓库和多数项目最大的不同，也是 review 时最常提的意见。

代码本身已经说清"做了什么"。注释的位置留给**当时的判断**：为什么是这个阈值、
为什么不用那个看起来更自然的写法、这个分支是哪次线上故障留下的。

```ts
// ✗ 没有信息量
// 把 pct 和阈值比较
if (pct >= threshold) ...

// ✓ 记住了判断
// 判封板要 pct 达阈值 **且** close == high：光看 pct 会把"盘中触板又打开"
// 误记成涨停，那天的连板高度就整个错了
if (pct >= threshold && close === high) ...
```

策略 YAML 里的注释尤其重要 —— 那些数字是真金白银复盘出来的，
loader 会原样保留它们。**改阈值请连注释一起改。**

中文注释是本仓库的惯例（业务领域是 A 股，术语翻译成英文反而失真）。
代码标识符用英文，业务概念保留中文（`必查链`、`盘面强度`）。

## 提交与 PR

- 提交信息说明**为什么改**，不是复述 diff。多数提交正文比标题长，这是刻意的。
- 一个 PR 做一件事。顺手的重构请另开一个。
- 改了行为就要有测试。改了约束却没有测试变红，说明那条约束根本没被守住 —— 那是另一个 bug。
- 加了 npm script 要写进两个 README；加了 `spec §N` 引用要写进 `docs/ARCHITECTURE.md`。
  这两条有测试（`tests/package-scripts.test.ts`、`tests/docs.test.ts`）会自动查。

## 数据源的礼节

采集走的是东方财富、新浪、腾讯的**免费公开接口**。它们没有配额承诺，也没有义务服务我们。

- **不要为了调试反复跑全量采集。** 单测一律不打网络；要验真接口用 `pnpm test:live`，克制点。
- 客户端有按主机的熔断器（连续失败 3 次开闸、冷却 5 分钟）和限频，**别绕过它们**。
- CI 永远设 `PANTRADER_NO_SCHEDULER=1`，不让采集器在 CI 上跑起来。

如果你的改动会显著提高请求频率，请在 PR 里说明，并给出退避策略。

## 不接受的改动

- **自动下单。** 券商权限到位且 paper 模式连续跑满一个季度并达标之前，
  系统里不存在下单能力（见 ARCHITECTURE §18.2）。这是红线，不是待办。
- **让回测变好看的"优化"**：关掉 T+1、关掉涨跌停、去掉滑点、用当前在市清单回测历史。
  这些都会让结果系统性虚高，`DEFAULT_CONSTRAINTS` 默认全开是有原因的。
- **系统自动改写策略 YAML。** 参数建议只出建议，由人来改。
  自动改写要猜缩进与注释归属，猜错会破坏那些复盘注释。

## 报 bug

开 [issue](https://github.com/hjhjw1991/ai_pantrader/issues)，带上 `node scripts/doctor.mjs`
的输出 —— 它会列出平台、Node 版本、原生模块状态、定时任务指向，
这几项能省掉大半轮来回。

**请不要在 issue 里贴你的真实持仓、账户信息或数据库文件。**

---

<a name="english"></a>

# Contributing (English)

Welcome. This is a **personal-use** A-share quant dashboard, open-sourced so it gets
tested against more real situations. Most conventions below aren't style preferences —
they're scar tissue. Reading this first will save you a round of review.

## Getting started

```bash
node scripts/doctor.mjs        # Environment check-up. Read-only, runs before install
pnpm install
pnpm test                      # 1100+ unit tests, no network
```

Tests should be green on a clean checkout. If they aren't, that's a bug — please open an
issue with the output of `node scripts/doctor.mjs`.

## Before opening a PR

```bash
pnpm exec tsc --noEmit
pnpm test
pnpm build
```

CI runs these on **Linux / macOS / Windows × Node 22 / 24**.

## Hard constraints

**Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before touching core logic.** It indexes
the 193 `spec §N` citations scattered through the code.

The four you're most likely to trip over:

1. **`lib/factors/` and `lib/strategy/` must not touch storage, network, the clock, or
   randomness.** Data arrives through `PointInTimeView`; "now" is `view.asOf`. The assertion
   is a **literal grep**, so even comments can't contain `db.` / `sqlite` / `Date.now` /
   `fetch` — the tests themselves are written as `"f" + "etch"` to avoid matching.
2. **The same input must hash to the same backtest result.** No `Date.now()`, `new Date()`,
   or randomness anywhere on the replay path. Timestamps are injected from outside.
3. **No look-ahead.** Reading past `asOf` must **throw**, never return empty — empty reads as
   "nothing limit-up that day", turning a crash into a silently wrong number.
4. **Missing data must never pass silently.** Unevaluated conditions, low-confidence factors,
   and gap days all surface in the signal card's `warnings` or on the report's front page.

The first three are covered by tests, so you'll see red rather than having to remember.

## Comments explain *why*, not *what*

This is the biggest difference from most repos and the most common review comment. The code
already says what it does; comments are for the judgment behind it — why this threshold, why
not the obvious alternative, which incident this branch came from.

Comments are written in Chinese by convention (the domain is the Chinese A-share market;
translating the terminology loses precision). Identifiers are English; domain concepts stay
Chinese.

## Commits and PRs

- Explain **why**, not what the diff shows.
- One thing per PR.
- Behaviour change ⇒ test. If you changed a constraint and no test went red, that constraint
  wasn't actually enforced — that's a separate bug.
- New npm script ⇒ document it in both READMEs. New `spec §N` citation ⇒ add it to
  `docs/ARCHITECTURE.md`. Both are checked by tests.

## Be polite to the data sources

Collection uses **free public endpoints** from Eastmoney, Sina and Tencent. They owe us
nothing.

- Don't re-run full collection to debug. Unit tests never hit the network; use `pnpm test:live`
  sparingly.
- The client has per-host circuit breakers (3 failures to open, 5-minute cooldown) and rate
  limits. **Don't bypass them.**
- CI always sets `PANTRADER_NO_SCHEDULER=1`.

## Changes that won't be accepted

- **Automated order placement.** Off-limits until broker access is in place and paper mode has
  run a full quarter on target (ARCHITECTURE §18.2). This is a red line, not a TODO.
- **"Optimisations" that flatter the backtest**: disabling T+1 or price limits, dropping
  slippage, backtesting history against the current listing. All of these inflate results.
- **Having the system rewrite strategy YAML.** Suggestions only; a human edits the file.

## Reporting bugs

Open an [issue](https://github.com/hjhjw1991/ai_pantrader/issues) with the output of
`node scripts/doctor.mjs`.

**Please don't paste your real positions, account details, or database file into an issue.**
