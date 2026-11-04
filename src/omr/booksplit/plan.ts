// 歌本切分 · 整本规划（纯计算，不碰像素）：印页码 → 歌谱区、目录投票、标题配号、分段、系统间距与边距、每首的摆放。
import { median, quantile } from "../../omrkit/geom";
import type { Rect } from "../../omrkit/types";
import { isMusicBand, type Band } from "./layout";
import type { Layout, Margins, PageInfo, Piece, Placement, SongPlan, TitleHit, TocEntry } from "./types";

/** 歌谱区：`序号 − 印页码` 出现最多的那个差值所覆盖的页段（前后的封面、目录、附录不算）。 */
export interface BookRegion {
  first: number;
  last: number;
  /** 序号 − 印页码；没有页码时为 undefined。 */
  offset?: number;
}

export function findRegion(pages: readonly PageInfo[]): BookRegion {
  const votes = new Map<number, number>();
  for (const p of pages) if (p.printed !== undefined) votes.set(p.index - p.printed, (votes.get(p.index - p.printed) ?? 0) + 1);
  let offset: number | undefined, best = 0;
  for (const [k, v] of votes) if (v > best) { best = v; offset = k; }
  if (offset === undefined || best < 3) {
    // 没有可信的页码：从第一页有标题的页到末页
    const first = pages.find((p) => p.titles.length)?.index ?? 0;
    return { first, last: pages.length - 1 };
  }
  const hits = pages.filter((p) => p.printed !== undefined && p.index - p.printed === offset).map((p) => p.index);
  return { first: hits[0], last: hits[hits.length - 1], offset };
}

export interface Toc {
  /** 曲号 → 印页码（投票、单调性筛过）。 */
  pages: Map<number, number>;
  /** 首句等文字（报告用）。 */
  texts: Map<number, string>;
  /** 目录里有的全部曲号（含不带页码的条目、不含剔掉的）。 */
  numbers: Set<number>;
  /** 读到了但与前后不单调、被剔掉的条目。 */
  dropped: TocEntry[];
}

/**
 * 多份目录（首句、经文…）的条目投票：同一曲号取票最多的页码；再按曲号排序取页码不减的最长子序列，
 * 把 OCR 读错的号（页码跟前后对不上）剔掉。`maxPage` 是歌谱区最后一页的印页码，超出的条目不收。
 */
export function buildToc(entries: readonly TocEntry[], maxPage?: number): Toc {
  const votes = new Map<number, Map<number, number>>();
  const texts = new Map<number, string>();
  const bare = new Set<number>();
  // 一本书的目录要么都带页码、要么都不带：有带页码的条目时，不带的（前言、索引页上按「数 + 字」误认出来的）不收
  const paged = entries.some((e) => e.page !== undefined);
  for (const e of entries) {
    if (e.number >= 1 && e.page === undefined) {
      if (paged) continue;
      // 不带页码的条目（只列「曲号 曲名」的目录）：只记号与文字
      bare.add(e.number);
      if (!texts.has(e.number)) texts.set(e.number, e.text);
      continue;
    }
    if (e.page === undefined || e.number < 1 || e.page < 1 || (maxPage !== undefined && e.page > maxPage)) continue;
    const m = votes.get(e.number) ?? new Map<number, number>();
    m.set(e.page, (m.get(e.page) ?? 0) + 1);
    votes.set(e.number, m);
    if (!texts.has(e.number)) texts.set(e.number, e.text);
  }
  const cand = [...votes.entries()].map(([n, m]) => {
    let page = 0, best = 0;
    for (const [p, v] of m) if (v > best || (v === best && p < page)) { best = v; page = p; }
    return { n, page };
  }).sort((a, b) => a.n - b.n);
  const keep = longestNonDecreasing(cand.map((c) => c.page));
  const pages = new Map<number, number>();
  const dropped: TocEntry[] = [];
  cand.forEach((c, i) => {
    if (keep.has(i)) pages.set(c.n, c.page);
    else dropped.push({ text: texts.get(c.n) ?? "", number: c.n, page: c.page });
  });
  const dropNums = new Set(dropped.map((e) => e.number));
  const numbers = new Set([...pages.keys(), ...[...bare].filter((n) => !dropNums.has(n))]);
  return { pages, texts, numbers, dropped };
}

/** 最长不减子序列的下标集合（O(n log n)）。 */
function longestNonDecreasing(xs: readonly number[]): Set<number> {
  const tails: number[] = [], tailIdx: number[] = [], prev = new Array<number>(xs.length).fill(-1);
  xs.forEach((x, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] <= x) lo = mid + 1; else hi = mid; }
    tails[lo] = x; tailIdx[lo] = i; prev[i] = lo ? tailIdx[lo - 1] : -1;
  });
  const out = new Set<number>();
  for (let i = tailIdx[tails.length - 1] ?? -1; i >= 0; i = prev[i]) out.add(i);
  return out;
}

