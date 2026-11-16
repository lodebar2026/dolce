//! 声部（part）的增删改（同 `src/model/parts.ts`）：声部面板调它。纯模型。
//!
//! 合唱谱常见的是**闭合谱**——一行谱两个声部（S/A 共用高音谱表、T/B 共用低音谱表），写成两个声线或和弦的上下音；
//! 拆成开放谱（每部一行）、或反过来合成闭合谱，是校谱时最常做的两件事。改的都是传进来的那份模型。
//!
//! 缺省声部名要按界面语言出：模型只给 `Msg`，文字由 `EditHooks::text` 给（同 TS `msgText`）。

use crate::doc::*;
use crate::edit::EditHooks;
use crate::helpers::{clear_part_oids, voice_length, voice_onsets};
use dolce_base::{js, Msg};
use serde::{Deserialize, Deserializer, Serialize};
use std::borrow::Cow;
use std::collections::HashSet;

// ───────────────────────── 小工具 ─────────────────────────

fn max_id(doc: &ScoreDoc) -> ElementId {
    let mut max = 0;
    for s in &doc.songs {
        for p in &s.parts {
            for m in &p.measures {
                for e in &m.elements {
                    max = max.max(e.id());
                }
            }
        }
    }
    max
}

fn new_part_id(song: &Song) -> String {
    let used: HashSet<&str> = song.parts.iter().map(|p| p.id.as_str()).collect();
    let mut n = song.parts.len() + 1;
    while used.contains(format!("P{n}").as_str()) {
        n += 1;
    }
    format!("P{n}")
}

/// 某小节处生效的 divisions 与拍号（按第一声部算小节长）。
fn ctx_at(part: &Part, mi: usize) -> (f64, f64, f64) {
    let (mut dpq, mut beats, mut beat_type) = (SIMPLE_DIVISIONS, 4.0, 4.0);
    for m in part.measures.iter().take(mi + 1) {
        let Some(a) = &m.attrs else { continue };
        if let Some(d) = a.divisions.filter(|&d| d != 0.0 && !d.is_nan()) {
            dpq = d;
        }
        if let Some(t) = &a.time {
            beats = t.beats;
            beat_type = t.beat_type;
        }
    }
    (dpq, beats, beat_type)
}




fn rest_chord(id: ElementId, len: f64, kind: NoteType, measure: bool) -> Chord {
    Chord {
        id,
        rest: Some(RestInfo { measure: if measure { Some(true) } else { None }, ..Default::default() }),
        duration: Duration { divisions: len, dots: 0.0, kind: Some(kind), time_mod: None },
        voice: 1.0,
        staff: 1.0,
        ..Default::default()
    }
}

/// 整小节休止。MusicXML 形状（首小节带 `divisions`）写一个整小节休止；简谱形状按拍各写一个四分休止。
fn rest_chords(part: &Part, mi: usize, id: &mut ElementId, len: f64) -> Vec<Element> {
    let xml = part.measures.first().and_then(|m| m.attrs.as_ref()).is_some_and(|a| a.divisions.is_some());
    if xml {
        *id += 1;
        return vec![Element::Chord(rest_chord(*id, len, NoteType::Whole, true))];
    }
    let (dpq, _, _) = ctx_at(part, mi);
    let n = js::max(1.0, js::round(len / dpq));
    let mut out = vec![];
    let mut k = 0.0;
    while k < n {
        *id += 1;
        out.push(Element::Chord(rest_chord(*id, dpq, NoteType::Quarter, false)));
        k += 1.0;
    }
    out
}


