//! 迁移期对拍用的摘要（dev `rs-diff.mjs` 各档的 Rust 一侧；TS 一侧在该脚本里同口径算）。不给编辑器用。

use dolce_model::deconames::{deco_key, notehead_of, rehearsal_of, tremolo_strokes};
use dolce_model::harmony::{chord_step_alter, chord_suffix_form};
use dolce_model::helpers::{measure_duration, section_mark_of, section_word_of, verse_count};
use dolce_model::jianpu::*;
use dolce_model::keyshift::*;
use dolce_model::metakeys::creator_type_of;
use dolce_model::multirest::compress_multi_rests;
use dolce_model::tuplets::{apply_tuplet_time_mods_default, default_tuplet_normal};
use dolce_model::*;
use serde_json::{json, Value};
use std::borrow::Cow;

fn key_digest(k: &Key) -> Value {
    json!([key_spelling(k, false), key_spelling(k, true), key_fifths(k), tonic_spelling(k), is_minor_key(k)])
}

fn degrees_of(part: &Part) -> Value {
    let mut out = vec![];
    for m in &part.measures {
        for el in &m.elements {
            if let Element::Chord(c) = el {
                for n in &c.notes {
                    out.push(json!(n.degree));
                }
            }
        }
    }
    Value::Array(out)
}

fn part_digest(part: &Part, song: &Song) -> Value {
    let c_major = c_major();
    let mut assigned = part.clone();
    assign_degrees(&mut assigned, song.key.as_ref().unwrap_or(&c_major));
    let mut meas = vec![];
    for (i, m) in part.measures.iter().enumerate() {
        let a = attrs_at(part, 1.0, i, song.key.as_ref());
        let a2 = attrs_at(part, 2.0, i, None);
        let prev = if i > 0 { Some(&part.measures[i - 1]) } else { None };
        let mut melody = AccidentalCarry::default();
        let mut back = AccidentalCarry::default();
        let mut staff = StaffAccidentalCarry::new(a.key.fifths);
        let mut carry = vec![];
        let mut els = vec![];
        for el in &m.elements {
            let q = nominal_quarters(el, a.divisions);
            let sh = jianpu_shape(q);
            let mut notes = vec![];
            let mut top = -1.0;
            let mut sw = Value::Null;
            if let Element::Chord(c) = el {
                top = top_note(c).map_or(-2.0, |i| i as f64);
                sw = json!(section_word_of(c.section_word.as_deref()));
                for n in &c.notes {
                    if let Some(p) = &n.pitch {
                        notes.push(json!([degree_from_pitch(p, &a.key, None), midi_pitch(p), note_height(n)]));
                        carry.push(json!([melody.mark(p, &a.key), staff.mark(p, n.tie.as_ref().and_then(|t| t.stop) == Some(true))]));
                    } else {
                        notes.push(json!([null, null, note_height(n)]));
                    }
                    if let Some(d) = &n.degree {
                        carry.push(json!(back.pitch(d, &a.key)));
                    }
                }
            }
            els.push(json!([q, [sh.beams, sh.dots, sh.sustains], top, notes, el.harmony().map(harmony_text), sw]));
        }
        meas.push(json!({
            "a": [a.divisions, a.key, a.time, a.clef, a.transpose],
            "a2": a2.clef,
            "dur": measure_duration(m),
            "sec": [section_mark_of(m, None), section_mark_of(m, Some(prev))],
            "lane": melody_lane(m).map(|(s, v)| [s, v]),
            "mel": melody_chords(m, None),
            "mel2": melody_chords(m, Some(2.0)),
            "cont": continues_measure(prev, m),
            "els": els,
            "carry": carry,
        }));
    }
    json!({ "wo": written_octave_of(part), "assign": degrees_of(&assigned), "meas": meas })
}

