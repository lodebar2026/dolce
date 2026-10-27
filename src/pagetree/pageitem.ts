// Ported from mp/layout/layout.kt. Pure model + geometry; SVG emission lives in
// painter.ts. Skija Path/Canvas/Font replaced by GraphicPath command lists,
// the common geom types, and the Font abstraction (measurement via SVG/canvas).

import { Point, Rect, Matrix33, newMatrix, Colors } from "../common/geom";
import { pathTightBounds } from "../common/measure";
import { Font } from "./font";
import { MetaData } from "../smufl/smufl";
import type { ItemIdentity } from "./identity";

export function getOrNull<T>(arr: T[], i: number): T | null {
  return i >= 0 && i < arr.length ? arr[i] : null;
}

// ---------------- PageItem hierarchy ----------------

export class PageItem {
  parent: PageItem | null = null;
  children: PageItem[] = [];
  _width = 0;
  _height = 0;
  matrix: Matrix33 = newMatrix();
  classes = new Set<string>();
  data: unknown = null;
  /** 身份标签：画的是谁（播放高亮、点选、可视化编辑按它认，见 `identity.ts`）。不进 SVG。 */
  ident?: ItemIdentity;
  _selected = false;
  selectable = false;

  get selected(): boolean {
    return this._selected;
  }
  set selected(v: boolean) {
    this._selected = v;
  }

  get bound(): Rect {
    return new Rect(0, 0, this.width, this.height);
  }

  changeColor(clr: number): void {
    for (const it of this.children) it.changeColor(clr);
    this.applyColor(clr);
  }

  /** 给本 item 自己上色（不含子项）；有颜色的子类各自重写。 */
  protected applyColor(_clr: number): void {}

  pos(root: PageItem | null): Point {
    let loc = new Point(this.x, this.y);
    if (this.parent === root) return loc;
    const pp = this.parent!.pos(root);
    loc = loc.offset(pp);
    return loc;
  }

  get x(): number {
    return this.matrix.translateX;
  }
  set x(v: number) {
    this.matrix.translateX = v;
  }
  get y(): number {
    return this.matrix.translateY;
  }
  set y(v: number) {
    this.matrix.translateY = v;
  }
  get width(): number {
    return this._width;
  }
  set width(v: number) {
    this._width = v;
  }
  get height(): number {
    return this._height;
  }
  set height(v: number) {
    this._height = v;
  }

  get childrenBound(): Rect {
    let r = new Rect();
    for (const ch of this.children) {
      let rr = ch instanceof Group ? ch.childrenBound : ch.bound;
      rr = rr.offset(ch.x, ch.y);
      r = r.union(rr);
    }
    return r;
  }

  update(): void {
    let r = new Rect();
    for (const ch of this.children) {
      ch.update();
      let rr1 = ch.bound;
      rr1 = rr1.offset(ch.x, ch.y);
      r = r.union(rr1);
    }
    this.width = r.right;
    this.height = r.bottom;
  }

  add(pageItem: PageItem): void {
    this.children.push(pageItem);
    pageItem.parent = this;
  }
}

export type PathSeg = { op: "M" | "L" | "C" | "Z"; pts: number[] };

export class GraphicPath extends PageItem {
  segs: PathSeg[] = [];
  strokeWidth = 1;
  strokeColor = 0;
  fillColor = 0;
  stroke = false;
  fill = false;

  protected override applyColor(clr: number): void {
    if (this.stroke) this.strokeColor = clr;
    if (this.fill) this.fillColor = clr;
  }

  get d(): string {
    let s = "";
    for (const seg of this.segs) {
      if (seg.op === "Z") s += "Z";
      else s += `${seg.op}${seg.pts.join(" ")} `;
    }
    return s.trim();
  }

  override update(): void {
    const bnd = this.computeTightBounds();
    this.width = bnd.width;
    this.height = bnd.height;
    this.x += bnd.left;
    this.y += bnd.top;
    this.offset(-bnd.left, -bnd.top);
  }

  offset(dx: number, dy: number): void {
    for (const seg of this.segs) {
      for (let i = 0; i < seg.pts.length; i += 2) {
        seg.pts[i] += dx;
        seg.pts[i + 1] += dy;
      }
    }
  }
  moveTo(x: number | Point, y = 0): void {
    if (x instanceof Point) this.segs.push({ op: "M", pts: [x.x, x.y] });
    else this.segs.push({ op: "M", pts: [x, y] });
  }
  lineTo(x: number | Point, y = 0): void {
    if (x instanceof Point) this.segs.push({ op: "L", pts: [x.x, x.y] });
    else this.segs.push({ op: "L", pts: [x, y] });
  }
  cubicTo(p1: Point, p2: Point, p3: Point): void;
  cubicTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void;
  cubicTo(
    a: number | Point,
    b?: number | Point,
    c?: number | Point,
    d?: number,
    e?: number,
    f?: number,
  ): void {
    if (a instanceof Point) {
      const p1 = a, p2 = b as Point, p3 = c as Point;
      this.segs.push({ op: "C", pts: [p1.x, p1.y, p2.x, p2.y, p3.x, p3.y] });
    } else {
      this.segs.push({ op: "C", pts: [a, b as number, c as number, d!, e!, f!] });
    }
  }
  computeTightBounds(): Rect {
    if (this.segs.length === 0) return new Rect();
    return pathTightBounds(this.d);
  }
  close(): void {
    this.segs.push({ op: "Z", pts: [] });
  }
}

