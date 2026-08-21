/**
 * 把原生模块的 ABI 报错翻成"下一步敲什么"。
 *
 * better-sqlite3 的 .node 绑死 NODE_MODULE_VERSION，换了 Node 大版本就 dlopen 失败。
 * 这个故障离它的表象隔了好几层：业务侧看到的是"数据库打不开"，而报错正文里只有
 * 两个光秃秃的 ABI 号（127 / 137）。没人背得住哪个号对应哪个 Node，于是人转头去查
 * 路径和权限 —— 那两样从头到尾都是对的。
 *
 * 这个模块不改写原始报错（原文由 lib/ui/db 原样带出，ABI 号和 errno 是唯一线索），
 * 只在旁边**追加**一句可执行的处置。
 */

/** NODE_MODULE_VERSION → Node 大版本。只列本项目可能撞上的，认不出就老实给 null */
const ABI_TO_NODE: Record<number, number> = {
  108: 18,
  115: 20,
  127: 22,
  131: 23,
  137: 24,
};

export interface AbiMismatch {
  /** .node 编译时的 ABI */
  builtFor: number;
  /** 当前 Node 要求的 ABI */
  required: number;
  /** 对应的 Node 大版本，认不出为 null */
  builtForNode: number | null;
  requiredNode: number | null;
}

/**
 * 从报错正文里取两个 ABI 号。取不到就是 null ——
 * 权限、路径、文件损坏都不该被硬套成 ABI 问题。
 */
export function parseAbiMismatch(message: string): AbiMismatch | null {
  const m = /NODE_MODULE_VERSION (\d+)[\s\S]*?NODE_MODULE_VERSION (\d+)/.exec(message);
  if (m === null) return null;
  const builtFor = Number(m[1]);
  const required = Number(m[2]);
  return {
    builtFor,
    required,
    builtForNode: ABI_TO_NODE[builtFor] ?? null,
    requiredNode: ABI_TO_NODE[required] ?? null,
  };
}

/**
 * 处置建议。**刻意劝阻 rebuild**：
 * install-launchd / install-schtasks 把安装当时那个 Node 的绝对路径写进了计划任务，
 * 就地重编成新 ABI，网页是好了，采集反过来全挂 —— 而采集挂了是静默的，
 * 要等到某天发现数据缺了一段才发现。所以正解永远是"把 Node 换回去"。
 */
export function abiHint(message: string): string | null {
  const m = parseAbiMismatch(message);
  if (m === null) return null;

  const built = m.builtForNode === null ? `ABI ${m.builtFor}` : `Node ${m.builtForNode}`;
  const cur = m.requiredNode === null ? `ABI ${m.required}` : `Node ${m.requiredNode}`;
  const use = m.builtForNode === null ? "" : `：nvm use ${m.builtForNode}`;

  return (
    `原生模块 better-sqlite3 编译于 ${built}，当前跑的是 ${cur}，装不上。` +
    `换回 ${built} 再启动${use}（仓库根目录有 .nvmrc，nvm use 会自动读）。` +
    `不要 rebuild —— 计划任务里写死的是安装当时那个 Node 的绝对路径，` +
    `重编成新 ABI 会让采集反过来跑不动，而采集挂掉是静默的。`
  );
}
