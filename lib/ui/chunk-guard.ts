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

/** dev / build 都不会改写的产物路径特征。CSS 块走另一个目录，404 一样是白屏/裸页 */
export const CHUNK_PATHS = ["/_next/static/chunks/", "/_next/static/css/"];

export const CHUNK_MARKERS = ["ChunkLoadError", "Loading chunk", "Loading CSS chunk"];

/** sessionStorage 里记"上次自救时刻"的键。组件与 <head> 里的内联脚本共用 */
export const CHUNK_RELOAD_KEY = "pt:chunk-reload-at";

/** 内联脚本装好后在 window 上留的标记：组件看到它就不再重复挂监听 */
export const CHUNK_GUARD_FLAG = "__ptChunkGuard";

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
    if (url !== null) return CHUNK_PATHS.some((p) => url.includes(p));
    // target 上没有 src/href：这是 ErrorEvent（target 是 window），不是资源加载事件。
    // 未捕获的 ChunkLoadError 就从这条路来 —— 往下看它带的 error 与 message，不能直接判 false
    const ev = e as { error?: unknown; message?: unknown };
    if (ev.error && typeof ev.error === "object" && errorLooksLikeChunk(ev.error)) return true;
    return typeof ev.message === "string" && CHUNK_MARKERS.some((m) => (ev.message as string).includes(m));
  }

  return errorLooksLikeChunk(e);
}

function errorLooksLikeChunk(e: object): boolean {
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

/** 冷却记录存在哪儿。浏览器里是 sessionStorage；读写都可能抛（隐私模式、配额、被禁用） */
export interface CooldownStore {
  get: () => string | null;
  set: (v: string) => void;
}

export type ReloadDecision =
  /** 可以重载，冷却记录已经确实写进去了 */
  | "reload"
  /** 冷却期内已经自救过 */
  | "cooldown"
  /** 存储读或写不了：记不住"刚刷过"，就绝不自动刷 —— 否则失败一次刷一次，永远停不下来 */
  | "noStorage";

/**
 * 要不要自动重载。
 *
 * 关键是"记得住才敢刷"：冷却记录写不进去（或写了读不回来）时，
 * 重载后的页面不知道自己刚刷过，再失败就再刷 —— 无限循环。
 * 宁可白屏等人手动刷新，也不能把页面变成转盘。
 */
export function decideAutoReload(
  nowMs: number,
  store: CooldownStore,
  cooldownMs: number = CHUNK_COOLDOWN_MS,
): ReloadDecision {
  let raw: string | null;
  try {
    raw = store.get();
  } catch {
    return "noStorage";
  }
  const last = raw === null ? null : Number(raw);
  if (!shouldAutoReload(nowMs, last, cooldownMs)) return "cooldown";
  try {
    store.set(String(nowMs));
    // 写完读回来核对：有的环境 setItem 不抛但什么也没存
    if (store.get() !== String(nowMs)) return "noStorage";
  } catch {
    return "noStorage";
  }
  return "reload";
}

/**
 * 放进 <head> 的内联脚本。
 *
 * 组件的 useEffect 要等水合之后才挂上监听，而最常见的失败恰恰发生在那之前：
 * HTML 里的 <script src=".../chunks/xxx.js"> 一上来就 404，水合根本走不到。
 * 所以监听要在 HTML 解析时就挂好 —— 只能是内联脚本。
 *
 * 判定与冷却和上面的 TS 实现是同一套规则、同一组常量（路径、关键字、键名、冷却时长都从这里插进去），
 * 手写成 ES5 是因为它不经过打包器；行为一致性由 tests/chunk-guard.test.ts 直接执行这段脚本来核对。
 */
export function chunkGuardInlineScript(): string {
  const cfg = JSON.stringify({
    key: CHUNK_RELOAD_KEY, flag: CHUNK_GUARD_FLAG, cooldown: CHUNK_COOLDOWN_MS,
    paths: CHUNK_PATHS, markers: CHUNK_MARKERS,
  });
  return `(function(c){
if(window[c.flag])return;window[c.flag]=true;
function has(t,list){if(typeof t!=="string")return false;for(var i=0;i<list.length;i++){if(t.indexOf(list[i])>=0)return true;}return false;}
function errChunk(x){if(!x||typeof x!=="object")return false;var n=typeof x.name==="string"?x.name:"";var m=typeof x.message==="string"?x.message:"";return has(n+" "+m,c.markers);}
function isChunk(e){if(!e||typeof e!=="object")return false;
if("target" in e){var t=e.target,u=null;if(t&&typeof t==="object"){u=t.src!=null?t.src:t.href;}
if(typeof u==="string")return has(u,c.paths);
return errChunk(e.error)||has(e.message,c.markers);}
return errChunk(e);}
var done=false;
function attempt(){if(done)return;var now=Date.now(),raw;
try{raw=sessionStorage.getItem(c.key);}catch(_){console.warn("[候潮] 代码块加载失败，但会话存储不可用，记不住刚刷过 —— 不自动刷新，请手动刷新页面");done=true;return;}
var last=raw===null?null:Number(raw);
if(last!==null&&isFinite(last)&&now-last<c.cooldown){console.warn("[候潮] 代码块加载失败，且冷却期内已经自救过一次；停止自动刷新，请手动刷新页面（仍不行就重启 pnpm dev）");done=true;return;}
try{sessionStorage.setItem(c.key,String(now));if(sessionStorage.getItem(c.key)!==String(now))throw 0;}catch(_){console.warn("[候潮] 代码块加载失败，但会话存储写不进去，记不住刚刷过 —— 不自动刷新，请手动刷新页面");done=true;return;}
done=true;window.location.reload();}
window.addEventListener("error",function(e){if(isChunk(e))attempt();},true);
window.addEventListener("unhandledrejection",function(e){if(isChunk(e.reason))attempt();});
})(${cfg});`;
}
