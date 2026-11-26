//! `ScoreDoc` → **排版行视图**（同 `src/jianpu/slots.ts`）：文本谱排版器、简谱输入模型（投影档）、双向定位共用的那一份铺排。
//!
//! 文本谱「简谱」档不自动断行：一个系统就是一行，行内按符号逐个步进、记号按行内区间画。
//! 这里把 `ScoreDoc`（声部 → 小节 → 元素，id 配对）线性化成一行一行的符号流，规则只写这一次：
//!
//! - 行内顺序：夹层（`before`）→ 主音 / 承接前音的增时线 → 各增时线（带各自夹层）→ 有样式的右小节线（带夹层）→ 行末夹层；
//!   倚音折进宿主音符；左小节线不出现（它的信息由前一小节右线与房号承载）。
//! - 行里每个符号都带一条来源（[`SlotRef`]）：它的元素 id 与在（投影后的）曲子里的位置。
//! - 跨行记号按行切段（续接标记、续行 level）、房号由 `Barline.ending` 还原成行内区间、歌词按行级版式铺回。
//!
//! 与 TS 的出入只在边界形状：TS 的 `refs` 存对象引用，这里存下标（小节在声部里第几个、元素第几个、增时线 / 小节线第几条），
//! 投影改了曲子（MusicXML 形状、多小节休止）时把投影后的那份一并给出（`SongView.song`），门面据此认回对象；
//! `idOf` / `elementOf` / `syllableOwner` 三张表由门面按 `refs` 与块的 `ids` 走一遍重建（次序同 TS）。

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use crate::base::{js, SourceSpan};
use crate as dm;
use crate::deconames::{chord_notehead, deco_key, notehead_of, tremolo_strokes};
use crate::directionmarks::{direction_marks, lead_tempo, WedgeEdge};
use crate::innervoice::{has_inner_voice, inner_layer_measures, lanes_of, Lane};
use crate::jianpu::{key_spelling, note_height, quarter_tempos, top_note};
use crate::jianpuproject::project_for_jianpu;
use crate::keyshift::{song_fifths, tonic_spelling};
use crate::metakeys::get_meta;
use crate::multirest::compress_multi_rests;
use crate::{Barline, Chord, ElementId, Measure, Song};
use serde::Serialize;

use crate::view::ast as fq;

const ZERO: SourceSpan = SourceSpan { line: 0, column: 0, offset: 0, length: 0 };

// ───────────────────────── 输出形状 ─────────────────────────

