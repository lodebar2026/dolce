//! `ScoreDoc` → jianpu-ly 写出端的输入（同原 `jianpu/jianpuinput.ts` 的 `jianpuInputOfDoc` 简谱档与 `jianpuInputOfJpw`）。
//!
//! 只留写出端（[`super::emit`]）读的字段；口径逐条照原 TS（简谱档 `decorate`：和弦、段落词、力度 / 术语 / 跳转记号、奏法；
//! 倚音两档都有）。和 `dolce-view::phrasesong::build_measures`（试听 / 断句 / `.jpwabc` 用的那一份投影）的分歧都是原 TS 两份投影本来就有的，
//! 不在这里抹平。
//!
//! 元素身份：原 TS 按对象引用认（连音组首尾、弧的终点和弦）；这里和弦按建出来的次序编号（[`JChord::ci`]），
//! 与写出端拍平各小节和弦的次序相同。

use std::collections::{HashMap, HashSet};

use dolce_base::{js, Fraction};
use dolce_model::keyshift::fifths_of_spelling;
use dolce_model::marknames::{is_dynamic_name, term_text};
use dolce_model::{BarLocation, BreakKind, Element, MarkType as DocMarkType, Measure as DocMeasure, NoteType, RepeatDir, ScoreDoc, Song};
use dolce_play::jppitch::key_name_to_fifth;
use dolce_view::ast::{BarlineType, LyricLine, Mark, MarkType, MusicElement, NoteElement, Sound};
use dolce_view::phrasesong::{dedup, digit_runs, edge_at, jp_alter_of, jp_alter_of_accidental, lines_of_voice, marks_at, next_syllables, takes_lyric, view_song, voice_numbers};
use dolce_view::playsong::{play_data_of_song, PlaySongOptions};
use dolce_view::slots::{doc_view, RowView, SongView};

type R<T> = Result<T, String>;

/// 印在音符上方的记号（原 TS `JDirection`；字形记号只记是哪一种，写出端不碰字形）
#[derive(Clone, Debug, PartialEq)]
pub enum JDir {
    /// 文字记号（`rit.`、`Fine`、`D.C.`）
    Text(String),
    /// 力度（名字）
    Dynamic(String),
    Segno,
    Coda,
}

/// 倚音
#[derive(Clone, Debug)]
pub struct JGrace {
    pub number: String,
    pub jp_octave: f64,
    pub jp_alter: String,
    /// 印出来的时值（MusicXML 口径：8 / 16 / 32…），没记为 None
    pub duration: Option<f64>,
}

/// 一个和弦（简谱一格一个音：原 TS `JChord` 与它唯一的 `JNote` 并成一个）
#[derive(Clone, Debug)]
pub struct JChord {
    /// 建出来的次序（= 写出端拍平各小节和弦的次序）
    pub ci: usize,
    pub number: String,
    pub jp_octave: f64,
    /// `b` / `n` / `#`，空格 = 无记号
    pub jp_alter: String,
    /// (段号, 字)
    pub lyrics: Vec<(f64, String)>,
    pub tuplet_begin: bool,
    pub tuplet_end: bool,
    /// 所在连音组的首尾和弦（`ci`）
    pub tuplet: Option<(usize, usize)>,
    pub rest: bool,
    pub beats: f64,
    pub beams: f64,
    pub dot: f64,
    pub position: Fraction,
    pub duration: Fraction,
    pub slur_start: bool,
    /// 从本和弦起的各条弧收在哪个和弦（`ci`）
    pub slur_end_chords: Vec<usize>,
    pub fermata: bool,
    pub harmony: Option<String>,
    pub section_word: Option<String>,
    pub directions: Vec<JDir>,
    pub articulations: Vec<String>,
    pub grace_notes: Vec<JGrace>,
}

#[derive(Clone, Debug)]
pub enum JEntry {
    Chord(JChord),
    Break { new_page: bool },
    Bar,
}

#[derive(Clone, Debug)]
pub struct JMeasure {
    pub position: Fraction,
    pub entries: Vec<JEntry>,
    pub fifths: f64,
    pub beats: f64,
    pub beat_type: f64,
    pub key_change: bool,
    pub time_change: bool,
    pub repeat_forward: bool,
    pub repeat_backward: bool,
    /// 房号适用的遍数（插入次序、去重）
    pub ending_num: Option<Vec<f64>>,
}

