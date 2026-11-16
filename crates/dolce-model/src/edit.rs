//! 改模型的编辑动作（同 `src/model/edit.ts`）：`.musicxml` 在谱面上改谱走这里，改完经 `toxml` 整份重写。
//!
//! **纯模型**。每个动作返回改完要选中什么（`ModelEdit`，和弦按 id 给），调用方按「位置」（`ChordPos`）认回新读出的模型。
//! TS 里按对象身份记的（`Set<Measure>`、`Map<Chord, …>`）这里按 (曲, 声部, 小节, 下标) 记。
//!
//! 语义对齐文本格式那一路：唱名按调号换算、八度点不变；删音符就是删，不补休止；增时线 = 多一拍；
//! 小节线 = 把这一小节在光标处劈成两节（所有声部一起劈）。

use crate::doc::*;
use crate::jianpu::{degree_from_pitch, pitch_from_degree};
use crate::xmlsurface::Surface;
use dolce_base::{js, Msg};
use std::collections::{HashMap, HashSet};

// ───────────────────────── 定位 ─────────────────────────

/// 和弦的位置：第几首、第几声部、第几小节、`measure.elements` 里第几个
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ChordLoc {
    pub si: usize,
    pub pi: usize,
    pub mi: usize,
    pub index: usize,
}

impl ChordLoc {
    pub fn song<'a>(&self, doc: &'a ScoreDoc) -> &'a Song {
        &doc.songs[self.si]
    }
    pub fn part<'a>(&self, doc: &'a ScoreDoc) -> &'a Part {
        &doc.songs[self.si].parts[self.pi]
    }
    pub fn measure<'a>(&self, doc: &'a ScoreDoc) -> &'a Measure {
        &doc.songs[self.si].parts[self.pi].measures[self.mi]
    }
    pub fn measure_mut<'a>(&self, doc: &'a mut ScoreDoc) -> &'a mut Measure {
        &mut doc.songs[self.si].parts[self.pi].measures[self.mi]
    }
    pub fn chord<'a>(&self, doc: &'a ScoreDoc) -> &'a Chord {
        match &self.measure(doc).elements[self.index] {
            Element::Chord(c) => c,
            _ => unreachable!("ChordLoc 指着和弦"),
        }
    }
    pub fn chord_mut<'a>(&self, doc: &'a mut ScoreDoc) -> &'a mut Chord {
        match &mut self.measure_mut(doc).elements[self.index] {
            Element::Chord(c) => c,
            _ => unreachable!("ChordLoc 指着和弦"),
        }
    }
    fn mkey(&self) -> (usize, usize, usize) {
        (self.si, self.pi, self.mi)
    }
}

pub fn locate(doc: &ScoreDoc, id: ElementId) -> Option<ChordLoc> {
    for (si, song) in doc.songs.iter().enumerate() {
        for (pi, part) in song.parts.iter().enumerate() {
            for (mi, measure) in part.measures.iter().enumerate() {
                // `findIndex` 找第一个同 id 的元素，是和弦才算
                if let Some(index) = measure.elements.iter().position(|e| e.id() == id) {
                    if matches!(measure.elements[index], Element::Chord(_)) {
                        return Some(ChordLoc { si, pi, mi, index });
                    }
                }
            }
        }
    }
    None
}

/// 某小节处生效的调号、拍号与每四分音符的 divisions。
#[derive(Clone, Debug)]
pub struct MeasureCtx {
    pub key: Key,
    pub time: Option<Time>,
    pub dpq: f64,
}

fn fifths_key(fifths: f64) -> Key {
    Key { fifths, mode: None, spelling: None, tonic_degree: None, display: None, explicit_accidentals: None, cancel: None }
}

pub fn measure_ctx(song: &Song, part: &Part, mi: usize) -> MeasureCtx {
    let mut key = song.key.clone().unwrap_or_else(|| fifths_key(0.0));
    let mut time = song.time.clone();
    let mut dpq = SIMPLE_DIVISIONS;
    for m in part.measures.iter().take(mi + 1) {
        if let Some(a) = &m.attrs {
            if let Some(k) = &a.key {
                key = k.clone();
            }
            if let Some(t) = &a.time {
                time = Some(t.clone());
            }
            if let Some(d) = a.divisions.filter(|d| *d != 0.0 && !d.is_nan()) {
                dpq = d;
            }
        }
    }
    MeasureCtx { key, time, dpq }
}

fn ctx_of(doc: &ScoreDoc, l: &ChordLoc) -> MeasureCtx {
    measure_ctx(l.song(doc), l.part(doc), l.mi)
}

/// 一个和弦的「位置」：重写再读回之后元素 id 会重编，按位置认回来。`ord` 是它在本小节本声线里是第几个和弦。
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ChordPos {
    pub si: usize,
    pub pi: usize,
    pub mi: usize,
    pub voice: f64,
    pub ord: usize,
}

pub fn pos_of(doc: &ScoreDoc, id: ElementId) -> Option<ChordPos> {
    let l = locate(doc, id)?;
    let voice = l.chord(doc).voice;
    let ord =
        l.measure(doc).elements.iter().take(l.index).filter(|e| matches!(e, Element::Chord(c) if c.voice == voice)).count();
    Some(ChordPos { si: l.si, pi: l.pi, mi: l.mi, voice, ord })
}

pub fn chord_at_pos(doc: &ScoreDoc, p: &ChordPos) -> Option<ElementId> {
    let m = doc.songs.get(p.si)?.parts.get(p.pi)?.measures.get(p.mi)?;
    m.elements.iter().filter_map(|e| e.as_chord()).filter(|c| c.voice == p.voice).nth(p.ord).map(|c| c.id)
}

// ───────────────────────── 结果 ─────────────────────────

/// 改完要选中的：一串和弦（编辑模式）或某个和弦前 / 后的插入光标。
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelEdit {
    Select(Vec<ElementId>),
    CaretAfter(ElementId),
    CaretBefore(ElementId),
    Error(Msg),
    /// 挪了记号：选中这些，并告诉调用方挪到了哪（同 TS `ModelEdit & { moved }`）
    Moved { select: Vec<ElementId>, moved: MovedMark },
}

fn err(key: &str) -> ModelEdit {
    ModelEdit::Error(Msg::new(key))
}

/// 动作改了模型之后要作废的表层（`xmlsurface`）
pub trait EditHooks {
    /// 音高变了：原文里这个和弦的符干方向、纵坐标作废
    fn forget_stem(&mut self, _ch: &Chord) {}
    /// 小节的内容变了：整曲的版面坐标作废
    fn forget_layout(&mut self, _song: &Song) {}
}

/// 不挂表层
pub struct NoHooks;
impl EditHooks for NoHooks {}

impl EditHooks for Surface {
    fn forget_stem(&mut self, ch: &Chord) {
        self.forget_note_layout(ch);
    }
    fn forget_layout(&mut self, song: &Song) {
        self.drop_embedded_layout(song);
    }
}

// ───────────────────────── 音高 ─────────────────────────

const STEPS: [Step; 7] = [Step::C, Step::D, Step::E, Step::F, Step::G, Step::A, Step::B];
const SHARP_ORDER: [&str; 7] = ["F", "C", "G", "D", "A", "E", "B"];

fn step_semi(s: &Step) -> f64 {
    match s.as_str() {
        "C" => 0.0,
        "D" => 2.0,
        "E" => 4.0,
        "F" => 5.0,
        "G" => 7.0,
        "A" => 9.0,
        "B" => 11.0,
        _ => f64::NAN,
    }
}

/// 调号里这个音名本来带的升降（`K:F` 的 B 为 -1）。
pub fn key_alter(step: &str, fifths: f64) -> f64 {
    let fwd = SHARP_ORDER.iter().position(|s| *s == step).map_or(-1.0, |i| i as f64);
    let rev = SHARP_ORDER.iter().rev().position(|s| *s == step).map_or(-1.0, |i| i as f64);
    if fifths > 0.0 {
        return if fwd < fifths { 1.0 } else { 0.0 };
    }
    if fifths < 0.0 {
        return if rev < -fifths { -1.0 } else { 0.0 };
    }
    0.0
}

pub fn midi_of_pitch(p: &Pitch) -> f64 {
    (p.octave + 1.0) * 12.0 + step_semi(&p.step) + p.alter
}

const C0: Pitch = Pitch { step: Step::C, alter: 0.0, octave: 0.0 };

/// 把音高挪到离 `near` 最近的那个八度。
fn nearest_octave(p: &Pitch, near: f64) -> Pitch {
    let mut best = p.clone();
    let mut bd = f64::INFINITY;
    for o in 0..=8 {
        let q = Pitch { octave: o as f64, ..p.clone() };
        let d = (midi_of_pitch(&q) - near).abs();
        if d < bd {
            bd = d;
            best = q;
        }
    }
    best
}

/// 同一声部里插入点之前最近的一个有音高的音（没有就往后找），给新音定八度。
fn neighbour_midi(part: &Part, mi: usize, index: usize, voice: f64) -> f64 {
    let mut flat: Vec<&Chord> = vec![];
    let mut at = 0;
    for (i, m) in part.measures.iter().enumerate() {
        for (j, e) in m.elements.iter().enumerate() {
            let Element::Chord(c) = e else { continue };
            if c.voice != voice {
                continue;
            }
            if i < mi || (i == mi && j < index) {
                at = flat.len() + 1;
            }
            flat.push(c);
        }
    }
    let hit = |c: &Chord| c.notes.first().and_then(|n| n.pitch.as_ref()).map(midi_of_pitch);
    for k in (0..at).rev() {
        if let Some(v) = hit(flat[k]) {
            return v;
        }
    }
    for c in flat.iter().skip(at) {
        if let Some(v) = hit(c) {
            return v;
        }
    }
    67.0 // G4：高音谱号中间
}

fn accidental_for(alter: f64) -> Accidental {
    if alter == -2.0 {
        Accidental::DoubleFlat
    } else if alter == -1.0 {
        Accidental::Flat
    } else if alter == 0.0 {
        Accidental::Natural
    } else if alter == 1.0 {
        Accidental::Sharp
    } else {
        Accidental::DoubleSharp
    }
}

/// 重算一小节里临时记号的**印法**：同一谱表、同一音名同一八度，按时间先后，与当前生效的升降一致就不印、不一致就印。
pub fn respell_measure(measure: &mut Measure, key: &Key) {
    let mut items: Vec<(f64, usize, usize, f64)> = vec![]; // (起点, 元素下标, 音下标, 谱表)
    let mut voice_at: Vec<(f64, f64)> = vec![];
    for (order, el) in measure.elements.iter().enumerate() {
        let Element::Chord(c) = el else { continue };
        let start = c.onset.or_else(|| voice_at.iter().find(|(v, _)| *v == c.voice).map(|(_, p)| *p)).unwrap_or(0.0);
        let end = start + if c.grace.is_some() { 0.0 } else { c.duration.divisions };
        match voice_at.iter_mut().find(|(v, _)| *v == c.voice) {
            Some(e) => e.1 = end,
            None => voice_at.push((c.voice, end)),
        }
        for (ni, n) in c.notes.iter().enumerate() {
            if n.pitch.is_some() {
                items.push((start, order, ni, c.staff));
            }
        }
    }
    js::sort_by(&mut items, |a, b| {
        let d = a.0 - b.0;
        if d != 0.0 && !d.is_nan() {
            d
        } else {
            a.1 as f64 - b.1 as f64
        }
    });
    let mut state: HashMap<String, f64> = HashMap::new();
    for (_, ei, ni, staff) in items {
        let Element::Chord(c) = &mut measure.elements[ei] else { continue };
        let n = &mut c.notes[ni];
        let p = n.pitch.as_ref().unwrap();
        let k = format!("{}:{}:{}", js::num_to_string(staff), p.step.as_str(), js::num_to_string(p.octave));
        let cur = *state.get(&k).unwrap_or(&key_alter(p.step.as_str(), key.fifths));
        let alter = p.alter;
        n.accidental = if alter == cur { None } else { Some(accidental_for(alter)) };
        state.insert(k, alter);
    }
}

/// 唱名 → 音高：八度点照 `octave_shift`，升降照 `acc`（相对调号）。
fn pitch_of_degree(number: f64, octave_shift: f64, key: &Key, acc: Option<Accidental>) -> Option<Pitch> {
    pitch_from_degree(&Degree { number, octave_shift, accidental: acc }, key)
}

// ───────────────────────── 时值 ─────────────────────────

const TYPES: [(NoteType, f64); 7] = [
    (NoteType::Whole, 4.0),
    (NoteType::Half, 2.0),
    (NoteType::Quarter, 1.0),
    (NoteType::Eighth, 0.5),
    (NoteType::N16th, 0.25),
    (NoteType::N32nd, 0.125),
    (NoteType::N64th, 0.0625),
];

/// divisions → 符号时值（带至多两个附点）；写不出为 None。
pub fn type_of_divisions(div: f64, dpq: f64) -> Option<(NoteType, f64)> {
    let q = div / dpq;
    for (t, base) in TYPES.iter() {
        for dots in 0..=2 {
            let len = base * (2.0 - 0.5f64.powi(dots));
            if (len - q).abs() < 1e-9 {
                return Some((t.clone(), dots as f64));
            }
        }
    }
    None
}

fn scale_hx(offset: &mut Option<f64>, onset: &mut Option<f64>, k: f64) {
    if let Some(o) = offset {
        *o *= k;
    }
    if let Some(o) = onset {
        *o *= k;
    }
}

/// 整个声部的时值单位放大 `k` 倍。
pub fn scale_part_divisions(part: &mut Part, k: f64) {
    let truthy = |x: Option<f64>| x.is_some_and(|d| d != 0.0 && !d.is_nan());
    for m in &mut part.measures {
        if let Some(a) = &mut m.attrs {
            if truthy(a.divisions) {
                a.divisions = a.divisions.map(|d| d * k);
            }
        }
        for la in m.later_attrs.iter_mut().flatten() {
            if let Some(o) = &mut la.onset {
                *o *= k;
            }
            if truthy(la.attrs.divisions) {
                la.attrs.divisions = la.attrs.divisions.map(|d| d * k);
            }
        }
        if let Some(d) = &mut m.duration {
            *d *= k;
        }
        for d in m.directions.iter_mut().flatten() {
            scale_hx(&mut d.offset, &mut d.onset, k);
        }
        for el in &mut m.elements {
            match el {
                Element::Chord(c) => {
                    c.duration.divisions *= k;
                    if let Some(o) = &mut c.onset {
                        *o *= k;
                    }
                    if let Some(h) = &mut c.harmony {
                        scale_hx(&mut h.offset, &mut h.onset, k);
                    }
                    for h in c.later_harmonies.iter_mut().flatten() {
                        scale_hx(&mut h.offset, &mut h.onset, k);
                    }
                }
                Element::Space(s) => {
                    if let Some(d) = &mut s.duration {
                        d.divisions *= k;
                    }
                    if let Some(o) = &mut s.onset {
                        *o *= k;
                    }
                    if let Some(h) = &mut s.harmony {
                        scale_hx(&mut h.offset, &mut h.onset, k);
                    }
                }
            }
        }
    }
}

fn is_integer(x: f64) -> bool {
    x.is_finite() && x.trunc() == x
}

/// `want` 不是整数时，把声部单位放大到够用的最小倍数，返回放大后的值。
fn fit_divisions(part: &mut Part, want: f64) -> f64 {
    if is_integer(want) {
        return want;
    }
    for k in [2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 16.0, 24.0, 32.0] {
        if is_integer(js::round(want * k * 1e6) / 1e6) {
            scale_part_divisions(part, k);
            return js::round(want * k);
        }
    }
    want
}

/// 按新的 divisions 改时值（连音不改）。
fn set_divisions(ch: &mut Chord, div: f64, dpq: f64) -> Option<Msg> {
    if ch.duration.time_mod.is_some() {
        return Some(Msg::new("me.tupletDur"));
    }
    if !is_integer(div) || div <= 0.0 {
        return Some(Msg::new("me.divCoarse"));
    }
    let Some((t, dots)) = type_of_divisions(div, dpq) else { return Some(Msg::new("me.durInvalid")) };
    ch.duration.divisions = div;
    ch.duration.kind = Some(t);
    ch.duration.dots = dots;
    None
}

fn beam_level(t: Option<&NoteType>) -> f64 {
    match t.map_or("quarter", |t| t.as_str()) {
        "eighth" => 1.0,
        "16th" => 2.0,
        "32nd" => 3.0,
        "64th" => 4.0,
        "128th" => 5.0,
        _ => 0.0,
    }
}

/// 重排一小节一个声线的符杠：同一拍里连着的八分及更短的音连成一组（复拍子三个八分一组），休止断开。
pub fn rebeam(measure: &mut Measure, voice: f64, time: Option<&Time>, dpq: f64) {
    let group = if time.is_some_and(|t| t.beat_type == 8.0 && t.beats % 3.0 == 0.0) { dpq * 1.5 } else { dpq };
    // (元素下标, 起点, 层数)
    let mut chords: Vec<(usize, f64, f64)> = vec![];
    let mut at = 0.0;
    for (i, el) in measure.elements.iter().enumerate() {
        let Element::Chord(c) = el else { continue };
        if c.voice != voice {
            continue;
        }
        if let Some(o) = c.onset {
            at = o;
        }
        if c.grace.is_some() {
            continue;
        }
        let lv = if c.rest.is_some() || c.duration.time_mod.is_some() { 0.0 } else { beam_level(c.duration.kind.as_ref()) };
        chords.push((i, at, lv));
        at += c.duration.divisions;
    }
    fn ch(m: &mut Measure, i: usize) -> &mut Chord {
        match &mut m.elements[i] {
            Element::Chord(c) => c,
            _ => unreachable!(),
        }
    }
    let mut i = 0;
    while i < chords.len() {
        let g = (chords[i].1 / group).floor();
        let mut j = i;
        while j < chords.len() && chords[j].2 > 0.0 && (chords[j].1 / group).floor() == g {
            j += 1;
        }
        if j == i {
            let c = ch(measure, chords[i].0);
            if c.duration.time_mod.is_none() {
                c.beams = None;
            }
            i += 1;
            continue;
        }
        let run = &chords[i..j];
        if run.len() < 2 {
            ch(measure, run[0].0).beams = None;
        } else {
            for (k, c) in run.iter().enumerate() {
                let mut beams = vec![];
                let mut level = 1.0;
                while level <= c.2 {
                    let prev = k > 0 && run[k - 1].2 >= level;
                    let next = k + 1 < run.len() && run[k + 1].2 >= level;
                    beams.push(if prev && next {
                        BeamVal::Continue
                    } else if prev {
                        BeamVal::End
                    } else if next {
                        BeamVal::Begin
                    } else if k == 0 {
                        BeamVal::ForwardHook
                    } else {
                        BeamVal::BackwardHook
                    });
                    level += 1.0;
                }
                ch(measure, c.0).beams = Some(beams);
            }
        }
        i = j;
    }
}

// ───────────────────────── 动作 ─────────────────────────

fn chords_of(doc: &ScoreDoc, ids: &[ElementId]) -> Vec<ChordLoc> {
    ids.iter().filter_map(|&id| locate(doc, id)).collect()
}

fn ids_of(doc: &ScoreDoc, locs: &[ChordLoc]) -> Vec<ElementId> {
    locs.iter().map(|l| l.chord(doc).id).collect()
}

/// 改完音高的小节：临时记号重算印法，原文的符干方向作废。
fn touched(doc: &mut ScoreDoc, locs: &[ChordLoc], hooks: &mut dyn EditHooks) {
    let mut seen: HashSet<(usize, usize, usize)> = HashSet::new();
    for l in locs {
        hooks.forget_stem(l.chord(doc));
        if !seen.insert(l.mkey()) {
            continue;
        }
        let key = ctx_of(doc, l).key;
        respell_measure(l.measure_mut(doc), &key);
    }
}

/// 不同的曲（按首次出现的次序）
fn songs_of(locs: &[ChordLoc]) -> Vec<usize> {
    let mut v: Vec<usize> = vec![];
    for l in locs {
        if !v.contains(&l.si) {
            v.push(l.si);
        }
    }
    v
}

