//! 版面态 dump（照 `cli/staffref.ts::staffDump`，键与形两边同一口径）：读入、分系统、排定、装页各阶段同一个口径，对拍逐键比。
//! 分数写 `[分子, 分母]`，非有限数写 `"NaN"` / `"Inf"` / `"-Inf"`，枚举写 TS 枚举的序号。

use crate::model::*;
use crate::pages::Placed;
use dolce_model::base::fraction::Fraction;
use dolce_engrave::text::Font;
use serde_json::{json, Map, Value};

fn jn(x: f64) -> Value {
    if x.is_finite() {
        json!(x)
    } else if x.is_nan() {
        json!("NaN")
    } else if x > 0.0 {
        json!("Inf")
    } else {
        json!("-Inf")
    }
}
fn jo(x: Option<f64>) -> Value {
    x.map_or(Value::Null, jn)
}
fn fr(f: &Fraction) -> Value {
    json!([f.numerator, f.denominator])
}
fn font(f: &Font) -> Value {
    json!({ "family": f.family, "size": jn(f.size), "bold": f.bold, "italic": f.italic })
}
fn tick<T>(m: &TickMap<T>, v: impl Fn(&T) -> Value) -> Value {
    Value::Array(m.entries.iter().map(|e| json!([fr(&e.t), v(&e.v)])).collect())
}

fn item(it: &TextBlockItem) -> Value {
    json!({
        "text": it.text, "font": font(&it.font), "dy": jn(it.dy), "music": it.music, "superscript": jn(it.superscript),
        "nominalSize": jo(it.nominal_size), "padBefore": jo(it.pad_before),
    })
}

fn text_block(t: &TextBlock) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("x".into(), jn(t.x));
    m.insert("y".into(), jn(t.y));
    m.insert("justify".into(), json!(t.justify as i32));
    m.insert("title".into(), json!(t.title));
    m.insert("data".into(), Value::Array(t.data.iter().map(item).collect()));
    m
}

fn note_ref(s: &StaffLayout, n: Option<NoteId>) -> Value {
    match n {
        None => Value::Null,
        Some(n) => {
            let c = s[n].chord;
            json!([s[c].src.id, s[c].notes.iter().position(|&x| x == n).map_or(-1, |i| i as i64)])
        }
    }
}

fn chord(s: &StaffLayout, c: ChordId) -> Value {
    let ch = &s[c];
    let entries = &s[ch.measure].note_entries;
    json!({
        "id": ch.src.id, "offset": fr(&ch.offset), "measureRest": ch.measure_rest, "doubleSide": ch.double_side,
        "stemLen": jn(ch.stem_len), "stemUp": ch.stem_up, "srcTipY": jo(ch.src_tip_y), "stemExtra": jn(ch.stem_extra),
        "beams": ch.beams.iter().map(|b| *b as i32).collect::<Vec<_>>(), "breath": ch.breath,
        "notations": ch.notations.iter().map(|n| json!({
            "symbol": n.symbol, "dx": jn(n.dx), "y": jn(n.y), "above": n.above, "outside": n.outside, "placed": n.placed,
        })).collect::<Vec<_>>(),
        "notes": ch.notes.iter().map(|&n| {
            let nt = &s[n];
            json!({
                "x": jn(nt.x), "writtenPitch": nt.written_pitch, "jpMelody": nt.jp_melody, "tieBegin": nt.tie_begin, "tieEnd": nt.tie_end,
                "flipped": nt.flipped, "entry": nt.entry.and_then(|e| entries.iter().position(|&x| x == e)),
            })
        }).collect::<Vec<_>>(),
    })
}

fn lyric(s: &StaffLayout, l: LyricId) -> Value {
    let ly = &s[l];
    json!({
        "chord": s[ly.chord].src.id, "verse": ly.src.number, "text": ly.text(), "prefix": ly.prefix(), "offset": fr(&ly.offset),
        "font": font(&ly.font), "compress": ly.compress.as_str(), "extend": ly.extend.as_ref().map(fr),
        "x": jn(ly.x), "y": jn(ly.y), "srcY": jo(ly.src_y), "xOffset": jn(ly.x_offset), "width": jn(ly.width),
        "next": ly.next.map(|n| json!([s[s[n].chord].src.id, s[n].src.number])),
    })
}

