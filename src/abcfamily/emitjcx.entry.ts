// `.jcx` 写出端的函数入口（与 `emitabc.entry.ts` 对称）。落盘编码见 `common/jcxcodec.ts`。

import type { ScoreDoc } from "../model/doc";
import { EMITTER_JCX } from "./emitjcx";

/** 整份文档 → Muse `.jcx` 文本（未编码）。Muse 一个文件一首，多曲只写第一首。 */
export function emitJcx(doc: ScoreDoc): string {
  return EMITTER_JCX.emitDoc(doc);
}
