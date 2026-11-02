// 字体文件测量后端：advance 与笔位由 fontkit 的 shaping 给出（GSUB/GPOS，含 `chws`/`halt`），
// 墨迹取字形轮廓的紧包围盒——轮廓由 opentype.js 按字形 id 读（fontkit 读不了 CID 的 CFF：
// PingFang 的 FDArray 里带 FontMatrix，fontkit 报 Unknown operator 3079），读不了再退回 fontkit 的轮廓。
// 与环境无关——字体从哪来由注入的 `FontLocator` 决定（Node 读系统字体文件，见 cli/fontfile.node.ts）。
// Node 回归与出图走它；口径对齐浏览器后端（measure.browser.ts）：
//   - CSS 族串逐个解析，泛称（sans-serif…）按浏览器在中文页面里的缺省展开，缺字逐字回退；
//   - 一串字跨几支字时分段 shaping，段间不做 kerning（浏览器同样不跨字体 kerning）；
//   - 数值过一遍 float32（浏览器的 getComputedTextLength / getBBox 是单精度）。

import * as fontkitNs from "@pdf-lib/fontkit";
import type { Font as FkFont, Glyph as FkGlyph } from "@pdf-lib/fontkit";
import * as opentype from "opentype.js";
import { Rect } from "./geom";
import { pathBounds } from "./pathbounds";
import { svgCollapsedText, type FeatureList, type FontStyle, type FontWeight, type MeasureBackend, type TextMetrics } from "./measure";

// UMD/ESM 两种形态下 fontkit 都挂在 default 上
const fontkit = ((fontkitNs as unknown as { default?: typeof fontkitNs }).default ?? fontkitNs) as typeof fontkitNs;

/** 定位到的一支字。 */
export interface FontFile {
  /** 单个 sfnt（ttc 已经拆出来）或 woff/woff2 */
  bytes: Uint8Array;
  /** 缓存键（同一支字定位几次只建一个 fontkit 对象） */
  key: string;
  /** 要粗体而挑到的字面不够粗（浏览器此时合成粗体） */
  synthBold?: boolean;
  /** 要斜体而这个族没有斜体字面（浏览器此时合成倾斜） */
  synthItalic?: boolean;
}

/** 单个族名（不是 CSS 族串）+ 字重 + 字形 → 一支字；没有就 null。 */
export type FontLocator = (family: string, weight: FontWeight, style: FontStyle) => FontFile | null;

export interface FontMeasureOptions {
  /** 泛称 → 具体族（按浏览器在 `lang=zh-CN` 页面里的缺省） */
  generic?: Record<string, string[]>;
  /** 族串里的字都没有这个字时的回退链 */
  fallback?: string[];
}

/** macOS 上 Chromium 在中文页面里的缺省 */
const GENERIC: Record<string, string[]> = {
  "sans-serif": ["PingFang SC"],
  serif: ["Songti SC", "Times"],
  monospace: ["Menlo"],
  "system-ui": ["PingFang SC"],
};
const FALLBACK = ["PingFang SC", "Helvetica", "Apple Symbols", "Arial Unicode MS", "Apple Color Emoji"];

interface Face {
  font: FkFont;
  /** 读轮廓用；undefined = 还没解析，null = 解析不了 */
  outline?: opentype.Font | null;
  bytes: Uint8Array;
  scale: number; // 1 / unitsPerEm
  synthBold: boolean;
  synthItalic: boolean;
}

/** 合成粗体的描边外扩量（em 的比例）：照 Skia 的 fake bold，字号 9→36 由 1/24 插到 1/32。 */
function fakeBoldOutset(size: number): number {
  const t = Math.min(1, Math.max(0, (size - 9) / (36 - 9)));
  const k = 1 / 24 + (1 / 32 - 1 / 24) * t;
  return (size * k) / 2;
}
/** 合成倾斜的错切（Skia 的 fake italic）。 */
const FAKE_ITALIC_SKEW = 0.25;

const f32 = Math.fround;

