// 简谱来源的 `Song` → **MusicXML 形状**的 `Song`：`toxml.ts` 序列化之前的投影。在 Rust（`crates/model/src/xmlproject.rs`），这里是门面。
//
// MusicXML 只有一份写出端，它只认 MusicXML 形状的字段（绝对音高、以 `attrs.divisions` 为分母的时值、`<notations>` 元素名、
// 带 offset 的 `<direction>`）；简谱来源（文本谱/123/ABC/`.jpwabc`）只填了简谱那一侧，在这里投过去，**写出端就不必分两份**。
// 判据与已知不表达见 Rust 那边文件头。首小节带 `attrs.divisions` 的是 MusicXML 形状，原样返回（门面就地判，不过边界）。

import type { ElementId, ScoreDoc, Song } from "./doc";
import { dolce } from "../common/dolce";
import { call } from "./rustdoc";

/** 是否已经是 MusicXML 形状（`fromxml.ts` 读进来的）。与 Rust `is_xml_shaped` 同一行判据：调用频繁，就地判、省一趟 JSON。 */
export function isXmlShaped(song: Song): boolean {
  return song.parts.some((p) => p.measures[0]?.attrs?.divisions !== undefined);
}

/** 源格式有没有自己的延音线写法（ABC、Muse）：有就不把同音弧当延音线。同 Rust `has_tie_syntax`。 */
export const hasTieSyntax = (doc: Pick<ScoreDoc, "sourceFormat">): boolean => doc.sourceFormat === "abc" || doc.sourceFormat === "jcx";

export interface ProjectOptions {
  /** 换行改照这些音起行（简谱视图实际排出的各行首音，`App.jianpuLineStarts`）。不给就用模型里的换行（源文的行） */
  lineStarts?: ReadonlySet<ElementId> | null;
  /** `lineStarts` 落在小节中间的也原位断（拆小节、中间隐藏线）：它们是乐句断点（`App.staffPhraseLineStarts`），
   *  不是简谱版面宽度的产物。不给就只留源文写明的，其余顺延到下一小节。 */
  midLineStarts?: boolean;
  /** 相邻两个同音的弧当延音线（简谱口径，`tieSlur`）。缺省是；源格式有自己延音线写法的（`hasTieSyntax`：ABC、Muse）传 false */
  slurTies?: boolean;
}

/** 投成 MusicXML 形状（新对象、不带身份，不改入参）；已是 MusicXML 形状的原样返回。 */
export function projectForMusicXml(src: Song, options: ProjectOptions = {}): Song {
  if (isXmlShaped(src)) return src;
  const opts = {
    ...(options.lineStarts?.size ? { lineStarts: [...options.lineStarts] } : {}),
    midLineStarts: options.midLineStarts ?? false,
    ...(options.slurTies !== undefined ? { slurTies: options.slurTies } : {}),
  };
  return JSON.parse(call(() => dolce().modelProjectForMusicXml(JSON.stringify(src), JSON.stringify(opts)))) as Song;
}

/** 房号（由演唱顺序反推）：本小节是某一房的开头 / 结尾、末尾要补反复回头。 */
export interface Volta {
  /** 本小节是某一房的开头，值为该房辖的遍数（"1,2,3"） */
  start?: string;
  /** 本小节是某一房的结尾 */
  stop?: boolean;
  /** 本小节末尾要补一个反复回头（除最后一房外，每房唱完都要回到 `|:`） */
  repeatBack?: boolean;
}

/** 从文档自带的演唱顺序（`.jpwabc` 的 `.Repeat`）反推房号，键是第一声部的小节下标（判据见 Rust `voltas_of_play_order`）。 */
export function voltasOfPlayOrder(song: Song): Map<number, Volta> {
  const pairs = JSON.parse(call(() => dolce().modelVoltasOfPlayOrder(JSON.stringify(song)))) as [number, Volta][];
  return new Map(pairs);
}

/** 简谱口径括住相邻两个同音的弧改记延音线（写成 ABC / Muse 的 `-` 之前）；没有要改的原样返回。 */
export function slursAsTies(src: Song): Song {
  if (isXmlShaped(src) || !src.marks.some((m) => m.type === "slur")) return src;
  const out = call(() => dolce().modelSlursAsTies(JSON.stringify(src)));
  return out === undefined ? src : (JSON.parse(out) as Song);
}
