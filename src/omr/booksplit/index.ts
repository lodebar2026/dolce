// 歌本切分：整本分页简谱（PDF / 页图文件夹）→ 一首一张图。按标题切开一页多首、拼接跨页，去页码，
// 拼缝处用本首的系统间距，边距照源图；再按书内目录核对缺漏。
// 第一遍逐页扫描（scan.ts）只留几何与文字，第二遍（write.node.ts）按摆放回源图原分辨率裁拼。
import type { OcrBackend } from "../../omrkit/ocr";
import { scanPage } from "./scan";
import { assignNumbers, bookMargins, buildToc, findRegion, layoutSong, planSongs, segmentSongs, type BookRegion, type Toc } from "./plan";
import type { Layout, Margins, PageInfo, PageSource, SongPlan } from "./types";

export type { PageSource, SongPlan, Layout, Margins, PageInfo } from "./types";

export interface BookPlan {
  pages: PageInfo[];
  region: BookRegion;
  toc: Toc;
  /** 目录读自哪几页（源序号）。 */
  tocPages: number[];
  margins: Margins;
  songs: SongPlan[];
  layouts: Layout[];
  /** 歌谱区里第一个标题之前、不属于任何一首的页。 */
  orphans: number[];
}

export interface PlanOptions {
  /** 指定目录页（源序号，0 起）；不给则自动认（歌谱区之前、全是字行的页）。 */
  tocPages?: number[];
  onProgress?: (done: number, total: number) => void;
}

export async function planBook(src: PageSource, ocr: OcrBackend, opts: PlanOptions = {}): Promise<BookPlan> {
  const pages: PageInfo[] = [];
  const forced = opts.tocPages ? new Set(opts.tocPages) : null;
  let last: number | undefined;
  for (let i = 0; i < src.count; i++) {
    const p = await scanPage(i, await src.page(i), ocr, forced ? forced.has(i) : undefined, last !== undefined ? last + 1 : undefined);
    pages.push(p);
    last = p.printed ?? (last !== undefined ? last + 1 : undefined);
    opts.onProgress?.(i + 1, src.count);
  }
  const region = findRegion(pages);
  // 目录页成片排：与已认出的目录页相邻、在歌谱区外、没有标题的页也整页 OCR 一遍（三位曲号全以「1」打头时，
  // 笔画细的「1」一行好几个都像小节线，`looksLikeToc` 当它是谱行，漏认）
  if (!forced) {
    const outside = (i: number) => i < region.first || i > region.last;
    for (let grew = true; grew;) {
      grew = false;
      for (const p of pages) {
        if (p.toc.length || p.titles.length || !outside(p.index)) continue;
        if (!pages[p.index - 1]?.toc.length && !pages[p.index + 1]?.toc.length) continue;
        const again = await scanPage(p.index, await src.page(p.index), ocr, true, p.printed);
        if (!again.toc.length) continue;
        pages[p.index] = again;
        grew = true;
      }
    }
  }
  // 目录只取歌谱区之外的页（区内纯歌词页也可能像目录）
  const tocPages = pages.filter((p) => p.toc.length && (forced ? forced.has(p.index) : p.index < region.first || p.index > region.last)).map((p) => p.index);
  const maxPage = region.offset !== undefined ? region.last - region.offset : undefined;
  const toc = buildToc(tocPages.flatMap((i) => pages[i].toc), maxPage);
  const nums = assignNumbers(pages, region, toc);
  const { songs: segs, orphans } = segmentSongs(pages, region, nums);
  const songs = planSongs(pages, segs);
  const margins = bookMargins(pages, region);
  const layouts = songs.map((s) => layoutSong(s, pages, margins));
  return { pages, region, toc, tocPages, margins, songs, layouts, orphans };
}

