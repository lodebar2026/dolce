// 「在模型上改、写回原文」那一路的读与写（无 DOM）：`.musicxml` 直接读写；ABC / 123 借道——原文读成 MusicXML 形状、
// 改完按原格式写回（可视化编辑的模型动作、引擎的 `edit` 共用）。别的格式不走这一路（文本补丁，见 `visual/dialects/`）。

import type { ScoreDoc } from "../model/doc";
import type { EditHooks } from "../model/edit";
import { dropEmbeddedLayout, forgetNoteLayout } from "../model/xmlsurface";
import { hasTieSyntax, isXmlShaped, projectForMusicXml } from "../model/xmlproject";
import { assignDegrees } from "../model/jianpu";
import { scoreDocToMusicXml } from "../model/toxml";
import { targetSpec } from "../convert/targets";
import { formatOf, musicXmlFormat, type DocFormatId } from "./formats";

/** 模型编辑动作挂的钩子：改了音的符干、改了结构的原谱版面坐标作废（MusicXML 表层）。 */
export const EDIT_HOOKS: EditHooks = { forgetStem: forgetNoteLayout, forgetLayout: dropEmbeddedLayout };

/** ABC / 123：借道改模型。 */
export function isBridgeFormat(fmt: DocFormatId): fmt is "abc" | "123" {
  return fmt === "abc" || fmt === "123";
}

/** ABC / 123 的原文读成 MusicXML 形状（元素 id 与源码同步索引的相同，`projectForMusicXml` 不换 id）。读不了为 null。 */
export function readBridgeModel(fmt: "abc" | "123", text: string): ScoreDoc | null {
  try {
    const doc = formatOf(fmt).toScoreDoc?.(text);
    if (!doc) return null;
    const songs = doc.songs.map((s) => (isXmlShaped(s) ? s : projectForMusicXml(s, { slurTies: !hasTieSyntax(doc) })));
    // 模型那一路改的是音高；123 读进来的唱名留着就是旧的（写出端按唱名写），去掉让写出端按音高重推
    for (const s of songs) for (const p of s.parts) for (const m of p.measures) for (const el of m.elements) {
      if (el.kind === "chord") for (const n of el.notes) if (n.pitch) delete n.degree;
    }
    return { ...doc, songs };
  } catch {
    return null;
  }
}

/** 借道改完的整份写回 ABC / 123。写不了为 null。 */
export function writeBridgeModel(fmt: "abc" | "123", doc: ScoreDoc): string | null {
  try {
    // 唱名按改过的音高重推（`readBridgeModel` 去掉了旧的；ABC 不用唱名，推了也无妨）
    for (const s of doc.songs) for (const p of s.parts) assignDegrees(p, s.key ?? { fifths: 0 });
    return targetSpec(fmt).emit(doc);
  } catch {
    return null;
  }
}

/** 能在模型上改的那份：`.musicxml` 新读一份，ABC / 123 借道；别的格式与读不了的为 null。 */
export function readEditModel(fmt: DocFormatId, text: string): ScoreDoc | null {
  if (isBridgeFormat(fmt)) return readBridgeModel(fmt, text);
  if (fmt !== "musicxml") return null;
  try {
    return musicXmlFormat.toScoreDoc(text);
  } catch {
    return null;
  }
}

/** `readEditModel` 读的那份改完写回原格式。写不了为 null。 */
export function writeEditModel(fmt: DocFormatId, doc: ScoreDoc): string | null {
  if (isBridgeFormat(fmt)) return writeBridgeModel(fmt, doc);
  return fmt === "musicxml" ? scoreDocToMusicXml(doc) : null;
}