/// 新声部的小节骨架：小节号、拍号调号 divisions 照第一声部，谱号另给；小节线照抄。
fn skeleton(r: &Measure, clef: Option<&Clef>, first: bool) -> Measure {
    let mut m = Measure { number: r.number.clone(), elements: vec![], ..Default::default() };
    if r.implicit == Some(true) {
        m.implicit = Some(true);
    }
    if let Some(ra) = &r.attrs {
        // `{ ...ref.attrs }`：新对象
        let mut a = MeasureAttrs { oid: Oid::NONE, clefs: None, staves: None, ..ra.clone() };
        if let (true, Some(c)) = (first, clef) {
            a.clefs = Some(vec![c.clone()]);
        }
        if !&a.is_empty() {
            m.attrs = Some(a);
        }
    } else if let (true, Some(c)) = (first, clef) {
        m.attrs = Some(MeasureAttrs { clefs: Some(vec![c.clone()]), ..Default::default() });
    }
    if let Some(bs) = &r.barlines {
        m.barlines = Some(bs.iter().map(|b| Barline { oid: Oid::NONE, ..b.clone() }).collect());
    }
    if let Some(p) = &r.print {
        let (sys, page) = (p.new_system == Some(true), p.new_page == Some(true));
        if sys || page {
            m.print = Some(Print { new_system: sys.then_some(true), new_page: page.then_some(true), ..Default::default() });
        }
    }
    m
}

// ───────────────────────── 属性 ─────────────────────────

/// 谱号名。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClefName {
    #[serde(rename = "treble")]
    Treble,
    #[serde(rename = "treble-8")]
    Treble8,
    #[serde(rename = "bass")]
    Bass,
    #[serde(rename = "alto")]
    Alto,
    #[serde(rename = "tenor")]
    Tenor,
}

/// 区分「没给」（`undefined`，外层 None）与「给了 null」（`Some(None)`）。
fn double_opt<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartProps {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abbrev: Option<String>,
    /// `treble` / `treble-8`（男高音）/ `bass` / `alto` / `tenor`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clef: Option<ClefName>,
    /// 移调乐器（`<transpose>`）；`Some(None)` = 去掉
    #[serde(default, deserialize_with = "double_opt", skip_serializing_if = "Option::is_none")]
    pub transpose: Option<Option<Transpose>>,
}

/// 声部面板「移调」一栏的选项（键 → `<transpose>`；文字在界面层）。
pub fn transpose_presets() -> Vec<(&'static str, Option<Transpose>)> {
    let t = |diatonic: f64, chromatic: f64, octave_change: Option<f64>| Some(Transpose { diatonic: Some(diatonic), chromatic, octave_change });
    vec![
        ("none", None),
        ("Bb", t(-1.0, -2.0, None)),
        ("A", t(-2.0, -3.0, None)),
        ("F", t(-4.0, -7.0, None)),
        ("Eb", t(-5.0, -9.0, None)),
        ("8vb", t(0.0, 0.0, Some(-1.0))),
        ("8va", t(0.0, 0.0, Some(1.0))),
    ]
}

/// 声部现在的移调对应哪个选项（对不上任何一个为 `other`）。
pub fn transpose_key_of(part: &Part) -> &'static str {
    let Some(t) = part.measures.first().and_then(|m| m.attrs.as_ref()).and_then(|a| a.transpose.as_ref()) else { return "none" };
    transpose_presets()
        .into_iter()
        .find(|(_, p)| p.as_ref().is_some_and(|p| p.chromatic == t.chromatic && p.octave_change.unwrap_or(0.0) == t.octave_change.unwrap_or(0.0)))
        .map_or("other", |x| x.0)
}

/// 这个声部用几行谱（`<staves>`）。
pub fn staves_of(part: &Part) -> f64 {
    let mut n = 1.0;
    for m in &part.measures {
        if let Some(s) = m.attrs.as_ref().and_then(|a| a.staves).filter(|&s| s != 0.0 && !s.is_nan()) {
            n = js::max(n, s);
        }
    }
    n
}

