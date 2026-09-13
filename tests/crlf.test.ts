/**
 * CRLF 回归：Windows 上 CI 六个平台里有两个红，根因全在这里。
 *
 * `.gitattributes` 现在强制以 LF 检出，所以仓库内的文件不会再是 CRLF。
 * 但**用户的文件**和**网络响应**不归 git 管：
 *   - 策略 YAML 用户可能拿 Windows 编辑器存过
 *   - HTTP 响应用 CRLF 完全合法
 *
 * 这类失败极难认，因为代码看着没问题：
 *   /^id\s*:.*$/  在 "id: default\r" 上**匹配不上** ——
 *   JS 的 `.` 不匹配 \r，而 `$`（无 m 标志）只匹配串尾。
 *   于是 replace 静默什么都不做，新建的策略 id 没被改。
 */
import { describe, it, expect } from "vitest";
import { rewriteIdLine } from "@/lib/strategy/registry";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseGtimg } from "@/lib/data/sources/tencent";

const here = path.dirname(fileURLToPath(import.meta.url));
// 用仓库里真实的响应样本，不自造 —— 自造的样本一旦字段数写错，
// 测的就只是"我编的字符串解析不了"，而不是 CRLF 容忍度
const GTIMG = fs.readFileSync(path.join(here, "fixtures/gtimg.txt"), "utf8");

describe("CRLF 输入", () => {
  it("rewriteIdLine 在 CRLF 源上真的改掉 id，并保留 \\r 行尾", () => {
    const src = "# 注释\r\nid: default\r\nversion: 1.0.0\r\n";
    const out = rewriteIdLine(src, "v2");

    expect(out).toContain("id: v2\r\n");
    expect(out).not.toContain("id: default");
    // 其余字节不动 —— 包括换行风格
    expect(out).toContain("# 注释\r\n");
    expect(out).toContain("version: 1.0.0\r\n");
  });

  it("rewriteIdLine 在 LF 源上不引入 \\r", () => {
    const out = rewriteIdLine("id: default\nversion: 1.0.0\n", "v2");
    expect(out).toBe("id: v2\nversion: 1.0.0\n");
  });

  it("gtimg 解析吃得下 CRLF 响应", () => {
    const lf = GTIMG.replace(/\r\n/g, "\n");
    const crlf = lf.replace(/\n/g, "\r\n");

    const a = parseGtimg(lf);
    const b = parseGtimg(crlf);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBe(a.length);
    expect(b).toEqual(a);
  });
});
