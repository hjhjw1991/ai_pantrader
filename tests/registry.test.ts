import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";

/**
 * registry 默认用 import.meta.url 推项目根，测试里不能真去改仓库的 config/。
 * 用 PANTRADER_CONFIG_ROOT 把它整体指到临时目录 —— 挪的只是**目录位置**，
 * 判断逻辑一行没被替换，测到的是真实的读写与拒绝规则。
 */
let dir: string, db: any;

/**
 * 夹具直接用仓库里那份真策略，不手写简化版 ——
 * 手写的夹具只要漏一个必填字段就测不到真实路径，而且会随 schema 演进悄悄失效。
 * 用真文件还顺带守住一条：**随源码发布的默认策略必须校验通过**。
 *
 * 指的是 `.yaml.example` 而不是 `.yaml`：实文件已被 .gitignore 忽略（里面有用户的账户 id），
 * 新克隆下来只有模板。而"随源码发布的那份"现在正是模板，所以这里指它才名副其实。
 */
const REAL_DEFAULT = path.resolve(process.cwd(), "config/strategies/default.yaml.example");
const BASE = fs.readFileSync(REAL_DEFAULT, "utf8");

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-reg-"));
  process.env.PANTRADER_CONFIG_ROOT = dir;
  fs.mkdirSync(path.join(dir, "config", "strategies"), { recursive: true });
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.PANTRADER_CONFIG_ROOT;
});

const reg = () => import("@/lib/strategy/registry");
/** 删除与快照在 ledger 层：lib/strategy 的纯度断言不许它碰存储 */
const snap = () => import("@/lib/ledger/strategy-snapshot");
const write = (id: string, text = BASE) =>
  fs.writeFileSync(path.join(dir, "config", "strategies", `${id}.yaml`),
                   text.replace(/^id: .*$/m, `id: ${id}`), "utf8");
const readFile = (id: string) =>
  fs.readFileSync(path.join(dir, "config", "strategies", `${id}.yaml`), "utf8");
const commentLines = (t: string) => t.split("\n").filter(l => l.trim().startsWith("#")).length;

describe("策略 id 安全", () => {
  it("挡住路径穿越 —— id 直接拼进文件名", async () => {
    const { assertSafeId } = await reg();
    for (const bad of ["../../etc/passwd", "a/b", "..", "", " x", "a".repeat(65), "/abs"]) {
      expect(() => assertSafeId(bad), `应拒绝 ${JSON.stringify(bad)}`).toThrow();
    }
  });

  it("不许叫 ACTIVE —— 那是指针文件", async () => {
    const { assertSafeId, ACTIVE_POINTER } = await reg();
    expect(() => assertSafeId(ACTIVE_POINTER)).toThrow(/指针文件/);
  });

  it("放过正常 id", async () => {
    const { assertSafeId } = await reg();
    for (const good of ["default", "aggressive-v2", "a.b_c", "S1"]) {
      expect(() => assertSafeId(good)).not.toThrow();
    }
  });
});

describe("列出与 active 指针", () => {
  it("列出目录下全部 .yaml", async () => {
    write("default"); write("aggressive");
    const { listStrategies } = await reg();
    expect(listStrategies().map(s => s.id)).toEqual(["aggressive", "default"]);
  });

  it("只有一个策略时不需要指针也能定 active", async () => {
    write("only");
    const { activeStrategyId } = await reg();
    expect(activeStrategyId()).toBe("only");
  });

  it("多个策略且没有指针 → active 为 null（未决），不猜", async () => {
    write("a"); write("b");
    const { activeStrategyId } = await reg();
    // 猜一个的后果是界面显示 A、引擎按 B 出信号，且没人发现
    expect(activeStrategyId()).toBeNull();
  });

  it("指针指向不存在的文件时视为未设置，不报错", async () => {
    write("a");
    fs.writeFileSync(path.join(dir, "config", "strategies", "ACTIVE"), "ghost\n");
    const { activeStrategyId } = await reg();
    expect(activeStrategyId()).toBe("a");   // 退回"只有一个"的规则
  });

  it("校验不过的策略照样列出来，标 valid=false", async () => {
    write("ok");
    fs.writeFileSync(path.join(dir, "config", "strategies", "broken.yaml"), "id: broken\n:::bad", "utf8");
    const { listStrategies } = await reg();
    const rows = listStrategies();
    expect(rows.find(s => s.id === "broken")!.valid).toBe(false);
    // 藏起来用户就不知道该去修哪个文件
    expect(rows.map(s => s.id)).toContain("broken");
  });
});

