// 松叶（`<wedge>`：渐强 `<` / 渐弱 `>`）——**按 contour 认**，不拼线段。
//
// 为什么不从 `hSegs` 里配对两条臂：`findPrimitives` 对横笔画有一道
// 「块高不过 `thin * 2`」的闸（约 0.8 个线距），而松叶的开口实测有 1.5~2 个线距高
// ——整条松叶连着尖端是**一团**，块高一超限就被那道闸整个滤掉，压根没进 `hSegs`。
// 它于是原样留在图上，成为一个又宽又扁的 contour（实测宁静 p2 那条 376×30 px =
// 20.7×1.66 格、团状度 0.01）。既然它本来就是完整的一团，直接按 contour 判最省事。
//
// 判据是**逐列的墨迹跨度**：松叶的两条臂从尖端往开口张开，跨度近似线性地涨；
// 弧线（slur）同样又宽又扁、团状度也低，但它逐列只有**一段**墨、跨度处处等于线宽
// ——「一列几段墨」与「跨度涨不涨」这两条一起用，两者一刀分得开。
import type { Binary } from "../omr/types";
import type { Contour, ContourMap } from "./contour";
import type { RasterUnit } from "./staffline";

export interface RasterWedge {
  /** 渐强（尖端在左）/ 渐弱（尖端在右）。 */
  type: "crescendo" | "diminuendo";
  /** 左右端的 x（像素）。 */
  x0: number;
  x1: number;
  /** 纵向中心（像素）——挂到哪行谱靠它。 */
  cy: number;
  contourId: number;
  /** 配对认出来的那一条：另一条臂的 contour（单团认出来的没有这一项）。 */
  pairedId?: number;
  /** 从别的团里切出来的（`findFusedWedges`）：只有这一段是松叶，认领按它记，不按整团。 */
  box?: { x: number; y: number; w: number; h: number };
}

/** 松叶的形状闸（一律按线距）。 */
const MIN_W = 1.8;
const MAX_H = 3.0;
const MIN_H = 0.35;
/** 团状度上限：又宽又扁的东西才有资格（符头 0.7 往上、字 0.3 往上）。 */
const MAX_COMPACT = 0.2;
/** 开口那一头的跨度下限，与尖端那一头的上限。
 *  与 `MIN_W`、`TWO_RUN_FRAC` 一起扫过两档（2.5/0.55/0.42/0.35 与 1.8/0.45/0.5/0.25）：
 *  松叶检出 38/77 → **54/77**、序列 46.0% → 47.2%，其余各档不动，取松的这一档。 */
const OPEN_MIN = 0.45;
const TIP_MAX = 0.5;
/** 逐列有**两段**墨的列要占多少（尖端附近只有一段，所以不能要求全部）。 */
const TWO_RUN_FRAC = 0.25;

/** 一条**臂**：尖端没连上的松叶，两条臂各成一个 contour（见 `pairArms`）。 */
interface Arm {
  c: Contour;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  slope: number;
}

/** 臂的形状闸。比整条松叶松（一条臂只有半边的高度），但要**直**。 */
const ARM_MIN_W = 1.5;
const ARM_MAX_H = 1.6;
/** 逐列只有一段墨的列要占多少——两段的那是整条松叶，走 `judge`。 */
const ONE_RUN_FRAC = 0.85;
/** 离两端连线最远的那一点，不能超过这么多（线距）。弧线拱得高，一量就出局。 */
const STRAIGHT_TOL = 0.18;
/** 臂的斜率范围。太平的是加线、连音线的一截；太陡的是符干残段。 */
const SLOPE_MIN = 0.03;
const SLOPE_MAX = 0.6;
/** 配对：两条臂在 x 上要盖住多少（短的那条的比例）。 */
const OVERLAP_MIN = 0.55;
/** 尖端那一头：两条臂的端点要挨着。 */
const TIP_DX = 0.7;
const TIP_DY = 0.45;
/** 开口那一头：要张开这么多。 */
const OPEN_DY = 0.55;

