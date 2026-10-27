// 文本谱（番茄简谱 / 「有谱」）的对外入口。

export { sniffDialect, dialectSpec, DIALECTS, type Dialect, type DialectSpec } from "./dialect";
export { parseFanqie, parseFanqieAst, parseMusicLine, parseLyricBody, type ParseOptions } from "./parse";
export { eachNoteInElements, emptyMetadata } from "../jianpu/ast";
export { jianpuInputOfDoc, type JianpuInputOptions } from "../jianpu/jianpuinput";
export { relayoutFanqieText } from "./relayout";
export { fanqiePhraseLines, type FanqieNewLine } from "../jianpu/phrase";
export { phrasePartOfSong } from "../jianpu/phrasesong";
export { playDataOfSong, playSourceOf, playSourceOfSong } from "../jianpu/playsong";
// 展开档应有几遍（两种格式共用的判据；回归脚本经 window.__fanqie 取用）
export { countPasses } from "../jianpu/expand";
export { docView, type DocView, type SongView, type RowView, type SlotRef } from "../jianpu/slots";
export { fanqieToScoreDoc } from "./fromfanqie";
export type {
  Accidental,
  BarlineElement,
  BarlineType,
  BeatBoundaryElement,
  Diagnostic,
  InlineLayerElement,
  LyricLine,
  LyricSyllable,
  Mark,
  MarkType,
  Metadata,
  Meter,
  MusicElement,
  NoteElement,
  Ornament,
  FanqieSong,
  ScoreLine,
  ScorePage,
  SourceSpan,
  SustainElement,
  TextLine,
  VoiceGroup,
} from "../jianpu/ast";
