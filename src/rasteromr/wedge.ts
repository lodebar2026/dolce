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
import type { Binary } from "../omrkit/types";
import { traceContours, type Contour, type ContourMap, type ContourStaff } from "./contour";
import type { RasterUnit } from "./staffline";
import { meanFinite as mean, median } from "../omrkit/geom";

export interface RasterWedge {
  /** 渐强（尖端在左）/ 渐弱（尖端在右）。 */
  type: "crescendo" | "diminuendo";
  /** 左右端的 x（像素）。 */
  x0: number;
  x1: number;
  /** 纵向中心（像素）——挂到哪行谱靠它。 */
  cy: number;
  /** 宽口那头的开口高（像素，外缘到外缘） */
  spread?: number;
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
/** 臂的斜率范围。太平的是加线、连音线的一截；太陡的是符干残段。
 *  下限原来 0.03：长而平的松叶（钢琴两行之间二十来格长、续到下一行的那一截，破碎 m65 / m73）一条臂只有 0.016 */
const SLOPE_MIN = 0.015;
const SLOPE_MAX = 0.6;
/** 长臂（过这么多格）不看斜率下限，改看总落差过 `LONG_ARM_RISE` 格。 */
const LONG_ARM = 8;
const LONG_ARM_RISE = 0.3;
/** 配对：两条臂在 x 上要盖住多少（短的那条的比例）。 */
const OVERLAP_MIN = 0.55;
/** 尖端那一头：两条臂的端点要挨着。 */
const TIP_DX = 0.7;
const TIP_DY = 0.45;
/** 跨系统松叶在行首、行尾那一截：「尖端」那头已经张开，放到这么多（且不过开口的一半） */
const TIP_DY_CONT = 0.9;
/** 两条长臂（`LONG_ARM` 格以上）的尖端：不过开口的三分之一、也不过这么多格 */
const TIP_DY_LONG = 0.6;
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
 * @param judgeOnly 只走整团判据、不当臂去配的（被符杠误认的整条松叶：两臂各一段墨、斜着，横段抽取当成了一条杠）。
 */
export function findRasterWedges(map: ContourMap, unit: RasterUnit, only?: Contour[], atRowEdge?: (x: number, y: number) => boolean, judgeOnly: Contour[] = []): RasterWedge[] {
  const pool = only ?? map.contours;
  const out: RasterWedge[] = [];
  const taken = new Set<number>();
  for (const c of [...pool, ...judgeOnly]) {
    if (c.w < MIN_W || c.h > MAX_H || c.h < MIN_H) continue;
    if (c.compact > MAX_COMPACT) continue;
    // 显式传列范围：原来 `judge` 的列范围用默认参数（`xa = c.bbox.x`），剥团一路调多了之后偶发几条结果的 x0/x1/cy 变成同一条的
    //（宁静 p9，十来次里一两次；疑似运行时优化的问题），显式传之后连跑十次稳定
    const w = judge(map, c, unit, c.bbox.x, c.bbox.x + c.bbox.w);
    if (w) {
      out.push(w);
      taken.add(c.id);
    }
  }
  for (const w of pairArms(pool.filter((c) => !taken.has(c.id)), map, unit, atRowEdge)) out.push(w);
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
  const ym0 = mean(ys.slice(0, q));
  const ym1 = mean(ys.slice(-q));
  if (Number.isNaN(ym0) || Number.isNaN(ym1)) return null;
  // 两段均值落在各自那一段的中点，**外推到两端**：长而平的臂（钢琴两行之间二十来格长的松叶）按段均值当端点，
  // 尖端那头差出两三个像素，两臂「挨着」的判据就过不去
  const c0 = (q - 1) / 2;
  const c1 = ys.length - 1 - (q - 1) / 2;
  const k = c1 > c0 ? (ym1 - ym0) / (c1 - c0) : 0;
  const y0 = ym0 - k * c0;
  const y1 = ym1 + k * (ys.length - 1 - c1);
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
  // 很长的臂按**总落差**算：五十来格长的渐弱（宁静 m105 钢琴，开口 0.66 格）一条臂斜率才 0.011
  const longFlat = x1 - x0 >= unit.space * LONG_ARM && Math.abs(y1 - y0) >= unit.space * LONG_ARM_RISE;
  if ((Math.abs(slope) < SLOPE_MIN && !longFlat) || Math.abs(slope) > SLOPE_MAX) return null;
  return { c, x0, y0, x1, y1, slope };
}

/**
 * 两条臂配成一条松叶：斜率一正一负、x 上盖着、**一头挨着、另一头张开**。
 *
 * 单看一条臂与弧线的一截分不开（都是又细又长的一段墨），
 * 但两条臂的**关系**是硬的：尖端处两端点几乎重合，开口处拉开半格以上。
 */
function pairArms(pool: Contour[], map: ContourMap, unit: RasterUnit, atRowEdge?: (x: number, y: number) => boolean): RasterWedge[] {
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
      // 尖端在行首、行尾的是**跨系统松叶的一截**：那一头本来就张开着，只要另一头张得更开
      const tipX = tipLeft ? Math.min(a.x0, b.x0) : Math.max(a.x1, b.x1);
      const tipY = tipLeft ? (a.y0 + b.y0) / 2 : (a.y1 + b.y1) / 2;
      let tipMax = atRowEdge?.(tipX, tipY) ? Math.min(TIP_DY_CONT * sp, openD / 2) : TIP_DY * sp;
      // 两条臂都很长的：外推到尖端差一两个像素就过不了 0.45 格（宁静 m105 钢琴五十来格长，尖端差 0.5 格、开口 1.5 格），按开口的三分之一放
      if (Math.min(a.x1 - a.x0, b.x1 - b.x0) >= sp * LONG_ARM) tipMax = Math.max(tipMax, Math.min(TIP_DY_LONG * sp, openD / 3));
      if (tipD > tipMax || openD < sp * OPEN_DY) continue;
      if (Math.abs(tipLeft ? a.x0 - b.x0 : a.x1 - b.x1) > sp * TIP_DX) continue;
      used.add(a.c);
      used.add(b.c);
      out.push({
        type: tipLeft ? "crescendo" : "diminuendo",
        x0: Math.min(a.x0, b.x0),
        x1: Math.max(a.x1, b.x1),
        cy: (a.y0 + a.y1 + b.y0 + b.y1) / 4,
        spread: openD,
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
    // 一段段不含小节线的列；每段两头的跨度与纵向中心（小节线两侧接不接得上看它）。
    // 只量 [lo, hi] 那一带：同一团里还连着别的东西（越过小节线的圆滑线、符干、别的谱行），整列量上下沿会被拉开（宁静 m7、m105）
    const col = (x: number, lo = b.y, hi = b.y + b.h - 1) => {
      let top = -1;
      let bot = -1;
      for (let y = Math.max(b.y, lo); y <= Math.min(b.y + b.h - 1, hi); y++)
        if (map.labels[y * map.w + x] === c.id) {
          if (top < 0) top = y;
          bot = y;
        }
      return top < 0 ? null : { top, bot };
    };
    /** 一段列的纵向带：跨度在松叶高度闸以内的「干净」列的上下沿并起来，外放 0.2 格。
     *  干净列不到 `FUSED_CLEAN_FRAC` 的不是松叶：整团别处连着的只该是一两处（小节线边上碰着的圆滑线），
     *  大半列都被拉高的是符尾、杠、字挤在一起，带内凑出来的「松叶」是假的（新编 078 m9、105 m19） */
    const bandOf = (xa: number, xb: number): { lo: number; hi: number } | null => {
      let lo = Infinity;
      let hi = -Infinity;
      let clean = 0;
      let all = 0;
      for (let x = xa; x < xb; x++) {
        const k = col(x);
        if (!k) continue;
        all++;
        if (k.bot - k.top + 1 > sp * MAX_H) continue;
        clean++;
        lo = Math.min(lo, k.top);
        hi = Math.max(hi, k.bot);
      }
      return lo > hi || clean < all * FUSED_CLEAN_FRAC ? null : { lo: Math.floor(lo - sp * 0.2), hi: Math.ceil(hi + sp * 0.2) };
    };
    const segs: { xa: number; xb: number; band: { lo: number; hi: number } | null }[] = [];
    for (let i = 0; i < b.w; ) {
      if (bar[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < b.w && !bar[j]) j++;
      // 段边让开一列：小节线的毛边
      const xa = b.x + i + (i > 0 ? 1 : 0);
      const xb = b.x + j - (j < b.w ? 1 : 0);
      segs.push({ xa, xb, band: bandOf(xa, xb) });
      i = j;
    }
    // **横穿小节线的松叶**（钢琴大谱表两行之间那条，小节线从上贯到下）被切成两段：
    // 隔着的只有小节线那几列、两侧的跨度与中心都接得上的并回一条，判的时候跳过小节线那几列
    const runs: { xa: number; xb: number; band: { lo: number; hi: number } | null }[] = [];
    for (const sg of segs) {
      const prev = runs[runs.length - 1];
      if (prev && prev.band && sg.band && sg.xa - prev.xb <= sp * FUSED_BAR_GAP) {
        const lo = Math.min(prev.band.lo, sg.band.lo);
        const hi = Math.max(prev.band.hi, sg.band.hi);
        const l = col(prev.xb - 1, lo, hi);
        const r = col(sg.xa, lo, hi);
        if (l && r && Math.abs((l.top + l.bot) / 2 - (r.top + r.bot) / 2) <= sp * FUSED_JOIN_DY && Math.abs(l.bot - l.top - (r.bot - r.top)) <= sp * FUSED_JOIN_DY) {
          prev.xb = sg.xb;
          prev.band = { lo, hi };
          continue;
        }
      }
      runs.push({ ...sg });
    }
    for (const { xa, xb, band } of runs) {
      if (xb - xa < sp * FUSED_MIN_W || !band) continue;
      const w = judge(map, c, unit, xa, xb, (x) => !!bar[x - b.x], band);
      if (w) out.push({ ...w, box: { x: xa, y: w.y0, w: xb - xa, h: w.y1 - w.y0 + 1 } });
    }
  }
  return out;
}
/** 从粘连团里切出来的段最短这么多格：带内量墨后，符干、杠、字之间的小空当也能凑出「一头尖一头张」的两三格（破碎扫描 p2 m19） */
const FUSED_MIN_W = 3;
/** 小节线切出的段里，整列跨度在高度闸内的列要占这么多 */
const FUSED_CLEAN_FRAC = 0.6;
/**
 * **和符干、符杠、圆滑线粘成一大团的松叶**（钢琴两行之间被跨谱表的符干穿过、尖端碰着圆滑线：宁静 m22、m40、m96、m105，
 * 破碎 m29、m89、m107）：整团的上下跨度远超高度闸，切小节线（`findFusedWedges`）也切不出来。
 * 把团里逐列**细的游程**（≤ `STRIP_THIN` 格、在谱表外）单拎出来——竖着的符干、粗的符杠与符头都剥掉了，
 * 被符干、小节线截断的地方（横向不过 `STRIP_GAP` 格、原图那里是墨）补上，再重新连通，交给整团判据与臂配对。
 *
 * @param pool 要剥的团（调用方挑：够宽、没认成松叶的）
 */
export function findStrippedWedges(map: ContourMap, unit: RasterUnit, pool: Contour[], staves: ContourStaff[], atRowEdge?: (x: number, y: number) => boolean): RasterWedge[] {
  const sp = unit.space;
  const thin = Math.max(2, Math.round(sp * STRIP_THIN));
  const gap = Math.max(1, Math.round(sp * STRIP_GAP));
  const out: RasterWedge[] = [];
  const inStaff = (x: number, y: number) =>
    staves.some((st) => {
      const d = st.lift ? st.lift(x) : 0;
      return y >= st.top + d - sp * 0.2 && y <= st.bottom + d + sp * 0.2;
    });
  for (const c of pool) {
    const b = c.bbox;
    const W = b.w;
    const H = b.h;
    const own = (x: number, y: number) => map.labels[(b.y + y) * map.w + b.x + x] === c.id;
    const data = new Uint8Array(W * H);
    for (let x = 0; x < W; x++) {
      let y = 0;
      while (y < H) {
        if (!own(x, y)) {
          y++;
          continue;
        }
        let e = y;
        while (e < H && own(x, e)) e++;
        if (e - y <= thin && !inStaff(b.x + x, b.y + (y + e) / 2)) for (let k = y; k < e; k++) data[k * W + x] = 1;
        y = e;
      }
    }
    // 横向补缺口：两侧都是细墨、中间原图有墨（符干、小节线穿过的地方）
    for (let y = 0; y < H; y++) {
      let last = -1;
      for (let x = 0; x < W; x++) {
        if (!data[y * W + x]) continue;
        if (last >= 0 && x - last > 1 && x - last <= gap + 1) {
          let ink = true;
          for (let k = last + 1; k < x; k++) if (!own(k, y)) ink = false;
          if (ink) for (let k = last + 1; k < x; k++) data[y * W + k] = 1;
        }
        last = x;
      }
    }
    const sub = traceContours({ w: W, h: H, data }, unit);
    const ws = findRasterWedges(sub, unit, sub.contours, atRowEdge && ((x, y) => atRowEdge(x + b.x, y + b.y)));
    for (const w of ws) {
      if (w.x1 - w.x0 < sp * STRIP_MIN_W) continue;
      const parts = [w.contourId, w.pairedId].map((id) => (id === undefined ? undefined : sub.byId.get(id))).filter((q): q is Contour => !!q);
      const x0 = Math.min(...parts.map((q) => q.bbox.x));
      const y0 = Math.min(...parts.map((q) => q.bbox.y));
      const x1 = Math.max(...parts.map((q) => q.bbox.x + q.bbox.w));
      const y1 = Math.max(...parts.map((q) => q.bbox.y + q.bbox.h));
      out.push({ ...w, x0: w.x0 + b.x, x1: w.x1 + b.x, cy: w.cy + b.y, contourId: c.id, pairedId: undefined, box: { x: x0 + b.x, y: y0 + b.y, w: x1 - x0, h: y1 - y0 } });
    }
  }
  return out;
}
/** 剥团时留下的细游程：不过这么多格（松叶两臂在尖端并成一段也在内；符杠约半格、符头一格，剥掉） */
const STRIP_THIN = 0.4;
/** 剥团认出的最短这么多格：剥完的细墨里，弧、字的笔画、符尾也能凑出两三格长「一头尖一头张」的一对（独唱谱几首）；救回来的都在十格以上 */
const STRIP_MIN_W = 8;
/** 剥团后横向补的缺口：不过这么多格（符干、小节线一两个像素到小半格） */
const STRIP_GAP = 0.5;

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
  xa: number,
  xb: number,
  skip?: (x: number) => boolean,
  band?: { lo: number; hi: number },
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
    for (let y = Math.max(b.y, band?.lo ?? b.y); y < Math.min(b.y + b.h, (band?.hi ?? Infinity) + 1); y++) {
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
  const left = median(spread.slice(0, k)) / unit.space;
  const right = median(spread.slice(-k)) / unit.space;
  const open = Math.max(left, right);
  const tip = Math.min(left, right);
  if (open < OPEN_MIN || tip > TIP_MAX || open < tip * 2) return null;
  return {
    type: right > left ? "crescendo" : "diminuendo",
    x0: xa,
    x1: xb - 1,
    cy: (y0 + y1) / 2,
    spread: open * unit.space,
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
