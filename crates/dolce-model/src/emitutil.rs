//! 文本写出端**共用**的助手：`ScoreDoc` → 123 / ABC / jcx 与 → 文本谱。
//!
//! 与目标语法无关、只与模型结构有关：怎么按换行切系统、哪些弧两端都落在本声部、弧与多连音怎么嵌套。
//! TS 里按 `Mark` 对象身份记的集合，这里按**下标**记（下标指传进来的那个 `marks` 切片）。

use crate::helpers::{break_after, inline_break_of};
use crate::{BeamVal, BreakKind, Element, ElementId, Mark, MarkType, Part, Song};
use std::collections::{HashMap, HashSet};

/// 一个系统：第 `from`–`to` 小节（闭区间）。切在小节中间时，首小节从第 `from_el` 个元素起、末小节到第 `to_el` 个止（不含）。
/// 开到底的 `to` / `to_el` 记 `usize::MAX`（TS 的 `MAX_SAFE_INTEGER` / `Infinity`）。
#[derive(Clone, Debug, PartialEq)]
pub struct SystemRange {
    pub from: usize,
    pub to: usize,
    pub from_el: usize,
    pub to_el: usize,
    /// 系统末是**小节中间**的换行：`$` 写在 `to_el` 那个元素之前
    pub inline: Option<BreakKind>,
}

/// 按声部的换行切出系统。最后一段开到无穷；小节中间换行照原位切，同一处的小节级 `print` 不再切第二次
pub fn system_ranges(part: Option<&Part>) -> Vec<SystemRange> {
    let mut out = vec![];
    let Some(part) = part else { return out };
    let mut from = 0;
    let mut from_el = 0;
    let n = part.measures.len();
    for i in 0..n {
        let els = &part.measures[i].elements;
        let mut inline_here = false;
        for (j, el) in els.iter().enumerate().take(els.len().saturating_sub(1)) {
            let Some(kind) = inline_break_of(el) else { continue };
            out.push(SystemRange { from, to: i, from_el, to_el: j + 1, inline: Some(kind) });
            from = i;
            from_el = j + 1;
            inline_here = true;
        }
        if i + 1 < n && !inline_here && break_after(part, i).is_some() {
            out.push(SystemRange { from, to: i, from_el, to_el: usize::MAX, inline: None });
            from = i + 1;
            from_el = 0;
        }
    }
    out.push(SystemRange { from, to: usize::MAX, from_el, to_el: usize::MAX, inline: None });
    out
}

/// 第一声部切出来的系统套到别的声部上：小节中间的切点按拍位对过去（取拍位不早于切点的第一个元素）。
/// `same`：`part` 就是 `lead`（TS 按对象身份比）。按组排的 `axis` 那一路留给文本谱写出端迁移时补
pub fn part_ranges(ranges: &[SystemRange], lead: &Part, part: &Part, same: bool) -> Vec<SystemRange> {
    if same {
        return ranges.to_vec();
    }
    let onset_at = |p: &Part, mi: usize, el: usize| -> f64 {
        let mut t = 0.0;
        let Some(m) = p.measures.get(mi) else { return 0.0 };
        for e in m.elements.iter().take(el) {
            if let Element::Chord(c) = e {
                if c.grace.is_none() {
                    t += c.duration.divisions;
                }
            }
        }
        t
    };
    let index_at = |mi: usize, t: f64| -> usize {
        let len = part.measures.get(mi).map_or(0, |m| m.elements.len());
        for j in 0..=len {
            if onset_at(part, mi, j) >= t {
                return j;
            }
        }
        len
    };
    let map = |mi: usize, el: usize| -> usize {
        if el == 0 || el == usize::MAX {
            el
        } else {
            index_at(mi, onset_at(lead, mi, el))
        }
    };
    ranges
        .iter()
        .map(|r| SystemRange { from_el: map(r.from, r.from_el), to_el: map(r.to, r.to_el), ..r.clone() })
        .collect()
}