/// 视图用：藏起来的声部去掉（元素 id 不变；起止落在藏起来的声部里的记号一起去掉）。
pub fn with_visible_parts<'a>(doc: &'a ScoreDoc, hidden: &[usize]) -> Cow<'a, ScoreDoc> {
    if hidden.is_empty() {
        return Cow::Borrowed(doc);
    }
    let mut out = doc.clone();
    for s in &mut out.songs {
        let n = s.parts.len();
        let keep: Vec<Part> = s.parts.iter().enumerate().filter(|(i, _)| !hidden.contains(i)).map(|(_, p)| p.clone()).collect();
        if keep.is_empty() || keep.len() == n {
            continue;
        }
        let ids: HashSet<ElementId> = keep.iter().flat_map(|p| p.measures.iter().flat_map(|m| m.elements.iter().map(|e| e.id()))).collect();
        // `{ ...s, parts, marks }`：新的 Song
        s.oid = Oid::NONE;
        s.parts = keep;
        s.marks.retain(|mk| ids.contains(&mk.start) && ids.contains(&mk.end));
    }
    Cow::Owned(out)
}

/// 视图用：简谱档的歌词改取第 `from` 声部的。深拷贝第 `to` 声部、清掉它的词再按时刻抄过来。
pub fn with_lyrics_from(doc: &ScoreDoc, from: usize, to: usize) -> Cow<'_, ScoreDoc> {
    if from == to {
        return Cow::Borrowed(doc);
    }
    let mut out = doc.clone();
    for si in 0..out.songs.len() {
        let s = &mut out.songs[si];
        s.oid = Oid::NONE;
        if s.parts.get(to).is_none() || s.parts.get(from).is_none() {
            continue;
        }
        // structuredClone：表层绑定全丢
        let target = &mut s.parts[to];
        clear_part_oids(target);
        for m in &mut target.measures {
            for e in &mut m.elements {
                if let Element::Chord(c) = e {
                    c.lyrics = None;
                }
            }
        }
        copy_lyrics(&mut out, si, from, to);
    }
    Cow::Owned(out)
}

pub fn clef_of(name: ClefName) -> Clef {
    let c = |sign: ClefSign, line: f64, oc: Option<f64>| Clef { sign, line: Some(line), octave_change: oc, staff: None };
    match name {
        ClefName::Treble => c(ClefSign::G, 2.0, None),
        ClefName::Treble8 => c(ClefSign::G, 2.0, Some(-1.0)),
        ClefName::Bass => c(ClefSign::F, 4.0, None),
        ClefName::Alto => c(ClefSign::C, 3.0, None),
        ClefName::Tenor => c(ClefSign::C, 4.0, None),
    }
}

/// 声部开头的谱号叫什么（读不出来按高音谱号）。
pub fn clef_name_of(part: &Part) -> ClefName {
    let Some(c) = part.measures.first().and_then(|m| m.attrs.as_ref()).and_then(|a| a.clefs.as_ref()).and_then(|cs| cs.first()) else {
        return ClefName::Treble;
    };
    match c.sign {
        ClefSign::F => ClefName::Bass,
        ClefSign::C => {
            if c.line == Some(4.0) {
                ClefName::Tenor
            } else {
                ClefName::Alto
            }
        }
        _ => {
            if c.octave_change == Some(-1.0) {
                ClefName::Treble8
            } else {
                ClefName::Treble
            }
        }
    }
}

pub fn set_part_props(song: &mut Song, pi: usize, p: &PartProps) {
    let Some(part) = song.parts.get_mut(pi) else { return };
    if let Some(n) = &p.name {
        part.name = Some(n.clone());
    }
    if let Some(a) = &p.abbrev {
        part.abbrev = if a.is_empty() { None } else { Some(a.clone()) };
    }
    if let Some(t) = &p.transpose {
        if let Some(m0) = part.measures.first_mut() {
            let mut a = m0.attrs.clone().unwrap_or_default();
            a.oid = Oid::NONE;
            a.transpose = t.clone();
            m0.attrs = Some(a);
        }
    }
    if let Some(c) = p.clef {
        if c != clef_name_of(part) {
            if let Some(m0) = part.measures.first_mut() {
                let mut a = m0.attrs.clone().unwrap_or_default();
                a.oid = Oid::NONE;
                let mut clefs = vec![clef_of(c)];
                clefs.extend(a.clefs.take().unwrap_or_default().into_iter().filter(|x| x.staff.unwrap_or(1.0) != 1.0));
                a.clefs = Some(clefs);
                m0.attrs = Some(a);
            }
        }
    }
}

