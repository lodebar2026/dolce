// Node CLI 侧的 123 格式入口：`.123` 文本 ↔ `ScoreDoc` ↔ 其它格式，**不起浏览器**。
// 由 `npm run build:cli` 打成 out/cli/j123.js，供 scripts/j123-*.mjs import。载入时读 dolce-wasm（`cli/dolcewasm.node.ts`）。
//
// 与另两个入口的分工：`cli/index.ts` 是矢量 PDF 版面那一摊、`cli/omrfmt.ts` 是识别结果的写出端，
// 这个是**格式与语义模型**这一条。
//
// **只能汇出不碰 DOM 的模块**——排版件（依赖 common/measure.ts 的那些）不进这条链，
// 所以这里没有排版器 / layout。需要排版的走 `cli/engrave.ts`（它装测量后端，并把这里的导出一并转出）。
import "./dolcewasm.node"; // 演唱顺序、断句、时间轴、MIDI、jcx 编解码在 dolce-wasm
export * from "../model/doc";
export * from "../abcfamily/parse";
export * from "../abcfamily/emit";
export { decodeJcx, encodeJcx } from "../common/jcx";
export * from "../convert/capability";
export * from "../model/helpers";
export * from "../model/metakeys";
export { decoKey } from "../model/deconames";
export { docView } from "../jianpu/slots";
export { fanqieToScoreDoc } from "../fanqie/parse";
export { jpwToScoreDoc } from "../model/fromjpw";
export { scoreDocToMusicXml } from "../model/toxml";
export { slursAsTies, voltasOfPlayOrder } from "../model/xmlproject";
export { loadScoreDoc } from "../model/fromxml";
export { emitJpwabc } from "../convert/jpwabc";
export { emitFanqie, emitFanqieSong, keyNameOf, fanqieArcLosses } from "../fanqie/tofanqie";
export { emitJly } from "../jly/tojly";
export { parseJly, isJlyMusicLine, rewrapJlyText } from "../jly/fromjly";
export { wholeToDuration, harmonyToChordToken, chordTimeline } from "../jly/jlychords";
export { projectForJianpu } from "../model/jianpuproject";
export { songFifths } from "../model/keyshift";
export { AccidentalCarry } from "../model/jianpu";
// 文本谱与 `.jpwabc` 读入：迁移工具要拿它们当输入
export { parseFanqie, parseFanqieAst, sniffDialect } from "../fanqie";
export { JpwFile, RepeatSection } from "../jpword/jpwfile";
// `.jpwabc` 迁 Rust 对拍（dev `rs-diff.mjs jpw`）：词法、分节、源文小节、写出端的两种输入形状
export { VoiceSection, WordsSection, TitleSection, LayoutSection } from "../jpword/jpwfile";
export { lexVoice } from "../jpword/lex";
export { readJpwSource } from "../model/fromjpw";
export { isXmlShaped } from "../model/xmlproject";
// 按乐句重排（写回原文那一步；断句本身在 crates/dolce-play，经 score/play.ts）
export { relayoutDocBreaks, relayoutJpwabcText, spliceComments } from "../jianpu/docrelayout";
export { applyBreaks, breaksOf } from "../model/breaks";
export { barLines, phraseCuts, fanqiePhraseLines } from "../jianpu/phrase";
// 小节时值自检（私有仓库的对比报告拿它查手工谱各小节满不满）
export { checkMeasureDurations, describeBeatIssue } from "../model/beatcheck";
// 模型编辑动作（可视化编辑的 MusicXML 那一路；`ops-actions-check.mjs` 按识别手动操作的口径逐个验）
export * as modelEdit from "../model/edit";
export * as modelParts from "../model/parts";
export * as modelHanconv from "../model/hanconv";
export { msgText } from "../model/msg";
export * as modelTranscribe from "../model/transcribe";
// 试听/MIDI（私有仓库的 `chorus-midi.mjs` 拿识别结果与 GT 各导一份 MIDI 逐音比）
export { playSourceOf, buildTimeline, toMidi } from "../score/play";
// MIDI 导入（迁 Rust 对拍 dev `rs-diff.mjs midiimport`）
export { midiToScoreDoc } from "../midi/import";
// 只读写模型的回归脚本（`playorder-check.mjs`、`jianpu-shape-check.mjs`、`phrase-dual-check.mjs` 等）在 Node 下直接跑用
export { playSourceOfDoc } from "../score/play";
export { jianpuInputOfDoc } from "../jianpu/jianpuinput";
export { phrasePartOfSong } from "../score/play";
export { fillDegreesFromPitch } from "../model/jianpu";
// 迁 Rust 对拍（dev `rs-diff.mjs query`）用的查询层
export * as modelJianpu from "../model/jianpu";
export * as modelKeyshift from "../model/keyshift";
export * as modelTuplets from "../model/tuplets";
export * as modelMultirest from "../model/multirest";
export * as modelDeconames from "../model/deconames";
export * as harmonyParse from "../score/harmonyparse";
export * as xmlSurface from "../model/xmlsurface";
export * as modelStaves from "../model/staves";
export * as modelTimeaxis from "../model/timeaxis";
export * as modelInnervoice from "../model/innervoice";
export * as modelPagemeta from "../model/pagemeta";
export * as modelBreaks from "../model/breaks";
export * as modelXmlproject from "../model/xmlproject";
export * as modelJianpuproject from "../model/jianpuproject";
export * as modelDirectionmarks from "../model/directionmarks";
// 自有 XML 树：脚本里数 MusicXML 元素用（不靠浏览器 DOM）
// Rust 识别的核对 JSON → 编辑器核对数据（`rust-omr/adapter-check.mjs` 用），识别 id 按表层读
export { reviewFromRust, systemOpToRust } from "../omrrust/adapter";
export { surfaceIds } from "../editor/omrlinks";
