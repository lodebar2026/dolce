// `.jpwabc`（`JpwFile`）→ `ScoreDoc`：读法在 Rust（crates/model/src/formats/jpw/read.rs），这里是门面。
// 编辑器谱面（经 `jianpu/jianpuinput.ts::jianpuInputOfJpw`）、试听、转 123/ABC、导出 MusicXML、能力表都从这里出。
//
// 两步（口径见 `docs/格式/jpwabc.md`）：源文切成「源文小节」（`SrcMeasure`，歌词按它数小节），再落成模型。

import type { JpwFile } from "../jpword/jpwfile";
import type { Barline, ScoreDoc, SourceSpan } from "./doc";
import { ModelError, type ModelMsg } from "./msg";
import { dolce } from "../common/dolce";

// ───────────────────────── 源文小节 ─────────────────────────

/** 一个倚音（`{6,}`），音高照主音那样按调号与小节内临时记号落好 */
export interface SrcGrace {
  number: string;
  jpOctave: number;
  jpAlter: string;
  pitch: number;
  step: string;
  rest: boolean;
}

export interface SrcNote {
  kind: "note";
  number: string;
  jpOctave: number;
  jpAlter: string;
  /** MIDI 音高（`applyJpPitch`，休止为 0） */
  pitch: number;
  step: string;
  rest: boolean;
  beams: number;
  /** 总拍数：初值 1，每个 `-` 再加一 */
  beats: number;
  dot: number;
  slurStart: boolean;
  slurEnds: number;
  fermata: boolean;
  tupletBegin: boolean;
  tupletEnd: boolean;
  graces: SrcGrace[];
  lyrics: { number: number; text: string; source?: SourceSpan }[];
  source?: SourceSpan;
}

export interface SrcBar {
  kind: "bar";
  style: NonNullable<Barline["style"]>;
  repeat?: "forward" | "backward";
  /** `::` / `:|:`（左右都反复），同 `Barline.alsoForward` */
  alsoForward?: boolean;
  source?: SourceSpan;
}

export interface SrcBreak {
  kind: "break";
  page: boolean;
  /** `$(…)` 在原文里的位置。只给编辑用（`doc.ts::BreakSource`） */
  source?: SourceSpan;
}

export type SrcEntry = SrcNote | SrcBar | SrcBreak;

/** 源文小节：按原文的小节线切（歌词按它数小节） */
export interface SrcMeasure {
  entries: SrcEntry[];
  fifths: number;
  time: { beats: number; beatType: number };
  keyChange: boolean;
  timeChange: boolean;
}

/** `readJpwSource` 的结果 */
export interface JpwSource {
  measures: SrcMeasure[];
  fifths: number;
  time: { beats: number; beatType: number };
  /** 歌词的最大遍数（`.Words` 各段 `passLast` 取大；没有歌词为 0） */
  passes: number;
}

type Read<K extends string, T> = { [k in K]: T } | { error: { model: ModelMsg } | { fail: string } };

function unwrap<K extends string, T>(json: string, key: K): T {
  const r = JSON.parse(json) as Read<K, T> | null;
  // 分节读得出才会到这儿（`JpwFile.fromString` 已过）
  if (!r) throw new Error("jpwabc");
  if ("error" in r) throw "model" in r.error ? new ModelError(r.error.model) : new Error(r.error.fail);
  return (r as { [k in K]: T })[key];
}

/** 读 `.jpwabc` 原文的那一步：`.Voice` 切成源文小节、歌词落到音符上。`.Voice` 缺失或解析失败时抛错。 */
export function readJpwSource(f: JpwFile): JpwSource {
  return unwrap<"src", JpwSource>(dolce().jpwSource(f.text), "src");
}

/** `.jpwabc` → `ScoreDoc`。`.Voice` 缺失或解析失败时抛错。 */
export function jpwToScoreDoc(f: JpwFile): ScoreDoc {
  return unwrap<"doc", ScoreDoc>(dolce().jpwToScoreDoc(f.text), "doc");
}
