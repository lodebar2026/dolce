// 连通域标注（`connectedComponents` 按行游程并查集，`components` 迭代式 flood fill，都不递归）。两个口径：
//   - `connectedComponents`：墨的 8 邻接块，给包围盒、面积、质心，可出标号图（对应 musicpp 用 cv::findContours 得到的 contour 包围盒）；
//   - `components`：墨或白、4 或 8 邻接，给像素表与碰没碰图边（面积开闭运算、找内腔用）。
import type { Binary, Component, Rect } from "./types";
import { pixelKernels } from "./kernels";

/**
 * @param out 可选的**标号图**（长 `w*h`，0 = 背景）：传进来就把每个像素属于哪个块写进去。
 *        `src/rasteromr/contour.ts` 要靠它做「像素 → 块」的查表；自己再 flood 一遍
 *        容易与这里的分块不一致（面积不到 `minArea` 被丢掉的小块会把种子引偏）。
 */
export function connectedComponents(bin: Binary, minArea = 4, out?: Int32Array): Component[] {
  const { w, h, data } = bin;
  const labels = out ?? new Int32Array(w * h);
  const nk = pixelKernels()?.connectedComponents;
  if (nk) {
    const f = nk(data, w, h, minArea, labels);
    const comps: Component[] = [];
    for (let i = 0; i < f.length; i += 8) comps.push({ id: f[i], bbox: { x: f[i + 1], y: f[i + 2], w: f[i + 3], h: f[i + 4] }, area: f[i + 5], cx: f[i + 6], cy: f[i + 7] });
    return comps;
  }
  labels.fill(0);
  // 按行取墨游程，上下两行游程横向相接（含斜角，8 邻接）就并。游程按光栅序编号、并查集总挂到小号上，
  // 根就是块里光栅序最早的那段——块号照「块首像素的光栅序」发，与逐点 flood 的编号一致
  const ry: number[] = [];
  const rx0: number[] = [];
  const rx1: number[] = [];
  const parent: number[] = [];
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  let prevStart = 0;
  let prevEnd = 0;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    const curStart = ry.length;
    let j = prevStart;
    for (let x = 0; x < w; ) {
      if (data[o + x] !== 1) {
        x++;
        continue;
      }
      const a = x;
      while (x < w && data[o + x] === 1) x++;
      const b = x - 1;
      const id = ry.length;
      ry.push(y);
      rx0.push(a);
      rx1.push(b);
      parent.push(id);
      while (j < prevEnd && rx1[j] < a - 1) j++;
      for (let k = j; k < prevEnd && rx0[k] <= b + 1; k++) {
        const ra = find(k);
        const rb = find(id);
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
      }
    }
    prevStart = curStart;
    prevEnd = ry.length;
  }
  const n = ry.length;
  const label = new Int32Array(n);
  const area: number[] = [];
  const sx: number[] = [];
  const sy: number[] = [];
  const minX: number[] = [];
  const maxX: number[] = [];
  const minY: number[] = [];
  const maxY: number[] = [];
  let next = 0;
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let c: number;
    if (r === i) {
      c = next++;
      area.push(0), sx.push(0), sy.push(0), minX.push(w), maxX.push(0), minY.push(ry[i]), maxY.push(0);
    } else c = label[r];
    label[i] = c;
    const y = ry[i];
    const a = rx0[i];
    const b = rx1[i];
    const len = b - a + 1;
    area[c] += len;
    sx[c] += ((a + b) * len) / 2;
    sy[c] += y * len;
    if (a < minX[c]) minX[c] = a;
    if (b > maxX[c]) maxX[c] = b;
    if (y > maxY[c]) maxY[c] = y;
    labels.fill(c + 1, y * w + a, y * w + b + 1);
  }
  const comps: Component[] = [];
  for (let c = 0; c < next; c++) {
    if (area[c] < minArea) continue;
    const bbox: Rect = { x: minX[c], y: minY[c], w: maxX[c] - minX[c] + 1, h: maxY[c] - minY[c] + 1 };
    comps.push({ id: c + 1, bbox, area: area[c], cx: sx[c] / area[c], cy: sy[c] / area[c] });
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
