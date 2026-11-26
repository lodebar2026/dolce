//! 同一谱表上的第二声部（123/ABC 的 `&`、MusicXML 同一 `<staff>` 里的第二个 `<voice>`）与文本谱 `{dsb…}` 并排块之间的互转。
//!
//! 简谱一行只排一路旋律：主行是 `melody_lane`（最小谱表上的最小 voice），同一谱表的第二路排成并排块；第三路起、别的谱表排不下。
//! 反过来，文本谱的 `{dsb…}` 层进 123 / MusicXML 时还原成第二声部。

use crate::doc::*;
use crate::helpers::hidden_rest;
use crate::jianpu::{jianpu_shape, melody_lane};
use std::collections::HashSet;

/// 元素在小节里属于哪一路
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lane {
    /// 简谱主行
    Main,
    /// 同一谱表的第二声部
    Inner,
}

/// 这一小节的分路判据（None = 排不下：别的谱表、第三声部起）。小节里只有一路时恒为 `Main`。
pub fn lanes_of(mea: &Measure) -> impl Fn(&Element) -> Option<Lane> {
    let lane = melody_lane(mea);
    let single = match lane {
        None => true,
        Some((s, v)) => mea.elements.iter().all(|el| el.voice() == v && el.staff() == s),
    };
    let mut second: Option<f64> = None;
    if let (false, Some((s, v))) = (single, lane) {
        for el in &mea.elements {
            if let Element::Chord(c) = el {
                if c.staff == s && c.voice != v && second.is_none_or(|x| c.voice < x) {
                    second = Some(c.voice);
                }
            }
        }
    }
    move |el: &Element| {
        if single {
            return Some(Lane::Main);
        }
        let (s, v) = lane.unwrap();
        if el.staff() != s {
            None
        } else if el.voice() == v {
            Some(Lane::Main)
        } else if Some(el.voice()) == second {
            Some(Lane::Inner)
        } else {
            None
        }
    }
}

pub fn has_inner_voice(mea: &Measure) -> bool {
    let lane_of = lanes_of(mea);
    mea.elements.iter().any(|el| lane_of(el) == Some(Lane::Inner))
}

/// 一路元素占几个四分（简谱形状：`divisions` 已含增时线，多连音记名义值）
fn lane_quarters<'a>(els: impl IntoIterator<Item = &'a Element>) -> f64 {
    let mut q = 0.0;
    for el in els {
        let skip = match el {
            Element::Chord(c) => c.grace.is_some(),
            Element::Space(s) => s.spacer != Spacer::X,
        };
        if skip {
            continue;
        }
        let d = el.duration();
        let tm = d.and_then(|d| d.time_mod.as_ref());
        q += (d.map_or(0.0, |d| d.divisions) / SIMPLE_DIVISIONS) * tm.map_or(1.0, |t| t.normal / t.actual);
    }
    q
}

/// 补足 `q` 个四分的不可见休止（整拍一个，零头按减时线）
fn pad_rests(mut q: f64, voice: f64, staff: f64, new_id: &mut impl FnMut() -> ElementId) -> Vec<Chord> {
    let mut out = vec![];
    let mut rest = |quarters: f64| -> Chord {
        let s = jianpu_shape(quarters);
        let dur = Duration { divisions: crate::base::js::round(quarters * SIMPLE_DIVISIONS), dots: s.dots, ..Default::default() };
        let mut c = hidden_rest(new_id(), dur, voice, staff, false);
        if s.beams > 0.0 {
            c.beams = Some(vec![BeamVal::Continue; s.beams as usize]);
        }
        c
    };
    while q >= 1.0 - 1e-9 {
        out.push(rest(1.0));
        q -= 1.0;
    }
    let mut k = 1;
    while k <= 6 && q > 1e-9 {
        let v = 2f64.powi(-k);
        if q >= v - 1e-9 {
            out.push(rest(v));
            q -= v;
        }
        k += 1;
    }
    out
}

