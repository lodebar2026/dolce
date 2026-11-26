//! `ScoreDoc`（MusicXML 形状）→ 断句输入；试听旋律档与演唱顺序也用这一份（同原 `model/phrasedoc.ts`）。
//!
//! 口径（断点写回文档要按 id 对上）：
//!   - 只留主分支（[`main_voice_of`]）的非倚音和弦；和弦内取最高音（`jianpu::top_note`）
//!   - 位置 / 时值按**首小节**的 divisions 折算
//!   - `beats` / `beams` / `dot` 按 `<type>` 与附点；唱名、八度点取语义层的度数
//!   - 小节线、反复、房号、调号变更同引擎输入；另读段落标记（段首硬换行）
//!   - 副歌判定同 `findRefrain`

use std::collections::{HashMap, HashSet};

use crate::base::Fraction;
use crate::helpers::{distinct_number_seq, section_mark_of};
use crate::jianpu::{midi_pitch, top_note};
use crate::{BarLocation, Chord, Element, ElementId, MarkType, Measure, Part, RepeatDir, Song};
use crate::play::phraseinput::PhrasePart;
use crate::play::timeline::TimeSig;

use crate::view::phrasesong::{dedup, digit_runs, fail, phrase_part_of, ChordOut, LyricOut, MeasureOut, NoteOut, ViewResult};

/// 一个声部的主分支：它里面最小的 voice 号。MusicXML 的 voice 号可以跨 part 连着编（文本谱 `Q2:` 投成的第二个 part 全是 voice 2），
/// 写死 voice 1 会把这种声部整个滤空。
pub fn main_voice_of(part: &Part) -> f64 {
    let mut v = f64::INFINITY;
    for m in &part.measures {
        for el in &m.elements {
            if let Element::Chord(c) = el {
                if c.voice < v {
                    v = c.voice;
                }
            }
        }
    }
    if v == f64::INFINITY {
        1.0
    } else {
        v
    }
}

/// 首小节的 divisions（缺省 1）
pub fn divisions_of(part: &Part) -> f64 {
    part.measures.first().and_then(|m| m.attrs.as_ref()).and_then(|a| a.divisions).unwrap_or(1.0)
}

/// 连音弧的起止和弦
pub(crate) struct Slurs {
    pub starts: HashSet<ElementId>,
    pub ends: HashMap<ElementId, f64>,
}

pub(crate) fn slurs_of(song: &Song) -> Slurs {
    let mut starts = HashSet::new();
    let mut ends = HashMap::new();
    for mk in &song.marks {
        if mk.kind != MarkType::Slur {
            continue;
        }
        starts.insert(mk.start);
        *ends.entry(mk.end).or_insert(0.0) += 1.0;
    }
    Slurs { starts, ends }
}

/// 一个声部的小节序列（`phrasePartOfDoc`）。`part_index` 越界回空。
/// `distinct_lyrics` = 同音同号的词顺延（只试听的演唱顺序要；断句与引擎输入不顺延）。
pub fn phrase_measures_of_doc(song: &Song, part_index: usize, distinct_lyrics: bool) -> ViewResult<Vec<MeasureOut>> {
    let Some(part) = song.parts.get(part_index) else { return Ok(vec![]) };
    let div = divisions_of(part);
    let slurs = slurs_of(song);
    let mut measures: Vec<MeasureOut> = vec![];
    let mut positions: Vec<Fraction> = vec![];
    let mut at = Fraction::int(0.0);
    let mut time = TimeSig { beats: 4.0, beat_type: 4.0 };
    let voice = main_voice_of(part);
    for (mi, m) in part.measures.iter().enumerate() {
        if let Some(t) = m.attrs.as_ref().and_then(|a| a.time.as_ref()) {
            time = TimeSig { beats: t.beats, beat_type: t.beat_type };
        }
        let prev = if mi > 0 { part.measures.get(mi - 1) } else { None };
        measures.push(measure_of(m, prev, div, &slurs, time, voice)?);
        positions.push(at);
        at = at.plus(&measure_end(m, div));
    }
    if distinct_lyrics {
        for n in measures.iter_mut().flat_map(|m| m.entries.iter_mut()).flat_map(|c| c.notes.iter_mut()) {
            let numbers = distinct_number_seq(n.lyrics.iter().map(|l| l.number));
            for (l, number) in n.lyrics.iter_mut().zip(numbers) {
                l.number = number;
            }
        }
    }
    find_refrain(&mut measures, &positions);
    Ok(measures)
}

