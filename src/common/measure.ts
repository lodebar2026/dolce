// 排版期的文字/路径测量——替代 Skija 的
//   font.measureText / font.metrics / Path.computeTightBounds / font.getPath bounds。
//
// 量字本身交给注入的**测量后端**（`setMeasureBackend`），这里只留缓存与和后端无关的规则（标点挤压）：
//   - `measure.browser.ts`  浏览器：SVG getComputedTextLength + canvas 墨迹（app 缺省，「在哪测量就在哪绘制」）；
//   - `measure.font.ts`     字体文件（fontkit）：Node 回归与出图（`cli/engrave.ts` 装配），桌面版拿得到系统字体字节时也用它。
// 本文件**无 DOM 依赖**，Node 侧可以 import。

import { Rect } from "./geom";
import { compressRun, pairTrimPx, trimLeft, type CompressMode, type Slack } from "./cjkpunct";

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

/** 装配测量后端（app 启动时、CLI 入口各调一次）。换后端会清掉已有缓存。 */
export function setMeasureBackend(b: MeasureBackend): void {
  backend = b;
  clearMeasureCache();
}

function be(): MeasureBackend {
  if (!backend) throw new Error("测量后端未装配：浏览器侧应先 setMeasureBackend(browserMeasure)，Node 侧走 cli/engrave");
  return backend;
}

// Cache measurements keyed by (text, family, size, weight). Layout measures the
// same glyphs/sizes thousands of times; caching avoids repeated reflows.
const textCache = new Map<string, TextMetrics>();
const pathCache = new Map<string, Rect>();
const metricsCache = new Map<string, { ascent: number; descent: number }>();
const featureCache = new Map<string, boolean>();

