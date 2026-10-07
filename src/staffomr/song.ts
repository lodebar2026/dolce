// 矢量五线谱**整曲**识别：一份打开了的 PDF 逐页 `recognizeStaffPage`，拍号跨页沿用，收尾做跨系统连接、页眉，写成 MusicXML。
//
// 原先这段在 `browser.ts` 里（那个文件靠 Vite 加载 pdfjs，Node 用不了）。抽出来与位图路的 `rasteromr/song.ts` 同一个做法：
// 编辑器与回归脚本（合唱谱 `chorus-ops.mjs`）走同一份代码，读数才对得上。不碰 DOM。
import type { OpsEnum } from "../omr/vector";
import { extractTextPage } from "../omr/vectext";
import { musicFamily } from "./symbolmap";
import type { StaffGlyphLookup } from "./staffglyphs";
import type { TextGlyphLookup } from "./textglyphs";
import { recognizeStaffPage, vectorPageCredits } from "./index";
import { buildScore } from "./score";
import { scoreToMusicXml } from "./toxml";
import type { StaffNote } from "./notedata";
import type { Staff } from "./model";

/**
 * 这份 PDF 是不是「文字层完整的五线谱」——也就是该不该走 `src/staffomr/` 这条路。
 *
 * 判据：取样几页，页面上要有**音乐字体的文字**（Maestro/Opus/Anastasia 一系）。
 * 没有文字层的（500 首那种全部转曲的）与只有正文字体的（歌词页）都不算。
 * 与 `vector.ts::isVectorPdf` 互补：那条判的是「转曲矢量谱」。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function isStaffPdf(pdf: any, OPS: OpsEnum, sampleCount = 5): Promise<boolean> {
  const n = pdf.numPages as number;
  const picks: number[] = [];
  for (let k = 1; k <= sampleCount; k++) picks.push(Math.max(1, Math.min(n, Math.round((n * k) / (sampleCount + 1)))));
  let musicGlyphs = 0;
  for (const pn of picks) {
    const page = await pdf.getPage(pn);
    const runs = await extractTextPage(page, OPS, { scale: 1, withOutlines: false });
    for (const r of runs) if (musicFamily(r.font)) musicGlyphs += r.glyphs.length;
    page.cleanup?.();
    if (musicGlyphs > 50) return true;
  }
  return false;
}

export interface StaffPdfResult {
  musicxml: string;
  pages: number;
  notes: number;
  parts: number;
  /** 没有谱表的页（封面/目录/歌词页）。 */
  skipped: number;
  /** 原图对照与关联表要的东西（同位图那一路的 `RasterSongResult`，坐标是 PDF 点） */
  detail?: {
    pages: { pn: number; page: Parameters<typeof buildScore>[0][number]["page"]; notes: StaffNote[] }[];
    noteBoxes: Map<string, { page: number; box: { left: number; right: number; top: number; bottom: number }; step: string; octave: number; alter: number; rest: boolean }>;
    score: ReturnType<typeof buildScore>;
    assignment(): number[][];
    rebuild(slots: number[][]): { xml: string; score: ReturnType<typeof buildScore> };
  };
}

/** 整曲识别（PDF 已打开、字典已建好）。`noteIds` 时带上原图对照要的 `detail`。 */
export async function recognizeStaffDoc(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdf: any,
  OPS: OpsEnum,
  look: StaffGlyphLookup,
  textLookup: TextGlyphLookup | undefined,
  opts: { pages?: number[]; title?: string; onProgress?: (done: number, total: number) => void; noteIds?: boolean } = {},
): Promise<StaffPdfResult> {
  const list = opts.pages ?? Array.from({ length: pdf.numPages as number }, (_, i) => i + 1);
  const entries: { page: Parameters<typeof buildScore>[0][number]["page"]; ctx: Parameters<typeof buildScore>[0][number]["ctx"] }[] = [];
  const notesByStaff = new Map<Staff, StaffNote[]>();
  let carryTime: { beats: number; beatType: number } | undefined;
  let skipped = 0;
  const detailPages: NonNullable<StaffPdfResult["detail"]>["pages"] = [];
  let done = 0;
  for (const pn of list) {
    const page = await pdf.getPage(pn);
    const r = await recognizeStaffPage(page, OPS, look, pn, { textLookup, carryTime });
    carryTime = r.carryTime;
    if (r.hasStaff) {
      entries.push({ page: r.page, ctx: r.ctx });
      detailPages.push({ pn, page: r.page, notes: r.notes });
      for (const n of r.notes) {
        const a = notesByStaff.get(n.staff) ?? [];
        a.push(n);
        notesByStaff.set(n.staff, a);
      }
    } else skipped++;
    page.cleanup?.();
    opts.onProgress?.(++done, list.length);
  }
  // 内容剖面（有没有词、音域中位数）交给 `buildScore` 做全局指派，见 `score.ts::assignSlots`
  const score = buildScore(entries, {
    profileOf: (st) => {
      const ns = notesByStaff.get(st) ?? [];
      const ps = ns
        .filter((n) => !n.rest && !n.grace && n.step)
        .map((n) => "CDEFGAB".indexOf(n.step!) + 7 * n.octave!)
        .sort((a, b) => a - b);
      return { lyric: ns.some((n) => n.lyrics?.length), pitch: ps.length ? ps[ps.length >> 1] : null };
    },
  });
  // 原图对照：逐页逐音编号写进 `<note id>`、记下源框（同 `rasteromr/song.ts`）
  const noteBoxes: NonNullable<StaffPdfResult["detail"]>["noteBoxes"] = new Map();
  if (opts.noteIds) {
    let k = 0;
    detailPages.forEach(({ notes }, pi) => {
      for (const n of notes) {
        const id = `omr${++k}`;
        n.omrId = id;
        noteBoxes.set(id, { page: pi, box: { ...n.sym.box }, step: n.step ?? "C", octave: n.octave ?? 4, alter: n.alter ?? 0, rest: !!n.rest });
      }
    });
  }
  const notesOf = (st: Staff): StaffNote[] => notesByStaff.get(st) ?? [];
  // 页眉页脚只取曲首那一页（同位图路 `rasteromr/song.ts`）
  const credits = entries.length ? vectorPageCredits(entries[0].page).map(({ text, type, justify }) => ({ text, type, justify })) : [];
  const title = opts.title ?? credits.find((c) => c.type === "title")?.text;
  const xmlOpts = { title, credits, ...(opts.noteIds ? { noteId: (n: StaffNote) => n.omrId } : {}) };
  const musicxml = scoreToMusicXml(score, notesOf, xmlOpts);
  let notes = 0;
  for (const v of notesByStaff.values()) notes += v.length;
  let cur = score;
  // 页、音符与声部结构总是带上（回归脚本按系统切行要用）；`noteIds` 只管写不写 `<note id>` 与源框
  const detail: StaffPdfResult["detail"] = {
    pages: detailPages, noteBoxes, score,
    assignment: () => cur.systems.map((e, si) => e.sys.staves.map((st) => cur.scoreStaves.findIndex((ss) => ss.staves[si] === st))),
    rebuild: (slots) => {
      cur = buildScore(entries, { slots });
      return { xml: scoreToMusicXml(cur, notesOf, xmlOpts), score: cur };
    },
  };
  return { musicxml, pages: list.length, notes, parts: score.parts.length, skipped, ...(detail ? { detail } : {}) };
}
