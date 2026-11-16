//! 小节里的 `<direction>`（MusicXML / `.jpwabc` 来的力度、术语、跳转、文字、渐强渐弱）→ 简谱那套「挂在符号上的记号」
//! （同 `src/model/directionmarks.ts`）。
//!
//!   - 挂哪个符号：按**拍位**找——力度、术语、segno/coda、文字、渐强起点挂在拍位上（或之后）的第一个占时值的符号；
//!     渐强收尾挂在拍位**之前**的最后一个；
//!   - Fine / D.C. / D.S.：挂本小节的右线；
//!   - 不是术语的文字当段落词。

use crate::deconames::deco_key;
use crate::doc::*;
use crate::jianpu::melody_lane;
use crate::marknames::{is_dynamic_name, TERMS};
use dolce_base::js;

/// 文字术语 → 记号名（`TERMS` 反查，同文字的后者胜：「a tempo」→ `atempo`）
pub fn term_of(text: &str) -> Option<&'static str> {
    TERMS.iter().rev().find(|(_, t)| *t == text).map(|(k, _)| *k)
}

/// 挂在小节右线上的跳转记号
const AT_BAR_END: [&str; 3] = ["fine", "dc", "ds"];

#[derive(Clone, Debug, PartialEq)]
pub enum WedgeEdge {
    Start { kind: WedgeType, index: usize },
    Stop { index: usize },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DirectionMarks {
    /// 挂在本小节第几个元素上的记号（按首次出现的次序）
    pub by_element: Vec<(usize, Vec<SourceOrnament>)>,
    /// 挂在本小节右线上的（Fine / D.C. / D.S.）
    pub bar_end: Vec<SourceOrnament>,
    /// 不是术语的文字：挂在第几个元素上当段落词
    pub words: Vec<(usize, String)>,
    /// 渐强渐弱的起止，按出现顺序
    pub wedges: Vec<WedgeEdge>,
}

fn timed(el: &Element) -> bool {
    match el {
        Element::Chord(c) => c.grace.is_none(),
        Element::Space(s) => s.spacer == Spacer::X,
    }
}

/// direction 的一份（主体或 `more` 里的一个）：(类型, 文字, 连线类型, 渐强类型)
type PartView<'a> = (&'a str, Option<&'a str>, Option<&'a SpanType>, Option<&'a WedgeType>);

/// direction 的主体与 `more` 各是一份
fn parts_of(d: &Direction) -> Vec<PartView<'_>> {
    let mut v = vec![(d.kind.as_str(), d.text.as_deref(), d.span_type.as_ref(), d.wedge_type.as_ref())];
    for p in d.more.iter().flatten() {
        v.push((p.kind.as_str(), p.text.as_deref(), p.span_type.as_ref(), p.wedge_type.as_ref()));
    }
    v
}

fn opens_bracket(had: &str) -> bool {
    had.chars().last().is_some_and(|c| "(（[【《“".contains(c))
}

fn closes_bracket(t: &str) -> bool {
    t.chars().next().is_some_and(|c| ")）]】》”,，.。;；:：!！?？".contains(c))
}

/// 元素终点（divisions）：多声部一小节里各声部从头排（`onset`），缺省接前一个元素的终点
fn ends_of(mea: &Measure) -> (Vec<f64>, Vec<f64>) {
    let mut onset = vec![];
    let mut end = vec![];
    let mut pos = 0.0;
    for el in &mea.elements {
        let at = el.onset().unwrap_or(pos);
        onset.push(at);
        pos = at + if timed(el) { js::round(el.duration().map_or(0.0, |d| d.divisions)) } else { 0.0 };
        end.push(pos);
    }
    (onset, end)
}

fn base_of(after: Option<f64>, onset: Option<f64>, end: &[f64]) -> f64 {
    if let Some(o) = onset {
        return o;
    }
    match after {
        None => 0.0,
        Some(0.0) => 0.0,
        Some(k) => {
            let i = js::min(k, end.len() as f64) - 1.0;
            js::index(i).and_then(|i| end.get(i).copied()).unwrap_or(f64::NAN)
        }
    }
}

