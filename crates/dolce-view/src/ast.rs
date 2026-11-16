//! 文本谱（番茄简谱 / 诗歌本文本谱）的抽象语法树（同 `jianpu/ast.ts`）。
//!
//! 每个节点都带 `source` 源码区间（UTF-16）。时值用 `duration` 表示**分母**（4=四分，8=八分……），`dots` 是附点个数。
//! 文本谱解析器（`dolce-formats::fanqie`，进 `ScoreDoc` 之前的中间产物）与排版行视图（[`crate::slots`]）产同一套形状。
//! JSON 形状照 TS（对拍时与 `parseFanqieAst` / `docView` 逐字段比）。
//! 行内下标（`Mark.start/end`）用 `i64`：行视图里空房号的终点在起点前一位（行首的为 −1）。

use dolce_base::SourceSpan;
use dolce_model::{Accidental, Diagnostic, Tempo};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meter {
    pub numerator: f64,
    pub denominator: f64,
    /// 辅助拍号写在括号里：`P: 4/4 ( 2/4 )`
    pub parenthesized: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct KeyValue {
    pub key: String,
    pub value: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    #[serde(skip_serializing_if = "Option::is_none")] pub version: Option<String>,
    /// 第一条为主标题，其余为副标题
    pub titles: Vec<String>,
    pub authors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub scripture: Option<Vec<String>>,
    /// 调号，如 `C` `bE` `#F`
    #[serde(skip_serializing_if = "Option::is_none")] pub mode: Option<String>,
    /// 主音唱名：`1=D` 省略；`6=c` 记 "6"
    #[serde(skip_serializing_if = "Option::is_none")] pub tonic: Option<String>,
    pub remarks: Vec<String>,
    pub meters: Vec<Meter>,
    #[serde(skip_serializing_if = "Option::is_none")] pub time_note: Option<String>,
    pub tempos: Vec<Tempo>,
    #[serde(skip_serializing_if = "Option::is_none")] pub tempo_mark: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub index_left: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub index_right: Option<String>,
    pub top_left: Vec<String>,
    pub top_right: Vec<String>,
    pub bottom_left: Vec<String>,
    pub bottom_center: Vec<String>,
    pub bottom_right: Vec<String>,
    pub font_sizes: Vec<String>,
    pub margins: Vec<String>,
    pub options: Vec<KeyValue>,
}

/// `&xx` 记号。`level` 是紧跟的 `+` 个数。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Ornament {
    pub name: String,
    pub level: f64,
    pub source: SourceSpan,
    #[serde(skip_serializing_if = "Option::is_none")] pub below: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Sound {
    Note,
    Rest,
    Rhythm,
}

/// 和音里叠在上面的一个音（只有 123 / MusicXML 来源的视图有）
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StackedNote {
    pub pitch: u32,
    pub octave: i32,
    #[serde(skip_serializing_if = "Option::is_none")] pub accidental: Option<Accidental>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteElement {
    /// 0=休止，1–7=唱名，9=节奏音符（仅番茄）
    pub pitch: u32,
    pub sound: Sound,
    /// 隐藏音符：占位不显形
    pub hidden: bool,
    #[serde(skip_serializing_if = "Option::is_none")] pub placeholder: Option<bool>,
    /// 隐藏音符是否仍参与歌词对位
    pub lyric_anchor: bool,
    /// 正数为高八度点个数，负数为低八度点
    pub octave: i32,
    /// 时值分母：4=四分，8=八分……
    pub duration: u32,
    pub dots: u32,
    #[serde(skip_serializing_if = "Option::is_none")] pub accidental: Option<Accidental>,
    pub ornaments: Vec<Ornament>,
    #[serde(with = "tagged_notes")]
    pub grace_before: Vec<NoteElement>,
    #[serde(with = "tagged_notes")]
    pub grace_after: Vec<NoteElement>,
    #[serde(skip_serializing_if = "Option::is_none")] pub stack: Option<Vec<StackedNote>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub multi_rest: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub annotation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub chord: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub key_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub annotation_source: Option<SourceSpan>,
    #[serde(skip_serializing_if = "Option::is_none")] pub chord_source: Option<SourceSpan>,
    pub code: String,
    pub source: SourceSpan,
}