/// 一份 `ScoreDoc` 的排版行视图。
#[derive(Clone, Debug, Serialize)]
pub struct DocView {
    pub songs: Vec<SongView>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SongView {
    pub index: usize,
    pub metadata: fq::Metadata,
    pub pages: Vec<PageView>,
    /// 投影改了曲子时（MusicXML 形状投成简谱形状、多小节休止合并）投影后的那份；没改为 None（`refs` 指原曲子）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub song: Option<Song>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PageView {
    pub index: usize,
    pub groups: Vec<SystemView>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SystemView {
    pub index: usize,
    /// 全曲第几个系统
    pub system: f64,
    pub texts: Vec<fq::TextLine>,
    pub voices: Vec<RowView>,
}

/// 一行（一个声部在一个系统里的那一段）。形状同 `ScoreLine`，另带来源。
#[derive(Clone, Debug, Serialize)]
pub struct RowView {
    /// 声部下标
    pub part: usize,
    /// 这一行的小节（声部里的下标；切在小节中间的那个小节两行都有）
    pub measures: Vec<usize>,
    /// 与 `elements` 平行
    pub refs: Vec<SlotRef>,
    #[serde(flatten)]
    pub line: fq::ScoreLine,
}

/// 行里一个符号的来源（同 TS `SlotRef`，对象引用换成下标）。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct SlotRef {
    /// 元素 id（音符和弦、承接增时线的和弦、增时线、`Space`）；小节线与夹层没有
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    /// 小节：声部里第几个
    pub m: usize,
    /// 和弦 / `Space`：小节里第几个元素
    #[serde(skip_serializing_if = "Option::is_none")]
    pub e: Option<usize>,
    /// 增时线：和弦的第几条
    #[serde(skip_serializing_if = "Option::is_none")]
    pub s: Option<usize>,
    /// 小节线：小节的第几条
    #[serde(skip_serializing_if = "Option::is_none")]
    pub b: Option<usize>,
}

// ───────────────────────── 元素换形 ─────────────────────────

/// 补拍位的不可见休止发的临时号（TS 发 −1、−2…）：从 `u32::MAX` 往下数，出视图时换回负数
const PAD_FLOOR: u32 = u32::MAX - (1 << 24);

fn view_id(id: ElementId) -> i64 {
    if id > PAD_FLOOR {
        -((u32::MAX - id) as i64) - 1
    } else {
        id as i64
    }
}

/// 小节线样式 + 反复 → 文本谱的 BarlineType。
fn fanqie_barline_type(b: &Barline) -> fq::BarlineType {
    use dm::{BarStyle, RepeatDir};
    match b.repeat {
        Some(RepeatDir::Forward) => return fq::BarlineType::RepeatStart,
        Some(RepeatDir::Backward) => {
            return if b.also_forward == Some(true) { fq::BarlineType::RepeatBoth } else { fq::BarlineType::RepeatEnd };
        }
        _ => {}
    }
    match &b.style {
        Some(BarStyle::NoStyle) => {
            if b.no_width == Some(true) {
                fq::BarlineType::Hidden
            } else {
                fq::BarlineType::Invisible
            }
        }
        Some(BarStyle::LightLight) => fq::BarlineType::Double,
        Some(BarStyle::LightHeavy) => fq::BarlineType::End,
        Some(BarStyle::HeavyLight) => fq::BarlineType::Double,
        Some(BarStyle::Dotted) => fq::BarlineType::Hidden,
        _ => fq::BarlineType::Normal,
    }
}

fn fanqie_ornaments(os: Option<&Vec<dm::SourceOrnament>>) -> Vec<fq::Ornament> {
    os.map_or(vec![], |os| {
        os.iter()
            .map(|o| fq::Ornament { name: o.name.clone(), level: o.level, source: ZERO, below: if o.below == Some(true) { Some(true) } else { None } })
            .collect()
    })
}

fn orn(name: &str, level: f64) -> fq::Ornament {
    fq::Ornament { name: name.to_owned(), level, source: ZERO, below: None }
}

/// 和弦上的记号：有原名就照原名（文本谱来源），否则由语义投影推（123 / MusicXML 来源）。
fn chord_ornaments(ch: &Chord) -> Vec<fq::Ornament> {
    if ch.ornaments.is_some() {
        return fanqie_ornaments(ch.ornaments.as_ref());
    }
    let mut out: Vec<fq::Ornament> = vec![];
    fn add(out: &mut Vec<fq::Ornament>, name: &str) {
        if !out.iter().any(|o| o.name == name) {
            out.push(orn(name, 0.0));
        }
    }
    let nt = ch.notations.as_ref();
    if nt.and_then(|n| n.fermata) == Some(true) {
        add(&mut out, "yc");
    }
    if nt.and_then(|n| n.arpeggiate) == Some(true) {
        add(&mut out, "arp");
    }
    let artics: &[String] = nt.and_then(|n| n.articulations.as_deref()).unwrap_or(&[]);
    for a in artics {
        if notehead_of(a).is_none() {
            add(&mut out, deco_key(a).unwrap_or(a));
        }
    }
    for o in nt.and_then(|n| n.ornaments.as_deref()).unwrap_or(&[]) {
        if let Some(k) = deco_key(o) {
            add(&mut out, k);
        }
    }
    for tk in nt.and_then(|n| n.technical.as_deref()).unwrap_or(&[]) {
        if let Some(k) = deco_key(tk) {
            add(&mut out, k);
        }
    }
    let strokes: Option<f64> = nt.and_then(|n| n.tremolo).or_else(|| artics.iter().find_map(|a| tremolo_strokes(a)).map(|n| n as f64));
    if let Some(n) = strokes.filter(|&n| n != 0.0 && !n.is_nan()) {
        out.retain(|o| tremolo_strokes(&o.name).is_none());
        add(&mut out, &format!("trem{}", js::num_to_string(n)));
    }
    out
}

fn grace_duration(t: Option<&dm::NoteType>) -> Option<u32> {
    match t.map(|t| t.as_str()) {
        Some("eighth") => Some(8),
        Some("16th") => Some(16),
        Some("32nd") => Some(32),
        _ => None,
    }
}

/// 和弦里要叠印的几个音的唱名，自下而上；画小的上方装饰音（`cue`）不算，同一个音写两遍的只算一个。
fn chord_degrees(ch: &Chord) -> Vec<dm::Degree> {
    let normal: Vec<&dm::Note> = ch.notes.iter().filter(|n| n.type_size.as_deref() != Some("cue")).collect();
    let base: Vec<&dm::Note> = if normal.is_empty() { ch.notes.iter().collect() } else { normal };
    let mut pool: Vec<&dm::Note> = base.into_iter().filter(|n| n.degree.as_ref().is_some_and(|d| d.number >= 1.0 && d.number <= 7.0)).collect();
    js::sort_by(&mut pool, |a, b| note_height(a) - note_height(b));
    let mut out: Vec<dm::Degree> = vec![];
    for n in pool {
        let d = n.degree.as_ref().unwrap();
        if let Some(prev) = out.last() {
            if prev.number == d.number && prev.octave_shift == d.octave_shift && prev.accidental == d.accidental {
                continue;
            }
        }
        out.push(d.clone());
    }
    out
}

fn shl4(n: usize) -> u32 {
    // JS `4 << n`（32 位）
    (4i32.wrapping_shl(n as u32)) as u32
}

/// 一个和弦 → 文本谱音符（主音或倚音）。
fn note_of(ch: &Chord, grace_before: Vec<fq::NoteElement>) -> fq::NoteElement {
    let head = chord_notehead(ch.notes.iter().map(|n| n.notehead.as_deref())).or_else(|| {
        ch.notations.as_ref().and_then(|n| n.articulations.as_ref()).and_then(|a| a.iter().find_map(|x| notehead_of(x)))
    });
    let rest = ch.rest.is_some();
    let rhythm = ch.rhythm == Some(true) || (!rest && matches!(head.as_deref(), Some("x" | "circle-x" | "cross")));
    let stacked = if ch.grace.is_some() || rest || rhythm { vec![] } else { chord_degrees(ch) };
    let deg: Option<dm::Degree> =
        if stacked.len() > 1 { Some(stacked[0].clone()) } else { top_note(ch).and_then(|i| ch.notes[i].degree.clone()) };
    let beams = ch.beams.as_ref().map(|b| b.len());
    let mut n = fq::NoteElement {
        pitch: if rhythm {
            9
        } else if rest {
            0
        } else {
            deg.as_ref().map_or(0.0, |d| d.number) as u32
        },
        sound: if rhythm {
            fq::Sound::Rhythm
        } else if rest {
            fq::Sound::Rest
        } else {
            fq::Sound::Note
        },
        hidden: ch.print_object == Some(false),
        placeholder: None,
        lyric_anchor: ch.lyric_anchor.unwrap_or(if ch.grace.is_some() { false } else { !rest }),
        octave: if rhythm {
            0
        } else {
            deg.as_ref().map(|d| d.octave_shift).or_else(|| ch.rest.as_ref().and_then(|r| r.octave_shift)).unwrap_or(0.0) as i32
        },
        duration: if beams.is_none() && ch.grace.is_some() {
            grace_duration(ch.duration.kind.as_ref()).unwrap_or(8)
        } else {
            shl4(beams.unwrap_or(0))
        },
        dots: ch.duration.dots as u32,
        accidental: None,
        ornaments: chord_ornaments(ch),
        grace_before,
        grace_after: vec![],
        stack: None,
        multi_rest: None,
        annotation: None,
        chord: None,
        key_label: None,
        annotation_source: None,
        chord_source: None,
        code: String::new(),
        source: ch.source.unwrap_or(ZERO),
    };
    if let Some(a) = deg.as_ref().and_then(|d| d.accidental.clone()) {
        if !rhythm && !a.as_str().is_empty() {
            n.accidental = Some(a);
        }
    }
    if rhythm && ch.grace.is_none() && ch.notes.len() > 1 {
        n.stack = Some(ch.notes[1..].iter().map(|_| fq::StackedNote { pitch: 9, octave: 0, accidental: None }).collect());
    }
    if stacked.len() > 1 {
        n.stack = Some(
            stacked[1..]
                .iter()
                .map(|d| fq::StackedNote { pitch: d.number as u32, octave: d.octave_shift as i32, accidental: d.accidental.clone() })
                .collect(),
        );
    }
    if ch.placeholder == Some(true) {
        n.placeholder = Some(true);
    }
    if let Some(t) = ch.harmony.as_ref().and_then(|h| h.text.clone()) {
        n.chord = Some(t);
    }
    if let Some(w) = &ch.section_word {
        n.annotation = Some(w.clone());
    }
    n
}

fn sustain_of(
    harmony: Option<&dm::Harmony>,
    section_word: Option<&String>,
    ornaments: Option<&Vec<dm::SourceOrnament>>,
    lyric_anchor: Option<bool>,
    source: Option<SourceSpan>,
) -> fq::SustainElement {
    fq::SustainElement {
        duration: 4,
        lyric_anchor: lyric_anchor.unwrap_or(false),
        ornaments: fanqie_ornaments(ornaments),
        annotation: section_word.cloned(),
        chord: harmony.and_then(|h| h.text.clone()),
        annotation_source: None,
        chord_source: None,
        code: "-".into(),
        source: source.unwrap_or(ZERO),
    }
}

// ───────────────────────── 一行的铺排 ─────────────────────────

/// 行里一个符号的来源（建行时的内部形状：和弦与小节线按引用）
#[derive(Clone, Copy, Default)]
struct Ref<'a> {
    id: Option<i64>,
    chord: Option<&'a Chord>,
    e: Option<usize>,
    s: Option<usize>,
    barline: Option<(&'a Barline, usize)>,
    /// 小节键：主行是声部里的下标，块里的是块内下标
    measure: usize,
}

struct WedgeAt {
    start: bool,
    kind: Option<dm::WedgeType>,
    id: ElementId,
}

/// 把一段小节铺成扁平元素流时要带出去的东西。
struct RowBuild<'a> {
    elements: Vec<fq::MusicElement>,
    /// 与 `elements` 平行
    refs: Vec<Ref<'a>>,
    /// 元素 id → 行内下标（同一 id 再出现时后者覆盖，同 TS `Map.set`）
    index_of: HashMap<i64, usize>,
    /// 参与对位的元素（按顺序）的歌词
    anchors: Vec<&'a [dm::Lyric]>,
    /// 与本行小节逐位对应：[首元素下标, 末元素下标（含右小节线）]
    measure_span: Vec<(usize, usize)>,
    /// 小节 direction 里的渐强渐弱起止
    wedges: Vec<WedgeAt>,
}

impl RowBuild<'_> {
    fn len(&self) -> i64 {
        self.elements.len() as i64
    }
}

fn lyrics_of(l: Option<&Vec<dm::Lyric>>) -> &[dm::Lyric] {
    l.map_or(&[], |v| v.as_slice())
}

fn push_inline<'a>(row: &mut RowBuild<'a>, items: Option<&'a Vec<dm::InlineItem>>, key: usize) {
    for it in items.into_iter().flatten() {
        row.refs.push(Ref { measure: key, ..Default::default() });
        match it {
            dm::InlineItem::Boundary { behavior, source } => {
                let join = *behavior == dm::BoundaryBehavior::Join;
                row.elements.push(fq::MusicElement::BeatBoundary(fq::BeatBoundaryElement {
                    behavior: if join { fq::Behavior::Join } else { fq::Behavior::Split },
                    code: if join { "~" } else { "^" }.into(),
                    source: source.unwrap_or(ZERO),
                }));
            }
            dm::InlineItem::Layer { role, measures, marks, source } => {
                let ms: Vec<&Measure> = measures.iter().collect();
                let keys: Vec<usize> = (0..ms.len()).collect();
                let sub = build_row(&ms, &keys, None, &[]);
                let mut mk = segment_marks(marks, std::slice::from_ref(&sub), 0);
                mk.extend(row_voltas(&[&ms], std::slice::from_ref(&sub)).into_iter().next().unwrap());
                row.elements.push(fq::MusicElement::InlineLayer(fq::InlineLayerElement {
                    role: if *role == dm::LayerRole::Voice { fq::LayerRole::Voice } else { fq::LayerRole::Accompaniment },
                    below: None,
                    elements: sub.elements,
                    ids: None,
                    marks: mk,
                    code: String::new(),
                    source: source.unwrap_or(ZERO),
                }));
            }
        }
    }
}