impl JMeasure {
    fn new(fifths: f64, beats: f64, beat_type: f64) -> JMeasure {
        JMeasure {
            position: Fraction::int(0.0),
            entries: vec![],
            fifths,
            beats,
            beat_type,
            key_change: false,
            time_change: false,
            repeat_forward: false,
            repeat_backward: false,
            ending_num: None,
        }
    }

    pub fn chords(&self) -> impl Iterator<Item = &JChord> {
        self.entries.iter().filter_map(|e| match e {
            JEntry::Chord(c) => Some(c),
            _ => None,
        })
    }

    fn chord_mut(&mut self, e: usize) -> &mut JChord {
        match &mut self.entries[e] {
            JEntry::Chord(c) => c,
            _ => unreachable!("条目不是和弦"),
        }
    }
}

/// (类型, 文字)
pub type JCredit = (Option<String>, String);

pub struct JScore {
    /// 各声部的小节
    pub parts: Vec<Vec<JMeasure>>,
    pub title: String,
    pub credit: Vec<JCredit>,
}

/// 原 TS `emitJly` 的取法：简谱形状走 `jianpuInputOfDoc`，投不出来再按 `.jpwabc` 取。都没有回 None
pub fn jly_input_of_doc(doc: &ScoreDoc) -> R<Option<JScore>> {
    if let Some(s) = jianpu_input_of_doc(doc)? {
        return Ok(Some(s));
    }
    jianpu_input_of_jpw(doc)
}

/// 时值：beats ×（附点）÷ 2^减时线（多连音的 2/3 另乘）
fn nominal(c: &JChord) -> Fraction {
    let mut dur = Fraction::int(c.beats);
    if c.dot > 0.0 {
        dur = dur.times_int(3.0).div_int(2.0);
    }
    dur.div_int((1u64 << (c.beams as u32)) as f64)
}

fn new_chord(ci: usize) -> JChord {
    JChord {
        ci,
        number: "0".into(),
        jp_octave: 0.0,
        jp_alter: " ".into(),
        lyrics: vec![],
        tuplet_begin: false,
        tuplet_end: false,
        tuplet: None,
        rest: false,
        beats: 0.0,
        beams: 0.0,
        dot: 0.0,
        position: Fraction::int(0.0),
        duration: Fraction::int(0.0),
        slur_start: false,
        slur_end_chords: vec![],
        fermata: false,
        harmony: None,
        section_word: None,
        directions: vec![],
        articulations: vec![],
        grace_notes: vec![],
    }
}

/// 和弦 `ci` → (小节, 条目)
type At = HashMap<usize, (usize, usize)>;

/// 连音首尾两两配对（起、止、起、止…）；配不上（首是止、尾是起）报错（原 TS 抛空错）
fn pair_tuplets(measures: &mut [JMeasure], at: &At, notes: &[usize]) -> R<()> {
    let mut i = 0;
    while i + 1 < notes.len() {
        let (a, b) = (notes[i], notes[i + 1]);
        let (am, ae) = at[&a];
        let (bm, be) = at[&b];
        if measures[am].chord_mut(ae).tuplet_end || measures[bm].chord_mut(be).tuplet_begin {
            return Err(String::new());
        }
        measures[am].chord_mut(ae).tuplet = Some((a, b));
        measures[bm].chord_mut(be).tuplet = Some((a, b));
        i += 2;
    }
    Ok(())
}

/// 按时值排出各和弦的拍位与小节起点（多连音起止之间的音也乘 2/3）
fn layout_times(measures: &mut [JMeasure]) {
    let mut in_tuplet = false;
    for m in measures.iter_mut() {
        let mut pos = Fraction::int(0.0);
        for e in m.entries.iter_mut() {
            let JEntry::Chord(c) = e else { continue };
            c.position = pos;
            let mut dur = nominal(c);
            if c.tuplet.is_some() && c.tuplet_begin {
                in_tuplet = true;
            }
            if in_tuplet || c.tuplet.is_some() {
                dur = dur.times_int(2.0).div_int(3.0);
            }
            if c.tuplet.is_some() && c.tuplet_end {
                in_tuplet = false;
            }
            c.duration = dur;
            pos = pos.plus(&dur);
        }
    }
    let mut acc = Fraction::int(0.0);
    for m in measures.iter_mut() {
        m.position = acc;
        for c in m.chords() {
            acc = acc.plus(&c.duration);
        }
    }
}

