/**
 * docs/ARCHITECTURE.md 是从代码反推的约束索引，它的价值全在"指得准"。
 * 代码改了路径而文档没跟上，这份文档就从导航变成误导 —— 比没有更糟。
 *
 * 所以把它引用的每个文件路径钉住。文档腐烂会在这里变红，不会等到
 * 某个贡献者照着它去找一个不存在的文件。
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const read = (f: string): string => readFileSync(resolve(ROOT, f), "utf8");

describe("docs/ARCHITECTURE.md", () => {
  const md = read("docs/ARCHITECTURE.md");

  it("引用的源文件都存在", () => {
    const cited = [
      ...md.matchAll(/`((?:lib|app|tests|components|scripts|config)\/[^`]+\.(?:ts|tsx|sql|mjs))`/g),
    ].map((m) => m[1]);
    expect(cited.length).toBeGreaterThan(40);

    const missing = [...new Set(cited)].filter((f) => !existsSync(resolve(ROOT, f)));
    expect(missing, `文档指向了不存在的文件：${missing.join(", ")}`).toEqual([]);
  });

  it("锚点内链都有对应标题", () => {
    const slug = (h: string): string =>
      h.trim().toLowerCase().replace(/[^\w一-鿿\- ]/g, "").replace(/ /g, "-");
    const anchors = new Set(
      [...md.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]))
    );
    const broken = [...md.matchAll(/\]\(#([^)]+)\)/g)]
      .map((m) => m[1])
      .filter((a) => !anchors.has(a));
    expect(broken, `失效内链：${broken.join(", ")}`).toEqual([]);
  });

  /**
   * 反过来的一半：代码里引用了 spec §N，文档就该收录 §N。
   * 新加一条 spec 引用而不写进文档，等于又造一条断链 —— 这正是本文档
   * 当初要解决的问题。
   */
  it("代码里引用的 spec 章节都收录在文档里", () => {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execSync(
      `grep -rhoE "spec §[0-9]+(\\.[0-9]+)?" lib app components tests config scripts || true`,
      { cwd: ROOT, encoding: "utf8" }
    );
    const sections = [...new Set(out.split("\n").filter(Boolean).map((s) => s.replace("spec §", "")))];
    expect(sections.length).toBeGreaterThan(15);

    const uncovered = sections.filter((s) => !md.includes(`§${s}`));
    expect(
      uncovered,
      `代码引用了这些 spec 章节但 docs/ARCHITECTURE.md 没收录：${uncovered.join(", ")}`
    ).toEqual([]);
  });
});
