// 转曲矢量谱的**小条栅格化**：歌词、和弦、简谱、页眉这些文字要送 OCR，OCR 吃位图。
// 只画落在条里的那几个对象（整页不画），对象之间本来就分开，画出来也不粘。
//
// 自己写扫描线，不用 canvas：浏览器与 Node 要画出**逐像素相同**的条——OCR 缓存按条的内容指纹寻址
// （`omrkit/contentkey.ts`），两边差一个像素就对不上缓存。无 DOM 依赖。
import { DRAW_CLOSE, DRAW_CUBIC, DRAW_LINE, DRAW_MOVE, DRAW_QUAD, drawOpArity, matApplyX, matApplyY, type VecObj } from "../omrkit/vector";
import type { Binary, Rect } from "../omrkit/types";

/** 曲线细分段数（条的分辨率下一段不过一两个像素） */
const CURVE_STEPS = 8;

/** 对象的子路径压成折线（设备坐标），带「闭合」标记。 */
function rings(o: VecObj): { pts: number[]; closed: boolean }[] {
  const d = o.data;
  const m = o.ctm;
  const out: { pts: number[]; closed: boolean }[] = [];
  let cur: { pts: number[]; closed: boolean } | null = null;
  let px = 0;
  let py = 0;
  const push = (x: number, y: number) => {
    px = x;
    py = y;
    cur!.pts.push(matApplyX(m, x, y), matApplyY(m, x, y));
  };
  let i = 0;
  while (i < d.length) {
    const c = d[i++];
    const n = drawOpArity(c);
    if (n < 0) break;
    if (c === DRAW_MOVE || !cur) {
      cur = { pts: [], closed: false };
      out.push(cur);
    }
    if (c === DRAW_MOVE || c === DRAW_LINE) push(d[i], d[i + 1]);
    else if (c === DRAW_CUBIC) {
      const [x0, y0] = [px, py];
      for (let t = 1; t <= CURVE_STEPS; t++) {
        const u = t / CURVE_STEPS;
        const v = 1 - u;
        push(
          v * v * v * x0 + 3 * v * v * u * d[i] + 3 * v * u * u * d[i + 2] + u * u * u * d[i + 4],
          v * v * v * y0 + 3 * v * v * u * d[i + 1] + 3 * v * u * u * d[i + 3] + u * u * u * d[i + 5],
        );
      }
    } else if (c === DRAW_QUAD) {
      const [x0, y0] = [px, py];
      for (let t = 1; t <= CURVE_STEPS; t++) {
        const u = t / CURVE_STEPS;
        const v = 1 - u;
        push(v * v * x0 + 2 * v * u * d[i] + u * u * d[i + 2], v * v * y0 + 2 * v * u * d[i + 1] + u * u * d[i + 3]);
      }
    } else if (c === DRAW_CLOSE) cur.closed = true;
    i += n;
  }
  return out.filter((r) => r.pts.length >= 4);
}

/** 非零环绕填充一组多边形（像素坐标）到 `bin`。 */
function fillPolys(bin: Binary, polys: number[][]): void {
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of polys)
    for (let i = 1; i < p.length; i += 2) {
      if (p[i] < y0) y0 = p[i];
      if (p[i] > y1) y1 = p[i];
    }
  const ya = Math.max(0, Math.floor(y0));
  const yb = Math.min(bin.h - 1, Math.ceil(y1));
  for (let py = ya; py <= yb; py++) {
    const y = py + 0.5;
    const xs: { x: number; dir: number }[] = [];
    for (const p of polys) {
      const n = p.length;
      for (let i = 0; i < n; i += 2) {
        const xA = p[i];
        const yA = p[i + 1];
        const xB = p[(i + 2) % n];
        const yB = p[(i + 3) % n];
        if (yA === yB) continue;
        if (y >= Math.min(yA, yB) && y < Math.max(yA, yB)) xs.push({ x: xA + ((y - yA) / (yB - yA)) * (xB - xA), dir: yB > yA ? 1 : -1 });
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a.x - b.x);
    let wind = 0;
    for (let k = 0; k < xs.length - 1; k++) {
      wind += xs[k].dir;
      if (wind === 0) continue;
      const from = Math.max(0, Math.ceil(xs[k].x - 0.5));
      const to = Math.min(bin.w - 1, Math.floor(xs[k + 1].x - 0.5));
      for (let px = from; px <= to; px++) bin.data[py * bin.w + px] = 1;
    }
  }
}

/** 折线描边（线宽 `lw` 像素，至少一像素）：每段画成一个四边形。 */
function strokePoly(bin: Binary, pts: number[], closed: boolean, lw: number): void {
  const half = Math.max(0.5, lw / 2);
  const n = pts.length / 2;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const ax = pts[2 * i];
    const ay = pts[2 * i + 1];
    const bx = pts[(2 * (i + 1)) % pts.length];
    const by = pts[(2 * (i + 1) + 1) % pts.length];
    const len = Math.hypot(bx - ax, by - ay);
    if (len === 0) continue;
    const nx = ((ay - by) / len) * half;
    const ny = ((bx - ax) / len) * half;
    // 两头各延半个线宽（方头），短段不至于断开
    const ex = ((bx - ax) / len) * half;
    const ey = ((by - ay) / len) * half;
    fillPolys(bin, [[ax - ex + nx, ay - ey + ny, bx + ex + nx, by + ey + ny, bx + ex - nx, by + ey - ny, ax - ex - nx, ay - ey - ny]]);
  }
}

/**
 * 把 `objs` 画进 `rect`（设备坐标）这块，`scale` 像素 / 设备单位。返回二值图（1 = 墨）。
 * 填充的按非零环绕填，描边的按线宽描（算子是 fillStroke 的两样都画）。
 */
export function rasterizeObjs(objs: readonly VecObj[], rect: Rect, scale: number): Binary {
  const w = Math.max(1, Math.round(rect.w * scale));
  const h = Math.max(1, Math.round(rect.h * scale));
  const bin: Binary = { w, h, data: new Uint8Array(w * h) };
  const toPx = (pts: number[]) => pts.map((v, i) => (i % 2 === 0 ? (v - rect.x) * scale : (v - rect.y) * scale));
  for (const o of objs) {
    const rs = rings(o).map((r) => ({ pts: toPx(r.pts), closed: r.closed }));
    if (!rs.length) continue;
    // 按绘制算子画：`fill` / `stroke` 只是图形状态里的颜色，算子没说描就不描（字形描一圈 0.74 点会糊成一团）
    if (/fill/i.test(o.paint)) fillPolys(bin, rs.filter((r) => r.pts.length >= 6).map((r) => r.pts));
    if (/stroke/i.test(o.paint)) for (const r of rs) strokePoly(bin, r.pts, r.closed, o.lineWidth * scale);
  }
  return bin;
}
