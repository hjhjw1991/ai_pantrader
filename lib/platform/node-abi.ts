/**
 * 把原生模块的 ABI 报错翻成"下一步敲什么"。
 *
 * 这条路径**正常情况下已经不会走到**：better-sqlite3 从 v13 起是 N-API，
 * 预编译产物按平台分而不是按 ABI 分，换 Node 大版本不再需要重编
 * （实测同一份安装在 ABI 127 与 ABI 137 下都能加载）。
 *
 * 留着是因为它仍然可能发生，而且发生时极难认：从别的机器拷 node_modules、
 * 用了从源码编译的旧版本、或依赖被降级回 v11 那种 prebuild-install 的形态，
 * 都会重新绑上 NODE_MODULE_VERSION。那时业务侧看到的是"数据库打不开"，
 * 而报错正文里只有两个光秃秃的 ABI 号（127 / 137）。没人背得住哪个号对应哪个 Node，
 * 于是人转头去查路径和权限 —— 那两样从头到尾都是对的。
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
 * 处置建议：优先把 Node 换回装依赖时的版本。
 * 就地重编成新 ABI 也行，但网页进程与采集守护进程必须用同一个 Node 启动 ——
 * 两边 ABI 不一致时，一边好了另一边照样开不了库，而采集挂了是静默的。
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