// ───────────────────────── 增删排 ─────────────────────────

/// 新建一个声部：每小节整小节休止，小节结构照第一声部。插在 `at`（缺省最后）。返回插在第几个（None = 没有第一声部可照）。
pub fn add_part(doc: &mut ScoreDoc, si: usize, props: &PartProps, at: Option<f64>, hooks: &dyn EditHooks) -> Option<usize> {
    let mut id = max_id(doc);
    let song = doc.songs.get(si)?;
    let r = song.parts.first()?;
    let name = match &props.name {
        Some(n) => n.clone(),
        None => hooks.text(&Msg::new("parts.defaultName").arg("n", (song.parts.len() + 1) as f64)),
    };
    let mut part = Part { id: new_part_id(song), name: Some(name), ..Default::default() };
    if let Some(a) = props.abbrev.as_ref().filter(|a| !a.is_empty()) {
        part.abbrev = Some(a.clone());
    }
    let clef = clef_of(props.clef.unwrap_or(ClefName::Treble));
    for (mi, rm) in r.measures.iter().enumerate() {
        let mut m = skeleton(rm, Some(&clef), mi == 0);
        let mut len = voice_length(rm);
        if len == 0.0 || len.is_nan() {
            let (dpq, beats, beat_type) = ctx_at(r, mi);
            len = (dpq * 4.0 * beats) / beat_type;
        }
        m.elements = rest_chords(r, mi, &mut id, len);
        part.measures.push(m);
    }
    let n = song.parts.len();
    let at = match at {
        None => n,
        Some(a) => js::max(0.0, js::min(a, n as f64)).trunc() as usize,
    };
    doc.songs[si].parts.insert(at, part);
    Some(at)
}

/// 复制一个声部（新 id，弧与延音线跟着复制），插在它后面。
pub fn duplicate_part(doc: &mut ScoreDoc, si: usize, pi: usize, hooks: &dyn EditHooks) -> Option<usize> {
    let mut id = max_id(doc);
    let song = doc.songs.get(si)?;
    let src = song.parts.get(pi)?;
    // JSON 往返深拷贝：表层绑定全丢
    let mut copy = src.clone();
    clear_part_oids(&mut copy);
    copy.id = new_part_id(song);
    let name_arg: dolce_base::msg::MsgArg = match &src.name {
        Some(n) => n.clone().into(),
        None => Msg::new("parts.title").into(),
    };
    copy.name = Some(hooks.text(&Msg::new("parts.copyName").arg("name", name_arg)));
    let mut map: Vec<(ElementId, ElementId)> = vec![];
    for m in &mut copy.measures {
        for e in &mut m.elements {
            id += 1;
            map.push((e.id(), id));
            match e {
                Element::Chord(c) => c.id = id,
                Element::Space(s) => s.id = id,
            }
        }
    }
    // Map.set：同一旧 id 后写的盖前写的
    let get = |old: ElementId| map.iter().rev().find(|x| x.0 == old).map(|x| x.1);
    let song = &mut doc.songs[si];
    let marks: Vec<Mark> = song
        .marks
        .iter()
        .filter_map(|mk| match (get(mk.start), get(mk.end)) {
            (Some(s), Some(e)) => Some(Mark { oid: Oid::NONE, start: s, end: e, ..mk.clone() }),
            _ => None,
        })
        .collect();
    song.marks.extend(marks);
    song.parts.insert(pi + 1, copy);
    Some(pi + 1)
}

