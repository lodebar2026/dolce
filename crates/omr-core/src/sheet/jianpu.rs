//! 简谱识别结果模型（`omr-jianpu` 产出）：形状同 web `omr/types.ts::RecognizedScore`（核对叠加视图直接吃这份 JSON），
//! 另加可疑清单。字段含义见那边的注释，这里只留与识别有关的说明。
//!
//! 能读回（`Deserialize`）：编辑器核对时会改它（参照歌词改字），换输出格式时把改过的那份送回 Rust 建模（`omr-core::todoc::jianpu`）。
//! 只在识别中途用的字段（`#[serde(skip)]`）读回取缺省。
/// 可疑项：两条路线共用的那份（`result`）；`at.row` 是全曲第几行、`at.note` 是行内第几个音。
pub use crate::sheet::result::Doubt;
use crate::image::Rect;
use serde::{Deserialize, Deserializer, Serialize};

/// 几个取值固定的字段（升降号、奏法、终止线…）是字面量；写成别名，免得 serde 见了 `&'static str` 就要求 `'de: 'static`（读回走 [`de_static`]）。
pub type Lit = &'static str;

/// 读回时认回同一个字面量，认不得的报错。
fn de_static<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Lit>, D::Error> {
    const KNOWN: [&str; 9] = ["sharp", "flat", "natural", "staccato", "accent", "upper-mordent", "lower-mordent", "end", "right"];
    let Some(s) = Option::<String>::deserialize(d)? else { return Ok(None) };
    let s = if s == "left" { "left" } else { KNOWN.iter().find(|k| **k == s).copied().ok_or_else(|| serde::de::Error::custom(format!("认不得的取值「{s}」")))? };
    Ok(Some(s))
}

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

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeSig {
    pub beats: u32,
    pub beat_type: u32,
}

/// 曲中转调（谱面「转1=F」「D大調」）：五度圈位置（小调记关系大调的升降号数）与是否小调。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySig {
    pub fifths: i32,
    #[serde(default, skip_serializing_if = "no")]
    pub minor: bool,
}

/// 一个歌词汉字的 OCR 候选：第几段、该段歌词串里第几个汉字、前几名与得分（降序）、字的源框。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct LyricAlt {
    pub verse: usize,
    pub idx: usize,
    pub alts: Vec<String>,
    pub scores: Vec<f32>,
    pub bbox: Rect,
}

/// 谱行里印的转拍号：位置、拍号、源框。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowMeter {
    pub x: f64,
    pub beats: u32,
    pub beat_type: u32,
    pub bbox: Rect,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tuplet {
    pub actual: u32,
    pub normal: u32,
    pub start: bool,
    pub stop: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Grace {
    pub digit: u8,
    pub octave: i32,
    pub div: u32,
    pub bbox: Rect,
}

/// 落选的时值候选（计划 §2.8）：证据差一点没收（或勉强收了）的减时线、附点、增时线。满拍裁决只在这些候选里挑。
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
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
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Alt {
    pub kind: AltKind,
    pub cost: f64,
}

/// 同一个音时值内后面换的和弦：`offset` 是落在时值里的比例。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExtraChord {
    pub tok: String,
    pub offset: f64,
}

