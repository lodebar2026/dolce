// 把乐句分析的断点写进文档（成书重排用），以及断句之后的那几步：容量补刀、两两并行、收拾行首行尾休止、并碎行、
// 整首的排版模式阶梯、逐行事实与按乐句行分页。
//
// 判据在 Rust（crates/dolce-play/src/applybreaks.rs；改模型的两步在 crates/dolce-view/src/bookbreaks.rs），这里是门面：
// 断点集合原地改（`score/play.ts::phraseLayoutOp` 把 Rust 改过的集合写回），和弦按拍平下标认回对象。
// 断句在 `ScoreDoc` 拼出的断句输入（`phraseinput.ts`）上跑，两边的和弦**按元素 id 对上**，断点经 `model/breaks.ts::applyBreaks` 写回。
//
// 无 DOM 依赖。
import type { ElementId, Song } from "../model/doc";
import { applyBreaks } from "../model/breaks";
import type { PhraseChord, PhrasePart } from "../score/phraseinput";
import { phraseBookIn, phraseLayoutOp, type FitMetric, type PhraseBreaks } from "../score/play";
import { dolce } from "../common/dolce";
import { call } from "../model/rustdoc";

export type { FitMetric };

export interface ApplyBreakOptions {
  /** 每页几行。**0 = 不按行数换页**——成书排版走这个：一页装多少行交给
   *  layout 的 layoutVertically 按页高决定，硬定 4 行会让每页空掉半页。 */
  linesPerPage?: number;
  /** 段落起点（主歌/副歌…）是否另起一页。成书里一首歌通常连排，默认不换。 */
  sectionNewPage?: boolean;
  /** 是否采用**行内断点**（`midBreaks`：在小节中间的和弦后换行）。成书要每行都在小节线上收尾，那边关掉它。 */
  useMidBreaks?: boolean;
}

export interface ApplyBreakResult {
  lines: number;
  pages: number;
}

/** 简谱引擎量出来的自然跨度（键是元素 id，`layoutBookDoc` 的 `measure`）换成按断句输入的和弦。 */
export function fitForIds(
  fit: { width: number; spans: ReadonlyMap<string | number, { x0: number; x1: number; x1b?: number }> },
  idOf: ReadonlyMap<PhraseChord, ElementId>,
): FitMetric {
  const spans = new Map<PhraseChord, { x0: number; x1: number; x1b?: number }>();
  for (const [c, id] of idOf) {
    const sp = fit.spans.get(id);
    if (sp) spans.set(c, sp);
  }
  return { width: fit.width, spans };
}

/**
 * 断句的断点写进文档（成书在简谱引擎上排，`song` 是 `ScoreDoc` 克隆里的那首）：换成行首交 `model/breaks.ts::applyBreaks`，
 * **替换**原有的换行（小节一一对应、和弦按元素 id 对上，对不上抛错；`linesPerPage` 0 = 不按行数换页）。
 */
export function applyPhraseBreaksToDoc(
  song: Song, input: PhrasePart, idOf: ReadonlyMap<PhraseChord, ElementId>, breaks: PhraseBreaks,
  opt: ApplyBreakOptions = {},
): ApplyBreakResult {
  const i = phraseBookIn(input, idOf, breaks);
  const r = JSON.parse(call(() => dolce().modelPhraseLineStarts(JSON.stringify(song), i.part, i.ids, i.breaks, JSON.stringify(opt)))) as {
    starts: { id: ElementId; page?: boolean }[]; lines: number; pages: number;
  };
  applyBreaks(song, r.starts, { mid: "inline", pages: "write" });
  return { lines: r.lines, pages: r.pages };
}

/**
 * 成书的段落词（原书印在和弦带里的「（副歌）」）：按原书音符序号（`note_ordinal`，数的是正经和弦、休止也算，倚音不算）
 * 写到文档的和弦上（`Chord.sectionWord`），排版引擎自己去摆。副歌那一条优先挂到断句输入里**副歌的起句**。
 */
