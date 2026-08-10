import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stampOf, backupFile, listBackups } from "@/lib/backup/strategy-file";

/**
 * 原文编辑器的服务端半边。
 *
 * 盯的是"落盘前的每一道闸都真的会拦"：id 分叉、并发覆盖、校验不过、备份失败。
 * 这些闸门里任何一道形同虚设，一次全文保存就能把唯一真相源（以及它的注释）弄坏。
 *
 * 用 PANTRADER_CONFIG_ROOT / PANTRADER_DATA_DIR 把策略目录与备份目录都指到临时目录，
 * 测的是真实读写，不 mock 文件系统。
 */

let dir: string;
let cfgRoot: string;
let dataDir: string;
let realYaml: string;
const savedEnv = { cfg: process.env.PANTRADER_CONFIG_ROOT, data: process.env.PANTRADER_DATA_DIR };

/**
 * 仓库里那份真实策略当夹具：它是唯一能保证通过全部跨字段校验的样本。
 * 读 `.example` —— 实文件已 gitignore（`持仓:` 段键名是用户的账户 id），新克隆下来只有模板。
 * 临时目录里写出的文件仍叫 `default.yaml`，因为那测的是**实文件**的读写语义。
 */
const REAL = path.resolve(__dirname, "..", "..", "config", "strategies", "default.yaml.example");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-raw-"));
  cfgRoot = path.join(dir, "root");
  dataDir = path.join(dir, "data");
  fs.mkdirSync(path.join(cfgRoot, "config", "strategies"), { recursive: true });
  realYaml = fs.readFileSync(REAL, "utf8");
  fs.writeFileSync(path.join(cfgRoot, "config", "strategies", "default.yaml"), realYaml);
  fs.writeFileSync(path.join(cfgRoot, "config", "strategies", "ACTIVE"), "default\n");
  process.env.PANTRADER_CONFIG_ROOT = cfgRoot;
  process.env.PANTRADER_DATA_DIR = dataDir;
});