fn beams(s: &StaffLayout, gs: &[BeamId]) -> Value {
    Value::Array(
        gs.iter()
            .map(|&g| {
                let b = &s[g];
                json!({ "chords": b.chords.iter().map(|&c| s[c].src.id).collect::<Vec<_>>(), "jp": b.jp, "doubleDir": b.double_dir })
            })
            .collect(),
    )
}

fn part_measure(s: &StaffLayout, pm: PmId) -> Value {
    let md = &s[pm];
    json!({
        "chords": md.chords.iter().map(|&c| chord(s, c)).collect::<Vec<_>>(),
        "lyrics": md.lyrics.iter().map(|&l| lyric(s, l)).collect::<Vec<_>>(),
        "harmonies": md.harmonies.iter().map(|&h| {
            let hl = &s[h];
            json!({ "offset": fr(&hl.offset), "x": jn(hl.x), "y": jn(hl.y), "staff": hl.staff() })
        }).collect::<Vec<_>>(),
        "texts": md.text_blocks.iter().map(|&t| {
            let mt = &s[t];
            let mut m = text_block(&mt.block);
            for (k, v) in [
                ("offset", fr(&mt.offset)), ("staff", json!(mt.staff)), ("relative", json!(mt.relative)), ("autoY", json!(mt.auto_y)),
                ("sourceY", json!(mt.source_y)), ("sourceSize", json!(mt.source_size)), ("signPlaced", json!(mt.sign_placed)),
                ("boxed", json!(mt.boxed)), ("frameless", json!(mt.frameless)),
            ] {
                m.insert(k.into(), v);
            }
            Value::Object(m)
        }).collect::<Vec<_>>(),
        "arpegs": md.arpegs.iter().map(|&a| s[a].notes.iter().map(|&n| note_ref(s, Some(n))).collect::<Vec<_>>()).collect::<Vec<_>>(),
        "beams": beams(s, &md.beams), "graceBeams": beams(s, &md.grace_beams), "jpBeams": beams(s, &md.jp_beams),
        "entries": md.note_entries.iter().map(|&e| {
            let en = &s[e];
            json!({
                "subStaff": en.sub_staff, "offset": fr(&en.offset),
                "leger": en.leger.ranges.iter().map(|(l, [a, b])| json!([l, jn(*a), jn(*b)])).collect::<Vec<_>>(),
                "dots": en.dot.dots, "dotPos": jn(en.dot.dot_pos),
                "acc": en.acc.accidentals.iter().map(|it| json!({
                    "line": it.line, "xpos": jo(it.xpos), "scale": jn(it.scale), "symbols": it.symbols,
                })).collect::<Vec<_>>(),
            })
        }).collect::<Vec<_>>(),
    })
}

fn span(sp: &SpanObj) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("start".into(), fr(&sp.start_tick));
    m.insert("end".into(), fr(&sp.end_tick));
    m.insert("above".into(), json!(sp.above));
    m
}

fn with(mut m: Map<String, Value>, kv: Vec<(&str, Value)>) -> Value {
    for (k, v) in kv {
        m.insert(k.into(), v);
    }
    Value::Object(m)
}

