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
fn pitch_of_degree(number: f64, octave_shift: f64, key: &Key) -> Option<Pitch> {
    pitch_from_degree(&Degree { number, octave_shift, accidental: None }, key)
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
        let Some(mut p) = pitch_of_degree(degree, shift, &key) else { continue };
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
        let Some(p) = pitch_of_degree(degree, 0.0, &key) else { return err("me.degree07") };
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
    let Some(p0) = pitch_of_degree(degree, 0.0, &key) else { return err("me.degree17") };
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
        let Some(p) = pitch_of_degree(degree, 0.0, &key) else { return err("me.degree07") };
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
    let before = mine.iter().copied().filter(|&i| on_of(i) <= onset).last();
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
            if let Some(p) = pitch_of_degree(num, shift, &key) {
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
                    first.attrs.get_or_insert_with(MeasureAttrs::default).key = Some(fifths_key(0.0));
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
    }
}
