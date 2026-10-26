// 转曲矢量谱**整曲**识别：逐页 `recognizeOutlinedPage`，拍号跨页沿用，收尾做跨系统连接、页眉，写成 MusicXML。
// 照矢量路 `staffomr/song.ts::recognizeStaffDoc` 的样子，交出同一个形状（`StaffPdfResult`），编辑器的落地、
// 原图对照（`staffomr/browser.ts::vectorOverlayResult`）不用另写。不碰 DOM。
import { extractVectorPage, type OpsEnum } from "../omrkit/vector";
import type { StaffPdfResult } from "../staffomr/song";
import { buildScore, measureNumbering, restructureSystems, type StaffProfile } from "../staffomr/score";
import { scoreToMusicXml, type StaffXmlOptions } from "../staffomr/toxml";
import type { StaffNote } from "../staffomr/notedata";
import type { Staff } from "../staffomr/model";
import { numberOmrIds } from "../staffomr/review";
import type { RasterLiveOcr } from "../rasteromr/recognize";
import type { FuseStats } from "../rasteromr/jianpufuse";
import type { OutlineGlyphLookup } from "./glyphs";
import { recognizeOutlinedPage, staffGroups } from "./page";

/**
 * 这份 PDF 是不是**转曲的五线谱**：取样几页，没有文字层，路径里有五条一组的等距长横线。
 * 文字层完整的五线谱（`isStaffPdf`）先判，那条判不上才轮到这里；只有内嵌位图的扫描件也判否（交位图路）。
 */
export async function isOutlinedStaffPdf(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdf: any,
  OPS: OpsEnum,
  sampleCount = 3,
): Promise<boolean> {
  const n = pdf.numPages as number;
  const picks = new Set<number>();
  for (let k = 1; k <= sampleCount; k++) picks.add(Math.max(1, Math.min(n, Math.round((n * k) / (sampleCount + 1)))));
  for (const pn of picks) {
    const page = await pdf.getPage(pn);
    try {
      const tc = await page.getTextContent();
      if (tc.items.some((it: { str?: string }) => it.str?.trim())) continue;
      const vec = await extractVectorPage(page, OPS, { scale: 1 });
      if (vec.extras?.images.length) continue;
      if (staffGroups(vec.objs, vec.width)) return true;
    } finally {
      page.cleanup?.();
    }
  }
  return false;
}

export interface OutlinedPdfResult extends StaffPdfResult {
  /** 认出了简谱行（简线混排谱）：编辑器进混排档 */
  jianpu: boolean;
  stats: { notes: number; harmonies: number; lyricRows: number; jianpuFix: FuseStats };
}

/** 整曲识别（PDF 已打开）。`live` 是在线 OCR（编辑器）或缓存查表（回归脚本），不给就只出音符。 */
export async function recognizeOutlinedDoc(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdf: any,
  OPS: OpsEnum,
  look: OutlineGlyphLookup,
  opts: { title?: string; live?: RasterLiveOcr; onProgress?: (done: number, total: number) => void; noteIds?: boolean } = {},
): Promise<OutlinedPdfResult> {
  const list = Array.from({ length: pdf.numPages as number }, (_, i) => i + 1);
  const entries: Parameters<typeof buildScore>[0] = [];
  const notesByStaff = new Map<Staff, StaffNote[]>();
  const detailPages: NonNullable<StaffPdfResult["detail"]>["pages"] = [];
  const stats: OutlinedPdfResult["stats"] = { notes: 0, harmonies: 0, lyricRows: 0, jianpuFix: { pairs: 0, pitch: 0, duration: 0, removed: 0, inserted: 0 } };
  let carryTime: { beats: number; beatType: number } | undefined;
  let skipped = 0;
  let header: Awaited<ReturnType<typeof recognizeOutlinedPage>>["header"] = [];
  let jianpu = false;
  let done = 0;
  for (const pn of list) {
    const page = await pdf.getPage(pn);
    const r = await recognizeOutlinedPage(page, OPS, look, pn, { live: opts.live, carryTime, wantHeader: !entries.length });
    page.cleanup?.();
    carryTime = r.carryTime;
    if (r.hasStaff) {
      if (!entries.length) header = r.header;
      entries.push({ page: r.page, ctx: r.ctx });
      detailPages.push({ pn, page: r.page, notes: r.notes });
      for (const n of r.notes) notesByStaff.set(n.staff, [...(notesByStaff.get(n.staff) ?? []), n]);
      stats.notes += r.notes.length;
      stats.harmonies += r.harmonies;
      stats.lyricRows += r.lyricRows;
      if (r.jianpuBands.length) jianpu = true;
      if (r.jianpuFix) for (const k of Object.keys(stats.jianpuFix) as (keyof FuseStats)[]) stats.jianpuFix[k] += r.jianpuFix[k];
    } else skipped++;
    opts.onProgress?.(++done, list.length);
  }
  const profileOf = (st: Staff): StaffProfile => {
    const ns = notesByStaff.get(st) ?? [];
    const ps = ns
      .filter((n) => !n.rest && !n.grace && n.step)
      .map((n) => "CDEFGAB".indexOf(n.step!) + 7 * n.octave!)
      .sort((a, b) => a - b);
    return { lyric: ns.some((n) => n.lyrics?.length), pitch: ps.length ? ps[ps.length >> 1]! : null };
  };
  // 简线混排谱：单行谱表的系统都归第一声部（同位图路 `rasteromr/song.ts`）
  const score = buildScore(entries, { profileOf, soloToFirst: jianpu });
  const noteBoxes: NonNullable<StaffPdfResult["detail"]>["noteBoxes"] = new Map();
  const markBoxes: NonNullable<StaffPdfResult["detail"]>["markBoxes"] = new Map();
  const arcId = opts.noteIds ? numberOmrIds(detailPages, noteBoxes, markBoxes) : undefined;
  const notesOf = (st: Staff): StaffNote[] => notesByStaff.get(st) ?? [];
  const credits: NonNullable<StaffXmlOptions["credits"]> = header.map(({ text, type, justify, size, box }) => ({ text, type, justify, box, ...(size ? { size } : {}) }));
  const title = opts.title ?? credits.find((c) => c.type === "title")?.text;
  const numbering = measureNumbering(score);
  const xmlOpts = { title, credits, ...(numbering ? { measureNumbering: numbering } : {}), ...(opts.noteIds ? { noteId: (n: StaffNote) => n.omrId, arcId } : {}) };
  const musicxml = entries.length ? scoreToMusicXml(score, notesOf, xmlOpts) : "";
  let cur = score;
  const detail: StaffPdfResult["detail"] = {
    pages: detailPages, noteBoxes, markBoxes, score,
    assignment: () => cur.systems.map((e, si) => e.sys.staves.map((st) => cur.scoreStaves.findIndex((ss) => ss.staves[si] === st))),
    rebuild: (slots) => {
      cur = buildScore(entries, { slots });
      return { xml: scoreToMusicXml(cur, notesOf, xmlOpts), score: cur };
    },
    restructure: (op) => {
      if (!restructureSystems(entries, op)) return null;
      cur = buildScore(entries, { profileOf, soloToFirst: jianpu });
      return { xml: scoreToMusicXml(cur, notesOf, xmlOpts), score: cur };
    },
  };
  return { musicxml, pages: list.length, notes: stats.notes, parts: score.parts.length, skipped, detail, jianpu, stats };
}