/// 同 `part_ranges`，按组排的歌（`timeaxis`：某声部在有的组里缺席）：第一声部的小节落在轴上第几格，本声部就取同一格起止的小节；
/// 这一段里本声部一个小节都没有就给空段（`from > to`，写出端跳过；TS 的 `to = -1` 记成 `from = usize::MAX, to = 0`）。
/// 小节中间的切点只在两边同一格时照拍位对过去。`lead_slots` / `part_slots` 是两声部各小节在轴上的格号
pub fn part_ranges_on_axis(ranges: &[SystemRange], lead: &Part, part: &Part, lead_slots: &[usize], part_slots: &[usize]) -> Vec<SystemRange> {
    const INF: usize = usize::MAX;
    let onset_at = |p: &Part, mi: usize, el: usize| -> f64 {
        let Some(m) = p.measures.get(mi) else { return 0.0 };
        m.elements.iter().take(el).filter_map(|e| if let Element::Chord(c) = e { c.grace.is_none().then_some(c.duration.divisions) } else { None }).sum()
    };
    let index_at = |mi: usize, t: f64| -> usize {
        let len = part.measures.get(mi).map_or(0, |m| m.elements.len());
        (0..=len).find(|&j| onset_at(part, mi, j) >= t).unwrap_or(len)
    };
    let map = |mi: usize, el: usize, pmi: usize| -> usize {
        if el == 0 || el == INF {
            el
        } else {
            index_at(pmi, onset_at(lead, mi, el))
        }
    };
    let at_or_after = |slot: usize| part_slots.iter().position(|&g| g >= slot).unwrap_or(part.measures.len());
    let at_or_before = |slot: usize| part_slots.iter().rposition(|&g| g <= slot);
    ranges
        .iter()
        .map(|r| {
            let sf = lead_slots.get(r.from).copied().unwrap_or(INF);
            let st = if r.to >= lead.measures.len() { INF } else { lead_slots[r.to] };
            let from = if sf == INF { part.measures.len() } else { at_or_after(sf) };
            let to = if st == INF { Some(INF) } else { at_or_before(st) };
            let Some(to) = to else {
                return SystemRange { from: INF, to: 0, from_el: 0, to_el: INF, ..r.clone() };
            };
            SystemRange {
                from,
                to,
                from_el: if sf != INF && part_slots.get(from) == Some(&sf) { map(r.from, r.from_el, from) } else { 0 },
                to_el: if st != INF && part_slots.get(to) == Some(&st) { map(r.to, r.to_el, to) } else { INF },
                ..r.clone()
            }
        })
        .collect()
}

/// 本声部里写得出来的元素 id（含增时线）。`emits` 判哪些元素写
pub fn own_ids(part: &Part, emits: impl Fn(&Element, usize) -> bool) -> HashSet<ElementId> {
    let mut own = HashSet::new();
    for (mi, mea) in part.measures.iter().enumerate() {
        for el in &mea.elements {
            if !emits(el, mi) {
                continue;
            }
            own.insert(el.id());
            if let Element::Chord(c) = el {
                for su in c.sustains.iter().flatten() {
                    own.insert(su.id);
                }
            }
        }
    }
    own
}

/// **只收两端都在本声部里的 Mark**（不校验会写出不配对的括号）
pub fn own_marks(song: &Song, own: &HashSet<ElementId>) -> Vec<Mark> {
    song.marks.iter().filter(|m| own.contains(&m.start) && own.contains(&m.end)).cloned().collect()
}

/// `nest_arcs_in_tuplets` 的结果；`crossed_marks` 是传入切片里被截的那几条的下标
pub struct NestedArcs {
    pub marks: Vec<Mark>,
    pub crossed: usize,
    pub crossed_marks: HashSet<usize>,
    pub outer_open: HashMap<ElementId, usize>,
    pub outer_close: HashMap<ElementId, usize>,
}

struct TupletSpan {
    start: ElementId,
    end: ElementId,
    s: usize,
    e: usize,
}

