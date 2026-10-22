// 弧线（圆滑线 / 连音线）：**又宽又扁、逐列一段墨、而且拱着**的那一团。
//
// 无主 contour 报表里最大的一类带外图形就是它（实测 6~15 格宽、1~3 格高、
// 团状度 0.03~0.07），而位图路至今一条都不认——GT 里宁静 283 条、破碎 326 条。
//
// 与松叶（`wedge.ts`）是同一批候选里分出来的两类，判据正好相反：
//   - 松叶：逐列**两段**墨（两条臂），或者一条臂——**直**的；
//   - 弧线：逐列**一段**墨，而且**拱**（离两端连线最远处超过 0.25 格）。
//
// 认出来之后交给矢量路现成的那一套（`staffomr/slur.ts`）：`attachSlurs` 挂两端、
// `reconnectSlurs` 接回跨行的、`markSlurNotes` 落到音符上，`toxml` 出 `<slur>`/`<tied>`
// ——那边一行不改，只是这边要造一个假 `PObj` 装着盒（与 `adapt.ts` 造假字形同一套路）。
import type { Binary, Rect } from "../omrkit/types";
import { PObj } from "../staffomr/model";
import type { SlurArc } from "../staffomr/slur";
import type { Contour, ContourMap } from "./contour";
import type { RasterUnit } from "./staffline";
import { meanFinite as mean } from "../omrkit/geom";
import { connectedComponents } from "../omrkit/ccl";

/** 形状闸（一律按线距）。 */
/** 宽度下限。扫过 2.0 / 1.4 / 1.2 / 1.0：圆滑线 37.6 / **39.4** / 39.4 / 39.4%
 *  （凭空多出 23 → 25），1.4 往下是平台，取过 1.4；只被谱线认过的块也进候选之后，两个八分之间的小弧 1.3 格（破碎 p2 m2），放到 1.2。 */
const MIN_W = 1.2;
const MAX_W = 110;
const MAX_H = 12;
/** 团状度上限：又宽又扁才有资格。 */
const MAX_COMPACT = 0.25;
/** 团状度超了、但逐列平均墨厚不过这么多（格）的也放进来：一格半宽的小弧盒子扁，团状度天然偏高（破碎 p2 m2 G4–F4 下方那条 0.26）。 */
const THIN_MEAN = 0.2;
/** 逐列一段墨的列要占多少——两段的是松叶。 */
const ONE_RUN_FRAC = 0.8;
/** **拱**：离两端连线最远处的下限（线距）。直的那些是松叶的臂、加线、连音线的一截。 */
const BOW_MIN = 0.25;
/** 弧线细：逐列的墨迹跨度不该超过这么多（线距）。跨度大的是松叶或实心块。 */
const SPREAD_MAX = 0.6;

/**
 * 从 contour 层里挑出弧。
 *
 * @param only 只看这些 contour（传账本里**无主**的那些）。
 * @param nextId 造假 `PObj` 用的起始 id（与页面里其它对象别撞号）。
 */
/** `forkWin`：拆分叉（`splitFork`）拆出来的那一截要整个落在这里（行首行尾的窗口）；不给就不拆 */
export function findRasterSlurs(
  map: ContourMap, unit: RasterUnit, only: Contour[], nextId: number, mask?: Binary, thinMean = THIN_MEAN,
  forkWin?: (r: Rect) => boolean,
): SlurArc[] {
  const out: SlurArc[] = [];
  for (const c of only) {
    if (c.w < MIN_W || c.w > MAX_W || c.h > MAX_H) continue;
    if (c.compact > MAX_COMPACT && c.area > c.bbox.w * unit.space * thinMean) continue;
    const ink = (x: number, y: number) => map.labels[y * map.w + x] === c.id && (!mask || mask.data[y * mask.w + x] === 1);
    const arc = judgeArcBox(c.bbox, ink, unit, nextId + out.length);
    if (!arc) continue;
    const two = forkWin ? splitFork(c.bbox, ink, unit, arc, nextId + out.length, forkWin) : null;
    if (two) out.push(...two);
    else out.push(arc);
  }
  return out;
}

// ── 同一个起点分出来的两条弧 ─────────────────────────────────────────────────
//
// 行首一条跨行延音线的后半截与一条圆滑线从同一处起笔（谱号调号之后），延音线短短一截收在第一个音底下，
// 圆滑线接着往后走，两条墨在起头那里是一块（破碎 p3 m17 钢琴右手：E4 延音线的后半截 + E4…F4 圆滑线），整块判成一条圆滑线，
// 延音线的半截就没了。一头有一段（不短于 `FORK_MIN` 格）逐列正好两段墨、靠音符那一段走到头断了，
// 就把那一段（连同它前面两条共用的起头）拆出来单判一条，剩下的是主弧；两条都过弧线那几道闸才拆。
// 只在行首行尾拆（拆出来的那截整个落在调用方给的窗口里）：行中间的圆滑线贴着歌词、符尾的地方也有两段墨（高举主大能 m2）

/** 分叉段至少多宽（格）。 */
const FORK_MIN = 1;
/** 分叉段离弧的一头不超过全宽的几成。 */
const FORK_EDGE = 0.4;
/** 拆出来的那一截的对象 id 偏移（只要不与同一批撞号）。 */
const SPLIT_ID = 100000;

function splitFork(b: Rect, ink: (x: number, y: number) => boolean, unit: RasterUnit, arc: SlurArc, id: number, win: (r: Rect) => boolean): SlurArc[] | null {
  const sp = unit.space;
  // 逐列墨段
  const runs: [number, number][][] = [];
  for (let x = b.x; x < b.x + b.w; x++) {
    const col: [number, number][] = [];
    let y0 = -1;
    for (let y = b.y; y <= b.y + b.h; y++) {
      const on = y < b.y + b.h && ink(x, y);
      if (on && y0 < 0) y0 = y;
      if (!on && y0 >= 0) col.push([y0, y - 1]), (y0 = -1);
    }
    runs.push(col);
  }
  const W = runs.length;
  // 两段墨的连续列，挨着弧的一头（左头或右头）
  const spans: [number, number][] = [];
  for (let i = 0; i < W; ) {
    if (runs[i]!.length !== 2) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < W && runs[j + 1]!.length === 2) j++;
    spans.push([i, j]);
    i = j + 1;
  }
  for (const [i0, i1] of spans) {
    if (i1 - i0 + 1 < sp * FORK_MIN) continue;
    const left = i1 < W * FORK_EDGE, right = i0 > W * (1 - FORK_EDGE);
    if (!left && !right) continue;
    // 靠音符那一段：弧在下方时是上面那段（y 小），弧在上方时是下面那段
    const inner = (col: [number, number][]) => (arc.above ? col[1]! : col[0]!);
    // 分叉段往弧中间那侧外面一列只剩一段墨：靠音符那条在那儿断了
    const past = left ? i1 + 1 : i0 - 1;
    if (past < 0 || past >= W || runs[past]!.length !== 1) continue;
    const branch = new Set<number>();
    for (let i = i0; i <= i1; i++) {
      const [y0, y1] = inner(runs[i]!);
      for (let y = y0; y <= y1; y++) branch.add(y * 100000 + b.x + i);
    }
    // 共用的起头（弧端到分叉段之间）两条都算
    const shared = left ? [0, i0 - 1] : [i1 + 1, W - 1];
    const sharedInk = (x: number, y: number) => x - b.x >= shared[0]! && x - b.x <= shared[1]! && ink(x, y);
    const bx0 = left ? b.x : b.x + i0, bx1 = left ? b.x + i1 : b.x + W - 1;
    if (!win({ x: bx0, y: b.y, w: bx1 - bx0 + 1, h: b.h })) continue;
    const twig = judgeArcBox(
      { x: bx0, y: b.y, w: bx1 - bx0 + 1, h: b.h },
      (x, y) => branch.has(y * 100000 + x) || sharedInk(x, y), unit, id + SPLIT_ID, STUB_BOW_MIN, STUB_ONE_RUN,
    );
    const main = judgeArcBox(b, (x, y) => ink(x, y) && !branch.has(y * 100000 + x), unit, id);
    if (!twig || !main || twig.above !== arc.above || main.above !== arc.above) continue;
    return [main, twig];
  }
  return null;
}

