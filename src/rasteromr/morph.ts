// 二值图的标准形态学操作：连通块标记、面积开/闭运算、方形结构元的闭运算。
//
// 墨 = 1、白 = 0。面积类操作只看连通块大小，不动形状；闭运算的结构元是 (2r+1)² 的方块，
// 用积分图做膨胀/腐蚀，与 r 无关地线性时间。
import type { Binary } from "../omrkit/types";

/** 一个连通块：像素下标、面积、外接盒、碰没碰图边。 */
export interface Blob {
  px: number[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  edge: boolean;
}

/**
 * 标出值为 `val` 的全部连通块（`conn` 取 4 或 8）。
 * `keep` 只收回调判为真的块（省内存：大块的像素表不留）。
 */
export function components(bin: Binary, val: 0 | 1, conn: 4 | 8, keep: (n: number) => boolean = () => true): Blob[] {
  const { w, h, data } = bin;
  const seen = new Uint8Array(w * h);
  const out: Blob[] = [];
  const st: number[] = [];
  for (let s0 = 0; s0 < w * h; s0++) {
    if (data[s0] !== val || seen[s0]) continue;
    seen[s0] = 1;
    st.push(s0);
    const px: number[] = [];
    let x0 = w, x1 = 0, y0 = h, y1 = 0;
    let edge = false;
    while (st.length) {
      const i = st.pop()!;
      px.push(i);
      const x = i % w;
      const y = (i - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || (conn === 4 && dx && dy)) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (data[j] === val && !seen[j]) {
            seen[j] = 1;
            st.push(j);
          }
        }
    }
    if (keep(px.length)) out.push({ px, x0, y0, x1, y1, edge });
  }
  return out;
}

/** **面积开运算**：抹掉面积小于 `min` 的墨块（8 连通）。 */
export function areaOpen(bin: Binary, min: number): void {
  for (const b of components(bin, 1, 8, (n) => n < min)) for (const i of b.px) bin.data[i] = 0;
}

/** **面积闭运算**：填上面积小于 `max`、被墨围住（不碰图边）的白块（4 连通）。 */
export function areaClose(bin: Binary, max: number): void {
  for (const b of components(bin, 0, 4, (n) => n < max)) if (!b.edge) for (const i of b.px) bin.data[i] = 1;
}

/** 方形结构元 (2r+1)² 的膨胀（`dilate`）或腐蚀，结果写回。 */
function boxMorph(bin: Binary, r: number, dilate: boolean): void {
  const { w, h, data } = bin;
  const W = w + 1;
  const s = new Int32Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let run = 0;
    for (let x = 0; x < w; x++) {
      run += data[y * w + x];
      s[(y + 1) * W + x + 1] = s[y * W + x + 1] + run;
    }
  }
  const full = (2 * r + 1) * (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const n = s[y1 * W + x1] - s[y0 * W + x1] - s[y1 * W + x0] + s[y0 * W + x0];
      // 越界那部分按腐蚀不设防（图边的墨不因出界被蚀掉）
      const area = (x1 - x0) * (y1 - y0);
      data[y * w + x] = dilate ? (n > 0 ? 1 : 0) : n >= Math.min(full, area) ? 1 : 0;
    }
  }
}

/** **闭运算**（先膨胀后腐蚀），方形结构元 (2r+1)²：补上宽不过 2r 的白隙。 */
export function close(bin: Binary, r: number): void {
  if (r < 1) return;
  boxMorph(bin, r, true);
  boxMorph(bin, r, false);
}

/** 面积序列的 `p` 分位（空序列返回 0）。 */
export function quantile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((u, v) => u - v);
  return a[Math.min(a.length - 1, Math.floor(a.length * p))];
}