export function fontMeasure(locate: FontLocator, opts: FontMeasureOptions = {}): MeasureBackend {
  const generic = opts.generic ?? GENERIC;
  const fallback = opts.fallback ?? FALLBACK;
  const fontByKey = new Map<string, FkFont | null>();
  const faceCache = new Map<string, Face | null>();
  const chainCache = new Map<string, Face[]>();

  function faceOf(family: string, weight: FontWeight, style: FontStyle): Face | null {
    const ck = `${family.toLowerCase()}\x01${weight}\x01${style}`;
    if (faceCache.has(ck)) return faceCache.get(ck)!;
    let face: Face | null = null;
    const file = locate(family, weight, style);
    if (file) {
      if (!fontByKey.has(file.key)) {
        let f: FkFont | null = null;
        try {
          const made = fontkit.create(file.bytes) as FkFont & { fonts?: FkFont[] };
          f = made.fonts?.[0] ?? made;
        } catch {
          f = null;
        }
        fontByKey.set(file.key, f);
      }
      const font = fontByKey.get(file.key);
      if (font) face = { font, bytes: file.bytes, scale: 1 / (font.unitsPerEm || 1000), synthBold: !!file.synthBold, synthItalic: !!file.synthItalic };
    }
    faceCache.set(ck, face);
    return face;
  }

  /** CSS 族串 → 按序可用的字（泛称展开、补回退链、去重）。 */
  function chainOf(families: string, weight: FontWeight, style: FontStyle): Face[] {
    const ck = `${families}\x01${weight}\x01${style}`;
    const hit = chainCache.get(ck);
    if (hit) return hit;
    const names: string[] = [];
    for (const part of families.split(",")) {
      const name = part.trim().replace(/^(['"])(.*)\1$/, "$2");
      if (!name) continue;
      names.push(...(generic[name.toLowerCase()] ?? [name]));
    }
    names.push(...fallback);
    const out: Face[] = [];
    for (const n of names) {
      const f = faceOf(n, weight, style);
      if (f && !out.includes(f)) out.push(f);
    }
    chainCache.set(ck, out);
    return out;
  }

  /** 字形 id 的轮廓紧包围盒（字体单位，y 向上）；没有墨返回 null。 */
  function glyphBox(face: Face, g: FkGlyph): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (face.outline === undefined) {
      try {
        const b = face.bytes;
        const ot = (opentype as unknown as { default?: typeof opentype }).default ?? opentype; // Node 里走 CJS 入口
        face.outline = ot.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      } catch {
        face.outline = null;
      }
    }
    if (face.outline) {
      try {
        const og = face.outline.glyphs.get(g.id);
        if (og) {
          const p = og.getPath(0, 0, face.outline.unitsPerEm);
          if (!p.commands.length) return null;
          // getPath 是 y 向下的屏幕坐标，翻回字体坐标
          const bb = p.getBoundingBox();
          return { minX: bb.x1, maxX: bb.x2, minY: -bb.y2, maxY: -bb.y1 };
        }
      } catch {
        /* 退回 fontkit */
      }
    }
    try {
      const bb = g.path.bbox;
      return Number.isFinite(bb.minX) && bb.maxX >= bb.minX ? bb : null;
    } catch {
      return null;
    }
  }

  const hasCp = (f: Face, cp: number): boolean => {
    try {
      return f.font.hasGlyphForCodePoint(cp);
    } catch {
      return false;
    }
  };

  /** 按「哪支字有这个字」把一串字切段（码点下标）。空白跟前一个字走，免得为一个空格换字体。 */
  function segments(text: string, chain: Face[]): { face: Face | null; text: string; cps: number }[] {
    const out: { face: Face | null; text: string; cps: number }[] = [];
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      const last = out[out.length - 1];
      let face: Face | null;
      if (last?.face && /\s/.test(ch) && hasCp(last.face, cp)) face = last.face;
      else face = chain.find((f) => hasCp(f, cp)) ?? chain[0] ?? null;
      if (last && last.face === face) {
        last.text += ch;
        last.cps++;
      } else out.push({ face, text: ch, cps: 1 });
    }
    return out;
  }

  const featureArg = (features: FeatureList | undefined): string[] | undefined =>
    features && features.length ? [...features] : undefined;

  interface Shaped {
    /** 每个码点的落笔点 */
    xs: number[];
    width: number;
    ink: { left: number; right: number; top: number; bottom: number } | null;
  }

  function shape(text: string, families: string, size: number, weight: FontWeight, style: FontStyle, features: FeatureList | undefined): Shaped {
    const chain = chainOf(families, weight, style);
    const xs: number[] = [];
    let pen = 0;
    let ink: Shaped["ink"] = null;
    const addInk = (l: number, t: number, r: number, b: number) => {
      if (!ink) ink = { left: l, top: t, right: r, bottom: b };
      else {
        ink.left = Math.min(ink.left, l);
        ink.top = Math.min(ink.top, t);
        ink.right = Math.max(ink.right, r);
        ink.bottom = Math.max(ink.bottom, b);
      }
    };
    for (const seg of segments(text, chain)) {
      if (!seg.face) {
        for (let i = 0; i < seg.cps; i++) xs.push(pen);
        continue;
      }
      const { font, scale, synthBold, synthItalic } = seg.face;
      const k = size * scale;
      let run;
      try {
        run = font.layout(seg.text, featureArg(features) as never);
      } catch {
        for (let i = 0; i < seg.cps; i++) xs.push(pen);
        continue;
      }
      const outset = synthBold ? fakeBoldOutset(size) : 0;
      let cpIdx = 0;
      run.glyphs.forEach((g: FkGlyph, i: number) => {
        const pos = run.positions[i]!;
        // 一个字形吃几个码点（连字）就记几次同一个笔位
        const n = Math.max(1, g.codePoints?.length ?? 1);
        for (let j = 0; j < n && cpIdx < seg.cps; j++, cpIdx++) xs.push(pen);
        const bb = glyphBox(seg.face!, g);
        if (bb) {
          const ox = pen + pos.xOffset * k;
          const top = -bb.maxY * k - (pos.yOffset ?? 0) * k;
          const bottom = -bb.minY * k - (pos.yOffset ?? 0) * k;
          let left = ox + bb.minX * k;
          let right = ox + bb.maxX * k;
          if (synthItalic) {
            // x' = x − skew·y（y 向下为正）：上沿右移、下沿左移
            left = Math.min(left - FAKE_ITALIC_SKEW * top, left - FAKE_ITALIC_SKEW * bottom);
            right = Math.max(right - FAKE_ITALIC_SKEW * top, right - FAKE_ITALIC_SKEW * bottom);
          }
          addInk(left - outset, top - outset, right + outset, bottom + outset);
        }
        pen += pos.xAdvance * k;
      });
      while (cpIdx < seg.cps) {
        xs.push(pen);
        cpIdx++;
      }
    }
    return { xs, width: pen, ink };
  }

  return {
    glyph(text, family, size, weight, features, style): TextMetrics {
      const s = shape(text, family, size, weight, style, features);
      const ink = s.ink as Shaped["ink"];
      const shown = svgCollapsedText(text);
      const width = shown === text ? s.width : shape(shown, family, size, weight, style, features).width;
      // 没有墨（空白）：墨迹盒退成落笔点上的空盒，同浏览器
      const bbox = ink
        ? new Rect(f32(ink.left), f32(ink.top), f32(ink.right), f32(ink.bottom))
        : new Rect(0, 0, 0, 0);
      return { width: f32(width), bbox };
    },
    positions(text, family, size, weight, features) {
      const s = shape(text, family, size, weight, "normal", features);
      return { xs: s.xs.map(f32), width: f32(s.width) };
    },
    fontMetrics(family, size, weight, style) {
      const face = chainOf(family, weight, style)[0];
      if (!face) return { ascent: -size * 0.8, descent: size * 0.2 };
      const k = size * face.scale;
      return { ascent: -face.font.ascent * k, descent: -face.font.descent * k };
    },
    pathBounds(d) {
      const r = pathBounds(d);
      return new Rect(f32(r.left), f32(r.top), f32(r.right), f32(r.bottom));
    },
  };
}