afterEach(() => {
  if (savedEnv.cfg === undefined) delete process.env.PANTRADER_CONFIG_ROOT;
  else process.env.PANTRADER_CONFIG_ROOT = savedEnv.cfg;
  if (savedEnv.data === undefined) delete process.env.PANTRADER_DATA_DIR;
  else process.env.PANTRADER_DATA_DIR = savedEnv.data;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** adapters 在模块级读 registry 的路径函数，但都是调用时求值，动态 import 即可拿到新 env */
async function mod() {
  return await import("@/lib/ui/adapters/strategy");
}

describe("备份原语", () => {
  it("时间戳后缀是本地时间 YYYYMMDD-HHmmss，字典序即时间序", () => {
    expect(stampOf(new Date(2026, 7, 10, 13, 45, 6))).toBe("20260810-134506");
    expect(stampOf(new Date(2026, 11, 1, 9, 0, 0))).toBe("20261201-090000");
    expect(stampOf(new Date(2026, 7, 10, 13, 45, 6)) < stampOf(new Date(2026, 7, 10, 13, 45, 7))).toBe(true);
  });

  it("文件名 = 原名 + . + 时间戳，内容逐字节相同", () => {
    const src = path.join(dir, "x.yaml");
    fs.writeFileSync(src, "a: 1\n# 注释\n");
    const bak = path.join(dir, "baks");
    const r = backupFile(src, bak, new Date(2026, 7, 10, 13, 45, 6));
    expect(path.basename(r.path)).toBe("x.yaml.20260810-134506");
    expect(fs.readFileSync(r.path, "utf8")).toBe("a: 1\n# 注释\n");
  });

  it("同一秒内第二次备份不覆盖第一份，往后加 -2", () => {
    const src = path.join(dir, "x.yaml");
    const bak = path.join(dir, "baks");
    const now = new Date(2026, 7, 10, 13, 45, 6);
    fs.writeFileSync(src, "first\n");
    const a = backupFile(src, bak, now);
    fs.writeFileSync(src, "second\n");
    const b = backupFile(src, bak, now);
    expect(path.basename(b.path)).toBe("x.yaml.20260810-134506-2");
    // 第一份必须还在，且还是第一份的内容 —— 这个函数存在的唯一理由就是别吃掉原文
    expect(fs.readFileSync(a.path, "utf8")).toBe("first\n");
    expect(listBackups(bak, "x.yaml").length).toBe(2);
  });

  it("listBackups 最新在前", () => {
    const src = path.join(dir, "x.yaml");
    const bak = path.join(dir, "baks");
    fs.writeFileSync(src, "v\n");
    backupFile(src, bak, new Date(2026, 7, 10, 10, 0, 0));
    backupFile(src, bak, new Date(2026, 7, 10, 11, 0, 0));
    expect(listBackups(bak, "x.yaml").map((b) => b.name)).toEqual([
      "x.yaml.20260810-110000",
      "x.yaml.20260810-100000",
    ]);
  });
});

describe("writeStrategyRaw 的闸门", () => {
  it("正常保存：落盘 + 留下带时间戳的备份，备份是改动前的原文", async () => {
    const { writeStrategyRaw, readStrategyRawById, rawHash } = await mod();
    const before = readStrategyRawById("default");
    if ("error" in before) throw new Error(before.error);

    const edited = `${realYaml}\n# 新加一行注释\n`;
    const r = writeStrategyRaw("default", edited, before.hash, { now: new Date(2026, 7, 10, 13, 45, 6) });
    expect(r.ok).toBe(true);
    expect(path.basename(r.backupPath ?? "")).toBe("default.yaml.20260810-134506");
    expect(fs.readFileSync(before.filePath, "utf8")).toBe(edited);
    expect(fs.readFileSync(r.backupPath ?? "", "utf8")).toBe(realYaml);
    expect(r.hash).toBe(rawHash(edited));
  });

  it("baseHash 对不上 → conflict，且磁盘原文一个字节都没动", async () => {
    const { writeStrategyRaw } = await mod();
    const p = path.join(cfgRoot, "config", "strategies", "default.yaml");
    const r = writeStrategyRaw("default", `${realYaml}\n# x\n`, "0".repeat(16));
    expect(r.ok).toBe(false);
    expect(r.conflict).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toBe(realYaml);
    expect(fs.existsSync(path.join(dataDir, "strategy-backups"))).toBe(false);
  });

  it("校验不过 → 带 issues 返回，不落盘也不备份", async () => {
    const { writeStrategyRaw, readStrategyRawById } = await mod();
    const before = readStrategyRawById("default");
    if ("error" in before) throw new Error(before.error);
    // 仓位档位是 0..1 的比例，5 必然越界
    const bad = realYaml.replace(/进攻:\s*[\d.]+/, "进攻: 5");
    expect(bad).not.toBe(realYaml);
    const r = writeStrategyRaw("default", bad, before.hash);
    expect(r.ok).toBe(false);
    expect(Array.isArray(r.issues)).toBe(true);
    expect(fs.readFileSync(before.filePath, "utf8")).toBe(realYaml);
    expect(fs.existsSync(path.join(dataDir, "strategy-backups"))).toBe(false);
  });

  it("正文 id 与文件名分叉 → 拒绝（否则「在跑哪个策略」说不清）", async () => {
    const { writeStrategyRaw, readStrategyRawById } = await mod();
    const before = readStrategyRawById("default");
    if ("error" in before) throw new Error(before.error);
    const renamed = realYaml.replace(/^id:.*$/m, "id: aggressive");
    const r = writeStrategyRaw("default", renamed, before.hash);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("与文件名 default 不一致");
    expect(fs.readFileSync(before.filePath, "utf8")).toBe(realYaml);
  });

  it("dryRun：校验通过但不写、不备份，并告知备份将落在哪", async () => {
    const { writeStrategyRaw, readStrategyRawById } = await mod();
    const before = readStrategyRawById("default");
    if ("error" in before) throw new Error(before.error);
    const edited = `${realYaml}\n# dry\n`;
    const r = writeStrategyRaw("default", edited, before.hash, {
      dryRun: true,
      now: new Date(2026, 7, 10, 13, 45, 6),
    });
    expect(r.ok).toBe(true);
    expect(path.basename(r.backupPath ?? "")).toBe("default.yaml.20260810-134506");
    expect(fs.readFileSync(before.filePath, "utf8")).toBe(realYaml);
    expect(fs.existsSync(path.join(dataDir, "strategy-backups"))).toBe(false);
  });

  it("不存在的策略 / 非法 id → 拒绝，不建任何文件", async () => {
    const { writeStrategyRaw } = await mod();
    expect(writeStrategyRaw("nope", realYaml, "0".repeat(16)).ok).toBe(false);
    expect(writeStrategyRaw("../escape", realYaml, "0".repeat(16)).ok).toBe(false);
    expect(fs.existsSync(path.join(cfgRoot, "config", "strategies", "nope.yaml"))).toBe(false);
  });

  it("readStrategyRawById 对校验不过的文件也要能读 —— 那时才最需要打开它改", async () => {
    const { readStrategyRawById } = await mod();
    const p = path.join(cfgRoot, "config", "strategies", "broken.yaml");
    fs.writeFileSync(p, "id: broken\nversion: 不是语义化版本\n");
    const r = readStrategyRawById("broken");
    if ("error" in r) throw new Error(r.error);
    expect(r.raw).toContain("不是语义化版本");
  });
});
