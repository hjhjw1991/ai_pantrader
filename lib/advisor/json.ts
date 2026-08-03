/**
 * 从模型输出里抠出第一个完整 JSON 对象。
 *
 * 为什么不直接 JSON.parse：模型输出是外部输入，实测三种脏法都会出现 ——
 * JSON 外面裹解释文字、裹 ```json 围栏、或者被 token 上限截断成半截。
 * 前两种能救（找平衡括号），第三种救不了（括号不闭合）就返回 null 让调用方降级。
 * 绝不抛错：解析失败必须是一个返回值，而不是让顾问把主流程炸掉。
 */
export function firstJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      // 字符串里的花括号不参与配对，转义引号也不能当结束
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null; // 括号没闭合 = 输出被截断
}
