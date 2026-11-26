//! ABC 家族的词法产物（同 `abcfamily/types.ts`）。两种方言 token 种类共用，差异只落在 `note` 带什么：
//! 123 带 `degree`，ABC 带 `step` / `alter` / `num` / `den`。字段「没有」与「0」有别（TS 按有无写出），全用 `Option`。

use crate::base::{Msg, SourceSpan};
use crate::Accidental;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TokenKind {
    Note,
    ChordGroup,
    Broken,
    Rest,
    Spacer,
    Rhythm,
    Sustain,
    Tie,
    ArcNext,
    Barline,
    Ending,
    SlurStart,
    SlurEnd,
    Tuplet,
    Grace,
    Deco,
    Chord,
    Annotation,
    InlineField,
    Break,
    Overlay,
    Wedge,
    Space,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Token {
    pub kind: TokenKind,
    pub text: String,
    pub source: SourceSpan,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub degree: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub octave: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accidental: Option<Accidental>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub beams: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dots: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alter: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub den: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub broken: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub numbers: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repeat_times: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bars: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tie_next: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<Vec<Token>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acciaccatura: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grace_after: Option<bool>,
}

impl Token {
    pub fn new(kind: TokenKind, text: String, source: SourceSpan) -> Token {
        Token {
            kind,
            text,
            source,
            degree: None,
            octave: None,
            accidental: None,
            beams: None,
            dots: None,
            step: None,
            alter: None,
            num: None,
            den: None,
            broken: None,
            value: None,
            numbers: None,
            repeat_times: None,
            bars: None,
            tie_next: None,
            notes: None,
            acciaccatura: None,
            grace_after: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct LexError {
    pub msg: Msg,
    pub source: SourceSpan,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct LexResult {
    pub tokens: Vec<Token>,
    pub errors: Vec<LexError>,
}

/// 时值修饰的扫描结果：123 是 `_` / `.`，ABC 是 `2` `/2` `3/2` 这类分数
#[derive(Clone, Copy, Debug, Default)]
pub struct DurationScan {
    pub beams: u32,
    pub dots: u32,
    pub num: Option<f64>,
    pub den: Option<f64>,
    /// 整小节休止 `Z` / `Zn` 的小节数
    pub bars: Option<f64>,
    pub next: usize,
}

#[derive(Clone, Debug, Default)]
pub struct NoteScan {
    pub dur: DurationScan,
    pub degree: Option<u32>,
    pub step: Option<String>,
    pub alter: Option<i32>,
    pub octave: i32,
    pub accidental: Option<Accidental>,
}