/// 连续几个带第二声部的小节 → 并排块的小节（只含第二声部；不满小节的补不可见休止）。元素原样搬（id 不变）。
pub fn inner_layer_measures(run: &[Measure], new_id: &mut impl FnMut() -> ElementId) -> Vec<Measure> {
    run.iter()
        .map(|mea| {
            let lane_of = lanes_of(mea);
            let main = mea.elements.iter().filter(|el| lane_of(el) == Some(Lane::Main));
            let inner: Vec<Element> = mea.elements.iter().filter(|el| lane_of(el) == Some(Lane::Inner)).cloned().collect();
            let lack = lane_quarters(main) - lane_quarters(inner.iter());
            let head = inner.iter().find_map(|el| el.as_chord()).map(|c| (c.voice, c.staff));
            let pad = match head {
                Some((v, s)) if lack > 1e-6 => pad_rests(lack, v, s, new_id),
                _ => vec![],
            };
            let mut elements = inner;
            elements.extend(pad.into_iter().map(Element::Chord));
            let mut bar = Barline::at(BarLocation::Right);
            bar.style = Some(BarStyle::Regular);
            Measure { number: mea.number.clone(), elements, barlines: Some(vec![bar]), ..Default::default() }
        })
        .collect()
}

/// 一串小节里带第二声部的连续段（下标区间，含两端）。`break_after(i)`：第 i 小节之后换行，段在那里断开
pub fn inner_runs(measures: &[Measure], break_after: impl Fn(usize) -> bool) -> Vec<(usize, usize)> {
    let mut out = vec![];
    let has: Vec<bool> = measures.iter().map(has_inner_voice).collect();
    let mut i = 0;
    while i < measures.len() {
        if !has[i] {
            i += 1;
            continue;
        }
        let mut end = i;
        while end + 1 < has.len() && has[end + 1] && !break_after(end) {
            end += 1;
        }
        out.push((i, end));
        i = end + 1;
    }
    out
}

fn visit_max(els: &[Element], max: &mut ElementId) {
    for el in els {
        *max = (*max).max(el.id());
        let Element::Chord(c) = el else { continue };
        for su in c.sustains.iter().flatten() {
            *max = (*max).max(su.id);
        }
        for it in c.before.iter().flatten() {
            if let InlineItem::Layer { measures, .. } = it {
                for m in measures {
                    visit_max(&m.elements, max);
                }
            }
        }
    }
}

/// 含增时线、层里元素的最大 id
pub fn max_id(song: &Song) -> ElementId {
    let mut max = 0;
    for p in &song.parts {
        for m in &p.measures {
            visit_max(&m.elements, &mut max);
        }
    }
    max
}

/// 第二声部 → `{dsb}` 层（文本谱写出端用，在副本上做）：每个连续段挂在段首小节主行第一个音的 `before` 上，
/// 两端都在段里的弧、连音随层走。别的谱表、第三声部的元素删掉。
pub fn voices_to_layers(src: &Song, break_after: impl Fn(usize, usize) -> bool) -> std::borrow::Cow<'_, Song> {
    let mixed = src.parts.iter().any(|p| {
        p.measures.iter().any(|m| {
            let Some(first) = m.elements.first() else { return false };
            m.elements.iter().any(|el| el.voice() != first.voice() || el.staff() != first.staff())
        })
    });
    if !mixed {
        return std::borrow::Cow::Borrowed(src);
    }
    let mut song = src.clone();
    let mut next = max_id(&song) + 1;
    let mut new_id = || {
        let id = next;
        next += 1;
        id
    };
    // 已随层走的记号（按 song.marks 下标）
    let mut moved: HashSet<usize> = HashSet::new();
    for pi in 0..song.parts.len() {
        let runs = inner_runs(&song.parts[pi].measures, |i| break_after(pi, i));
        for (a, b) in runs {
            let measures = inner_layer_measures(&song.parts[pi].measures[a..=b], &mut new_id);
            let mut ids: HashSet<ElementId> = HashSet::new();
            for m in &measures {
                for el in &m.elements {
                    ids.insert(el.id());
                    if let Element::Chord(c) = el {
                        for su in c.sustains.iter().flatten() {
                            ids.insert(su.id);
                        }
                    }
                }
            }
            let mut marks = vec![];
            for (k, mk) in song.marks.iter().enumerate() {
                if !moved.contains(&k) && ids.contains(&mk.start) && ids.contains(&mk.end) {
                    marks.push(mk.clone());
                    moved.insert(k);
                }
            }
            let run0 = &song.parts[pi].measures[a];
            let lane_of = lanes_of(run0);
            let host = run0
                .elements
                .iter()
                .position(|el| matches!(el, Element::Chord(c) if c.grace.is_none()) && lane_of(el) == Some(Lane::Main));
            let Some(hi) = host else { continue };
            let Element::Chord(host) = &mut song.parts[pi].measures[a].elements[hi] else { unreachable!() };
            let layer = InlineItem::Layer { role: LayerRole::Voice, measures, marks, source: None };
            let mut before = vec![layer];
            before.extend(host.before.take().unwrap_or_default());
            host.before = Some(before);
        }
        for m in &mut song.parts[pi].measures {
            let keep: Vec<bool> = {
                let lane_of = lanes_of(m);
                m.elements.iter().map(|el| lane_of(el) == Some(Lane::Main)).collect()
            };
            let mut it = keep.into_iter();
            m.elements.retain(|_| it.next().unwrap());
        }
    }
    if !moved.is_empty() {
        let mut k = 0;
        song.marks.retain(|_| {
            let keep = !moved.contains(&k);
            k += 1;
            keep
        });
    }
    std::borrow::Cow::Owned(song)
}

