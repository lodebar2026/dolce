// 简谱临时记号（数字左边的 ♭ ♯ ♮）：旧简谱引擎、原样文档、混排简谱层共用。
// 两种样子（样式键 `accidental-style`）：`csym`（缺省，下述）与 `classic`（原先旧简谱引擎那样，成书照原书用它）。
//
// `csym` 观感照混排（render.cpp 的简谱分支）：字形是 SMuFL 的 **csym** 小号升降号（和弦里那一套，
// 不是五线谱的 accidentalFlat），贴在数字左边。混排原先按 tenths 写死（Bravura 40 × 0.75、
// 笔位 `n.x − w·0.75 − 2`、基线 y = 20），这里折成**相对数字墨迹盒**的比例（H = 数字墨迹高），
// 换字体、换字号都跟着走：
//   - 大小：字号 = 1.867 H（混排出厂：数字 22.5px 墨迹高 16.07，升降号 30px）；
//   - 竖向：字形基线在数字墨迹底之上 0.156 H（混排基线 20 对数字基线 22.5）；
//   - 横向：升降号墨迹右缘离数字墨迹左缘 0.143 H（混排实测 2.3 tenths）。
// 位置一律按**墨迹**（SMuFL 走元数据或 canvas 墨迹，不用 Bravura 那 4 em 高的字体盒）。
import { Rect } from "../common/geom";
import type { Font } from "../pagetree/font";
import type { TextFrame } from "../pagetree/pageitem";
import { GlyphCodes, type MetaData } from "../smufl/smufl";
import type { AccidentalStyleKind } from "./spacing";
import { musicInk, musicText } from "./prims";

export type AccidentalKind = "sharp" | "flat" | "natural" | "double-sharp" | "double-flat";

const GLYPH: Record<AccidentalKind, string> = {
  sharp: GlyphCodes.csymAccidentalSharp,
  flat: GlyphCodes.csymAccidentalFlat,
  natural: GlyphCodes.csymAccidentalNatural,
  // csym 没有重升重降，用五线谱那两个
  "double-sharp": GlyphCodes.accidentalDoubleSharp,
  "double-flat": GlyphCodes.accidentalDoubleFlat,
};

const SIZE_PER_INK = 30 / 16.065;
const BASE_ABOVE_INK_BOTTOM = 2.5 / 16.065;
const GAP_PER_INK = 2.3 / 16.065;

export interface AccidentalStyle {
  /** SMuFL 字体（只取族名，字号按数字定）。 */
  music: Font;
  color: number;
  /** 有就按元数据量墨迹，没有按 canvas 墨迹。 */
  meta?: MetaData;
  /** 样子（样式键 `accidental-style`）。缺省 `csym`。 */
  kind?: AccidentalStyleKind;
  /** `csym` 样子的大小 × 这个（样式键 `accidental-scale`，缺省 1 = 照混排）。 */
  scale?: number;
}

/** 升降号挂在哪个数字上：数字的字、笔位与基线（调用方坐标），倚音那种整体缩小的给 `scale`。 */
export interface DigitRef {
  font: Font;
  text: string;
  x: number;
  y: number;
  scale?: number;
}

/** `classic` 样子的字形：五线谱那套升降号。 */
const CLASSIC_GLYPH: Record<AccidentalKind, string> = {
  sharp: GlyphCodes.accidentalSharp,
  flat: GlyphCodes.accidentalFlat,
  natural: GlyphCodes.accidentalNatural,
  "double-sharp": GlyphCodes.accidentalDoubleSharp,
  "double-flat": GlyphCodes.accidentalDoubleFlat,
};
/** `classic` 按数字字形微调的横向字距（÷ 字号），原先旧简谱引擎的那张表。 */
const CLASSIC_KERN: Record<string, number> = { "4": 0.1, "2": -0.07, "1": -0.07 };

/** 一个临时记号，摆在 `digit` 左边。 */
export class AccidentalGlyph {
  readonly item: TextFrame;
  /** 墨迹盒，调用方坐标。 */
  readonly box: Rect;

