// 歌本切分 · 单页版面：连通块 → 横向「带」（一行字 / 一行谱及其弧线、八度点），标出页脚、标题候选与谱行。
// 只看几何，不跑 OCR；页脚与标题候选的真假由 `scan.ts` 再拿 OCR 定。
import type { Binary, Component, Rect } from "../../omrkit/types";
import { connectedComponents } from "../../omrkit/ccl";
import { median, quantile } from "../../omrkit/geom";

/** 页面上的一条横向带。 */
export interface Band {
  y0: number;
  /** 不含：带占 [y0, y1)。 */
  y1: number;
  x0: number;
  x1: number;
  /** 方正且高 ≥ TITLE_H × 字高的块数（标题大字）。 */
  tall: number;
  /** 竖细长、高 ≥ BAR_H × 字高的块数（小节线；大字带里不算整个落在大字那一排以内的）。 */
  bars: number;
  /** 全是扁块（弧线、减时线）。 */
  flat: boolean;
  /** 方正块（字）的中位高；没有为 0。 */
  sqH: number;
  /** 大字块的中位高；没有为 0。 */
  bigH: number;
  /** 带内各块的包围盒（扫描完即清空省内存）。 */
  boxes: Rect[];
}

export interface PageLayout {
  w: number;
  h: number;
  /** 本页正文字高（数字、歌词字的中位高）。 */
  charH: number;
  /** 本页字行（非谱行、非大字行）的字高：各字行方正块中位高的 0.9 分位。有的本子一页里某首的歌词字比别的大，
   *  标题要比最大的那种字行还大才算。 */
  textH: number;
  /** 铺开的大字歌词行的大字中位高；没有这种行为 0。没读出调号的标题字要比它大（简线混排谱的歌词比数字大一圈）。 */
  lyricH: number;
  bands: Band[];
  /** 纸色（背景像素的中位 RGB）。 */
  paper: [number, number, number];
}

/** 标题大字：方正块高 ≥ 字高 × 此值。 */
export const TITLE_H = 1.22;
/** 小节线：竖细块高 ≥ 字高 × 此值。 */
const BAR_H = 1.15;
/** 没有小节线的标题候选带最高几个字高（标题旁的作者、出处常排两行） */
const TITLE_BAND_H = 4.5;
/** 标题带里像小节线的笔画最多几道 */
const TITLE_STROKES = 2;
/** 歌词行：大字行铺开占版心宽的这么多，一页至少几行 */
const LYRIC_SPAN = 0.6;
const LYRIC_ROWS = 3;
/** 上下两块间隙 ≤ 字高 × 此值就并进同一带（谱行与其弧线、八度点隔得很近）。 */
const MERGE_GAP = 0.12;

/** 一页的显著连通块（去掉碰纸边的与斑点）与正文字高。 */
export interface PageComps {
  w: number;
  h: number;
  charH: number;
  comps: Component[];
}

export function pageComps(bin: Binary): PageComps {
  const { w, h } = bin;
  const all = connectedComponents(bin, 4).filter((c) => !touchesEdge(c.bbox, w, h));
  const charH = estimateCharH(all, h);
  return { w, h, charH, comps: all.filter((c) => significant(c.bbox, charH)) };
}

/** 版面：`drop` 里的块（已认出的页码）不进带。`rgba` 只用来取纸色。 */
export function analyzePage(pc: PageComps, bin: Binary, rgba: Uint8ClampedArray, drop: ReadonlySet<Component> = new Set()): PageLayout {
  const { w, h, charH } = pc;
  // 孤立的小污点自成一带（矮于半个字高、窄于一个字宽）：不算内容，否则会顶替页脚成为「最下一带」、还把空白拼进曲子
  const bands = buildBands(pc.comps.filter((c) => !drop.has(c)), charH)
    .filter((b) => b.y1 - b.y0 >= charH * 0.45 || b.x1 - b.x0 >= charH);
  const textHs = bands.filter((b) => !b.bars && !b.flat && b.sqH > 0 && b.tall < 2).map((b) => b.sqH);
  const textH = Math.max(charH, textHs.length ? quantile(textHs, 0.9) : 0);
  // 歌词字比数字大一圈的本子（简线混排谱的歌词行）：歌词行的块也够「大」（tall ≥ 2），上面不收它们，字行字高只剩出处、署名
  // 那几行小字。铺满版心六成以上宽的大字带（歌词行常与上面的谱行粘成一带、带着小节线，照收）有 `LYRIC_ROWS` 条以上时，
  // 取它们大字高的中位作歌词字高（一页排两首、带着调号拍号的标题行也铺得开，只有两条时不算）
  const x0 = Math.min(...bands.map((b) => b.x0)), x1 = Math.max(...bands.map((b) => b.x1));
  const wide = bands.filter((b) => b.tall >= 2 && b.bigH > 0 && b.x1 - b.x0 >= (x1 - x0) * LYRIC_SPAN).map((b) => b.bigH);
  const lyricH = wide.length >= LYRIC_ROWS ? median(wide, 0) : 0;
  return { w, h, charH, textH, lyricH, bands, paper: paperColor(bin, rgba) };
}

