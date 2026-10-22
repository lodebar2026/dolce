// 谱线的数据结构与读法：基本单位（线宽与线距）、一行谱的五条线（弯、斜的带逐列偏移）、随 x 的线位、音级换算、全页谱线网格。
// 谱线怎么找见 `stafffind.ts`（按逐列游程，不用行投影）。
//
// 后面所有几何门槛都按线距写——与矢量路同一个口径（`page.ts`：「一切长度都是小节线高度 H 的比例」）。
import type { Binary } from "../omrkit/types";
import { definePortable } from "./portablefn";

/** 页面的基本单位。musicpp `omr/pixel.cpp::findUnit` 量的就是这两个。 */
export interface RasterUnit {
  /** 谱线线宽（px）。 */
  lineThick: number;
  /** 一个线距（px，两条相邻谱线的中心距）。 */
  space: number;
  /** 谱表高度 = 小节线高度 H = 四个线距。矢量路的 `SPage.barlineHeight` 就是它。 */
  height: number;
}

/**
 * **曲线谱线**：一条线相对它的 `y` 的逐列偏移（`step` 像素一采样，从 x = 0 起；采样之间线性插值、两头沿用端值）。
 * 识别不推平、不纠斜（`rasterpage.ts::rasterizeImage`），弯、斜的谱线就用它表示；平直的线不挂（见 `dewarp.ts::fitStaffCurves`），
 * 一切判据照常数 y 走。
 */
export interface LineCurve {
  step: number;
  d: Float32Array;
}

/** 线上挂的曲线当成 `lift` 函数（x 处相对名义线位的偏移）；平直的线没有。 */
export function liftOf(l: LineRef): ((x: number) => number) | undefined {
  const c = l.curve;
  return c ? (x: number) => curveAt(c, x) : undefined;
}

/** `lift`（x 处相对名义线位的偏移）在 [x0, x1] 上的最小、最大值，四像素一采。没有 `lift` 是 [0, 0]。 */
export function liftRange(lift: ((x: number) => number) | undefined, x0: number, x1: number): [number, number] {
  if (!lift) return [0, 0];
  let lo = Infinity;
  let hi = -Infinity;
  for (let x = x0; ; x = Math.min(x1, x + 4)) {
    const d = lift(x);
    if (d < lo) lo = d;
    if (d > hi) hi = d;
    if (x >= x1) break;
  }
  return [lo, hi];
}

/** 横带 [y0, y1) **按谱线偏移逐列上下挪**成的子图：列 x 的第 y 行取原图第 `y0 + y + round(lift(x))` 行，
 *  出了页的填白。整像素挪列、不插值，笔画与原图逐像素相同；在子图里切出的框挪回原图时按框心的 x 加回偏移。 */
export function levelRows(bin: Binary, y0: number, y1: number, lift: (x: number) => number): Binary {
  const w = bin.w;
  const h = Math.max(0, y1 - y0);
  const data = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    const d = y0 + Math.round(lift(x));
    for (let y = 0; y < h; y++) {
      const sy = d + y;
      if (sy >= 0 && sy < bin.h) data[y * w + x] = bin.data[sy * w + x];
    }
  }
  return { w, h, data };
}

/** 带不带曲线的线都认：`y` 是整条线的名义位置。 */
export interface LineRef {
  y: number;
  curve?: LineCurve;
}

/** 曲线在 x 处的偏移。 */
export function curveAt(c: LineCurve, x: number): number {
  const t = x / c.step;
  const n = c.d.length;
  if (t <= 0) return c.d[0];
  if (t >= n - 1) return c.d[n - 1];
  const i = Math.floor(t);
  return c.d[i] + (c.d[i + 1] - c.d[i]) * (t - i);
}

/** 线在 x 处的 y。 */
export function lineYAt(l: LineRef, x: number): number {
  return l.curve ? l.y + curveAt(l.curve, x) : l.y;
}

/** 一条谱线：中心 y、上下沿、左右端；弯、斜的另带逐列偏移 `curve`。 */
export interface StaffLineRun {
  y: number;
  curve?: LineCurve;
  y0: number;
  y1: number;
  left: number;
  right: number;
}

/** 一行谱：五条线加它们定出来的线距。 */
export interface StaffGroup {
  lines: StaffLineRun[];
  /** 组内相邻线的平均间距。 */
  space: number;
}

/**
 * **随 x 变化的五线位置**：整行谱一个 y 只是投影峰，页面轻微倾斜、弯曲、线距不匀时，
 * 局部实测的线与它差出 3~6 像素（44 首独唱谱 p99；线距 15~20 像素时，半格只有 7~10 像素，
 * 读音高四舍五入的分界离中心 3.5~5 像素）。
 *
 * 按一格宽的桶逐列量：每条线在名义 y 上下 0.35 格里找墨的竖游程，厚度不超过 2.5 个线宽
 *（压着符头、符干的列厚得多，不算），取桶内中位；五条线的偏移再取中位当这一桶的整体平移。
 * 量不到的桶从两侧插值、一侧都没有就取最近的。返回 `x → 五条线的 y`（桶中心之间线性插值）。
 */