  constructor(kind: AccidentalKind, digit: DigitRef, style: AccidentalStyle) {
    const sc = digit.scale ?? 1;
    let t: TextFrame;
    let ink: Rect;
    if (style.kind === "classic") {
      // 原先旧简谱引擎的样子（成书照原书用它）：五线谱升降号 0.8 倍，笔位在数字笔位左 0.2 字号（按数字微调），
      // 基线落在「1」的墨迹顶，降号再低 0.1 字号
      const S = digit.font.size;
      const font = style.music.makeWithSize(S * 0.8 * sc);
      const glyph = CLASSIC_GLYPH[kind];
      ink = musicInk(glyph, font, style.meta);
      t = musicText(glyph, font, style.color);
      t.x = digit.x + (-0.2 + (CLASSIC_KERN[digit.text[0] ?? ""] ?? 0)) * S * 0.8 * sc;
      t.y = digit.y + (digit.font.charBound("1").top + (kind.includes("flat") ? S * 0.1 : 0)) * sc;
    } else {
      const d = digit.font.charBound(digit.text);
      const left = digit.x + d.left * sc;
      const bottom = digit.y + d.bottom * sc;
      const H = d.height * sc;
      const font = style.music.makeWithSize(H * SIZE_PER_INK * (style.scale ?? 1));
      const glyph = GLYPH[kind];
      ink = musicInk(glyph, font, style.meta);
      t = musicText(glyph, font, style.color);
      t.x = left - H * GAP_PER_INK - ink.right;
      t.y = bottom - H * BASE_ABOVE_INK_BOTTOM;
    }
    this.item = t;
    this.box = ink.offset(t.x, t.y);
  }
}

/** 升降号左缘与前一个音之间要多留的空 ÷ 数字墨迹高（横向排布让位时加上；用户口径：别挤着前一个音）。 */
export const ACCIDENTAL_CLEARANCE = 0.3;

/** 各字形墨迹宽 ÷ 数字墨迹高（Bravura：字号 1.867 H 时的实测墨迹宽，与字体无关）。 */
const INK_WIDTH: Record<AccidentalKind, number> = {
  flat: 8.49 / 16.065,
  sharp: 9.3 / 16.065,
  natural: 5.52 / 16.065,
  "double-sharp": 0.988 * 7.5 / 16.065,
  "double-flat": 1.644 * 7.5 / 16.065,
};

/** 临时记号在数字墨迹左边占掉的宽（墨迹宽 + 与数字之间的空），横向排布给它让位用（`csym` 样子）。
 *  纯算术（不量字形），原样文档的定位（`place/`，不碰 DOM）也能调。 */
export function accidentalLead(kind: AccidentalKind, digitInkHeight: number, scale = 1): number {
  return (INK_WIDTH[kind] * scale + GAP_PER_INK) * digitInkHeight;
}

/** 各字形墨迹高 ÷ 数字墨迹高（同上，csym 升降号约 1.4 个数字高）。 */
const INK_HEIGHT: Record<AccidentalKind, number> = {
  flat: 22.47 / 16.065,
  sharp: 23.25 / 16.065,
  natural: 22.53 / 16.065,
  "double-sharp": 0.988 * 7.5 / 16.065,
  "double-flat": 1.75 * 7.5 / 16.065,
};

/** 临时记号的墨迹顶高出数字墨迹顶多少（≥ 0）。弧、连音、记号要让开它；纯算术，不碰 DOM。 */
export function accidentalRise(kind: AccidentalKind, digitInkHeight: number, scale = 1): number {
  return Math.max(0, (BASE_ABOVE_INK_BOTTOM + INK_HEIGHT[kind] * scale - 1) * digitInkHeight);
}

/** 简谱记法里的升降号字符（`b` / `#` / `n`）→ 临时记号种类。 */
export function accidentalKindOf(alt: string): AccidentalKind | null {
  return alt === "b" ? "flat" : alt === "#" ? "sharp" : alt === "n" ? "natural" : null;
}
