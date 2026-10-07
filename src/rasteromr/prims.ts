// 几何原语：从位图里抽出**横段 / 竖段 / 符杠**。
//
// 这三样在矢量路里是现成的（一条 path 就是一条线），位图路要自己挑出来。
// 挑出来之后交给 `adapt.ts` 包成 `Seg`，`page.ts` 的 `findStaves` / `findLegers` /
// `findStems` / `findBarlines` 就能原样跑——**那边的判据一条都不改**。
//
// ## 靠**游程**分，不靠连通域
//
// 直接对整幅图做连通域没有用：一行谱的五条线、压在上面的符头符干符杠、
// 穿过去的小节线全连成**一个**块。得先按「这个像素属于横笔画还是竖笔画」分开：
//   - 纵向游程短的像素 → 横笔画（谱线、加线、括号横杠）；
//   - 横向游程短的像素 → 竖笔画（符干、小节线）；
//   - 两个方向都粗的 → 符杠、符头、字。
// 分完再各自做连通域，笔画就散开了。
import type { Binary, Component, Rect } from "../omr/types";
import { SIG_N } from "../omr/glyphdict";
import { connectedComponents } from "../omr/ccl";
import type { RasterUnit } from "./staffline";

/** 一条直线段（像素坐标）。 */
export interface LineSeg {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 线宽（横段取厚度、竖段取宽度），**取平均**——几何判据要的是视觉线宽。 */
  lw: number;
  /** 连通块的**最大**厚度。抹笔画时用它，不能用平均：
   *  符干的两头常常粗一点（与符头相接处），照平均抹会在符头边上留一条 0.17 格的残渣
   *  ——实测宁静一首里这种残渣有五百多个，全都混进了符号块。 */
  maxLw: number;
}

/** 抹符杠时中心线两侧的余量（px）。扫过 0 / 1 / 2 / 3：
 *  音符 70.83 / 71.53 / **71.59** / 71.46%——余量太小会留下符杠残渣混进符号块，
 *  太大又开始啃符头。 */
const BEAM_PAD = 2;
/** 抹笔画时按平均厚的几倍封顶（见 `blobImage`）。 */
const PAD_LW = 2;
/** 左端系统线的窗口：谱行左缘往外几格、往里几格；连着要占缝里的几成行。见 `groupByLeftInk`。
 *  往外从 2 格放到 3.5 格：谱行左缘取五条线左端的最大值，谱线在谱号处断开时会被量到
 *  谱号右边（齐来称颂第一行 204，系统线在 155，差 2.8 格），SATB 上下两行就拆成两个系统。 */
const LEFTINK_OUT = 3.5;
const LEFTINK_IN = 0.5;
const LEFTINK_FRAC = 0.9;
/**
 * 竖笔画的**长度**下限（线距的倍数）。
 *
 * 原来一格。太松：**四分休止的下半截**（细钩 + 一坨）只有 1.1 格高，
 * 过得了这道闸，于是被抽成竖段、`blobImage` 照它抹墨把整个休止铲掉
 * （实测破碎 p2 钢琴行的四分休止就是这么没的）。真符干至少一格半
 * ——连桁里最短的那种也有两格。
 * 扫过 1.0 / 1.1 / 1.2 / 1.3 / **1.4** / 1.45 / 1.5 / 1.6 格：
 * 按谱行 92.31 / 92.31 / 92.33 / 92.46 / **92.59** / 92.59 / 92.33 / 91.99%，
 * 真扫描件 29.63 / 29.66 / 29.91 / 30.99 / **30.99** / 31.03 / 31.03 / 31.03%
 * ——**两档同向**，与「收竖笔画的宽度闸」那条正好相反。
 */
const VSEG_MIN_H = 1.4;

/** 一条符杠：拟合出来的中心线加包围盒。 */
/** 谱表外不到这么多格宽的「杠」要两端都连着干才算（见 `findPrims` 里符杠那一段）。 */
const LEDGER_BEAM_W = 2.5;
/** 上面那条只在线宽过线距这么多的页判。 */
const LEDGER_BEAM_THICK = 0.22;

export interface BeamQuad extends LineSeg {
  box: Rect;
}

export interface RasterPrims {
  hSegs: LineSeg[];
  vSegs: LineSeg[];
  beams: BeamQuad[];
  /** 叠头和弦的短干（`cleanTail`）：不进 `vSegs`，只给光杆干探头用，探出了头才并进去（`recognize.ts`）。 */
  shortStems?: LineSeg[];
}

/** 逐像素的纵向游程长度（该像素所在的那一竖条黑色游程有多长）。 */
function vRuns(bin: Binary): Uint16Array {
  const { w, h, data } = bin;
  const out = new Uint16Array(w * h);
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!data[y * w + x]) {
        y++;
        continue;
      }
      let y2 = y;
      while (y2 + 1 < h && data[(y2 + 1) * w + x]) y2++;
      const len = y2 - y + 1;
      for (let k = y; k <= y2; k++) out[k * w + x] = len;
      y = y2 + 1;
    }
  }
  return out;
}

/** 本页谱线的实测厚度：各谱线 y 上逐列（每隔三列）取竖游程，取九成分位（只取不到 0.4 格的，压着符号的不算）。
 *  不取中位数：扫描件的线粗细不匀（望十架 2~3 像素，中位数 2）。 */
function measuredLineThick(bin: Binary, vr: Uint16Array, lineYs: number[], unit: RasterUnit): number {
  const ts: number[] = [];
  for (const ly of lineYs) {
    const y = Math.round(ly);
    if (y < 0 || y >= bin.h) continue;
    for (let x = 0; x < bin.w; x += 3) {
      const t = vr[y * bin.w + x];
      if (t > 0 && t <= unit.space * 0.4) ts.push(t);
    }
  }
  ts.sort((p, q) => p - q);
  return ts.length ? ts[Math.floor(ts.length * 0.9)] : unit.lineThick;
}

/** 逐像素的横向游程长度。 */
function hRuns(bin: Binary): Uint16Array {
  const { w, h, data } = bin;
  const out = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let x = 0;
    while (x < w) {
      if (!data[row + x]) {
        x++;
        continue;
      }
      let x2 = x;
      while (x2 + 1 < w && data[row + x2 + 1]) x2++;
      const len = x2 - x + 1;
      for (let k = x; k <= x2; k++) out[row + k] = len;
      x = x2 + 1;
    }
  }
  return out;
}

/**
 * 沿一个方向做**闭运算**（先膨胀后腐蚀），把笔画上的小缺口补上。
 *
 * 非做不可：符干穿过谱线的那几个像素，纵向游程一下子变成整根符干的长度，
 * 于是被踢出「横笔画」——一条谱线因此被每根符干断成十几截，
 * 后面「长度 ≥ 最长横线的 35%」那道闸一截都过不去。沿 x 闭一下就接回来了。
 * 竖笔画同理（被谱线断开），沿 y 闭。
 */
function close1d(mask: Uint8Array, w: number, h: number, r: number, horizontal: boolean): Uint8Array {
  if (r < 1) return mask;
  const out = new Uint8Array(mask.length);
  const n = horizontal ? h : w;
  const m = horizontal ? w : h;
  const at = (i: number, j: number) => (horizontal ? i * w + j : j * w + i);
  const gap = new Uint8Array(m);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) gap[j] = mask[at(i, j)];
    // 膨胀 r 再腐蚀 r，等价于「把不超过 2r 的缺口填上」
    let last = -1;
    for (let j = 0; j < m; j++) {
      if (!gap[j]) continue;
      if (last >= 0 && j - last <= r * 2) for (let k = last + 1; k < j; k++) out[at(i, k)] = 1;
      out[at(i, j)] = 1;
      last = j;
    }
  }
  return out;
}

/** 连通域：把 mask 当作一幅 `Binary` 跑 `ccl.ts`。 */
function comps(mask: Uint8Array, w: number, h: number, minArea: number): Component[] {
  return connectedComponents({ w, h, data: mask }, minArea);
}

/**
 * 一个连通块 → 中心线。逐列取墨迹的平均 y，两端各取四分之一段的均值当端点。
 *
 * 不用块的对角线：符杠是斜的四边形，对角线偏出中心线半个厚度；
 * 也不用最小二乘全拟合——两端各取一段更稳，末端的毛刺影响不到中间。
 */
function centerLine(mask: Uint8Array, w: number, c: Component, horizontal: boolean): LineSeg {
  const b = c.bbox;
  if (horizontal) {
    const q = Math.max(1, Math.round(b.w / 4));
    const meanY = (x0: number, x1: number) => {
      let s = 0;
      let n = 0;
      for (let x = x0; x < x1; x++)
        for (let y = b.y; y < b.y + b.h; y++)
          if (mask[y * w + x]) {
            s += y;
            n++;
          }
      return n ? s / n : b.y + b.h / 2;
    };
    return { x0: b.x, y0: meanY(b.x, b.x + q), x1: b.x + b.w - 1, y1: meanY(b.x + b.w - q, b.x + b.w), lw: c.area / Math.max(b.w, 1), maxLw: b.h };
  }
  const q = Math.max(1, Math.round(b.h / 4));
  const meanX = (y0: number, y1: number) => {
    let s = 0;
    let n = 0;
    for (let y = y0; y < y1; y++)
      for (let x = b.x; x < b.x + b.w; x++)
        if (mask[y * w + x]) {
          s += x;
          n++;
        }
    return n ? s / n : b.x + b.w / 2;
  };
  return { x0: meanX(b.y, b.y + q), y0: b.y, x1: meanX(b.y + b.h - q, b.y + b.h), y1: b.y + b.h - 1, lw: c.area / Math.max(b.h, 1), maxLw: b.w };
}

/** `narrowPart` 取出的窄段至少多长（格）。 */
const NARROW_STEM = 3;
const INK_RUN_STEM = 2.5;
/** 干净尾巴的长度下限（格），见 `cleanTail`。 */
const CLEAN_TAIL = 2.5;

/** `isolated` 按 `maxLw` 开的邻墨窗里（中心列两侧）有没有一列从第五线到第一线都有墨（≥95% 行）。 */
function barColumnNear(bin: Binary, x: number, maxLw: number, bands: [number, number][]): boolean {
  const { w, data } = bin;
  const half = Math.max(1, Math.ceil(maxLw / 2));
  const near = half + 1;
  const far = half + Math.max(2, Math.round(maxLw * 2));
  const cx = Math.round(x);
  for (const [t, bt] of bands) {
    const top = Math.round(t), bot = Math.round(bt);
    for (let d = near; d <= far; d++)
      for (const xx of [cx - d, cx + d]) {
        if (xx < 0 || xx >= w) continue;
        let n = 0;
        for (let y = top; y <= bot; y++) if (data[y * w + xx]) n++;
        if (n >= (bot - top + 1) * 0.95) return true;
      }
  }
  return false;
}

/** 块里各行墨宽（最左到最右）的众数：干那几十行宽度一致，块里连着的字、头边各行宽窄不一。 */
function modalRowWidth(mask: Uint8Array, w: number, c: Component): number {
  const b = c.bbox;
  const n = new Map<number, number>();
  for (let y = b.y; y < b.y + b.h; y++) {
    let a = -1, z = -1;
    for (let x = b.x; x < b.x + b.w; x++) if (mask[y * w + x]) { if (a < 0) a = x; z = x; }
    if (a >= 0) n.set(z - a + 1, (n.get(z - a + 1) ?? 0) + 1);
  }
  let best = 1, cnt = 0;
  for (const [k, v] of n) if (v > cnt || (v === cnt && k < best)) (best = k), (cnt = v);
  return best;
}

/**
 * 块里**窄的那一段**：竖笔连着别的细笔画（二分头的圈边横向游程也细，进了竖笔掩模，与符干连成一块），
 * 最宽处超过平均线宽两倍时，取行宽不超过平均线宽加 2 的最长连续行重做中心线。
 * 只给孤立性没过的块用：按整块最宽处开的邻墨窗伸到 26px，贴着小节线 1.2 格的符干一路碰到小节线、
 * 判成「不孤立」扔掉，小节线随后被当成那个头的干（我一生要赞美你第六行 x=240）。
 * 直接按平均线宽开窗是全局改动，谱号、升号的竖笔也跟着过了闸（赞美三一真神音符 94 → 55%）。
 */
function narrowPart(mask: Uint8Array, w: number, c: Component, lw: number, unit: RasterUnit, minLen = NARROW_STEM): LineSeg | null {
  const b = c.bbox;
  if (b.w <= lw * 2) return null;
  let best: [number, number] | null = null;
  let start = -1;
  const rows: [number, number][] = [];
  for (let y = b.y; y <= b.y + b.h; y++) {
    let a = -1, z = -1;
    if (y < b.y + b.h) for (let x = b.x; x < b.x + b.w; x++) if (mask[y * w + x]) { if (a < 0) a = x; z = x; }
    const ok = a >= 0 && z - a + 1 <= lw + 2;
    rows.push([a, z]);
    if (ok && start < 0) start = y;
    if (!ok && start >= 0) {
      if (!best || y - start > best[1] - best[0]) best = [start, y];
      start = -1;
    }
  }
  // 够一根符干长：破碎干净版这样收进来的多是 1.5~2.7 格的短笔（满拍自检 64.6 → 61.8），真干约 3.5 格
  if (!best || best[1] - best[0] < unit.space * minLen) return null;
  let sx = 0, n = 0, maxW = 0;
  for (let y = best[0]; y < best[1]; y++) {
    const [a, z] = rows[y - b.y];
    sx += (a + z) / 2;
    n++;
    maxW = Math.max(maxW, z - a + 1);
  }
  const x = sx / n;
  return { x0: x, y0: best[0], x1: x, y1: best[1] - 1, lw: maxW, maxLw: maxW };
}

