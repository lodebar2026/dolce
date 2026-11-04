// 二值图的标准形态学操作：面积开/闭运算、方形结构元的闭运算、椭圆结构元的开运算（连通块标记在 `ccl.ts`）。
//
// 墨 = 1、白 = 0。面积类操作只看连通块大小，不动形状；闭运算的结构元是 (2r+1)² 的方块，
// 用积分图做膨胀/腐蚀，与 r 无关地线性时间。
import type { Binary } from "./types";
import { components } from "./ccl";
import { pixelKernels } from "./kernels";

/** **面积开运算**：抹掉面积小于 `min` 的墨块（8 连通）。 */
export function areaOpen(bin: Binary, min: number): void {
  for (const b of components(bin, 1, 8, (n) => n < min)) for (const i of b.px) bin.data[i] = 0;
}

/**
 * **面积闭运算**：填上面积小于 `max`、被墨围住（不碰图边）的白块（4 连通）。
 * 按行取白游程、上下两行游程有横向重叠就并（并查集）——白底那一整块几百万点不必逐点 flood。
 */
export function areaClose(bin: Binary, max: number): void {
  const { w, h, data } = bin;
  // 游程：行、起、止（闭区间）
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
      if (data[o + x]) {
        x++;
        continue;
      }
      const a = x;
      while (x < w && !data[o + x]) x++;
      const b = x - 1;
      const id = ry.length;
      ry.push(y);
      rx0.push(a);
      rx1.push(b);
      parent.push(id);
      // 上一行与 [a,b] 重叠的游程并进来（上一行游程按 x 递增，指针只往前走）
      while (j < prevEnd && rx1[j] < a) j++;
      for (let k = j; k < prevEnd && rx0[k] <= b; k++) {
        const ra = find(k);
        const rb = find(id);
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
      }
    }
    prevStart = curStart;
    prevEnd = ry.length;
  }
  const n = ry.length;
  const area = new Float64Array(n);
  const edge = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = find(i);
    area[r] += rx1[i] - rx0[i] + 1;
    if (ry[i] === 0 || ry[i] === h - 1 || rx0[i] === 0 || rx1[i] === w - 1) edge[r] = 1;
  }
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!edge[r] && area[r] < max) data.fill(1, ry[i] * w + rx0[i], ry[i] * w + rx1[i] + 1);
  }
}

/** 0/1 图的积分图（整型精确）：建好之后原图再改不影响它。 */
export class Integral {
  private readonly s: Int32Array;
  private readonly W: number;
  constructor(private readonly bin: Binary) {
    const { w, h, data } = bin;
    const s = new Int32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let run = 0;
      const src = y * w;
      const cur = (y + 1) * (w + 1);
      const up = y * (w + 1);
      for (let x = 0; x < w; x++) {
        run += data[src + x];
        s[cur + x + 1] = s[up + x + 1] + run;
      }
    }
    this.s = s;
    this.W = w + 1;
  }
  /** 半开矩形 [x0,x1)×[y0,y1) 的墨点数（调用方保证在图内）。 */
  rect(x0: number, y0: number, x1: number, y1: number): number {
    const s = this.s;
    const W = this.W;
    return s[y1 * W + x1] - s[y0 * W + x1] - s[y1 * W + x0] + s[y0 * W + x0];
  }
  /** 以 (x,y) 为中心、kw×kh 窗口的墨点数（越界按 0 计）。 */
  box(x: number, y: number, kw: number, kh: number): number {
    const { w, h } = this.bin;
    return this.rect(Math.max(0, x - (kw >> 1)), Math.max(0, y - (kh >> 1)), Math.min(w, x + (kw >> 1) + 1), Math.min(h, y + (kh >> 1) + 1));
  }
}

/** 方形结构元 (2r+1)² 的膨胀（`dilate`）或腐蚀，结果写回。 */
function boxMorph(bin: Binary, r: number, dilate: boolean): void {
  const { w, h, data } = bin;
  const nk = pixelKernels()?.boxMorph;
  if (nk) return nk(data, w, h, r, dilate);
  const ii = new Integral(bin);
  const full = (2 * r + 1) * (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const n = ii.rect(x0, y0, x1, y1);
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

/**
 * **开运算**（先腐蚀后膨胀），椭圆结构元，半轴 `rx`×`ry`（像素）：抹掉装不下这个椭圆的笔画——
 * 比椭圆细的谱线、符干、细弧都去掉，实心符头、符杠这类够粗的块原样留下。返回新图，不改原图。
 * 椭圆按行拆成横段：腐蚀时每段「全是墨」查本行向右的连续墨长，膨胀时把腐蚀结果的横段按各行段宽整段铺开
 *（只碰有墨的地方，不逐点扫整页）。
 */
export function ellipseOpen(bin: Binary, rx: number, ry: number): Binary {
  const { w, h, data } = bin;
  const nk = pixelKernels()?.ellipseOpen;
  if (nk) return { w, h, data: nk(data, w, h, rx, ry) };
  const n = 2 * ry + 1;
  const dys = new Int32Array(n);
  const ks = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const dy = i - ry;
    dys[i] = dy;
    ks[i] = Math.floor(rx * Math.sqrt(Math.max(0, 1 - (dy * dy) / ((ry + 0.5) * (ry + 0.5)))));
  }
  // 最宽的段（中行）先查，最容易判死
  const order = Array.from(dys.keys()).sort((a, b) => ks[b] - ks[a]);
  // 每点向右的连续墨长（封顶 2rx+1，够判任何一段就行）
  const cap = 2 * rx + 1;
  const runR = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let r = 0;
    for (let x = w - 1; x >= 0; x--) {
      r = data[o + x] ? Math.min(cap, r + 1) : 0;
      runR[o + x] = r;
    }
  }
  const er = new Uint8Array(w * h);
  for (let y = ry; y < h - ry; y++)
    for (let x = rx; x < w - rx; x++) {
      if (!data[y * w + x]) continue;
      let ok = true;
      for (const i of order) {
        const k = ks[i];
        if (runR[(y + dys[i]) * w + x - k] < 2 * k + 1) {
          ok = false;
          break;
        }
      }
      if (ok) er[y * w + x] = 1;
    }
  const out = new Uint8Array(w * h);
  for (let y = ry; y < h - ry; y++) {
    const o = y * w;
    for (let x = rx; x < w - rx; x++) {
      if (!er[o + x]) continue;
      let b = x;
      while (b + 1 < w && er[o + b + 1]) b++;
      for (let i = 0; i < n; i++) {
        const t = y + dys[i];
        if (t < 0 || t >= h) continue;
        out.fill(1, t * w + Math.max(0, x - ks[i]), t * w + Math.min(w - 1, b + ks[i]) + 1);
      }
      x = b;
    }
  }
  return { w, h, data: out };
}
