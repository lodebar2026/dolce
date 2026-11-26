// MusicXML **表层**：`ScoreDoc` 之外的旁表，装 MusicXML 独有、别的格式与排版器都不读的东西。
//
// ## 为什么不进 `ScoreDoc`
//
// 版面坐标（`default-x/-y`、`relative-x/-y`）、小节宽、符干、对齐、字体、`<system-layout>`、`<staff-details>`、
// slur 贝塞尔、`<supports>`、`repeat winged`……只有两个用处：`.musicxml` 改动后整份重写不丢、五线谱引擎照原版面排。
// 所以不存进模型、经查询层取（简谱的是 `jianpu.ts`，那边是由语义派生，这边是从原文现读）。
//
// 表层在 Rust（crates/model/src/xmlsurface.rs）：读入时每个模型对象按身份（`_oid`）绑到原节点，原树与绑定表留在 Rust 里，
// 这里的查询按镜像对象的身份（`rustdoc.ts` 的旁表）去问。克隆出来的对象没有身份（= 文本来源），一律照常。
// 导出时五线谱引擎排出来的版面（`editor/xmllayout.ts`）是另一个来源，在 Rust 里排好直接交给写出端（`EngravedLayout`）。

import type { Chord, FontSpec, HAlign, Measure, MeasureAttrs, Note, Print, ScoreDoc, Song } from "./doc";
import { dolce } from "../common/dolce";
import { boundOf } from "./rustdoc";

/** 版面坐标（tenths，口径同 MusicXML 的 `default-x/-y`、`relative-x/-y`）。 */
export interface Position {
  defaultX?: number;
  defaultY?: number;
  relativeX?: number;
  relativeY?: number;
}

/** `<print>` 里的版式（系统与谱表间距）。 */
export interface PrintLayout {
  systemLayout?: { systemDistance?: number; topSystemDistance?: number; leftMargin?: number; rightMargin?: number };
  /** `<staff-layout number>`：本系统各谱表离上一谱表的距离 */
  staffLayouts?: { staff?: number; staffDistance?: number }[];
}

export type StemDir = "up" | "down" | "none" | "double";

/** 有表层的对象问一样东西（没有表层回 null） */
function ask<T>(obj: object | null | undefined, what: string): T | null {
  const b = boundOf(obj);
  if (!b?.s) return null;
  return JSON.parse(dolce().modelSurface(b.s.h, what, b.oid)) as T | null;
}

const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

/** 原文的版面坐标：`Note`（所在 `<note>`）、无音的 `Chord`、`Lyric`、`Harmony`、`DirectionPart`。 */
export function xmlPos(obj: object | null | undefined): Position | undefined {
  return opt(ask<Position>(obj, "pos"));
}

/** `<wedge spread>`（tenths，开口那一端的开口高）。 */
export function wedgeSpread(obj: object | null | undefined): number | undefined {
  return opt(ask<number>(obj, "spread"));
}

/** `<measure width>`（tenths）。 */
export function measureWidth(m: Measure): number | undefined {
  return opt(ask<number>(m, "width"));
}

/** `<stem>` 的方向与 `default-y`（符干末端）。 */
export function noteStem(note: Note | null | undefined): { dir: StemDir; y?: number } | undefined {
  return opt(ask<{ dir: StemDir; y?: number }>(note, "stem"));
}

/** `justify` / `halign` / `valign`（`Lyric`、`DirectionPart`）。 */
export function xmlAlign(obj: object): { justify?: HAlign; halign?: HAlign; valign?: string } {
  return ask<{ justify?: HAlign; halign?: HAlign; valign?: string }>(obj, "align") ?? {};
}

/** 把「族名 + 字面名」的全名（`宋体-简 常规体`、`楷体-简 粗体`）拆回族名与字重/字形。
 *  浏览器与系统文字引擎都只按族名匹配，全名一个都认不出、落到回退字体。逗号分开的每一项各拆；
 *  属性里已写的字重/字形优先；只有一个词（`黑体`）不拆。 */
export function splitFaceName(f: FontSpec): FontSpec {
  if (!f.family) return f;
  return JSON.parse(dolce().modelSplitFaceName(JSON.stringify(f))) as FontSpec;
}

/** 文字的字体属性：`Lyric` 取首个 `<text>`，`DirectionPart` 取它那条子元素。 */
export function xmlFont(obj: object): FontSpec | undefined {
  return opt(ask<FontSpec>(obj, "font"));
}

