//! MusicXML 形状的 `Song` → **简谱形状**的 `Song`：简谱排版与 123 写出端之前的投影（`src/model/jianpuproject.ts` 是门面）。
//! 与 `xmlproject` 方向相反，判据同一条（`is_xml_shaped`）。原生 ABC（时值只在 `divisions`、不带 `beams` / `sustains`）同走这一层。
//!
//! TS 按 `Song` 对象缓存（WeakMap）；这里不缓存，调用方自己留结果。

use crate::directionmarks::carry_late_directions;
use crate::doc::*;
use crate::helpers::{clear_oids, hidden_rest};
use crate::jianpu::{harmony_text, jianpu_shape, nominal_quarters};
use crate::metakeys::creator_type_of;
use crate::xmlproject::{is_xml_shaped, ties_to_marks};
use dolce_base::js;
use std::borrow::Cow;
use std::collections::HashSet;
use unicode_general_category::{get_general_category, GeneralCategory as G};

/// 简谱来源的时值单位（四分音符的 divisions）
const Q: f64 = SIMPLE_DIVISIONS;

/// 时值只记在 `divisions` 里的简谱来源（原生 ABC）：全曲没有一条减时线、一个增时线，却有不是四分的音。
fn is_duration_shaped(song: &Song) -> bool {
    let mut off_shape = false;
    for p in &song.parts {
        for m in &p.measures {
            for el in &m.elements {
                let Element::Chord(c) = el else { continue };
                if c.grace.is_some() || c.continued == Some(true) {
                    continue;
                }
                if c.beams.as_ref().is_some_and(|b| !b.is_empty()) || c.sustains.as_ref().is_some_and(|s| !s.is_empty()) {
                    return false;
                }
                if !off_shape {
                    let s = jianpu_shape(nominal_quarters(el, Q));
                    off_shape = s.beams > 0.0 || s.sustains > 0.0 || s.dots != c.duration.dots;
                }
            }
        }
    }
    off_shape
}

fn continues(n: f64) -> Vec<BeamVal> {
    vec![BeamVal::Continue; n as usize]
}

/// `Song` → 简谱形状（不必投的原样借出）
pub fn project_for_jianpu(src: &Song) -> Cow<'_, Song> {
    let xml = is_xml_shaped(src);
    if !xml && !is_duration_shaped(src) {
        return Cow::Borrowed(src);
    }
    let mut song = src.clone();
    clear_oids(&mut song);
    if xml {
        creators_from_credits(&mut song);
        header_from_credits(&mut song);
        // 落在小节末的力度、文字挂到下一小节头
        carry_late_directions(&mut song);
    } else {
        // ABC 的延音线只标在音上，按 id 配成 `tied` 记号
        ties_to_marks(&mut song);
    }
    let mut next_id = max_id(&song) + 1;
    let mut new_id = || {
        let id = next_id;
        next_id += 1;
        id
    };
    if xml {
        for part in &mut song.parts {
            fill_voice_gaps(part, &mut new_id);
        }
    }
    for part in &mut song.parts {
        let mut divisions = if xml { 1.0 } else { Q };
        let mut carry: Vec<Harmony> = vec![];
        for m in &mut part.measures {
            if let Some(d) = m.attrs.as_ref().and_then(|a| a.divisions) {
                divisions = d;
            }
            carry = project_measure(m, divisions, &mut new_id, carry);
            if let Some(a) = &mut m.attrs {
                a.divisions = None;
            }
            // MusicXML 的普通小节不写 `<barline>`，模型里就没有右线；简谱这边「没有右线」是行末开口的小节
            if xml {
                let bls = m.barlines.get_or_insert_with(Vec::new);
                match bls.iter_mut().find(|b| b.location == BarLocation::Right) {
                    None => {
                        let mut b = Barline::at(BarLocation::Right);
                        b.style = Some(BarStyle::Regular);
                        bls.push(b);
                    }
                    Some(r) => {
                        if r.style.is_none() {
                            r.style = Some(BarStyle::Regular);
                        }
                    }
                }
            }
        }
        // 曲末还欠着的和弦：挂回最后一个音符
        if !carry.is_empty() {
            let last = part.measures.iter_mut().rev().flat_map(|m| m.elements.iter_mut().rev()).find_map(|e| e.as_chord_mut());
            if let Some(last) = last {
                last.later_harmonies.get_or_insert_with(Vec::new).extend(carry);
            }
        }
    }
    Cow::Owned(song)
}