/// 同一谱表上的第二声部：连续几个带第二声部的小节并成一个并排块（下行）。
/// 不满小节的补不可见休止，好让下行与主行按拍位一列列对齐；块内的弧、连音只收两端都在块里的。
fn inner_voice_layer(run: &[&Measure], marks: &[dm::Mark], next_id: &mut impl FnMut() -> ElementId) -> fq::MusicElement {
    let owned: Vec<Measure> = run.iter().map(|m| (*m).clone()).collect();
    let sub = inner_layer_measures(&owned, next_id);
    let ms: Vec<&Measure> = sub.iter().collect();
    let keys: Vec<usize> = (0..ms.len()).collect();
    let b = build_row(&ms, &keys, None, &[]);
    let own: Vec<dm::Mark> =
        marks.iter().filter(|mk| b.index_of.contains_key(&view_id(mk.start)) && b.index_of.contains_key(&view_id(mk.end))).cloned().collect();
    let mut out_marks = segment_marks(&own, std::slice::from_ref(&b), 0);
    let tuplets = row_tuplets(&[&ms], std::slice::from_ref(&b)).into_iter().next().unwrap();
    out_marks.extend(tuplets.into_iter().filter(|t| {
        !own.iter().any(|mk| mk.kind == dm::MarkType::Tuplet && b.index_of.get(&view_id(mk.start)).map(|&i| i as i64) == Some(t.start))
    }));
    let ids = b.refs.iter().map(|r| r.id).collect();
    fq::MusicElement::InlineLayer(fq::InlineLayerElement {
        role: fq::LayerRole::Voice,
        below: Some(true),
        elements: b.elements,
        ids: Some(ids),
        marks: out_marks,
        code: String::new(),
        source: ZERO,
    })
}

/// 落成的符号上补一个记号（同名的不重复）
fn add_orn(el: Option<&mut fq::MusicElement>, o: &dm::SourceOrnament) {
    let list = match el {
        Some(fq::MusicElement::Note(n)) => &mut n.ornaments,
        Some(fq::MusicElement::Sustain(s)) => &mut s.ornaments,
        Some(fq::MusicElement::Barline(b)) => &mut b.ornaments,
        _ => return,
    };
    if !list.iter().any(|x| x.name == o.name) {
        list.push(orn(&o.name, o.level));
    }
}

/// `measures` 与 `keys` 逐位对应（键是来源里的小节下标）。
/// `ranges`：切在小节中间的那几个小节只取 `[from, to)` 这一段元素；右小节线与小节尾的夹层只归最后一段。
/// `marks`：本声部的记号，同一谱表上的第二声部并成并排块时取块里的弧。
fn build_row<'a>(
    measures: &[&'a Measure],
    keys: &[usize],
    ranges: Option<&HashMap<usize, (usize, usize)>>,
    marks: &[dm::Mark],
) -> RowBuild<'a> {
    let mut row = RowBuild { elements: vec![], refs: vec![], index_of: HashMap::new(), anchors: vec![], measure_span: vec![], wedges: vec![] };
    let mut pad: u32 = 0;
    let mut next_pad = || {
        pad += 1;
        u32::MAX - (pad - 1)
    };
    // 小节被换行切开的不并第二声部（块对不齐两段）
    let has_inner: Vec<bool> =
        measures.iter().zip(keys).map(|(m, k)| !ranges.is_some_and(|r| r.contains_key(k)) && has_inner_voice(m)).collect();
    for (mi, &mea) in measures.iter().enumerate() {
        let key = keys[mi];
        let first = row.elements.len();
        let (from, to) = ranges.and_then(|r| r.get(&key).copied()).unwrap_or((0, mea.elements.len()));
        let tail = to >= mea.elements.len();
        let lane_of = lanes_of(mea);
        if has_inner[mi] && !(mi > 0 && has_inner[mi - 1]) {
            let mut end = mi;
            while end + 1 < has_inner.len() && has_inner[end + 1] {
                end += 1;
            }
            let layer = inner_voice_layer(&measures[mi..=end], marks, &mut next_pad);
            row.elements.push(layer);
            row.refs.push(Ref { measure: key, ..Default::default() });
        }
        // 文本谱显式写出的左边界保留原文位置；合成的房号左线不另画小节线。
        if from == 0 {
            for (bi, b) in mea.barlines.iter().flatten().enumerate() {
                if b.location != dm::BarLocation::Left || b.source.is_none() || b.style.is_none() {
                    continue;
                }
                push_inline(&mut row, b.before.as_ref(), key);
                row.elements.push(fanqie_bar(b));
                row.refs.push(Ref { barline: Some((b, bi)), measure: key, ..Default::default() });
            }
        }
        let mut pending_grace: Vec<fq::NoteElement> = vec![];
        let mut last_note: Option<usize> = None;
        // 小节元素下标 → 落成的那个符号在行里的下标
        let mut head_at: Vec<(usize, usize)> = vec![];
        for (j, el) in mea.elements.iter().enumerate() {
            if j < from || j >= to {
                continue;
            }
            if lane_of(el) != Some(Lane::Main) {
                continue;
            }
            let ch = match el {
                dm::Element::Space(sp) => {
                    // `y`（无时值占位）与 `x`（不可见休止）都落成隐藏音符；`y` 不参与对位
                    let x = sp.spacer == dm::Spacer::X;
                    let mut n = fq::NoteElement {
                        pitch: 0,
                        sound: fq::Sound::Rest,
                        hidden: true,
                        placeholder: None,
                        lyric_anchor: x,
                        octave: 0,
                        duration: if x { shl4(sp.beams.as_ref().map_or(0, |b| b.len())) } else { 4 },
                        dots: sp.duration.as_ref().map_or(0.0, |d| d.dots) as u32,
                        accidental: None,
                        ornaments: vec![],
                        grace_before: vec![],
                        grace_after: vec![],
                        stack: None,
                        multi_rest: None,
                        annotation: None,
                        chord: None,
                        key_label: None,
                        annotation_source: None,
                        chord_source: None,
                        code: sp.spacer.as_str().to_owned(),
                        source: sp.source.unwrap_or(ZERO),
                    };
                    if let Some(t) = sp.harmony.as_ref().and_then(|h| h.text.clone()).filter(|t| !t.is_empty()) {
                        n.chord = Some(t);
                    }
                    if !pending_grace.is_empty() {
                        n.grace_before = std::mem::take(&mut pending_grace);
                    }
                    let anchor = n.lyric_anchor;
                    let at = row.elements.len();
                    row.index_of.insert(view_id(sp.id), at);
                    row.elements.push(fq::MusicElement::Note(n));
                    row.refs.push(Ref { id: Some(view_id(sp.id)), e: Some(j), measure: key, ..Default::default() });
                    if anchor {
                        row.anchors.push(lyrics_of(sp.lyrics.as_ref()));
                    }
                    head_at.push((j, at));
                    continue;
                }
                dm::Element::Chord(c) => c,
            };
            // 倚音：前倚音攒着挂到下一个主音，后倚音挂回刚才那个主音
            if ch.grace.is_some() {
                let g = note_of(ch, vec![]);
                let after = ch.grace.as_ref().and_then(|g| g.after) == Some(true);
                match (after, last_note) {
                    (true, Some(k)) => {
                        if let fq::MusicElement::Note(n) = &mut row.elements[k] {
                            n.grace_after.push(g);
                        }
                    }
                    _ => pending_grace.push(g),
                }
                continue;
            }
            push_inline(&mut row, ch.before.as_ref(), key);
            let head: fq::MusicElement = if ch.continued == Some(true) {
                fq::MusicElement::Sustain(sustain_of(
                    ch.harmony.as_ref(),
                    ch.section_word.as_ref(),
                    ch.ornaments.as_ref(),
                    Some(ch.lyric_anchor.unwrap_or(ch.rest.is_none())),
                    ch.source,
                ))
            } else {
                let mut n = note_of(ch, std::mem::take(&mut pending_grace));
                last_note = Some(row.elements.len());
                if ch.rest.is_some() {
                    if let Some(k) = mea.attrs.as_ref().and_then(|a| a.multi_rest).filter(|&k| k != 0.0 && !k.is_nan()) {
                        n.multi_rest = Some(k);
                    }
                }
                fq::MusicElement::Note(n)
            };
            let anchor = match &head {
                fq::MusicElement::Note(n) => n.lyric_anchor,
                fq::MusicElement::Sustain(s) => s.lyric_anchor,
                _ => false,
            };
            let at = row.elements.len();
            row.index_of.insert(view_id(ch.id), at);
            row.elements.push(head);
            row.refs.push(Ref { id: Some(view_id(ch.id)), chord: Some(ch), e: Some(j), measure: key, ..Default::default() });
            if anchor {
                row.anchors.push(lyrics_of(ch.lyrics.as_ref()));
            }
            head_at.push((j, at));
            // 增时线展开：文本谱里它们是独立元素
            for (si, su) in ch.sustains.iter().flatten().enumerate() {
                push_inline(&mut row, su.before.as_ref(), key);
                row.index_of.insert(view_id(su.id), row.elements.len());
                let s = sustain_of(su.harmony.as_ref(), su.section_word.as_ref(), su.ornaments.as_ref(), su.lyric_anchor, su.source);
                let anchor = s.lyric_anchor;
                row.elements.push(fq::MusicElement::Sustain(s));
                row.refs.push(Ref { id: Some(view_id(su.id)), chord: Some(ch), e: Some(j), s: Some(si), measure: key, ..Default::default() });
                if anchor {
                    row.anchors.push(lyrics_of(su.lyrics.as_ref()));
                }
            }
        }
        // 小节里的 direction 挂到对应的符号上；左线上的跳转目标挂到本小节头一个符号上
        let dmk = direction_marks(mea);
        let mut heads = head_at.clone();
        heads.sort_by_key(|h| h.0);
        let head_from = |j: usize| -> Option<usize> { heads.iter().find(|(k, _)| *k >= j).or(heads.last()).map(|h| h.1) };
        let in_range = |j: usize| j >= from && j < to;
        for (j, orns) in &dmk.by_element {
            if in_range(*j) {
                for o in orns {
                    let h = head_from(*j);
                    add_orn(h.map(|h| &mut row.elements[h]), o);
                }
            }
        }
        for (j, text) in &dmk.words {
            if !in_range(*j) {
                continue;
            }
            if let Some(h) = head_from(*j) {
                if let fq::MusicElement::Note(n) = &mut row.elements[h] {
                    if n.annotation.is_none() {
                        n.annotation = Some(text.clone());
                    }
                }
            }
        }
        if from == 0 {
            for b in mea.barlines.iter().flatten() {
                if b.location != dm::BarLocation::Left {
                    continue;
                }
                let list: Vec<dm::SourceOrnament> = match (&b.ornaments, &b.jump) {
                    (Some(os), _) => os.clone(),
                    (None, Some(j)) if !j.is_empty() => vec![dm::SourceOrnament { name: j.clone(), level: 0.0, below: None }],
                    _ => vec![],
                };
                for o in &list {
                    let h = heads.first().map(|h| h.1);
                    add_orn(h.map(|h| &mut row.elements[h]), o);
                }
            }
        }
        // 只有房号、没有线的「右线」是行末补出来挂 ending 的，原文那里没有小节线
        let right = if tail { mea.barlines.iter().flatten().enumerate().find(|(_, b)| b.location == dm::BarLocation::Right) } else { None };
        let mut right_el: Option<usize> = None;
        if let Some((bi, right)) = right {
            if right.style.is_some() {
                push_inline(&mut row, right.before.as_ref(), key);
                right_el = Some(row.elements.len());
                row.elements.push(fanqie_bar(right));
                row.refs.push(Ref { barline: Some((right, bi)), measure: key, ..Default::default() });
            }
        }
        if tail {
            for o in &dmk.bar_end {
                let h = right_el.or(heads.last().map(|h| h.1));
                add_orn(h.map(|h| &mut row.elements[h]), o);
            }
        }
        for w in &dmk.wedges {
            let (start, kind, index) = match w {
                WedgeEdge::Start { kind, index } => (true, Some(kind.clone()), *index),
                WedgeEdge::Stop { index } => (false, None, *index),
            };
            if in_range(index) {
                row.wedges.push(WedgeAt { start, kind, id: mea.elements[index].id() });
            }
        }
        if tail {
            push_inline(&mut row, mea.trailing.as_ref(), key);
        }
        // 跨度只数有归属的符号与小节线（夹层不算），房号的起止偏移以此为基准
        let mut f: Option<usize> = None;
        let mut l = 0;
        for (i, r) in row.refs.iter().enumerate().skip(first) {
            if r.id.is_none() && r.barline.is_none() {
                continue;
            }
            if f.is_none() {
                f = Some(i);
            }
            l = i;
        }
        row.measure_span.push(match f {
            None => (first, first.max(row.elements.len().saturating_sub(1))),
            Some(f) => (f, l),
        });
    }
    row
}

