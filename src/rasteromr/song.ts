// 位图五线谱**整曲**识别：几份底本（每份一个 PDF，图片先包成单页 PDF）逐页 `recognizeRasterPage`，
// 调号拍号跨页沿用，收尾做结构性半截小节认定、拉丁段挪后、跨系统连接，写成 MusicXML。
//
// 原先这段在私有仓库的回归脚本里，编辑器要接位图五线谱识别，搬进来成为**唯一一份**：回归脚本与编辑器走同一条路，
// 读数才对得上。不碰 DOM（Node 与浏览器都跑）；OCR 两种来法——离线缓存（回归脚本，`caches`）或在线识别（编辑器，`live`）。

import type { RasterGlyphLookup } from "./rasterglyphs";
import { recognizeRasterPage, settleLyricVerses, type CarryKey, type RasterPageResult } from "./recognize";
import type { HarmonyStrip } from "./harmony";
import type { LyricStrip, OcrChar } from "./lyric";
import type { LabelStrip } from "./stafflabel";
import type { TimeStrip } from "./timesig";
import type { JianpuStrip } from "./jianpuband";
import type { JianpuRow } from "./jianpufuse";
import type { HeaderCredit, WordLine, WordStrip } from "./words";
import { markSplitBars } from "../staffomr/notedata";
import { buildScore, type StaffScore } from "../staffomr/score";
import { scoreToMusicXml } from "../staffomr/toxml";
import type { Staff } from "../staffomr/model";
import type { StaffNote } from "../staffomr/notedata";

/** 离线缓存（回归脚本用）：按条的内容指纹寻址。 */
export interface RasterOcrCaches {
  lyricOcr?: Map<string, OcrChar[]>;
  labelOcr?: Map<string, string>;
  timeOcr?: Map<string, string>;
  harmonyOcr?: Map<string, OcrChar[]>;
  jianpuOcr?: Map<string, JianpuRow[]>;
  wordOcr?: Map<string, WordLine[]>;
  headerOcr?: Map<string, WordLine[]>;
}

/** 在线识别（编辑器用）：把一页切出来的条送 OCR，回同形的表（`ocrlive.ts`）。 */
export interface RasterLiveOcr {
  harmony(strips: readonly HarmonyStrip[]): Promise<Map<string, OcrChar[]>>;
  lyric(strips: readonly LyricStrip[]): Promise<Map<string, OcrChar[]>>;
  label(strips: readonly LabelStrip[]): Promise<Map<string, string>>;
  /** 拍号数字条（可缺：缺了拍号只靠模板）。 */
  time?(strips: readonly TimeStrip[]): Promise<Map<string, string>>;
  jianpu(strips: readonly JianpuStrip[]): Promise<Map<string, JianpuRow[]>>;
  /** 文字指示带（可缺：缺了就不出 `<words>`）。 */
  word?(strips: readonly WordStrip[]): Promise<Map<string, WordLine[]>>;
  /** 页眉带（可缺：缺了就不出 `<credit>`）。 */
  header?(strips: readonly WordStrip[]): Promise<Map<string, WordLine[]>>;
}

export interface RasterSongStats {
  notes: number;
  harmonies: number;
  lyricLines: number;
  lyricStats: { rows: number; hit: number; parity: number };
  bars: number;
  full: number;
  unknown: number;
  staves: number;
  pages: number;
  halftone: number | null;
  kind: string | null;
  jianpuFix: { pairs: number; pitch: number; duration: number; removed: number; inserted: number };
  systems?: number;
  parts?: number;
}

export interface RasterSongResult {
  xml: string | null;
  score: StaffScore | null;
  stats: RasterSongStats;
  /** 有谱的各页的识别结果（第几份底本、第几页）：对照视图要它的位图与音符坐标。
   *  `scale`：页面结构（`result.page` 的谱线坐标）乘它才是位图像素——矢量 PDF 那一路按 PDF 点识别、渲成位图时放大了（缺省 1） */
  pages: { source: number; pn: number; result: RasterPageResult; scale?: number }[];
  /** `noteIds` 时：写进 `<note id>` 的 id → 第几页（`pages` 下标）、源图上的框（位图像素） */
  noteBoxes: Map<string, { page: number; box: { left: number; right: number; top: number; bottom: number }; step: string; octave: number; alter: number; rest: boolean }>;
  /** 各系统各谱行现在指派到第几个声部行（`buildScore` 的结果；关联表的初值） */
  assignment(): number[][];
  /** 按新的指派（`slots[系统][谱行]`，-1 忽略）重建 MusicXML，不重跑识别 */
  rebuild(slots: number[][]): { xml: string; score: StaffScore };
}

/**
 * 整曲识别。`sources` 每项是一份打开了的 PDF（pdf.js 的文档对象与 OPS 表）。
 * 有 `live` 时每页跑三趟：先取和弦带送 OCR（和弦字母在找符头之前认领，不带它切出的歌词条会多出「和弦行」），
 * 再带着和弦取歌词条、声部标签条、简谱行送 OCR，最后带全部结果出这一页。没有 `live` 就用 `caches` 一趟出。
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
  for (const [si, { pdf, OPS }] of sources.entries()) {
    for (let pn = 1; pn <= (pdf.numPages as number); pn++) {
      if (opts.cancelled?.()) throw new Error("已取消");
      const page = await pdf.getPage(pn);
      try {
        let caches: RasterOcrCaches = { lyricOcr: opts.lyricOcr, labelOcr: opts.labelOcr, timeOcr: opts.timeOcr, harmonyOcr: opts.harmonyOcr, jianpuOcr: opts.jianpuOcr, wordOcr: opts.wordOcr, headerOcr: opts.headerOcr };
        const wantHeader = header === null;
        if (opts.live) {
          const r1 = await recognizeRasterPage(page, OPS, look, pn, { carryTime, carryKey });
          if (r1.hasStaff) {
            // 拍号条在找符头之前就切好了，不受后面几张表影响：与和弦带同一趟送
            const [harmonyOcr, timeOcr] = await Promise.all([opts.live.harmony(r1.harmonyStrips), opts.live.time?.(r1.timeStrips)]);
            if (opts.cancelled?.()) throw new Error("已取消");
            const r2 = await recognizeRasterPage(page, OPS, look, pn, { carryTime, carryKey, harmonyOcr, timeOcr, wantWordStrips: !!opts.live.word, wantHeader: wantHeader && !!opts.live.header });
            const [lyricOcr, labelOcr, jianpuOcr, wordOcr, headerOcr] = await Promise.all([
              opts.live.lyric(r2.lyricStrips),
              opts.live.label(r2.labelStrips),
              opts.live.jianpu(r2.jianpuStrips),
              opts.live.word?.(r2.wordStrips),
              r2.headerStrips.length ? opts.live.header?.(r2.headerStrips) : undefined,
            ]);
            if (opts.cancelled?.()) throw new Error("已取消");
            caches = { harmonyOcr, timeOcr, lyricOcr, labelOcr, jianpuOcr, wordOcr, headerOcr };
          }
        }
        const r = await recognizeRasterPage(page, OPS, look, pn, { carryTime, carryKey, ...caches, wantHeader });
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
  // 拉丁段挪到全曲中文段后面（页内先占位，见 `recognize.ts::settleLyricVerses`）
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