/// 改唱名（`0` = 改成休止）：八度点不变；休止改成音时八度取离前一个音最近的。
pub fn set_degree(doc: &mut ScoreDoc, ids: &[ElementId], degree: f64, hooks: &mut dyn EditHooks) -> ModelEdit {
    let locs: Vec<ChordLoc> = chords_of(doc, ids).into_iter().filter(|l| l.chord(doc).grace.is_none()).collect();
    if locs.is_empty() {
        return err("ve.selectNote");
    }
    for l in &locs {
        let key = ctx_of(doc, l).key;
        if degree == 0.0 {
            let ch = l.chord_mut(doc);
            ch.notes = vec![];
            ch.rest = Some(RestInfo::default());
            continue;
        }
        let old = l.chord(doc).notes.first().and_then(|n| n.pitch.clone());
        let shift = old.as_ref().map_or(0.0, |o| degree_from_pitch(o, &key, None).octave_shift);
        let Some(mut p) = pitch_of_degree(degree, shift, &key, None) else { continue };
        if old.is_none() {
            let near = neighbour_midi(l.part(doc), l.mi, l.index, l.chord(doc).voice);
            p = nearest_octave(&p, near);
        }
        let ch = l.chord_mut(doc);
        ch.rest = None;
        // 和弦只改最上面那个音；单音就是它
        if ch.notes.is_empty() {
            ch.notes = vec![Note { pitch: Some(p), ..Default::default() }];
        } else {
            let m = |n: &Note| midi_of_pitch(n.pitch.as_ref().unwrap_or(&C0));
            let mut top = 0;
            for k in 1..ch.notes.len() {
                if m(&ch.notes[k]) > m(&ch.notes[top]) {
                    top = k;
                }
            }
            ch.notes[top].pitch = Some(p);
        }
    }
    touched(doc, &locs, hooks);
    ModelEdit::Select(ids_of(doc, &locs))
}

/// 升降八度：和弦里每个音一起挪。
pub fn shift_octave(doc: &mut ScoreDoc, ids: &[ElementId], delta: f64, hooks: &mut dyn EditHooks) -> ModelEdit {
    let locs = chords_of(doc, ids);
    let pitched: Vec<ChordLoc> = locs.iter().copied().filter(|l| l.chord(doc).notes.iter().any(|n| n.pitch.is_some())).collect();
    if pitched.is_empty() {
        return err("me.restOctave");
    }
    for l in &pitched {
        for n in &mut l.chord_mut(doc).notes {
            if let Some(p) = &mut n.pitch {
                p.octave += delta;
            }
        }
    }
    touched(doc, &pitched, hooks);
    ModelEdit::Select(ids_of(doc, &locs))
}

/// 升号 / 降号 / 还原号（相对调号）：已经是这样就取消。
pub fn toggle_accidental(doc: &mut ScoreDoc, ids: &[ElementId], acc: &str, hooks: &mut dyn EditHooks) -> ModelEdit {
    let locs: Vec<ChordLoc> = chords_of(doc, ids).into_iter().filter(|l| l.chord(doc).notes.iter().any(|n| n.pitch.is_some())).collect();
    if locs.is_empty() {
        return err("ve.selectNote");
    }
    for l in &locs {
        let key = ctx_of(doc, l).key;
        for n in &mut l.chord_mut(doc).notes {
            let Some(p) = &mut n.pitch else { continue };
            let base = key_alter(p.step.as_str(), key.fifths);
            let want = match acc {
                "sharp" => base + 1.0,
                "flat" => base - 1.0,
                _ => 0.0,
            };
            let on = if acc == "natural" { p.alter == 0.0 && base != 0.0 } else { p.alter == want };
            p.alter = if on { base } else { want };
        }
    }
    touched(doc, &locs, hooks);
    ModelEdit::Select(ids_of(doc, &locs))
}

/// 改时值的公用一步：改完这一小节这个声线的符杠重排、整曲版面坐标作废。
fn retime(doc: &mut ScoreDoc, ids: &[ElementId], f: impl Fn(&Chord, f64) -> f64, hooks: &mut dyn EditHooks) -> ModelEdit {
    let locs: Vec<ChordLoc> = chords_of(doc, ids).into_iter().filter(|l| l.chord(doc).grace.is_none()).collect();
    if locs.is_empty() {
        return err("ve.selectNote");
    }
    for l in &locs {
        let want = f(l.chord(doc), ctx_of(doc, l).dpq);
        let div = fit_divisions(&mut doc.songs[l.si].parts[l.pi], want);
        let dpq = ctx_of(doc, l).dpq;
        if let Some(e) = set_divisions(l.chord_mut(doc), div, dpq) {
            return ModelEdit::Error(e);
        }
    }
    let mut seen: HashSet<(usize, usize, usize, js::NumKey)> = HashSet::new();
    for l in &locs {
        let voice = l.chord(doc).voice;
        if !seen.insert((l.si, l.pi, l.mi, js::NumKey::new(voice))) {
            continue;
        }
        let MeasureCtx { time, dpq, .. } = ctx_of(doc, l);
        let m = l.measure_mut(doc);
        rebeam(m, voice, time.as_ref(), dpq);
        m.duration = None;
    }
    for si in songs_of(&locs) {
        hooks.forget_layout(&doc.songs[si]);
    }
    ModelEdit::Select(ids_of(doc, &locs))
}

fn dot_factor(dots: f64) -> f64 {
    2.0 - 0.5f64.powf(dots)
}

/// 附点：加一个或去掉（去掉时全部去掉）。
pub fn toggle_dot(doc: &mut ScoreDoc, ids: &[ElementId], hooks: &mut dyn EditHooks) -> ModelEdit {
    retime(
        doc,
        ids,
        |ch, _| {
            let base = ch.duration.divisions / dot_factor(ch.duration.dots);
            if ch.duration.dots != 0.0 && !ch.duration.dots.is_nan() {
                base
            } else {
                base * 1.5
            }
        },
        hooks,
    )
}

/// 时值减半 / 加倍（附点照留）。
pub fn scale_duration(doc: &mut ScoreDoc, ids: &[ElementId], factor: f64, hooks: &mut dyn EditHooks) -> ModelEdit {
    retime(doc, ids, |ch, _| ch.duration.divisions * factor, hooks)
}

/// 增时线：多一拍（一个四分音符）。
pub fn add_beat(doc: &mut ScoreDoc, id: ElementId, hooks: &mut dyn EditHooks) -> ModelEdit {
    retime(doc, &[id], |ch, dpq| ch.duration.divisions + dpq, hooks)
}

/// 插入位置：某个和弦之后，或某小节开头（声部、声线照给的）。
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InsertAnchor {
    After(ElementId),
    MeasureStart { si: usize, pi: usize, mi: usize, voice: f64 },
}

/// 某声线落在哪条谱表（取它第一个音的；整个声部都没有它为 1）。
pub fn staff_of_voice(part: &Part, voice: f64) -> f64 {
    for m in &part.measures {
        for e in &m.elements {
            if let Element::Chord(c) = e {
                if c.voice == voice {
                    return c.staff;
                }
            }
        }
    }
    1.0
}

/// 谱表内的「第 k 声线」在这个声部里的 voice 号。
pub fn staff_voice(part: &Part, staff: f64, k: usize) -> f64 {
    let mut mine: Vec<f64> = vec![];
    let mut others: Vec<f64> = vec![];
    for m in &part.measures {
        for e in &m.elements {
            if let Element::Chord(c) = e {
                let set = if c.staff == staff { &mut mine } else { &mut others };
                if !set.contains(&c.voice) {
                    set.push(c.voice);
                }
            }
        }
    }
    let mut used = mine.clone();
    js::sort_num(&mut used);
    if k >= 1 && k <= used.len() {
        return used[k - 1];
    }
    let mut v = used.first().copied().unwrap_or((staff - 1.0) * 4.0 + 1.0) + k as f64 - 1.0;
    while mine.contains(&v) || others.contains(&v) {
        v += 1.0;
    }
    v
}

/// 新音符的时值：相对四分音符的减半次数与附点。
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct NewDuration {
    pub halvings: f64,
    pub dots: f64,
}

fn next_id(doc: &ScoreDoc) -> ElementId {
    let mut max = 0;
    for s in &doc.songs {
        max = max.max(crate::helpers::max_top_element_id(s));
    }
    max + 1
}

/// 元素增删之后，按「排在第几个元素之后」记位置的东西跟着挪。
fn remap_after(m: &mut Measure, map: impl Fn(f64) -> f64) {
    for d in m.directions.iter_mut().flatten() {
        if let Some(a) = &mut d.after_elements {
            *a = map(*a);
        }
    }
    for a in m.later_attrs.iter_mut().flatten() {
        a.after_elements = map(a.after_elements);
    }
    for b in m.barlines.iter_mut().flatten() {
        if let Some(a) = &mut b.after_elements {
            *a = map(*a);
        }
    }
}

/// 在第 `index` 个元素前插了一个：挂在它及以后的往后挪（小节开头的不动）
fn shift_for_insert(m: &mut Measure, index: usize) {
    let index = index as f64;
    remap_after(m, |a| if a > index || (a == index && index > 0.0) { a + 1.0 } else { a });
}

fn new_chord(id: ElementId, voice: f64, staff: f64) -> Chord {
    Chord { id, duration: Duration { divisions: 0.0, dots: 0.0, ..Default::default() }, voice, staff, ..Default::default() }
}

/// 在锚点处插入一个音（`degree` 0 = 休止）。
pub fn insert_chord(doc: &mut ScoreDoc, anchor: &InsertAnchor, degree: f64, dur: NewDuration, hooks: &mut dyn EditHooks) -> ModelEdit {
    let (si, pi, mi, index, voice, staff) = match anchor {
        InsertAnchor::After(id) => {
            let Some(l) = locate(doc, *id) else { return err("me.noInsertPos") };
            let c = l.chord(doc);
            (l.si, l.pi, l.mi, l.index + 1, c.voice, c.staff)
        }
        InsertAnchor::MeasureStart { si, pi, mi, voice } => {
            let Some(p) = doc.songs.get(*si).and_then(|s| s.parts.get(*pi)) else { return err("me.noInsertPos") };
            let Some(m) = p.measures.get(*mi) else { return err("me.noInsertPos") };
            let first = m.elements.iter().position(|e| e.voice() == *voice);
            let index = first.unwrap_or(m.elements.len());
            // 这一小节里本声线还没有音：谱表照它在别的小节落的那条
            let staff = match first {
                Some(f) => m.elements[f].staff(),
                None => staff_of_voice(p, *voice),
            };
            (*si, *pi, *mi, index, *voice, staff)
        }
    };
    let dpq0 = measure_ctx(&doc.songs[si], &doc.songs[si].parts[pi], mi).dpq;
    let div = fit_divisions(&mut doc.songs[si].parts[pi], (dpq0 / 2f64.powf(dur.halvings)) * dot_factor(dur.dots));
    let MeasureCtx { key, time, dpq } = measure_ctx(&doc.songs[si], &doc.songs[si].parts[pi], mi);
    let mut ch = new_chord(next_id(doc), voice, staff);
    if let Some(e) = set_divisions(&mut ch, div, dpq) {
        return ModelEdit::Error(e);
    }
    if degree == 0.0 {
        ch.rest = Some(RestInfo::default());
    } else {
        let Some(p) = pitch_of_degree(degree, 0.0, &key, None) else { return err("me.degree07") };
        let near = neighbour_midi(&doc.songs[si].parts[pi], mi, index, voice);
        ch.notes = vec![Note { pitch: Some(nearest_octave(&p, near)), ..Default::default() }];
    }
    let measure = &mut doc.songs[si].parts[pi].measures[mi];
    // 插在别的声线开头（带 onset）的前面时，新音接的是本声线前一个音的终点；首个元素要给它显式的起点
    if let Some(Element::Chord(f)) = measure.elements.get_mut(index) {
        if f.voice == voice && f.onset.is_some() {
            ch.onset = f.onset.take();
        }
    }
    let id = ch.id;
    measure.elements.insert(index, Element::Chord(ch));
    shift_for_insert(measure, index);
    measure.duration = None;
    rebeam(measure, voice, time.as_ref(), dpq);
    respell_measure(measure, &key);
    hooks.forget_layout(&doc.songs[si]);
    ModelEdit::CaretAfter(id)
}

/// 删掉一些和弦：连带删掉以它们为端点的弧、连音线与延音线（对面那个音的 `tie` 也清掉）。
pub fn delete_chords(doc: &mut ScoreDoc, ids: &[ElementId], hooks: &mut dyn EditHooks) -> ModelEdit {
    let locs = chords_of(doc, ids);
    if locs.is_empty() {
        return err("me.nothingToDelete");
    }
    let gone: HashSet<ElementId> = locs.iter().map(|l| l.chord(doc).id).collect();
    for si in songs_of(&locs) {
        let marks = std::mem::take(&mut doc.songs[si].marks);
        let mut keep: Vec<Mark> = vec![];
        for mk in marks {
            if !gone.contains(&mk.start) && !gone.contains(&mk.end) {
                keep.push(mk);
                continue;
            }
            if mk.kind == MarkType::Tied {
                let start_gone = gone.contains(&mk.start);
                if let Some(o) = locate(doc, if start_gone { mk.end } else { mk.start }) {
                    for n in &mut o.chord_mut(doc).notes {
                        if let Some(t) = &mut n.tie {
                            if start_gone {
                                t.stop = None;
                            } else {
                                t.start = None;
                            }
                        }
                    }
                }
            }
        }
        doc.songs[si].marks = keep;
    }
    // 删之前记下光标该落在谁后面：第一个被删的前面那个同声线的音
    let first = locs[0];
    let first_voice = first.chord(doc).voice;
    let before = first.measure(doc).elements[..first.index]
        .iter()
        .rev()
        .find_map(|e| e.as_chord().filter(|c| c.voice == first_voice && !gone.contains(&c.id)))
        .map(|c| c.id);
    // 各小节（按首次出现）与它最后一个 loc
    let mut touched_m: Vec<((usize, usize, usize), ChordLoc)> = vec![];
    for l in &locs {
        match touched_m.iter_mut().find(|(k, _)| *k == l.mkey()) {
            Some(e) => e.1 = *l,
            None => touched_m.push((l.mkey(), *l)),
        }
    }
    for (mk, l) in &touched_m {
        let voices: Vec<f64> = {
            let mut v: Vec<f64> = vec![];
            for x in locs.iter().filter(|x| x.mkey() == *mk) {
                let vv = x.chord(doc).voice;
                if !v.contains(&vv) {
                    v.push(vv);
                }
            }
            v
        };
        let MeasureCtx { key, time, dpq } = ctx_of(doc, l);
        let m = l.measure_mut(doc);
        // 被删的音若带着显式起点，交给同声线的下一个
        for i in 0..m.elements.len() {
            let Element::Chord(e) = &m.elements[i] else { continue };
            if !gone.contains(&e.id) || e.onset.is_none() {
                continue;
            }
            let (onset, voice) = (e.onset, e.voice);
            let nxt = (i + 1..m.elements.len()).find(|&j| m.elements[j].voice() == voice && !gone.contains(&m.elements[j].id()));
            if let Some(j) = nxt {
                if let Element::Chord(n) = &mut m.elements[j] {
                    if n.onset.is_none() {
                        n.onset = onset;
                    }
                }
            }
        }
        let removed: Vec<f64> = m.elements.iter().enumerate().filter(|(_, e)| gone.contains(&e.id())).map(|(i, _)| i as f64).collect();
        m.elements.retain(|e| !gone.contains(&e.id()));
        remap_after(m, |a| a - removed.iter().filter(|&&i| i < a).count() as f64);
        m.duration = None;
        for v in voices {
            rebeam(m, v, time.as_ref(), dpq);
        }
        respell_measure(m, &key);
    }
    for si in songs_of(&locs) {
        hooks.forget_layout(&doc.songs[si]);
    }
    if let Some(b) = before {
        return ModelEdit::CaretAfter(b);
    }
    let after = first.measure(doc).elements.iter().find_map(|e| e.as_chord().filter(|c| c.voice == first_voice)).map(|c| c.id);
    match after {
        Some(a) => ModelEdit::CaretBefore(a),
        None => ModelEdit::Select(vec![]),
    }
}

/// 小节里各和弦的起点（divisions，按元素下标）。
fn onsets(m: &Measure) -> HashMap<usize, f64> {
    let mut out = HashMap::new();
    let mut voice_at: Vec<(f64, f64)> = vec![];
    for (i, el) in m.elements.iter().enumerate() {
        let start = match el {
            Element::Chord(c) => c.onset,
            _ => None,
        }
        .or_else(|| voice_at.iter().find(|(v, _)| *v == el.voice()).map(|(_, p)| *p))
        .unwrap_or(0.0);
        let dur = match el {
            Element::Chord(c) => {
                if c.grace.is_some() {
                    0.0
                } else {
                    c.duration.divisions
                }
            }
            Element::Space(s) => s.duration.as_ref().map_or(0.0, |d| d.divisions),
        };
        match voice_at.iter_mut().find(|(v, _)| *v == el.voice()) {
            Some(e) => e.1 = start + dur,
            None => voice_at.push((el.voice(), start + dur)),
        }
        if matches!(el, Element::Chord(_)) {
            out.insert(i, start);
        }
    }
    out
}

/// 音的位置次序变了之后（和弦里加、删、排序）：挂在「第几个音」上的弧与延音线跟着那个音走。
/// `new_from_old[k]` = 新的第 k 个音原来是第几个（新加的音为 None）。
fn renote_marks(song: &mut Song, chord_id: ElementId, new_from_old: &[Option<usize>]) {
    let at = |i: Option<f64>| -> Option<usize> {
        let i = i.unwrap_or(0.0);
        let i = js::index(i)?;
        new_from_old.iter().position(|o| *o == Some(i))
    };
    song.marks.retain_mut(|mk| {
        if mk.start == chord_id {
            match at(mk.start_note) {
                None => return false,
                Some(j) => mk.start_note = if j != 0 { Some(j as f64) } else { None },
            }
        }
        if mk.end == chord_id {
            match at(mk.end_note) {
                None => return false,
                Some(j) => mk.end_note = if j != 0 { Some(j as f64) } else { None },
            }
        }
        true
    });
}

fn note_midi_or0(n: &Note) -> f64 {
    n.pitch.as_ref().map_or(0.0, midi_of_pitch)
}

/// 和弦里加一个音（落在最上面那个音之上）。
pub fn add_chord_note(doc: &mut ScoreDoc, id: ElementId, degree: f64, hooks: &mut dyn EditHooks) -> ModelEdit {
    let Some(l) = locate(doc, id) else { return err("me.selectNoteNoRest") };
    let c = l.chord(doc);
    if c.rest.is_some() || c.notes.is_empty() {
        return err("me.selectNoteNoRest");
    }
    let key = ctx_of(doc, &l).key;
    let top = c.notes.iter().fold(f64::NEG_INFINITY, |a, n| js::max(a, note_midi_or0(n)));
    let Some(p0) = pitch_of_degree(degree, 0.0, &key, None) else { return err("me.degree17") };
    let mut p = nearest_octave(&p0, top + 6.0);
    while midi_of_pitch(&p) <= top {
        p.octave += 1.0;
    }
    let ch = l.chord_mut(doc);
    let n_old = ch.notes.len();
    let mut tagged: Vec<(Option<usize>, Note)> = std::mem::take(&mut ch.notes).into_iter().enumerate().map(|(i, n)| (Some(i), n)).collect();
    tagged.push((None, Note { pitch: Some(p), ..Default::default() }));
    js::sort_by(&mut tagged, |a, b| note_midi_or0(&a.1) - note_midi_or0(&b.1));
    let order: Vec<Option<usize>> = tagged.iter().map(|(o, _)| *o).collect();
    ch.notes = tagged.into_iter().map(|(_, n)| n).collect();
    let _ = n_old;
    renote_marks(&mut doc.songs[l.si], id, &order);
    touched(doc, &[l], hooks);
    ModelEdit::Select(vec![id])
}

