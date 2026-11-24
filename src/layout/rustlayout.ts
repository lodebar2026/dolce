// 排版在 Rust（crates/dolce-session/src/layout.rs）：这里只管宿主装配与过边界的形状。
//
// - 两种宿主：网页 / Node 是 dolce-wasm（同步）；桌面版的异步排版走 Tauri 进程里的原生 Rust（`src-tauri/src/layout.rs`，
//   系统量字），同步的那几处（帮助页谱例、量简谱行首）仍走 wasm。排好的一份包成 `LaidHandle`，两种宿主同一个样子。
// - 量字（wasm）：wasm 里的排版同步回调 TS 的量字后端（`common/measure.ts` 装的那个：网页 `measure.browser.ts`、Node `textmeasure.node.ts`），
//   结果一律走数组（`wasmMeasure`）；缓存在 Rust 的 `MeasureCtx` 里（键同 `measure.ts`），TS 这边清缓存时一并清。
// - SMuFL 元数据：`bravura_metadata.json` 原文交给 wasm（SMuFL 字的紧包围盒）。
// - 排好的一份留在 wasm（`DolceLayoutWasm` 句柄），按页取 SVG、身份表、场景。

import { dolce } from "../common/dolce";
import type { DolceLayoutWasm, WasmMeasure } from "../common/dolcewasm";
import { asBuffer, tauriCore, type TauriCore } from "../common/tauricore";
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
  const core = tauriCore();
  bindWasmMeasure({
    set: (b) => dolce().setLayoutHost(wasmMeasure(b), smufl),
    clear: () => {
      dolce().clearMeasureCache();
      // 桌面版原生那边的量字缓存也清（网页字体载完时；原生量的是系统字体，清了无妨）
      if (core) void core.invoke("layout_clear_measure").catch(() => undefined);
    },
  });
}

// ---------------------------------------------------------------- 排好的一份

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** 交给 Rust 排的一份：哪条引擎、文档、请求（`JianpuRequest` / `StaffRequest` 的形状，见 `painter.ts::wireOf`）。 */
export interface LayoutWire {
  kind: "jianpu" | "staff";
  doc: ScoreDoc;
  req: object;
}

/** 排好的一份（两种宿主同一个样子）：概要、各页身份表、SVG 同步取；场景异步取；用完 `free`。 */
export interface LaidHandle {
  readonly info: LaidInfo;
  readonly hits: readonly SceneHit[][];
  svg(i: number): string;
  scene(i: number): Promise<Json>;
  /** 简谱定稿栅格 / 定位结构（回归脚本核对用，只有 wasm 那份同步给；原生回 null） */
  grid(): Json | null;
  placed(): Json | null;
  free(): void;
}

function wasmHandle(l: DolceLayoutWasm): LaidHandle {
  const info = JSON.parse(l.info()) as LaidInfo;
  const hits = info.pages.map((_, i) => JSON.parse(l.hits(i)) as SceneHit[]);
  const parsed = (s: string): Json | null => (s ? (JSON.parse(s) as Json) : null);
  return {
    info,
    hits,
    svg: (i) => l.svg(i),
    scene: (i) => Promise.resolve(JSON.parse(l.scene(i)) as Json),
    grid: () => parsed(l.gridJson()),
    placed: () => parsed(l.placedJson()),
    free: () => l.free(),
  };
}

/** 同步排（wasm）。 */
export function layoutSync(w: LayoutWire): LaidHandle {
  const { json, h } = docJson(w.doc);
  const req = JSON.stringify(w.req);
  return wasmHandle(w.kind === "staff" ? dolce().layoutStaff(json, h, req) : dolce().layoutJianpu(json, req));
}

/** 异步排：桌面版走原生，别处同 `layoutSync`。 */
export async function layoutAsync(w: LayoutWire): Promise<LaidHandle> {
  const core = tauriCore();
  return core ? nativeLayout(core, w) : layoutSync(w);
}

