// 位图五线谱**整曲**识别：几份底本（每份一个 PDF，图片先包成单页 PDF）逐页 `recognizeRasterPage`，
// 调号拍号跨页沿用，收尾做结构性半截小节认定、拉丁段挪后、跨系统连接，写成 MusicXML。
//
// 原先这段在私有仓库的回归脚本里，编辑器要接位图五线谱识别，搬进来成为**唯一一份**：回归脚本与编辑器走同一条路，
// 读数才对得上。不碰 DOM（Node 与浏览器都跑）；OCR 两种来法——离线缓存（回归脚本，`caches`）或在线识别（编辑器，`live`）。

import type { RasterGlyphLookup } from "./rasterglyphs";
import type { RasterPage } from "./rasterpage";
import { recognizeRasterPage, type RasterStage, type CarryKey, type PageCarry, type RasterLiveOcr, type RasterPageResult } from "./recognize";
import { pageImageOf, type PageImage } from "./rasterpage";
import { composeHeaderStrip } from "./pagecompose";
import type { PagePool } from "./pagepool";
import type { OcrChar } from "./lyric";
import type { JianpuRow } from "./jianpufuse";
import type { HeaderCredit, WordLine } from "../omrkit/headertext";
import type { Rect } from "../omrkit/types";
import { markSplitBars } from "../staffomr/notedata";
import { buildScore, restructureSystems, type StaffProfile } from "../staffomr/score";
import { type StaffReviewResult, type StaffReviewStats, numberOmrIds } from "../staffomr/review";
import { pageTextPt, scoreToMusicXml } from "../staffomr/toxml";
import type { SPage, Staff } from "../staffomr/model";
import type { LyricLine } from "../staffomr/textanalyze";
import type { StaffNote } from "../staffomr/notedata";
import type { WedgeOpen } from "../staffomr/notations";
import { settleLyricVerses } from "./lyricpost";

/** 离线缓存（回归脚本用）：按条的内容指纹寻址。 */
export interface RasterOcrCaches {
  lyricOcr?: Map<string, OcrChar[]>;
  labelOcr?: Map<string, string>;
  timeOcr?: Map<string, string>;
  harmonyOcr?: Map<string, OcrChar[]>;
  jianpuOcr?: Map<string, JianpuRow[]>;
  wordOcr?: Map<string, WordLine[]>;
  headerOcr?: Map<string, WordLine[]>;
  /** 整页文字框（`gen-rastertext.mjs`），按页指纹寻址。见 `pagetext.ts`。 */
  pageTexts?: Map<string, Rect[]>;
}

export type RasterSongStats = StaffReviewStats;
export type RasterSongResult = StaffReviewResult<RasterPageResult>;

/**
 * 整曲识别。`sources` 每项是一份打开了的 PDF（pdf.js 的文档对象与 OPS 表）。
 * 每页一趟：有 `live` 时识别走到哪一处要 OCR（整页文字框、和弦带、拍号条、声部标签、歌词条、简谱行、文字指示、页眉），
 * 就当场把那一处切出的条送 `live`（`recognizeRasterPage`）；没有 `live` 就查 `caches`。
 */