/// 删一个声部（至少留一个）。删的是第一声部时，挂在它小节上的速度、跳转等文字记号挪给新的第一声部。
pub fn delete_part(doc: &mut ScoreDoc, si: usize, pi: usize) -> bool {
    let Some(song) = doc.songs.get_mut(si) else { return false };
    if song.parts.len() < 2 || song.parts.get(pi).is_none() {
        return false;
    }
    let gone = song.parts.remove(pi);
    let ids: HashSet<ElementId> = gone.measures.iter().flat_map(|m| m.elements.iter().map(|e| e.id())).collect();
    song.marks.retain(|m| !ids.contains(&m.start) && !ids.contains(&m.end));
    if pi == 0 {
        let next = &mut song.parts[0];
        for (mi, m) in gone.measures.into_iter().enumerate() {
            let keep: Vec<Direction> = m
                .directions
                .unwrap_or_default()
                .into_iter()
                .filter(|d| d.kind == "metronome" || d.kind == "segno" || d.kind == "coda" || (d.kind == "words" && d.sound.is_some()))
                .collect();
            if let Some(t) = next.measures.get_mut(mi) {
                if !keep.is_empty() {
                    t.directions.get_or_insert_with(Vec::new).extend(keep);
                }
            }
        }
    }
    true
}

/// 把第 `from` 声部挪到第 `to` 位。
pub fn move_part(doc: &mut ScoreDoc, si: usize, from: usize, to: usize) -> bool {
    let Some(song) = doc.songs.get_mut(si) else { return false };
    if from >= song.parts.len() || to >= song.parts.len() || from == to {
        return false;
    }
    let p = song.parts.remove(from);
    song.parts.insert(to, p);
    true
}

// ───────────────────────── 拆与合 ─────────────────────────

fn second_name(src: &Part, props: &PartProps, hooks: &dyn EditHooks) -> String {
    match &props.name {
        Some(n) => n.clone(),
        None => format!("{} 2", src.name.clone().unwrap_or_else(|| hooks.text(&Msg::new("parts.title")))),
    }
}

fn split_clef(src: &Part, props: &PartProps) -> Option<Clef> {
    match props.clef {
        Some(c) => Some(clef_of(c)),
        None => src.measures.first().and_then(|m| m.attrs.as_ref()).and_then(|a| a.clefs.as_ref()).and_then(|cs| cs.first()).cloned(),
    }
}

/// 按声线拆：第 2 条及以后的声线挪到新声部（插在它后面），两边都成单声线。返回新声部下标（None = 没有第二声线）。
pub fn split_by_voice(doc: &mut ScoreDoc, si: usize, pi: usize, props: &PartProps, hooks: &dyn EditHooks) -> Option<usize> {
    let mut id = max_id(doc);
    let song = doc.songs.get_mut(si)?;
    let src = song.parts.get(pi)?;
    if !src.measures.iter().any(|m| m.elements.iter().any(|e| e.voice() > 1.0)) {
        return None;
    }
    let mut part = Part { id: new_part_id(song), name: Some(second_name(src, props, hooks)), ..Default::default() };
    let clef = split_clef(src, props);
    let src = &mut song.parts[pi];
    for mi in 0..src.measures.len() {
        let m = &mut src.measures[mi];
        let mut nm = skeleton(m, clef.as_ref(), mi == 0);
        let on = voice_onsets(m);
        let (mut keep, mut moved, mut keep_on, mut moved_on) = (vec![], vec![], vec![], vec![]);
        for (i, e) in std::mem::take(&mut m.elements).into_iter().enumerate() {
            if e.voice() > 1.0 {
                moved.push(e);
                moved_on.push(on[i]);
            } else {
                keep.push(e);
                keep_on.push(on[i]);
            }
        }
        // 留下的第一声线从小节头接着排：显式起点只在与前一个音之间有空当时保留
        let mut at = 0.0;
        for (k, e) in keep.iter_mut().enumerate() {
            let st = keep_on[k];
            if let Element::Chord(c) = e {
                c.onset = if st != at { Some(st) } else { None };
            }
            at = st + e.span();
        }
        // 挪过去的只留第一条声线（第 3、4 条声线照样并进来，各自显式起点）
        let mut at2 = 0.0;
        let first_voice = moved.first().map(|e| e.voice());
        for (k, e) in moved.iter_mut().enumerate() {
            let st = moved_on[k];
            let v = e.voice();
            if let Element::Chord(c) = e {
                c.onset = if st != at2 || Some(v) != first_voice { Some(st) } else { None };
            }
            let nv = if Some(v) == first_voice { 1.0 } else { v - 1.0 };
            match e {
                Element::Chord(c) => c.voice = nv,
                Element::Space(s) => s.voice = nv,
            }
            at2 = st + e.span();
        }
        m.elements = keep;
        nm.elements = if moved.is_empty() {
            let len = voice_length(&src.measures[mi]);
            rest_chords(src, mi, &mut id, len)
        } else {
            moved
        };
        part.measures.push(nm);
    }
    song.parts.insert(pi + 1, part);
    Some(pi + 1)
}

