//! MIDI → `ScoreDoc`（**MusicXML 形状**：绝对音高 + 每小节 divisions），同 `midi/import.ts`。
//!
//! MIDI 只有音高和时间，与 MusicXML 形状同类，所以直接建这一形状的模型：简谱度数、增时线/减时线由
//! `jianpuproject` 投影（与打开 MusicXML 同一条），要 MusicXML 就走唯一写出端 `toxml`，
//! 编辑器里按打开 MusicXML 的流程落地（转成设置里的默认编辑格式、多声部进五线谱）。
//!
//! 这是**量化后的记谱重建**，不是无损的事件编辑：
//! - 量化按拍：网格选「1/16 与三连音」时每拍各算一遍，起止点贴 1/16 与贴八分三连音哪个误差小用哪个
//!   （三连音要明显更贴才用，人奏的十六分音符抖一点不该读成三连音）；复拍子（x/8）与跨小节线的拍不认三连音。
//! - 声部按小节分：每小节里起止相同的音并成和弦，互相重叠的才另开声部；连奏时前一个音拖进后一个音的一小截截掉。
//! - 音名按调号拼：调内音照调号，调外音在升号调（含 C）记升、降号调记降；临时记号的印法走 `edit::respell_measure`。
//! - 变速只取首个速度，踏板/控制器/弯音、打击乐通道不转写（导入后在状态栏提示）。
//!
//! 位置一律 `f64`（TS `number`；tick × 48/ppq 不一定是整数）。TS 按 `RawNote` 对象身份记的表（上一段的和弦、上一小节的声部）
//! 改按声部内音符下标记（量化、去重之后不再增删）。提示与报错只给 `Msg` 键。

