// Node 侧的测量后端装配：
//   - macOS / Windows：原生模块 `native/textmeasure`（CoreText / DirectWrite，`npm run build:native`）；
//   - 其它平台，或原生模块没编：退回字体文件后端（common/measure.font.ts + cli/fontfile.node.ts）。
// 两条路都按浏览器的口径对齐：CSS 族串里的泛称按浏览器缺省展开，字体全局度量按浏览器取整与修正。
// **只许进 Node 入口（cli/*）的 import 链。**

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Rect } from "../common/geom";
import { pathBounds } from "../common/pathbounds";
import { fontMeasure } from "../common/measure.font";
import { nodeFontLocator } from "./fontfile.node";
import { HALT, svgCollapsedText, type FeatureList, type FontStyle, type FontWeight, type MeasureBackend, type TextMetrics } from "../common/measure";
import { punctClass } from "../common/cjkpunct";

interface Native {
  outline(text: string, families: string[], size: number, bold: boolean, italic: boolean, features: string[]): string;
  measure(text: string, families: string[], size: number, bold: boolean, italic: boolean, features: string[]): {
    width: number; ink: boolean; left: number; top: number; right: number; bottom: number; xs: number[];
  };
  fontMetrics(families: string[], size: number, bold: boolean, italic: boolean): { ascent: number; descent: number; family: string };
  registerFont(path: string): boolean;
  hasFamily(family: string): boolean;
}

/**
 * 泛称按浏览器在**中文页面里的 SVG `<text>`** 解析：页面 `lang=zh-CN`，泛称走简体中文那一档
 *（谱面就是 SVG 画的，这是用户看到的字）。浏览器的 canvas 不带语言，泛称落到 Helvetica/Times，
 * 与 SVG 不一致——浏览器后端量 `sans-serif` 时宽度与墨迹出自两支字，这里不照抄。
 */
const GENERIC: Record<string, Record<string, string[]>> = {
  darwin: { "sans-serif": ["PingFang SC"], serif: ["Songti SC"], monospace: ["Menlo"], "system-ui": ["PingFang SC"] },
  win32: { "sans-serif": ["Microsoft YaHei"], serif: ["SimSun"], monospace: ["Consolas"], "system-ui": ["Microsoft YaHei UI"] },
};

/**
 * 浏览器给的 ascent/descent 是**取整**过的；macOS 上 Times、Helvetica、Courier 的 ascent 还要再加 15% 的行高
 *（WebKit 留下来的兼容修正，Chromium 照抄）。canvas 的 fontBoundingBox* 量出来的就是这个数。
 */
function browserMetrics(asc: number, desc: number, family: string): { ascent: number; descent: number } {
  let a = Math.round(asc);
  const d = Math.round(desc);
  if (process.platform === "darwin" && /^(times|helvetica|courier)$/i.test(family)) a += Math.floor((a + d) * 0.15 + 0.5);
  return { ascent: -a, descent: d };
}

const f32 = Math.fround;

/**
 * Chromium 量单个字的 advance 是**向上**取到 1/64 px 的（10.24px 的「圣」量成 10.25，28px 的「1」11.228 → 11.234）。
 * 排版里单字量宽是大头（数字、歌词逐字），照着取，一行几十个字累下来才不会和浏览器差出零点几个像素。
 * 整串与带 GPOS 调整的逐字笔位另有取法，量出的差在 1/64 以内，不照抄。整串都是空白的不取（浏览器那时用 canvas 的宽）。
 */
const ceil64 = (v: number): number => Math.ceil(v * 64 - 1e-6) / 64;
function quantize<T extends { width: number }>(m: T, text: string): T {
  return [...text].length === 1 && !/^\s$/.test(text) ? { ...m, width: ceil64(m.width) } : m;
}

/**
 * Chromium 缺省的 `text-spacing-trim: normal`（CSS Text 4 的 trim-adjacent）：相邻的全角标点自动挤掉半格——
 * 开括号前面是全角标点时挤开括号的左半（「：（」「）（」），收尾/点号后面跟收尾/点号时挤前一个的右半（「）。」）。
 * 挤法是给那个字开 `halt`，字体没有 `halt` 的（Songti）不挤；比例宽的字形（PingFang 的弯引号）不算全角，不挤；
 * 单个标点与串首的不挤。不开特性量的宽度里已经挤过了，所以浏览器后端的 `hasFontFeature` 开关前后一样、返回 false，
 * 标点挤压一律走 `compressRun`。这里照同一套规则挤，宽度与分支走向都同浏览器。
 */
