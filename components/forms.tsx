"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * 所有写操作的表单。
 *
 * 共同点：写的都是**人已经决定或已经发生的事**（我盯哪只票、我在券商成交了什么、
 * 我有哪几个账户）。没有一个表单会向券商发单 —— 整个前端不存在下单能力，
 * 红线是券商权限到位且 paper 跑满一个季度前不自动下单（spec §18.2）。
 */

const inputCls =
  "num bg-panel-2 border border-line-2 rounded-sm px-2 py-1 text-ink placeholder:text-ink-3";
const btnCls =
  "border border-line-2 rounded-sm px-2 py-1 text-ink-2 hover:text-ink disabled:opacity-40";

function useSubmit() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function send(url: string, method: string, body: unknown) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // 后端的校验信息原样显示：改参数时不用猜哪一项不合法
        const detail = j?.issues ? ` ${JSON.stringify(j.issues)}` : "";
        throw new Error(`${j?.error ?? `HTTP ${r.status}`}${detail}`);
      }
      setMsg({ kind: "ok", text: "已保存" });
      router.refresh();
      return true;
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
      return false;
    } finally {
      setBusy(false);
    }
  }
  /**
   * 需要**看服务端说了什么**的操作用这个，不是 send。
   *
   * send 一律显示"已保存"，但删除类操作的结果不是二值的：
   * 点了"删除账户"实际可能只是停用了（有台账引用时），那句解释必须原样显示出来 ——
   * 让用户以为删掉了而其实没删，是最糟的一种反馈。
   */
  async function call(
    url: string, method: string, body?: unknown
  ): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(url, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) throw new Error(String(j?.error ?? `HTTP ${r.status}`));
      setMsg({ kind: "ok", text: String(j.note ?? "已完成") });
      router.refresh();
      return j;
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
      return null;
    } finally {
      setBusy(false);
    }
  }

  return { busy, msg, send, call };
}

function Msg({ msg }: { msg: { kind: "ok" | "err"; text: string } | null }) {
  if (!msg) return null;
  return (
    <span className={msg.kind === "ok" ? "text-down" : "text-danger"}>{msg.text}</span>
  );
}

// ─────────────────────────── 观察池 ───────────────────────────

export function WatchpoolForm({ accountIds = [] }: { accountIds?: string[] }) {
  const { busy, msg, send } = useSubmit();
  const [f, setF] = useState({
    code: "",
    name: "",
    // 默认取第一个真实账户；没有账户就留空，由下面的提示引导去建
    account: accountIds[0] ?? "",
    triggerPx: "",
    stopPx: "",
    thesis: "",
  });

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const okDone = await send("/api/signal/watchpool", "POST", {
          code: f.code.trim(),
          name: f.name.trim() || undefined,
          account: f.account,
          triggerPx: f.triggerPx.trim() === "" ? null : Number(f.triggerPx),
          stopPx: f.stopPx.trim() === "" ? null : Number(f.stopPx),
          thesis: f.thesis.trim() || undefined,
        });
        if (okDone) setF({ ...f, code: "", name: "", triggerPx: "", stopPx: "", thesis: "" });
      }}
    >
      <label className="flex flex-col gap-0.5">
        <span className="text-ink-3 text-[11px]">代码</span>
        <input
          className={`${inputCls} w-24`}
          value={f.code}
          onChange={(e) => setF({ ...f, code: e.target.value })}
          placeholder="600519"
          required
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-ink-3 text-[11px]">名称</span>
        <input
          className={`${inputCls} w-28`}
          value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })}
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-ink-3 text-[11px]">账户</span>
        {/* 选项来自 account 表，代码不预设任何账户名 */}
        <select
          className={`${inputCls} w-24`}
          value={f.account}
          onChange={(e) => setF({ ...f, account: e.target.value })}
          required
        >
          {accountIds.length === 0 ? <option value="">（先建账户）</option> : null}
          {accountIds.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-ink-3 text-[11px]">触发价（回踩到此价才动手）</span>
        <input
          className={`${inputCls} w-28`}
          value={f.triggerPx}
          onChange={(e) => setF({ ...f, triggerPx: e.target.value })}
          inputMode="decimal"
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-ink-3 text-[11px]">止损价（必须低于触发价）</span>
        <input
          className={`${inputCls} w-28`}
          value={f.stopPx}
          onChange={(e) => setF({ ...f, stopPx: e.target.value })}
          inputMode="decimal"
        />
      </label>
      <label className="flex flex-col gap-0.5 grow">
        <span className="text-ink-3 text-[11px]">一句话逻辑（写不出来的不该进池子）</span>
        <input
          className={`${inputCls} w-full text-left`}
          style={{ fontFamily: "inherit", textAlign: "left" }}
          value={f.thesis}
          onChange={(e) => setF({ ...f, thesis: e.target.value })}
        />
      </label>
      <button className={btnCls} disabled={busy} type="submit">
        加入观察池
      </button>
      <Msg msg={msg} />
    </form>
  );
}

