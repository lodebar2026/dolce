//! 简谱形状的 `ScoreDoc`（文本谱 / 123 / ABC / `.jpwabc`）→ 一个声部的小节序列（同原 `jianpu/phrasesong.ts`）。
//!
//! 经排版行视图（[`crate::view::slots::doc_view`]）读，和简谱档谱面、简谱输入模型是同一批行。小节序列一份三用：
//! 断句输入（[`phrase_part_of_song`]）、试听 / 演唱顺序（[`crate::view::playsong`]）、`.jpwabc` 写出端输入（`dolce-formats::jpw::input`）。
//! **口径逐条同 `jianpuinput.ts::rowsPart`**（`forExpanded` 那一份：带歌词的声部当主旋律、同号歌词顺延）。

use std::collections::{HashMap, HashSet};

use crate::base::{js, Fraction};
use crate::helpers::section_mark_of;
use crate::{Accidental, BarLocation, ElementId, Part, ScoreDoc, Song};
use crate::play::jppitch::{apply_jp_pitch, JpKeyState};
use crate::play::phraseinput::{PhraseChord, PhraseLyric, PhraseMeasure, PhraseNote, PhrasePart};
use crate::play::timeline::{TimeSig, TimelineKey};
use crate::play::PlayError;

use crate::view::ast::{BarlineType, LyricLine, Mark, MarkType, MusicElement, NoteElement, Sound};
use crate::view::slots::{DocView, RowView, SongView};

pub type ViewResult<T> = Result<T, PlayError>;

pub(crate) fn fail<T>(msg: &str) -> ViewResult<T> {
    Err(PlayError(msg.to_string()))
}

// ───────────────────────── 产物形状 ─────────────────────────

/// 一个音底下的一段词。`extend`：续记号，只试听填（`playsong::mark_extends`）
#[derive(Debug, Clone, PartialEq)]
pub struct LyricOut {
    pub text: String,
    pub number: f64,
    pub refrain: bool,
    pub extend: bool,
}

#[derive(Debug, Clone)]
pub struct NoteOut {
    pub number: String,
    pub jp_octave: f64,
    /// MIDI 音高：只在 [`build_measures`] 给了调号状态时算（试听用）；休止与无音高为 0
    pub pitch: f64,
    pub jp_alter: String,
    pub tie_start: bool,
    pub tie_end: bool,
    pub lyrics: Vec<LyricOut>,
    /// 试听用：括住相邻两个同音的弧当延音线，后一个不再起音
    pub tie_stop: bool,
}

#[derive(Debug, Clone)]
pub struct ChordOut {
    /// 恒一个音（和弦取最高音 / 简谱一格一个数）
    pub notes: Vec<NoteOut>,
    pub rest: bool,
    pub beats: f64,
    pub beams: f64,
    pub dot: f64,
    pub duration: Option<Fraction>,
    pub position: Fraction,
    pub fermata: bool,
    pub slur_start: bool,
    pub slur_ends: f64,
    /// 多连音配对（`doPairTuplet`）用
    pub tuplet_begin: bool,
    pub tuplet_end: bool,
    pub tuplet: bool,
    /// 元素 id（高亮、断点写回）
    pub id: Option<ElementId>,
}

/// 小节里和弦、小节线、行末换行的原次序（`.jpwabc` 写出端要）
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SeqItem {
    /// `entries` 的下标
    Chord(usize),
    Barline,
    Break,
}

#[derive(Debug, Clone)]
pub struct MeasureOut {
    pub entries: Vec<ChordOut>,
    /// MusicXML bar-style token
    pub barline: Option<String>,
    pub repeat_backward: bool,
    pub repeat_forward: bool,
    pub key_change: bool,
    pub ending_left: bool,
    /// 房号适用的遍数（插入次序）
    pub ending_num: Option<Vec<f64>>,
    /// "stop" / "discontinue"
    pub ending_right: Option<String>,
    pub section_mark: Option<String>,
    pub seq: Vec<SeqItem>,
    /// 拍号：曲首的接着模型小节 `attrs.time` 的曲中转拍号
    pub time: TimeSig,
    /// 调号（导出 MIDI 写调号）：只在给了调号状态时有，随曲中转调
    pub key: Option<TimelineKey>,
}