describe("新建策略", () => {
  it("复制原文，注释一个字节不动 —— 那些注释记着阈值的由来", async () => {
    write("default");
    const { createStrategy } = await reg();
    createStrategy("aggressive", "default");
    const src = readFile("default"), out = readFile("aggressive");
    expect(commentLines(out)).toBe(commentLines(src));
    // 真文件的第一行就是注释；复制后必须还在
    expect(out.split("\n")[0]).toBe(src.split("\n")[0]);
    expect(out.split("\n")[0].startsWith("#")).toBe(true);
    // 除了 id 行，其余每一行都相同
    const a = src.split("\n").filter(l => !/^id\s*:/.test(l));
    const b = out.split("\n").filter(l => !/^id\s*:/.test(l));
    expect(b).toEqual(a);
  });

  it("id 行被改成新 id", async () => {
    write("default");
    const { createStrategy } = await reg();
    createStrategy("v2", "default");
    expect(readFile("v2")).toMatch(/^id: v2$/m);
  });

  it("不改变当前生效的策略 —— 新建不等于切换", async () => {
    write("default");
    const { createStrategy, setActiveStrategy, activeStrategyId } = await reg();
    setActiveStrategy("default");
    createStrategy("v2", "default");
    expect(activeStrategyId()).toBe("default");
  });

  it("重名拒绝", async () => {
    write("default"); write("v2");
    const { createStrategy } = await reg();
    expect(() => createStrategy("v2", "default")).toThrow(/已存在/);
  });

  it("源里没有顶层 id 行时拒绝改写，不退化成整份 dump", async () => {
    const { rewriteIdLine } = await reg();
    expect(() => rewriteIdLine("择时:\n  仓位档位: {}\n", "x")).toThrow(/找不到顶层/);
  });

  it("只认顶层 id，不动嵌套里的同名键", async () => {
    const { rewriteIdLine } = await reg();
    const src = "id: old\n持仓:\n  主账户:\n    id: inner\n";
    const out = rewriteIdLine(src, "new");
    expect(out).toContain("id: new");
    expect(out).toContain("    id: inner");
  });
});

describe("切换生效策略", () => {
  it("写指针文件", async () => {
    write("a"); write("b");
    const { setActiveStrategy, activeStrategyId } = await reg();
    setActiveStrategy("b");
    expect(activeStrategyId()).toBe("b");
    expect(fs.readFileSync(path.join(dir, "config", "strategies", "ACTIVE"), "utf8").trim()).toBe("b");
  });

  it("拒绝切到校验不过的策略 —— 那等于让系统立刻停止出信号", async () => {
    write("ok");
    fs.writeFileSync(path.join(dir, "config", "strategies", "broken.yaml"), "id: broken\nversion: 1.0.0\n", "utf8");
    const { setActiveStrategy } = await reg();
    expect(() => setActiveStrategy("broken")).toThrow(/校验失败/);
  });

  it("拒绝切到不存在的策略", async () => {
    write("a");
    const { setActiveStrategy } = await reg();
    expect(() => setActiveStrategy("ghost")).toThrow(/不存在/);
  });
});

