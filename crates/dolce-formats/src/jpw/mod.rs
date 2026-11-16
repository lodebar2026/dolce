//! JP-Word `.jpwabc`（TS `jpword/`、`model/fromjpw.ts`、`model/tojpw.ts`）。
//!
//! - [`lex`]：`.Voice` 正文的词法（`lexVoice` / `parseVoiceText`）
//! - [`file`]：分节文件与各节解析（`JpwFile`）
//! - [`read`]：原文 → `ScoreDoc`（`jpwToScoreDoc`、`readJpwSource`、`convertRepeat`）
//! - [`write`]：输入形状 → 原文（`writeJpwabc`；形状由视图层拼）

pub mod file;
pub mod lex;
pub mod read;
pub mod write;