export function putSectionWords(
  song: Song, input: PhrasePart, idOf: ReadonlyMap<PhraseChord, ElementId>, rows: ReadonlyArray<{ text: string; note_ordinal: number }>,
): void {
  if (!rows.length) return;
  const i = phraseBookIn(input, idOf);
  const got = JSON.parse(dolce().modelSectionWordTargets(JSON.stringify(song), i.part, i.ids, JSON.stringify(rows))) as [ElementId, string][];
  const byId = new Map(got);
  for (const m of song.parts[0]?.measures ?? []) {
    for (const el of m.elements) {
      if (el.kind !== "chord") continue;
      const w = byId.get(el.id);
      if (w !== undefined) el.sectionWord = w;
    }
  }
}

/**
 * 容量保险：把**放不下的行**按乐句子句断点切开（落点由 Rust `pick_cuts` 挑）。
 *
 * @param cells 一行放得下几格（由排版器实测）
 * @param useMidBreaks 调用方是否会采用行内断点（与 applyPhraseBreaks 的同名选项保持一致）
 */
export function enforceLineCapacity(part: PhrasePart, breaks: PhraseBreaks, cells: number, targetMeas = 4,
                                    useMidBreaks = true, fit?: FitMetric): void {
  applyCapacityCuts(part, breaks, cells, { targetMeas, useMidBreaks, avoidSpans: false, fit });
}

/** **容量补刀**：一行放不下就在它内部切开；工整段整段一起断、一样满的行跟着切，只拆一轮。 */
export function applyCapacityCuts(part: PhrasePart, breaks: PhraseBreaks, cells: number,
                                  opt: { targetMeas?: number; useMidBreaks: boolean; avoidSpans: boolean; fit?: FitMetric }): void {
  phraseLayoutOp("applyCapacityCuts", part, breaks, { cells, targetMeas: opt.targetMeas ?? 0, useMidBreaks: opt.useMidBreaks, avoidSpans: opt.avoidSpans, fit: opt.fit });
}

/** 一行的行首「残小节」：从行首到第一条小节线之间的那点内容。 */
export interface LineHead {
  /** 残小节的**时值**（整小节起头时就是该小节的全长） */
  dur: number;
  /** 行首是不是小节起点（false = 从小节中间起头，弱起/长音收尾之后） */
  full: boolean;
  /** 残小节里有没有音符（false = 只有休止） */
  hasNote: boolean;
  /** 残小节占多少**格** */
  cells: number;
  /** 行首第一个和弦：是不是休止、几条符杠、几拍 */
  rest: boolean;
  beams: number;
  firstBeats: number;
  /** 行首第一个和弦的**时值** */
  firstDur: number;
  /** 行首第一个和弦的歌词标点分：**带标点的长音**是上一句的收尾，不该出现在行首（373） */
  firstPunct: number;
  /** 行首第一个和弦的主歌词 */
  text: string;
}

/** 一行的行末：最后一个和弦的歌词末字与其标点分（句末 6 / 句中 4 / 无 0）。 */
export interface LineTail {
  text: string;
  punct: number;
  beats: number;
  /** 行末往前**最近的那个有词的字** */
  lastWord: string;
  /** 同上，那个字的标点分 */
  lastWordPunct: number;
  /** **行末的残小节里只有休止** */
  restOnlyBar: boolean;
  /** 行末残小节的时值（`restOnlyBar` 那一截有多少拍；否则 0） */
  restBarDur: number;
}

/** 断点把曲子切成的一行。`mi`/`chord` 是**这一行末尾**那个断点；末行没有断点，两者皆 null。 */
export interface LineInfo {
  cells: number;
  /** 这一行的**时值** */
  dur: number;
  /** 这一行覆盖的小节下标区间（含端点） */
  fromMi: number;
  toMi: number;
  /** 整小节数 */
  bars: number;
  beats: number;
  head: LineHead;
  tail: LineTail;
  /** 行首的旋律指纹：两行相同 = 平行乐句开头。 */
  headFp: string;
  mi: number | null;
  chord: PhraseChord | null;
  /** 段界（另起一页）不可合并。 */
  section: boolean;
  /** 这一行覆盖的和弦在**全曲拍平序列**里的下标区间（含端点）。 */
  from: number;
  to: number;
  /** 这一行的**行首**那个断点是不是**容量补刀**落的（line-check 的 D2 据此豁免） */
  fromCut: boolean;
}

