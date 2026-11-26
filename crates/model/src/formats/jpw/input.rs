//! `ScoreDoc` → `.jpwabc` 写出端的输入（[`super::write::JpwScoreIn`]），按形状两条路（同原 `model/playdoc.ts::jpwInputOfDoc`、
//! `jianpu/playsong.ts::jpwInputOfSong`），再交 [`super::write::write_jpwabc`]（[`emit_jpwabc`]，同原 `convert/jpwabc.ts`）。
//! 小节序列、演唱顺序由视图层（`dolce-view`）拼。

use std::collections::{HashMap, HashSet};

use crate::base::{js, Fraction};
use crate::breaks::breaks_of;
use crate::jianpu::top_note;
use crate::xmlproject::is_xml_shaped;
use crate::{BarLocation, Barline, Chord, Element, ElementId, MarkType, Measure, Note, ScoreDoc, Song};
use crate::play::jppitch::key_name;
use crate::view::phrasedoc::divisions_of;
use crate::view::phrasesong::{jp_alter_of_accidental, ChordOut, SeqItem};
use crate::view::playdata::PlayData;
use crate::view::playdoc::{play_data_of_doc, tempo_of_doc, DocPlayOptions};
use crate::view::playsong::{fold_to_first_part, play_data_of, song_measures, tempo_of_meta, PlaySongOptions};
use crate::view::slots::doc_view;

use super::write::{
    write_jpwabc, JpwChordIn, JpwCreditIn, JpwEntryIn, JpwKeyIn, JpwLyricIn, JpwMeasureIn, JpwNoteIn, JpwPartIn, JpwPitchIn, JpwPlayDataIn, JpwPlayItemIn,
    JpwScoreIn, JpwTimeIn,
};

type R<T> = Result<T, String>;

/// `ScoreDoc` → `.jpwabc` 文本（第 `song_idx` 首）。MusicXML 形状照 `loadMusicXml` 的口径，简谱形状照 `scoreDocToScore`。
/// 这首没有曲行时回 None；写不出（推演唱顺序出错、坏调号、写出端拒收）回 Err。
pub fn emit_jpwabc(doc: &ScoreDoc, song_idx: usize) -> R<Option<String>> {
    let Some(song) = doc.songs.get(song_idx) else { return Ok(None) };
    let src = if is_xml_shaped(song) { Some(jpw_input_of_doc(song)?) } else { jpw_input_of_song(doc, song_idx)? };
    match src {
        Some(s) => write_jpwabc(&s).map(Some).map_err(|e| e.0),
        None => Ok(None),
    }
}

fn play_data_in(pd: &PlayData) -> JpwPlayDataIn {
    JpwPlayDataIn {
        no_repeat: pd.no_repeat(),
        tempo: pd.tempo,
        measures: pd.measures.iter().map(|i| JpwPlayItemIn { mid: i.mid, end: i.end, pass: i.pass, skip: i.skip, limit: i.limit }).collect(),
    }
}

fn key_in(fifths: f64) -> R<JpwKeyIn> {
    match key_name(fifths) {
        Some(name) => Ok(JpwKeyIn { fifths, name: name.to_string() }),
        None => Err(format!("bad key fifths {}", js::num_to_string(fifths))),
    }
}

fn lyrics_in(ch: &ChordOut) -> Vec<JpwLyricIn> {
    ch.notes[0].lyrics.iter().map(|l| JpwLyricIn { text: l.text.clone(), number: l.number, refrain: l.refrain }).collect()
}

// ───────────────────────── 简谱形状 ─────────────────────────