// ── 跨行弧的半截 ───────────────────────────────────────────────────────────
//
// 跨系统的延音线、圆滑线在下一行开头只画一小截（谱号调号之后、第一个音之前），上一行末尾同理：
// 只有一格来宽、拱得也浅（半条弧），过不了 `MIN_W` 与 `BOW_MIN`（破碎 p2 第三系统钢琴右手开头 A4 下方两截，1.17 / 1.23 格）。
// 只在行首行尾那段窗口里（调用方给）放宽这两道闸。

/** 半截弧的宽度下限、拱的下限（格）。行尾的延音线头只有半格多宽（破碎 p2 m16 钢琴右手 E4，0.64 格），下限 0.6 */
const STUB_MIN_W = 0.6;
const STUB_BOW_MIN = 0.08;
/** 半截弧逐列一段墨的占比下限：贴着谱线的那截去线后有几列断成两段（同上，下方那截压在第五线上）。 */
const STUB_ONE_RUN = 0.6;
/** 半截弧的平均厚度上限（格）：行尾那截延音线不到一格宽、贴着谱线，去线后剩的块又短又尖（破碎 p2 m16 钢琴右手 E4，0.64 格宽、平均厚 0.28 格），
 *  整条弧的 `THIN_MEAN` 卡得住它 */
const STUB_THIN_MEAN = 0.3;

export function findStubSlurs(map: ContourMap, unit: RasterUnit, only: Contour[], nextId: number, mask?: Binary): SlurArc[] {
  const out: SlurArc[] = [];
  for (const c of only) {
    if (c.w < STUB_MIN_W || c.w >= MIN_W * 2 || c.h > 1.5) continue;
    if (c.compact > MAX_COMPACT && c.area > c.bbox.w * unit.space * STUB_THIN_MEAN) continue;
    const arc = judgeArc(map, c, unit, nextId + out.length, mask, STUB_BOW_MIN, STUB_ONE_RUN);
    if (arc) out.push(arc);
  }
  return out;
}

/**
 * 几块拼成一条判：弧顶（弧底）贴着谱线走的那段连游程去线也去掉了，弧断成两截、各自不到 `MIN_W`（宁静 p8 m102、p4 m56 两个八分上下那条）。
 * 拼起来的盒照样过弧线那几道闸，中间空着的列不算。
 */
