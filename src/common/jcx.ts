// Muse `.jcx` 的字节 ↔ 文本门面：编解码在 Rust（crates/dolce-formats/src/jcxcodec.rs，经 dolce-wasm），签名同原 TS 实现。
// 读：BOM 优先；`%MUSE3` 或合法 UTF-8 按 UTF-8；否则 GBK，字节分布像 BIG5 的按 BIG5；行尾归一成 `\n`。
// 写：默认 `%MUSE2` + GBK（新旧版 Muse 都能开），打开的是 `%MUSE3` 就照原样 UTF-8；行尾 CRLF。
import { dolce } from "./dolce";

/** 字节 → 文本（行尾归一成 `\n`）。 */
export function decodeJcx(bytes: Uint8Array): string {
  return dolce().decodeJcx(bytes);
}

/** 文本 → 字节。`missing`：GBK 里没有、写成了 `?` 的字（调用方报给用户）。 */
export function encodeJcx(text: string): { bytes: Uint8Array; missing: string[] } {
  const r = dolce().encodeJcx(text);
  try {
    return { bytes: r.bytes, missing: [...r.missing] };
  } finally {
    r.free();
  }
}