/// 各声部的空拍（`onset` 晚于本声部游标）补不可见休止，并去掉 `onset`。
fn fill_voice_gaps(part: &mut Part, new_id: &mut impl FnMut() -> ElementId) {
    for m in &mut part.measures {
        let mut voices: Vec<js::NumKey> = vec![];
        for el in &m.elements {
            if let Element::Chord(c) = el {
                let v = js::NumKey::new(c.voice);
                if !voices.contains(&v) {
                    voices.push(v);
                }
            }
        }
        let has_dur = m.duration.is_some_and(|d| d != 0.0 && !d.is_nan());
        let has_onset = m.elements.iter().any(|e| matches!(e, Element::Chord(c) if c.onset.is_some_and(|o| o != 0.0 && !o.is_nan())));
        if voices.len() < 2 && !has_dur && !has_onset {
            continue;
        }
        let mut out: Vec<Element> = vec![];
        let mut cursor: Vec<(f64, f64)> = vec![];
        let get = |cursor: &Vec<(f64, f64)>, v: f64| cursor.iter().find(|(k, _)| *k == v).map(|(_, p)| *p);
        let mut end = 0.0;
        for el in std::mem::take(&mut m.elements) {
            let Element::Chord(mut c) = el else {
                out.push(el);
                continue;
            };
            let start = c.onset.unwrap_or(end);
            let at = get(&cursor, c.voice).unwrap_or(0.0);
            if start > at + 1e-9 && c.grace.is_none() {
                let dur = Duration { divisions: start - at, dots: 0.0, ..Default::default() };
                out.push(Element::Chord(hidden_rest(new_id(), dur, c.voice, c.staff, false)));
            }
            c.onset = None;
            end = start + if c.grace.is_some() { 0.0 } else { c.duration.divisions };
            match cursor.iter_mut().find(|(k, _)| *k == c.voice) {
                Some(e) => e.1 = end,
                None => cursor.push((c.voice, end)),
            }
            out.push(Element::Chord(c));
        }
        let first = out.iter().find_map(|e| e.as_chord()).map(|c| (c.voice, c.staff));
        if let Some((fv, fs)) = first {
            let lack = m.duration.unwrap_or(0.0) - get(&cursor, fv).unwrap_or(0.0);
            if lack > 1e-9 {
                let mut at = out.len();
                while at > 0 && !matches!(&out[at - 1], Element::Chord(c) if c.voice == fv) {
                    at -= 1;
                }
                let dur = Duration { divisions: lack, dots: 0.0, ..Default::default() };
                out.insert(at, Element::Chord(hidden_rest(new_id(), dur, fv, fs, false)));
            }
        }
        // 小节长已落成休止
        m.duration = None;
        m.elements = out;
    }
}

/// 123 的 `C:` 取自 `identification`；没有 creator 时，把第一页上标题、副标题、版权、页码、声部名以外的 credit 当作者行。
pub fn creators_from_credits(song: &mut Song) {
    if song.identification.as_ref().is_some_and(|i| !i.creators.is_empty()) {
        printed_creators(song);
        return;
    }
    let skip = ["title", "subtitle", "rights", "page number", "page-number", "part name"];
    let title = song.work.title.as_deref().map(js::trim);
    let creators: Vec<Creator> = song
        .credits
        .iter()
        .flatten()
        .filter(|c| {
            let t = js::trim(&c.text);
            c.page.unwrap_or(1.0) == 1.0
                && !c.kind.as_deref().is_some_and(|k| !k.is_empty() && skip.contains(&k))
                && !t.is_empty()
                && Some(t) != title
        })
        .map(|c| Creator {
            kind: c.kind.clone().unwrap_or_else(|| "composer".into()),
            text: js::trim(&c.text.replace('\n', " ")).to_owned(),
        })
        .collect();
    if !creators.is_empty() {
        match &mut song.identification {
            Some(i) => i.creators = creators,
            None => song.identification = Some(Identification { creators, rights: None, software: None }),
        }
    }
}

