// 写明的演唱顺序（`.Repeat`、头部 `P:` 与段落标记、`%%sing`）搬到另一份模型（五线谱档读回的 `mixedDoc`）。
// 段落语义（`P:` 展开、锚定首尾和弦）在 Rust（`crates/model/src/sections.rs`），这里是门面。语义见 `docs/格式/123格式.md` §6。

import type { PlayPass, ScoreDoc, Song } from "./doc";
import { dolce } from "../common/dolce";
import { call } from "./rustdoc";

interface CarriedOrder {
  playOrder?: PlayPass[];
  sectionOrder?: Song["sectionOrder"];
  singOrder?: Song["singOrder"];
  layouts?: Song["layouts"];
  sectionMarks?: Song["sectionMarks"];
}

/** 写明的演唱顺序搬到读回的那份模型上：MusicXML 写不下 `.Repeat`、`P:` 与逐遍演唱顺序，小节会拆、元素 id 也换了，
 *  按 `Chord.srcId` 对回去。**就地改 `to`**（它绑着表层，不能整份换掉）：Rust 回各首要设的字段，这里照着赋值。 */
export function carryPlayOrder(from: ScoreDoc, to: ScoreDoc): void {
  const patches = JSON.parse(call(() => dolce().modelCarryPlayOrder(JSON.stringify(from), JSON.stringify(to)))) as CarriedOrder[];
  patches.forEach((p, i) => {
    const dst = to.songs[i];
    if (!dst) return;
    if (p.playOrder) dst.playOrder = p.playOrder;
    if (p.sectionOrder) dst.sectionOrder = p.sectionOrder;
    if (p.singOrder) dst.singOrder = p.singOrder;
    if (p.layouts) dst.layouts = p.layouts;
    if (p.sectionMarks) dst.sectionMarks = p.sectionMarks;
  });
}
