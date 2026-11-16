//! **简谱语义层**（同 `src/model/jianpu.ts`）：从 `ScoreDoc` 取简谱要印的派生量——唱名与八度点、相对调号的临时记号
//! （小节内延续）、减时线/增时线/附点、和弦原文、谱表上下文、旋律取音。
//!
//! 口径（详见 TS 文件头）：按记谱音高；调号是声部级的、谱号按谱表取；派生量不存进 `ScoreDoc`
//! （`Note.degree` 例外：MusicXML 来源由 `assign_degrees` 补上）。

use crate::doc::*;
use crate::harmony::harmony_to_text;
use dolce_base::js::{self, NumKey};
use dolce_play::jppitch::{jp_pitch, jp_tonic_octave_shift, key_alter, step_index, tonic_step, STEPS};
use std::collections::HashMap;

fn step_of(s: Option<&str>) -> Step {
    s.map_or_else(|| Step::Other(String::new()), Step::parse)
}

// ───────────────────────── 音高 ↔ 度数 ─────────────────────────

/// 简谱度数 → 绝对音高（单音，不看小节内延续）。面上的记号**相对调号**。
pub fn pitch_from_degree(degree: &Degree, key: &Key) -> Option<Pitch> {
    if degree.number == 0.0 {
        return None;
    }
    Some(AccidentalCarry::default().pitch(degree, key))
}

/// 绝对音高 → 简谱度数（唱名 + 八度点）。临时记号由调用方给。
pub fn degree_from_pitch(pitch: &Pitch, key: &Key, accidental: Option<Accidental>) -> Degree {
    let idx = step_index(pitch.step.as_str());
    let wr = idx + pitch.octave * 7.0;
    let b = tonic_step(key.fifths);
    let number = ((((wr - b) % 7.0) + 7.0) % 7.0) + 1.0;
    let octave_shift = ((wr - b) / 7.0).floor() - 4.0 + jp_tonic_octave_shift(key.fifths);
    Degree { number, octave_shift, accidental }
}

fn acc_by_offset(o: f64) -> Option<Accidental> {
    Some(if o == -2.0 {
        Accidental::DoubleFlat
    } else if o == -1.0 {
        Accidental::Flat
    } else if o == 0.0 {
        Accidental::Natural
    } else if o == 1.0 {
        Accidental::Sharp
    } else if o == 2.0 {
        Accidental::DoubleSharp
    } else {
        return None;
    })
}

/// `OFFSET_BY_ACC[acc]`：认不得的记号名取不到（undefined）
fn offset_by_acc(a: &Accidental) -> Option<f64> {
    match a {
        Accidental::DoubleFlat => Some(-2.0),
        Accidental::Flat => Some(-1.0),
        Accidental::Natural => Some(0.0),
        Accidental::Sharp => Some(1.0),
        Accidental::DoubleSharp => Some(2.0),
        Accidental::Other(_) => None,
    }
}

/// 一小节里（一条谱表上）**按唱名延续**的临时记号状态（简谱口径，升降号相对调号）。
#[derive(Clone, Debug, Default)]
pub struct AccidentalCarry {
    /// 唱名 → 相对调号的半音偏移（None = TS 存进去的 `undefined`：认不得的记号名）
    offsets: HashMap<NumKey, Option<f64>>,
}

impl AccidentalCarry {
    /// `this.offsets.get(n) ?? 0`
    fn get(&self, n: f64) -> f64 {
        self.offsets.get(&NumKey::new(n)).copied().flatten().unwrap_or(0.0)
    }
}

impl AccidentalCarry {
    /// 这个音要不要印记号：相对调号的偏移与本小节已延续的不同才印，按偏移命名。
    pub fn mark(&mut self, pitch: &Pitch, key: &Key) -> Option<Accidental> {
        let number = degree_from_pitch(pitch, key, None).number;
        let offset = pitch.alter - key_alter(step_index(pitch.step.as_str()), key.fifths);
        let expected = self.get(number);
        self.offsets.insert(NumKey::new(number), Some(offset));
        if offset != expected {
            acc_by_offset(offset)
        } else {
            None
        }
    }

