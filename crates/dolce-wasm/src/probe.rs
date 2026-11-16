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

// ───────────────────────── fromxml ─────────────────────────

/// 绑定表摘要：按模型 JSON 的路径，`路径|槽位` → `标签@起-止`（同 rs-diff 的 TS 一侧）
fn bindings_of(v: &Value, s: &dolce_model::xmlsurface::Surface, path: &str, out: &mut serde_json::Map<String, Value>) {
    match v {
        Value::Array(a) => {
            for (i, x) in a.iter().enumerate() {
                bindings_of(x, s, &format!("{path}[{i}]"), out);
            }
        }
        Value::Object(o) => {
            if let Some(oid) = o.get("_oid").and_then(Value::as_u64) {
                for slot in dolce_model::xmlsurface::Slot::ALL {
                    if let Some(n) = s.of(Oid(oid as u32), slot) {
                        let t = s.tree();
                        out.insert(format!("{path}|{}", slot.name()), json!(format!("{}@{}-{}", t.tag(n), t.start(n), t.end(n))));
                    }
                }
            }
            for (k, x) in o {
                if k != "_oid" {
                    bindings_of(x, s, &format!("{path}.{k}"), out);
                }
            }
        }
        _ => {}
    }
}

/// 去掉 `_oid`
fn strip_oids(v: &mut Value) {
    match v {
        Value::Array(a) => a.iter_mut().for_each(strip_oids),
        Value::Object(o) => {
            o.remove("_oid");
            o.values_mut().for_each(strip_oids);
        }
        _ => {}
    }
}

/// 第 3 步读入的摘要：模型（去掉 `_oid`）、绑定表、读后的树（合并 `<attributes>` 会往树上挪节点）
pub fn from_xml_digest(text: &str) -> Value {
    match dolce_model::fromxml::load_score_doc(text) {
        Err(m) => json!({ "ok": false, "error": m.key }),
        Ok(r) => {
            let mut doc = serde_json::to_value(&r.doc).expect("序列化");
            let mut b = serde_json::Map::new();
            bindings_of(&doc, &r.surface, "", &mut b);
            strip_oids(&mut doc);
            let tree = r.surface.tree().serialize(r.surface.xml.root);
            json!({ "ok": true, "doc": doc, "bindings": b, "tree": tree })
        }
    }
}

// ───────────────────────── toxml ─────────────────────────

fn write(doc: &ScoreDoc, s: Option<&dolce_model::xmlsurface::Surface>, ids: bool) -> Value {
    let o = dolce_model::toxml::ToXmlOptions { source_ids: ids, ..Default::default() };
    match dolce_model::toxml::score_doc_to_music_xml(doc, s, &o) {
        Ok(x) => json!(x),
        Err(m) => json!({ "error": m.key }),
    }
}

/// 第 4 步写出的摘要：原样写出、清表层写出、写出后读回再写、带源 id 写出
pub fn to_xml_digest(text: &str) -> Value {
    let r = match dolce_model::fromxml::load_score_doc(text) {
        Err(m) => return json!({ "error": m.key }),
        Ok(r) => r,
    };
    let plain = write(&r.doc, Some(&r.surface), false);
    let again = match plain.as_str().map(dolce_model::fromxml::load_score_doc) {
        Some(Ok(r2)) => write(&r2.doc, Some(&r2.surface), false),
        Some(Err(m)) => json!({ "error": m.key }),
        None => Value::Null,
    };
    json!({ "plain": plain, "bare": write(&r.doc, None, false), "again": again, "ids": write(&r.doc, Some(&r.surface), true) })
}

// ───────────────────────── 投影（第 5 步） ─────────────────────────

fn song_json(s: &Song) -> Value {
    let mut v = serde_json::to_value(s).expect("序列化");
    strip_oids(&mut v);
    v
}

/// 第一声部起逐声部、每第 3 个（下标 % 3 == 1）正经和弦的 id：拿来当「行首」试断行
fn probe_line_starts(s: &Song) -> Vec<ElementId> {
    let mut out = vec![];
    let mut k = 0;
    for p in &s.parts {
        for m in &p.measures {
            for el in &m.elements {
                if let Element::Chord(c) = el {
                    if c.grace.is_none() {
                        if k % 3 == 1 {
                            out.push(c.id);
                        }
                        k += 1;
                    }
                }
            }
        }
    }
    out
}