/**
 * 竖段按**原图墨迹**收拢：闭运算会跨过空白把干接到别的笔画上——两端补出来的空白行裁掉
 * （主使我喜乐 m8 干顶上方的和弦字母「A」），断口外离谱表 2 格以外的那截墨也裁掉
 * （m13 干尖接进下方歌词「乐」，字头被当成符尾）。谱表附近的断口照旧接着：扫描件的干本来会断
 * （一律按断口裁，合唱谱扫描档破碎漏 4 音）。
 */
function inkRun(bin: Binary, s: LineSeg | null, unit: RasterUnit, staffBands: [number, number][]): LineSeg | null {
  if (!s) return null;
  const { w, data } = bin;
  const x = Math.round(s.x0);
  const half = Math.ceil(s.maxLw / 2);
  const runs: [number, number][] = [];
  let start = -1;
  for (let y = Math.round(s.y0); y <= Math.round(s.y1) + 1; y++) {
    let ink = false;
    if (y <= s.y1) for (let xx = Math.max(0, x - half); xx <= Math.min(w - 1, x + half) && !ink; xx++) ink = data[y * w + xx] === 1;
    if (ink && start < 0) start = y;
    if (!ink && start >= 0) {
      runs.push([start, y - 1]);
      start = -1;
    }
  }
  if (!runs.length) return null;
  const far = ([a, b]: [number, number]) =>
    staffBands.every(([t, bot]) => b < t - unit.space * 2 || a > bot + unit.space * 2);
  let k = 0;
  for (let i = 1; i < runs.length; i++) if (runs[i][1] - runs[i][0] > runs[k][1] - runs[k][0]) k = i;
  let lo = k, hi = k;
  while (lo > 0 && !far(runs[lo - 1])) lo--;
  while (hi + 1 < runs.length && !far(runs[hi + 1])) hi++;
  const y0 = runs[lo][0], y1 = runs[hi][1];
  // 裁前已够 NARROW_STEM；剩下夹在符杠与头之间的短干约 2.8 格（主使我喜乐 m8）
  if (y1 - y0 + 1 < unit.space * INK_RUN_STEM) return null;
  return { ...s, y0, y1 };
}

/**
 * 这条笔画是不是**孤立**的——两侧（横段则上下）**都**空着。
 *
 * 非有这一条不可：谱号的中央竖笔、升号的两道竖笔、拍号「4」的竖笔，
 * 横向游程都很短，一律被当成竖笔画抽走，于是**符号被自己的笔画切开**
 * （实测高音谱号被切成上下两半，`bootstrapClefs` 取到的「谱号」一多半是它的上半截，
 * 高度不到 3.8 格，整批误判成低音谱号：你要等候 76 行谱认出 69 个「低音谱号」）。
 *
 * 沿笔画取样，两侧合计的邻墨超过取样行数就判它属于某个符号。
 * 真符干、真小节线两侧是空的，只在符头、符杠那一小截有邻墨。
 *
 * **试过分左右两侧、两侧都被挨着才算「属于符号」**（想放行被花括号贴着的系统线），
 * 更差：这么一放，谱号的中央竖笔也过了闸，低音谱号又被切开
 * （破碎 p7/p8 整页的谱号变成未知）。系统线另走**位置豁免**，见 `sysLeft`。
 */
function isolated(bin: Binary, s: LineSeg, vertical: boolean): boolean {
  const { w, h, data } = bin;
  const half = Math.max(1, Math.ceil(s.maxLw / 2));
  const near = half + 1;
  const far = half + Math.max(2, Math.round(s.maxLw * 2));
  let n = 0;
  let a = 0; // 两侧任一侧有邻墨的行数
  if (vertical) {
    const cx = Math.round((s.x0 + s.x1) / 2);
    for (let y = Math.round(Math.min(s.y0, s.y1)); y <= Math.round(Math.max(s.y0, s.y1)); y++) {
      if (y < 0 || y >= h) continue;
      n++;
      let hit = 0;
      for (let d = near; d <= far && !hit; d++) {
        if (cx - d >= 0) hit |= data[y * w + cx - d];
        if (cx + d < w) hit |= data[y * w + cx + d];
      }
      a += hit;
    }
  } else {
    const cy = Math.round((s.y0 + s.y1) / 2);
    for (let x = Math.round(Math.min(s.x0, s.x1)); x <= Math.round(Math.max(s.x0, s.x1)); x++) {
      if (x < 0 || x >= w) continue;
      n++;
      let hit = 0;
      for (let d = near; d <= far && !hit; d++) {
        if (cy - d >= 0) hit |= data[(cy - d) * w + x];
        if (cy + d < h) hit |= data[(cy + d) * w + x];
      }
      a += hit;
    }
  }
  return n === 0 || a < n * 0.5;
}

/**
 * 竖段一端连续 `CLEAN_TAIL` 格两侧都空着：叠着几个头的和弦干，头那一半两侧全是墨（再加上压着的谱线行），
 * 整条过不了孤立性（是爱 p1 m1 钢琴右手 F5/A5/C6 二分和弦，干 4.3 格、一半贴着头）。符干另一头是光的；
 * 谱号的中央竖笔、升号、拍号「4」的竖笔都没有这么长一截光杆。
 */
function cleanTail(bin: Binary, s: LineSeg, unit: RasterUnit): boolean {
  const t = Math.min(s.y0, s.y1), b = Math.max(s.y0, s.y1);
  const L = unit.space * CLEAN_TAIL;
  if (b - t < L) return false;
  const at = (y0: number, y1: number): LineSeg => ({ ...s, y0, y1, x0: s.x0 + ((s.x1 - s.x0) * (y0 - s.y0)) / (s.y1 - s.y0 || 1), x1: s.x0 + ((s.x1 - s.x0) * (y1 - s.y0)) / (s.y1 - s.y0 || 1) });
  return strictlyIsolated(bin, at(t, t + L)) || strictlyIsolated(bin, at(b - L, b));
}

/** 竖段沿原图那一列墨往两端延到断墨处（各至多 `max` 像素）：窄段只取到叠头以下，干端要落在最外那个头上，端头探头才对得上。 */
function alongInk(bin: Binary, s: LineSeg, max: number): LineSeg {
  const x = Math.round((s.x0 + s.x1) / 2);
  const half = Math.max(1, Math.floor(s.lw / 2));
  const ink = (y: number) => {
    if (y < 0 || y >= bin.h) return false;
    for (let xx = x - half; xx <= x + half; xx++) if (xx >= 0 && xx < bin.w && bin.data[y * bin.w + xx]) return true;
    return false;
  };
  let t = Math.round(Math.min(s.y0, s.y1)), b = Math.round(Math.max(s.y0, s.y1));
  const t0 = t, b0 = b;
  while (t0 - t < max && ink(t - 1)) t--;
  while (b - b0 < max && ink(b + 1)) b++;
  return { ...s, x0: x, x1: x, y0: t, y1: b };
}

/** 同 `isolated`，但邻墨行只许两成半（谱线行、跨过的加线）。 */
function strictlyIsolated(bin: Binary, s: LineSeg): boolean {
  const { w, h, data } = bin;
  const half = Math.max(1, Math.ceil(s.maxLw / 2));
  const near = half + 1;
  const far = half + Math.max(2, Math.round(s.maxLw * 2));
  let n = 0, a = 0;
  const cx = Math.round((s.x0 + s.x1) / 2);
  for (let y = Math.round(Math.min(s.y0, s.y1)); y <= Math.round(Math.max(s.y0, s.y1)); y++) {
    if (y < 0 || y >= h) continue;
    n++;
    let hit = 0;
    for (let d = near; d <= far && !hit; d++) {
      if (cx - d >= 0) hit |= data[y * w + cx - d];
      if (cx + d < w) hit |= data[y * w + cx + d];
    }
    a += hit;
  }
  return n > 0 && a <= n * 0.25;
}

/** 一行谱的线距与全页的相对差在这个范围里，加线网格才用它自己的线距（见 `ledgerGrid`）。 */
const LEDGER_OWN_SPACE = [0.04, 0.3];

/**
 * 「这个 y 落在谱线网格的延长线上吗」——判加线用。
 *
 * 加线是谱表的延长：只可能出现在第一线**上方**或第五线**下方**整数个线距处。
 * 容差取四分之一线距（谱线本身实测偏差不到 0.2px，位图上加线也贴着网格画）。
 */
export function ledgerGrid(lineYs: number[], unit: RasterUnit): (y: number) => boolean {
  if (lineYs.length < 5) return () => false;
  // 逐行谱取它的第一线与第五线（`lineYs` 是全页的线，五条一组）
  const anchors: number[] = [];
  const sorted = [...lineYs].sort((a, b) => a - b);
  for (let i = 0; i + 4 < sorted.length; i += 5) {
    anchors.push(sorted[i], sorted[i + 4]);
  }
  return (y: number) => {
    for (let i = 0; i < anchors.length; i += 2) {
      const top = anchors[i];
      const bottom = anchors[i + 1];
      // **线距取这一行谱自己的**，不取全页的：一页上谱表大小可以不一样（望十架人声谱表线距 10.4px、钢琴 11.6px），
      // 拿全页的线距往外推，小谱表的第二条加线就偏出两三像素、出了容差——骑在上面的头不算骑着加线，
      // 加线也补不出来，谱表外的音整批挂不上谱表。只在这一行的线距与全页的差出 4% 以上时才换：差得小的是量线位的
      // 半像素误差（一行只有五条线，全页的中位数更准；一律用自己的，以马内利来临歌、高举主大能各错一两个音），
      // 差到三成以上的是谱行找错了。
      const own = (bottom - top) / 4;
      const d = Math.abs(own - unit.space) / unit.space;
      const sp = d > LEDGER_OWN_SPACE[0] && d < LEDGER_OWN_SPACE[1] ? own : unit.space;
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
  };
}

/** 正好盖满谱表的竖段续出去的那截里，横向墨至少这么宽（格）才算续进了符头，见 `extendVSegs`。 */
const EXACT_HEAD_W = 0.6;

/**
 * 竖段的端点**沿着墨往里续**，至多 `cap` 个像素。返回续过的副本。
 *
 * 为什么要续：符干在与符头相接处横向游程一下子变成整个符头的宽度，出了「细」的那道闸，
 * 竖笔画就在符头**边界前一两个像素**断掉（实测缺口中位数只有 0.06 格）。
 * 而 `findStems` / `buildStems` 要的是符干与符头**纵向相交**，差一个像素就不成立
 * ——实测破碎 2218 个符头里只有 642 个（28.9%）配得上符干，其余全读成四分音符，
 * 符杠也因此接不上符干（层号 0 的占 304/1042）。
 *
 * 为什么只对竖段做：横段（谱线、加线）本来就该在符号处断开——那正是
 * 「上下都没墨才抹」判据的依据；竖段断在符头边上则是纯粹的**假边界**。
 *
 * **只给 `adapt.ts` 用，不回写 `prims`**：`blobImage` 按段的包围盒抹墨，
 * 续进符头的段会把符头啃掉一条，符头就认不出来了
 * （实测直接在 `findPrimitives` 里续，小节自检 27.4% → 31.4% 但音符 65.1% → 62.5%）。
 *
 * 续的时候看中心线左右各一列（符干只有一两个像素宽，中心线是拟合出来的，
 * 只看一列会被半像素的偏差卡住）。碰到白就停——不跨空隙，所以续不出别的符号。
 */
export function extendVSegs(bin: Binary, segs: LineSeg[], cap: number, staffBands: [number, number][] = [], lineThick = 1): LineSeg[] {
  // **正好从第五线画到第一线的**（`barlineCore` / `bandColumns` 取出的）续出去的那截要**进了符头**才留：
  // 连线收尾弯进小节线下端，续出 5px（0.35 格）就过不了 `findBarlines` 的「出界端须落谱线」
  //（我一生要赞美你第六、七行各漏一刀）；而和弦的长符干正要靠续进上下两端的头伸出谱表，
  // 才不被收成小节线（一律封顶 0.2 格，万古磐石歌多切两刀）。续出段里（谱线那几行不算）
  // 有一行横向墨宽过 `EXACT_HEAD_W` 算进了头；或者**笔直延续**（符杠下的长符干，同曲 x=1602 上下各伸出半格）
  // 也留。连线收尾只有一笔宽、又斜着偏开。
  const bandOf = (s: LineSeg) => staffBands.find(([t, b]) => Math.abs(Math.min(s.y0, s.y1) - t) <= 1 && Math.abs(Math.max(s.y0, s.y1) - b) <= 1);
  return segs.map((s) => {
    const out = { ...s };
    extendIntoInk(bin, out, cap);
    const band = bandOf(s);
    if (band) {
      const space = (band[1] - band[0]) / 4;
      const skip = Math.ceil(lineThick / 2) + 1;
      const x = (s.x0 + s.x1) / 2;
      const keep = (from: number, to: number) => reachesHead(bin, x, from, to, space) || straight(bin, x, from, to, s.maxLw);
      if (!keep(Math.round(s.y0) - skip, Math.round(out.y0))) out.y0 = s.y0;
      if (!keep(Math.round(s.y1) + skip, Math.round(out.y1))) out.y1 = s.y1;
    }
    return out;
  });
}

/** 从 `from` 到 `to`（含，任一方向）每行都有墨、墨段中心离 `x` 不过 1px 且不漂、宽不过线宽加 2：竖笔笔直往外延续。 */
function straight(bin: Binary, x: number, from: number, to: number, lw: number): boolean {
  const { w, h, data } = bin;
  const cx = Math.round(x);
  const step = to >= from ? 1 : -1;
  if ((to - from) * step < 1) return false;
  let lo = Infinity, hi = -Infinity;
  for (let y = from; step > 0 ? y <= to : y >= to; y += step) {
    if (y < 0 || y >= h || !data[y * w + cx]) return false;
    let a = cx, b = cx;
    while (a > 0 && data[y * w + a - 1]) a--;
    while (b + 1 < w && data[y * w + b + 1]) b++;
    const c = (a + b) / 2;
    if (b - a + 1 > lw + 2 || Math.abs(c - x) > 1) return false;
    lo = Math.min(lo, c);
    hi = Math.max(hi, c);
  }
  // 逐行中心的极差也不过 1px：连线收尾每行都离竖段不到 1px，却一路往一边偏（241 → 239.5）
  return hi - lo <= 1;
}

/** 从 `from` 到 `to`（含，任一方向）逐行量过 `x` 的横向墨宽，有一行够一个符头宽就算。 */
function reachesHead(bin: Binary, x: number, from: number, to: number, space: number): boolean {
  const { w, h, data } = bin;
  const cx = Math.round(x);
  const step = to >= from ? 1 : -1;
  for (let y = from; step > 0 ? y <= to : y >= to; y += step) {
    if (y < 0 || y >= h || !data[y * w + cx]) continue;
    let a = cx, b = cx;
    while (a > 0 && data[y * w + a - 1]) a--;
    while (b + 1 < w && data[y * w + b + 1]) b++;
    if (b - a + 1 >= space * EXACT_HEAD_W) return true;
  }
  return false;
}

function extendIntoInk(bin: Binary, seg: LineSeg, cap: number): void {
  const { w, h, data } = bin;
  const ink = (x: number, y: number) => {
    if (y < 0 || y >= h) return false;
    for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.round(x) + dx;
      if (xx >= 0 && xx < w && data[y * w + xx]) return true;
    }
    return false;
  };
  let up = 0;
  while (up < cap && ink(seg.x0, Math.round(seg.y0) - up - 1)) up++;
  let down = 0;
  while (down < cap && ink(seg.x1, Math.round(seg.y1) + down + 1)) down++;
  seg.y0 -= up;
  seg.y1 += down;
}