fn song_digest(song: &Song) -> Value {
    let multi = match compress_multi_rests(song) {
        Cow::Borrowed(_) => Value::Null,
        Cow::Owned(s) => json!(s.parts.iter().map(|p| &p.measures).collect::<Vec<_>>()),
    };
    let mut tup = song.clone();
    let mut tuplets = vec![];
    for p in &mut tup.parts {
        let mut seq: Vec<&mut Element> = p.measures.iter_mut().flat_map(|m| m.elements.iter_mut()).collect();
        apply_tuplet_time_mods_default(&song.marks, &mut seq);
        for el in seq {
            if let Element::Chord(c) = el {
                if let Some(t) = &c.duration.time_mod {
                    tuplets.push(json!([c.id, t]));
                }
            }
        }
    }
    let mut filled = song.clone();
    fill_degrees_from_pitch(&mut filled);
    json!({
        "verse": verse_count(song),
        "spell": song.key.as_ref().map(key_digest),
        "fifths": song_fifths(song),
        "tempos": quarter_tempos(song),
        "multi": multi,
        "tuplets": tuplets,
        "fill": filled.parts.iter().map(degrees_of).collect::<Vec<_>>(),
        "parts": song.parts.iter().map(|p| part_digest(p, song)).collect::<Vec<_>>(),
    })
}

fn synth_digest(doc: &ScoreDoc) -> Value {
    let mut names: Vec<String> = vec![];
    let mut texts: Vec<String> = vec![];
    let mut chords: Vec<String> = vec![];
    let mut spellings: Vec<String> = vec!["bB".into(), "Bb".into(), "#F".into(), "F#".into(), "C".into(), "H".into(), "".into()];
    for s in &doc.songs {
        for c in s.identification.iter().flat_map(|i| &i.creators) {
            texts.push(c.text.clone());
        }
        for c in s.credits.iter().flatten() {
            texts.push(c.text.clone());
        }
        if let Some(k) = &s.key {
            spellings.extend(k.spelling.clone());
        }
        for (_, _, el) in dolce_model::helpers::each_element(s) {
            if let Some(h) = el.harmony() {
                chords.push(harmony_text(h));
            }
            if let Element::Chord(c) = el {
                for o in c.ornaments.iter().flatten() {
                    names.push(o.name.clone());
                }
                if let Some(n) = &c.notations {
                    names.extend(n.articulations.iter().flatten().cloned());
                    names.extend(n.ornaments.iter().flatten().cloned());
                }
            }
        }
    }
    names.extend(["Staccato", "HOLD", "///", "震音", "head-x", "Head-Circle-X", "rehearsal=A", "排练号 = 【B】", "d.c."].map(String::from));
    let qs: Vec<f64> = (1..=64).map(|k| k as f64 / 16.0).chain([0.75 / 8.0, 1.0 / 3.0, 2.0 / 3.0, 0.1, 1e-3]).collect();
    let degs = ["1", "2", "3", "4", "5", "6", "7", "#1", "#4", "b7", "b3", "8", "x", ""];
    let mut kod = vec![];
    let mut dok = vec![];
    for home in -7..=7 {
        for d in degs {
            kod.push(json!(key_of_degree(home as f64, d)));
        }
        for f in -7..=7 {
            dok.push(json!(degree_of_key(home as f64, f as f64)));
        }
    }
    let fos: Vec<Value> = spellings
        .iter()
        .flat_map(|s| [None, Some("1"), Some("6"), Some("2"), Some("x")].map(|t| json!(fifths_of_spelling(s, t))))
        .collect();
    let clefs = ["treble", "Bass-8", "alto+8", "tenor", "x", "treble8", " treble-8 "];
    json!({
        "shapes": qs.iter().map(|&q| { let s = jianpu_shape(q); json!([s.beams, s.dots, s.sustains]) }).collect::<Vec<_>>(),
        "kod": kod,
        "dok": dok,
        "fos": fos,
        "creators": texts.iter().map(|t| creator_type_of(t)).collect::<Vec<_>>(),
        "decos": names.iter().map(|n| json!([deco_key(n), tremolo_strokes(n), notehead_of(n), rehearsal_of(n)])).collect::<Vec<_>>(),
        "clefs": clefs.iter().map(|c| { let k = clef_from_name(c); json!([k.clone(), k.as_ref().and_then(clef_name)]) }).collect::<Vec<_>>(),
        "chords": chords.iter().map(|c| { let a = chord_step_alter(c); json!([chord_suffix_form(c), a.map(|a| json!([a.step.to_string(), a.acc, a.left, a.len]))]) }).collect::<Vec<_>>(),
        "tn": (1..=9).map(|n| default_tuplet_normal(n as f64)).collect::<Vec<_>>(),
    })
}

/// 第 2 步查询层的摘要
pub fn query_digest(doc: &ScoreDoc) -> Value {
    json!({ "songs": doc.songs.iter().map(song_digest).collect::<Vec<_>>(), "synth": synth_digest(doc) })
}