/// 口径同 `jianpuInputOfDoc`（非投影档那一份）：第一个有曲行的声部；小节线条目与行末换行按原次序；标题 / credit 同 `songToScore`。
/// 这首没有曲行时回 None。
pub fn jpw_input_of_song(doc: &ScoreDoc, song_idx: usize) -> R<Option<JpwScoreIn>> {
    let view = doc_view(doc, None);
    let Some(built) = song_measures(doc, &view, song_idx, PlaySongOptions::default(), false).map_err(|e| e.0)? else { return Ok(None) };
    // `P:` 不展开进 `.Repeat`（只读的旧扩展）：存 `.jpwabc` 时走丢失提示，顺序按谱面记号推
    let pd = play_data_of(doc, song_idx, &built, false).map_err(|e| e.0)?;
    let mut pd = fold_to_first_part(pd, &built).map_err(|e| e.0)?;
    let meta = &built.view.metadata;
    if let Some(t) = tempo_of_meta(&meta.tempos) {
        pd.tempo = t;
    }
    let mut credit = vec![];
    let mut push = |text: &str, kind: &str| {
        if !text.is_empty() {
            credit.push(JpwCreditIn { kind: Some(kind.to_string()), text: text.to_string(), page: 0.0 });
        }
    };
    for (i, t) in meta.titles.iter().enumerate() {
        push(t, if i == 0 { "title" } else { "subtitle" });
    }
    // 作者条目照原文分行（`.jpwabc` 的 `WordsByAndMusicBy` 一条多行，行视图已取 credit 原文）
    for a in &meta.authors {
        push(a, "composer");
    }
    for t in &meta.top_right {
        push(t, "composer");
    }
    for t in &meta.top_left {
        push(t, "lyricist");
    }

    let key = key_in(built.key)?;
    let time = JpwTimeIn { beats: built.time.beats, beat_type: built.time.beat_type };
    // 换页：换行之后紧跟的那个音是换页的行首（`breaks_of`，小节级与小节中间的都在里面）
    let page_starts: HashSet<ElementId> = breaks_of(&doc.songs[song_idx]).into_iter().filter(|b| b.page).map(|b| b.id).collect();
    let part = &built.parts[0];
    // 拍平的 seq：(小节, 项)
    let flat: Vec<(usize, SeqItem)> = part.iter().enumerate().flat_map(|(mi, m)| m.seq.iter().map(move |&it| (mi, it))).collect();
    let page_after: HashSet<usize> = flat
        .iter()
        .enumerate()
        .filter(|(_, (_, it))| *it == SeqItem::Break)
        .filter(|(i, _)| {
            let next = flat[i + 1..].iter().find_map(|&(mi, it)| match it {
                SeqItem::Chord(k) => Some(&part[mi].entries[k]),
                _ => None,
            });
            next.and_then(|c| c.id).is_some_and(|id| page_starts.contains(&id))
        })
        .map(|(i, _)| i)
        .collect();
    let mut at = 0usize;
    let measures = part
        .iter()
        .map(|m| {
            let mut chords = 0;
            let entries = m
                .seq
                .iter()
                .map(|&it| {
                    let i = at;
                    at += 1;
                    match it {
                        SeqItem::Break => JpwEntryIn::LineBreak { new_page: page_after.contains(&i), pass: None },
                        SeqItem::Barline => JpwEntryIn::Barline { style: None, repeat: None, position: Fraction::int(if chords > 0 { 1.0 } else { 0.0 }) },
                        SeqItem::Chord(k) => {
                            chords += 1;
                            let c = &m.entries[k];
                            let n = &c.notes[0];
                            JpwEntryIn::Chord(JpwChordIn {
                                notes: vec![JpwNoteIn {
                                    number: n.number.clone(),
                                    jp_octave: n.jp_octave,
                                    jp_alter: n.jp_alter.clone(),
                                    tie_start: n.tie_start,
                                    tie_end: n.tie_end,
                                    tuplet_begin: c.tuplet_begin,
                                    tuplet_end: c.tuplet_end,
                                    lyrics: lyrics_in(c),
                                }],
                                rest: c.rest,
                                dot: c.dot,
                                beats: c.beats,
                                beams: c.beams,
                                slur_start: c.slur_start,
                                slur_ends: c.slur_ends,
                                fermata: c.fermata,
                                grace_notes: vec![],
                            })
                        }
                    }
                })
                .collect();
            JpwMeasureIn {
                entries,
                new_system: false,
                new_page: false,
                repeat_forward: m.repeat_forward,
                repeat_backward: m.repeat_backward,
                ending_left: m.ending_left,
                ending_num: m.ending_num.clone(),
                time_change: false,
                key_change: false,
                time: time.clone(),
                key: key.clone(),
                barline: m.barline.clone(),
            }
        })
        .collect();
    Ok(Some(JpwScoreIn {
        title: meta.titles.first().cloned().unwrap_or_default(),
        credit,
        parts: vec![JpwPartIn { measures }],
        play_data: play_data_in(&pd),
    }))
}

// ───────────────────────── MusicXML 形状 ─────────────────────────

