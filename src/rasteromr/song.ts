// 位图五线谱**整曲**识别：几份底本（每份一个 PDF，图片先包成单页 PDF）逐页 `recognizeRasterPage`，
// 调号拍号跨页沿用，收尾做结构性半截小节认定、拉丁段挪后、跨系统连接，写成 MusicXML。
//
// 原先这段在私有仓库的回归脚本里，编辑器要接位图五线谱识别，搬进来成为**唯一一份**：回归脚本与编辑器走同一条路，
// 读数才对得上。不碰 DOM（Node 与浏览器都跑）；OCR 两种来法——离线缓存（回归脚本，`caches`）或在线识别（编辑器，`live`）。

import type { RasterGlyphLookup } from "./rasterglyphs";
import type { RasterPage } from "./rasterpage";
import { recognizeRasterPage, type CarryKey, type RasterLiveOcr, type RasterPageResult } from "./recognize";
import type { OcrChar } from "./lyric";
import type { JianpuRow } from "./jianpufuse";
import type { HeaderCredit, WordLine } from "../omrkit/headertext";
import type { Rect } from "../omrkit/types";
import { markSplitBars } from "../staffomr/notedata";
import { buildScore } from "../staffomr/score";
import type { StaffReviewResult, StaffReviewStats } from "../staffomr/review";
import { scoreToMusicXml } from "../staffomr/toxml";
import type { Staff } from "../staffomr/model";
import type { StaffNote } from "../staffomr/notedata";
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
    onPage?: (done: number, total: number) => void;
    /** 返回 true = 取消（逐页之间查一次） */
    cancelled?: () => boolean;
    /** 判路时已栅格化过的页（第几份底本、第几页 → 结果）：识别那一页时直接用 */
    rastered?: (source: number, pn: number) => RasterPage | null | undefined;
    /** 给每个 `<note>` 写 `id="omr<k>"` 并记下源图框（编辑器的识别对照用；回归脚本不开，产物逐字节不变） */
    noteIds?: boolean;
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
  const barPages: Parameters<typeof markSplitBars>[0] = [];
  const total = sources.reduce((n, s) => n + (s.pdf.numPages as number), 0);
  let done = 0;
  /** 曲首页（第一页有谱的）的页眉 */
  let header: HeaderCredit[] | null = null;
  /** 整页文字框：离线给的缓存，在线识别时逐页现检补进来 */
  const pageTexts = opts.pageTexts ?? new Map<string, Rect[]>();
  for (const [si, { pdf, OPS }] of sources.entries()) {
    for (let pn = 1; pn <= (pdf.numPages as number); pn++) {
      if (opts.cancelled?.()) throw new Error("已取消");
      const page = await pdf.getPage(pn);
      try {
        const caches: RasterOcrCaches = { lyricOcr: opts.lyricOcr, labelOcr: opts.labelOcr, timeOcr: opts.timeOcr, harmonyOcr: opts.harmonyOcr, jianpuOcr: opts.jianpuOcr, wordOcr: opts.wordOcr, headerOcr: opts.headerOcr, pageTexts };
        const wantHeader = header === null;
        const r = await recognizeRasterPage(page, OPS, look, pn, { carryTime, carryKey, ...caches, live: opts.live, raster: opts.rastered?.(si, pn), wantHeader });
        if (r.jianpuFix) for (const k of Object.keys(stats.jianpuFix) as (keyof RasterSongStats["jianpuFix"])[]) stats.jianpuFix[k] += r.jianpuFix[k];
        carryTime = r.carryTime;
        carryKey = r.carryKey;
        if (r.hasStaff) {
          if (wantHeader) header = r.header;
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
          for (const n of r.notes) {
            const a = notesByStaff.get(n.staff) ?? [];
            a.push(n);
            notesByStaff.set(n.staff, a);
          }
          pages.push({ source: si, pn, result: r });
        }
      } finally {
        page.cleanup?.();
      }
      opts.onPage?.(++done, total);
    }
  }
  // 自检：凑满拍的，加上结构上的半截小节（弱起、乐句中间劈开的两半，见 `notedata.ts::markSplitBars`）
  markSplitBars(barPages);
  for (const { bars } of barPages) stats.full += bars.filter((b) => b.full || b.split).length;
  // 音符 id 与源图框：逐页逐音编号，记在音符上（写出前音符会被复制，复制品带着它），重建时 id 不变
  const noteBoxes: RasterSongResult["noteBoxes"] = new Map();
  if (opts.noteIds) {
    let k = 0;
    pages.forEach(({ result }, pi) => {
      for (const n of result.notes) {
        const id = `omr${++k}`;
        n.omrId = id;
        noteBoxes.set(id, { page: pi, box: { ...n.sym.box }, step: n.step, octave: n.octave, alter: n.alter, rest: n.rest });
      }
    });
  }
  const noteId = opts.noteIds ? (n: StaffNote): string | undefined => n.omrId : undefined;
  const notesOf = (st: Staff): StaffNote[] => notesByStaff.get(st) ?? [];
  const emptyAssign = (): number[][] => [];
  if (!entries.length) return { xml: null, score: null, stats, pages, noteBoxes, assignment: emptyAssign, rebuild: () => { throw new Error("没有谱表"); } };
  // 拉丁段挪到全曲中文段后面（页内先占位，见 `lyricpost.ts::settleLyricVerses`）
  settleLyricVerses([...notesByStaff.values()].flat());
  let score = buildScore(entries);
  const credits = (header ?? []).map(({ text, type, justify }) => ({ text, type, justify }));
  // 没给标题（编辑器里打开的图、PDF）就拿页眉的头一个标题
  const title = opts.title ?? credits.find((c) => c.type === "title")?.text;
  const xml = scoreToMusicXml(score, notesOf, { title, credits, ...(noteId ? { noteId } : {}) });
  stats.systems = score.systems.length;
  stats.parts = score.parts.length;
  return {
    xml, score, stats, pages, noteBoxes,
    assignment: () => score.systems.map((e, si) => e.sys.staves.map((st) => score.scoreStaves.findIndex((ss) => ss.staves[si] === st))),
    rebuild: (slots) => {
      score = buildScore(entries, { slots });
      return { xml: scoreToMusicXml(score, notesOf, { title, credits, ...(noteId ? { noteId } : {}) }), score };
    },
  };
}
