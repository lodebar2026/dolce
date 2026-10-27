// `ScoreDoc` → `.jpwabc`：按形状选写出端的输入——MusicXML 形状走 `model/playdoc.ts::jpwInputOfDoc`，
// 简谱形状（文本谱 / 123 / ABC / `.jpwabc`）走排版行视图那一路 `jianpu/playsong.ts::jpwInputOfSong`，再交 `model/tojpw.ts::writeJpwabc`。
// 放在 model 之上：简谱形状那一路要用投影层，模型层不反过来依赖它。

import type { ScoreDoc } from "../model/doc";
import { jpwInputOfDoc } from "../model/playdoc";
import { writeJpwabc } from "../model/tojpw";
import { isXmlShaped } from "../model/xmlproject";
import { jpwInputOfSong } from "../jianpu/playsong";

/** `ScoreDoc` → `.jpwabc` 文本（第 `songIdx` 首）。MusicXML 形状照 `loadMusicXml` 的口径，简谱形状照 `scoreDocToScore`。
 *  这首没有曲行时返回 null。 */
export function emitJpwabc(doc: ScoreDoc, songIdx = 0): string | null {
  const song = doc.songs[songIdx];
  if (!song) return null;
  const src = isXmlShaped(song) ? jpwInputOfDoc(song) : jpwInputOfSong(doc, songIdx);
  return src ? writeJpwabc(src) : null;
}
