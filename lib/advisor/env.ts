/**
 * 环境变量的宽松类型。
 *
 * 刻意不用 NodeJS.ProcessEnv：本仓的 Next 类型声明把 NODE_ENV 标成必填，
 * 于是每个传字面量对象的调用点（尤其是测试）都会被类型系统拦下来。
 * 顾问层只读 ADVISOR / ANTHROPIC_API_KEY / PATH 这几个 key，不该受那个约束。
 *
 * 单独成文件而不是放 index.ts：claude-api.ts 需要它，从 index 引会成环。
 */
export type EnvLike = Record<string, string | undefined>;