/// 末尾的数字（`\s*\d+$` 去掉）
fn strip_page_no(t: &str) -> String {
    let t = js::trim(t);
    let digits = t.trim_end_matches(|c: char| c.is_ascii_digit());
    if digits.len() == t.len() {
        return t.to_owned();
    }
    digits.trim_end_matches(js::is_space).to_owned()
}

/// `^V\.\s*S\.?$`（不分大小写）
fn is_vs(t: &str) -> bool {
    let mut s = t;
    let Some(r) = s.strip_prefix(['V', 'v']) else { return false };
    s = r;
    let Some(r) = s.strip_prefix('.') else { return false };
    s = r.trim_start_matches(js::is_space);
    let Some(r) = s.strip_prefix(['S', 's']) else { return false };
    r.is_empty() || r == "."
}

/// 副标题与页脚：MusicXML 只写在 `<credit>` 里的，123 / 文本谱有对应字段。页脚每页一条、只差末尾页码的去掉页码记一条。
pub fn header_from_credits(song: &mut Song) {
    let credits: Vec<Credit> = song.credits.clone().unwrap_or_default();
    if song.work.subtitles.is_empty() {
        let mut subs: Vec<String> = vec![];
        for c in &credits {
            let t = js::trim(&c.text);
            if c.kind.as_deref() == Some("subtitle") && !t.is_empty() && !subs.iter().any(|x| x == t) {
                subs.push(t.to_owned());
            }
        }
        if !subs.is_empty() {
            song.work.subtitles = subs;
        }
    }
    head_text_from_credits(song);
    let pt = song.page_text.as_ref();
    if pt.is_some_and(|p| !p.bottom_left.is_empty() || !p.bottom_center.is_empty() || !p.bottom_right.is_empty()) {
        return;
    }
    let h = song.defaults.as_ref().and_then(|d| d.page_layout.as_ref()).and_then(|p| p.page_height);
    let head = ["title", "subtitle", "composer", "lyricist", "arranger", "poet"];
    // 翻页提示「V.S.」是原谱翻页处的，简谱不印
    let feet: Vec<&Credit> = credits
        .iter()
        .filter(|c| {
            let t = js::trim(&c.text);
            !t.is_empty()
                && !is_vs(t)
                && !c.kind.as_deref().is_some_and(|k| !k.is_empty() && head.contains(&k))
                && matches!((h, c.y), (Some(h), Some(y)) if y < h / 4.0)
        })
        .collect();
    if feet.is_empty() {
        return;
    }
    let mut out = pt.cloned().unwrap_or_default();
    for c in &feet {
        let trimmed = js::trim(&c.text);
        let page_no = {
            let d = trimmed.len() - trimmed.trim_end_matches(|ch: char| ch.is_ascii_digit()).len();
            (d > 0).then(|| &trimmed[trimmed.len() - d..])
        };
        let many = feet.iter().filter(|o| strip_page_no(&o.text) == strip_page_no(&c.text)).count() > 1;
        let text = if many || page_no.is_some_and(|n| js::number(n) == c.page.unwrap_or(1.0)) { strip_page_no(&c.text) } else { trimmed.to_owned() };
        // 单双页左右交替印的同一条只记头一次那一侧
        if !text.is_empty() && !out.bottom_left.iter().chain(&out.bottom_center).chain(&out.bottom_right).any(|x| *x == text) {
            match c.justify {
                Some(HAlign::Left) => out.bottom_left.push(text),
                Some(HAlign::Right) => out.bottom_right.push(text),
                _ => out.bottom_center.push(text),
            }
        }
    }
    song.page_text = Some(out);
}

const CREATOR_TYPES: [&str; 7] = ["composer", "lyricist", "arranger", "translator", "poet", "words-and-music", "transcriber"];

fn is_ascii_digits(t: &str) -> bool {
    !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit())
}

/// 第一页上半页的 credit（页脚、页码不算）。
fn head_credits(song: &Song) -> Vec<Credit> {
    let h = song.defaults.as_ref().and_then(|d| d.page_layout.as_ref()).and_then(|p| p.page_height);
    song.credits
        .iter()
        .flatten()
        .filter(|c| {
            let t = js::trim(&c.text);
            c.page.unwrap_or(1.0) == 1.0 && !t.is_empty() && !is_ascii_digits(t) && !matches!((h, c.y), (Some(h), Some(y)) if y < h / 2.0)
        })
        .cloned()
        .collect()
}