/** 按断点把 part 切成行，并把**判断版面好坏要用的事实**一并算出来（行首残小节、行末歌词标点、格数、小节数）。 */
export function describeLines(part: PhrasePart, breaks: PhraseBreaks, useMidBreaks: boolean): LineInfo[] {
  const { out, flat } = phraseLayoutOp("describeLines", part, breaks, { useMidBreaks });
  return (out as (Omit<LineInfo, "chord"> & { chord: number | null })[]).map((l) => ({ ...l, chord: l.chord === null ? null : flat[l.chord]! }));
}

/** 逐行的**真实宽度**（自然坐标，未 justify）与版心宽度（`scripts/rebuild.mjs` 的逐行事实用）。 */
export function measureLines(part: PhrasePart, lines: LineInfo[], fit?: FitMetric): { width: number; widths: number[] } {
  const empty: PhraseBreaks = {
    measureBreaks: new Set(), midBreaks: new Set(), sectionStarts: new Set(), sectionCutChords: new Set(),
    cuts: [], capacityCuts: new Set(), refrainCut: false, forced: new Set(),
  };
  return phraseLayoutOp("measureLines", part, empty, { ranges: lines.map((l) => [l.from, l.to]), fit }).out as { width: number; widths: number[] };
}

/** **行首不留半个小节的休止**：把那点休止并到上一行去（并过去放不下就不并）。回挪了几行。 */
export function tidyLineHeads(part: PhrasePart, breaks: PhraseBreaks,
                              opt: { useMidBreaks?: boolean; cells?: number; fit?: FitMetric } = {}): number {
  return phraseLayoutOp("tidyLineHeads", part, breaks, { useMidBreaks: opt.useMidBreaks ?? true, cells: opt.cells ?? 0, fit: opt.fit }).out as number;
}

/** **行末不留半个小节的休止**：把那点休止推到下一行去（与 `tidyLineHeads` 对称）。回推了几行。 */
export function tidyLineTails(part: PhrasePart, breaks: PhraseBreaks,
                              opt: { useMidBreaks?: boolean; cells?: number; fit?: FitMetric } = {}): number {
  return phraseLayoutOp("tidyLineTails", part, breaks, { useMidBreaks: opt.useMidBreaks ?? true, cells: opt.cells ?? 0, fit: opt.fit }).out as number;
}

/** **每两句并一行**（B 档）：全首一个口径，并不齐就整档放弃（回 0）。回并掉的断点数。 */
export function mergePairsUniform(part: PhrasePart, breaks: PhraseBreaks, useMidBreaks: boolean): number {
  return phraseLayoutOp("mergePairsUniform", part, breaks, { useMidBreaks }).out as number;
}

/** **碎行并回上一行**：只剩一小节、又唱不满一句的行。回并掉的断点数。 */
export function mergeSliverLines(part: PhrasePart, breaks: PhraseBreaks, useMidBreaks: boolean, cells = 0,
                                 fit?: FitMetric): number {
  return phraseLayoutOp("mergeSliverLines", part, breaks, { useMidBreaks, cells, fit }).out as number;
}

/**
 * **整首的排版模式阶梯**（B 两句一行 → A 一句一行 → C 均匀排版，取第一个可行的）。
 * 选中的那一档**写回 `breaks`**（原地改，调用方拿到的就是最终断点）。
 */
export function chooseLineLayout(
  part: PhrasePart,
  breaks: PhraseBreaks,
  cells: number,
  opt: { useMidBreaks?: boolean; allowPairs?: boolean; fit?: FitMetric } = {},
): "pairs" | "phrase" | "even" {
  return phraseLayoutOp("chooseLineLayout", part, breaks, {
    cells, useMidBreaks: opt.useMidBreaks ?? true, allowPairs: opt.allowPairs ?? true, fit: opt.fit,
  }).out as "pairs" | "phrase" | "even";
}

/**
 * **乐句行 → 换页行号**（`.jpwabc` 与文本谱共用同一套口径）。
 *
 * @param lines       乐句行总数
 * @param sectionEnds 段末行号（1 基；主歌/副歌分界）
 * @param pageLines   一页至多几行
 * @returns 1 基行号集合：该行行尾换页（末行必定在内，段末收尾）
 */
export function pageBreakLines(lines: number, sectionEnds: ReadonlySet<number>, pageLines: number): Set<number> {
  return new Set(dolce().pageBreakLines(lines, Uint32Array.from(sectionEnds), pageLines));
}