impl MeasureOut {
    /// 末和弦的终点。没有和弦时报错（同 `layout/input.ts::measureDuration`）
    pub fn duration(&self) -> ViewResult<Fraction> {
        match self.entries.last() {
            Some(ChordOut { duration: Some(d), position, .. }) => Ok(position.plus(d)),
            _ => fail("measure has no chord"),
        }
    }
}

/// 跳转记号（`&dc` / `&ds` / `&fine` / `&ty` / `&hs`）挂在哪一小节。
#[derive(Debug, Clone)]
pub struct JumpOut {
    pub name: String,
    pub measure: usize,
    pub on_barline: bool,
}

const JUMP_NAMES: [&str; 5] = ["dc", "ds", "fine", "ty", "hs"];

// ───────────────────────── 行视图上的小工具 ─────────────────────────

/// 一首里某声部号的各行（按页、组的次序）
pub fn lines_of_voice(song: &SongView, voice: f64) -> Vec<&RowView> {
    song.pages.iter().flat_map(|p| p.groups.iter()).flat_map(|g| g.voices.iter()).filter(|v| v.line.voice == voice).collect()
}

/// 一首里出现过的声部号（按首次出现）。一个都没有退回 [1]
pub fn voice_numbers(song: &SongView) -> Vec<f64> {
    let mut seen: Vec<f64> = vec![];
    for v in song.pages.iter().flat_map(|p| p.groups.iter()).flat_map(|g| g.voices.iter()) {
        if !seen.contains(&v.line.voice) {
            seen.push(v.line.voice);
        }
    }
    if seen.is_empty() {
        vec![1.0]
    } else {
        seen
    }
}

/// 行视图那首曲子在模型里的样子：投影改过的取投影后那份
pub fn view_song<'a>(doc: &'a ScoreDoc, view: &'a DocView, i: usize) -> Option<&'a Song> {
    let sv = view.songs.get(i)?;
    sv.song.as_ref().or(doc.songs.get(i))
}

/// 同一条曲行下**段号重复**的歌词行，依次顺延到下一个空闲段号（投影档用，`ToScoreOptions.forExpanded`）。
pub fn distinct_verses(lyrics: &[LyricLine]) -> Vec<LyricLine> {
    let mut max_used = 0.0;
    let mut used: HashSet<js::NumKey> = HashSet::new();
    lyrics
        .iter()
        .map(|l| {
            let mut shift: f64 = 0.0;
            let mut v = l.verse_from;
            while v <= l.verse_to {
                if used.contains(&js::NumKey::new(v)) {
                    shift = js::max(shift, max_used + 1.0 - l.verse_from);
                }
                v += 1.0;
            }
            let from = l.verse_from + shift;
            let to = l.verse_to + shift;
            let mut v = from;
            while v <= to {
                used.insert(js::NumKey::new(v));
                v += 1.0;
            }
            max_used = js::max(max_used, to);
            if shift == 0.0 {
                l.clone()
            } else {
                LyricLine { verse_from: from, verse_to: to, ..l.clone() }
            }
        })
        .collect()
}

/// 临时记号 → `applyJpPitch` 的 `jpAlter`
pub fn jp_alter_of(el: &NoteElement) -> &'static str {
    jp_alter_of_accidental(el.accidental.as_ref())
}

/// 面上的记号 → 单字符记号位（同 `score.ts::Note.init` 的 `JP_ALTER`，双升 / 双降印成 `#` / `b`）
pub fn jp_alter_of_accidental(acc: Option<&Accidental>) -> &'static str {
    match acc {
        Some(Accidental::Sharp) | Some(Accidental::DoubleSharp) => "#",
        Some(Accidental::Flat) | Some(Accidental::DoubleFlat) => "b",
        Some(Accidental::Natural) => "n",
        _ => " ",
    }
}

