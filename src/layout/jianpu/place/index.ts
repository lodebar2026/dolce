// 原样文档布局（文本谱与多声部 123/ABC、MusicXML 的原样档）：排版行视图 → 定位结构。按能力分文件，这里只做再导出。
//
// 与本项目 .jpwabc 的排版引擎分开，因为规则本来就不同：文本谱**不自动断行**——
// 一行 `Q:` 就是谱面一行（这正是「原版」的意义），放不下才整首重新断行；行内横向与旧简谱引擎同一套排法
//（同拍位归一列、列宽按内容、两端对齐，`spacing.ts`）；多声部同组上下堆叠。
//
// 只算位置、不碰绘图，构图在 `compose/`。这样播放高亮只需拿定位结构里的锚点，
// 不必反查 SVG。

export type { PlacedItem, PlacedMark, PlacedLayer, PlacedSplit, PlacedUnderline, PlacedVoice, PlacedGroup, PlacedPage, PlacedScore, InkMeasurer } from "./model";
export type { NoteElement, SustainElement } from "../../../jianpu/ast";
export { elementBeats } from "./voice";
export { layoutSong, layoutDocument } from "./song";
export { reflowLineStarts } from "./reflow";
export { graceLayout, graceTop, noteBeams, noteInkBottom, stackTop } from "./vertical";