fn attach(measures: &mut [JMeasure], at: (usize, usize), lyrics: &[LyricLine], cursors: &mut [usize]) {
    let syl = next_syllables(lyrics, cursors);
    measures[at.0].chord_mut(at.1).lyrics.extend(syl);
}

// ───────────────────────── 简谱形状（经排版行视图） ─────────────────────────

fn jianpu_input_of_doc(doc: &ScoreDoc) -> R<Option<JScore>> {
    let view = doc_view(doc, None);
    let Some(song) = view.songs.first() else { return Ok(None) };
    let Some(model_song) = view_song(doc, &view, 0) else { return Ok(None) };
    let Some(score) = song_input(song, model_song)? else { return Ok(None) };
    // 原 TS 这里还拼演唱顺序（写出端不用），推不出来照样报错
    play_data_of_song(doc, &view, 0, PlaySongOptions::default()).map_err(|e| e.0)?;
    Ok(Some(score))
}

fn song_input(song: &SongView, model: &Song) -> R<Option<JScore>> {
    let meta = &song.metadata;
    let mut credit: Vec<JCredit> = vec![];
    let mut push = |text: &str, kind: &str| {
        if !text.is_empty() {
            credit.push((Some(kind.to_string()), text.to_string()));
        }
    };
    for (i, t) in meta.titles.iter().enumerate() {
        push(t, if i == 0 { "title" } else { "subtitle" });
    }
    for t in meta.scripture.iter().flatten() {
        push(t, "scripture");
    }
    for a in &meta.authors {
        push(a, "composer");
    }
    for t in &meta.top_right {
        push(t, "composer");
    }
    for t in &meta.top_left {
        push(t, "lyricist");
    }
    let (beats, beat_type) = meta.meters.first().map_or((4.0, 4.0), |m| (m.numerator, m.denominator));
    let mode = meta.mode.as_deref().unwrap_or("C");
    let fifths = fifths_of_spelling(mode, meta.tonic.as_deref()).unwrap_or_else(|| key_name_to_fifth(mode));

    let mut parts = vec![];
    for v in voice_numbers(song) {
        let lines = lines_of_voice(song, v);
        if lines.is_empty() {
            continue;
        }
        let ends = page_ends(song, v);
        parts.push(rows_part(&lines, model, fifths, beats, beat_type, &ends)?);
    }
    if parts.is_empty() {
        return Ok(None);
    }
    Ok(Some(JScore { parts, title: meta.titles.first().cloned().unwrap_or_default(), credit }))
}

/// 源里 `[fenye]` 分出的页边界：每一页里该声部的最后一条曲行（末页不算）
fn page_ends(song: &SongView, voice: f64) -> Vec<*const RowView> {
    let n = song.pages.len();
    let mut out = vec![];
    for (i, pg) in song.pages.iter().enumerate() {
        if i + 1 == n {
            continue;
        }
        if let Some(r) = pg.groups.iter().flat_map(|g| g.voices.iter()).filter(|r| r.line.voice == voice).last() {
            out.push(r as *const RowView);
        }
    }
    out
}