/// 一个简谱音符（数字 + 修饰）。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub augment_rects: Vec<Rect>,
    /// 复核：把握不大的原因码
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub doubt: Vec<String>,
    /// 读成「1」的格其实像一根光竖条（没有旗、没有底座）：也许是小节线（不写出）
    #[serde(skip)]
    pub bar_like: bool,
    /// 收下的八度点（连通块 id、在上、离数字多远）：上下两行都收了同一个点时按缝小的归（`lib::settle_shared_dots`）
    #[serde(skip)]
    pub oct_dots: Vec<(i32, bool, f64)>,
    /// 粘在数字顶上（或弧端）探出来的高音点离数字顶多远：等全页认出的高音点缝定了再裁决（`lib::promote_glued_up`）
    #[serde(skip)]
    pub glued_up: Option<f64>,
    /// 歌词里的英文词（段、字迹左缘、右缘）：认完弧后按拼写拆到罩着的空音上（`text::split_spanning_words`）
    #[serde(skip)]
    pub word_ext: Vec<(usize, f64, f64)>,
    /// 歌词汉字的 OCR 候选（参照歌词互证选字用，TS `LyricHooks.rankAlts` / `regionOf` 读它）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lyric_alts: Vec<LyricAlt>,
    /// 落选的时值候选（换候选用；TS 的 `JpNum` 没有这一项，读入时忽略）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alts: Vec<Alt>,
    /// 各段歌词（下标 = 段，空串 = 这段没字）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lyrics: Vec<String>,
    /// 复核：哪几段（0 起）的歌词字把握不大（OCR 第一名不是它，或第一名领先第二名不到 `omr-jianpu::text::LYRIC_DOUBT_MARGIN`）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lyric_doubt: Vec<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_mark: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dynamics: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chord: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chord_offset: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_chords: Vec<ExtraChord>,
    #[serde(default, skip_serializing_if = "zero")]
    pub slur_start: u32,
    #[serde(default, skip_serializing_if = "zero")]
    pub slur_stop: u32,
    #[serde(default, skip_serializing_if = "no")]
    pub tie_start: bool,
    #[serde(default, skip_serializing_if = "no")]
    pub tie_stop: bool,
    #[serde(default, skip_serializing_if = "no")]
    pub repeat_forward: bool,
    #[serde(default, skip_serializing_if = "no")]
    pub repeat_backward: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ending_start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ending_stop: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub jump_marks: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub jump_below: Vec<String>,
    #[serde(default, skip_serializing_if = "no")]
    pub segno: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_change: Option<TimeSig>,
    /// 曲中转调：从这个音起换调（同 `time_change` 锚在音上，建模时提升为所在小节的调号）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_change: Option<KeySig>,
    /// `sharp` / `flat` / `natural`
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de_static")]
    pub accidental: Option<Lit>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub grace: Vec<Grace>,
    #[serde(default, skip_serializing_if = "no")]
    pub fermata: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tuplet: Option<Tuplet>,

    /// `staccato` / `accent`
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de_static")]
    pub articulation: Option<Lit>,
    /// `upper-mordent` / `lower-mordent`
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de_static")]
    pub ornament: Option<Lit>,
    /// 下滑音
    #[serde(default, skip_serializing_if = "no")]
    pub fall: bool,
}

/// 拍单位（分数）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BeatUnit {
    pub num: u32,
    pub den: u32,
}

/// 一行谱识别出的内容。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaffRow {
    pub top_y: f64,
    pub bottom_y: f64,
    pub nums: Vec<JpNum>,
    pub barline_xs: Vec<f64>,
    /// `end`：行末是终止线
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de_static")]
    pub final_barline: Option<Lit>,
    /// 终止线只按位置认的（两根没分出粗细）：跳转曲写出端据此写细细双线
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub final_barline_thin: bool,
    /// 行里印的转拍号（按 x 排）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub meters: Vec<RowMeter>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub double_bar_xs: Vec<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub end_bar_xs: Vec<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lyric_labels: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TextRegion {
    pub text: String,
    pub bbox: Rect,
    /// 逐字源图位置（页眉行用 OCR 的字位；识别模式据此逐字落回源图 x）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub chars: Vec<RegionChar>,
}

/// 页眉行里一个字的源图中心 x。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RegionChar {
    pub text: String,
    pub cx: f64,
}


#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognizedScore {
    pub key: String,
    pub fifths: i32,
    #[serde(default, skip_serializing_if = "no")]
    pub minor: bool,
    pub beats: u32,
    pub beat_type: u32,
    /// 混合拍：页眉并排印着的全部拍号（头一个即 beats / beat_type）；只印一个时不写
    #[serde(default, skip_serializing_if = "single")]
    pub meters: Vec<TimeSig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meter_note: Option<String>,
    /// 页眉里读到了拍号（没读到的是缺省 4/4；不写出）
    #[serde(skip)]
    pub meter_read: bool,
    pub rows: Vec<StaffRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de_static")]
    pub number_side: Option<Lit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    /// 紧贴第一行副标题、同样居中的第二行
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subtitles_more: Vec<String>,
    /// 页眉里整行包在方括号里的谱面说明（`[ 共2张：A（原调）、G调 ]`），写 N:
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub header_notes: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub credits: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub credits_top_left: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tempo: Option<u32>,
    /// 谱后的「注：…」（注文折行的接续行并成一条），写出端记左下页文
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub footnotes: Vec<String>,
    /// 谱后附段对不上第 1 段的音（按句、按总字数都对不上）时照印的行原样记下，写出端记曲末歌词（123 `W:`）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub post_lyrics: Vec<String>,
    /// 速度的拍单位（附点四分 `♩.=` 为 3/8）；缺省四分
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tempo_beat: Option<BeatUnit>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub header_regions: Vec<TextRegion>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lyric_regions: Vec<TextRegion>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub chord_regions: Vec<TextRegion>,
    /// 谱后单独排版、按第 1 段骨架落到音上的附段：各行原文与源框
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stanza_regions: Vec<TextRegion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dot_diam: Option<f64>,
    /// 可疑清单（TS 那份没有；核对视图现读各音的 `doubt`，这份供回归统计）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub doubts: Vec<Doubt>,
}
