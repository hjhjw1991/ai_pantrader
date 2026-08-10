import { describe, it, expect } from "vitest";
import { overrideConfigParams } from "@/lib/ui/adapters/strategy";
import { SweepRunSchema } from "@/lib/ui/validate";
import { validateStrategyYaml } from "@/lib/strategy/schema";
import fs from "node:fs";
import path from "node:path";

/**
 * 参数扫描的把关逻辑。
 *
 * 这里不跑真回测（那要一整套 PIT 数据，integration 测试的活），
 * 盯的是**开跑之前那几道拒绝**：轴形状、非法覆盖、路径不存在、原配置不被污染。
 * 这几道任一失守，热力图就会画出一张"看起来正常但不是你以为的那次实验"的图。
 */

// 用 .example：实文件已 gitignore（含用户账户 id），新克隆下来只有模板
const REAL = path.resolve(__dirname, "..", "..", "config", "strategies", "default.yaml.example");
const base = (() => {
  const v = validateStrategyYaml(fs.readFileSync(REAL, "utf8"), REAL);
  if (!v.ok) throw new Error(`仓库里的 default.yaml 校验不过：${v.message}`);
  return v.config;
})();

describe("overrideConfigParams", () => {
  it("覆盖已存在的纯量并通过校验", () => {
    const r = overrideConfigParams(base, { "择时.仓位档位.进攻": 0.6 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.config as any).择时.仓位档位.进攻).toBe(0.6);
  });

  it("不污染原配置 —— 否则同一次扫描里前一个网格点会脏到后一个", () => {
    const before = (base as any).择时.仓位档位.进攻;
    // 取值要满足跨字段规则 进攻 >= 中性（中性 0.4），不然会被 crossChecks 拒
    const r = overrideConfigParams(base, { "择时.仓位档位.进攻": 0.75 });
    expect(r.ok).toBe(true);
    expect((base as any).择时.仓位档位.进攻).toBe(before);
  });

  /**
   * 跨字段规则会连坐整个网格，这点必须有测试钉住：
   * 扫 `进攻` 时只要有一个取值低于 `中性`，那一个网格点就非法，
   * 而 runSweep 的设计是**整体拒绝**（不跳过该点）。所以界面上会看到
   * "网格点 {...} 非法" 而不是一张缺格的图 —— 这是有意的，别当 bug 改。
   */
  it("单个取值违反跨字段规则 → 该点非法（runSweep 会因此整体拒绝）", () => {
    const r = overrideConfigParams(base, { "择时.仓位档位.进攻": 0.3 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("进攻");
  });

  it("越界值当场拒，不让回测拿非法配置跑出一条像样的曲线", () => {
    // 仓位档位是 0..1 的比例
    const r = overrideConfigParams(base, { "择时.仓位档位.进攻": 5 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("非法");
  });

  it("路径不存在就拒，不静默新建一个引擎根本不读的键", () => {
    const a = overrideConfigParams(base, { "择时.不存在的键": 1 });
    const b = overrideConfigParams(base, { "根本没有.这条路径": 1 });
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok) expect(a.reason).toContain("参数路径不存在");
  });

  it("非纯量目标拒绝（扫描只支持纯量轴）", () => {
    const r = overrideConfigParams(base, { 择时: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/不是纯量|非法/);
  });

  it("多轴一起覆盖", () => {
    const r = overrideConfigParams(base, {
      "择时.仓位档位.进攻": 0.6,
      "组合风控.总仓位上限": 0.7,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.config as any).组合风控.总仓位上限).toBe(0.7);
  });
});

describe("SweepRunSchema 形状把关", () => {
  const good = {
    from: "2026-01-05",
    to: "2026-06-30",
    initialCash: 100000,
    grid: { "择时.仓位档位.进攻": [0.6, 0.7], "组合风控.总仓位上限": [0.7, 0.8] },
    axisX: "择时.仓位档位.进攻",
    axisY: "组合风控.总仓位上限",
  };

  it("正常请求通过", () => {
    expect(SweepRunSchema.safeParse(good).success).toBe(true);
  });

  it("x 轴与 y 轴相同 → 拒（同一条轴画不出面）", () => {
    expect(SweepRunSchema.safeParse({ ...good, axisY: good.axisX }).success).toBe(false);
  });

  it("只有一条轴 → 拒（热力图要 x 和 y）", () => {
    const r = SweepRunSchema.safeParse({ ...good, grid: { "择时.仓位档位.进攻": [0.6, 0.7] } });
    expect(r.success).toBe(false);
  });

  it("某轴只有 1 个取值 → 拒", () => {
    const r = SweepRunSchema.safeParse({
      ...good,
      grid: { ...good.grid, "组合风控.总仓位上限": [0.7] },
    });
    expect(r.success).toBe(false);
  });

  it("字符串轴值 → 拒（字符串排序没有语义，轴序会骗人）", () => {
    const r = SweepRunSchema.safeParse({
      ...good,
      grid: { ...good.grid, "组合风控.总仓位上限": ["高", "低"] },
    });
    expect(r.success).toBe(false);
  });

  it("布尔轴放行（开关型参数确实要扫）", () => {
    const r = SweepRunSchema.safeParse({
      ...good,
      grid: { ...good.grid, "择时.防守触发.权重杀跌": [true, false] },
    });
    expect(r.success).toBe(true);
  });
});