pub fn marks_at(marks: &[Mark], index: i64, kind: MarkType) -> impl Iterator<Item = &Mark> {
    marks.iter().filter(move |m| m.kind == kind && (m.start == index || m.end == index))
}

/// 同 `jianpuinput.ts::marksEdgeAt`：跨行的续接端不是真端点。
pub fn edge_at(marks: &[Mark], index: i64, kind: MarkType) -> (bool, bool) {
    let starts = marks_at(marks, index, kind).any(|m| m.start == index && m.continuation_from_previous != Some(true));
    let ends = marks_at(marks, index, kind).any(|m| m.end == index && m.continuation_to_next != Some(true));
    (starts, ends)
}

fn chord_duration(ch: &ChordOut) -> Fraction {
    let mut dur = Fraction::int(ch.beats);
    if ch.dot > 0.0 {
        dur = dur.times_int(3.0).div_int(2.0);
    }
    dur.div_int((1u64 << (ch.beams as u32)) as f64)
}

/// 每条歌词行的下一个音节（`nextSyllables`）：`(段号, 字 + 收尾标点)`
pub fn next_syllables(lyrics: &[LyricLine], cursors: &mut [usize]) -> Vec<(f64, String)> {
    let mut out = vec![];
    for (li, line) in lyrics.iter().enumerate() {
        let syl = line.syllables.get(cursors[li]);
        cursors[li] += 1;
        let Some(syl) = syl else { continue };
        if syl.text.is_empty() {
            continue;
        }
        let text = format!("{}{}", syl.text, syl.trailing_punctuation.as_deref().unwrap_or(""));
        let mut v = line.verse_from;
        while v <= line.verse_to {
            out.push((v, text.clone()));
            v += 1.0;
        }
    }
    out
}

pub fn takes_lyric(el: &MusicElement) -> bool {
    match el {
        MusicElement::Note(n) => n.lyric_anchor,
        MusicElement::Sustain(s) => s.lyric_anchor,
        _ => false,
    }
}

// ───────────────────────── 小节序列 ─────────────────────────

/// 试听要的音高状态（[`build_measures`] 给了才算 MIDI 音高）
pub struct PitchCtx {
    pub key: JpKeyState,
    pub time: TimeSig,
    /// 曲首是不是小调
    pub minor: bool,
    /// 曲中转调：元素 id → 它所在小节的调号。None = 全曲一个调
    pub key_of: Option<HashMap<ElementId, TimelineKey>>,
    /// 括住相邻两个同音的弧当延音线（缺省是；ABC / Muse 原文的括号就是圆滑线）
    pub slur_ties: bool,
}

