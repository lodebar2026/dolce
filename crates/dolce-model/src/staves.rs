//! **一个声部的几条谱表**（钢琴大谱表）在 ABC 家族文本与 MusicXML 两种形状之间互转。
//!
//! MusicXML 形状：一个 `Part` 带 `<staves>`，元素 `staff` 是 1、2…，第 k 条谱表上的 voice 按每谱表 4 个编；
//! 123 / ABC 形状：每条谱表各是一个 `Part`，第二条起 `staffOf` 指向首条的 id。
//! `split_staves` 前者 → 后者，`merge_staff_parts` 后者 → 前者。

use crate::doc::*;
use crate::helpers::hidden_rest;
use dolce_base::js;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

/// 每条谱表的 voice 号段
const VOICES_PER_STAFF: f64 = 4.0;

fn or1(x: f64) -> f64 {
    if x == 0.0 || x.is_nan() {
        1.0
    } else {
        x
    }
}


/// 小节里各元素的起点（`onset` 缺省 = 前一个元素的终点）。
fn starts_of(m: &Measure) -> Vec<f64> {
    let mut out = vec![];
    let mut end = 0.0;
    for el in &m.elements {
        let s = el.onset().unwrap_or(end);
        out.push(s);
        end = s + el.span();
    }
    out
}

/// 「排在第几个元素之后、起点多少」这种挂法的时刻
fn time_at(m: &Measure, starts: &[f64], after: Option<f64>, onset: Option<f64>) -> f64 {
    if let Some(o) = onset {
        return o;
    }
    let k = after.unwrap_or(0.0);
    if k > 0.0 {
        match js::index(k - 1.0) {
            Some(i) if i < starts.len() => starts[i] + m.elements[i].span(),
            _ => f64::NAN,
        }
    } else {
        0.0
    }
}

/// 这份歌里有没有一个声部带几条谱表。
pub fn has_extra_staves(song: &Song) -> bool {
    song.parts.iter().any(|p| staff_numbers(p).len() > 1)
}

fn staff_numbers(part: &Part) -> Vec<f64> {
    let mut set: Vec<f64> = vec![];
    let mut add = |x: f64| {
        if !set.iter().any(|y| js::NumKey::new(*y) == js::NumKey::new(x)) {
            set.push(x);
        }
    };
    for m in &part.measures {
        for el in &m.elements {
            add(or1(el.staff()));
        }
    }
    let n = part.staff_count.unwrap_or(1.0);
    let mut k = 2.0;
    while k <= n {
        add(k);
        k += 1.0;
    }
    js::sort_num(&mut set);
    set
}

/// 一个 voice 的「家」：它第一个音所在的谱表。
fn home_staves(part: &Part) -> HashMap<js::NumKey, f64> {
    let mut home = HashMap::new();
    for m in &part.measures {
        for el in &m.elements {
            home.entry(js::NumKey::new(el.voice())).or_insert(or1(el.staff()));
        }
    }
    home
}

/// 跨谱表的东西：连两条谱表上的音的记号、写到别的谱表上的音。
pub fn has_cross_staff(song: &Song) -> bool {
    let mut staff_of: HashMap<ElementId, (&str, js::NumKey)> = HashMap::new();
    for p in &song.parts {
        if staff_numbers(p).len() < 2 {
            continue;
        }
        let home = home_staves(p);
        for m in &p.measures {
            for el in &m.elements {
                staff_of.insert(el.id(), (p.id.as_str(), js::NumKey::new(or1(el.staff()))));
                if let Element::Chord(c) = el {
                    if c.rest.is_none() && home.get(&js::NumKey::new(c.voice)).copied() != Some(or1(c.staff)) {
                        return true;
                    }
                }
            }
        }
    }
    song.marks.iter().any(|mk| match (staff_of.get(&mk.start), staff_of.get(&mk.end)) {
        (Some(a), Some(b)) => a != b,
        _ => false,
    })
}


