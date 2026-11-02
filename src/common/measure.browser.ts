// 浏览器测量后端（app 缺省）：SVG getComputedTextLength / getStartPositionOfChar 给 advance 与笔位，
// canvas measureText（WebKit 下逐像素）给墨迹。"Measure where you draw": the same browser engine
// renders the live score SVG, so measurement and rendering agree.
// **只许进浏览器入口的 import 链**（`main.ts` 装配、编辑器叠层直接用 `inkOf`）。

import { Rect } from "./geom";
import {
  clearMeasureCache, featureSettings,
  type FeatureList, type FontStyle, type FontWeight, type MeasureBackend, type TextMetrics,
} from "./measure";

const SVG_NS = "http://www.w3.org/2000/svg";

let measureSvg: SVGSVGElement | null = null;
let measureText: SVGTextElement | null = null;
let measurePath: SVGPathElement | null = null;

function ensureMeasureSvg(): SVGSVGElement {
  if (measureSvg && measureSvg.isConnected) return measureSvg;
  measureSvg =
    (document.getElementById("measure-svg") as SVGSVGElement | null) ?? null;
  if (!measureSvg) {
    measureSvg = document.createElementNS(SVG_NS, "svg");
    measureSvg.id = "measure-svg";
    measureSvg.setAttribute("width", "0");
    measureSvg.setAttribute("height", "0");
    measureSvg.style.position = "absolute";
    measureSvg.style.left = "-9999px";
    measureSvg.style.top = "-9999px";
    document.body.appendChild(measureSvg);
  }
  measureText = null;
  measurePath = null;
  return measureSvg;
}

function textEl(): SVGTextElement {
  const svg = ensureMeasureSvg();
  if (!measureText || !measureText.isConnected) {
    measureText = document.createElementNS(SVG_NS, "text");
    svg.appendChild(measureText);
  }
  return measureText;
}

// Canvas context used for tight glyph bounds via actualBoundingBox*.
// SVG getBBox() returns the full line box for CJK fonts, not the tight glyph
// outline. Canvas actualBoundingBoxAscent/Descent matches Skija getPath bounds.
let glyphCtx: CanvasRenderingContext2D | null = null;

/** Build a Canvas/FontFaceSet font shorthand without turning an entire CSS
 * fallback list into one (non-existent) quoted family name. */