export function localLineModel(bin: Binary, lines: LineRef[], left: number, right: number, unit: RasterUnit): (x: number) => number[] {
  return lineModelAt(localLineData(bin, lines, left, right, unit));
}

/** `localLineModel` 量出来的数据（普通对象，可跨线程传）：`sm` 为空表示一桶都没量到、五线取各自的曲线（没有就是整行的 `lineYs`）。 */
export interface LineModelData {
  lineYs: number[];
  curves: (LineCurve | undefined)[];
  x0: number;
  bw: number;
  sm: Float64Array | null;
}

/** 按数据造 `x → 五条线的 y`（曲线谱线上再叠桶内实测的整体平移，桶中心之间线性插值）。 */
export const lineModelAt = definePortable("lineModel", (m: LineModelData): ((x: number) => number[]) => {
  const { lineYs, curves, x0, bw, sm } = m;
  const base = (x: number) => lineYs.map((y, k) => (curves[k] ? y + curveAt(curves[k]!, x) : y));
  if (!sm) return curves.some((c) => c) ? base : () => lineYs;
  const nb = sm.length;
  return (x: number) => {
    const t = (x - x0) / bw - 0.5;
    const i = Math.max(0, Math.min(nb - 1, Math.floor(t)));
    const j = Math.min(nb - 1, i + 1);
    const f = Math.max(0, Math.min(1, t - i));
    const d = sm[i] + (sm[j] - sm[i]) * f;
    return base(x).map((y) => y + d);
  };
});

function localLineData(bin: Binary, lines: LineRef[], left: number, right: number, unit: RasterUnit): LineModelData {
  const lineYs = lines.map((l) => l.y);
  const curves = lines.map((l) => l.curve);
  const sp = unit.space;
  const bw = Math.max(4, Math.round(sp));
  const x0 = Math.max(0, Math.round(left));
  const x1 = Math.min(bin.w - 1, Math.round(right));
  const nb = Math.max(1, Math.ceil((x1 - x0 + 1) / bw));
  const maxRun = unit.lineThick * 2.5;
  const reach = sp * 0.35;
  /** 每条线、每个桶的实测中心（量不到为 NaN）。 */
  // 量的是相对曲线的残差：桶内每列的名义 y 取曲线在该列的值
  const meas = lines.map((l0) => {
    const out = new Float64Array(nb).fill(NaN);
    for (let b = 0; b < nb; b++) {
      const cs: number[] = [];
      for (let x = x0 + b * bw; x < Math.min(x1 + 1, x0 + (b + 1) * bw); x++) {
        const ly = lineYAt(l0, x);
        let best = NaN;
        for (let y = Math.max(0, Math.round(ly - reach)); y <= Math.min(bin.h - 2, Math.round(ly + reach)); y++) {
          if (!bin.data[y * bin.w + x]) continue;
          let e = y;
          while (e + 1 < bin.h && bin.data[(e + 1) * bin.w + x]) e++;
          // 游程从窗口上沿之外连进来的，起点往上补齐再量厚度
          let s = y;
          while (s > 0 && bin.data[(s - 1) * bin.w + x]) s--;
          if (e - s + 1 <= maxRun) {
            const c = (s + e) / 2;
            if (isNaN(best) || Math.abs(c - ly) < Math.abs(best - ly)) best = c;
          }
          y = e;
        }
        if (!isNaN(best)) cs.push(best - (ly - l0.y));
      }
      if (cs.length >= Math.max(2, bw / 4)) {
        cs.sort((a, b2) => a - b2);
        out[b] = cs[cs.length >> 1];
      }
    }
    return out;
  });
  // 每桶取**五条线偏移的中位数**当整体平移：骑线的空心头、贴线的符杠只带偏其中一条（奇异恩典中线被头的细圈带偏 2.6 像素）
  const shift = new Float64Array(nb).fill(NaN);
  for (let b = 0; b < nb; b++) {
    const ds = meas.map((m, k) => m[b] - lineYs[k]).filter((d) => !isNaN(d)).sort((a, c) => a - c);
    if (ds.length >= 3) shift[b] = ds[ds.length >> 1];
  }
  const idx = [...shift.keys()].filter((i) => !isNaN(shift[i]));
  if (!idx.length) return { lineYs, curves, x0, bw, sm: null };
  for (let i = 0; i < nb; i++) {
    if (!isNaN(shift[i])) continue;
    const lo = idx.filter((j) => j < i).pop();
    const hi = idx.find((j) => j > i);
    shift[i] = lo === undefined ? shift[hi!] : hi === undefined ? shift[lo] : shift[lo] + ((shift[hi] - shift[lo]) * (i - lo)) / (hi - lo);
  }
  // 相邻三桶取中位，压掉单桶的跳变
  const sm = shift.map((_, i) => [shift[Math.max(0, i - 1)], shift[i], shift[Math.min(nb - 1, i + 1)]].sort((a, c) => a - c)[1]);
  return { lineYs, curves, x0, bw, sm };
}