    /// 写出前核对：照面上的记号读回会不会读偏成别的音高；会就返回要改印的记号。
    pub fn repair(&mut self, degree: &Degree, actual: &Pitch, key: &Key) -> Option<Accidental> {
        let offset = actual.alter - key_alter(step_index(actual.step.as_str()), key.fifths);
        let read = self.pitch(degree, key);
        if read.alter == actual.alter {
            return None;
        }
        let acc = acc_by_offset(offset)?;
        self.pitch(&Degree { accidental: Some(acc.clone()), ..degree.clone() }, key);
        Some(acc)
    }

    /// 度数（带面上的记号）→ 音高，并更新延续状态。
    pub fn pitch(&mut self, degree: &Degree, key: &Key) -> Pitch {
        if let Some(acc) = &degree.accidental {
            // `OFFSET_BY_ACC[acc]` 取不到时 TS 存 undefined
            match offset_by_acc(acc) {
                Some(off) if off == 0.0 => {
                    self.offsets.remove(&NumKey::new(degree.number));
                }
                off => {
                    self.offsets.insert(NumKey::new(degree.number), off);
                }
            }
        }
        let p = jp_pitch(degree.number, degree.octave_shift, key.fifths);
        Pitch { step: step_of(p.step), alter: p.alter + self.get(degree.number), octave: p.octave }
    }
}

/// 一小节里一条谱表上**按线/间延续**的临时记号（五线谱口径）
#[derive(Clone, Debug)]
pub struct StaffAccidentalCarry {
    alters: HashMap<String, f64>,
    fifths: f64,
}

impl StaffAccidentalCarry {
    pub fn new(fifths: f64) -> StaffAccidentalCarry {
        StaffAccidentalCarry { alters: HashMap::new(), fifths }
    }

    /// 这个音在谱表上要印的记号；`tied` 是延音线接过来的音：不印，也不改延续状态
    pub fn mark(&mut self, pitch: &Pitch, tied: bool) -> Option<Accidental> {
        if tied {
            return None;
        }
        let k = format!("{}{}", pitch.step.as_str(), js::num_to_string(pitch.octave));
        let expected = self.alters.get(&k).copied().unwrap_or_else(|| key_alter(step_index(pitch.step.as_str()), self.fifths));
        self.alters.insert(k, pitch.alter);
        if pitch.alter != expected {
            acc_by_offset(pitch.alter)
        } else {
            None
        }
    }
}

// ───────────────────────── 调号拼写 ─────────────────────────

/// 调号的主音拼写（前置形：`"D"`、`"bB"`、`"#F"`）。有 `spelling` 就用它；否则由升降号数推：
/// `mode_tonic = false` 取大调主音（简谱 `1=` 用），`true` 在 `mode` 为 minor/aeolian 时取关系小调主音（ABC `K:Am` 用）。
pub fn key_spelling(key: &Key, mode_tonic: bool) -> String {
    if let Some(s) = &key.spelling {
        if !s.is_empty() {
            return s.clone();
        }
    }
    let minor = mode_tonic && matches!(key.mode.as_deref(), Some("minor" | "aeolian"));
    let idx = (tonic_step(key.fifths) + if minor { 5.0 } else { 0.0 }) % 7.0;
    let alter = key_alter(idx, key.fifths);
    let sign = if alter > 0.0 {
        "#"
    } else if alter < 0.0 {
        "b"
    } else {
        ""
    };
    format!("{sign}{}", js::index(idx).and_then(|i| STEPS.get(i)).copied().unwrap_or("undefined"))
}

// ───────────────────────── 谱表上下文 ─────────────────────────

#[derive(Clone, Debug)]
pub struct ResolvedAttrs {
    pub divisions: f64,
    pub key: Key,
    pub time: Option<Time>,
    pub clef: Option<Clef>,
    pub transpose: Option<Transpose>,
}

