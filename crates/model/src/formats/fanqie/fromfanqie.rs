//! `FanqieDoc` → `ScoreDoc`：文本谱进语义模型的**唯一入口**（同 `fanqie/fromfanqie.ts`）。
//!
//! ## 判据：无损
//!
//! 文本谱的排版、导出、试听、双向定位、乐句重排都只吃 `ScoreDoc`，所以这里转过去的东西必须**足以原样还原出那棵树**。
//! 文本谱特有、MusicXML 装不下的东西（记号原名与 level、`~`/`^`、临时伴奏层、行级歌词版式）放在模型里标明来源的字段上，
//! 语义那一侧（`notations` / `Barline.ending` / `Mark`）照常填。
//!
//! ## 结构差异
//!
//! `FanqieDoc` 是**扁平元素流 + 下标区间配对**，`ScoreDoc` 是**小节层级 + id 配对**。
//! 先按 barline 切小节，同时建「下标 → 元素 id」的映射，再把 Mark 的下标区间翻成 id。
//!
//! 行结构：一个 `VoiceGroup` 是一个系统。每个声部在该组那一行的**首小节**上挂 `print.newSystem` + `print.system`（组序号）。
//!
//! TS 靠对象引用的几处改成：歌词宿主记（行内第几小节, 第几个元素, 第几条增时线）；房号起点那条小节线临时借 `_oid`
//! 认（声部第几小节 + oid），转完清掉；跨行弧线的待合并队列记 `out` 里的下标（起点在上一行行尾的那条未落地，单独放着）。

use super::ast::{
    BarlineElement, BarlineType, Behavior, LyricLine as FanqieLyricLine, Mark as FanqieMark, MarkType as FanqieMarkType, MusicElement,
    NoteElement, Ornament, Sound, SustainElement,
};
use super::ast::{FanqieDoc, LayerRole as FanqieLayerRole};
use crate::formats::abc::fields::normalize_spelling;
use crate::base::js;
use crate::helpers::{clear_oids, empty_doc, empty_song, IdGen};
use crate::keyshift::{key_of_degree, song_fifths};
use crate::metakeys::creator_of;
use crate::timeaxis::axis_of_song;
use crate::tuplets::apply_tuplet_time_mods;
use crate::*;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicU32, Ordering};

/// 房号 start/stop 的配对号：与 TS 一样是进程级计数（对拍时按文档归一）
static VOLTA_PAIR: AtomicU32 = AtomicU32::new(0);

fn from_fanqie_barline(el: &BarlineElement) -> Barline {
    let mut b = Barline::at(BarLocation::Right);
    match el.kind {
        BarlineType::End => b.style = Some(BarStyle::LightHeavy),
        BarlineType::Double => b.style = Some(BarStyle::LightLight),
        BarlineType::RepeatStart => {
            b.style = Some(BarStyle::HeavyLight);
            b.repeat = Some(RepeatDir::Forward);
        }
        BarlineType::RepeatEnd => {
            b.style = Some(BarStyle::LightHeavy);
            b.repeat = Some(RepeatDir::Backward);
        }
        BarlineType::RepeatBoth => {
            b.style = Some(BarStyle::LightHeavy);
            b.repeat = Some(RepeatDir::Backward);
            b.also_forward = Some(true);
        }
        // `|/` 不显形也不占宽、`|*` 不显形但占宽：MusicXML 两者都只能是 none
        BarlineType::Hidden => {
            b.style = Some(BarStyle::NoStyle);
            b.no_width = Some(true);
        }
        BarlineType::Invisible => b.style = Some(BarStyle::NoStyle),
        BarlineType::Normal => b.style = Some(BarStyle::Regular),
    }
    if !el.ornaments.is_empty() {
        b.ornaments = Some(ornaments_of(&el.ornaments));
    }
    if let Some(m) = &el.temporary_meter {
        b.time = Some(Time { beats: m.numerator, beat_type: m.denominator, symbol: None, parenthesized: if m.parenthesized { Some(true) } else { None } });
    }
    if let Some(a) = &el.annotation {
        b.annotation = Some(a.clone());
    }
    b.source = Some(el.source);
    b
}

fn ornaments_of(os: &[Ornament]) -> Vec<SourceOrnament> {
    os.iter().map(|o| SourceOrnament { name: o.name.clone(), level: o.level, below: if o.below == Some(true) { Some(true) } else { None } }).collect()
}

/// 时值分母（4=四分）→ 减时线层数。
fn beams_of(duration: u32) -> usize {
    let mut n = 0;
    let mut d = duration as f64;
    while d > 4.0 && n < 6 {
        d /= 2.0;
        n += 1;
    }
    n
}

const TYPES: [NoteType; 7] = [NoteType::Quarter, NoteType::Eighth, NoteType::N16th, NoteType::N32nd, NoteType::N64th, NoteType::N128th, NoteType::N256th];

fn duration_from(duration: u32, dots: f64, sustains: usize) -> Duration {
    let beams = beams_of(duration);
    let base = (SIMPLE_DIVISIONS as i64) >> beams.min(6);
    let mut total = base;
    let mut add = base;
    for _ in 0..dots as usize {
        add /= 2;
        total += add;
    }
    let total = total as f64 + sustains as f64 * SIMPLE_DIVISIONS;
    Duration { divisions: total, kind: Some(TYPES[beams.min(6)].clone()), dots, time_mod: None }
}

fn harmony_of(text: &str) -> Harmony {
    Harmony { root: HarmonyStep { step: "C".into(), alter: 0.0, alter_left: None }, kind: String::new(), text: Some(text.into()), ..Default::default() }
}

