import { describe, it, expect } from "vitest";
import {
  CHUNK_COOLDOWN_MS, CHUNK_GUARD_FLAG, CHUNK_RELOAD_KEY, chunkGuardInlineScript,
  decideAutoReload, isChunkFailure, shouldAutoReload, type CooldownStore,
} from "@/lib/ui/chunk-guard";

/** 造一个"资源加载失败"的事件对象：dev 下 script 404 就是这副样子 */
const resourceError = (tag: "script" | "img", url: string): unknown => {
  const el = { tagName: tag.toUpperCase() };
  return { target: tag === "script" ? { ...el, src: url } : { ...el, src: url } };
};

describe("认得出代码块加载失败", () => {
  it("ChunkLoadError（动态 import 被拒绝）", () => {
    const e = Object.assign(new Error("Loading chunk app/(dash)/page failed."), {
      name: "ChunkLoadError",
    });
    expect(isChunkFailure(e)).toBe(true);
  });

  it("消息里带 Loading chunk，哪怕 name 不是 ChunkLoadError", () => {
    expect(isChunkFailure(new Error("Loading chunk 1234 failed. (timeout)"))).toBe(true);
  });

  it("样式块也算 —— CSS chunk 404 同样是白屏", () => {
    expect(isChunkFailure(new Error("Loading CSS chunk app/layout failed."))).toBe(true);
  });

  it("产物目录里的 script 加载失败", () => {
    expect(isChunkFailure(resourceError("script", "/_next/static/chunks/app/(dash)/page.js"))).toBe(true);
  });

  it("普通图片的 404 不算 —— 那不该触发整页刷新", () => {
    expect(isChunkFailure(resourceError("img", "/logo.png"))).toBe(false);
  });

  it("业务报错不算 —— 刷新治不了 TypeError", () => {
    expect(isChunkFailure(new TypeError("Cannot read properties of undefined"))).toBe(false);
  });

  it("空值与非对象不炸", () => {
    for (const v of [null, undefined, "boom", 42]) {
      expect(isChunkFailure(v)).toBe(false);
    }
  });
});

describe("冷却：不能把自己刷成转盘", () => {
  it("从没重载过 —— 立刻自救", () => {
    expect(shouldAutoReload(10_000, null)).toBe(true);
  });

  it("刚重载过 —— 冷却期内不再刷", () => {
    expect(shouldAutoReload(10_000 + 1_000, 10_000)).toBe(false);
  });

  it("过了冷却期 —— 可以再试一次", () => {
    expect(shouldAutoReload(10_000 + CHUNK_COOLDOWN_MS, 10_000)).toBe(true);
  });

  it("存进去的时间是脏值 —— 当成没重载过", () => {
    expect(shouldAutoReload(10_000, Number.NaN)).toBe(true);
  });

  it("时钟回拨 —— 宁可不刷", () => {
    expect(shouldAutoReload(5_000, 10_000)).toBe(false);
  });
});

describe("未捕获的 ChunkLoadError 走 window 的 error 事件", () => {
  // ErrorEvent 的 target 是 window：没有 src/href，不能当成"非产物资源"直接判 false
  const win = { location: {}, document: {} };

  it("error 是 ChunkLoadError → 认", () => {
    const err = Object.assign(new Error("Loading chunk 77 failed."), { name: "ChunkLoadError" });
    expect(isChunkFailure({ target: win, error: err, message: "Uncaught ChunkLoadError" })).toBe(true);
  });

  it("error 缺失、只剩 message → 看 message", () => {
    expect(isChunkFailure({ target: win, error: null, message: "Uncaught Error: Loading chunk 3 failed." })).toBe(true);
  });

  it("window 上的普通 TypeError → 不认", () => {
    expect(isChunkFailure({
      target: win, error: new TypeError("x is undefined"), message: "Uncaught TypeError: x is undefined",
    })).toBe(false);
  });

  it("target 为 null 的事件同样往下看 error", () => {
    const err = Object.assign(new Error("boom"), { name: "ChunkLoadError" });
    expect(isChunkFailure({ target: null, error: err })).toBe(true);
  });
});

describe("CSS 块 404 也认", () => {
  it("<link href=/_next/static/css/...> 加载失败", () => {
    expect(isChunkFailure({ target: { tagName: "LINK", href: "http://localhost:3000/_next/static/css/app/layout.css" } })).toBe(true);
  });

  it("其它目录的样式表不认", () => {
    expect(isChunkFailure({ target: { tagName: "LINK", href: "https://fonts.example.com/a.css" } })).toBe(false);
  });
});

/** 内存版存储；可以让读或写抛错，或者"写了没存上" */
function memStore(o: { getThrows?: boolean; setThrows?: boolean; dropWrites?: boolean; init?: string } = {}): CooldownStore & { v: string | null } {
  const st = {
    v: o.init ?? null as string | null,
    get: () => { if (o.getThrows) throw new Error("SecurityError"); return st.v; },
    set: (x: string) => { if (o.setThrows) throw new Error("QuotaExceededError"); if (!o.dropWrites) st.v = x; },
  };
  return st;
}