export function judgeArcUnion(map: ContourMap, parts: readonly Contour[], unit: RasterUnit, id: number): SlurArc | null {
  const ids = new Set(parts.map((c) => c.id));
  const x0 = Math.min(...parts.map((c) => c.bbox.x)), y0 = Math.min(...parts.map((c) => c.bbox.y));
  const x1 = Math.max(...parts.map((c) => c.bbox.x + c.bbox.w)), y1 = Math.max(...parts.map((c) => c.bbox.y + c.bbox.h));
  if (x1 - x0 < unit.space * MIN_W) return null;
  return judgeArcBox({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, (x, y) => ids.has(map.labels[y * map.w + x]!), unit, id);
}

/** `mask`：只认这张图上也有墨的像素（去线图上的块按修补图判：去线时留下的谱线残段在修补图上清掉了）。 */
function judgeArc(map: ContourMap, c: Contour, unit: RasterUnit, id: number, mask?: Binary, bowMin = BOW_MIN, oneRun = ONE_RUN_FRAC): SlurArc | null {
  return judgeArcBox(c.bbox, (x, y) => map.labels[y * map.w + x] === c.id && (!mask || mask.data[y * mask.w + x] === 1), unit, id, bowMin, oneRun);
}

function judgeArcBox(b: Rect, ink: (x: number, y: number) => boolean, unit: RasterUnit, id: number, bowMin = BOW_MIN, oneRun = ONE_RUN_FRAC): SlurArc | null {
  const ys: number[] = [];
  let one = 0;
  let cols = 0;
  let wide = 0;
  for (let x = b.x; x < b.x + b.w; x++) {
    let top = -1;
    let bot = -1;
    let runs = 0;
    let prev = false;
    let sum = 0;
    let n = 0;
    for (let y = b.y; y < b.y + b.h; y++) {
      const on = ink(x, y);
      if (on) {
        if (top < 0) top = y;
        bot = y;
        sum += y;
        n++;
        if (!prev) runs++;
      }
      prev = on;
    }
    if (n === 0) {
      ys.push(NaN);
      continue;
    }
    cols++;
    if (runs === 1) one++;
    if (bot - top > unit.space * SPREAD_MAX) wide++;
    ys.push(sum / n);
  }
  if (!cols || one < cols * oneRun) return null;
  if (wide > cols * 0.15) return null; // 跨度大的列太多：那是松叶或实心块
  // **两端的 y 只取最外那一小截**（三十分之一），不能取六分之一：
  // 弧的两头是尖的，往里取一段，端点的 y 会被拉向弧背，`validateSlurNote`
  // 的「在符头上方/下方三格以内」就判偏了。扫过 1/6、1/12、1/30、1/60、一列：
  // 圆滑线 34.0 / 36.6 / **37.6** / 37.6 / 37.8%——1/30 起是平台。
  const q = Math.max(1, Math.round(ys.length / 30));
  const ly = mean(ys.slice(0, q));
  const ry = mean(ys.slice(-q));
  if (Number.isNaN(ly) || Number.isNaN(ry)) return null;
  // 拱多少、往哪边拱：离两端连线最远的那一点（y 向下，负 = 拱在上方）
  const bow = chordBow(ys, ly, ry);
  if (Math.abs(bow) < unit.space * bowMin) return null; // 直的不是弧
  const box: Rect = { x: b.x, y: b.y, w: b.w, h: b.h };
  return {
    obj: fakeArcObj(id, box),
    lx: b.x,
    ly,
    rx: b.x + b.w - 1,
    ry,
    // `above` = 弧画在音符**上方**（开口向下）：中间比两端高，y 向下就是 bow < 0
    above: bow < 0,
    tie: false,
  };
}

// ── 粘在音符上的弧 ─────────────────────────────────────────────────────────
//
// 扫描件里弧两端常粘着符头、符干、符杠，整团墨归了音符那一组（望十架 p7 m54 女低两条），无主的候选里根本没有它。
// 在**有符头认领**的那团墨里抠掉粗的（逐列墨段高过 `THIN_RUN` 格：符头、符杠）、竖的（逐列墨段长过 `STEM_RUN` 格：符干、小节线）
// 和符头盒，剩下的细墨按八邻接分块，每块照样过弧线那几道闸，再加两道：更宽（`FUSED_MIN_W`）、更拱（`FUSED_BOW_MIN`）。

/** 逐列墨段高过这么多格的是粗笔（符头、符杠），抠掉。弧身两三个像素。 */
const THIN_RUN = 0.35;
/** 符头盒往外放这么多格一起抠掉（弧端贴着符头的那截）。 */
const HEAD_PAD = 0.2;
/** 粘连弧的宽度下限、拱的下限（格）：抠剩下的碎墨（符尾、字的笔画）比独立的弧多，闸收紧一档。 */
const FUSED_MIN_W = 2.5;
const FUSED_BOW_MIN = 0.35;
/** 粘在小节线上的弧的宽度下限（格）：跨小节线连两个八分的延音线只有两格多，左端去线时还常断掉一小截
 *（破碎 p2 m15–16 钢琴右手 G4）。只给修补图上的小节线那团用（调用方 `barOnly`）：那团墨里没有符尾、字的笔画，放宽不招碎墨 */
const FUSED_BAR_MIN_W = 1.5;
/** 竖笔抠掉后弧上补回的缝宽上限（格）：符干、小节线两三个像素。 */
const BRIDGE_GAP = 0.25;

/**
 * 从音符那组墨里抠出粘连的弧。`groups` 是要看的 contour（有符头认领、够宽的），`heads` 是全页符头盒。
 */
export function findFusedSlurs(
  map: ContourMap, unit: RasterUnit, groups: Contour[], heads: readonly Rect[], nextId: number,
  barOnly: (c: Contour) => boolean = () => false,
): SlurArc[] {
  const sp = unit.space;
  const out: SlurArc[] = [];
  for (const c of groups) {
    const b = c.bbox;
    const minW = sp * (barOnly(c) ? FUSED_BAR_MIN_W : FUSED_MIN_W);
    if (b.w < minW) continue;
    const keep = new Uint8Array(b.w * b.h);
    for (let x = 0; x < b.w; x++) {
      let y = 0;
      while (y < b.h) {
        if (map.labels[(b.y + y) * map.w + b.x + x] !== c.id) {
          y++;
          continue;
        }
        let e = y;
        while (e < b.h && map.labels[(b.y + e) * map.w + b.x + x] === c.id) e++;
        if (e - y <= sp * THIN_RUN) for (let k = y; k < e; k++) keep[k * b.w + x] = 1;
        y = e;
      }
    }
    // 弧穿过符干、小节线：竖笔抠掉后弧断成两截，中间一道窄缝（不过 `BRIDGE_GAP` 格）。同一行（上下一像素内）缝两边都有细墨、
    // 缝里原本是墨的，补回（破碎 p2 m15–16 钢琴右手 G4 延音线跨小节线，整条记在小节线账上）
    const gapMax = Math.max(2, Math.round(sp * BRIDGE_GAP));
    const kept = (x: number, y: number) => x >= 0 && x < b.w && y >= 0 && y < b.h && keep[y * b.w + x] === 1;
    const near = (x: number, y: number) => kept(x, y) || kept(x, y - 1) || kept(x, y + 1);
    const bridge: number[] = [];
    for (let y = 0; y < b.h; y++)
      for (let x = 1; x < b.w - 1; x++) {
        if (keep[y * b.w + x] || map.labels[(b.y + y) * map.w + b.x + x] !== c.id || !near(x - 1, y)) continue;
        let e = x;
        while (e < b.w && !keep[y * b.w + e] && map.labels[(b.y + y) * map.w + b.x + e] === c.id && e - x < gapMax) e++;
        if (e - x >= gapMax || !near(e, y)) continue;
        for (let k = x; k < e; k++) bridge.push(y * b.w + k);
      }
    for (const i of bridge) keep[i] = 1;
    const pad = sp * HEAD_PAD;
    for (const h of heads) {
      const x0 = Math.max(0, Math.floor(h.x - pad - b.x));
      const x1 = Math.min(b.w, Math.ceil(h.x + h.w + pad - b.x));
      const y0 = Math.max(0, Math.floor(h.y - pad - b.y));
      const y1 = Math.min(b.h, Math.ceil(h.y + h.h + pad - b.y));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) keep[y * b.w + x] = 0;
    }
    // 八邻接分块（`keep` 是 0/1）
    const lab = new Int32Array(b.w * b.h);
    for (const { id, bbox: bb, area } of connectedComponents({ w: b.w, h: b.h, data: keep }, 0, lab)) {
      const w = bb.w, h = bb.h;
      if (w < minW || h > sp * MAX_H || area > w * sp * THIN_RUN * 1.5) continue;
      const box: Rect = { x: b.x + bb.x, y: b.y + bb.y, w, h };
      const arc = judgeArcBox(box, (x, y) => lab[(y - b.y) * b.w + x - b.x] === id, unit, nextId + out.length);
      if (!arc) continue;
      const bow = Math.abs(arcBow(box, (x, y) => lab[(y - b.y) * b.w + x - b.x] === id));
      if (bow < sp * FUSED_BOW_MIN) continue;
      out.push(arc);
    }
  }
  return out;
}

/** 弧离两端连线最远处（像素，y 向下为正）。同 `judgeArcBox` 的量法，两端各取一列。 */
function arcBow(b: Rect, ink: (x: number, y: number) => boolean): number {
  const ys: number[] = [];
  for (let x = b.x; x < b.x + b.w; x++) {
    let s = 0, k = 0;
    for (let y = b.y; y < b.y + b.h; y++) if (ink(x, y)) (s += y), k++;
    if (k) ys.push(s / k);
  }
  if (ys.length < 2) return 0;
  return chordBow(ys, ys[0]!, ys[ys.length - 1]!);
}