fn note_midi(n: &Note) -> f64 {
    match &n.pitch {
        Some(p) => {
            let idx = "C D EF G A B".find(p.step.as_str()).map_or(-1.0, |i| i as f64);
            (p.octave + 1.0) * 12.0 + idx + p.alter
        }
        None => 0.0,
    }
}

/// 按和弦上下音拆：和弦里最低的那个音挪到新声部（同起点同时值），上面的留下；单音两边各一份。只看第一声线。
pub fn split_by_chord(doc: &mut ScoreDoc, si: usize, pi: usize, props: &PartProps, hooks: &dyn EditHooks) -> Option<usize> {
    let mut id = max_id(doc);
    let song = doc.songs.get_mut(si)?;
    let src = song.parts.get(pi)?;
    if !src.measures.iter().any(|m| m.elements.iter().any(|e| matches!(e, Element::Chord(c) if c.notes.len() > 1))) {
        return None;
    }
    let mut part = Part { id: new_part_id(song), name: Some(second_name(src, props, hooks)), ..Default::default() };
    let clef = split_clef(src, props);
    let src = &mut song.parts[pi];
    for mi in 0..src.measures.len() {
        let m = &mut src.measures[mi];
        let mut nm = skeleton(m, clef.as_ref(), mi == 0);
        for e in &mut m.elements {
            let Element::Chord(e) = e else { continue };
            if e.voice != 1.0 {
                continue;
            }
            id += 1;
            // `{ ...e, id, notes: [], voice: 1 }`：新的和弦
            let mut copy = Chord { oid: Oid::NONE, id, notes: vec![], voice: 1.0, ..e.clone() };
            copy.lyrics = None;
            copy.harmony = None;
            copy.later_harmonies = None;
            copy.attached_sources = None;
            copy.source = None;
            if e.notes.len() > 1 {
                let mut low = 0;
                for k in 0..e.notes.len() {
                    if note_midi(&e.notes[k]) < note_midi(&e.notes[low]) {
                        low = k;
                    }
                }
                copy.notes = vec![e.notes.remove(low)];
            } else {
                copy.notes = e.notes.iter().map(|n| Note { oid: Oid::NONE, ..n.clone() }).collect();
            }
            nm.elements.push(Element::Chord(copy));
        }
        if nm.elements.is_empty() {
            let len = voice_length(&src.measures[mi]);
            nm.elements = rest_chords(src, mi, &mut id, len);
        }
        part.measures.push(nm);
    }
    song.parts.insert(pi + 1, part);
    Some(pi + 1)
}

