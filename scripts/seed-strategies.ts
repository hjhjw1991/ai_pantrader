import { STRATEGIES_DIR_REL, seedFromExamples } from "@/lib/strategy/registry";

/**
 * 从 `<id>.yaml.example` 播种出本地策略实文件。
 *
 * 为什么策略实文件不进 git：`持仓:` 段的键就是**用户自己的账户 id**，那是个人数据。
 * 仓库只跟踪去个人化的 `.example`，实文件由这一步生成、并被 .gitignore 忽略。
 *
 * 幂等：已存在的实文件一律跳过，不覆盖、不合并 —— 那里面是攒下来的阈值和注释。
 * 所以 setup.mjs 每次都可以放心调它。
 */
const r = seedFromExamples();

if (r.created.length > 0) console.log(`已从模板创建策略：${r.created.join(" ")}`);
if (r.skipped.length > 0) console.log(`已存在、未覆盖：${r.skipped.join(" ")}`);
if (r.activeSet !== null) console.log(`ACTIVE 指针指向：${r.activeSet}`);
if (r.created.length === 0 && r.skipped.length === 0) {
  console.log(`${STRATEGIES_DIR_REL} 下没有 *.yaml.example 模板，未播种任何策略`);
}
