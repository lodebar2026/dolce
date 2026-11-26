// 导出 MusicXML 的版面坐标（门面；排版、写回、写出在 Rust `dolce-layout/src/layout.rs::engraved_music_xml` 一趟做完）：由五线谱引擎排一遍（与屏幕上的五线谱同一套——同纸、同断行、同自动铺排），
// 排出来的坐标、小节宽、系统间距、符干装进 `EngravedLayout`（**不写进模型**，与原文的表层一样不进 `ScoreDoc`），
// 交给唯一写出端 `model/toxml.ts`（`ToXmlOptions.layout`）。纸、scaling、标题块、换行、弧的朝向这些模型本来就有的照旧写回模型。
//
// 以前导出另有一套 DOM 上的版面注入（A4 常量表、每行 4 小节、音符按小节宽均分），与这里的自动铺排判据两份，
// 屏幕上与 MuseScore 里的分行对不上；导出的文件再读回来，那些粗坐标还会压过自动铺排（行首音压在谱号下）。
// 现在导出的坐标就是引擎自己的坐标，读回来走「带版面」那条路，排出来与导出前一致。
//
// 谱里已经带版面（有 `<defaults>`，或小节宽/音符 default-x）的一字不改：作者给的版面比我们排的更贴切。

import type { ScoreDoc } from "../model/doc";
import type { StaffPage } from "../layout/painter";
import { dolce } from "../common/dolce";
import { docJson } from "../model/rustdoc";

/** `doc` 第一首投成带导出版面的 MusicXML（Rust `dolce_layout::layout::engraved_music_xml`：排版、写回模型、写出一趟做完，
 *  `doc` 本身不动）：纸、标题块、换行、弧朝向写回模型，坐标、小节宽、系统间距、符干交给写出端（`EngravedLayout`）。
 *  谱里已带版面、或排出来不是自动铺排的不加版面原样写。
 *  `sourceBreaks`：谱里的换行换页是源文写明的（ABC），当硬断点（同屏幕上的五线谱，`App.staffRequest`）。 */
export function engravedMusicXml(doc: ScoreDoc, page: StaffPage | null, sourceBreaks = false): string {
  const { json, h } = docJson(doc);
  return dolce().engravedMusicXml(json, h, JSON.stringify({ page, sourceBreaks }));
}
