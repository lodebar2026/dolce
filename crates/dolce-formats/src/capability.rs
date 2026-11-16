//! **格式能力表**：每种目标格式装得下什么（同 `src/convert/capability.ts`）。
//!
//! 另存为别的格式之前，算出「这份文档里用到、但目标格式装不下」的东西列给用户。表里每一条的依据
//! （全语料实测、各模块文档的「已知限制」、`break-roundtrip-check`）写在 TS 那份开头与各格式条目旁；
//! **改这张表之前先去改那几处的实测**。名字与排序（按界面语言）留在 TS 门面。

use crate::fanqie::plan::{fanqie_arc_losses, short_open_voltas};
use dolce_model::beatgroup::{beat_group_index, beat_group_size};
use dolce_model::deconames::{chord_notehead, deco_key, notehead_of, rehearsal_of, tremolo_strokes};
use dolce_model::emitutil::{arcs_to_next_note, beam_level1, nest_arcs_in_tuplets};
use dolce_model::helpers::{each_chord, inline_break_of, verse_count};
use dolce_model::jianpu::melody_lane;
use dolce_model::jianpuproject::project_for_jianpu;
use dolce_model::pagemeta::{song_header_fonts, song_lyric_size, song_page, song_staff_size};
use dolce_model::staves::has_cross_staff;
use dolce_model::xmlsurface::Surface;
use dolce_model::{BeamVal, BreakKind, Element, Key, Mark, MarkType, ScoreDoc, Song, Spacer, Time};

macro_rules! features {
    ($($v:ident = $s:literal),* $(,)?) => {
        /// 一项「文档里可能用到、格式可能装不下」的特性（名字同 TS `Feature`）
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum Feature { $($v),* }
        impl Feature {
            pub const ALL: &'static [Feature] = &[$(Feature::$v),*];
            pub fn as_str(self) -> &'static str {
                match self { $(Feature::$v => $s),* }
            }
        }
    };
}

features! {
    Harmony = "harmony", HarmonyOffset = "harmonyOffset", MultiVoice = "multiVoice", NoteStack = "noteStack",
    InnerVoice = "innerVoice", InnerVoiceLyrics = "innerVoiceLyrics", ExtraStaff = "extraStaff", CrossStaff = "crossStaff",
    OctaveShift = "octaveShift", BeamGroup = "beamGroup", RhythmStack = "rhythmStack", RhythmPosition = "rhythmPosition",
    GraceArc = "graceArc", Dynamics = "dynamics", PlayOrder = "playOrder", SingOrder = "singOrder", SectionOrder = "sectionOrder",
    Style = "style", LayoutDirectives = "layoutDirectives", KeyChange = "keyChange", TonicDegree = "tonicDegree",
    MultiVerse = "multiVerse", Volta = "volta", ShortOpenVolta = "shortOpenVolta", Grace = "grace", Slur = "slur",
    TextLine = "textLine", MultiSong = "multiSong", PageText = "pageText", Meta = "meta", Paper = "paper",
    VerseLabel = "verseLabel", RhythmNote = "rhythmNote", InvisibleRest = "invisibleRest", NestedArc = "nestedArc",
    OddTuplet = "oddTuplet", SlurCrossTuplet = "slurCrossTuplet", LyricOnRest = "lyricOnRest", PageBreak = "pageBreak",
    Tremolo = "tremolo", Bowing = "bowing", Rehearsal = "rehearsal", MultiRest = "multiRest", Notehead = "notehead",
    Arpeggio = "arpeggio", Staccatissimo = "staccatissimo",
}

/// 目标格式（文本谱两种方言各算一种）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetFormat {
    J123,
    Abc,
    Jpwabc,
    Tomato,
    Shige,
    Jly,
    Jcx,
    MusicXml,
}

