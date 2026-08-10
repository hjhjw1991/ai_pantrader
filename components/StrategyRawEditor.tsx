"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

/**
 * 策略原文编辑器。
 *
 * 为什么是"一屏文本"而不是逐字段按钮：新增键、改列表、改整段规则这几类改动，
 * 程序化改写都要猜缩进与注释归属 —— 而这份 YAML 的价值大半在注释里
 * （每个阈值下面记着它是哪次复盘换来的）。人直接改文本，注释保全是天然的。
 *
 * 三条纪律，缺一条这个编辑器就变成风险源：
 *   1. **保存前必须能看 diff**：全文替换的破坏力和它的方便程度成正比，
 *      要让人在落盘前看见自己到底删掉了哪几行（尤其是注释行）；
 *   2. **校验挡在落盘前**：服务端 dryRun 先跑一遍 schema，带行号返回；
 *   3. **baseHash 乐观并发**：载入之后磁盘那份可能被手工改过，
 *      拿旧内容覆盖等于静默吃掉那次改动，服务端会回 409。
 */

const btnCls =
  "border border-line rounded-sm px-2 py-0.5 text-[12px] text-ink-2 hover:text-ink hover:border-line-2 disabled:opacity-40";

interface Issue {
  path?: string[] | string;
  message: string;
  line?: number | null;
}

type Msg = { kind: "ok" | "err" | "warn"; text: string } | null;

/** 一行的 diff 结果 */
type DiffRow = { kind: "same" | "add" | "del"; text: string; ln: number | null };

/**
 * 行级 LCS diff。
 *
 * 自己写而不是拉个 diff 库：这里只需要"哪几行加了、哪几行删了"，
 * 而策略文件是几十到几百行，O(n·m) 的表完全够用 —— 为一个函数引入依赖，
 * 换来的是每次装依赖都要多信任一个包。
 */
function diffLines(a: string[], b: string[]): DiffRow[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i], ln: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "del", text: a[i], ln: null });
      i++;
    } else {
      out.push({ kind: "add", text: b[j], ln: j + 1 });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++], ln: null });
  while (j < m) out.push({ kind: "add", text: b[j], ln: j++ + 1 });
  return out;
}

const isComment = (s: string) => s.trim().startsWith("#");