fn is_voice_layer(it: &InlineItem) -> bool {
    matches!(it, InlineItem::Layer { role: LayerRole::Voice, .. })
}

/// `{dsb}` 层 → 同一谱表的第二声部（123 / MusicXML 写出端用，在副本上做）：层里第 k 个小节并进宿主小节往后数第 k 个，
/// `voice` 取本声部用过的最大号 + 1；层从小节中间起的，前面用不可见休止补齐。层里的弧并回全曲。`{bz}` 伴奏层不动。
pub fn layers_to_voices(src: &Song) -> std::borrow::Cow<'_, Song> {
    let has_layer = src.parts.iter().any(|p| {
        p.measures.iter().any(|m| {
            m.elements.iter().any(|el| matches!(el, Element::Chord(c) if c.before.iter().flatten().any(is_voice_layer)))
        })
    });
    if !has_layer {
        return std::borrow::Cow::Borrowed(src);
    }
    let mut song = src.clone();
    let mut next = max_id(&song) + 1;
    let mut new_id = || {
        let id = next;
        next += 1;
        id
    };
    for pi in 0..song.parts.len() {
        let part = &mut song.parts[pi];
        let mut vmax = 1.0f64;
        for m in &part.measures {
            for el in &m.elements {
                vmax = crate::base::js::max(vmax, el.voice());
            }
        }
        let voice = vmax + 1.0;
        for mi in 0..part.measures.len() {
            // forEach 只走开始时的长度（同一小节里追加的不再走）
            let len = part.measures[mi].elements.len();
            for j in 0..len {
                let Element::Chord(el) = &mut part.measures[mi].elements[j] else { continue };
                let Some(before) = el.before.as_mut().filter(|b| !b.is_empty()) else { continue };
                if !before.iter().any(is_voice_layer) {
                    continue;
                }
                let (layers, rest): (Vec<InlineItem>, Vec<InlineItem>) = std::mem::take(before).into_iter().partition(is_voice_layer);
                el.before = if rest.is_empty() { None } else { Some(rest) };
                let staff = el.staff;
                let offset = lane_quarters(part.measures[mi].elements[..j].iter());
                for layer in layers {
                    let InlineItem::Layer { measures, marks, .. } = layer else { unreachable!() };
                    for (k, lm) in measures.into_iter().enumerate() {
                        let Some(target) = part.measures.get_mut(mi + k) else { continue };
                        let pad = if k == 0 && offset > 1e-6 { pad_rests(offset, voice, staff, &mut new_id) } else { vec![] };
                        target.elements.extend(pad.into_iter().map(Element::Chord));
                        target.elements.extend(lm.elements.into_iter().map(|mut x| {
                            match &mut x {
                                Element::Chord(c) => {
                                    c.voice = voice;
                                    c.staff = staff;
                                }
                                Element::Space(s) => {
                                    s.voice = voice;
                                    s.staff = staff;
                                }
                            }
                            x
                        }));
                    }
                    song.marks.extend(marks);
                }
            }
        }
    }
    std::borrow::Cow::Owned(song)
}