function cssFontShorthand(fontFamily: string, fontSizePx: number, fontWeight: FontWeight, fontStyle: FontStyle = "normal"): string {
  const family = fontFamily.split(",").map((part) => {
    const name = part.trim().replace(/^(['"])(.*)\1$/, "$2");
    return /^(?:sans-serif|serif|monospace|system-ui)$/i.test(name)
      ? name
      : `"${name.replace(/(["\\])/g, "\\$1")}"`;
  }).join(", ");
  return `${fontStyle === "italic" ? "italic " : ""}${fontWeight} ${fontSizePx}px ${family}`;
}

/** 一串字的墨迹盒（相对落笔点，基线 y = 0，向下为正）。`ctx.font` 由调用方设好。 */
export interface InkBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * WebKit（macOS 桌面版的 WKWebView、Safari）的 `measureText` 不给真墨迹：`actualBoundingBoxLeft` 恒 0、`Right` 是前进宽度，
 * 上下沿截到基线（「-」的下沿报 0 而不是 −0.22 em）——增时线按「-」的墨迹高画就粗了好几倍，数字、标点的横向墨迹也全错。
 * 首次用到时拿「-」探一下，是这种实现就改成**画到离屏画布上逐像素量**（按字体与字缓存）。Chromium 照用 `measureText`。
 */
let inkByPixels: boolean | null = null;
const pixelInkCache = new Map<string, InkBox>();
let pixelCanvas: HTMLCanvasElement | null = null;

function needsPixelInk(ctx: CanvasRenderingContext2D): boolean {
  if (inkByPixels !== null) return inkByPixels;
  const saved = ctx.font;
  ctx.font = "100px sans-serif";
  const m = ctx.measureText("-");
  ctx.font = saved;
  inkByPixels = m.actualBoundingBoxDescent >= 0 && m.actualBoundingBoxLeft === 0;
  return inkByPixels;
}

/** 量墨迹：`measureText` 可信就用它，否则逐像素（见 `needsPixelInk`）。`ctx.font` 是要量的那种字。 */
export function inkOf(ctx: CanvasRenderingContext2D, text: string): InkBox {
  const m = ctx.measureText(text);
  if (!needsPixelInk(ctx)) {
    return { left: -m.actualBoundingBoxLeft, right: m.actualBoundingBoxRight, top: -m.actualBoundingBoxAscent, bottom: m.actualBoundingBoxDescent };
  }
  const key = `${ctx.font}\x01${text}`;
  const hit = pixelInkCache.get(key);
  if (hit) return hit;
  // 放大到约 200px 画（边缘误差 < 0.5%），量完按比例折回
  const px = Number(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] ?? 16);
  const k = 200 / Math.max(1, px);
  const pad = 200;
  const w = Math.ceil(m.width * k) + pad * 2;
  const h = pad * 3;
  pixelCanvas ??= document.createElement("canvas");
  pixelCanvas.width = w;
  pixelCanvas.height = h;
  const c = pixelCanvas.getContext("2d", { willReadFrequently: true })!;
  c.clearRect(0, 0, w, h);
  c.font = ctx.font.replace(/(\d+(?:\.\d+)?)px/, `${px * k}px`);
  c.fillStyle = "#000";
  c.textBaseline = "alphabetic";
  const ox = pad, oy = pad * 2;
  c.fillText(text, ox, oy);
  const data = c.getImageData(0, 0, w, h).data;
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3]! < 128) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const box: InkBox = x1 < 0
    ? { left: 0, right: 0, top: 0, bottom: 0 }
    : { left: (x0 - ox) / k, right: (x1 + 1 - ox) / k, top: (y0 - oy) / k, bottom: (y1 + 1 - oy) / k };
  pixelInkCache.set(key, box);
  return box;
}

function glyph(
  text: string,
  fontFamily: string,
  fontSizePx: number,
  fontWeight: FontWeight,
  features: FeatureList | undefined,
  fontStyle: FontStyle,
): TextMetrics {
  const t = textEl();
  t.setAttribute("x", "0");
  t.setAttribute("y", "0");
  t.setAttribute("font-family", fontFamily);
  t.setAttribute("font-size", String(fontSizePx));
  t.setAttribute("font-weight", fontWeight);
  t.setAttribute("font-style", fontStyle);
  // font-feature-settings 在 SVG 1.1 里不是 presentation attribute，只能走 style。
  t.style.fontFeatureSettings = featureSettings(features);
  t.textContent = text;

  let width = t.getComputedTextLength();

  // Use Canvas actualBoundingBox* for tight glyph bounds.
  // getBBox() on SVG <text> returns the full em/line box for CJK fonts (e.g.
  // "." in PingFang SC measures the same height as "1"), causing octave dots
  // to be placed far above their correct position.
  // Horizontally the ink box is NOT 0..advance: PingFang SC's "1" is a narrow
  // proportional glyph whose ink centre sits 3.1% of an em left of its advance
  // centre, which visibly offsets anything centred on it (octave dots, slur
  // ends, tuplet brackets). actualBoundingBoxLeft/Right come free from the same
  // measureText() call, so keep them.
  let bboxTop: number;
  let bboxBottom: number;
  let inkLeft = 0;
  let inkRight = width;
  if (!glyphCtx) {
    const c = document.createElement("canvas");
    glyphCtx = c.getContext("2d");
  }
  if (glyphCtx) {
    glyphCtx.font = cssFontShorthand(fontFamily, fontSizePx, fontWeight, fontStyle);
    const cm = glyphCtx.measureText(text);
    const ink = inkOf(glyphCtx, text);
    // **整串都是空白时 `getComputedTextLength()` 恒为 0**（浏览器把纯空白的文本节点当空的，
    // 加 `xml:space="preserve"` 也一样）。于是「空格」这个字的 advance 被量成 0，逐字量
    // advance 的那条路（`compressRun`，字体没有 chws 之类特性时走它）就把
    // 「John Laudon 词曲」排成「JohnLaudon词曲」。canvas 的 measureText 对空白是准的，拿它兜底。
    if (/^\s+$/.test(text)) width = cm.width;
    bboxTop = ink.top;
    bboxBottom = ink.bottom;
    inkLeft = ink.left;
    inkRight = ink.right;
  } else {
    const b = t.getBBox();
    bboxTop = b.y;
    bboxBottom = b.y + b.height;
  }
  return { width, bbox: new Rect(inkLeft, bboxTop, inkRight, bboxBottom) };
}