/**
 * **竖笔块太宽，但里头有一条盖满谱表的**：取出那几列当小节线。
 *
 * 小节线后第一个音是空心头、圈贴着线画时（我一生要赞美你第五、六行：全音符连到下一小节的二分音符），
 * 圈的左右两道竖边也在细竖笔的掩模里，与小节线连成一块，块宽超过两个「细」，整块被扔掉，
 * 那一刀就没了、两小节并成一个。线本身在掩模里是完整的，只是连着别的东西。
 *
 * 块须纵向盖住某个谱表带（两端各容半格），带内**整列都有墨**（≥95%）的列连成一段、
 * 宽不过两个「细」，才取。
 */
function barlineCore(mask: Uint8Array, w: number, c: Component, bands: [number, number][], maxW: number, unit: RasterUnit): LineSeg | null {
  const b = c.bbox;
  const tol = unit.space * 0.5;
  const band = bands.find(([t, bt]) => b.y <= t + tol && b.y + b.h - 1 >= bt - tol);
  if (!band) return null;
  const top = Math.round(band[0]), bot = Math.round(band[1]);
  const need = (bot - top + 1) * 0.95;
  const cols: number[] = [];
  for (let x = b.x; x < b.x + b.w; x++) {
    let n = 0;
    for (let y = top; y <= bot; y++) if (mask[y * w + x]) n++;
    if (n >= need) cols.push(x);
  }
  if (!cols.length) return null;
  const x0 = cols[0], x1 = cols[cols.length - 1];
  if (x1 - x0 + 1 !== cols.length || cols.length > maxW) return null;
  const x = (x0 + x1) / 2;
  return { x0: x, y0: top, x1: x, y1: bot, lw: cols.length, maxLw: cols.length };
}

/**
 * **掩模里断开了、二值图里却盖满谱表带的竖线**：按谱表带逐列扫原图补回来。
 *
 * 弧线斜着压过小节线、交点又挨着一条谱线时，那几行的横向游程连弧带线超过「细」，
 * 竖笔掩模在那里断开四五行，闭运算接不上；上下两截各连着一段弧、块偏宽，
 * `barlineCore` 又要整块盖满谱表带，两截都被扔掉（我灵镇静第四行低音谱表 x=686，
 * 高低音谱表从此错开一个小节）。原图上那一列从第五线到第一线每行都有墨，谱线本身也算墨，
 * 所以断口不影响。带内 ≥95% 行有墨、且闭运算后的竖笔掩模里也有 ≥75% 的列连成一段
 * （后一条挡住别的块的边缘列、终止线那种粗线），宽不过一个「细」；
 * 半格内已有竖段的不补，行首四格（谱号、系统线）不补。符干与小节线照旧交给 `findStems`/`findBarlines` 分。
 */
function bandColumns(
  bin: Binary,
  vMask: Uint8Array,
  bands: [number, number][],
  have: LineSeg[],
  maxW: number,
  staffLefts: number[],
  unit: RasterUnit,
): LineSeg[] {
  const { w, data } = bin;
  const out: LineSeg[] = [];
  for (const [t, bt] of bands) {
    const top = Math.round(t), bot = Math.round(bt);
    const need = (bot - top + 1) * 0.95;
    const thinNeed = (bot - top + 1) * 0.75;
    const full = (x: number) => {
      let n = 0;
      let m = 0;
      for (let y = top; y <= bot; y++) {
        if (data[y * w + x]) n++;
        if (vMask[y * w + x]) m++;
      }
      return n >= need && m >= thinNeed;
    };
    for (let x = 0; x < w; x++) {
      if (!full(x)) continue;
      const x0 = x;
      while (x + 1 < w && full(x + 1)) x++;
      const cx = (x0 + x) / 2;
      const width = x - x0 + 1;
      if (width > maxW) continue;
      if (staffLefts.some((l) => cx >= l - unit.space && cx <= l + unit.space * 4)) continue;
      const near = have.some(
        (s) => Math.abs((s.x0 + s.x1) / 2 - cx) <= unit.space * 0.5 && Math.min(s.y0, s.y1) <= bot && Math.max(s.y0, s.y1) >= top,
      );
      if (near) continue;
      // **贴着符头、符杠的是符干**（向主唱新歌的三音和弦、万古磐石歌的八分十六分，干都盖满谱表带，
      // 原先不在竖段里，补进来向主唱新歌音符掉 1.8 点、万古磐石歌时值掉 4 点）：从线的外缘往外量每行连着的墨，
      // 长过半格算「宽行」，宽行连着超过 0.4 格就是挨着一块符头或符杠。小节线外侧只有谱线（线粗那几行）
      // 与擦过的弧（我灵镇静那道弧连线才 6px、三分之一格）。
      const attached = (dir: -1 | 1) => {
        const from = dir < 0 ? x0 - 1 : x + 1;
        let run = 0;
        let best = 0;
        for (let y = top; y <= bot; y++) {
          let len = 0;
          for (let sx = from; sx >= 0 && sx < w && data[y * w + sx] && len <= unit.space; sx += dir) len++;
          run = len >= unit.space * 0.5 ? run + 1 : 0;
          best = Math.max(best, run);
        }
        return best > unit.space * 0.4;
      };
      if (attached(-1) || attached(1)) continue;
      out.push({ x0: cx, y0: top, x1: cx, y1: bot, lw: width, maxLw: width });
    }
  }
  return out;
}

/**
 * 抽出全部几何原语。
 *
 * 三道门槛都按线距 `space` 写（与矢量路同口径，不写绝对像素）：
 *   - 横笔画：纵向游程 ≤ 线宽的三倍。谱线、加线是它；符杠的厚度约半个线距，出局。
 *   - 竖笔画：横向游程 ≤ 线宽的三倍。符干、小节线是它。
 *   - 符杠：纵向游程在 0.25~1.1 个线距之间、且横向游程超过一个线距。
 *     下限把谱线滤掉，上限把符头（约一个线距高、但横向游程只有一个符头宽）与
 *     实心块滤掉；横向那道再滤掉竖直的粗笔画。
 */