/// 一个声部的所有曲行接成一串小节，行与行之间插换行（原 TS `rowsPart`，`decorate` 档、不顺延段号）
fn rows_part(lines: &[&RowView], model: &Song, fifths: f64, beats: f64, beat_type: f64, page_ends: &[*const RowView]) -> R<Vec<JMeasure>> {
    let mut measures: Vec<JMeasure> = vec![];
    let mut measure: Option<usize> = None;
    let mut next_ci = 0usize;
    let mut at: At = HashMap::new();
    let mut tuplet_notes: Vec<usize> = vec![];
    // 开着的弧的起点（`ci`，后开先收）；跨行的弧靠它连到下一行的收尾处
    let mut slur_open: Vec<usize> = vec![];
    let mut new_measure_needed = true;
    let mut last_chord: Option<(usize, usize)> = None;
    let mut pending_repeat_forward = false;
    let mut pending_ending: Option<Option<String>> = None;
    let (mut cur_fifths, mut cur_beats, mut cur_beat_type) = (fifths, beats, beat_type);
    // 曲中转调 / 转拍号：按符号的来源小节取模型小节的 `attrs`，与当前的不同才算变（每个模型小节只读一次）
    let mut seen: HashSet<(usize, usize)> = HashSet::new();

    let n_lines = lines.len();
    for (li, row) in lines.iter().enumerate() {
        let line = &row.line;
        let refs = &row.refs;
        let part = model.parts.get(row.part);
        let src_of = |index: usize| -> Option<(usize, &DocMeasure)> {
            let r = refs.get(index)?;
            Some((r.m, part?.measures.get(r.m)?))
        };
        let mut open = |measures: &mut Vec<JMeasure>, src: Option<(usize, &DocMeasure)>| -> usize {
            let mut m = JMeasure::new(cur_fifths, cur_beats, cur_beat_type);
            if let Some((mi, dm)) = src {
                if seen.insert((row.part, mi)) {
                    let attrs = dm.attrs.as_ref();
                    if let Some(k) = attrs.and_then(|a| a.key.as_ref()) {
                        if !measures.is_empty() && k.fifths != cur_fifths {
                            cur_fifths = k.fifths;
                            m.fifths = k.fifths;
                            m.key_change = true;
                        }
                    }
                    if let Some(t) = attrs.and_then(|a| a.time.as_ref()) {
                        if !measures.is_empty() && (t.beats != cur_beats || t.beat_type != cur_beat_type) {
                            cur_beats = t.beats;
                            cur_beat_type = t.beat_type;
                            m.beats = t.beats;
                            m.beat_type = t.beat_type;
                            m.time_change = true;
                        }
                    }
                    // 小节左线上的反复起点：排版行视图不把左线输出成元素，直接从模型读
                    if dm.barlines.iter().flatten().any(|b| b.location == BarLocation::Left && b.repeat == Some(RepeatDir::Forward)) {
                        m.repeat_forward = true;
                    }
                }
            }
            measures.push(m);
            measures.len() - 1
        };
        let lyrics = &line.lyrics;
        let mut cursors = vec![0usize; lyrics.len()];
        let voltas: Vec<&Mark> = line.marks.iter().filter(|m| m.kind == MarkType::Volta).collect();

        for (index, el) in line.elements.iter().enumerate() {
            let ix = index as i64;
            for mk in &voltas {
                if mk.start == ix && mk.continuation_from_previous != Some(true) {
                    pending_ending = Some(mk.caption.clone());
                }
            }
            let n = match el {
                MusicElement::BeatBoundary(_) | MusicElement::InlineLayer(_) => continue,
                MusicElement::Sustain(su) => {
                    // 增时线并进前一个音符的时值
                    if let Some((m, e)) = last_chord {
                        measures[m].chord_mut(e).beats += 1.0;
                        if su.lyric_anchor {
                            attach(&mut measures, (m, e), lyrics, &mut cursors);
                        }
                    }
                    continue;
                }
                MusicElement::Barline(b) => {
                    // 显式前导线只用于原样显示，仍是小节分界
                    let left = refs.get(index).and_then(|r| {
                        let m = part?.measures.get(r.m)?;
                        m.barlines.as_ref()?.get(r.b?).map(|bl| bl.location == BarLocation::Left)
                    });
                    if left == Some(true) {
                        new_measure_needed = true;
                        continue;
                    }
                    let mea = match measure {
                        Some(m) => m,
                        None => {
                            let m = open(&mut measures, src_of(index));
                            measure = Some(m);
                            m
                        }
                    };
                    let mm = &mut measures[mea];
                    match b.kind {
                        BarlineType::RepeatStart => pending_repeat_forward = true,
                        BarlineType::RepeatEnd => mm.repeat_backward = true,
                        BarlineType::RepeatBoth => {
                            mm.repeat_backward = true;
                            pending_repeat_forward = true;
                        }
                        _ => {}
                    }
                    mm.entries.push(JEntry::Bar);
                    // 小节线上的跳转记号贴着这条线、挂在它前面那个音上
                    if let Some((m, e)) = last_chord {
                        let c = measures[m].chord_mut(e);
                        for orn in &b.ornaments {
                            if let Some(d) = barline_dir(&orn.name) {
                                c.directions.push(d);
                            }
                        }
                    }
                    new_measure_needed = true;
                    continue;
                }
                MusicElement::Note(n) => n,
            };

            let mea = match measure {
                Some(m) if !new_measure_needed => m,
                _ => {
                    let m = open(&mut measures, src_of(index));
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
                let text = caption.as_deref().map(js::trim).unwrap_or("");
                measures[mea].ending_num = digit_runs(text).map(dedup);
            }

            let ci = next_ci;
            next_ci += 1;
            let mut ch = new_chord(ci);
            ch.number = if n.sound == Sound::Rhythm { "0".into() } else { n.pitch.to_string() };
            ch.jp_octave = n.octave as f64;
            ch.jp_alter = jp_alter_of(n).to_string();
            ch.beats = 1.0;
            ch.beams = js::max(0.0, js::round((n.duration as f64 / 4.0).log2()));
            ch.dot = n.dots as f64;
            ch.rest = n.hidden || n.sound == Sound::Rest || n.sound == Sound::Rhythm || ch.number == "0";

            let (tb, te) = edge_at(&line.marks, ix, MarkType::Tuplet);
            ch.tuplet_begin = tb;
            ch.tuplet_end = te;
            if tb || te {
                tuplet_notes.push(ci);
            }
            // 先收后起：同一个音既收前一条弧又起下一条；同一个音可收几条、起几条
            let slur_ends = marks_at(&line.marks, ix, MarkType::Slur).filter(|m| m.end == ix && m.continuation_to_next != Some(true)).count();
            for _ in 0..slur_ends {
                if let Some(from) = slur_open.pop() {
                    let (m, e) = at[&from];
                    measures[m].chord_mut(e).slur_end_chords.push(ci);
                }
            }
            for m in marks_at(&line.marks, ix, MarkType::Slur) {
                if m.start != ix || m.continuation_from_previous == Some(true) {
                    continue;
                }
                ch.slur_start = true;
                slur_open.push(ci);
            }
            ch.fermata = n.ornaments.iter().any(|o| o.name == "yc" || o.name == "ycy");
            decorate_chord(&mut ch, n);
            ch.grace_notes = n
                .grace_before
                .iter()
                .map(|g| JGrace { number: g.pitch.to_string(), jp_octave: g.octave as f64, jp_alter: jp_alter_of(g).to_string(), duration: Some(g.duration as f64) })
                .collect();
            let mm = &mut measures[mea];
            mm.entries.push(JEntry::Chord(ch));
            let pos = (mea, mm.entries.len() - 1);
            at.insert(ci, pos);
            last_chord = Some(pos);
            if takes_lyric(el) {
                attach(&mut measures, pos, lyrics, &mut cursors);
            }
        }
        // 行末换行（末行不加）。`[fenye]` 落在这一行末尾时写成换页
        if li + 1 < n_lines {
            if let Some(m) = measure {
                let new_page = page_ends.contains(&(*row as *const RowView));
                measures[m].entries.push(JEntry::Break { new_page });
            }
        }
    }

    pair_tuplets(&mut measures, &at, &tuplet_notes)?;
    layout_times(&mut measures);
    Ok(measures)
}

/// 小节线上的反复 / 导航记号（原 TS `BARLINE_MARKS`）：`Fine` / `D.C.` / `D.S.` 是文字，`ty` / `hs` 是跳跃 / 花 S 字形
fn barline_dir(name: &str) -> Option<JDir> {
    Some(match name {
        "fine" => JDir::Text("Fine".into()),
        "dc" => JDir::Text("D.C.".into()),
        "ds" => JDir::Text("D.S.".into()),
        "ty" => JDir::Coda,
        "hs" => JDir::Segno,
        _ => return None,
    })
}

/// 文本谱 `&xx` 记号 → 奏法记号名
fn artic_of_ornament(name: &str) -> Option<&'static str> {
    Some(match name {
        "zy" => "accent",
        "dy" => "staccato",
        "bc" => "tenuto",
        "hx" => "breath",
        _ => return None,
    })
}