fn is_punct(c: char) -> bool {
    matches!(
        get_general_category(c),
        G::ConnectorPunctuation | G::DashPunctuation | G::OpenPunctuation | G::ClosePunctuation | G::InitialPunctuation | G::FinalPunctuation | G::OtherPunctuation
    )
}

/// 比对用：去空白与标点、不分大小写
fn loose_norm(t: &str) -> String {
    t.to_lowercase().chars().filter(|&c| !js::is_space(c) && !is_punct(c)).collect()
}

/// 按空白与标点切词
fn words_of(t: &str) -> Vec<String> {
    t.split(|c: char| js::is_space(c) || is_punct(c)).map(loose_norm).filter(|w| !w.is_empty()).collect()
}

/// 署名照谱面印的写：`<creator>` 的每个词都出现在页眉某条 credit 里，`C:` 就写那条印出来的文字。
fn printed_creators(song: &mut Song) {
    let creators = song.identification.as_ref().unwrap().creators.clone();
    let covers = |line: &str, cr: &Creator| {
        let w = words_of(&cr.text);
        !w.is_empty() && w.iter().all(|x| line.contains(x.as_str()))
    };
    let lines: Vec<String> = head_credits(song)
        .iter()
        .filter(|c| c.kind.as_deref().is_none_or(|k| k.is_empty() || CREATOR_TYPES.contains(&k)))
        .map(|c| js::trim(&c.text).to_owned())
        .collect();
    let mut used: HashSet<usize> = HashSet::new();
    // 第几条 credit → 写成的署名（按 credit 次序）
    let mut out: Vec<(usize, Creator)> = vec![];
    for (i, text) in lines.iter().enumerate() {
        let ln = loose_norm(text);
        let hit: Vec<usize> = (0..creators.len()).filter(|&k| !used.contains(&k) && covers(&ln, &creators[k])).collect();
        if hit.is_empty() {
            continue;
        }
        for &k in &hit {
            used.insert(k);
        }
        let h0 = &creators[hit[0]];
        let kind = if hit.len() == 1 { h0.kind.clone() } else { creator_type_of(text).map_or_else(|| h0.kind.clone(), str::to_owned) };
        out.push((i, Creator { kind, text: text.clone() }));
    }
    // 一位署名分印在两行：两行各写一条，类型同这一位
    for (k, cr) in creators.iter().enumerate() {
        if used.contains(&k) {
            continue;
        }
        let has = |out: &Vec<(usize, Creator)>, i: usize| out.iter().any(|(j, _)| *j == i);
        let mut pair: Option<(usize, usize)> = None;
        'outer: for i in 0..lines.len() {
            for j in i + 1..lines.len() {
                if !has(&out, i) && !has(&out, j) && covers(&loose_norm(&format!("{}{}", lines[i], lines[j])), cr) {
                    pair = Some((i, j));
                    break 'outer;
                }
            }
        }
        let Some((i, j)) = pair else { continue };
        used.insert(k);
        for x in [i, j] {
            out.push((x, Creator { kind: cr.kind.clone(), text: lines[x].clone() }));
        }
    }
    if !out.is_empty() {
        out.sort_by_key(|(i, _)| *i);
        let mut v: Vec<Creator> = out.into_iter().map(|(_, c)| c).collect();
        v.extend(creators.iter().enumerate().filter(|(k, _)| !used.contains(k)).map(|(_, c)| c.clone()));
        song.identification.as_mut().unwrap().creators = v;
    }
}