fn part(s: &StaffLayout, p: PartId) -> Value {
    let pl = &s[p];
    let notes = |n: &SpanNotes| vec![("start0", note_ref(s, n.start_note)), ("end0", note_ref(s, n.end_note))];
    json!({
        "pid": pl.pid, "name": pl.name, "abbrev": pl.abbrev, "nameSize": jn(pl.name_size),
        "staves": pl.staves.iter().map(|st| json!({
            "order": st.order,
            "key": tick(&st.key, |k| json!([k.fifths, k.cancel])),
            "clef": tick(&st.clef, |c| json!([c.sign.chars().next().map_or(0, |c| c as u32), c.line])),
            "time": tick(&st.time, |t| json!([t.beats, t.beat_type, t.symbol])),
            "notation": tick(&st.notation, |n| json!(*n as i32)),
        })).collect::<Vec<_>>(),
        "measures": pl.measures.iter().map(|&pm| part_measure(s, pm)).collect::<Vec<_>>(),
        "slurs": pl.slurs.iter().map(|&i| { let x = &s[i]; let mut kv = notes(&x.notes); kv.push(("autoDir", json!(x.auto_dir))); with(span(&x.span), kv) }).collect::<Vec<_>>(),
        "tied": pl.tied.iter().map(|&i| { let x = &s[i]; let mut kv = notes(&x.notes); kv.push(("yOffsetType", json!(x.y_offset_type))); kv.push(("srcDir", json!(x.src_dir))); with(span(&x.span), kv) }).collect::<Vec<_>>(),
        "tuplets": pl.tuplets.iter().map(|&i| { let x = &s[i]; let mut kv = notes(&x.notes); kv.push(("tm", fr(&x.time_modification))); kv.push(("bracket", json!(x.bracket))); with(span(&x.span), kv) }).collect::<Vec<_>>(),
        "endings": pl.endings.iter().map(|&i| { let x = &s[i]; with(span(&x.span), vec![
            ("sm", json!(x.start_measure.0)), ("em", json!(x.end_measure.0)), ("number", json!(x.number)), ("hasStop", json!(x.has_stop)),
        ]) }).collect::<Vec<_>>(),
        "wedges": pl.wedges.iter().map(|&i| { let x = &s[i]; with(span(&x.span), vec![
            ("sm", json!(x.start_measure.0)), ("em", json!(x.end_measure.0)), ("crescendo", json!(x.crescendo)), ("staff", json!(x.staff)),
            ("ypos", jn(x.ypos)), ("autoY", json!(x.auto_y)), ("dxLeft", jn(x.dx_left)), ("dxRight", jn(x.dx_right)), ("spread", jn(x.spread)),
        ]) }).collect::<Vec<_>>(),
        "pedals": pl.pedal_lines.iter().map(|&i| { let x = &s[i]; with(span(&x.span), vec![
            ("sm", json!(x.start_measure.0)), ("em", json!(x.end_measure.0)), ("sign", json!(x.sign)), ("line", json!(x.line)),
            ("staff", json!(x.staff)), ("ypos", jn(x.ypos)),
        ]) }).collect::<Vec<_>>(),
        "octaves": pl.octave_lines.iter().map(|&i| { let x = &s[i]; with(span(&x.span), vec![
            ("sm", json!(x.start_measure.0)), ("em", json!(x.end_measure.0)), ("staff", json!(x.staff)), ("size", json!(x.size)),
        ]) }).collect::<Vec<_>>(),
        "lrcExtends": pl.lrc_extends.iter().map(|&i| { let x = &s[i]; let mut kv = notes(&x.notes);
            let ly = |l: Option<LyricId>| l.map_or(Value::Null, |l| json!([s[s[l].chord].src.id, s[l].src.number]));
            kv.push(("lyric", ly(x.start))); kv.push(("stop", ly(x.stop))); with(span(&x.span), kv) }).collect::<Vec<_>>(),
    })
}

