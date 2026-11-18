// 排版在 Rust（crates/dolce-session/src/layout.rs，经 dolce-wasm）：这里只管宿主装配与过边界的形状。
//
// - 量字：wasm 里的排版同步回调 TS 的量字后端（`common/measure.ts` 装的那个：网页 `measure.browser.ts`、Node `textmeasure.node.ts`），
//   结果一律走数组（`wasmMeasure`）；缓存在 Rust 的 `MeasureCtx` 里（键同 `measure.ts`），TS 这边清缓存时一并清。
// - SMuFL 元数据：`bravura_metadata.json` 原文交给 wasm（SMuFL 字的紧包围盒）。
// - 排好的一份留在 wasm（`DolceLayoutWasm` 句柄），按页取 SVG、身份表、场景。

import { dolce } from "../common/dolce";
import type { WasmMeasure } from "../common/dolcewasm";
import { bindWasmMeasure, type MeasureBackend } from "../common/measure";
import type { ElementId, ScoreDoc } from "../model/doc";
import { docJson } from "../model/rustdoc";
import type { StyleSheet } from "../style/sheet";
import type { PlayItem } from "../score/playtypes";

const weight = (bold: boolean): "bold" | "normal" => (bold ? "bold" : "normal");
const fstyle = (italic: boolean): "italic" | "normal" => (italic ? "italic" : "normal");

/** TS 量字后端 → wasm 要的形状（数组进出）。特性表空串 = 不开（同 TS 的 `undefined`）。 */
export function wasmMeasure(b: MeasureBackend): WasmMeasure {
  const feats = (f: string): string[] | undefined => (f ? f.split(",") : undefined);
  return {
    glyph(text, family, size, bold, features, italic) {
      const m = b.glyph(text, family, size, weight(bold), feats(features), fstyle(italic));
      return Float64Array.of(m.width, m.bbox.left, m.bbox.top, m.bbox.right, m.bbox.bottom);
    },
    positions(text, family, size, bold, features) {
      const p = b.positions(text, family, size, weight(bold), feats(features) ?? []);
      const out = new Float64Array(p.xs.length + 1);
      out.set(p.xs);
      out[p.xs.length] = p.width;
      return out;
    },
    fontMetrics(family, size, bold, italic) {
      const m = b.fontMetrics(family, size, weight(bold), fstyle(italic));
      return Float64Array.of(m.ascent, m.descent);
    },
    pathBounds(d) {
      const r = b.pathBounds(d);
      return Float64Array.of(r.left, r.top, r.right, r.bottom);
    },
  };
}

/** 装排版宿主：wasm 已载入、SMuFL 元数据原文在手之后调一次（网页 `main.ts`、Node `cli/engrave.ts`）。
 *  之后 TS 换量字后端（`setMeasureBackend`）、清缓存（`clearMeasureCache`）都跟着同步到 wasm。 */
export function installLayoutHost(smufl: string): void {
  bindWasmMeasure({
    set: (b) => dolce().setLayoutHost(wasmMeasure(b), smufl),
    clear: () => dolce().clearMeasureCache(),
  });
}

/** 五线谱的断句尺子（乐句档五线谱按它断句）：`doc`（不带换行投出来、`sourceIds` 读回的那份）按五线谱引擎排一遍，
 *  各和弦的自然横向区间（键是源元素 id）与版心宽（Rust `dolce_session::layout::staff_chord_spans`）。 */
export function staffChordSpans(
  doc: ScoreDoc,
  style: StyleSheet,
  page: { widthPt: number; heightPt: number | null } | null,
): { width: number; byId: Map<ElementId, { x0: number; x1: number }> } {
  const { json, h } = docJson(doc);
  const r = JSON.parse(dolce().staffChordSpans(json, h, JSON.stringify({ style, page }))) as { width: number; spans: [ElementId, number, number][] };
  return { width: r.width, byId: new Map(r.spans.map(([id, x0, x1]) => [id, { x0, x1 }] as const)) };
}

// ---------------------------------------------------------------- 过边界的形状

/** 身份标签（`crates/dolce-scene` 的 `Identity`；字段同 `pagetree/identity.ts::ItemIdentity`）。 */
export interface SceneIdentity {
  kind: "note" | "sustain" | "barline" | "slur" | "syllable" | "system" | "harmony" | "deco" | "annotation" | "aug-dot" | "header";
  id?: ElementId;
  pass?: number;
  verse?: number;
  edge?: "before" | "after";
  measure?: number;
  also?: ElementId[];
  end?: ElementId;
}

/** 身份表一项（`dolce_scene::index::Hit`）：带身份或页眉类名的节点，对上 SVG 里的元素先序号 `el`。 */
export interface SceneHit {
  /** `<svg>` 之下的元素先序号（`getElementsByTagName("*")` 的下标）；没画出来为 -1 */
  el: number;
  /** 最近一个也在表里的祖先（本表下标）；没有为 -1 */
  up: number;
  id?: SceneIdentity;
  hdr?: "hdr" | "hdr-keysig" | "hdr-time";
  text?: string;
  data?: Record<string, number>;
}

/** 一页的几何（原生坐标宽高；一个原生单位合多少 pt：简谱 1，五线谱取谱里的 scaling）。 */
export interface LaidPage {
  w: number;
  h: number;
  ptPerUnit: number;
  song: number;
}

/** 排好的一份的概要（`dolce_session::layout::LaidInfo`）。 */
export interface LaidInfo {
  renderer: "jianpu" | "staff";
  title: string;
  pages: LaidPage[];
  /** 简谱各行首音（行序，投影档可能重复）；五线谱为 null */
  lineStarts: ElementId[] | null;
  /** 投影档各首实际走的演唱顺序 */
  plans?: (PlayItem[] | null)[];
  digitFontSize?: number;
  /** 简谱：附点离数字的那道空（导出 PPTX 重摆附点） */
  stackGap?: number;
}
