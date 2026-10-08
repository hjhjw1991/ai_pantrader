"use client";

import { useEffect } from "react";
import { CHUNK_COOLDOWN_MS, isChunkFailure, shouldAutoReload } from "@/lib/ui/chunk-guard";

const KEY = "pt:chunk-reload-at";

/**
 * 页面级自救：监听到代码块加载失败就重载一次。
 *
 * 只挂监听、不渲染任何东西。识别与冷却的判断都在 lib/ui/chunk-guard.ts 里（可测），
 * 这里只负责跟浏览器打交道。sessionStorage 而不是 localStorage：
 * 冷却是"这个标签页刚试过"，不该跨标签页、更不该跨天留着。
 */
export function ChunkReloadGuard(): null {
  useEffect(() => {
    let stopped = false;

    const attempt = (): void => {
      if (stopped) return;
      const now = Date.now();
      let last: number | null = null;
      try {
        const raw = sessionStorage.getItem(KEY);
        last = raw === null ? null : Number(raw);
      } catch {
        last = null; // 隐私模式下 sessionStorage 会抛，退化成"从没重载过"
      }

      if (!shouldAutoReload(now, last, CHUNK_COOLDOWN_MS)) {
        // 重载过一次还是失败，说明不是产物过期这么简单，别把页面刷成转盘
        console.warn(
          `[候潮] 代码块加载失败，且 ${Math.round(CHUNK_COOLDOWN_MS / 1000)} 秒内已经自救过一次；` +
            "停止自动刷新，请手动刷新页面（仍不行就重启 pnpm dev）",
        );
        return;
      }

      try {
        sessionStorage.setItem(KEY, String(now));
      } catch {
        /* 存不进去也要刷新：最坏情况是冷却失效，而不是页面一直白着 */
      }
      window.location.reload();
    };

    // capture 阶段：资源加载错误不冒泡，只能在捕获阶段拿到
    const onError = (e: Event): void => {
      if (isChunkFailure(e)) attempt();
    };
    const onReject = (e: PromiseRejectionEvent): void => {
      if (isChunkFailure(e.reason)) attempt();
    };

    window.addEventListener("error", onError, true);
    window.addEventListener("unhandledrejection", onReject);
    return () => {
      stopped = true;
      window.removeEventListener("error", onError, true);
      window.removeEventListener("unhandledrejection", onReject);
    };
  }, []);

  return null;
}