export class Group extends PageItem {
  get minY(): number | null {
    if (this.children.length === 0) return null;
    return this.children.reduce((m, c) => (c.y < m.y ? c : m)).y;
  }
  get minX(): number | null {
    if (this.children.length === 0) return null;
    return this.children.reduce((m, c) => (c.x < m.x ? c : m)).x;
  }
  get maxX(): number | null {
    if (this.children.length === 0) return null;
    const it = this.children.reduce((m, c) => (c.x + c.width > m.x + m.width ? c : m));
    return it.x + it.width;
  }
  get maxY(): number | null {
    if (this.children.length === 0) return null;
    const it = this.children.reduce((m, c) => (c.y + c.height > m.y + m.height ? c : m));
    return it.y + it.height;
  }

  normalizeX(): void {
    if (this.children.length === 0) return;
    const mx = this.minX!;
    for (const it of this.children) it.x -= mx;
    this.x += mx;
  }
  normalizeY(): void {
    if (this.children.length === 0) return;
    const mx = this.minY!;
    for (const it of this.children) it.y -= mx;
    this.y += mx;
  }

  override update(): void {
    for (const it of this.children) it.update();
    const bnd = this.childrenBound;
    for (const it of this.children) {
      it.x -= bnd.left;
      it.y -= bnd.top;
    }
    this.x += bnd.left;
    this.y += bnd.top;
    this.width = bnd.width;
    this.height = bnd.height;
  }
}

export class TextFrame extends PageItem {
  text = "";
  color = Colors.black;
  font!: Font;
  previous: TextFrame | null = null;
  next: TextFrame | null = null;
  /** 用**紧包围盒**而不是字体的全局 ascent/descent 来算 bound。
   *  给 SMuFL 那类字体用：Bravura 的 ascent−descent 是 4.02 em，一个和弦里夹一个升号，
   *  这一行就凭空高出四个字号——行距全乱。SmuflText 自己重写了 bound，
   *  但 engrave/chord.ts 里的音乐段是普通 TextFrame，靠这个开关。 */
  inkBound = false;
  /** 逐字笔位（相对本 item 的 x，按码点）。null = 连排，由字体的 advance 说了算。
   *  标点挤压后的歌词用它——测量与绘制拿同一串坐标，`<text>` 的 `x` 直接吃它，
   *  绝不在渲染端再叠 font-feature-settings（会挤两遍）。见 common/measure.ts。 */
  charXs: number[] | null = null;

  protected override applyColor(clr: number): void {
    this.color = clr;
  }

  measureText(beg = 0, len = -1): number {
    const str = len < 0 ? this.text.substring(beg) : this.text.substring(beg, beg + len);
    return this.font.measureText(str);
  }

  override get bound(): Rect {
    if (this.inkBound) {
      const b = this.font.charBound(this.text);
      return new Rect(0, Math.min(b.top, 0), this.width, Math.max(b.bottom, 0));
    }
    const fm = this.font.metrics;
    return new Rect(0, fm.ascent, this.width, fm.descent);
  }

  override update(): void {
    this.width = this.measureText();
    this.height = this.font.size;
  }
}

export class GraphicLine extends PageItem {
  p0 = new Point();
  p1 = new Point();
  strokeWidth = 1;
  strokeColor = 0;

  protected override applyColor(clr: number): void {
    this.strokeColor = clr;
  }

  override update(): void {
    this.y += this.p0.y;
    this.x += this.p0.x;
    this.p1 = this.p1.offset(-this.p0.x, -this.p0.y);
    this.p0 = new Point(0, 0);
    this.width = Math.abs(this.p1.x);
    this.height = Math.abs(this.p1.y);
    if (this.p0.x === this.p1.x) this.width = this.strokeWidth;
    if (this.p0.y === this.p1.y) this.height = this.strokeWidth;
  }
}

/** SMuFL 文字要的两样：字（Bravura 那支）与字形元数据（量紧包围盒）。 */
export interface SmuflSource {
  smuflMeta: MetaData;
  smuflFont: Font;
}

export class SmuflText extends TextFrame {
  asPath = false;
  meta: MetaData;
  constructor(options: SmuflSource) {
    super();
    this.meta = options.smuflMeta;
    this.font = options.smuflFont;
  }
  /**
   * 紧包围盒，**页面坐标**（y 向下为正，`top` 在上、负值在基线之上）。
   *
   * ⚠ SMuFL 元数据的 `bBoxNE/SW` 是**乐谱坐标**：y **向上为正**，NE 是墨迹**上**缘、
   * SW 是**下**缘。这里翻过来对齐 `PageItem.bound` 的口径（`Rect(left, top, right, bottom)`），
   * 不然 `Group.update()` / `childrenBound` 会把整个记号的盒子摆到基线下方一截，
   * 凡是拿它做避让的都会多让三四个点——fermata（302）、重音（470）、Segno（064）
   * 全踩过这个坑，`addTuplet` 当年干脆绕开它自己读元数据。
   */
  override get bound(): Rect {
    const first = this.text[0];
    const box = this.meta.getBBox(first);
    if (!box) throw new Error("no smufl bbox");
    const sp = this.font.size / 4; // SMuFL：字号 = 4 个 staff space
    const l = box.bBoxSW[0] * sp;
    const r = box.bBoxNE[0] * sp;
    return new Rect(l, -box.bBoxNE[1] * sp, r, -box.bBoxSW[1] * sp);
  }
}

/** 子树里带类 `cls` 的项，按页面树顺序；命中的项不再往下找。
 *  可视化编辑按它从音符格里认出挂在音符上的记号（和弦名 `chord-group`、装饰 `artic`…）。 */
export function findByClass(root: PageItem, cls: string): PageItem[] {
  const out: PageItem[] = [];
  const walk = (it: PageItem): void => {
    if (it !== root && it.classes.has(cls)) {
      out.push(it);
      return;
    }
    for (const c of it.children) walk(c);
  };
  walk(root);
  return out;
}
