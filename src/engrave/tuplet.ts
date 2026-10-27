// 连音（三连音等）的画法：旧简谱引擎、原样文档、五线谱/混排共用一份。
//
// 三种样子：
//   - `bracket` 括号：一条（可斜的）横线 + 两头竖脚，数字坐在横线正中的断口里——五线谱与简谱同一套；
//   - `arc`     两段弧：同页 slur 那条月牙从中间挖掉数字那一截（`SlurStyle.gap`），简谱印刷本常见；
//   - `number`  只印数字（混排简谱层的旧观感）。
// 数字一律是 SMuFL 的 tuplet 数字字形（`tuplet0`…），按**墨迹**居中在横线/弧顶上。
// 位置（在音符上方多高、两端落在哪）各引擎自己算好，传进来的是坐标。
import { Point, Rect } from "../common/geom";
import type { Font } from "../pagetree/font";
import { GraphicPath, PageItem } from "../pagetree/pageitem";
import { Slur, type SlurStyle } from "./arc";
import { GlyphCodes, type MetaData } from "../smufl/smufl";
import { musicInk, musicText } from "./prims";

export type TupletKind = "bracket" | "arc" | "number";

export interface TupletStyle {
  kind: TupletKind;
  color: number;
  /** 数字的 SMuFL 字体（字号即数字字号）。 */
  music: Font;
  /** 有就按元数据量数字墨迹（与 `SmuflText.bound` 同口径），没有按 canvas 墨迹。 */
  meta?: MetaData;
  /** 括号的线宽。 */
  lineWidth?: number;
  /** 括号竖脚：从横线量到脚尖的**有向**长度（正 = 往下，括号在音符上方时）。 */
  foot?: number;
  /** 数字两侧各留的空 ÷ 数字字号。缺省 0.15。 */
  gapPad?: number;
  /** `arc` 样子的弧形参数（与同页 slur 同一份）。 */
  arc?: SlurStyle;
}

/** 连音数字 → SMuFL 字形串（`tuplet0` 起连续编码）。 */
export function tupletDigits(n: number): string {
  const zero = GlyphCodes.tuplet0.charCodeAt(0);
  let s = "";
  for (const c of String(n)) s += String.fromCharCode(zero + c.charCodeAt(0) - 48);
  return s;
}

/**
 * 一组连音记号。`p0`/`p1`：括号是**横线**两端、弧是**弧**两端（音符那一头）、只印数字时取两者中点。
 * 坐标系是调用方的，图元直接按它摆（不另包组）。
 */
export class TupletGlyph {
  readonly items: PageItem[] = [];
  /** 断口半宽（数字墨迹半宽 + 两侧留空）。 */
  readonly halfGap: number;
  /** 线那一截的顶（括号是横线上沿，弧是弧顶），调用方坐标。 */
  readonly lineTop: number;
  /** 数字的墨迹盒，调用方坐标。 */
  readonly numBox: Rect;

  constructor(p0: Point, p1: Point, n: number, style: TupletStyle) {
    const glyphs = tupletDigits(n);
    const font = style.music;
    const ink = musicInk(glyphs, font, style.meta);
    const inkCx = (ink.left + ink.right) / 2;
    const inkCy = (ink.top + ink.bottom) / 2;
    this.halfGap = ink.width / 2 + font.size * (style.gapPad ?? 0.15);
    const cx = (p0.x + p1.x) / 2;
    let cy = (p0.y + p1.y) / 2;
    let lineTop = Math.min(p0.y, p1.y);

    if (style.kind === "bracket") {
      const lw = style.lineWidth ?? 1;
      const foot = style.foot ?? 0;
      const k = p1.x !== p0.x ? (p1.y - p0.y) / (p1.x - p0.x) : 0;
      // 两端比数字还窄时横线不往外反画：只留竖脚
      const dx = Math.max(0, (p1.x - p0.x) / 2 - this.halfGap);
      const path = new GraphicPath();
      path.classes.add("tuplet-line"); // line-check 的 V12 靠它认（见 browser.ts::CLS_TAGS）
      path.strokeWidth = lw;
      path.fill = false;
      path.stroke = true;
      path.strokeColor = style.color;
      path.moveTo(p0.x, p0.y + foot);
      path.lineTo(p0.x, p0.y);
      if (dx > 0) path.lineTo(p0.x + dx, p0.y + dx * k);
      path.moveTo(p1.x, p1.y + foot);
      path.lineTo(p1.x, p1.y);
      if (dx > 0) path.lineTo(p1.x - dx, p1.y - dx * k);
      this.items.push(path);
      lineTop -= lw / 2;
    } else if (style.kind === "arc") {
      const arc = new Slur();
      arc.init(p0, p1, { ...style.arc!, gap: { x0: cx - this.halfGap, x1: cx + this.halfGap } });
      arc.update();
      arc.classes.add("tuplet-arc");
      this.items.push(arc);
      lineTop = arc.y;
      // 数字骑在弧顶那条线上（弧在断口处已接近顶点，取包围盒顶再往下半个厚度）
      cy = arc.y + style.arc!.thickness / 4;
    }

    const txt = musicText(glyphs, font, style.color);
    txt.x = cx - inkCx;
    txt.y = cy - inkCy;
    this.items.push(txt);
    this.lineTop = lineTop;
    this.numBox = ink.offset(txt.x, txt.y);
  }
}
