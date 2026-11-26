//! 断句的输入形状（TS `score/phraseinput.ts`）。小节里只收和弦（TS 的 `chordsOf(m)`，次序不变）；
//! 产物里引用和弦一律用**拍平下标**：各小节和弦按小节次序首尾相接后的序号（TS 侧按同样次序认回对象）。

use crate::base::Fraction;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct PhraseLyric {
    pub text: String,
    pub number: f64,
    pub refrain: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct PhraseNote {
    /// 唱名 "0"–"7"
    pub number: String,
    pub jp_octave: f64,
    pub tie_start: bool,
    pub tie_end: bool,
    pub lyrics: Vec<PhraseLyric>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct PhraseChord {
    pub notes: Vec<PhraseNote>,
    pub rest: bool,
    /// 增时线格数（含本音，1 起）
    pub beats: f64,
    /// 减时线条数
    pub beams: f64,
    pub dot: f64,
    #[serde(default)]
    pub duration: Option<Fraction>,
    /// 小节内位置（四分音符为 1）
    pub position: Fraction,
    pub fermata: bool,
    pub slur_start: bool,
    pub slur_ends: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct PhraseMeasure {
    /// 小节里的和弦（TS `chordsOf(m)`）
    pub chords: Vec<PhraseChord>,
    /// 小节右边的小节线样式（MusicXML token，原样；没写为 None）
    #[serde(default)]
    pub barline: Option<String>,
    pub repeat_backward: bool,
    pub repeat_forward: bool,
    pub key_change: bool,
    pub ending_left: bool,
    /// "start" / "stop" / "discontinue"；None = TS 的 null
    #[serde(default)]
    pub ending_right: Option<String>,
    #[serde(default)]
    pub section_mark: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct PhrasePart {
    pub measures: Vec<PhraseMeasure>,
}

impl PhrasePart {
    /// 各小节和弦首尾相接（拍平下标的次序）。
    pub fn flat_chords(&self) -> impl Iterator<Item = &PhraseChord> {
        self.measures.iter().flat_map(|m| m.chords.iter())
    }
}