/** 逐列墨心 `ys`（等距、NaN = 这列没墨）离两端连线（`ly` → `ry`）最远的那一点的偏差，带符号（y 向下，负 = 拱在上方）。 */
function chordBow(ys: readonly number[], ly: number, ry: number): number {
  let bow = 0;
  for (let i = 0; i < ys.length; i++) {
    if (Number.isNaN(ys[i])) continue;
    const t = ys.length > 1 ? i / (ys.length - 1) : 0;
    const d = ys[i]! - (ly + (ry - ly) * t);
    if (Math.abs(d) > Math.abs(bow)) bow = d;
  }
  return bow;
}

/** 造一个只带包围盒的假对象——`SlurArc.obj` 要一个 `PObj`，下游只用它的盒与标记。 */
function fakeArcObj(id: number, box: Rect): PObj {
  const o = new PObj(id, { id, kind: "path", bbox: box, fill: "#000", stroke: null, lineWidth: 0, path: [], clip: null, curves: 0 } as unknown as never, null);
  o.addTag("Slur");
  return o;
}

// ── 虚线弧 ─────────────────────────────────────────────────────────────────
//
// 诗歌本里第二段起唱法不同的那几处，圆滑线 / 连音线画成**虚线**（Holy, Holy, Holy 十二条）。
// 每一截只有 0.7×0.25 格，单看是噪点；成串看：一截截**等宽、等距、排成一线**的短横划。
// 两端那一截常粘在符头、符干上，认出来的只是中段——端点仍落在两个音符之间，`attachSlurs` 挂得上。

/** 一截短划的尺寸（格）：宽、高上限，宽高比下限。弧两头那截是斜的，8×5 像素（0.42 格高、宽高比 1.6）。 */
const DASH_W = [0.35, 1.0] as const;
const DASH_H = 0.5;
const DASH_ASPECT = 1.4;
/** 相邻两截的间隔（格）、竖向错开上限（格），宽度比上下限。 */
const DASH_GAP = [0.25, 0.9] as const;
const DASH_DY = 0.35;
const DASH_WR = [0.6, 1.6] as const;
/** 至少几截；各间隔之间最多差多少（格）。 */
const DASH_MIN = 3;
const DASH_GAP_SPREAD = 0.3;

/**
 * 从无主 contour 里串出虚线弧。`side(x0, x1, y)` 由调用方给：这一串近旁的符头在它下方返回 `"above"`
 *（弧画在音符上方）、在上方返回 `"below"`，近旁没有符头、或落在歌词带那种地方返回 `null`（不认）。
 */
export function findRasterDashedSlurs(
  only: Contour[],
  unit: RasterUnit,
  nextId: number,
  side: (x0: number, x1: number, y: number) => "above" | "below" | null,
): SlurArc[] {
  const sp = unit.space;
  const dashes = only
    .filter((c) => {
      const b = c.bbox;
      return b.w >= sp * DASH_W[0] && b.w <= sp * DASH_W[1] && b.h <= sp * DASH_H && b.w >= b.h * DASH_ASPECT;
    })
    .map((c) => c.bbox)
    .sort((a, b) => a.x - b.x);
  const used = new Set<Rect>();
  const out: SlurArc[] = [];
  for (const d0 of dashes) {
    if (used.has(d0)) continue;
    const chain = [d0];
    for (;;) {
      const cur = chain[chain.length - 1]!;
      const cy = cur.y + cur.h / 2;
      const next = dashes.find((d) => {
        if (used.has(d) || chain.includes(d)) return false;
        const gap = d.x - (cur.x + cur.w);
        const wr = d.w / cur.w;
        return gap >= sp * DASH_GAP[0] && gap <= sp * DASH_GAP[1] && Math.abs(d.y + d.h / 2 - cy) <= sp * DASH_DY && wr >= DASH_WR[0] && wr <= DASH_WR[1];
      });
      if (!next) break;
      chain.push(next);
    }
    if (chain.length < DASH_MIN) continue;
    const gaps = chain.slice(1).map((d, i) => d.x - (chain[i]!.x + chain[i]!.w));
    if (Math.max(...gaps) - Math.min(...gaps) > sp * DASH_GAP_SPREAD) continue;
    const first = chain[0]!;
    const last = chain[chain.length - 1]!;
    const ly = first.y + first.h / 2;
    const ry = last.y + last.h / 2;
    const midY = chain.reduce((a, d) => a + d.y + d.h / 2, 0) / chain.length;
    const where = side(first.x, last.x + last.w, midY);
    if (!where) continue;
    for (const d of chain) used.add(d);
    const x0 = first.x;
    const y0 = Math.min(...chain.map((d) => d.y));
    const box: Rect = { x: x0, y: y0, w: last.x + last.w - x0, h: Math.max(...chain.map((d) => d.y + d.h)) - y0 };
    out.push({ obj: fakeArcObj(nextId + out.length, box), lx: x0, ly, rx: last.x + last.w - 1, ry, above: where === "above", tie: false, dashed: true });
  }
  return out;
}


// ── 弧端接过谱线 ───────────────────────────────────────────────────────────
//
// 弧斜着穿过谱线，压在线上的那几列被去线抹掉，弧端那一截成了另一团碎墨（或干脆没了）：认出来的弧停在离音三四格处，
// `attachSlurs` 够不着（宁静的伯利恒 p2 m25 低音、钢琴那几条大弧）。从弧端顺着切线逐列往外走：
// 预计位置上下两像素内有墨就跟上，落在谱线行上没墨也照走（最多 `EXT_GAP` 格），过了线又接上墨，端点才延过去；
// 一路没跨过谱线的不延（贴着符头、符杠的墨跟过去会越走越远）。总长不过 `EXT_MAX` 格。
// 没跨线的端另走一种：细尾巴二值化后断成一串点（`dottedTail`），只跟细墨、断口小、碰上粗墨就停。

/** 跨谱线时允许连续没墨的列数（格）。 */
const EXT_GAP = 1.5;
/** 一端最多延长（格）。 */
const EXT_MAX = 3;
/** 越线途中找墨的垂直窗口（格）。 */
const EXT_CROSS_PERP = 0.3;
/** 越过谱线接上墨之后再跟多远（格）。 */
const EXT_AFTER = 1;
/** 断成点的细尾巴：点间断口上限、总长上限（格）。 */
const DOT_GAP = 0.3;
const DOT_MAX = 1.2;

