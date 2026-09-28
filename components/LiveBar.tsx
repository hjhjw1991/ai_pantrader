"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fmtNoticeTs } from "@/lib/ui/format";
import { toShanghaiWall } from "@/lib/ui/time";
import { shanghaiDay } from "@/lib/data/clock";
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

/**
 * 铃铛里默认露出的条数。
 *
 * 通知是越积越多的（一个交易日几十条），全量铺开等于把交通事故现场摆到顶栏，
 * 而 90% 的情况人只想看最近那几条。所以：**默认 10 条，剩下的自己点。**
 * 不是截掉，是折叠 —— 且渲染只做前 10 条，翻页前列表一屏就装得下，不用靠 max-height 兜。
 */
const PAGE_SIZE = 10;
/**
 * 会话内保留上限。
 *
 * SSE 一路往里塞，两天不关页面就能攒出上千条，而人根本不会翻到那么远。
 * 超过的部分丢最旧的（它们随时能从 /api/notifications 重新拉回来，不丢数据）。
 */
const MAX_KEPT = 500;

type Notice = {
  id: number; ts: string; kind: string;
  severity: "critical" | "warn" | "info";
  title: string; body: string | null;
};

/**
 * 按 id 去重合并，保持新→旧。
 *
 * SSE 推来的和历史翻页拉回来的会在中间地带撞车（同一条通知两边都到），
 * 直接 concat 会让同一个 id 出现两次，而 React 的 key 重复是运行时警告级别的脏数据。
 */
