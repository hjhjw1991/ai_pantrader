"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FlatParam } from "@/lib/ui/adapters/strategy";

/**
 * 参数面板 —— config/strategy.yaml 的**投影**（D7）。
 *
 * 这里没有 state 存参数值：每一行的当前值都是服务端刚从 YAML 读出来的，
 * 提交后 router.refresh() 重新读文件。不存在第二份状态，所以不可能出现
 * "面板显示 0.05 但 YAML 里是 0.06" 这种最难查的偏差。
 *
 * 只允许改纯量。列表与整段规则要直接编辑 YAML —— 自动改写需要猜缩进与注释归属，
 * 猜错会破坏原文，而那些注释记着每个阈值的由来。
 */
export function ParamPanel({ params }: { params: FlatParam[] }) {
  return (
    <div className="overflow-x-auto max-h-96 overflow-y-auto">
      <table className="dense">
        <thead>
          <tr>
            <th>参数路径</th>
            <th className="text-right">当前值</th>
            <th>类型</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {params.map((p) => (
            <ParamRow key={p.path} p={p} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ParamRow({ p }: { p: FlatParam }) {
  const router = useRouter();
  const [draft, setDraft] = useState(String(p.value));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const editable = p.kind === "scalar";
  const dirty = editable && draft !== String(p.value);

  async function save() {
    setBusy(true);
    setErr(null);
    // 数字写成数字、布尔写成布尔：全都当字符串写回去会把 0.05 变成 "0.05"，
    // 之后 loader 校验会拒（区间校验只认数字），但那时错误信息很难懂
    let value: string | number | boolean = draft;
    if (typeof p.value === "number" && draft.trim() !== "" && Number.isFinite(Number(draft))) {
      value = Number(draft);
    } else if (typeof p.value === "boolean") {
      value = draft === "true";
    }
    try {
      const r = await fetch("/api/strategy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: p.path, value }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const detail = j?.issues ? ` ${JSON.stringify(j.issues)}` : "";
        throw new Error(`${j?.error ?? `HTTP ${r.status}`}${detail}`);
      }
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td className="text-ink-2">{p.path}</td>
      <td className="num">
        {editable ? (
          <input
            className="num w-28 bg-panel-2 border border-line-2 rounded-sm px-1 text-ink"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && dirty) void save();
              if (e.key === "Escape") setDraft(String(p.value));
            }}
          />
        ) : (
          <span className="text-ink">
            {Array.isArray(p.value) ? p.value.join(", ") : String(p.value)}
          </span>
        )}
      </td>
      <td className="text-ink-3">{p.kind === "scalar" ? "纯量" : "列表（改 YAML）"}</td>
      <td>
        {dirty ? (
          <button
            className="text-info hover:text-ink disabled:opacity-40"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? "写入中…" : "写回 YAML"}
          </button>
        ) : null}
        {err ? <span className="ml-2 text-danger text-[11px]">{err}</span> : null}
      </td>
    </tr>
  );
}