export async function recognizeRasterSong(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sources: readonly { pdf: any; OPS: any }[],
  look: RasterGlyphLookup,
  opts: RasterOcrCaches & {
    title?: string;
    live?: RasterLiveOcr;
    /** 每认完一页（串行时会等它返回：回归测试据此逐页切行覆盖） */
    onPage?: (done: number, total: number) => void | Promise<void>;
    /** 返回 true = 取消（逐页之间查一次） */
    cancelled?: () => boolean;
    /** 判路时已栅格化过的页（第几份底本、第几页 → 结果）：识别那一页时直接用 */
    rastered?: (source: number, pn: number) => RasterPage | null | undefined;
    /** 多页并行（`pagepool.ts`）：给了就各页分给 Worker 跑，结果与串行逐字一致 */
    pool?: PagePool;
    /** 给每个 `<note>` 写 `id="omr<k>"` 并记下源图框（编辑器的识别对照用；回归脚本不开，产物逐字节不变） */
    noteIds?: boolean;
    /** 逐页各阶段的中间产物（`recognize.ts::RasterStage`，回归测试的阶段快照）。多页并行时 Worker 发回的是它那头
     *  `servePageWorker` 的 `project` 投影过的数据；Worker 入口没给 `project` 就收不到 */
    trace?: (pageSeq: number, stage: RasterStage, data: unknown) => void;
  } = {},
): Promise<RasterSongResult> {
  const entries: Parameters<typeof buildScore>[0] = [];
  const notesByStaff = new Map<Staff, StaffNote[]>();
  const stats: RasterSongStats = {
    notes: 0, harmonies: 0, lyricLines: 0, lyricStats: { rows: 0, hit: 0, parity: 0 },
    bars: 0, full: 0, unknown: 0, staves: 0, pages: 0, halftone: null, kind: null,
    jianpuFix: { pairs: 0, pitch: 0, duration: 0, removed: 0, inserted: 0 },
  };
  const pages: RasterSongResult["pages"] = [];
  let carryTime: { beats: number; beatType: number } | undefined;
  let carryKey: CarryKey | undefined;
  let openWedges: (WedgeOpen | null)[] | undefined;
  /** 上一页末系统「可能」续出的松叶那截写了止的音：这一页认了续段就撤掉 */
  let openStops: (StaffNote | null)[] = [];
  const barPages: Parameters<typeof markSplitBars>[0] = [];
  /** 闭合人声谱：两行谱之间印着歌词的上一行（见 `buildScore` 的同名选项） */
  const lyricsBelow = new Set<Staff>();
  /** 谱面印的声部标签（`recognize.ts` 的 `staffLabels`，按谱行认回对象） */
  const labelOf = new Map<Staff, string>();
  const total = sources.reduce((n, s) => n + (s.pdf.numPages as number), 0);
  let done = 0;
  /** 曲首页（第一页有谱的）的页眉 */
  let header: HeaderCredit[] | null = null;
  let headerPage: SPage | null = null;
  /** 整页文字框：离线给的缓存，在线识别时逐页现检补进来 */
  const pageTexts = opts.pageTexts ?? new Map<string, Rect[]>();
  const caches: RasterOcrCaches = { lyricOcr: opts.lyricOcr, labelOcr: opts.labelOcr, timeOcr: opts.timeOcr, harmonyOcr: opts.harmonyOcr, jianpuOcr: opts.jianpuOcr, wordOcr: opts.wordOcr, headerOcr: opts.headerOcr, pageTexts };
  /** 收一页结果（按页序）：记账、留页，交出下一页的沿用 */
  const consume = (r: RasterPageResult, si: number, pn: number, wantHeader: boolean): void => {
    if (r.jianpuFix) for (const k of Object.keys(stats.jianpuFix) as (keyof RasterSongStats["jianpuFix"])[]) stats.jianpuFix[k] += r.jianpuFix[k];
    carryTime = r.carryTime;
    carryKey = r.carryKey;
    for (const row of r.wedgeRows?.took ?? []) {
      const n = openStops[row];
      if (!n) continue;
      delete n.wedgeStop;
      delete n.wedgeStopAfter;
      delete n.wedgeStopAt;
    }
    openWedges = r.wedgeRows?.open;
    openStops = r.wedgeRows?.stops ?? [];
    if (r.hasStaff) {
      if (wantHeader) {
        header = r.header;
        headerPage = r.page;
      }
      // 页眉带近乎半页像素，读完就不留
      r.headerStrips = [];
      stats.pages++;
      stats.notes += r.notes.length;
      stats.harmonies += r.harmonies?.length ?? 0;
      stats.lyricLines += r.lyricLines.length;
      for (const k of Object.keys(stats.lyricStats) as (keyof RasterSongStats["lyricStats"])[]) stats.lyricStats[k] += r.lyricStats?.[k] ?? 0;
      stats.bars += r.bars.length;
      barPages.push({ page: r.page, bars: r.bars });
      stats.unknown += r.unknown;
      stats.staves += r.page.staves.length;
      stats.halftone ??= r.raster?.halftone ?? null;
      stats.kind ??= r.raster?.kind ?? null;
      entries.push({ page: r.page, ctx: r.ctx });
      markLyricsBelow(r.page, r.lyricLines, lyricsBelow);
      for (const st of r.page.staves) {
        const lb = r.staffLabels.get(st.index);
        if (lb) labelOf.set(st, lb);
      }
      for (const n of r.notes) {
        const a = notesByStaff.get(n.staff) ?? [];
        a.push(n);
        notesByStaff.set(n.staff, a);
      }
      pages.push({ source: si, pn, result: r });
    }
  };
  const order = sources.flatMap(({ pdf }, si) => Array.from({ length: pdf.numPages as number }, (_, i) => ({ si, pn: i + 1 })));
  if (!opts.pool) {
    for (const [k, { si, pn }] of order.entries()) {
      if (opts.cancelled?.()) throw new Error("已取消");
      const { pdf, OPS } = sources[si];
      const page = await pdf.getPage(pn);
      try {
        const wantHeader = header === null;
        const r = await recognizeRasterPage(page, OPS, look, pn, { carryTime, carryKey, openWedges, ...caches, live: opts.live, raster: opts.rastered?.(si, pn), wantHeader, pageSeq: k, trace: opts.trace && ((st, d) => opts.trace!(k, st, d)) });
        consume(r, si, pn, wantHeader);
      } finally {
        page.cleanup?.();
      }
      done++;
      await opts.onPage?.(done, total);
    }
  } else {
    // 多页并行（`pagepool.ts`）：在途页数不超过池大小；按页序收结果，收到一页就把下一页的沿用交出去
    const pool = opts.pool;
    pool.init(look, caches, opts.live);
    const carries = order.map(() => {
      let resolve!: (c: PageCarry) => void;
      const promise = new Promise<PageCarry>((r) => (resolve = r));
      return { promise, resolve };
    });
    carries[0]?.resolve({ carryTime, carryKey, wantHeader: true });
    const start = async (k: number): Promise<RasterPageResult> => {
      const { si, pn } = order[k];
      const { pdf, OPS } = sources[si];
      const raster = opts.rastered?.(si, pn);
      let image: PageImage | null | undefined;
      if (raster === undefined) {
        const page = await pdf.getPage(pn);
        try {
          image = await pageImageOf(page, OPS);
        } finally {
          page.cleanup?.();
        }
      }
      const host = {
        live: opts.live,
        composeHeader: async (binW: number) => {
          const page = await pdf.getPage(pn);
          try {
            return await composeHeaderStrip(page, OPS, binW);
          } finally {
            page.cleanup?.();
          }
        },
        ...(opts.trace ? { trace: (st: RasterStage, d: unknown) => opts.trace!(k, st, d) } : {}),
      };
      return pool.run({ index: pn, seq: k, image, raster, ...(opts.trace ? { trace: true } : {}) }, carries[k].promise, host);
    };
    const running: Promise<RasterPageResult>[] = [];
    let next = 0;
    const fill = () => {
      while (next < order.length && next - done < pool.size) {
        const p = start(next++);
        p.catch(() => undefined); // 由按页序的 await 接住
        running.push(p);
      }
    };
    fill();
    for (let k = 0; k < order.length; k++) {
      if (opts.cancelled?.()) throw new Error("已取消");
      const r = await running[k];
      const wantHeader = header === null;
      consume(r, order[k].si, order[k].pn, wantHeader);
      carries[k + 1]?.resolve({ carryTime, carryKey, wantHeader: header === null, openWedges });
      done++;
      void opts.onPage?.(done, total);
      fill();
    }
  }
  settleEdgeSlurStarts(entries.map((e) => e.page), notesByStaff);
  // 自检：凑满拍的，加上结构上的半截小节（弱起、乐句中间劈开的两半，见 `notedata.ts::markSplitBars`）
  markSplitBars(barPages);
  for (const { bars } of barPages) stats.full += bars.filter((b) => b.full || b.split).length;
  // 音符与歌词、文字、力度、弧的 id 与源图框：逐页逐音编号，记在各自身上（写出前音符会被复制，复制品带着它），重建时 id 不变
  const noteBoxes: RasterSongResult["noteBoxes"] = new Map();
  const markBoxes: RasterSongResult["markBoxes"] = new Map();
  const arcId = opts.noteIds ? numberOmrIds(pages.map(({ result }) => result), noteBoxes, markBoxes) : undefined;
  const idOpts = opts.noteIds ? { noteId: (n: StaffNote): string | undefined => n.omrId, arcId } : {};
  const notesOf = (st: Staff): StaffNote[] => notesByStaff.get(st) ?? [];
  const emptyAssign = (): number[][] => [];
  if (!entries.length) return { xml: null, score: null, stats, pages, noteBoxes, markBoxes, assignment: emptyAssign, rebuild: () => { throw new Error("没有谱表"); } };
  // 拉丁段挪到全曲中文段后面（页内先占位，见 `lyricpost.ts::settleLyricVerses`）
  settleLyricVerses([...notesByStaff.values()].flat());
  // 内容剖面（有没有词、音域中位数、谱面标签）交给 `buildScore` 做全局指派，见 `score.ts::assignSlots`
  const profileOf = (st: Staff): StaffProfile => {
    const ns = notesOf(st);
    const ps = ns
      .filter((n) => !n.rest && !n.grace && n.step)
      .map((n) => "CDEFGAB".indexOf(n.step!) + 7 * n.octave!)
      .sort((a, b) => a - b);
    return { lyric: ns.some((n) => n.lyrics?.length), pitch: ps.length ? ps[ps.length >> 1]! : null, label: labelOf.get(st) ?? null };
  };
  // 简线混排谱（认出了简谱行）：单行谱表的系统都归 P1
  const soloToFirst = pages.some((p) => p.result.jianpuStrips.length > 0);
  let score = buildScore(entries, { lyricsBelow, profileOf, soloToFirst });
  const credits = (header ?? []).map(({ text, type, justify, size, box }) => ({ text, type, justify, box, ...(headerPage ? { size: pageTextPt(headerPage, size) } : {}) }));
  // 没给标题（编辑器里打开的图、PDF）就拿页眉的头一个标题
  const title = opts.title ?? credits.find((c) => c.type === "title")?.text;
  const xml = scoreToMusicXml(score, notesOf, { title, credits, crossPageTies: true, ...idOpts });
  stats.systems = score.systems.length;
  stats.parts = score.parts.length;
  return {
    xml, score, stats, pages, noteBoxes, markBoxes,
    assignment: () => score.systems.map((e, si) => e.sys.staves.map((st) => score.scoreStaves.findIndex((ss) => ss.staves[si] === st))),
    rebuild: (slots) => {
      score = buildScore(entries, { slots, lyricsBelow });
      return { xml: scoreToMusicXml(score, notesOf, { title, credits, crossPageTies: true, ...idOpts }), score };
    },
    restructure: (op) => {
      if (!restructureSystems(entries, op)) return null;
      score = buildScore(entries, { lyricsBelow, profileOf, soloToFirst });
      return { xml: scoreToMusicXml(score, notesOf, { title, credits, crossPageTies: true, ...idOpts }), score };
    },
  };
}