/// 一个声部的曲行 → 小节序列与跳转记号。`song`：行视图那首曲子在模型里的样子（`refs` 指它）。
/// `renumber_verses` 同 `jianpuinput.ts::rowsPart`（投影档那一份才顺延同号歌词）。
pub fn build_measures(song: &Song, lines: &[&RowView], renumber_verses: bool, mut pitch: Option<PitchCtx>) -> ViewResult<(Vec<MeasureOut>, Vec<JumpOut>)> {
    let mut measures: Vec<MeasureOut> = vec![];
    let mut jumps: Vec<JumpOut> = vec![];
    let mut new_measure_needed = true;
    // 上一个和弦：(小节下标, 条目下标)
    let mut last_chord: Option<(usize, usize)> = None;
    // `last_chord` 上起头的弧里有没有续到下一行的
    let mut last_slur_opens_continue = false;
    let mut last_chord_at: Option<(usize, i64)> = None;
    let mut pending_repeat_forward = false;
    let mut pending_ending: Option<Option<String>> = None;
    let mut tuplet_notes: Vec<(usize, usize)> = vec![];
    let mut cur_time = pitch.as_ref().map_or(TimeSig { beats: 4.0, beat_type: 4.0 }, |p| p.time);
    let mut cur_key: Option<TimelineKey> = pitch.as_ref().map(|p| TimelineKey { fifths: p.key.fifths, minor: p.minor });
    let open = |measures: &mut Vec<MeasureOut>, time: TimeSig, key: Option<TimelineKey>| -> usize {
        measures.push(MeasureOut {
            entries: vec![],
            barline: None,
            repeat_backward: false,
            repeat_forward: false,
            key_change: false,
            ending_left: false,
            ending_num: None,
            ending_right: None,
            section_mark: None,
            seq: vec![],
            time,
            key,
        });
        measures.len() - 1
    };
    let note_jumps = |jumps: &mut Vec<JumpOut>, el: &MusicElement, mea: usize, on_barline: bool| {
        let orns = match el {
            MusicElement::Note(n) => &n.ornaments,
            MusicElement::Sustain(s) => &s.ornaments,
            MusicElement::Barline(b) => &b.ornaments,
            _ => return,
        };
        for o in orns {
            if JUMP_NAMES.contains(&o.name.as_str()) {
                jumps.push(JumpOut { name: o.name.clone(), measure: mea, on_barline });
            }
        }
    };

    // 已读过段落标记的模型小节（小节中间换行时一个模型小节跨两行，只在头一段读）
    let mut section_seen: HashSet<(usize, usize)> = HashSet::new();
    let n_lines = lines.len();
    let mut measure: Option<usize> = None;
    for (li, row) in lines.iter().enumerate() {
        let line = &row.line;
        let refs = &row.refs;
        let part = song.parts.get(row.part);
        let lyrics: Vec<LyricLine> = if renumber_verses { distinct_verses(&line.lyrics) } else { line.lyrics.clone() };
        let mut cursors = vec![0usize; lyrics.len()];
        let voltas: Vec<&Mark> = line.marks.iter().filter(|m| m.kind == MarkType::Volta).collect();
        for (index, el) in line.elements.iter().enumerate() {
            let ix = index as i64;
            for mk in &voltas {
                if mk.start == ix && mk.continuation_from_previous != Some(true) {
                    pending_ending = Some(mk.caption.clone());
                }
            }
            let ends_volta: Vec<&&Mark> = voltas.iter().filter(|mk| mk.end == ix && mk.continuation_to_next != Some(true)).collect();
            let close_volta = |measures: &mut Vec<MeasureOut>, mea: Option<usize>| {
                let Some(mea) = mea else { return };
                for mk in &ends_volta {
                    measures[mea].ending_right = Some(if mk.open_end == Some(true) { "discontinue" } else { "stop" }.to_string());
                }
            };
            let attach = |measures: &mut Vec<MeasureOut>, at: (usize, usize), cursors: &mut Vec<usize>| {
                for (verse, text) in next_syllables(&lyrics, cursors) {
                    measures[at.0].entries[at.1].notes[0].lyrics.push(LyricOut { text, number: verse, refrain: false, extend: false });
                }
            };

            match el {
                MusicElement::BeatBoundary(_) | MusicElement::InlineLayer(_) => continue,
                MusicElement::Sustain(su) => {
                    close_volta(&mut measures, measure);
                    if let Some(m) = measure {
                        note_jumps(&mut jumps, el, m, false);
                    }
                    if let Some((m, e)) = last_chord {
                        let ch = &mut measures[m].entries[e];
                        ch.beats += 1.0;
                        ch.duration = Some(chord_duration(ch));
                    }
                    if su.lyric_anchor {
                        if let Some(at) = last_chord {
                            attach(&mut measures, at, &mut cursors);
                        }
                    }
                    continue;
                }
                MusicElement::Barline(b) => {
                    let location = refs.get(index).and_then(|r| {
                        let m = part?.measures.get(r.m)?;
                        m.barlines.as_ref()?.get(r.b?).map(|bl| bl.location.clone())
                    });
                    if location == Some(BarLocation::Left) && b.kind != BarlineType::RepeatEnd && b.kind != BarlineType::RepeatBoth {
                        if b.kind == BarlineType::RepeatStart || b.repeat_forward_after == Some(true) {
                            pending_repeat_forward = true;
                        }
                        new_measure_needed = true;
                        continue;
                    }
                    if measure.is_none() && b.kind == BarlineType::RepeatStart {
                        // 曲首的 `|:`：不造空小节，只给紧跟着的那个小节记「反复起点」
                        pending_repeat_forward = true;
                        new_measure_needed = true;
                        continue;
                    }
                    let mea = match measure {
                        Some(m) => m,
                        None => {
                            let m = open(&mut measures, cur_time, cur_key);
                            measure = Some(m);
                            m
                        }
                    };
                    measures[mea].seq.push(SeqItem::Barline);
                    close_volta(&mut measures, Some(mea));
                    note_jumps(&mut jumps, el, mea, true);
                    let mm = &mut measures[mea];
                    match b.kind {
                        BarlineType::Normal => mm.barline = Some("regular".into()),
                        BarlineType::Double => mm.barline = Some("light-light".into()),
                        BarlineType::End => mm.barline = Some("light-heavy".into()),
                        BarlineType::RepeatStart => pending_repeat_forward = true,
                        BarlineType::RepeatEnd => {
                            mm.repeat_backward = true;
                            mm.barline = Some("light-heavy".into());
                        }
                        BarlineType::RepeatBoth => {
                            mm.repeat_backward = true;
                            mm.barline = Some("light-heavy".into());
                            pending_repeat_forward = true;
                        }
                        _ => mm.barline = Some("none".into()),
                    }
                    // 下一小节左线上的反复起点挂在这条线上（`|] |:` 两条线并成一条）
                    if b.repeat_forward_after == Some(true) {
                        pending_repeat_forward = true;
                    }
                    new_measure_needed = true;
                    if let Some(p) = pitch.as_mut() {
                        p.key.alter.clear(); // 临时记号到小节线为止
                    }
                    continue;
                }
                MusicElement::Note(_) => {}
            }
            let MusicElement::Note(n) = el else { unreachable!() };

            let mea = match measure {
                Some(m) if !new_measure_needed => m,
                _ => {
                    let m = open(&mut measures, cur_time, cur_key);
                    measure = Some(m);
                    m
                }
            };
            new_measure_needed = false;
            if pending_repeat_forward {
                measures[mea].repeat_forward = true;
                pending_repeat_forward = false;
            }
            if let Some(caption) = pending_ending.take() {
                let mm = &mut measures[mea];
                mm.ending_left = true;
                mm.ending_num = digit_runs(caption.as_deref().map(js::trim).unwrap_or("")).map(dedup);
            }
            close_volta(&mut measures, Some(mea));
            note_jumps(&mut jumps, el, mea, false);
            // 段落标记从模型小节读（`sectionMarkOf`，与 MusicXML 那条路同一个判据）
            let r = refs.get(index);
            if let (Some(r), Some(part)) = (r, part) {
                if let Some(dm) = part.measures.get(r.m) {
                    if section_seen.insert((row.part, r.m)) {
                        let mm = &mut measures[mea];
                        if mm.section_mark.is_none() {
                            mm.section_mark = section_mark_of(dm, None);
                        }
                        // 曲中转拍号
                        if let Some(t) = dm.attrs.as_ref().and_then(|a| a.time.as_ref()) {
                            cur_time = TimeSig { beats: t.beats, beat_type: t.beat_type };
                            mm.time = cur_time;
                        }
                    }
                }
            }
            let id: Option<ElementId> = r.and_then(|r| r.id).and_then(|i| u32::try_from(i).ok());

            let number = if n.sound == Sound::Rhythm { "0".to_string() } else { n.pitch.to_string() };
            let mut ch = ChordOut {
                notes: vec![NoteOut {
                    number: number.clone(),
                    jp_octave: n.octave as f64,
                    pitch: 0.0,
                    jp_alter: jp_alter_of(n).to_string(),
                    tie_start: false,
                    tie_end: false,
                    lyrics: vec![],
                    tie_stop: false,
                }],
                rest: n.hidden || n.sound == Sound::Rest || n.sound == Sound::Rhythm || number == "0",
                beats: 1.0,
                beams: js::max(0.0, js::round((n.duration as f64 / 4.0).log2())),
                dot: n.dots as f64,
                duration: None,
                position: Fraction::int(0.0),
                fermata: n.ornaments.iter().any(|o| o.name == "yc" || o.name == "ycy"),
                slur_start: false,
                slur_ends: 0.0,
                tuplet_begin: false,
                tuplet_end: false,
                tuplet: false,
                id,
            };
            if let Some(p) = pitch.as_mut() {
                let k = p.key_of.as_ref().and_then(|m| id.and_then(|i| m.get(&i).copied()));
                if let Some(k) = k {
                    if k.fifths != p.key.fifths {
                        p.key = JpKeyState::of_fifths(k.fifths).or_else(fail)?;
                        measures[mea].key_change = true;
                    }
                    if cur_key.is_none_or(|c| k.fifths != c.fifths || k.minor != c.minor) {
                        cur_key = Some(k);
                        measures[mea].key = cur_key;
                    }
                }
                let got = apply_jp_pitch(&mut p.key, &number, n.octave as f64, jp_alter_of(n)).or_else(fail)?;
                ch.notes[0].pitch = got.map_or(0.0, |(pitch, _)| pitch);
            }
            let (tb, te) = edge_at(&line.marks, ix, MarkType::Tuplet);
            ch.tuplet_begin = tb;
            ch.tuplet_end = te;
            let (ss, se) = edge_at(&line.marks, ix, MarkType::Slur);
            if ss {
                ch.slur_start = true;
            }
            if se {
                ch.slur_ends += 1.0;
            }
            // 相邻两个同音被一条弧括住 = 延音线（简谱里两者同形）：试听只延长、不再起音
            if let (Some(p), Some((lm, le))) = (pitch.as_ref(), last_chord) {
                let last = &measures[lm].entries[le];
                if p.slur_ties && !ch.rest && !last.rest && last.notes[0].pitch == ch.notes[0].pitch {
                    let tied = marks_at(&line.marks, ix, MarkType::Slur).any(|m| {
                        if m.end != ix || m.continuation_to_next == Some(true) {
                            return false;
                        }
                        if m.continuation_from_previous == Some(true) {
                            return last_chord_at.is_some_and(|(pl, _)| pl != li) && last_slur_opens_continue;
                        }
                        last_chord_at.is_some_and(|(pl, pi)| pl == li && m.start == pi)
                    });
                    if tied {
                        ch.notes[0].tie_stop = true;
                    }
                }
            }
            ch.duration = Some(chord_duration(&ch));
            let mm = &mut measures[mea];
            mm.entries.push(ch);
            let at = (mea, mm.entries.len() - 1);
            mm.seq.push(SeqItem::Chord(at.1));
            if tb || te {
                tuplet_notes.push(at);
            }
            last_chord = Some(at);
            last_chord_at = Some((li, ix));
            last_slur_opens_continue = line
                .marks
                .iter()
                .any(|m| m.kind == MarkType::Slur && m.start == ix && m.continuation_from_previous != Some(true) && m.continuation_to_next == Some(true));
            if takes_lyric(el) {
                attach(&mut measures, at, &mut cursors);
            }
        }
        // 行末换行（末行不加）
        if li + 1 != n_lines {
            if let Some(m) = measure {
                measures[m].seq.push(SeqItem::Break);
            }
        }
    }

    // doPairTuplet + applyTupletDurations
    for i in 0..tuplet_notes.len() / 2 {
        for k in [2 * i, 2 * i + 1] {
            let (m, e) = tuplet_notes[k];
            measures[m].entries[e].tuplet = true;
        }
    }
    let mut in_tuplet = false;
    for m in measures.iter_mut() {
        let mut pos = Fraction::int(0.0);
        for ch in m.entries.iter_mut() {
            let mut dur = chord_duration(ch);
            if ch.tuplet && ch.tuplet_begin {
                in_tuplet = true;
            }
            if in_tuplet || ch.tuplet {
                dur = dur.times_int(2.0).div_int(3.0);
            }
            if ch.tuplet && ch.tuplet_end {
                in_tuplet = false;
            }
            ch.duration = Some(dur);
            ch.position = pos;
            pos = pos.plus(&dur);
        }
    }
    Ok((measures, jumps))
}

