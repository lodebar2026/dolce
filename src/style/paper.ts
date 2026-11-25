// 纸张：纸名 / 方向 / 边距 → 实际尺寸，以及谱里自带的版面 → 样式规则（级联的「曲内」那一层）。
//
// 纸张设置三档都有（简谱档的简谱格式、简谱档的文本谱、五线谱/混排），投影档是投影片比例，不走这里。
// 谱里写了纸（MusicXML 的 `<page-layout>`，123/ABC 的 `I:meta page …`）就作为曲内层垫在用户层之下：
// 面板上显示「跟随文件」，用户选了具体纸才盖过它。
//
// 无 DOM 依赖。
import type { LayoutSpec, Song } from "../model/doc";
import { songPage, standardPaperOf } from "../model/pagemeta";
import type { StyleRule } from "./cascade";
import type { DeepPartial, PageDecl, StyleSheet } from "./sheet";
import { PAGE_RATIOS, PAPER_SIZES } from "./themes";

export type Orientation = "portrait" | "landscape";

/** 不在纸张表里的尺寸（谱里自带的非标准纸）记成这个名字，尺寸在 `size`。 */
export const CUSTOM_PAPER = "自定义";

/** 纸的实际尺寸（pt，已按方向转好）。`null` = 长图（不分页）；`undefined` = 没写纸。 */
export function resolvePaper(page: PageDecl): { w: number; h: number } | null | undefined {
  const name = page.paper;
  if (name === undefined) return undefined;
  let wh: readonly [number, number] | null | undefined = PAPER_SIZES[name];
  if (wh === undefined) wh = page.size;
  if (wh === null) return null;
  if (wh === undefined) return undefined;
  const [a, b] = wh;
  const landscape = page.orientation === "landscape";
  return landscape === a > b ? { w: a, h: b } : { w: b, h: a };
}

/** 编辑器用的边距 `[上, 右, 下, 左]`（pt）。没写或写得不全返回 undefined（= 各排版器自己的缺省）。 */
export function pageMargins(page: PageDecl): [number, number, number, number] | undefined {
  const m = page.margin;
  if (m === undefined) return undefined;
  if (typeof m === "number") return [m, m, m, m];
  if (m.length !== 4 || m.some((v) => !Number.isFinite(v) || v < 0)) return undefined;
  return [m[0]!, m[1]!, m[2]!, m[3]!];
}

/** 尺寸（pt）→ 纸张声明：标准纸（±2pt，横竖都认）记纸名 + 方向，其余记自定义尺寸。 */
export function pageDeclOfSize(w: number, h: number): PageDecl {
  const std = standardPaperOf(w, h);
  if (std) return { paper: std.name, orientation: std.landscape ? "landscape" : "portrait" };
  const [a, b] = w > h ? [h, w] : [w, h];
  return { paper: CUSTOM_PAPER, size: [a, b], orientation: w > h ? "landscape" : "portrait" };
}

/** 谱里自带的纸 → 纸张声明（MusicXML `<page-layout>` 优先，其次 123/ABC 的 `I:meta page …`，见 `model/pagemeta.ts`）。 */
export function songPageDecl(song: Song): PageDecl | null {
  const page = songPage(song);
  if (!page) return null;
  const decl = pageDeclOfSize(page.w, page.h);
  if (page.margins) decl.margin = [...page.margins];
  return decl;
}

/** 曲内层：谱里自带的纸作为一条不带限定的规则。 */
export function docPageLayer(song: Song | undefined): StyleRule[] {
  const page = song ? songPageDecl(song) : null;
  return page ? [{ set: { page } }] : [];
}

/**
 * 版面层：123 `%%layout` 写的纸与音符字号（规范 123格式 §9.1）→ 一条不带限定的规则。
 * 投影系的纸是投影片比例（`16:9` / `4:3`），其余是纸名（`PAPER_SIZES`）加方向；五线谱系的 `note-size` 不认（谱表大小另有一套）。
 * 级联里排在面板的不限定那层之后、按版面限定的用户规则之前：版面写明的纸与字号不被基础档的面板设置盖掉，面板在这个版面里再改的照改。
 */
export function layoutSpecLayer(spec: LayoutSpec | undefined, kind: "projection" | "print" | "staff"): StyleRule[] {
  if (!spec) return [];
  const set: DeepPartial<StyleSheet> = {};
  if (spec.paper) {
    if (kind === "projection") {
      const r = PAGE_RATIOS[spec.paper];
      if (r) set.page = { size: [...r] };
    } else if (PAPER_SIZES[spec.paper] !== undefined) {
      const o = spec.pageOrientation;
      set.page = { paper: spec.paper, ...(o === "portrait" || o === "landscape" ? { orientation: o } : {}) };
    }
  }
  if (spec.noteSize && kind !== "staff") set.roles = { note: { size: spec.noteSize } };
  return Object.keys(set).length ? [{ set }] : [];
}