/// 把元素子集挑出来另成一个小节：元素按需补 `onset`，`Direction` / `laterAttrs` / 中间小节线重算挂在第几个元素之后。
fn sub_measure(
    m: &Measure,
    keep: impl Fn(&Element) -> bool,
    dir_keep: impl Fn(&Direction) -> bool,
    attrs_of: impl Fn(&MeasureAttrs) -> Option<MeasureAttrs>,
    new_id: &mut impl FnMut() -> ElementId,
) -> Measure {
    let starts = starts_of(m);
    let idx: Vec<usize> = (0..m.elements.len()).filter(|&j| keep(&m.elements[j])).collect();
    let mut elements = vec![];
    let mut end = 0.0;
    for &j in &idx {
        let mut el = m.elements[j].clone();
        let s = starts[j];
        let on = if s != end { Some(s) } else { None };
        match &mut el {
            Element::Chord(c) => c.onset = on,
            Element::Space(x) => x.onset = on,
        }
        end = s + el.span();
        elements.push(el);
    }
    let relocate = |after: Option<f64>, onset: Option<f64>| -> (f64, Option<f64>) {
        let t = time_at(m, &starts, after, onset);
        let a = after.unwrap_or(0.0);
        let k = idx.iter().filter(|&&j| (j as f64) < a).count();
        let def = if k > 0 { starts[idx[k - 1]] + m.elements[idx[k - 1]].span() } else { 0.0 };
        (k as f64, if t != def { Some(t) } else { None })
    };
    let full_of = || m.elements.iter().enumerate().fold(m.duration.unwrap_or(0.0), |a, (j, el)| js::max(a, starts[j] + el.span()));
    // 这条谱表这一小节一个音都没有：补一个不可见的整小节休止占住
    if elements.is_empty() && !m.elements.is_empty() {
        let len = full_of();
        if len > 0.0 {
            let dur = Duration { divisions: len, dots: 0.0, kind: Some(NoteType::Whole), ..Default::default() };
            elements.push(Element::Chord(hidden_rest(new_id(), dur, 1.0, 1.0, true)));
        }
    }
    let mut out = Measure { elements, ..m.clone() };
    // 留下的音比整小节短：记下原小节长
    let full = full_of();
    let sub_starts = starts_of(&out);
    let sub_end = out.elements.iter().enumerate().fold(0.0, |a, (j, el)| js::max(a, sub_starts[j] + el.span()));
    if full > sub_end {
        out.duration = Some(full);
    }
    if let Some(a) = &m.attrs {
        out.attrs = attrs_of(a);
    }
    if let Some(later) = &m.later_attrs {
        let v: Vec<LaterAttrs> = later
            .iter()
            .filter_map(|la| {
                let a = attrs_of(&la.attrs)?;
                let (after, onset) = relocate(Some(la.after_elements), la.onset);
                Some(LaterAttrs { after_elements: after, onset, attrs: a })
            })
            .collect();
        out.later_attrs = if v.is_empty() { None } else { Some(v) };
    }
    if let Some(dirs) = &m.directions {
        let v: Vec<Direction> = dirs
            .iter()
            .filter(|d| dir_keep(d))
            .map(|d| {
                let (after, onset) = relocate(d.after_elements, d.onset);
                Direction { after_elements: Some(after), onset, staff: None, ..d.clone() }
            })
            .collect();
        out.directions = if v.is_empty() { None } else { Some(v) };
    }
    if let Some(bars) = &m.barlines {
        if bars.iter().any(|b| b.location == BarLocation::Middle) {
            out.barlines = Some(
                bars.iter()
                    .map(|b| {
                        if b.location == BarLocation::Middle {
                            Barline { after_elements: Some(relocate(b.after_elements, None).0), ..b.clone() }
                        } else {
                            b.clone()
                        }
                    })
                    .collect(),
            );
        }
    }
    out
}