/// `new Set(xs)` 的次序：重复的只留第一个
pub fn dedup(xs: Vec<f64>) -> Vec<f64> {
    let mut out: Vec<f64> = vec![];
    for x in xs {
        if !out.contains(&x) {
            out.push(x);
        }
    }
    out
}

/// `text.match(/\d+/g)` 各段按十进制读；没有数字回 None
pub fn digit_runs(text: &str) -> Option<Vec<f64>> {
    let mut out = vec![];
    let mut cur = String::new();
    for c in text.chars().chain(std::iter::once(' ')) {
        if c.is_ascii_digit() {
            cur.push(c);
        } else if !cur.is_empty() {
            out.push(js::parse_int(&cur, 10));
            cur.clear();
        }
    }
    (!out.is_empty()).then_some(out)
}

// ───────────────────────── 断句输入 ─────────────────────────

/// 小节序列 → 断句输入（和弦按小节首尾相接的拍平次序另回各自的元素 id）
pub fn phrase_part_of(measures: &[MeasureOut]) -> (PhrasePart, Vec<Option<ElementId>>) {
    let mut ids = vec![];
    let measures = measures
        .iter()
        .map(|m| PhraseMeasure {
            chords: m
                .entries
                .iter()
                .map(|c| {
                    ids.push(c.id);
                    phrase_chord_of(c)
                })
                .collect(),
            barline: m.barline.clone(),
            repeat_backward: m.repeat_backward,
            repeat_forward: m.repeat_forward,
            key_change: m.key_change,
            ending_left: m.ending_left,
            ending_right: m.ending_right.clone(),
            section_mark: m.section_mark.clone(),
        })
        .collect();
    (PhrasePart { measures }, ids)
}

