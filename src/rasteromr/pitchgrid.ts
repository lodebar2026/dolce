// 位图五线谱的**音高网格与加线**：谱线 → 线位 / 间位网格、加线候选、共用与自带的加线。
import type { Binary } from "../omrkit/types";
import type { Rect } from "../omrkit/types";
import { type LineSeg } from "./prims";
import { type PitchStep } from "./notehead";
import { type RasterUnit, type StaffLineRun } from "./staffline";

/**
 * 加线候选（`hollowHeadsOnLedgers` 用）：每行谱上下第 1~4 条加线的位置上，**直接在原图上**找横向墨段
 *（上下各放一像素，断口 ≤ 1 像素）。不用 `prims.hSegs`：骑在加线上的空心头，那几列的纵向墨是
 * 圈 + 加线一整条，过不了横笔画「细」的那道闸，加线抽不出来（赞美三一真神 m16 的 C4）。
 * 真假交给模板得分与内腔佐证。
 */
export function ledgerCandidates(bin: Binary, groups: { lines: StaffLineRun[]; space: number }[]): { x0: number; x1: number; y: number }[] {
  const out: { x0: number; x1: number; y: number }[] = [];
  for (const g of groups) {
    const left = Math.max(...g.lines.map((l) => l.left));
    const right = Math.min(...g.lines.map((l) => l.right));
    const ys: number[] = [];
    for (let k = 1; k <= 4; k++) ys.push(g.lines[0].y - k * g.space, g.lines[4].y + k * g.space);
    for (const fy of ys) {
      const y = Math.round(fy);
      if (y < 1 || y >= bin.h - 1) continue;
      const ink = (x: number) => !!(bin.data[(y - 1) * bin.w + x] || bin.data[y * bin.w + x] || bin.data[(y + 1) * bin.w + x]);
      let start = -1;
      let miss = 0;
      for (let x = Math.max(0, Math.round(left)); x <= Math.min(bin.w - 1, Math.round(right)) + 1; x++) {
        const on = x <= Math.min(bin.w - 1, Math.round(right)) && ink(x);
        if (on) {
          if (start < 0) start = x;
          miss = 0;
          continue;
        }
        if (start >= 0 && ++miss > 1) {
          out.push({ x0: start, x1: x - miss, y: fy });
          start = -1;
          miss = 0;
        }
      }
    }
  }
  return out;
}

/** 一行谱的几何与**随 x 变化的五线**（`staffline.ts::localLineModel`）。 */
export interface LineFrame {
  top: number;
  bottom: number;
  at: (x: number) => number[];
}

/** 区间 [y0, y1] 里的全部音高位置（与 `makePitchGrid` 同一张表：每行谱顶线上下各五条加线的线位与间位）。 */
export function makePitchSteps(groups: { lines: { y: number }[]; space: number }[]): (y0: number, y1: number) => PitchStep[] {
  const steps: PitchStep[] = [];
  for (const g of groups) {
    const top = g.lines[0].y;
    const half = g.space / 2;
    for (let k = -10; k <= 18; k++) steps.push({ y: top + k * half, line: k % 2 === 0 });
  }
  return (y0, y1) => steps.filter((s) => s.y >= y0 && s.y <= y1);
}

/**
 * 音高格：把一个 y 吸到最近的**线/间中心**（差半格音高就错一级）。
 * 谱表之外也给（加线那一带），上下各放几格；离得太远返回 null。
 */
