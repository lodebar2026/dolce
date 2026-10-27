// 简谱数字与挂在数字上的图元：数字 `JpNumber`、八度点/附点 `JpOctaveDot`、减时线 `BeamLine`。
// 都是页面树的叶子（`pagetree/pageitem.ts` 的子类），简谱引擎（`layout/jianpu/compose/`）造、导出（PDF / PPTX）按类认。

import { Point, Rect } from "../common/geom";
import { GraphicLine, GraphicPath, TextFrame } from "../pagetree/pageitem";
import { jpDot } from "./dot";

/**
 * 八度点 —— **一个实心矢量圆**，不是字体里的 `.` 字形。
 *
 * 三条简谱路统一走 `engrave/dot.ts::jpDot`（文本谱本来就是自绘的，谱面与混排原先用
 * `.`／`·` 字形——同一个点三种画法，还得各自补一道「按墨迹而非 advance 居中」的修正）。
 * 圆没有这个问题：局部包围盒恒为 (0,0)–(2r,2r)，调用点照旧 `x − width/2` 居中即可。
 *
 * `update()` / `bound` 都按解析式给，**不走 `computeTightBounds`**——那是一次
 * `<path>`.getBBox 的 DOM 测量，全书几万个八度点经不起。
 */
export class JpOctaveDot extends GraphicPath {
  readonly radius: number;
  /** 这个圆是**附点**的话，记下它挂在哪个数字上、是第几个。
   *  只有 `editor/pptx.ts` 用得着：那边要按目标字体的数字宽把附点重新摆一遍
   *  （八度点锚在 `JpNumber.cx` 上，本来就跟着走，不需要）。 */
  aug: { num: JpNumber; index: number } | null = null;
  constructor(r: number, color: number) {
    super();
    this.selectable = true;
    this.radius = r;
    this.segs = jpDot(r, r, r, color).segs;
    this.fill = true;
    this.stroke = false;
    this.fillColor = color;
    this.width = 2 * r;
    this.height = 2 * r;
  }
  override update(): void {
    this.width = 2 * this.radius;
    this.height = 2 * this.radius;
  }
  override get bound(): Rect {
    return new Rect(0, 0, 2 * this.radius, 2 * this.radius);
  }
}

export class JpNumber extends TextFrame {
  /** 附点是画上去的矢量圆、不在文本里（见 `NoteEntry.addAugDots`），可横向间距还得
   *  照原来那样给它留出位置——这里记的就是那几个 `·` 的 advance。 */
  augDotAdvance = 0;
  constructor() {
    super();
    this.selectable = true;
  }
  override update(): void {
    super.update();
    this.width += this.augDotAdvance;
  }
  get left(): number {
    return this.measureText(0, 1) / 2;
  }
  get right(): number {
    return this.measureText(0, 1) / 2 + this.measureText(1) + this.augDotAdvance;
  }
  /**
   * Anchor for decorations that must look centred on the digit: octave dots,
   * slur/tie ends, tuplet brackets. Uses the *ink* centre, not advance/2 —
   * PingFang SC's "1" is a narrow proportional glyph sitting 3.1% of an em
   * left of its advance centre, which is visible as an off-centre octave dot.
   * (musicpp render.cpp:906 and the Kotlin original both use advance/2 here
   * and carry the same offset; FreeType/Skija gave them no ink bounds on that
   * path, whereas the browser hands us actualBoundingBoxLeft/Right for free.)
   * Horizontal spacing goes through `width`/`left`/`right`, never `cx`, so
   * this does not move the notes themselves.
   */
  get cx(): number {
    return this.font.inkCenter(this.text[0]);
  }
  get numberPos(): number {
    let end = this.text.length;
    if (this.text.endsWith("·")) end--; // 附点早已不写进文本了，留着这道兜底不碍事
    return this.measureText(0, end);
  }
  override get bound(): Rect {
    const bnd = this.font.charBound(this.text[0]);
    return new Rect(0, bnd.top, this.width, bnd.bottom);
  }
}

/**
 * 减时线：数字下的一道横线，第 `level` 层（1 起），从 `x0` 到 `x1`、中线在 `y`。
 * 两端记着挂在哪两个数字上：导出 .pptx 时要按目标字体的数字宽把两端接回数字盒（`editor/pptx.ts`）。
 */
export class BeamLine extends GraphicLine {
  constructor(
    readonly level: number,
    x0: number,
    x1: number,
    y: number,
    width: number,
    color: number,
    readonly leftNum: JpNumber | null = null,
    readonly rightNum: JpNumber | null = null,
  ) {
    super();
    this.selectable = true;
    this.x = x0;
    this.p0 = new Point(0, y);
    this.p1 = new Point(x1 - x0, y);
    this.strokeWidth = width;
    this.strokeColor = color;
  }
}