/// 第 5 步投影的摘要（口径见 dev `rs-diff.mjs project`）
pub fn project_digest(doc: &ScoreDoc) -> Value {
    use dolce_model::breaks::*;
    use dolce_model::toxml::{score_doc_to_music_xml, ToXmlOptions};
    use dolce_model::xmlproject::ProjectOptions;
    let xml = |i: usize, project: ProjectOptions| -> Value {
        let o = ToXmlOptions { song: i, project, ..Default::default() };
        match score_doc_to_music_xml(doc, None, &o) {
            Ok(x) => json!(x),
            Err(m) => json!({ "error": m.key }),
        }
    };
    let mut songs = vec![];
    for (i, s) in doc.songs.iter().enumerate() {
        let ls = probe_line_starts(s);
        let mut breaks = serde_json::Map::new();
        for (tag, mid, pages) in [
            ("inline-write", MidMode::Inline, PageMode::Write),
            ("snap-keep", MidMode::Snap, PageMode::Keep),
            ("source-keep", MidMode::Source, PageMode::Keep),
            ("inline-keep", MidMode::Inline, PageMode::Keep),
        ] {
            let mut c = s.clone();
            let starts: Vec<LineStart> = ls.iter().enumerate().map(|(k, &id)| LineStart { id, page: k % 4 == 3 }).collect();
            let ok = apply_breaks(&mut c, &starts, &ApplyBreaksOptions { mid_in_any_part: tag == "inline-keep", mid, pages });
            breaks.insert(tag.into(), json!({ "ok": ok, "song": song_json(&c), "of": breaks_of(&c).iter().map(|b| json!([b.id, b.page])).collect::<Vec<_>>() }));
        }
        let mut cleared = s.clone();
        clear_song_breaks(&mut cleared);
        let fonts: serde_json::Map<String, Value> = dolce_model::pagemeta::song_header_fonts(s, None)
            .into_iter()
            .map(|(r, f)| {
                let mut o = serde_json::Map::new();
                if let Some(x) = f.family {
                    o.insert("family".into(), json!(x));
                }
                if let Some(x) = f.size {
                    o.insert("size".into(), json!(x));
                }
                if f.bold {
                    o.insert("bold".into(), json!(true));
                }
                (r.as_str().to_owned(), Value::Object(o))
            })
            .collect();
        let page = dolce_model::pagemeta::song_page(s).map(|p| {
            let mut o = json!({ "w": p.w, "h": p.h });
            if let Some(m) = p.margins {
                o["margins"] = json!(m);
            }
            o
        });
        songs.push(json!({
            "xml": xml(i, ProjectOptions::default()),
            "xmlNoTie": xml(i, ProjectOptions { slur_ties: Some(false), ..Default::default() }),
            "xmlLines": xml(i, ProjectOptions { line_starts: Some(ls.clone()), ..Default::default() }),
            "xmlLinesMid": xml(i, ProjectOptions { line_starts: Some(ls.clone()), mid_line_starts: true, ..Default::default() }),
            "split": song_json(&dolce_model::staves::split_staves(s)),
            "fillEmpty": song_json(&dolce_model::staves::fill_empty_measures(s)),
            "fillAbsent": song_json(&dolce_model::timeaxis::fill_absent_groups(s)),
            "toLayers": song_json(&dolce_model::innervoice::voices_to_layers(s, |_, _| false)),
            "toVoices": song_json(&dolce_model::innervoice::layers_to_voices(s)),
            "slursAsTies": song_json(&dolce_model::xmlproject::slurs_as_ties(s)),
            "flags": [dolce_model::staves::has_cross_staff(s), dolce_model::staves::has_extra_staves(s), dolce_model::xmlproject::has_voice_overlay(s)],
            "voltas": dolce_model::xmlproject::voltas_of_play_order(s).iter().map(|(m, v)| json!([m, v.start, v.stop, v.repeat_back])).collect::<Vec<_>>(),
            "breaks": breaks,
            "cleared": song_json(&cleared),
            "page": page,
            "sizes": [dolce_model::pagemeta::song_staff_size(s), dolce_model::pagemeta::song_lyric_size(s)],
            "fonts": fonts,
            "jianpu": song_json(&dolce_model::jianpuproject::project_for_jianpu(s)),
            "asMarks": song_json(&dolce_model::directionmarks::directions_as_marks(s)),
            "leadTempo": dolce_model::directionmarks::lead_tempo(s).map(|(n, b)| json!([n, b.num, b.den])),
        }));
    }
    let mut paged = serde_json::to_value(dolce_model::pagemeta::with_page_meta(doc, None).as_ref()).expect("序列化");
    strip_oids(&mut paged);
    json!({ "songs": songs, "paged": paged })
}