describe("删除策略", () => {
  it("正在跑的不能删 —— 删了系统直接读不出配置", async () => {
    write("a"); write("b");
    const { setActiveStrategy } = await reg();
    const { deleteStrategy } = await snap();
    setActiveStrategy("a");
    expect(() => deleteStrategy(db, "a")).toThrow(/正在使用中/);
  });

  it("最后一个不能删 —— 删完系统就没有参数了", async () => {
    write("only");
    const { deleteStrategy } = await snap();
    // 唯一一个必然也是 active，两条拒绝都该拦住它
    expect(() => deleteStrategy(db, "only")).toThrow();
  });

  it("没有预测引用 → 物理删，不留空壳", async () => {
    write("a"); write("b");
    const { setActiveStrategy, listStrategies } = await reg();
    const { deleteStrategy } = await snap();
    setActiveStrategy("a");
    const r = deleteStrategy(db, "b");
    expect(r.fileRemoved).toBe(true);
    expect(r.predictions).toBe(0);
    expect(r.snapshotted).toBe(0);
    expect(listStrategies().map(s => s.id)).toEqual(["a"]);
  });

  it("有预测引用 → 先把原文快照进 strategy 表再删文件，归因不丢", async () => {
    write("a"); write("keeper");
    const { setActiveStrategy } = await reg();
    const { deleteStrategy } = await snap();
    setActiveStrategy("a");
    db.prepare(
      `INSERT INTO prediction (id,ts,phase,code,strategy_id,action,eval_horizon,valid_until,advisor_influenced)
       VALUES ('p1','2026-08-05 09:40:00.000','preopen','600519','keeper','买入',5,'2026-08-12',0)`
    ).run();

    const r = deleteStrategy(db, "keeper");
    expect(r.predictions).toBe(1);
    expect(r.snapshotted).toBe(1);
    const row = db.prepare("SELECT id, version, yaml FROM strategy WHERE id='keeper'").get();
    expect(row.version).toBe("1.0.0");
    // 快照必须带注释：它是"这条预测依据的参数集"的唯一副本
    expect(commentLines(row.yaml)).toBeGreaterThan(0);
    // 文件删了，但 prediction 仍解释得清
    expect(fs.existsSync(path.join(dir, "config", "strategies", "keeper.yaml"))).toBe(false);
    expect(db.prepare("SELECT strategy_id FROM prediction WHERE id='p1'").get().strategy_id)
      .toBe("keeper");
  });
});

describe("快照", () => {
  it("同 (id, version) 只留第一份 —— 允许改写就不是快照了", async () => {
    const { snapshotStrategy, hasSnapshot } = await snap();
    expect(snapshotStrategy(db, { id: "s", version: "1.0.0", yaml: "第一版" })).toBe(true);
    expect(snapshotStrategy(db, { id: "s", version: "1.0.0", yaml: "改过的" })).toBe(false);
    expect(db.prepare("SELECT yaml FROM strategy WHERE id='s'").get().yaml).toBe("第一版");
    expect(hasSnapshot(db, "s", "1.0.0")).toBe(true);
    expect(hasSnapshot(db, "s", "2.0.0")).toBe(false);
  });
});

