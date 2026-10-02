// 带方括号的连音（位图路）：四分音符以上的三连音不打符杠，画一条被数字断开的方括号。
//
// 下游 `findTuplets` 要一个数字符号加两截横段，位图路两样都没有：数字「3」不在形状字典里，括号常是斜的（不成横段）、
// 还带着两端的小钩。这里按**结构**认：一个数字大小的墨块，左右各贴着一条细长的墨（括号的两臂），三样排成一线；
// 括号罩着的那行谱上正好三个音才算。数字本身不认字形——「两臂夹一块」这个结构已经够特别。
import type { SPage, Staff } from "../staffomr/model";
import type { StaffNote } from "../staffomr/notedata";
import type { Contour } from "./contour";

/** 数字块的宽、高（格）。 */
const DIGIT_W: [number, number] = [0.45, 1.2];
const DIGIT_H: [number, number] = [0.8, 1.6];
/** 括号的臂：最短（格）、最高（格，斜括号加小钩）、平均粗细上限（格）。 */
const ARM_W = 1.0;
const ARM_H = 1.6;
const ARM_THICK = 0.4;
/** 臂与数字的横向间隙上限（格）、臂的纵向中心离数字中心的上限（格）。 */
const ARM_GAP = 1.2;
const ARM_DY = 1.2;
/** 括号离它那行谱的距离上限（格）。 */
const REACH = 6;

export interface RasterTuplet {
  notes: StaffNote[];
  /** 数字与两臂的 contour（记账用）。 */
  contours: Contour[];
}

/**
 * 找带方括号的三连音。`cands` 是无主的（或只被歌词带罩住的）contour。
 * 只返回分组，不改时值——调用方决定收不收。
 */
export function findRasterTuplets(pg: SPage, cands: Contour[], notes: StaffNote[], sp: number): RasterTuplet[] {
  const out: RasterTuplet[] = [];
  const arms = cands.filter((c) => c.w >= ARM_W && c.h <= ARM_H && c.area / c.bbox.w <= sp * ARM_THICK);
  for (const d of cands) {
    if (d.w < DIGIT_W[0] || d.w > DIGIT_W[1] || d.h < DIGIT_H[0] || d.h > DIGIT_H[1]) continue;
    const dl = d.bbox.x;
    const dr = d.bbox.x + d.bbox.w;
    const near = (a: Contour) => Math.abs(a.bbox.y + a.bbox.h / 2 - d.cy) <= sp * ARM_DY;
    const left = arms.filter((a) => a !== d && near(a) && a.bbox.x + a.bbox.w <= dl + sp * 0.2 && dl - (a.bbox.x + a.bbox.w) <= sp * ARM_GAP).sort((p, q) => q.bbox.x + q.bbox.w - (p.bbox.x + p.bbox.w))[0];
    const right = arms.filter((a) => a !== d && near(a) && a.bbox.x >= dr - sp * 0.2 && a.bbox.x - dr <= sp * ARM_GAP).sort((p, q) => p.bbox.x - q.bbox.x)[0];
    if (!left || !right) continue;
    const x0 = left.bbox.x;
    const x1 = right.bbox.x + right.bbox.w;
    // 括号罩着的那行谱：上下最近、跨度里正好三个音（和弦算一个，休止也算）
    let best: { st: Staff; grp: StaffNote[]; d: number } | null = null;
    for (const st of pg.staves) {
      const dist = d.cy < st.box.top ? st.box.top - d.cy : d.cy > st.box.bottom ? d.cy - st.box.bottom : 0;
      if (dist > sp * REACH) continue;
      const span = notes.filter((n) => n.staff === st && !n.grace && n.x >= x0 - sp * 1.2 && n.x <= x1 + sp * 0.6);
      const mains = span.filter((n) => !n.chordExtra);
      // 同一行两个声部时只取离括号近的那一个声部
      const voices = [...new Set(mains.map((n) => n.voice))];
      for (const v of voices) {
        const grp = mains.filter((n) => n.voice === v);
        if (grp.length !== 3) continue;
        if (!best || dist < best.d) best = { st, grp: span.filter((n) => n.voice === v), d: dist };
      }
    }
    if (!best) continue;
    out.push({ notes: best.grp, contours: [d, left, right] });
  }
  return out;
}
