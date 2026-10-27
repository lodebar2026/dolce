// 窄纸整首重新断行：源里的行放不下时求新的行首。
import type { MusicElement, FanqieSong } from "../../../jianpu/ast";
import { contentWidth, type JianpuGrid } from "../metrics";
import { naturalColumns } from "./spacing";
import { fillLines } from "./expand";
import type { InkMeasurer, PlacedItem } from "./model";
import { assignLyrics, layoutVoiceLine } from "./voice";

/**
 * **窄纸整首重新断行的断点**（原样档放不下时用，见 `compose/index.ts::layoutJianpu`）。
 *
 * 原样文档照源里的行排（「原版」的意义），版心够宽时不动：每组按**自然宽**（紧排 + 歌词避让，不两端对齐，
 * 与排版同一个 `spacing.ts`）量出所需宽度，全都放得进版心就返回 null。有一组放不下（500 首那张 150×216mm 纸上，原版按 1000 宽长图写的行），
 * 就把全曲各小节的所需宽度串起来，只在小节线处断、求「各行余白平方和最小」——行长均匀、中间没有短行
 * （与旧简谱引擎 `layout.ts::reflowBreak` 同一个口径）。返回每首的新行首（行里第一个音的元素 id，首行不列）。
 *
 * 多声部各组的列是共享的（同拍位归一列），量宽取主声部（第一个声部）的小节线位置。
 */
export function reflowLineStarts(
  songs: readonly FanqieSong[],
  idOf: ReadonlyMap<MusicElement, string | number>,
  m: JianpuGrid,
  ink: InkMeasurer,
): Array<Array<string | number>> | null {
  const width = contentWidth(m);
  if (!(width > 0)) return null;
  let overflow = false;
  const perSong = songs.map((song) => {
    /** 全曲的小节：所需宽度 + 小节首音的 id */
    const bars: { w: number; first: string | number | null }[] = [];
    let open: { w: number; first: string | number | null } | null = null; // 跨组没收口的小节
    for (const page of song.pages) {
      for (const group of page.groups) {
        const laidOut = group.voices.map((voice) => layoutVoiceLine(voice, m, { meter: song.metadata.meters[0] }));
        laidOut.forEach((l, vi) => {
          const voice = group.voices[vi]!;
          for (const it of l.items) it.syllables = new Array(voice.lyrics.length).fill(null);
          assignLyrics(l.items, voice.lyrics);
        });
        const nat = naturalColumns(laidOut, m, ink);
        const X = (it: PlacedItem): number => nat.xOf.get(it) ?? 0;
        const lead = laidOut[0];
        if (!lead) continue;
        if (nat.width > width) overflow = true;
        let start = 0;
        let first: string | number | null = null;
        const flush = (end: number): void => {
          const w = Math.max(0, end - start);
          if (open) {
            open.w += w;
            if (open.first === null) open.first = first;
            bars.push(open);
            open = null;
          } else bars.push({ w, first });
          first = null;
        };
        for (const it of lead.items) {
          if (it.element.kind === "barline") {
            if (first !== null || open) flush(X(it));
            start = X(it);
            continue;
          }
          if (first === null && it.element.kind === "note") first = idOf.get(it.element) ?? null;
        }
        // 组尾没收口（小节中间换行）：留到下一组接着量
        const end = nat.width;
        if (end - start > 1e-6 || first !== null) open = { w: end - start, first };
      }
    }
    if (open) bars.push(open);
    return bars;
  });
  if (!overflow) return null;
  return perSong.map((bars) => {
    const n = bars.length;
    const best = new Array<number>(n + 1).fill(Infinity);
    const prev = new Array<number>(n + 1).fill(-1);
    best[0] = 0;
    for (let j = 1; j <= n; j++) {
      let w = 0;
      for (let i = j - 1; i >= 0; i--) {
        w += bars[i]!.w;
        if (w > width && i < j - 1) break; // 单个小节就超宽也得放
        if (best[i] === Infinity) continue;
        const c = best[i]! + Math.max(0, width - w) ** 2;
        if (c < best[j]!) {
          best[j] = c;
          prev[j] = i;
        }
      }
    }
    const cuts: number[] = [];
    for (let j = n; j > 0; j = prev[j]!) cuts.unshift(prev[j]!);
    return cuts.filter((i) => i > 0).map((i) => bars[i]!.first).filter((id): id is string | number => id !== null);
  });
}

