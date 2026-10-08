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
export function findRasterSlurs(map: ContourMap, unit: RasterUnit, only: Contour[], nextId: number, mask?: Binary): SlurArc[] {
  const out: SlurArc[] = [];
  for (const c of only) {
    if (c.w < MIN_W || c.w > MAX_W || c.h > MAX_H) continue;
    if (c.compact > MAX_COMPACT && c.area > c.bbox.w * unit.space * THIN_MEAN) continue;
    const arc = judgeArc(map, c, unit, nextId + out.length, mask);
    if (arc) out.push(arc);
  }
  return out;
}

// ── 跨行弧的半截 ───────────────────────────────────────────────────────────
//
// 跨系统的延音线、圆滑线在下一行开头只画一小截（谱号调号之后、第一个音之前），上一行末尾同理：
// 只有一格来宽、拱得也浅（半条弧），过不了 `MIN_W` 与 `BOW_MIN`（破碎 p2 第三系统钢琴右手开头 A4 下方两截，1.17 / 1.23 格）。
// 只在行首行尾那段窗口里（调用方给）放宽这两道闸。

/** 半截弧的宽度下限、拱的下限（格）。 */
const STUB_MIN_W = 0.8;
const STUB_BOW_MIN = 0.08;
/** 半截弧逐列一段墨的占比下限：贴着谱线的那截去线后有几列断成两段（同上，下方那截压在第五线上）。 */
const STUB_ONE_RUN = 0.6;

export function findStubSlurs(map: ContourMap, unit: RasterUnit, only: Contour[], nextId: number, mask?: Binary): SlurArc[] {
  const out: SlurArc[] = [];
  for (const c of only) {
    if (c.w < STUB_MIN_W || c.w >= MIN_W * 2 || c.h > 1.5) continue;
    if (c.compact > MAX_COMPACT && c.area > c.bbox.w * unit.space * THIN_MEAN) continue;
    const arc = judgeArc(map, c, unit, nextId + out.length, mask, STUB_BOW_MIN, STUB_ONE_RUN);
    if (arc) out.push(arc);
  }
  return out;
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
/** 竖笔抠掉后弧上补回的缝宽上限（格）：符干、小节线两三个像素。 */
const BRIDGE_GAP = 0.25;

/**
 * 从音符那组墨里抠出粘连的弧。`groups` 是要看的 contour（有符头认领、够宽的），`heads` 是全页符头盒。
 */
export function findFusedSlurs(map: ContourMap, unit: RasterUnit, groups: Contour[], heads: readonly Rect[], nextId: number): SlurArc[] {
  const sp = unit.space;
  const out: SlurArc[] = [];
  for (const c of groups) {
    const b = c.bbox;
    if (b.w < sp * FUSED_MIN_W) continue;
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
      if (w < sp * FUSED_MIN_W || h > sp * MAX_H || area > w * sp * THIN_RUN * 1.5) continue;
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

/** 跨谱线时允许连续没墨的列数（格）。 */
const EXT_GAP = 1.5;
/** 一端最多延长（格）。 */
const EXT_MAX = 3;
/** 越线途中找墨的垂直窗口（格）。 */
const EXT_CROSS_PERP = 0.3;
/** 越过谱线接上墨之后再跟多远（格）。 */
const EXT_AFTER = 1;

export function extendArcEnds(arcs: SlurArc[], nl: Binary, onLine: (y: number) => boolean, sp: number): void {
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
  const lineAt = (y: number) => onLine(Math.round(y)) || onLine(Math.round(y) - 1) || onLine(Math.round(y) + 1);
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
        if (lineAt(py)) {
          x = px;
          y = py;
          gap++;
          crossed = true;
          if (gap > sp * EXT_GAP) break;
          continue;
        }
        break;
      }
      if (!end) continue;
      if (dir < 0) (sl.lx = end.x), (sl.ly = end.y);
      else (sl.rx = end.x), (sl.ry = end.y);
    }
  }
}