function positions(
  text: string,
  fontFamily: string,
  fontSizePx: number,
  fontWeight: FontWeight,
  features: FeatureList,
): { xs: number[]; width: number } {
  const t = textEl();
  t.setAttribute("x", "0");
  t.setAttribute("y", "0");
  t.setAttribute("font-family", fontFamily);
  t.setAttribute("font-size", String(fontSizePx));
  t.setAttribute("font-weight", fontWeight);
  t.style.fontFeatureSettings = featureSettings(features);
  // **不能让浏览器折叠空白**：默认 `white-space` 下「十架 归」里的空格不成字，
  // 逐字取笔位时 `getStartPositionOfChar` 的下标就越界（IndexSizeError），
  // 且其后每个字的笔位都错位一格。
  t.style.whiteSpace = "pre";
  t.textContent = text;
  const xs: number[] = [];
  const n = t.getNumberOfChars();
  let u16 = 0;
  for (const ch of text) {
    // 仍越界（浏览器把某几个码元合成一个字位）时按上一笔位顺延，不抛
    xs.push(u16 < n ? t.getStartPositionOfChar(u16).x : (xs[xs.length - 1] ?? 0));
    u16 += ch.length;
  }
  const width = t.getComputedTextLength();
  t.style.fontFeatureSettings = "";
  t.style.whiteSpace = "";
  return { xs, width };
}

let metricsCtx: CanvasRenderingContext2D | null = null;

function fontMetrics(
  fontFamily: string,
  fontSizePx: number,
  fontWeight: FontWeight,
  fontStyle: FontStyle,
): { ascent: number; descent: number } {
  if (!metricsCtx) {
    const c = document.createElement("canvas");
    metricsCtx = c.getContext("2d");
  }
  let res = { ascent: -fontSizePx * 0.8, descent: fontSizePx * 0.2 };
  if (metricsCtx) {
    metricsCtx.font = cssFontShorthand(fontFamily, fontSizePx, fontWeight, fontStyle);
    const m = metricsCtx.measureText("Mg");
    const asc = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent;
    const desc = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent;
    if (asc !== undefined && desc !== undefined) {
      res = { ascent: -asc, descent: desc };
    }
  }
  return res;
}

function pathBounds(d: string): Rect {
  const svg = ensureMeasureSvg();
  if (!measurePath || !measurePath.isConnected) {
    measurePath = document.createElementNS(SVG_NS, "path");
    svg.appendChild(measurePath);
  }
  measurePath.setAttribute("d", d);
  const b = measurePath.getBBox();
  return new Rect(b.x, b.y, b.x + b.width, b.y + b.height);
}

export const browserMeasure: MeasureBackend = { glyph, positions, fontMetrics, pathBounds };

/** Resolve when the given font families are loaded so measurement is accurate. */
export async function ensureFontsReady(
  families: Array<{ family: string; size: number }>,
): Promise<void> {
  if (!("fonts" in document)) return;
  try {
    await Promise.all(
      families.map((f) => document.fonts.load(cssFontShorthand(f.family, f.size, "normal"))),
    );
    await document.fonts.ready;
  } catch {
    /* font load failures fall back to whatever the engine substitutes */
  }
  // Fonts changing invalidates earlier measurements.
  clearMeasureCache();
}
