// 五线谱识别入口。全链不碰 DOM（要进 `src/cli/index.ts` 那条 Node 链）。
export * from "./glyphs";
export * from "./symbolmap";
export * from "./staffglyphs";
export * from "./model";
export * from "./vecgeom";
export * from "./page";
export * from "./notedata";
export * from "./toxml";
export * from "./textanalyze";
export * from "./textglyphs";
export * from "./slur";
export * from "./notations";
export * from "./score";
export * from "./octave";
export * from "./song";

import { extractVectorPage } from "../omr/vector";
import type { OpsEnum } from "../omr/vector";
import { extractTextPage } from "../omr/vectext";
import { StaffGlyphLookup, type StaffGlyphDict } from "./staffglyphs";
import { buildPage, findBarlines, findNoteheads, findStaves, findStems, findSymbols, findTails, makeBars, makeSystems, removeWhite, unknownObjs } from "./page";
import type { SPage, Staff } from "./model";
import { buildNotes, checkBars, findBeams, findClefKeyTime, lastTimeSignature, staffOmrOptions, type BarCheck, type BeamShape, type StaffContext, type StaffNote, type StemInfo } from "./notedata";
import { analyzeText, attachDirectionTexts, attachHarmonies, attachLyrics, buildLyricLines, type LyricLine, type TextAnalysis } from "./textanalyze";
import type { TextGlyphLookup } from "./textglyphs";
import { attachSlurs, findSlurs, mergeArcHalves, findWedges, markSlurNotes, reconnectSlurs, wedgeSpans, type SlurArc } from "./slur";
import { attachDynamics, attachNotations, attachWedges, findNotations, findTuplets, takeArpeggios } from "./notations";
import { applyOctaveShifts, attachVoltas, findOctaveShifts, findVoltas, type OctaveShift, type Volta } from "./octave";
import { headerCredits, type HeaderCredit, type WordLine } from "../rasteromr/words";

export interface StaffPageResult {
  page: SPage;
  /** 这一页有没有谱表。没有的（封面/目录/歌词页）后续一律跳过，照 musicpp `Score::process`。 */
  hasStaff: boolean;
  /** 还没有归属的对象数——识别覆盖率的硬指标。 */
  unknown: number;
  /** 逐谱行的谱号/调号/拍号。 */
  ctx: Map<Staff, StaffContext>;
  beams: BeamShape[];
  /** 认出来的音符（按 x 排）。 */
  notes: StaffNote[];
  /** 文本层的分类结果。 */
  text: TextAnalysis;
  lyricLines: LyricLine[];
  /** 圆滑线与连音线。 */
  slurs: SlurArc[];
  /** 八度移位段与反复房号。 */
  octaves: OctaveShift[];
  voltas: Volta[];
  /** 逐小节的时值自检（不靠 GT，见 `checkBars`）。 */
  bars: BarCheck[];
  /** 这一页最后生效的拍号——下一页要拿它当 `opts.carryTime`（续页不再印拍号）。 */
  carryTime?: { beats: number; beatType: number };
}

/**
 * 认一页。顺序照 musicpp `Score::process`，**别调**。
 *
 * @param look 字形字典（`glyphmap.json` → `new StaffGlyphLookup(dict)`）。
 *             一份字典跑全书，别每页重建（构造要解 176 条签名）。
 */
export async function recognizeStaffPage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfPage: any,
  OPS: OpsEnum,
  look: StaffGlyphLookup,
  index: number,
  opts: { textLookup?: TextGlyphLookup; carryTime?: { beats: number; beatType: number } } = {},
): Promise<StaffPageResult> {
  const vec = await extractVectorPage(pdfPage, OPS, { scale: 1 });
  const runs = await extractTextPage(pdfPage, OPS, { scale: 1 });
  const pg = buildPage(index, vec.width, vec.height, vec.objs, runs);

  findSymbols(pg, look);
  if (!findStaves(pg)) {
    removeWhite(pg);
    return { page: pg, hasStaff: false, unknown: unknownObjs(pg).length, ctx: new Map(), beams: [], notes: [], text: emptyText(), lyricLines: [], slurs: [], octaves: [], voltas: [], bars: [], carryTime: opts.carryTime };
  }
  findNoteheads(pg);
  findStems(pg);
  findTails(pg);
  findBarlines(pg);
  const ctx = findClefKeyTime(pg);
  makeSystems(pg);
  makeBars(pg);
  const beams = findBeams(pg);
  const stems: StemInfo[] = [];
  const notes = buildNotes(pg, ctx, beams, stems);
  // 三连音要在时值算完之后改（它按比例缩短已算好的时值）
  findTuplets(pg, beams, stems, notes);
  // 弧要在音符之后找：判断「哪条曲线是谱表括号」要用到系统线，挂两端要用到音符。
  // 渐强渐弱要**先于**弧挑出来——它们也是又宽又扁的图形。
  const wedges = findWedges(pg);
  // 一条弧在这批 PDF 里画成左右两半两个对象，挂音符之前先并回一条
  const slurs = mergeArcHalves(findSlurs(pg), pg.normalStaffSpace || pg.space);
  attachSlurs(slurs, notes, pg.normalStaffSpace || pg.space);
  reconnectSlurs(pg, slurs);
  markSlurNotes(slurs);
  // 八度移位要在音高算完之后、文本层之前：它直接改音符的八度
  const octaves = findOctaveShifts(pg);
  if (staffOmrOptions.octaveShift) applyOctaveShifts(octaves, notes, pg.normalStaffSpace || pg.space);
  const voltas = findVoltas(pg);
  attachVoltas(pg, voltas);
  // 演奏法记号要在文本层**之前**挑（它们是乐谱字形，与文本无关，但要先占住位置）
  const marks = findNotations(pg);
  attachNotations(pg, notes, takeArpeggios(pg, notes, marks.marks));
  const text = analyzeText(pg);
  // 力度与松叶挪到文本层之后挂：判「隔着上一行歌词、是下一行的」要知道各行谱下方歌词的下沿（见 `ownerStaff`）
  const lyricBottom = new Map<Staff, number>();
  for (const o of text.lyric) {
    const cy = (o.box.top + o.box.bottom) / 2;
    const st = pg.staves.filter((q) => q.box.bottom <= cy).sort((a, b) => b.box.bottom - a.box.bottom)[0];
    if (st) lyricBottom.set(st, Math.max(lyricBottom.get(st) ?? -Infinity, o.box.bottom));
  }
  attachDynamics(pg, notes, marks.dynamics, lyricBottom);
  attachWedges(pg, notes, wedgeSpans(wedges), lyricBottom);
  const lyricLines = buildLyricLines(pg, text.lyric, opts.textLookup);
  attachLyrics(notes, lyricLines);
  attachHarmonies(pg, notes, text.harmony);
  attachDirectionTexts(pg, notes, text);
  removeWhite(pg);
  return { page: pg, hasStaff: true, unknown: unknownObjs(pg).length, ctx, beams, notes, text, lyricLines, slurs, octaves, voltas, bars: checkBars(pg, ctx, notes, opts.carryTime), carryTime: lastTimeSignature(pg, ctx, opts.carryTime) };
}