/**
 * 页码候选：页面下 25% 里的「词」（同排、横向间隙 ≤ 1 字高的块并成一词），要
 * 不高（≤ 1.8 字高）、不宽（≤ 7 字高）、有够高的块、同排左右 2.5 字高内没有别的块（页码常与末行歌词同排、在最右）、
 * 下面没有内容（矮于 0.6 字高的污点不算，它们自己也当不了页码）。最靠下的排前。真假由逐字认数定。
 */
export function footerWords(pc: PageComps): Component[][] {
  const { h, charH } = pc;
  const low = pc.comps.filter((c) => c.bbox.y >= h * 0.75).sort((a, b) => a.bbox.x - b.bbox.x);
  // 按整词外框判同排；再把上下只差几个像素、合起来仍是页码大小的两词并上
  //（「–」在数字中腰，断成两截的「2」上半截与它不重叠；合起来太高的不并，免得粘上紧挨着的末行）
  const words: { g: Component[]; box: Rect }[] = [];
  for (const c of low) {
    const w = words.find(({ box }) => c.bbox.y < box.y + box.h && c.bbox.y + c.bbox.h > box.y && c.bbox.x - (box.x + box.w) <= charH);
    if (w) { w.g.push(c); w.box = boxOf(w.g); } else words.push({ g: [c], box: c.bbox });
  }
  for (let merged = true; merged;) {
    merged = false;
    for (let a = 0; a < words.length && !merged; a++) {
      for (let b = a + 1; b < words.length && !merged; b++) {
        const A = words[a].box, B = words[b].box;
        const gx = Math.max(A.x, B.x) - Math.min(A.x + A.w, B.x + B.w), gy = Math.max(A.y, B.y) - Math.min(A.y + A.h, B.y + B.h);
        if (gx > charH || gy > charH * 0.2) continue;
        const g = [...words[a].g, ...words[b].g], box = boxOf(g);
        if (box.h > charH * 1.8 || box.w > charH * 7) continue;
        words[a] = { g, box };
        words.splice(b, 1);
        merged = true;
      }
    }
  }
  const out: { g: Component[]; box: Rect }[] = [];
  for (const { g, box } of words) {
    if (box.h > charH * 1.8 || box.w > charH * 7) continue;
    if (!g.some((c) => c.bbox.h >= charH * 0.6)) continue; // 有字（数字粘连成宽块、断成几截都可能，交给认数那步）
    const inG = new Set(g);
    const others = pc.comps.filter((c) => !inG.has(c));
    const sideBy = others.some((c) => overlapsY(c.bbox, box)
      && Math.max(box.x - (c.bbox.x + c.bbox.w), c.bbox.x - (box.x + box.w)) < charH * 2.5);
    const below = others.some((c) => c.bbox.y >= box.y + box.h && (c.bbox.h >= charH * 0.6 || c.bbox.w >= charH));
    if (!sideBy && !below) out.push({ g, box });
  }
  return out.sort((a, b) => b.box.y + b.box.h - (a.box.y + a.box.h)).map((o) => o.g);
}

const overlapsY = (a: Rect, b: Rect) => Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > Math.min(a.h, b.h) * 0.3;