export function makePitchGrid(groups: { lines: { y: number }[]; space: number }[], unit: RasterUnit): (y: number) => number | null {
  const steps: number[] = [];
  for (const g of groups) {
    const top = g.lines[0].y;
    const half = g.space / 2;
    for (let k = -10; k <= 18; k++) steps.push(top + k * half);
  }
  steps.sort((a, b) => a - b);
  return (y: number) => {
    let best: number | null = null;
    let bd = unit.space * 0.3;
    for (const s of steps) {
      const d = Math.abs(s - y);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  };
}

/**
 * **几个音共用的那条长加线，要按符头切成短段补进去。**
 *
 * 相邻几个音落在同一条加线上时，谱面上画的是**一条通长的横线**
 *（实测破碎 p4 两个音共用的那条 x[616,723]、长 **6.25 格**）。
 * 而下游有两道长度闸都是按「一个符头的加线」定的：
 * `findNoteheads` 只收 ≤ 6 格的横段、`findLegers` 还要求不超过符头宽的三倍。
 * 通长的那条两道都过不了，于是这些音**一条加线都找不到**
 *（实测未认领的符头里「需要 1 条、找到 0 条」占 155/259，这是头号成因）。
 *
 * 不去动那两道闸——它们防的是「和弦图的格线被当成加线」，是拿具体页换来的。
 * 改成在位图这边**按符头把长线切成短段**补进去：加线本来就是给符头垫的，
 * 一个符头配一小段，长度取符头宽的一倍半，语义与「剪出来的加线」那一路一致。
 *
 * 只切**落在谱线网格延长线上**的横段（`ledgerGrid`），那是加线的硬判据。
 */
export function sharedLegers(hSegs: LineSeg[], heads: { box: Rect }[], onGrid: (y: number) => boolean, unit: RasterUnit): LineSeg[] {
  const out: LineSeg[] = [];
  for (const seg of hSegs) {
    const y = (seg.y0 + seg.y1) / 2;
    if (Math.abs(seg.x1 - seg.x0) <= unit.space * 3) continue; // 短的下游本来就收得下
    if (!onGrid(y)) continue;
    const left = Math.min(seg.x0, seg.x1);
    const right = Math.max(seg.x0, seg.x1);
    for (const h of heads) {
      const cx = h.box.x + h.box.w / 2;
      if (cx < left || cx > right) continue;
      // 窗口要放到三格：谱表外两三格的音，**里面那几条加线上并没有符头**
      //（实测「需要 2 条、找到 1 条」占 66 处，缺的就是里侧那条）。
      // 放宽不怕误收——`findLegers` 自己还要判「加线落在符头与谱表之间」。
      if (Math.abs(y - (h.box.y + h.box.h / 2)) > unit.space * 3.2) continue;
      const half = h.box.w * 0.8;
      out.push({ x0: Math.max(left, cx - half), y0: y, x1: Math.min(right, cx + half), y1: y, lw: seg.lw, maxLw: seg.maxLw });
    }
  }
  return out;
}

/**
 * 骑在加线上的符头，按它自己的位置补一条加线（验过那一带确实有墨）。
 *
 * 判据：中心落在加线网格上（`ledgerGrid`）、且沿中心线左右各半个符头宽的范围内，
 * 六成以上的列在 ±线宽 内有墨。补出来的段按符头宽的一倍二，与 `trimLedger` 那条同口径。
 */
export function ownLegers(heads: { box: Rect }[], bin: Binary, onGrid: (y: number) => boolean, unit: RasterUnit): LineSeg[] {
  const out: LineSeg[] = [];
  const th = Math.max(1, Math.round(unit.lineThick));
  for (const h of heads) {
    const cy = h.box.y + h.box.h / 2;
    const cx = h.box.x + h.box.w / 2;
    const half = h.box.w * 0.6;
    // 候选位置：符头**自己骑着的**那条网格线，以及**上下各半格**的那条
    // ——符头落在加线上面/下面那一间时，压着它的那条加线同样抽不出来
    //（那一带的纵向游程是「符头 + 线」的高度，出了「细」的那道闸），
    // 而它正是 `findLegers` 要数的那一条。
    for (const y of [cy, cy - unit.space / 2, cy + unit.space / 2]) {
      if (!onGrid(y)) continue;
      let ink = 0;
      let n = 0;
      for (let x = Math.round(cx - half); x <= Math.round(cx + half); x++) {
        if (x < 0 || x >= bin.w) continue;
        n++;
        for (let d = -th; d <= th; d++) {
          const yy = Math.round(y) + d;
          if (yy >= 0 && yy < bin.h && bin.data[yy * bin.w + x]) {
            ink++;
            break;
          }
        }
      }
      if (!n || ink < n * 0.6) continue;
      out.push({ x0: cx - half, y0: y, x1: cx + half, y1: y, lw: th, maxLw: th });
    }
  }
  return out;
}
