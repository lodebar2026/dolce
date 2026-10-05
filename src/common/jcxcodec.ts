// Muse `.jcx` 的字节 ↔ 文本（说明书「Muse 保存的文件格式」）：
//
// - `%MUSE2` 开头：3.1 以前的版本存的，简体中文版 GBK、繁体中文版 BIG5；
// - `%MUSE3` 开头：3.1 起存的，固定 UTF-8。3.1 以前的 Muse 打不开（乱码）。
//
// 写出**默认 `%MUSE2` + GBK**：新旧版 Muse 都能开（用 Muse 的多是长者，手里常是旧版）。
// 打开的就是 `%MUSE3` 文件时照原样 UTF-8 存回，不降级。Muse 是 Windows 软件，行尾写 CRLF。
//
// 浏览器与 Node 的 `TextDecoder` 都能解 GBK/BIG5，`TextEncoder` 却只出 UTF-8——GBK 写出靠一张反查表，
// 头一次写出时逐个双字节码解一遍建起来（两万来次，一次性）。

let gbkMap: Map<string, number> | null = null;

function gbkTable(): Map<string, number> {
  if (gbkMap) return gbkMap;
  const dec = new TextDecoder("gbk");
  const map = new Map<string, number>();
  const pair = new Uint8Array(2);
  for (let hi = 0x81; hi <= 0xfe; hi++) {
    for (let lo = 0x40; lo <= 0xfe; lo++) {
      if (lo === 0x7f) continue;
      pair[0] = hi;
      pair[1] = lo;
      const ch = dec.decode(pair);
      if (ch.length === 1 && ch !== "�" && !map.has(ch)) map.set(ch, (hi << 8) | lo);
    }
  }
  gbkMap = map;
  return map;
}

const bad = (s: string): number => (s.match(/�/g) ?? []).length;

/** 字节 → 文本（行尾归一成 `\n`）。BOM 优先；`%MUSE3` 或合法 UTF-8 按 UTF-8；否则 GBK，GBK 解不干净再试 BIG5（繁体版 Muse）。 */
export function decodeJcx(bytes: Uint8Array): string {
  let text: string;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) text = new TextDecoder("utf-8").decode(bytes.subarray(3));
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder("utf-16le").decode(bytes.subarray(2));
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder("utf-16be").decode(bytes.subarray(2));
  else {
    try {
      // 纯 ASCII 与 `%MUSE3` 都在这一档；GBK 的中文几乎不可能恰好是合法 UTF-8
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder("gbk").decode(bytes);
      if (bad(text) > 0) {
        const big5 = new TextDecoder("big5").decode(bytes);
        if (bad(big5) < bad(text)) text = big5;
      }
    }
  }
  return text.replace(/\r\n?/g, "\n");
}

/** 文本 → 字节。`missing`：GBK 里没有、写成了 `?` 的字（调用方报给用户）。 */
export function encodeJcx(text: string): { bytes: Uint8Array; missing: string[] } {
  const crlf = text.replace(/\r?\n/g, "\r\n");
  if (/^\s*%MUSE3/.test(text)) return { bytes: new TextEncoder().encode(crlf), missing: [] };
  const map = gbkTable();
  const out: number[] = [];
  const missing: string[] = [];
  for (const ch of crlf) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) {
      out.push(c);
      continue;
    }
    const code = map.get(ch);
    if (code === undefined) {
      if (!missing.includes(ch)) missing.push(ch);
      out.push(0x3f);
    } else {
      out.push(code >> 8, code & 0xff);
    }
  }
  return { bytes: new Uint8Array(out), missing };
}
