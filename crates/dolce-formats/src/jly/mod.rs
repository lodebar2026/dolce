//! jianpu-ly（`.jly`）：读入（`fromjly.ts`）与和弦符号工具（`jlychords.ts`）。
//! 写出端（原 `tojly.ts`）：`input` 从 `ScoreDoc` 投影出简谱输入，`emit` 写成上游 jianpu-ly 文本。

pub mod chords;
pub mod emit;
pub mod fromjly;
pub mod input;

pub use emit::{emit_jly, JlyExport};
pub use fromjly::{is_bare_direction, is_jly_music_line, parse_jly, rewrap_jly_text, scan_music_line, scan_word, JlyLosses, JlyParse, JlyToken};
