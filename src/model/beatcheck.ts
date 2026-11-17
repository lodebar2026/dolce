// 小节时值自检：逐小节把时值加起来，与拍号对不上的报出来。**不需要 GT**。
//
// 判据在 Rust（`crates/dolce-model/src/beatcheck.rs`，wasm `modelBeatCheck`；口径与合法例外见那边文件头），这里是门面，
// 外加两样说法（`describeBeatIssue` 走界面语言、`beatTag` 是红框角上的差额）。
//
// 消费者：编辑器把拍数不对的小节标红（`editor/visual/`）、简谱识别核对视图（`editor/omrctl.ts`）、私有仓库 `beat-check.mjs`（经 CLI）。

import type { ElementId, ScoreDoc, SourceSpan } from "./doc";
import { msg, msgText } from "./msg";
import { dolce } from "../common/dolce";
import { call } from "./rustdoc";

export interface BeatIssue {
  songIndex: number;
  partIndex: number;
  measureIndex: number;
  /** 该有几拍、实际几拍（四分音符为 1） */
  want: number;
  got: number;
  /** 这一小节里的元素 id（按顺序；高亮用） */
  ids: ElementId[];
  /** 第一个元素在原文里的位置（没有原文的来源为 undefined） */
  source?: SourceSpan;
}

export interface BeatCheckOptions {
  /** 混合拍：这些拍号对上任意一个就算过（识别结果的 `RecognizedScore.meters`）。缺省按模型里的拍号 */
  meters?: readonly { beats: number; beatType: number }[];
  /** 这个声部的首小节不满算不算弱起（放过）。缺省一律算 */
  pickup?: (songIndex: number, partIndex: number) => boolean;
}

const EPS = 1e-6;

/** 逐小节查时值，返回对不上的那些。`pickup` 回调先对每首每个声部问一遍，结果表交给 Rust。 */
export function checkMeasureDurations(doc: ScoreDoc, opts: BeatCheckOptions = {}): BeatIssue[] {
  const o: { meters?: readonly { beats: number; beatType: number }[]; pickup?: boolean[][] } = {};
  if (opts.meters?.length) o.meters = opts.meters.map((m) => ({ beats: m.beats, beatType: m.beatType }));
  const pickup = opts.pickup;
  if (pickup) o.pickup = doc.songs.map((song, si) => song.parts.map((_, pi) => pickup(si, pi)));
  return JSON.parse(call(() => dolce().modelBeatCheck(JSON.stringify(doc), JSON.stringify(o)))) as BeatIssue[];
}

/** 分数拍数的写法：`1/2`、`1 1/2`、`3`。 */
function beatText(q: number): string {
  for (const d of [1, 2, 4, 8, 16, 3, 6, 12]) {
    const n = Math.round(q * d);
    if (Math.abs(n / d - q) > EPS) continue;
    if (d === 1) return String(n);
    const whole = Math.floor(n / d);
    const rest = n - whole * d;
    return whole ? `${whole} ${rest}/${d}` : `${rest}/${d}`;
  }
  return q.toFixed(2);
}

/** 一条问题的说法：「差 1/2 拍」「多 1 拍」。 */
export function describeBeatIssue(i: BeatIssue): string {
  const diff = i.got - i.want;
  return msgText(msg(diff < 0 ? "beat.short" : "beat.over", { d: beatText(Math.abs(diff)), want: beatText(i.want), got: beatText(i.got) }));
}

/** 红框角上标的差额（识谱软件那样一眼看出差多少：`−♩`、`+♪`、`+𝅗𝅥.`）；凑不成一个音符的写拍数（`−1 1/3`）。 */
export function beatTag(i: BeatIssue): string {
  const diff = i.got - i.want;
  const sign = diff < 0 ? "−" : "+";
  const q = Math.abs(diff);
  const NOTES: [number, string][] = [
    [4, "\u{1D15D}"], [3, "\u{1D15E}."], [2, "\u{1D15E}"], [1.5, "♩."], [1, "♩"], [0.75, "♪."], [0.5, "♪"], [0.25, "\u{1D161}"],
  ];
  const hit = NOTES.find(([v]) => Math.abs(v - q) < EPS);
  return sign + (hit ? hit[1] : beatText(q));
}