/// 选中和弦里的第 `index` 个音（从低到高）单独删掉；只剩一个音时不删。
pub fn remove_chord_note(doc: &mut ScoreDoc, id: ElementId, index: usize, hooks: &mut dyn EditHooks) -> ModelEdit {
    let Some(l) = locate(doc, id) else { return err("me.lastChordNote") };
    if l.chord(doc).notes.len() < 2 {
        return err("me.lastChordNote");
    }
    // `index` 按谱面从低到高数；模型里的次序是原文的
    let mut by_pitch: Vec<usize> = (0..l.chord(doc).notes.len()).collect();
    {
        let notes = &l.chord(doc).notes;
        js::sort_by(&mut by_pitch, |a, b| note_midi_or0(&notes[*a]) - note_midi_or0(&notes[*b]));
    }
    let Some(&gone) = by_pitch.get(index) else { return err("me.noNote") };
    let ch = l.chord_mut(doc);
    let n = ch.notes.len();
    ch.notes.remove(gone);
    let order: Vec<Option<usize>> = (0..n).filter(|&i| i != gone).map(Some).collect();
    renote_marks(&mut doc.songs[l.si], id, &order);
    touched(doc, &[l], hooks);
    ModelEdit::Select(vec![id])
}

/// 声部输入的插入时刻
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
pub struct VoiceAt {
    pub si: usize,
    pub pi: usize,
    pub mi: usize,
    pub onset: f64,
    pub staff: f64,
}

/// 在指定声线的某一时刻插一个音（声部输入）。`shown` 是报错里说的声线号。
pub fn insert_in_voice(
    doc: &mut ScoreDoc,
    at: &VoiceAt,
    voice: f64,
    degree: f64,
    dur: NewDuration,
    hooks: &mut dyn EditHooks,
    shown: f64,
) -> ModelEdit {
    let ok = doc.songs.get(at.si).and_then(|s| s.parts.get(at.pi)).and_then(|p| p.measures.get(at.mi)).is_some();
    if !ok {
        return err("me.noInsertPos");
    }
    let dpq0 = measure_ctx(&doc.songs[at.si], &doc.songs[at.si].parts[at.pi], at.mi).dpq;
    let div = fit_divisions(&mut doc.songs[at.si].parts[at.pi], (dpq0 / 2f64.powf(dur.halvings)) * dot_factor(dur.dots));
    let MeasureCtx { key, time, dpq: scale } = measure_ctx(&doc.songs[at.si], &doc.songs[at.si].parts[at.pi], at.mi);
    let onset = (at.onset * scale) / dpq0;
    let mut ch = new_chord(next_id(doc), voice, at.staff);
    if let Some(e) = set_divisions(&mut ch, div, scale) {
        return ModelEdit::Error(e);
    }
    if degree == 0.0 {
        ch.rest = Some(RestInfo::default());
    } else {
        let Some(p) = pitch_of_degree(degree, 0.0, &key, None) else { return err("me.degree07") };
        let part = &doc.songs[at.si].parts[at.pi];
        let near = neighbour_midi(part, at.mi, part.measures[at.mi].elements.len(), voice);
        ch.notes = vec![Note { pitch: Some(nearest_octave(&p, near)), ..Default::default() }];
    }
    let measure = &mut doc.songs[at.si].parts[at.pi].measures[at.mi];
    let on = onsets(measure);
    let mine: Vec<usize> = (0..measure.elements.len()).filter(|&i| matches!(&measure.elements[i], Element::Chord(c) if c.voice == voice)).collect();
    let on_of = |i: usize| *on.get(&i).unwrap_or(&0.0);
    if mine.iter().any(|&i| measure.elements[i].as_chord().unwrap().grace.is_none() && on_of(i) == onset) {
        return ModelEdit::Error(Msg::new("me.voiceBusy").arg("n", shown));
    }
    let before = mine.iter().copied().rfind(|&i| on_of(i) <= onset);
    // 比本声线第一个音还早：插在它前面
    let index = match before {
        Some(b) => b + 1,
        None => mine.first().copied().unwrap_or(measure.elements.len()),
    };
    let prev_end = before.map_or(-1.0, |b| on_of(b) + measure.elements[b].as_chord().unwrap().duration.divisions);
    if prev_end != onset {
        ch.onset = Some(onset);
    }
    // 后面同声线的那个音若原本接着前一个音，给它显式起点保住原位
    if let Some(&f) = mine.iter().find(|&&i| i >= index) {
        let o = on_of(f);
        if let Element::Chord(fc) = &mut measure.elements[f] {
            if fc.onset.is_none() {
                fc.onset = Some(o);
            }
        }
    }
    let id = ch.id;
    measure.elements.insert(index, Element::Chord(ch));
    shift_for_insert(measure, index);
    measure.duration = None;
    rebeam(measure, voice, time.as_ref(), scale);
    respell_measure(measure, &key);
    hooks.forget_layout(&doc.songs[at.si]);
    ModelEdit::CaretAfter(id)
}

/// 和弦的起点（给声部输入算插入时刻）。
pub fn chord_onset(doc: &ScoreDoc, id: ElementId) -> Option<f64> {
    let l = locate(doc, id)?;
    onsets(l.measure(doc)).get(&l.index).copied()
}

/// 选中音的 MIDI 音高（按键发声用）。
pub fn midi_of(doc: &ScoreDoc, id: ElementId) -> Option<f64> {
    let l = locate(doc, id)?;
    l.chord(doc).notes.first()?.pitch.as_ref().map(midi_of_pitch)
}

/// 调内音阶走一级（7 往上到高音 1）。
pub fn step_degree(doc: &mut ScoreDoc, ids: &[ElementId], delta: f64, hooks: &mut dyn EditHooks) -> ModelEdit {
    let locs: Vec<ChordLoc> = chords_of(doc, ids).into_iter().filter(|l| l.chord(doc).notes.iter().any(|n| n.pitch.is_some())).collect();
    if locs.is_empty() {
        return err("ve.selectNote");
    }
    for l in &locs {
        let key = ctx_of(doc, l).key;
        for n in &mut l.chord_mut(doc).notes {
            let Some(p) = &n.pitch else { continue };
            let d = degree_from_pitch(p, &key, None);
            let mut num = d.number + delta;
            let mut shift = d.octave_shift;
            if num > 7.0 {
                num = 1.0;
                shift += 1.0;
            }
            if num < 1.0 {
                num = 7.0;
                shift -= 1.0;
            }
            if let Some(p) = pitch_of_degree(num, shift, &key, None) {
                n.pitch = Some(p);
            }
        }
    }
    touched(doc, &locs, hooks);
    ModelEdit::Select(ids_of(doc, &locs))
}

/// 选中的音移 `n` 个半音：落在调内音上写本音，否则升号调写升号、降号调写降号，C 调按走的方向。
pub fn shift_semitones(doc: &mut ScoreDoc, ids: &[ElementId], n: f64, hooks: &mut dyn EditHooks) -> ModelEdit {
    let locs: Vec<ChordLoc> = chords_of(doc, ids).into_iter().filter(|l| l.chord(doc).notes.iter().any(|x| x.pitch.is_some())).collect();
    if locs.is_empty() {
        return err("ve.selectNote");
    }
    for l in &locs {
        let key = ctx_of(doc, l).key;
        let sign = if key.fifths > 0.0 {
            1.0
        } else if key.fifths < 0.0 {
            -1.0
        } else {
            let s = js_sign(n);
            if s == 0.0 || s.is_nan() {
                1.0
            } else {
                s
            }
        };
        for x in &mut l.chord_mut(doc).notes {
            if let Some(p) = &x.pitch {
                x.pitch = Some(spell_midi(midi_of_pitch(p) + n, key.fifths, sign));
            }
        }
    }
    touched(doc, &locs, hooks);
    ModelEdit::Select(ids_of(doc, &locs))
}