/// 弧（`is_arc`）与多连音**只许嵌套**的写法（123：两者共用括号）：跨出组的弧截进组内，截完只剩一个音的丢掉；
/// `outer_open` / `outer_close`：组首起、组外收 / 组外起、组尾收的弧数
pub fn nest_arcs_in_tuplets(part: &Part, marks: &[Mark], is_arc: impl Fn(&Mark) -> bool) -> NestedArcs {
    let mut pos: HashMap<ElementId, usize> = HashMap::new();
    let mut tail: HashMap<ElementId, usize> = HashMap::new();
    let mut n = 0usize;
    for mea in &part.measures {
        for el in &mea.elements {
            pos.insert(el.id(), n);
            n += 1;
            if let Element::Chord(c) = el {
                for su in c.sustains.iter().flatten() {
                    pos.insert(su.id, n);
                    n += 1;
                }
            }
            tail.insert(el.id(), n - 1);
        }
    }
    let end_pos = |id: ElementId| -> Option<usize> { tail.get(&id).or_else(|| pos.get(&id)).copied() };
    let mut tuplets: Vec<TupletSpan> = vec![];
    for m in marks {
        if m.kind != MarkType::Tuplet {
            continue;
        }
        if let (Some(s), Some(e)) = (pos.get(&m.start).copied(), end_pos(m.end)) {
            tuplets.push(TupletSpan { start: m.start, end: m.end, s, e });
        }
    }
    let mut outermost_from: HashMap<ElementId, (usize, usize)> = HashMap::new();
    let mut outermost_to: HashMap<ElementId, (usize, usize)> = HashMap::new();
    for t in &tuplets {
        if outermost_from.get(&t.start).is_none_or(|f| t.e > f.1) {
            outermost_from.insert(t.start, (t.s, t.e));
        }
        if outermost_to.get(&t.end).is_none_or(|l| t.s < l.0) {
            outermost_to.insert(t.end, (t.s, t.e));
        }
    }
    let mut out = vec![];
    let mut outer_open: HashMap<ElementId, usize> = HashMap::new();
    let mut outer_close: HashMap<ElementId, usize> = HashMap::new();
    let mut crossed = 0;
    let mut crossed_marks = HashSet::new();
    for (k, m) in marks.iter().enumerate() {
        let arc = is_arc(m);
        let s0 = if arc { pos.get(&m.start).copied() } else { None };
        let e0 = if arc { end_pos(m.end) } else { None };
        let (Some(mut s), Some(mut e)) = (s0, e0) else {
            out.push(m.clone());
            continue;
        };
        if tuplets.is_empty() {
            out.push(m.clone());
            continue;
        }
        let mut mm = m.clone();
        let mut changed = false;
        for t in &tuplets {
            if s < t.s && e >= t.s && e < t.e {
                mm.start = t.start;
                s = t.s;
                crossed += 1;
                changed = true;
            } else if s > t.s && s <= t.e && e > t.e {
                mm.end = t.end;
                e = t.e;
                crossed += 1;
                changed = true;
            }
        }
        if changed {
            crossed_marks.insert(k);
            if mm.start == mm.end {
                continue;
            }
        }
        if let Some(first) = outermost_from.get(&mm.start) {
            if e > first.1 {
                *outer_open.entry(mm.start).or_insert(0) += 1;
            }
        }
        if let Some(last) = outermost_to.get(&mm.end) {
            if s < last.0 {
                *outer_close.entry(mm.end).or_insert(0) += 1;
            }
        }
        out.push(mm);
    }
    NestedArcs { marks: out, crossed, crossed_marks, outer_open, outer_close }
}

/// 跨出多连音、但终点就是起点**之后下一个非倚音和弦**的弧（123 写成起点音后的 `~`）。返回传入切片里的下标
pub fn arcs_to_next_note(part: &Part, marks: &[Mark], is_arc: impl Fn(&Mark) -> bool, own: Option<&HashSet<ElementId>>) -> HashSet<usize> {
    let mut out = HashSet::new();
    let crossed = nest_arcs_in_tuplets(part, marks, is_arc).crossed_marks;
    if crossed.is_empty() {
        return out;
    }
    let mut next: HashMap<ElementId, ElementId> = HashMap::new();
    let mut prev: Option<ElementId> = None;
    for mea in &part.measures {
        for el in &mea.elements {
            let Element::Chord(c) = el else { continue };
            if c.grace.is_some() || own.is_some_and(|o| !o.contains(&c.id)) {
                continue;
            }
            if let Some(p) = prev {
                next.insert(p, c.id);
            }
            prev = Some(c.id);
        }
    }
    for k in crossed {
        if next.get(&marks[k].start) == Some(&marks[k].end) {
            out.insert(k);
        }
    }
    out
}

/// 第一层符杠在这个音上是起、续还是收（`Chord.beams` 不保证按层排）。不连为 None
pub fn beam_level1(beams: Option<&Vec<BeamVal>>) -> Option<BeamVal> {
    let vals: Vec<&BeamVal> =
        beams.into_iter().flatten().filter(|v| matches!(v, BeamVal::Begin | BeamVal::Continue | BeamVal::End)).collect();
    if vals.is_empty() {
        return None;
    }
    if vals.iter().any(|v| **v == BeamVal::Continue) {
        return Some(BeamVal::Continue);
    }
    if vals.iter().any(|v| **v == BeamVal::Begin) {
        return Some(BeamVal::Begin);
    }
    Some(BeamVal::End)
}