/// 断句输入（`part_index` 缺省第一声部，与引擎输入只读 `parts[0]` 一致）。和弦按拍平次序另回各自的元素 id
pub fn phrase_part_of_doc(song: &Song, part_index: usize, distinct_lyrics: bool) -> ViewResult<(PhrasePart, Vec<Option<ElementId>>)> {
    Ok(phrase_part_of(&phrase_measures_of_doc(song, part_index, distinct_lyrics)?))
}

/// 跳转记号（Fine / D.C. / D.S. / To Coda）所在的小节下标（0 基、升序）。**只取记号本身**，
/// `segno` / `coda` 是跳转的目标、不算（口径同引擎输入的 `playData.jumpTo`）。
pub fn phrase_jump_measures(song: &Song, part_index: usize) -> Vec<usize> {
    let Some(part) = song.parts.get(part_index) else { return vec![] };
    part.measures
        .iter()
        .enumerate()
        .filter(|(_, m)| {
            m.directions.iter().flatten().filter_map(|d| d.sound.as_ref()).any(|s| s.dacapo == Some(true) || s.dalsegno.is_some() || s.fine == Some(true) || s.tocoda.is_some())
        })
        .map(|(i, _)| i)
        .collect()
}

/// 各声部各自累计的起拍（divisions），按元素下标。倚音不占时值；不是和弦的为 None。
pub(crate) fn onsets(m: &Measure) -> Vec<Option<f64>> {
    let mut pos: HashMap<crate::base::js::NumKey, f64> = HashMap::new();
    m.elements
        .iter()
        .map(|el| {
            let Element::Chord(c) = el else { return None };
            let key = crate::base::js::NumKey::new(c.voice);
            let p = pos.get(&key).copied().unwrap_or(0.0);
            if c.grace.is_none() {
                pos.insert(key, p + c.duration.divisions);
            }
            Some(p)
        })
        .collect()
}

/// 小节时值 = 文档序最后一个（任意声部的）非倚音和弦的终点
fn measure_end(m: &Measure, div: f64) -> Fraction {
    let at = onsets(m);
    for (i, el) in m.elements.iter().enumerate().rev() {
        if let Element::Chord(c) = el {
            if c.grace.is_none() {
                return Fraction::int(at[i].unwrap() + c.duration.divisions).div_int(div);
            }
        }
    }
    Fraction::int(0.0)
}

fn measure_of(m: &Measure, prev: Option<&Measure>, div: f64, slurs: &Slurs, time: TimeSig, voice: f64) -> ViewResult<MeasureOut> {
    let mut out = MeasureOut {
        entries: vec![],
        barline: None,
        repeat_backward: false,
        repeat_forward: false,
        key_change: m.attrs.as_ref().is_some_and(|a| a.key.is_some()),
        ending_left: false,
        ending_num: None,
        ending_right: None,
        section_mark: None,
        seq: vec![],
        time,
        key: None,
    };
    for b in m.barlines.iter().flatten() {
        if let Some(style) = &b.style {
            if b.location != BarLocation::Left {
                out.barline = Some(style.as_str().to_string());
            }
        }
        match b.repeat {
            Some(RepeatDir::Backward) => out.repeat_backward = true,
            Some(RepeatDir::Forward) => out.repeat_forward = true,
            _ => {}
        }
        if let Some(e) = &b.ending {
            if b.location == BarLocation::Left {
                // 同 `parseBarline`：房号文本里的数字才是遍数，文本没有数字才用 `number` 属性
                out.ending_left = true;
                out.ending_num = Some(dedup(e.text.as_deref().and_then(digit_runs).unwrap_or_else(|| e.numbers.clone())));
            } else {
                out.ending_right = Some(e.kind.as_str().to_string());
            }
        }
    }
    out.section_mark = section_mark_of(m, Some(prev));

    let at = onsets(m);
    for (i, el) in m.elements.iter().enumerate() {
        let Element::Chord(c) = el else { continue };
        if c.grace.is_some() || c.voice > voice {
            continue;
        }
        out.entries.push(chord_of(c, at[i].unwrap(), div, slurs)?);
    }
    Ok(out)
}

/// `<type>` → (增时线格数, 减时线条数)
fn type_beats(t: &str) -> Option<(f64, f64)> {
    Some(match t {
        "whole" => (4.0, 0.0),
        "half" => (2.0, 0.0),
        "quarter" => (1.0, 0.0),
        "eighth" => (1.0, 1.0),
        "16th" => (1.0, 2.0),
        "32nd" => (1.0, 3.0),
        "64th" => (1.0, 4.0),
        _ => return None,
    })
}