fn js_sign(x: f64) -> f64 {
    if x.is_nan() {
        f64::NAN
    } else if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

/// 调号移 `n` 个半音后的调号（升 / 降不超过 6 个，F♯ 与 G♭ 取 F♯）。
pub fn transpose_fifths(fifths: f64, n: f64) -> f64 {
    let pc = (((fifths * 7.0 + n) % 12.0) + 12.0) % 12.0;
    const T: [f64; 12] = [0.0, -5.0, 2.0, -3.0, 4.0, -1.0, 6.0, 1.0, -4.0, 3.0, -2.0, 5.0];
    js::index(pc).and_then(|i| T.get(i).copied()).unwrap_or(f64::NAN)
}

/// 全曲移 `n` 个半音：每个音移过去、每处调号跟着换，按新调号拼写；和弦记号不动。
pub fn transpose_score(doc: &mut ScoreDoc, n: f64, hooks: &mut dyn EditHooks) -> ModelEdit {
    if n == 0.0 {
        return err("me.nothingToMove");
    }
    let mut all: Vec<ElementId> = vec![];
    for si in 0..doc.songs.len() {
        let song = &mut doc.songs[si];
        if let Some(k) = &mut song.key {
            k.fifths = transpose_fifths(k.fifths, n);
        }
        let song_key = song.key.as_ref().map(|k| k.fifths);
        for part in &mut song.parts {
            // 一处调号都没写（C 调）：在第一小节补上新调号
            if let Some(first) = part.measures.first_mut() {
                if song_key.is_none() && first.attrs.as_ref().and_then(|a| a.key.as_ref()).is_none() {
                    // `{ ...first.attrs, key }`：新对象，表层绑定丢了
                    let a = first.attrs.get_or_insert_with(MeasureAttrs::default);
                    a.oid = Oid::NONE;
                    a.key = Some(fifths_key(0.0));
                }
            }
            let mut fifths = song_key.unwrap_or(0.0);
            for m in &mut part.measures {
                if let Some(k) = m.attrs.as_mut().and_then(|a| a.key.as_mut()) {
                    k.fifths = transpose_fifths(k.fifths, n);
                    fifths = k.fifths;
                }
                let sign = if fifths > 0.0 {
                    1.0
                } else if fifths < 0.0 {
                    -1.0
                } else {
                    js_sign(n)
                };
                for el in &mut m.elements {
                    let Element::Chord(c) = el else { continue };
                    for x in &mut c.notes {
                        if let Some(p) = &x.pitch {
                            x.pitch = Some(spell_midi(midi_of_pitch(p) + n, fifths, sign));
                        }
                    }
                    if c.notes.iter().any(|x| x.pitch.is_some()) {
                        all.push(c.id);
                    }
                }
            }
        }
        hooks.forget_layout(&doc.songs[si]);
    }
    for id in all {
        if let Some(l) = locate(doc, id) {
            touched(doc, &[l], hooks);
        }
    }
    ModelEdit::Select(vec![])
}

/// MIDI 音高拼成音名：调内音优先，其次本位，再按 `sign` 取升或降。
fn spell_midi(midi: f64, fifths: f64, sign: f64) -> Pitch {
    let mut best: Option<Pitch> = None;
    let mut rank = f64::INFINITY;
    let pcm = ((midi % 12.0) + 12.0) % 12.0;
    for step in STEPS.iter() {
        for alter in [-1.0, 0.0, 1.0] {
            let pc = (step_semi(step) + alter + 12.0) % 12.0;
            if pc != pcm {
                continue;
            }
            let r = if alter == key_alter(step.as_str(), fifths) {
                0.0
            } else if alter == 0.0 {
                1.0
            } else if js_sign(alter) == sign {
                2.0
            } else {
                3.0
            };
            if r >= rank {
                continue;
            }
            rank = r;
            let octave = ((midi - step_semi(step) - alter) / 12.0).floor() - 1.0;
            best = Some(Pitch { step: step.clone(), alter, octave });
        }
    }
    best.expect("每个音级都有拼法")
}

fn top_note(ch: &Chord) -> Option<usize> {
    let mut top: Option<usize> = None;
    for (i, n) in ch.notes.iter().enumerate() {
        let Some(p) = &n.pitch else { continue };
        let better = match top {
            None => true,
            Some(t) => match &ch.notes[t].pitch {
                None => true,
                Some(tp) => midi_of_pitch(p) > midi_of_pitch(tp),
            },
        };
        if better {
            top = Some(i);
        }
    }
    top
}

/// 按音名改（`A`–`G`）：升降照调号，八度取离原来那个音最近的；和弦只改最上面那个音。
pub fn set_step(doc: &mut ScoreDoc, ids: &[ElementId], letter: &str, hooks: &mut dyn EditHooks) -> ModelEdit {
    let up = letter.to_uppercase();
    let Some(step) = STEPS.iter().find(|s| s.as_str() == up).cloned() else { return err("me.stepAG") };
    let locs: Vec<ChordLoc> = chords_of(doc, ids).into_iter().filter(|l| l.chord(doc).grace.is_none()).collect();
    if locs.is_empty() {
        return err("ve.selectNote");
    }
    for l in &locs {
        let key = ctx_of(doc, l).key;
        let ch = l.chord(doc);
        let top = top_note(ch);
        let r = match top.and_then(|t| ch.notes[t].pitch.as_ref()) {
            Some(p) => midi_of_pitch(p),
            None => neighbour_midi(l.part(doc), l.mi, l.index, ch.voice),
        };
        let p = nearest_octave(&Pitch { step: step.clone(), alter: key_alter(step.as_str(), key.fifths), octave: 4.0 }, r);
        let ch = l.chord_mut(doc);
        ch.rest = None;
        match top {
            Some(t) => ch.notes[t].pitch = Some(p),
            None => ch.notes = vec![Note { pitch: Some(p), ..Default::default() }],
        }
    }
    touched(doc, &locs, hooks);
    ModelEdit::Select(ids_of(doc, &locs))
}

/// 音名在这个调里是几（`1=` 那个音名算 1）。
pub fn degree_of_step(letter: &str, fifths: f64) -> f64 {
    let up = letter.to_uppercase();
    let idx = STEPS.iter().position(|s| s.as_str() == up).map_or(-1.0, |i| i as f64);
    let tonic = (((fifths * 4.0) % 7.0) + 7.0) % 7.0;
    ((idx - tonic + 7.0) % 7.0) + 1.0
}

/// 插入位置所在小节的调号（升号个数）。
pub fn anchor_fifths(doc: &ScoreDoc, anchor: &InsertAnchor) -> f64 {
    match anchor {
        InsertAnchor::After(id) => locate(doc, *id).map_or(0.0, |l| ctx_of(doc, &l).key.fifths),
        InsertAnchor::MeasureStart { si, pi, mi, .. } => match doc.songs.get(*si).and_then(|s| s.parts.get(*pi).map(|p| (s, p))) {
            Some((s, p)) => measure_ctx(s, p, *mi).key.fifths,
            None => 0.0,
        },
    }
}

// ───────────────────────── 小节结构 ─────────────────────────

/// 小节的实际长度：各声线终点的最大值。
fn measure_length(m: &Measure) -> f64 {
    let mut len = m.duration.unwrap_or(0.0);
    let mut voice_at: Vec<(f64, f64)> = vec![];
    for el in &m.elements {
        let start = match el {
            Element::Chord(c) => c.onset,
            _ => None,
        }
        .or_else(|| voice_at.iter().find(|(v, _)| *v == el.voice()).map(|(_, p)| *p))
        .unwrap_or(0.0);
        let end = start
            + match el {
                Element::Chord(c) => {
                    if c.grace.is_some() {
                        0.0
                    } else {
                        c.duration.divisions
                    }
                }
                Element::Space(s) => s.duration.as_ref().map_or(0.0, |d| d.divisions),
            };
        match voice_at.iter_mut().find(|(v, _)| *v == el.voice()) {
            Some(e) => e.1 = end,
            None => voice_at.push((el.voice(), end)),
        }
        len = js::max(len, end);
    }
    len
}

fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// 小节号从 `from` 起顺着往后重排（原文是整数的才动；implicit 小节不计号）。
fn renumber(part: &mut Part, from: usize) {
    let mut n = if from > 0 { js::parse_int(&part.measures[from - 1].number, 10.0 as i32) } else { 0.0 };
    if !n.is_finite() {
        return;
    }
    for m in part.measures.iter_mut().skip(from) {
        if !all_digits(&m.number) {
            return;
        }
        if m.implicit == Some(true) {
            continue;
        }
        n += 1.0;
        m.number = js::num_to_string(n);
    }
}

fn voices_in(els: &[Element]) -> Vec<f64> {
    let mut v: Vec<f64> = vec![];
    for e in els {
        if !v.iter().any(|x| js::NumKey::new(*x) == js::NumKey::new(e.voice())) {
            v.push(e.voice());
        }
    }
    v
}

fn set_onset(e: &mut Element, o: Option<f64>) {
    match e {
        Element::Chord(c) => c.onset = o,
        Element::Space(s) => s.onset = o,
    }
}

/// 插小节线：把锚点所在小节在锚点之后劈成两节。**所有声部一起劈**，要求每个声部每个声线在那一刻都有音符边界。
pub fn split_measure(doc: &mut ScoreDoc, after_id: ElementId, hooks: &mut dyn EditHooks) -> ModelEdit {
    let Some(l) = locate(doc, after_id) else { return err("me.noInsertPos") };
    let cut0 = onsets(l.measure(doc)).get(&l.index).copied().unwrap_or(0.0) + l.chord(doc).duration.divisions;
    if cut0 >= measure_length(l.measure(doc)) {
        return err("me.atMeasureEnd");
    }
    let song = l.song(doc);
    let cut_q = cut0 / measure_ctx(song, l.part(doc), l.mi).dpq;
    let cut_of = |part: &Part| cut_q * measure_ctx(song, part, l.mi).dpq;
    for part in &song.parts {
        let Some(m) = part.measures.get(l.mi) else { continue };
        let cut = cut_of(part);
        let on = onsets(m);
        for (i, el) in m.elements.iter().enumerate() {
            let Element::Chord(ch) = el else { continue };
            let at = on[&i];
            if at < cut && at + if ch.grace.is_some() { 0.0 } else { ch.duration.divisions } > cut {
                let name = part.name.as_deref().filter(|n| !n.is_empty());
                let arg: dolce_base::msg::MsgArg = match name {
                    Some(n) => n.into(),
                    None => Msg::new("me.otherPart").into(),
                };
                return ModelEdit::Error(Msg::new("me.crossBar").arg("part", arg));
            }
        }
    }
    let cuts: Vec<f64> = song.parts.iter().map(cut_of).collect();
    let si = l.si;
    for (pi, cut) in cuts.into_iter().enumerate() {
        let song = &mut doc.songs[si];
        let MeasureCtx { time, dpq, .. } = measure_ctx(song, &song.parts[pi], l.mi);
        let part = &mut song.parts[pi];
        let Some(m) = part.measures.get_mut(l.mi) else { continue };
        let on = onsets(m);
        let old: Vec<Element> = std::mem::take(&mut m.elements);
        let is_kept = |i: usize, e: &Element| !matches!(e, Element::Chord(_)) || on.get(&i).copied().unwrap_or(0.0) < cut;
        let keep_idx: Vec<usize> = (0..old.len()).filter(|&i| is_kept(i, &old[i])).collect();
        let moved_idx: Vec<usize> = (0..old.len()).filter(|&i| !is_kept(i, &old[i])).collect();
        let mut moved: Vec<Element> = moved_idx.iter().map(|&i| old[i].clone()).collect();
        // 挪过去的每个声线的第一个音给显式起点（新小节里各声线从头排）
        let mut first_of: Vec<f64> = vec![];
        for k in 0..moved.len() {
            let Element::Chord(e) = &moved[k] else { continue };
            let voice = e.voice;
            let mut onset = e.onset;
            if onset.is_some() || !first_of.contains(&voice) {
                onset = Some(on.get(&moved_idx[k]).copied().unwrap_or(cut) - cut);
            }
            first_of.push(voice);
            let first_same_voice = moved.iter().position(|x| x.voice() == voice) == Some(k);
            if onset == Some(0.0) && first_same_voice && k == 0 {
                onset = None;
            }
            set_onset(&mut moved[k], onset);
        }
        let keep: Vec<Element> = keep_idx.iter().map(|&i| old[i].clone()).collect();
        let mut nm = Measure { number: m.number.clone(), elements: vec![], ..Default::default() };
        let right: Vec<Barline> = m.barlines.iter().flatten().filter(|b| b.location == BarLocation::Right).cloned().collect();
        if !right.is_empty() {
            nm.barlines = Some(right);
            m.barlines = Some(m.barlines.take().unwrap_or_default().into_iter().filter(|b| b.location != BarLocation::Right).collect());
        }
        // 文字记号、小节中间的属性按「排在第几个元素之后」挂：跟着它前面挨着的那个元素走
        let place = |a: f64| -> (bool, f64) {
            if a <= 0.0 {
                return (false, 0.0);
            }
            if a >= old.len() as f64 {
                return (!moved_idx.is_empty(), if !moved_idx.is_empty() { moved_idx.len() as f64 } else { keep_idx.len() as f64 });
            }
            let e = js::index(a).unwrap_or(0);
            match moved_idx.iter().position(|&i| i == e) {
                Some(k) => (true, k as f64),
                None => (false, keep_idx.iter().position(|&i| i == e).map_or(-1.0, |k| k as f64)),
            }
        };
        let (mut moved_dirs, mut stay) = (vec![], vec![]);
        for d in m.directions.take().unwrap_or_default() {
            let (mv, at) = place(d.after_elements.unwrap_or(0.0));
            // `{ ...d, afterElements }`：新对象
            let nd = Direction { oid: Oid::NONE, after_elements: Some(at), ..d };
            if mv {
                moved_dirs.push(nd);
            } else {
                stay.push(nd);
            }
        }
        if !moved_dirs.is_empty() {
            nm.directions = Some(moved_dirs);
        }
        m.directions = if stay.is_empty() { None } else { Some(stay) };
        let later = m.later_attrs.take();
        let (mut moved_later, mut stay_later) = (vec![], vec![]);
        for x in later.clone().unwrap_or_default() {
            let (mv, at) = place(x.after_elements);
            let nx = LaterAttrs { after_elements: at, ..x };
            if mv {
                moved_later.push(nx);
            } else {
                stay_later.push(nx);
            }
        }
        if !moved_later.is_empty() {
            nm.later_attrs = Some(moved_later);
        }
        m.later_attrs = if stay_later.is_empty() { None } else { Some(stay_later) };
        let voices = voices_in(&keep.iter().chain(moved.iter()).cloned().collect::<Vec<_>>());
        m.elements = keep;
        m.duration = None;
        nm.elements = moved;
        part.measures.insert(l.mi + 1, nm);
        renumber(part, l.mi + 1);
        for v in voices {
            rebeam(&mut part.measures[l.mi], v, time.as_ref(), dpq);
            rebeam(&mut part.measures[l.mi + 1], v, time.as_ref(), dpq);
        }
    }
    hooks.forget_layout(&doc.songs[si]);
    ModelEdit::CaretAfter(after_id)
}

fn attrs_without_divisions(a: &MeasureAttrs) -> MeasureAttrs {
    MeasureAttrs { oid: Oid::NONE, divisions: None, ..a.clone() }
}

fn attrs_empty(a: &MeasureAttrs) -> bool {
    a.divisions.is_none()
        && a.key.is_none()
        && a.time.is_none()
        && a.clefs.is_none()
        && a.staves.is_none()
        && a.transpose.is_none()
        && a.multi_rest.is_none()
}

/// 删小节线：第 `mi` 小节与下一小节并成一节（所有声部一起并）。下一小节换了调号 / 拍号的不并。
pub fn merge_measures(doc: &mut ScoreDoc, si: usize, mi: usize, hooks: &mut dyn EditHooks) -> ModelEdit {
    let Some(song) = doc.songs.get(si) else { return err("me.noMeasure") };
    for part in &song.parts {
        let (Some(_), Some(b)) = (part.measures.get(mi), part.measures.get(mi + 1)) else { return err("me.lastBar") };
        if b.attrs.as_ref().is_some_and(|a| a.key.is_some() || a.time.is_some()) {
            return err("me.mergeKeyTime");
        }
        if let Some(d) = b.attrs.as_ref().and_then(|a| a.divisions) {
            if d != measure_ctx(song, part, mi).dpq {
                return err("me.mergeDiv");
            }
        }
    }
    let mut anchor: Option<ElementId> = None;
    let song = &mut doc.songs[si];
    for pi in 0..song.parts.len() {
        let part = &mut song.parts[pi];
        let mut b = part.measures.remove(mi + 1);
        let a = &mut part.measures[mi];
        let len = measure_length(a);
        let on_b = onsets(&b);
        let mut seen: Vec<f64> = vec![];
        for (i, e) in b.elements.iter_mut().enumerate() {
            let Element::Chord(c) = e else { continue };
            if c.onset.is_some() || !seen.contains(&c.voice) {
                c.onset = Some(on_b.get(&i).copied().unwrap_or(0.0) + len);
            }
            seen.push(c.voice);
        }
        // 接在 a 后面的第一个声线本来就从 a 的终点起，去掉多余的显式起点
        let last_a = a.elements.iter().rev().find_map(|e| e.as_chord()).map(|c| (c.id, c.voice));
        if pi == 0 {
            anchor = last_a.map(|x| x.0);
        }
        if let Some(Element::Chord(first)) = b.elements.iter_mut().find(|e| matches!(e, Element::Chord(_))) {
            if let Some((_, lv)) = last_a {
                if first.voice == lv && first.onset == Some(len) {
                    first.onset = None;
                }
            }
        }
        let a_n = a.elements.len() as f64;
        let mut dirs = a.directions.take().unwrap_or_default();
        dirs.extend(b.directions.take().unwrap_or_default().into_iter().map(|d| Direction {
            oid: Oid::NONE,
            after_elements: Some(d.after_elements.unwrap_or(0.0) + a_n),
            ..d
        }));
        a.directions = if dirs.is_empty() { None } else { Some(dirs) };
        // 下一小节开头换的谱号（等）成了这一小节中间的属性；它中间的属性、小节线照挪
        let battrs = b.attrs.as_ref().map(attrs_without_divisions).filter(|x| !attrs_empty(x));
        let mut later: Vec<LaterAttrs> = a.later_attrs.clone().unwrap_or_default();
        if let Some(ba) = battrs {
            later.push(LaterAttrs { after_elements: a_n, onset: Some(len), attrs: ba });
        }
        for x in b.later_attrs.take().unwrap_or_default() {
            later.push(LaterAttrs { after_elements: x.after_elements + a_n, onset: x.onset.map(|o| o + len), attrs: x.attrs });
        }
        if !later.is_empty() {
            a.later_attrs = Some(later);
        }
        for x in b.barlines.iter_mut().flatten() {
            if x.location == BarLocation::Middle {
                if let Some(ae) = &mut x.after_elements {
                    *ae += a_n;
                }
            }
        }
        a.elements.append(&mut b.elements);
        let mut bars: Vec<Barline> = a.barlines.take().unwrap_or_default().into_iter().filter(|x| x.location != BarLocation::Right).collect();
        bars.extend(b.barlines.take().unwrap_or_default().into_iter().filter(|x| x.location != BarLocation::Left));
        a.barlines = if bars.is_empty() { None } else { Some(bars) };
        a.duration = None;
        renumber(part, mi + 1);
        let MeasureCtx { key, time, dpq } = measure_ctx(song, &song.parts[pi], mi);
        let a = &mut song.parts[pi].measures[mi];
        for v in voices_in(&a.elements) {
            rebeam(a, v, time.as_ref(), dpq);
        }
        respell_measure(a, &key);
    }
    hooks.forget_layout(&doc.songs[si]);
    match anchor {
        Some(a) => ModelEdit::CaretAfter(a),
        None => ModelEdit::Select(vec![]),
    }
}

fn print_empty(p: &Print) -> bool {
    p.new_system.is_none()
        && p.new_page.is_none()
        && p.system.is_none()
        && p.texts.is_none()
        && p.caption.is_none()
        && p.variant.is_none()
        && p.lyric_lines.is_none()
        && p.source.is_none()
        && p.text_sources.is_none()
}

fn last_chord(m: Option<&Measure>) -> Option<ElementId> {
    m?.elements.iter().rev().find_map(|e| e.as_chord()).map(|c| c.id)
}

/// 在第 `mi` 小节之前换行 / 换页（None = 去掉）。
pub fn set_break_before(doc: &mut ScoreDoc, si: usize, mi: usize, kind: Option<BreakKind>) -> ModelEdit {
    let Some(song) = doc.songs.get_mut(si) else { return err("me.breakFirst") };
    if mi == 0 {
        return err("me.breakFirst");
    }
    let mut anchor = None;
    for (pi, part) in song.parts.iter_mut().enumerate() {
        if part.measures.get(mi).is_none() {
            continue;
        }
        if pi == 0 {
            anchor = last_chord(part.measures.get(mi - 1));
        }
        let m = &mut part.measures[mi];
        let mut p = m.print.clone().unwrap_or_default();
        p.oid = Oid::NONE;
        p.new_system = None;
        p.new_page = None;
        match kind {
            Some(BreakKind::System) => p.new_system = Some(true),
            Some(BreakKind::Page) => p.new_page = Some(true),
            _ => {}
        }
        m.print = if print_empty(&p) { None } else { Some(p) };
    }
    match anchor {
        Some(a) => ModelEdit::CaretAfter(a),
        None => ModelEdit::Select(vec![]),
    }
}

/// 圆滑线：首尾两个音之间加一条；已有同样起止的就去掉。
pub fn toggle_slur(doc: &mut ScoreDoc, first_id: ElementId, last_id: ElementId) -> ModelEdit {
    if first_id == last_id {
        return err("ve.slurTwo");
    }
    let (Some(a), Some(b)) = (locate(doc, first_id), locate(doc, last_id)) else { return err("me.selectToSlur") };
    if a.pi != b.pi {
        return err("me.slurCrossPart");
    }
    let song = &mut doc.songs[a.si];
    match song.marks.iter().position(|m| m.kind == MarkType::Slur && m.start == first_id && m.end == last_id) {
        Some(i) => {
            song.marks.remove(i);
        }
        None => {
            // number 取与它重叠的弧都没用的最小号
            let used: Vec<f64> = song.marks.iter().filter(|m| m.kind == MarkType::Slur).map(|m| m.number.unwrap_or(1.0)).collect();
            let mut number = 1.0;
            while used.contains(&number) {
                number += 1.0;
            }
            let mut mk = Mark::new(MarkType::Slur, first_id, last_id);
            mk.number = Some(number);
            song.marks.push(mk);
        }
    }
    ModelEdit::Select(vec![a.chord(doc).id, b.chord(doc).id])
}

/// 同一声线里 `loc` 之后的下一个和弦（可跨小节）。
fn next_in_voice(doc: &ScoreDoc, loc: &ChordLoc) -> Option<ChordLoc> {
    let part = loc.part(doc);
    let voice = loc.chord(doc).voice;
    for (mi, m) in part.measures.iter().enumerate().skip(loc.mi) {
        let els = &m.elements;
        let from = if mi == loc.mi { loc.index + 1 } else { 0 };
        for (i, e) in els.iter().enumerate().skip(from) {
            if let Element::Chord(c) = e {
                if c.voice == voice && c.grace.is_none() {
                    return Some(ChordLoc { si: loc.si, pi: loc.pi, mi, index: i });
                }
            }
        }
    }
    None
}

/// 延音线：连到同一声线的下一个音（音高要相同）；已连着就去掉。
pub fn toggle_tie(doc: &mut ScoreDoc, id: ElementId) -> ModelEdit {
    let Some(l) = locate(doc, id) else { return err("ve.selectNote") };
    let c = l.chord(doc);
    if c.rest.is_some() || c.notes.is_empty() {
        return err("ve.selectNote");
    }
    let nxt = next_in_voice(doc, &l);
    let same = |x: &Chord| {
        x.notes.len() == c.notes.len()
            && x.notes.iter().enumerate().all(|(i, n)| match (&n.pitch, c.notes.get(i).and_then(|m| m.pitch.as_ref())) {
                (Some(p), Some(q)) => midi_of_pitch(p) == midi_of_pitch(q),
                _ => false,
            })
    };
    let Some(nl) = nxt.filter(|n| same(n.chord(doc))) else { return err("me.tieSamePitch") };
    let on = c.notes.iter().all(|n| n.tie.as_ref().is_some_and(|t| t.start == Some(true)));
    let (cid, nid) = (c.id, nl.chord(doc).id);
    let count = c.notes.len();
    doc.songs[l.si].marks.retain(|m| !(m.kind == MarkType::Tied && m.start == cid && m.end == nid));
    for i in 0..count {
        if on {
            if let Some(t) = &mut l.chord_mut(doc).notes[i].tie {
                t.start = None;
            }
            if let Some(t) = &mut nl.chord_mut(doc).notes[i].tie {
                t.stop = None;
            }
        } else {
            l.chord_mut(doc).notes[i].tie.get_or_insert_with(Tie::default).start = Some(true);
            nl.chord_mut(doc).notes[i].tie.get_or_insert_with(Tie::default).stop = Some(true);
            let mut mk = Mark::new(MarkType::Tied, cid, nid);
            mk.number = Some(1.0);
            if i != 0 {
                mk.start_note = Some(i as f64);
                mk.end_note = Some(i as f64);
            }
            doc.songs[l.si].marks.push(mk);
        }
    }
    ModelEdit::Select(vec![cid])
}

pub const ARTICULATIONS: [&str; 7] = ["accent", "staccato", "tenuto", "strong-accent", "staccatissimo", "detached-legato", "breath-mark"];
pub const ORNAMENTS: [&str; 5] = ["trill-mark", "mordent", "inverted-mordent", "turn", "inverted-turn"];

fn has_deco(c: &Chord, kind: &str) -> bool {
    let n = c.notations.as_ref();
    let fermata = n.and_then(|n| n.fermata) == Some(true);
    let inverted = n.and_then(|n| n.fermata_inverted) == Some(true);
    match kind {
        "fermata" => fermata && !inverted,
        "fermata-inverted" => fermata && inverted,
        _ if ARTICULATIONS.contains(&kind) => n.and_then(|n| n.articulations.as_ref()).is_some_and(|a| a.iter().any(|x| x == kind)),
        _ => n.and_then(|n| n.ornaments.as_ref()).is_some_and(|a| a.iter().any(|x| x == kind)),
    }
}

fn notations_empty(n: &Notations) -> bool {
    n.articulations.is_none()
        && n.artic_placement.is_none()
        && n.ornaments.is_none()
        && n.tremolo.is_none()
        && n.tremolo_pos.is_none()
        && n.technical.is_none()
        && n.fermata.is_none()
        && n.fermata_inverted.is_none()
        && n.arpeggiate.is_none()
        && n.glissando.is_none()
}

/// 音符记号：有就去掉，没有就加上（选中几个音时，全都有才算有）。
pub fn toggle_deco(doc: &mut ScoreDoc, ids: &[ElementId], kind: &str) -> ModelEdit {
    let locs = chords_of(doc, ids);
    if locs.is_empty() {
        return err("ve.selectNote");
    }
    let on = locs.iter().all(|l| has_deco(l.chord(doc), kind));
    for l in &locs {
        let c = l.chord_mut(doc);
        let mut n = c.notations.clone().unwrap_or_default();
        if kind == "fermata" || kind == "fermata-inverted" {
            n.fermata = None;
            n.fermata_inverted = None;
            if !on {
                n.fermata = Some(true);
                if kind == "fermata-inverted" {
                    n.fermata_inverted = Some(true);
                }
            }
        } else {
            let field = if ARTICULATIONS.contains(&kind) { &mut n.articulations } else { &mut n.ornaments };
            let mut list: Vec<String> = field.take().unwrap_or_default().into_iter().filter(|a| a != kind).collect();
            if !on {
                list.push(kind.to_owned());
            }
            *field = if list.is_empty() { None } else { Some(list) };
        }
        c.notations = if notations_empty(&n) { None } else { Some(n) };
    }
    ModelEdit::Select(ids_of(doc, &locs))
}

/// 本小节该有多长（按拍号；没有拍号按实际最长声线）。
fn nominal_length(song: &Song, part: &Part, mi: usize) -> f64 {
    let MeasureCtx { time, dpq, .. } = measure_ctx(song, part, mi);
    match time {
        Some(t) => (dpq * 4.0 * t.beats) / t.beat_type,
        None => part.measures.get(mi).map_or(dpq * 4.0, measure_length),
    }
}

/// 整小节休止（声线 1，谱表 1）。
fn whole_rest(doc: &ScoreDoc, len: f64, dpq: f64) -> Chord {
    let (t, dots) = type_of_divisions(len, dpq).unwrap_or((NoteType::Whole, 0.0));
    Chord {
        id: next_id(doc),
        rest: Some(RestInfo { measure: Some(true), ..Default::default() }),
        duration: Duration { divisions: len, kind: Some(t), dots, time_mod: None },
        voice: 1.0,
        staff: 1.0,
        ..Default::default()
    }
}

/// 在第 `mi` 小节之前插入一个空小节（`mi` = 小节数时追加在最后）：所有声部一起插，各放一个整小节休止。
pub fn insert_measure(doc: &mut ScoreDoc, si: usize, mi: usize, hooks: &mut dyn EditHooks) -> ModelEdit {
    if doc.songs.get(si).is_none() {
        return err("me.noMeasure");
    }
    let mut pick: Option<ElementId> = None;
    for pi in 0..doc.songs[si].parts.len() {
        let song = &doc.songs[si];
        let part = &song.parts[pi];
        let n = part.measures.len();
        let at = mi.min(n);
        // 拍号取插入处前面那一小节的
        let r = (if at > 0 { at - 1 } else { 0 }).min(n.saturating_sub(1));
        let len = nominal_length(song, part, r);
        let dpq_ref = measure_ctx(song, part, r).dpq;
        let rest = whole_rest(doc, len, dpq_ref);
        let rest_id = rest.id;
        let mut nm = Measure { number: String::new(), elements: vec![Element::Chord(rest)], ..Default::default() };
        // 大谱表：每行谱表各一个整小节休止
        let mut staves = 1.0;
        for k in 0..=r {
            if let Some(s) = part.measures.get(k).and_then(|m| m.attrs.as_ref()).and_then(|a| a.staves) {
                staves = s;
            }
        }
        let mut st = 2.0;
        while st <= staves {
            let mut x = whole_rest(doc, len, dpq_ref);
            x.staff = st;
            x.voice = part.measures.get(r).and_then(|m| m.elements.iter().find(|e| e.staff() == st)).map_or((st - 1.0) * 4.0 + 1.0, |e| e.voice());
            x.onset = Some(0.0);
            nm.elements.push(Element::Chord(x));
            st += 1.0;
        }
        let part = &mut doc.songs[si].parts[pi];
        // 插在第一小节前面：原来第一小节的属性挪到新的第一小节
        if at == 0 {
            if let Some(a) = part.measures.first_mut().and_then(|m| m.attrs.take()) {
                nm.attrs = Some(a);
            }
        }
        // 追加在最后：终止线挪到新的最后一小节（带反复、房号的尾线留在原处）
        if at == n && at > 0 {
            let last = &mut part.measures[at - 1];
            let is_final = |b: &Barline| b.location == BarLocation::Right && b.style == Some(BarStyle::LightHeavy) && b.repeat.is_none() && b.ending.is_none();
            let right: Vec<Barline> = last.barlines.iter().flatten().filter(|b| is_final(b)).cloned().collect();
            if !right.is_empty() {
                nm.barlines = Some(right);
                let rest: Vec<Barline> = last.barlines.take().unwrap_or_default().into_iter().filter(|b| !is_final(b)).collect();
                last.barlines = if rest.is_empty() { None } else { Some(rest) };
            }
        }
        part.measures.insert(at, nm);
        part.measures[at].number = if at > 0 {
            let p = js::parse_int(&part.measures[at - 1].number, 10);
            let base = if p == 0.0 || p.is_nan() { at as f64 } else { p };
            js::num_to_string(base + 1.0)
        } else {
            "1".to_owned()
        };
        renumber(part, at);
        if pi == 0 {
            pick = Some(rest_id);
        }
    }
    hooks.forget_layout(&doc.songs[si]);
    ModelEdit::Select(pick.into_iter().collect())
}

fn merge_attrs_over(base: &MeasureAttrs, over: &MeasureAttrs) -> MeasureAttrs {
    MeasureAttrs {
        oid: Oid::NONE,
        divisions: over.divisions.or(base.divisions),
        key: over.key.clone().or_else(|| base.key.clone()),
        time: over.time.clone().or_else(|| base.time.clone()),
        clefs: over.clefs.clone().or_else(|| base.clefs.clone()),
        staves: over.staves.or(base.staves),
        transpose: over.transpose.clone().or_else(|| base.transpose.clone()),
        multi_rest: over.multi_rest.or(base.multi_rest),
    }
}

/// 删掉第 `from`..`to` 小节（含）：所有声部一起删；删掉的第一小节带的属性挪给后面那一小节，以它们为端点的弧与连音线一起去掉。
pub fn delete_measures(doc: &mut ScoreDoc, si: usize, from: usize, to: usize, hooks: &mut dyn EditHooks) -> ModelEdit {
    let Some(song) = doc.songs.get_mut(si) else { return err("me.noMeasure") };
    let n = song.parts.first().map_or(0, |p| p.measures.len()) as isize;
    if to as isize - from as isize + 1 >= n {
        return err("me.keepOneMeasure");
    }
    let mut gone: HashSet<ElementId> = HashSet::new();
    for part in &mut song.parts {
        let len = part.measures.len();
        let (a, b) = (from.min(len), (to + 1).min(len).max(from.min(len)));
        let removed: Vec<Measure> = part.measures[a..b].to_vec();
        for m in &removed {
            for e in &m.elements {
                gone.insert(e.id());
            }
        }
        // 删掉的小节里最早生效的属性合并给紧跟着的那一小节
        let carried = removed.iter().fold(None::<MeasureAttrs>, |acc, m| match (&acc, &m.attrs) {
            (_, None) => acc,
            (None, Some(x)) => Some(MeasureAttrs { oid: Oid::NONE, ..x.clone() }),
            (Some(a), Some(x)) => Some(merge_attrs_over(a, x)),
        });
        let has_next = to + 1 < len;
        if has_next {
            if let Some(c) = &carried {
                let next = &mut part.measures[to + 1];
                next.attrs = Some(match &next.attrs {
                    Some(x) => merge_attrs_over(c, x),
                    None => MeasureAttrs { oid: Oid::NONE, ..c.clone() },
                });
            }
        }
        // 删的是最后几小节：终止线挪给新的最后一小节
        let last_right: Vec<Barline> =
            removed.last().and_then(|m| m.barlines.as_ref()).map(|b| b.iter().filter(|x| x.location == BarLocation::Right).cloned().collect()).unwrap_or_default();
        part.measures.drain(a..b);
        if !has_next && !last_right.is_empty() {
            if let Some(last) = part.measures.last_mut() {
                let mut bars: Vec<Barline> = last.barlines.take().unwrap_or_default().into_iter().filter(|x| x.location != BarLocation::Right).collect();
                bars.extend(last_right);
                last.barlines = Some(bars);
            }
        }
        renumber(part, from.min(part.measures.len()));
    }
    // 一头删掉的延音线：留下那头的音上的 tie 标记也清掉
    let ties: Vec<(ElementId, bool)> = doc.songs[si]
        .marks
        .iter()
        .filter(|mk| mk.kind == MarkType::Tied && gone.contains(&mk.start) != gone.contains(&mk.end))
        .map(|mk| if gone.contains(&mk.start) { (mk.end, true) } else { (mk.start, false) })
        .collect();
    for (other, start_gone) in ties {
        if let Some(o) = locate(doc, other) {
            for nt in &mut o.chord_mut(doc).notes {
                if let Some(t) = &mut nt.tie {
                    if start_gone {
                        t.stop = None;
                    } else {
                        t.start = None;
                    }
                }
            }
        }
    }
    doc.songs[si].marks.retain(|m| !gone.contains(&m.start) && !gone.contains(&m.end));
    hooks.forget_layout(&doc.songs[si]);
    let p0 = doc.songs[si].parts.first();
    let after = p0.and_then(|p| p.measures.get(from.min(p.measures.len().max(1) - 1))).and_then(|m| m.elements.iter().find_map(|e| e.as_chord())).map(|c| c.id);
    ModelEdit::Select(after.into_iter().collect())
}

/// 从第 `mi` 小节起换调号（音高不动，临时记号的印法到下一次换调号为止重算）。
pub fn set_key_at(doc: &mut ScoreDoc, si: usize, mi: usize, fifths: f64, hooks: &mut dyn EditHooks) -> ModelEdit {
    let Some(song) = doc.songs.get_mut(si) else { return err("me.noMeasure") };
    for pi in 0..song.parts.len() {
        let Some(m) = song.parts[pi].measures.get_mut(mi) else { continue };
        let mut a = m.attrs.clone().unwrap_or_default();
        a.oid = Oid::NONE;
        let mut k = a.key.clone().unwrap_or_else(|| fifths_key(fifths));
        k.fifths = fifths;
        a.key = Some(k);
        m.attrs = Some(a);
        if mi == 0 {
            let mut k = song.key.clone().unwrap_or_else(|| fifths_key(fifths));
            k.fifths = fifths;
            song.key = Some(k);
        }
        for i in mi..song.parts[pi].measures.len() {
            if i > mi && song.parts[pi].measures[i].attrs.as_ref().is_some_and(|a| a.key.is_some()) {
                break;
            }
            let key = measure_ctx(song, &song.parts[pi], i).key;
            respell_measure(&mut song.parts[pi].measures[i], &key);
        }
    }
    hooks.forget_layout(&doc.songs[si]);
    ModelEdit::Select(vec![])
}

/// 从第 `mi` 小节起换拍号（小节里的音不动）。
pub fn set_time_at(doc: &mut ScoreDoc, si: usize, mi: usize, beats: f64, beat_type: f64, hooks: &mut dyn EditHooks) -> ModelEdit {
    let Some(song) = doc.songs.get_mut(si) else { return err("me.noMeasure") };
    if !(beats > 0.0 && [1.0, 2.0, 4.0, 8.0, 16.0, 32.0].contains(&beat_type)) {
        return err("me.timeFormat");
    }
    let t = Time { beats, beat_type, symbol: None, parenthesized: None };
    for pi in 0..song.parts.len() {
        let Some(m) = song.parts[pi].measures.get_mut(mi) else { continue };
        let mut a = m.attrs.clone().unwrap_or_default();
        a.oid = Oid::NONE;
        a.time = Some(t.clone());
        m.attrs = Some(a);
        if mi == 0 {
            song.time = Some(t.clone());
        }
        let MeasureCtx { time, dpq, .. } = measure_ctx(song, &song.parts[pi], mi);
        for i in mi..song.parts[pi].measures.len() {
            let x = &mut song.parts[pi].measures[i];
            if i > mi && x.attrs.as_ref().is_some_and(|a| a.time.is_some()) {
                break;
            }
            for v in voices_in(&x.elements) {
                rebeam(x, v, time.as_ref(), dpq);
            }
        }
    }
    hooks.forget_layout(&doc.songs[si]);
    ModelEdit::Select(vec![])
}

/// 第 `mi` 小节开头的速度记号（♩ = bpm）；bpm 为 0 = 去掉。只挂在第一声部上。
pub fn set_tempo_at(doc: &mut ScoreDoc, si: usize, mi: usize, bpm: f64) -> ModelEdit {
    let Some(m) = doc.songs.get_mut(si).and_then(|s| s.parts.first_mut()).and_then(|p| p.measures.get_mut(mi)) else { return err("me.noMeasure") };
    let mut rest: Vec<Direction> = m
        .directions
        .take()
        .unwrap_or_default()
        .into_iter()
        .filter(|d| !(d.kind == "metronome" && d.after_elements.is_none_or(|a| a == 0.0 || a.is_nan())))
        .collect();
    if bpm > 0.0 {
        let mut d = Direction::of("metronome");
        d.tempo = Some(Metronome { beat_unit: Some(NoteType::Quarter), per_minute: Some(bpm), ..Default::default() });
        d.sound = Some(Sound { tempo: Some(bpm), ..Default::default() });
        rest.insert(0, d);
    }
    m.directions = if rest.is_empty() { None } else { Some(rest) };
    ModelEdit::Select(vec![])
}

/// 第 `mi` 小节的小节线样式：反复开始在小节头（左线），其余在小节尾（右线）。所有声部一起改。
pub fn set_bar_kind(doc: &mut ScoreDoc, si: usize, mi: usize, kind: &str) -> ModelEdit {
    let Some(song) = doc.songs.get_mut(si) else { return err("me.noMeasure") };
    for part in &mut song.parts {
        let Some(m) = part.measures.get_mut(mi) else { continue };
        let loc = if kind == "repeatStart" { BarLocation::Left } else { BarLocation::Right };
        let mut bars = m.barlines.take().unwrap_or_default();
        let old = bars.iter().position(|b| b.location == loc).map(|i| bars.remove(i));
        let mut b = old.unwrap_or_else(|| Barline::at(loc.clone()));
        b.oid = Oid::NONE;
        b.location = loc;
        b.style = None;
        b.repeat = None;
        match kind {
            "double" => b.style = Some(BarStyle::LightLight),
            "final" => b.style = Some(BarStyle::LightHeavy),
            "repeatEnd" => {
                b.style = Some(BarStyle::LightHeavy);
                b.repeat = Some(RepeatDir::Backward);
            }
            "repeatStart" => {
                b.style = Some(BarStyle::HeavyLight);
                b.repeat = Some(RepeatDir::Forward);
            }
            _ => {}
        }
        let keep = kind != "single" || b.ending.is_some() || b.jump.as_deref().is_some_and(|j| !j.is_empty());
        if keep {
            bars.push(b);
        }
        m.barlines = if bars.is_empty() { None } else { Some(bars) };
    }
    ModelEdit::Select(vec![])
}

/// 房号：第 `from`..`to` 小节标成第 `n` 房（已是就去掉）。所有声部一起标。
pub fn toggle_ending(doc: &mut ScoreDoc, si: usize, from: usize, to: usize, n: f64) -> ModelEdit {
    let Some(song) = doc.songs.get_mut(si) else { return err("me.noMeasure") };
    let cur = song.parts.first().and_then(|p| p.measures.get(from)).and_then(|m| m.barlines.as_ref()).and_then(|b| {
        b.iter().find(|x| x.location == BarLocation::Left && x.ending.as_ref().is_some_and(|e| e.kind == EndingType::Start))
    });
    let on = cur.is_some_and(|c| c.ending.as_ref().unwrap().numbers.contains(&n));
    for part in &mut song.parts {
        for (i, loc, kind) in [(from, BarLocation::Left, EndingType::Start), (to, BarLocation::Right, EndingType::Stop)] {
            let Some(m) = part.measures.get_mut(i) else { continue };
            let mut bars = m.barlines.take().unwrap_or_default();
            let old = bars.iter().position(|b| b.location == loc).map(|i| bars.remove(i));
            let mut b = old.unwrap_or_else(|| Barline::at(loc.clone()));
            b.oid = Oid::NONE;
            b.location = loc;
            if on {
                b.ending = None;
            } else {
                // 最后一房不封口（`discontinue`），前面的房封口
                let t = if kind == EndingType::Stop && n > 1.0 { EndingType::Discontinue } else { kind };
                b.ending = Some(Ending::new(vec![n], t, None));
            }
            let keep = b.style.is_some() || b.repeat.is_some() || b.ending.is_some() || b.jump.as_deref().is_some_and(|j| !j.is_empty());
            if keep {
                bars.push(b);
            }
            m.barlines = if bars.is_empty() { None } else { Some(bars) };
        }
    }
    ModelEdit::Select(vec![])
}

/// 跳转记号：segno / coda 挂在小节头，D.C. / D.S. / Fine 挂在小节尾（带 `<sound>`）。已有就去掉。
pub fn toggle_jump(doc: &mut ScoreDoc, si: usize, mi: usize, kind: &str) -> ModelEdit {
    let Some(m) = doc.songs.get_mut(si).and_then(|s| s.parts.first_mut()).and_then(|p| p.measures.get_mut(mi)) else { return err("me.noMeasure") };
    let end = matches!(kind, "dc" | "ds" | "fine");
    let text = match kind {
        "dc" => "D.C.",
        "ds" => "D.S.",
        "fine" => "Fine",
        _ => "",
    };
    let is = |d: &Direction| if kind == "segno" || kind == "coda" { d.kind == kind } else { d.kind == "words" && d.text.as_deref() == Some(text) };
    let mut dirs = m.directions.take().unwrap_or_default();
    if dirs.iter().any(is) {
        dirs.retain(|d| !is(d));
    } else {
        let at = if end { m.elements.len() as f64 } else { 0.0 };
        let d = if kind == "segno" || kind == "coda" {
            let mut d = Direction::of(kind);
            d.after_elements = Some(at);
            d.sound = Some(if kind == "segno" {
                Sound { segno: Some("segno".into()), ..Default::default() }
            } else {
                Sound { coda: Some("coda".into()), ..Default::default() }
            });
            d
        } else {
            let mut d = Direction::of("words");
            d.text = Some(text.into());
            d.after_elements = Some(at);
            d.sound = Some(match kind {
                "dc" => Sound { dacapo: Some(true), ..Default::default() },
                "ds" => Sound { dalsegno: Some("segno".into()), ..Default::default() },
                _ => Sound { fine: Some(true), ..Default::default() },
            });
            d
        };
        dirs.push(d);
    }
    m.directions = if dirs.is_empty() { None } else { Some(dirs) };
    ModelEdit::Select(vec![])
}

// ───────────────────────── 连音 ─────────────────────────

/// 连音的默认比例：二连、四连占 3，其余占小于 n 的最大 2 的幂（3→2、5→4、6→4、7→4），同 123 的表。
pub fn tuplet_normal(n: f64) -> f64 {
    if n == 2.0 || n == 4.0 {
        return 3.0;
    }
    let mut p = 1.0;
    while p * 2.0 < n {
        p *= 2.0;
    }
    p
}

/// 选中的几个音（同一小节、同一声线）做成连音，已经是同一组连音就拆回去。
pub fn toggle_tuplet(doc: &mut ScoreDoc, ids: &[ElementId], hooks: &mut dyn EditHooks) -> ModelEdit {
    let mut locs: Vec<ChordLoc> = chords_of(doc, ids).into_iter().filter(|l| l.chord(doc).grace.is_none()).collect();
    locs.sort_by_key(|l| l.index);
    if locs.len() < 2 {
        return err("ve.tupletTwo");
    }
    let f = locs[0];
    let fv = f.chord(doc).voice;
    if locs.iter().any(|l| l.mkey() != f.mkey() || l.chord(doc).voice != fv) {
        return err("me.tupletSame");
    }
    let (first, last) = (f.chord(doc).id, locs[locs.len() - 1].chord(doc).id);
    let mark = doc.songs[f.si].marks.iter().position(|m| m.kind == MarkType::Tuplet && m.start == first && m.end == last);
    if let Some(mk) = mark {
        // 拆回去：时值还原、去掉比例与括号
        for l in &locs {
            let Some(tm) = l.chord(doc).duration.time_mod.clone() else { continue };
            let want = (l.chord(doc).duration.divisions * tm.actual) / tm.normal;
            let v = fit_divisions(&mut doc.songs[l.si].parts[l.pi], want);
            let d = &mut l.chord_mut(doc).duration;
            d.divisions = v;
            d.time_mod = None;
        }
        doc.songs[f.si].marks.remove(mk);
    } else {
        if locs.iter().any(|l| l.chord(doc).duration.time_mod.is_some()) {
            return err("me.tupletAlready");
        }
        let n = locs.len() as f64;
        let normal = tuplet_normal(n);
        for l in &locs {
            // 放大单位（`fit_divisions` 可能整声部乘一倍）后再按当前值算，前面改过的也一起放大了，比例不变
            let want = (l.chord(doc).duration.divisions * normal) / n;
            let v = fit_divisions(&mut doc.songs[l.si].parts[l.pi], want);
            let d = &mut l.chord_mut(doc).duration;
            d.divisions = v;
            d.time_mod = Some(TimeMod { actual: n, normal, normal_type: None });
        }
        let mut mk = Mark::new(MarkType::Tuplet, first, last);
        mk.tuplet_actual = Some(n);
        mk.tuplet_normal = Some(normal);
        doc.songs[f.si].marks.push(mk);
    }
    let song = &doc.songs[f.si];
    let MeasureCtx { time, dpq, .. } = measure_ctx(song, &song.parts[f.pi], f.mi);
    let m = f.measure_mut(doc);
    rebeam(m, fv, time.as_ref(), dpq);
    m.duration = None;
    hooks.forget_layout(&doc.songs[f.si]);
    ModelEdit::Select(ids_of(doc, &locs))
}

// ───────────────────────── 歌词 ─────────────────────────

/// 同声部同声线、`l` 之前最近的一个和弦（找连字符的前一半）。
fn prev_in_voice(doc: &ScoreDoc, l: &ChordLoc) -> Option<ChordLoc> {
    let part = l.part(doc);
    let voice = l.chord(doc).voice;
    for mi in (0..=l.mi).rev() {
        let els = &part.measures[mi].elements;
        let to = if mi == l.mi { l.index } else { els.len() };
        for i in (0..to).rev() {
            if let Element::Chord(c) = &els[i] {
                if c.voice == voice && c.grace.is_none() {
                    return Some(ChordLoc { si: l.si, pi: l.pi, mi, index: i });
                }
            }
        }
    }
    None
}

fn hyphen_after(ly: Option<&Lyric>) -> bool {
    matches!(ly.and_then(|x| x.syllabic.as_ref()), Some(Syllabic::Begin) | Some(Syllabic::Middle))
}

/// 前面那个字接不接连字符变了：这个字的 syllabic 跟着改（自己后面接不接不变）
fn relink_syllabic(ly: Option<&mut Lyric>, joined_before: bool) {
    let Some(ly) = ly else { return };
    let hy = hyphen_after(Some(ly));
    ly.syllabic = Some(match (joined_before, hy) {
        (true, true) => Syllabic::Middle,
        (true, false) => Syllabic::End,
        (false, true) => Syllabic::Begin,
        (false, false) => Syllabic::Single,
    });
}

fn verse_lyric(doc: &mut ScoreDoc, l: Option<ChordLoc>, verse: f64) -> Option<&mut Lyric> {
    l?.chord_mut(doc).lyrics.as_mut()?.iter_mut().find(|x| x.number == verse)
}

/// 歌词录入：和弦 `id` 第 `verse` 段的字写成 `text`（空串 = 去掉这一段的字）。`hyphen` = 后面接连字符；`extend` = 一字多音的续线。
pub fn set_lyric(doc: &mut ScoreDoc, id: ElementId, verse: f64, text: &str, hyphen: bool, extend: bool) -> ModelEdit {
    let Some(l) = locate(doc, id) else { return err("me.noNote") };
    let rest: Vec<Lyric> = l.chord(doc).lyrics.iter().flatten().filter(|x| x.number != verse).cloned().collect();
    let prev = prev_in_voice(doc, &l);
    let next = next_in_voice(doc, &l);
    let cid = l.chord(doc).id;
    if text.is_empty() {
        l.chord_mut(doc).lyrics = if rest.is_empty() { None } else { Some(rest) };
        // 字去掉了：前一个字不再连到这儿、后一个字也不再接着这个字
        if let Some(p) = verse_lyric(doc, prev, verse) {
            if hyphen_after(Some(p)) {
                p.syllabic = Some(if p.syllabic == Some(Syllabic::Middle) { Syllabic::End } else { Syllabic::Single });
            }
        }
        relink_syllabic(verse_lyric(doc, next, verse), false);
        return ModelEdit::Select(vec![cid]);
    }
    let joined = hyphen_after(verse_lyric(doc, prev, verse).map(|x| &*x));
    relink_syllabic(verse_lyric(doc, next, verse), hyphen);
    let old = l.chord(doc).lyrics.iter().flatten().find(|x| x.number == verse).cloned();
    // `{ ...old, number, text, syllabic }`：新对象
    let mut ly = old.unwrap_or_default();
    ly.oid = Oid::NONE;
    ly.number = verse;
    ly.text = text.to_owned();
    ly.syllabic = Some(match (joined, hyphen) {
        (true, true) => Syllabic::Middle,
        (true, false) => Syllabic::End,
        (false, true) => Syllabic::Begin,
        (false, false) => Syllabic::Single,
    });
    ly.extend = if extend { Some(true) } else { None };
    ly.extend_type = None;
    let mut all = rest;
    all.push(ly);
    js::sort_by(&mut all, |a, b| a.number - b.number);
    l.chord_mut(doc).lyrics = Some(all);
    ModelEdit::Select(vec![cid])
}

/// 和弦名录入：和弦 `id` 的和弦名写成 `text`（空串 = 去掉）。只记原文，结构由写出端按文字解析。
pub fn set_harmony(doc: &mut ScoreDoc, id: ElementId, text: &str) -> ModelEdit {
    let Some(l) = locate(doc, id) else { return err("me.noNote") };
    let c = l.chord_mut(doc);
    c.harmony = if text.is_empty() {
        None
    } else {
        Some(Harmony { root: HarmonyStep { step: "C".into(), alter: 0.0, alter_left: None }, kind: String::new(), text: Some(text.into()), ..Default::default() })
    };
    ModelEdit::Select(vec![c.id])
}

/// 文字 / 力度录入：和弦 `id` 前面挂一条 `<direction>`（文字在上方、力度在下方）；`text` 空串 = 去掉。
pub fn set_direction_text(doc: &mut ScoreDoc, id: ElementId, kind: &str, text: &str) -> ModelEdit {
    let Some(l) = locate(doc, id) else { return err("me.noNote") };
    let (voice, staff, cid) = {
        let c = l.chord(doc);
        (c.voice, c.staff, c.id)
    };
    let idx = l.index as f64;
    let m = l.measure_mut(doc);
    let mut rest: Vec<Direction> = m
        .directions
        .take()
        .unwrap_or_default()
        .into_iter()
        .filter(|d| !(d.kind == kind && d.after_elements.unwrap_or(0.0) == idx && d.voice.is_none_or(|v| v == voice)))
        .collect();
    if !text.is_empty() {
        let mut d = Direction::of(kind);
        d.text = Some(text.into());
        d.after_elements = Some(idx);
        d.placement = Some(if kind == "dynamics" { Placement::Below } else { Placement::Above });
        d.voice = Some(voice);
        d.staff = Some(staff);
        rest.push(d);
    }
    m.directions = if rest.is_empty() { None } else { Some(rest) };
    ModelEdit::Select(vec![cid])
}

/// 和弦 `id` 前面那条文字 / 力度现在的值。
pub fn direction_text_of(doc: &ScoreDoc, id: ElementId, kind: &str) -> String {
    let Some(l) = locate(doc, id) else { return String::new() };
    let idx = l.index as f64;
    l.measure(doc)
        .directions
        .iter()
        .flatten()
        .find(|x| x.kind == kind && x.after_elements.unwrap_or(0.0) == idx)
        .and_then(|d| d.text.clone())
        .unwrap_or_default()
}

// ───────────────────────── 剪贴板 ─────────────────────────

/// 剪贴板里的一样东西：与格式无关。音按唱名记（相对调号），时值按简谱口径（减时线条数 + 附点，四分以上拆成增时线）。
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClipItem {
    Note { degree: f64, octave: f64, acc: Option<Accidental>, halvings: f64, dots: f64 },
    Sustain,
    Bar,
}

fn halvings_of(t: &NoteType) -> Option<f64> {
    match t {
        NoteType::Quarter => Some(0.0),
        NoteType::Eighth => Some(1.0),
        NoteType::N16th => Some(2.0),
        NoteType::N32nd => Some(3.0),
        NoteType::N64th => Some(4.0),
        _ => None,
    }
}

/// 选中的和弦 → 剪贴板（和弦取最上面那个音；连音、写不出的时值按最近的四分拍数拆）。
pub fn clip_of_chords(doc: &ScoreDoc, ids: &[ElementId]) -> Vec<ClipItem> {
    let mut out = vec![];
    for l in chords_of(doc, ids) {
        let MeasureCtx { key, dpq, .. } = ctx_of(doc, &l);
        let ch = l.chord(doc);
        let top = top_note(ch).map(|i| &ch.notes[i]);
        let d = top.and_then(|n| n.pitch.as_ref().map(|p| degree_from_pitch(p, &key, n.accidental.clone())));
        let t = type_of_divisions(ch.duration.divisions, dpq);
        let h = t.as_ref().and_then(|(ty, _)| halvings_of(ty));
        let (mut halvings, mut dots, mut sustains) = (0.0, 0.0, 0.0);
        match (t, h) {
            (Some((_, d)), Some(h)) => {
                halvings = h;
                dots = d;
            }
            _ => sustains = js::max(0.0, js::round(ch.duration.divisions / dpq) - 1.0),
        }
        out.push(ClipItem::Note {
            degree: d.as_ref().map_or(0.0, |d| d.number),
            octave: d.as_ref().map_or(0.0, |d| d.octave_shift),
            acc: d.and_then(|d| d.accidental),
            halvings,
            dots,
        });
        let mut k = 0.0;
        while k < sustains {
            out.push(ClipItem::Sustain);
            k += 1.0;
        }
    }
    out
}

/// 剪贴板贴到锚点处（同一声线、接着往后插）；增时线并进前一个音（多一拍），小节线不贴。返回贴进来的那些音。
pub fn paste_clip(doc: &mut ScoreDoc, anchor: &InsertAnchor, items: &[ClipItem], hooks: &mut dyn EditHooks) -> ModelEdit {
    let mut at = anchor.clone();
    let mut last: Option<ElementId> = None;
    let mut added: Vec<ElementId> = vec![];
    for it in items {
        match it {
            ClipItem::Bar => continue,
            ClipItem::Sustain => {
                if let Some(id) = last {
                    let r = add_beat(doc, id, hooks);
                    if matches!(r, ModelEdit::Error(_)) {
                        return r;
                    }
                }
            }
            ClipItem::Note { degree, octave, acc, halvings, dots } => {
                let r = insert_chord(doc, &at, *degree, NewDuration { halvings: *halvings, dots: *dots }, hooks);
                let ModelEdit::CaretAfter(id) = r else { return r };
                last = Some(id);
                added.push(id);
                if *degree > 0.0 {
                    let l = locate(doc, id).expect("刚插的音");
                    let key = ctx_of(doc, &l).key;
                    if let Some(p) = pitch_of_degree(*degree, *octave, &key, acc.clone()) {
                        l.chord_mut(doc).notes = vec![Note { pitch: Some(p), ..Default::default() }];
                    }
                    touched(doc, &[l], hooks);
                }
                at = InsertAnchor::After(id);
            }
        }
    }
    if added.is_empty() {
        err("me.clipNoNotes")
    } else {
        ModelEdit::Select(added)
    }
}

// ───────────────────────── 识别修正：重读与挪动 ─────────────────────────
//
// 识谱软件里改谱号、改调号是**纠正认错**（默认符头不动、按新谱号 / 调号重读音高），与打谱软件的「保音高、挪符头」相反，
// 两种都给（`reread`）。挪动类（连线端点、力度文字、和弦名、歌词）一次挪一个音。

fn diatonic(s: &Step) -> f64 {
    STEPS.iter().position(|x| x == s).map_or(f64::NAN, |i| i as f64)
}

fn acc_alter(a: &Accidental) -> f64 {
    match a {
        Accidental::DoubleFlat => -2.0,
        Accidental::Flat => -1.0,
        Accidental::Natural => 0.0,
        Accidental::Sharp => 1.0,
        Accidental::DoubleSharp => 2.0,
        // TS 查表落空是 undefined
        Accidental::Other(_) => f64::NAN,
    }
}

/// 谱号最下面那条线是第几个自然音级（八度 × 7 + 音级）：G 谱号第二线 G4、F 谱号第四线 F3、C 谱号第三线 C4。
fn clef_bottom(c: &Clef) -> f64 {
    let (r, l) = match c.sign {
        ClefSign::F => (3.0 * 7.0 + 3.0, 4.0),
        ClefSign::C => (4.0 * 7.0, 3.0),
        _ => (4.0 * 7.0 + 4.0, 2.0),
    };
    let line = c.line.unwrap_or(l);
    r + 7.0 * c.octave_change.unwrap_or(0.0) - 2.0 * (line - 1.0)
}

fn staff_of_clef(c: &Clef) -> f64 {
    c.staff.unwrap_or(1.0)
}

/// 第 `mi` 小节开头第 `staff` 谱表生效的谱号（含本小节 `attrs`、不含小节中间的）。
fn clef_at(part: &Part, mi: usize, staff: f64) -> Clef {
    let mut cur = Clef { sign: ClefSign::G, line: Some(2.0), octave_change: None, staff: None };
    for i in 0..=mi.min(part.measures.len().saturating_sub(1)) {
        if i >= part.measures.len() {
            break;
        }
        if i > 0 {
            for la in part.measures[i - 1].later_attrs.iter().flatten() {
                for c in la.attrs.clefs.iter().flatten() {
                    if staff_of_clef(c) == staff {
                        cur = c.clone();
                    }
                }
            }
        }
        for c in part.measures[i].attrs.iter().flat_map(|a| a.clefs.iter().flatten()) {
            if staff_of_clef(c) == staff {
                cur = c.clone();
            }
        }
    }
    cur
}

/// 重读一小节里（某谱表上、`keep` 放行的）音的升降：印了临时记号的照记号，没印的按本小节前面同音级同八度印过的、
/// 再按延音线接过来的（`carry`），最后按调号。返回本小节末仍连着的音，给下一小节当 `carry`。
fn reread_alters(m: &mut Measure, key: &Key, staff: Option<f64>, keep: impl Fn(f64) -> bool, carry: &HashMap<String, f64>) -> HashMap<String, f64> {
    let at = onsets(m);
    // (起点, 元素序, 元素下标, 音下标, 谱表)
    let mut items: Vec<(f64, usize, usize, usize, f64)> = vec![];
    for (order, el) in m.elements.iter().enumerate() {
        let Element::Chord(c) = el else { continue };
        if staff.is_some_and(|s| c.staff != s) {
            continue;
        }
        for (ni, n) in c.notes.iter().enumerate() {
            if n.pitch.is_some() {
                items.push((at.get(&order).copied().unwrap_or(0.0), order, order, ni, c.staff));
            }
        }
    }
    js::sort_by(&mut items, |a, b| {
        let d = a.0 - b.0;
        if d != 0.0 && !d.is_nan() {
            d
        } else {
            a.1 as f64 - b.1 as f64
        }
    });
    let mut state: HashMap<String, f64> = HashMap::new();
    let mut out: HashMap<String, f64> = HashMap::new();
    for &(t, _, ei, ni, st) in &items {
        let Element::Chord(c) = &mut m.elements[ei] else { continue };
        let n = &mut c.notes[ni];
        let p = n.pitch.as_ref().unwrap();
        let k = format!("{}:{}:{}", js::num_to_string(st), p.step.as_str(), js::num_to_string(p.octave));
        if keep(t) {
            let alter = match &n.accidental {
                Some(a) => acc_alter(a),
                None => {
                    let stop = n.tie.as_ref().is_some_and(|x| x.stop == Some(true));
                    match carry.get(&k) {
                        Some(&v) if stop => v,
                        _ => state.get(&k).copied().unwrap_or_else(|| key_alter(p.step.as_str(), key.fifths)),
                    }
                }
            };
            n.pitch.as_mut().unwrap().alter = alter;
        }
        let alter = n.pitch.as_ref().unwrap().alter;
        state.insert(k.clone(), alter);
        if n.tie.as_ref().is_some_and(|x| x.start == Some(true)) {
            out.insert(k, alter);
        }
    }
    out
}

/// 换谱号：第 `pi` 声部第 `staff` 谱表自第 `mi` 小节起改成 `clef`，到这一谱表下一次换谱号为止。
/// `reread`：符头在谱表上的位置不动、按新谱号重读音高（识别认错谱号的纠正）；否则音高不动。
#[allow(clippy::too_many_arguments)]
pub fn set_clef_at(doc: &mut ScoreDoc, si: usize, pi: usize, mi: usize, staff: f64, clef: &Clef, reread: bool, hooks: &mut dyn EditHooks) -> ModelEdit {
    let Some(part) = doc.songs.get(si).and_then(|s| s.parts.get(pi)) else { return err("me.noMeasure") };
    if part.measures.get(mi).is_none() {
        return err("me.noMeasure");
    }
    let old = clef_at(part, mi, staff);
    let mut nc = clef.clone();
    if staff > 1.0 || part.staff_count.unwrap_or(1.0) > 1.0 {
        nc.staff = Some(staff);
    }
    let m0 = &mut doc.songs[si].parts[pi].measures[mi];
    let mut a = m0.attrs.clone().unwrap_or_default();
    a.oid = Oid::NONE;
    let mut clefs: Vec<Clef> = a.clefs.take().unwrap_or_default().into_iter().filter(|c| staff_of_clef(c) != staff).collect();
    clefs.push(nc.clone());
    a.clefs = Some(clefs);
    m0.attrs = Some(a);
    if reread {
        let shift = clef_bottom(&nc) - clef_bottom(&old);
        let mut carry: HashMap<String, f64> = HashMap::new();
        let n = doc.songs[si].parts[pi].measures.len();
        for i in mi..n {
            let song = &doc.songs[si];
            let m = &song.parts[pi].measures[i];
            if i > mi && m.attrs.as_ref().and_then(|a| a.clefs.as_ref()).is_some_and(|cs| cs.iter().any(|c| staff_of_clef(c) == staff)) {
                break;
            }
            // 小节中间换了这一谱表的谱号：那之后的音不归这一段
            let cut: Vec<f64> = m
                .later_attrs
                .iter()
                .flatten()
                .filter(|la| la.attrs.clefs.as_ref().is_some_and(|cs| cs.iter().any(|c| staff_of_clef(c) == staff)))
                .map(|la| la.onset.unwrap_or_else(|| default_onset_before(m, la.after_elements)))
                .collect();
            let stop = if cut.is_empty() { f64::INFINITY } else { cut.iter().copied().fold(f64::INFINITY, js::min) };
            let key = measure_ctx(song, &song.parts[pi], i).key;
            let at = onsets(m);
            let m = &mut doc.songs[si].parts[pi].measures[i];
            for (ei, el) in m.elements.iter_mut().enumerate() {
                let Element::Chord(c) = el else { continue };
                if c.staff != staff || at.get(&ei).copied().unwrap_or(0.0) >= stop {
                    continue;
                }
                for nt in &mut c.notes {
                    let Some(p) = &nt.pitch else { continue };
                    let d = p.octave * 7.0 + diatonic(&p.step) + shift;
                    let idx = ((d % 7.0) + 7.0) % 7.0;
                    let step = js::index(idx).and_then(|i| STEPS.get(i)).cloned().unwrap_or(Step::C);
                    nt.pitch = Some(Pitch { step, alter: p.alter, octave: (d / 7.0).floor() });
                }
                hooks.forget_stem(c);
            }
            // 印出来的临时记号就是谱面上的，重读不改它的印法（不跑 `respell_measure`）
            carry = reread_alters(m, &key, Some(staff), |t| t < stop, &carry);
            if stop != f64::INFINITY {
                break;
            }
        }
    }
    hooks.forget_layout(&doc.songs[si]);
    ModelEdit::Select(vec![])
}

/// 换调号并**重读**：自第 `mi` 小节起各声部改成 `fifths`，到下一次换调号为止，没印临时记号的音按新调号重读升降。
pub fn reread_key_at(doc: &mut ScoreDoc, si: usize, mi: usize, fifths: f64, hooks: &mut dyn EditHooks) -> ModelEdit {
    let Some(song) = doc.songs.get_mut(si) else { return err("me.noMeasure") };
    for pi in 0..song.parts.len() {
        let Some(m0) = song.parts[pi].measures.get_mut(mi) else { continue };
        let mut a = m0.attrs.clone().unwrap_or_default();
        a.oid = Oid::NONE;
        let mut k = a.key.clone().unwrap_or_else(|| fifths_key(fifths));
        k.fifths = fifths;
        a.key = Some(k);
        m0.attrs = Some(a);
        if mi == 0 {
            let mut k = song.key.clone().unwrap_or_else(|| fifths_key(fifths));
            k.fifths = fifths;
            song.key = Some(k);
        }
        let mut carry: HashMap<String, f64> = HashMap::new();
        for i in mi..song.parts[pi].measures.len() {
            if i > mi && song.parts[pi].measures[i].attrs.as_ref().is_some_and(|a| a.key.is_some()) {
                break;
            }
            let key = measure_ctx(song, &song.parts[pi], i).key;
            let m = &mut song.parts[pi].measures[i];
            carry = reread_alters(m, &key, None, |_| true, &carry);
            for el in &m.elements {
                if let Element::Chord(c) = el {
                    hooks.forget_stem(c);
                }
            }
        }
    }
    hooks.forget_layout(&doc.songs[si]);
    ModelEdit::Select(vec![])
}

/// 同一声部同一声线里 `l` 前 / 后第 |`delta`| 个和弦（可跨小节；`skip` 放过的不算，如休止、倚音）。
fn step_in_voice(doc: &ScoreDoc, l: &ChordLoc, delta: f64, skip: impl Fn(&Chord) -> bool) -> Option<ChordLoc> {
    let part = l.part(doc);
    let voice = l.chord(doc).voice;
    let dir: isize = if delta > 0.0 { 1 } else { -1 };
    let mut cur = *l;
    let mut n = delta.abs();
    while n > 0.0 {
        let mut mi = cur.mi as isize;
        let mut i = cur.index as isize + dir;
        let found;
        loop {
            let m = &part.measures[mi as usize];
            if i < 0 || i >= m.elements.len() as isize {
                mi += dir;
                if mi < 0 || mi as usize >= part.measures.len() {
                    return None;
                }
                i = if dir > 0 { 0 } else { part.measures[mi as usize].elements.len() as isize - 1 };
                continue;
            }
            if let Element::Chord(e) = &m.elements[i as usize] {
                if e.voice == voice && !skip(e) {
                    found = ChordLoc { si: l.si, pi: l.pi, mi: mi as usize, index: i as usize };
                    break;
                }
            }
            i += dir;
        }
        cur = found;
        n -= 1.0;
    }
    Some(cur)
}

/// 先后：同一声部里谁在前（小节、小节内下标）。
fn loc_before(a: &ChordLoc, b: &ChordLoc) -> bool {
    a.mi < b.mi || (a.mi == b.mi && a.index < b.index)
}

/// 选中的记号挪了之后要选回它：挂在哪个和弦上、是什么。
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum MovedMark {
    Mark {
        mark_on: ElementId,
        kind: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        dir_type: Option<String>,
    },
    Lyric {
        lyric_of: ElementId,
        verse: f64,
    },
}

/// 连线一端挪一个音：`which` 哪一端（start / end / both）、`delta` 往后 +1 / 往前 −1。挪到的音不能越过另一端；延音线不挪。
pub fn move_mark_end(doc: &mut ScoreDoc, kind: &MarkType, start_id: ElementId, end_id: ElementId, which: &str, delta: f64) -> ModelEdit {
    let (Some(a), Some(b)) = (locate(doc, start_id), locate(doc, end_id)) else { return err("me.noNote") };
    let Some(mk) = doc.songs[a.si].marks.iter().position(|m| m.kind == *kind && m.start == start_id && m.end == end_id) else { return err("me.noMark") };
    if *kind == MarkType::Tied {
        return err("me.tieNoMove");
    }
    let skip = |c: &Chord| c.grace.is_some() || c.rest.is_some();
    let (mut na, mut nb) = (a, b);
    if which != "end" {
        let Some(x) = step_in_voice(doc, &a, delta, skip) else { return err("me.noNeighbour") };
        na = x;
    }
    if which != "start" {
        let Some(x) = step_in_voice(doc, &b, delta, skip) else { return err("me.noNeighbour") };
        nb = x;
    }
    if !loc_before(&na, &nb) {
        return err("me.markCollapse");
    }
    let (ia, ib) = (na.chord(doc).id, nb.chord(doc).id);
    let m = &mut doc.songs[a.si].marks[mk];
    m.start = ia;
    m.end = ib;
    m.start_note = None;
    m.end_note = None;
    ModelEdit::Moved { select: vec![ia, ib], moved: MovedMark::Mark { mark_on: ia, kind: "slur".into(), dir_type: None } }
}

/// 小节里第 `i` 个元素之前、按写出端的游标（文档序）缺省落在哪一刻。
fn default_onset_before(m: &Measure, i: f64) -> f64 {
    let mut cursor = 0.0;
    for (k, el) in m.elements.iter().enumerate() {
        if (k as f64) >= i {
            break;
        }
        let start = el.onset().unwrap_or(cursor);
        cursor = start
            + match el {
                Element::Chord(c) => {
                    if c.grace.is_some() {
                        0.0
                    } else {
                        c.duration.divisions
                    }
                }
                Element::Space(s) => s.duration.as_ref().map_or(0.0, |d| d.divisions),
            };
    }
    cursor
}

/// 一条 `<direction>` 的位置：第几首、第几声部、第几小节、`directions` 里第几条。
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DirRef {
    pub si: usize,
    pub pi: usize,
    pub mi: usize,
    pub index: usize,
}

impl DirRef {
    fn dir<'a>(&self, doc: &'a ScoreDoc) -> Option<&'a Direction> {
        doc.songs.get(self.si)?.parts.get(self.pi)?.measures.get(self.mi)?.directions.as_ref()?.get(self.index)
    }
}