export function extendArcEnds(arcs: SlurArc[], nl: Binary, onLine: (y: number, x?: number) => boolean, sp: number): void {
  const ink = (x: number, y: number) => x >= 0 && y >= 0 && x < nl.w && y < nl.h && nl.data[y * nl.w + x] === 1;
  /** 弧盒里某一列的墨心（离 y0 最近的那个墨点）。 */
  const colY = (x: number, y0: number, top: number, bot: number): number | null => {
    let best: number | null = null;
    for (let y = top; y <= bot; y++) if (ink(x, y) && (best === null || Math.abs(y - y0) < Math.abs(best - y0))) best = y;
    return best;
  };
  const vRun = (x: number, y: number) => {
    let a = y, b = y;
    while (ink(x, a - 1)) a--;
    while (ink(x, b + 1)) b++;
    return b - a + 1;
  };
  const lineAt = (y: number, x?: number) => onLine(Math.round(y), x) || onLine(Math.round(y) - 1, x) || onLine(Math.round(y) + 1, x);
  /** 弧的细尾巴二值化后断成一串点：顺切线往外走，垂直 ±2 像素内的细墨（竖向不过 `THIN_RUN` 格）都算，
   *  断口不过 `DOT_GAP` 格，总长不过 `DOT_MAX` 格；碰上粗墨（干、杠、头）就停。返回最后一粒点，走不出去返回 null */
  const dottedTail = (x0: number, y0: number, vx: number, vy: number): { x: number; y: number } | null => {
    let last: { x: number; y: number; t: number } | null = null;
    for (let t = 1; t <= sp * DOT_MAX; t++) {
      if (t - (last?.t ?? 0) > Math.max(3, sp * DOT_GAP)) break;
      const px = x0 + vx * t, py = y0 + vy * t;
      let hit: { x: number; y: number } | null = null;
      let thick = false;
      for (let d = 0; d <= 2 && !hit; d++)
        for (const sgn of d ? [-1, 1] : [1]) {
          const qx = Math.round(px - vy * d * sgn), qy = Math.round(py + vx * d * sgn);
          if (!ink(qx, qy)) continue;
          if (vRun(qx, qy) > sp * THIN_RUN) thick = true;
          else hit = { x: qx, y: qy };
          break;
        }
      if (thick && !hit) break;
      if (hit) last = { ...hit, t };
    }
    return last && last.t >= 2 ? { x: last.x, y: last.y } : null;
  };
  for (const sl of arcs) {
    const b = sl.obj.box;
    const k = Math.max(3, Math.round(sp * 0.6));
    for (const dir of [-1, 1] as const) {
      const x0 = Math.round(dir < 0 ? sl.lx : sl.rx);
      // 从端头那一列真实的墨点起步：`ly`/`ry` 是最外一小截的平均，斜着的弧尾比端点那列的墨高（低）两三像素，第一步就落空
      const y0 = colY(x0, dir < 0 ? sl.ly : sl.ry, Math.round(b.top), Math.round(b.bottom)) ?? (dir < 0 ? sl.ly : sl.ry);
      // 端头往里 k 列处的墨心定切线方向（单位向量，沿它逐像素走：竖着下去的那一截按列走跟不上）
      const yIn = colY(x0 - dir * k, y0, Math.round(b.top), Math.round(b.bottom));
      if (yIn === null) continue;
      let vx = dir * k, vy = y0 - yIn;
      let n = Math.hypot(vx, vy);
      vx /= n;
      vy /= n;
      const tvx = vx, tvy = vy;
      let x = x0, y = y0, gap = 0, crossed = false, after = 0;
      let end: { x: number; y: number } | null = null;
      for (let step = 0; step < sp * EXT_MAX; step++) {
        const px = x + vx, py = y + vy;
        // 垂直于走向 ±2 像素内找墨；越线途中放宽到 `EXT_CROSS_PERP` 格：平着斜进线的弧在线带里走一格来宽，
        // 出线时比进线前陡，照进线的切线走差出三四像素（宁静 p1 m2、m4 钢琴右手两条长弧的止端）
        const perp = gap > 0 && crossed ? Math.max(2, Math.round(sp * EXT_CROSS_PERP)) : 2;
        let hit: { x: number; y: number } | null = null;
        for (let d = 0; d <= perp && !hit; d++)
          for (const sgn of d ? [-1, 1] : [1]) {
            const qx = Math.round(px - vy * d * sgn), qy = Math.round(py + vx * d * sgn);
            // 越过线之后找到的墨要细（竖向不过 `THIN_RUN` 格）：碰上贴着的符头就跟过去了（我灵镇静 F4 延音线左端挂到前一个 E4）
            if (ink(qx, qy) && (!crossed || vRun(qx, qy) <= sp * THIN_RUN)) {
              hit = { x: qx, y: qy };
              break;
            }
          }
        if (hit) {
          if ((gap > 0 && crossed) || end) end = hit;
          // 越线接上之后最多再跟 `EXT_AFTER` 格：再往外多半是贴着的符头、符干（晨曦破晓 m5 跟过头挂到了前一个 D4）
          if (end && ++after > sp * EXT_AFTER) break;
          const ax = hit.x - x, ay = hit.y - y;
          const an = Math.hypot(ax, ay) || 1;
          vx = vx * 0.7 + (ax / an) * 0.3;
          vy = vy * 0.7 + (ay / an) * 0.3;
          n = Math.hypot(vx, vy);
          vx /= n;
          vy /= n;
          x = hit.x;
          y = hit.y;
          gap = 0;
          continue;
        }
        if (lineAt(py, px)) {
          x = px;
          y = py;
          gap++;
          crossed = true;
          if (gap > sp * EXT_GAP) break;
          continue;
        }
        break;
      }
      // 没跨线可延的端：顺着断成点的细尾巴走（破碎 p4 m30、p7 m71 钢琴右手一组十六分上方的弧，起端尾巴断成几粒点，认出的起点落到第二个音头上）
      if (!end) end = dottedTail(x0, y0, tvx, tvy);
      if (!end) continue;
      if (dir < 0) (sl.lx = end.x), (sl.ly = end.y);
      else (sl.rx = end.x), (sl.ry = end.y);
    }
  }
}

// ── 陡着收不住的弧端 ─────────────────────────────────────────────────────────
//
// 钢琴跨谱表的大弧从低音谱表陡着升上去、在高音谱表顶上拱过、落到右手和弦上（宁静的伯利恒 p1–p2 钢琴几乎每小节一条）。
// 去线后拱顶那段压着、擦着高音谱表的线，碎成短块认不成弧，只剩下截（陡的那段），右端停在半空，`attachSlurs` 就近挂到中途某个右手音上。
// 弧上方（∩）的右端还在陡升、左端还在陡降（弧下方反过来），说明弧在这儿没完：在**原图**上顺切线一步一像素往外追，
// 垂直于走向 `TRACE_PERP` 格内找离预计位置最近的一段墨：细的（不过 `TRACE_THICK` 格）跟上、修切线；粗的（擦过音头、符杠，
// 或平着贴在谱线上）照切线穿过去，连续不过 `TRACE_OCCLUDE` 格；没墨连续不过 `TRACE_MISS` 格。弯向要一路朝一侧弯
//（∩ 往右走斜率只增不减，回头超过 `TRACE_BEND` 就停：那是顺着符干上去了）。追出 `TRACE_MIN` 格以上才改端点；
// 追过的路上原先认出的别的截弧（拱顶那截有时认得出来）并掉。