impl ResolvedAttrs {
    pub fn new(key: Key) -> ResolvedAttrs {
        ResolvedAttrs { divisions: 1.0, key, time: None, clef: None, transpose: None }
    }
}

pub fn c_major() -> Key {
    Key { fifths: 0.0, mode: None, spelling: None, tonic_degree: None, display: None, explicit_accidentals: None, cancel: None }
}

/// 第 `i` 小节起点、第 `staff` 条谱表上生效的属性（向前找最近一次设定）。
pub fn attrs_at(part: &Part, staff: f64, i: usize, fallback_key: Option<&Key>) -> ResolvedAttrs {
    let mut r = ResolvedAttrs::new(fallback_key.cloned().unwrap_or_else(c_major));
    if part.measures.is_empty() {
        return r;
    }
    let n = i.min(part.measures.len() - 1);
    for m in &part.measures[..=n] {
        apply_attrs(&mut r, m, staff);
    }
    r
}

pub fn apply_attrs(r: &mut ResolvedAttrs, m: &Measure, staff: f64) {
    let Some(a) = &m.attrs else { return };
    if let Some(d) = a.divisions {
        r.divisions = d;
    }
    if let Some(k) = &a.key {
        r.key = k.clone();
    }
    if let Some(t) = &a.time {
        r.time = Some(t.clone());
    }
    if let Some(t) = &a.transpose {
        r.transpose = Some(t.clone());
    }
    if let Some(c) = a.clefs.iter().flatten().find(|c| c.staff.unwrap_or(1.0) == staff) {
        r.clef = Some(c.clone());
    }
}

// ───────────────────────── 记谱八度 ─────────────────────────

const CLEF_NAMES: [(&str, ClefSign, f64); 4] =
    [("treble", ClefSign::G, 2.0), ("bass", ClefSign::F, 4.0), ("alto", ClefSign::C, 3.0), ("tenor", ClefSign::C, 4.0)];

/// 八度谱号名（`treble-8`）→ 谱号
pub fn clef_from_name(name: &str) -> Option<Clef> {
    let t = js::trim(name);
    let (word, oct) = if t.len() >= 2 && (t.ends_with("-8") || t.ends_with("+8")) { (&t[..t.len() - 2], Some(&t[t.len() - 2..])) } else { (t, None) };
    if word.is_empty() || !word.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let lower = word.to_ascii_lowercase();
    let (_, sign, line) = CLEF_NAMES.iter().find(|(n, _, _)| *n == lower)?;
    Some(Clef { sign: sign.clone(), line: Some(*line), octave_change: oct.map(|o| if o == "-8" { -1.0 } else { 1.0 }), staff: None })
}

pub fn clef_name(c: &Clef) -> Option<String> {
    let (n, _, _) = CLEF_NAMES.iter().find(|(_, sign, line)| *sign == c.sign && c.line.unwrap_or(*line) == *line)?;
    let suffix = match c.octave_change {
        Some(o) if o != 0.0 && !o.is_nan() => {
            if o < 0.0 {
                "-8"
            } else {
                "+8"
            }
        }
        _ => "",
    };
    Some(format!("{n}{suffix}"))
}

/// 简谱声部的**记谱八度**：第一小节的谱号带八度移位时简谱照惯例按高八度记。0 = 按度数原样发声。
pub fn written_octave_of(part: &Part) -> f64 {
    part.measures
        .first()
        .and_then(|m| m.attrs.as_ref())
        .and_then(|a| a.clefs.as_ref())
        .and_then(|cs| cs.iter().find(|c| c.staff.unwrap_or(1.0) == 1.0))
        .and_then(|c| c.octave_change)
        .unwrap_or(0.0)
}

// ───────────────────────── 度数补全 ─────────────────────────