function hanKerning(b: MeasureBackend) {
  /** 全角标点（单字宽约一个字身）。 */
  const isFull = (ch: string, family: string, size: number, weight: FontWeight, style: FontStyle): boolean =>
    punctClass(ch) !== "none" && Math.abs(b.glyph(ch, family, size, weight, undefined, style).width - size) <= size * 0.02;
  /** 开 `halt` 能挤掉多少（px）；字体没有 `halt` 给 0。 */
  const halfOf = (ch: string, family: string, size: number, weight: FontWeight, style: FontStyle): number =>
    Math.max(0, b.glyph(ch, family, size, weight, undefined, style).width - b.glyph(ch, family, size, weight, HALT, style).width);
  /** 各码点往左挪多少（它前面累计挤掉的）；一处都不挤返回 null。 */
  return (text: string, family: string, size: number, weight: FontWeight, style: FontStyle): number[] | null => {
    const chars = [...text];
    if (chars.length < 2) return null;
    const shift = new Array<number>(chars.length).fill(0);
    let acc = 0;
    for (let i = 1; i < chars.length; i++) {
      const a = chars[i - 1]!, c = chars[i]!;
      const ka = punctClass(a), kc = punctClass(c);
      if (ka !== "none" && kc !== "none" && isFull(a, family, size, weight, style) && isFull(c, family, size, weight, style)) {
        // 开括号前面是全角标点：挤开括号的左半；收尾/点号后面跟收尾/点号/中间类：挤前一个的右半
        if (kc === "open") acc += halfOf(c, family, size, weight, style);
        else if ((ka === "close" || ka === "stop") && (kc === "close" || kc === "stop" || kc === "middle")) acc += halfOf(a, family, size, weight, style);
      }
      shift[i] = acc;
    }
    return acc > 0 ? shift : null;
  };
}

/** 两个后端共用的外层：缺省的标点挤压（`hanKerning`）、按浏览器的口径量化 advance。 */
function browserLike(b: MeasureBackend): MeasureBackend {
  const kern = hanKerning(b);
  const glyph = (text: string, family: string, size: number, weight: FontWeight, features: FeatureList | undefined, style: FontStyle): TextMetrics => {
    const m = b.glyph(text, family, size, weight, features, style);
    if (features?.length) return m;
    const shift = kern(svgCollapsedText(text), family, size, weight, style);
    if (!shift) return m;
    // 宽度减去挤掉的；墨迹逐字量、按各字的笔位减去它前面挤掉的再合起来
    const shown = svgCollapsedText(text);
    const xs = b.positions(shown, family, size, weight, []).xs;
    let ink: Rect | null = null;
    [...shown].forEach((ch, i) => {
      const g = b.glyph(ch, family, size, weight, undefined, style).bbox;
      if (g.right <= g.left && g.bottom <= g.top) return;
      const dx = (xs[i] ?? 0) - shift[i]!;
      const r = new Rect(g.left + dx, g.top, g.right + dx, g.bottom);
      ink = ink ? ink.union(r) : r;
    });
    return { width: m.width - shift[shift.length - 1]!, bbox: ink ?? m.bbox };
  };
  return {
    ...b,
    glyph: (text, family, size, weight, features, style) => quantize(glyph(text, family, size, weight, features, style), text),
  };
}

/** 本仓库的字体文件（不在系统里、按族名直接给文件的）。 */
export function repoFonts(): Record<string, string> {
  const redist = fileURLToPath(new URL("../../public/redist/", import.meta.url));
  return { Bravura: `${redist}Bravura.otf`, "Bravura Text": `${redist}BravuraText.otf` };
}

/** 找原生模块：`DOLCE_TEXTMEASURE` 指定的，或仓库里 `native/textmeasure/textmeasure.node`。 */
function loadNative(): Native | null {
  if (process.env.DOLCE_TEXTMEASURE === "off") return null;
  const cands = [
    process.env.DOLCE_TEXTMEASURE,
    fileURLToPath(new URL("../../native/textmeasure/textmeasure.node", import.meta.url)),
  ].filter((p): p is string => !!p);
  const req = createRequire(import.meta.url);
  for (const p of cands) {
    if (!existsSync(p)) continue;
    try {
      return req(p) as Native;
    } catch {
      /* 平台不对或缺依赖：试下一个 */
    }
  }
  return null;
}