pub fn direction_marks(mea: &Measure) -> DirectionMarks {
    let mut out = DirectionMarks::default();
    let dirs: &[Direction] = mea.directions.as_deref().unwrap_or(&[]);
    if dirs.is_empty() {
        return out;
    }
    let (onset, end) = ends_of(mea);
    // 挂靠只挑旋律那一路
    let lane = melody_lane(mea);
    let in_lane = |el: &Element| match (lane, el) {
        (Some((s, v)), Element::Chord(c)) => c.staff == s && c.voice == v,
        _ => true,
    };
    let timed_idx: Vec<usize> = (0..mea.elements.len()).filter(|&i| timed(&mea.elements[i]) && in_lane(&mea.elements[i])).collect();
    if timed_idx.is_empty() {
        return out;
    }
    let pos_of = |d: &Direction| -> f64 {
        let p = base_of(d.after_elements, d.onset, &end) + d.offset.unwrap_or(0.0);
        // 落在某个音中间的取最近的拍位：前半段算这个音、后半段算下一个
        match timed_idx.iter().find(|&&j| onset[j] < p - 1e-6 && p < end[j] - 1e-6) {
            None => p,
            Some(&i) => {
                if p - onset[i] < (end[i] - onset[i]) / 2.0 {
                    onset[i]
                } else {
                    end[i]
                }
            }
        }
    };
    let at_or_after = |p: f64| -> usize { timed_idx.iter().copied().find(|&i| onset[i] >= p - 1e-6).unwrap_or(*timed_idx.last().unwrap()) };
    let before = |p: f64| -> usize {
        let mut best = timed_idx[0];
        for &i in &timed_idx {
            if onset[i] < p - 1e-6 {
                best = i;
            }
        }
        best
    };
    let push = |out: &mut DirectionMarks, i: usize, name: &str| {
        let k = match out.by_element.iter().position(|(j, _)| *j == i) {
            Some(k) => k,
            None => {
                out.by_element.push((i, vec![]));
                out.by_element.len() - 1
            }
        };
        let list = &mut out.by_element[k].1;
        if !list.iter().any(|o| o.name == name) {
            list.push(SourceOrnament { name: name.to_owned(), level: 0.0, below: None });
        }
    };
    for dir in dirs {
        let p = pos_of(dir);
        for (kind, text, span, wedge) in parts_of(dir) {
            if kind == "wedge" {
                match (span, wedge) {
                    (Some(SpanType::Start), Some(w)) => out.wedges.push(WedgeEdge::Start { kind: w.clone(), index: at_or_after(p) }),
                    (Some(SpanType::Stop), _) => out.wedges.push(WedgeEdge::Stop { index: before(p) }),
                    _ => {}
                }
                continue;
            }
            let mut name: Option<String> = None;
            if kind == "dynamics" && text.is_some_and(|t| !t.is_empty() && is_dynamic_name(t)) {
                name = text.map(str::to_owned);
            } else if kind == "segno" || kind == "coda" {
                name = deco_key(kind).map(str::to_owned);
            } else if kind == "rehearsal" && text.is_some_and(|t| !js::trim(t).is_empty()) {
                name = Some(format!("rehearsal={}", js::trim(text.unwrap())));
            } else if kind == "words" && text.is_some_and(|t| !t.is_empty()) {
                let t = js::trim(text.unwrap());
                name = term_of(t).or_else(|| deco_key(t)).map(str::to_owned);
                // 同一拍上两段文字分行挂在同一个音上；括号两侧不加空格
                if name.is_none() && !t.is_empty() {
                    let at = at_or_after(p);
                    match out.words.iter_mut().find(|(j, _)| *j == at) {
                        None => out.words.push((at, t.to_owned())),
                        Some((_, had)) => {
                            if !had.split('\n').any(|l| l == t) {
                                *had = if opens_bracket(had) || closes_bracket(t) { format!("{had}{t}") } else { format!("{had}\n{t}") };
                            }
                        }
                    }
                }
            }
            let Some(name) = name else { continue };
            if AT_BAR_END.contains(&name.as_str()) {
                let below = dir.placement == Some(Placement::Below);
                if !out.bar_end.iter().any(|o| o.name == name) {
                    out.bar_end.push(SourceOrnament { name, level: 0.0, below: below.then_some(true) });
                }
            } else {
                let at = at_or_after(p);
                push(&mut out, at, &name);
            }
        }
    }
    out
}

/// 落在小节末、后面已经没有音的力度挪到下一小节开头。只挪力度；最后一小节不挪。就地改。
pub fn carry_late_directions(song: &mut Song) {
    let movable = |kind: &str| kind == "dynamics";
    for part in &mut song.parts {
        let n = part.measures.len();
        for mi in 0..n {
            if mi + 1 >= n || part.measures[mi].directions.as_ref().is_none_or(|d| d.is_empty()) {
                continue;
            }
            let mea = &part.measures[mi];
            let (_, end) = ends_of(mea);
            let measure_end = end.iter().fold(0.0, |a, b| js::max(a, *b));
            if measure_end == 0.0 || measure_end.is_nan() {
                continue;
            }
            let last_dur = mea.elements.iter().rev().find(|el| timed(el)).and_then(|el| el.duration()).map_or(0.0, |d| d.divisions);
            let last_start = measure_end - js::round(last_dur);
            let late = |d: &Direction| -> bool {
                if !parts_of(d).iter().all(|(k, ..)| movable(k)) {
                    return false;
                }
                let p = base_of(d.after_elements, d.onset, &end) + d.offset.unwrap_or(0.0);
                p >= measure_end - 1e-6 || (p > last_start + 1e-6 && p - last_start >= (measure_end - last_start) / 2.0)
            };
            let dirs = part.measures[mi].directions.take().unwrap();
            let (moved, kept): (Vec<Direction>, Vec<Direction>) = dirs.into_iter().partition(|d| late(d));
            part.measures[mi].directions = if kept.is_empty() { None } else { Some(kept) };
            if moved.is_empty() {
                continue;
            }
            let next = &mut part.measures[mi + 1];
            let mut v: Vec<Direction> =
                moved.into_iter().map(|d| Direction { after_elements: Some(0.0), onset: None, offset: None, ..d }).collect();
            v.extend(next.directions.take().unwrap_or_default());
            next.directions = Some(v);
        }
    }
}

