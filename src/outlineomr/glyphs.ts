// 转曲矢量谱的**字形对象**：哪些路径是线（谱线、符干、符杠、弧……交给 `staffomr` 的几何步骤），
// 哪些是字形（符头、谱号、升降号、数字、汉字……），字形又认成哪个音乐符号。
//
// 转曲（文字转成路径）的 PDF 没有文字层，音乐字体的字形也成了路径——`staffomr/page.ts::findSymbols`
// 查的是文字层，一个也拿不到。好在**一个字形一个路径对象**（Ghostscript 转出来的：符头、附点、汉字各自一个），
// 不存在位图那边的粘连。字形认法：轮廓签名（`omrkit/glyphdict.ts::shapeSig`）对 `glyphmap.json` 的各类
// **跨字体**找最近的——那份字典是 Maestro/Opus/Anastasia 的字形，与这里的字体不同，但同一个符号形状相近，
// 尺寸按「音乐字体 1 em = 谱表高 = 4 线距」归一后也相当（祢話如甘霖：符头 15~28、符尾 5~11、谱号 26，文字 90 开外）。
//
// 无 DOM 依赖（Node CLI 要 import）。
import { DRAW_CLOSE, DRAW_MOVE, drawOpArity, matApplyX, matApplyY, type VecObj } from "../omrkit/vector";
import { decodeSig, shapeSig, sigDistance } from "../omrkit/glyphdict";
import { isSmuflName, type SmuflName } from "../staffomr/glyphs";
import type { StaffGlyphDict } from "../staffomr/staffglyphs";
import type { Rect } from "../omrkit/types";

/**
 * 线类对象：无曲线的线段与四边形（谱线、符干、加线、小节线、符杠、减时线、房子的折线），
 * 以及有曲线、又扁又长的（圆滑线、延音线）。其余都当字形。
 */
export function isGeometry(o: VecObj, sp?: number): boolean {
  if (o.curves === 0 && o.segs <= 5) return true;
  // 弧是一个闭合的月牙：拆不出第二块。一整串字（「Badd9」「D.S.al.Fine.」画成一个对象）同样又扁又长，但拆得开
  if (o.curves === 0 || splitPieces(o).length !== 1) return false;
  if (o.bbox.w >= o.bbox.h * ARC_ASPECT) return true;
  // 斜着走的弧（跨行延音线在行末的半截往右下拐，祢話如甘霖 15×13 点）：不扁，但细——墨只占外框一小块
  return sp !== undefined && o.bbox.w >= sp * ARC_MIN_W && inkRatio(o) < ARC_INK;
}
/** 斜弧：至少这么宽（线距；括号这类细字形窄），墨占外框不到这么多 */
const ARC_MIN_W = 2;
const ARC_INK = 0.15;

/** 轮廓签名里墨占外框的比例（签名按长边归一，短边那一向只占一部分格子） */
function inkRatio(o: VecObj): number {
  const sig = shapeSig(o.data);
  let ink = 0;
  for (const v of sig) ink += v;
  const long = Math.max(o.bbox.w, o.bbox.h) || 1;
  const area = (30 * o.bbox.w / long) * (30 * o.bbox.h / long);
  return area > 0 ? ink / area : 1;
}
/** 有曲线的对象宽过高的几倍算弧（祢話如甘霖的弧 3~10 倍，最扁的字形「一」没有曲线） */
const ARC_ASPECT = 2.5;

/** 对象在设备坐标下的子路径（各自的数据切片与外框）。 */
interface SubPiece {
  start: number;
  end: number;
  box: { x0: number; y0: number; x1: number; y1: number };
}

function subPieces(o: VecObj): SubPiece[] {
  const d = o.data;
  const out: SubPiece[] = [];
  let cur: SubPiece | null = null;
  const grow = (x: number, y: number) => {
    const X = matApplyX(o.ctm, x, y);
    const Y = matApplyY(o.ctm, x, y);
    const b = cur!.box;
    if (X < b.x0) b.x0 = X;
    if (X > b.x1) b.x1 = X;
    if (Y < b.y0) b.y0 = Y;
    if (Y > b.y1) b.y1 = Y;
  };
  let i = 0;
  while (i < d.length) {
    const at = i;
    const c = d[i++];
    const n = drawOpArity(c);
    if (n < 0) break;
    if (c === DRAW_MOVE || !cur) {
      if (cur) cur.end = at;
      cur = { start: at, end: d.length, box: { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity } };
      out.push(cur);
    }
    for (let k = 0; k < n; k += 2) grow(d[i + k], d[i + k + 1]);
    i += n;
    if (c === DRAW_CLOSE && cur) cur.end = i;
  }
  if (cur && cur.end === d.length) cur.end = d.length;
  return out.filter((p) => Number.isFinite(p.box.x0));
}