/// 本小节各元素的**起拍**（四分音符为 1），按声部各自累计（下标同 `m.elements`）。
fn onsets(m: &Measure, divisions: f64) -> Vec<f64> {
    let mut pos: HashMap<NumKey, f64> = HashMap::new();
    let mut out = Vec::with_capacity(m.elements.len());
    for el in &m.elements {
        let k = NumKey::new(el.voice());
        let at = pos.get(&k).copied().unwrap_or(0.0);
        out.push(at);
        let d = match el {
            Element::Chord(c) => {
                if c.grace.is_some() {
                    0.0
                } else {
                    c.duration.divisions
                }
            }
            Element::Space(s) => s.duration.as_ref().map_or(0.0, |d| d.divisions),
        };
        pos.insert(k, at + d / divisions);
    }
    out
}

/// 小节中间换行拆成的后半：仍是同一个小节，临时记号接着前半延续。
pub fn continues_measure(prev: Option<&Measure>, m: &Measure) -> bool {
    m.implicit == Some(true)
        && prev.is_some_and(|p| p.barlines.iter().flatten().any(|b| b.location == BarLocation::Right && b.style == Some(BarStyle::NoStyle)))
}

/// 按绝对音高给一个声部**重算**简谱度数与面上要印的临时记号（按起拍先后过音；每条谱表旋律 / 全部两份延续状态）。
pub fn assign_degrees(part: &mut Part, initial_key: &Key) {
    struct Lane {
        melody: AccidentalCarry,
        all: AccidentalCarry,
    }
    let mut r = ResolvedAttrs::new(initial_key.clone());
    let mut lanes: HashMap<NumKey, Lane> = HashMap::new();
    for mi in 0..part.measures.len() {
        apply_attrs(&mut r, &part.measures[mi], 1.0);
        let m = &part.measures[mi];
        let at = onsets(m, r.divisions);
        let mut order: Vec<usize> = (0..m.elements.len()).collect();
        js::sort_by(&mut order, |&a, &b| {
            let d = at[a] - at[b];
            if d != 0.0 && !d.is_nan() {
                d
            } else {
                a as f64 - b as f64
            }
        });
        let mut melody_voice: HashMap<NumKey, f64> = HashMap::new();
        for el in &m.elements {
            if let Element::Chord(c) = el {
                if c.voice < melody_voice.get(&NumKey::new(c.staff)).copied().unwrap_or(f64::INFINITY) {
                    melody_voice.insert(NumKey::new(c.staff), c.voice);
                }
            }
        }
        if !continues_measure(if mi > 0 { Some(&part.measures[mi - 1]) } else { None }, m) {
            lanes.clear();
        }
        let octave_change = r.clef.as_ref().and_then(|c| c.octave_change).unwrap_or(0.0);
        let m = &mut part.measures[mi];
        for &ei in &order {
            let Element::Chord(el) = &mut m.elements[ei] else { continue };
            let lane = lanes.entry(NumKey::new(el.staff)).or_insert_with(|| Lane { melody: AccidentalCarry::default(), all: AccidentalCarry::default() });
            let top = if melody_voice.get(&NumKey::new(el.staff)) == Some(&el.voice) { top_note(el) } else { None };
            for (ni, n) in el.notes.iter_mut().enumerate() {
                let Some(p) = &n.pitch else { continue };
                let mut d = degree_from_pitch(p, &r.key, None);
                d.octave_shift -= octave_change;
                let by_all = lane.all.mark(p, &r.key);
                let acc = if Some(ni) == top { lane.melody.mark(p, &r.key) } else { by_all };
                if acc.is_some() {
                    d.accidental = acc;
                }
                n.degree = Some(d);
            }
        }
    }
}

/// 用绝对音高补出简谱度数（已有度数的不动）。调号取小节的 `attrs.key`，没有就取本曲的（缺省 C 大调）。
pub fn fill_degrees_from_pitch(song: &mut Song) {
    let key = song.key.clone().unwrap_or_else(c_major);
    for part in &mut song.parts {
        let mut cur = key.clone();
        for m in &mut part.measures {
            if let Some(k) = m.attrs.as_ref().and_then(|a| a.key.as_ref()) {
                cur = k.clone();
            }
            for el in &mut m.elements {
                let Element::Chord(c) = el else { continue };
                for n in &mut c.notes {
                    if n.degree.is_some() {
                        continue;
                    }
                    let Some(p) = &n.pitch else { continue };
                    n.degree = Some(degree_from_pitch(p, &cur, n.accidental.clone()));
                }
            }
        }
    }
}

