// 连通域标注（迭代式 flood fill，避免递归爆栈）。两个口径：
//   - `connectedComponents`：墨的 8 邻接块，给包围盒、面积、质心，可出标号图（对应 musicpp 用 cv::findContours 得到的 contour 包围盒）；
//   - `components`：墨或白、4 或 8 邻接，给像素表与碰没碰图边（面积开闭运算、找内腔用）。
import type { Binary, Component, Rect } from "./types";

/**
 * @param out 可选的**标号图**（长 `w*h`，0 = 背景）：传进来就把每个像素属于哪个块写进去。
 *        `src/rasteromr/contour.ts` 要靠它做「像素 → 块」的查表；自己再 flood 一遍
 *        容易与这里的分块不一致（面积不到 `minArea` 被丢掉的小块会把种子引偏）。
 */
export function connectedComponents(bin: Binary, minArea = 4, out?: Int32Array): Component[] {
  const { w, h, data } = bin;
  const labels = out ?? new Int32Array(w * h);
  labels.fill(0);
  const comps: Component[] = [];
  let next = 1;
  const stack: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (data[idx] !== 1 || labels[idx] !== 0) continue;
      // 新连通块
      const id = next++;
      let minX = x, maxX = x, minY = y, maxY = y, area = 0, sx = 0, sy = 0;
      stack.length = 0;
      stack.push(idx);
      labels[idx] = id;
      while (stack.length) {
        const cur = stack.pop()!;
        const cy = (cur / w) | 0;
        const cx = cur - cy * w;
        area++; sx += cx; sy += cy;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            if (nx < 0 || nx >= w) continue;
            const nIdx = ny * w + nx;
            if (data[nIdx] === 1 && labels[nIdx] === 0) {
              labels[nIdx] = id;
              stack.push(nIdx);
            }
          }
        }
      }
      if (area < minArea) continue;
      const bbox: Rect = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
      comps.push({ id, bbox, area, cx: sx / area, cy: sy / area });
    }
  }
  return comps;
}

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
