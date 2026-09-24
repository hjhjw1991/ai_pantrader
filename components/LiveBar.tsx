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
  /**
   * 桌面通知开关。
   *
   * 初值必须从 Notification.permission 读回来，不能写死 false ——
   * 浏览器权限是持久的，而这个 state 不是：写死 false 的话，授权过的人**每刷新一次页面
   * 就又关掉一次**，按钮还一直显示"开启桌面通知"，于是通知永远不弹。
   * （实测就是这样：notification 表本来也是空的，两个 bug 叠在一起，从没响过。）
   *
   * 用惰性初值而不是 useEffect：服务端渲染没有 Notification，直接读会炸；
   * 惰性初值在客户端首次渲染时求值，正好避开。
   */
  const [notifyOn, setNotifyOn] = useState(
    () => typeof Notification !== "undefined" && Notification.permission === "granted"
  );
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

  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(0);
  const unseen = notices.filter(n => n.id > seen).length;
  const btn = "border border-line-2 rounded-sm px-2 py-0.5 text-[11px] hover:bg-panel-2 disabled:opacity-50";

  /**
   * 顶栏里的紧凑版：连接状态、立即采集、桌面通知、通知铃。
   * 通知不再平铺在页面上（一早上的买入提醒能占满半屏），收进铃铛；硬线告警（critical）另外常驻显示。
   */
  const critical = notices.filter(n => n.severity === "critical");
  return (
    <div className="flex items-center gap-2 text-[11px] text-ink-3">
      <span className="flex items-center gap-1" title={`页面 1 分钟自刷 · 采集 ${SCAN_MIN} 分钟一轮`}>
        <span className={live ? "inline-block w-1.5 h-1.5 rounded-full bg-down" : "inline-block w-1.5 h-1.5 rounded-full bg-ink-3"} />
        {live ? "实时" : "未连接"}
        {lastEvent ? <span className="num ml-1">{lastEvent.slice(11, 19)}</span> : null}
      </span>
      {critical.slice(0, 1).map(n => (
        <span key={n.id} className="text-danger max-w-[22rem] truncate" title={n.body ?? ""}>⚠ {n.title}</span>
      ))}
      <button className={btn} disabled={scan.busy} onClick={scan.run} type="button">
        {scan.busy ? (scan.total > 0 ? `采集中 ${scan.done}/${scan.total}` : "采集中…") : "立即采集"}
      </button>
      {scan.busy ? <span className="w-40"><CollectProgress s={scan} /></span> : null}
      {collectMsg ? <span className="text-ink-2">{collectMsg}</span> : null}
      <div className="relative">
        <button type="button" aria-label="通知" onClick={() => { setOpen(v => !v); setSeen(notices[0]?.id ?? seen); }}
          className="relative w-7 h-7 flex items-center justify-center rounded-sm hover:bg-panel-2 text-ink-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </svg>
          {unseen > 0 ? <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-danger text-white text-[10px] leading-4 text-center">{unseen}</span> : null}
        </button>
        {open ? (
          <div className="absolute right-0 top-8 z-50 w-[28rem] max-h-[60vh] overflow-y-auto bg-panel border border-line-2 rounded-sm shadow-2xl">
            <div className="flex items-center px-3 py-2 border-b border-line text-ink">
              通知
              {!notifyOn ? (
                <button className={`${btn} ml-auto`} onClick={enableNotify} type="button">开启桌面通知</button>
              ) : <span className="ml-auto text-down">桌面通知已开</span>}
            </div>
            {notices.length === 0 ? <div className="px-3 py-3 text-ink-3">这次打开页面之后还没有新通知</div> : (
              <ul>
                {notices.map(n => (
                  <li key={n.id} className="px-3 py-2 border-b border-line/60">
                    <div className={n.severity === "critical" ? "text-danger" : n.severity === "warn" ? "text-warn" : "text-ink-2"}>
                      <span className="num text-ink-3 mr-1">{n.ts.slice(11, 19)}</span>{n.title}
                    </div>
                    {n.body ? <div className="text-ink-3 mt-0.5 leading-5">{n.body}</div> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