export function findPrimitives(
  bin: Binary,
  unit: RasterUnit,
  staffLineYs: number[] = [],
  /** 各谱行的左缘 x。**系统线按位置豁免孤立性判据**——它就画在谱行左缘，
   *  紧贴它的花括号会让「两侧有没有邻墨」判它属于某个符号，
   *  于是整页的系统线一条都抽不出来，十行谱碎成十个系统
   *  （实测破碎 p5 起就是这样，`buildScore` 随之把一个声部拆成好几条）。 */
  staffLefts: number[] = [],
  /** 细线扫描件（`RasterPage.faint`）：竖笔的「细」放宽，见「竖笔画」那段。 */
  faint = false,
): RasterPrims {
  const { w, h } = bin;
  const onGrid = ledgerGrid(staffLineYs, unit);
  const atStaffLeft = (x: number) => staffLefts.some((l) => Math.abs(x - l) <= Math.max(3, unit.lineThick * 2));
  // **正好从一行谱的第一线画到第五线**（两端各 ±0.5 格）、又不在行首四格里的竖段：这是小节线的样子，
  // 不查孤立性。反复记号的细线右边紧挨着一道粗线（网纹印的粗线还过不了「细」这一闸），
  // 孤立性判它属于某个符号，整条抽不出来，两小节并成一个（《向主唱新歌》第 14 小节末）。
  // 谱号的中央竖笔上下都伸出谱表，升号、拍号的竖笔没有一整个谱表高，都不沾这一条。
  const staffBands: [number, number][] = [];
  {
    const ys = [...staffLineYs].sort((a, b) => a - b);
    for (let i = 0; i + 4 < ys.length; i += 5) staffBands.push([ys[i], ys[i + 4]]);
  }
  const spansStaff = (sg: LineSeg) => {
    const x = (sg.x0 + sg.x1) / 2;
    if (staffLefts.some((l) => x >= l - unit.space && x <= l + unit.space * 4)) return false;
    const t = Math.min(sg.y0, sg.y1);
    const b = Math.max(sg.y0, sg.y1);
    return staffBands.some(([top, bot]) => Math.abs(t - top) <= unit.space * 0.5 && Math.abs(b - bot) <= unit.space * 0.5);
  };
  const vr = vRuns(bin);
  const hr = hRuns(bin);
  // 「细」的上限**要卡在谱线与符杠之间**：谱线约 0.15 个线距厚，符杠约 0.5 个。
  // 一度写成 `lineThick * 3`，那正好撞上符杠的厚度——符杠混进横笔画，
  // 与它压着的谱线连成一块，块高一超限整条谱线跟着被剔掉
  // （实测宁静 p1 五十条谱线只剩十一条，且都不是谱线）。
  // 改成按线距取比例、再用线宽兜个下限。
  const thin = Math.max(3, Math.min(unit.lineThick * 2, unit.space * 0.4));

  // ── 横笔画 ──
  const hMask0 = new Uint8Array(w * h);
  for (let i = 0; i < hMask0.length; i++) if (vr[i] && vr[i] <= thin) hMask0[i] = 1;
  const hMask = close1d(hMask0, w, h, Math.round(unit.space * 0.6), true);
  const hSegs: LineSeg[] = [];
  for (const c of comps(hMask, w, h, Math.max(3, unit.lineThick * 2))) {
    // 长度下限：一个线距。**落在谱线网格上的放宽到三分之一格**——
    // 加线被压在它上面的符头从中间切断（符头的纵向游程粗，不在横笔画的掩模里），
    // 剩下左右两截各只有 0.4 格，照一个线距的闸两截都被滤掉，
    // 于是「谱表外一条加线」的音符（高音谱表下面的 C4）整批收不进来
    // ——实测宁静一首的人声行开头 `C4 C4 B3 C4` 只认出 B3。
    // 试过把水平闭运算的半径从 0.6 格放到 1.0/1.5 格把两截接起来，**更差**
    //（音符 28.5% → 25.2% / 21.8%）：半径一大，别处不相干的横笔画也被连成一条。
    const cy = c.bbox.y + c.bbox.h / 2;
    if (c.bbox.w < (onGrid(cy) ? unit.space / 3 : unit.space)) continue;
    if (c.bbox.h > thin * 2) continue; // 太厚：不是单条横线（是几条粘在一起或别的东西）
    const seg = centerLine(hMask, w, c, true);
    // **加线免检**：加线总有个符头压在上面，孤立性判据一律判它「属于某个符号」，
    // 于是既抽不出来（`findLegers` 没得用）、也抹不掉（符头连着加线，
    // 宽度从 1.3 格涨到 1.77 格，字典里凭空多出两个三百多实例的「符头」大类）。
    // 加线有一条更硬的判据：它只出现在**谱线网格的延长线**上。
    if (!onGrid((seg.y0 + seg.y1) / 2) && !isolated(bin, seg, false)) continue;
    hSegs.push(seg);
  }

  // ── 竖笔画 ──
  const vMask0 = new Uint8Array(w * h);
  // 细线扫描件（敬拜万世之王 线宽/线距 1px/18.8px）的「细」按线宽定只有 3px，
  // 简谱行的粗小节线（5px）进不了竖段，简谱行也就定不了位。这一档的竖笔放到 0.3 格。
  // 只认 `faint`，不按线宽/线距比判：干净位图你要等候也是 1px/18.75px，照放宽的话
  // 符头、符尾的竖边混进竖段，合唱谱干净档小节自检 59.5 → 58.4（该曲 35.6 → 31.3）。
  const thinV = faint ? Math.max(thin, unit.space * 0.3) : thin;
  for (let i = 0; i < vMask0.length; i++) if (hr[i] && hr[i] <= thinV) vMask0[i] = 1;
  const vMask = close1d(vMask0, w, h, Math.round(unit.lineThick * 2), false);
  const vSegs: LineSeg[] = [];
  /** 叠头和弦的短干（见下），单独交出去 */
  const shortStems: LineSeg[] = [];
  for (const c of comps(vMask, w, h, Math.max(3, unit.lineThick * 2))) {
    if (c.bbox.h < unit.space * VSEG_MIN_H) continue;
    if (c.bbox.w > thinV * 2) {
      const core = barlineCore(vMask, w, c, staffBands, thinV * 2, unit);
      if (core && !atStaffLeft(core.x0) && !staffLefts.some((l) => core.x0 >= l - unit.space && core.x0 <= l + unit.space * 4)) vSegs.push(core);
      else if (!core) {
        // 竖向闭运算跨过符杠，把上方和弦字母的斜笔接到了符干上（主使我喜乐 m8 那个「A」下的 A4）：取窄的那一段
        // 行宽按这块自己的众数放宽（按细笔上限放的话，贴干的头边也收进来，干粗到 8px：高举主大能 m7 F3 丢了）
        const narrow = inkRun(bin, narrowPart(vMask, w, c, modalRowWidth(vMask, w, c), unit), unit, staffBands);
        if (narrow && !atStaffLeft(narrow.x0) && isolated(bin, narrow, true)) vSegs.push(narrow);
        else if (!narrow) {
          // 不到 `NARROW_STEM` 的（叠头和弦的干，头以下只剩 2.9 格）要有一截光杆（`cleanTail`）
          const short = inkRun(bin, narrowPart(vMask, w, c, modalRowWidth(vMask, w, c), unit, CLEAN_TAIL), unit, staffBands);
          if (short && !atStaffLeft(short.x0) && cleanTail(bin, short, unit)) shortStems.push(alongInk(bin, short, unit.space * CLEAN_TAIL));
        }
      }
      continue;
    }
    const seg = centerLine(vMask, w, c, false);
    // 谱行左缘那条（系统线）免检，其余要判孤立性——谱号的中央竖笔、升号的竖笔不是原语
    if (!atStaffLeft((seg.x0 + seg.x1) / 2) && !spansStaff(seg) && !isolated(bin, seg, true)) {
      // 只在原窗里有一根盖满谱表的整列（小节线）时按窄段重判：只因某一行偏宽、原本被别的邻墨判不孤立的块
      // 也放进来的话，破碎干净版满拍自检 64.8 → 58.2
      const narrow = narrowPart(vMask, w, c, seg.lw, unit);
      if (narrow && isolated(bin, narrow, true) && barColumnNear(bin, (seg.x0 + seg.x1) / 2, seg.maxLw, staffBands)) vSegs.push(narrow);
      continue;
    }
    vSegs.push(seg);
  }
  vSegs.push(...bandColumns(bin, vMask, staffBands, vSegs, thinV, staffLefts, unit));

  // ── 符杠 ──
  const bMask = new Uint8Array(w * h);
  // 符杠必须比本页的谱线更厚。扫描件的粗加线也能超过四分之一格：
  // 望十架 web 版 p2 的加线厚 5px、线距 18.125px，原来会被当成符杠；
  // 加线连着符头时又把符头拉宽，过了长宽比闸，随后抹符杠把符头拦腰切断。
  // 用实测线宽的一倍半兜底，在构造掩模时就排掉细横墨；留下的椭圆过不了
  // 符杠长宽比闸。干净页仍由四分之一格定下限（正常的细符杠要保留）。
  const bLo = Math.max(unit.space * 0.25, unit.lineThick * 1.5);
  const bHi = unit.space * 1.1;
  for (let i = 0; i < bMask.length; i++) if (vr[i] >= bLo && vr[i] <= bHi && hr[i] >= unit.space) bMask[i] = 1;
  // **沿 x 闭一道**，与横笔画同一个道理：符干穿过符杠的那几列横向游程很短，
  // 出了「横向游程 ≥ 一个线距」这道闸，符杠于是被每根符干切成小段
  //（实测你要等候 p2 一条符杠碎成 1.33~1.65 格的六截，`w ≥ 1.5 格` 那道闸挡掉大半，
  // 整页 199 个符头只认出 44 条符杠——音符排得密的谱子尤其吃亏）。
  // 半径取两个线宽：符干就这么粗，再大会把相邻两组的符杠连成一条。
  const bMaskC = close1d(bMask, w, h, Math.round(unit.lineThick * 2), true);
  const beams: BeamQuad[] = [];
  /** 这一列附近有没有一根竖段搭着这块（x 在 ±tol 内、纵向与块相交），有就返回它的 x。 */
  const stemNear = (x: number, b: Rect, tol: number): number | null => {
    for (const v of vSegs) {
      const vx = (v.x0 + v.x1) / 2;
      if (Math.abs(vx - x) <= tol && Math.min(v.y0, v.y1) <= b.y + b.h + 2 && Math.max(v.y0, v.y1) >= b.y - 2) return vx;
    }
    return null;
  };
  /** 两根干之间逐列量块的墨厚（这一列在块盒里最长的竖游程），取中位数。 */
  const midThick = (b: Rect, xa: number, xb: number): number => {
    const ts: number[] = [];
    for (let x = Math.ceil(xa); x <= Math.floor(xb); x++) {
      let best = 0;
      for (let y = b.y; y < b.y + b.h; y++) if (bMaskC[y * w + x]) best = Math.max(best, vr[y * w + x]);
      ts.push(best);
    }
    ts.sort((p, q) => p - q);
    return ts.length ? ts[ts.length >> 1] : 0;
  };
  for (const c of comps(bMaskC, w, h, Math.round(unit.space * unit.space * 0.2))) {
    // **两端各连着一根干、中间够厚的短杠**：两个八分挨得近（我一生要赞美你 m18，两根干只隔 1.2 格），杠短、又斜，
    // 过不了宽度与长宽比那两道，反被收成一个实心头。两根干之间逐列量厚，中位数要像杠（`SHORT_BEAM_THICK`）
    const tol = Math.max(2, unit.lineThick * 2);
    let shortBeam = false;
    if (c.bbox.w >= unit.space * SHORT_BEAM_W && c.bbox.w < unit.space * 1.5 && c.bbox.h <= unit.space * 1.2) {
      const xa = stemNear(c.bbox.x, c.bbox, tol);
      const xb = stemNear(c.bbox.x + c.bbox.w - 1, c.bbox, tol);
      if (xa !== null && xb !== null && xb - xa >= unit.space * 0.7) {
        const t = midThick(c.bbox, xa + tol, xb - tol) / unit.space;
        shortBeam = t >= SHORT_BEAM_THICK[0] && t <= SHORT_BEAM_THICK[1];
      }
    }
    if (!shortBeam) {
      if (c.bbox.w < unit.space * 1.5) continue; // 太短的不是符杠（照矢量路 findBeams 的 0.8 格，位图放宽到 1.5）
      if (c.bbox.h > unit.space * 3) continue; // 太高：是实心块、方框
      // **要够扁**。光靠上面两条拦不住符头：实心符头约 1.3×1.0 个线距，
      // 纵向游程（18px）落在符杠区间里、横向游程也过线，宽度还差一点点就够。
      // 符杠是 3:1 往上的长条，符头是 1.3:1 的椭圆，长宽比一刀分得开。
      if (c.bbox.w < c.bbox.h * 2.5) continue;
    }
    // **谱表外的短「杠」两端都要连着干**：粗线的低分辨率页上加线有三像素厚，骑着、贴着加线的符头与加线并成一块
    //（纵向游程过了「比谱线厚一倍半」那道闸），宽过一格半、够扁，被收成符杠，头就丢了（烛光颂曲管风琴右手
    // 谱表下方两条加线上的一串八分，一个都没认出）。真的短杠是架在两根干之间的；头连加线只在一侧有干。
    // 只管谱表外、不到两格半的：谱表里的短杠照旧，长杠不会是一个头。
    // 只在线宽过线距两成的页判：细线页的加线过不了厚度闸、不会并进来，而那里干抽不全的真短杠会被这一条误杀
    //（不限线宽时独唱谱时值 97.52 → 96.96%、合唱谱干净档小节自检 88.62 → 86.34%）。
    if (!shortBeam && unit.lineThick > unit.space * LEDGER_BEAM_THICK && c.bbox.w < unit.space * LEDGER_BEAM_W && !staffBands.some(([t, b]) => c.bbox.y + c.bbox.h / 2 > t - unit.space * 0.3 && c.bbox.y + c.bbox.h / 2 < b + unit.space * 0.3)) {
      const xa = stemNear(c.bbox.x, c.bbox, tol);
      const xb = stemNear(c.bbox.x + c.bbox.w - 1, c.bbox, tol);
      // 还要看得见加线：块的左端或右端往外三成格处有一道细横墨（厚不过谱线的一倍半）。真短杠两头之外是白的
      //（只看干时救主降生一条干没抽全的短杠被误杀，音符 98.5 → 96.9%）
      const d = Math.max(2, Math.round(unit.space * 0.3));
      // 那道细横墨还得落在谱线网格的延长线上、离谱表不过四格半（歌词带里的横笔两头也是细的）
      const nearStaff = staffBands.some(([t, b]) => c.bbox.y + c.bbox.h > t - unit.space * 4.5 && c.bbox.y < b + unit.space * 4.5);
      const thinAt = (x: number) => {
        if (x < 0 || x >= w || !nearStaff) return false;
        for (let y = Math.max(0, c.bbox.y - 1); y <= Math.min(h - 1, c.bbox.y + c.bbox.h); y++)
          if (bin.data[y * w + x] && vr[y * w + x] <= unit.lineThick * 1.5 && onGrid(y)) return true;
        return false;
      };
      const ledgerTail = thinAt(c.bbox.x - d) || thinAt(c.bbox.x + c.bbox.w - 1 + d);
      // 块自己得比一条线厚（四成格以上；头贴着加线的那一块量得半格上下）：只有线那么薄的是一道横线（歌词的延长线、单独一截粗加线），不是「头连着加线」。
      // 高举主大能有一道 26×3 的横线过了前面几条，不再算符杠之后留在歌词条里，那一行歌词读坏（中文 94 → 70%，
      // 当时被旧的 OCR 缓存盖住没显出来）
      if (c.bbox.h >= unit.space * 0.4 && ledgerTail && (xa === null || xb === null || xb - xa < unit.space * 0.7)) continue;
    }
    const line = centerLine(bMaskC, w, c, true);
    // **杠厚要匀**：低分辨率页上一串八分的头沿谱线挨个粘成一条（有一位神 m4 五个 B4），过得了宽度与长宽比，
    // 被当成一层杠，头全丢了。杠逐列厚度基本一样，头串是头处鼓、头间凹。沿中心线逐列量墨的竖游程
    //（去掉 1.5 格以上的干列），中位厚过 `BEAM_EVEN_MED` 格、而第一成分位不到中位的 `BEAM_EVEN_LO` 的不收。
    // 网点灰的真杠纹理也有洞（下分位 0.3~0.6），但中位厚正常（0.54 格），靠中位那一条放过。只在谱表上下三格内判：
    // 页眉的粗体字也有这种剖面，剔掉后它的墨改走别的路，连带把拍号数字认成符头（齐来崇拜）。
    if (!shortBeam && staffBands.some(([t, b]) => c.bbox.y + c.bbox.h / 2 > t - unit.space * 3 && c.bbox.y + c.bbox.h / 2 < b + unit.space * 3)) {
      const ts: number[] = [];
      const trim = Math.round(unit.space * 0.3);
      for (let x = c.bbox.x + trim; x < c.bbox.x + c.bbox.w - trim; x++) {
        const cy = Math.round(line.y0 + ((line.y1 - line.y0) * (x - line.x0)) / Math.max(1, line.x1 - line.x0));
        const n = vr[cy * w + x];
        if (n > 0 && n <= unit.space * 1.5) ts.push(n);
      }
      ts.sort((p, q) => p - q);
      const med = ts[ts.length >> 1] || 1;
      if (ts.length >= unit.space && med > unit.space * BEAM_EVEN_MED && ts[Math.floor(ts.length * 0.1)] < med * BEAM_EVEN_LO) continue;
    }
    beams.push({ ...line, box: c.bbox });
  }
  // **网点灰的杠被纹理横着切成上下两条**（当我们回到天家 m12：一条杠读成高 3、高 4 两条），被当成两层，
  // 附点八分读成十六分。x 范围基本重合、上下间隙不过一个线宽、合起来不过一根杠厚（0.8 格）的并成一条
  // 独唱谱时值 92.21 → 92.31%（当我们回到天家 +3.2），合唱谱扫描档音符 +0.11、小节自检 +0.27。
  // x 重合按**较窄**那条算：切下来的一条常只有杠长的一半（当我们回到天家 m12 上面 40px × 2px 一条、下面 70px，
  // 十六分读成三十二分）；真半截杠离主杠隔着 0.25 格以上的白缝、合起来也超过 0.8 格，下面两条照样拦得住
  for (let i = 0; i < beams.length; i++)
    for (let j = beams.length - 1; j > i; j--) {
      const a = beams[i].box;
      const b = beams[j].box;
      const ov = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      if (ov < Math.min(a.w, b.w) * 0.8) continue;
      const gap = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
      const y0 = Math.min(a.y, b.y);
      const y1 = Math.max(a.y + a.h, b.y + b.h);
      if (gap > Math.max(1, unit.lineThick) || y1 - y0 > unit.space * 0.8) continue;
      const x0 = Math.min(a.x, b.x);
      const box = { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: y1 - y0 };
      const A = beams[i];
      const B = beams[j];
      beams[i] = { ...A, y0: (A.y0 + B.y0) / 2, y1: (A.y1 + B.y1) / 2, lw: y1 - y0, maxLw: y1 - y0, box };
      beams.splice(j, 1);
    }
  dropHeadEndBeams(beams, vSegs, unit);
  beams.push(...partialBeams(bin, beams, unit, vSegs));
  vSegs.push(...beamStems(bin, beams, vSegs, unit, staffLineYs));
  // 杠上补出的干也能揭出头那一端的假杠，再剔一遍
  dropHeadEndBeams(beams, vSegs, unit);
  return { hSegs, vSegs, beams, shortStems };
}