/// 谱号等属性里属于第 `k` 条谱表的那部分，谱表号改成 1；`staves` 去掉。拍号调号各条谱表都带。
fn attrs_for_staff(a: &MeasureAttrs, k: f64) -> Option<MeasureAttrs> {
    let mut out = MeasureAttrs { staves: None, ..a.clone() };
    if let Some(clefs) = &a.clefs {
        let v: Vec<Clef> = clefs.iter().filter(|c| c.staff.unwrap_or(1.0) == k).map(|c| Clef { staff: None, ..c.clone() }).collect();
        out.clefs = if v.is_empty() { None } else { Some(v) };
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// MusicXML 形状的歌里**整小节一个元素都没有**的小节补一个不可见的整小节休止。简谱形状的歌不动。
pub fn fill_empty_measures(song: &Song) -> Cow<'_, Song> {
    if !song.parts.iter().any(|p| p.measures.first().and_then(|m| m.attrs.as_ref()).and_then(|a| a.divisions).is_some()) {
        return Cow::Borrowed(song);
    }
    let mut max_id = crate::helpers::max_top_element_id(song);
    let mut hit = false;
    let mut out = song.clone();
    for p in &mut out.parts {
        let mut time = song.time.clone();
        let mut dpq = 0.0;
        for m in &mut p.measures {
            if let Some(t) = m.attrs.as_ref().and_then(|a| a.time.clone()) {
                time = Some(t);
            }
            if let Some(d) = m.attrs.as_ref().and_then(|a| a.divisions).filter(|&d| d != 0.0 && !d.is_nan()) {
                dpq = d;
            }
            if !m.elements.is_empty() || dpq == 0.0 || dpq.is_nan() {
                continue;
            }
            let len = m.duration.unwrap_or_else(|| match &time {
                Some(t) => (dpq * 4.0 * t.beats) / t.beat_type,
                None => dpq * 4.0,
            });
            hit = true;
            max_id += 1;
            let dur = Duration { divisions: len, dots: 0.0, kind: Some(NoteType::Whole), ..Default::default() };
            m.elements = vec![Element::Chord(hidden_rest(max_id, dur, 1.0, 1.0, true))];
        }
    }
    if hit {
        Cow::Owned(out)
    } else {
        Cow::Borrowed(song)
    }
}

/// 带几条谱表的声部拆成每条谱表一个声部（第二条起 `staffOf` 指向首条）。没有就原样返回。
pub fn split_staves(song: &Song) -> Cow<'_, Song> {
    if !has_extra_staves(song) {
        return Cow::Borrowed(song);
    }
    let mut parts: Vec<Part> = vec![];
    let mut part_of: HashMap<ElementId, String> = HashMap::new();
    let mut groups = song.part_groups.clone();
    let mut max_id = crate::helpers::max_top_element_id(song);
    let mut new_id = || {
        max_id += 1;
        max_id
    };
    for p in &song.parts {
        let staves = staff_numbers(p);
        if staves.len() < 2 {
            parts.push(p.clone());
            for m in &p.measures {
                for el in &m.elements {
                    part_of.insert(el.id(), p.id.clone());
                }
            }
            continue;
        }
        let mut added: Vec<String> = vec![];
        for &k in &staves {
            let first = k == staves[0];
            let id = if first { p.id.clone() } else { format!("{}-S{}", p.id, js::num_to_string(k)) };
            let base = (k - 1.0) * VOICES_PER_STAFF;
            let measures: Vec<Measure> = p
                .measures
                .iter()
                .map(|m| {
                    let mut sub = sub_measure(
                        m,
                        |el| or1(el.staff()) == k,
                        |d| d.staff.unwrap_or(1.0) == k,
                        |a| attrs_for_staff(a, k),
                        &mut new_id,
                    );
                    for el in &mut sub.elements {
                        let v = el.voice();
                        let nv = if v > base { v - base } else { v };
                        match el {
                            Element::Chord(c) => {
                                c.staff = 1.0;
                                c.voice = nv;
                            }
                            Element::Space(s) => {
                                s.staff = 1.0;
                                s.voice = nv;
                            }
                        }
                    }
                    sub
                })
                .collect();
            let mut sp = Part { id: id.clone(), measures, staff_count: None, ..p.clone() };
            if !first {
                sp.staff_of = Some(p.id.clone());
                sp.name = None;
                sp.abbrev = None;
                sp.name_size = None;
                added.push(id.clone());
            }
            for m in &sp.measures {
                for el in &m.elements {
                    part_of.insert(el.id(), id.clone());
                }
            }
            parts.push(sp);
        }
        // 组里有这个声部的，拆出来的几条谱表跟着进组
        for g in groups.iter_mut().flatten() {
            if let Some(at) = g.parts.iter().position(|x| *x == p.id) {
                g.parts.splice(at + 1..at + 1, added.iter().cloned());
            }
        }
    }
    let marks = song
        .marks
        .iter()
        .filter(|mk| match (part_of.get(&mk.start), part_of.get(&mk.end)) {
            (Some(a), Some(b)) => a == b,
            _ => true,
        })
        .cloned()
        .collect();
    let mut out = Song { parts, marks, ..song.clone() };
    if groups.is_some() {
        out.part_groups = groups;
    }
    Cow::Owned(out)
}