struct DirAnchor {
    loc: ChordLoc,
    at_end: bool,
}

/// 这条记号挂在哪个音前；`at_end`：挂在小节里最后一个（同声线）和弦**之后**，`loc` 借那最后一个和弦。
fn dir_anchor(doc: &ScoreDoc, r: &DirRef) -> Option<DirAnchor> {
    let dir = r.dir(doc)?;
    let m = &doc.songs[r.si].parts[r.pi].measures[r.mi];
    let len = m.elements.len() as f64;
    let ae = dir.after_elements.unwrap_or(0.0);
    let k = js::min(ae, len - 1.0);
    let loc = |i: usize| ChordLoc { si: r.si, pi: r.pi, mi: r.mi, index: i };
    let fits = |e: &Element| matches!(e, Element::Chord(c) if dir.voice.is_none_or(|v| c.voice == v));
    let start = if k > 0.0 { k.ceil() as usize } else { 0 };
    for (i, e) in m.elements.iter().enumerate().skip(start) {
        if (i as f64) < k {
            continue;
        }
        if fits(e) {
            return Some(DirAnchor { loc: loc(i), at_end: ae > i as f64 });
        }
    }
    for i in (0..m.elements.len()).rev() {
        if fits(&m.elements[i]) {
            return Some(DirAnchor { loc: loc(i), at_end: true });
        }
    }
    for i in (0..m.elements.len()).rev() {
        if matches!(m.elements[i], Element::Chord(_)) {
            return Some(DirAnchor { loc: loc(i), at_end: true });
        }
    }
    None
}