/**
 * **半截符杠**：附点八分 + 十六分那种，十六分那一侧的第二道杠只有一个头宽（1 格左右），
 * 过不了符杠「≥1.5 格、3:1 往上」的闸，就被当成实心符头挂在干上（《倚靠主永远膀臂》整曲的十六分都读成八分、
 * 还多出一个高音）。它的位置是死的：贴着一条已认出的杠的**端头**、隔一道白缝、与杠平行、厚度与杠相近。
 *
 * 做法：沿每条杠两端 1.6 格内逐列往杠的上下两侧走——跨过杠本身、跨过 1px~0.6 格的白缝、
 * 再遇到一段厚 0.6~1.6 倍杠厚的墨，这一列就是半截杠的一列。从杠端（容 0.4 格）起连续够 0.5 格的，收成一截杠。
 * 另卡：高 0.3~0.8 格（薄的是弧线、文字笔画）、杠端有一列从主杠连墨到它（同一根干上）、已认出的杠与重复的不算。
 */
/** 杠厚要匀（见 `findPrimitives` 符杠那段）：中位厚下限（格）、第一成分位与中位之比的下限。
 *  扫 BEAM_EVEN_LO 0.65 / 0.75 / 0.85：独唱谱音符 93.91 / 93.92 / 93.93%；BEAM_EVEN_MED 0.65 / 0.75 / 0.85：93.92 / 93.92 / 93.91%。 */
const BEAM_EVEN_MED = 0.75;
const BEAM_EVEN_LO = 0.85;
/** 半截符杠的高度范围（格）。 */
const PARTIAL_BEAM_H = [0.3, 0.8] as const;

function partialBeams(bin: Binary, beams: BeamQuad[], unit: RasterUnit, vSegs: LineSeg[] = []): BeamQuad[] {
  const sp = unit.space;
  const out: BeamQuad[] = [];
  const ink = (x: number, y: number) => y >= 0 && y < bin.h && x >= 0 && x < bin.w && !!bin.data[y * bin.w + x];
  const holeTol = Math.max(1, Math.ceil(unit.lineThick));
  for (const b of beams) {
    const lw = Math.max(2, b.lw);
    const yAt = (x: number) => b.y0 + ((b.y1 - b.y0) * (x - b.x0)) / Math.max(1, b.x1 - b.x0);
    // 起点：杠的两端；**杠中段的每根干左右两侧**也算（附点八分 + 十六分夹在一组中间时，
    // 十六分的半截杠挂在中段那根干旁边，平安夜歌伴奏整曲九处）
    const starts: [number, number][] = [[b.box.x, 1], [b.box.x + b.box.w - 1, -1]];
    for (const v of vSegs) {
        const vx = Math.round((v.x0 + v.x1) / 2);
        if (vx <= b.box.x + sp * 0.5 || vx >= b.box.x + b.box.w - 1 - sp * 0.5) continue;
        const by = yAt(vx);
        // 干的上一截常贴着半截杠、没进竖段表（平安夜：竖段从杠下 1 格才开始），离杠 1.5 格内都算
        if (Math.min(v.y0, v.y1) > by + sp * 1.5 || Math.max(v.y0, v.y1) < by - sp * 1.5) continue;
        const half = Math.ceil(v.maxLw / 2) + 1;
        starts.push([vx - half, -1], [vx + half, 1]);
      }
    for (const side of [-1, 1])
      for (const [end, dir] of starts) {
        const cols: { x: number; y0: number; y1: number }[] = [];
        // 已收了几列后容断几列：杠里的白洞（网点扫描）让个别列读不出（当我们回到天家 m11 只收到 7 列）
        let skip = 0;
        const skipTol = sp * 0.25;
        for (let k = 0; k < sp * 1.6; k++) {
          const x = end + dir * k;
          let y = Math.round(yAt(x));
          if (!ink(x, y)) {
            if (cols.length && ++skip > skipTol) break;
            continue;
          }
          // 跨过杠本身，顺带量这一列的杠厚（平均线宽对斜杠估得偏薄：当我们回到天家 5.96px，实际 8~10）
          let t = 1;
          for (let yy = y; ink(x, yy - side); yy -= side) t++;
          while (ink(x, y + side)) (y += side), t++;
          // 夹在平均线宽的 1~1.7 倍：杠外侧连着别的墨时（相邻的杠、头）t 会量大（倚靠主丢了半杠）
          const lwx = Math.min(Math.max(lw, t), lw * 1.7);
          let g = 0;
          while (!ink(x, y + side * (g + 1)) && g <= sp * 0.6) g++;
          const s0 = y + side * (g + 1);
          // 先按连着的墨段判；不合格再容一个线宽的断口数一次：半杠被谱线横穿，去线时在它中间啃出一两行白
          //（当我们回到天家）。只用后者的话，墨段会越过断口连上后面别的墨，原本合格的半杠反倒超厚（倚靠主 −2.9）
          const runLen = (tol: number) => {
            let n = 0;
            for (let miss = 0; n <= lwx * 1.6; ) {
              if (ink(x, s0 + side * (n + miss))) (n += miss + 1), (miss = 0);
              else if (++miss > tol) break;
            }
            return n;
          };
          const fits = (n: number) => n >= lwx * 0.6 && n <= lwx * 1.6;
          let r = runLen(0);
          if (!fits(r)) r = runLen(holeTol);
          const ok = g >= 1 && g <= sp * 0.6 && fits(r);
          if (!ok) {
            if (cols.length ? ++skip > skipTol : k > sp * 0.4) break;
            continue;
          }
          cols.push({ x, y0: Math.min(s0, s0 + side * (r - 1)), y1: Math.max(s0, s0 + side * (r - 1)) });
        }
        if (cols.length < sp * 0.5) continue;
        const xs = cols.map((c) => c.x);
        const x0 = Math.min(...xs);
        const x1 = Math.max(...xs);
        // 上下缘取各列的中位数：杠里的白洞会让个别列读岔（把杠的下半截当成半杠），min/max 会把盒拉高
        const med = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1];
        const top = med(cols.map((c) => c.y0));
        const bot = med(cols.map((c) => c.y1));
        // 落在已认出的杠上的不算（十六分那组两条杠都是整条，从第一条往外走就撞上第二条）
        const cy = (top + bot) / 2;
        if (beams.some((q) => q !== b && x0 >= q.box.x - 2 && x1 <= q.box.x + q.box.w + 2 && cy >= q.box.y && cy <= q.box.y + q.box.h)) continue;
        if (bot - top + 1 < sp * PARTIAL_BEAM_H[0] || bot - top + 1 > sp * PARTIAL_BEAM_H[1]) continue;
        // 与主杠**同一根干**：杠端附近有一列从主杠一直连墨到这一截（干穿过那道白缝）
        const reachY = side > 0 ? bot : top;
        const onStem = [...Array(Math.round(unit.lineThick * 2) + 5).keys()].some((d) => {
          const x = end + dir * (d - 2);
          for (let y = Math.round(yAt(x)); y !== reachY; y += side) if (!ink(x, y)) return false;
          return true;
        });
        if (!onStem) continue;
        if (out.some((q) => Math.abs(q.box.x - x0) <= 2 && Math.abs(q.box.y - top) <= 2)) continue;
        const first = cols.find((c) => c.x === x0)!;
        const last = cols.find((c) => c.x === x1)!;
        out.push({
          x0, x1, y0: (first.y0 + first.y1) / 2, y1: (last.y0 + last.y1) / 2,
          lw: cols.reduce((a, c) => a + c.y1 - c.y0 + 1, 0) / cols.length,
          maxLw: Math.max(...cols.map((c) => c.y1 - c.y0 + 1)),
          box: { x: x0, y: top, w: x1 - x0 + 1, h: bot - top + 1 },
        });
      }
  }
  return out;
}

/**
 * 逐列估计谱线的局部中心。扫描件即使已推平，行首仍会偏离全行中心几像素，
 * 固定高度擦线就会把残余谱线当成「上下相连的符号」，谱号连着长横线而认不出。
 * 只用附近的短纵向游程定位，再取横跨两个线距的滑动中位数；至少半窗有证据，
 * 且偏移超过 1px 才修正。符干、符头的长游程不参与估计，缺证据则沿用全行中心。
 * 这里只定位，不擦像素；保护交叉符号仍由下面的上下邻墨检查负责。
 */
function localLineCenters(bin: Binary, runs: Uint16Array, cy: number, unit: RasterUnit): Float64Array {
  const { w, h, data } = bin;
  const radius = Math.max(2, Math.round(unit.space * 0.35));
  const lo = Math.max(0, Math.floor(cy) - radius);
  const hi = Math.min(h - 1, Math.ceil(cy) + radius);
  const cap = Math.max(unit.lineThick * 2, unit.lineThick + 2);
  const samples = new Int32Array(w).fill(-1);
  for (let x = 0; x < w; x++) {
    let dist = radius + 1;
    for (let y = lo; y <= hi; y++) {
      const len = runs[y * w + x];
      if (!len || len > cap) continue;
      let end = y + 1;
      while (end < h && data[end * w + x]) end++;
      const mid = end - (len + 1) / 2;
      if (mid >= lo && mid <= hi && Math.abs(mid - cy) < dist) {
        dist = Math.abs(mid - cy);
        samples[x] = Math.round((mid - lo) * 2);
      }
      y = end - 1;
    }
  }
  const centers = new Float64Array(w).fill(cy);
  const hist = new Int32Array((hi - lo) * 2 + 1);
  const window = Math.max(4, Math.round(unit.space));
  let count = 0;
  const add = (x: number, delta: number) => {
    if (x < 0 || x >= w || samples[x] < 0) return;
    hist[samples[x]] += delta;
    count += delta;
  };
  for (let x = 0; x < window; x++) add(x, 1);
  for (let x = 0; x < w; x++) {
    add(x + window, 1);
    add(x - window - 1, -1);
    if (count < Math.max(4, window)) continue;
    let n = 0;
    for (let k = 0; k < hist.length; k++) {
      n += hist[k];
      if (n <= count / 2) continue;
      const local = lo + k / 2;
      if (Math.abs(local - cy) > 1) centers[x] = local;
      break;
    }
  }
  return centers;
}

/**
 * 去谱线：把属于谱线的像素抹掉，留下符头/符干/符杠/字。
 *
 * 判据是**上下都没有墨才抹**：谱线那一带的某一列，如果紧邻的上方与下方
 * 都是白的，就抹掉；只要有一侧连着墨，就保留某个符号穿过谱线的那一截。
 * 不能直接按「纵向游程短」擦像素，否则会抹断骑线的拍号数字、休止符和谱号。
 */
