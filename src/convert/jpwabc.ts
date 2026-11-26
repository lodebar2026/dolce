// `ScoreDoc` → `.jpwabc`：写出端的输入按形状拼（MusicXML 形状 / 简谱形状经排版行视图）、写出，都在 Rust
// （crates/model/src/formats/jpw/input.rs、write.rs，wasm `modelEmitJpwabc`），这里是门面。

import { dolce } from "../common/dolce";
import type { ScoreDoc } from "../model/doc";
import { call } from "../model/rustdoc";

/** `ScoreDoc` → `.jpwabc` 文本（第 `songIdx` 首）。MusicXML 形状照 `loadMusicXml` 的口径，简谱形状照 `scoreDocToScore`。
 *  这首没有曲行时返回 null；写不出（坏 jpAlter、heavy-light 线、多房号……）抛错。 */
export function emitJpwabc(doc: ScoreDoc, songIdx = 0): string | null {
  return call(() => dolce().modelEmitJpwabc(JSON.stringify(doc), songIdx)) ?? null;
}