/** 端头算「陡」的切线竖向分量下限（单位向量）。 */
const TRACE_STEEP = 0.6;
/** 收尾往回陡下的上限（单位向量竖向分量）。 */
const TRACE_STEEP_BACK = 0.85;
/** 垂直于走向找墨的半宽（格）。 */
const TRACE_PERP = 0.5;
/** 细墨段的长度上限（格，沿垂线量）。 */
const TRACE_THICK = 0.6;
/** 连续穿过粗墨的上限（格）。 */
const TRACE_OCCLUDE = 1.5;
/** 连续没墨的上限（格）。 */
const TRACE_MISS = 0.6;
/** 斜率回头的容差。 */
const TRACE_BEND = 0.8;
/** 线带里的墨竖向比线宽多出几像素才算弧。 */
const TRACE_ON_LINE = 2;
/** 追出多远才算数（格）。 */
const TRACE_MIN = 1.5;
/** 一端最多追多远（格）。 */
const TRACE_MAX = 30;

export function traceSteepArcEnds(arcs: SlurArc[], bin: Binary, onLine: (y: number, x?: number) => boolean, lineThick: number, sp: number): void {
  const raw = (x: number, y: number) => x >= 0 && y >= 0 && x < bin.w && y < bin.h && bin.data[y * bin.w + x] === 1;
  const vRun = (x: number, y: number) => {
    let a = y, b = y;
    while (raw(x, a - 1) && y - a < sp) a--;
    while (raw(x, b + 1) && b - y < sp) b++;
    return b - a + 1;
  };
  // 谱线行上的墨只在竖向比线粗（`TRACE_ON_LINE` 倍线宽）时算：斜穿谱线时线的那一小截也是细墨，跟上去就顺着线走了；
  // 弧顶贴在线上的那段（宁静 p2 m16 钢琴 A2→C5 拱顶压着高音谱表第二线）线加弧比线粗
  const ink = (x: number, y: number) => raw(x, y) && (!onLine(y, x) || vRun(x, y) >= lineThick + TRACE_ON_LINE);
  const W = Math.max(3, Math.round(sp * TRACE_PERP));
  for (const sl of [...arcs]) {
    if (!arcs.includes(sl) || sl.dashed) continue;
    const len = Math.hypot(sl.rx - sl.lx, sl.ry - sl.ly);
    if (len < sp * 1.5) continue;
    for (const dir of [-1, 1] as const) {
      // 起步切线取整截的弦（陡的那截近乎直）
      let vx = dir * (sl.rx - sl.lx), vy = dir * (sl.ry - sl.ly);
      const n0 = Math.hypot(vx, vy);
      vx /= n0;
      vy /= n0;
      // 往外（离开音符那侧）陡走：∩ 往上（vy<0）、∪ 往下
      const out = sl.above ? -vy : vy;
      if (out < TRACE_STEEP) continue;
      let x = dir < 0 ? sl.lx : sl.rx, y = dir < 0 ? sl.ly : sl.ry;
      // 起步切线按端头往里 `k` 列处的墨心（弦是整截的走向，端头那截常已拐平：拱顶前的那段）
      {
        const k = Math.max(3, Math.round(sp * 0.6)), bx = Math.round(x - dir * k), b = sl.obj.box;
        let yIn: number | null = null;
        for (let yy = Math.round(b.top); yy <= Math.round(b.bottom); yy++) if (ink(bx, yy) && (yIn === null || Math.abs(yy - y) < Math.abs(yIn - y))) yIn = yy;
        if (yIn !== null) {
          vx = dir * k;
          vy = y - yIn;
          const n1 = Math.hypot(vx, vy);
          vx /= n1;
          vy /= n1;
        }
      }
      /** 走向上的「弯度」：∩ 往右走 vy/vx 只增，往左走 vy/(-vx) 只增；∪ 反过来。统一成只增的量 */
      const bendOf = (ax: number, ay: number) => (sl.above ? 1 : -1) * (ay / Math.max(1e-3, Math.abs(ax)));
      let maxBend = -Infinity;
      let miss = 0, occl = 0, lineGap = 0, walked = 0;
      const sx = x, sy = y, lag = Math.max(3, Math.round(sp * 0.3));
      let last: { x: number; y: number; at: number } | null = null;
      const path: { x: number; y: number }[] = [];
      while (walked < sp * TRACE_MAX) {
        const px = x + vx, py = y + vy;
        walked++;
        // 垂线上的墨段
        const runs: { a: number; b: number }[] = [];
        let cur: { a: number; b: number } | null = null;
        for (let d = -W; d <= W; d++) {
          if (ink(Math.round(px - vy * d), Math.round(py + vx * d))) {
            if (cur && cur.b === d - 1) cur.b = d;
            else runs.push((cur = { a: d, b: d }));
          }
        }
        // 段要延到窗口边上的，量真长度（粗墨块常比窗口宽）
        const extent = (r: { a: number; b: number }) => {
          let a = r.a, b = r.b;
          if (a === -W) while (a > -sp && ink(Math.round(px - vy * (a - 1)), Math.round(py + vx * (a - 1)))) a--;
          if (b === W) while (b < sp && ink(Math.round(px - vy * (b + 1)), Math.round(py + vx * (b + 1)))) b++;
          return { a, b };
        };
        const near = runs.map(extent).sort((p, q) => Math.min(Math.abs(p.a), Math.abs(p.b), p.a <= 0 && p.b >= 0 ? 0 : 99) - Math.min(Math.abs(q.a), Math.abs(q.b), q.a <= 0 && q.b >= 0 ? 0 : 99))[0];
        if (!near) {
          // 落在谱线行上：照切线走过去（同 `extendArcEnds` 的 `EXT_GAP`）
          if (onLine(Math.round(py), px)) {
            if (++lineGap > sp * EXT_GAP) break;
            x = px;
            y = py;
            continue;
          }
          if (++miss > Math.max(2, sp * TRACE_MISS)) break;
          x = px;
          y = py;
          continue;
        }
        miss = 0;
        lineGap = 0;
        if (near.b - near.a + 1 > sp * TRACE_THICK) {
          if (++occl > sp * TRACE_OCCLUDE) break;
          x = px;
          y = py;
          continue;
        }
        occl = 0;
        const c = (near.a + near.b) / 2;
        const hx = px - vy * c, hy = py + vx * c;
        // 走向按几步之前那个墨点量（一步一像素，垂线上取中的半像素抖动会把单步方向甩到后头去）
        const back = path[path.length - lag] ?? { x: sx, y: sy };
        const ax = hx - back.x, ay = hy - back.y;
        const an = Math.hypot(ax, ay) || 1;
        let nvx = vx * 0.7 + (ax / an) * 0.3, nvy = vy * 0.7 + (ay / an) * 0.3;
        const nn = Math.hypot(nvx, nvy);
        nvx /= nn;
        nvy /= nn;
        // 往回（朝音符那侧）陡下去的是顺着符干、头的边走了：弧尾收得没这么陡
        if (Math.sign(nvx) !== dir || (sl.above ? nvy : -nvy) > TRACE_STEEP_BACK) break;
        // 弯度只在走出起步那一小段（`lag` 的两倍）之后才记：起步处端头墨心不准，切线左右晃
        const bend = bendOf(nvx, nvy);
        if (path.length > 2 * lag) {
          if (bend < maxBend - TRACE_BEND) break;
          maxBend = Math.max(maxBend, bend);
        } else maxBend = bend;
        vx = nvx;
        vy = nvy;
        x = hx;
        y = hy;
        last = { x: hx, y: hy, at: walked };
        path.push(last);
      }
      if (!last || last.at < sp * TRACE_MIN) continue;
      const b = sl.obj.box as { left: number; right: number; top: number; bottom: number };
      if (dir < 0) (sl.lx = Math.round(last.x)), (sl.ly = Math.round(last.y));
      else (sl.rx = Math.round(last.x)), (sl.ry = Math.round(last.y));
      for (const p of path) {
        b.left = Math.min(b.left, p.x);
        b.right = Math.max(b.right, p.x);
        b.top = Math.min(b.top, p.y);
        b.bottom = Math.max(b.bottom, p.y);
      }
      // 路上原先认出的别的截：两端都贴着追过的路（半格内）的并掉
      const onPath = (qx: number, qy: number) => path.some((p) => Math.hypot(p.x - qx, p.y - qy) <= sp * 0.5);
      for (let i = arcs.length - 1; i >= 0; i--) {
        const o = arcs[i];
        if (o !== sl && o.above === sl.above && !o.dashed && onPath(o.lx, o.ly) && onPath(o.rx, o.ry)) arcs.splice(i, 1);
      }
    }
  }
}

