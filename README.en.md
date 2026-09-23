# HouChao · 候潮

A-share market quant system · local-first · human-in-the-loop · self-calibrating closed loop

The whole chain runs on one machine: collection → factors → strategy → signals → ledger reconciliation → parameter suggestions. Data stays local. No paid data feed, no server.

> **Hard line: the system never places orders.** You place them by hand in your broker's app and fill the execution back in on the positions page.
> Automation waits until broker permissions are in place **and** paper mode has run a full quarter and met its targets. There is no order-placing capability in the frontend, and no config hook left for one.

[![CI](https://github.com/hjhjw1991/ai_pantrader/actions/workflows/ci.yml/badge.svg)](https://github.com/hjhjw1991/ai_pantrader/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

*[中文版 README](README.md)*

---

## One-command install

Requires **Node ≥ 22**. Check with `node -v`; if you don't have it, `nvm install 22 && nvm use 22` (the `.nvmrc` at the repo root gives the recommended version).

> The upper bound used to be pinned too (`>=22 <23`), because `better-sqlite3` v11 used `prebuild-install`, whose prebuilt artifacts are **split by Node ABI** — a major version bump failed to load.
> Upgrading to v13 removed that premise: it is N-API, and its artifacts are split by **platform** (`darwin-arm64` / `linux-x64` / `win32-x64`…), so one `.node` loads across Node major versions.
> Verified: the same install passes all 1136 tests under both Node 22 (ABI 127) and Node 24 (ABI 137), and reads the real 2.4 GB database under both.
>
> The lower bound stays: the code is written against Node 22's syntax and built-ins.
>
> Two layers catch problems: `engine-strict=true` in `.npmrc` makes **any `pnpm` entry point** fail at startup if the version is too low (instead of printing one WARN line and running anyway); `node scripts/setup.mjs --check` additionally loads the `.node` for real, which also catches "right version number, broken artifact" (copying `node_modules` from another machine does that). If it still slips through to runtime, the web UI's 503 translates the ABI number into the concrete action ("switch back to Node N").

**Environment check-up**: `node scripts/doctor.mjs` reports, for your platform, the state of each requirement, whether it is actually needed, and how to fix it — compiler toolchain (macOS Xcode CLT / Windows VS Build Tools / Linux build-essential), free disk space, and whether the Node your scheduled tasks point at still exists. Read-only; it changes nothing.

```bash
git clone <repo-url> pantrader
cd pantrader
node scripts/setup.mjs --start
```

That command will: check the environment → install dependencies → create the database and run migrations → load the security list and trading calendar (hits the network, 1–3 minutes) → build → start the web UI at **http://localhost:3111**

Windows uses the same command, from PowerShell or CMD — the script is pure Node, there is no separate `.sh` / `.ps1` implementation.

### Other switches

| Command | Purpose |
|---|---|
| `node scripts/doctor.mjs` | Environment check-up: what's missing on your platform and how to fix it. **Read-only**, runs before dependencies are installed |
| `node scripts/setup.mjs --check` | Pre-install gate: only checks whether installation can proceed, **changes nothing** |
| `node scripts/setup.mjs --no-data` | Skip data loading, no network. Look at the UI structure first |
| `node scripts/setup.mjs --dev` | Start in dev mode (hot reload, slower than production) |
| `node scripts/setup.mjs` | Install and stop, don't start |

After that, day to day you only need `pnpm start`.

### Manual install (if you want to see each step)

```bash
pnpm install             # dependencies
pnpm run migrate         # create the database + run migrations (lands in ~/PanTraderData/)
pnpm run seed-strategies # seed real strategy files from config/strategies/*.yaml.example
pnpm run bootstrap       # load the security list + trading calendar. Interruptible; reruns resume
pnpm build               # build
pnpm start               # start → http://localhost:3111
```

`seed-strategies` is not optional: **the real strategy files are not in git** — the repo only ships `.yaml.example` templates. The reason is that the keys under `持仓:` (positions) are your own account ids, which is personal data and doesn't belong in a published source tree. This step is idempotent — if the real file already exists it is skipped, so your edited thresholds are never overwritten.

No `pnpm`? `npm i -g pnpm`. npm works too, but the repo ships a `pnpm-lock.yaml` and npm ignores the pinned versions in it.

---

## Three things to do after installing

**1. Create an account** → bottom of http://localhost:3111/positions

The system **ships with no accounts**. How you organise your money is yours to name; the program has no business picking for you.

Three fields: `account id` (the ledger's primary key — don't change it after creating), `display name`, and `type label` (free text, used only for grouping in the UI).

**2. Rename the account keys in your strategy to match your ids** → the `持仓:` section of `config/strategies/default.yaml`

Per-account stop-loss rules come from that section, **keyed by account id**. If a key doesn't match, that account has no hard-line rules — the positions page calls this out in a red panel listing which YAML keys don't exist in the `account` table, alongside the accounts that did get rules. It never fails silently.

Two ways to edit: the file directly, or the "strategy source editor" at http://localhost:3111/settings — the latter runs schema validation before saving, shows a diff, and backs the original up to `~/PanTraderData/strategy-backups/<filename>.YYYYMMDD-HHmmss`.

> This file is gitignored (only the `default.yaml.example` template is tracked), so editing it won't dirty `git status`.
> The cost is that you can no longer read the strategy's evolution with `git diff` — that role moves to the backup directory above, which keeps a full timestamped copy on every write-back and is backed up along with `~/PanTraderData`, so it survives `git clean` or a project reinstall.

**3. Glance at data health** → http://localhost:3111/settings

Every data source is a free, unofficial endpoint: they drop out, rate-limit, and change fields. This page lays out per-source health and the gap list. Staleness is its own category — it never gets folded into "healthy".

---

## Pages

| Path | Contents |
|---|---|
| `/today` | Today's signal card: environment gear, target exposure, buy candidates, hard-line alerts |
| `/positions` | Holdings, P&L, distance to stop, execution fill-back, **account management** |
| `/watchpool` | Watchlist: each entry carries a trigger price, a stop price, and a one-line rationale |
| `/ledger` | Prediction ledger and reconciliation: hit rate, error attribution, parameter suggestions |
| `/lab` | Backtesting and walk-forward |
| `/settings` | Source health, gaps, scheduler status, **strategy management**, parameter panel, import/export |

Pages refresh themselves every 60 seconds, plus an SSE push — gear changes, new buy candidates, and hard-line breaks raise a desktop notification; routine data refreshes do not.

---

## Data collection

**Collection starts automatically as soon as the system is running.** Scheduling is cross-platform and in-process; it does not depend on launchd / cron / Task Scheduler.

| Time (Shanghai) | Job | Contents | Backfillable across days |
|---|---|---|---|
| 08:50 | `selfcheck` | Gap scan + coverage | ✅ |
| 09:00 | `preopen` | Sync trading calendar | ✅ |
| 09:15 | `plan` | Pre-open battle plan: run the strategy, push today's candidates | ❌ |
| 09:35–11:30 / 13:00–14:55, every 5 min | `intraday` | Whole-market snapshot + watchlist minute bars | ❌ |
| 15:05 | `close` | Closing snapshot + limit-up pool | ❌ |
| 18:40 | `post` | Dragon-tiger list + broker seats | ✅ |
| 22:00 | `night` | Full daily bars + gap backfill + dragon-tiger label refresh + ledger reconciliation | ✅ |

The "backfillable across days" column is a real constraint, not a labelling convention: **an intraday snapshot is a moment that has passed, and the sources offer no historical endpoint — miss a day and it is missing forever.** So a missed slot is honestly recorded as `missed`, never as a success; recording it as success would be forging the coverage number.

Both schedulers can be installed at once without double-collecting: the in-process scheduler and the OS-level task (launchd / schtasks) share the `job_run` table, keyed `(date, job, slot)`. Whoever claims a slot first runs it; the other stands down. So "browser open" plus "startup task installed" will not pull the whole-market snapshot twice.

> Learned the hard way: `scripts/job.ts` used to execute directly without writing `job_run`, which made the OS task completely invisible to the scheduler.
> Observed on 2026-08-21: launchd finished `post`/`night`, then the web UI started, the scheduler saw no rows in the table, and ran both again.

To collect without opening the web UI:

```bash
pnpm run daemon          # standalone daemon with a PID lock, so it can't start twice
```

To install as a startup-level task (optional):

```bash
pnpm run install-launchd    # macOS
pnpm run install-schtasks   # Windows
```

### Wake compensation

When the system comes back to life (process restart, or the machine waking from sleep), it first asks: when did I last do work, and what did I miss?

- Reclaim slots stuck in `running` (sleep interrupting a process leaves these behind; without reclaiming they are never rerun and never recorded as missed)
- Sync the trading calendar **first**, then work out which trading days were missed — the calendar is derived from historical index bars and never contains future dates, so without syncing first you cannot see any day during the sleep
- For backfillable data, run `night` once for structural coverage (pull 1023 daily bars + refresh the last 30 trading days of dragon-tiger data) rather than replaying day by day
- Honestly record non-backfillable slots as `missed`

The criterion is "backfillable data for a trading day never landed", not "asleep for more than N hours". The latter gets it wrong in both directions: a 60-hour weekend shutdown misses nothing, while Thursday to Friday is only 10 hours apart and misses all of Friday.

---

## Strategy

A strategy is a file, not a database row:

```
config/strategies/<id>.yaml           editable source of truth, add or delete freely. **Not in git**
config/strategies/<id>.yaml.example   de-personalised template, in git, seeded by seed-strategies
config/strategies/ACTIVE              single line of text: which one is currently in effect
```

The real file stays out of git because the keys under `持仓:` are your own account ids. History is preserved in `~/PanTraderData/strategy-backups/<filename>.YYYYMMDD-HHmmss`: every write-back (including changing one number in the panel) backs up first, consecutive saves within the same second get a `-2` suffix, and nothing is auto-pruned.

**The YAML is the single source of truth for parameters.** The parameter panel is only a projection of it; there is no second copy of state. Changing one number in the panel replaces one scalar in the source text and leaves comments and layout byte-for-byte intact — those comments record where each threshold came from, which is worth more than the convenience of editing parameters in a panel.

Add / switch / delete under the "strategy" panel in `/settings`. Adding **copies an existing strategy's source text** (comments and all) and changes only the `id:` line; it does not generate a blank template, which would start you from "I have no idea what these numbers should be".

When the first prediction is produced, the strategy source is automatically snapshotted into the `strategy` table (idempotent, only the first copy is kept). That is what makes deletion safe: `prediction.strategy_id` is the ledger's attribution key, and as long as the snapshot exists the file can be deleted freely while historical conclusions remain explainable.

---

## Where the data lives

```
~/PanTraderData/
├── pantrader.db          SQLite (WAL mode)
├── snapshots/            raw response archive
└── *.ptbak               export bundles
```

`PANTRADER_DATA_DIR` relocates the whole thing.

**Deliberately outside the repo**: free data sources can be cut off at any time, so the history you accumulate is a non-reproducible asset. It has to be independently backup-able and movable, and it should not be deleted as collateral damage by `git clean` or a project reinstall.

```bash
pnpm db:export                      # VACUUM-consistent snapshot + meta + sha256
pnpm db:import <f.ptbak> dry-run    # see what would happen first
pnpm db:import <f.ptbak> merge newer
```

---

## Common commands

| Command | Purpose |
|---|---|
| `pnpm start` / `pnpm dev` | Start the web UI (production / development) |
| `pnpm run daemon` | Standalone collection daemon |
| `pnpm run job <name>` | Run one job by hand: `selfcheck` `preopen` `plan` `intraday` `close` `post` `night` |
| `pnpm run parity [days]` | v1 vs v2 engine parity: real factors over the last N trading days, field-by-field card diff. Non-zero exit on any mismatch |
| `pnpm test` | Unit tests (**no network**) |
| `pnpm test:watch` | Unit tests, watch mode |
| `pnpm test:live` | Smoke tests against the real endpoints |
| `pnpm run migrate` | Run migrations |
| `pnpm run seed-strategies` | Seed real strategy files from `*.yaml.example` (idempotent, never overwrites) |
| `pnpm env:doctor` | Environment check-up (read-only): Node / toolchain / disk / scheduled tasks |
| `pnpm env:setup --check` | Install gate (read-only). Without flags it really installs: deps → database → data → build. For a first deployment see [One-command install](#one-command-install), which uses `node scripts/setup.mjs` because pnpm and the dependencies may not be in place yet |

> `import` / `setup` / `doctor` are built-in pnpm commands and **hijack** scripts of the same name: what runs is
> pnpm's own, and it **still exits 0** — it looks like it passed while our script never ran at all. Silent false pass,
> the hardest kind to notice. Hence the prefixes: `db:import` / `env:setup` / `env:doctor`.
> `db:export` just mirrors `db:import` (`export` isn't a pnpm command, so a typo fails loudly rather than lying).
> `tests/package-scripts.test.ts` pins this down, so new scripts get checked automatically.

---

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PANTRADER_DATA_DIR` | `~/PanTraderData` | Where the database and snapshots live |
| `PANTRADER_CONFIG_ROOT` | repo root | Where `config/` lives (used by tests) |
| `PANTRADER_NO_SCHEDULER` | — | Set to `1` to disable the in-process collector. Use when running backtests or import/export, to avoid competing for the rate-limit budget |
| `PORT` | `3111` | Web UI port |

---

## Architectural constraints

These are hard constraints with assertions guarding them in CI. Read them before changing anything:

- **`lib/data/` is the only directory allowed to make network requests** (sole exception: the advisor transport layer, separately annotated)
- **The factor and strategy layers may not touch the database or read the system clock.** Data enters only through `PointInTimeView`, and "now" can only be `view.asOf` — otherwise a backtest peeks at the future, and you cannot tell that it did
- **A failed collection never silently returns empty.** It must throw or record a `data_gap`. An empty response body is a classic symptom of rate limiting, not "no data today"
- **All timestamps are Shanghai wall-clock time**, to millisecond precision (`source_health`'s primary key needs it)
- **The ledger is append-only.** Same id with the same content is treated as a duplicate delivery; same id with different content is an error

## Known limitations

- **A few BSE tickers have no adjustment factors**: Sina does not serve `hfq.js` for the "directed transfer" codes (measured: 3 of 5,888 return a stable 404 — 810011/810013/810014). Those names are treated as factor 1.0 — any that paid dividends will be off, and technical indicators need to know it. A non-recoverable `adj_factor:unsupported` gap records this
- **Adjustment comes from Sina only**: Sina and East Money do not share a back-adjustment algorithm (measured on 600000: identical in 1999, 2.5% apart in 2005, 61% apart in 2026, with the ratio drifting — i.e. the two series disagree on returns themselves). The stored daily bars are Sina's, so the factors must be Sina's too; weekly/monthly bars are **aggregated locally** from the adjusted dailies. Mixing the two would put daily and weekly MACD on different price series, silently
- **ST status only exists from 2026-08-04**: ST intervals are observed from the security's short name, and observation began the day the system went live — all 328 ST names have intervals starting on that date. Earlier dates mean "not seen", not "not ST"; the ST check reports undetermined instead of letting a replay happily buy a name that was flagged at the time
- **Reduction plans work live, not for deep backtests**: East Money's datacenter has no reduction-plan report (its `RPT_SHARE_HOLDER_INCREASE` is after-the-fact disclosure with no future dates), so the pipeline is two-step — filter pre-disclosure titles from East Money's announcement list, then parse the templated sentence on Tonghuashun's F10 page. Tonghuashun keeps only the latest ~2 plans per name, so the table accumulates from 2026-09-23 and earlier dates report "not observed"
- **Northbound flow has activity but no direction**: exchanges stopped publishing northbound net buying on 2024-08-16; only turnover and the top-10 traded list remain. The two northbound factors say whether foreign money is busy or watching a name, not whether it is buying or selling, so they are shown on cards but never drive decisions. Southbound net buying is still published and is recorded too
- **Margin and Stock Connect data lag one day**: margin data for T is published before T+1's open, and HKEX publishes turnover after the close, so the PIT view only returns rows strictly before the evaluation date. Per-stock margin is backfilled for two years (from 2024-09); earlier dates report no data
- **Capital-flow factors do not drive decisions yet**: margin sentiment, per-stock margin, northbound activity/attention and executed shareholder changes only produce readings for now; their thresholds are placeholders until rolling-percentile thresholds are learned
- **Sentiment-cycle inputs are rebuilt from daily bars**: promotion rates, limit-up premiums, top-board premium, failed-seal premium, daily failed-seal rate and median change live in the `sentiment_daily` derived table (from 2022-05, where the trading calendar starts), rebuilt nightly after daily bars land. Limit-up detection was checked against East Money's limit-up pool: 17 of 31 days match name-for-name, the rest differ by 1–2 names (the extras are names East Money's pool itself misses). Two limits: daily bars cannot see "opened then resealed", so the failed-seal rate is a lower bound; ST history is only observed from 2026-08-04, so earlier ST limit-ups cannot be excluded and limit-up stats for that period run slightly high
- **Price-limit thresholds follow rule changes**: ChiNext is 10% (ST 5%) before the 2020-08-24 registration reform; main-board ST widened from 5% to 10% on 2026-07-06. An exact limit-price check (previous close × limit, rounded to the cent) backs up the percentage threshold, otherwise limit-ups in ~2-yuan stocks are missed
- **Technical-structure conventions**: daily/weekly MACD, ATR, structure levels and double tops/bottoms are computed on back-adjusted prices, then divided by the current adjustment factor for display and pricing (equivalent to the forward-adjusted view in broker apps); crossover and pivot positions are unaffected. Weekly bars use completed weeks only, so weekly signals can lag up to a week. Pivots need 3 bars on each side, so the last 3 bars are never pivots and levels/patterns lag by 3 bars. Double-top/bottom defaults (≥10 bars apart, neckline ≥6% deep, break valid for 10 bars) are provisional until the shadow book has enough samples to calibrate them
- **Valuations have no history**: East Money only serves the current PE/PB; there is no historical endpoint. `valuation_daily` accumulates from the day it was wired in (2026-09-23); everything before that is blank and unrecoverable. Replays to earlier dates report "no data" for valuation checks rather than **back-filling today's PE** — that would be a lookahead, and one biased toward names that look cheap today. The "PE vs market percentile" check only needs the **cross-sectional** percentile (this name vs the whole market today), which a single day's snapshot already supports
- **Industry membership before 2021-12-13 returns null**: 74.6% of names carry a `beginningdate` of the 2021 revision's base date, and that taxonomy simply did not exist earlier. Null means "unknown", **not "not on the main line"** — anything keying off industry must treat it as undetermined, never as a rejection
- **Weekly/monthly bars only exist once the period closes**: the in-progress week is not stored. Storing it would let tomorrow's data overwrite it, so a replay to Tuesday would read a bar containing Friday's close — not a read past the boundary, but history itself changing under you
- **The engine has no access to account funds — a design decision, not a TODO**: `StrategyEngineInput` deliberately carries no equity or cash figure, and won't. The engine emits ratios; turning a ratio into an amount of money is the human's job. That boundary also backstops the "never places orders" hard line: an engine that cannot compute an order size cannot be casually wired to automated trading. The cost is that the new-position budget is issued against the full target exposure without subtracting existing holdings, and the signal card says so explicitly and asks you to check
- **Two other portfolio risk limits cannot be computed**: industry classification and core/satellite tagging have no input source. The engine lists them under "unevaluated conditions" on the signal card and **never quietly treats them as passed**
- **Backtests only exercise one of the three candidate sources**: the code→industry map has no historical versions, so injecting it into a replay would leak the future. With it absent, the "sector leader" and "volume-price" sources switch themselves off and only the limit-up pool is tested. The backtest report states how many days actually produced candidates, alongside data coverage
- **The limit-up pool has a short history and cannot be backfilled**: it is a same-day-only snapshot, so ledger samples can only accumulate going forward
- **Two advisor transport layers are unverified against real endpoints**
- **macOS clamshell sleep cannot be blocked**: `caffeinate` cannot prevent it. If you want complete intraday data, keep the lid open
- A handful of securities have no real-time snapshot (long suspensions / some Beijing Stock Exchange names); whole-market coverage is about 99.9%

## Contributing

PRs welcome. Read these two before touching core logic:

| Doc | What's in it |
|---|---|
| [CONTRIBUTING.md](CONTRIBUTING.md) | Getting it running, the four hard constraints, comment conventions, data-source etiquette, what won't be accepted |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The rules behind the 193 `spec §N` citations in the code, indexed by section |

Also: [SECURITY.md](SECURITY.md) (report privately, not as a public issue) ·
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

---

## Disclaimer

This project does not constitute investment advice. The data sources are free, unofficial endpoints that drop out, rate-limit, and change fields — they are **not trading grade**.
Your gains and losses are your own.