/// 页眉里没写类型、标题/副标题/署名又没包含的几条 credit：靠左的进左上、靠右的进右上，居中的当副标题。
fn head_text_from_credits(song: &mut Song) {
    if song.page_text.as_ref().is_some_and(|p| !p.top_left.is_empty() || !p.top_right.is_empty()) {
        return;
    }
    let norm = |t: &str| -> String { t.chars().filter(|&c| !js::is_space(c)).collect() };
    let creators: Vec<String> =
        song.identification.iter().flat_map(|i| &i.creators).map(|c| norm(&c.text)).filter(|t| !t.is_empty()).collect();
    let mut known: HashSet<String> = HashSet::new();
    for t in [song.work.title.as_deref(), song.work.movement_title.as_deref()].into_iter().flatten().chain(song.work.subtitles.iter().map(|s| s.as_str())) {
        if !t.is_empty() {
            known.insert(norm(t));
        }
    }
    for c in &creators {
        known.insert(norm(c));
    }
    let (mut left, mut right, mut subs): (Vec<String>, Vec<String>, Vec<String>) = (vec![], vec![], vec![]);
    for c in head_credits(song) {
        let text = js::trim(&c.text).to_owned();
        let nt = norm(&text);
        let covered = known.contains(&nt) || (creators.len() > 1 && creators.iter().all(|x| nt.contains(x.as_str())));
        if c.kind.as_deref().is_some_and(|k| !k.is_empty()) || covered {
            continue;
        }
        known.insert(nt);
        match c.justify {
            Some(HAlign::Left) => left.push(text),
            Some(HAlign::Right) => right.push(text),
            _ => subs.push(text),
        }
    }
    if !left.is_empty() || !right.is_empty() {
        let pt = song.page_text.get_or_insert_with(PageText::default);
        pt.top_left.extend(left);
        pt.top_right.extend(right);
    }
    song.work.subtitles.extend(subs);
}

fn max_id(song: &Song) -> ElementId {
    let mut max = 0;
    for p in &song.parts {
        for m in &p.measures {
            for el in &m.elements {
                max = max.max(el.id());
                if let Element::Chord(c) = el {
                    for su in c.sustains.iter().flatten() {
                        max = max.max(su.id);
                    }
                }
            }
        }
    }
    max
}

fn text_of(h: Harmony) -> Harmony {
    if h.text.is_some() {
        h
    } else {
        let text = harmony_text(&h);
        Harmony { text: Some(text), ..h }
    }
}

fn no_offset(mut h: Harmony) -> Harmony {
    h.offset = None;
    h
}

fn chord_at(out: &mut [Element], i: usize) -> &mut Chord {
    match &mut out[i] {
        Element::Chord(c) => c,
        _ => unreachable!(),
    }
}

