// MusicXML（五线谱识别的原样产物）→ 各输出格式：MusicXML 原样，或读回 ScoreDoc 再按转换目标表写成可编辑格式。
// 歌本逐首识别（`omr/booksplit/recognize.ts`）与识别命令行（`cli/omrfmt.ts`）共用。无 DOM 依赖。
import { loadScoreDoc } from "../model/fromxml";
import { CONVERT_TARGETS, type ConvertTarget } from "./targets";
import { DOC_EXT, encodeDocText, utf8 } from "./docfile";

/** 输出格式：MusicXML 加上各可编辑格式。 */
export type XmlOutFormat = "musicxml" | ConvertTarget;
export const XML_OUT_FORMATS: readonly XmlOutFormat[] = ["musicxml", ...CONVERT_TARGETS.map((t) => t.id)];
export const isXmlOutFormat = (v: unknown): v is XmlOutFormat => XML_OUT_FORMATS.includes(v as XmlOutFormat);

/** 一种格式的扩展名、原文与落盘字节（与编辑器存盘同一份：`convert/docfile.ts`）。 */
export function encodeXmlAs(format: XmlOutFormat, xml: string): { ext: string; text: string; bytes: Uint8Array } {
  if (format === "musicxml") return { ext: DOC_EXT.musicxml, text: xml, bytes: utf8(xml) };
  const spec = CONVERT_TARGETS.find((t) => t.id === format)!;
  const text = spec.emit(loadScoreDoc(xml));
  return { ext: DOC_EXT[spec.docFormat], text, bytes: encodeDocText(spec.docFormat, text) };
}