// ───────────────────────── 时值 → 简谱写法 ─────────────────────────

/// `<type>` → 以四分音符为 1 的名义时值
pub fn type_quarters(t: &NoteType) -> Option<f64> {
    Some(match t {
        NoteType::Maxima => 32.0,
        NoteType::Long => 16.0,
        NoteType::Breve => 8.0,
        NoteType::Whole => 4.0,
        NoteType::Half => 2.0,
        NoteType::Quarter => 1.0,
        NoteType::Eighth => 0.5,
        NoteType::N16th => 0.25,
        NoteType::N32nd => 0.125,
        NoteType::N64th => 1.0 / 16.0,
        NoteType::N128th => 1.0 / 32.0,
        NoteType::N256th => 1.0 / 64.0,
        NoteType::Other(_) => return None,
    })
}

/// 这个元素的名义时值（四分音符为 1）：优先 `<type>` + 附点，没有 type（整小节休止等）才按 divisions 折算。
pub fn nominal_quarters(el: &Element, divisions: f64) -> f64 {
    let Some(d) = el.duration() else { return 0.0 };
    let chord = el.as_chord();
    let is_rest = chord.is_some_and(|c| c.rest.is_some());
    // 整小节休止常记成 `<type>whole`、时值却是一整小节：按实际时值
    let whole_rest = is_rest && d.kind == Some(NoteType::Whole) && d.time_mod.is_none();
    // 不可见休止是占位：也按实际时值
    let spacer_rest = is_rest && chord.is_some_and(|c| c.print_object == Some(false)) && d.time_mod.is_none();
    let base = if !whole_rest && !spacer_rest { d.kind.as_ref().and_then(type_quarters) } else { None };
    if let Some(base) = base {
        let mut q = base;
        let mut add = base;
        let mut k = 0.0;
        while k < d.dots {
            add /= 2.0;
            q += add;
            k += 1.0;
        }
        return q;
    }
    let mut q = d.divisions / divisions;
    if let Some(tm) = &d.time_mod {
        q = (q * tm.actual) / tm.normal;
    }
    q
}

/// 简谱写法：减时线条数、附点数、增时线条数。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct JianpuShape {
    pub beams: f64,
    pub dots: f64,
    pub sustains: f64,
}

/// 名义时值 → 简谱写法。
pub fn jianpu_shape(q: f64) -> JianpuShape {
    if q >= 1.0 {
        // 四分以上：一个四分（或附点四分）本体 + 若干增时线。附点二分 = `5 - -`
        let sustains = js::max(0.0, (q + 1e-9).floor() - 1.0);
        let body = q - sustains;
        let dots = if body >= 1.75 - 1e-9 {
            2.0
        } else if body >= 1.5 - 1e-9 {
            1.0
        } else {
            0.0
        };
        return JianpuShape { beams: 0.0, dots, sustains };
    }
    // 四分以下：减时线条数由基本时值定，附点照记
    for dots in [0.0, 1.0, 2.0] {
        let factor = if dots == 0.0 {
            1.0
        } else if dots == 1.0 {
            1.5
        } else {
            1.75
        };
        let base = q / factor;
        let beams = (1.0 / base).log2();
        if (beams - js::round(beams)).abs() < 1e-6 {
            return JianpuShape { beams: js::round(beams), dots, sustains: 0.0 };
        }
    }
    JianpuShape { beams: js::max(1.0, js::round((1.0 / q).log2())), dots: 0.0, sustains: 0.0 }
}

/// 减时线条数（MusicXML 形状的元素）。
pub fn beam_count(el: &Element, divisions: f64) -> f64 {
    jianpu_shape(nominal_quarters(el, divisions)).beams
}