/// 挂点在声部里的先后：挂在第 `index` 个元素前为 `index`，挂在它之后（小节末）再加半格。
fn dir_pos(loc: &ChordLoc, at_end: bool) -> f64 {
    loc.mi as f64 * 1e6 + loc.index as f64 + if at_end { 0.5 } else { 0.0 }
}

/// 把 `from` 那条 `<direction>` 挂到 `to` 那个和弦前（可换小节）。返回它挪到的位置。
fn place_direction(doc: &mut ScoreDoc, from: DirRef, to: &ChordLoc) -> DirRef {
    let fm = &mut doc.songs[from.si].parts[from.pi].measures[from.mi];
    let mut dirs = fm.directions.take().unwrap_or_default();
    let mut dir = dirs.remove(from.index);
    fm.directions = if dirs.is_empty() { None } else { Some(dirs) };
    dir.after_elements = Some(to.index as f64);
    dir.offset = None;
    let tm = to.measure(doc);
    let want = onsets(tm).get(&to.index).copied().unwrap_or(0.0);
    dir.onset = if want == default_onset_before(tm, to.index as f64) { None } else { Some(want) };
    let list = to.measure_mut(doc).directions.get_or_insert_with(Vec::new);
    list.push(dir);
    DirRef { si: to.si, pi: to.pi, mi: to.mi, index: list.len() - 1 }
}

