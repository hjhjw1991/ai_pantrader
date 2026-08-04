import { z } from "zod";

/**
 * API 入参校验。
 *
 * 这些路由只监听 localhost，但"只有我自己用"不是不校验的理由：
 * 浏览器里任意页面都能对 127.0.0.1 发跨站请求，而这些路由能改观察池、
 * 能落成交记录。所以规矩是 —— **参数校验不过就拒绝，不做兜底猜测**，
 * 且任何值都只经绑定参数进 SQL，永不拼字符串。
 */

/** A股代码一律 6 位数字（含北交所 8xxxxx / 9xxxxx） */
export const CodeSchema = z.string().regex(/^\d{6}$/, "代码必须是 6 位数字");

export const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必须是 YYYY-MM-DD");

export const IsoTsSchema = z
  .string()
  .refine((s) => !Number.isNaN(new Date(s).getTime()), "时间戳无法解析");

export const AccountTypeSchema = z.enum(["贼王", "价值"]);

/** 一次最多问 200 只票的报价：再多就该走批量导出，不是页面查询 */
export const CodesQuerySchema = z
  .string()
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(CodeSchema).min(1).max(200));

export const PxSchema = z.number().positive().finite().max(100000);
export const QtySchema = z.number().positive().finite().max(1e9);

export const WatchpoolUpsertSchema = z.object({
  code: CodeSchema,
  name: z.string().max(32).optional(),
  account: AccountTypeSchema,
  /** 触发价与止损价都允许留空：想清楚之前先记下标的也是合理的 */
  triggerPx: PxSchema.nullable().optional(),
  stopPx: PxSchema.nullable().optional(),
  thesis: z.string().max(500).optional(),
});

export const WatchpoolDeleteSchema = z.object({ code: CodeSchema });

/**
 * 手工成交回填。**这不是下单**：它记录的是"我已经在券商 App 里成交了"这件事
 * （spec §12 ManualBroker）。所以必须带真实成交价与时间，不接受"按市价"。
 */
export const ManualFillSchema = z.object({
  accountId: z.string().min(1).max(64),
  code: CodeSchema,
  side: z.enum(["buy", "sell"]),
  px: PxSchema,
  qty: QtySchema,
  ts: IsoTsSchema.optional(),
  fee: z.number().min(0).finite().max(1e7).optional(),
  stopPx: PxSchema.nullable().optional(),
  thesis: z.string().max(500).optional(),
  predictionId: z.string().max(64).nullable().optional(),
});

export const AccountUpsertSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  type: AccountTypeSchema,
});

export const StrategyParamWriteSchema = z.object({
  /** 形如 "持仓.贼王账户.止损" */
  path: z.string().min(1).max(200).regex(/^[^\s]+$/, "参数路径不能含空格"),
  value: z.union([z.number(), z.string().max(200), z.boolean(), z.array(z.union([z.number(), z.string().max(64)]))]),
});

export const BacktestRunSchema = z.object({
  strategyId: z.string().min(1).max(64).optional(),
  strategyVersion: z.string().min(1).max(32).optional(),
  from: DateSchema,
  to: DateSchema,
  /**
   * 初始资金。必填且没有默认值 —— 它直接决定手数取整能不能成交、
   * 单票占比算出来是多少。给个默认值等于替用户假设了账户规模。
   */
  initialCash: z.number().positive().finite().max(1e12),
});

/** 导出只接受文件名，不接受路径 —— 目录固定在 dataDir 下，避免写到库外任意位置 */
export const ExportSchema = z.object({
  fileName: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9._-]+\.ptbak$/, "文件名只能是 [A-Za-z0-9._-] 且以 .ptbak 结尾")
    .optional(),
});

export const ImportDryRunSchema = z.object({
  bakPath: z.string().min(1).max(1000).endsWith(".ptbak", "只接受 .ptbak 文件"),
});

export const LimitSchema = z.coerce.number().int().min(1).max(1000);

export interface BadRequest {
  error: string;
  issues?: unknown;
}

/** 统一的 400 载荷。把 zod 的 issue 原样带出去，改参数时不用猜哪一项不合法 */
export function badRequest(msg: string, issues?: unknown): BadRequest {
  return { error: msg, issues };
}
