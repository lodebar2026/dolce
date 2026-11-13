// 识别命令行（`scripts/omr-cli.mjs`）的写出端：识别本身在 Rust（`omr-cli run` / `split`），这里只把它的产物写成各输出格式。
// 由 `npm run build:cli` 打成 out/cli/omrfmt.js，随 OMR 分发包走——**不引识别、图像解码、推理与 pdf.js**（包里不再带 sharp / onnxruntime-node / pdfjs-dist）。
import type { RecognizedScore } from "../omrkit/types";
import { recognizedToDoc } from "../omr/todoc";
import { omrEmitter } from "../omr/emit";
import { scoreDocToMusicXml } from "../model/toxml";
import { CONVERT_TARGETS } from "../convert/targets";
import { DOC_EXT, encodeDocText, utf8 } from "../convert/docfile";
import { XML_OUT_FORMATS, encodeXmlAs, isXmlOutFormat, type XmlOutFormat } from "../convert/xmlformats";
import { applyRefLyrics, rustLyricHooks } from "../omr/reflyrics";
export { decodeLyricsBytes, formatLyricCheckItem } from "../omr/reflyrics";

/** 输出格式：MusicXML 加上各可编辑格式（`convert/targets.ts`），顺序即帮助里的顺序。 */
export const OUT_FORMATS = XML_OUT_FORMATS;
export const isOutFormat = isXmlOutFormat;
export type OutFormat = XmlOutFormat;
/** 各格式的显示名 */
export const formatLabel = (f: OutFormat): string => (f === "musicxml" ? "MusicXML" : CONVERT_TARGETS.find((t) => t.id === f)!.label);

export interface Encoded {
  /** 落盘扩展名（与编辑器存盘同一份） */
  ext: string;
  /** 原文（写 stdout 用） */
  text: string;
  /** 落盘字节（.jpwabc 是 UTF-16LE 带 BOM、.jcx 是 GBK，其余 UTF-8） */
  bytes: Uint8Array;
}

/** 简谱识别结果 → 指定格式。 */
export function encodeRecognized(score: RecognizedScore, format: OutFormat): Encoded {
  if (format === "musicxml") {
    const xml = scoreDocToMusicXml(recognizedToDoc(score));
    return { ext: DOC_EXT.musicxml, text: xml, bytes: utf8(xml) };
  }
  const e = omrEmitter(format).emit(score);
  return { ext: DOC_EXT[e.kind], text: e.text, bytes: encodeDocText(e.kind, e.text) };
}

/** 五线谱识别的 MusicXML（带识别 id）→ 指定格式。写出的 MusicXML 去掉识别 id（那是编辑器核对用的）。 */
export function encodeStaffXml(xml: string, format: OutFormat): Encoded {
  return encodeXmlAs(format, format === "musicxml" ? stripOmrIds(xml) : xml);
}

/** 去掉元素上的识别 id（`id="omr…"`）。 */
export function stripOmrIds(xml: string): string {
  return xml.replace(/ id="omr[A-Za-z]*\d+"/g, "");
}

/** 参照歌词互证（`-l`）：形近字按歌词选字（候选取 Rust 挂在音上的 `lyricAlts`）、补漏字，其余不一致只报告；结果挂到 `score.lyricCheck`。
 *  在 Rust 识别之后做（TS 管线里它挂在歌词落位之后、弧裁决之前，补上的字还喂给后面几步；这里那几步已做完）。 */
export async function checkRefLyrics(score: RecognizedScore, refText: string): Promise<NonNullable<RecognizedScore["lyricCheck"]>> {
  const lc = await applyRefLyrics(score, refText, rustLyricHooks(score));
  score.lyricCheck = lc;
  return lc;
}
