/**
 * YAML 键路径 → 源文本位置的索引。
 *
 * 两个用途，都不是锦上添花：
 *   1. spec §9.2 要求导入非法值时报出**具体行号**。
 *   2. 参数写回要在原文上做**外科手术式替换**，这样注释与排版一个字节都不动 ——
 *      注释里记着"为什么是这个阈值"，load→dump 往返会把它们全部冲掉。
 *
 * js-yaml 5 的 parseEvents 给的是字符偏移，事件流形状是：
 *   DOCUMENT, <节点>, ... , POP
 *   节点 = SCALAR | ALIAS | (MAPPING, k, v, k, v, ..., POP) | (SEQUENCE, v, v, ..., POP)
 * 所以按栈递归消费一遍就能给每个叶子标上路径。
 */
import {
  parseEvents, getScalarValue,
  EVENT_DOCUMENT, EVENT_SEQUENCE, EVENT_MAPPING, EVENT_SCALAR, EVENT_ALIAS, EVENT_POP,
  SCALAR_STYLE_PLAIN,
  type Event, type ScalarEvent,
} from "js-yaml";

export interface YamlSpan {
  /** 键路径。序列元素用下标的十进制字符串，如 ["选股","主线识别","必查链","1"] */
  path: string[];
  /** 值在源文本中的起止偏移（引号/花括号之外的部分） */
  valueStart: number;
  valueEnd: number;
  /** 1 起的行号 */
  line: number;
  column: number;
  kind: "scalar" | "mapping" | "sequence" | "alias";
  /** 纯量是否是无引号的 plain 风格。带引号的替换要留住引号，所以要分清 */
  plain: boolean;
}

export interface YamlIndex {
  /** path.join(".") -> span */
  byPath: Map<string, YamlSpan>;
  spans: YamlSpan[];
  /** 偏移 → 行号（1 起） */
  lineAt(offset: number): number;
}

function lineStarts(src: string): number[] {
  const out = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") out.push(i + 1);
  return out;
}

/**
 * 建索引。YAML 本身语法错误时抛 YAMLException（带 mark.line），由调用方转成 issue。
 */
export function indexYaml(src: string, filename?: string): YamlIndex {
  const events = parseEvents(src, filename === undefined ? {} : { filename });
  const starts = lineStarts(src);
  const lineAt = (offset: number): number => {
    // 二分找最后一个 <= offset 的行首
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  const spans: YamlSpan[] = [];
  const byPath = new Map<string, YamlSpan>();
  const push = (s: YamlSpan): void => {
    spans.push(s);
    const key = s.path.join(".");
    // 同名键重复出现时保留第一条（js-yaml 的 load 本身会对重复键报错，走不到这里）
    if (!byPath.has(key)) byPath.set(key, s);
  };

  let i = 0;
  const startOf = (e: Event): number =>
    e.type === EVENT_SCALAR ? e.valueStart
      : e.type === EVENT_SEQUENCE || e.type === EVENT_MAPPING ? e.start
      : e.type === EVENT_ALIAS ? e.anchorStart
      : 0;

  /** 消费一个节点（及其子树），返回它自己的 span */
  const node = (path: string[]): YamlSpan => {
    const e = events[i];
    if (e === undefined) throw new Error("indexYaml: 事件流提前结束");
    const off = startOf(e);
    const self: YamlSpan = {
      path: [...path],
      valueStart: off, valueEnd: off,
      line: lineAt(off), column: off - starts[lineAt(off) - 1] + 1,
      kind: "scalar", plain: true,
    };

    if (e.type === EVENT_SCALAR) {
      i++;
      self.valueEnd = e.valueEnd;
      self.plain = e.style === SCALAR_STYLE_PLAIN;
      push(self);
      return self;
    }
    if (e.type === EVENT_ALIAS) {
      i++;
      self.kind = "alias";
      self.valueEnd = e.anchorEnd;
      push(self);
      return self;
    }
    if (e.type === EVENT_MAPPING) {
      i++;
      self.kind = "mapping";
      let last = off;
      while (events[i] !== undefined && events[i].type !== EVENT_POP) {
        const keyEvent = events[i];
        // 键一律当纯量读；复合键（? :）在配置文件里不会出现，出现了就按原文当键名
        const keyText = keyEvent.type === EVENT_SCALAR
          ? getScalarValue(src, keyEvent as ScalarEvent)
          : String(startOf(keyEvent));
        i++;                              // 吃掉键
        const child = node([...path, keyText]);
        last = Math.max(last, child.valueEnd);
      }
      if (events[i] !== undefined) i++;   // 吃掉 POP
      self.valueEnd = last;
      push(self);
      return self;
    }
    if (e.type === EVENT_SEQUENCE) {
      i++;
      self.kind = "sequence";
      let idx = 0, last = off;
      while (events[i] !== undefined && events[i].type !== EVENT_POP) {
        const child = node([...path, String(idx)]);
        last = Math.max(last, child.valueEnd);
        idx++;
      }
      if (events[i] !== undefined) i++;
      self.valueEnd = last;
      push(self);
      return self;
    }
    throw new Error(`indexYaml: 未预期的事件类型 ${(e as { type: number }).type}`);
  };

  while (i < events.length) {
    const e = events[i];
    if (e.type === EVENT_DOCUMENT) { i++; continue; }
    if (e.type === EVENT_POP) { i++; continue; }
    node([]);
  }

  return { byPath, spans, lineAt };
}

/**
 * 找路径对应的位置；找不到就沿路径往上退，退到最近的祖先。
 *
 * 为什么要退：缺失的键在源文本里根本没有位置，但"第 11 行的 组合风控 段少了 单票最大占比"
 * 比"行号未知"有用得多。
 */
export function locate(idx: YamlIndex, path: string[]): YamlSpan | null {
  for (let n = path.length; n >= 0; n--) {
    const hit = idx.byPath.get(path.slice(0, n).join("."));
    if (hit !== undefined) return hit;
  }
  return null;
}