describe("存储不可用时绝不自动刷新 —— 记不住刚刷过就会无限循环", () => {
  it("正常：第一次可刷，并且确实记下了时刻", () => {
    const st = memStore();
    expect(decideAutoReload(10_000, st)).toBe("reload");
    expect(st.v).toBe("10000");
    // 刷完（同一个会话）马上又失败：冷却
    expect(decideAutoReload(10_500, st)).toBe("cooldown");
  });

  it("读抛错 → 不刷", () => {
    expect(decideAutoReload(10_000, memStore({ getThrows: true }))).toBe("noStorage");
  });

  it("写抛错 → 不刷", () => {
    expect(decideAutoReload(10_000, memStore({ setThrows: true }))).toBe("noStorage");
  });

  it("写了不抛但没存上 → 不刷", () => {
    expect(decideAutoReload(10_000, memStore({ dropWrites: true }))).toBe("noStorage");
  });

  it("模拟一连串'重载后再失败'：存储坏掉时一次都不刷，存储正常时最多刷一次", () => {
    for (const broken of [{ getThrows: true }, { setThrows: true }, { dropWrites: true }]) {
      const st = memStore(broken);
      let reloads = 0;
      for (let i = 0; i < 20; i++) if (decideAutoReload(10_000 + i * 100, st) === "reload") reloads++;
      expect(reloads).toBe(0);
    }
    const ok = memStore();
    let reloads = 0;
    for (let i = 0; i < 20; i++) if (decideAutoReload(10_000 + i * 100, ok) === "reload") reloads++;
    expect(reloads).toBe(1);
  });
});

describe("<head> 内联脚本与 TS 实现同一套规则", () => {
  type Handler = (e: unknown) => void;
  function boot(storage: { getThrows?: boolean; setThrows?: boolean; init?: string } = {}) {
    const handlers: Record<string, Handler[]> = {};
    const data: Record<string, string> = {};
    if (storage.init !== undefined) data[CHUNK_RELOAD_KEY] = storage.init;
    let reloads = 0;
    const win: Record<string, unknown> = {
      addEventListener: (t: string, h: Handler) => { (handlers[t] ??= []).push(h); },
      location: { reload: () => { reloads++; } },
    };
    const sessionStorage = {
      getItem: (k: string) => { if (storage.getThrows) throw new Error("SecurityError"); return data[k] ?? null; },
      setItem: (k: string, v: string) => { if (storage.setThrows) throw new Error("QuotaExceededError"); data[k] = v; },
    };
    const consoleStub = { warn: () => {} };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("window", "sessionStorage", "console", chunkGuardInlineScript())(win, sessionStorage, consoleStub);
    const fire = (t: string, e: unknown) => (handlers[t] ?? []).forEach((h) => h(e));
    return { win, fire, reloads: () => reloads, handlers, data };
  }

  it("装上后留标记，避免组件重复挂监听", () => {
    const b = boot();
    expect(b.win[CHUNK_GUARD_FLAG]).toBe(true);
  });

  it("首屏 script 404 → 刷一次并记下时刻", () => {
    const b = boot();
    b.fire("error", { target: { src: "/_next/static/chunks/app/page.js" } });
    expect(b.reloads()).toBe(1);
    expect(b.data[CHUNK_RELOAD_KEY]).toBeDefined();
  });

  it("CSS 404、window 上的 ChunkLoadError、被拒绝的动态 import 都认", () => {
    for (const [t, e] of [
      ["error", { target: { href: "/_next/static/css/app.css" } }],
      ["error", { target: {}, error: { name: "ChunkLoadError", message: "x" } }],
      ["unhandledrejection", { reason: { name: "Error", message: "Loading chunk 9 failed." } }],
    ] as const) {
      const b = boot();
      b.fire(t, e);
      expect(b.reloads()).toBe(1);
    }
  });

  it("图片 404、业务报错不刷", () => {
    const b = boot();
    b.fire("error", { target: { src: "/logo.png" } });
    b.fire("error", { target: {}, error: new TypeError("x"), message: "Uncaught TypeError" });
    expect(b.reloads()).toBe(0);
  });

  it("冷却期内不刷", () => {
    const b = boot({ init: String(Date.now()) });
    b.fire("error", { target: { src: "/_next/static/chunks/a.js" } });
    expect(b.reloads()).toBe(0);
  });

  it("会话存储读或写抛错 → 不刷（否则无限循环）", () => {
    for (const s of [{ getThrows: true }, { setThrows: true }]) {
      const b = boot(s);
      b.fire("error", { target: { src: "/_next/static/chunks/a.js" } });
      expect(b.reloads()).toBe(0);
    }
  });

  it("同一次页面生命周期里连着失败多次，最多刷一次", () => {
    const b = boot();
    for (let i = 0; i < 5; i++) b.fire("error", { target: { src: "/_next/static/chunks/a.js" } });
    expect(b.reloads()).toBe(1);
  });
});