/** 文件名：`曲号 曲名`（曲号补零到全书最大号的位数），去掉文件系统不认的字符；重名加 `(2)`。 */
export function songFileNames(songs: readonly SongPlan[]): string[] {
  const maxN = Math.max(0, ...songs.map((s) => s.number ?? 0));
  const width = Math.max(3, String(maxN).length);
  const seen = new Map<string, number>();
  return songs.map((s, k) => {
    const num = s.number !== undefined ? String(s.number).padStart(width, "0") : `未编号${k + 1}`;
    const title = (s.title || "未识别曲名").replace(/[\\/:*?"<>|\s]+/g, "");
    let name = `${num} ${title}`;
    const c = (seen.get(name) ?? 0) + 1;
    seen.set(name, c);
    if (c > 1) name += `(${c})`;
    return name;
  });
}

export interface SplitReport {
  /** 期望的曲号：目录最大号以内的全部号。 */
  expected: number;
  written: number;
  /** 缺：目录里有（或在号段内）却没切出来。 */
  missing: { number: number; text?: string; page?: number }[];
  /** 切出来、目录里却没有的号。 */
  extra: number[];
  duplicate: number[];
  /** 起始页与目录不符：[曲号, 目录页, 实际印页]。 */
  pageMismatch: [number, number, number][];
  noTitle: number[];
  text: string;
}

/** 按目录核对，并生成可读报告。`names` 是写出的文件名（与 songs 同序）。 */
export function checkAgainstToc(plan: BookPlan, names: readonly string[], srcName: (i: number) => string): SplitReport {
  const { toc, songs, region } = plan;
  const counts = new Map<number, number>();
  for (const s of songs) if (s.number !== undefined) counts.set(s.number, (counts.get(s.number) ?? 0) + 1);
  const maxN = Math.max(0, ...toc.numbers);
  const missing: SplitReport["missing"] = [];
  for (let n = 1; n <= maxN; n++) if (!counts.has(n)) missing.push({ number: n, text: toc.texts.get(n), page: toc.pages.get(n) });
  const extra = [...counts.keys()].filter((n) => toc.numbers.size && !toc.numbers.has(n)).sort((a, b) => a - b);
  const duplicate = [...counts].filter(([, c]) => c > 1).map(([n]) => n).sort((a, b) => a - b);
  const pageMismatch: [number, number, number][] = [];
  if (region.offset !== undefined) {
    for (const s of songs) {
      const tp = s.number !== undefined ? toc.pages.get(s.number) : undefined;
      const actual = s.startPage - region.offset;
      if (tp !== undefined && tp !== actual) pageMismatch.push([s.number!, tp, actual]);
    }
  }
  const noTitle = songs.map((s, k) => (s.title ? -1 : k)).filter((k) => k >= 0);

  const L: string[] = [];
  const pageLabel = (i: number) => (region.offset !== undefined ? `${srcName(i)}（印页 ${i - region.offset}）` : srcName(i));
  L.push(`歌谱区：${pageLabel(region.first)} – ${pageLabel(region.last)}，共 ${region.last - region.first + 1} 页`);
  L.push(`目录：读自 ${plan.tocPages.length} 页，得 ${toc.numbers.size} 条（曲号 1–${maxN}）` + (toc.dropped.length ? `，${toc.dropped.length} 条与前后页码不单调已剔除` : ""));
  L.push(`切出：${songs.length} 首`);
  L.push(`缺：${missing.length} 首` + (missing.length ? "" : " ✓"));
  for (const m of missing) L.push(`  ${m.number}${m.text ? ` ${m.text}` : "（目录也没读到）"}${m.page !== undefined ? ` 目录页 ${m.page}` : ""}`);
  if (extra.length) L.push(`切出了、目录里却没读到的号（目录漏读或标题号读错，请抽查）：${extra.join("、")}`);
  if (duplicate.length) L.push(`重号：${duplicate.join("、")}`);
  if (pageMismatch.length) {
    L.push(`起始页与目录不符：${pageMismatch.length} 首`);
    for (const [n, tp, ap] of pageMismatch) L.push(`  ${n}：目录 ${tp}，实际 ${ap}`);
  }
  if (noTitle.length) L.push(`没认出曲名：${noTitle.map((k) => names[k]).join("、")}`);
  const noFooter: number[] = [];
  for (let i = region.first; i <= region.last; i++) if (plan.pages[i].printed === undefined) noFooter.push(i);
  const badFooter: number[] = [];
  for (let i = region.first; i <= region.last; i++) {
    const p = plan.pages[i].printed;
    if (region.offset !== undefined && p !== undefined && p !== i - region.offset) badFooter.push(i);
  }
  if (badFooter.length) L.push(`页码与前后不连贯（可能把别的数当成页码、或真页码没去掉）：${badFooter.map((i) => `${srcName(i)} 读作 ${plan.pages[i].printed}`).join("、")}`);
  if (noFooter.length) L.push(`没认出页码的页（页码可能留在图里，请抽查）：${noFooter.map(srcName).join("、")}`);
  if (plan.orphans.length) L.push(`第一个标题之前、未归属的页：${plan.orphans.map(srcName).join("、")}`);
  if (toc.dropped.length) L.push(`剔除的目录条目：${toc.dropped.map((e) => `${e.text} ${e.number}/${e.page ?? ""}`).join("；")}`);
  const withIssues = songs.map((s, k) => ({ s, k })).filter(({ s }) => s.issues.length);
  if (withIssues.length) {
    L.push(`逐首提示：`);
    for (const { s, k } of withIssues) L.push(`  ${names[k]}（${srcName(s.startPage)}）：${s.issues.join("；")}`);
  }
  L.push("");
  L.push("曲目清单（文件名 ← 源页）：");
  songs.forEach((s, k) => L.push(`  ${names[k]} ← ${s.pieces.map((p) => srcName(p.page)).join(" + ")}`));
  return { expected: maxN, written: songs.length, missing, extra, duplicate, pageMismatch, noTitle, text: L.join("\n") + "\n" };
}