function dedupeMerge(prev: Notice[], incoming: Notice[]): Notice[] {
  const byId = new Map<number, Notice>();
  for (const n of prev) byId.set(n.id, n);
  for (const n of incoming) byId.set(n.id, n);   // 后来的覆盖：服务端口径是准的
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, MAX_KEPT);
}

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
      // 不再截断成 8 条：显示多少由铃铛里的"加载更多"管，这里是数据源不该替 UI 做决定
      setNotices(prev => dedupeMerge(prev, [n]));
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
  const [revealed, setRevealed] = useState(PAGE_SIZE);
  /** 服务端通知总数。用于算"还有几条"，以及判断该不该显示加载更多 */
  const [total, setTotal] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  /**
   * 历史只拉一次。铃铛反复开关不该反复打服务端 ——
   * 期间漏掉的新通知由 SSE 兜住，不会丢。
   */
  const historyLoadedRef = useRef(false);
  const unseen = notices.filter(n => n.id > seen).length;
  const btn = "border border-line-2 rounded-sm px-2 py-0.5 text-[11px] hover:bg-panel-2 disabled:opacity-50";

  /** 拉一页更旧的通知。before=0 表示第一页（最新的 PAGE_SIZE 条） */
  const loadOlder = useCallback(async (before: number): Promise<Notice[]> => {
    setLoadingOlder(true);
    setLoadErr(null);
    try {
      const res = await fetch(
        `/api/notifications?limit=${PAGE_SIZE}${before > 0 ? `&before=${before}` : ""}`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      const items: Notice[] = d.items ?? [];
      // 总数而不是"剩余"：SSE 首推已经给过一批，服务端算的剩余会把重复的那部分算两遍
      setTotal(t => Math.max(t, Number(d.total ?? 0)));
      setNotices(prev => dedupeMerge(prev, items));
      return items;
    } catch {
      // 拿不到历史不许伪装成"没有更多"，否则那条加载更多按钮会静默失效
      setLoadErr("加载失败，重试一下");
      return [];
    } finally {
      setLoadingOlder(false);
    }
  }, []);

  const toggleBell = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (!next) return;
    setSeen(s => Math.max(s, notices[0]?.id ?? 0));
    if (historyLoadedRef.current) return;
    historyLoadedRef.current = true;
    // 历史是用户主动点开看的，拉完就算读过 —— 红点只该为"推来的新东西"计数
    void loadOlder(0).then(items => {
      setSeen(s => Math.max(s, items[0]?.id ?? 0));
    });
  }, [open, notices, loadOlder]);

  /**
   * 还有几条没显示。展示的永远是最新的 revealed 条，所以"没显示"就等于"比它们旧"的
   * 那些 —— 总数减已展示数即可，不必区分哪些拉过哪些没拉过。
   *
   * 取 max(服务端总数, 手上已有条数)：盘中新来的通知先落到 SSE 这边，
   * 而 total 只在翻页时才刷新，只看 total 会漏掉它们（最终表现为底下最后几条点不出来）。
   */
  const hidden = Math.max(0, Math.max(total, notices.length) - revealed);
  const canLoadMore = hidden > 0;
  const loadMore = async () => {
    // 本地已经拿到的先展开（免掉一次往返），不够了再去服务端要下一页
    if (notices.length < revealed + PAGE_SIZE && hidden > 0) {
      const oldest = notices.length === 0 ? 0 : notices[notices.length - 1].id;
      await loadOlder(oldest);
    }
    setRevealed(r => r + PAGE_SIZE);
  };

  const visible = notices.slice(0, revealed);

  /**
   * 顶栏里的紧凑版：连接状态、立即采集、桌面通知、通知铃。
   * 通知不再平铺在页面上（一早上的买入提醒能占满半屏），收进铃铛；硬线告警（critical）另外常驻显示。
   */
  /**
   * 常驻的硬线告警条只认**今天**的。
   *
   * 铃铛现在会拉历史，一条三天前的 critical 要是能占住这条位置，
   * 就等于顶栏永远挂着一件早就不作数的事 —— 而真正今天破线的那条被挤掉。
   */
  const today = shanghaiDay();
  const critical = notices.filter(n => {
    if (n.severity !== "critical") return false;
    const wall = toShanghaiWall(n.ts);
    return wall !== null && wall.slice(0, 10) === today;
  });
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
        <button type="button" aria-label="通知" onClick={toggleBell}
          className="relative w-7 h-7 flex items-center justify-center rounded-sm hover:bg-panel-2 text-ink-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </svg>
          {unseen > 0 ? <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-danger text-white text-[10px] leading-4 text-center">{unseen}</span> : null}
        </button>
        {open ? (
          <div className="absolute right-0 top-8 z-50 w-[30rem] flex flex-col bg-panel border border-line-2 rounded-sm shadow-2xl">
            <div className="flex items-center px-3 py-2 border-b border-line text-ink">
              通知
              {unseen > 0 ? <span className="ml-2 text-ink-3">{unseen} 条新</span> : null}
              {loadErr ? <span className="ml-2 text-danger">{loadErr}</span> : null}
              {!notifyOn ? (
                <button className={`${btn} ml-auto`} onClick={enableNotify} type="button">开启桌面通知</button>
              ) : <span className="ml-auto text-down">桌面通知已开</span>}
            </div>
            {/* 列表自己滚，加载更多钉在最下面：否则刚过 10 条按钮就被挤到滚动区外面，
                人以为到底了。 */}
            <div className="max-h-[60vh] overflow-y-auto">
              {visible.length === 0 ? (
                <div className="px-3 py-3 text-ink-3">
                  {loadingOlder ? "加载中…" : "还没有任何通知"}
                </div>
              ) : (
                <ul>
                  {visible.map(n => (
                    <li key={n.id} className="px-3 py-2 border-b border-line/60">
                      <div className={n.severity === "critical" ? "text-danger" : n.severity === "warn" ? "text-warn" : "text-ink-2"}>
                        {/* 带日期：只看 HH:MM:SS 分不清"今天早上"和"上周二"，
                            而这条通知还作不作数，多半就取决于它多老了 */}
                        <span className="num text-ink-3 mr-1" title={n.ts}>{fmtNoticeTs(n.ts)}</span>{n.title}
                      </div>
                      {n.body ? <div className="text-ink-3 mt-0.5 leading-5">{n.body}</div> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {canLoadMore ? (
              <button type="button" onClick={loadMore} disabled={loadingOlder}
                className="w-full px-3 py-2 border-t border-line text-[11px] text-ink-2 hover:bg-panel-2 disabled:opacity-50">
                {loadingOlder ? "加载中…" : `加载更多${hidden > 0 ? `（还有 ${hidden} 条）` : ""}`}
              </button>
            ) : visible.length > 0 ? (
              <div className="px-3 py-2 border-t border-line text-[11px] text-ink-3">没有更早的了</div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