/**
 * 一个对象里画了好几个字形的（调号的五个升号是**一个**路径、标题一行字也可能是一个）：按子路径外框相交并成块，
 * 一块一个字形。块内的子路径（外轮廓与内腔）外框必相交；挨着不碰的两个字形分开。
 * 只有一块的原样返回。
 */
export function splitPieces(o: VecObj): VecObj[] {
  const subs = subPieces(o);
  if (subs.length <= 1) return [o];
  const parent = subs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const meet = (a: SubPiece["box"], b: SubPiece["box"]) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
  for (let i = 0; i < subs.length; i++) for (let j = i + 1; j < subs.length; j++) if (meet(subs[i].box, subs[j].box)) parent[find(i)] = find(j);
  const groups = new Map<number, SubPiece[]>();
  subs.forEach((s, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), s]));
  if (groups.size <= 1) return [o];
  const out: VecObj[] = [];
  for (const g of groups.values()) {
    const len = g.reduce((a, s) => a + s.end - s.start, 0);
    const data = new Float32Array(len);
    let k = 0;
    for (const s of g.sort((a, b) => a.start - b.start)) {
      data.set(o.data.subarray(s.start, s.end), k);
      k += s.end - s.start;
    }
    const x0 = Math.min(...g.map((s) => s.box.x0));
    const y0 = Math.min(...g.map((s) => s.box.y0));
    const x1 = Math.max(...g.map((s) => s.box.x1));
    const y1 = Math.max(...g.map((s) => s.box.y1));
    out.push({ ...o, data, bbox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
  }
  return out.sort((a, b) => a.bbox.x - b.bbox.x);
}

/** 认得出的音乐符号：签名距离不过这么多（32×32 签名的汉明距离）。符头 15~28、谱号 26、拍号数字 ~50；文字 90 开外 */
const SIG_MAX = 60;
/** 附点、反复点这种小圆点签名抖得厉害（量化后只有几个像素宽）：放到这么多，另要近圆 */
const DOT_SIG_MAX = 100;
/** 尺寸（em）差多少以内才比签名 */
const SIZE_TOL = 0.08;
/** 签名近到这个份上（几乎同形）时尺寸放到 `SIZE_LOOSE`：别的字体同一个符号比例不同 */
const SIG_SAME = 20;
const SIZE_LOOSE = 0.25;

/** 跨字体的音乐字形查表：`glyphmap.json` 各类的签名与尺寸（em）。 */
export class OutlineGlyphLookup {
  private classes: { sig: Uint8Array; w: number; h: number; smufl: SmuflName }[] = [];

  constructor(dict: StaffGlyphDict) {
    for (const c of dict.classes) {
      if (!c.smufl || !isSmuflName(c.smufl)) continue;
      this.classes.push({ sig: decodeSig(c.sig), w: c.w, h: c.h, smufl: c.smufl });
    }
  }

  /**
   * 一个字形对象（设备坐标）认成哪个符号；认不出（多半是文字）为 null。
   * @param sp 本页线距：1 em = 4 线距（音乐字体的字号就是谱表高）
   */
  classify(o: VecObj, sp: number): { code: SmuflName; d: number } | null {
    const em = sp * 4;
    const w = o.bbox.w / em;
    const h = o.bbox.h / em;
    const sig = shapeSig(o.data);
    let best: SmuflName | null = null;
    let bd = Infinity;
    let loose: SmuflName | null = null;
    let ld = Infinity;
    for (const c of this.classes) {
      const dw = Math.abs(c.w - w);
      const dh = Math.abs(c.h - h);
      if (dw > SIZE_LOOSE || dh > SIZE_LOOSE) continue;
      const d = sigDistance(c.sig, sig);
      if (dw <= SIZE_TOL && dh <= SIZE_TOL && d < bd) (bd = d), (best = c.smufl);
      if (d < ld) (ld = d), (loose = c.smufl);
    }
    // 形状几乎一样、只是这套字体画得大小不同（祢話如甘霖调号的升号比 Opus 矮三成，签名距离 1~3）
    if (loose && ld <= SIG_SAME) return { code: loose, d: ld };
    if (!best) return null;
    if (bd <= SIG_MAX) return { code: best, d: bd };
    // 小圆点：近圆、半格上下（附点 0.47 格）
    const round = Math.abs(o.bbox.w - o.bbox.h) <= Math.max(o.bbox.w, o.bbox.h) * 0.25 && o.bbox.w <= sp * 0.7;
    if (best === "augmentationDot" && bd <= DOT_SIG_MAX && round) return { code: best, d: bd };
    return null;
  }
}

/** 对象外框（设备坐标）→ `Rect`。 */
export function objRect(o: VecObj): Rect {
  return { x: o.bbox.x, y: o.bbox.y, w: o.bbox.w, h: o.bbox.h };
}