// ── 长弧末端的细尾 ─────────────────────────────────────────────────────────
//
// 长弧两头收成发丝细的尾巴，二值化后断成几截，过谱线那几列还被去线抹掉，认出的端点停在尾巴前头，挂到前一个音上
//（宁静 p1 m6–8 钢琴右手 A4 起的长弧，尾巴过第一线后画到 m8 F4 前，认出的右端停在 E4 上方）。
// 宽过 `TAIL_LONG` 格的弧，两端都在原图上顺切线往外追：垂直于走向 `TAIL_PERP` 格内找细墨（线行上的墨照 `traceSteepArcEnds` 的规矩），
// 碰上粗墨（过 `TAIL_THICK` 格，头、干、符杠）就停；断口容 `TAIL_GAP` 格，断着时按最近的转弯速度续着弯；最多追 `TAIL_MAX` 格。

/** 长弧的宽度下限（格）。 */
const TAIL_LONG = 3.5;
/** 找墨的半宽（格）；起步一格内的半宽。 */
const TAIL_PERP = 0.3;
const TAIL_PERP_START = 0.7;
/** 细墨的上限（格）。 */
const TAIL_THICK = 0.4;
/** 断口上限（格）。 */
const TAIL_GAP = 0.8;
/** 最多追多远、至少追出多远（格）。 */
const TAIL_MAX = 4;
const TAIL_MIN = 0.4;
/** 长延伸最多追多远、落点离另一行谱音头的上限（格）。 */
const TAIL_MAX_CROSS = 15;
const TAIL_CROSS_HEAD = 1.5;
/** 续尾连续穿过粗墨的上限（格）。 */
const TAIL_OCCLUDE = 1;
/** 端头离音头多近就不追、追到离音头多近就停（格）。 */
const TAIL_AT_HEAD = 0.4;
const TAIL_STOP_HEAD = 0.5;
/** 判像不像延音线时，弧端找最近音头的范围（格）。 */
const TAIL_TIE_NEAR = 1.5;