/**
 * 从 contour 层里挑出松叶。
 *
 * 两条路：
 *   1. **整条一团**（尖端连着）——逐列跨度判，见 `judge`；
 *   2. **两条臂各成一团**（尖端没连上，印得细的时候常见）——`pairArms` 配对。
 *      实测这一档占了漏检的一多半：单团的判据对一条臂无能为力
 *      （一条臂逐列只有一段墨、跨度处处等于线宽，与弧线的特征一模一样），
 *      只有把两条配起来、看它们**一头挨着一头张开**才分得出来。
 *
 * @param only 只看这些 contour（一般传账本里**无主**的那些——认出来的符号不必再判）。
 */
export function findRasterWedges(map: ContourMap, unit: RasterUnit, only?: Contour[]): RasterWedge[] {
  const pool = only ?? map.contours;
  const out: RasterWedge[] = [];
  const taken = new Set<number>();
  for (const c of pool) {
    if (c.w < MIN_W || c.h > MAX_H || c.h < MIN_H) continue;
    if (c.compact > MAX_COMPACT) continue;
    const w = judge(map, c, unit);
    if (w) {
      out.push(w);
      taken.add(c.id);
    }
  }
  for (const w of pairArms(pool.filter((c) => !taken.has(c.id)), map, unit)) out.push(w);
  return out;
}

/** 一条直的细线（松叶的一条臂）——量出两端与斜率；不是就返回 null。**排查用，也对外**。 */
export function armOf(map: ContourMap, c: Contour, unit: RasterUnit): Arm | null {
  if (c.w < ARM_MIN_W || c.h > ARM_MAX_H) return null;
  if (c.compact > MAX_COMPACT) return null;
  const b = c.bbox;
  const ys: number[] = [];
  let one = 0;
  let cols = 0;
  for (let x = b.x; x < b.x + b.w; x++) {
    let sum = 0;
    let n = 0;
    let runs = 0;
    let prev = false;
    for (let y = b.y; y < b.y + b.h; y++) {
      const on = map.labels[y * map.w + x] === c.id;
      if (on) {
        sum += y;
        n++;
        if (!prev) runs++;
      }
      prev = on;
    }
    if (!n) {
      ys.push(NaN);
      continue;
    }
    cols++;
    if (runs === 1) one++;
    ys.push(sum / n);
  }
  if (!cols || one < cols * ONE_RUN_FRAC) return null;
  // 两端各取四分之一段的均值（与 `prims.ts::centerLine` 同一套，末端的毛刺影响不到）
  const q = Math.max(1, Math.round(ys.length / 4));
  const mean = (a: number[]) => {
    const v = a.filter((y) => !Number.isNaN(y));
    return v.length ? v.reduce((s, y) => s + y, 0) / v.length : NaN;
  };
  const y0 = mean(ys.slice(0, q));
  const y1 = mean(ys.slice(-q));
  if (Number.isNaN(y0) || Number.isNaN(y1)) return null;
  const x0 = b.x;
  const x1 = b.x + b.w - 1;
  // **要直**：离两端连线最远的那一点不能超过 0.18 格。弧线拱得高，一量就出局。
  let far = 0;
  for (let i = 0; i < ys.length; i++) {
    if (Number.isNaN(ys[i])) continue;
    const t = ys.length > 1 ? i / (ys.length - 1) : 0;
    far = Math.max(far, Math.abs(ys[i] - (y0 + (y1 - y0) * t)));
  }
  if (far > unit.space * STRAIGHT_TOL) return null;
  const slope = (y1 - y0) / Math.max(1, x1 - x0);
  if (Math.abs(slope) < SLOPE_MIN || Math.abs(slope) > SLOPE_MAX) return null;
  return { c, x0, y0, x1, y1, slope };
}

/**
 * 两条臂配成一条松叶：斜率一正一负、x 上盖着、**一头挨着、另一头张开**。
 *
 * 单看一条臂与弧线的一截分不开（都是又细又长的一段墨），
 * 但两条臂的**关系**是硬的：尖端处两端点几乎重合，开口处拉开半格以上。
 */
