import { EmptyState, NoDatabase, NoRows } from "@/components/EmptyState";
import { Num } from "@/components/Num";
import { KV, Panel, Tag } from "@/components/Panel";
import { SourceHealthTable } from "@/components/StatusRail";
import { ExportForm, ImportDryRunForm, StrategyManager } from "@/components/forms";
import { ParamPanel } from "@/components/ParamPanel";
import { StrategyRawEditor } from "@/components/StrategyRawEditor";
import { appliedMigrations, dbUnavailable, readDb } from "@/lib/ui/db";
import { fmtAge, fmtAmount, fmtTs, ageMinutes } from "@/lib/ui/format";
import { unavailable } from "@/lib/ui/derive";
import { systemStatus } from "@/lib/ui/status";
import { scheduleStatus, storageInfo } from "@/lib/ui/settings-info";
import {
  advisorOutputs,
  calendarRange,
  getMetaValue,
  tableCounts,
  unresolvedGaps,
} from "@/lib/ui/queries";
import {
  backupDir,
  strategyYamlRel,
  flattenConfig,
  readStrategyConfig,
} from "@/lib/ui/adapters/strategy";
import {
  STRATEGIES_DIR_REL,
  activeStrategyId,
  listStrategies,
} from "@/lib/strategy/registry";

export const dynamic = "force-dynamic";

/**
 * 设置。spec §13：数据库路径、导入导出、Advisor 模式、源健康、调度状态。
 *
 * 另外把两件"必须看得见"的东西完整摊在这里：源健康明细 与 缺口清单。
 * 这两块在顶部状态条里只有一个灯，明细在这一页 —— 免费非官方接口会掉线/限频/改字段，
 * 静默陈旧正是最不能发生的事（spec §18.2）。
 */