impl TargetFormat {
    pub fn parse(s: &str) -> Option<TargetFormat> {
        Some(match s {
            "123" => TargetFormat::J123,
            "abc" => TargetFormat::Abc,
            "jpwabc" => TargetFormat::Jpwabc,
            "tomato" => TargetFormat::Tomato,
            "shige" => TargetFormat::Shige,
            "jly" => TargetFormat::Jly,
            "jcx" => TargetFormat::Jcx,
            "musicxml" => TargetFormat::MusicXml,
            _ => return None,
        })
    }
}

use Feature as F;

/// 文本谱两种方言都装不下的（依据见 TS `FANQIE_GONE`）
const FANQIE_GONE: &[Feature] = &[
    F::InnerVoiceLyrics, F::BeamGroup, F::OctaveShift, F::Style, F::PlayOrder, F::SingOrder, F::SectionOrder, F::HarmonyOffset,
    F::Meta, F::Paper, F::NoteStack, F::ExtraStaff, F::RhythmStack, F::RhythmPosition, F::GraceArc, F::NestedArc, F::OddTuplet,
    F::Tremolo, F::Bowing, F::Rehearsal, F::MultiRest, F::Arpeggio, F::Notehead, F::Staccatissimo,
];
/// 只有 123 与 MusicXML 装得下的（123 的扩展写法）
const EXT_123: &[Feature] = &[F::Tremolo, F::Bowing, F::Rehearsal, F::MultiRest, F::Arpeggio, F::Notehead];

/// 目标格式装不下的特性（TS `FORMAT_CAPS` 的 `allBut(...)` 参数；依据见 TS 各条注释）
pub fn gone(target: TargetFormat) -> Vec<Feature> {
    let list: &[&[Feature]] = match target {
        TargetFormat::J123 => &[&[F::PlayOrder, F::HarmonyOffset, F::CrossStaff, F::InnerVoiceLyrics, F::SlurCrossTuplet, F::LyricOnRest, F::OctaveShift, F::BeamGroup]],
        TargetFormat::Abc => &[&[
            F::Style, F::PlayOrder, F::SingOrder, F::InnerVoiceLyrics, F::RhythmNote, F::RhythmStack, F::RhythmPosition, F::CrossStaff,
            F::OctaveShift, F::HarmonyOffset, F::LyricOnRest, F::Rehearsal, F::MultiRest,
        ]],
        TargetFormat::Jpwabc => &[
            &[
                F::SectionOrder, F::SingOrder, F::BeamGroup, F::OctaveShift, F::TonicDegree, F::Harmony, F::HarmonyOffset, F::Slur, F::Dynamics,
                F::MultiVoice, F::NoteStack, F::InnerVoice, F::ExtraStaff, F::RhythmStack, F::RhythmPosition, F::Style, F::LayoutDirectives,
                F::MultiSong, F::Grace, F::Meta, F::Paper, F::NestedArc, F::OddTuplet,
            ],
            EXT_123,
        ],
        TargetFormat::Tomato => &[FANQIE_GONE, &[F::PageText, F::LayoutDirectives, F::TonicDegree, F::ShortOpenVolta]],
        TargetFormat::Shige => &[FANQIE_GONE],
        TargetFormat::Jly => &[
            &[
                F::BeamGroup, F::OctaveShift, F::RhythmStack, F::RhythmPosition, F::InnerVoice, F::ExtraStaff, F::MultiVoice, F::MultiSong, F::Meta,
                F::Paper, F::Style, F::PageText, F::PlayOrder, F::SingOrder, F::SectionOrder, F::LayoutDirectives, F::Dynamics, F::VerseLabel,
                F::TonicDegree,
            ],
            EXT_123,
        ],
        TargetFormat::Jcx => &[
            &[
                F::BeamGroup, F::OctaveShift, F::RhythmStack, F::RhythmPosition, F::InnerVoice, F::ExtraStaff, F::MultiSong, F::Style, F::PlayOrder,
                F::SingOrder, F::SectionOrder, F::Meta, F::Paper, F::PageText, F::LayoutDirectives, F::Dynamics, F::VerseLabel, F::LyricOnRest,
                F::HarmonyOffset, F::PageBreak, F::TonicDegree,
            ],
            EXT_123,
        ],
        TargetFormat::MusicXml => &[&[F::PlayOrder, F::SingOrder, F::SectionOrder, F::Style, F::LayoutDirectives, F::NestedArc, F::OddTuplet, F::TonicDegree]],
    };
    list.iter().flat_map(|l| l.iter().copied()).collect()
}

