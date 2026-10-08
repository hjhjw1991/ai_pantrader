import { describe, it, expect } from "vitest";
import { CHUNK_COOLDOWN_MS, isChunkFailure, shouldAutoReload } from "@/lib/ui/chunk-guard";

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