/// 合：第 `pj` 声部并进第 `pi` 声部当第二声线（小节数要一样），然后删掉第 `pj` 声部。
pub fn merge_into(doc: &mut ScoreDoc, si: usize, pi: usize, pj: usize) -> bool {
    let Some(song) = doc.songs.get_mut(si) else { return false };
    let (Some(a), Some(b)) = (song.parts.get(pi), song.parts.get(pj)) else { return false };
    if pi == pj || a.measures.len() != b.measures.len() {
        return false;
    }
    let v = a.measures.iter().flat_map(|m| m.elements.iter().map(|e| e.voice())).fold(1.0, js::max) + 1.0;
    let b = song.parts.remove(pj);
    let a = &mut song.parts[if pj < pi { pi - 1 } else { pi }];
    for (m, bm) in a.measures.iter_mut().zip(b.measures) {
        let on = voice_onsets(&bm);
        let n = bm.elements.len();
        for (i, mut e) in bm.elements.into_iter().enumerate() {
            if let Element::Chord(c) = &e {
                if c.rest.as_ref().is_some_and(|r| r.measure == Some(true)) && n == 1 {
                    continue; // 整小节休止不并
                }
            }
            let nv = v + e.voice() - 1.0;
            match &mut e {
                Element::Chord(c) => {
                    c.onset = Some(on[i]);
                    c.voice = nv;
                }
                Element::Space(s) => s.voice = nv,
            }
            m.elements.push(e);
        }
    }
    true
}

/// 歌词复制：第 `from` 声部的歌词按同一时刻抄给第 `to` 声部（目标那个音已有这一段的不覆盖）。返回抄了几个字。
pub fn copy_lyrics(doc: &mut ScoreDoc, si: usize, from: usize, to: usize) -> f64 {
    let Some(song) = doc.songs.get_mut(si) else { return 0.0 };
    if song.parts.get(from).is_none() || song.parts.get(to).is_none() {
        return 0.0;
    }
    let mut n = 0.0;
    for mi in 0..song.parts[from].measures.len() {
        if song.parts[to].measures.get(mi).is_none() {
            continue;
        }
        let m = song.parts[from].measures[mi].clone();
        let bm = &mut song.parts[to].measures[mi];
        let on_a = voice_onsets(&m);
        let on_b = voice_onsets(bm);
        // 时刻 → 目标小节里第一个这一刻起的音（第一声线、非休止、非倚音）
        let mut by_time: Vec<(f64, usize)> = vec![];
        for (i, e) in bm.elements.iter().enumerate() {
            if let Element::Chord(c) = e {
                if c.rest.is_none() && c.grace.is_none() && c.voice == 1.0 {
                    let t = on_b[i];
                    if !by_time.iter().any(|x| js::NumKey::new(x.0) == js::NumKey::new(t)) {
                        by_time.push((t, i));
                    }
                }
            }
        }
        for (i, e) in m.elements.iter().enumerate() {
            let Element::Chord(e) = e else { continue };
            let Some(lys) = e.lyrics.as_ref().filter(|l| !l.is_empty()) else { continue };
            let Some(&(_, ti)) = by_time.iter().find(|x| js::NumKey::new(x.0) == js::NumKey::new(on_a[i])) else { continue };
            let Element::Chord(t) = &mut bm.elements[ti] else { continue };
            for ly in lys {
                if t.lyrics.iter().flatten().any(|x| x.number == ly.number) {
                    continue;
                }
                let mut list = t.lyrics.take().unwrap_or_default();
                list.push(Lyric { oid: Oid::NONE, ..ly.clone() });
                js::sort_by(&mut list, |x, y| x.number - y.number);
                t.lyrics = Some(list);
                n += 1.0;
            }
        }
    }
    n
}

/// 视图用：第 `pi` 声部挪到最前（简谱档只排第一声部）。元素 id 不变。
pub fn with_melody_first(doc: &ScoreDoc, pi: usize) -> Cow<'_, ScoreDoc> {
    if pi == 0 {
        return Cow::Borrowed(doc);
    }
    let mut out = doc.clone();
    for s in &mut out.songs {
        if pi >= s.parts.len() {
            continue;
        }
        s.oid = Oid::NONE;
        let p = s.parts.remove(pi);
        s.parts.insert(0, p);
    }
    Cow::Owned(out)
}