/// 目标格式装不装得下这项
pub fn can_hold(target: TargetFormat, f: Feature) -> bool {
    !gone(target).contains(&f)
}

/// 文本谱认的版面指令（`/^(fontsize|margin|space|off)$/i`）
fn is_layout_directive(key: &str) -> bool {
    ["fontsize", "margin", "space", "off"].iter().any(|k| key.eq_ignore_ascii_case(k))
}

fn key_differs(a: &Key, b: &Key) -> bool {
    a.fifths != b.fifths
        || a.spelling.as_deref().unwrap_or("") != b.spelling.as_deref().unwrap_or("")
        || a.tonic_degree.as_deref().unwrap_or("1") != b.tonic_degree.as_deref().unwrap_or("1")
}

/// JS 真值：数字非 0 非 NaN
fn truthy(v: Option<f64>) -> bool {
    v.is_some_and(|x| x != 0.0 && !x.is_nan())
}

/// 写明的符杠分组与按拍自动连的不一样（跨拍连成一组、或一拍里断开）。只看第一层
fn irregular_beams(song: &Song) -> bool {
    for part in &song.parts {
        let mut divisions = 1.0;
        let mut time = Time { beats: 4.0, beat_type: 4.0, symbol: None, parenthesized: None };
        for m in &part.measures {
            if let Some(a) = &m.attrs {
                if truthy(a.divisions) {
                    divisions = a.divisions.unwrap();
                }
                if let Some(t) = &a.time {
                    time = t.clone();
                }
            }
            let size = beat_group_size(time.beats, time.beat_type);
            let mut end = 0.0;
            // 各声部：上一个连杠音的拍号（组号 TS 记了但不比）
            let mut prev: Vec<(f64, f64)> = vec![];
            for el in &m.elements {
                let (onset, dur) = match el {
                    Element::Chord(c) => (c.onset, if c.grace.is_some() { 0.0 } else { c.duration.divisions }),
                    Element::Space(s) => (s.onset, s.duration.as_ref().map_or(0.0, |d| d.divisions)),
                };
                let s = onset.unwrap_or(end);
                end = s + dur;
                let Element::Chord(c) = el else { continue };
                if c.grace.is_some() {
                    continue;
                }
                let at = prev.iter().position(|p| p.0 == c.voice);
                let Some(b) = beam_level1(c.beams.as_ref()) else {
                    if let Some(i) = at {
                        prev.remove(i);
                    }
                    continue;
                };
                let beat = beat_group_index(s / divisions, 0.0, size);
                if let Some(i) = at {
                    let pb = prev[i].1;
                    if b != BeamVal::Begin && pb != beat {
                        return true;
                    }
                    if b == BeamVal::Begin && pb == beat {
                        return true;
                    }
                    prev[i].1 = beat;
                } else {
                    prev.push((c.voice, beat));
                }
            }
        }
    }
    false
}

