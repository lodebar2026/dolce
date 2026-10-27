// 简谱调号「1=♭B」/ 曲中转调「转1=D」：旧简谱引擎、原样文档、混排简谱层共用。
//
// 画法照混排（render.cpp::drawKey 的简谱分支）：「1=」是文字，升降号是 SMuFL 的 csym 小号字形
// （和弦里用的那一套，不是五线谱的 accidentalFlat）、抬高；缺省写在音名**之前**，`accidental-side: after` 写在后。
// 原先三路三张名表、三种升降号（ASCII `Bb` 写在后、缩小的 `b` 字符、Unicode `♭`），这里收一份。
import { Rect } from "../common/geom";
import { Font } from "../pagetree/font";
import { PageItem, TextFrame } from "../pagetree/pageitem";
import { MusicCommon } from "../score/jppitch";
import { GlyphCodes } from "../smufl/smufl";
import { musicText } from "./prims";
import { EQ_PAD_EM, type AccidentalSide } from "./spacing";

/** 调名：字母 + 升降（-1 降、0 本位、1 升）。 */
export interface KeyName {
  letter: string;
  alter: -1 | 0 | 1;
}

/** 调号的五度数 → 调名（`MusicCommon.keys` 那一张表，全仓唯一）。 */
export function keyNameOfFifths(fifths: number): KeyName {
  const s = MusicCommon.keys[fifths + 7] ?? "C";
  return keyNameOf(s) ?? { letter: "C", alter: 0 };
}

/** 文字写法的调名（`bE` / `Eb` / `♭E` / `$E` / `#F` / `F`）→ 调名；认不出返回 null。
 *  `$` 是文本谱里降号的写法（`fanqie/parse.ts`）。 */
export function keyNameOf(text: string): KeyName | null {
  const m = /^([b#$♭♯]?)([A-G])([b#$♭♯]?)$/.exec(text.trim());
  if (!m || (m[1] && m[3])) return null;
  const acc = m[1] || m[3];
  const alter = acc === "b" || acc === "$" || acc === "♭" ? -1 : acc === "#" || acc === "♯" ? 1 : 0;
  return { letter: m[2]!, alter };
}

export interface KeyLabelStyle {
  /** 「1=」与音名的字。 */
  font: Font;
  /** SMuFL 字体（只取族名；字号按 `font` 定）。 */
  music: Font;
  color: number;
  /** 前缀：曲中转调写「转」，曲首不写。 */
  prefix?: string;
  /** 升降号在音名前（缺省）还是后（样式键 `accidental-side`，与和弦同一个）。 */
  side?: AccidentalSide;
  /** 每个图元都挂上的类名（`key-change` / `hdr-keysig`，点选与检查脚本认它）。 */
  classes?: string[];
  /** 「=」两侧各让的空 ÷ 字号。缺省 `EQ_PAD_EM`。 */
  eqPad?: number;
}

/**
 * 升降号的取尺（÷ 字号），照混排实测：混排的 `1=` 字号是 jianpuFont 30 时，升降号前空 7、
 * 字形占 12（含右侧空）、基线抬高 10，csym 字形按 Bravura 40 × (字号/40) 即字号本身排。
 */
const ACC_GAP_BEFORE = 7 / 30;
const ACC_ADVANCE = 12 / 30;
const ACC_RAISE = 10 / 30;
/** 升降号写在音名后面时与音名之间的空（÷ 字号）。 */
const ACC_GAP_AFTER = 2 / 30;

/** 一个调号标签。图元相对自身原点：x 从 0 起，y = 0 是文字基线。 */
export class KeyLabel {
  readonly items: PageItem[] = [];
  readonly width: number;
  /** 墨迹的几处边（本地 x）：「=」右缘、「=」之后第一笔（升降号或音名）左缘、整串右缘。
   *  原样文档页眉按「调号→拍号 = 「=」→调号」的墨迹间距排拍号（用户口径）。 */
  readonly eqInkRight: number;
  readonly nameInkLeft: number;
  readonly inkRight: number;
  private readonly bbox: Rect;

  constructor(tonic: string, name: KeyName, style: KeyLabelStyle) {
    const { font, color } = style;
    const pad = (style.eqPad ?? EQ_PAD_EM) * font.size;
    let x = 0;
    const { ascent: asc, descent: desc } = font.metrics;
    let box = new Rect();
    const put = (text: string): Rect => {
      const tf = new TextFrame();
      tf.font = font;
      tf.color = color;
      tf.text = text;
      tf.x = x;
      for (const c of style.classes ?? []) tf.classes.add(c);
      this.items.push(tf);
      const w = tf.measureText();
      // 一般文字按**字体盒**（笔位 + advance、基线 ± ascent/descent）
      box = box.union(new Rect(x, asc, x + w, desc));
      const ink = font.charBound(text).offset(x, 0);
      x += w;
      return ink;
    };
    put(`${style.prefix ?? ""}${tonic}`);
    x += pad;
    this.eqInkRight = put("=").right;
    x += pad;
    // 升降号：csym 字形、抬高；写在音名前（缺省，`1=♭B`）还是后（`1=B♭`）由 `side` 定，与和弦同一个样式键
    const putAcc = (): Rect => {
      const glyph = name.alter < 0 ? GlyphCodes.csymAccidentalFlat : GlyphCodes.csymAccidentalSharp;
      const mf = style.music.makeWithSize(font.size);
      const tf = musicText(glyph, mf, color);
      tf.x = x;
      tf.y = -ACC_RAISE * font.size;
      for (const c of style.classes ?? []) tf.classes.add(c);
      this.items.push(tf);
      // SMuFL 字形按**墨迹盒**（canvas 量的 actualBoundingBox，不是 Bravura 那 4 em 高的字体盒）
      const ink = mf.charBound(glyph).offset(x, tf.y);
      box = box.union(ink);
      x += ACC_ADVANCE * font.size;
      return ink;
    };
    let firstInk: number | null = null;
    let lastInk: number;
    if (name.alter !== 0 && style.side !== "after") {
      x += ACC_GAP_BEFORE * font.size;
      firstInk = putAcc().left;
      lastInk = put(name.letter).right;
    } else {
      const letterInk = put(name.letter);
      firstInk = letterInk.left;
      lastInk = letterInk.right;
      if (name.alter !== 0) {
        x += ACC_GAP_AFTER * font.size;
        lastInk = putAcc().right;
      }
    }
    this.nameInkLeft = firstInk;
    this.inkRight = lastInk;
    this.width = x;
    this.bbox = box;
  }

  /** 占位盒：文字部分按字体盒、升降号按 SMuFL 墨迹，本地坐标。 */
  box(): Rect {
    return this.bbox;
  }
}
