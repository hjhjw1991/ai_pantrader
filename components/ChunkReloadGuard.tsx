"use client";

import { useEffect } from "react";
import {
  CHUNK_COOLDOWN_MS, CHUNK_GUARD_FLAG, CHUNK_RELOAD_KEY,
  decideAutoReload, isChunkFailure,
} from "@/lib/ui/chunk-guard";

/**
 * 页面级自救：监听到代码块加载失败就重载一次。
 *
 * 主力是 app/layout.tsx 的 <head> 里那段内联脚本（chunkGuardInlineScript）：
 * 水合之前的 script 404 只有它接得住。这个组件是兜底 —— 内联脚本因为什么原因没装上
 * （被 CSP 拦了、被改掉了），水合之后至少还有这一层。两者都装会各自刷一次，
 * 所以看到内联脚本留下的标记就什么都不做。
 *
 * 只挂监听、不渲染任何东西。识别与冷却的判断都在 lib/ui/chunk-guard.ts 里（可测），
 * 这里只负责跟浏览器打交道。sessionStorage 而不是 localStorage：
 * 冷却是"这个标签页刚试过"，不该跨标签页、更不该跨天留着。
 */
export function ChunkReloadGuard(): null {
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    if (w[CHUNK_GUARD_FLAG]) return;
    w[CHUNK_GUARD_FLAG] = true;
    let stopped = false;
    let done = false;

    const attempt = (): void => {
      if (stopped || done) return;
      const decision = decideAutoReload(Date.now(), {
        get: () => sessionStorage.getItem(CHUNK_RELOAD_KEY),
        set: (v) => sessionStorage.setItem(CHUNK_RELOAD_KEY, v),
      }, CHUNK_COOLDOWN_MS);
      done = true;

      if (decision === "cooldown") {
        // 重载过一次还是失败，说明不是产物过期这么简单，别把页面刷成转盘
        console.warn(
          `[候潮] 代码块加载失败，且 ${Math.round(CHUNK_COOLDOWN_MS / 1000)} 秒内已经自救过一次；` +
            "停止自动刷新，请手动刷新页面（仍不行就重启 pnpm dev）",
        );
        return;
      }
      if (decision === "noStorage") {
        // 记不住"刚刷过"就不能刷：刷完再失败会再刷，永远停不下来
        console.warn("[候潮] 代码块加载失败，但会话存储不可用，记不住刚刷过 —— 不自动刷新，请手动刷新页面");
        return;
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
      w[CHUNK_GUARD_FLAG] = false;
      window.removeEventListener("error", onError, true);
      window.removeEventListener("unhandledrejection", onReject);
    };
  }, []);

  return null;
}
