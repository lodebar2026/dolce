//! MIDI 导入（TS `midi/`）：SMF 读取（[`smf`]）与量化建模（[`import`]，直出 MusicXML 形状的 `ScoreDoc`）。
//!
//! 与 `dolce-play::midi`（写出）方向相反。提示与报错只出 `Msg` 键（`midi.*`），文字由 TS 门面按界面语言给。

pub mod import;
pub mod smf;