/// 简谱档才要的那几样：和弦、段落词、奏法、力度 / 术语 / 跳转记号（原 TS `decorateChord`）
fn decorate_chord(ch: &mut JChord, el: &NoteElement) {
    if let Some(c) = el.chord.as_ref().filter(|c| !c.is_empty()) {
        ch.harmony = Some(c.clone());
    }
    if let Some(a) = el.annotation.as_ref().filter(|a| !a.is_empty()) {
        ch.section_word = Some(a.clone());
    }
    for orn in &el.ornaments {
        let name = orn.name.as_str();
        if let Some(art) = artic_of_ornament(name) {
            ch.articulations.push(art.to_string());
        } else if is_dynamic_name(name) {
            ch.directions.push(JDir::Dynamic(name.to_string()));
        } else if let Some(t) = term_text(name) {
            ch.directions.push(JDir::Text(t.to_string()));
        } else if let Some(d) = barline_dir(name) {
            ch.directions.push(d);
        }
    }
}

// ───────────────────────── `.jpwabc` ─────────────────────────

/// 倚音的符号时值 → `JGrace.duration`（四分及未记的按八分画一条）
fn grace_duration(kind: Option<&NoteType>) -> Option<f64> {
    match kind? {
        NoteType::Eighth => Some(8.0),
        NoteType::N16th => Some(16.0),
        NoteType::N32nd => Some(32.0),
        _ => None,
    }
}

