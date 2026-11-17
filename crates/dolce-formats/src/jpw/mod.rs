//! JP-Word `.jpwabc`（TS `jpword/`、`model/fromjpw.ts`、`model/tojpw.ts`）。
//!
//! - [`lex`]：`.Voice` 正文的词法（`lexVoice` / `parseVoiceText`）
//! - [`file`]：分节文件与各节解析（`JpwFile`）
//! - [`read`]：原文 → `ScoreDoc`（`jpwToScoreDoc`、`readJpwSource`、`convertRepeat`）
//! - [`write`]：输入形状 → 原文（`writeJpwabc`）
//! - [`input`]：`ScoreDoc` → 输入形状（`jpwInputOfDoc` / `jpwInputOfSong`）与整条 [`input::emit_jpwabc`]

pub mod file;
pub mod input;
pub mod lex;
pub mod read;
pub mod relayout;
pub mod write;