fn pitch_in(n: Option<&Note>, rest: bool) -> JpwPitchIn {
    let degree = n.and_then(|n| n.degree.as_ref());
    JpwPitchIn {
        number: match degree {
            Some(d) if !rest => js::num_to_string(d.number),
            _ => "0".to_string(),
        },
        jp_octave: degree.map_or(0.0, |d| d.octave_shift),
        jp_alter: if rest { " ".to_string() } else { jp_alter_of_accidental(degree.and_then(|d| d.accidental.as_ref())).to_string() },
    }
}

/// `at[i]`：前 `i` 个元素读完时的游标（divisions 折算成四分音符）：最后一个非倚音和弦的终点。
fn cursor_ends(m: &Measure, div: f64) -> Vec<Fraction> {
    let mut pos: HashMap<js::NumKey, f64> = HashMap::new();
    let mut out = vec![Fraction::int(0.0)];
    let mut end = 0.0;
    for el in &m.elements {
        if let Element::Chord(c) = el {
            if c.grace.is_none() {
                let key = js::NumKey::new(c.voice);
                end = pos.get(&key).copied().unwrap_or(0.0) + c.duration.divisions;
                pos.insert(key, end);
            }
        }
        out.push(Fraction::int(end).div_int(div));
    }
    out
}

fn barline_at(b: &Barline, position: Fraction) -> JpwEntryIn {
    JpwEntryIn::Barline { style: b.style.as_ref().map(|s| s.as_str().to_string()), repeat: None, position }
}

