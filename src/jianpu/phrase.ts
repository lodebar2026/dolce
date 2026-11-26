// 「按乐句重排」/「每行 n 小节」——**把断点换算到排版行视图的行上**。
//
// 判据在 Rust（crates/model/src/view/phraselines.rs，wasm `modelPhraseCuts` / `modelPhraseLinesEdited`），这里是门面：
// 行长尺子（`FitMeasure`，要量字）在 TS 量好按元素 id 交过去，`onKeep` / `onOverflow` 回调由 Rust 回的标志触发。
// 断句本身格式无关（crates/model/src/play/phrase.rs），断点经断句输入的 `ids` 与视图的元素表回到行里的元素；
// 多声部按累计时值对齐同一拍位。产出是一份「新的行划分」（`FanqieNewLine[]`）或断点（`PhraseCut[]`），
// 消费者（`fanqie/relayout.ts`、`docrelayout.ts`、文本谱写出端）据此改原文或写回换行位。
//
// 无 DOM 依赖。

import { dolce } from "../common/dolce";
import { call } from "../model/rustdoc";
import { defaultBookStyle } from "../style/bookstyle";
import type { SourceSpan } from "./ast";
import type { ElementId, ScoreDoc } from "../model/doc";

/** 一个声部在某一新行上占的元素区间（半开区间，下标是该声部**整曲元素流**的下标）。 */
export interface FanqieLineSeg {
  voice: number;
  from: number;
  to: number;
}

/** 重排后的一行（一个「系统」：同组各声部各一条）。 */
export interface FanqieNewLine {
  segs: FanqieLineSeg[];
  /** 本行行尾换页（下一行另起一页）。 */
  pageAfter: boolean;
}

/** 量行长的尺子：量这份文档第 `song` 首各音的自然跨度（键是元素 id，按 id 对回断句输入）。 */
export type FitMeasure = (doc: ScoreDoc, song: number) => {
  width: number; spans: ReadonlyMap<string | number, { x0: number; x1: number; x1b?: number }>
} | null;

/** 每行 n 小节有一行放不下：第 `song` 首（0 基，共 `songs` 首）的第 `line` 行（1 基）。 */
export interface BarsOverflow {
  song: number;
  songs: number;
  line: number;
}

/** 新的行怎么分：按乐句（`measure` 是行长尺子）、或每行固定 `n` 小节。
 *  `onOverflow`：每行 n 小节时，有一行在 `measure` 量出的版心里放不下就报（每首报第一处）。 */
export type LinePlan =
  /** `onKeep`：乐句方案有行放不下、原始排版放得下，于是保持原排版（不重排）时调一次 */
  | { kind: "phrase"; measure: FitMeasure | null; onKeep?: () => void }
  | { kind: "bars"; n: number; measure?: FitMeasure | null; onOverflow?: (at: BarsOverflow) => void };

/**
 * 一个断点：**新行从这个元素起**。
 *
 * 两个消费者各取所需：写回 `ScoreDoc` 的那条路（123/ABC，`jianpu/docrelayout.ts`）按 `id` 找回
 * 模型里的元素；改写原文的那条路（`.jpwabc`）按 `source` 在原文上下刀。小节线没有 `ElementId`
 * （模型里它挂在 `Measure.barlines` 上，不是元素），所以 `|:` 领起的新行 `id` 取它后面那个音
 * ——落到小节级换行上是同一个位置；`source` 仍是 `|:` 自己的，原文才切得对。
 */
export interface PhraseCut {
  id: ElementId | null;
  source: SourceSpan | null;
  /** 这一行另起一页 */
  page: boolean;
}

/** 有尺子时的断句参数：**与成书同一套**（`contentOnly`，参数取成书出厂值；尺子不进断句，只在选档、收拾行首行尾、并碎行时用）。 */
function contentOptions(): { content: object; mid: boolean } {
  const L = defaultBookStyle().layout;
  return {
    mid: L.phraseMidBreak,
    content: {
      contentOnly: true,
      lenWeight: L.phraseLenWeight,
      breakWeight: L.phraseBreakWeight,
      parallelWeight: L.phraseParallelWeight ?? 6,
      tailLongWeight: L.phraseTailLongWeight ?? 0,
      shortSentenceWords: 4,
      repeatLenBonus: true,
      evenWeight: L.phraseEvenWeight ?? 0,
      tailWeight: L.phraseTailWeight ?? 0,
      fitSlack: L.phraseFitSlack ?? 0,
      moreRowsSlack: L.phraseMoreRowsSlack ?? 0,
    },
  };
}

