/**
 * 跑测试前先把策略实文件播种出来。
 *
 * 为什么需要这一步：策略实文件（`config/strategies/*.yaml`）**不进 git** ——
 * 它的 `持仓:` 段的键是用户自己的账户 id，属于个人数据。仓库只跟踪去个人化的
 * `.example`，实文件由 seed 生成并被 .gitignore 忽略。
 *
 * 于是在**干净克隆**上，两个测试拿不到可校验的对象：
 *   tests/strategy/loader.test.ts  —— "默认路径 = ACTIVE 指的那个，且真实存在"
 *   tests/strategy/schema.test.ts  —— "仓库里没有生效策略，schema 测试没有可校验的对象"
 *
 * 这个坑此前一直存在，只是本地开发机都先跑过 setup.mjs（它会调 seed），
 * 所以没人撞上。CI 第一次在干净检出上跑，六个平台全红。
 *
 * 放在 globalSetup 而不是让 CI 多跑一条命令：贡献者 clone 下来直接
 * `pnpm test` 也该是绿的 —— CONTRIBUTING 是这么承诺的，那就得让它成立。
 *
 * seedFromExamples 幂等：已存在的实文件一律跳过、不覆盖，所以重复跑无副作用，
 * 也不会动开发机上攒下来的阈值和注释。
 */
import { seedFromExamples } from "@/lib/strategy/registry";

export default function setup(): void {
  const r = seedFromExamples();
  if (r.created.length > 0) {
    console.log(`[test setup] 已从模板播种策略：${r.created.join(" ")}`);
  }
}
