//! 演唱顺序连同跳转表、速度（TS `score/playtypes.ts::PlayData`）：由 `ScoreDoc` 推出来（[`crate::view::playsong`]、[`crate::view::playdoc`]），
//! 交给试听（`PlaySource`）、投影档（`expand.ts::walkPlay`）与 `.jpwabc` 写出端。

use crate::base::Fraction;
use crate::{ElementId, Song};
use crate::play::playorder::{JumpSpec, PlayChord, PlayItem, PlayJumps, PlayLyric, PlayMeasure, PlayNote, PlayOrder, PlayPart, PlaySpecKind, SectionMark, SingItem, SingPassSpec, TimePosition};
use crate::play::timeline::{PlaySourceOrder, TimelineChord, TimelineLyric, TimelineMeasure, TimelineNote};
use serde::Serialize;

use crate::view::phrasesong::{ChordOut, MeasureOut};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayData {
    /// 名字不重复（TS 是 `Map`：再设同名的换值、位置不变）
    pub coda: Vec<(String, TimePosition)>,
    pub segno: Vec<(String, TimePosition)>,
    /// TS 以 `TimePosition` 对象为键：各处新建的对象各占一条
    pub jump_to: Vec<(TimePosition, JumpSpec)>,
    pub measures: Vec<PlayItem>,
    /// `PlayItem::scope` 指的段落小节表
    pub scopes: Vec<Vec<f64>>,
    pub has_repeat: bool,
    /// 没有反复、只是多段词逐段一遍（TS 字段名原样 `isSimpple`）
    #[serde(rename = "isSimpple")]
    pub is_simple: bool,
    /// 第一处漏写 `:|` 的房；没有为 -1
    pub implied_repeat: f64,
    /// 顺序来自头部 `P:`
    pub from_sections: bool,
    /// 顺序来自逐遍演唱顺序（123 `%%sing`）
    pub from_sing: bool,
    /// 谱面速度（♩=），0 = 未标注
    pub tempo: f64,
}

impl Default for PlayData {
    fn default() -> Self {
        PlayData {
            coda: vec![],
            segno: vec![],
            jump_to: vec![],
            measures: vec![],
            scopes: vec![],
            has_repeat: false,
            is_simple: false,
            implied_repeat: -1.0,
            from_sections: false,
            from_sing: false,
            tempo: 0.0,
        }
    }
}

/// `Map.set`：已有同名的换值（位置不变），否则接在末尾
pub(crate) fn map_set(map: &mut Vec<(String, TimePosition)>, key: &str, t: TimePosition) {
    match map.iter_mut().find(|(k, _)| k == key) {
        Some(e) => e.1 = t,
        None => map.push((key.to_string(), t)),
    }
}

impl PlayData {
    pub fn jumps(&self) -> PlayJumps {
        PlayJumps { coda: self.coda.clone(), segno: self.segno.clone(), jump_to: self.jump_to.clone() }
    }

    /// 推出来的顺序落进来（`isSimpple` / `measures` / `hasRepeat` / `impliedRepeat`）
    pub fn take_order(&mut self, o: PlayOrder) {
        self.is_simple = o.is_simple;
        self.measures = o.measures;
        self.scopes = o.scopes;
        self.has_repeat = o.has_repeat;
        self.implied_repeat = o.implied_repeat;
    }

    /// 没有反复、跳转（`.jpwabc` 写出端据此不写 `.Repeat`）
    pub fn no_repeat(&self) -> bool {
        !self.has_repeat && self.coda.is_empty() && self.segno.is_empty() && self.jump_to.is_empty()
    }

    /// 试听那份（演唱顺序、速度、段落小节表）
    pub fn source_order(&self) -> PlaySourceOrder {
        PlaySourceOrder { measures: self.measures.clone(), tempo: self.tempo, scopes: self.scopes.clone() }
    }
}

pub(crate) fn jump(kind: PlaySpecKind, value: Option<&str>) -> JumpSpec {
    JumpSpec { kind, value: value.map(str::to_string) }
}

// ───────────────────────── 小节序列 → 推演唱顺序 / 时间轴的输入 ─────────────────────────

pub(crate) fn play_measure_of(m: &MeasureOut) -> PlayMeasure {
    PlayMeasure {
        chords: m
            .entries
            .iter()
            .map(|c| PlayChord {
                notes: c
                    .notes
                    .iter()
                    .map(|n| PlayNote {
                        tie_start: n.tie_start,
                        tie_end: n.tie_end,
                        lyrics: n.lyrics.iter().map(|l| PlayLyric { number: l.number, text: Some(l.text.clone()) }).collect(),
                    })
                    .collect(),
                position: c.position,
                slur_start: c.slur_start,
                slur_ends: c.slur_ends,
            })
            .collect(),
        duration: m.duration().ok(),
        repeat_backward: m.repeat_backward,
        repeat_forward: m.repeat_forward,
        ending_left: m.ending_left,
        ending_num: m.ending_num.clone(),
        ending_right: m.ending_right.clone(),
        barline: m.barline.clone(),
    }
}

pub(crate) fn play_part_of(measures: &[Option<&MeasureOut>]) -> PlayPart {
    PlayPart { measures: measures.iter().map(|m| m.map(play_measure_of)).collect() }
}

/// 时间轴的和弦：`ident` 由调用方按出场次序发
pub(crate) fn timeline_chord_of(c: &ChordOut, ident: usize) -> TimelineChord {
    TimelineChord {
        ident,
        id: c.id,
        notes: c
            .notes
            .iter()
            .map(|n| TimelineNote {
                pitch: n.pitch,
                tie_stop: n.tie_stop,
                lyrics: n
                    .lyrics
                    .iter()
                    .map(|l| TimelineLyric { text: l.text.clone(), number: l.number, refrain: l.refrain, extend: l.extend })
                    .collect(),
            })
            .collect(),
        rest: c.rest,
        position: c.position,
        duration: c.duration,
        velocity: None,
        cursor: None,
        slur_start: c.slur_start,
        slur_ends: c.slur_ends,
    }
}

pub(crate) fn timeline_measure_of(m: &MeasureOut, next: &mut usize) -> TimelineMeasure {
    TimelineMeasure {
        chords: m
            .entries
            .iter()
            .map(|c| {
                *next += 1;
                timeline_chord_of(c, *next - 1)
            })
            .collect(),
        duration: m.duration().ok(),
        time: m.time,
        key: m.key,
    }
}

pub(crate) fn zero() -> Fraction {
    Fraction::int(0.0)
}

/// 段落标记按 `locate` 落到 (声部排位, 小节, 第几个和弦)；只留排位最前的那个声部上的
pub(crate) fn locate_section_marks(song: &Song, locate: impl Fn(ElementId) -> Option<(usize, f64, f64)>) -> Vec<SectionMark> {
    let found: Vec<(String, (usize, f64, f64))> = song.section_marks.iter().flatten().filter_map(|m| locate(m.before).map(|at| (m.name.clone(), at))).collect();
    let Some(rank) = found.iter().map(|(_, at)| at.0).min() else { return vec![] };
    found.into_iter().filter(|(_, at)| at.0 == rank).map(|(name, (_, mid, skip))| SectionMark { name, mid, skip }).collect()
}

pub(crate) fn sing_specs(song: &Song) -> Vec<SingPassSpec> {
    song.sing_order
        .iter()
        .flatten()
        .map(|p| SingPassSpec { items: p.items.iter().map(|it| SingItem { section: it.section.clone(), verse: it.verse }).collect() })
        .collect()
}