/** 按**相邻两条线的相对位置**把 y 换成音级位置：第一线为 0、往下每半格 +1；线外按最近的线距外推。 */
export function pitchPos(ys: number[], y: number): number {
  if (y <= ys[0]) return ((y - ys[0]) / (ys[1] - ys[0])) * 2;
  if (y >= ys[4]) return 8 + ((y - ys[4]) / (ys[4] - ys[3])) * 2;
  let k = 0;
  while (k < 3 && y > ys[k + 1]) k++;
  return k * 2 + ((y - ys[k]) / (ys[k + 1] - ys[k])) * 2;
}

/** `pitchPos` 的反函数：音级位置 → y。 */
export function pitchY(ys: number[], p: number): number {
  if (p <= 0) return ys[0] + (p / 2) * (ys[1] - ys[0]);
  if (p >= 8) return ys[4] + ((p - 8) / 2) * (ys[4] - ys[3]);
  const k = Math.min(3, Math.floor(p / 2));
  return ys[k] + (p / 2 - k) * (ys[k + 1] - ys[k]);
}

/** 一行谱的线距与全页的相对差在这个范围里，加线网格才用它自己的线距（见 `LineGrid.ledger`）。 */
const LEDGER_OWN_SPACE = [0.04, 0.3];

/**
 * **全页谱线网格**：判「这个 y 在不在谱线上 / 加线位置上」。谱线弯、斜时（挂了 `curve`）按给的 x 取该处的线位，
 * 不给 x 或整页都平直时照各线的常数 y（与原先的 `gridYs.some(...)` / `prims.ts::ledgerGrid` 逐字相同）。
 */
export class LineGrid {
  /** 各行谱的五条线（自上而下） */
  readonly staves: LineRef[][];
  /** 全页谱线的常数 y（五条一组、按行谱自上而下） */
  readonly ys: number[];
  readonly curved: boolean;
  constructor(
    groups: { lines: LineRef[] }[],
    private readonly unit: RasterUnit,
  ) {
    this.staves = groups.map((g) => [...g.lines].sort((a, b) => a.y - b.y)).sort((a, b) => a[0].y - b[0].y);
    this.ys = this.staves.flatMap((s) => s.map((l) => l.y));
    this.curved = this.staves.some((s) => s.some((l) => l.curve));
  }

  /** 第 i 行谱在 x 处的五条线 */
  at(i: number, x?: number): number[] {
    return this.staves[i].map((l) => (x === undefined ? l.y : lineYAt(l, x)));
  }

  /** y 离某条谱线不过 tol */
  onLine(y: number, tol: number, x?: number): boolean {
    if (!this.curved || x === undefined) return this.ys.some((ly) => Math.abs(ly - y) <= tol);
    for (const s of this.staves) for (const l of s) if (Math.abs(lineYAt(l, x) - y) <= tol) return true;
    return false;
  }

  /**
   * y 落在**加线位置**上：第一线上方或第五线下方整数个线距处（1~6 条），容差四分之一线距。
   * **线距取这一行谱自己的**，不取全页的：一页上谱表大小可以不一样（望十架人声谱表线距 10.4px、钢琴 11.6px）；
   * 只在这一行的线距与全页的差出 4% 以上时才换（差得小的是量线位的半像素误差），差到三成以上的是谱行找错了。
   */
  ledger(y: number, x?: number): boolean {
    for (const s of this.staves) {
      if (s.length < 5) continue;
      const top = x === undefined ? s[0].y : lineYAt(s[0], x);
      const bottom = x === undefined ? s[4].y : lineYAt(s[4], x);
      const own = (bottom - top) / 4;
      const d = Math.abs(own - this.unit.space) / this.unit.space;
      const sp = d > LEDGER_OWN_SPACE[0] && d < LEDGER_OWN_SPACE[1] ? own : this.unit.space;
      const tol = sp * 0.25;
      if (y < top) {
        const k = Math.round((top - y) / sp);
        if (k >= 1 && k <= 6 && Math.abs(top - k * sp - y) <= tol) return true;
      } else if (y > bottom) {
        const k = Math.round((y - bottom) / sp);
        if (k >= 1 && k <= 6 && Math.abs(bottom + k * sp - y) <= tol) return true;
      }
    }
    return false;
  }

  /** 各行谱在 x 处的上下界（第一线、第五线） */
  bands(x?: number): [number, number][] {
    return this.staves.filter((s) => s.length >= 5).map((s) => (x === undefined ? [s[0].y, s[4].y] : [lineYAt(s[0], x), lineYAt(s[4], x)]));
  }
}