fn fanqie_bar(b: &Barline) -> fq::MusicElement {
    let mut e = fq::BarlineElement {
        kind: fanqie_barline_type(b),
        ornaments: if b.ornaments.is_some() { fanqie_ornaments(b.ornaments.as_ref()) } else { vec![] },
        temporary_meter: None,
        temporary_key: None,
        annotation: None,
        repeat_forward_after: None,
        code: "|".into(),
        source: b.source.unwrap_or(ZERO),
    };
    if b.ornaments.is_none() {
        if let Some(j) = b.jump.as_ref().filter(|j| !j.is_empty()) {
            e.ornaments.push(orn(j, 0.0));
        }
    }
    if let Some(t) = &b.time {
        e.temporary_meter = Some(fq::Meter { numerator: t.beats, denominator: t.beat_type, parenthesized: t.parenthesized.unwrap_or(false) });
    }
    if let Some(a) = &b.annotation {
        e.annotation = Some(a.clone());
    }
    fq::MusicElement::Barline(e)
}

/// 行内的歌词。有 `print.lyricLines`（文本谱来源）就照它的版式还原；否则按段号铺，全空的行不产生。
fn row_lyrics(row: &RowBuild, infos: Option<&Vec<dm::LyricLineInfo>>) -> Vec<fq::LyricLine> {
    if let Some(infos) = infos {
        return infos
            .iter()
            .enumerate()
            .map(|(line_idx, info)| {
                let mut syllables = vec![];
                let n = js::min(info.count, row.anchors.len() as f64);
                let mut a = 0usize;
                while (a as f64) < n {
                    let hit = row.anchors[a].iter().find(|l| {
                        l.number == info.verse_from
                            && l.number_to.unwrap_or(l.number) == info.verse_to
                            && l.line_index.is_none_or(|k| k == line_idx as f64)
                    });
                    let source = info.sources.as_ref().and_then(|s| s.get(a).copied()).or(hit.and_then(|h| h.source)).unwrap_or(ZERO);
                    let mut syl = fq::LyricSyllable { text: hit.map_or(String::new(), |h| h.text.clone()), trailing_punctuation: None, source };
                    if let Some(p) = hit.and_then(|h| h.trailing_punctuation.clone()).filter(|p| !p.is_empty()) {
                        syl.trailing_punctuation = Some(p);
                    }
                    syllables.push(syl);
                    a += 1;
                }
                fq::LyricLine {
                    verse_from: info.verse_from,
                    verse_to: info.verse_to,
                    annotation: info.annotation.clone(),
                    annotation_gap: info.annotation_gap,
                    syllables,
                    join_brace: if info.join_brace == Some(true) { Some(true) } else { None },
                    source: info.source.unwrap_or(ZERO),
                }
            })
            .collect();
    }
    let mut verses: Vec<f64> = vec![];
    for a in &row.anchors {
        for l in a.iter() {
            let mut v = l.number;
            while v <= l.number_to.unwrap_or(l.number) {
                if !verses.contains(&v) {
                    verses.push(v);
                }
                v += 1.0;
            }
        }
    }
    js::sort_by(&mut verses, |a, b| a - b);
    let mut out = vec![];
    for v in verses {
        let mut syllables = vec![];
        let mut label: Option<String> = None;
        for a in &row.anchors {
            let hit = a.iter().find(|l| v >= l.number && v <= l.number_to.unwrap_or(l.number));
            if let Some(lb) = hit.and_then(|h| h.verse_label.clone()) {
                label = Some(lb);
            }
            let mut syl = fq::LyricSyllable {
                text: hit.map_or(String::new(), |h| h.text.clone()),
                trailing_punctuation: None,
                source: hit.and_then(|h| h.source).unwrap_or(ZERO),
            };
            if let Some(p) = hit.and_then(|h| h.trailing_punctuation.clone()).filter(|p| !p.is_empty()) {
                syl.trailing_punctuation = Some(p);
            }
            syllables.push(syl);
        }
        // 全空就不产生这一行
        if !syllables.iter().any(|s| !s.text.is_empty()) {
            continue;
        }
        out.push(fq::LyricLine { verse_from: v, verse_to: v, annotation: label, annotation_gap: 20.0, syllables, join_brace: None, source: ZERO });
    }
    out
}

/// 和音里第 `k` 个音叠印在第几层（0 = 本音即最低那个，同 `chord_degrees` 的次序）；不是叠印的和音为 None
fn stack_level(ch: &Chord, k: f64) -> Option<usize> {
    let d = js::index(k).and_then(|k| ch.notes.get(k)).and_then(|n| n.degree.as_ref())?;
    let ds = chord_degrees(ch);
    if ds.len() < 2 {
        return None;
    }
    ds.iter().position(|x| x.number == d.number && x.octave_shift == d.octave_shift && x.accidental == d.accidental)
}