/// 增时线 `-`：延长前一个音符一拍。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SustainElement {
    pub duration: u32,
    pub lyric_anchor: bool,
    pub ornaments: Vec<Ornament>,
    #[serde(skip_serializing_if = "Option::is_none")] pub annotation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub chord: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub annotation_source: Option<SourceSpan>,
    #[serde(skip_serializing_if = "Option::is_none")] pub chord_source: Option<SourceSpan>,
    pub code: String,
    pub source: SourceSpan,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BarlineType {
    Normal,
    End,
    Double,
    RepeatStart,
    RepeatEnd,
    RepeatBoth,
    Hidden,
    Invisible,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BarlineElement {
    #[serde(rename = "type")]
    pub kind: BarlineType,
    pub ornaments: Vec<Ornament>,
    #[serde(skip_serializing_if = "Option::is_none")] pub temporary_meter: Option<Meter>,
    #[serde(skip_serializing_if = "Option::is_none")] pub temporary_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub annotation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub repeat_forward_after: Option<bool>,
    pub code: String,
    pub source: SourceSpan,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Behavior {
    Join,
    Split,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BeatBoundaryElement {
    pub behavior: Behavior,
    pub code: String,
    pub source: SourceSpan,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LayerRole {
    Accompaniment,
    Voice,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InlineLayerElement {
    pub role: LayerRole,
    #[serde(skip_serializing_if = "Option::is_none")] pub below: Option<bool>,
    pub elements: Vec<MusicElement>,
    /// 并排块各元素在模型里的 id（补拍位的不可见休止是负的临时号；夹层没有 id 为 null）
    #[serde(skip_serializing_if = "Option::is_none")] pub ids: Option<Vec<Option<i64>>>,
    pub marks: Vec<Mark>,
    pub code: String,
    pub source: SourceSpan,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum MusicElement {
    Note(NoteElement),
    Sustain(SustainElement),
    Barline(BarlineElement),
    BeatBoundary(BeatBoundaryElement),
    InlineLayer(InlineLayerElement),
}

impl MusicElement {
    pub fn source(&self) -> &SourceSpan {
        match self {
            MusicElement::Note(n) => &n.source,
            MusicElement::Sustain(s) => &s.source,
            MusicElement::Barline(b) => &b.source,
            MusicElement::BeatBoundary(b) => &b.source,
            MusicElement::InlineLayer(l) => &l.source,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MarkType {
    Slur,
    Tuplet,
    Crescendo,
    Decrescendo,
    Volta,
}

/// 跨若干元素的记号。`start`/`end` 是行内元素下标（闭区间）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    #[serde(rename = "type")]
    pub kind: MarkType,
    pub start: i64,
    pub end: i64,
    pub level: f64,
    #[serde(skip_serializing_if = "Option::is_none")] pub caption: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub open_end: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] pub continuation_from_previous: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] pub continuation_to_next: Option<bool>,
    pub source: SourceSpan,
    #[serde(skip_serializing_if = "Option::is_none")] pub close_source: Option<SourceSpan>,
    #[serde(skip_serializing_if = "Option::is_none")] pub digits: Option<[u32; 2]>,
    /// 解析期身份（跨行弧线到最后没收口时，按它把已经落下的半条撤掉；TS 按对象身份）
    #[serde(skip)]
    pub uid: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricSyllable {
    /// 空串表示「跳过一个音符」
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")] pub trailing_punctuation: Option<String>,
    pub source: SourceSpan,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    pub verse_from: f64,
    pub verse_to: f64,
    #[serde(skip_serializing_if = "Option::is_none")] pub annotation: Option<String>,
    pub annotation_gap: f64,
    pub syllables: Vec<LyricSyllable>,
    #[serde(skip_serializing_if = "Option::is_none")] pub join_brace: Option<bool>,
    pub source: SourceSpan,
}

/// 一行曲（`Q:` / `Q1:`），连同挂在它下面的歌词行。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScoreLine {
    pub voice: f64,
    #[serde(skip_serializing_if = "Option::is_none")] pub variant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub caption: Option<String>,
    pub elements: Vec<MusicElement>,
    pub marks: Vec<Mark>,
    pub lyrics: Vec<LyricLine>,
    pub raw: String,
    pub source: SourceSpan,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TextLine {
    pub text: String,
    pub source: SourceSpan,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VoiceGroup {
    pub index: usize,
    pub texts: Vec<TextLine>,
    pub voices: Vec<ScoreLine>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScorePage {
    pub index: usize,
    pub groups: Vec<VoiceGroup>,
    #[serde(skip_serializing_if = "Option::is_none")] pub break_source: Option<SourceSpan>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FanqieSong {
    pub index: usize,
    pub metadata: Metadata,
    pub pages: Vec<ScorePage>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FanqieDoc {
    pub dialect: String,
    pub source: String,
    pub songs: Vec<FanqieSong>,
    pub diagnostics: Vec<Diagnostic>,
}

/// 倚音也是完整的音符元素：JSON 里带 `kind: "note"`（同 TS）
mod tagged_notes {
    use super::{MusicElement, NoteElement};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    #[derive(Serialize)]
    #[serde(tag = "kind", rename_all = "kebab-case")]
    enum Tagged<'a> {
        Note(&'a NoteElement),
    }

    pub fn serialize<S: Serializer>(v: &[NoteElement], s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(v.iter().map(Tagged::Note))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<NoteElement>, D::Error> {
        let v = Vec::<MusicElement>::deserialize(d)?;
        Ok(v.into_iter().filter_map(|e| if let MusicElement::Note(n) = e { Some(n) } else { None }).collect())
    }
}