export function StrategyRawEditor({
  ids,
  initialId,
}: {
  ids: string[];
  initialId: string | null;
}) {
  const router = useRouter();
  const [id, setId] = useState(initialId ?? ids[0] ?? "");
  /** 服务端那份原文（载入时的快照）。draft 与它比就是 diff */
  const [base, setBase] = useState<{ raw: string; hash: string; filePath: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [showDiff, setShowDiff] = useState(false);
  const [backups, setBackups] = useState<Array<{ name: string; bytes: number }>>([]);

  const dirty = base !== null && draft !== base.raw;

  const diff = useMemo(
    () => (base === null ? [] : diffLines(base.raw.split("\n"), draft.split("\n"))),
    [base, draft]
  );
  const added = diff.filter((d) => d.kind === "add").length;
  const deleted = diff.filter((d) => d.kind === "del").length;
  /** 单独数被删掉的注释行 —— 这是最容易无声流失、又最难重建的东西 */
  const deletedComments = diff.filter((d) => d.kind === "del" && isComment(d.text)).length;

  async function load(which: string) {
    setBusy(true);
    setMsg(null);
    setIssues([]);
    try {
      const r = await fetch(`/api/strategy/raw?id=${encodeURIComponent(which)}`, {
        cache: "no-store",
      });
      const j = (await r.json()) as Record<string, unknown>;
      if (!r.ok) {
        setMsg({ kind: "err", text: String(j.error ?? `HTTP ${r.status}`) });
        return;
      }
      setBase({ raw: String(j.raw), hash: String(j.hash), filePath: String(j.filePath) });
      setDraft(String(j.raw));
      setBackups((j.backups as Array<{ name: string; bytes: number }>) ?? []);
      setShowDiff(false);
      setMsg({ kind: "ok", text: `已载入 ${String(j.filePath)}` });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function submit(dryRun: boolean) {
    if (base === null) return;
    setBusy(true);
    setMsg(null);
    setIssues([]);
    try {
      const r = await fetch("/api/strategy/raw", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, text: draft, baseHash: base.hash, dryRun }),
      });
      const j = (await r.json()) as Record<string, unknown>;
      if (!r.ok) {
        setIssues((j.issues as Issue[]) ?? []);
        setMsg({
          kind: r.status === 409 ? "warn" : "err",
          text: String(j.error ?? `HTTP ${r.status}`),
        });
        return;
      }
      if (dryRun) {
        setMsg({ kind: "ok", text: `校验通过，未落盘。保存时备份将写到 ${String(j.backupPath)}` });
        return;
      }
      setMsg({ kind: "ok", text: `已保存。原文已备份到 ${String(j.backupPath)}` });
      // 重新载入：既刷新 hash，也让备份列表把刚生成那份带出来
      await load(id);
      router.refresh();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-ink-3 text-[11px]">策略</span>
          <select
            className="bg-panel-2 border border-line rounded-sm px-1.5 py-0.5 text-[12px] text-ink w-40"
            value={id}
            onChange={(e) => {
              setId(e.target.value);
              setBase(null);
              setDraft("");
            }}
          >
            {ids.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        <button className={btnCls} disabled={busy || id === ""} type="button" onClick={() => void load(id)}>
          {base === null ? "载入原文" : "重新载入（丢弃改动）"}
        </button>
        <button
          className={btnCls}
          disabled={busy || !dirty}
          type="button"
          onClick={() => setShowDiff((v) => !v)}
        >
          {showDiff ? "收起 diff" : `查看 diff（+${added} / -${deleted}）`}
        </button>
        <button className={btnCls} disabled={busy || !dirty} type="button" onClick={() => void submit(true)}>
          只校验
        </button>
        <button
          className={btnCls}
          disabled={busy || !dirty}
          type="button"
          onClick={() => {
            const warn =
              deletedComments > 0
                ? `\n\n注意：这次改动删掉了 ${deletedComments} 行注释。那些注释记着阈值的由来，删掉就没了（备份里还有）。`
                : "";
            if (!confirm(`保存到 ${base?.filePath}？\n+${added} 行 / -${deleted} 行。${warn}`)) return;
            void submit(false);
          }}
        >
          保存
        </button>
        {msg !== null ? (
          <span
            className={
              msg.kind === "ok" ? "text-down text-[12px]" : msg.kind === "warn" ? "text-warn text-[12px]" : "text-danger text-[12px]"
            }
          >
            {msg.text}
          </span>
        ) : null}
      </div>

      {issues.length > 0 ? (
        <ul className="text-[12px] text-danger leading-6">
          {issues.map((i, k) => (
            <li key={k}>
              {i.line !== null && i.line !== undefined ? (
                <span className="num text-ink-3 mr-1">L{i.line}</span>
              ) : null}
              {i.path !== undefined ? (
                <span className="text-ink-2 mr-1">
                  {Array.isArray(i.path) ? i.path.join(".") : i.path}
                </span>
              ) : null}
              {i.message}
            </li>
          ))}
        </ul>
      ) : null}

      {base === null ? (
        <p className="text-ink-3 text-[12px]">
          先「载入原文」。载入之后这里就是那份 YAML 的全文，可以改任何东西 ——
          新增键、改列表、改整段规则。保存前会做 schema 校验并把原文备份成带时间戳的副本。
        </p>
      ) : showDiff ? (
        <div className="border border-line rounded-sm max-h-96 overflow-auto text-[11px] leading-5 font-mono">
          {diff
            .filter((d) => d.kind !== "same")
            .map((d, k) => (
              <div
                key={k}
                className={
                  d.kind === "add"
                    ? "bg-down/10 text-down whitespace-pre-wrap break-all px-2"
                    : "bg-danger/10 text-danger whitespace-pre-wrap break-all px-2"
                }
              >
                {d.kind === "add" ? "+ " : "- "}
                {d.text === "" ? "␊" : d.text}
              </div>
            ))}
          {added === 0 && deleted === 0 ? <div className="px-2 text-ink-3">没有差异</div> : null}
        </div>
      ) : (
        <textarea
          className="bg-panel-2 border border-line rounded-sm p-2 text-[11px] leading-5 font-mono text-ink h-96 w-full"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      )}

      {base !== null ? (
        <p className="text-ink-3 text-[11px]">
          真相源 <code className="text-ink-2">{base.filePath}</code>
          {dirty ? <span className="text-warn ml-2">有未保存改动</span> : <span className="ml-2">与磁盘一致</span>}
          {deletedComments > 0 ? (
            <span className="text-danger ml-2">本次将删除 {deletedComments} 行注释</span>
          ) : null}
          <br />
          保存链路：id 一致性 → 乐观并发（磁盘被改过就回 409，不覆盖）→ 整份 schema 校验（不过则一个字节都不写）
          → **原文备份成 <code className="text-ink-2">&lt;文件名&gt;.YYYYMMDD-HHmmss</code>** → 临时文件 + rename 落盘。
          {backups.length > 0 ? `已有 ${backups.length} 份备份，最新：${backups[0].name}` : "尚无备份"}
        </p>
      ) : null}
    </div>
  );
}
