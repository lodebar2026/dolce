// 谱里自带的纸：MusicXML 的 `<page-layout>`（tenths）与 123/ABC 的 `I:meta page …`（pt）互转，外加谱表大小、歌词字号、页眉字体。
// 在 Rust（`crates/model/src/pagemeta.rs`，meta 键与换算见那边文件头），这里是门面。
//
// 转换时把纸写成 meta（`withPageMeta`），123/ABC 写 MusicXML 时再还原成 `<page-layout>`（投影里做）。
// 编辑器里「跟随文件」读的也是这里（`style/paper.ts::songPageDecl`）。
//
// 无 DOM 依赖。
import type { ScoreDoc, Song } from "./doc";
import { dolce } from "../common/dolce";
import { adopt, boundOf, call, docJson } from "./rustdoc";

/** 标准纸（pt，竖放）。编辑器纸张表（`style/themes.ts::PAPER_SIZES`）在它之上再加一档「长图」。
 *  与 Rust `pagemeta::STANDARD_PAPERS` 同一张表（编辑器模块加载时就要用，等不到 wasm 载入）。 */
export const STANDARD_PAPERS: Readonly<Record<string, readonly [number, number]>> = {
  A4: [595, 842],
  A5: [420, 595],
  B5: [499, 709],
  Letter: [612, 792],
  // 歌本常用的两种开本（mm 折 pt）：150×216 是 500 首成书那张，155×240 是五线谱/混排的出厂纸
  "150×216mm": [425.197, 612.283],
  "155×240mm": [439.37, 680.315],
};

/** 实际的纸（pt，已按方向转好）与边距 `[上, 右, 下, 左]`。 */
export interface PagePt {
  w: number;
  h: number;
  margins?: [number, number, number, number];
}

export type HeaderRole = "title" | "subtitle" | "scripture" | "credit";
export const HEADER_ROLES: readonly HeaderRole[] = ["title", "subtitle", "scripture", "credit"];

/** 页眉一项的字体：族（CSS font-family）、字号（pt）、粗体。 */
export interface HeaderFontSpec {
  family?: string;
  size?: number;
  bold?: boolean;
}

interface PageInfo {
  page: PagePt | null;
  staffSize: number | null;
  lyricSize: number | null;
  headerFonts: Partial<Record<HeaderRole, HeaderFontSpec>>;
}

/** 一趟取齐：只送 `meta` / `defaults` / `credits` 与身份（页眉字体缺族时按身份到表层取 `<word-font>`）。 */
function pageInfo(song: Song): PageInfo {
  const b = boundOf(song);
  const lite = {
    work: song.work, parts: [], marks: [], meta: song.meta, defaults: song.defaults, credits: song.credits,
    ...(b ? { _oid: b.oid } : {}),
  };
  return JSON.parse(call(() => dolce().modelPageInfo(JSON.stringify(lite), b?.s?.h ?? 0))) as PageInfo;
}

/** 谱里写的纸：MusicXML 的 `<page-layout>` 优先，其次 `I:meta page …`。 */
export function songPage(song: Song): PagePt | null {
  return pageInfo(song).page;
}

/** 认得的标准纸（含横放）。 */
export function standardPaperOf(w: number, h: number): { name: string; landscape: boolean } | null {
  return JSON.parse(dolce().modelStandardPaperOf(w, h)) as { name: string; landscape: boolean } | null;
}

/** 谱表高（mm）：MusicXML `<scaling>` 优先（40 tenths 的毫米数），其次 `I:meta staff-size`。 */
export function songStaffSize(song: Song): number | null {
  return pageInfo(song).staffSize;
}

/** 歌词字号（pt）：MusicXML `<lyric-font font-size>` 优先，其次 `I:meta lyric-size`。 */
export function songLyricSize(song: Song): number | null {
  return pageInfo(song).lyricSize;
}

/** 谱里写的页眉字体：MusicXML 的 credit 优先，其次 meta。 */
export function songHeaderFonts(song: Song): Partial<Record<HeaderRole, HeaderFontSpec>> {
  return pageInfo(song).headerFonts;
}

/** MusicXML 的 `<credit>` 按类型归到页眉角色（`credit-type`；没写类型的按版面：页首最大号且不靠右的是标题，靠右的是词曲）。
 *  五线谱排版器画 credit 时也用它（`mixed/staffpages.ts`）。 */
export function headerRoleOfCredit(type: string | undefined, justify: string | undefined, biggest: boolean): HeaderRole | null {
  return (dolce().modelHeaderRoleOfCredit(type, justify, biggest) as HeaderRole | undefined) ?? null;
}

/** 转成 123/ABC 之前：MusicXML 的纸、谱表大小、歌词字号、页眉字体写进 meta（meta 里已有的不动）。返回新文档，不改入参；没有要写的原样返回。 */
export function withPageMeta(doc: ScoreDoc): ScoreDoc {
  const { json, s, h } = docJson(doc);
  const out = call(() => dolce().modelWithPageMeta(json, h));
  if (out === undefined) return doc;
  const fresh = adopt<ScoreDoc>(out, s);
  if (doc.source !== undefined) fresh.source = doc.source;
  return fresh;
}