/** 没成组的横线只抹竖游程不过这么多个线宽的列：谱线、加线约一个线宽，符杠约 0.5 格厚——
 *  粗线页上只有线宽的两倍（主使我喜乐线宽 4、杠厚 8 像素）。 */
const THIN_ONLY_RUN = 1.6;
/** 从杠边伸出多长（格）的细墨柱算干。 */
const BEAM_STEM_MIN = 2.0;

/**
 * **挂在杠上的干**：孤立性判据在粗线扫描件上抽不出夹在两个头之间的干——两侧量程按最宽那一行定，
 * 贴着的邻头、横穿的谱线和杠一起占去过半行（破碎扫描版 p7 十六分，见「现状与待办」阈值冲突表）。
 * 干没抽出来，它连着的头与邻头沿谱线焊成一团，超出拆块闸，头全丢。
 * 换个特征找：干一定挂在杠上。沿每条杠逐列从杠的上下沿往外走（谱线那几行允许断开），
 * 连续伸出 `BEAM_STEM_MIN` 格以上的列并成一束；束宽不过细笔上限、离已有竖段半格开外的，补一根竖段。
 */
function beamStems(bin: Binary, beams: BeamQuad[], vSegs: LineSeg[], unit: RasterUnit, lineYs: number[]): LineSeg[] {
  const { w, h, data } = bin;
  const sp = unit.space;
  const thin = Math.max(3, Math.min(unit.lineThick * 2, sp * 0.4));
  const lineHalf = unit.lineThick / 2 + 1;
  const onLine = (y: number) => lineYs.some((ly) => Math.abs(ly - y) <= lineHalf);
  const ink = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] === 1;
  /** 从 y0 起沿 dir 走，返回走到的最远一行（谱线行上断了也接着走）。 */
  /** 这一行过 x 的横向墨宽。 */
  const runAt = (x: number, y: number): number => {
    let a = x;
    let b = x;
    while (ink(a - 1, y)) a--;
    while (ink(b + 1, y)) b++;
    return ink(x, y) ? b - a + 1 : 0;
  };
  const walk = (x: number, y0: number, dir: number): number => {
    let last = y0 - dir;
    for (let y = y0; y >= 0 && y < h; y += dir) {
      if (ink(x, y)) last = y;
      else if (!onLine(y)) {
        // 干尖与头之间常断一两行（破碎扫描版 p7 十六分 E4 差 3px）：三行内接上的是头那么宽的墨，就续进去
        let k = 1;
        while (k <= 3 && !ink(x, y + dir * k)) k++;
        if (k > 3 || runAt(x, y + dir * k) < sp * 0.8) break;
        y += dir * (k - 1);
      }
    }
    return last;
  };
  const out: LineSeg[] = [];
  for (const q of beams) {
    // 只找已挂着竖段的杠：真杠总有别的干抽得出来；一根都没挂的多是粗体四分休止的斜笔（主我敬拜你 m8）
    const hung = vSegs.some((v) => {
      const vx = (v.x0 + v.x1) / 2;
      return vx >= q.box.x - 2 && vx <= q.box.x + q.box.w + 2 && Math.min(v.y0, v.y1) <= q.box.y + q.box.h + 2 && Math.max(v.y0, v.y1) >= q.box.y - 2;
    });
    if (!hung) continue;
    // 两端各放 0.3 格：杠的中心线拟合常收不到端头那根干
    const x0 = Math.ceil(Math.min(q.x0, q.x1, q.box.x) - sp * 0.3);
    const x1 = Math.floor(Math.max(q.x0, q.x1, q.box.x + q.box.w) + sp * 0.3);
    for (const dir of [1, -1]) {
      let run: { x: number; end: number }[] = [];
      const flush = () => {
        if (!run.length) return;
        const wd = run.length;
        const xs = run.map((r) => r.x);
        const cx = (xs[0] + xs[xs.length - 1]) / 2;
        run.sort((a, b) => (b.end - a.end) * dir);
        const end = run[Math.min(run.length - 1, 1)].end;
        run = [];
        if (wd > thin) return;
        const t = x0 === x1 ? 0 : (cx - q.x0) / (q.x1 - q.x0 || 1);
        const yc = q.y0 + (q.y1 - q.y0) * t;
        const start = Math.round(yc - (dir * q.lw) / 2);
        if (vSegs.some((v) => Math.abs((v.x0 + v.x1) / 2 - cx) <= sp * 0.5 && Math.min(v.y0, v.y1) <= Math.max(start, end) && Math.max(v.y0, v.y1) >= Math.min(start, end))) return;
        if (out.some((v) => Math.abs(v.x0 - cx) <= sp * 0.5)) return;
        out.push({ x0: cx, y0: Math.min(start, end), x1: cx, y1: Math.max(start, end), lw: wd, maxLw: wd });
      };
      for (let x = x0; x <= x1; x++) {
        const t = x0 === x1 ? 0 : (x - q.x0) / (q.x1 - q.x0 || 1);
        const yc = q.y0 + (q.y1 - q.y0) * t;
        const edge = Math.round(yc + (dir * (q.lw / 2 + 1)));
        const end = walk(x, edge, dir);
        if ((end - edge) * dir >= sp * BEAM_STEM_MIN) run.push({ x, end });
        else flush();
      }
      flush();
    }
  }
  return out;
}

/** 挂杠的干多长以内（格）算一根干：再长是两个声部共用一根贯穿的干，两头都可以有杠。 */
const ONE_STEM_MAX = 4.5;

/**
 * **挂在干的另一头、比那头的杠短的「杠」是连成一条的符头**：扫描件上一组连桁里相邻的两个实心头
 * 斜着粘成一条（破碎扫描版 p3 两个十六分头连成 2.5×0.6 格），过得了宽度、长宽比和杠厚匀那几道，
 * 被当成一层杠抹掉，头跟着没了。一根干只有一头能挂杠：这「杠」碰到的每根干（不到 `ONE_STEM_MAX` 格）
 * 另一头都挂着别的杠、且那条杠比它长，就不是杠，退给拆头那一路。
 */
function dropHeadEndBeams(beams: BeamQuad[], vSegs: LineSeg[], unit: RasterUnit): void {
  const tol = unit.lineThick + 2;
  const inBox = (x: number, y: number, b: Rect) => x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
  const drop = new Set<BeamQuad>();
  for (const q of beams) {
    let touched = 0;
    let fake = true;
    for (const v of vSegs) {
      const vx = (v.x0 + v.x1) / 2;
      const top = Math.min(v.y0, v.y1);
      const bot = Math.max(v.y0, v.y1);
      const atTop = inBox(vx, top, q.box);
      const atBot = inBox(vx, bot, q.box);
      if (atTop === atBot) continue;
      touched++;
      if (bot - top > unit.space * ONE_STEM_MAX) { fake = false; break; }
      const far = atTop ? bot : top;
      // 那一头挂的常是半截杠：比的是那一摞（横向重叠、上下 1.5 格内的几层）里最长的一条
      const at = beams.filter((o) => o !== q && inBox(vx, far, o.box));
      const stack = beams.filter((o) => o !== q && at.some((a) => o.box.x < a.box.x + a.box.w && a.box.x < o.box.x + o.box.w && Math.abs(o.box.y - a.box.y) <= unit.space * 1.5));
      if (!stack.some((o) => o.box.w > q.box.w)) { fake = false; break; }
    }
    if (touched && fake) drop.add(q);
  }
  for (let i = beams.length - 1; i >= 0; i--) if (drop.has(beams[i])) beams.splice(i, 1);
}

/** 修补图：压线处的笔画认作「存疑」补回时，看左右多远（格）有没有挨着线带的墨。 */
const REPAIR_REACH = 0.75;
/** 斜穿过线的笔画，线上、线下挨着的墨纵向厚不过这么多（格）：再厚是符头、干。 */
const REPAIR_THIN = 0.4;
/** 拱顶压线、剩两条腿时两腿之间的缝上限（格）。 */
const REPAIR_CAP = 1.5;
/** 缝宽过这么多格时另一侧也要空（破碎 p4 m30–31 女高两条小弧，拱顶压在第一线上，两腿相隔 1.17 格）。 */
const REPAIR_CAP_NARROW = 1;

/**
 * **修补图**：去线图上把「存疑」的线带像素补回去，给按形状认的那几路用（弧线候选）；认干、认杠照旧用去线图。
 *
 * 去线逐列判：线带上下紧挨着有墨才留。弧、松叶贴着线斜穿时，中间那几列整段落在线带里、上下都不连墨，被当线抹掉，
 * 笔画断成几截（宁静的伯利恒、破碎的小弧一排排断在线上）。原图上那几列的线带比本线厚：
 * - 线带竖向墨厚比本线实测线宽厚出一像素以上，且左右 `REPAIR_REACH` 格内线带紧上方或紧下方有墨（有东西压着线、从这里进出）；
 * - 或者线带上方挨着的一截细笔与下方挨着的一截（纵向都不过 `REPAIR_THIN` 格）横向相隔不过 `REPAIR_REACH` 格，补两截之间那道缝（斜穿，线带没加厚也接上）。
 * 反过来，线带只有本线厚、又不是穿线段的那几列在这张图上清掉：去线时因为上下挨着墨留下的谱线残段，粘在弧身上就不拱了。
 * 这两种列上原图有墨的线带像素补回。和谱线完全重合、一点没加厚的笔画（平躺在线上的延音线、还原号横笔）补不回来。
 */
export function repairLineCuts(bin: Binary, nl: Binary, lineYs: number[], unit: RasterUnit): Binary {
  const { w, h, data } = bin;
  const out: Binary = { w, h, data: new Uint8Array(nl.data) };
  const runs = vRuns(bin);
  const nlRuns = vRuns(nl);
  const half = unit.lineThick / 2 + 1;
  const look = Math.max(1, Math.round(unit.lineThick));
  const lineT = Math.max(unit.lineThick, measuredLineThick(bin, runs, lineYs, unit));
  const reach = Math.max(2, Math.round(unit.space * REPAIR_REACH));
  const thinMax = unit.space * REPAIR_THIN;
  for (const cy of lineYs) {
    const centers = localLineCenters(bin, runs, cy, unit);
    const band = (x: number): [number, number] => [Math.max(0, Math.floor(centers[x] - half)), Math.min(h - 1, Math.ceil(centers[x] + half))];
    // 逐列：线带紧上方 / 紧下方挨着的去线图墨（细的才算，-1 = 没有或太粗）、线带是否加厚
    const above = new Int8Array(w), below = new Int8Array(w), thick = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      const [y0, y1] = band(x);
      let t = 0;
      for (let y = y0; y <= y1; y++) t = Math.max(t, runs[y * w + x]);
      if (t >= lineT + 1 && t <= unit.space * 0.8) thick[x] = 1;
      for (let y = Math.max(0, y0 - look); y < y0; y++) if (nl.data[y * w + x]) above[x] = nlRuns[y * w + x] <= thinMax ? 1 : 2;
      for (let y = y1 + 1; y <= Math.min(h - 1, y1 + look); y++) if (nl.data[y * w + x]) below[x] = nlRuns[y * w + x] <= thinMax ? 1 : 2;
    }
    // 穿线段：线上挨着的一段细墨 [a0,a1] 与线下挨着的一段 [b0,b1] 横向相隔不过 `reach`，二者之间的缝（相接时取接头那两列）
    const ivals = (m: Int8Array): [number, number][] => {
      const out2: [number, number][] = [];
      for (let x = 0; x < w; x++) {
        if (m[x] !== 1) continue;
        let e = x;
        while (e + 1 < w && m[e + 1] === 1) e++;
        out2.push([x, e]);
        x = e;
      }
      return out2;
    };
    const ups = ivals(above), dns = ivals(below);
    const cross = new Uint8Array(w);
    for (const [a0, a1] of ups)
      for (const [b0, b1] of dns) {
        // 一左一右：缝 [左段末, 右段首]
        const [l1, r0] = a1 < b0 ? [a1, b0] : b1 < a0 ? [b1, a0] : [Math.max(a0, b0), Math.min(a1, b1)];
        if (r0 - l1 > reach) continue;
        for (let x = Math.min(l1, r0); x <= Math.max(l1, r0); x++) cross[x] = 1;
      }
    // 拱顶（拱底）压在线上、只剩两条腿：同一侧挨着线的两截细墨相隔不过 `REPAIR_CAP` 格，缝补上（破碎扫描版 p1 m2 C5–B4 上方那条）。
    // 拱顶那几列与谱线重合、线带一点没加厚，前两条都补不着
    const capGap = Math.round(unit.space * REPAIR_CAP);
    const capGapNarrow = Math.round(unit.space * REPAIR_CAP_NARROW);
    // 缝那一侧 0.6 格内过半的列得是空的：弧身拱在缝上方（坐在线上的延音线，望十架 p4 m33 低音 D3）的补了就和线围成一圈；
    // 拱顶压线的，缝下只有几点拱顶残墨（破碎扫描版 p1 m2）
    const clear = Math.round(unit.space * 0.6);
    const emptySide = (x0: number, x1: number, up: boolean) => {
      let inked = 0;
      for (let x = x0; x <= x1; x++) {
        const [y0, y1] = band(x);
        for (let k = 1; k <= clear; k++) {
          const y = up ? y0 - k : y1 + k;
          if (y >= 0 && y < h && nl.data[y * w + x]) {
            inked++;
            break;
          }
        }
      }
      return inked <= (x1 - x0 + 1) * 0.5;
    };
    for (const [side, up] of [[ups, true], [dns, false]] as const)
      for (let i = 0; i + 1 < side.length; i++) {
        const g0 = side[i][1], g1 = side[i + 1][0];
        if (g1 - g0 <= 1 || g1 - g0 > capGap || !emptySide(g0 + 1, g1 - 1, up)) continue;
        // 缝宽过一格的，线另一侧正对着缝的地方也得空：拱顶压线的弧另一侧是空的谱间；两条腿接着穿过线、在另一侧收成碗底的是别的字形
        //（主我敬拜你 U 形小记号，两腿在线上、碗底在线下）
        if (g1 - g0 > capGapNarrow && !emptySide(g0 + 1, g1 - 1, !up)) continue;
        for (let x = g0; x <= g1; x++) cross[x] = 1;
      }
    const near = new Int32Array(w + 1);
    for (let x = 0; x < w; x++) near[x + 1] = near[x] + (above[x] || below[x] ? 1 : 0);
    const nearInk = (x: number) => near[Math.min(w, x + reach + 1)] - near[Math.max(0, x - reach)] > 0;
    for (let x = 0; x < w; x++) {
      const [y0, y1] = band(x);
      let t = 0;
      for (let y = y0; y <= y1; y++) t = Math.max(t, runs[y * w + x]);
      // 线带只有本线那么厚、又不是穿线段：去线时因为上下挨着墨留下的一截谱线（弧身贴着线走，破碎 p2 m2），这张图上清掉
      if (t > 0 && t <= lineT && !cross[x]) {
        for (let y = y0; y <= y1; y++) out.data[y * w + x] = 0;
        continue;
      }
      if (!(cross[x] || (thick[x] && nearInk(x)))) continue;
      for (let y = y0; y <= y1; y++) if (data[y * w + x]) out.data[y * w + x] = 1;
    }
  }
  return out;
}