/// 这份文档实际用到了哪些特性（`surface`：MusicXML 读进来的表层，页眉字体要查它；文本来源给 None）
pub fn features_used(doc: &ScoreDoc, surface: Option<&Surface>) -> Vec<Feature> {
    let mut used: Vec<Feature> = vec![];
    let mut add = |f: Feature| {
        if !used.contains(&f) {
            used.push(f);
        }
    };
    if doc.songs.len() > 1 {
        add(F::MultiSong);
    }
    for song in &doc.songs {
        if song.parts.len() > 1 {
            add(F::MultiVoice);
        }
        if song.play_order.as_ref().is_some_and(|v| !v.is_empty()) {
            add(F::PlayOrder);
        }
        if song.sing_order.as_ref().is_some_and(|v| !v.is_empty()) {
            add(F::SingOrder);
        }
        if song.section_order.is_some() {
            add(F::SectionOrder);
        }
        if let Some(st) = &song.style {
            if st.sheet_ref.as_deref().is_some_and(|s| !s.is_empty()) || st.inline.as_ref().is_some_and(|v| !v.is_empty()) {
                add(F::Style);
            }
            for r in st.raw.iter().flatten() {
                add(if is_layout_directive(&r.key) { F::LayoutDirectives } else { F::Style });
            }
        }
        let projected = project_for_jianpu(song);
        if song.page_text.is_some() || projected.page_text.is_some() {
            add(F::PageText);
        }
        if song.meta.as_ref().is_some_and(|m| !m.is_empty()) {
            add(F::Meta);
        }
        if song_page(song).is_some() || truthy(song_staff_size(song)) || truthy(song_lyric_size(song)) || !song_header_fonts(song, surface).is_empty() {
            add(F::Paper);
        }
        if song.remarks.as_ref().is_some_and(|v| !v.is_empty()) {
            add(F::TextLine);
        }
        if verse_count(song) > 1.0 {
            add(F::MultiVerse);
        }
        if song.key.as_ref().and_then(|k| k.tonic_degree.as_deref()).is_some_and(|t| !t.is_empty() && t != "1") {
            add(F::TonicDegree);
        }
        for m in &song.marks {
            if m.kind == MarkType::Slur {
                add(F::Slur);
            }
            if m.kind == MarkType::Wedge {
                add(F::Dynamics);
            }
        }
        for part in &song.parts {
            for (mi, mea) in part.measures.iter().enumerate() {
                if mi > 0 {
                    if let (Some(k), Some(sk)) = (mea.attrs.as_ref().and_then(|a| a.key.as_ref()), song.key.as_ref()) {
                        if key_differs(k, sk) {
                            add(F::KeyChange);
                        }
                    }
                    if mea.print.as_ref().is_some_and(|p| p.new_page == Some(true)) {
                        add(F::PageBreak);
                    }
                }
                if mea.elements.iter().any(|el| inline_break_of(el) == Some(BreakKind::Page)) {
                    add(F::PageBreak);
                }
            }
            for mea in &part.measures {
                let lane = melody_lane(mea);
                if mea.barlines.iter().flatten().any(|b| b.ending.is_some()) {
                    add(F::Volta);
                }
                for d in mea.directions.iter().flatten() {
                    if d.kind == "dynamics" || d.kind == "wedge" {
                        add(F::Dynamics);
                    }
                    if d.kind == "rehearsal" || d.more.iter().flatten().any(|x| x.kind == "rehearsal") {
                        add(F::Rehearsal);
                    }
                    if d.kind == "octave-shift" {
                        add(F::OctaveShift);
                    }
                }
                if mea.attrs.as_ref().is_some_and(|a| truthy(a.multi_rest)) {
                    add(F::MultiRest);
                }
                for el in &mea.elements {
                    let c = match el {
                        Element::Space(s) => {
                            if s.spacer == Spacer::X {
                                add(F::InvisibleRest);
                            }
                            if s.harmony.is_some() {
                                add(F::Harmony);
                            }
                            continue;
                        }
                        Element::Chord(c) => c,
                    };
                    if c.harmony.is_some() {
                        add(F::Harmony);
                    }
                    let n = c.notations.as_ref();
                    let arts: &[String] = n.and_then(|n| n.articulations.as_deref()).unwrap_or(&[]);
                    if n.is_some_and(|n| truthy(n.tremolo)) || arts.iter().any(|a| tremolo_strokes(a).is_some()) {
                        add(F::Tremolo);
                    }
                    if n.and_then(|n| n.technical.as_ref()).is_some_and(|t| t.iter().any(|x| x == "up-bow" || x == "down-bow"))
                        || arts.iter().any(|a| matches!(deco_key(a), Some("sg") | Some("xg")))
                    {
                        add(F::Bowing);
                    }
                    if arts.iter().any(|a| rehearsal_of(a).is_some()) {
                        add(F::Rehearsal);
                    }
                    if arts.iter().any(|a| a == "staccatissimo" || a == "wedge") {
                        add(F::Staccatissimo);
                    }
                    if n.is_some_and(|n| n.arpeggiate == Some(true)) || arts.iter().any(|a| deco_key(a) == Some("arp")) {
                        add(F::Arpeggio);
                    }
                    let head = chord_notehead(c.notes.iter().map(|x| x.notehead.as_deref()));
                    if head.is_some_and(|h| h != "slash") || arts.iter().any(|a| notehead_of(a).is_some_and(|h| !h.is_empty())) {
                        add(F::Notehead);
                    }
                    let rhythm = c.rhythm == Some(true);
                    if c.notes.len() > 1 {
                        add(if rhythm { F::RhythmStack } else { F::NoteStack });
                    }
                    if rhythm && c.notes.iter().any(|x| x.unpitched.as_ref().is_some_and(|u| u.step.is_some())) {
                        add(F::RhythmPosition);
                    }
                    if let Some((staff, voice)) = lane {
                        if c.staff != staff {
                            add(F::ExtraStaff);
                        } else if c.voice != voice {
                            add(F::InnerVoice);
                            if c.lyrics.iter().flatten().any(|l| !l.text.is_empty()) {
                                add(F::InnerVoiceLyrics);
                            }
                        }
                    }
                    if c.grace.is_some() {
                        add(F::Grace);
                    }
                    if rhythm {
                        add(F::RhythmNote);
                    }
                    if c.section_word.as_deref().is_some_and(|s| !s.is_empty()) {
                        add(F::TextLine);
                    }
                    if c.print_object == Some(false) && c.rest.is_some() {
                        add(F::InvisibleRest);
                    }
                    if c.rest.is_some() && c.print_object != Some(false) && c.lyrics.iter().flatten().any(|l| !l.text.is_empty()) {
                        add(F::LyricOnRest);
                    }
                    if c.lyrics.iter().flatten().any(|l| l.verse_label.is_some()) {
                        add(F::VerseLabel);
                    }
                }
            }
        }
        if has_cross_staff(song) {
            add(F::CrossStaff);
        }
        if irregular_beams(song) {
            add(F::BeamGroup);
        }
        for (_, _, c) in each_chord(song) {
            if c.sustains.iter().flatten().any(|su| su.harmony.is_some()) {
                add(F::Harmony);
            }
        }
        // 长音中途换和弦：进简谱形状后还挂不到增时线上的才算
        let later = |s: &Song| each_chord(s).any(|(_, _, c)| c.later_harmonies.as_ref().is_some_and(|v| !v.is_empty()));
        if later(song) && later(&projected) {
            add(F::HarmonyOffset);
        }
        // 跨出多连音的弧：连到下一个音的写成 `~`，不算；判据与写出端同一份
        let is_arc = |m: &Mark| m.kind == MarkType::Slur || m.kind == MarkType::Tied;
        for part in &song.parts {
            let nest = nest_arcs_in_tuplets(part, &song.marks, is_arc);
            if nest.crossed_marks.len() > arcs_to_next_note(part, &song.marks, is_arc, None).len() {
                add(F::SlurCrossTuplet);
            }
        }
        if song.parts.iter().any(|p| !short_open_voltas(p).is_empty()) {
            add(F::ShortOpenVolta);
        }
        let arcs = fanqie_arc_losses(song);
        if arcs.nested > 0 {
            add(F::NestedArc);
        }
        if arcs.odd_tuplet > 0 {
            add(F::OddTuplet);
        }
        if arcs.grace_arc > 0 {
            add(F::GraceArc);
        }
    }
    used
}

/// 存成 `target` 会丢掉什么 = 用到的 ∖ 目标装得下的（按发现的先后；TS 门面按名字排）
pub fn plan_save(doc: &ScoreDoc, target: TargetFormat, surface: Option<&Surface>) -> Vec<Feature> {
    let gone = gone(target);
    features_used(doc, surface).into_iter().filter(|f| gone.contains(f)).collect()
}