// ───────────────────────── 和弦原文 ─────────────────────────

/// 结构化和弦 → 简谱面上印的原文（`"Am7"`、`"G/B"`）。
pub fn harmony_text(h: &Harmony) -> String {
    harmony_to_text(h, false)
}

// ───────────────────────── 旋律取音 ─────────────────────────

/// 简谱层印哪一路：**最小谱表上的最小 voice**（`(staff, voice)`）。本小节没有和弦时为 None。
pub fn melody_lane(m: &Measure) -> Option<(f64, f64)> {
    let mut lane: Option<(f64, f64)> = None;
    for el in &m.elements {
        let Element::Chord(c) = el else { continue };
        match lane {
            Some((s, v)) if !(c.staff < s || (c.staff == s && c.voice < v)) => {}
            _ => lane = Some((c.staff, c.voice)),
        }
    }
    lane
}

/// 简谱层的旋律：`melody_lane` 那一路的和弦（下标），按原文次序。给了 `staff` 就取那条谱表上的最小 voice。
pub fn melody_chords(m: &Measure, staff: Option<f64>) -> Vec<usize> {
    let (s, v) = match staff {
        None => match melody_lane(m) {
            Some(l) => l,
            None => return vec![],
        },
        Some(s) => {
            let mut voice = f64::INFINITY;
            for el in &m.elements {
                if let Element::Chord(c) = el {
                    if c.staff == s && c.voice < voice {
                        voice = c.voice;
                    }
                }
            }
            (s, voice)
        }
    };
    m.elements
        .iter()
        .enumerate()
        .filter(|(_, el)| matches!(el, Element::Chord(c) if c.staff == s && c.voice == v))
        .map(|(i, _)| i)
        .collect()
}

const SEMI: [f64; 7] = [0.0, 2.0, 4.0, 5.0, 7.0, 9.0, 11.0];

fn midi_of(p: &Pitch) -> f64 {
    let semi = js::index(step_index(p.step.as_str())).map_or(f64::NAN, |i| SEMI[i]);
    p.octave * 12.0 + semi + p.alter
}

/// MIDI 音高（中央 C = 60）。
pub fn midi_pitch(p: &Pitch) -> f64 {
    midi_of(p) + 12.0
}

/// 音的高低（比较用）：有绝对音高按 MIDI，简谱来源按度数与八度。
pub fn note_height(n: &Note) -> f64 {
    if let Some(p) = &n.pitch {
        midi_of(p)
    } else if let Some(d) = &n.degree {
        d.octave_shift * 7.0 + d.number
    } else {
        f64::NEG_INFINITY
    }
}

/// 和弦里简谱印的那个音（下标）：音高最高者；画小的音（cue）不算，除非全是；都比不出取第一个。
pub fn top_note(ch: &Chord) -> Option<usize> {
    let mut best: Option<usize> = None;
    let mut best_v = f64::NEG_INFINITY;
    let normal = ch.notes.iter().any(|n| n.type_size.as_deref() != Some("cue"));
    for (i, n) in ch.notes.iter().enumerate() {
        if normal && n.type_size.as_deref() == Some("cue") {
            continue;
        }
        let v = note_height(n);
        if v > best_v {
            best = Some(i);
            best_v = v;
        }
    }
    best.or(if ch.notes.is_empty() { None } else { Some(0) })
}

/// 速度按**四分等值**（`tempoBeat` 为 3/8 时 `♩.=60` → 90）；文字术语原样。
pub fn quarter_tempos(song: &Song) -> Vec<Tempo> {
    let tempos = song.tempos.clone().unwrap_or_default();
    match &song.tempo_beat {
        Some(b) if b.num * 4.0 != b.den => tempos
            .into_iter()
            .map(|t| match t {
                Tempo::Bpm(n) => Tempo::Bpm(js::round((n * 4.0 * b.num) / b.den)),
                other => other,
            })
            .collect(),
        _ => tempos,
    }
}