/** 同一系统里上下紧挨着的两行谱之间有一行歌词（不管挂在哪一行上），记下上面那行。 */
function markLyricsBelow(page: SPage, lines: readonly LyricLine[], out: Set<Staff>): void {
  for (const sys of page.systems) {
    const rows = [...sys.staves].sort((a, b) => a.box.top - b.box.top);
    for (let k = 0; k + 1 < rows.length; k++) {
      const up = rows[k];
      const down = rows[k + 1];
      if (lines.some((l) => l.syllables.length && l.top > up.box.bottom && l.top < down.box.top)) out.add(up);
    }
  }
}

/**
 * 页上第一个系统行首起笔、只挂了止端的弧（`StaffNote.slurEdgeCands`，见 `slurattach.ts::attachEdgeSlurStarts`）：
 * 上一页末系统同一行谱（两系统行数相同才按行序对，不同的不补）没有行尾的半截（`slurOrphans` 里 `edge: "end"`）可接，就是从首音起的弧，补上起端；
 * 有的留给写出端跨页接（`toxml.ts::renumberSlurs`）。宁静的伯利恒 p4 m47、p6 m75 钢琴右手。
 */
function settleEdgeSlurStarts(pages: SPage[], notesByStaff: Map<Staff, StaffNote[]>): void {
  for (let k = 1; k < pages.length; k++) {
    const ps = pages[k - 1].systems.filter((sy) => sy.staves.length);
    const prev = ps[ps.length - 1], cur = pages[k].systems.filter((sy) => sy.staves.length)[0];
    if (!cur) continue;
    const dangles = (st: Staff) => (notesByStaff.get(st) ?? []).some((n) => n.slurOrphans?.some((o) => o.edge === "end"));
    // 上一页末系统整个没有行尾半截：这一页行首的弧都不是接过来的，照补；有的话按行对，对上的那行没有行尾半截才补
    const anyDangle = !!prev && prev.staves.some(dangles);
    // 行数不同按从下往上对（多出、隐藏的多是最上面的人声谱表，钢琴总在最下）
    const shift = prev ? cur.staves.length - prev.staves.length : 0;
    cur.staves.forEach((st, i) => {
      const ns = notesByStaff.get(st) ?? [];
      const firsts = ns.filter((n) => n.slurEdgeCands?.length);
      if (!firsts.length) return;
      if (anyDangle) {
        const pst = prev!.staves[i - shift];
        if (!pst || dangles(pst)) return;
      }
      for (const f of firsts)
        for (const c of f.slurEdgeCands!) {
          const to = ns.find((n) => n.slurOrphans?.some((o) => o.id === c.id && o.edge === "begin"));
          if (!to) continue;
          to.slurOrphans = to.slurOrphans!.filter((o) => o.id !== c.id);
          f.slurStart = true;
          f.slurAbove ??= c.above;
          f.slurStartIds = [...(f.slurStartIds ?? []), c.id];
        }
    });
  }
}