fn chord_of(el: &Chord, onset: f64, div: f64, slurs: &Slurs) -> ViewResult<ChordOut> {
    let rest = el.rest.is_some();
    let dot = if el.duration.dots > 0.0 { 1.0 } else { 0.0 };
    let (mut beats, mut beams) = (0.0, 0.0);
    match &el.duration.kind {
        None => {
            if rest {
                beats = 4.0;
            }
        }
        Some(t) => {
            let Some(bb) = type_beats(t.as_str()) else { return fail(&format!("bad note type {}", t.as_str())) };
            (beats, beams) = bb;
            if dot == 1.0 && beats > 1.0 {
                beats = beats * 3.0 / 2.0;
            }
        }
    }
    let top = if rest { None } else { top_note(el).map(|i| &el.notes[i]) };
    let lyrics: Vec<LyricOut> = el
        .lyrics
        .iter()
        .flatten()
        .filter(|l| !l.text.is_empty())
        .map(|l| LyricOut { text: l.text.clone(), number: l.number, refrain: l.refrain.unwrap_or(false), extend: false })
        .collect();
    let degree = top.and_then(|n| n.degree.as_ref());
    let tie_end = top.and_then(|n| n.tie.as_ref()).and_then(|t| t.stop).unwrap_or(false);
    let note = NoteOut {
        number: degree.map_or("0".to_string(), |d| crate::base::js::num_to_string(d.number)),
        jp_octave: degree.map_or(0.0, |d| d.octave_shift),
        pitch: top.and_then(|n| n.pitch.as_ref()).map_or(0.0, midi_pitch),
        jp_alter: " ".to_string(),
        tie_start: top.and_then(|n| n.tie.as_ref()).and_then(|t| t.start).unwrap_or(false),
        tie_end,
        lyrics,
        tie_stop: tie_end,
    };
    Ok(ChordOut {
        notes: vec![note],
        rest,
        beats,
        beams,
        dot,
        duration: Some(Fraction::int(el.duration.divisions).div_int(div)),
        position: Fraction::int(onset).div_int(div),
        fermata: el.notations.as_ref().and_then(|n| n.fermata).unwrap_or(false),
        slur_start: slurs.starts.contains(&el.id),
        slur_ends: slurs.ends.get(&el.id).copied().unwrap_or(0.0),
        tuplet_begin: false,
        tuplet_end: false,
        tuplet: false,
        id: Some(el.id),
    })
}

/// 同 `musicxml.ts::findRefrain`：尾部只剩一行歌词的那一段（房内除外）记成副歌。`positions`：各小节起点
fn find_refrain(measures: &mut [MeasureOut], positions: &[Fraction]) {
    let mut count: Vec<(Fraction, usize)> = vec![];
    let mut in_ending = false;
    for (m, at) in measures.iter().zip(positions) {
        if m.ending_left {
            in_ending = true;
        }
        for ch in &m.entries {
            if in_ending {
                continue;
            }
            let cnt: usize = ch.notes.iter().map(|n| n.lyrics.iter().filter(|l| !l.text.is_empty()).count()).sum();
            if cnt == 0 {
                continue;
            }
            let pos = at.plus(&ch.position);
            match count.iter_mut().find(|(p, _)| p.equals(&pos)) {
                Some(e) => e.1 += cnt,
                None => count.push((pos, cnt)),
            }
        }
        if m.ending_right.is_some() {
            in_ending = false;
        }
    }
    count.sort_by(|a, b| a.0.compare_to(&b.0).cmp(&0));
    let mut refrain: Option<Fraction> = None;
    for (pos, n) in count.iter().rev() {
        if *n == 1 {
            refrain = Some(*pos);
        } else if *n > 1 {
            break;
        }
    }
    let Some(refrain) = refrain else { return };
    for (m, at) in measures.iter_mut().zip(positions) {
        let Some(last) = m.entries.last() else { continue };
        let end = at.plus(&last.position.plus(&last.duration.unwrap()));
        if end.compare_to(&refrain) <= 0 {
            continue;
        }
        for ch in m.entries.iter_mut() {
            if at.plus(&ch.position).compare_to(&refrain) < 0 {
                continue;
            }
            for l in ch.notes.iter_mut().flat_map(|n| n.lyrics.iter_mut()) {
                l.refrain = true;
            }
        }
    }
}