/// 返回小节末尾挂不进本小节、要顺延给下一小节第一个音的和弦
fn project_measure(m: &mut Measure, divisions: f64, new_id: &mut impl FnMut() -> ElementId, carry_in: Vec<Harmony>) -> Vec<Harmony> {
    // 每个音符（原元素下标）的实际起点（四分音符为 1），按出现次序
    let mut start_of: Vec<(usize, f64)> = vec![];
    // 各声部各自的游标
    let mut pos_of: Vec<(f64, f64)> = vec![];
    let get = |pos_of: &Vec<(f64, f64)>, v: f64| pos_of.iter().find(|(k, _)| *k == v).map(|(_, p)| *p);
    let set = |pos_of: &mut Vec<(f64, f64)>, v: f64, p: f64| match pos_of.iter_mut().find(|(k, _)| *k == v) {
        Some(e) => e.1 = p,
        None => pos_of.push((v, p)),
    };
    let mut trailing: Vec<Harmony> = vec![];
    for (i, el) in m.elements.iter().enumerate() {
        let pos = get(&pos_of, el.voice()).unwrap_or(0.0);
        match el {
            Element::Space(s) if s.spacer == Spacer::Y => {
                // 只在小节末尾造 `y`：音符后面还欠着的 `<harmony>`；简谱侧这里拆掉
                if let Some(h) = &s.harmony {
                    trailing.push(h.clone());
                }
            }
            Element::Chord(c) if c.grace.is_none() => {
                start_of.push((i, pos));
                set(&mut pos_of, c.voice, pos + c.duration.divisions / divisions);
            }
            Element::Space(s) => {
                if let Some(d) = &s.duration {
                    set(&mut pos_of, s.voice, pos + d.divisions / divisions);
                }
            }
            _ => {}
        }
    }
    let measure_end = pos_of.iter().fold(0.0, |a, (_, p)| js::max(a, *p));
    if !carry_in.is_empty() {
        if let Some(Element::Chord(fc)) = m.elements.iter_mut().find(|e| matches!(e, Element::Chord(c) if c.grace.is_none())) {
            for h in carry_in {
                let h = Harmony { offset: Some(0.0), ..h };
                if fc.harmony.is_none() {
                    fc.harmony = Some(h);
                } else {
                    fc.later_harmonies.get_or_insert_with(Vec::new).push(h);
                }
            }
        }
    }
    let mut out: Vec<Element> = vec![];
    // 原元素下标 → 在 out 里的下标
    let mut out_at: Vec<Option<usize>> = vec![None; m.elements.len()];
    for (i, el) in std::mem::take(&mut m.elements).into_iter().enumerate() {
        let mut el = el;
        if matches!(&el, Element::Space(s) if s.spacer == Spacer::Y) {
            continue;
        }
        let q = nominal_quarters(&el, divisions);
        match &mut el {
            Element::Space(sp) => {
                if let Some(h) = sp.harmony.take() {
                    sp.harmony = Some(text_of(h));
                }
                if sp.duration.is_some() {
                    let s = jianpu_shape(q);
                    sp.duration = Some(Duration { divisions: js::round(q * Q), dots: s.dots, ..Default::default() });
                    sp.beams = if s.beams > 0.0 { Some(continues(s.beams)) } else { None };
                }
                out_at[i] = Some(out.len());
                out.push(el);
                continue;
            }
            Element::Chord(ch) => {
                if let Some(h) = ch.harmony.take() {
                    ch.harmony = Some(text_of(h));
                }
                // ABC 的倚音不带时值：原样留着
                if ch.grace.is_some() && q <= 0.0 {
                    out_at[i] = Some(out.len());
                    out.push(el);
                    continue;
                }
                let s = jianpu_shape(q);
                ch.duration = Duration {
                    divisions: if ch.grace.is_some() { 0.0 } else { js::round(q * Q) },
                    dots: s.dots,
                    kind: ch.duration.kind.clone(),
                    time_mod: None,
                };
                ch.beams = if s.beams > 0.0 { Some(continues(s.beams)) } else { None };
                if ch.grace.is_some() || s.sustains == 0.0 {
                    place_later_harmonies(ch, 0, divisions);
                    out_at[i] = Some(out.len());
                    out.push(el);
                    continue;
                }
                if ch.rest.is_some() {
                    // 简谱的长休止写成几个 0，不写增时线
                    let beats = (q + 1e-9).floor();
                    ch.duration = Duration { divisions: Q, dots: 0.0, ..Default::default() };
                    let mut later: Vec<Harmony> = ch.later_harmonies.take().unwrap_or_default();
                    let (voice, staff, hidden) = (ch.voice, ch.staff, ch.print_object == Some(false));
                    let host_at = out.len();
                    out_at[i] = Some(host_at);
                    out.push(el);
                    let mut k = 1.0;
                    while k < beats {
                        let mut r = Chord {
                            id: new_id(),
                            rest: Some(RestInfo::default()),
                            duration: Duration { divisions: Q, dots: 0.0, ..Default::default() },
                            voice,
                            staff,
                            ..Default::default()
                        };
                        if hidden {
                            r.print_object = Some(false);
                        }
                        // 长休止中途换的和弦落到对应那个 0 上
                        if let Some(h) = later.iter().position(|x| (x.offset.unwrap_or(0.0) / divisions - k).abs() < 1e-6) {
                            let placed = later.remove(h);
                            r.harmony = Some(no_offset(text_of(placed)));
                        }
                        out.push(Element::Chord(r));
                        k += 1.0;
                    }
                    if !later.is_empty() {
                        chord_at(&mut out, host_at).later_harmonies = Some(later.into_iter().map(text_of).collect());
                    }
                    let rest = q - beats;
                    if rest > 1e-9 {
                        let r = jianpu_shape(rest);
                        let mut tail = Chord {
                            id: new_id(),
                            rest: Some(RestInfo::default()),
                            duration: Duration { divisions: js::round(rest * Q), dots: r.dots, ..Default::default() },
                            voice,
                            staff,
                            ..Default::default()
                        };
                        if hidden {
                            tail.print_object = Some(false);
                        }
                        if r.beams > 0.0 {
                            tail.beams = Some(continues(r.beams));
                        }
                        out.push(Element::Chord(tail));
                    }
                    continue;
                }
                let n = s.sustains as usize;
                ch.sustains = Some((0..n).map(|_| Sustain { id: new_id(), ..sustain0() }).collect());
                place_later_harmonies(ch, n, divisions);
                out_at[i] = Some(out.len());
                out.push(el);
            }
        }
    }

    // 小节末的和弦：位置 = 小节末 + offset（负值往回数），落进哪个音就交给那个音去挂；offset 不为负的给下一小节第一个音
    let mut carry_out: Vec<Harmony> = vec![];
    for h in trailing {
        let at = measure_end + h.offset.unwrap_or(0.0) / divisions;
        if at >= measure_end - 1e-9 {
            carry_out.push(text_of(h));
            continue;
        }
        let mut host: Option<(usize, f64)> = None;
        for &(i, st) in &start_of {
            if st <= at + 1e-9 {
                host = Some((i, st));
            }
        }
        let Some((hi, hst)) = host else {
            carry_out.push(text_of(h));
            continue;
        };
        let oi = out_at[hi].expect("宿主留在小节里");
        let rel = at - hst;
        let hc = chord_at(&mut out, oi);
        if rel.abs() < 1e-9 && hc.harmony.is_none() {
            hc.harmony = Some(no_offset(text_of(h)));
            continue;
        }
        let n_sus = hc.sustains.as_ref().map_or(0, |s| s.len()) as f64;
        let k = js::round(rel - (hc.duration.divisions - n_sus * Q) / Q);
        let on_beat = (rel - (hc.duration.divisions / Q - n_sus) - k).abs() < 1e-6;
        let su_free = js::index(k).and_then(|k| hc.sustains.as_ref().and_then(|s| s.get(k))).map(|su| su.harmony.is_none());
        if su_free == Some(true) && on_beat {
            hc.sustains.as_mut().unwrap()[k as usize].harmony = Some(no_offset(text_of(h)));
            continue;
        }
        // 长休止拆成的几个 0 里找对应那一拍
        let is_rest = hc.rest.is_some();
        let beat = js::round(rel);
        let r_ok = (rel - beat).abs() < 1e-9
            && is_rest
            && js::index(oi as f64 + beat)
                .and_then(|j| out.get(j))
                .is_some_and(|r| matches!(r, Element::Chord(c) if c.rest.is_some() && c.harmony.is_none()));
        if r_ok {
            chord_at(&mut out, oi + beat as usize).harmony = Some(no_offset(text_of(h)));
        } else {
            chord_at(&mut out, oi).later_harmonies.get_or_insert_with(Vec::new).push(text_of(h));
        }
    }
    m.elements = out;
    carry_out
}

