// Node CLI 侧的 123 格式入口：`.123` 文本 ↔ `ScoreDoc` ↔ 其它格式，**不起浏览器**。
// 由 `npm run build:cli` 打成 out/cli/j123.js，供 scripts/j123-*.mjs import。
//
// 与另两个入口的分工：`cli/index.ts` 是矢量 PDF 版面那一摊、`cli/omr.ts` 是位图简谱识别，
// 这个是**格式与语义模型**这一条。
//
// **只能汇出不碰 DOM 的模块**——排版件（依赖 common/measure.ts 的那些）一律不许进这条链，
// 所以这里没有排版器 / layout。需要排版的回归走 scripts/harness.mjs 起浏览器那条路。
export * from "../model/doc";
export * from "../abcfamily/lex123";
export * from "../abcfamily/parse";
export * from "../abcfamily/emit123.entry";
export { emitAbc } from "../abcfamily/emitabc.entry";
export { emitJcx } from "../abcfamily/emitjcx.entry";
export { decodeJcx, encodeJcx } from "../common/jcxcodec";
export * from "../convert/capability";
export * from "../abcfamily/fields";
export * from "../model/helpers";
export * from "../model/metakeys";
export { decoKey } from "../model/deconames";
export { docView } from "../jianpu/slots";
export { fanqieToScoreDoc } from "../fanqie/fromfanqie";
export { jpwToScoreDoc } from "../model/fromjpw";
export { scoreDocToMusicXml } from "../model/toxml";
export { slursAsTies } from "../model/xmlproject";
// MusicXML 读入要 `DOMParser`：Node 侧的脚本先装私有仓库 `scripts/xml-dom.mjs` 的极简实现
export { loadScoreDoc } from "../model/fromxml";
export { writeJpwabc } from "../model/tojpw";
export { emitJpwabc } from "../convert/jpwabc";
export { emitFanqie, emitFanqieSong, keyNameOf, fanqieArcLosses } from "../fanqie/tofanqie";
export { emitJly } from "../jly/tojly";
export { scanMusicLine, scanWord, JlyLosses, parseJly, isJlyMusicLine, rewrapJlyText } from "../jly/fromjly";
export { projectForJianpu } from "../model/jianpuproject";
export { songFifths } from "../model/keyshift";
export { AccidentalCarry } from "../model/jianpu";
// 文本谱与 `.jpwabc` 读入：迁移工具要拿它们当输入
export { parseFanqie, parseFanqieAst, sniffDialect } from "../fanqie";
export { JpwFile, RepeatSection } from "../jpword/jpwfile";
// 按乐句重排（写回原文那一步；断句本身在 score/phrase.ts）
export { relayoutDocBreaks, relayoutJpwabcText, spliceComments } from "../jianpu/docrelayout";
export { applyBreaks, breaksOf } from "../model/breaks";
export { barLines, phraseCuts, fanqiePhraseLines } from "../jianpu/phrase";
// 小节时值自检（私有仓库的对比报告拿它查手工谱各小节满不满）
export { checkMeasureDurations, describeBeatIssue } from "../model/beatcheck";
// 模型编辑动作（可视化编辑的 MusicXML 那一路；`ops-actions-check.mjs` 按识别手动操作的口径逐个验）
export * as modelEdit from "../model/edit";
// 试听/MIDI（私有仓库的 `chorus-midi.mjs` 拿识别结果与 GT 各导一份 MIDI 逐音比）
export { playSourceOf } from "../jianpu/playsong";
export { buildTimeline } from "../score/timeline";
export { toMidi } from "../score/midi";
