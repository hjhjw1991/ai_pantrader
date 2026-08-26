"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { intradayIntervalMin } from "@/lib/data/schedule";
import { useCollectScan, CollectProgress } from "@/components/CollectScan";

/**
 * 实时条：1 分钟自动刷新 + SSE 推送 + 桌面通知 + 立即采集按钮。
 *
 * 三个节奏是**故意不同**的，别合并：
 *   页面刷新   1 分钟   看数字用，便宜
 *   采集轮次   5 分钟   一轮全市场约 45 秒，1 分钟一轮只剩 15 秒余量，一次抖动就叠着跑
 *   SSE 轮询   3 秒     只在真有变化时推，静默期开销是一条 SELECT MAX(ts)
 *
 * 刷新用 router.refresh() 而不是 location.reload()：
 * 前者只重跑 server component，保留滚动位置与展开状态 ——
 * 盘中正看着某只票的明细，被整页重载打回顶部是很烦的。
 */

const REFRESH_MS = 60_000;
/** 采集节奏取自时刻表，不手打 —— 时刻表改了这行字必须跟着改 */
const SCAN_MIN = intradayIntervalMin();

type Notice = {
  id: number; ts: string; kind: string;
  severity: "critical" | "warn" | "info";
  title: string; body: string | null;
};

export function LiveBar() {
  const router = useRouter();
  const [live, setLive] = useState(false);
  const [lastEvent, setLastEvent] = useState<string | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [collectMsg, setCollectMsg] = useState<string | null>(null);
  const [notifyOn, setNotifyOn] = useState(false);
  const lastIdRef = useRef(0);

  // ── 1 分钟软刷新 ──
  useEffect(() => {
    const t = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [router]);

  // ── SSE ──
  useEffect(() => {
    const es = new EventSource(`/api/events?sinceId=${lastIdRef.current}`);
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);   // EventSource 自己重连，不手动重建

    es.addEventListener("data", e => {
      const d = JSON.parse((e as MessageEvent).data);
      setLastEvent(d.latestQuoteTs ?? null);
      // 数据变了就软刷新，但不弹通知 —— 数据刷新不需要人做动作
      router.refresh();
    });

    es.addEventListener("notify", e => {
      const n: Notice = JSON.parse((e as MessageEvent).data);
      lastIdRef.current = Math.max(lastIdRef.current, n.id);
      setNotices(prev => [n, ...prev].slice(0, 8));
      router.refresh();
      // 只有 critical / warn 才弹桌面通知（spec §13：只有关键信号才响）。
      // info 也弹的话，用户两天后就会关掉通知权限，等于把 critical 一起弄哑
      if (notifyOn && n.severity !== "info" && typeof Notification !== "undefined"
          && Notification.permission === "granted") {
        new Notification(n.title, {
          body: n.body ?? undefined,
          // 同一件事重复推送时替换旧通知，不堆一屏
          tag: `pantrader-${n.kind}-${n.id}`,
          requireInteraction: n.severity === "critical",
        } as NotificationOptions);
      }
    });

    return () => es.close();
  }, [router, notifyOn]);

  // 权限只能由用户点击触发（浏览器要求），不能页面一加载就弹
  const enableNotify = useCallback(async () => {
    if (typeof Notification === "undefined") {
      setCollectMsg("此浏览器不支持桌面通知");
      return;
    }
    const p = await Notification.requestPermission();
    setNotifyOn(p === "granted");
    if (p !== "granted") setCollectMsg("桌面通知未授权，关键信号只会显示在页面上");
  }, []);

  // 采集逻辑与候选池那个按钮共用一份：/api/collect 现在是 NDJSON 流，
  // 两处各写一遍解析必然漂移，而漂移的那一份只在少用的入口上炸
  const scan = useCollectScan();

  const btn = "border border-line-2 rounded-sm px-2 py-0.5 text-[11px] hover:bg-panel-2 disabled:opacity-50";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
        <span className="flex items-center gap-1">
          <span
            className={live ? "inline-block w-1.5 h-1.5 rounded-full bg-down"
                            : "inline-block w-1.5 h-1.5 rounded-full bg-ink-3"}
          />
          {live ? "实时推送已连接" : "推送未连接（页面仍每分钟刷新）"}
        </span>
        <span>页面 1 分钟自刷 · 采集 {SCAN_MIN} 分钟一轮</span>
        {lastEvent ? <span>最新快照 {lastEvent.slice(11, 19)}</span> : null}

        <button className={btn} disabled={scan.busy} onClick={scan.run} type="button">
          {scan.busy
            ? (scan.total > 0 ? `采集中 ${scan.done}/${scan.total} 批` : "采集中…")
            : "立即采集"}
        </button>
        {!notifyOn ? (
          <button className={btn} onClick={enableNotify} type="button">
            开启桌面通知
          </button>
        ) : (
          <span className="text-down">桌面通知已开</span>
        )}
        {collectMsg ? <span className="text-ink-2">{collectMsg}</span> : null}
        <span className="w-56"><CollectProgress s={scan} /></span>
      </div>

      {notices.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {notices.map(n => (
            <li
              key={n.id}
              className={
                n.severity === "critical"
                  ? "text-danger text-[11px]"
                  : n.severity === "warn"
                    ? "text-warn text-[11px]"
                    : "text-ink-3 text-[11px]"
              }
            >
              {n.ts.slice(11, 19)} {n.title}
              {n.body ? <span className="text-ink-3">　{n.body}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
