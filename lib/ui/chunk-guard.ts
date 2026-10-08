/**
 * 代码块（chunk）失效的识别与自救。
 *
 * 场景：dev 模式下长时间挂着的 Next 进程，产物目录里某个 chunk 会被回收或重建失败，
 * 而服务端渲染出的 HTML 仍然照旧引用它 —— 浏览器拿到 404，客户端把它报成
 * `ChunkLoadError: Loading chunk ... failed (timeout)`，页面就这么白在那儿。
 *
 * 这类失败不需要用户看懂：chunk 失效后重载一次页面就能拿到新产物。
 * 但**不能无脑重载** —— 如果是代码本身有错，重载只会把白屏变成闪烁的白屏。
 * 所以这里只做两件事：
 *   1. 认得出"这是 chunk 加载失败"（而不是普通运行时报错）；
 *   2. 给一个冷却期，同一个标签页里不会连续自我刷新。
 */

/** 同一个标签页两次自救之间至少隔这么久 —— 冷却期内再次失败就认命，交给手动刷新 */
export const CHUNK_COOLDOWN_MS = 60_000;

/** dev / build 都不会改写的产物路径特征 */
const CHUNK_PATH = "/_next/static/chunks/";

const CHUNK_MARKERS = ["ChunkLoadError", "Loading chunk", "Loading CSS chunk"];

function urlOf(target: unknown): string | null {
  if (!target || typeof target !== "object") return null;
  const t = target as { src?: unknown; href?: unknown };
  const url = t.src ?? t.href;
  return typeof url === "string" ? url : null;
}

/**
 * 判定一次失败是不是"代码块加载失败"。
 *
 * 两类入口：
 *   - 资源加载错误（`<script src>` 404）：事件对象上带着元素；
 *   - 动态 import 被拒绝（unhandledrejection）：reason 是个 Error，看名字/消息。
 * 普通脚本报错（TypeError 之类）两种特征都没有，不该触发刷新。
 */
export function isChunkFailure(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;

  // 资源加载事件：只认 Next 产物目录里的 script/link，别把图片 404 也算进来
  if ("target" in e) {
    const url = urlOf((e as { target?: unknown }).target);
    return url !== null && url.includes(CHUNK_PATH);
  }

  const err = e as { name?: unknown; message?: unknown };
  const name = typeof err.name === "string" ? err.name : "";
  const message = typeof err.message === "string" ? err.message : "";
  const text = `${name} ${message}`;
  return CHUNK_MARKERS.some((m) => text.includes(m));
}

/**
 * 冷却期内不重复自救。
 * `lastReloadMs` 为 null（从没重载过）时可以立刻重载一次。
 */
export function shouldAutoReload(
  nowMs: number,
  lastReloadMs: number | null,
  cooldownMs: number = CHUNK_COOLDOWN_MS,
): boolean {
  if (lastReloadMs === null || !Number.isFinite(lastReloadMs)) return true;
  return nowMs - lastReloadMs >= cooldownMs;
}