/// 挂在符号上的和弦名、注记、`&xx` 记号在原文里的位置（只给编辑用），按原文顺序。
fn attached_of(chord: Option<(&String, &Option<crate::base::SourceSpan>)>, ann: Option<(&String, &Option<crate::base::SourceSpan>)>, ornaments: &[Ornament]) -> Option<Vec<AttachedSource>> {
    let mut out = vec![];
    if let Some((name, Some(src))) = chord {
        out.push(AttachedSource { kind: AttachedKind::Harmony, name: name.clone(), source: *src });
    }
    if let Some((name, Some(src))) = ann {
        out.push(AttachedSource { kind: AttachedKind::Annotation, name: name.clone(), source: *src });
    }
    for o in ornaments {
        out.push(AttachedSource { kind: AttachedKind::Deco, name: o.name.clone(), source: o.source });
    }
    out.sort_by_key(|a| a.source.offset);
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn attached_of_note(n: &NoteElement) -> Option<Vec<AttachedSource>> {
    attached_of(n.chord.as_ref().map(|c| (c, &n.chord_source)), n.annotation.as_ref().map(|a| (a, &n.annotation_source)), &n.ornaments)
}

fn attached_of_sustain(s: &SustainElement) -> Option<Vec<AttachedSource>> {
    attached_of(s.chord.as_ref().map(|c| (c, &s.chord_source)), s.annotation.as_ref().map(|a| (a, &s.annotation_source)), &s.ornaments)
}

fn is_fermata(name: &str) -> bool {
    name.eq_ignore_ascii_case("yc") || name.eq_ignore_ascii_case("fermata")
}

/// 一个音符（主音或倚音）→ 和弦。倚音不占时值，但减时线层数要留着（排版画它）。
fn chord_of_note(n: &NoteElement, voice: f64, ids: &mut IdGen, grace: Option<GraceInfo>) -> Chord {
    let beams = beams_of(n.duration);
    let mut duration = duration_from(n.duration, n.dots as f64, 0);
    if grace.is_some() {
        duration.divisions = 0.0;
    }
    let mut ch = Chord { id: ids.next(), notes: vec![], duration, voice, staff: 1.0, source: Some(n.source), ..Default::default() };
    let is_grace = grace.is_some();
    ch.grace = grace;
    if n.sound == Sound::Rhythm {
        // 节奏音符（文本谱的 `X`、番茄的 `9`）：有声无音高，123 写 `X`
        ch.rhythm = Some(true);
    } else if n.pitch == 0 {
        ch.rest = Some(RestInfo { octave_shift: if n.octave != 0 { Some(n.octave as f64) } else { None }, ..Default::default() });
    } else {
        ch.notes.push(Note {
            degree: Some(Degree { number: n.pitch as f64, octave_shift: n.octave as f64, accidental: n.accidental.clone() }),
            ..Default::default()
        });
    }
    // 隐藏音符：`FanqieDoc` 用 hidden 标记，`ScoreDoc` 用 printObject=false（123 写 `x`）
    if n.hidden {
        ch.print_object = Some(false);
    }
    // 对位缺省是「非休止」，只记例外；倚音一律记（123 的倚音缺省不对位）
    if is_grace || n.lyric_anchor != (n.pitch != 0 || n.sound == Sound::Rhythm) {
        ch.lyric_anchor = Some(n.lyric_anchor);
    }
    if beams > 0 {
        ch.beams = Some(vec![BeamVal::Continue; beams]);
    }
    if let Some(c) = &n.chord {
        ch.harmony = Some(harmony_of(c));
    }
    // `"(副歌)"` 这类音符上方的注记：`FanqieDoc` 存 `annotation`，模型里归 `sectionWord`
    if let Some(a) = &n.annotation {
        ch.section_word = Some(a.clone());
    }
    if !n.ornaments.is_empty() {
        ch.ornaments = Some(ornaments_of(&n.ornaments));
        // 语义投影（123 与导出用）
        let fermata = n.ornaments.iter().any(|o| is_fermata(&o.name));
        let arts: Vec<String> = n.ornaments.iter().filter(|o| !is_fermata(&o.name)).map(|o| o.name.clone()).collect();
        ch.notations = Some(Notations {
            fermata: if fermata { Some(true) } else { None },
            articulations: if arts.is_empty() { None } else { Some(arts) },
            ..Default::default()
        });
    }
    ch.attached_sources = attached_of_note(n);
    ch
}

/// 歌词宿主：行内第几小节、小节里第几个元素、（增时线时）第几条
type AnchorPath = (usize, usize, Option<usize>);

struct LineResult {
    measures: Vec<Measure>,
    /// 元素流下标 → `ScoreDoc` 元素 id（Mark 的区间靠它翻译）
    id_at: HashMap<usize, ElementId>,
    /// 元素流下标 → 它落在第几小节（房号要找小节）
    measure_at: HashMap<usize, usize>,
    /// 参与对位的元素（按顺序），歌词按它铺回去
    anchors: Vec<AnchorPath>,
    /// 这一行元素流的长度
    length: usize,
}

/// 承接前音时要看的那几样（TS 存整个和弦对象，只读这几样）
#[derive(Clone)]
struct LastChord {
    notes: Vec<Note>,
    rest: bool,
    rhythm: bool,
}

/// 跨行承接状态
struct Carry {
    /// 行首的 `-` 要照抄的前音
    last: Option<LastChord>,
    /// 首调号的 fifths（`"k:2"` 按它换算）
    home: f64,
    /// 小节线上 `"k:…"` 定下的新调号（带序号：TS 比对象身份），落到线后那个小节
    key: Option<(u32, Option<Key>)>,
}

struct Conv {
    ids: IdGen,
    /// 调号对象的序号（代 TS 的对象身份）
    key_serial: u32,
    /// 临时借给小节线的 `_oid`
    bar_oid: u32,
}

impl Conv {
    fn next_key(&mut self, k: Option<Key>) -> (u32, Option<Key>) {
        self.key_serial += 1;
        (self.key_serial, k)
    }
    fn next_bar_oid(&mut self) -> Oid {
        self.bar_oid += 1;
        Oid(self.bar_oid)
    }
}

/// 正在攒的小节：带着它 `attrs.key` 的序号
struct Pending {
    mea: Measure,
    key_serial: Option<u32>,
}

fn fresh(no: usize, carry: &Carry) -> Pending {
    let mut mea = Measure { number: no.to_string(), ..Default::default() };
    let mut key_serial = None;
    if let Some((s, k)) = &carry.key {
        mea.attrs = Some(MeasureAttrs { key: k.clone(), ..Default::default() });
        key_serial = Some(*s);
    }
    Pending { mea, key_serial }
}

fn has_barlines(m: &Measure) -> bool {
    m.barlines.as_ref().is_some_and(|b| !b.is_empty())
}

/// 一行曲（或一段临时伴奏层）→ 小节数组。
fn convert_line(elements: &[MusicElement], voice: f64, conv: &mut Conv, start_measure_no: usize, carry: &mut Carry) -> LineResult {
    let mut measures: Vec<Measure> = vec![];
    let mut id_at = HashMap::new();
    let mut measure_at = HashMap::new();
    let mut anchors: Vec<AnchorPath> = vec![];
    let mut cur = fresh(start_measure_no, carry);
    // 本小节里增时线可以并进去的那个和弦（小节内下标）；小节线后清空（跨线的 `-` 是承接前音）
    let mut host: Option<usize> = None;
    // 还没找到宿主的夹层（`~`/`^`/临时伴奏），挂到下一个符号上
    let mut pending: Vec<InlineItem> = vec![];

    macro_rules! take_pending {
        ($target:expr) => {
            if !pending.is_empty() {
                $target = Some(std::mem::take(&mut pending));
            }
        };
    }
    // 把当前小节收进 measures（有东西才收），再开新的一节
    let flush = |cur: &mut Pending, measures: &mut Vec<Measure>, carry: &mut Carry, conv: &mut Conv, bar: Option<Barline>, key: Option<&String>| {
        if let Some(b) = bar {
            cur.mea.barlines.get_or_insert_with(Vec::new).push(b);
        }
        if !cur.mea.elements.is_empty() || has_barlines(&cur.mea) {
            let serial = cur.key_serial;
            measures.push(std::mem::take(&mut cur.mea));
            if serial == carry.key.as_ref().map(|k| k.0) {
                carry.key = None;
            }
        }
        if let Some(k) = key {
            carry.key = Some(conv.next_key(key_of_degree(carry.home, k)));
        }
        *cur = fresh(start_measure_no + measures.len(), carry);
    };

    for (i, el) in elements.iter().enumerate() {
        match el {
            MusicElement::Barline(bel) => {
                let mut b = from_fanqie_barline(bel);
                take_pending!(b.before);
                measure_at.insert(i, measures.len());
                // 无音符的前导线是下一小节的左边界，不是一个独立空小节。
                if cur.mea.elements.is_empty() {
                    b.location = BarLocation::Left;
                    cur.mea.barlines.get_or_insert_with(Vec::new).push(b);
                    if let Some(tk) = &bel.temporary_key {
                        let k = conv.next_key(key_of_degree(carry.home, tk));
                        cur.mea.attrs.get_or_insert_with(Default::default).key = k.1.clone();
                        cur.key_serial = Some(k.0);
                        carry.key = Some(k);
                    }
                    continue;
                }
                flush(&mut cur, &mut measures, carry, conv, Some(b), bel.temporary_key.as_ref());
                host = None;
            }

            MusicElement::Sustain(s) => {
                let Some(h) = host else {
                    // 小节线/行首之后的 `-`：承接前音的延长。它自己印成一条增时线
                    let prev = carry.last.clone();
                    let mut ch = Chord {
                        id: conv.ids.next(),
                        notes: prev
                            .as_ref()
                            .map(|p| p.notes.iter().map(|nt| Note { degree: nt.degree.clone(), ..Default::default() }).collect())
                            .unwrap_or_default(),
                        duration: duration_from(4, 0.0, 0),
                        voice,
                        staff: 1.0,
                        continued: Some(true),
                        source: Some(s.source),
                        ..Default::default()
                    };
                    if prev.as_ref().is_none_or(|p| p.rest) {
                        ch.rest = Some(RestInfo::default());
                    }
                    if prev.as_ref().is_some_and(|p| p.rhythm) {
                        ch.rhythm = Some(true);
                    }
                    if s.lyric_anchor != (ch.rest.is_none() || ch.rhythm.is_some()) {
                        ch.lyric_anchor = Some(s.lyric_anchor);
                    }
                    if let Some(c) = &s.chord {
                        ch.harmony = Some(harmony_of(c));
                    }
                    if let Some(a) = &s.annotation {
                        ch.section_word = Some(a.clone());
                    }
                    if !s.ornaments.is_empty() {
                        ch.ornaments = Some(ornaments_of(&s.ornaments));
                    }
                    ch.attached_sources = attached_of_sustain(s);
                    take_pending!(ch.before);
                    id_at.insert(i, ch.id);
                    measure_at.insert(i, measures.len());
                    if s.lyric_anchor {
                        anchors.push((measures.len(), cur.mea.elements.len(), None));
                    }
                    host = Some(cur.mea.elements.len());
                    carry.last = Some(LastChord { notes: ch.notes.clone(), rest: ch.rest.is_some(), rhythm: ch.rhythm.is_some() });
                    cur.mea.elements.push(Element::Chord(ch));
                    continue;
                };
                let mut su = Sustain {
                    id: conv.ids.next(),
                    harmony: s.chord.as_deref().map(harmony_of),
                    notations: None,
                    ornaments: if s.ornaments.is_empty() { None } else { Some(ornaments_of(&s.ornaments)) },
                    section_word: s.annotation.clone(),
                    lyric_anchor: if s.lyric_anchor { Some(true) } else { None },
                    lyrics: None,
                    before: None,
                    line_break_after: None,
                    attached_sources: attached_of_sustain(s),
                    source: Some(s.source),
                };
                take_pending!(su.before);
                let su_id = su.id;
                let Element::Chord(hc) = &mut cur.mea.elements[h] else { unreachable!() };
                let sus = hc.sustains.get_or_insert_with(Vec::new);
                sus.push(su);
                let n_sus = sus.len();
                hc.duration = duration_from(4 << hc.beams.as_ref().map_or(0, |b| b.len()), hc.duration.dots, n_sus);
                id_at.insert(i, su_id);
                measure_at.insert(i, measures.len());
                if s.lyric_anchor {
                    anchors.push((measures.len(), h, Some(n_sus - 1)));
                }
            }

            MusicElement::Note(n) => {
                // 倚音：`FanqieDoc` 挂在主音符上，`ScoreDoc` 是独立的 grace 元素，前倚音在主音之前、后倚音在之后
                for g in &n.grace_before {
                    let c = chord_of_note(g, voice, &mut conv.ids, Some(GraceInfo::default()));
                    cur.mea.elements.push(Element::Chord(c));
                }
                let mut ch = chord_of_note(n, voice, &mut conv.ids, None);
                take_pending!(ch.before);
                let id = ch.id;
                let at = cur.mea.elements.len();
                carry.last = Some(LastChord { notes: ch.notes.clone(), rest: ch.rest.is_some(), rhythm: ch.rhythm.is_some() });
                cur.mea.elements.push(Element::Chord(ch));
                for g in &n.grace_after {
                    let c = chord_of_note(g, voice, &mut conv.ids, Some(GraceInfo { after: Some(true), ..Default::default() }));
                    cur.mea.elements.push(Element::Chord(c));
                }
                id_at.insert(i, id);
                measure_at.insert(i, measures.len());
                host = Some(at);
                if n.lyric_anchor {
                    anchors.push((measures.len(), at, None));
                }
            }

            MusicElement::BeatBoundary(b) => pending.push(InlineItem::Boundary {
                behavior: if b.behavior == Behavior::Join { BoundaryBehavior::Join } else { BoundaryBehavior::Split },
                source: Some(b.source),
            }),

            MusicElement::InlineLayer(l) => {
                // 伴奏层是独立的一小段元素流：自带小节与记号，承接状态不跟主旋律串
                let mut sub_carry = Carry { last: None, home: carry.home, key: None };
                let mut sub = convert_line(&l.elements, voice, conv, 1, &mut sub_carry);
                let mut marks: Vec<Mark> = vec![];
                let mut sub_measures = std::mem::take(&mut sub.measures);
                convert_marks(&l.marks, &sub, &mut marks, &mut CrossState::default(), &mut sub_measures, 0, None, conv);
                {
                    let mut seq: Vec<&mut Element> = sub_measures.iter_mut().flat_map(|m| m.elements.iter_mut()).collect();
                    apply_tuplet_time_mods(&marks, &mut seq, fanqie_tuplet_ratio);
                }
                pending.push(InlineItem::Layer {
                    role: if l.role == FanqieLayerRole::Accompaniment { LayerRole::Accompaniment } else { LayerRole::Voice },
                    measures: sub_measures,
                    marks,
                    source: Some(l.source),
                });
            }
        }
    }
    // 行末剩下的夹层：挂在最后一个小节上（行里一个小节都没有时单独成一个空小节）
    if !pending.is_empty() {
        if !cur.mea.elements.is_empty() || has_barlines(&cur.mea) || measures.is_empty() {
            cur.mea.trailing = Some(std::mem::take(&mut pending));
            let serial = cur.key_serial;
            measures.push(std::mem::take(&mut cur.mea));
            if serial == carry.key.as_ref().map(|k| k.0) {
                carry.key = None;
            }
            cur = fresh(start_measure_no + measures.len(), carry);
        } else {
            measures.last_mut().unwrap().trailing = Some(std::mem::take(&mut pending));
        }
    }
    flush(&mut cur, &mut measures, carry, conv, None, None);
    LineResult { measures, id_at, measure_at, anchors, length: elements.len() }
}

fn anchor_lyrics(measures: &mut [Measure], (mi, ei, si): AnchorPath) -> &mut Option<Vec<Lyric>> {
    let Element::Chord(c) = &mut measures[mi].elements[ei] else { unreachable!() };
    match si {
        None => &mut c.lyrics,
        Some(k) => &mut c.sustains.as_mut().unwrap()[k].lyrics,
    }
}

/// 歌词铺回音符：`FanqieDoc` 按行存音节序列，`ScoreDoc` 挂在元素上；行这一级的版式记进 `print.lyricLines`。
fn attach_lyrics(measures: &mut [Measure], anchors: &[AnchorPath], lyrics: &[FanqieLyricLine]) -> Vec<LyricLineInfo> {
    let mut infos = vec![];
    let range_key = |l: &FanqieLyricLine| (l.verse_from.to_bits(), l.verse_to.to_bits());
    let mut dup = HashSet::new();
    let mut seen = HashSet::new();
    for l in lyrics {
        if !seen.insert(range_key(l)) {
            dup.insert(range_key(l));
        }
    }
    for (line_idx, line) in lyrics.iter().enumerate() {
        infos.push(LyricLineInfo {
            verse_from: line.verse_from,
            verse_to: line.verse_to,
            annotation: line.annotation.clone(),
            annotation_gap: line.annotation_gap,
            join_brace: if line.join_brace == Some(true) { Some(true) } else { None },
            count: line.syllables.len() as f64,
            source: Some(line.source),
            sources: Some(line.syllables.iter().map(|s| s.source).collect()),
        });
        let mut labelled = false;
        for (k, syl) in line.syllables.iter().enumerate().take(anchors.len()) {
            // 空串 = 跳过这个音符；只剩标点的（「心|，|难」）要留着，标点得画
            if syl.text.is_empty() && syl.trailing_punctuation.as_deref().is_none_or(str::is_empty) {
                continue;
            }
            let mut l = Lyric { number: line.verse_from, text: syl.text.clone(), ..Default::default() };
            if line.verse_to != line.verse_from {
                l.number_to = Some(line.verse_to);
            }
            if let Some(tp) = syl.trailing_punctuation.as_ref().filter(|t| !t.is_empty()) {
                l.trailing_punctuation = Some(tp.clone());
            }
            // 印刷段号挂在该段**第一个非空**音节上
            if !labelled {
                if let Some(a) = &line.annotation {
                    l.verse_label = Some(a.clone());
                    labelled = true;
                }
            }
            if dup.contains(&range_key(line)) {
                l.line_index = Some(line_idx as f64);
            }
            l.source = Some(syl.source);
            anchor_lyrics(measures, anchors[k]).get_or_insert_with(Vec::new).push(l);
        }
    }
    infos
}

/// 跨行记号待合并队列里的一条：已经落进 `out` 的（记下标），或起点在上一行行尾、还没落地的
enum Queued {
    Out(usize),
    Detached(Box<Mark>),
}

/// 跨行记号的待合并状态。`FanqieDoc` 把一条跨行弧拆成两条（各带 continuation 标记），123 里跨行弧是一对 `(` `)`，要合回一条。
/// **按类型排队**（不能用 level：续接那条会重新编 level）。同类多条按先后顺序配。
#[derive(Default)]
struct CrossState {
    pending: HashMap<u8, Vec<Queued>>,
}

/// 房号起点所在：声部里第几小节 + 那条小节线临时借的 oid
#[derive(Clone, Copy)]
struct EndRef {
    measure: usize,
    bar: Oid,
}

struct Lead {
    caption: String,
    level: f64,
    placeholder: EndRef,
}

/// 跨行未收口的房号。起在行尾（本行已无小节可挂）时 `start` 为空，先记下房号与 level，到续行首小节再建
struct OpenVolta {
    start: Option<EndRef>,
    lead: Option<Lead>,
}

/// 文本谱多连音的比例：写了显示数字照数字，没写按组内符号数 n；一律占 n−1 个
fn fanqie_tuplet_ratio(mk: &Mark, n: usize) -> (f64, f64) {
    let a = mk.tuplet_actual.unwrap_or(n as f64);
    (a, a - 1.0)
}

/// Mark：下标区间 → id 配对。房号另走 `apply_volta`。`measures[base..]` 是本行的小节。
#[allow(clippy::too_many_arguments)]
fn convert_marks(
    marks: &[FanqieMark],
    r: &LineResult,
    out: &mut Vec<Mark>,
    cross: &mut CrossState,
    measures: &mut [Measure],
    base: usize,
    mut voltas: Option<&mut Vec<OpenVolta>>,
    conv: &mut Conv,
) {
    for m in marks {
        if m.kind == FanqieMarkType::Volta {
            match voltas.as_deref_mut() {
                Some(v) => apply_volta(r, m, measures, base, v, conv),
                None => apply_volta(r, m, measures, base, &mut vec![], conv),
            }
            continue;
        }
        let kind = match m.kind {
            FanqieMarkType::Slur => MarkType::Slur,
            FanqieMarkType::Tuplet => MarkType::Tuplet,
            _ => MarkType::Wedge,
        };
        let wedge = match m.kind {
            FanqieMarkType::Crescendo => Some(WedgeType::Crescendo),
            FanqieMarkType::Decrescendo => Some(WedgeType::Diminuendo),
            _ => None,
        };
        let level = if m.level != 0.0 { Some(m.level) } else { None };
        let to_next = m.continuation_to_next == Some(true);
        let from_prev = m.continuation_from_previous == Some(true);
        let start_i = nearest_index(&r.id_at, m.start as usize, 1);
        let end_i = nearest_index(&r.id_at, m.end as usize, -1);
        let start = start_i.map(|i| r.id_at[&i]);
        let end = end_i.map(|i| r.id_at[&i]);
        // 端点离最近符号的偏移（`Mark.startLead/endTrail`）
        let lead = start_i.map_or(0, |i| i - (m.start as usize));
        let trail = end_i.map_or(0, |i| (m.end as usize) - i);
        let set_trail = |mk: &mut Mark| {
            mk.end_trail = if trail > 0 && !to_next { Some(trail as f64) } else { None };
        };
        if start.is_none() && to_next && !from_prev {
            // 起点在行尾：本行没有符号可挂，占个位，等续行来了再定起点（`Mark.leadInPreviousLine`）
            let mut lm = Mark::new(kind.clone(), 0, 0);
            lm.lead_in_previous_line = Some(true);
            lm.continues_to_next = Some(true);
            lm.level = level;
            if r.length as isize - (m.start as usize) as isize > 0 {
                lm.lead_back = Some((r.length - (m.start as usize)) as f64);
            }
            lm.wedge_type = wedge.clone();
            cross.pending.entry(m.kind as u8).or_default().push(Queued::Detached(Box::new(lm)));
            continue;
        }
        let collapsed = m.start > m.end && !to_next && !from_prev;
        if let (None, Some(e), true) = (start, end, collapsed) {
            let mut mk = Mark::new(kind.clone(), e, e);
            mk.collapsed = Some(true);
            mk.level = level;
            mk.wedge_type = wedge.clone();
            out.push(mk);
            continue;
        }
        let (Some(start), Some(end)) = (start, end) else { continue };
        // 续接行：把终点接回上一行那条，不再产生新的一条
        if from_prev {
            let queue = cross.pending.entry(m.kind as u8).or_default();
            if !queue.is_empty() {
                let head = queue.remove(0);
                let idx = match head {
                    Queued::Detached(mut hm) => {
                        hm.start = start;
                        if lead > 0 {
                            hm.start_lead = Some(lead as f64);
                        }
                        out.push(*hm);
                        out.len() - 1
                    }
                    Queued::Out(k) => k,
                };
                let hm = &mut out[idx];
                hm.end = end;
                if let Some(cs) = m.close_source {
                    hm.close_source = Some(cs);
                }
                set_trail(hm);
                hm.continues_to_next = None;
                hm.continuation_levels.get_or_insert_with(Vec::new).push(m.level);
                if to_next {
                    hm.continues_to_next = Some(true);
                    queue.push(Queued::Out(idx));
                }
                continue;
            }
        }
        let mut mk = Mark::new(kind.clone(), start, end);
        if kind == MarkType::Slur {
            mk.open_source = Some(m.source);
            if let Some(cs) = m.close_source {
                mk.close_source = Some(cs);
            }
        }
        if lead > 0 && !from_prev {
            mk.start_lead = Some(lead as f64);
        }
        set_trail(&mut mk);
        mk.level = level;
        mk.wedge_type = wedge.clone();
        if kind == MarkType::Tuplet {
            // 显示数字只在原文写了时才有；没写时 123 与导出按 3 连音处理
            if let Some(c) = &m.caption {
                let actual = js::number(c);
                if actual.is_finite() {
                    mk.tuplet_actual = Some(actual);
                }
            }
            mk.tuplet_normal = Some(2.0);
        }
        if from_prev {
            mk.continues_from_previous = Some(true);
        }
        out.push(mk);
        if to_next {
            out.last_mut().unwrap().continues_to_next = Some(true);
            cross.pending.entry(m.kind as u8).or_default().push(Queued::Out(out.len() - 1));
        }
    }
}

/// 下标可能落在 barline（没有 id）上，按方向找最近的有 id 的元素（最多 64 步）。
fn nearest_index(id_at: &HashMap<usize, ElementId>, from: usize, dir: isize) -> Option<usize> {
    let mut i = from as isize;
    while i >= 0 && i < from as isize + 64 {
        if id_at.contains_key(&(i as usize)) {
            return Some(i as usize);
        }
        if dir == -1 && i == 0 {
            break;
        }
        i += dir;
    }
    None
}

/// 第 k 小节在行里的首/末下标（只数有归属的符号与小节线）
fn measure_edge(r: &LineResult, k: usize, first: bool) -> Option<usize> {
    let it = r.measure_at.iter().filter(|(_, &mk)| mk == k).map(|(&i, _)| i);
    if first {
        it.min()
    } else {
        it.max()
    }
}

/// 下标 → 所在小节。落在无 id 的东西上时按方向找最近有归属的。
fn nearest_measure(r: &LineResult, from: usize, dir: isize) -> Option<usize> {
    let mut i = from as isize;
    while i >= 0 && i < from as isize + 64 {
        if let Some(&k) = r.measure_at.get(&(i as usize)) {
            return Some(k);
        }
        if dir == -1 && i == 0 {
            break;
        }
        i += dir;
    }
    None
}

fn ending_mut(measures: &mut [Measure], at: EndRef) -> &mut Ending {
    measures[at.measure].barlines.as_mut().unwrap().iter_mut().find(|b| b.oid == at.bar).unwrap().ending.as_mut().unwrap()
}

/// 房号：`FanqieDoc` 的 volta Mark → 起止小节的 `Barline.ending`。跨行的合成一个 start…stop。
fn apply_volta(r: &LineResult, m: &FanqieMark, measures: &mut [Measure], base: usize, open: &mut Vec<OpenVolta>, conv: &mut Conv) {
    let caption = m.caption.clone().unwrap_or_else(|| "1".into());
    let stop_type = if m.open_end == Some(true) { EndingType::Discontinue } else { EndingType::Stop };
    let to_next = m.continuation_to_next == Some(true);

    // 同一处起两个房号（解析器留下的不收口房号与新房号重叠）时各占一条左线，不互相覆盖
    let put_start = |measures: &mut [Measure], mi: usize, ending: Ending, conv: &mut Conv| -> EndRef {
        let bars = measures[mi].barlines.get_or_insert_with(Vec::new);
        let oid = conv.next_bar_oid();
        match bars.iter().position(|b| b.location == BarLocation::Left) {
            Some(p) if bars[p].ending.is_none() => {
                bars[p].ending = Some(ending);
                // 已借过 oid 的不换（同一条线不会两次挂起点：挂了 ending 就不再进这一支）
                bars[p].oid = oid;
            }
            Some(_) => {
                let mut b = Barline::at(BarLocation::Left);
                b.ending = Some(ending);
                b.oid = oid;
                bars.push(b);
            }
            None => {
                let mut b = Barline::at(BarLocation::Left);
                b.ending = Some(ending);
                b.oid = oid;
                bars.insert(0, b);
            }
        }
        EndRef { measure: mi, bar: oid }
    };
    let make_start = |cap: &str, level: f64| -> Ending {
        let ns: Vec<f64> = cap
            .split(['.', ','])
            .map(|x| js::number(js::trim(x)))
            .filter(|x| x.is_finite() && *x > 0.0)
            .collect();
        let mut e = Ending::new(if ns.is_empty() { vec![1.0] } else { ns }, EndingType::Start, Some(cap.into()));
        if m.caption.is_none() {
            e.captionless = Some(true);
        }
        if level != 0.0 {
            e.level = Some(level);
        }
        e
    };

    let mut start: Option<EndRef> = None;
    if m.continuation_from_previous == Some(true) && !open.is_empty() {
        let head = open.remove(0);
        if let Some(s) = head.start {
            start = Some(s);
            ending_mut(measures, s).continuation_levels.get_or_insert_with(Vec::new).push(m.level);
        } else if let Some(lead) = head.lead {
            let ph = lead.placeholder;
            let bars = measures[ph.measure].barlines.get_or_insert_with(Vec::new);
            bars.retain(|b| b.oid != ph.bar);
            if bars.is_empty() {
                measures[ph.measure].barlines = None;
            }
            // 上一行行尾起头的：房号挂到本行首小节，标明上一行有一段空起头
            let Some(k) = nearest_measure(r, m.start as usize, 1) else { return };
            let mut e = make_start(&lead.caption, lead.level);
            e.lead_in_previous_line = Some(true);
            e.continuation_levels = Some(vec![m.level]);
            start = Some(put_start(measures, base + k, e, conv));
        }
    }
    let start = match start {
        Some(s) => s,
        None => {
            let Some(k) = nearest_measure(r, m.start as usize, 1) else {
                if to_next {
                    // 先挂个占位：后面若再没有续行接上，它就是解析器留下的孤段（`Ending.danglingLead`）
                    if measures.len() <= base {
                        return;
                    }
                    let last = measures.len() - 1;
                    let mut e = make_start(&caption, m.level);
                    e.dangling_lead = Some(true);
                    let mut bar = Barline::at(BarLocation::Right);
                    bar.ending = Some(e);
                    let oid = conv.next_bar_oid();
                    bar.oid = oid;
                    measures[last].barlines.get_or_insert_with(Vec::new).push(bar);
                    open.push(OpenVolta { start: None, lead: Some(Lead { caption, level: m.level, placeholder: EndRef { measure: last, bar: oid } }) });
                }
                return;
            };
            let mut e = make_start(&caption, m.level);
            if let Some(first) = measure_edge(r, k, true) {
                if (m.start as usize) != first {
                    e.start_offset = Some(m.start as f64 - first as f64);
                }
            }
            let s = put_start(measures, base + k, e, conv);
            let k_end = if to_next { None } else { nearest_measure(r, m.end as usize, -1) };
            if k_end.is_some_and(|ke| ke < k) {
                ending_mut(measures, s).collapsed = Some(true);
                return;
            }
            s
        }
    };
    if to_next {
        open.push(OpenVolta { start: Some(start), lead: None });
        return;
    }
    let Some(k) = nearest_measure(r, m.end as usize, -1) else { return };
    let se = ending_mut(measures, start);
    let pair = *se.pair.get_or_insert_with(|| (VOLTA_PAIR.fetch_add(1, Ordering::Relaxed) + 1) as f64);
    let mut ending = Ending::new(se.numbers.clone(), stop_type, Some(se.text.clone().unwrap_or(caption)));
    ending.pair = Some(pair);
    if let Some(last) = measure_edge(r, k, false) {
        if (m.end as usize) != last {
            ending.end_offset = Some(m.end as f64 - last as f64);
        }
    }
    let bars = measures[base + k].barlines.get_or_insert_with(Vec::new);
    match bars.iter_mut().find(|b| b.location == BarLocation::Right) {
        Some(right) if right.ending.is_none() => right.ending = Some(ending),
        _ => {
            let mut b = Barline::at(BarLocation::Right);
            b.ending = Some(ending);
            bars.push(b);
        }
    }
}

/// 多声部里的隐藏休止 `8`/`9` 是不是**不占时值的占位**（`Chord.placeholder`）。判据见 TS 同名函数的注释。
fn mark_placeholders(song: &mut Song) {
    if song.parts.len() < 2 {
        return;
    }
    struct Read {
        hidden: Vec<(usize, usize)>,
        counted: f64,
        bare: f64,
    }
    let read: Vec<Read> = song
        .parts
        .iter()
        .map(|part| {
            let mut hidden = vec![];
            let mut counted = 0.0;
            let mut own = 0.0;
            for (mi, m) in part.measures.iter().enumerate() {
                for (ei, el) in m.elements.iter().enumerate() {
                    let Element::Chord(ch) = el else { continue };
                    if ch.grace.is_some() {
                        continue;
                    }
                    counted += ch.duration.divisions;
                    if ch.rest.is_some() && ch.rhythm != Some(true) && ch.print_object == Some(false) {
                        hidden.push((mi, ei));
                        own += ch.duration.divisions / (ch.sustains.as_ref().map_or(0, |s| s.len()) as f64 + 1.0);
                    }
                }
            }
            Read { hidden, counted, bare: counted - own }
        })
        .collect();
    if !read.iter().any(|r| !r.hidden.is_empty()) {
        return;
    }
    let fits = |total: f64| read.iter().filter(|r| r.counted == total || r.bare == total).count();
    let lead = &read[0];
    let total = if fits(lead.bare) > fits(lead.counted) { lead.bare } else { lead.counted };
    for (pi, r) in read.iter().enumerate() {
        if r.counted == total || r.bare != total {
            continue;
        }
        for &(mi, ei) in &r.hidden {
            if let Element::Chord(ch) = &mut song.parts[pi].measures[mi].elements[ei] {
                ch.placeholder = Some(true);
            }
        }
    }
}

fn element_id(el: &Element) -> ElementId {
    match el {
        Element::Chord(c) => c.id,
        Element::Space(s) => s.id,
    }
}

struct PartState {
    voice: f64,
    part: Part,
    carry: Carry,
    voltas: Vec<OpenVolta>,
    cross: CrossState,
}

/// `FanqieDoc` → `ScoreDoc`。一首 `FanqieSong` 对一首 `Song`。
pub fn fanqie_to_score_doc(fanqie: &FanqieDoc) -> ScoreDoc {
    let mut doc = empty_doc(SourceFormat::Fanqie);
    doc.fanqie_dialect = Some(fanqie.dialect.clone());
    doc.source = Some(fanqie.source.clone());
    doc.diagnostics = fanqie.diagnostics.clone();
    let mut conv = Conv { ids: IdGen::new(), key_serial: 0, bar_oid: 0 };

    for ps in &fanqie.songs {
        let mut song = empty_song();
        let meta = &ps.metadata;
        if let Some(t) = meta.titles.first() {
            song.work.title = Some(t.clone());
        }
        song.work.subtitles = meta.titles.iter().skip(1).cloned().collect();
        if let Some(v) = &meta.version {
            song.work.version = Some(v.clone());
        }
        if !meta.authors.is_empty() {
            song.identification = Some(Identification { creators: meta.authors.iter().map(|a| creator_of(a)).collect(), rights: None, software: None });
        }
        if meta.mode.is_some() || meta.tonic.is_some() {
            let mut key = Key::default();
            if let Some(mode) = &meta.mode {
                // `meta.mode` 是谱面原文，语料里常写音乐符号 `♭A`——归一成 ASCII 才能往返幂等；原文另存
                let sp = normalize_spelling(mode);
                if &sp != mode {
                    key.display = Some(mode.clone());
                }
                key.spelling = Some(sp);
            }
            if let Some(t) = meta.tonic.as_ref().filter(|t| t.as_str() != "1") {
                key.tonic_degree = Some(t.clone());
            }
            song.key = Some(key);
        }
        let time_of = |m: &super::ast::Meter| Time { beats: m.numerator, beat_type: m.denominator, symbol: None, parenthesized: Some(m.parenthesized) };
        if let Some(m0) = meta.meters.first() {
            song.time = Some(time_of(m0));
        }
        if meta.meters.len() > 1 {
            song.extra_times = Some(meta.meters[1..].iter().map(time_of).collect());
        }
        if let Some(t) = &meta.time_note {
            song.time_note = Some(t.clone());
        }
        if !meta.tempos.is_empty() {
            song.tempos = Some(meta.tempos.clone());
        }
        if !meta.remarks.is_empty() {
            song.remarks = Some(meta.remarks.clone());
        }
        // **所有七项都要看**：只写了 `TR:` 或只写了 `BL:` 的谱（语料里很常见）也得建起 pageText
        if meta.index_left.is_some()
            || meta.index_right.is_some()
            || !meta.top_left.is_empty()
            || !meta.top_right.is_empty()
            || !meta.bottom_left.is_empty()
            || !meta.bottom_center.is_empty()
            || !meta.bottom_right.is_empty()
        {
            song.page_text = Some(PageText {
                index_left: meta.index_left.clone(),
                index_right: meta.index_right.clone(),
                top_left: meta.top_left.clone(),
                top_right: meta.top_right.clone(),
                bottom_left: meta.bottom_left.clone(),
                bottom_center: meta.bottom_center.clone(),
                bottom_right: meta.bottom_right.clone(),
            });
        }
        let mut raw = vec![];
        for f in &meta.font_sizes {
            raw.push(RawStyle { key: "FontSize".into(), value: f.clone() });
        }
        for g in &meta.margins {
            raw.push(RawStyle { key: "Margin".into(), value: g.clone() });
        }
        for o in &meta.options {
            raw.push(RawStyle { key: o.key.clone(), value: o.value.clone() });
        }
        if !raw.is_empty() {
            song.style = Some(StyleRef { raw: Some(raw), ..Default::default() });
        }

        // 声部：同一声部号在各 VoiceGroup（排版行）里的片段要接起来
        let mut by_voice: Vec<PartState> = vec![];
        let mut marks: Vec<Mark> = vec![];
        let mut system = 0.0;
        for (page_idx, page) in ps.pages.iter().enumerate() {
            for (group_idx, group) in page.groups.iter().enumerate() {
                for (voice_idx, line) in group.voices.iter().enumerate() {
                    let pi = match by_voice.iter().position(|p| p.voice == line.voice) {
                        Some(p) => p,
                        None => {
                            let part = Part { id: format!("P{}", js::num_to_string(line.voice)), name: line.caption.clone(), ..Default::default() };
                            let home = song_fifths(&song);
                            by_voice.push(PartState {
                                voice: line.voice,
                                part,
                                carry: Carry { last: None, home, key: None },
                                voltas: vec![],
                                cross: CrossState::default(),
                            });
                            by_voice.len() - 1
                        }
                    };
                    let pv = &mut by_voice[pi];
                    let base = pv.part.measures.len();
                    let mut r = convert_line(&line.elements, line.voice, &mut conv, base + 1, &mut pv.carry);
                    if r.measures.is_empty() {
                        r.measures.push(Measure { number: (base + 1).to_string(), ..Default::default() });
                    }
                    let mut line_measures = std::mem::take(&mut r.measures);
                    let lyric_lines = attach_lyrics(&mut line_measures, &r.anchors, &line.lyrics);
                    // 行首小节：模型口径「本小节起新系统」，附上行这一级的东西
                    let mut p = Print { new_system: Some(true), system: Some(system), source: Some(line.source), ..Default::default() };
                    if group_idx == 0 && page_idx > 0 {
                        p.new_page = Some(true);
                        if let Some(bs) = page.break_source {
                            let after = pv.part.measures.last().and_then(|m| m.elements.last()).map(element_id);
                            pv.part.break_sources.get_or_insert_with(Vec::new).push(BreakSource { page: true, after, source: bs });
                        }
                    }
                    if voice_idx == 0 && !group.texts.is_empty() {
                        p.texts = Some(group.texts.iter().map(|t| t.text.clone()).collect());
                        p.text_sources = Some(group.texts.iter().map(|t| t.source).collect());
                    }
                    if let Some(c) = &line.caption {
                        p.caption = Some(c.clone());
                    }
                    p.variant = match line.variant.as_deref() {
                        Some("!") => Some(PrintVariant::Bang),
                        Some("-") => Some(PrintVariant::Minus),
                        Some("+") => Some(PrintVariant::Plus),
                        _ => None,
                    };
                    if !lyric_lines.is_empty() {
                        p.lyric_lines = Some(lyric_lines);
                    }
                    line_measures[0].print = Some(p);
                    pv.part.measures.extend(line_measures);
                    convert_marks(&line.marks, &r, &mut marks, &mut pv.cross, &mut pv.part.measures, base, Some(&mut pv.voltas), &mut conv);
                }
                system += 1.0;
            }
        }
        by_voice.sort_by(|a, b| a.voice.partial_cmp(&b.voice).unwrap_or(std::cmp::Ordering::Equal));
        song.parts = by_voice.into_iter().map(|v| v.part).collect();
        // 转调是全曲的：只在某一声部写了 `"k:…"` 的，别的声部同一时刻（共用时间轴的同一格）一起转
        let axis = axis_of_song(&song);
        let mut key_at: BTreeMap<usize, Key> = BTreeMap::new();
        for (pi, part) in song.parts.iter().enumerate() {
            for (i, m) in part.measures.iter().enumerate() {
                let g = axis.slot[pi][i];
                if let Some(k) = m.attrs.as_ref().and_then(|a| a.key.as_ref()) {
                    key_at.entry(g).or_insert_with(|| k.clone());
                }
            }
        }
        // 这一格没有小节的声部（这组没写它）落到它往后第一个小节：缺席时转了调，回来就是新调；
        // 同一小节先后补到几次的取最后那次，声部自己写了的不动
        for (pi, part) in song.parts.iter_mut().enumerate() {
            let own: HashSet<usize> = part.measures.iter().enumerate().filter(|(_, m)| m.attrs.as_ref().is_some_and(|a| a.key.is_some())).map(|(i, _)| i).collect();
            for (&g, k) in &key_at {
                let Some(i) = axis.slot[pi].iter().position(|&s| s >= g) else { continue };
                if own.contains(&i) {
                    continue;
                }
                if let Some(m) = part.measures.get_mut(i) {
                    m.attrs.get_or_insert_with(Default::default).key = Some(k.clone());
                }
            }
        }
        // 文本谱每行行尾都换行：123 写出时最后一行也带 `$`
        for part in &mut song.parts {
            part.end_break = Some(BreakKind::System);
            for (i, m) in part.measures.iter_mut().enumerate() {
                m.number = (i + 1).to_string();
            }
        }
        song.marks = marks;
        // 多连音组内各音的 `timeMod`：与 123 同一份（model/tuplets）。文本谱的组没写数字时 n 个符号占 n−1 个
        for part in &mut song.parts {
            let mut seq: Vec<&mut Element> = part.measures.iter_mut().flat_map(|m| m.elements.iter_mut()).collect();
            apply_tuplet_time_mods(&song.marks, &mut seq, fanqie_tuplet_ratio);
        }
        mark_placeholders(&mut song);
        clear_oids(&mut song);
        doc.songs.push(song);
    }
    doc
}