/// 力度、表情文字、速度、渐强渐弱的一端挪一个音：`delta` +1 往后、−1 往前，`by_measure` 时挪到前 / 后一小节的同一拍。
/// `pair` 给了就两条一起挪（整条挪）；只挪一端时与另一端（`guard`）比，不能越过。
pub fn move_direction(doc: &mut ScoreDoc, r: DirRef, delta: f64, by_measure: bool, pair: Option<DirRef>, guard: Option<DirRef>) -> ModelEdit {
    let refs: Vec<DirRef> = std::iter::once(r).chain(pair).collect();
    let anchors: Vec<Option<DirAnchor>> = refs.iter().map(|x| dir_anchor(doc, x)).collect();
    if anchors.iter().any(|x| x.is_none()) {
        return err("me.noMark");
    }
    let anchors: Vec<DirAnchor> = anchors.into_iter().flatten().collect();
    let mut targets: Vec<ChordLoc> = vec![];
    for an in &anchors {
        let to = if by_measure {
            let mi = an.loc.mi as f64 + delta;
            let part = an.loc.part(doc);
            let Some(m) = js::index(mi).and_then(|i| part.measures.get(i)) else { return err("me.noNeighbour") };
            let mi = mi as usize;
            let want = onsets(an.loc.measure(doc)).get(&an.loc.index).copied().unwrap_or(0.0);
            let voice = an.loc.chord(doc).voice;
            let os = onsets(m);
            let mut best = None;
            let mut bd = f64::INFINITY;
            for (i, e) in m.elements.iter().enumerate() {
                let Element::Chord(c) = e else { continue };
                if c.grace.is_some() || c.voice != voice {
                    continue;
                }
                let d = (os.get(&i).copied().unwrap_or(0.0) - want).abs();
                if d < bd {
                    bd = d;
                    best = Some(ChordLoc { mi, index: i, ..an.loc });
                }
            }
            best
        } else {
            // 挂在最后一个音之后的（小节末）：往后挪是挂到后面第 delta 个音前，往前挪一格是挂到最后那个音前
            let steps = if an.at_end && delta <= 0.0 { delta + 1.0 } else { delta };
            if steps == 0.0 {
                Some(an.loc)
            } else {
                step_in_voice(doc, &an.loc, steps, |c| c.grace.is_some())
            }
        };
        let Some(to) = to else { return err("me.noNeighbour") };
        targets.push(to);
    }
    if pair.is_some() && !loc_before(&targets[0], &targets[1]) && targets[0] != targets[1] {
        return err("me.markCollapse");
    }
    if let Some(g) = guard {
        let is_start = r.dir(doc).and_then(|d| d.span_type.as_ref()) == Some(&SpanType::Start);
        if let Some(other) = dir_anchor(doc, &g) {
            let mine = dir_pos(&targets[0], false);
            let theirs = dir_pos(&other.loc, other.at_end);
            if if is_start { mine >= theirs } else { mine <= theirs } {
                return err("me.markCollapse");
            }
        }
    }
    let dir_type = r.dir(doc).map(|d| d.kind.clone()).unwrap_or_default();
    // 依次挪；前一条从同一小节摘走时，后一条的下标跟着前移
    let mut pending = refs.clone();
    for k in 0..pending.len() {
        let from = pending[k];
        place_direction(doc, from, &targets[k]);
        for p in pending.iter_mut().skip(k + 1) {
            if (p.si, p.pi, p.mi) == (from.si, from.pi, from.mi) && p.index > from.index {
                p.index -= 1;
            }
        }
    }
    let id = targets[0].chord(doc).id;
    ModelEdit::Moved { select: vec![id], moved: MovedMark::Mark { mark_on: id, kind: "dir".into(), dir_type: Some(dir_type) } }
}

/// 和弦名挪一个音（同声线，休止也能挂）；那个音已有和弦名就拒绝。
pub fn move_harmony(doc: &mut ScoreDoc, id: ElementId, delta: f64) -> ModelEdit {
    let Some(l) = locate(doc, id).filter(|l| l.chord(doc).harmony.is_some()) else { return err("me.noMark") };
    let Some(to) = step_in_voice(doc, &l, delta, |c| c.grace.is_some()) else { return err("me.noNeighbour") };
    if to.chord(doc).harmony.is_some() {
        return err("me.harmonyTaken");
    }
    let mut h = l.chord_mut(doc).harmony.take();
    if let Some(h) = &mut h {
        h.onset = None;
        h.offset = None;
    }
    let t = to.chord_mut(doc);
    t.harmony = h;
    let tid = t.id;
    ModelEdit::Moved { select: vec![tid], moved: MovedMark::Mark { mark_on: tid, kind: "harmony".into(), dir_type: None } }
}

/// 歌词挪格：`delta` +1 = 在这个字前空出一格，这个字连同后面紧接着的字各往后挪一个音，挪到本段第一个空着的音为止；
/// −1 = 前一个音空着时，这个字连同后面紧接着的字各往前挪一格。`count`：只挪从这个字起的几个字。
pub fn shift_lyrics(doc: &mut ScoreDoc, id: ElementId, verse: f64, delta: f64, count: Option<f64>) -> ModelEdit {
    let mut at = id;
    let mut last = err("me.noLyric");
    let mut n = delta.abs();
    while n > 0.0 {
        last = shift_lyrics_once(doc, at, verse, if delta > 0.0 { 1.0 } else { -1.0 }, count);
        match &last {
            ModelEdit::Error(_) => return last,
            ModelEdit::Moved { moved: MovedMark::Lyric { lyric_of, .. }, .. } => at = *lyric_of,
            _ => {}
        }
        n -= 1.0;
    }
    last
}

fn shift_lyrics_once(doc: &mut ScoreDoc, id: ElementId, verse: f64, delta: f64, count: Option<f64>) -> ModelEdit {
    let Some(l) = locate(doc, id) else { return err("me.noNote") };
    let voice = l.chord(doc).voice;
    let mut seq: Vec<ChordLoc> = vec![];
    for (mi, m) in l.part(doc).measures.iter().enumerate() {
        for (i, e) in m.elements.iter().enumerate() {
            let Element::Chord(c) = e else { continue };
            if c.voice != voice || c.grace.is_some() {
                continue;
            }
            let anchor = c.lyric_anchor.unwrap_or(c.rest.is_none() || c.lyrics.as_ref().is_some_and(|x| !x.is_empty()));
            if anchor {
                seq.push(ChordLoc { si: l.si, pi: l.pi, mi, index: i });
            }
        }
    }
    let has = |doc: &ScoreDoc, c: Option<&ChordLoc>| c.is_some_and(|c| c.chord(doc).lyrics.iter().flatten().any(|x| x.number == verse));
    let Some(k) = seq.iter().position(|x| *x == l) else { return err("me.noLyric") };
    if !has(doc, Some(&l)) {
        return err("me.noLyric");
    }
    let take = |doc: &mut ScoreDoc, c: &ChordLoc| -> Lyric {
        let ch = c.chord_mut(doc);
        let mut list = ch.lyrics.take().unwrap_or_default();
        let i = list.iter().position(|x| x.number == verse).expect("有这一段的字");
        let ly = list.remove(i);
        ch.lyrics = if list.is_empty() { None } else { Some(list) };
        ly
    };
    let put = |doc: &mut ScoreDoc, c: &ChordLoc, ly: Lyric| {
        let ch = c.chord_mut(doc);
        let mut list = ch.lyrics.take().unwrap_or_default();
        list.push(ly);
        js::sort_by(&mut list, |a, b| a.number - b.number);
        ch.lyrics = Some(list);
    };
    let mut j = k;
    let lim = match count {
        Some(c) if c > 0.0 => k as f64 + c - 1.0,
        _ => f64::INFINITY,
    };
    while j + 1 < seq.len() && has(doc, seq.get(j + 1)) && ((j as f64) < lim || delta > 0.0) {
        j += 1;
    }
    if delta > 0.0 {
        if j + 1 >= seq.len() {
            return err("me.lyricNoRoom");
        }
        for i in (k..=j).rev() {
            let ly = take(doc, &seq[i]);
            put(doc, &seq[i + 1], ly);
        }
        let id = seq[k + 1].chord(doc).id;
        return ModelEdit::Moved { select: vec![id], moved: MovedMark::Lyric { lyric_of: id, verse } };
    }
    if k == 0 || has(doc, seq.get(k - 1)) {
        return err("me.lyricNoRoom");
    }
    for i in k..=j {
        let ly = take(doc, &seq[i]);
        put(doc, &seq[i - 1], ly);
    }
    let id = seq[k - 1].chord(doc).id;
    ModelEdit::Moved { select: vec![id], moved: MovedMark::Lyric { lyric_of: id, verse } }
}

/// 倚音 ↔ 正音：倚音改成正音按它印的时值占拍；正音改成倚音不占拍（照印的时值，八分的带斜线）。
pub fn toggle_grace(doc: &mut ScoreDoc, ids: &[ElementId], hooks: &mut dyn EditHooks) -> ModelEdit {
    let locs: Vec<ChordLoc> = chords_of(doc, ids).into_iter().filter(|l| l.chord(doc).rest.is_none()).collect();
    if locs.is_empty() {
        return err("ve.selectNote");
    }
    let on = locs.iter().all(|l| l.chord(doc).grace.is_some());
    for l in &locs {
        let dpq = ctx_of(doc, l).dpq;
        if on {
            let (kind, dots) = {
                let c = l.chord_mut(doc);
                c.grace = None;
                (c.duration.kind.clone().unwrap_or(NoteType::Eighth), c.duration.dots)
            };
            let base = TYPES.iter().find(|(t, _)| *t == kind).map_or(0.5, |x| x.1);
            let div = fit_divisions(&mut doc.songs[l.si].parts[l.pi], base * dpq * dot_factor(dots));
            l.chord_mut(doc).duration.divisions = div;
        } else {
            let c = l.chord_mut(doc);
            c.grace = Some(if c.duration.kind == Some(NoteType::Eighth) { GraceInfo { slash: Some(true), ..Default::default() } } else { GraceInfo::default() });
            if c.duration.kind.is_none() {
                c.duration.kind = Some(NoteType::Eighth);
            }
        }
        let MeasureCtx { time, dpq, .. } = ctx_of(doc, l);
        let voice = l.chord(doc).voice;
        let m = l.measure_mut(doc);
        rebeam(m, voice, time.as_ref(), dpq);
        m.duration = None;
    }
    for si in songs_of(&locs) {
        hooks.forget_layout(&doc.songs[si]);
    }
    ModelEdit::Select(ids_of(doc, &locs))
}

/// 符杠组：选中音所在的那一组连杠的音（同小节同声线、`beams` 连着的一串）。原文没写 `<beam>` 时按 `rebeam` 同一口径划。
pub fn beam_group_of(doc: &ScoreDoc, id: ElementId) -> Vec<ElementId> {
    let Some(l) = locate(doc, id) else { return vec![] };
    let me = l.chord(doc);
    let m = l.measure(doc);
    let run: Vec<(usize, &Chord)> =
        m.elements.iter().enumerate().filter_map(|(i, e)| e.as_chord().filter(|c| c.voice == me.voice && c.grace.is_none()).map(|c| (i, c))).collect();
    let Some(k) = run.iter().position(|(i, _)| *i == l.index) else { return vec![me.id] };
    let has_beams = |c: &Chord| c.beams.as_ref().is_some_and(|b| !b.is_empty());
    let ids = |a: usize, b: usize| run[a..=b].iter().map(|(_, c)| c.id).collect::<Vec<_>>();
    if run.iter().any(|(_, c)| has_beams(c)) {
        if !has_beams(me) {
            return vec![me.id];
        }
        let first = |c: &Chord| c.beams.as_ref().and_then(|b| b.first()).cloned();
        let mut a = k;
        while a > 0 && first(run[a].1) != Some(BeamVal::Begin) && has_beams(run[a - 1].1) {
            a -= 1;
        }
        let mut b = k;
        while b + 1 < run.len() && first(run[b].1) != Some(BeamVal::End) && has_beams(run[b + 1].1) {
            b += 1;
        }
        return ids(a, b);
    }
    let MeasureCtx { time, dpq, .. } = ctx_of(doc, &l);
    let group = match &time {
        Some(t) if t.beat_type == 8.0 && t.beats % 3.0 == 0.0 => dpq * 1.5,
        _ => dpq,
    };
    let os = onsets(m);
    let flagged = |c: &Chord| c.rest.is_none() && c.duration.time_mod.is_none() && c.duration.divisions < dpq;
    if !flagged(me) {
        return vec![me.id];
    }
    let beat = |i: usize| (os.get(&i).copied().unwrap_or(0.0) / group).floor();
    let mine = beat(l.index);
    let mut a = k;
    while a > 0 && flagged(run[a - 1].1) && beat(run[a - 1].0) == mine {
        a -= 1;
    }
    let mut b = k;
    while b + 1 < run.len() && flagged(run[b + 1].1) && beat(run[b + 1].0) == mine {
        b += 1;
    }
    ids(a, b)
}

/// 删掉某声部里的几条 direction（按位置；删空的小节去掉 `directions`）。
fn remove_dirs(part: &mut Part, gone: &[(usize, usize)]) {
    for (mi, m) in part.measures.iter_mut().enumerate() {
        if !gone.iter().any(|g| g.0 == mi) {
            continue;
        }
        let Some(list) = m.directions.take() else { continue };
        let keep: Vec<Direction> = list.into_iter().enumerate().filter(|(i, _)| !gone.contains(&(mi, *i))).map(|(_, d)| d).collect();
        m.directions = if keep.is_empty() { None } else { Some(keep) };
    }
}

/// 渐强 / 渐弱：选中的头尾两个音之间加一条（起点挂头一个音前、终点挂尾一个音后）。已有同起点的就去掉。
pub fn toggle_wedge(doc: &mut ScoreDoc, first_id: ElementId, last_id: ElementId, kind: &WedgeType) -> ModelEdit {
    let (Some(a), Some(b)) = (locate(doc, first_id), locate(doc, last_id)) else { return err("me.noNote") };
    if a.pi != b.pi || !loc_before(&a, &b) {
        return err("ve.slurTwo");
    }
    let (ia, ib) = (a.chord(doc).id, b.chord(doc).id);
    let ai = a.index as f64;
    let cur = a.measure(doc).directions.iter().flatten().position(|d| d.kind == "wedge" && d.span_type != Some(SpanType::Stop) && d.after_elements.unwrap_or(0.0) == ai);
    if let Some(ci) = cur {
        let m = a.measure_mut(doc);
        let cur = m.directions.as_mut().unwrap().remove(ci);
        // 配对的终点：同声部往后第一条 wedge stop
        let part = &mut doc.songs[a.si].parts[a.pi];
        for mi in a.mi..part.measures.len() {
            let m = &mut part.measures[mi];
            let stop = m.directions.iter().flatten().position(|d| {
                d.kind == "wedge" && d.span_type == Some(SpanType::Stop) && (mi > a.mi || d.after_elements.unwrap_or(0.0) >= ai)
            });
            if let Some(si) = stop {
                let list = m.directions.as_mut().unwrap();
                list.remove(si);
                if list.is_empty() {
                    m.directions = None;
                }
                break;
            }
        }
        let m = a.measure_mut(doc);
        if m.directions.as_ref().is_some_and(|d| d.is_empty()) {
            m.directions = None;
        }
        if cur.wedge_type.as_ref() == Some(kind) {
            return ModelEdit::Select(vec![ia, ib]);
        }
    }
    let (av, ast) = (a.chord(doc).voice, a.chord(doc).staff);
    let mut start = Direction::of("wedge");
    start.span_type = Some(SpanType::Start);
    start.wedge_type = Some(kind.clone());
    start.after_elements = Some(ai);
    start.placement = Some(Placement::Below);
    start.voice = Some(av);
    start.staff = Some(ast);
    a.measure_mut(doc).directions.get_or_insert_with(Vec::new).push(start);
    let (bv, bst, bdiv) = {
        let c = b.chord(doc);
        (c.voice, c.staff, c.duration.divisions)
    };
    let mut stop = Direction::of("wedge");
    stop.span_type = Some(SpanType::Stop);
    stop.after_elements = Some(b.index as f64 + 1.0);
    stop.placement = Some(Placement::Below);
    stop.voice = Some(bv);
    stop.staff = Some(bst);
    let bm = b.measure(doc);
    let end_at = onsets(bm).get(&b.index).copied().unwrap_or(0.0) + bdiv;
    if end_at != default_onset_before(bm, b.index as f64 + 1.0) {
        stop.onset = Some(end_at);
    }
    b.measure_mut(doc).directions.get_or_insert_with(Vec::new).push(stop);
    ModelEdit::Select(vec![ia, ib])
}

/// 八度线挪的八度数：8va / 15ma 实际比记谱高（down），8vb / 15mb 低（up）。
fn octave_of(d: &Direction) -> f64 {
    let n = if d.shift.as_ref().map_or(8.0, |s| s.size) >= 15.0 { 2.0 } else { 1.0 };
    if d.shift.as_ref().is_some_and(|s| s.dir == ShiftDir::Up) {
        -n
    } else {
        n
    }
}

