//! 文本谱写出端的弧线规划（同 `fanqie/tofanqie.ts` 的 `planArcs` / `writableMarks` / `positions` / `shortOpenVoltas`）。
//!
//! 写出端整体在 M4 迁；这几样先迁过来，是因为丢失清单（`capability`）要用同一份判据数「写不出来的弧」。

use crate::emitutil::own_ids;
use crate::jianpu::{melody_lane, top_note};
use crate::{Chord, Element, ElementId, EndingType, Mark, MarkType, Measure, Part, Song, Spacer, WedgeType};
use std::collections::{HashMap, HashSet};

/// 弧线与多连音的写法规划
#[derive(Default, Debug)]
pub struct ArcPlan {
    /// 元素 id → 写在它前面的开口（按顺序，`(` 或 `(y`）
    pub opens: HashMap<ElementId, Vec<&'static str>>,
    /// 元素 id → 紧跟它的 `)` 个数
    pub closes: HashMap<ElementId, usize>,
    /// 渐强渐弱：id → 写在它后面的 `<`/`>` 与 `!`
    pub wedge_start: HashMap<ElementId, Vec<String>>,
    pub wedge_end: HashMap<ElementId, usize>,
    /// 写不出来、只好丢掉的弧（真嵌套）条数
    pub dropped_nested: usize,
    /// 写不出来的多连音（比例不是 n:n−1，或挤不进括号队列）条数
    pub dropped_odd_tuplet: usize,
    /// 落在多连音里的元素位次
    pub in_tuplet: HashSet<usize>,
}

fn prio(t: &MarkType) -> Option<u8> {
    match t {
        MarkType::Tuplet => Some(0),
        MarkType::Tied => Some(1),
        MarkType::Slur => Some(2),
        _ => None,
    }
}

/// 弧线（含延音线）与多连音 → 括号。文本谱的 `)` 是**先开先闭**，一条完全包住另一条（后开的先收）写不出来。
/// 按优先级挑：多连音 > 延音线 > 圆滑线，挑不进来的丢掉；多连音 n 个符号一律占 n−1 个基本时值，别的比例写不出来。
pub fn plan_arcs(marks: &[Mark], pos: &HashMap<ElementId, usize>) -> ArcPlan {
    let mut plan = ArcPlan::default();
    struct Arc<'a> {
        m: &'a Mark,
        s: usize,
        e: usize,
    }
    let mut cands: Vec<Arc> = vec![];
    for m in marks {
        let (Some(&s), Some(&e)) = (pos.get(&m.start), pos.get(&m.end)) else { continue };
        if e < s {
            continue;
        }
        if m.kind == MarkType::Wedge {
            if e == s {
                continue;
            }
            let sign = format!(
                "{}{}",
                if m.wedge_type == Some(WedgeType::Diminuendo) { ">" } else { "<" },
                "+".repeat(m.level.unwrap_or(0.0).max(0.0) as usize)
            );
            plan.wedge_start.entry(m.start).or_default().push(sign);
            *plan.wedge_end.entry(m.end).or_insert(0) += 1;
            continue;
        }
        if prio(&m.kind).is_none() || m.collapsed == Some(true) {
            continue;
        }
        if m.kind == MarkType::Tuplet {
            let n = (e - s + 1) as f64;
            let odd = m.tuplet_actual.is_some_and(|a| a != n || m.tuplet_normal.unwrap_or(2.0) != n - 1.0);
            if n < 2.0 || odd {
                plan.dropped_odd_tuplet += 1;
                continue;
            }
        }
        cands.push(Arc { m, s, e });
    }
    let p = |a: &Arc| prio(&a.m.kind).unwrap_or(0);
    cands.sort_by(|a, b| p(a).cmp(&p(b)).then(a.s.cmp(&b.s)).then(a.e.cmp(&b.e)));
    let fits = |a: &Arc, b: &Arc| -> bool {
        if a.e < b.s || b.e < a.s || a.s == b.s {
            return true;
        }
        let (x, y) = if a.s < b.s { (a, b) } else { (b, a) };
        x.e <= y.e
    };
    let mut kept: Vec<Arc> = vec![];
    for c in cands {
        if kept.iter().all(|k| fits(k, &c)) {
            kept.push(c);
        } else if c.m.kind == MarkType::Tuplet {
            plan.dropped_odd_tuplet += 1;
        } else {
            plan.dropped_nested += 1;
        }
    }
    kept.sort_by(|a, b| a.s.cmp(&b.s).then(a.e.cmp(&b.e)).then(p(a).cmp(&p(b))));
    for k in &kept {
        let tuplet = k.m.kind == MarkType::Tuplet;
        plan.opens.entry(k.m.start).or_default().push(if tuplet { "(y" } else { "(" });
        *plan.closes.entry(k.m.end).or_insert(0) += 1;
        if tuplet {
            plan.in_tuplet.extend(k.s + 1..=k.e);
        }
    }
    plan
}

/// 写哪些元素：倚音另写、无时值占位 `y` 没有写法；和弦只写简谱印的那一路（同 123）
pub fn is_stream_element(el: &Element, mea: &Measure) -> bool {
    match el {
        Element::Space(s) => s.spacer == Spacer::X,
        Element::Chord(c) => {
            if c.grace.is_some() {
                return false;
            }
            melody_lane(mea).is_none_or(|(staff, voice)| c.staff == staff && c.voice == voice)
        }
    }
}

