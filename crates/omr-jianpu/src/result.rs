//! 结果模型：形状同 web `omrkit/types.ts::RecognizedScore`（TS 的 `recognizedToDoc`、核对叠加视图直接吃这份 JSON），
//! 另加可疑清单。字段含义见那边的注释，这里只留与识别有关的说明。
use dolce_omr_core::image::Rect;
use serde::Serialize;

fn zero(v: &u32) -> bool {
    *v == 0
}
fn no(v: &bool) -> bool {
    !*v
}

/// 节奏音符 X（有声无音高）在 `digit` 里的值。
pub const RHYTHM_DIGIT: u8 = 9;

#[derive(Clone, Debug, Default, Serialize)]
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
    /// 各段歌词（下标 = 段，空串 = 这段没字）
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub lyrics: Vec<String>,
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

/// 把握不大的一处（计划 §2.8）：涉及的音（行、行内第几个）、原因码。
#[derive(Clone, Debug, Serialize)]
pub struct Doubt {
    pub row: usize,
    pub note: Option<usize>,
    pub bbox: Rect,
    pub reason: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognizedScore {
    pub key: String,
    pub fifths: i32,
    #[serde(skip_serializing_if = "no")]
    pub minor: bool,
    pub beats: u32,
    pub beat_type: u32,
    pub rows: Vec<StaffRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number_side: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dot_diam: Option<f64>,
    /// 可疑清单（TS 那份没有；核对视图现读各音的 `doubt`，这份供回归统计）
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub doubts: Vec<Doubt>,
}