/**
 * 给歌谱区里的标题配号。逐个标题、按页序与纵向次序：
 *   1. 标题上读到的号在本页目录里 → 用它；
 *   2. 读到的号接得上（比上一首大、跳不超过 5），且目录没说它在别的页（差一页以内不算）→ 用它
 *      （目录本身也有印错、OCR 也会漏条，号接得上就信标题）；
 *   3. 本页目录给的号数与标题数相同 → 照目录次序配；
 *   4. 本页目录还剩比上一首大的号 → 用最小那个；
 *   5. 都不行 → 上一首 + 1。
 * 与读到的号不一致处记进 issues。
 */
export function assignNumbers(
  pages: readonly PageInfo[], region: BookRegion, toc: Toc,
): Map<TitleHit, { number?: number; issues: string[] }> {
  const byPage = new Map<number, number[]>();
  for (const [n, p] of toc.pages) byPage.set(p, [...(byPage.get(p) ?? []), n]);
  for (const ns of byPage.values()) ns.sort((a, b) => a - b);
  const out = new Map<TitleHit, { number?: number; issues: string[] }>();
  let prev = 0;
  for (let i = region.first; i <= region.last; i++) {
    const p = pages[i];
    if (!p.titles.length) continue;
    const printed = region.offset !== undefined ? i - region.offset : undefined;
    const expect = printed !== undefined ? byPage.get(printed) ?? [] : [];
    const left = [...expect];
    const together = expect.length === p.titles.length;
    p.titles.forEach((t, k) => {
      const issues: string[] = [];
      const r = t.number;
      const tp = r !== undefined ? toc.pages.get(r) : undefined;
      const fits = r !== undefined && r > prev && r <= prev + 6
        && (tp === undefined || printed === undefined || Math.abs(tp - printed) <= 1);
      let n: number | undefined;
      let how = "目录";
      if (r !== undefined && left.includes(r)) n = r;
      else if (fits) n = r;
      else if (together && expect[k] > prev) n = expect[k];
      else if (left.some((x) => x > prev)) n = left.find((x) => x > prev);
      else { n = prev + 1; how = "前后顺序"; }
      const j = n !== undefined ? left.indexOf(n) : -1;
      if (j >= 0) left.splice(j, 1);
      if (r !== undefined && r !== n) issues.push(`标题上读到曲号 ${r}，按${how}定为 ${n}`);
      if (r === undefined) issues.push(`标题上没读到曲号，按${how}定为 ${n}`);
      out.set(t, { number: n, issues });
      if (n !== undefined) prev = n;
    });
  }
  return out;
}

/** 一页的正文带按标题切开后，属于某首歌的一段带。 */
interface Segment { page: number; bands: Band[] }

/** 歌谱区按标题切成每首的分段（不含尚未摆放的间距）。标题之前、不接任何一首的内容记进 `orphans`。 */
export function segmentSongs(
  pages: readonly PageInfo[], region: BookRegion, nums: Map<TitleHit, { number?: number; issues: string[] }>,
): { songs: { hit: TitleHit; number?: number; issues: string[]; segs: Segment[] }[]; orphans: number[] } {
  const songs: { hit: TitleHit; number?: number; issues: string[]; segs: Segment[] }[] = [];
  const orphans: number[] = [];
  for (let i = region.first; i <= region.last; i++) {
    const p = pages[i];
    const titleAt = new Map(p.titles.map((t) => [t.band, t]));
    let seg: Segment | null = songs.length ? { page: i, bands: [] } : null;
    for (const b of p.body) {
      const t = titleAt.get(b);
      if (t) {
        if (seg && seg.bands.length && songs.length) songs[songs.length - 1].segs.push(seg);
        const a = nums.get(t) ?? { issues: [] };
        songs.push({ hit: t, number: a.number, issues: [...a.issues], segs: [] });
        seg = { page: i, bands: [b] };
      } else if (seg) seg.bands.push(b);
      else if (!orphans.includes(i)) orphans.push(i);
    }
    if (seg && seg.bands.length && songs.length) songs[songs.length - 1].segs.push(seg);
  }
  return { songs, orphans };
}

/**
 * 系统间距：一首里每个「系统」（谱行连同上面贴着的弧线带）顶上的空白，第一个系统（紧接标题）除外。
 * 一首里不止一处时取中位，否则用全书中位。
 */
export function systemGaps(segs: readonly Segment[], charH: number): number[] {
  const gaps: number[] = [];
  for (const s of segs) {
    for (let k = 1; k < s.bands.length; k++) {
      const b = s.bands[k];
      if (!isMusicBand(b)) continue;
      // 系统顶：谱行上面紧贴的扁弧线带算进系统
      let top = k;
      while (top - 1 >= 1 && s.bands[top - 1].flat && b.y0 - s.bands[top - 1].y1 < charH * 0.8) top--;
      if (top - 1 < 0) continue;
      const above = s.bands[top - 1];
      if (s.bands[0] === above && isTitleLike(above)) continue; // 标题下第一个系统
      gaps.push(s.bands[top].y0 - above.y1);
    }
  }
  return gaps;
}

function isTitleLike(b: Band): boolean { return b.tall >= 2; }