/** 宿主对账（dev `layout-node-parity.mjs`）：一份请求录成 `dolce-dev layout-wire` 吃的一行（表层快照写 hex）。 */
export function wireDump(w: LayoutWire, key: string, cfg: string): string {
  const { json, h } = docJson(w.doc);
  let surface: string | null = null;
  if (w.kind === "staff" && h) {
    const b = dolce().modelSurfaceSnapshot(h);
    surface = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  return JSON.stringify({ key, cfg, kind: w.kind, doc: json, req: JSON.stringify(w.req), surface });
}

/** 宿主对账：同一份请求在本页的 wasm 上（本页量字后端）同步排一遍，回各页 SVG。 */
export function wasmPages(w: LayoutWire): string[] {
  const l = layoutSync(w);
  try {
    return l.info.pages.map((_, i) => l.svg(i));
  } finally {
    l.free();
  }
}

/** 原生那边已有的表层代号（句柄 → 代号）；原生按最近用到的淘汰，排版报「没有表层」时作废重送。 */
const nativeSurfaces = new Map<number, number>();

async function sendSurface(core: TauriCore, h: number): Promise<void> {
  const gen = dolce().modelSurfaceGen(h);
  if (nativeSurfaces.get(h) === gen) return;
  await core.invoke("layout_surface", dolce().modelSurfaceSnapshot(h), { headers: { h: String(h), gen: String(gen) } });
  nativeSurfaces.set(h, gen);
}

async function nativeLayout(core: TauriCore, w: LayoutWire): Promise<LaidHandle> {
  const { json, h } = docJson(w.doc);
  const surface = w.kind === "staff" ? h : 0;
  const args = { kind: w.kind, doc: json, surface, req: JSON.stringify(w.req) };
  let raw: ArrayBuffer;
  if (surface) await sendSurface(core, surface);
  try {
    raw = asBuffer(await core.invoke("layout_run", args));
  } catch (e) {
    if (!surface || !String(e).includes("没有表层")) throw e;
    nativeSurfaces.delete(surface);
    await sendSurface(core, surface);
    raw = asBuffer(await core.invoke("layout_run", args));
  }
  const r = JSON.parse(new TextDecoder().decode(raw)) as { id: number; info: LaidInfo; svgs: string[]; hits: SceneHit[][] };
  const get = async (what: string, i: number): Promise<Json> =>
    JSON.parse(new TextDecoder().decode(asBuffer(await core.invoke("layout_get", { id: r.id, what, i })))) as Json;
  return {
    info: r.info,
    hits: r.hits,
    svg: (i) => r.svgs[i] ?? "",
    scene: (i) => get("scene", i),
    grid: () => null,
    placed: () => null,
    free: () => void core.invoke("layout_free", { id: r.id }).catch(() => undefined),
  };
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
  /** 本地坐标 → 页面坐标（SVG 用户坐标）的仿射 `[a, c, e, b, d, f]`：x' = a·x + c·y + e，y' = b·x + d·y + f */
  m?: [number, number, number, number, number, number];
  /** 页面坐标的排版盒 `[left, top, right, bottom]`（子树各图元 `bound` 的并：文字取字体盒，同 DOM `getBBox`）；什么都没画时缺 */
  bound?: [number, number, number, number];
  /** 页面坐标的墨迹盒（文字按字形实量、SMuFL 字按元数据紧盒、线与路径同排版盒） */
  ink?: [number, number, number, number];
}

/** 一页的几何（原生坐标宽高；一个原生单位合多少 pt：简谱 1，五线谱取谱里的 scaling）。 */
export interface LaidPage {
  w: number;
  h: number;
  ptPerUnit: number;
  song: number;
  /** 整页画出来的墨迹盒 `[left, top, right, bottom]`（页面坐标）；空页缺 */
  ink?: [number, number, number, number];
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

/** 按参照歌词生成的段落与演唱顺序（Rust `dolce_session::sing::fit_report`）。 */
export interface SingFitReport {
  /** 段落标记：段名、插在哪个和弦前（整套换掉谱里原有的） */
  marks: { name: string; before: ElementId }[];
  /** `%%sing` 原文（一遍一行）；对不上时为空串 */
  sing: string;
  notes: SingFitNote[];
  refChars: number;
  matched: number;
}

/** 生成时发现的差异：`refExtra` 歌词多出、`scoreExtra` 谱面多出、`mismatch` 字不同、`offScore` 不照谱面反复走、`noMatch` 整篇对不上 */
export interface SingFitNote {
  kind: "refExtra" | "scoreExtra" | "mismatch" | "offScore" | "noMatch";
  bar?: number;
  ref?: string;
  score?: string;
  context?: string;
  fromBar?: number;
}

/** 按参照歌词给第 `song` 首生成段落标记与 `%%sing`；分遍要试排投影档（`style` 是投影档样式表）。桌面版走原生排版线程，别处走 wasm。 */
export async function singFromLyrics(doc: ScoreDoc, song: number, lyrics: string, style: StyleSheet): Promise<SingFitReport> {
  const { json } = docJson(doc);
  const req = JSON.stringify({ view: "expanded", style });
  const core = tauriCore();
  const raw = core
    ? new TextDecoder().decode(asBuffer(await core.invoke("layout_sing_from_lyrics", { doc: json, song, lyrics, req })))
    : dolce().singFromLyrics(json, song, lyrics, req);
  return JSON.parse(raw) as SingFitReport;
}