export function WatchpoolRemoveButton({ code }: { code: string }) {
  const { busy, send } = useSubmit();
  return (
    <button
      className="text-ink-3 hover:text-danger"
      disabled={busy}
      onClick={() => send("/api/signal/watchpool", "DELETE", { code })}
      title="移出观察池（软删，历史保留供复盘）"
    >
      移出
    </button>
  );
}

// ─────────────────────────── 手工成交回填 ───────────────────────────

export function ManualFillForm({ accountIds }: { accountIds: string[] }) {
  const { busy, msg, send } = useSubmit();
  const [f, setF] = useState({
    accountId: accountIds[0] ?? "",
    code: "",
    side: "buy",
    px: "",
    qty: "",
    fee: "",
    stopPx: "",
    thesis: "",
  });

  if (accountIds.length === 0) {
    return (
      <p className="text-warn">
        还没有账户。先在下面建一个（名称与类型都由你定），再回填成交 ——
        自动建账户会让"记错账户"静默通过，而不同账户的止损规则不可混用。
      </p>
    );
  }

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const okDone = await send("/api/signal/fill", "POST", {
          accountId: f.accountId,
          code: f.code.trim(),
          side: f.side,
          px: Number(f.px),
          qty: Number(f.qty),
          fee: f.fee.trim() === "" ? undefined : Number(f.fee),
          stopPx: f.stopPx.trim() === "" ? null : Number(f.stopPx),
          thesis: f.thesis.trim() || undefined,
        });
        if (okDone) setF({ ...f, code: "", px: "", qty: "", fee: "", stopPx: "", thesis: "" });
      }}
    >
      <label className="flex flex-col gap-0.5">
        <span className="text-ink-3 text-[11px]">账户</span>
        <select
          className={`${inputCls} w-28`}
          value={f.accountId}
          onChange={(e) => setF({ ...f, accountId: e.target.value })}
        >
          {accountIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-ink-3 text-[11px]">方向</span>
        <select
          className={`${inputCls} w-16`}
          value={f.side}
          onChange={(e) => setF({ ...f, side: e.target.value })}
        >
          <option value="buy">买入</option>
          <option value="sell">卖出</option>
        </select>
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-ink-3 text-[11px]">代码</span>
        <input
          className={`${inputCls} w-24`}
          value={f.code}
          onChange={(e) => setF({ ...f, code: e.target.value })}
          required
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-ink-3 text-[11px]">成交价</span>
        <input
          className={`${inputCls} w-24`}
          value={f.px}
          onChange={(e) => setF({ ...f, px: e.target.value })}
          inputMode="decimal"
          required
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-ink-3 text-[11px]">数量（股）</span>
        <input
          className={`${inputCls} w-24`}
          value={f.qty}
          onChange={(e) => setF({ ...f, qty: e.target.value })}
          inputMode="numeric"
          required
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-ink-3 text-[11px]">费用</span>
        <input
          className={`${inputCls} w-20`}
          value={f.fee}
          onChange={(e) => setF({ ...f, fee: e.target.value })}
          inputMode="decimal"
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-ink-3 text-[11px]">止损价</span>
        <input
          className={`${inputCls} w-24`}
          value={f.stopPx}
          onChange={(e) => setF({ ...f, stopPx: e.target.value })}
          inputMode="decimal"
        />
      </label>
      <button className={btnCls} disabled={busy} type="submit">
        回填成交
      </button>
      <Msg msg={msg} />
    </form>
  );
}

// ─────────────────────────── 账户 ───────────────────────────

export function AccountForm() {
  const { busy, msg, send } = useSubmit();
  const [f, setF] = useState({ id: "", name: "", type: "" });
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const okDone = await send("/api/settings/account", "POST", f);
        if (okDone) setF({ ...f, id: "", name: "" });
      }}
    >
      <label className="flex flex-col gap-0.5">
        <span className="text-ink-3 text-[11px]">账户 id</span>
        <input
          className={`${inputCls} w-32`}
          value={f.id}
          onChange={(e) => setF({ ...f, id: e.target.value })}
          placeholder="zw-main"
          required
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-ink-3 text-[11px]">显示名</span>
        <input
          className={`${inputCls} w-40`}
          value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })}
          required
        />
      </label>
      <label className="flex flex-col gap-0.5">
        {/*
          自由输入，不是下拉。账户类型是用户自己起的标签 ——
          写死成几个固定选项，等于账户体系要改代码才能扩展。
          止损规则来自 strategy.yaml 里以账户 id 为键的那一段，不由这个标签决定。
        */}
        <span className="text-ink-3 text-[11px]">类型标签（自定义，仅用于分组展示）</span>
        <input
          className={`${inputCls} w-28`}
          value={f.type}
          onChange={(e) => setF({ ...f, type: e.target.value })}
          placeholder="如 短线 / 长线"
          required
        />
      </label>
      <button className={btnCls} disabled={busy} type="submit">
        保存账户
      </button>
      <Msg msg={msg} />
    </form>
  );
}

