import { describe, it, expect } from "vitest";
import { DEFAULT_SLOTS } from "@/lib/contracts/advisor";
import { createAdvisor, resolveAdvisorMode } from "@/lib/advisor";
import { makeInput } from "./helpers";

describe("createAdvisor 工厂", () => {
  it("三种模式各自返回对应实现", () => {
    expect(createAdvisor("null").mode).toBe("null");
    expect(createAdvisor("claude-cli").mode).toBe("claude-cli");
    expect(createAdvisor("claude-api").mode).toBe("claude-api");
  });

  it("ADVISOR=null 时全链路可用：拿到默认槽位且不降级", async () => {
    const snap = await createAdvisor("null").advise(makeInput());
    expect(snap.slots).toEqual(DEFAULT_SLOTS);
    expect(snap.degraded).toBe(false);
  });

  it("非法模式名回落 null，不抛错", () => {
    expect(createAdvisor("胡说" as any).mode).toBe("null");
  });

  it("没有任何宿主能力时探测结果是 null", () => {
    expect(resolveAdvisorMode({}, { hasCli: () => false, hasApiKey: () => false })).toBe("null");
  });

  it("探测到 CLI 优先用 CLI（spec §5.1 顺序）", () => {
    expect(resolveAdvisorMode({}, { hasCli: () => true, hasApiKey: () => true })).toBe("claude-cli");
  });

  it("没 CLI 但有 API key 时用 API", () => {
    expect(resolveAdvisorMode({}, { hasCli: () => false, hasApiKey: () => true })).toBe("claude-api");
  });

  it("ADVISOR 环境变量显式指定优先于探测 —— 用户能在设置页强制", () => {
    expect(resolveAdvisorMode({ ADVISOR: "null" }, { hasCli: () => true, hasApiKey: () => true })).toBe("null");
    expect(resolveAdvisorMode({ ADVISOR: "claude-api" }, { hasCli: () => true })).toBe("claude-api");
  });

  it("ADVISOR 写了非法值时忽略它走探测", () => {
    expect(resolveAdvisorMode({ ADVISOR: "gpt" }, { hasCli: () => false, hasApiKey: () => false })).toBe("null");
  });

  it("不传 mode 时按环境解析", () => {
    expect(createAdvisor(undefined, { env: { ADVISOR: "null" } }).mode).toBe("null");
  });
});
