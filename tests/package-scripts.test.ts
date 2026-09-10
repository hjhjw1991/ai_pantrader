import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * pnpm 的内置命令**优先于**同名 script。踩中时没有任何报错：
 * `pnpm doctor` 跑的是 pnpm 自带的配置检查器，什么都不打印、退出码 0，
 * 看着像"体检全过"，其实 scripts/doctor.mjs 一次都没执行 —— 静默假通过。
 *
 * 这个仓库踩过两次（先是 import/export，后是 doctor），两次都是加完 script
 * 手敲一次觉得"没报错"就过了。所以钉一条测试，别再靠人眼。
 *
 * 名单取自 pnpm 10 的命令表。新版本可能加命令，这里只保证已知的那些不会重犯。
 */
const PNPM_BUILTINS = new Set([
  "add", "audit", "bin", "config", "create", "dedupe", "deploy", "dlx", "doctor",
  "env", "exec", "fetch", "import", "init", "install", "licenses", "link", "list",
  "ls", "outdated", "pack", "patch", "prune", "publish", "rebuild", "remove",
  "root", "run", "server", "setup", "store", "unlink", "update", "why",
]);

/**
 * npm 兼容的生命周期名是例外：pnpm 明确把它们转给 script，不会劫持。
 * 拿掉这几个，表里剩下的才是真会被吃掉的。
 */
const LIFECYCLE_PASSTHROUGH = new Set(["start", "test", "restart", "stop"]);

describe("package.json scripts", () => {
  const pkg = JSON.parse(
    readFileSync(resolve(__dirname, "../package.json"), "utf8")
  ) as { scripts: Record<string, string> };

  it("没有 script 名被 pnpm 内置命令遮蔽", () => {
    const shadowed = Object.keys(pkg.scripts).filter(
      (name) => PNPM_BUILTINS.has(name) && !LIFECYCLE_PASSTHROUGH.has(name)
    );
    expect(
      shadowed,
      `这些 script 敲 \`pnpm <名字>\` 时跑的是 pnpm 自己的命令（退出码 0，静默）：` +
        `${shadowed.join(", ")}。加前缀改名，参考 db:import / env:doctor`
    ).toEqual([]);
  });

  it("README 里出现的 pnpm 子命令都真的存在", () => {
    const names = new Set(Object.keys(pkg.scripts));
    for (const file of ["README.md", "README.en.md"]) {
      const md = readFileSync(resolve(__dirname, "..", file), "utf8");
      // 只看被反引号包起来的 `pnpm xxx`，避开正文里讲内置命令的那段说明
      const cited = [...md.matchAll(/`pnpm (?:run )?([a-z][\w:-]*)`/g)].map((m) => m[1]);
      const bogus = [...new Set(cited)].filter(
        (n) => !names.has(n) && !PNPM_BUILTINS.has(n)
      );
      expect(bogus, `${file} 引用了不存在的 script：${bogus.join(", ")}`).toEqual([]);
    }
  });
});