/// 同一对相邻和音之间的延音线先归组：连上了叠印里每个数字的是整和音的弧，组里只留第一条、不记 `digits`（其余记 None 不画）；
/// 只连其中几个的各记两端连的是第几层。键是记号在 `marks` 里的下标。
fn chord_tie_digits<'a>(marks: &[dm::Mark], chord_of: impl Fn(ElementId) -> Option<&'a Chord>) -> HashMap<usize, Option<[u32; 2]>> {
    let mut out = HashMap::new();
    let mut groups: Vec<((ElementId, ElementId), Vec<usize>)> = vec![];
    for (i, m) in marks.iter().enumerate() {
        if m.kind != dm::MarkType::Tied {
            continue;
        }
        let k = (m.start, m.end);
        match groups.iter_mut().find(|g| g.0 == k) {
            Some(g) => g.1.push(i),
            None => groups.push((k, vec![i])),
        }
    }
    for (_, g) in groups {
        let m0 = &marks[g[0]];
        let (Some(a), Some(b)) = (chord_of(m0.start), chord_of(m0.end)) else { continue };
        let levels: Vec<(Option<usize>, Option<usize>)> =
            g.iter().map(|&i| (stack_level(a, marks[i].start_note.unwrap_or(0.0)), stack_level(b, marks[i].end_note.unwrap_or(0.0)))).collect();
        let distinct: HashSet<Option<usize>> = levels.iter().map(|l| l.0).collect();
        let whole = levels.iter().any(|(i, j)| i.is_none() || j.is_none()) || distinct.len() >= chord_degrees(a).len();
        if whole {
            for &i in &g[1..] {
                out.insert(i, None);
            }
        } else {
            for (n, &i) in g.iter().enumerate() {
                out.insert(i, Some([levels[n].0.unwrap() as u32, levels[n].1.unwrap() as u32]));
            }
        }
    }
    out
}

/// Mark：id 配对 → 第 `row_idx` 行的下标区间。跨行的截断在行边界、打上续接标记，续行那一段的 level 取 `continuation_levels`。
fn segment_marks(marks: &[dm::Mark], rows: &[RowBuild], row_idx: usize) -> Vec<fq::Mark> {
    let row = &rows[row_idx];
    let row_of = |id: ElementId| -> Option<usize> { rows.iter().position(|r| r.index_of.contains_key(&view_id(id))) };
    let chord_of = |id: ElementId| -> Option<&Chord> {
        let r = &rows[row_of(id)?];
        r.refs[r.index_of[&view_id(id)]].chord
    };
    let digits_of = chord_tie_digits(marks, chord_of);
    let mut out = vec![];
    for (mi, m) in marks.iter().enumerate() {
        let digits = digits_of.get(&mi);
        if digits == Some(&None) {
            continue;
        }
        // tie 在简谱里与圆滑线同形，归 slur；pedal/octaveShift/lyricExtend 没有对应物
        let kind = match m.kind {
            dm::MarkType::Slur | dm::MarkType::Tied => fq::MarkType::Slur,
            dm::MarkType::Tuplet => fq::MarkType::Tuplet,
            dm::MarkType::Wedge => {
                if m.wedge_type == Some(dm::WedgeType::Diminuendo) {
                    fq::MarkType::Decrescendo
                } else {
                    fq::MarkType::Crescendo
                }
            }
            _ => continue,
        };
        let level = m.level.unwrap_or(0.0);
        let mark = |start: i64, end: i64, level: f64| fq::Mark {
            kind,
            start,
            end,
            level,
            caption: None,
            open_end: None,
            continuation_from_previous: None,
            continuation_to_next: None,
            source: ZERO,
            close_source: None,
            digits: None,
            uid: 0,
        };
        // 起点写在上一行行尾的：上一行补一段空的起头
        if m.lead_in_previous_line == Some(true) && rows.get(row_idx + 1).is_some_and(|r| r.index_of.contains_key(&view_id(m.start))) {
            let mut pm = mark(row.len() - m.lead_back.unwrap_or(0.0) as i64, (row.len() - 1).max(0), level);
            pm.continuation_to_next = Some(true);
            out.push(pm);
            continue;
        }
        let a = row.index_of.get(&view_id(m.start)).map(|&i| i as i64);
        let b = row.index_of.get(&view_id(m.end)).map(|&i| i as i64);
        let start_row: i64 = if a.is_some() { row_idx as i64 } else { row_of(m.start).map_or(-1, |r| r as i64) };
        let end_row: i64 = if b.is_some() { row_idx as i64 } else { row_of(m.end).map_or(-1, |r| r as i64) };
        if a.is_none() && b.is_none() {
            // 两端都不在本行：只有跨过本行的才画（中间整行都在弧下）
            let r = row_idx as i64;
            if start_row < 0 || end_row < 0 || r < start_row || r > end_row {
                continue;
            }
        }
        if m.collapsed == Some(true) {
            if let Some(a) = a {
                out.push(mark(a + 1, a, level));
            }
            continue;
        }
        let lead_prev = m.lead_in_previous_line == Some(true);
        let seg = (if start_row >= 0 { row_idx as i64 - start_row } else { 0 }) + if lead_prev { 1 } else { 0 };
        let seg_level = if seg == 0 {
            level
        } else {
            m.continuation_levels.as_ref().and_then(|c| js::index((seg - 1) as f64).and_then(|i| c.get(i)).copied()).or(m.level).unwrap_or(0.0)
        };
        let mut pm = mark(
            a.map_or(0, |a| a - m.start_lead.unwrap_or(0.0) as i64),
            b.map_or((row.len() - 1).max(0), |b| b + m.end_trail.unwrap_or(0.0) as i64),
            seg_level,
        );
        if a.is_none() || m.continues_from_previous == Some(true) || (lead_prev && seg == 1) {
            pm.continuation_from_previous = Some(true);
        }
        if b.is_none() {
            pm.continuation_to_next = Some(true);
        }
        if let Some(t) = m.tuplet_actual {
            pm.caption = Some(js::num_to_string(t));
        }
        if let Some(Some(d)) = digits {
            pm.digits = Some(*d);
        }
        out.push(pm);
    }
    out
}

/// 跨小节线的两样东西挂到前一小节的右线上（行视图不出左线）：下一小节左线上的反复起点（只供画线，`repeatForwardAfter`），
/// 与曲中换拍号 → 前一小节右线上的临时拍号。`flat`：各行的小节键接起来（切开的小节出现两次，同 TS `flatMap`）。
fn carry_to_prev_barline(all: &[Measure], flat: &[usize], rows: &mut [RowBuild], song_time: Option<&dm::Time>) {
    let mut cur: Option<(f64, f64)> = song_time.map(|t| (t.beats, t.beat_type));
    let prev_bar = |rows: &[RowBuild], i: usize| -> Option<(usize, usize)> {
        let prev = flat[i - 1];
        for (ri, row) in rows.iter().enumerate() {
            let Some(k) = row.refs.iter().position(|r| r.barline.is_some_and(|(b, _)| b.location == dm::BarLocation::Right) && r.measure == prev)
            else {
                continue;
            };
            return matches!(row.elements[k], fq::MusicElement::Barline(_)).then_some((ri, k));
        }
        None
    };
    for (i, &mk) in flat.iter().enumerate() {
        let mea = &all[mk];
        // 显式左线已在行视图中占有一个元素，不能再在前一右线上合成同一个反复起点。
        if i > 0
            && mea
                .barlines
                .iter()
                .flatten()
                .any(|b| b.location == dm::BarLocation::Left && b.repeat == Some(dm::RepeatDir::Forward) && b.source.is_none())
        {
            if let Some((ri, k)) = prev_bar(rows, i) {
                if let fq::MusicElement::Barline(e) = &mut rows[ri].elements[k] {
                    e.repeat_forward_after = Some(true);
                }
            }
        }
        let Some(t) = mea.attrs.as_ref().and_then(|a| a.time.as_ref()) else { continue };
        let changed = cur.is_some_and(|(b, bt)| t.beats != b || t.beat_type != bt);
        cur = Some((t.beats, t.beat_type));
        if !changed || i == 0 {
            continue;
        }
        if let Some((ri, k)) = prev_bar(rows, i) {
            if let fq::MusicElement::Barline(e) = &mut rows[ri].elements[k] {
                if e.temporary_meter.is_none() {
                    e.temporary_meter = Some(fq::Meter { numerator: t.beats, denominator: t.beat_type, parenthesized: t.parenthesized.unwrap_or(false) });
                }
            }
        }
    }
}