/** 两端各连着干的短杠：宽度下限（格）。 */
const SHORT_BEAM_W = 0.9;
/** 同上：两根干之间逐列墨厚的中位数（格）。杠约半格厚；比这薄的是连线、谱线残段，比这厚的是挨着两根干的实心头。 */
const SHORT_BEAM_THICK = [0.4, 0.6] as const;
/** `thinOnly`：这几条线只抹竖游程不过 `THIN_ONLY_RUN` 个线宽的列（见 `recognize.ts` 调用处）。 */
export function removeStaffLines(bin: Binary, lineYs: number[], unit: RasterUnit, thinOnly: Set<number> = new Set()): Binary {
  const { w, h, data } = bin;
  const out: Binary = { w, h, data: new Uint8Array(data) };
  const half = unit.lineThick / 2 + 1;
  // 往外看多远算「紧邻」：一个线宽足矣。看太远会把间距里的符头也算成「连着」，
  // 谱线就抹不掉了。
  const look = Math.max(1, Math.round(unit.lineThick));
  const runs = vRuns(bin);
  const maxRun = unit.lineThick * THIN_ONLY_RUN;
  // **比一根线厚得多、又横着连成一段的不抹**：压在谱线上的薄符杠，杠连线整段落在线带里、上下又不连墨，照「上下没墨」抹就连杠一起没了
  //（望十架 p7 长笛一串八分的杠贴着第四线，原图 5~6 像素、线 3 像素；钢琴右手贴第五线的两条杠同样，二十来个八分读成四分）。
  // 厚度下限与符杠同口径（`findPrimitives` 的 `bLo`），线宽取本页谱线实测的九成分位：估值常比实际薄一像素
  //（望十架 p6 估 2、实有 3），只按估值卡，厚一点的那几段空谱线也会留下来
  const lineT = Math.max(unit.lineThick, measuredLineThick(bin, runs, lineYs, unit));
  const keepRun = Math.max(unit.space * 0.25, lineT * 1.5);
  for (const cy of lineYs) {
    const centers = localLineCenters(bin, runs, cy, unit);
    const thin = thinOnly.has(cy);
    // 这条线上逐列的「厚」：线带里的竖游程过 `keepRun`、又不到 0.8 格（再厚是符头、干，上下本来就连着墨）。
    // 只留**横向连着一格半以上都厚**的那几段（杠那么长）：升降号、符头压线的那一小截不够长，照旧抹
    const thickCol = new Uint8Array(w);
    const tAt = new Uint16Array(w);
    for (let x = 0; x < w; x++) {
      const y0 = Math.max(0, Math.floor(centers[x] - half));
      const y1 = Math.min(h - 1, Math.ceil(centers[x] + half));
      let t = 0;
      for (let y = y0; y <= y1; y++) t = Math.max(t, runs[y * w + x]);
      tAt[x] = t;
      if (t >= keepRun && t <= unit.space * 0.8) thickCol[x] = 1;
    }
    /** 这一段比**同一条线两旁**（各四格、不算厚列）的中位厚度厚出两像素以上：低清放大的扫描件谱线本身就有一段段糊厚的（齐来谢主歌），两旁一样厚 */
    const thickerThanSides = (xa: number, xb: number) => {
      const side: number[] = [];
      for (const [p0, p1] of [[xa - unit.space * 4, xa - 1], [xb + 1, xb + unit.space * 4]])
        for (let x = Math.max(0, Math.round(p0)); x <= Math.min(w - 1, Math.round(p1)); x++) if (!thickCol[x] && tAt[x] > 0) side.push(tAt[x]);
      if (!side.length) return false;
      side.sort((p, q) => p - q);
      const mid: number[] = [];
      for (let x = xa; x <= xb; x++) mid.push(tAt[x]);
      mid.sort((p, q) => p - q);
      return mid[mid.length >> 1] >= side[side.length >> 1] + 2;
    };
    const keep = new Uint8Array(w);
    for (let x = 0; x < w; ) {
      if (!thickCol[x]) {
        x++;
        continue;
      }
      let x2 = x;
      while (x2 + 1 < w && thickCol[x2 + 1]) x2++;
      if (x2 - x + 1 >= unit.space * 1.5 && thickerThanSides(x, x2)) keep.fill(1, x, x2 + 1);
      x = x2 + 1;
    }
    for (let x = 0; x < w; x++) {
      const y0 = Math.max(0, Math.floor(centers[x] - half));
      const y1 = Math.min(h - 1, Math.ceil(centers[x] + half));
      if (thin) {
        let run = 0;
        for (let y = y0; y <= y1; y++) run = Math.max(run, runs[y * w + x]);
        if (run > maxRun) continue;
      }
      if (keep[x]) continue;
      let up = 0;
      for (let y = Math.max(0, y0 - look); y < y0; y++) up |= data[y * w + x];
      if (up) continue;
      let down = 0;
      for (let y = y1 + 1; y <= Math.min(h - 1, y1 + look); y++) down |= data[y * w + x];
      if (down) continue;
      for (let y = y0; y <= y1; y++) out.data[y * w + x] = 0;
    }
  }
  return out;
}

/**
 * 符号块：去掉谱线、竖笔画、符杠、横段之后剩下的连通块。
 *
 * 剩下的就是**要查字典的那些**：符头、谱号、调号、拍号数字、休止符、
 * 升降号、附点、演奏法记号、力度字母、歌词字。
 *
 * 为什么先减笔画再连通：符头与符干是连着的，符干又骑在谱线上，
 * 不减的话半页连成一块。减完之后符头是个孤立的椭圆，谱号是个孤立的字形。
 *
 * 减的时候要**按线宽外扩一点**（`lw / 2 + 1`）：中心线是拟合出来的，
 * 直接照中心线抹只抹掉一像素宽，笔画的两侧还留着，连通关系照旧。
 */
export function findBlobs(bin: Binary, prims: RasterPrims, unit: RasterUnit, onGrid?: (y: number) => boolean): Component[] {
  const rest = blobImage(bin, prims, unit, onGrid);
  // 宽高**分别**设限，不能共用一个数：高音谱号窄而高，实测 2.8 × **7.5** 个线距
  //（连着尾巴那一圈），共用「六个线距」的上限会把整页的谱号挡在外面
  // ——`bootstrapClefs` 因此在宁静一首上一个高音谱号都取不到。
  // 花括号（18×283px = 1 × 15.6 格）与页边框仍然被高度那一档挡住，
  // 另由 `findBraces` 收（`StaffToken` 要靠它分开人声行与钢琴行）。
  const minSide = unit.space * 0.25;
  const maxW = unit.space * 6;
  const maxH = unit.space * 9;
  return connectedComponents(rest, Math.round(minSide * minSide)).filter((c) => {
    const b = c.bbox;
    if (b.w > maxW || b.h > maxH) return false;
    if (b.w < minSide && b.h < minSide) return false;
    return true;
  });
}

/**
 * **花括号 / 系统括号**：页面左端那个又高又窄的东西。
 *
 * `StaffToken`（`score.ts`）靠 `topOfBrace`/`bottomOfBrace` 分开「钢琴的上下两行」
 * 与「人声行」——不认花括号的话，同一个系统里所有 G 谱号行的签名完全相同，
 * `buildScore` 的 LCS 只能靠顺序分；系统行数一变（这本合唱谱从 2 行长到 7 行）
 * 就会把声部接错，一个声部碎成好几条。
 *
 * 判据：
 *   - 在**所有谱行左缘之左**（系统线正在左缘上，不算）；
 *   - 高度至少一个半谱表高（只盖住一行的不构成「把两行括起来」）；
 *   - 宽度不到两个线距（再宽的是别的东西）。
 */
export function findBraces(
  bin: Binary,
  prims: RasterPrims,
  unit: RasterUnit,
  staffLefts: number[],
  /** 各谱行的纵向范围。**只留恰好罩住两行的**，见下。 */
  staffSpans: { top: number; bottom: number }[] = [],
): Component[] {
  if (!staffLefts.length) return [];
  const rest = blobImage(bin, prims, unit);
  const leftMost = Math.min(...staffLefts);
  const staffH = unit.space * 4;
  return connectedComponents(rest, Math.round(unit.space * unit.space * 0.5)).filter((c) => {
    const b = c.bbox;
    if (b.x + b.w > leftMost) return false;
    if (b.h < staffH * 1.5) return false;
    if (b.w > unit.space * 2) return false;
    // **只留恰好罩住两行谱的**。页面左端还有一个把整个系统括起来的大括号，
    // 收进来的话这个系统里每一行都「在括号里」，`topOfBrace`/`bottomOfBrace`
    // 就分不开人声行与钢琴行了（实测破碎 p7 五行谱全被标成在括号里）。
    // 钢琴大谱表的花括号恰好罩两行——那正是这两个字段的本意。
    if (staffSpans.length) {
      const n = staffSpans.filter((s) => s.top < b.y + b.h && b.y < s.bottom).length;
      if (n !== 2) return false;
    }
    return true;
  });
}

/**
 * **按左端系统线的墨分系统**：两行谱之间，左端那条竖线连着，就是同一个系统。
 *
 * 为什么不按连通块（`findSystemBrackets` 那条路）：括号会碎。方括号的粗竖笔、
 * 上下衬线、细系统线连成一块又太宽（过不了竖笔画的宽度闸），拆开又各只罩两行
 * ——实测望十架一份 99 行谱按连通块分出 49 个系统，正确是 25 个上下。
 * 而**墨连不连着**这件事本身不受碎块影响：直接在两行谱之间的缝里逐行数
 * 「左端那一小条窗口里有没有墨」，够九成就判连着。
 *
 * 窗口只开在谱行左缘那一小条（左边两格、右边半格）：歌词、力度记号都在更右边，
 * 进不来；页边框在更左边，也进不来。
 */
export function groupByLeftInk(
  bin: Binary,
  staves: { top: number; bottom: number; left: number }[],
  unit: RasterUnit,
): { x: number; y: number; w: number; h: number }[] {
  if (!staves.length) return [];
  const ss = [...staves].sort((a, b) => a.top - b.top);
  const groups: (typeof ss)[] = [[ss[0]]];
  for (let i = 1; i < ss.length; i++) {
    const a = ss[i - 1];
    const b = ss[i];
    const y0 = Math.round(a.bottom) + 1;
    const y1 = Math.round(b.top) - 1;
    const left = Math.min(a.left, b.left);
    const x0 = Math.max(0, Math.round(left - unit.space * LEFTINK_OUT));
    const x1 = Math.min(bin.w - 1, Math.round(left + unit.space * LEFTINK_IN));
    let rows = 0;
    let hit = 0;
    for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= bin.h) continue;
      rows++;
      for (let x = x0; x <= x1; x++)
        if (bin.data[y * bin.w + x]) {
          hit++;
          break;
        }
    }
    if (rows <= 0 || hit >= rows * LEFTINK_FRAC) groups[groups.length - 1].push(b);
    else groups.push([b]);
  }
  return groups
    .filter((g) => g.length >= 2)
    .map((g) => {
      const x = Math.min(...g.map((s) => s.left)) - unit.space * LEFTINK_OUT;
      return { x, y: g[0].top, w: unit.space * (LEFTINK_OUT + LEFTINK_IN), h: g[g.length - 1].bottom - g[0].top };
    });
}