use super::smf::{parse_smf, SmfEvent};
use dolce_base::js;
use dolce_base::Msg;
use dolce_model::edit::respell_measure;
use dolce_model::helpers::{empty_doc, empty_song, IdGen};
use dolce_model::jianpu::assign_degrees;
use dolce_model::*;
use dolce_play::jppitch::key_alter;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// 量化网格：`16t` = 每拍在 1/16 与八分三连音之间择优
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MidiGrid {
    #[serde(rename = "16t")]
    Mixed,
    #[serde(rename = "16")]
    N16,
    #[serde(rename = "32")]
    N32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MidiImportOptions {
    pub grid: MidiGrid,
    /// 给了就不读文件里的调号
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fifths: Option<f64>,
    /// 给了就不读文件里的拍号
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub beats: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub beat_type: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct MidiImportResult {
    pub doc: ScoreDoc,
    /// 给状态栏的提示（量化、略去了什么）：只有键
    pub warnings: Vec<Msg>,
}

/// 一个四分音符的 divisions：到 32 分音符与三连音都是整数
const Q: f64 = 48.0;
const TRIPLET: f64 = Q / 3.0;
const MAX_BYTES: usize = 10 * 1024 * 1024;
const MAX_NOTES: usize = 20000;
const MAX_PARTS: usize = 32;
const MAX_BARS: usize = 2000;
const MAX_VOICES: usize = 16;

/// 不带连音的时值，大的在前
const STRAIGHT: [(f64, NoteType, f64); 10] = [
    (192.0, NoteType::Whole, 0.0),
    (144.0, NoteType::Half, 1.0),
    (96.0, NoteType::Half, 0.0),
    (72.0, NoteType::Quarter, 1.0),
    (48.0, NoteType::Quarter, 0.0),
    (36.0, NoteType::Eighth, 1.0),
    (24.0, NoteType::Eighth, 0.0),
    (18.0, NoteType::N16th, 1.0),
    (12.0, NoteType::N16th, 0.0),
    (6.0, NoteType::N32nd, 0.0),
];

#[derive(Clone, Debug)]
struct RawNote {
    start: f64,
    end: f64,
    pitch: u8,
}

#[derive(Clone, Debug)]
struct Bar {
    start: f64,
    end: f64,
    time: Time,
    key: Key,
    time_changed: bool,
    key_changed: bool,
}

/// 一小节里起止相同的一组音（截在小节内）。`notes` 是整音在声部里的下标：跨小节的延音线按它接
struct Seg {
    start: f64,
    end: f64,
    notes: Vec<usize>,
}

/// 一段时值：`beat` 是所在的三连音拍（不在三连音拍里为 `None`）
struct Piece {
    dur: f64,
    kind: NoteType,
    dots: f64,
    beat: Option<i64>,
}

struct RawPart {
    name: Option<String>,
    notes: Vec<RawNote>,
    triplet: HashSet<i64>,
}

fn invalid() -> Msg {
    Msg::new("midi.invalid")
}
fn too_large() -> Msg {
    Msg::new("midi.limit")
}

/// 拍号（`Math.floor(x / Q)`）
fn beat_of(x: f64) -> i64 {
    (x / Q).floor() as i64
}

fn time_of(beats: f64, beat_type: f64) -> Time {
    Time { beats, beat_type, symbol: None, parenthesized: None }
}

fn key_of(fifths: f64, minor: bool) -> Key {
    Key { fifths, mode: Some(if minor { "minor" } else { "major" }.into()), ..Key::default() }
}

/// 拍号变在小节中间（少见）就在那里断开
fn extend_bars(bars: &mut Vec<Bar>, until: f64, meters: &[(f64, Time)], keys: &[(f64, Key)], step: f64) -> Result<(), Msg> {
    while bars.last().is_none_or(|b| b.end < until) {
        if bars.len() >= MAX_BARS {
            return Err(too_large());
        }
        let start = bars.last().map_or(0.0, |b| b.end);
        // 拍号、调号事件离小节线差一点（未量化的 tick）也算在这一小节起
        let meter = meters.iter().rev().find(|m| m.0 <= start + step / 2.0).map_or_else(|| time_of(4.0, 4.0), |m| m.1.clone());
        let key = keys.iter().rev().find(|k| k.0 <= start + Q / 2.0).map_or_else(|| key_of(0.0, false), |k| k.1.clone());
        let next_meter = meters.iter().find(|m| m.0 > start + step / 2.0);
        let len = (Q * 4.0 * meter.beats) / meter.beat_type;
        // 小节线落在 32 分音符的格上（拍号到 x/32，各小节长都是 6 的倍数）
        let end = match next_meter {
            Some(n) => js::min(start + len, js::max(start + 6.0, js::round(n.0 / 6.0) * 6.0)),
            None => start + len,
        };
        let prev = bars.last();
        let time_changed = prev.is_none_or(|p| p.time.beats != meter.beats || p.time.beat_type != meter.beat_type);
        let key_changed = prev.is_none_or(|p| p.key.fifths != key.fifths || p.key.mode != key.mode);
        bars.push(Bar { start, end, time: meter, key, time_changed, key_changed });
    }
    Ok(())
}

fn bar_at(bars: &[Bar], x: f64) -> Option<&Bar> {
    bars.iter().find(|b| b.start <= x && x < b.end)
}

/// `title`：曲名（文件名）。报错（不是能读的 MIDI / 太大）只给键。
pub fn midi_to_score_doc(bytes: &[u8], title: &str, options: &MidiImportOptions) -> Result<MidiImportResult, Msg> {
    if bytes.len() > MAX_BYTES {
        return Err(invalid());
    }
    let smf = parse_smf(bytes).ok_or_else(invalid)?;
    if smf.format > 1 {
        return Err(invalid());
    }
    let scale = Q / smf.ppq as f64;

    // ── 读事件：每轨每通道一个声部 ──
    let mut meters: Vec<(f64, Time)> = vec![];
    let mut keys: Vec<(f64, Key)> = vec![];
    let mut tempos: Vec<(f64, f64)> = vec![];
    let mut parts: Vec<RawPart> = vec![];
    let (mut drums, mut controls, mut dangling) = (false, false, false);
    for track in &smf.tracks {
        let mut name: Option<String> = None;
        let mut by_channel: Vec<(u8, Vec<RawNote>)> = vec![];
        let mut open: HashMap<u32, Vec<f64>> = HashMap::new(); // 通道×128+音高 → 未收的起点（先开先收）
        for e in track {
            let at = e.tick() * scale;
            match e {
                SmfEvent::TrackName { text, .. } => {
                    if !text.is_empty() {
                        name = Some(text.clone());
                    }
                }
                SmfEvent::Tempo { us_per_quarter, .. } => {
                    if *us_per_quarter > 0.0 {
                        tempos.push((at, 60_000_000.0 / us_per_quarter));
                    }
                }
                SmfEvent::TimeSig { beats, beat_type, .. } => meters.push((at, time_of(*beats, *beat_type))),
                SmfEvent::KeySig { fifths, minor, .. } => keys.push((at, key_of(*fifths, *minor))),
                SmfEvent::Expression { .. } => controls = true,
                SmfEvent::NoteOn { channel, pitch, .. } | SmfEvent::NoteOff { channel, pitch, .. } => {
                    if *channel == 9 {
                        drums = true;
                        continue;
                    }
                    let k = *channel as u32 * 128 + *pitch as u32;
                    let q = open.entry(k).or_default();
                    if matches!(e, SmfEvent::NoteOn { .. }) {
                        q.push(at);
                    } else if !q.is_empty() {
                        let start = q.remove(0);
                        let i = match by_channel.iter().position(|(c, _)| c == channel) {
                            Some(i) => i,
                            None => {
                                by_channel.push((*channel, vec![]));
                                by_channel.len() - 1
                            }
                        };
                        by_channel[i].1.push(RawNote { start, end: at, pitch: *pitch });
                    }
                }
            }
        }
        dangling = dangling || open.values().any(|q| !q.is_empty());
        let multi = by_channel.len() > 1;
        for (ch, notes) in by_channel {
            let label = if multi {
                let ch = (ch as u32 + 1).to_string();
                Some(match &name {
                    Some(n) => format!("{n} · {ch}"),
                    None => ch,
                })
            } else {
                name.clone()
            };
            parts.push(RawPart { name: label, notes, triplet: HashSet::new() });
        }
    }
    let note_count: usize = parts.iter().map(|p| p.notes.len()).sum();
    if note_count == 0 || note_count > MAX_NOTES || parts.len() > MAX_PARTS {
        return Err(too_large());
    }
    js::sort_by(&mut meters, |a, b| a.0 - b.0);
    js::sort_by(&mut keys, |a, b| a.0 - b.0);
    js::sort_by(&mut tempos, |a, b| a.0 - b.0);
    if let (Some(beats), Some(beat_type)) = (options.beats, options.beat_type) {
        meters = vec![(0.0, time_of(beats, beat_type))];
    }
    if let Some(f) = options.fifths {
        keys = vec![(0.0, key_of(f, false))];
    }
    for (_, t) in &meters {
        if !(t.beats >= 1.0 && t.beats <= 32.0 && [1.0, 2.0, 4.0, 8.0, 16.0, 32.0].contains(&t.beat_type)) {
            return Err(invalid());
        }
    }
    if keys.iter().any(|(_, k)| k.fifths.abs() > 7.0) {
        return Err(invalid());
    }

    // ── 小节 ──
    let step = if options.grid == MidiGrid::N32 { 6.0 } else { 12.0 };
    let mut bars: Vec<Bar> = vec![];
    let raw_end = parts.iter().flat_map(|p| p.notes.iter().map(|n| n.end)).fold(f64::NEG_INFINITY, js::max);
    extend_bars(&mut bars, raw_end + 1.0, &meters, &keys, step)?;

    // ── 量化 ──
    for p in &mut parts {
        if options.grid == MidiGrid::Mixed {
            p.triplet = triplet_beats(&p.notes, step, &bars);
        }
        let triplet = &p.triplet;
        let grid_at = |x: f64| if triplet.contains(&beat_of(x)) { TRIPLET } else { step };
        let quantize = |x: f64| {
            let g = grid_at(x);
            js::max(0.0, js::round(x / g) * g)
        };
        for n in &mut p.notes {
            n.start = quantize(n.start);
            n.end = js::max(quantize(n.end), n.start + grid_at(n.start));
        }
        trim_overlaps(&mut p.notes, &grid_at);
    }
    let end = parts.iter().flat_map(|p| p.notes.iter().map(|n| n.end)).fold(f64::NEG_INFINITY, js::max);
    extend_bars(&mut bars, end, &meters, &keys, step)?;
    // `splice(findIndex + 1)`：找不到时 TS 是 `splice(0)` 清空（extend_bars 之后总能找到）
    let keep = bars.iter().position(|b| b.end >= end).map_or(0, |i| i + 1);
    bars.truncate(keep);

    // ── 建模型 ──
    let mut ids = IdGen::new();
    let mut marks: Vec<Mark> = vec![];
    let mut song = empty_song();
    song.work.title = Some(title.to_string());
    song.key = Some(bars[0].key.clone());
    song.time = Some(bars[0].time.clone());
    let bpm = js::round(tempos.first().map_or(120.0, |t| t.1));
    for (pi, p) in parts.iter().enumerate() {
        let triplet = &p.triplet;
        let mut part = Part { id: format!("P{}", pi + 1), name: p.name.clone(), ..Part::default() };
        let avg = p.notes.iter().fold(0.0, |s, n| s + n.pitch as f64) / p.notes.len() as f64;
        let clef = if avg < 55.0 {
            Clef { sign: ClefSign::F, line: Some(4.0), octave_change: None, staff: None }
        } else {
            Clef { sign: ClefSign::G, line: Some(2.0), octave_change: None, staff: None }
        };
        // 整音（下标）→ 它上一段写成的那个和弦与第几个音（延音线接下一段用）；上一小节在第几声部（跨小节尽量留在同一声部）
        let mut last_piece: HashMap<usize, (ElementId, usize)> = HashMap::new();
        let mut last_voice: HashMap<usize, usize> = HashMap::new();
        for (bi, bar) in bars.iter().enumerate() {
            let mut m = Measure { number: (bi + 1).to_string(), ..Measure::default() };
            if bi == 0 {
                m.attrs = Some(MeasureAttrs {
                    divisions: Some(Q),
                    key: Some(bar.key.clone()),
                    time: Some(bar.time.clone()),
                    clefs: Some(vec![clef.clone()]),
                    ..MeasureAttrs::default()
                });
            } else if bar.key_changed || bar.time_changed {
                m.attrs = Some(MeasureAttrs {
                    key: bar.key_changed.then(|| bar.key.clone()),
                    time: bar.time_changed.then(|| bar.time.clone()),
                    ..MeasureAttrs::default()
                });
            }
            if bi == 0 && pi == 0 {
                m.directions = Some(vec![Direction {
                    kind: "metronome".into(),
                    placement: Some(Placement::Above),
                    tempo: Some(Metronome { beat_unit: Some(NoteType::Quarter), per_minute: Some(bpm), ..Metronome::default() }),
                    sound: Some(Sound { tempo: Some(bpm), ..Sound::default() }),
                    ..Direction::default()
                }]);
            }
            let voices = voices_of_bar(&p.notes, bar, &last_voice);
            if voices.len() > MAX_VOICES {
                return Err(too_large());
            }
            let is_triplet = |b: i64| triplet.contains(&b);
            for (vi, segs) in voices.iter().enumerate() {
                let mut elems: Vec<Chord> = vec![];
                let mut pos = bar.start;
                for seg in segs {
                    if seg.start > pos {
                        for pc in pieces(pos, seg.start, &is_triplet)? {
                            elems.push(chord_of(&pc, vec![], vi + 1, &mut ids));
                        }
                    }
                    let ps = pieces(seg.start, seg.end, &is_triplet)?;
                    for (k, pc) in ps.iter().enumerate() {
                        let notes: Vec<Note> = seg
                            .notes
                            .iter()
                            .map(|&ni| {
                                let n = &p.notes[ni];
                                let stop = k > 0 || n.start < seg.start;
                                let start = k < ps.len() - 1 || n.end > seg.end;
                                Note {
                                    pitch: Some(spell(n.pitch as f64, bar.key.fifths)),
                                    tie: (stop || start).then(|| Tie { start: start.then_some(true), stop: stop.then_some(true) }),
                                    ..Note::default()
                                }
                            })
                            .collect();
                        let ch = chord_of(pc, notes, vi + 1, &mut ids);
                        for (index, &ni) in seg.notes.iter().enumerate() {
                            if let Some(&(prev_id, prev_index)) = last_piece.get(&ni) {
                                if ch.notes[index].tie.as_ref().and_then(|t| t.stop) == Some(true) {
                                    marks.push(Mark {
                                        start_note: Some(prev_index as f64),
                                        end_note: Some(index as f64),
                                        ..Mark::new(MarkType::Tied, prev_id, ch.id)
                                    });
                                }
                            }
                            last_piece.insert(ni, (ch.id, index));
                            last_voice.insert(ni, vi);
                        }
                        elems.push(ch);
                    }
                    pos = seg.end;
                }
                if pos < bar.end {
                    for pc in pieces(pos, bar.end, &is_triplet)? {
                        elems.push(chord_of(&pc, vec![], vi + 1, &mut ids));
                    }
                }
                // 三连音：同一拍里连着的几段成一组
                let mut beat_of_el: Vec<Option<i64>> = vec![];
                let mut at = bar.start;
                for el in &elems {
                    beat_of_el.push(el.duration.time_mod.as_ref().map(|_| beat_of(at)));
                    at += el.duration.divisions;
                }
                let mut k = 0;
                while k < elems.len() {
                    let mut j = k;
                    while beat_of_el[k].is_some() && j + 1 < elems.len() && beat_of_el[j + 1] == beat_of_el[k] {
                        j += 1;
                    }
                    if beat_of_el[k].is_some() && j > k {
                        marks.push(Mark {
                            tuplet_actual: Some(3.0),
                            tuplet_normal: Some(2.0),
                            ..Mark::new(MarkType::Tuplet, elems[k].id, elems[j].id)
                        });
                    }
                    k = j + 1;
                }
                if vi > 0 {
                    if let Some(first) = elems.first_mut() {
                        first.onset = Some(0.0);
                    }
                }
                m.elements.extend(elems.into_iter().map(Element::Chord));
            }
            if bi == bars.len() - 1 {
                m.barlines = Some(vec![Barline {
                    style: Some(BarStyle::LightHeavy),
                    after_elements: Some(m.elements.len() as f64),
                    ..Barline::at(BarLocation::Right)
                }]);
            }
            respell_measure(&mut m, &bar.key);
            part.measures.push(m);
        }
        let initial = song.key.clone().unwrap_or_default();
        assign_degrees(&mut part, &initial);
        song.parts.push(part);
    }
    song.marks = marks;
    let mut doc = empty_doc(SourceFormat::MusicXml);
    doc.songs.push(song);

    let mut warnings = vec![Msg::new("midi.quantized")];
    if tempos.iter().any(|t| js::round(t.1) != bpm) {
        warnings.push(Msg::new("midi.tempoWarning"));
    }
    if drums {
        warnings.push(Msg::new("midi.drumsWarning"));
    }
    if controls {
        warnings.push(Msg::new("midi.controlWarning"));
    }
    if dangling {
        warnings.push(Msg::new("midi.danglingWarning"));
    }
    Ok(MidiImportResult { doc, warnings })
}

/// 哪几拍按三连音量化：拍里的起止点贴八分三连音的误差不到贴直网格的一半。复拍子、跨小节线的拍不认。
fn triplet_beats(notes: &[RawNote], step: f64, bars: &[Bar]) -> HashSet<i64> {
    let mut err: HashMap<i64, (f64, f64)> = HashMap::new();
    let off = |x: f64, g: f64| (x - js::round(x / g) * g).abs();
    for n in notes {
        for x in [n.start, n.end] {
            let e = err.entry(beat_of(x)).or_insert((0.0, 0.0));
            e.0 += off(x, step);
            e.1 += off(x, TRIPLET);
        }
    }
    let mut out = HashSet::new();
    for (&b, &(straight, triplet)) in &err {
        let Some(bar) = bar_at(bars, b as f64 * Q) else { continue };
        if bar.time.beat_type > 4.0 || bar.end < (b + 1) as f64 * Q {
            continue;
        }
        if triplet < straight * 0.5 {
            out.insert(b);
        }
    }
    out
}

/// 量化后仍重叠的：同音高的前一个收在后一个起点；连奏拖进下一个音的一小截（不超过一格、不到前音四分之一）截掉。
fn trim_overlaps(notes: &mut Vec<RawNote>, grid_at: &dyn Fn(f64) -> f64) {
    js::sort_by(notes, |a, b| {
        let d = a.start - b.start;
        if d != 0.0 && !d.is_nan() { d } else { a.pitch as f64 - b.pitch as f64 }
    });
    // 已按起点排好：去重即相邻去重
    let mut starts: Vec<f64> = vec![];
    for n in notes.iter() {
        if starts.last() != Some(&n.start) {
            starts.push(n.start);
        }
    }
    let mut si = 0;
    for i in 0..notes.len() {
        let a_start = notes[i].start;
        while si < starts.len() && starts[si] <= a_start {
            si += 1;
        }
        if let Some(&next) = starts.get(si) {
            let a = &mut notes[i];
            if a.end > next && a.end - next <= grid_at(next) && (a.end - next) * 4.0 <= a.end - a.start {
                a.end = next;
            }
        }
        let mut j = i + 1;
        while j < notes.len() && notes[j].start < notes[i].end {
            if notes[j].pitch == notes[i].pitch && notes[j].start > notes[i].start {
                notes[i].end = notes[j].start;
            }
            j += 1;
        }
    }
    // 同起点同音高的重复音只留一个
    let mut i = notes.len();
    while i > 1 {
        i -= 1;
        if notes[i].start == notes[i - 1].start && notes[i].pitch == notes[i - 1].pitch {
            notes.remove(i);
        }
    }
}

/// 一小节的声部：起止相同的并成和弦，按起点排，放进第一个已空出来的声部（上一小节接过来的音优先回原声部）。
fn voices_of_bar(notes: &[RawNote], bar: &Bar, last_voice: &HashMap<usize, usize>) -> Vec<Vec<Seg>> {
    let mut groups: Vec<Seg> = vec![]; // 按首次出现的次序（同 TS `Map`）
    for (ni, n) in notes.iter().enumerate() {
        if n.end <= bar.start || n.start >= bar.end {
            continue;
        }
        let start = js::max(n.start, bar.start);
        let end = js::min(n.end, bar.end);
        match groups.iter_mut().find(|g| g.start == start && g.end == end) {
            Some(g) => g.notes.push(ni),
            None => groups.push(Seg { start, end, notes: vec![ni] }),
        }
    }
    let mut order: Vec<usize> = (0..groups.len()).collect();
    js::sort_by(&mut order, |&a, &b| {
        let d = groups[a].start - groups[b].start;
        if d != 0.0 && !d.is_nan() { d } else { groups[b].end - groups[a].end }
    });
    let mut slots: Vec<Option<Seg>> = groups.into_iter().map(Some).collect();
    let mut voices: Vec<Vec<Seg>> = vec![vec![]];
    let free_at = |voices: &Vec<Vec<Seg>>, v: usize| voices[v].last().map_or(bar.start, |s| s.end);
    for oi in order {
        let mut s = slots[oi].take().unwrap();
        js::sort_by(&mut s.notes, |&a, &b| notes[a].pitch as f64 - notes[b].pitch as f64);
        let pref = s.notes.iter().find_map(|n| last_voice.get(n).copied());
        let v = match pref {
            Some(pv) if pv < voices.len() && free_at(&voices, pv) <= s.start => pv,
            _ => match (0..voices.len()).find(|&i| free_at(&voices, i) <= s.start) {
                Some(i) => i,
                None => {
                    voices.push(vec![]);
                    voices.len() - 1
                }
            },
        };
        voices[v].push(s);
    }
    voices
}

/// `[from, to)` 拆成能写的时值：三连音拍里按拍内切；直拍上不跨进三连音拍，拍中间起的不跨过下一拍。
fn pieces(from: f64, to: f64, is_triplet: &dyn Fn(i64) -> bool) -> Result<Vec<Piece>, Msg> {
    let mut out = vec![];
    let mut p = from;
    while p < to {
        let b = beat_of(p);
        let beat_end = (b + 1) as f64 * Q;
        if is_triplet(b) && !(p % Q == 0.0 && to - p >= Q) {
            let len = js::min(to, beat_end) - p;
            // `if (len % TRIPLET)`：NaN 不算
            let r = len % TRIPLET;
            if r != 0.0 && !r.is_nan() {
                return Err(invalid());
            }
            out.push(Piece { dur: len, kind: if len == 2.0 * TRIPLET { NoteType::Quarter } else { NoteType::Eighth }, dots: 0.0, beat: Some(b) });
            p += len;
            continue;
        }
        let mut limit = to;
        if p % Q != 0.0 {
            limit = js::min(limit, beat_end);
        } else {
            let mut k = b + 1;
            while (k as f64) * Q < limit {
                if is_triplet(k) {
                    limit = k as f64 * Q;
                    break;
                }
                k += 1;
            }
        }
        let Some((dur, kind, dots)) = STRAIGHT.iter().find(|s| s.0 <= limit - p).map(|s| (s.0, s.1.clone(), s.2)) else { return Err(invalid()) };
        out.push(Piece { dur, kind, dots, beat: None });
        p += dur;
    }
    Ok(out)
}

fn chord_of(pc: &Piece, notes: Vec<Note>, voice: usize, ids: &mut IdGen) -> Chord {
    let rest = notes.is_empty().then(RestInfo::default);
    Chord {
        id: ids.next(),
        notes,
        rest,
        duration: Duration {
            divisions: pc.dur,
            kind: Some(pc.kind.clone()),
            dots: pc.dots,
            time_mod: pc.beat.map(|_| TimeMod { actual: 3.0, normal: 2.0, normal_type: None }),
        },
        voice: voice as f64,
        staff: 1.0,
        ..Chord::default()
    }
}

const SEMITONE: [f64; 7] = [0.0, 2.0, 4.0, 5.0, 7.0, 9.0, 11.0];
const STEP_NAMES: [Step; 7] = [Step::C, Step::D, Step::E, Step::F, Step::G, Step::A, Step::B];

/// MIDI 音高按调号拼成音名：调内音照调号；调外音升号调（含 C）记升、降号调记降。
pub fn spell(midi: f64, fifths: f64) -> Pitch {
    let pc = midi % 12.0;
    let fit = |shift: f64| -> Option<Pitch> {
        for s in 0..7 {
            let alter = key_alter(s as f64, fifths) + shift;
            if (((SEMITONE[s] + alter) % 12.0) + 12.0) % 12.0 == pc {
                return Some(Pitch { step: STEP_NAMES[s].clone(), alter, octave: ((midi - SEMITONE[s] - alter) / 12.0).floor() - 1.0 });
            }
        }
        None
    };
    fit(0.0)
        .or_else(|| fit(if fifths < 0.0 { -1.0 } else { 1.0 }))
        .or_else(|| fit(if fifths < 0.0 { 1.0 } else { -1.0 }))
        .expect("十二个半音总拼得出")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn smf(tracks: &[&[u8]]) -> Vec<u8> {
        let mut b = b"MThd\0\0\0\x06\0\x01".to_vec();
        b.extend_from_slice(&(tracks.len() as u16).to_be_bytes());
        b.extend_from_slice(&480u16.to_be_bytes());
        for t in tracks {
            b.extend_from_slice(b"MTrk");
            b.extend_from_slice(&(t.len() as u32).to_be_bytes());
            b.extend_from_slice(t);
        }
        b
    }
    fn opts(grid: MidiGrid) -> MidiImportOptions {
        MidiImportOptions { grid, fifths: None, beats: None, beat_type: None }
    }

    #[test]
    fn spells_by_key() {
        let p = spell(61.0, 0.0);
        assert_eq!((p.step, p.alter, p.octave), (Step::C, 1.0, 4.0));
        let p = spell(61.0, -2.0);
        assert_eq!((p.step, p.alter, p.octave), (Step::D, -1.0, 4.0));
        let p = spell(70.0, -2.0);
        assert_eq!((p.step, p.alter), (Step::B, -1.0));
        let name = |m: f64, f: f64| {
            let p = spell(m, f);
            (p.step, p.alter, p.octave)
        };
        assert_eq!(name(70.0, -1.0), (Step::B, -1.0, 4.0));
        assert_eq!(name(65.0, 6.0), (Step::E, 1.0, 4.0)); // 升 F 大调的 E#
        assert_eq!(name(59.0, -7.0), (Step::C, -1.0, 4.0)); // 降 C 大调的 Cb
        assert_eq!(name(66.0, -2.0), (Step::G, -1.0, 4.0));
    }

    #[test]
    fn quarter_notes_and_tie_across_bar() {
        // 一个四分音符 C4，再一个横跨小节线的 D4（第 4 拍起、两拍长）
        let t: &[u8] = &[
            0, 0x90, 60, 90, 0x83, 0x60, 0x80, 60, 0, //
            0x87, 0x40, 0x90, 62, 90, 0x87, 0x40, 0x80, 62, 0, 0, 0xff, 0x2f, 0,
        ];
        let r = midi_to_score_doc(&smf(&[t]), "t", &opts(MidiGrid::N16)).unwrap();
        let song = &r.doc.songs[0];
        assert_eq!(song.parts[0].measures.len(), 2);
        assert_eq!(song.marks.iter().filter(|m| m.kind == MarkType::Tied).count(), 1);
        assert_eq!(r.warnings, vec![Msg::new("midi.quantized")]);
    }

    #[test]
    fn triplets_detected_in_mixed_grid() {
        // 480 ppq：三个 160 tick 的八分三连音
        let t: &[u8] = &[0, 0x90, 60, 90, 0x81, 0x20, 0x80, 60, 0, 0, 0x90, 62, 90, 0x81, 0x20, 0x80, 62, 0, 0, 0x90, 64, 90, 0x81, 0x20, 0x80, 64, 0];
        let r = midi_to_score_doc(&smf(&[t]), "t", &opts(MidiGrid::Mixed)).unwrap();
        assert_eq!(r.doc.songs[0].marks.iter().filter(|m| m.kind == MarkType::Tuplet).count(), 1);
        let r = midi_to_score_doc(&smf(&[t]), "t", &opts(MidiGrid::N16)).unwrap();
        assert_eq!(r.doc.songs[0].marks.iter().filter(|m| m.kind == MarkType::Tuplet).count(), 0);
    }

    #[test]
    fn rejects_empty_and_format2() {
        assert_eq!(midi_to_score_doc(&smf(&[&[0, 0xff, 0x2f, 0]]), "t", &opts(MidiGrid::N16)).unwrap_err(), Msg::new("midi.limit"));
        let mut b = smf(&[&[0, 0x90, 60, 90, 0x60, 0x80, 60, 0]]);
        b[9] = 2;
        assert_eq!(midi_to_score_doc(&b, "t", &opts(MidiGrid::N16)).unwrap_err(), Msg::new("midi.invalid"));
    }
}