pub(crate) fn phrase_chord_of(c: &ChordOut) -> PhraseChord {
    PhraseChord {
        notes: c
            .notes
            .iter()
            .map(|n| PhraseNote {
                number: n.number.clone(),
                jp_octave: n.jp_octave,
                tie_start: n.tie_start,
                tie_end: n.tie_end,
                lyrics: n.lyrics.iter().map(|l| PhraseLyric { text: l.text.clone(), number: l.number, refrain: l.refrain }).collect(),
            })
            .collect(),
        rest: c.rest,
        beats: c.beats,
        beams: c.beams,
        dot: c.dot,
        duration: c.duration,
        position: c.position,
        fermata: c.fermata,
        slur_start: c.slur_start,
        slur_ends: c.slur_ends,
    }
}

/// 断句输入（主旋律那一个声部：带歌词的声部优先）。这首没有曲行时回 None（同 `jianpuInputOfDoc`）。
pub fn phrase_part_of_song(doc: &ScoreDoc, view: &DocView, song_idx: usize) -> ViewResult<Option<(PhrasePart, Vec<Option<ElementId>>)>> {
    let Some(sv) = view.songs.get(song_idx) else { return Ok(None) };
    let song = view_song(doc, view, song_idx).unwrap();
    let mut voices = voice_numbers(sv);
    if let Some(lead) = voices.iter().copied().find(|&v| lines_of_voice(sv, v).iter().any(|l| !l.line.lyrics.is_empty())) {
        voices.retain(|&v| v != lead);
        voices.insert(0, lead);
    }
    for v in voices {
        let lines = lines_of_voice(sv, v);
        if lines.is_empty() {
            continue;
        }
        let (measures, _) = build_measures(song, &lines, true, None)?;
        return Ok(Some(phrase_part_of(&measures)));
    }
    Ok(None)
}

/// 行视图的声部号 → 模型的 part（`P<n>` 的 id 或 part 序）
pub fn part_of_voice(song: &Song, voice: f64) -> Option<(usize, &Part)> {
    song.parts
        .iter()
        .enumerate()
        .find(|(_, p)| p.id == format!("P{}", js::num_to_string(voice)))
        .or_else(|| js::index(voice - 1.0).and_then(|i| song.parts.get(i).map(|p| (i, p))))
}