fn sustain0() -> Sustain {
    Sustain {
        id: 0,
        harmony: None,
        notations: None,
        ornaments: None,
        section_word: None,
        lyric_anchor: None,
        lyrics: None,
        before: None,
        line_break_after: None,
        attached_sources: None,
        source: None,
    }
}

/// 长音中途换的和弦（`offset`）挂到对应拍位的增时线上；落不到整拍上的留在原处
fn place_later_harmonies(ch: &mut Chord, n_sustains: usize, divisions: f64) {
    let mut later: Vec<Harmony> = ch.later_harmonies.take().unwrap_or_default();
    // 只有一个和弦、但它本身带 offset（落在长音中间）的也一样处理
    if ch.harmony.as_ref().and_then(|h| h.offset).is_some_and(|o| o > 0.0) {
        later.insert(0, ch.harmony.take().unwrap());
    }
    let body_quarters = (ch.duration.divisions - n_sustains as f64 * Q) / Q;
    let mut left: Vec<Harmony> = vec![];
    for h in later {
        let at = h.offset.unwrap_or(0.0) / divisions;
        let k = js::round(at - body_quarters);
        let free = js::index(k)
            .filter(|&k| k < n_sustains)
            .and_then(|k| ch.sustains.as_ref().and_then(|s| s.get(k)))
            .is_some_and(|su| su.harmony.is_none());
        if (at - body_quarters - k).abs() < 1e-6 && free {
            ch.sustains.as_mut().unwrap()[k as usize].harmony = Some(no_offset(text_of(h)));
        } else if ch.harmony.is_none() && h.offset.unwrap_or(0.0) <= 0.0 {
            ch.harmony = Some(text_of(h));
        } else {
            left.push(text_of(h));
        }
    }
    // 挂不到增时线上、音符本身又没有和弦的：退一步挂在音符上
    if ch.harmony.is_none() && !left.is_empty() {
        ch.harmony = Some(no_offset(left.remove(0)));
    }
    ch.later_harmonies = if left.is_empty() { None } else { Some(left) };
}