function pairArms(pool: Contour[], map: ContourMap, unit: RasterUnit): RasterWedge[] {
  const sp = unit.space;
  const arms = pool.map((c) => armOf(map, c, unit)).filter((a): a is Arm => !!a);
  const used = new Set<Contour>();
  const out: RasterWedge[] = [];
  for (let i = 0; i < arms.length; i++) {
    if (used.has(arms[i].c)) continue;
    for (let j = i + 1; j < arms.length; j++) {
      if (used.has(arms[j].c)) continue;
      const a = arms[i];
      const b = arms[j];
      if (a.slope * b.slope >= 0) continue; // 同向的不是一对
      const lo = Math.max(a.x0, b.x0);
      const hi = Math.min(a.x1, b.x1);
      const shorter = Math.min(a.x1 - a.x0, b.x1 - b.x0);
      if (hi - lo < shorter * OVERLAP_MIN) continue;
      const dLeft = Math.abs(a.y0 - b.y0);
      const dRight = Math.abs(a.y1 - b.y1);
      const tipLeft = dLeft < dRight;
      const tipD = tipLeft ? dLeft : dRight;
      const openD = tipLeft ? dRight : dLeft;
      if (tipD > sp * TIP_DY || openD < sp * OPEN_DY) continue;
      if (Math.abs(tipLeft ? a.x0 - b.x0 : a.x1 - b.x1) > sp * TIP_DX) continue;
      used.add(a.c);
      used.add(b.c);
      out.push({
        type: tipLeft ? "crescendo" : "diminuendo",
        x0: Math.min(a.x0, b.x0),
        x1: Math.max(a.x1, b.x1),
        cy: (a.y0 + a.y1 + b.y0 + b.y1) / 4,
        contourId: a.c.id,
        pairedId: b.c.id,
      });
      break;
    }
  }
  return out;
}

/**
 * **粘在小节线上的松叶**：开口一头顶到小节线（破碎 p2 m5–6 那条从 mf 拉到小节末的渐强），与小节线连成一团，
 * 整团被小节线认领，`findRasterWedges` 只看无主的团，看不到它。
 * 把团里**竖着贯穿**的那几列（最长竖游程过 `FUSED_BAR_RUN` 格）切掉，剩下每段连续的列各按松叶判一次；
 * 段的上下跨度也要在松叶的高度闸里（小节线两侧挂着的别的东西，跨度一般更大）。
 *
 * @param pool 认领里有小节线的那几团（调用方挑）。
 */