/// 一个声部各行里 direction 的渐强渐弱起止 → `Mark`（同类型后开先收）。
fn direction_wedge_marks(rows: &[RowBuild]) -> Vec<dm::Mark> {
    let mut out = vec![];
    let mut open: Vec<(dm::WedgeType, ElementId)> = vec![];
    for row in rows {
        for w in &row.wedges {
            if w.start {
                if let Some(k) = &w.kind {
                    open.push((k.clone(), w.id));
                }
            } else if let Some((kind, id)) = open.pop() {
                let mut m = dm::Mark::new(dm::MarkType::Wedge, id, w.id);
                m.wedge_type = Some(kind);
                m.level = Some(0.0);
                out.push(m);
            }
        }
    }
    out
}

fn caption_of_ending(e: &dm::Ending) -> Option<String> {
    if e.captionless == Some(true) {
        return None;
    }
    Some(e.text.clone().unwrap_or_else(|| e.numbers.iter().map(|n| js::num_to_string(*n)).collect::<Vec<_>>().join(".")))
}

fn volta(start: i64, end: i64, level: f64, caption: Option<String>) -> fq::Mark {
    fq::Mark {
        kind: fq::MarkType::Volta,
        start,
        end,
        level,
        caption,
        open_end: None,
        continuation_from_previous: None,
        continuation_to_next: None,
        source: ZERO,
        close_source: None,
        digits: None,
        uid: 0,
    }
}

/// 房号：`Barline.ending` → Mark volta。跨行的拆成各行一段。
fn row_voltas(measures_by_row: &[&[&Measure]], rows: &[RowBuild]) -> Vec<Vec<fq::Mark>> {
    struct Open<'e> {
        ending: &'e dm::Ending,
        start_row: usize,
        start: i64,
        from_prev: bool,
    }
    let mut out: Vec<Vec<fq::Mark>> = rows.iter().map(|_| vec![]).collect();
    let mut open: Vec<Open> = vec![];
    let level_of = |o: &Open, r: usize| -> f64 {
        let seg = r - o.start_row;
        if seg == 0 {
            o.ending.level.unwrap_or(0.0)
        } else {
            o.ending.continuation_levels.as_ref().and_then(|c| c.get(seg - 1).copied()).unwrap_or(0.0)
        }
    };
    let mark = |o: &Open, r: usize, end: i64| -> fq::Mark {
        let mut pm = volta(o.start, end, level_of(o, r), caption_of_ending(o.ending));
        if o.from_prev {
            pm.continuation_from_previous = Some(true);
        }
        pm
    };
    for (r, measures) in measures_by_row.iter().enumerate() {
        let row = &rows[r];
        for o in &mut open {
            o.start = 0;
            o.from_prev = true;
        }
        for (li, mea) in measures.iter().enumerate() {
            let span = row.measure_span[li];
            for b in mea.barlines.iter().flatten() {
                if b.location != dm::BarLocation::Left {
                    continue;
                }
                let Some(e) = b.ending.as_ref().filter(|e| e.kind == dm::EndingType::Start) else { continue };
                let caption = caption_of_ending(e);
                if e.collapsed == Some(true) {
                    out[r].push(volta(span.0 as i64, span.0 as i64 - 1, e.level.unwrap_or(0.0), caption));
                    continue;
                }
                if e.lead_in_previous_line == Some(true) && r > 0 {
                    let prev = &rows[r - 1];
                    let mut pm = volta(prev.len(), (prev.len() - 1).max(0), e.level.unwrap_or(0.0), caption);
                    pm.continuation_to_next = Some(true);
                    out[r - 1].push(pm);
                    open.push(Open { ending: e, start_row: r - 1, start: 0, from_prev: true });
                    continue;
                }
                open.push(Open { ending: e, start_row: r, start: span.0 as i64 + e.start_offset.unwrap_or(0.0) as i64, from_prev: false });
            }
            for right in mea.barlines.iter().flatten() {
                if right.location == dm::BarLocation::Right && right.ending.as_ref().is_some_and(|e| e.dangling_lead == Some(true)) {
                    let e = right.ending.as_ref().unwrap();
                    let mut pm = volta(row.len(), (row.len() - 1).max(0), e.level.unwrap_or(0.0), caption_of_ending(e));
                    pm.continuation_to_next = Some(true);
                    out[r].push(pm);
                    continue;
                }
                if right.location != dm::BarLocation::Right || open.is_empty() {
                    continue;
                }
                let Some(stop) = right.ending.as_ref().filter(|e| e.kind != dm::EndingType::Start) else { continue };
                // 有配对号按号收，否则收最近开的那个
                let k = stop.pair.and_then(|p| open.iter().position(|o| o.ending.pair == Some(p))).unwrap_or(open.len() - 1);
                let mut pm = mark(&open[k], r, span.1 as i64 + stop.end_offset.unwrap_or(0.0) as i64);
                if stop.kind == dm::EndingType::Discontinue {
                    pm.open_end = Some(true);
                }
                out[r].push(pm);
                open.remove(k);
            }
        }
        for o in &open {
            let mut pm = mark(o, r, (row.len() - 1).max(0));
            pm.continuation_to_next = Some(true);
            out[r].push(pm);
        }
    }
    out
}

/// 拍单位 → 速度记号里的音符字（附点四分写 `♩.`）
fn beat_char(num: f64, den: f64) -> &'static str {
    match (js::num_to_string(num).as_str(), js::num_to_string(den).as_str()) {
        ("1", "4") => "♩",
        ("1", "2") => "𝅗𝅥",
        ("1", "8") => "♪",
        ("3", "8") => "♩.",
        ("3", "4") => "𝅗𝅥.",
        ("1", "1") => "𝅝",
        _ => "♩",
    }
}

/// `print_tempo`：把速度数字印出来（`♩=144`）。文本谱的 `J:`、`.jpwabc` 的速度数字简谱档不印，只给别的来源。
fn to_metadata(song: &Song, print_tempo: bool) -> fq::Metadata {
    let mut meta = fq::Metadata::default();
    if let Some(t) = &song.work.title {
        meta.titles.push(t.clone());
    }
    meta.titles.extend(song.work.subtitles.iter().cloned());
    // MusicXML 的副标题只在 `<credit>` 里（`credit-type` 为 subtitle），`work` 那边没有
    if song.work.subtitles.is_empty() {
        for c in song.credits.iter().flatten() {
            let t = js::trim(&c.text);
            if c.kind.as_deref() == Some("subtitle") && !t.is_empty() && !meta.titles.iter().any(|x| x == t) {
                meta.titles.push(t.to_owned());
            }
        }
    }
    let scripture: Vec<String> =
        get_meta(song, "scripture").iter().chain(get_meta(song, "scripture-ref")).filter(|t| !js::trim(t).is_empty()).cloned().collect();
    if !scripture.is_empty() {
        meta.scripture = Some(scripture);
    }
    if let Some(v) = &song.work.version {
        meta.version = Some(v.clone());
    }
    // `.jpwabc` 的词曲一条写了好几行：作者条为写 123 的 `C:` 拼成了一行，原文的分行在 credits 里，照原文分行
    for c in song.identification.iter().flat_map(|i| &i.creators) {
        let multi = song.credits.iter().flatten().find(|k| {
            k.kind.as_deref().is_none_or(|t| t.is_empty()) && k.text.contains('\n') && k.text.replace('\n', " ") == c.text
        });
        meta.authors.push(multi.map_or_else(|| c.text.clone(), |k| k.text.clone()));
    }
    if let Some(key) = &song.key {
        if let Some(d) = &key.display {
            meta.mode = Some(d.clone());
        } else if let Some(s) = key.spelling.as_ref().filter(|s| !s.is_empty() && *s != "none") {
            meta.mode = Some(s.clone());
        } else if key.spelling.as_deref() != Some("none") {
            meta.mode = Some(tonic_spelling(key));
        }
        if let Some(t) = key.tonic_degree.as_ref().filter(|t| !t.is_empty() && *t != "1") {
            meta.tonic = Some(t.clone());
        }
    }
    for t in song.time.iter().chain(song.extra_times.iter().flatten()) {
        meta.meters.push(fq::Meter { numerator: t.beats, denominator: t.beat_type, parenthesized: t.parenthesized.unwrap_or(false) });
    }
    if let Some(n) = &song.time_note {
        meta.time_note = Some(n.clone());
    }
    meta.tempos = quarter_tempos(song);
    if print_tempo {
        if let Some((per_minute, beat)) = lead_tempo(song) {
            meta.tempo_mark = Some(format!("{}={}", beat_char(beat.num, beat.den), js::num_to_string(per_minute)));
        }
    }
    meta.remarks.extend(song.remarks.iter().flatten().cloned());
    if let Some(pt) = &song.page_text {
        meta.index_left = pt.index_left.clone();
        meta.index_right = pt.index_right.clone();
        meta.top_left.extend(pt.top_left.iter().cloned());
        meta.top_right.extend(pt.top_right.iter().cloned());
        meta.bottom_left.extend(pt.bottom_left.iter().cloned());
        meta.bottom_center.extend(pt.bottom_center.iter().cloned());
        meta.bottom_right.extend(pt.bottom_right.iter().cloned());
    }
    // 文档内样式指令原文（`FontSize:` / `Margin:` / 其它）交给 metrics 解释
    for r in song.style.iter().flat_map(|s| s.raw.iter().flatten()) {
        if r.key.eq_ignore_ascii_case("fontsize") {
            meta.font_sizes.push(r.value.clone());
        } else if r.key.eq_ignore_ascii_case("margin") {
            meta.margins.push(r.value.clone());
        } else {
            meta.options.push(fq::KeyValue { key: r.key.clone(), value: r.value.clone() });
        }
    }
    meta
}