export function traceLongArcTails(arcs: SlurArc[], bin: Binary, onLine: (y: number, x?: number) => boolean, heads: readonly { left: number; right: number; top: number; bottom: number }[], staves: readonly { top: number; bottom: number }[], sp: number): void {
  const headDist = (x: number, y: number) => Math.min(Infinity, ...heads.map((h) => Math.hypot(Math.max(0, h.left - x, x - h.right), Math.max(0, h.top - y, y - h.bottom))));
  const raw = (x: number, y: number) => x >= 0 && y >= 0 && x < bin.w && y < bin.h && bin.data[y * bin.w + x] === 1;
  // 谱线行上的墨一概不用：尾巴斜着过线，线加弧那几列竖向一长条，会把走向拽成竖直往下；过线当断口照切线走过去
  const ink = (x: number, y: number) => raw(x, y) && !onLine(y, x);
  const staffAt = (y: number) => staves.findIndex((b) => y >= b.top - sp * 2 && y <= b.bottom + sp * 2);
  const W = Math.max(2, Math.round(sp * TAIL_PERP));
  const nearestHead = (x: number, y: number) => {
    let best: (typeof heads)[number] | undefined, bd = sp * TAIL_TIE_NEAR;
    for (const h of heads) {
      const d = Math.hypot(Math.max(0, h.left - x, x - h.right), Math.max(0, h.top - y, y - h.bottom));
      if (d <= bd) (bd = d), (best = h);
    }
    return best;
  };
  for (const sl of [...arcs]) {
    if (!arcs.includes(sl) || sl.dashed || sl.rx - sl.lx < sp * TAIL_LONG) continue;
    // 像延音线的不追：两端各自最近的音头同高（延音线两头同音高，是爱 p3 m37、p4 m47 长延音线追过了头）
    const hl = nearestHead(sl.lx, sl.ly), hr = nearestHead(sl.rx, sl.ry);
    if (hl && hr && hl !== hr && Math.abs((hl.top + hl.bottom) / 2 - (hr.top + hr.bottom) / 2) <= sp * 0.3) continue;
    for (const dir of [-1, 1] as const) {
      let x = dir < 0 ? sl.lx : sl.rx, y = dir < 0 ? sl.ly : sl.ry;
      // 端头已贴着音头的不追（长延音线两头本就挨着头，再追就越过头、挂不上了，是爱 p3 m37、p5 m65）
      if (headDist(x, y) <= sp * TAIL_AT_HEAD) continue;
      // 起步切线：端头往里 k 列处离端头最近的墨
      const k = Math.max(3, Math.round(sp * 0.6)), bx = Math.round(x - dir * k), b = sl.obj.box;
      let yIn: number | null = null;
      for (let yy = Math.round(b.top); yy <= Math.round(b.bottom); yy++) if (raw(bx, yy) && (yIn === null || Math.abs(yy - y) < Math.abs(yIn - y))) yIn = yy;
      if (yIn === null) continue;
      let ang = Math.atan2(y - yIn, dir * k), turn = 0;
      let miss = 0, walked = 0, occl = 0, crossed = false;
      /** 第一次穿粗墨前的落点（验收不过退回这里） */
      let preCross: { x: number; y: number; at: number } | null = null, preCrossPts = 0;
      let last: { x: number; y: number; at: number } | null = null;
      /** 追满 `TAIL_MAX` 格时的落点：往后的长延伸只有落到另一行谱的音头跟前才采用，否则退回这里 */
      let check: { x: number; y: number; at: number } | null | undefined;
      let checkPts = 0;
      const home = staffAt(y);
      // 不越过本行谱第一个音头左边、最后一个音头右边半格（行首行尾往外追会进谱号调号、行尾小节线；跨行的半截另有配对）
      const hb = home >= 0 ? heads.filter((h) => staffAt((h.top + h.bottom) / 2) === home) : [];
      const xLo = hb.length ? Math.min(...hb.map((h) => h.left)) - sp * 0.5 : -Infinity;
      const xHi = hb.length ? Math.max(...hb.map((h) => h.right)) + sp * 0.5 : Infinity;
      const pts: { x: number; y: number; ang: number }[] = [];
      while (walked < sp * TAIL_MAX_CROSS) {
        if (check === undefined && walked >= sp * TAIL_MAX) (check = last), (checkPts = pts.length);
        if (miss) ang += turn;
        const vx = Math.cos(ang), vy = Math.sin(ang);
        const px = x + vx, py = y + vy;
        walked++;
        // 粗细沿走向的垂线量（近竖的线按竖向游程量是一长条），线行的墨不算（垂线近水平时，斜穿谱线会顺着线量成一长条）
        const pRun = (d0: number) => {
          let a = d0, b = d0;
          while (b - a < sp && ink(Math.round(px - vy * (a - 1)), Math.round(py + vx * (a - 1)))) a--;
          while (b - a < sp && ink(Math.round(px - vy * (b + 1)), Math.round(py + vx * (b + 1)))) b++;
          return b - a + 1;
        };
        let best: number | null = null, thick = false;
        // 起步一格内窗口放宽：端头往里那段常已拐平，起步切线是平的，真弧在端头处陡着往下（宁静 p2 m22 钢琴跨谱表大弧上截的左端）
        const Wn = walked <= sp ? Math.max(W, Math.round(sp * TAIL_PERP_START)) : W;
        for (let d = 0; d <= Wn && best === null; d++)
          for (const sg of d ? [-1, 1] : [1]) {
            const qx = Math.round(px - vy * d * sg), qy = Math.round(py + vx * d * sg);
            if (!ink(qx, qy)) continue;
            if (pRun(d * sg) > sp * TAIL_THICK) thick = true;
            else best = d * sg;
            break;
          }
        if (best === null) {
          // 粗墨（擦过音头、符干）照切线穿过去，连续不过 `TAIL_OCCLUDE` 格；穿过粗墨的延伸要按长延伸验收
          if (thick) {
            if (++occl > sp * TAIL_OCCLUDE) break;
            if (!crossed) (preCross = last), (preCrossPts = pts.length);
            crossed = true;
            x = px;
            y = py;
            continue;
          }
          if (++miss > sp * TAIL_GAP) break;
          x = px;
          y = py;
          continue;
        }
        miss = 0;
        occl = 0;
        const hx = px - vy * best, hy = py + vx * best;
        if (staffAt(hy) === home && (hx < xLo || hx > xHi)) break;
        // 追到了音头跟前：尾巴到了它的音，停
        if (headDist(hx, hy) <= sp * TAIL_STOP_HEAD) break;
        const na = Math.atan2(hy - y, hx - x);
        // 方向慢慢跟，转弯速度按近几步量
        const a2 = ang + 0.3 * Math.atan2(Math.sin(na - ang), Math.cos(na - ang));
        pts.push({ x: hx, y: hy, ang: a2 });
        if (pts.length > 4) turn = (a2 - pts[pts.length - 5].ang) / 4;
        ang = a2;
        // 不许回头：横向掉过头来就是沿着弧自己往回爬了（宁静 p2 m22 下截左端追到 C3 又绕回右手谱表）
        if (Math.cos(ang) * dir < -0.2) break;
        x = hx;
        y = hy;
        last = { x: hx, y: hy, at: walked };
      }
      // 长延伸（跨谱表大弧近竖的下半截一路下到低音谱表）要落到另一行谱的音头跟前（`TAIL_CROSS_HEAD` 格内）才算，
      // 否则多半是追进了谱号调号、符杠，退回 `TAIL_MAX` 格时的落点
      if (last && ((check !== undefined && last.at > sp * TAIL_MAX) || crossed)) {
        const other = staffAt(last.y);
        const ok = other >= 0 && other !== home && headDist(last.x, last.y) <= sp * TAIL_CROSS_HEAD;
        if (!ok) {
          // 退回 4 格时的落点、第一次穿粗墨前的落点里较早的那个
          const useCross = crossed && (check === undefined || (preCross?.at ?? 0) <= (check?.at ?? Infinity));
          last = useCross ? preCross : check ?? null;
          pts.length = useCross ? preCrossPts : checkPts;
        }
      }
      if (!last || last.at < sp * TAIL_MIN) continue;
      const bb = sl.obj.box as { left: number; right: number; top: number; bottom: number };
      if (dir < 0) (sl.lx = Math.round(last.x)), (sl.ly = Math.round(last.y));
      else (sl.rx = Math.round(last.x)), (sl.ry = Math.round(last.y));
      for (const p of pts) {
        bb.left = Math.min(bb.left, p.x);
        bb.right = Math.max(bb.right, p.x);
        bb.top = Math.min(bb.top, p.y);
        bb.bottom = Math.max(bb.bottom, p.y);
      }
      // 追过的路上碰到另一截同向弧的近端（半格内）：同一条弧被切成的几截，并进来（宁静 p2 m22 钢琴跨谱表大弧：下截右端追上去越过了上截的左端，
      // 原先靠 `bridgeArcPieces` 并的就并不上了）
      const onPath = (qx: number, qy: number) => pts.some((p) => Math.hypot(p.x - qx, p.y - qy) <= sp * 0.5);
      for (let i = arcs.length - 1; i >= 0; i--) {
        const o = arcs[i];
        if (o === sl || o.above !== sl.above || o.dashed) continue;
        if (dir > 0 && onPath(o.lx, o.ly) && o.rx > sl.rx) {
          (sl.rx = o.rx), (sl.ry = o.ry);
        } else if (dir < 0 && onPath(o.rx, o.ry) && o.lx < sl.lx) {
          (sl.lx = o.lx), (sl.ly = o.ly);
        } else if (!(onPath(o.lx, o.ly) && onPath(o.rx, o.ry))) continue;
        const ob = o.obj.box;
        bb.left = Math.min(bb.left, ob.left);
        bb.right = Math.max(bb.right, ob.right);
        bb.top = Math.min(bb.top, ob.top);
        bb.bottom = Math.max(bb.bottom, ob.bottom);
        arcs.splice(i, 1);
      }
    }
  }
}
