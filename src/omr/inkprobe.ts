// 简谱识别的**墨量小工具**：盒内逐列 / 逐行墨数、收紧到墨的盒、叠着的横线。预拆、数字核、建音与主流程共用。
import type { Binary, Component, Rect } from "../omrkit/types";
import { rcy } from "../omrkit/types";
import { overlapX } from "../omrkit/geom";

/** 块内每列前景像素数（在 [y0, yLimit) 行范围内统计）。 */
export function columnInk(bin: Binary, b: Rect, y0: number, yLimit: number): number[] {
  const cols = new Array(b.w).fill(0);
  for (let xx = 0; xx < b.w; xx++) {
    let cnt = 0;
    for (let yy = y0; yy < yLimit; yy++) {
      if (bin.data[(b.y + yy) * bin.w + (b.x + xx)]) cnt++;
    }
    cols[xx] = cnt;
  }
  return cols;
}

/** 块内每行前景像素数（[0, b.h)）。用于探测「弧帽 + 数字」纵向结构。 */
export function rowInk(bin: Binary, b: Rect): number[] {
  const rows = new Array(b.h).fill(0);
  for (let yy = 0; yy < b.h; yy++) {
    let cnt = 0;
    for (let xx = 0; xx < b.w; xx++) {
      if (bin.data[(b.y + yy) * bin.w + (b.x + xx)]) cnt++;
    }
    rows[yy] = cnt;
  }
  return rows;
}

/** 在 [x0,x1) 列、[y0,yLimit) 行范围内求前景紧包围盒（相对块原点的绝对坐标）。 */
export function tightBox(bin: Binary, b: Rect, x0: number, x1: number, y0: number, yLimit: number): Rect | null {
  let minX = x1, maxX = x0 - 1, minY = yLimit, maxY = -1;
  for (let yy = y0; yy < yLimit; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      if (bin.data[(b.y + yy) * bin.w + (b.x + xx)]) {
        if (xx < minX) minX = xx; if (xx > maxX) maxX = xx;
        if (yy < minY) minY = yy; if (yy > maxY) maxY = yy;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: b.x + minX, y: b.y + minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** 这条横线上/下方紧挨着另一条同 x 的横线？**增时线从不上下叠**（`- -` 是左右并排），
 *  上下叠的只可能是减时线。倚音那两条减时线印在主音符**左上方**、恰好落在前一个音符右侧
 *  的空隙里、又与数字带同高（迦南诗选《求主引导我每一天》第 1 行 `1 ²⁼3 - -` 实测两条
 *  678×3、Δcy −0.27/−0.42），只靠位置判不出来，会给前一个音符平白添两根增时线。 */
export function stackedHline(hlines: Component[], kb: Rect, numH: number): boolean {
  return hlines.some((o) => {
    const ob = o.bbox;
    if (ob === kb) return false;
    const dy = rcy(ob) - rcy(kb);
    if (dy === 0 || Math.abs(dy) > numH * 0.45) return false;
    return overlapX(ob, kb) >= Math.min(ob.w, kb.w) * 0.5;
  });
}

/** 矩形内的墨迹占比。 */
export function inkFill(bin: Binary, r: Rect): number {
  let ink = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (bin.data[y * bin.w + x]) ink++;
  return r.w * r.h ? ink / (r.w * r.h) : 0;
}

/** 矩形内的**实心**墨迹像素数：只数上下左右四邻都有墨的像素（一次腐蚀后剩下的面积）。 */
export function inkCount(bin: Binary, r: Rect): number {
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < bin.w && y < bin.h && bin.data[y * bin.w + x] === 1;
  let ink = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++)
    if (on(x, y) && on(x - 1, y) && on(x + 1, y) && on(x, y - 1) && on(x, y + 1)) ink++;
  return ink;
}