/** 一行里从第 `from` 个元素起第一个音符 / 增时线的元素 id（行首落点，`model/breaks.ts::applyBreaks` 按它写换行） */
function startIdOf(els: readonly MusicElement[], from: number, idOf: ReadonlyMap<MusicElement, string | number>): string | number | null {
  for (let i = from; i < els.length; i++) {
    const el = els[i]!;
    if (el.kind !== "note" && el.kind !== "sustain") continue;
    const id = idOf.get(el);
    if (id !== undefined) return id;
  }
  return null;
}

/**
 * **成书的折行**（同旧简谱引擎成书：照断点成行，单行放不下才在行内折，`layout.ts::Line.doLineBreak`）：源里每一行按自然宽逐行装满
 * （`expand.ts::fillLines`），折出新行首。有折的就返回每首的全部行首（源里原有的行首也在内，`applyBreaks` 是整份替换），都放得下返回 null。
 * 只看每组第一个声部（成书只排旋律）。
 */
export function foldLineStarts(
  songs: readonly FanqieSong[],
  idOf: ReadonlyMap<MusicElement, string | number>,
  m: JianpuGrid,
  ink: InkMeasurer,
): Array<Array<string | number>> | null {
  const width = contentWidth(m);
  if (!(width > 0)) return null;
  let folded = false;
  const out = songs.map((song) => {
    const starts: Array<string | number> = [];
    let firstGroup = true;
    for (const page of song.pages) {
      for (const group of page.groups) {
        const row = group.voices[0];
        if (!row) continue;
        const lines = fillLines(row, new Map(), m, ink, width, song.metadata.meters[0]);
        if (lines.length > 1) folded = true;
        lines.forEach((l, n) => {
          if (n === 0 && firstGroup) return;
          const id = startIdOf(row.elements, l.start, idOf);
          if (id !== null) starts.push(id);
        });
        firstGroup = false;
      }
    }
    return starts;
  });
  return folded ? out : null;
}

/** 一个音的自然横向区间（见 `naturalSpans`） */
export interface NaturalSpan {
  x0: number;
  x1: number;
  /** 后面紧跟小节线时，含这条线的右缘（判放不放得下用） */
  x1b?: number;
}

/**
 * 整首的**自然**横向区间（紧排 + 歌词避让，不分行、不两端对齐）：成书断句判「一行放不放得下」的尺子
 * （同旧简谱引擎 `Line.naturalSpans`）。键是元素 id；增时线算进它前面那个音（一个音的区间罩住它的增时线与歌词）。
 * `x1` 不含音后面的小节线（同旧简谱引擎；行长匀度、行宽比这些尺子按它调的）。
 * `x1b`：音后面紧跟小节线时量到那条线的右缘——引擎折行（`fillLines`）量到行末小节线为止，
 * 判「这行放不放得下」要用它，否则贴边的行差一条线宽就被引擎在断点之外再折一刀（393《非我惟主》1 页→2 页）。
 * 调用方先清掉换行，整首就是一组；源里有多组时各组各量（组内坐标）。
 */
export function naturalSpans(
  song: FanqieSong,
  idOf: ReadonlyMap<MusicElement, string | number>,
  m: JianpuGrid,
  ink: InkMeasurer,
): Map<string | number, NaturalSpan> {
  const out = new Map<string | number, NaturalSpan>();
  // 好几行（文本谱的歌词挂在每行源头，并不成一行）：后一行接在前一行末尾之后，整首一条坐标
  let base = 0;
  for (const page of song.pages) {
    for (const group of page.groups) {
      const row = group.voices[0];
      if (!row) continue;
      let right = base;
      const laid = layoutVoiceLine(row, m, { meter: song.metadata.meters[0] });
      for (const it of laid.items) it.syllables = new Array(row.lyrics.length).fill(null);
      assignLyrics(laid.items, row.lyrics);
      const nat = naturalColumns([laid], m, ink);
      let owner: string | number | null = null;
      for (const it of laid.items) {
        if (it.element.kind === "barline") {
          const sp = owner === null ? undefined : out.get(owner);
          if (sp) sp.x1b = Math.max(sp.x1b ?? sp.x1, base + (nat.rightOf.get(it) ?? 0));
          continue;
        }
        if (it.element.kind === "note") owner = idOf.get(it.element) ?? null;
        else if (it.element.kind !== "sustain") continue;
        if (owner === null) continue;
        const x0 = base + (nat.leftOf.get(it) ?? 0);
        const x1 = base + (nat.rightOf.get(it) ?? 0);
        right = Math.max(right, x1);
        const prev = out.get(owner);
        out.set(owner, prev ? { ...prev, x0: Math.min(prev.x0, x0), x1: Math.max(prev.x1, x1) } : { x0, x1 });
      }
      base = right;
    }
  }
  return out;
}