/// 拍单位 → 占几分之几全音符
fn beat_unit(t: &str) -> Option<(f64, f64)> {
    Some(match t {
        "whole" => (1.0, 1.0),
        "half" => (1.0, 2.0),
        "quarter" => (1.0, 4.0),
        "eighth" => (1.0, 8.0),
        "16th" => (1.0, 16.0),
        _ => return None,
    })
}

fn is_tempo(kind: &str, tempo: Option<&Metronome>) -> bool {
    kind == "metronome" && tempo.and_then(|t| t.per_minute).is_some_and(|p| p != 0.0 && !p.is_nan())
}

fn tempo_parts(d: &Direction) -> Vec<bool> {
    let mut v = vec![is_tempo(&d.kind, d.tempo.as_ref())];
    for p in d.more.iter().flatten() {
        v.push(is_tempo(&p.kind, p.tempo.as_ref()));
    }
    v
}

/// 曲首速度在哪：(声部, 小节, 第几条 direction, 其中第几个子元素)。全曲第一个速度落在头两个小节里才算。
fn lead_tempo_at(song: &Song) -> Option<(usize, usize, usize, usize)> {
    for (pi, part) in song.parts.iter().enumerate() {
        let Some(mi) = part.measures.iter().position(|m| m.directions.iter().flatten().any(|d| tempo_parts(d).contains(&true))) else {
            continue;
        };
        if mi > 1 {
            continue;
        }
        let dirs = part.measures[mi].directions.as_ref().unwrap();
        let i = dirs.iter().position(|d| tempo_parts(d).contains(&true)).unwrap();
        let k = tempo_parts(&dirs[i]).iter().position(|&b| b).unwrap();
        return Some((pi, mi, i, k));
    }
    None
}

/// 歌的曲首速度：`tempos` 里的数字，没有就取 MusicXML 曲首的 `<metronome>`。`beat` 是拍单位占几分之几全音符。
pub fn lead_tempo(song: &Song) -> Option<(f64, Ratio)> {
    if let Some(n) = song.tempos.iter().flatten().find_map(|t| match t {
        Tempo::Bpm(n) => Some(*n),
        _ => None,
    }) {
        return Some((n, song.tempo_beat.clone().unwrap_or(Ratio { num: 1.0, den: 4.0 })));
    }
    let (pi, mi, i, k) = lead_tempo_at(song)?;
    let d = &song.parts[pi].measures[mi].directions.as_ref().unwrap()[i];
    let t = if k == 0 { d.tempo.as_ref() } else { d.more.as_ref().unwrap()[k - 1].tempo.as_ref() }.unwrap();
    let (num, den) = beat_unit(t.beat_unit.as_ref().map_or("quarter", |u| u.as_str())).unwrap_or((1.0, 4.0));
    let beat = if t.beat_unit_dot == Some(true) { Ratio { num: num * 3.0, den: den * 2.0 } } else { Ratio { num, den } };
    Some((t.per_minute.unwrap(), beat))
}

/// 曲首的速度 `<metronome>` → 歌的 `tempos`。已有 `tempos` 或头一个速度不在头两小节里的不动。
fn lift_lead_tempo(song: &mut Song) {
    if song.tempos.as_ref().is_some_and(|t| !t.is_empty()) {
        return;
    }
    let (Some((pi, mi, i, k)), Some((per_minute, beat))) = (lead_tempo_at(song), lead_tempo(song)) else { return };
    song.tempos = Some(vec![Tempo::Bpm(per_minute)]);
    if beat.num * 4.0 != beat.den {
        song.tempo_beat = Some(beat);
    }
    let dirs = song.parts[pi].measures[mi].directions.as_mut().unwrap();
    let n_more = dirs[i].more.as_ref().map_or(0, |m| m.len());
    if n_more == 0 {
        // 只有速度这一份
        dirs.remove(i);
        return;
    }
    let dir = &mut dirs[i];
    let mut more = dir.more.take().unwrap();
    if k == 0 {
        // 剩下的子元素顶上来当这条 direction 的主体
        let head = more.remove(0);
        dir.kind = head.kind;
        dir.text = head.text;
        dir.tempo = head.tempo;
        dir.span_type = head.span_type;
        dir.wedge_type = head.wedge_type;
        dir.line = head.line;
        dir.shift = head.shift;
    } else {
        more.remove(k - 1);
    }
    dir.more = if more.is_empty() { None } else { Some(more) };
}

