// 按行解析的公共件。

/** 换行统一成 LF（CRLF、单独的 CR 都换）：与编辑器（CodeMirror）存下的原文一致。 */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** 各行起点的字符偏移，与 `text.split(/\r?\n/)` 的行一一对应。
 *  按**实际换行符的长度**累计：CRLF 文件用 `raw.length + 1` 累计时每行少算一个字符，
 *  到第 n 行就偏 n，SourceSpan 取回的原文全错位。 */
export function lineStarts(text: string): number[] {
  const out = [0];
  for (const m of text.matchAll(/\r?\n/g)) out.push(m.index + m[0].length);
  return out;
}

/** 两份原文前后相同的部分去掉，剩下中间不同的那一段（局部补丁，撤销与光标映射都干净）。 */
export function diffRegion(a: string, b: string): { from: number; to: number; insert: string } {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  return { from: p, to: a.length - q, insert: b.slice(p, b.length - q) };
}