export default function SettingsPage() {
  const db = readDb();
  if (!db) return <NoDatabase why={dbUnavailable()} />;

  const s = systemStatus();
  const st = storageInfo();
  const sched = scheduleStatus();
  const migs = appliedMigrations(db);
  const counts = tableCounts(db);
  const cal = calendarRange(db);
  const gaps = unresolvedGaps(db);
  const cfg = readStrategyConfig();
  const advisor = advisorOutputs(db, 20);
  const startDate = getMetaValue(db, "system_start_date");
  const strategyList = listStrategies();
  const activeStrategy = activeStrategyId();

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Panel title="数据库 / 存储" hint="DB 不在代码库目录内，避免重装或 git 操作误删">
          <KV label="数据目录">{st.dataDir}</KV>
          <KV label="数据库路径">{st.dbPath}</KV>
          <KV label="数据库大小">{fmtAmount(st.dbBytes)}B</KV>
          <KV label="WAL 大小" hint="异常巨大说明有连接长期不 checkpoint">
            {fmtAmount(st.walBytes)}B
          </KV>
          <KV label="快照目录">{st.snapshotDir}</KV>
          <KV label="快照文件数">
            <Num v={st.snapshotCount} kind="int" />
          </KV>
          <KV label="schema 版本" hint="已应用的 migration">
            {migs.length ? migs[migs.length - 1] : "—"}
          </KV>
          <KV label="系统起算日" hint="缺口检测从这天算起">
            {startDate ?? "—"}
          </KV>
          <p className="mt-2 text-ink-3 text-[11px]">
            路径由环境变量 <code className="text-ink-2">PANTRADER_DATA_DIR</code> 决定
            （默认 ~/PanTraderData）。前端以**只读**连接读库，不与采集 job 争写锁。
          </p>
        </Panel>

        <Panel title="Advisor 模式" hint="有 Claude 是增强，没 Claude 系统功能完整（D2/D3）">
          {advisor.length === 0 ? (
            <>
              <NoRows
                what="advisor_output 表为空"
                hint="从未调用过模型。这不等于已配置为 null 模式 —— 模式由 advisor 层决定，不在前端"
              />
              <p className="mt-2 text-ink-3 text-[11px]">
                模式取值：null / claude-cli / claude-api。每次填槽都会留结构化快照
                （提示词哈希 + 输入快照哈希），否则回测不可复现（spec §5.2）。
              </p>
            </>
          ) : (
            <>
              <KV label="最近一次">{fmtTs(advisor[0].ts, true)}</KV>
              <KV label="模式">{advisor[0].mode}</KV>
              <KV label="模型">{advisor[0].model ?? "—"}</KV>
              <KV label="置信度">
                <Num v={advisor[0].confidence} kind="ratio" />
              </KV>
              <KV label="降级">
                {advisor[0].degraded ? <Tag tone="warn">是</Tag> : <Tag>否</Tag>}
              </KV>
            </>
          )}
        </Panel>

        <Panel title="执行模式" tone="warn" hint="红线：不自动下单">
          <KV label="当前模式">{s.executionMode === "paper" ? "paper 模拟" : "manual 手工"}</KV>
          <KV label="live 可用">
            <Tag tone="danger">否</Tag>
          </KV>
          <p className="mt-2 text-ink-2 text-[12px]">{s.liveBlockedReason}</p>
          <p className="mt-2 text-ink-3 text-[11px]">
            即使环境变量写成 live 也会被降回 manual —— 前端不存在下单能力，
            也不给它留配置口子。manual 模式下界面只出信号卡，下单在券商 App 手敲，
            回来在持仓页回填成交。
          </p>
        </Panel>
      </div>

      {/* ── 源健康 ── */}
      <Panel
        title="数据源健康"
        hint="免费非官方接口，会掉线/限频/改字段，非交易级。陈旧独立成一档，不并进正常"
        right={`24h 窗口 · ${s.health.length} 源`}
        tone={s.worstHealth === "ok" || s.worstHealth === null ? "normal" : "warn"}
      >
        <SourceHealthTable s={s} />
      </Panel>

      {/* ── 调度 ── */}
      <Panel
        title="调度状态"
        hint="launchd 实况：从 ~/Library/LaunchAgents 与日志 mtime 读，不读配置常量"
        tone={sched.installed ? "normal" : "danger"}
      >
        {!sched.installed ? (
          <>
            <EmptyState
              u={unavailable(
                `未发现 com.pantrader.*.plist（查找目录 ${sched.agentsDir}）`,
                "跑 pnpm install-launchd 安装定时任务。调度不跑 = 分钟线与截面数据每天永久缺失，spec §18.2 要求这类失败必须告警"
              )}
            />
          </>
        ) : (
          <div className="overflow-x-auto">
            <table className="dense">
              <thead>
                <tr>
                  <th>任务</th>
                  <th className="text-right">最后输出</th>
                  <th className="text-right">距今</th>
                  <th className="text-right">错误日志</th>
                </tr>
              </thead>
              <tbody>
                {sched.entries.map((e) => (
                  <tr key={e.label}>
                    <td className="num text-ink">{e.label}</td>
                    <td className="num">{fmtTs(e.lastOutAt, true)}</td>
                    <td className="num text-ink-2">{fmtAge(ageMinutes(e.lastOutAt))}</td>
                    <td className="num">
                      {e.errBytes === null ? (
                        "—"
                      ) : e.errBytes > 0 ? (
                        <span className="text-warn">{fmtAmount(e.errBytes)}B</span>
                      ) : (
                        "0"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-ink-3 text-[11px]">
          日志目录 <code className="text-ink-2">{sched.logDir}</code>。
          "最后输出"是 .out.log 的 mtime，只能证明进程写过东西，不能证明当次采集成功 ——
          采集是否成功看上面的源健康与下面的缺口。
        </p>
      </Panel>

      {/* ── 缺口 ── */}
      <Panel
        title="数据缺口"
        tone={s.gapsUnrecoverable.length > 0 ? "danger" : "normal"}
        right={`未解决 ${gaps.length} 条`}
      >
        {gaps.length === 0 ? (
          <NoRows what="没有未解决的缺口" />
        ) : (
          <>
            <div className="flex gap-4 mb-2">
              <span>
                不可回补 <span className="num text-danger">{s.gapsUnrecoverable.length}</span>
              </span>
              <span>
                可回补 <span className="num text-warn">{s.gapsRecoverable.length}</span>
              </span>
            </div>
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="dense">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>类型</th>
                    <th>数据源</th>
                    <th>可回补</th>
                    <th className="text-right">发现时间</th>
                    <th>原因</th>
                  </tr>
                </thead>
                <tbody>
                  {gaps.map((g) => (
                    <tr key={`${g.date}-${g.source}-${g.kind}`}>
                      <td className="num">{g.date}</td>
                      <td className="num text-ink">{g.kind}</td>
                      <td className="text-ink-2">{g.source}</td>
                      <td>
                        {g.recoverable ? (
                          <Tag tone="warn">可回补</Tag>
                        ) : (
                          <Tag tone="danger">永久缺失</Tag>
                        )}
                      </td>
                      <td className="num text-ink-3">{fmtTs(g.detectedAt, true)}</td>
                      <td className="text-ink-3 max-w-[32rem] truncate" title={g.reason ?? ""}>
                        {g.reason ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-ink-3 text-[11px]">
              可回补的由 backfill job 重取；不可回补的（分钟线/涨停池/板块榜）没有历史接口，
              只能记入回测覆盖率永久扣分。
            </p>
          </>
        )}
      </Panel>

      {/* ── 策略清单 ── */}
      <Panel
        title="策略"
        hint={`${STRATEGIES_DIR_REL}/<id>.yaml，生效的记在同目录 ACTIVE 里`}
        right={`${strategyList.length} 个 · 生效 ${activeStrategy ?? "未选"}`}
        tone={activeStrategy === null && strategyList.length > 1 ? "danger" : "normal"}
      >
        <StrategyManager
          rows={strategyList.map((s) => ({
            id: s.id,
            version: s.version,
            active: s.active,
            valid: s.valid,
            invalidReason: s.invalidReason,
            filePath: s.filePath,
            bytes: s.bytes,
          }))}
          activeId={activeStrategy}
          dirRel={STRATEGIES_DIR_REL}
          undecided={activeStrategy === null && strategyList.length > 1}
        />
      </Panel>

      {/* ── 原文编辑器 ── */}
      <Panel
        title="策略原文编辑"
        hint="一屏文本覆盖新增键 / 改列表 / 改整段规则 —— 注释由人自己保全，程序不去猜"
        right={`备份目录 ${backupDir()}`}
      >
        <StrategyRawEditor
          ids={strategyList.map((s) => s.id)}
          initialId={activeStrategy ?? strategyList[0]?.id ?? null}
        />
      </Panel>

      {/* ── 参数面板 ── */}
      <Panel
        title="策略参数面板"
        hint={`${strategyYamlRel()} 的投影（D7）。这里不存第二份状态`}
        right={cfg.available && cfg.validated ? "已通过 loader 校验" : "校验未通过"}
      >
        {!cfg.available ? (
          <>
            <EmptyState u={cfg} />
            {Array.isArray(cfg.issues) && cfg.issues.length > 0 ? (
              <ul className="mt-2 text-[12px] text-danger leading-6">
                {(cfg.issues as Array<{ path?: string; message: string; line?: number }>).map(
                  (i, k) => (
                    <li key={k}>
                      {i.line !== undefined ? (
                        <span className="num text-ink-3 mr-1">L{i.line}</span>
                      ) : null}
                      {i.path ? <span className="text-ink-2 mr-1">{i.path}</span> : null}
                      {i.message}
                    </li>
                  )
                )}
              </ul>
            ) : null}
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-2 mb-2">
              <Tag tone="info">可改</Tag>
              <span className="text-ink-2 text-[12px]">
                改动直接写回 <code className="text-ink">{cfg.filePath}</code>：在原文上替换纯量
                （**保留注释与排版**）→ 整份重新校验 → 通过才落盘（临时文件 + rename）。
                校验不过就回滚，面板没有能力把唯一真相源改成非法状态。
              </span>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <ParamPanel params={flattenConfig(cfg.config)} />
              <pre className="text-[11px] text-ink-2 bg-panel-2 border border-line rounded-sm p-2 max-h-96 overflow-auto">
                {cfg.raw}
              </pre>
            </div>
            <p className="mt-2 text-ink-3 text-[11px]">
              高级规则（因子间关系判断、必查链、止盈档位这类列表）直接编辑 YAML
              —— 自动改写需要猜缩进与注释归属，猜错会破坏原文（spec §9.1）。
            </p>
          </>
        )}
      </Panel>

      {/* ── 导入导出 ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Panel title="导出" hint="策略与数据分开导出：策略是逻辑资产，数据是历史资产">
          <ExportForm />
          {st.bakFiles.length > 0 ? (
            <div className="mt-3 overflow-x-auto">
              <table className="dense">
                <thead>
                  <tr>
                    <th>文件</th>
                    <th className="text-right">大小</th>
                    <th className="text-right">时间</th>
                  </tr>
                </thead>
                <tbody>
                  {st.bakFiles.slice(0, 10).map((f) => (
                    <tr key={f.name}>
                      <td className="num text-ink">{f.name}</td>
                      <td className="num">{fmtAmount(f.bytes)}B</td>
                      <td className="num text-ink-3">{fmtTs(f.mtime, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-3 text-ink-3">dataDir 下还没有 .ptbak 文件。</p>
          )}
          <p className="mt-2 text-ink-3 text-[11px]">
            策略包（.ptstrat = strategy.yaml + factors.lock + 回测成绩 + meta）
            由策略层导出，不在本页 —— 它需要因子注册表来生成 factors.lock。
          </p>
        </Panel>

        <Panel title="导入" tone="warn" hint="只提供 dry-run；真正导入走 CLI">
          <ImportDryRunForm />
        </Panel>
      </div>

      {/* ── 表行数 ── */}
      <Panel
        title="各表行数"
        hint="空态文案指的就是这张表。行数 -1 = 表不存在（migration 未跑）"
        right={`日历 ${cal.from ?? "—"} → ${cal.to ?? "—"}（${cal.openDays} 交易日）`}
      >
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-x-4">
          {counts.map((c) => (
            <KV key={c.table} label={c.table}>
              {c.rows < 0 ? <span className="text-danger">缺表</span> : <Num v={c.rows} kind="int" />}
            </KV>
          ))}
        </div>
      </Panel>

      <p className="text-ink-3 text-[11px]">
        本方案不构成投资建议。数据源为免费非官方接口，会掉线/限频/改字段，非交易级。
      </p>
    </div>
  );
}