/// 写出顺序里的位次：主旋律上的和弦、不可见休止、增时线各占一位（倚音与 `y` 不占）
pub fn positions(part: &Part) -> HashMap<ElementId, usize> {
    let mut pos = HashMap::new();
    let mut p = 0;
    for mea in &part.measures {
        for el in &mea.elements {
            if !is_stream_element(el, mea) {
                continue;
            }
            pos.insert(el.id(), p);
            p += 1;
            if let Element::Chord(c) = el {
                for su in c.sustains.iter().flatten() {
                    pos.insert(su.id, p);
                    p += 1;
                }
            }
        }
    }
    pos
}

/// 这一声部写得出的记号：端点在倚音上的弧改挂到所属主音（改挂后起止重合的计入 `grace_arc`）；
/// 挂在和音非最高音上的延音线不写；同一对音上延音线与圆滑线重了的只留延音线
pub fn writable_marks(song: &Song, part: &Part, own: &HashSet<ElementId>) -> (Vec<Mark>, usize) {
    let mut host: HashMap<ElementId, ElementId> = HashMap::new();
    let mut chord_of: HashMap<ElementId, &Chord> = HashMap::new();
    let mut pending: Vec<ElementId> = vec![];
    let mut prev_main: Option<ElementId> = None;
    for m in &part.measures {
        for el in &m.elements {
            let Element::Chord(c) = el else { continue };
            chord_of.insert(c.id, c);
            if let Some(g) = &c.grace {
                match prev_main {
                    Some(pm) if g.after == Some(true) => {
                        host.insert(c.id, pm);
                    }
                    _ => pending.push(c.id),
                }
                continue;
            }
            if !own.contains(&c.id) {
                continue;
            }
            for g in pending.drain(..) {
                host.insert(g, c.id);
            }
            prev_main = Some(c.id);
        }
    }
    let on_top = |id: ElementId, note: Option<f64>| -> bool {
        let Some(ch) = chord_of.get(&id) else { return true };
        if ch.notes.len() < 2 {
            return true;
        }
        match top_note(ch) {
            None => true,
            Some(t) => t as f64 == note.unwrap_or(0.0),
        }
    };
    let mut grace_arc = 0;
    let mut out: Vec<Mark> = vec![];
    for mk in &song.marks {
        if mk.kind != MarkType::Slur && mk.kind != MarkType::Tied {
            if own.contains(&mk.start) && own.contains(&mk.end) {
                out.push(mk.clone());
            }
            continue;
        }
        let start = host.get(&mk.start).copied().unwrap_or(mk.start);
        let end = host.get(&mk.end).copied().unwrap_or(mk.end);
        if !own.contains(&start) || !own.contains(&end) {
            continue;
        }
        if start == end && (start != mk.start || end != mk.end) {
            grace_arc += 1;
            continue;
        }
        if mk.kind == MarkType::Tied && (!on_top(mk.start, mk.start_note) || !on_top(mk.end, mk.end_note)) {
            continue;
        }
        out.push(Mark { start, end, ..mk.clone() });
    }
    let tied: HashSet<(ElementId, ElementId)> = out.iter().filter(|m| m.kind == MarkType::Tied).map(|m| (m.start, m.end)).collect();
    out.retain(|m| m.kind != MarkType::Slur || !tied.contains(&(m.start, m.end)));
    (out, grace_arc)
}

/// 只罩一小节的不封口房号的收尾（`discontinue`）：返回 (小节下标, 小节线下标)。按 `pair` 配；没有配对号的按先后（后开的先收）
pub fn short_open_voltas(part: &Part) -> HashSet<(usize, usize)> {
    let mut out = HashSet::new();
    let mut open: Vec<(Option<f64>, usize)> = vec![];
    for (mi, mea) in part.measures.iter().enumerate() {
        let ends: Vec<(usize, &crate::Ending)> =
            mea.barlines.iter().flatten().enumerate().filter_map(|(bi, b)| b.ending.as_ref().map(|e| (bi, e))).collect();
        for (_, e) in &ends {
            if e.kind == EndingType::Start {
                open.push((e.pair, mi));
            }
        }
        for (bi, e) in &ends {
            if e.kind == EndingType::Start {
                continue;
            }
            let at = match e.pair {
                Some(p) => open.iter().position(|s| s.0 == Some(p)),
                None => open.len().checked_sub(1),
            };
            let Some(at) = at else { continue };
            if e.kind == EndingType::Discontinue && open[at].1 == mi {
                out.insert((mi, *bi));
            }
            open.remove(at);
        }
    }
    out
}

/// 转成文本谱时写不出来的弧线与多连音（丢失清单用，判据与写出时同一份）
#[derive(Default, Debug, PartialEq)]
pub struct ArcLosses {
    pub nested: usize,
    pub odd_tuplet: usize,
    pub grace_arc: usize,
}

pub fn fanqie_arc_losses(src: &Song) -> ArcLosses {
    let song = crate::jianpuproject::project_for_jianpu(src);
    let mut out = ArcLosses::default();
    for part in &song.parts {
        let own = own_ids(part, |el, mi| is_stream_element(el, &part.measures[mi]));
        let (marks, grace_arc) = writable_marks(&song, part, &own);
        let plan = plan_arcs(&marks, &positions(part));
        out.nested += plan.dropped_nested;
        out.odd_tuplet += plan.dropped_odd_tuplet;
        out.grace_arc += grace_arc;
    }
    out
}