export function findFusedWedges(map: ContourMap, unit: RasterUnit, pool: Contour[]): RasterWedge[] {
  const sp = unit.space;
  const out: RasterWedge[] = [];
  for (const c of pool) {
    const b = c.bbox;
    if (b.w < sp * MIN_W) continue;
    const bar = new Uint8Array(b.w);
    for (let x = b.x; x < b.x + b.w; x++) {
      let run = 0;
      let best = 0;
      for (let y = b.y; y < b.y + b.h; y++) {
        run = map.labels[y * map.w + x] === c.id ? run + 1 : 0;
        if (run > best) best = run;
      }
      bar[x - b.x] = best > sp * FUSED_BAR_RUN ? 1 : 0;
    }
    // 一段段不含小节线的列；每段两头的跨度与纵向中心（小节线两侧接不接得上看它）
    const col = (x: number) => {
      let top = -1;
      let bot = -1;
      for (let y = b.y; y < b.y + b.h; y++)
        if (map.labels[y * map.w + x] === c.id) {
          if (top < 0) top = y;
          bot = y;
        }
      return top < 0 ? null : { top, bot };
    };
    const segs: { xa: number; xb: number }[] = [];
    for (let i = 0; i < b.w; ) {
      if (bar[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < b.w && !bar[j]) j++;
      // 段边让开一列：小节线的毛边
      segs.push({ xa: b.x + i + (i > 0 ? 1 : 0), xb: b.x + j - (j < b.w ? 1 : 0) });
      i = j;
    }
    // **横穿小节线的松叶**（钢琴大谱表两行之间那条，小节线从上贯到下）被切成两段：
    // 隔着的只有小节线那几列、两侧的跨度与中心都接得上的并回一条，判的时候跳过小节线那几列
    const runs: { xa: number; xb: number }[] = [];
    for (const sg of segs) {
      const prev = runs[runs.length - 1];
      if (prev && sg.xa - prev.xb <= sp * FUSED_BAR_GAP) {
        const l = col(prev.xb - 1);
        const r = col(sg.xa);
        if (l && r && Math.abs((l.top + l.bot) / 2 - (r.top + r.bot) / 2) <= sp * FUSED_JOIN_DY && Math.abs(l.bot - l.top - (r.bot - r.top)) <= sp * FUSED_JOIN_DY) {
          prev.xb = sg.xb;
          continue;
        }
      }
      runs.push({ ...sg });
    }
    for (const { xa, xb } of runs) {
      if (xb - xa < sp * MIN_W) continue;
      const w = judge(map, c, unit, xa, xb, (x) => !!bar[x - b.x]);
      if (w) out.push({ ...w, box: { x: xa, y: w.y0, w: xb - xa, h: w.y1 - w.y0 + 1 } });
    }
  }
  return out;
}
/** 小节线：一列里连着这么多格的墨。 */
const FUSED_BAR_RUN = 2;
/** 小节线两侧的两段并成一条：中间隔着不过这么宽（格），两侧跨度与纵向中心各差不过 `FUSED_JOIN_DY` 格。 */
const FUSED_BAR_GAP = 0.6;
const FUSED_JOIN_DY = 0.3;

/** 逐列量墨迹：这一团（`xa`..`xb` 那几列）是不是松叶，是哪一种。 */
function judge(
  map: ContourMap,
  c: Contour,
  unit: RasterUnit,
  xa = c.bbox.x,
  xb = c.bbox.x + c.bbox.w,
  skip?: (x: number) => boolean,
): (RasterWedge & { y0: number; y1: number }) | null {
  const b = c.bbox;
  const spread: number[] = [];
  const runs: number[] = [];
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let x = xa; x < xb; x++) {
    if (skip?.(x)) continue;
    let top = -1;
    let bot = -1;
    let n = 0;
    let prev = false;
    for (let y = b.y; y < b.y + b.h; y++) {
      const on = map.labels[y * map.w + x] === c.id;
      if (on) {
        if (top < 0) top = y;
        bot = y;
        if (!prev) n++;
      }
      prev = on;
    }
    if (top < 0) continue;
    spread.push(bot - top + 1);
    runs.push(n);
    y0 = Math.min(y0, top);
    y1 = Math.max(y1, bot);
  }
  if (spread.length < unit.space * 2) return null;
  // 切出来的段：上下跨度也要过松叶的高度闸（整团的已经在 `findRasterWedges` 里过了）
  if (y1 - y0 + 1 > unit.space * MAX_H) return null;
  const twoRun = runs.filter((n) => n >= 2).length / runs.length;
  if (twoRun < TWO_RUN_FRAC) return null; // 逐列只有一段墨：那是弧线，不是松叶
  const k = Math.max(1, Math.round(spread.length * 0.15));
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
  const left = med(spread.slice(0, k)) / unit.space;
  const right = med(spread.slice(-k)) / unit.space;
  const open = Math.max(left, right);
  const tip = Math.min(left, right);
  if (open < OPEN_MIN || tip > TIP_MAX || open < tip * 2) return null;
  return {
    type: right > left ? "crescendo" : "diminuendo",
    x0: xa,
    x1: xb - 1,
    cy: (y0 + y1) / 2,
    contourId: c.id,
    y0,
    y1,
  };
}

/** 排查用：把一团墨的逐列跨度打出来。 */
export function wedgeProfile(map: ContourMap, c: Contour, bin?: Binary): { spread: number[]; runs: number[] } {
  void bin;
  const b = c.bbox;
  const spread: number[] = [];
  const runs: number[] = [];
  for (let x = b.x; x < b.x + b.w; x++) {
    let top = -1;
    let bot = -1;
    let n = 0;
    let prev = false;
    for (let y = b.y; y < b.y + b.h; y++) {
      const on = map.labels[y * map.w + x] === c.id;
      if (on) {
        if (top < 0) top = y;
        bot = y;
        if (!prev) n++;
      }
      prev = on;
    }
    if (top < 0) continue;
    spread.push(bot - top + 1);
    runs.push(n);
  }
  return { spread, runs };
}