function emptyText(): TextAnalysis {
  return { lyric: [], harmony: [], tempo: [], expression: [], instrument: [], measureNumber: [], boxed: [], textFrame: [] };
}

/** 从 `glyphmap.json` 的内容造查表器。 */
export function makeLookup(dict: StaffGlyphDict): StaffGlyphLookup {
  return new StaffGlyphLookup(dict);
}

/**
 * 页眉 → MusicXML 的 `<credit>`（矢量路；位图路是 OCR 读出来的行，见 `rasteromr/words.ts::headerCredits`）。
 *
 * 文字层现成：取**第一行谱以上**、没被文本层认成歌词/速度/声部名/表情的文字，
 * 同一条基线上相邻的几段（「Arranged by 」+「Ricardo Chan」）拼成一行，交给位图路那份分类
 * （标题、副标题、词曲作者、书眉同一套判据）。页脚不出——同位图路，计分也只看页眉。
 */
export function vectorPageCredits(pg: SPage): HeaderCredit[] {
  if (!pg.staves.length) return [];
  const sp = pg.normalStaffSpace || pg.space;
  const top = Math.min(...pg.staves.map((st) => st.box.top));
  const SKIP = ["Lyric", "Tempo", "Instrument", "Expression", "MeasureNumber"] as const;
  const objs = pg.objs.filter((o) => o.run && !o.symbols.length && !SKIP.some((t) => o.hasTag(t)) && o.box.bottom <= top - sp);
  // 拼行：纵向中线相差不到半个字高、横向间隙不到一个字高
  const lines: { t: string; box: { left: number; right: number; top: number; bottom: number } }[] = [];
  for (const o of [...objs].sort((a, b) => a.box.left - b.box.left)) {
    const s = o.run!.glyphs.map((g) => g.unicode).join("");
    if (!s.trim()) continue;
    const h = o.box.bottom - o.box.top;
    const cy = (o.box.top + o.box.bottom) / 2;
    const l = lines.find((q) => Math.abs((q.box.top + q.box.bottom) / 2 - cy) <= h * 0.5 && o.box.left - q.box.right <= h && o.box.left >= q.box.left);
    if (l) {
      l.t += s;
      l.box = { left: l.box.left, right: Math.max(l.box.right, o.box.right), top: Math.min(l.box.top, o.box.top), bottom: Math.max(l.box.bottom, o.box.bottom) };
    } else lines.push({ t: s, box: { ...o.box } });
  }
  // ToUnicode 常把汉字映到**康熙部首 / 部首补充**区（「第448⾸」「⽼师」「使⽤」，U+2E80–U+2FDF），只把这一段折回正常汉字（NFKC），
  // 全角括号之类别的字符不动
  const fold = (t: string) => t.replace(/[\u2e80-\u2fdf]/g, (c) => c.normalize("NFKC"));
  const toLine = (l: (typeof lines)[number], x0: number, y0: number): WordLine => ({ t: fold(l.t).replace(/\s+/g, " ").trim(), x: l.box.left - x0, y: l.box.top - y0, w: l.box.right - l.box.left, h: l.box.bottom - l.box.top });
  const head = lines.filter((l) => l.box.bottom <= top);
  const strip = { w: pg.width, h: top, data: new Uint8Array(0), box: { x: 0, y: 0, w: pg.width, h: top } };
  const out = headerCredits(head.map((l) => toLine(l, 0, 0)), strip);
  return out;
}
