import { describe, it, expect } from "vitest";
import type { AnySlot, ExitSlot, TimerSlot } from "@/lib/contracts";
import { createSlotRegistry } from "@/lib/strategy/v2/registry";

const timer = (name: string, version = "1.0.0"): TimerSlot => ({
  kind: "择时器", name, version,
  assess: () => ({ env: { gear: "中性", targetPosition: 0.4, reasons: [], factors: [], lowConfidenceFactors: [] } }),
});

const exit = (name: string, version = "1.0.0"): ExitSlot => ({
  kind: "离场器", name, version,
  decide: (_c, _p, pos) => ({
    code: pos.code, name: pos.code, action: "持有", account: pos.account,
    triggerPx: null, stopPx: null, size: 1, thesis: "", passedFilters: [], factors: [], score: 0,
  }),
});

describe("createSlotRegistry", () => {
  it("按 槽类型 + 实现名 取回", () => {
    const r = createSlotRegistry([timer("三档阈值")]);
    expect(r.get("择时器", "三档阈值")?.name).toBe("三档阈值");
    expect(r.get("择时器", "不存在")).toBeUndefined();
  });

  it("不同槽可以同名 —— 择时器和离场器都叫「默认」是正常的", () => {
    const r = createSlotRegistry([timer("默认"), exit("默认")]);
    expect(r.get("择时器", "默认")?.kind).toBe("择时器");
    expect(r.get("离场器", "默认")?.kind).toBe("离场器");
  });

  it("同槽重名直接抛错 —— 静默覆盖会让 lock 里写着一个版本、跑的是另一份实现", () => {
    const r = createSlotRegistry([timer("默认", "1.0.0")]);
    expect(() => r.register(timer("默认", "2.0.0"))).toThrow(/默认/);
  });

  it("list 按 槽类型 过滤，并按名字排序 —— 顺序不稳会让 lock 的字节序不稳", () => {
    const r = createSlotRegistry([timer("五段状态机"), timer("三档阈值"), exit("账户纪律")]);
    expect(r.list("择时器").map(s => s.name)).toEqual(["三档阈值", "五段状态机"]);
    expect(r.list().length).toBe(3);
  });

  it("排序是**码点序**不是汉语序 —— 与因子注册表同一套比较，别指望「甲乙丙」那个顺序", () => {
    // 乙 U+4E59 < 甲 U+7532。只要确定性成立就够了，lock 要的是可复现不是好看
    const r = createSlotRegistry([timer("甲"), timer("乙")]);
    expect(r.list("择时器").map(s => s.name)).toEqual(["乙", "甲"]);
  });

  it("lock 的键是 「槽类型:实现名」，且排序输出", () => {
    const r = createSlotRegistry([exit("丙", "2.1.0"), timer("甲", "1.0.0")]);
    const lock = r.lock();
    expect(Object.keys(lock)).toEqual(["择时器:甲", "离场器:丙"]);
    expect(lock["离场器:丙"]).toBe("2.1.0");
  });

  it("两次 lock 的键顺序一致 —— 策略包按字节做 sha256 校验，顺序抖动会假报失败", () => {
    const mk = () => createSlotRegistry([timer("乙"), exit("丙"), timer("甲")]).lock();
    expect(JSON.stringify(mk())).toBe(JSON.stringify(mk()));
  });
});