struct SystemRow {
    /// `print.system`（文本谱来源才有）
    system: Option<f64>,
    /// 小节键（声部里的下标）
    measures: Vec<usize>,
    /// 切在小节中间的小节：这一行只取它 `[from, to)` 这一段元素
    ranges: Option<HashMap<usize, (usize, usize)>>,
    /// 这一行是从小节中间接着起的：首小节的 `print` 属于上一行
    cont: bool,
}

/// 和弦（或它的某条增时线）之后原位换行（`Chord.lineBreakAfter`）。
fn breaks_inline(el: &dm::Element) -> bool {
    match el {
        dm::Element::Chord(c) => c.line_break_after.is_some() || c.sustains.iter().flatten().any(|su| su.line_break_after.is_some()),
        dm::Element::Space(_) => false,
    }
}

/// 一个声部按系统切开（带 `print` 的小节**起**新系统）。小节中间换行照原位切：那一小节分成两段、各归一行，
/// 下一小节上同源的那条小节级 `print` 就不再断第二次。
fn split_systems(part: &dm::Part) -> Vec<SystemRow> {
    let mut rows: Vec<SystemRow> = vec![];
    let mut cur: Vec<usize> = vec![];
    let mut ranges: HashMap<usize, (usize, usize)> = HashMap::new();
    let mut cont = false;
    let mut sys: Option<f64> = None;
    let mut swallow = false;
    let flush = |rows: &mut Vec<SystemRow>, cur: &mut Vec<usize>, ranges: &mut HashMap<usize, (usize, usize)>, cont: &mut bool, sys: Option<f64>| {
        if !cur.is_empty() {
            let r = std::mem::take(ranges);
            rows.push(SystemRow { system: sys, measures: std::mem::take(cur), ranges: (!r.is_empty()).then_some(r), cont: *cont });
        }
        cur.clear();
        ranges.clear();
        *cont = false;
    };
    for (mi, m) in part.measures.iter().enumerate() {
        if let Some(p) = m.print.as_ref().filter(|p| p.new_system == Some(true) || p.new_page == Some(true)) {
            if !swallow {
                flush(&mut rows, &mut cur, &mut ranges, &mut cont, sys);
            }
            sys = p.system;
        }
        swallow = false;
        let mut from = 0;
        let n = m.elements.len();
        for (i, el) in m.elements.iter().enumerate() {
            if i == n - 1 || !breaks_inline(el) {
                continue;
            }
            ranges.insert(mi, (from, i + 1));
            cur.push(mi);
            flush(&mut rows, &mut cur, &mut ranges, &mut cont, sys);
            cont = true;
            from = i + 1;
            swallow = true;
        }
        if from > 0 {
            ranges.insert(mi, (from, n));
        }
        cur.push(mi);
    }
    flush(&mut rows, &mut cur, &mut ranges, &mut cont, sys);
    if rows.is_empty() {
        rows.push(SystemRow { system: None, measures: vec![], ranges: None, cont: false });
    }
    rows
}

/// 一个声部里真正换了调的小节 → 转调标签。与前一小节同调的 `attrs.key` 不算
fn key_change_labels(song: &Song, part: &dm::Part) -> HashMap<usize, String> {
    let mut out = HashMap::new();
    let mut cur = part.measures.first().and_then(|m| m.attrs.as_ref()).and_then(|a| a.key.as_ref()).map_or_else(|| song_fifths(song), |k| k.fifths);
    for (i, m) in part.measures.iter().enumerate() {
        let Some(k) = m.attrs.as_ref().and_then(|a| a.key.as_ref()) else { continue };
        if i == 0 || k.fifths == cur {
            continue;
        }
        cur = k.fifths;
        let prev = part.measures[i - 1]
            .barlines
            .iter()
            .flatten()
            .find(|b| b.location == dm::BarLocation::Right && b.annotation.as_ref().is_some_and(|a| !a.is_empty()));
        // 升降号用真符号、写在字母前（同页眉调号）
        let name = key_spelling(k, false).replace('b', "\u{266D}").replace('#', "\u{266F}");
        out.insert(i, prev.and_then(|b| b.annotation.clone()).unwrap_or_else(|| format!("转1={name}")));
    }
    out
}

/// 连音：`Chord.duration.timeMod` → Mark tuplet（连续一串带 `timeMod` 的和弦算一组，跨行的组按行拆成多段）。
fn row_tuplets(measures_by_row: &[&[&Measure]], rows: &[RowBuild]) -> Vec<Vec<fq::Mark>> {
    let mut out: Vec<Vec<fq::Mark>> = rows.iter().map(|_| vec![]).collect();
    for (r, measures) in measures_by_row.iter().enumerate() {
        let row = &rows[r];
        let mut open: Option<i64> = None;
        let close = |out: &mut Vec<Vec<fq::Mark>>, open: &mut Option<i64>, end: i64| {
            if let Some(s) = open.take() {
                let mut m = volta(s, end, 0.0, None);
                m.kind = fq::MarkType::Tuplet;
                out[r].push(m);
            }
        };
        for li in 0..measures.len() {
            let (first, last) = row.measure_span[li];
            for i in first..=last {
                let tm = row.refs.get(i).and_then(|r| r.chord).and_then(|c| c.duration.time_mod.as_ref());
                if tm.is_some() {
                    if open.is_none() {
                        open = Some(i as i64);
                    }
                    continue;
                }
                close(&mut out, &mut open, i as i64 - 1);
            }
        }
        close(&mut out, &mut open, row.len() - 1);
    }
    out
}

/// 原文按行（`/\r?\n/`）
fn split_lines(source: &str) -> Vec<&str> {
    source.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect()
}