/** 抹掉笔画之后剩下的墨——`findBlobs` 与 `findBraces` 都从它出发。
 *  **对外**：叠置空心和弦要在这张图上数孔（原图上符干会把内腔连出去）。 */
export function blobImage(bin: Binary, prims: RasterPrims, unit: RasterUnit, onGrid?: (y: number) => boolean): Binary {
  const { w, h } = bin;
  const rest = new Uint8Array(bin.data);
  const clear = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = Math.max(0, Math.round(y0)); y <= Math.min(h - 1, Math.round(y1)); y++)
      for (let x = Math.max(0, Math.round(x0)); x <= Math.min(w - 1, Math.round(x1)); x++) rest[y * w + x] = 0;
  };
  for (const s of [...prims.vSegs, ...prims.hSegs]) {
    // **短横段只抽不抹**：那是被符头切断的加线残段（见 `findPrimitives` 里的说明），
    // 它就压在符头边上，照抹会把符头啃掉一块——填充率与尺寸一变，
    // `findRasterHeads` 就认不出它了（实测这么抹音符从 28.5% 掉到 27.0%）。
    // 抽出来交给 `findLegers` 判「谱表外的音符有没有加线撑着」，别动像素。
    const horiz = Math.abs(s.x1 - s.x0) >= Math.abs(s.y1 - s.y0);
    const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
    if (horiz && len < unit.space) continue;
    // **落在加线网格上的短横段一律不抹**。加线就压在符头底下，长度约 1.6 格
    //（符头 1.2 格 + 两头各探出一点），比「一个线距」的老门槛长——照抹会把符头
    // **拦腰啃成两半**（实测破碎 p5 那个下加一线的音剩下 0.99×0.29 两片，判不成符头，
    // 而它的墨还都算「有主」，无主报表里看不见）。上限放到三格：再长的是别的横线。
    if (horiz && onGrid && len <= unit.space * 3 && onGrid((s.y0 + s.y1) / 2) && headOn(bin, s, unit)) continue;
    // **抹的宽度按平均厚度算，不按块的最大宽度。**
    // `maxLw` 是这一块的**包围盒宽**：笔画中途鼓出来一段（四分休止那个钩、
    // 谱号的弯），`maxLw` 就是那一段的宽度，照它抹等于把整个符号铲掉
    // ——实测破碎 p2 钢琴行那个四分休止，下半截被抽成一条 lw 3.1 / maxLw **11**
    // 的竖段，一抹连带把上半截也带走，整页四分休止只剩几个。
    // 取平均厚的两倍封顶：真符干、真小节线两者差不多，鼓包的那些才卡得住。
    const pad = Math.min(s.maxLw, Math.max(2, s.lw * PAD_LW)) / 2 + 1;
    // **连成一长条的加线按列抹**：一串同高的加线音（父恩广大低音谱表的 C4）的加线被连成一条（8 格长），
    // 头只占一小半、`headOn` 判否，整条照抹就把每个头都拦腰切成两片，头全丢了。
    // 逐列看：线外一侧 0.6 格内贴着墨（头）的列留着，其余照抹。独唱谱音符 93.93 → 94.13%（父恩广大 +2.4）。
    if (horiz && onGrid && len > unit.space * 3 && onGrid((s.y0 + s.y1) / 2)) {
      const reach = Math.max(2, Math.round(unit.space * 0.6));
      const x0 = Math.max(0, Math.round(Math.min(s.x0, s.x1)));
      const x1 = Math.min(w - 1, Math.round(Math.max(s.x0, s.x1)));
      for (let x = x0; x <= x1; x++) {
        const cy = s.y0 + ((s.y1 - s.y0) * (x - s.x0)) / (s.x1 - s.x0 || 1);
        const ya = Math.round(cy - pad);
        const yb = Math.round(cy + pad);
        let head = false;
        for (let d = 1; d <= reach && !head; d++) head = (ya - d >= 0 && bin.data[(ya - d) * w + x] !== 0) || (yb + d < h && bin.data[(yb + d) * w + x] !== 0);
        if (!head) clear(x, ya, x, yb);
      }
      continue;
    }
    // 段是直的（`adapt.ts` 会把它们摆正），照包围盒抹即可
    clear(Math.min(s.x0, s.x1) - pad, Math.min(s.y0, s.y1) - pad, Math.max(s.x0, s.x1) + pad, Math.max(s.y0, s.y1) + pad);
  }
  // **符杠只抹它自己那条带，不抹包围盒。**
  // 符杠是斜的、还常常两三条叠着，包围盒比它本身大得多——照盒抹会把**贴着符杠的符头
  // 一起抹掉**（实测宁静 p8 那段十六分连桁，一半的符头因此认不出来）。
  // 沿中心线逐列抹，厚度取这一块的平均厚（`lw`）再放一点余量。
  for (const b of prims.beams) {
    const x0 = Math.max(0, Math.round(Math.min(b.x0, b.x1)));
    const x1 = Math.min(w - 1, Math.round(Math.max(b.x0, b.x1)));
    const half = Math.max(1, b.lw / 2 + BEAM_PAD);
    const dx = b.x1 - b.x0;
    for (let x = x0; x <= x1; x++) {
      const t = Math.abs(dx) < 1e-6 ? 0 : (x - b.x0) / dx;
      const cy = b.y0 + (b.y1 - b.y0) * t;
      clear(x, cy - half, x, cy + half);
    }
  }
  return { w, h, data: rest };
}

/**
 * 这条短横段上**压着符头**吗——加线不抹的前提。
 *
 * 光看「落在加线网格上」不够：**歌词带也落在网格里**（谱表下六格以内），
 * 那里的横笔（「一」的笔画、破折号）会被一并留下混进字格
 * ——实测歌词从 85.0% 垮到 42.7%。加线有一条硬区别：它是给符头垫的，
 * 正上方或正下方紧挨着就是符头那团墨。
 */
function headOn(bin: Binary, s: LineSeg, unit: RasterUnit): boolean {
  const cy = Math.round((s.y0 + s.y1) / 2);
  const x0 = Math.round(Math.min(s.x0, s.x1));
  const x1 = Math.round(Math.max(s.x0, s.x1));
  const reach = Math.max(2, Math.round(unit.space * 0.6));
  let up = 0;
  let down = 0;
  let n = 0;
  for (let x = x0; x <= x1; x++) {
    if (x < 0 || x >= bin.w) continue;
    n++;
    for (let d = 2; d <= reach; d++)
      if (cy - d >= 0 && bin.data[(cy - d) * bin.w + x]) {
        up++;
        break;
      }
    for (let d = 2; d <= reach; d++)
      if (cy + d < bin.h && bin.data[(cy + d) * bin.w + x]) {
        down++;
        break;
      }
  }
  if (!n) return false;
  return up > n * 0.5 || down > n * 0.5;
}

/**
 * 位图块 → 32×32 形状签名。**与 `glyphdict.ts::shapeSig` 同一套归一**
 * （长边缩到 30、居中摆进 32×32），两边算出来的签名才比得了距离。
 *
 * **必须反向映射**：符头只有 23×18 px，缩到 30 px 是**放大**，
 * 正向遍历源像素时大半目标格一个源像素都摊不到，签名会变成棋盘格
 * （实测符头的签名一半是洞，聚类全散）。逐个目标格去源图取那一小片、
 * 按面积平均再过半，放大缩小都对。
 */
export function binSig(bin: Binary, box: Rect): Uint8Array {
  const sig = new Uint8Array(SIG_N * SIG_N);
  const sc = (SIG_N - 2) / Math.max(box.w, box.h);
  const ox = (SIG_N - box.w * sc) / 2;
  const oy = (SIG_N - box.h * sc) / 2;
  for (let sy = 0; sy < SIG_N; sy++) {
    // 这一格对应源图的 y 区间（反解 `y * sc + oy`）
    const y0 = (sy - oy) / sc;
    const y1 = (sy + 1 - oy) / sc;
    const ya = Math.max(0, Math.floor(y0));
    const yb = Math.min(box.h - 1, Math.ceil(y1) - 1);
    if (ya > yb) continue;
    for (let sx = 0; sx < SIG_N; sx++) {
      const x0 = (sx - ox) / sc;
      const x1 = (sx + 1 - ox) / sc;
      const xa = Math.max(0, Math.floor(x0));
      const xb = Math.min(box.w - 1, Math.ceil(x1) - 1);
      if (xa > xb) continue;
      let hit = 0;
      let tot = 0;
      for (let y = ya; y <= yb; y++) {
        const row = (box.y + y) * bin.w + box.x;
        for (let x = xa; x <= xb; x++) {
          tot++;
          hit += bin.data[row + x];
        }
      }
      if (tot > 0 && hit * 2 >= tot) sig[sy * SIG_N + sx] = 1;
    }
  }
  return sig;
}

/**
 * 盒里的**竖笔**：逐列取最长的竖直连续墨（容 `gap` 像素的断口），够 `minH` 高的相邻列并成一笔。
 * 返回每一笔的左右列、高度与上下端（像素）。在**带谱线的原图**上量：去线图里竖笔被当原语抽走了。
 */
export function verticalStrokes(bin: Binary, box: Rect, minH: number, gap = 2): { x0: number; x1: number; h: number; top: number; bottom: number }[] {
  const out: { x0: number; x1: number; h: number; top: number; bottom: number }[] = [];
  let cur: (typeof out)[number] | null = null;
  for (let x = box.x; x < box.x + box.w; x++) {
    let best = 0;
    let bestTop = 0;
    let st = -1;
    let miss = 0;
    for (let y = box.y; y < box.y + box.h; y++) {
      if (bin.data[y * bin.w + x]) {
        if (st < 0) st = y;
        miss = 0;
        if (y - st + 1 > best) (best = y - st + 1), (bestTop = st);
      } else if (st >= 0 && ++miss > gap) (st = -1), (miss = 0);
    }
    if (best >= minH) {
      if (cur && x - cur.x1 <= 1) (cur.x1 = x), (cur.h = Math.max(cur.h, best)), (cur.top = Math.min(cur.top, bestTop)), (cur.bottom = Math.max(cur.bottom, bestTop + best - 1));
      else out.push((cur = { x0: x, x1: x, h: best, top: bestTop, bottom: bestTop + best - 1 }));
    } else cur = null;
  }
  return out;
}

/**
 * **同一列上被符头隔断的竖段接回一根**。干穿过头的那几行横向墨宽、孤立性判不过，
 * 干就在头那里断开（《耶和华是我的牧者》低音谱表朝下的干穿过下面那个头：上段连着两个头、没有杠，
 * 下段挂着杠、头被上段占了，一整批八分和弦读成四分）。
 * 中心差不过 `dx`、断口不过 `gap` 像素、且断口里那一列（左右各容一像素）**每行都有墨**才接——
 * 墨是连着的，只是被头盖住了。接出来的段按两段长度加权取中心与线宽。
 */
export function joinVSegs(bin: Binary, segs: LineSeg[], dx: number, gap: number): LineSeg[] {
  const top = (v: LineSeg) => Math.min(v.y0, v.y1);
  const bot = (v: LineSeg) => Math.max(v.y0, v.y1);
  const cx = (v: LineSeg) => (v.x0 + v.x1) / 2;
  const vs = segs.filter((v) => bot(v) - top(v) > Math.abs(v.x1 - v.x0)).sort((a, b) => top(a) - top(b));
  const others = segs.filter((v) => !vs.includes(v));
  const out: LineSeg[] = [];
  const used = new Set<LineSeg>();
  for (const a of vs) {
    if (used.has(a)) continue;
    let cur = a;
    for (let again = true; again; ) {
      again = false;
      for (const b of vs) {
        if (b === cur || used.has(b) || b === a) continue;
        const g = top(b) - bot(cur);
        if (g < 0 || g > gap || Math.abs(cx(b) - cx(cur)) > dx) continue;
        const x = Math.round((cx(b) + cx(cur)) / 2);
        let solid = true;
        for (let y = Math.ceil(bot(cur)); y <= Math.floor(top(b)) && solid; y++) {
          const row = y * bin.w;
          solid = !!(bin.data[row + x] || bin.data[row + x - 1] || bin.data[row + x + 1]);
        }
        if (!solid) continue;
        const lwA = bot(cur) - top(cur);
        const lwB = bot(b) - top(b);
        cur = {
          x0: (cur.x0 * lwA + b.x0 * lwB) / (lwA + lwB),
          x1: (cur.x1 * lwA + b.x1 * lwB) / (lwA + lwB),
          y0: top(cur),
          y1: bot(b),
          lw: (cur.lw * lwA + b.lw * lwB) / (lwA + lwB),
          maxLw: Math.max(cur.maxLw, b.maxLw),
        };
        used.add(b);
        again = true;
      }
    }
    out.push(cur);
  }
  return [...out, ...others];
}
