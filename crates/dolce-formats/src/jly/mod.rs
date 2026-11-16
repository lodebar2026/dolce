//! jianpu-ly（`.jly`）：读入（`fromjly.ts`）与和弦符号工具（`jlychords.ts`）。
//! 写出端 `tojly.ts` 吃旧排版引擎的 `JScore`（按对象身份记连音组、要字形表），随 jianpuinput 留到 M5 再迁。

pub mod chords;
pub mod fromjly;

pub use fromjly::{is_bare_direction, is_jly_music_line, parse_jly, rewrap_jly_text, scan_music_line, scan_word, JlyLosses, JlyParse, JlyToken};