fn measure(m: &MeasureLayout) -> Value {
    json!({
        "number": m.number, "multiRest": m.multi_rest, "index": m.index, "dur": fr(&m.dur), "offset": fr(&m.offset), "width": jn(m.width),
        "forward": m.forward, "backward": m.backward, "endingNum": m.ending_num, "leftEnding": m.left_ending_type as i32, "rightEnding": m.right_ending_type as i32,
        "clefPos": jo(m.clef_pos), "keyPos": jo(m.key_pos), "timePos": jo(m.time_pos), "keyOffestJP": jo(m.key_offest_jp),
        "leftBarlinePos": jn(m.left_barline_pos), "dataPos": jn(m.data_pos), "dataEnd": jn(m.data_end), "showBarNumber": m.show_bar_number, "implicit": m.implicit,
        "sibKeyOffset": jn(m.sib_key_offset), "entPos": tick(&m.ent_pos, |x| jn(*x)),
        "leftBarline": m.left_barline.map(|b| b as i32), "rightBarline": m.right_barline.map(|b| b as i32),
        "system": m.system.map(|s| s.0),
    })
}

/// 版面态 dump（还没算到的字段照初值写）
pub fn staff_dump(score: &StaffLayout) -> Value {
    let d = &score.defaults;
    json!({
        "scaling": jn(score.scaling), "autoLayout": score.auto_layout, "keepBreaks": score.keep_breaks, "hardBreaks": score.hard_breaks,
        "longImage": score.long_image, "dataXPlaced": score.data_x_placed, "scripture": score.scripture,
        "harmonySize": jn(score.options.harmony_size),
        "defaults": {
            "pageWidth": jn(d.page_width), "pageHeight": jn(d.page_height), "leftMargin": jn(d.left_margin), "rightMargin": jn(d.right_margin),
            "topMargin": jn(d.top_margin), "bottomMargin": jn(d.bottom_margin), "lyricFont": font(&d.lyric_font), "wordFont": font(&d.word_font),
            "musicTextFont": font(&d.music_text_font), "wordFontGiven": d.word_font_given,
        },
        "credits": score.credits.iter().map(|c| json!({
            "page": c.page, "text": c.text, "type": c.r#type, "x": jn(c.x), "y": jn(c.y), "justify": c.justify as i32, "fontSize": jn(c.font_size),
            "family": c.family, "bold": c.bold.unwrap_or(false), "valign": c.valign,
        })).collect::<Vec<_>>(),
        "measures": score.measures.iter().map(measure).collect::<Vec<_>>(),
        "parts": (0..score.parts.len()).map(|p| part(score, PartId(p))).collect::<Vec<_>>(),
        "partGroups": score.part_groups.iter().map(|g| json!({
            "parts": g.parts.iter().map(|p| p.0).collect::<Vec<_>>(), "number": g.number, "barline": g.barline, "symbol": g.symbol as i32,
            "staffRange": g.staff_range.map(|(a, b)| json!([a, b])),
        })).collect::<Vec<_>>(),
        "systems": score.systems.iter().map(|s| json!({
            "index": s.index, "distance": jn(s.distance), "firstMeasure": s.first_measure, "measures": s.measures.len(),
            "leftMargin": jn(s.left_margin), "rightMargin": jn(s.right_margin), "keyChangeWidth": jn(s.key_change_width), "timeChangeWidth": jn(s.time_change_width),
            "staves": s.staves.iter().map(|st| json!({
                "part": st.part_staff.part.0, "sub": st.part_staff.sub, "distance": jn(st.distance), "minDistance": jn(st.min_distance),
                "srcDistance": jo(st.src_distance), "staffLines": st.staff_lines, "staffScale": jn(st.staff_scale), "staffVisible": st.staff_visible,
                "minY": jn(st.min_y), "harmonyY": jn(st.harmony_y), "hasHarmony": st.has_harmony,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "pages": score.pages.iter().map(|p| json!({
            "width": jn(p.width), "height": jn(p.height), "left": jn(p.left), "right": jn(p.right), "top": jn(p.top), "bottom": jn(p.bottom),
            "systems": p.systems.iter().map(|s| s.0).collect::<Vec<_>>(),
            "texts": p.texts.iter().map(|t| Value::Object(text_block(t))).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
}

pub fn placed_json(placed: &[Placed]) -> Value {
    Value::Array(placed.iter().map(|p| json!({ "sys": p.sys.0, "page": p.page, "top": jn(p.top) })).collect())
}