/** `<attributes>` 里的 `<staff-details number print-object>`。 */
export function staffDetailsOf(attrs: MeasureAttrs | undefined): { staff?: number; printObject?: boolean }[] {
  return ask<{ staff?: number; printObject?: boolean }[]>(attrs, "staffDetails") ?? [];
}

/** `<attributes>` 里的 `<part-symbol top-staff bottom-staff>`：多谱表声部左侧的符号。没写返回 undefined（规范缺省为 brace）。 */
export function partSymbolOf(attrs: MeasureAttrs | undefined): { symbol: string; top?: number; bottom?: number } | undefined {
  return opt(ask<{ symbol: string; top?: number; bottom?: number }>(attrs, "partSymbol"));
}

/** 原文 `<print>` 的系统与谱表间距。 */
export function printLayout(p: Print | undefined): PrintLayout | undefined {
  return opt(ask<PrintLayout>(p, "print"));
}

/** `<defaults>` 里模型不存的两种字体（五线谱引擎用：记号字号、文字缺省字体）。 */
export function defaultsFonts(song: Song): { musicFont?: FontSpec; wordFont?: FontSpec } {
  return ask<{ musicFont?: FontSpec; wordFont?: FontSpec }>(song, "defaultsFonts") ?? {};
}

/** 元素上原文写的 `id`（识别 id，`omrlinks.ts`）：`slot` 取弧的起止两端。 */
export function surfaceId(obj: object | null | undefined, slot?: "start" | "stop"): string | undefined {
  return opt(ask<string>(obj, slot === "start" ? "idStart" : slot === "stop" ? "idStop" : "id"));
}

/** `.musicxml` 的源码同步索引（`editor/sync.ts::SyncIndex.buildXml`）：条目区间取表层原节点记的区间，按推入次序给。
 *  模型不是读进来的那份、或原节点对不上这份原文为 null（宁可不能编辑，也不按错位的偏移改）。 */
export function xmlSyncOf<E, B>(doc: ScoreDoc, text: string): { entries: E[]; breaks: B[] } | null {
  const b = boundOf(doc.songs[0]);
  if (!b?.s) return null;
  return JSON.parse(dolce().modelXmlSync(b.s.h, text)) as { entries: E[]; breaks: B[] } | null;
}

/** 把识别 id 写进各对象原节点的 `id`（`omrlinks.ts::stampXmlIds`），回写好的整份 XML；一个也没写上（都没有表层）为 null。 */
export function stampSurfaceIds(stamps: readonly [object, string][]): string | null {
  let h = 0;
  const oids: number[] = [];
  const ids: string[] = [];
  for (const [o, id] of stamps) {
    const b = boundOf(o);
    if (!b?.s) continue;
    h ||= b.s.h;
    if (b.s.h !== h) continue;
    oids.push(b.oid);
    ids.push(id);
  }
  return h ? dolce().modelStampIds(h, Uint32Array.from(oids), ids) ?? null : null;
}

/** 这份 MusicXML 是否自带版面坐标（任一小节有 width 或任一音符有 default-x）。 */
export function hasEmbeddedLayout(song: Song): boolean {
  const measures: number[] = [];
  const positioned: number[] = [];
  let h = 0;
  const oid = (o: object): number => {
    const b = boundOf(o);
    if (!b?.s) return 0;
    h ||= b.s.h;
    return b.s.h === h ? b.oid : 0;
  };
  for (const part of song.parts) {
    for (const m of part.measures) {
      measures.push(oid(m));
      for (const el of m.elements) {
        if (el.kind !== "chord") continue;
        if (el.notes.length === 0) positioned.push(oid(el));
        else for (const n of el.notes) positioned.push(oid(n));
      }
    }
  }
  return h !== 0 && dolce().modelHasEmbeddedLayout(h, Uint32Array.from(measures), Uint32Array.from(positioned));
}

// ───────────────────────── 编辑后作废的表层 ─────────────────────────
//
// 谱面上改谱时，原节点上有些版面信息跟着改动失效。作废在 Rust 的编辑动作里做（`EditCmd` 带着钩子开关）；
// 这两个只作钩子的记号交给编辑门面（`edit.ts`），表示「这次改动要作废表层」。

/** 音高变了：这个和弦各音原文的符干方向（`<stem>`）与纵坐标（`default-y`）作废，交给五线谱引擎按新音高推。 */
export function forgetNoteLayout(_chord: Chord): void {
  // 只当钩子记号用：见上
}

/** 小节内容变了（增删音、改时值、拆并小节）：整曲的版面坐标作废——小节宽与音符横坐标一律去掉。 */
export function dropEmbeddedLayout(_song: Song): void {
  // 只当钩子记号用：见上
}