fn clef_staff1(c: &Clef) -> Clef {
    if c.staff.is_some_and(|s| s != 0.0 && !s.is_nan()) {
        c.clone()
    } else {
        Clef { staff: Some(1.0), ..c.clone() }
    }
}

/// `split_staves` 的反向：`staffOf` 指向同一首条的声部并回那个声部，成为它的第 2、3… 条谱表。就地改。
pub fn merge_staff_parts(song: &mut Song) {
    // `new Map(parts.map(p => [p.id, p]))`：同 id 后者胜
    let mut by_id: HashMap<String, usize> = HashMap::new();
    for (i, p) in song.parts.iter().enumerate() {
        by_id.insert(p.id.clone(), i);
    }
    let mut guests_of: Vec<(usize, Vec<usize>)> = vec![];
    for (i, p) in song.parts.iter().enumerate() {
        let Some(so) = p.staff_of.as_ref().filter(|so| !so.is_empty() && **so != p.id) else { continue };
        let Some(&hi) = by_id.get(so) else { continue };
        if song.parts[hi].staff_of.as_ref().is_some_and(|x| !x.is_empty()) {
            continue;
        }
        match guests_of.iter_mut().find(|(h, _)| *h == hi) {
            Some(e) => e.1.push(i),
            None => guests_of.push((hi, vec![i])),
        }
    }
    if guests_of.is_empty() {
        for p in &mut song.parts {
            p.staff_of = None;
        }
        return;
    }
    let mut merged: HashSet<String> = HashSet::new();
    for (hi, guests) in &guests_of {
        let guest_parts: Vec<Part> = guests.iter().map(|&g| song.parts[g].clone()).collect();
        let host = &mut song.parts[*hi];
        for (gi, g) in guest_parts.iter().enumerate() {
            let k = gi as f64 + 2.0;
            let base = (k - 1.0) * VOICES_PER_STAFF;
            for (mi, gm) in g.measures.iter().enumerate() {
                if mi >= host.measures.len() {
                    host.measures.push(Measure { number: gm.number.clone(), elements: vec![], ..Default::default() });
                }
                let hm = &mut host.measures[mi];
                let host_starts = starts_of(hm);
                let host_end = match hm.elements.last() {
                    Some(last) => host_starts[host_starts.len() - 1] + last.span(),
                    None => 0.0,
                };
                let g_starts = starts_of(gm);
                let offset = hm.elements.len() as f64;
                let mut end = host_end;
                for (j, el) in gm.elements.iter().enumerate() {
                    let s = g_starts[j];
                    let mut ne = el.clone();
                    let voice = or1(el.voice()) + base;
                    let on = if s != end { Some(s) } else { None };
                    match &mut ne {
                        Element::Chord(c) => {
                            c.staff = k;
                            c.voice = voice;
                            c.onset = on;
                        }
                        Element::Space(x) => {
                            x.staff = k;
                            x.voice = voice;
                            x.onset = on;
                        }
                    }
                    end = s + ne.span();
                    hm.elements.push(ne);
                }
                let fix = |after_el: Option<f64>, onset: Option<f64>| -> (f64, Option<f64>) {
                    let t = time_at(gm, &g_starts, after_el, onset);
                    let after = offset + after_el.unwrap_or(0.0);
                    let def = if after > 0.0 {
                        if after > offset {
                            match js::index(after - offset - 1.0) {
                                Some(i) if i < g_starts.len() => g_starts[i] + gm.elements[i].span(),
                                _ => f64::NAN,
                            }
                        } else {
                            host_end
                        }
                    } else {
                        0.0
                    };
                    (after, if t != def { Some(t) } else { None })
                };
                let with_staff = |a: &MeasureAttrs| -> Option<Vec<Clef>> {
                    a.clefs.as_ref().filter(|c| !c.is_empty()).map(|cs| cs.iter().map(|c| Clef { staff: Some(k), ..c.clone() }).collect())
                };
                if let Some(ga) = &gm.attrs {
                    if let Some(clefs) = with_staff(ga) {
                        let ha = hm.attrs.get_or_insert_with(MeasureAttrs::default);
                        let mut own: Vec<Clef> = ha.clefs.iter().flatten().map(clef_staff1).collect();
                        own.extend(clefs);
                        ha.clefs = Some(own);
                    }
                }
                for la in gm.later_attrs.iter().flatten() {
                    if let Some(clefs) = with_staff(&la.attrs) {
                        let (after, onset) = fix(Some(la.after_elements), la.onset);
                        hm.later_attrs.get_or_insert_with(Vec::new).push(LaterAttrs {
                            after_elements: after,
                            onset,
                            attrs: MeasureAttrs { clefs: Some(clefs), ..Default::default() },
                        });
                    }
                }
                for d in gm.directions.iter().flatten() {
                    let (after, onset) = fix(d.after_elements, d.onset);
                    hm.directions.get_or_insert_with(Vec::new).push(Direction {
                        after_elements: Some(after),
                        onset,
                        staff: Some(k),
                        ..d.clone()
                    });
                }
            }
        }
        let staves = guests.len() as f64 + 1.0;
        host.staff_count = Some(staves);
        if let Some(first) = host.measures.first_mut() {
            let a = first.attrs.get_or_insert_with(MeasureAttrs::default);
            a.staves = Some(staves);
            let mut clefs: Vec<Clef> = a.clefs.iter().flatten().map(clef_staff1).collect();
            let mut k = 1.0;
            while k <= staves {
                if !clefs.iter().any(|c| c.staff == Some(k)) {
                    clefs.push(Clef { sign: ClefSign::G, line: Some(2.0), octave_change: None, staff: Some(k) });
                }
                k += 1.0;
            }
            a.clefs = Some(clefs);
        }
        // 后面小节的谱号也都要带谱表号（首条的写成 1）
        for m in host.measures.iter_mut().skip(1) {
            if let Some(a) = &mut m.attrs {
                if let Some(cs) = &mut a.clefs {
                    *cs = cs.iter().map(clef_staff1).collect();
                }
            }
        }
        for m in &mut host.measures {
            for la in m.later_attrs.iter_mut().flatten() {
                if let Some(cs) = &mut la.attrs.clefs {
                    *cs = cs.iter().map(clef_staff1).collect();
                }
            }
            // 首条自己的力度、文字、渐强渐弱同样写明谱表号
            for d in m.directions.iter_mut().flatten() {
                if !d.staff.is_some_and(|s| s != 0.0 && !s.is_nan()) {
                    d.staff = Some(1.0);
                }
            }
        }
        for &g in guests {
            merged.insert(song.parts[g].id.clone());
        }
    }
    song.parts.retain(|p| !merged.contains(&p.id));
    for p in &mut song.parts {
        p.staff_of = None;
    }
    // 组里并掉的声部拿掉；只剩一个声部的组也拿掉
    if let Some(groups) = &mut song.part_groups {
        for g in groups.iter_mut() {
            g.parts.retain(|id| !merged.contains(id));
        }
        groups.retain(|g| g.parts.len() > 1);
        if groups.is_empty() {
            song.part_groups = None;
        }
    }
}