export interface AccountManagerRow {
  id: string;
  name: string;
  type: string;
  active: boolean;
  refs: { positions: number; trades: number; orders: number };
}

/**
 * 账户列表 + 停用 / 恢复 / 删除。
 *
 * 界面在点之前就说清会发生什么：有台账引用的账户按钮写"停用"，没有的写"删除"。
 * 两者都调同一个 DELETE，服务端按引用决定实际动作 —— 判断只放一处，
 * 界面写死一套规则、服务端另一套，早晚对不上。
 */
export function AccountManager({ rows }: { rows: AccountManagerRow[] }) {
  const { busy, msg, call } = useSubmit();
  if (rows.length === 0) {
    return (
      <p className="text-ink-3 text-[12px]">
        还没有账户。用下面的表单建一个 —— 代码不预置任何账户，
        账户是你组织自己资金的方式。
      </p>
    );
  }
  const refTotal = (r: AccountManagerRow) => r.refs.positions + r.refs.trades + r.refs.orders;
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <table className="dense">
          <thead>
            <tr>
              <th>账户 id</th>
              <th>显示名</th>
              <th>类型标签</th>
              <th className="text-right">持仓</th>
              <th className="text-right">成交</th>
              <th className="text-right">委托</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className={a.active ? "" : "opacity-50"}>
                <td className="num text-ink">{a.id}</td>
                <td className="text-ink-2">{a.name}</td>
                <td className="text-ink-3">{a.type}</td>
                <td className="num">{a.refs.positions}</td>
                <td className="num">{a.refs.trades}</td>
                <td className="num">{a.refs.orders}</td>
                <td className={a.active ? "text-down" : "text-ink-3"}>
                  {a.active ? "启用" : "已停用"}
                </td>
                <td className="flex gap-1">
                  <button
                    className={btnCls}
                    disabled={busy}
                    type="button"
                    onClick={() =>
                      void call("/api/settings/account", "PATCH", { id: a.id, active: !a.active })
                    }
                  >
                    {a.active ? "停用" : "恢复"}
                  </button>
                  <button
                    className={btnCls}
                    disabled={busy}
                    type="button"
                    onClick={() => {
                      const n = refTotal(a);
                      const q = n > 0
                        ? `${a.id} 有 ${n} 条台账记录，只会停用（保留历史归属），确定？`
                        : `${a.id} 没有任何台账记录，将彻底删除，确定？`;
                      if (!confirm(q)) return;
                      void call(`/api/settings/account?id=${encodeURIComponent(a.id)}`, "DELETE");
                    }}
                  >
                    {refTotal(a) > 0 ? "停用（有台账）" : "删除"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Msg msg={msg} />
      <p className="text-ink-3 text-[11px]">
        有台账记录的账户只能停用：硬删会让那些持仓/成交行的 account_id 指向不存在的账户，
        持仓页显示不出归属、按账户分组的胜率统计凭空少一组，且没有任何提示。
        停用后不再出现在新建表单里，也不会被引擎当作可下单账户，但历史归属完整保留。
      </p>
    </div>
  );
}

// ─────────────────────────── 策略 ───────────────────────────

export interface StrategyManagerRow {
  id: string;
  version: string | null;
  active: boolean;
  valid: boolean;
  invalidReason?: string;
  filePath: string;
  bytes: number;
}

/**
 * 策略清单 + 新建 / 切换 / 删除。
 *
 * 新建是**复制现有策略的原文**，不是生成空模板：YAML 里每个阈值下面
 * 都有一段注释记着它的由来，从空模板开始等于从"不知道这些数该是多少"开始。
 */