/** 字体变了（加载完成、换后端）以后，之前量的数作废。 */
export function clearMeasureCache(): void {
  textCache.clear();
  pathCache.clear();
  metricsCache.clear();
  featureCache.clear();
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

/** Tight bounds of an SVG path "d" string (replaces Path.computeTightBounds). */
export function pathTightBounds(d: string): Rect {
  const cached = pathCache.get(d);
  if (cached) return cached;
  const r = be().pathBounds(d);
  pathCache.set(d, r);
  return r;
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


// ─────────────────────────────────────────── OpenType 特性
//
// 标点挤压有现成的 OpenType 特性（`chws` = CJK Contextual Half-width Spacing，
// 相邻标点自动取半角）。字体有就交给它——shaping 与渲染同一份字体；
// 没有就退回 common/cjkpunct.ts 的等效实现。两条路由 `punctTrim` 统一出口，下游只认一个数。
//
// **注意**：浏览器后端带 features 量多字串时，返回的 `width` 是挤压后的（SVG shaping 说了算），
// 而 `bbox` 来自 canvas（设不了 feature，量的是未挤压的连排）。要墨迹一律**逐字量**。

/** 一个字两侧的实际留白（advance 减墨迹）。挤压量拿它封顶——只压空白，绝不压墨。 */
export function slackOf(
  fontFamily: string,
  fontSizePx: number,
  fontWeight: FontWeight = "normal",
): Slack {
  return (ch: string) => {
    const m = measureGlyphText(ch, fontFamily, fontSizePx, fontWeight);
    return { left: m.bbox.left, right: m.width - m.bbox.right };
  };
}

/** 横排标点挤压（上下文）。竖排是 `vchw`，本项目不排竖排。 */
export const CHWS: FeatureList = ["chws"];

/** 无条件半角标点。 */
export const HALT: FeatureList = ["halt"];

/** 挤压档 → OpenType 特性。字体没有这个特性时退回 cjkpunct 的等效实现。 */
export function featuresFor(mode: CompressMode): FeatureList {
  return mode === "halfwidth" ? HALT : mode === "clreq" ? CHWS : [];
}

/** CSS `font-feature-settings` 写法（浏览器后端直接用；也当缓存 key）。 */
export function featureSettings(features?: FeatureList): string {
  if (!features || !features.length) return "";
  return features.map((f) => `"${f}" 1`).join(", ");
}

/**
 * 这个字体支不支持某个特性。开/关同一样本串比 advance——变了就是支持。
 * 样本用 `：“`（冒号 + 前引号，两截空白相接，`chws` 一定会压它）。
 */
export function hasFontFeature(
  fontFamily: string,
  feature: string,
  fontSizePx = 100,
  sample = "：“",
): boolean {
  const key = `${fontFamily}\x01${feature}`;
  const cached = featureCache.get(key);
  if (cached !== undefined) return cached;
  const on = measureGlyphText(sample, fontFamily, fontSizePx, "normal", [feature]).width;
  const off = measureGlyphText(sample, fontFamily, fontSizePx, "normal").width;
  const res = Math.abs(on - off) > 0.01;
  featureCache.set(key, res);
  return res;
}

/**
 * 一串字的逐字笔位与总宽（`xs[i]` = 第 i 个**码点**的落笔点，相对串首 0）。
 *
 * 字体带 `chws` 时取后端 shaping/GPOS 之后的真实笔位，挤压已经含在里面；不带时由 `compressRun` 按 CLREQ 自算。
 * 渲染端把这串 `xs` 原样交给 `<text>` 的 `x`，测量与绘制就一定一致。
 */
export function measureGlyphRun(
  text: string,
  fontFamily: string,
  fontSizePx: number,
  fontWeight: FontWeight = "normal",
  mode: CompressMode = "clreq",
): { xs: number[]; width: number } {
  const chars = [...text];
  if (!chars.length) return { xs: [], width: 0 };
  const features = featuresFor(mode);
  const useFeature = !!features.length && features.some((f) => hasFontFeature(fontFamily, f, fontSizePx));
  if (!useFeature) {
    const adv = (ch: string) => measureGlyphText(ch, fontFamily, fontSizePx, fontWeight).width;
    return compressRun(chars, adv, fontSizePx, mode, slackOf(fontFamily, fontSizePx, fontWeight));
  }
  const { xs, width } = be().positions(text, fontFamily, fontSizePx, fontWeight, features);
  // **起始类标点要把笔位往左挪回压掉的那截**：特性换的是半宽字形（墨已挪进半格里），
  // 而绘制端的 `<text>` 不叠特性、画的是全宽字形——它的墨在方框右半边，照特性笔位落笔就压到下一个字上
  //（`（副`、`「面` 的括号骑在字上）。收尾类与点号的墨本来就在左半边，不用挪。
  // 与不带特性那条路（`compressRun` 的 `xs.push(x - l)`）同一个口径
  chars.forEach((ch, i) => {
    if (trimLeft(ch) <= 0) return;
    const featAdv = (i + 1 < chars.length ? xs[i + 1]! : width) - xs[i]!;
    const fullAdv = measureGlyphText(ch, fontFamily, fontSizePx, fontWeight).width;
    // 差不到半个点的是字形自己的进位误差（PingFang 的 `“` 本来就是半宽字形，两者只差 0.02），不挪
    if (fullAdv - featAdv > 0.5) xs[i] = xs[i]! - (fullAdv - featAdv);
  });
  return { xs, width };
}

/**
 * 相邻两个字之间该压掉多少**像素**——标点挤压的**唯一出口**。
 *
 * 字体带 `chws` 就以它的实测量为准（`w(ab) < w(a)+w(b)` 的那个差），
 * 不带就按 CLREQ 折算。跨 `<text>` 的那一对标点（歌词逐字挂音符，前字的尾标点与
 * 后字的前引号分属两个元素，特性管不到）拿这个数当**间距下限**，见 layout.ts::calcXPos。
 */
export function punctTrim(
  prev: string,
  next: string,
  fontFamily: string,
  fontSizePx: number,
  fontWeight: FontWeight = "normal",
  mode: CompressMode = "clreq",
): number {
  if (!prev || !next || mode === "none") return 0;
  const features = featuresFor(mode);
  const feat = features.find((f) => hasFontFeature(fontFamily, f, fontSizePx));
  if (feat) {
    const w = (s: string) => measureGlyphText(s, fontFamily, fontSizePx, fontWeight, features).width;
    return Math.max(0, w(prev) + w(next) - w(prev + next));
  }
  return pairTrimPx(mode, prev, next, fontSizePx, slackOf(fontFamily, fontSizePx, fontWeight));
}
