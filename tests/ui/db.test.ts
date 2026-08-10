import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { openRead, readDb, dbUnavailable } from "@/lib/ui/db";

/**
 * 这组测试盯的是**故障文案说不说真话**。
 *
 * 起因是一次真实误诊：Node 大版本升过之后 better-sqlite3 的 .node 还是旧 ABI，
 * 构造函数抛 ERR_DLOPEN_FAILED，被 readDb 里的 catch 压成 null，界面照着 null
 * 显示"数据库不存在"，而库文件一直好好躺在那条路径上。
 * 所以"文件不在"和"文件在但打不开"必须是两种可区分的返回。
 */

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-uidb-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("ui/db 接不上库时的原因区分", () => {
  it("文件不存在 → kind=missing，并带上探测过的路径", () => {
    const p = path.join(dir, "nope.db");
    const r = openRead(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why.kind).toBe("missing");
    expect(r.why.path).toBe(p);
  });

  it("路径存在但打不开 → kind=unopenable，且带原始报错", () => {
    // 用目录占住路径：existsSync 为真而构造函数必抛，等价于 ABI 不匹配那类"文件在、连不上"
    const p = path.join(dir, "as-a-dir.db");
    fs.mkdirSync(p);
    const r = openRead(p);
    expect(r.ok).toBe(false);
    if (r.ok || r.why.kind !== "unopenable") throw new Error("应判为 unopenable");
    expect(r.why.path).toBe(p);
    // detail 必须非空：它是唯一能把人指向真原因（ABI/权限/损坏）的线索
    expect(r.why.detail.length).toBeGreaterThan(0);
  });

  it("内容是垃圾的文件能打开成功 —— 记住这个陷阱：openRead 通过≠库可用", () => {
    // sqlite 惰性打开，坏内容要到第一次查询才暴露。所以 openRead 只负责"连得上"，
    // 库内容坏不坏由各查询自己的 try/catch 兜（appliedMigrations 就是这么写的）。
    const p = path.join(dir, "garbage.db");
    fs.writeFileSync(p, "这不是 sqlite 文件");
    const r = openRead(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(() => r.db.prepare("SELECT 1 FROM sqlite_master").all()).toThrow(/not a database/i);
  });

  it("正常库 → openRead 成功，readDb 返回同一个连接（走缓存）", () => {
    const p = path.join(dir, "ok.db");
    openDb(p).close();
    const r = openRead(p);
    expect(r.ok).toBe(true);
    expect(readDb(p)).toBe(r.ok ? r.db : null);
  });

  it("dbUnavailable 重新探测，不缓存过期的失败原因", () => {
    const p = path.join(dir, "later.db");
    expect(dbUnavailable(p).kind).toBe("missing");
    openDb(p).close();
    // 修好之后再问，不该还咬定 missing
    expect(dbUnavailable(p).kind).not.toBe("missing");
  });
});
