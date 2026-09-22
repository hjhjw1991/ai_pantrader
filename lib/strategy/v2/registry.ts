/**
 * 槽位注册表。
 *
 * 与 lib/factors/registry 同构，连"重名直接抛错"这条都一样 ——
 * 静默覆盖是最难查的一类 bug：策略包的 lock 里写着 1.0.0，跑的却是后注册的那份，
 * 于是影子盘的历史胜率归因到了一个根本没跑过的实现上。
 *
 * 与因子注册表的唯一差别是键多一维：同一个名字在不同槽里是两回事，
 * 择时器叫「默认」和离场器叫「默认」应当共存。
 */
import type { AnySlot, SlotKind, SlotRegistry } from "@/lib/contracts";

const keyOf = (kind: SlotKind, name: string): string => `${kind}:${name}`;

class InMemorySlotRegistry implements SlotRegistry {
  private readonly slots = new Map<string, AnySlot>();

  register(slot: AnySlot): void {
    const k = keyOf(slot.kind, slot.name);
    const exist = this.slots.get(k);
    if (exist !== undefined) {
      throw new Error(
        `槽位重名：${k}（已注册 ${exist.version}，又要注册 ${slot.version}）`);
    }
    this.slots.set(k, slot);
  }

  get(kind: SlotKind, name: string): AnySlot | undefined {
    return this.slots.get(keyOf(kind, name));
  }

  list(kind?: SlotKind): AnySlot[] {
    const all = [...this.slots.values()].filter(s => kind === undefined || s.kind === kind);
    // 排序钉死：lock() 的字节序依赖它，而策略包按字节做 sha256 校验
    return all.sort((a, b) =>
      a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }

  lock(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const s of this.list()) out[keyOf(s.kind, s.name)] = s.version;
    return out;
  }
}

export function createSlotRegistry(slots: AnySlot[] = []): SlotRegistry {
  const reg = new InMemorySlotRegistry();
  for (const s of slots) reg.register(s);
  return reg;
}
