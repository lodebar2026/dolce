// 量字后端的装配与缓存。排版在 Rust（dolce-wasm 同步回调这里装的后端；桌面版原生排版用系统量字，不经这里）：
//   - `measure.browser.ts`  浏览器：SVG getComputedTextLength + canvas 墨迹（app 缺省，「在哪测量就在哪绘制」）；
//   - `cli/textmeasure.node.ts`  Node：原生模块（系统文字引擎 + Rust 的浏览器口径层，`cli/engrave.ts` 装配）。
// TS 这边直接量的只剩两处：识别叠加层的字宽、导出 PPTX 文本框的字体度量。本文件**无 DOM 依赖**。

import { Rect } from "./geom";

export interface TextMetrics {
  width: number;
  /** tight bounding box of the rendered text, baseline at y=0 */
  bbox: Rect;
}

export type FontStyle = "normal" | "italic";
export type FontWeight = "normal" | "bold";
export type FeatureList = readonly string[];

/** 测量后端：只管「这串字在这个字体下多宽、墨在哪」，不缓存（缓存在本文件）。 */
export interface MeasureBackend {
  /** 一串字的 advance 与墨迹盒（相对落笔点，基线 y = 0，向下为正）。`features` 开 OpenType 特性（`chws`/`halt`）。 */
  glyph(text: string, family: string, size: number, weight: FontWeight, features: FeatureList | undefined, style: FontStyle): TextMetrics;
  /** 开着 `features` 排这串字的逐**码点**落笔点与总宽（shaping/GPOS 之后）。 */
  positions(text: string, family: string, size: number, weight: FontWeight, features: FeatureList): { xs: number[]; width: number };
  /** 字体全局 ascent（负，基线以上）/ descent（正）。 */
  fontMetrics(family: string, size: number, weight: FontWeight, style: FontStyle): { ascent: number; descent: number };
  /** SVG path `d` 的紧包围盒。 */
  pathBounds(d: string): Rect;
}

/**
 * SVG `<text>` 缺省折叠空白：ASCII 空格、制表符、换行连成一段折成一个空格，串首串尾的去掉
 *（不换行空格、全角空格不折）。浏览器量 advance 用的就是 `<text>`，画出来也是这样——
 * 不靠浏览器的后端量**宽度**前先过一遍（墨迹照原串量，同浏览器的 canvas）。整串都是空白的不折（浏览器那时改用 canvas 的宽）。
 */
export function svgCollapsedText(text: string): string {
  if (/^\s+$/.test(text)) return text;
  return text.replace(/[ \t\n\r]+/g, " ").replace(/^ | $/g, "");
}

let backend: MeasureBackend | null = null;

/** wasm 里的排版（`layout/rustlayout.ts::installLayoutHost`）：换后端、清缓存都同步过去。 */
interface WasmMeasureSync {
  set(b: MeasureBackend): void;
  clear(): void;
}
let wasmSync: WasmMeasureSync | null = null;

/** 装配测量后端（app 启动时、CLI 入口各调一次）。换后端会清掉已有缓存。 */
export function setMeasureBackend(b: MeasureBackend): void {
  backend = b;
  clearMeasureCache();
  wasmSync?.set(b);
}

/** 接上 wasm 排版的量字（已装的后端立即交过去）。 */
export function bindWasmMeasure(sync: WasmMeasureSync): void {
  wasmSync = sync;
  if (backend) sync.set(backend);
}

/** 录下的一次后端调用（`dolce-text::MeasureRecord`：`dolce measure-check` 拿原生量字逐条对）。 */
export type MeasureRecord = Record<string, unknown>;

/**
 * 给测量后端（缺省当前装的那个）套一层录制：每次调用写一条（同一调用只到后端一次，去重靠缓存）。
 * 装上即 `setMeasureBackend`（会清缓存）；返回取走已录条目的函数。宿主对账（dev `layout-node-parity.mjs`）用。
 */
export function recordMeasure(inner: MeasureBackend = be()): () => MeasureRecord[] {
  let log: MeasureRecord[] = [];
  const rect = (r: { left: number; top: number; right: number; bottom: number }) => [r.left, r.top, r.right, r.bottom];
  setMeasureBackend({
    glyph(text, family, size, weight, features, style) {
      const m = inner.glyph(text, family, size, weight, features, style);
      log.push({ op: "glyph", text, family, size, weight, features: [...(features ?? [])], style, width: m.width, bbox: rect(m.bbox) });
      return m;
    },
    positions(text, family, size, weight, features) {
      const p = inner.positions(text, family, size, weight, features);
      log.push({ op: "positions", text, family, size, weight, features: [...features], xs: [...p.xs], width: p.width });
      return p;
    },
    fontMetrics(family, size, weight, style) {
      const m = inner.fontMetrics(family, size, weight, style);
      log.push({ op: "fontMetrics", family, size, weight, style, ascent: m.ascent, descent: m.descent });
      return m;
    },
    pathBounds(d) {
      const r = inner.pathBounds(d);
      log.push({ op: "pathBounds", d, bbox: rect(r) });
      return r;
    },
  });
  return () => {
    const out = log;
    log = [];
    return out;
  };
}

function be(): MeasureBackend {
  if (!backend) throw new Error("测量后端未装配：浏览器侧应先 setMeasureBackend(browserMeasure)，Node 侧走 cli/engrave");
  return backend;
}

// Cache measurements keyed by (text, family, size, weight). Layout measures the
// same glyphs/sizes thousands of times; caching avoids repeated reflows.
const textCache = new Map<string, TextMetrics>();
const metricsCache = new Map<string, { ascent: number; descent: number }>();

/** 字体变了（加载完成、换后端）以后，之前量的数作废。 */
export function clearMeasureCache(): void {
  textCache.clear();
  metricsCache.clear();
  wasmSync?.clear();
}

export function measureGlyphText(
  text: string,
  fontFamily: string,
  fontSizePx: number,
  fontWeight: FontWeight = "normal",
  features?: FeatureList,
  fontStyle: FontStyle = "normal",
): TextMetrics {
  const sep = "\x01";
  const feat = featureSettings(features);
  // **features 必须进 key**：同一串字开不开 `chws` 宽度不同，共用一个 key 会串味。
  const key = `${fontFamily}${sep}${fontWeight}${sep}${fontStyle}${sep}${fontSizePx}${sep}${feat}${sep}${text}`;
  const cached = textCache.get(key);
  if (cached) return cached;
  const m = be().glyph(text, fontFamily, fontSizePx, fontWeight, features, fontStyle);
  textCache.set(key, m);
  return m;
}

// --- font-global metrics (ascent/descent), Skija FontMetrics convention:
//     ascent is negative (above baseline), descent positive (below) ---
export function measureFontMetrics(
  fontFamily: string,
  fontSizePx: number,
  fontWeight: FontWeight = "normal",
  fontStyle: FontStyle = "normal",
): { ascent: number; descent: number } {
  const sep = "\x01";
  const key = `${fontFamily}${sep}${fontWeight}${sep}${fontStyle}${sep}${fontSizePx}`;
  const cached = metricsCache.get(key);
  if (cached) return cached;
  const res = be().fontMetrics(fontFamily, fontSizePx, fontWeight, fontStyle);
  metricsCache.set(key, res);
  return res;
}


/** CSS `font-feature-settings` 写法（浏览器后端直接用；也当缓存 key）。 */
export function featureSettings(features?: FeatureList): string {
  if (!features || !features.length) return "";
  return features.map((f) => `"${f}" 1`).join(", ");
}