/** 族串里一个都没有时浏览器用的标准字体（中文页面）。 */
const STANDARD: Record<string, string[]> = { darwin: ["PingFang SC"], win32: ["Microsoft YaHei"] };

/** CSS 族串 → 具体族名（泛称按浏览器展开，末尾补标准字体）。 */
function familyLister(generic: Record<string, string[]>, standard: string[]): (css: string) => string[] {
  const listCache = new Map<string, string[]>();
  return (css: string): string[] => {
    let hit = listCache.get(css);
    if (!hit) {
      hit = [];
      for (const part of css.split(",")) {
        const name = part.trim().replace(/^(['"])(.*)\1$/, "$2");
        if (name) hit.push(...(generic[name.toLowerCase()] ?? [name]));
      }
      // 族串里的都没有时浏览器落到标准字体（中文页面里是 PingFang SC / Microsoft YaHei），不是什么都不画
      for (const f of standard) if (!hit.includes(f)) hit.push(f);
      listCache.set(css, hit);
    }
    return hit;
  };
}

function nativeMeasure(n: Native, familiesOf: (css: string) => string[]): MeasureBackend {
  const feats = (f: FeatureList | undefined) => (f ? [...f] : []);
  return {
    glyph(text: string, family: string, size: number, weight: FontWeight, features: FeatureList | undefined, style: FontStyle) {
      const fams = familiesOf(family);
      const m = n.measure(text, fams, size, weight === "bold", style === "italic", feats(features));
      const bbox = m.ink ? new Rect(f32(m.left), f32(m.top), f32(m.right), f32(m.bottom)) : new Rect(0, 0, 0, 0);
      const shown = svgCollapsedText(text);
      const width = shown === text ? m.width : n.measure(shown, fams, size, weight === "bold", style === "italic", feats(features)).width;
      return { width: f32(width), bbox };
    },
    positions(text: string, family: string, size: number, weight: FontWeight, features: FeatureList) {
      const m = n.measure(text, familiesOf(family), size, weight === "bold", false, feats(features));
      return { xs: m.xs.map(f32), width: f32(m.width) };
    },
    fontMetrics(family: string, size: number, weight: FontWeight, style: FontStyle) {
      const m = n.fontMetrics(familiesOf(family), size, weight === "bold", style === "italic");
      return browserMetrics(m.ascent, m.descent, m.family);
    },
    pathBounds(d: string) {
      const r = pathBounds(d);
      return new Rect(f32(r.left), f32(r.top), f32(r.right), f32(r.bottom));
    },
  };
}

let nativeOutline: ((text: string, css: string, size: number, bold: boolean, italic: boolean) => string) | null = null;

/** 一串字的轮廓（SVG path `d`，基线 y = 0），字体选择同量字；没有原生模块时给 null。 */
export function textOutline(text: string, css: string, size: number, bold = false, italic = false): string | null {
  return nativeOutline ? nativeOutline(text, css, size, bold, italic) : null;
}

/** 本次装配用的是哪条路（脚本打日志用）。 */
export let measureKind: "native" | "font" = "font";

/**
 * Node 侧的测量后端。`files` 是要额外按文件给的字体（族名 → 路径），缺省带 Bravura 两支；
 * 成书注册的字体也从这里进来。
 */
export function nodeMeasure(files: Record<string, string> = {}): MeasureBackend {
  const all = { ...repoFonts(), ...files };
  const generic = GENERIC[process.platform] ?? GENERIC.darwin!;
  const familiesOf = familyLister(generic, STANDARD[process.platform] ?? STANDARD.darwin!);
  const n = loadNative();
  if (n) {
    for (const p of Object.values(all)) if (existsSync(p)) n.registerFont(p);
    measureKind = "native";
    nativeOutline = (text, css, size, bold, italic) => n.outline(text, familiesOf(css), size, bold, italic, []);
    return browserLike(nativeMeasure(n, familiesOf));
  }
  measureKind = "font";
  const font = browserLike(fontMeasure(nodeFontLocator(all), { generic: { ...generic } }));
  return {
    ...font,
    fontMetrics(family, size, weight, style) {
      const m = font.fontMetrics(family, size, weight, style);
      return browserMetrics(-m.ascent, m.descent, family.split(",")[0]!.trim());
    },
  };
}