fn to_fanqie_song(song: &Song, index: usize, raw_lines: &[&str], hand_pages: bool, print_tempo: bool) -> SongView {
    let per_part: Vec<Vec<SystemRow>> = song.parts.iter().map(split_systems).collect();
    // 文本谱来源：一组不一定含全部声部，按 `print.system` 对回同一组；其余按行序号
    let by_system = per_part.iter().any(|rows| rows.iter().any(|r| r.system.is_some()));
    let voice_of = |pi: usize| -> f64 {
        if by_system {
            let id = &song.parts[pi].id;
            if let Some(d) = id.strip_prefix('P') {
                if !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()) {
                    return js::number(d);
                }
            }
        }
        (pi + 1) as f64
    };
    // 各声部的全部行先建好——跨行记号要看别的行有没有端点
    let row_measures: Vec<Vec<Vec<&Measure>>> =
        per_part.iter().enumerate().map(|(pi, rows)| rows.iter().map(|r| r.measures.iter().map(|&k| &song.parts[pi].measures[k]).collect()).collect()).collect();
    let mut builds: Vec<Vec<RowBuild>> = per_part
        .iter()
        .enumerate()
        .map(|(pi, rows)| rows.iter().enumerate().map(|(r, row)| build_row(&row_measures[pi][r], &row.measures, row.ranges.as_ref(), &song.marks)).collect())
        .collect();
    for (pi, rows) in per_part.iter().enumerate() {
        let flat: Vec<usize> = rows.iter().flat_map(|r| r.measures.iter().copied()).collect();
        carry_to_prev_barline(&song.parts[pi].measures, &flat, &mut builds[pi], song.time.as_ref());
    }
    // MusicXML 来源的渐强渐弱只有 direction：按起止配成 Mark
    let has_wedge_marks = song.marks.iter().any(|m| m.kind == dm::MarkType::Wedge);
    let marks_of_part: Vec<Cow<[dm::Mark]>> = builds
        .iter()
        .map(|rows| {
            let w = if has_wedge_marks { vec![] } else { direction_wedge_marks(rows) };
            if w.is_empty() {
                Cow::Borrowed(song.marks.as_slice())
            } else {
                Cow::Owned(song.marks.iter().cloned().chain(w).collect())
            }
        })
        .collect();
    let voltas: Vec<Vec<Vec<fq::Mark>>> = per_part
        .iter()
        .enumerate()
        .map(|(pi, _)| {
            let by_row: Vec<&[&Measure]> = row_measures[pi].iter().map(|v| v.as_slice()).collect();
            row_voltas(&by_row, &builds[pi])
        })
        .collect();
    let tuplets: Vec<Vec<Vec<fq::Mark>>> = per_part
        .iter()
        .enumerate()
        .map(|(pi, _)| {
            let by_row: Vec<&[&Measure]> = row_measures[pi].iter().map(|v| v.as_slice()).collect();
            row_tuplets(&by_row, &builds[pi])
        })
        .collect();
    // 记号与歌词在挪走元素之前算好（跨行记号要看别的行）
    let mut segs: Vec<Vec<Vec<fq::Mark>>> =
        builds.iter().enumerate().map(|(pi, rows)| (0..rows.len()).map(|r| segment_marks(&marks_of_part[pi], rows, r)).collect()).collect();

    let mut systems: Vec<(f64, Vec<(usize, usize)>)> = vec![];
    for (pi, rows) in per_part.iter().enumerate() {
        for (r, row) in rows.iter().enumerate() {
            let key = if by_system { row.system.unwrap_or(r as f64) } else { r as f64 };
            let nk = js::NumKey::new(key);
            match systems.iter_mut().find(|s| js::NumKey::new(s.0) == nk) {
                Some(s) => s.1.push((pi, r)),
                None => systems.push((key, vec![(pi, r)])),
            }
        }
    }
    js::sort_by(&mut systems, |a, b| a.0 - b.0);

    /// 一行的元素与来源（落进组时挪走）
    type Taken = Option<(Vec<fq::MusicElement>, Vec<SlotRef>)>;
    let mut taken: Vec<Vec<Taken>> = builds
        .iter_mut()
        .map(|rows| {
            rows.iter_mut()
                .map(|b| {
                    let refs = b.refs.iter().map(|r| SlotRef { id: r.id, m: r.measure, e: r.e, s: r.s, b: r.barline.map(|x| x.1) }).collect();
                    Some((std::mem::take(&mut b.elements), refs))
                })
                .collect()
        })
        .collect();

    let mut pages: Vec<PageView> = vec![];
    let mut page = PageView { index: 0, groups: vec![] };
    for (key, members) in &systems {
        let mut voices: Vec<RowView> = vec![];
        let mut texts: &[String] = &[];
        let mut text_sources: &[SourceSpan] = &[];
        let mut new_page = false;
        for &(pi, r) in members {
            let part = &song.parts[pi];
            let sr = &per_part[pi][r];
            let p = if sr.cont { None } else { sr.measures.first().and_then(|&k| part.measures[k].print.as_ref()) };
            // 换页：文本谱的 `[fenye]`、123 / ABC 手写的 `%%newpage`。MusicXML 的 `new-page` 是原排版软件按它那张纸断的，不照搬
            if (by_system || hand_pages) && p.is_some_and(|p| p.new_page == Some(true)) {
                new_page = true;
            }
            if let Some(t) = p.and_then(|p| p.texts.as_ref()) {
                texts = t;
                text_sources = p.and_then(|p| p.text_sources.as_deref()).unwrap_or(&[]);
            }
            let row_segs = std::mem::take(&mut segs[pi][r]);
            // 解析器同时写了连音标记的，按 `timeMod` 补出来的与之重叠的就不再要
            let extra: Vec<fq::Mark> = tuplets[pi][r]
                .iter()
                .filter(|t| !row_segs.iter().any(|s| s.kind == fq::MarkType::Tuplet && s.start <= t.end && t.start <= s.end))
                .cloned()
                .collect();
            let lyrics = row_lyrics(&builds[pi][r], p.and_then(|p| p.lyric_lines.as_ref()));
            let (elements, refs) = taken[pi][r].take().expect("一行只进一组");
            let mut marks = row_segs;
            marks.extend(voltas[pi][r].iter().cloned());
            marks.extend(extra);
            let source = p.and_then(|p| p.source);
            let caption = if by_system { p.and_then(|p| p.caption.clone()) } else { part.name.clone() };
            voices.push(RowView {
                part: pi,
                measures: sr.measures.clone(),
                refs,
                line: fq::ScoreLine {
                    voice: voice_of(pi),
                    variant: p.and_then(|p| p.variant.as_ref()).map(|v| v.as_str().to_owned()),
                    caption,
                    elements,
                    marks,
                    lyrics,
                    raw: source.map_or(String::new(), |s| raw_lines.get(s.line as usize).map_or(String::new(), |l| (*l).to_owned())),
                    source: source.unwrap_or(ZERO),
                },
            });
        }
        if new_page && !page.groups.is_empty() {
            pages.push(std::mem::replace(&mut page, PageView { index: pages.len() + 1, groups: vec![] }));
        }
        page.groups.push(SystemView {
            index: page.groups.len(),
            system: *key,
            texts: texts.iter().enumerate().map(|(i, t)| fq::TextLine { text: t.clone(), source: text_sources.get(i).copied().unwrap_or(ZERO) }).collect(),
            voices,
        });
    }
    pages.push(page);
    SongView { index, metadata: to_metadata(song, print_tempo), pages, song: None }
}

/// 一份 `ScoreDoc` 的排版行视图。`source`：原文（文本谱来源按 `Print.source` 的行号取行的 `raw`）。
pub fn doc_view(doc: &dm::ScoreDoc, source: Option<&str>) -> DocView {
    let fanqie = doc.source_format == dm::SourceFormat::Fanqie;
    let raw_lines: Vec<&str> = match source.or(doc.source.as_deref()) {
        Some(s) if fanqie && !s.is_empty() => split_lines(s),
        _ => vec![],
    };
    let hand_pages = matches!(doc.source_format, dm::SourceFormat::S123 | dm::SourceFormat::Abc);
    // 速度数字只给 123 / ABC / MusicXML 这类来源印；文本谱的 `J:`、JP-Word 的 `Expression` 简谱档本来不印
    let print_tempo = !fanqie && doc.source_format != dm::SourceFormat::Jpwabc;
    let mut songs: Vec<SongView> = vec![];
    let mut projected: Vec<Cow<Song>> = vec![];
    for (i, s) in doc.songs.iter().enumerate() {
        // MusicXML 读进来的先投成简谱形状（长音拆增时线、减时线按 `<type>` 算、和弦补原文）
        let p = project_for_jianpu(s);
        let c = match p {
            Cow::Borrowed(b) => compress_multi_rests(b),
            Cow::Owned(o) => Cow::Owned(compress_multi_rests(&o).into_owned()),
        };
        songs.push(to_fanqie_song(&c, i, &raw_lines, hand_pages, print_tempo));
        projected.push(c);
    }
    // 转调标签：全曲同步，只印在一组的第一个声部上、每个小节一次
    let mut labels_of: HashMap<(usize, usize), HashMap<usize, String>> = HashMap::new();
    let mut labelled: HashSet<(usize, usize, usize)> = HashSet::new();
    for (si, sv) in songs.iter_mut().enumerate() {
        let song: &Song = &projected[si];
        for pg in &mut sv.pages {
            for g in &mut pg.groups {
                for (vi, row) in g.voices.iter_mut().enumerate() {
                    let labels = labels_of.entry((si, row.part)).or_insert_with(|| key_change_labels(song, &song.parts[row.part]));
                    if vi != 0 {
                        continue;
                    }
                    for (el, r) in row.line.elements.iter_mut().zip(&row.refs) {
                        let Some(label) = labels.get(&r.m) else { continue };
                        let is_chord = r.e.is_some_and(|e| matches!(song.parts[row.part].measures[r.m].elements[e], dm::Element::Chord(_)));
                        if let fq::MusicElement::Note(n) = el {
                            if is_chord && labelled.insert((si, row.part, r.m)) {
                                n.key_label = Some(label.clone());
                            }
                        }
                    }
                }
            }
        }
    }
    for (sv, p) in songs.iter_mut().zip(projected) {
        if let Cow::Owned(mut s) = p {
            // 投影出来的副本没有身份（同 TS `structuredClone` 后表层挂不上）
            dm::helpers::clear_oids(&mut s);
            sv.song = Some(s);
        }
    }
    DocView { songs }
}