export function boxOf(g: readonly Component[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const { bbox: b } of g) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function touchesEdge(b: Rect, w: number, h: number): boolean {
  return b.x <= 0 || b.y <= 0 || b.x + b.w >= w || b.y + b.h >= h;
}

/** 正文字高：页高 0.8%–4% 之间、宽高比不离谱的块的中位高（汉字偏旁拆散也大体落在一个字高附近）。 */
function estimateCharH(comps: Component[], h: number): number {
  const hs = comps
    .filter((c) => c.bbox.h >= h * 0.008 && c.bbox.h <= h * 0.04 && c.bbox.w >= c.bbox.h * 0.5 && c.bbox.w <= c.bbox.h * 2)
    .map((c) => c.bbox.h);
  return median(hs, h * 0.018);
}

/** 不是斑点：高或宽有字高的三成（细竖的小节线、扁长的减时线与弧线都算）。 */
function significant(b: Rect, charH: number): boolean {
  return Math.max(b.w, b.h) >= charH * 0.3 && Math.min(b.w, b.h) >= 2;
}

const isTall = (b: Rect, charH: number) => b.h >= charH * TITLE_H && b.w >= b.h * 0.4 && b.w <= b.h * 2.5;
const isBar = (b: Rect, charH: number) => b.h >= charH * BAR_H && b.w <= b.h * 0.12;

function buildBands(comps: Component[], charH: number): Band[] {
  const sorted = [...comps].sort((a, b) => a.bbox.y - b.bbox.y);
  const gap = Math.max(2, charH * MERGE_GAP);
  const groups: Component[][] = [];
  let bottom = -Infinity;
  for (const c of sorted) {
    if (!groups.length || c.bbox.y > bottom + gap) { groups.push([c]); bottom = c.bbox.y + c.bbox.h; }
    else { groups[groups.length - 1].push(c); bottom = Math.max(bottom, c.bbox.y + c.bbox.h); }
  }
  return groups.flatMap((g) => splitTitle(g, charH)).map((g) => {
    let y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity, tall = 0, bars = 0, flat = true;
    const sq: number[] = [], big: number[] = [];
    for (const { bbox: b } of g) {
      y0 = Math.min(y0, b.y); y1 = Math.max(y1, b.y + b.h);
      x0 = Math.min(x0, b.x); x1 = Math.max(x1, b.x + b.w);
      if (isTall(b, charH)) { tall++; big.push(b.h); }
      if (isBar(b, charH)) bars++;
      if (!(b.w >= b.h * 1.8 && b.h < charH * 0.7)) flat = false;
      if (b.h >= charH * 0.6 && b.w >= b.h * 0.6 && b.w <= b.h * 1.6) sq.push(b.h);
    }
    // 大字带里整个落在大字那一排高度以内的竖细块是字的笔画（「惧」的竖心旁）或细体数字「1」（曲号「170」），不是小节线。
    // 标题里这种块最多一两个；带大字的谱行（「和：」）小节线有好几道，也都落在那一排里，不折算
    if (tall >= 2 && bars <= TITLE_STROKES) {
      const tb = g.filter((c) => isTall(c.bbox, charH));
      const t0 = Math.min(...tb.map((c) => c.bbox.y)) - charH * 0.2, t1 = Math.max(...tb.map((c) => c.bbox.y + c.bbox.h)) + charH * 0.2;
      bars = g.filter((c) => isBar(c.bbox, charH) && (c.bbox.y < t0 || c.bbox.y + c.bbox.h > t1)).length;
    }
    return { y0, y1, x0, x1, tall, bars, flat, sqH: median(sq, 0), bigH: median(big, 0), boxes: g.map((c) => c.bbox) };
  });
}

/**
 * 标题行与下面的谱行粘成一带（谱行上的升降号、弧线顶到了标题行底）、或与下面几行页眉粘成一带时，在标题大字的底边处切开。
 * 只看最上面一排大字，且小节线的中心全在它底边之下才切，免得把谱行里「和：」这类大字当标题行切出去。
 */
function splitTitle(g: Component[], charH: number): Component[][] {
  const tall = g.filter((c) => isTall(c.bbox, charH));
  const bars = g.filter((c) => isBar(c.bbox, charH));
  if (tall.length < 2) return [g];
  // 只看最上面一排大字（谱行里连着减时线的数字也够「大」，不能算进标题行）
  const top0 = Math.min(...tall.map((c) => c.bbox.y));
  const row = tall.filter((c) => c.bbox.y <= top0 + charH * 0.6);
  if (row.length < 2) return [g];
  const ty1 = Math.max(...row.map((c) => c.bbox.y + c.bbox.h));
  // 整个落在大字那一排里的「小节线」是曲号里笔画细的「1」（「139」），不算
  const lowBars = bars.filter((c) => c.bbox.y < top0 - charH * 0.2 || c.bbox.y + c.bbox.h > ty1 + charH * 0.2);
  // 没有小节线：标题行与下面几行页眉（出处、调号、速度）挨得紧粘成了一带——有块整个落在大字底边以下才切
  if (!lowBars.length && !g.some((c) => c.bbox.y >= ty1)) return [g];
  if (lowBars.length && Math.min(...lowBars.map((c) => c.cy)) < ty1) return [g]; // 小节线顶可能挨上标题底，按中心比
  const top = g.filter((c) => c.cy <= ty1), rest = g.filter((c) => c.cy > ty1);
  return top.length && rest.length ? [top, rest] : [g];
}

/** 纸色：背景像素（隔点抽样）各通道中位数。 */
function paperColor(bin: Binary, rgba: Uint8ClampedArray): [number, number, number] {
  const r: number[] = [], g: number[] = [], b: number[] = [];
  const step = Math.max(1, Math.floor(Math.sqrt((bin.w * bin.h) / 40000)));
  for (let y = 0; y < bin.h; y += step) {
    for (let x = 0; x < bin.w; x += step) {
      const i = y * bin.w + x;
      if (bin.data[i]) continue;
      r.push(rgba[i * 4]); g.push(rgba[i * 4 + 1]); b.push(rgba[i * 4 + 2]);
    }
  }
  return [Math.round(median(r, 255)), Math.round(median(g, 255)), Math.round(median(b, 255))];
}

/**
 * 标题候选：有 ≥ 2 个大字、不是谱行（标题带里小节线极少）、不太高（字行粘上谱行的那种带里
 * 连着减时线的数字也够「大」，双减时线还会被 OCR 读成「=」冒充调号）。字是否比本页字行大由 OCR 那步再看。
 */
export function isTitleCandidate(b: Band, p: PageLayout): boolean {
  // 没有小节线的带可以高些：标题旁的作者、出处常排两行
  return b.tall >= 2 && b.bars <= 1 && b.y1 - b.y0 <= p.charH * (b.bars ? 3 : TITLE_BAND_H);
}

/** 谱行：有小节线。 */
export function isMusicBand(b: Band): boolean {
  return b.bars >= 1 && b.tall < 2;
}