describe("老单文件兼容", () => {
  it("只有 config/strategy.yaml 时也认，id 记为 default", async () => {
    fs.rmSync(path.join(dir, "config", "strategies"), { recursive: true, force: true });
    fs.writeFileSync(path.join(dir, "config", "strategy.yaml"),
                     BASE.replace(/^id: .*$/m, "id: default"), "utf8");
    const { listStrategies, activeStrategyId } = await reg();
    expect(listStrategies().map(s => s.id)).toEqual(["default"]);
    expect(activeStrategyId()).toBe("default");
  });

  it("migrateLegacy 把它搬进 strategies/ 并写好指针", async () => {
    fs.rmSync(path.join(dir, "config", "strategies"), { recursive: true, force: true });
    fs.writeFileSync(path.join(dir, "config", "strategy.yaml"),
                     BASE.replace(/^id: .*$/m, "id: default"), "utf8");
    const { migrateLegacy, activeStrategyId } = await reg();
    const r = migrateLegacy();
    expect(r.moved).toBe(true);
    expect(fs.existsSync(path.join(dir, "config", "strategy.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "config", "strategies", "default.yaml"))).toBe(true);
    expect(activeStrategyId()).toBe("default");
  });

  it("目标已存在时不搬 —— 不覆盖用户已有的 default", async () => {
    write("default", `# 用户已有的这份不能被覆盖\n${BASE}`);
    fs.writeFileSync(path.join(dir, "config", "strategy.yaml"), "id: default\n老的", "utf8");
    const { migrateLegacy } = await reg();
    expect(migrateLegacy().moved).toBe(false);
    expect(readFile("default")).toContain("# 用户已有的这份不能被覆盖");
  });
});

/**
 * 播种：`<id>.yaml.example` → `<id>.yaml`。
 *
 * 存在的理由是实文件被 gitignore（`持仓:` 段键名 = 用户账户 id = 个人数据），
 * 新克隆下来一个策略都没有 = 系统没有参数。这组测试守两件事：
 * 播种真能让空目录变可用，以及**已有实文件绝不被模板覆盖**（那里面是攒下来的阈值与注释）。
 */
describe("seedFromExamples", () => {
  const writeExample = (id: string, text = BASE) =>
    fs.writeFileSync(path.join(dir, "config", "strategies", `${id}.yaml.example`), text, "utf8");

  it("空目录 + 一个模板 → 建出实文件并写好 ACTIVE 指针", async () => {
    writeExample("default");
    const { seedFromExamples, listStrategies, activeStrategyId } = await reg();
    const r = seedFromExamples();
    expect(r.created).toEqual(["default"]);
    expect(r.skipped).toEqual([]);
    expect(r.activeSet).toBe("default");
    expect(listStrategies().map((s) => s.id)).toEqual(["default"]);
    expect(activeStrategyId()).toBe("default");
  });

  it("实文件内容与模板逐字节相同（注释一并带过来）", async () => {
    writeExample("default");
    const { seedFromExamples } = await reg();
    seedFromExamples();
    expect(readFile("default")).toBe(BASE);
  });

  it("实文件已存在 → 跳过，绝不覆盖用户改过的阈值", async () => {
    writeExample("default");
    write("default", `# 我自己改的，不许被模板盖掉\n${BASE}`);
    const { seedFromExamples } = await reg();
    const r = seedFromExamples();
    expect(r.created).toEqual([]);
    expect(r.skipped).toEqual(["default"]);
    expect(readFile("default")).toContain("# 我自己改的，不许被模板盖掉");
  });

  it("幂等：连跑两次，第二次全是 skipped", async () => {
    writeExample("default");
    const { seedFromExamples } = await reg();
    expect(seedFromExamples().created).toEqual(["default"]);
    expect(seedFromExamples()).toMatchObject({ created: [], skipped: ["default"] });
  });

  it("多个模板都播种；但多策略且无指针时不替用户猜 active", async () => {
    writeExample("default");
    writeExample("aggressive", BASE.replace(/^id: .*$/m, "id: aggressive"));
    const { seedFromExamples, activeStrategyId } = await reg();
    const r = seedFromExamples();
    expect(r.created.sort()).toEqual(["aggressive", "default"]);
    // 两个策略、没有指针 = 未决状态，必须让用户自己选（界面会红字要求选一个）
    expect(r.activeSet).toBeNull();
    expect(activeStrategyId()).toBeNull();
  });

  it("已有指针时不动它", async () => {
    writeExample("default");
    write("keep", BASE.replace(/^id: .*$/m, "id: keep"));
    const { setActiveStrategy, seedFromExamples, activeStrategyId } = await reg();
    setActiveStrategy("keep");
    const r = seedFromExamples();
    expect(r.created).toEqual(["default"]);
    expect(r.activeSet).toBeNull();
    expect(activeStrategyId()).toBe("keep");
  });

  it("没有任何模板 → 什么都不做，不抛错", async () => {
    const { seedFromExamples } = await reg();
    expect(seedFromExamples()).toEqual({ created: [], skipped: [], activeSet: null });
  });

  it("模板名当 id 非法时跳过该模板，不让一个坏文件毁掉整次播种", async () => {
    writeExample("default");
    fs.writeFileSync(path.join(dir, "config", "strategies", "..evil.yaml.example"), BASE, "utf8");
    const { seedFromExamples } = await reg();
    expect(seedFromExamples().created).toEqual(["default"]);
  });
});