/** 尺子量出的跨度换成 Rust 吃的 `[元素 id, 跨度]`（元素 id 是数，字符串键本来就按 id 查不到，略去）。 */
function measuredIn(m: ReturnType<FitMeasure>): string {
  if (!m) return "null";
  const spans: Array<[number, { x0: number; x1: number; x1b?: number }]> = [];
  for (const [k, sp] of m.spans) {
    if (typeof k !== "number" || !Number.isInteger(k)) continue;
    spans.push([k, sp.x1b === undefined ? { x0: sp.x0, x1: sp.x1 } : { x0: sp.x0, x1: sp.x1, x1b: sp.x1b }]);
  }
  return JSON.stringify({ width: m.width, spans });
}

interface PlanResult {
  cuts: PhraseCut[] | null;
  lines: FanqieNewLine[] | null;
}

/** 分行与断点一趟出：尺子只在要用时量，回调按 Rust 回的标志触发。 */
function runPlan(sdoc: ScoreDoc, songIdx: number, plan: LinePlan): PlanResult {
  let planIn: object;
  let measured: ReturnType<FitMeasure> = null;
  if (plan.kind === "phrase") {
    planIn = { kind: "phrase", ...contentOptions() };
    measured = plan.measure ? plan.measure(sdoc, songIdx) : null;
  } else {
    planIn = { kind: "bars", n: plan.n };
    if (plan.measure && plan.onOverflow) measured = plan.measure(sdoc, songIdx);
  }
  const r = JSON.parse(call(() => dolce().modelPhraseCuts(JSON.stringify(sdoc), songIdx, JSON.stringify(planIn), measuredIn(measured)))) as {
    cuts: PhraseCut[] | null; lines: FanqieNewLine[] | null; kept: boolean; overflow: number | null;
  };
  if (r.kept && plan.kind === "phrase") plan.onKeep?.();
  if (r.overflow !== null && plan.kind === "bars") plan.onOverflow?.({ song: songIdx, songs: sdoc.songs.length, line: r.overflow });
  return { cuts: r.cuts, lines: r.lines };
}

/** 按 `plan` 分出这一首的新行。 */
export function planLines(sdoc: ScoreDoc, songIdx: number, plan: LinePlan): FanqieNewLine[] | null {
  return runPlan(sdoc, songIdx, plan).lines;
}

/**
 * **每行 n 小节**：只按主旋律的小节线数，原有换行（连同小节中间的）一律作废。
 * 弱起不计数并进首行；源里原有的换页照留（之后从下一个完整小节起重新数）；剩下不足 n 的照留为末行；`|:` 领起新行。
 */
export function barLines(sdoc: ScoreDoc, songIdx: number, n: number): FanqieNewLine[] | null {
  return planLines(sdoc, songIdx, { kind: "bars", n });
}

/**
 * 算出这一首该怎么按乐句分行。
 *
 * @param measure 真实坐标的行长尺子（`App._fanqiePhraseMeasure`）。不给就只按小节数断，
 *                行长目标是断句的出厂值——与 `.jpwabc` 那条路同一个口径。
 * @returns 新的行划分；这份文档没有可排的曲行、或乐句方案放不下而保持原排版（调 `onKeep`）时返回 null。
 */
export function fanqiePhraseLines(
  sdoc: ScoreDoc, songIdx = 0, opt: { measure?: FitMeasure | null; onKeep?: () => void } = {},
): FanqieNewLine[] | null {
  return planLines(sdoc, songIdx, { kind: "phrase", measure: opt.measure ?? null, onKeep: opt.onKeep });
}

/**
 * **照原文现有的行结构**，只在元素 `afterId` 之后加一刀（`add`）或去掉它后面那一刀（与下一行合并）。
 * 可视化编辑增删文本谱换行用（写回复用乐句重排那套原文搬运，`relayout.ts::relayoutFanqieBreak`）。
 *
 * @returns 新的行划分；元素不在这首里、或这一刀加不上 / 去不掉时返回 null
 */
export function fanqieLinesEdited(
  sdoc: ScoreDoc, songIdx: number, edit: { afterId: ElementId; add: boolean; page: boolean },
): FanqieNewLine[] | null {
  return JSON.parse(call(() => dolce().modelPhraseLinesEdited(JSON.stringify(sdoc), songIdx, edit.afterId, edit.add, edit.page))) as FanqieNewLine[] | null;
}

/**
 * 重排的断点（不含第一行的行首），新行按 `plan` 分（按乐句 / 每行 n 小节）。**与格式无关**：
 * 两种分法都只经行视图读谱，文本谱 / 123 / ABC / `.jpwabc` 拼出的 `ScoreDoc` 都吃得下。
 */
export function phraseCuts(sdoc: ScoreDoc, songIdx: number, plan: LinePlan): PhraseCut[] | null {
  return runPlan(sdoc, songIdx, plan).cuts;
}
