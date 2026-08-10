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

// 账户名由用户定义，不做白名单校验；只挡空串与超长输入
export const AccountTypeSchema = z.string().trim().min(1).max(40);

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

export const AccountActiveSchema = z.object({
  id: z.string().min(1).max(64),
  active: z.boolean(),
});

/**
 * 策略 id 会直接拼成文件名（config/strategies/<id>.yaml），
 * 所以这里挡的是路径穿越，不是格式洁癖。registry.assertSafeId 再挡一次 ——
 * 校验入口只有一个的话，哪天多一条调用路径就漏了。
 */
export const StrategyIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "只允许字母数字与 . _ -，首字符须为字母或数字");

export const StrategyCreateSchema = z.object({
  id: StrategyIdSchema,
  /** 从哪个策略复制原文（含注释）。不给则从当前生效的那个复制 */
  from: StrategyIdSchema.optional(),
});

export const StrategyActivateSchema = z.object({ id: StrategyIdSchema });

/**
 * 整份原文写回。
 *
 * 上限 256 KB：策略 YAML 现实里是几 KB，给两个数量级余量足够；不设上限则
 * 一次贴错内容就能让服务端拿一份几十 MB 的字符串去做 YAML 解析。
 * baseHash 必填 —— 它是"我编辑的还是不是我读到的那份"的唯一凭据，
 * 允许省略就等于允许静默覆盖别人的改动。
 */
export const StrategyRawWriteSchema = z.object({
  id: StrategyIdSchema,
  text: z.string().min(1).max(256 * 1024),
  baseHash: z.string().regex(/^[0-9a-f]{16}$/, "baseHash 形状不对，请重新载入原文"),
  /** true = 只校验、不落盘。编辑器的「校验」按钮走这条 */
  dryRun: z.boolean().optional(),
});

export const StrategyParamWriteSchema = z.object({
  /** 形如 "持仓.卫星账户.止损" */
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

/**
 * 参数扫描（热力图）。
 *
 * 轴值只收数字与布尔：字符串轴排序没有语义（"高" 和 "低" 谁在左边？），
 * 画出来的热力图轴序是任意的，而人会照着轴序读"往右调更好"。
 * 每轴 2..6 个取值：1 个画不出面，超过 6 个必然撞上 36 点上限。
 * 点数上限本身在 runSweep 里判（它才知道笛卡尔积多大）—— 这里只挡明显的形状错误。
 */
export const SweepRunSchema = z.object({
  from: DateSchema,
  to: DateSchema,
  initialCash: z.number().positive().finite().max(1e12),
  grid: z
    .record(
      z.string().min(1).max(200).regex(/^[^\s]+$/, "参数路径不能含空格"),
      z.array(z.union([z.number().finite(), z.boolean()])).min(2, "每轴至少 2 个取值才画得出面").max(6)
    )
    .refine((g) => Object.keys(g).length >= 2, "至少两条轴（热力图要 x 和 y）")
    .refine((g) => Object.keys(g).length <= 4, "最多四条轴，再多点数必然超上限"),
  axisX: z.string().min(1).max(200),
  axisY: z.string().min(1).max(200),
}).refine((v) => v.axisX !== v.axisY, { message: "x 轴与 y 轴不能是同一条" });

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