/// 跳转目标记号的短名 → 123 / ABC 的写法
fn text_name(name: &str) -> Option<&'static str> {
    match name {
        "hs" => Some("segno"),
        "ty" => Some("coda"),
        _ => None,
    }
}

/// 简谱文本写出端（123 / ABC / jcx）用：小节里的 `<direction>` 换成简谱那套写法，之后删掉 `directions`。没有 direction 的歌原样返回。
pub fn directions_as_marks(src: &Song) -> std::borrow::Cow<'_, Song> {
    if !src.parts.iter().any(|p| p.measures.iter().any(|m| m.directions.as_ref().is_some_and(|d| !d.is_empty()))) {
        return std::borrow::Cow::Borrowed(src);
    }
    let mut song = src.clone();
    crate::helpers::clear_oids(&mut song);
    lift_lead_tempo(&mut song);
    carry_late_directions(&mut song);
    let mut new_marks: Vec<Mark> = vec![];
    for part in &mut song.parts {
        // 渐强渐弱常跨小节：起点留着等后面小节的收尾
        let mut open: std::collections::VecDeque<(WedgeType, ElementId)> = std::collections::VecDeque::new();
        for mea in &mut part.measures {
            if mea.directions.as_ref().is_none_or(|d| d.is_empty()) {
                continue;
            }
            let dm = direction_marks(mea);
            for (i, orns) in &dm.by_element {
                let i = *i;
                if !matches!(mea.elements.get(i), Some(Element::Chord(_))) {
                    continue;
                }
                // 小节第一个符号上的 segno / coda 是左线上的跳转目标
                if i == 0 {
                    for o in orns.iter().filter(|x| text_name(&x.name).is_some()) {
                        let bls = mea.barlines.get_or_insert_with(Vec::new);
                        let orn = SourceOrnament { name: o.name.clone(), level: 0.0, below: None };
                        match bls.iter_mut().find(|b| b.location == BarLocation::Left) {
                            Some(left) => left.ornaments.get_or_insert_with(Vec::new).push(orn),
                            None => {
                                let mut b = Barline::at(BarLocation::Left);
                                b.ornaments = Some(vec![orn]);
                                bls.push(b);
                            }
                        }
                    }
                }
                let Some(Element::Chord(el)) = mea.elements.get_mut(i) else { unreachable!() };
                let arts = el.notations.get_or_insert_with(Notations::default).articulations.get_or_insert_with(Vec::new);
                for o in orns {
                    if i == 0 && text_name(&o.name).is_some() {
                        continue;
                    }
                    let name = text_name(&o.name).map_or_else(|| o.name.clone(), str::to_owned);
                    if !arts.contains(&name) {
                        arts.push(name);
                    }
                }
            }
            if !dm.bar_end.is_empty() {
                let bls = mea.barlines.get_or_insert_with(Vec::new);
                let ri = match bls.iter().position(|b| b.location == BarLocation::Right) {
                    Some(i) => i,
                    None => {
                        let mut b = Barline::at(BarLocation::Right);
                        b.style = Some(BarStyle::Regular);
                        bls.push(b);
                        bls.len() - 1
                    }
                };
                let own = bls[ri].ornaments.get_or_insert_with(Vec::new);
                for o in &dm.bar_end {
                    if !own.iter().any(|x| x.name == o.name) {
                        own.push(SourceOrnament { name: o.name.clone(), level: 0.0, below: None });
                    }
                }
            }
            for (i, text) in &dm.words {
                if let Some(Element::Chord(el)) = mea.elements.get_mut(*i) {
                    if el.section_word.is_none() {
                        el.section_word = Some(text.clone());
                    }
                }
            }
            for w in &dm.wedges {
                match w {
                    WedgeEdge::Start { kind, index } => {
                        if let Some(el) = mea.elements.get(*index) {
                            open.push_back((kind.clone(), el.id()));
                        }
                    }
                    WedgeEdge::Stop { index } => {
                        let Some(el) = mea.elements.get(*index) else { continue };
                        if let Some((kind, start)) = open.pop_front() {
                            let mut m = Mark::new(MarkType::Wedge, start, el.id());
                            m.wedge_type = Some(kind);
                            new_marks.push(m);
                        }
                    }
                }
            }
            mea.directions = None;
        }
    }
    song.marks.extend(new_marks);
    std::borrow::Cow::Owned(song)
}
