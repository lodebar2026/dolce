//! 结果模型：形状同 web `omrkit/types.ts::RecognizedScore`（TS 的 `recognizedToDoc`、核对叠加视图直接吃这份 JSON），
//! 另加可疑清单。字段含义见那边的注释，这里只留与识别有关的说明。
use dolce_omr_core::image::Rect;
use serde::Serialize;

fn zero(v: &u32) -> bool {
    *v == 0
}
fn single(v: &[TimeSig]) -> bool {
    v.len() < 2
}
fn no(v: &bool) -> bool {
    !*v
}

/// 节奏音符 X（有声无音高）在 `digit` 里的值。
pub const RHYTHM_DIGIT: u8 = 9;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeSig {
    pub beats: u32,
    pub beat_type: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tuplet {
    pub actual: u32,
    pub normal: u32,
    pub start: bool,
    pub stop: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Grace {
    pub digit: u8,
    pub octave: i32,
    pub div: u32,
    pub bbox: Rect,
}

/// 落选的时值候选（计划 §2.8）：证据差一点没收（或勉强收了）的减时线、附点、增时线。满拍裁决只在这些候选里挑。
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AltKind {
    DivPlus,
    DivMinus,
    DotPlus,
    DotMinus,
    AugPlus,
    AugMinus,
}

impl AltKind {
    /// 原因码的尾巴。
    pub fn code(self) -> &'static str {
        match self {
            AltKind::DivPlus => "div+",
            AltKind::DivMinus => "div-",
            AltKind::DotPlus => "dot+",
            AltKind::DotMinus => "dot-",
            AltKind::AugPlus => "aug+",
            AltKind::AugMinus => "aug-",
        }
    }
}

/// `cost`：改成这个候选要付的代价（证据越弱越大），裁决取总代价最小的一组。
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Alt {
    pub kind: AltKind,
    pub cost: f64,
}

/// 同一个音时值内后面换的和弦：`offset` 是落在时值里的比例。
#[derive(Clone, Debug, Serialize)]
pub struct ExtraChord {
    pub tok: String,
    pub offset: f64,
}

/// 一个简谱音符（数字 + 修饰）。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JpNum {
    /// 0–7（0 = 休止）；9 = 节奏音符 X
    pub digit: u8,
    pub bbox: Rect,
    pub dot: u32,
    pub octave: i32,
    /// 减时线条数
    pub div: u32,
    /// 增时线条数
    pub augment: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub augment_rects: Vec<Rect>,
    /// 复核：把握不大的原因码
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub doubt: Vec<String>,
    /// 读成「1」的格其实像一根光竖条（没有旗、没有底座）：也许是小节线（不写出）
    #[serde(skip)]
    pub bar_like: bool,
    /// 落选的时值候选（换候选用；TS 的 `JpNum` 没有这一项，读入时忽略）
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub alts: Vec<Alt>,
    /// 各段歌词（下标 = 段，空串 = 这段没字）
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub lyrics: Vec<String>,
    /// 复核：哪几段（0 起）的歌词字把握不大（OCR 第一名不是它，或第一名领先第二名不到 [`crate::text::LYRIC_DOUBT_MARGIN`]）
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub lyric_doubt: Vec<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section_mark: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub dynamics: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chord: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chord_offset: Option<f64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub extra_chords: Vec<ExtraChord>,
    #[serde(skip_serializing_if = "zero")]
    pub slur_start: u32,
    #[serde(skip_serializing_if = "zero")]
    pub slur_stop: u32,
    #[serde(skip_serializing_if = "no")]
    pub tie_start: bool,
    #[serde(skip_serializing_if = "no")]
    pub tie_stop: bool,
    #[serde(skip_serializing_if = "no")]
    pub repeat_forward: bool,
    #[serde(skip_serializing_if = "no")]
    pub repeat_backward: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ending_start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ending_stop: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub jump_marks: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub jump_below: Vec<String>,
    #[serde(skip_serializing_if = "no")]
    pub segno: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_change: Option<TimeSig>,
    /// `sharp` / `flat` / `natural`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accidental: Option<&'static str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub grace: Vec<Grace>,
    #[serde(skip_serializing_if = "no")]
    pub fermata: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tuplet: Option<Tuplet>,
    /// `staccato` / `accent`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub articulation: Option<&'static str>,
    /// `upper-mordent` / `lower-mordent`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ornament: Option<&'static str>,
    /// 下滑音
    #[serde(skip_serializing_if = "no")]
    pub fall: bool,
}

/// 一行谱识别出的内容。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaffRow {
    pub top_y: f64,
    pub bottom_y: f64,
    pub nums: Vec<JpNum>,
    pub barline_xs: Vec<f64>,
    /// `end`：行末是终止线
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_barline: Option<&'static str>,
    /// 终止线只按位置认的（两根没分出粗细）：跳转曲写出端据此写细细双线
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub final_barline_thin: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub double_bar_xs: Vec<f64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub end_bar_xs: Vec<f64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub lyric_labels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TextRegion {
    pub text: String,
    pub bbox: Rect,
}

/// 可疑项：两条路线共用的那份（`omr-sheet::result`）；`at.row` 是全曲第几行、`at.note` 是行内第几个音。
pub use dolce_omr_sheet::result::Doubt;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognizedScore {
    pub key: String,
    pub fifths: i32,
    #[serde(skip_serializing_if = "no")]
    pub minor: bool,
    pub beats: u32,
    pub beat_type: u32,
    /// 混合拍：页眉并排印着的全部拍号（头一个即 beats / beat_type）；只印一个时不写
    #[serde(skip_serializing_if = "single")]
    pub meters: Vec<TimeSig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meter_note: Option<String>,
    /// 页眉里读到了拍号（没读到的是缺省 4/4；不写出）
    #[serde(skip)]
    pub meter_read: bool,
    pub rows: Vec<StaffRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number_side: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    /// 紧贴第一行副标题、同样居中的第二行
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub subtitles_more: Vec<String>,
    /// 页眉里整行包在方括号里的谱面说明（`[ 共2张：A（原调）、G调 ]`），写 N:
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub header_notes: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub credits: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub credits_top_left: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tempo: Option<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub header_regions: Vec<TextRegion>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub lyric_regions: Vec<TextRegion>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub chord_regions: Vec<TextRegion>,
    /// 谱后单独排版、按第 1 段骨架落到音上的附段：各行原文与源框
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub stanza_regions: Vec<TextRegion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dot_diam: Option<f64>,
    /// 可疑清单（TS 那份没有；核对视图现读各音的 `doubt`，这份供回归统计）
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub doubts: Vec<Doubt>,
}