/// 方向记号在小节里的游标（divisions）。
fn dir_onset(m: &Measure, d: &Direction) -> f64 {
    d.onset.unwrap_or_else(|| default_onset_before(m, d.after_elements.unwrap_or(0.0)))
}

/// 谱表 `staff` 上 `[from, to)`（小节下标 + 小节内游标）里的音实际音高挪 `oct` 个八度（符头不动）。
fn shift_octave_span(part: &mut Part, staff: f64, from: (usize, f64), to: (usize, f64), oct: f64) {
    let mut mi = from.0;
    while mi <= to.0 && mi < part.measures.len() {
        let m = &mut part.measures[mi];
        let on = onsets(m);
        for (i, e) in m.elements.iter_mut().enumerate() {
            let Element::Chord(c) = e else { continue };
            if c.staff != staff {
                continue;
            }
            let t = on.get(&i).copied().unwrap_or(0.0);
            if (mi == from.0 && t < from.1) || (mi == to.0 && t >= to.1) {
                continue;
            }
            for n in &mut c.notes {
                if let Some(p) = &mut n.pitch {
                    p.octave += oct;
                }
            }
        }
        mi += 1;
    }
}

/// 一对八度线起止去掉前，范围里的音挪回记谱那个八度。
fn undo_octave_shift(part: &mut Part, start: &DirRef, stop: &DirRef) {
    let ms = &part.measures[start.mi];
    let d = &ms.directions.as_ref().unwrap()[start.index];
    let me = &part.measures[stop.mi];
    let from = (start.mi, dir_onset(ms, d));
    let to = (stop.mi, dir_onset(me, &me.directions.as_ref().unwrap()[stop.index]));
    let (staff, oct) = (d.staff.unwrap_or(1.0), -octave_of(d));
    shift_octave_span(part, staff, from, to, oct);
}

/// 选中的头尾两个音之间加 / 去一条八度线（`8va` 印在上方、`8vb` 在下方）。**符头留在谱面原位**，范围里本谱表的音音高跟着挪；去掉时挪回。
pub fn toggle_octave_shift(doc: &mut ScoreDoc, first_id: ElementId, last_id: ElementId, kind: &str) -> ModelEdit {
    let (Some(a), Some(b)) = (locate(doc, first_id), locate(doc, last_id)) else { return err("me.noNote") };
    if a.pi != b.pi || !loc_before(&a, &b) {
        return err("ve.slurTwo");
    }
    let (ia, ib) = (a.chord(doc).id, b.chord(doc).id);
    let staff = a.chord(doc).staff;
    let am = a.measure(doc);
    // 第二声线等写了 onset 的和弦：起点照它的游标
    let at = onsets(am).get(&a.index).copied().unwrap_or_else(|| default_onset_before(am, a.index as f64));
    let ci = am
        .directions
        .iter()
        .flatten()
        .position(|d| d.kind == "octave-shift" && d.span_type != Some(SpanType::Stop) && d.staff.unwrap_or(1.0) == staff && dir_onset(am, d) == at);
    if let Some(ci) = ci {
        let r = DirRef { si: a.si, pi: a.pi, mi: a.mi, index: ci };
        let cur_up = r.dir(doc).and_then(|d| d.shift.as_ref()).is_some_and(|s| s.dir == ShiftDir::Up);
        let pair = dir_partner(doc, &r);
        let part = &mut doc.songs[a.si].parts[a.pi];
        if let Some(p) = &pair {
            undo_octave_shift(part, &r, p);
        }
        let mut gone = vec![(r.mi, r.index)];
        if let Some(p) = pair {
            gone.push((p.mi, p.index));
        }
        remove_dirs(part, &gone);
        if cur_up == (kind == "8vb") {
            return ModelEdit::Select(vec![ia, ib]);
        }
    }
    let placement = if kind == "8va" { Placement::Above } else { Placement::Below };
    let mut start = Direction::of("octave-shift");
    start.span_type = Some(SpanType::Start);
    start.shift = Some(OctaveShift { dir: if kind == "8va" { ShiftDir::Down } else { ShiftDir::Up }, size: 8.0 });
    start.after_elements = Some(a.index as f64);
    start.placement = Some(placement.clone());
    start.staff = Some(staff);
    let mut stop = Direction::of("octave-shift");
    stop.span_type = Some(SpanType::Stop);
    stop.after_elements = Some(b.index as f64 + 1.0);
    stop.placement = Some(placement);
    stop.staff = Some(staff);
    if at != default_onset_before(a.measure(doc), a.index as f64) {
        start.onset = Some(at);
    }
    let bm = b.measure(doc);
    let end_at = onsets(bm).get(&b.index).copied().unwrap_or(0.0) + b.chord(doc).duration.divisions;
    if end_at != default_onset_before(bm, b.index as f64 + 1.0) {
        stop.onset = Some(end_at);
    }
    let oct = octave_of(&start);
    a.measure_mut(doc).directions.get_or_insert_with(Vec::new).push(start);
    b.measure_mut(doc).directions.get_or_insert_with(Vec::new).push(stop);
    shift_octave_span(&mut doc.songs[a.si].parts[a.pi], staff, (a.mi, at), (b.mi, end_at), oct);
    ModelEdit::Select(vec![ia, ib])
}

/// 渐强渐弱、踏板、八度线的起点 / 终点各是一条 `<direction>`：给一条，找配对的另一条（同声部、同类、按先后最近的那条）。
pub fn dir_partner(doc: &ScoreDoc, r: &DirRef) -> Option<DirRef> {
    let d = r.dir(doc)?;
    let part = &doc.songs[r.si].parts[r.pi];
    let st = d.span_type.as_ref()?;
    if *st == SpanType::Continue {
        return None;
    }
    // 同谱表、同声线（都写了才比）、同类；按先后排好，从它往后（终点往前）数，套着的同类一对对跳过
    let same = |x: &Direction| {
        x.kind == d.kind
            && x.staff.unwrap_or(1.0) == d.staff.unwrap_or(1.0)
            && (x.voice.is_none() || d.voice.is_none() || x.voice == d.voice)
            && matches!(x.span_type, Some(SpanType::Start) | Some(SpanType::Stop))
    };
    let mut list: Vec<(DirRef, f64, bool)> = vec![];
    for (mi, m) in part.measures.iter().enumerate() {
        for (index, x) in m.directions.iter().flatten().enumerate() {
            if same(x) {
                let is_stop = x.span_type == Some(SpanType::Stop);
                let pos = mi as f64 * 1e6 + x.after_elements.unwrap_or(0.0) * 2.0 + if is_stop { 0.0 } else { 1.0 };
                list.push((DirRef { si: r.si, pi: r.pi, mi, index }, pos, is_stop));
            }
        }
    }
    js::sort_by(&mut list, |a, b| a.1 - b.1);
    let k = list.iter().position(|x| x.0 == *r)? as isize;
    let fwd = *st == SpanType::Start;
    let me_stop = *st == SpanType::Stop;
    let mut depth = 0;
    let mut i = k + if fwd { 1 } else { -1 };
    while i >= 0 && (i as usize) < list.len() {
        let x = &list[i as usize];
        if x.2 == me_stop {
            depth += 1;
        } else if depth == 0 {
            return Some(x.0);
        } else {
            depth -= 1;
        }
        i += if fwd { 1 } else { -1 };
    }
    None
}

/// 删音符上的一个记号（`<notations>` 里按名字：奏法、装饰、延长号都行）。
pub fn remove_notation(doc: &mut ScoreDoc, id: ElementId, name: &str) -> ModelEdit {
    let Some(l) = locate(doc, id) else { return err("me.noNote") };
    let c = l.chord_mut(doc);
    let mut n = c.notations.clone().unwrap_or_default();
    if name == "fermata" || name == "fermata-inverted" {
        n.fermata = None;
        n.fermata_inverted = None;
    } else {
        for field in [&mut n.articulations, &mut n.ornaments, &mut n.technical] {
            let list: Vec<String> = field.take().unwrap_or_default().into_iter().filter(|a| a != name).collect();
            *field = if list.is_empty() { None } else { Some(list) };
        }
    }
    c.notations = if notations_empty(&n) { None } else { Some(n) };
    ModelEdit::Select(vec![c.id])
}

/// 删一条 `<direction>`（渐强渐弱这类成对的连配对那条一起删）。
pub fn delete_direction(doc: &mut ScoreDoc, r: DirRef) -> ModelEdit {
    let Some(an) = dir_anchor(doc, &r) else { return err("me.noMark") };
    let pair = dir_partner(doc, &r);
    let d = r.dir(doc).unwrap();
    let is_oct = d.kind == "octave-shift";
    let is_stop = d.span_type == Some(SpanType::Stop);
    let id = an.loc.chord(doc).id;
    let part = &mut doc.songs[an.loc.si].parts[an.loc.pi];
    // 删八度线：符头不动，范围里的音挪回记谱那个八度
    if let (true, Some(p)) = (is_oct, &pair) {
        let (s, e) = if is_stop { (p, &r) } else { (&r, p) };
        undo_octave_shift(part, s, e);
    }
    let mut gone = vec![(r.mi, r.index)];
    if let Some(p) = pair {
        gone.push((p.mi, p.index));
    }
    remove_dirs(part, &gone);
    ModelEdit::Select(vec![id])
}

/// 同一声部同一声线里前 / 后一个音（可跨小节，倚音不算；`skip_rests` 时休止也跳过）。
pub fn neighbour_chord(doc: &ScoreDoc, id: ElementId, delta: f64, skip_rests: bool) -> Option<ElementId> {
    let l = locate(doc, id)?;
    step_in_voice(doc, &l, delta, |c| c.grace.is_some() || (skip_rests && c.rest.is_some())).map(|x| x.chord(doc).id)
}

/// 给定音高（音名 + 八度）。
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct StepOctave {
    pub step: Step,
    pub octave: f64,
}

/// 在锚点处插一个**给定音高**的音（升降按那里的调号，印法重算）：Alt+点原图补漏识的音用。
pub fn insert_pitch(doc: &mut ScoreDoc, anchor: &InsertAnchor, pitch: &StepOctave, dur: NewDuration, hooks: &mut dyn EditHooks) -> ModelEdit {
    let r = insert_chord(doc, anchor, 1.0, dur, hooks);
    let ch = match &r {
        ModelEdit::Error(_) => return r,
        ModelEdit::CaretAfter(id) | ModelEdit::CaretBefore(id) => Some(*id),
        ModelEdit::Select(v) | ModelEdit::Moved { select: v, .. } => v.first().copied(),
    };
    let Some(l) = ch.and_then(|id| locate(doc, id)) else { return r };
    let key = ctx_of(doc, &l).key;
    let c = l.chord_mut(doc);
    c.notes = vec![Note { pitch: Some(Pitch { step: pitch.step.clone(), octave: pitch.octave, alter: key_alter(pitch.step.as_str(), key.fifths) }), ..Default::default() }];
    c.rest = None;
    respell_measure(l.measure_mut(doc), &key);
    hooks.forget_stem(l.chord(doc));
    ModelEdit::Select(vec![l.chord(doc).id])
}

/// 和弦现在的时值换成「新音」的写法（减半次数 + 附点）。
pub fn new_duration_of(ch: &Chord) -> NewDuration {
    let h = match ch.duration.kind.as_ref().unwrap_or(&NoteType::Quarter) {
        NoteType::Whole => -2.0,
        NoteType::Half => -1.0,
        NoteType::Quarter => 0.0,
        NoteType::Eighth => 1.0,
        NoteType::N16th => 2.0,
        NoteType::N32nd => 3.0,
        NoteType::N64th => 4.0,
        _ => 0.0,
    };
    NewDuration { halvings: h, dots: ch.duration.dots }
}

// ───────────────────────── 命令 ─────────────────────────

/// 一个编辑动作（JSON `{"op": "setDegree", …}`，`op` 与字段名同 TS 函数与参数名）。会话与对拍都按它发。
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum EditCmd {
    SetDegree { ids: Vec<ElementId>, degree: f64 },
    ShiftOctave { ids: Vec<ElementId>, delta: f64 },
    ToggleAccidental { ids: Vec<ElementId>, acc: String },
    ToggleDot { ids: Vec<ElementId> },
    ScaleDuration { ids: Vec<ElementId>, factor: f64 },
    AddBeat { id: ElementId },
    InsertChord { anchor: InsertAnchor, degree: f64, dur: NewDuration },
    DeleteChords { ids: Vec<ElementId> },
    AddChordNote { id: ElementId, degree: f64 },
    RemoveChordNote { id: ElementId, index: usize },
    InsertInVoice { at: VoiceAt, voice: f64, degree: f64, dur: NewDuration, shown: Option<f64> },
    StepDegree { ids: Vec<ElementId>, delta: f64 },
    StepSemitone { ids: Vec<ElementId>, delta: f64 },
    ShiftSemitones { ids: Vec<ElementId>, n: f64 },
    TransposeScore { n: f64 },
    SetStep { ids: Vec<ElementId>, letter: String },
    SplitMeasure { after_id: ElementId },
    MergeMeasures { si: usize, mi: usize },
    SetBreakBefore { si: usize, mi: usize, kind: Option<BreakKind> },
    ToggleSlur { first_id: ElementId, last_id: ElementId },
    ToggleTie { id: ElementId },
    ToggleDeco { ids: Vec<ElementId>, kind: String },
    InsertMeasure { si: usize, mi: usize },
    DeleteMeasures { si: usize, from: usize, to: usize },
    SetKeyAt { si: usize, mi: usize, fifths: f64 },
    SetTimeAt { si: usize, mi: usize, beats: f64, beat_type: f64 },
    SetTempoAt { si: usize, mi: usize, bpm: f64 },
    SetBarKind { si: usize, mi: usize, kind: String },
    ToggleEnding { si: usize, from: usize, to: usize, n: f64 },
    ToggleJump { si: usize, mi: usize, kind: String },
    ToggleTuplet { ids: Vec<ElementId> },
    SetLyric { id: ElementId, verse: f64, text: String, hyphen: bool, extend: bool },
    SetHarmony { id: ElementId, text: String },
    SetDirectionText { id: ElementId, kind: String, text: String },
    PasteClip { anchor: InsertAnchor, items: Vec<ClipItem> },
    SetClefAt { si: usize, pi: usize, mi: usize, staff: f64, clef: Clef, reread: bool },
    RereadKeyAt { si: usize, mi: usize, fifths: f64 },
    MoveMarkEnd { kind: MarkType, start_id: ElementId, end_id: ElementId, which: String, delta: f64 },
    MoveDirection { r: DirRef, delta: f64, #[serde(default)] by_measure: bool, pair: Option<DirRef>, guard: Option<DirRef> },
    MoveHarmony { id: ElementId, delta: f64 },
    ShiftLyrics { id: ElementId, verse: f64, delta: f64, count: Option<f64> },
    ToggleGrace { ids: Vec<ElementId> },
    ToggleWedge { first_id: ElementId, last_id: ElementId, kind: WedgeType },
    ToggleOctaveShift { first_id: ElementId, last_id: ElementId, kind: String },
    RemoveNotation { id: ElementId, name: String },
    DeleteDirection { r: DirRef },
    InsertPitch { anchor: InsertAnchor, pitch: StepOctave, dur: NewDuration },
}

/// 执行一个编辑动作
pub fn apply(doc: &mut ScoreDoc, cmd: &EditCmd, hooks: &mut dyn EditHooks) -> ModelEdit {
    use EditCmd as C;
    match cmd {
        C::SetDegree { ids, degree } => set_degree(doc, ids, *degree, hooks),
        C::ShiftOctave { ids, delta } => shift_octave(doc, ids, *delta, hooks),
        C::ToggleAccidental { ids, acc } => toggle_accidental(doc, ids, acc, hooks),
        C::ToggleDot { ids } => toggle_dot(doc, ids, hooks),
        C::ScaleDuration { ids, factor } => scale_duration(doc, ids, *factor, hooks),
        C::AddBeat { id } => add_beat(doc, *id, hooks),
        C::InsertChord { anchor, degree, dur } => insert_chord(doc, anchor, *degree, *dur, hooks),
        C::DeleteChords { ids } => delete_chords(doc, ids, hooks),
        C::AddChordNote { id, degree } => add_chord_note(doc, *id, *degree, hooks),
        C::RemoveChordNote { id, index } => remove_chord_note(doc, *id, *index, hooks),
        C::InsertInVoice { at, voice, degree, dur, shown } => insert_in_voice(doc, at, *voice, *degree, *dur, hooks, shown.unwrap_or(*voice)),
        C::StepDegree { ids, delta } | C::StepSemitone { ids, delta } => {
            if matches!(cmd, C::StepDegree { .. }) {
                step_degree(doc, ids, *delta, hooks)
            } else {
                shift_semitones(doc, ids, *delta, hooks)
            }
        }
        C::ShiftSemitones { ids, n } => shift_semitones(doc, ids, *n, hooks),
        C::TransposeScore { n } => transpose_score(doc, *n, hooks),
        C::SetStep { ids, letter } => set_step(doc, ids, letter, hooks),
        C::SplitMeasure { after_id } => split_measure(doc, *after_id, hooks),
        C::MergeMeasures { si, mi } => merge_measures(doc, *si, *mi, hooks),
        C::SetBreakBefore { si, mi, kind } => set_break_before(doc, *si, *mi, kind.clone()),
        C::ToggleSlur { first_id, last_id } => toggle_slur(doc, *first_id, *last_id),
        C::ToggleTie { id } => toggle_tie(doc, *id),
        C::ToggleDeco { ids, kind } => toggle_deco(doc, ids, kind),
        C::InsertMeasure { si, mi } => insert_measure(doc, *si, *mi, hooks),
        C::DeleteMeasures { si, from, to } => delete_measures(doc, *si, *from, *to, hooks),
        C::SetKeyAt { si, mi, fifths } => set_key_at(doc, *si, *mi, *fifths, hooks),
        C::SetTimeAt { si, mi, beats, beat_type } => set_time_at(doc, *si, *mi, *beats, *beat_type, hooks),
        C::SetTempoAt { si, mi, bpm } => set_tempo_at(doc, *si, *mi, *bpm),
        C::SetBarKind { si, mi, kind } => set_bar_kind(doc, *si, *mi, kind),
        C::ToggleEnding { si, from, to, n } => toggle_ending(doc, *si, *from, *to, *n),
        C::ToggleJump { si, mi, kind } => toggle_jump(doc, *si, *mi, kind),
        C::ToggleTuplet { ids } => toggle_tuplet(doc, ids, hooks),
        C::SetLyric { id, verse, text, hyphen, extend } => set_lyric(doc, *id, *verse, text, *hyphen, *extend),
        C::SetHarmony { id, text } => set_harmony(doc, *id, text),
        C::SetDirectionText { id, kind, text } => set_direction_text(doc, *id, kind, text),
        C::PasteClip { anchor, items } => paste_clip(doc, anchor, items, hooks),
        C::SetClefAt { si, pi, mi, staff, clef, reread } => set_clef_at(doc, *si, *pi, *mi, *staff, clef, *reread, hooks),
        C::RereadKeyAt { si, mi, fifths } => reread_key_at(doc, *si, *mi, *fifths, hooks),
        C::MoveMarkEnd { kind, start_id, end_id, which, delta } => move_mark_end(doc, kind, *start_id, *end_id, which, *delta),
        C::MoveDirection { r, delta, by_measure, pair, guard } => move_direction(doc, *r, *delta, *by_measure, *pair, *guard),
        C::MoveHarmony { id, delta } => move_harmony(doc, *id, *delta),
        C::ShiftLyrics { id, verse, delta, count } => shift_lyrics(doc, *id, *verse, *delta, *count),
        C::ToggleGrace { ids } => toggle_grace(doc, ids, hooks),
        C::ToggleWedge { first_id, last_id, kind } => toggle_wedge(doc, *first_id, *last_id, kind),
        C::ToggleOctaveShift { first_id, last_id, kind } => toggle_octave_shift(doc, *first_id, *last_id, kind),
        C::RemoveNotation { id, name } => remove_notation(doc, *id, name),
        C::DeleteDirection { r } => delete_direction(doc, *r),
        C::InsertPitch { anchor, pitch, dur } => insert_pitch(doc, anchor, pitch, *dur, hooks),
    }
}
