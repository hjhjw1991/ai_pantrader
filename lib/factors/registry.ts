/**
 * 因子注册表（lib/contracts/factor.ts 的 FactorRegistry 实现）。
 *
 * lock() 是给 .ptstrat 的 factors.lock 用的（spec §9.2）：导入策略包时校验
 * "引用的因子全部存在且版本一致"，版本不匹配要能给出迁移提示。
 * 所以 lock() 的键必须**排序输出** —— 两台机器导出的同一份策略包，
 * factors.lock 的字节序必须一致，否则 sha256 对不上，校验会假报失败。
 */
import type { FactorRegistry, FactorResult, FactorSpec, PointInTimeView } from "@/lib/contracts";

class InMemoryFactorRegistry implements FactorRegistry {
  private readonly specs = new Map<string, FactorSpec<any>>();

  register(spec: FactorSpec<any>): void {
    const exist = this.specs.get(spec.name);
    if (exist !== undefined) {
      // 静默覆盖是最难查的一类 bug：factors.lock 里写着 1.0.0，
      // 跑的是后注册的那份实现，回测结论无法归因。
      throw new Error(
        `因子重名：${spec.name}（已注册 ${exist.version}，又要注册 ${spec.version}）`);
    }
    this.specs.set(spec.name, spec);
  }

  get(name: string): FactorSpec<any> | undefined {
    return this.specs.get(name);
  }

  list(): FactorSpec<any>[] {
    return [...this.specs.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  lock(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const s of this.list()) out[s.name] = s.version;
    return out;
  }
}

export function createRegistry(specs: FactorSpec<any>[] = []): FactorRegistry {
  const reg = new InMemoryFactorRegistry();
  for (const s of specs) reg.register(s);
  return reg;
}

/**
 * 求值一个因子：defaults 与调用方覆盖参数合并。
 * 合并在这里做而不是在因子内部做，是为了让"参数从哪来"只有一个地方 ——
 * 策略 YAML 的 因子参数 段覆盖 defaults，因子自己只管读合并后的 params。
 */
export function runFactor<T>(
  spec: FactorSpec<T>, view: PointInTimeView, overrides: Record<string, unknown> = {}
): FactorResult<T> {
  return spec.fn({ view, params: { ...spec.defaults, ...overrides } });
}

/** 校验策略包的 factors.lock：返回缺失与版本不匹配的清单（spec §9.2 三重校验之一） */
export interface LockCheck {
  missing: string[];
  mismatched: Array<{ name: string; expected: string; actual: string }>;
  ok: boolean;
}

export function checkLock(reg: FactorRegistry, lock: Record<string, string>): LockCheck {
  const missing: string[] = [];
  const mismatched: Array<{ name: string; expected: string; actual: string }> = [];
  for (const name of Object.keys(lock).sort()) {
    const spec = reg.get(name);
    if (spec === undefined) { missing.push(name); continue; }
    if (spec.version !== lock[name]) {
      mismatched.push({ name, expected: lock[name], actual: spec.version });
    }
  }
  return { missing, mismatched, ok: missing.length === 0 && mismatched.length === 0 };
}
