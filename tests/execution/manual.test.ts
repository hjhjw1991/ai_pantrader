import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createBroker, ManualBroker } from "@/lib/execution";
import { upsertAccount } from "@/lib/ui/mutations";
import { makeTempDb, type TempDb } from "../pit/helpers";

let t: TempDb;
let b: ManualBroker;
beforeEach(() => {
  t = makeTempDb();
  upsertAccount(t.db, { id: "zw", name: "卫星", type: "卫星" });
  b = new ManualBroker(t.db);
});
afterEach(() => t.close());

const pos = () => t.db.prepare("SELECT qty, cost FROM position WHERE account_id = 'zw' AND code = '600468'").get() as any;

describe("ManualBroker", () => {
  it("submit 只开一张待手敲的下单单，不动持仓", async () => {
    const o = await b.submit({ account: "zw", code: "600468", side: "buy", px: 10, qty: 1000 });
    expect(o.status).toBe("pending");
    expect(b.openOrders().map(x => x.id)).toEqual([o.id]);
    expect(pos()).toBeUndefined();
  });

  it("分两次回填：先 partial 再 filled；成交挂在单子上，持仓按加权成本推", async () => {
    const o = await b.submit({ account: "zw", code: "600468", side: "buy", px: 10, qty: 1000 });
    await b.confirmManualFill(o.id, { ts: "2026-09-24 10:00:00", px: 10, qty: 400, fee: 2 });
    expect(b.openOrders()[0].status).toBe("partial");
    await b.confirmManualFill(o.id, { ts: "2026-09-24 10:05:00", px: 10.1, qty: 600, fee: 3 });
    expect(b.openOrders()).toEqual([]);
    expect(pos().qty).toBe(1000);
    expect(pos().cost).toBeCloseTo((4000 + 6060 + 5) / 1000, 6);
    const fills = await b.fills("2026-09-24", "2026-09-25");
    expect(fills.map(f => f.orderId)).toEqual([o.id, o.id]);
  });

  it("超量回填、给已成交的单回填、撤已成交的单都拒绝", async () => {
    const o = await b.submit({ account: "zw", code: "600468", side: "buy", px: 10, qty: 100 });
    await expect(b.confirmManualFill(o.id, { ts: "2026-09-24 10:00:00", px: 10, qty: 200, fee: 0 })).rejects.toThrow(/超过剩余/);
    await b.confirmManualFill(o.id, { ts: "2026-09-24 10:00:00", px: 10, qty: 100, fee: 0 });
    await expect(b.confirmManualFill(o.id, { ts: "2026-09-24 10:01:00", px: 10, qty: 100, fee: 0 })).rejects.toThrow(/filled/);
    await expect(b.cancel(o.id)).rejects.toThrow(/已成交/);
  });

  it("下单单要校验：非 100 股整数倍、非正价、账户不存在都拒绝", async () => {
    await expect(b.submit({ account: "zw", code: "600468", side: "buy", px: 10, qty: 150 })).rejects.toThrow(/100 股/);
    await expect(b.submit({ account: "zw", code: "600468", side: "buy", px: 0, qty: 100 })).rejects.toThrow(/限价/);
    await expect(b.submit({ account: "nope", code: "600468", side: "buy", px: 10, qty: 100 })).rejects.toThrow(/账户不存在/);
  });

  it("撤单：pending 可撤，撤后不在待手敲列表里", async () => {
    const o = await b.submit({ account: "zw", code: "600468", side: "sell", px: 10, qty: 100 });
    await b.cancel(o.id);
    expect(b.openOrders()).toEqual([]);
  });
});

describe("createBroker", () => {
  it("manual 是真的；paper 未实现直接抛错；live 是占位，任何调用都拒绝 —— 都不许悄悄降级成 manual", async () => {
    expect(createBroker(t.db, "manual").mode).toBe("manual");
    expect(() => createBroker(t.db, "paper")).toThrow(/paper/);
    const live = createBroker(t.db, "live");
    await expect(live.submit({ account: "zw", code: "600468", side: "buy", px: 10, qty: 100 })).rejects.toThrow(/live 模式未开放/);
    await expect(live.positions()).rejects.toThrow(/live/);
  });
});