/// 口径同引擎输入：第一声部主分支、和弦取最高音（与断句同一份 `phrase_measures_of_doc`）；标题 / credit 照 `extractScoreTitle` 与 `<credit>` 的读法；
/// 倚音挂到它后面第一个新和弦上（跨小节也挂）；小节线条目按游标位置（只看是不是在小节开头）。
pub fn jpw_input_of_doc(song: &Song) -> R<JpwScoreIn> {
    // `P:` 不展开进 `.Repeat`（只读的旧扩展）
    let (mut pd, view) = play_data_of_doc(song, DocPlayOptions { use_sections: false, ..Default::default() }).map_err(|e| e.0)?;
    pd.tempo = tempo_of_doc(song);
    let part = &song.parts[0];
    let div = divisions_of(part);

    let mut tie_starts = HashSet::new();
    let mut tie_ends = HashSet::new();
    let mut tup_starts = HashSet::new();
    let mut tup_ends = HashSet::new();
    for mk in &song.marks {
        if mk.kind == MarkType::Tied {
            tie_starts.insert(mk.start);
            tie_ends.insert(mk.end);
        }
        if mk.kind == MarkType::Tuplet {
            tup_starts.insert(mk.start);
            tup_ends.insert(mk.end);
        }
    }

    // 倚音：挂到文档序里它后面第一个非倚音和弦（任意 voice，可跨小节）
    let mut graces: HashMap<ElementId, Vec<JpwPitchIn>> = HashMap::new();
    let mut pending: Vec<JpwPitchIn> = vec![];
    for m in &part.measures {
        for el in &m.elements {
            let Element::Chord(c) = el else { continue };
            if c.grace.is_some() {
                pending.extend(c.notes.iter().map(|n| pitch_in(Some(n), false)));
                if c.notes.is_empty() {
                    pending.push(pitch_in(None, true));
                }
                continue;
            }
            if !pending.is_empty() {
                graces.insert(c.id, std::mem::take(&mut pending));
            }
        }
    }

    let mut fifths = 0.0;
    let mut time = JpwTimeIn { beats: 4.0, beat_type: 4.0 };
    let mut measures = vec![];
    for (mid, m) in part.measures.iter().enumerate() {
        let out = &view[mid];
        let by_id: HashMap<ElementId, (usize, &Chord)> = m
            .elements
            .iter()
            .enumerate()
            .filter_map(|(i, el)| match el {
                Element::Chord(c) => Some((c.id, (i, c))),
                _ => None,
            })
            .collect();
        let mut entries = vec![];
        let barlines = m.barlines.as_deref().unwrap_or(&[]);
        // 左小节线（带 bar-style 的）在小节开头：位置 0，写出端不写
        for b in barlines.iter().filter(|b| b.location == BarLocation::Left && b.style.is_some()) {
            entries.push(barline_at(b, Fraction::int(0.0)));
        }
        let at = cursor_ends(m, div);
        let after = |b: &Barline| b.after_elements.unwrap_or(0.0);
        let mut middle: Vec<&Barline> = barlines.iter().filter(|b| b.location == BarLocation::Middle && b.style.is_some()).collect();
        for ch in &out.entries {
            let (index, el) = by_id[&ch.id.unwrap()];
            for b in middle.iter().filter(|b| after(b) <= index as f64) {
                entries.push(barline_at(b, at[after(b) as usize]));
            }
            middle.retain(|b| after(b) > index as f64);
            let rest = ch.rest;
            let top = if rest { None } else { top_note(el).map(|i| &el.notes[i]) };
            let n = &ch.notes[0];
            let p = pitch_in(top, rest);
            entries.push(JpwEntryIn::Chord(JpwChordIn {
                notes: vec![JpwNoteIn {
                    number: n.number.clone(),
                    jp_octave: n.jp_octave,
                    jp_alter: p.jp_alter,
                    tie_start: tie_starts.contains(&el.id),
                    tie_end: tie_ends.contains(&el.id),
                    tuplet_begin: tup_starts.contains(&el.id),
                    tuplet_end: tup_ends.contains(&el.id),
                    lyrics: lyrics_in(ch),
                }],
                rest,
                dot: ch.dot,
                beats: ch.beats,
                beams: ch.beams,
                slur_start: ch.slur_start,
                slur_ends: ch.slur_ends,
                fermata: ch.fermata,
                grace_notes: graces.remove(&el.id).unwrap_or_default(),
            }));
        }
        for b in middle {
            entries.push(barline_at(b, at[(after(b) as usize).min(m.elements.len())]));
        }
        for b in barlines.iter().filter(|b| b.location == BarLocation::Right && b.style.is_some()) {
            entries.push(barline_at(b, at[m.elements.len()]));
        }

        let attrs = m.attrs.as_ref();
        let key_change = attrs.is_some_and(|a| a.key.is_some());
        if let Some(k) = attrs.and_then(|a| a.key.as_ref()) {
            fifths = k.fifths;
        }
        let time_change = attrs.is_some_and(|a| a.time.is_some());
        if let Some(t) = attrs.and_then(|a| a.time.as_ref()) {
            time = JpwTimeIn { beats: t.beats, beat_type: t.beat_type };
        }
        let print = m.print.as_ref();
        let new_page = print.and_then(|p| p.new_page).unwrap_or(false);
        measures.push(JpwMeasureIn {
            entries,
            new_system: print.and_then(|p| p.new_system).unwrap_or(false) || new_page,
            new_page,
            repeat_forward: out.repeat_forward,
            repeat_backward: out.repeat_backward,
            ending_left: out.ending_left,
            ending_num: out.ending_num.clone(),
            time_change,
            key_change,
            time: time.clone(),
            key: key_in(fifths)?,
            barline: out.barline.clone(),
        });
    }

    // 标题同 `extractScoreTitle`：title 类 credit 的首行 → work-title → movement-title
    struct C {
        kind: Option<String>,
        text: String,
        page: f64,
        first: String,
    }
    let mut credits: Vec<C> = song
        .credits
        .iter()
        .flatten()
        .map(|c| C {
            kind: c.kind.clone(),
            // 逐个 `<credit-words>` 去首尾空白、丢空的再用换行接；模型里已接成一段，分不出元素边界，
            // 只能去整段首尾空白、丢纯空白行（元素内部换行两侧的空格留着，同原文）
            text: js::trim(&c.text.split('\n').filter(|t| !js::trim(t).is_empty()).collect::<Vec<_>>().join("\n")).to_string(),
            page: c.page.unwrap_or(1.0) - 1.0,
            first: js::trim(c.text.split('\n').next().unwrap_or("")).to_string(),
        })
        .collect();
    let title = credits
        .iter()
        .find(|c| c.kind.as_deref() == Some("title") && !c.first.is_empty())
        .map(|c| c.first.clone())
        .or_else(|| song.work.title.as_deref().map(|t| js::trim(t).to_string()))
        .unwrap_or_default();
    for c in credits.iter_mut() {
        if c.kind.is_none() && c.text == title {
            c.kind = Some("title".to_string());
        }
    }
    Ok(JpwScoreIn {
        title,
        credit: credits.into_iter().map(|c| JpwCreditIn { kind: c.kind, text: c.text, page: c.page }).collect(),
        parts: vec![JpwPartIn { measures }],
        play_data: play_data_in(&pd),
    })
}