// ───────────────────────── 编辑（第 6 步） ─────────────────────────

#[derive(serde::Deserialize)]
pub struct EditScript {
    cmds: Vec<Value>,
    #[serde(rename = "probeIds")]
    probe_ids: Vec<ElementId>,
}

/// 第 6 步编辑的摘要（口径见 dev `rs-diff.mjs edit`）：载入 MusicXML（带表层）→ 逐条执行 → 每步结果 + 最后的模型与写出
pub fn edit_digest(text: &str, script: &EditScript) -> Value {
    use dolce_model::edit::*;
    let mut r = match dolce_model::fromxml::load_score_doc(text) {
        Err(m) => return json!({ "error": m.key }),
        Ok(r) => r,
    };
    // 动作前的查询
    let mut queries = vec![];
    for &id in &script.probe_ids {
        let pos = pos_of(&r.doc, id);
        queries.push(json!({
            "pos": pos,
            "back": pos.and_then(|p| chord_at_pos(&r.doc, &p)),
            "onset": chord_onset(&r.doc, id),
            "midi": midi_of(&r.doc, id),
            "fifths": anchor_fifths(&r.doc, &InsertAnchor::After(id)),
        }));
    }
    if let Some(p) = r.doc.songs.first().and_then(|s| s.parts.first()) {
        queries.push(json!([1, 2, 3, 5].iter().map(|&k| staff_voice(p, 1.0, k)).chain([1, 2].iter().map(|&k| staff_voice(p, 2.0, k))).collect::<Vec<_>>()));
    }
    let mut results = vec![];
    for c in &script.cmds {
        let cmd: EditCmd = match serde_json::from_value(c.clone()) {
            Ok(x) => x,
            Err(e) => {
                results.push(json!({ "badCmd": e.to_string() }));
                continue;
            }
        };
        let res = apply(&mut r.doc, &cmd, &mut r.surface);
        results.push(serde_json::to_value(&res).expect("序列化"));
    }
    let mut doc = serde_json::to_value(&r.doc).expect("序列化");
    strip_oids(&mut doc);
    let xml = match dolce_model::toxml::score_doc_to_music_xml(&r.doc, Some(&r.surface), &Default::default()) {
        Ok(x) => json!(x),
        Err(m) => json!({ "error": m.key }),
    };
    json!({ "queries": queries, "results": results, "doc": doc, "xml": xml })
}

/// 纯函数小表：`degreeOfStep`、`transposeFifths`、`keyAlter`、`typeOfDivisions`
pub fn edit_tables() -> Value {
    use dolce_model::edit::*;
    let mut v = vec![];
    for f in -7..=7 {
        let f = f as f64;
        let row: Vec<Value> = ["C", "d", "E", "f", "G", "a", "B", "x"]
            .iter()
            .map(|l| json!([degree_of_step(l, f), key_alter(&l.to_uppercase(), f)]))
            .chain((-13..=13).map(|n| json!(transpose_fifths(f, n as f64))))
            .collect();
        v.push(json!(row));
    }
    for dpq in [1.0, 2.0, 3.0, 4.0, 48.0, 480.0] {
        let row: Vec<Value> = (0..=40).map(|k| json!(type_of_divisions(k as f64 * dpq / 8.0, dpq).map(|(t, d)| json!([t.as_str(), d])))).collect();
        v.push(json!(row));
    }
    Value::Array(v)
}
