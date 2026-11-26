// jianpu-ly 的 `chords=` 行（LilyPond 和弦语法 ↔ 谱上印的文字）：在 Rust（crates/model/src/formats/jly/chords.rs），这里是门面。
// 读写同一张表（对称），表外的后缀保留原文、写出时报出来。写出端（Rust `jly/emit.rs`）与可视化编辑要这几样。

import { dolce } from "../common/dolce";

/** 整音符分数 → `{ LilyPond 时值串, 是否精确 }`（分母 + 附点取最接近的，同上游 `xmlDuration`） */
export function wholeToDuration(whole: number): { text: string; exact: boolean } {
  const [text, exact] = JSON.parse(dolce().jlyWholeToDuration(whole)) as [string, boolean];
  return { text, exact };
}

/** 谱上印的和弦文字 → `chords=` 的 token（`Am7/G` + 时值；写不精确时配乘数 `c4*31`）。后缀认不出来时返回 null */
export function harmonyToChordToken(text: string, whole: number): string | null {
  return dolce().jlyHarmonyToChordToken(text, whole) ?? null;
}

/** 一条 `chords=` 行的 **token 序列 + 各自的时间线**（整音符为单位）：时值没写就沿用上一个，第一个默认四分 */
export function chordTimeline(tokens: readonly string[], fallbackWhole = 0.25): { text: string; whole: number | null; at: number }[] {
  return JSON.parse(dolce().jlyChordTimeline(JSON.stringify(tokens), fallbackWhole)) as { text: string; whole: number | null; at: number }[];
}
