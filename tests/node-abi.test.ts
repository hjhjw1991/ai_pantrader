import { describe, it, expect } from "vitest";
import { parseAbiMismatch, abiHint } from "@/lib/platform/node-abi";

/**
 * 这组测试盯的是**一次真实误诊的复发**。
 *
 * better-sqlite3 是原生模块，.node 绑死 NODE_MODULE_VERSION。用 Node 24 起网页、
 * 而 node_modules 是 Node 22 装的，dlopen 就失败，一路冒泡成"数据库打不开"。
 * 原始报错里其实写着两个 ABI 号，但没人背得住 127/137 对应哪个 Node 大版本，
 * 于是人转头去查路径和权限 —— 那两样从头到尾都是对的。
 *
 * 所以这里要的不是"把报错透出来"（lib/ui/db 已经在做），而是把 ABI 号翻译成
 * **下一步该敲什么命令**。
 */

// 真实报错原文（Node 24 加载 Node 22 装的 better-sqlite3）
const REAL = `The module '/repo/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 127. This version of Node.js requires
NODE_MODULE_VERSION 137. Please try re-compiling or re-installing
the module (for instance, using \`npm rebuild\` or \`npm install\`).`;

describe("parseAbiMismatch", () => {
  it("从真实报错里取出两个 ABI 号，并翻成 Node 大版本", () => {
    const m = parseAbiMismatch(REAL);
    expect(m).not.toBeNull();
    expect(m!.builtFor).toBe(127);
    expect(m!.required).toBe(137);
    expect(m!.builtForNode).toBe(22);
    expect(m!.requiredNode).toBe(24);
  });

  it("认不出的 ABI 号不猜 Node 版本，宁可给 null", () => {
    const m = parseAbiMismatch(REAL.replace("127", "999"));
    expect(m!.builtFor).toBe(999);
    expect(m!.builtForNode).toBeNull();
    // 另一半仍然认得，不该被带坏
    expect(m!.requiredNode).toBe(24);
  });

  it("与 ABI 无关的报错一律返回 null，不许硬套", () => {
    expect(parseAbiMismatch("SQLITE_CANTOPEN: unable to open database file")).toBeNull();
    expect(parseAbiMismatch("EACCES: permission denied")).toBeNull();
    expect(parseAbiMismatch("")).toBeNull();
  });
});

describe("abiHint", () => {
  it("给出的是可执行动作：换回哪个 Node 大版本", () => {
    const h = abiHint(REAL);
    expect(h).not.toBeNull();
    expect(h).toContain("Node 22");
    expect(h).toContain(".nvmrc");
  });

  it("必须劝阻 rebuild：重编会把计划任务里写死的旧 Node 反过来打挂", () => {
    const h = abiHint(REAL)!;
    expect(h).toContain("rebuild");
    expect(h).toMatch(/不要|别/);
  });

  it("非 ABI 故障不给 ABI 建议 —— 说错话比不说话更贵", () => {
    expect(abiHint("EACCES: permission denied")).toBeNull();
  });
});