fn jianpu_input_of_jpw(doc: &ScoreDoc) -> R<Option<JScore>> {
    let Some(song) = doc.songs.first() else { return Ok(None) };
    let Some(part) = song.parts.first() else { return Ok(None) };
    let credit: Vec<JCredit> = song.credits.iter().flatten().map(|c| (None, c.text.clone())).collect();
    let mut fifths = song.key.as_ref().map_or(0.0, |k| k.fifths);
    let (mut beats, mut beat_type) = song.time.as_ref().map_or((4.0, 4.0), |t| (t.beats, t.beat_type));

    let mut marks_from: HashMap<u32, Vec<&dolce_model::Mark>> = HashMap::new();
    let mut marks_to: HashMap<u32, Vec<&dolce_model::Mark>> = HashMap::new();
    for mk in &song.marks {
        if mk.kind != DocMarkType::Slur && mk.kind != DocMarkType::Tuplet {
            continue;
        }
        marks_from.entry(mk.start).or_default().push(mk);
        marks_to.entry(mk.end).or_default().push(mk);
    }
    let mut ci_of_id: HashMap<u32, usize> = HashMap::new();
    let mut at: At = HashMap::new();
    let mut slur_ends: Vec<(usize, u32)> = vec![];
    // 带小节中间换行的和弦
    let mut inline_break: HashSet<u32> = HashSet::new();
    let mut tuplet_notes: Vec<usize> = vec![];
    let mut measures: Vec<JMeasure> = vec![];
    // 各小节里和弦的 id
    let mut measure_ids: Vec<Vec<u32>> = vec![];
    let mut graces: Vec<JGrace> = vec![];
    let mut next_ci = 0usize;

    for (i, dm) in part.measures.iter().enumerate() {
        let attrs = dm.attrs.as_ref();
        let key = attrs.and_then(|a| a.key.as_ref());
        let time = attrs.and_then(|a| a.time.as_ref());
        if let (Some(k), true) = (key, i > 0) {
            fifths = k.fifths;
        }
        if let (Some(t), true) = (time, i > 0) {
            beats = t.beats;
            beat_type = t.beat_type;
        }
        let mut m = JMeasure::new(fifths, beats, beat_type);
        m.key_change = i > 0 && key.is_some();
        m.time_change = i > 0 && time.is_some();
        // 小节之间的换行落在上一小节末；上一小节里已有小节中间换行时，那就是同一处 `$`
        let print = dm.print.as_ref();
        let brk = if print.is_some_and(|p| p.new_page == Some(true)) {
            Some(true)
        } else if print.is_some_and(|p| p.new_system == Some(true)) {
            Some(false)
        } else {
            None
        };
        if let (Some(new_page), Some(prev)) = (brk, measures.last_mut()) {
            if !measure_ids[i - 1].iter().any(|id| inline_break.contains(id)) {
                prev.entries.push(JEntry::Break { new_page });
            }
        }
        measures.push(m);
        measure_ids.push(vec![]);
        let mi = measures.len() - 1;

        for el in &dm.elements {
            let Element::Chord(el) = el else { continue };
            let d = el.notes.first().and_then(|n| n.degree.as_ref());
            if el.grace.is_some() {
                graces.push(JGrace {
                    number: js::num_to_string(d.map_or(1.0, |d| d.number)),
                    jp_octave: d.map_or(0.0, |d| d.octave_shift),
                    jp_alter: jp_alter_of_accidental(d.and_then(|d| d.accidental.as_ref())).to_string(),
                    duration: grace_duration(el.duration.kind.as_ref()),
                });
                continue;
            }
            let ci = next_ci;
            next_ci += 1;
            ci_of_id.insert(el.id, ci);
            let mut ch = new_chord(ci);
            ch.rest = d.is_none() || el.rest.is_some();
            ch.number = match d {
                Some(d) if el.rest.is_none() => js::num_to_string(d.number),
                _ => "0".into(),
            };
            ch.jp_octave = d.map_or(0.0, |d| d.octave_shift);
            ch.jp_alter = jp_alter_of_accidental(d.and_then(|d| d.accidental.as_ref())).to_string();
            ch.beams = el.beams.as_ref().map_or(0, |b| b.len()) as f64;
            ch.beats = el.sustains.as_ref().map_or(0, |s| s.len()) as f64 + 1.0;
            ch.dot = el.duration.dots;
            ch.fermata = el.notations.as_ref().is_some_and(|n| n.fermata == Some(true));
            for l in el.lyrics.iter().flatten() {
                ch.lyrics.push((l.number, l.text.clone()));
            }
            ch.grace_notes = std::mem::take(&mut graces);
            for mk in marks_to.get(&el.id).into_iter().flatten() {
                if mk.kind != DocMarkType::Slur {
                    ch.tuplet_end = true;
                }
            }
            for mk in marks_from.get(&el.id).into_iter().flatten() {
                if mk.kind == DocMarkType::Slur {
                    ch.slur_start = true;
                    slur_ends.push((ci, mk.end));
                } else {
                    ch.tuplet_begin = true;
                }
            }
            // 原 TS 起、止各推一次（同一个音既起又止就推两次，配对时报错）
            if ch.tuplet_begin {
                tuplet_notes.push(ci);
            }
            if ch.tuplet_end {
                tuplet_notes.push(ci);
            }
            let m = &mut measures[mi];
            m.entries.push(JEntry::Chord(ch));
            at.insert(ci, (mi, m.entries.len() - 1));
            measure_ids[mi].push(el.id);
            if let Some(kind) = &el.line_break_after {
                inline_break.insert(el.id);
                m.entries.push(JEntry::Break { new_page: *kind == BreakKind::Page });
            }
        }
        if dm.barlines.iter().flatten().any(|b| b.location == BarLocation::Right) {
            measures[mi].entries.push(JEntry::Bar);
        }
    }
    if let (Some(last), Some(kind)) = (measures.last_mut(), part.end_break.as_ref()) {
        last.entries.push(JEntry::Break { new_page: *kind == BreakKind::Page });
    }
    for (from, to) in slur_ends {
        if let Some(&end) = ci_of_id.get(&to) {
            let (m, e) = at[&from];
            measures[m].chord_mut(e).slur_end_chords.push(end);
        }
    }
    pair_tuplets(&mut measures, &at, &tuplet_notes)?;
    layout_times(&mut measures);
    // 原 TS 这里还拼演唱顺序（写出端不用），推不出来照样报错
    let view = doc_view(doc, None);
    play_data_of_song(doc, &view, 0, PlaySongOptions::default()).map_err(|e| e.0)?;
    Ok(Some(JScore { parts: vec![measures], title: song.work.title.clone().unwrap_or_default(), credit }))
}
