// 识别结果 → `ScoreDoc`（**简谱形状**，与 123 解析的产物同口径：度数、48 分时值、增时线、减时线）的门面。
// 实现在 Rust `crates/omr-todoc/src/jianpu.rs`（判据与注释都在那边），经 dolce-wasm 同步调。
//
// 识别出来的本来就是简谱，直出模型：123 核对文本 = `emit123(本文件产物)`，要 MusicXML 就走唯一写出端 `model/toxml.ts`（经 `xmlproject.ts` 投影）。
// 识别结果在编辑器里会改（参照歌词改字），所以每次都把当前这份送过去重建。
//
// **无 DOM 依赖**（Node CLI 要 import 它）。
import type { ElementId, ScoreDoc } from "../model/doc";
import { dolce } from "../common/dolce";
import type { JpNum, RecognizedScore } from "./types";

/** 一个和弦名落在哪：音符本身 `h`、第 k 条增时线 `s<k>`、写不出的后续和弦第 k 个 `l<k>`（`Chord.laterHarmonies`）。 */
export type ChordPlace = "h" | `s${number}` | `l${number}`;

/** @param numOf 可选：记下每个和弦来自哪个识别符号（小节时值自检要按源图坐标标出问题小节，`omr/beats.ts`） */
export function recognizedToDoc(score: RecognizedScore, numOf?: Map<ElementId, JpNum>): ScoreDoc {
  const r = JSON.parse(dolce().omrJianpuDoc(JSON.stringify(score))) as { doc: ScoreDoc; numOf: [ElementId, number][] };
  if (numOf) {
    const flat = score.rows.flatMap((row) => row.nums);
    for (const [id, i] of r.numOf) numOf.set(id, flat[i]!);
  }
  return r.doc;
}

/**
 * 全曲各音符（`flatten(rows[].nums)` 序）的和弦落点，与 `[chord, ...extraChords]` 同序。
 * 识别核对按它把源图和弦框认回模型（`reproject.ts::chordSlots`）：按「这个音的第几个和弦」数的话，删掉前面一个，后面的就错位一格。
 */
export function chordPlacesOf(score: RecognizedScore): ChordPlace[][] {
  return JSON.parse(dolce().omrChordPlaces(JSON.stringify(score))) as ChordPlace[][];
}