export function StrategyManager({
  rows, activeId, dirRel, undecided,
}: {
  rows: StrategyManagerRow[];
  activeId: string | null;
  dirRel: string;
  undecided: boolean;
}) {
  const { busy, msg, call } = useSubmit();
  const [newId, setNewId] = useState("");
  const [from, setFrom] = useState("");

  return (
    <div className="flex flex-col gap-2">
      {undecided ? (
        <p className="text-danger text-[12px]">
          有 {rows.length} 个策略但没有 ACTIVE 指针 —— 系统读不出该用哪个。下面选一个「设为生效」。
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-ink-3 text-[12px]">
          {dirRel} 下没有任何策略文件。系统没有参数可用 —— 放一份 YAML 进去。
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="dense">
            <thead>
              <tr>
                <th>策略 id</th>
                <th>版本</th>
                <th>校验</th>
                <th className="text-right">大小</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td className="num text-ink">{s.id}</td>
                  <td className="num text-ink-2">{s.version ?? "—"}</td>
                  <td className={s.valid ? "text-down" : "text-danger"}>
                    {s.valid ? "通过" : (s.invalidReason ?? "不通过")}
                  </td>
                  <td className="num text-ink-3">{s.bytes}B</td>
                  <td className={s.active ? "text-down" : "text-ink-3"}>
                    {s.active ? "生效中" : "—"}
                  </td>
                  <td className="flex gap-1">
                    <button
                      className={btnCls}
                      disabled={busy || s.active || !s.valid}
                      type="button"
                      title={!s.valid ? "校验不过的策略不能设为生效" : undefined}
                      onClick={() => void call("/api/strategy", "PATCH", { id: s.id })}
                    >
                      设为生效
                    </button>
                    <button
                      className={btnCls}
                      disabled={busy || s.active || rows.length <= 1}
                      type="button"
                      title={s.active ? "先切换到别的策略再删" : undefined}
                      onClick={() => {
                        if (!confirm(`删除策略 ${s.id}？有预测挂在它上面时会先把原文快照进 strategy 表，归因不丢。`)) return;
                        void call(`/api/strategy?id=${encodeURIComponent(s.id)}`, "DELETE");
                      }}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const j = await call("/api/strategy", "POST", {
            id: newId,
            ...(from ? { from } : {}),
          });
          if (j) setNewId("");
        }}
      >
        <label className="flex flex-col gap-0.5">
          <span className="text-ink-3 text-[11px]">新策略 id（会成为文件名）</span>
          <input
            className={`${inputCls} w-40`}
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            placeholder="aggressive"
            required
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-ink-3 text-[11px]">复制自</span>
          <select
            className={`${inputCls} w-40`}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          >
            <option value="">（当前生效：{activeId ?? "无"}）</option>
            {rows.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
        </label>
        <button className={btnCls} disabled={busy || rows.length === 0} type="submit">
          新建策略
        </button>
        <Msg msg={msg} />
      </form>

      <p className="text-ink-3 text-[11px]">
        策略是 <code className="text-ink-2">{dirRel}/&lt;id&gt;.yaml</code> 文件，
        生效的那个记在同目录的 <code className="text-ink-2">ACTIVE</code> 里 ——
        指针放文件不放数据库，因为 app_meta 不进 .ptbak，换台机器恢复后
        「在跑哪个策略」就丢了。新建是复制原文、只改 id 行，
        <strong>注释一个字节不动</strong>：那些注释记着每个阈值的由来。
      </p>
    </div>
  );
}

// ─────────────────────────── 导出 / 导入 ───────────────────────────

export function ExportForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        className={btnCls}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setOut(null);
          const r = await fetch("/api/settings/export", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          const j = await r.json().catch(() => ({}));
          setOut(r.ok ? `已导出 ${j.outPath}` : `失败：${j?.error ?? r.status}`);
          setBusy(false);
          router.refresh();
        }}
      >
        导出 .ptbak
      </button>
      <span className="text-ink-3 text-[11px]">
        VACUUM INTO 一致性快照 + 快照目录，写到 dataDir 下（不接受任意路径）
      </span>
      {out ? <span className="text-ink-2">{out}</span> : null}
    </div>
  );
}

export function ImportDryRunForm() {
  const [p, setP] = useState("");
  const [out, setOut] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setOut(null);
          const r = await fetch("/api/settings/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bakPath: p.trim() }),
          });
          const j = await r.json().catch(() => ({}));
          setOut(r.ok ? JSON.stringify(j.report?.changes ?? j.report, null, 1) : `失败：${j?.error ?? r.status}`);
          setBusy(false);
        }}
      >
        <label className="flex flex-col gap-0.5 grow">
          <span className="text-ink-3 text-[11px]">.ptbak 绝对路径（只做 dry-run，不落盘）</span>
          <input
            className={`${inputCls} w-full`}
            value={p}
            onChange={(e) => setP(e.target.value)}
            placeholder="/Users/…/PanTraderData/pantrader-xxx.ptbak"
            required
          />
        </label>
        <button className={btnCls} disabled={busy} type="submit">
          试算变更
        </button>
      </form>
      <p className="text-ink-3 text-[11px]">
        replace / merge 会一次抹掉本机不可再生资产（分钟线、涨停池、台账），
        不由浏览器点击触发。要真正导入请在终端执行：
        <code className="text-ink-2 ml-1">pnpm db:import &lt;file.ptbak&gt; --mode replace</code>
      </p>
      {out ? (
        <pre className="text-[11px] text-ink-2 bg-panel-2 border border-line rounded-sm p-2 overflow-x-auto">
          {out}
        </pre>
      ) : null}
    </div>
  );
}