/** 全书边距：歌谱区各页版心距纸边的分位数（底边取 0.3 分位，免得收尾半页的大片空白把它抬高）。 */
export function bookMargins(pages: readonly PageInfo[], region: BookRegion): Margins {
  const L: number[] = [], R: number[] = [], T: number[] = [], B: number[] = [], W: number[] = [];
  for (let i = region.first; i <= region.last; i++) {
    const p = pages[i];
    if (!p.body.length) continue;
    const x0 = Math.min(...p.body.map((b) => b.x0)), x1 = Math.max(...p.body.map((b) => b.x1));
    L.push(x0); R.push(p.layout.w - x1); W.push(x1 - x0);
    T.push(p.body[0].y0); B.push(p.layout.h - p.body[p.body.length - 1].y1);
  }
  return {
    left: Math.round(median(L, 150)), right: Math.round(median(R, 150)), top: Math.round(median(T, 200)),
    bottom: Math.round(quantile(B, 0.3) || 200), typeW: Math.round(median(W, 1100)),
  };
}

/** 一页的版心左缘与右缘（各段按左缘对齐）。 */
function typeX(p: PageInfo): { x0: number; x1: number } {
  return { x0: Math.min(...p.body.map((b) => b.x0)), x1: Math.max(...p.body.map((b) => b.x1)) };
}

/** 分段 → SongPlan（各段纵向范围 + 拼缝间距）。 */
export function planSongs(
  pages: readonly PageInfo[],
  songs: ReturnType<typeof segmentSongs>["songs"],
): SongPlan[] {
  const all: number[] = [];
  const per = songs.map((s) => {
    const g = systemGaps(s.segs, pages[s.segs[0]?.page ?? 0]?.layout.charH ?? 36);
    all.push(...g);
    return g;
  });
  const globalGap = median(all, 60);
  return songs.map((s, k) => ({
    number: s.number,
    title: s.hit.title,
    startPage: s.segs[0]?.page ?? -1,
    pieces: s.segs.map((g): Piece => ({
      page: g.page, y0: g.bands[0].y0, y1: g.bands[g.bands.length - 1].y1, typeX: typeX(pages[g.page]).x0,
    })),
    seamGap: Math.round(per[k].length ? median(per[k]) : globalGap),
    issues: s.issues,
  }));
}

/**
 * 一首的摆放：画布宽 = 左边距 + max(全书版心宽, 各段实宽) + 右边距；各段按本页版心左缘对齐、竖着排，
 * 段与段之间隔一个系统间距；段的上下多拷一点源图（不超过到邻带空白的一半），其余填纸色。
 */
export function layoutSong(song: SongPlan, pages: readonly PageInfo[], m: Margins): Layout {
  let width = 0;
  for (const pc of song.pieces) width = Math.max(width, typeX(pages[pc.page]).x1 - pc.typeX);
  width = m.left + Math.max(m.typeW, width) + m.right;
  const parts: Placement[] = [];
  const erase: Rect[] = [];
  let y = m.top;
  song.pieces.forEach((pc, k) => {
    const p = pages[pc.page];
    const { above, below } = room(p, pc);
    const padT = Math.min(Math.round(p.layout.charH * 0.3), above);
    const padB = Math.min(Math.round(p.layout.charH * 0.3), below);
    const sx = Math.max(0, pc.typeX - m.left), sx1 = Math.min(p.layout.w, pc.typeX - m.left + width);
    const sy = pc.y0 - padT, sy1 = pc.y1 + padB;
    const src = { x: sx, y: sy, w: sx1 - sx, h: sy1 - sy };
    const dx = sx - (pc.typeX - m.left), dy = y - padT;
    parts.push({ page: pc.page, src, dx, dy });
    // 拷进来的范围里夹着页码（与末行同排、或贴得很近）→ 画布上涂纸色
    const f = p.footer;
    if (f && f.x < src.x + src.w && f.x + f.w > src.x && f.y < src.y + src.h && f.y + f.h > src.y) {
      const d = Math.round(p.layout.charH * 0.15);
      erase.push({ x: f.x - d - src.x + dx, y: f.y - d - src.y + dy, w: f.w + 2 * d, h: f.h + 2 * d });
    }
    y += pc.y1 - pc.y0;
    if (k < song.pieces.length - 1) y += song.seamGap;
  });
  const paper = song.pieces.length ? pages[song.pieces[0].page].layout.paper : [255, 255, 255] as [number, number, number];
  return { width, height: y + m.bottom, paper, parts, erase };
}

/** 段上下可多拷的源图高度：到相邻、不属于本段的带（或纸边）空白的一半。页码另行涂掉。 */
function room(p: PageInfo, pc: Piece): { above: number; below: number } {
  const bands = p.body;
  let above = pc.y0, below = p.layout.h - pc.y1;
  for (const b of bands) {
    if (b.y1 <= pc.y0) above = Math.min(above, Math.floor((pc.y0 - b.y1) / 2));
    if (b.y0 >= pc.y1) below = Math.min(below, Math.floor((b.y0 - pc.y1) / 2));
  }
  return { above: Math.max(0, above), below: Math.max(0, below) };
}
