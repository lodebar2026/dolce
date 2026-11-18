//! 跨若干符号的记号（弧线 / 多连音 / 跳房子 / 渐强渐弱）换算成行内坐标，弧按嵌套定层（照 `place/marks.ts`）。

use dolce_engrave::arc::{arc_clear_shift, arc_rise, jp_arc_y, slur_tie, ArcKind, ArcObstacle, SlurStyle, ARC_CHAIN_INSET_DIV};
use dolce_engrave::dynamics::DYNAMIC_SIZE;
use dolce_engrave::hairpin::jp_hairpin;
use dolce_engrave::jpglyph::dynamic;
use dolce_base::geom::Point;
use dolce_view::ast::{Mark, MarkType, MusicElement, ScoreLine};

use crate::grid::{jianpu_slur_rise, jianpu_slur_style, JianpuGrid};
use crate::ink::Ink;
use crate::model::{PlacedItem, PlacedMark};
use crate::place::spacing::barline_lines;
use crate::place::vertical::{artic_stack, note_ink_bottom, stack_top};
use crate::util::{max, max_of, min};

/// 把记号的元素下标区间换算成行内 x 区间；弧线、多连音的 y 也在这里定（跳房子、松叶的 y 见 band）。
pub fn place_marks(voice: &ScoreLine, items: &[PlacedItem], m: &JianpuGrid, ink: &Ink) -> Vec<PlacedMark> {
    if items.is_empty() {
        return vec![];
    }
    let first = 0usize;
    let last = items.len() - 1;
    let at = |src: i64, start: bool| -> usize {
        // 记号端点未必正落在占位符号上（例如 `(` 紧跟在 `~` 后），取最近的一个
        let mut best = if start { last } else { first };
        for (k, it) in items.iter().enumerate() {
            if start {
                if it.src_index >= src && it.src_index < items[best].src_index {
                    best = k;
                }
            } else if it.src_index <= src && it.src_index > items[best].src_index {
                best = k;
            }
        }
        if start && items[best].src_index < src {
            best = first;
        }
        best
    };
    let mut out: Vec<PlacedMark> = vec![];
    for (mi, mark) in voice.marks.iter().enumerate() {
        let open_left = mark.continuation_from_previous == Some(true);
        let open_right = mark.continuation_to_next == Some(true);
        // 跨行的弧线/多连音**两截都画**
        let ai = if open_left { first } else { at(mark.start, true) };
        let bi = if open_right { last } else { at(mark.end, false) };
        let (a, b) = (&items[ai], &items[bi]);
        let level = max(1.0, mark.level);
        let is_arc = matches!(mark.kind, MarkType::Slur | MarkType::Tuplet);
        let dx = if is_arc { m.ink.note_height / 0.7 / ARC_CHAIN_INSET_DIV } else { 0.0 };
        let chained_left = voice.marks.iter().enumerate().any(|(k, o)| k != mi && o.end == mark.start);
        let chained_right = voice.marks.iter().enumerate().any(|(k, o)| k != mi && o.start == mark.end);
        let is_wedge = matches!(mark.kind, MarkType::Crescendo | MarkType::Decrescendo);
        let spread = m.note.beam_half_span;
        let pad_left = if is_arc { if chained_left { dx } else { 0.0 } } else { -spread };
        let pad_right = if is_arc { if chained_right { dx } else { 0.0 } } else { -spread };
        // 跳房子的竖脚对齐小节线的线位
        let mut vx0: Option<f64> = None;
        let mut vx1: Option<f64> = None;
        if mark.kind == MarkType::Volta {
            for it in items {
                let MusicElement::Barline(bl) = &it.element else { continue };
                let ln = barline_lines(bl, m);
                if it.x <= a.x {
                    vx0 = Some(it.x + ln.map_or(0.0, |l| l.1));
                }
                if it.x >= b.x && vx1.is_none() {
                    vx1 = Some(it.x + ln.map_or(0.0, |l| l.0));
                }
            }
        }
        let mut placed = PlacedMark {
            dy: None,
            mark: mark.clone(),
            x0: if open_left { a.x - m.note.note_step * 0.5 } else { vx0.unwrap_or(a.x + pad_left) },
            x1: if open_right { b.x + m.note.note_step * 0.5 } else { vx1.unwrap_or(b.x - pad_right) },
            y: None,
            flat: false,
            below: false,
            level,
            open_left,
            open_right,
            has_ends: true,
            start_id: a.id,
            end_id: b.id,
        };
        if is_wedge {
            let (x0, x1) = wedge_span(items, a, b, open_left, open_right, m, ink);
            placed.x0 = x0;
            placed.x1 = x1;
        }
        if mark.kind == MarkType::Tuplet && m.style.look.tuplet_style == "bracket" {
            let gap = m.style.vertical.slur_gap;
            let mut top = f64::INFINITY;
            for it in items {
                let MusicElement::Note(n) = &it.element else { continue };
                if it.src_index < a.src_index || it.src_index > b.src_index || n.hidden {
                    continue;
                }
                top = min(top, artic_stack(&it.element, m, ink, gap).1);
            }
            if !top.is_finite() {
                top = min(stack_top(Some(&a.element), m, true), stack_top(Some(&b.element), m, true));
            }
            placed.y = Some(top - gap - (level - 1.0) * m.note.level_step);
        } else if mark.kind == MarkType::Slur && tie_below(mark, a, b, open_left, open_right) {
            let ends: Vec<&PlacedItem> = [(!open_left).then_some(a), (!open_right).then_some(b)]
                .into_iter()
                .flatten()
                .filter(|it| matches!(it.element, MusicElement::Note(_)))
                .collect();
            placed.below = true;
            placed.y = Some(
                max_of(ends.iter().map(|it| match &it.element {
                    MusicElement::Note(n) => note_ink_bottom(n, m),
                    _ => unreachable!(),
                })) + m.ink.stack.gap,
            );
        } else if is_arc {
            let flat_notes = m.style.arc.flat_notes;
            if mark.kind == MarkType::Slur && flat_notes > 0.0 {
                let mut n = 0.0;
                for it in items {
                    if it.src_index >= a.src_index && it.src_index <= b.src_index && matches!(it.element, MusicElement::Note(_)) {
                        n += 1.0;
                    }
                }
                if n >= flat_notes {
                    placed.flat = true;
                }
            }
            let top_a = stack_top(Some(&a.element), m, false);
            let top_b = stack_top(Some(&b.element), m, true);
            placed.y = Some(
                jp_arc_y(if open_left { top_b } else { top_a }, if open_right { top_a } else { top_b }, m.ink.stack.gap)
                    - (level - 1.0) * m.note.level_step,
            );
        }
        if a.dy.is_some() && b.dy.is_some() {
            placed.dy = a.dy;
        }
        out.push(placed);
    }
    // 弧套弧：从短的排起，外层才看得到里层定下的高度
    let mut arcs: Vec<usize> = (0..out.len()).filter(|&k| out[k].y.is_some() && is_arc_mark(&out[k].mark) && !out[k].below).collect();
    dolce_base::js::sort_by(&mut arcs, |&p, &q| {
        ((out[p].mark.end - out[p].mark.start) - (out[q].mark.end - out[q].mark.start)) as f64
    });
    let capped = jianpu_slur_rise(m);
    let free_style = jianpu_slur_style(m, 0.0);
    let rise_of = |p: &PlacedMark| -> f64 { if capped.is_finite() { capped } else { arc_rise(p.x1 - p.x0, &free_style) } };
    for i in 0..arcs.len() {
        let outer = arcs[i];
        let inner: Vec<ArcObstacle> = arcs[..i]
            .iter()
            .filter(|&&q| nests(q, &out[q].mark, outer, &out[outer].mark))
            .map(|&q| {
                let qm = &out[q];
                ArcObstacle { x: (qm.x0 + qm.x1) / 2.0, y: qm.y.unwrap() - rise_of(qm) - m.style.stroke.slur }
            })
            .collect();
        let o = &out[outer];
        let y = o.y.unwrap();
        let shift = arc_clear_shift(o.x0, y, o.x1, y, rise_of(o), true, &inner, m.ink.stack.gap);
        out[outer].y = Some(y + shift);
    }
    out
}

/// 松叶的横向范围（几何见 `jp_hairpin`）
fn wedge_span(items: &[PlacedItem], a: &PlacedItem, b: &PlacedItem, open_left: bool, open_right: bool, m: &JianpuGrid, ink: &Ink) -> (f64, f64) {
    let nh = m.ink.note_height;
    let notes: Vec<&PlacedItem> = items.iter().filter(|it| matches!(it.element, MusicElement::Note(_) | MusicElement::Sustain(_))).collect();
    let first_note = notes.first().copied().unwrap_or(a);
    let last_note = notes.last().copied().unwrap_or(b);
    let mut x0 = if open_left { max(0.0, first_note.x - nh * jp_hairpin::CARRY_LEAD) } else { a.x - nh * jp_hairpin::PAD };
    let mut x1 = if open_right { last_note.x + ink.digit("1").advance / 2.0 } else { b.x + nh * jp_hairpin::PAD };
    let dyn_width = |it: &PlacedItem| -> f64 {
        let MusicElement::Note(n) = &it.element else { return 0.0 };
        let fs = m.style.size.note * DYNAMIC_SIZE;
        let ws: Vec<f64> = n.ornaments.iter().filter_map(|o| dynamic(&o.name)).map(|g| ink.smufl(&g, fs).width()).collect();
        if ws.is_empty() {
            0.0
        } else {
            max_of(ws)
        }
    };
    let w0 = if open_left { 0.0 } else { dyn_width(a) };
    if w0 > 0.0 {
        let after = a.x + w0 / 2.0 + nh * 0.25;
        if after < x1 - nh {
            x0 = after;
        }
    }
    let w1 = if open_right { 0.0 } else { dyn_width(b) };
    if w1 > 0.0 {
        let before = b.x - w1 / 2.0 - nh * 0.25;
        if before > x0 + nh {
            x1 = before;
        }
    }
    (x0, x1)
}

/// 和音单连一个音的延音线是不是连在最下面那个数字上
fn tie_below(mark: &Mark, a: &PlacedItem, b: &PlacedItem, open_left: bool, open_right: bool) -> bool {
    let Some(digits) = mark.digits else { return false };
    let mut ends: Vec<(&PlacedItem, u32)> = vec![];
    if !open_left {
        ends.push((a, digits[0]));
    }
    if !open_right {
        ends.push((b, digits[1]));
    }
    !ends.is_empty()
        && ends.iter().all(|(it, d)| *d == 0 && matches!(&it.element, MusicElement::Note(n) if n.stack.as_ref().is_some_and(|s| !s.is_empty())))
}

/// 叠印下方那几条延音线的墨迹底，相对基线（含并排块的 `dy`）；没有为 -Infinity
pub fn below_arcs_bottom(marks: &[PlacedMark], m: &JianpuGrid, ink: &Ink) -> f64 {
    let mut bottom = f64::NEG_INFINITY;
    for mk in marks {
        let (true, Some(y)) = (mk.below, mk.y) else { continue };
        let arc = slur_tie(ArcKind::Slur, Point::new(mk.x0, y), Point::new(max(mk.x1, mk.x0 + 6.0), y), &below_arc_style(m, 0.0), ink.env);
        bottom = max(bottom, arc.y() + arc.h + mk.dy.unwrap_or(0.0));
    }
    bottom
}

/// 叠印下方那条延音线的样式：开口朝上；扁平式关掉
pub fn below_arc_style(m: &JianpuGrid, color: f64) -> SlurStyle {
    SlurStyle { side_down: true, flat_span: Some(0.0), flat_ratio: Some(0.0), ..jianpu_slur_style(m, color) }
}

pub fn is_arc_mark(mk: &Mark) -> bool {
    matches!(mk.kind, MarkType::Slur | MarkType::Tuplet)
}

/// `inner` 整条落在 `outer` 的跨度里（不是同一条；身份按下标）
fn nests(ii: usize, inner: &Mark, oi: usize, outer: &Mark) -> bool {
    ii != oi && inner.start >= outer.start && inner.end <= outer.end && (inner.start != outer.start || inner.end != outer.end)
}

/// 第 `at` 条记号外面套着几层（TS 按对象身份在 `marks` 里认，这里给下标）
pub fn arc_nest_depth(at: usize, marks: &[Mark]) -> f64 {
    let mut depth: f64 = 0.0;
    for (k, o) in marks.iter().enumerate() {
        if is_arc_mark(o) && nests(k, o, at, &marks[at]) {
            depth = max(depth, arc_nest_depth(k, marks) + 1.0);
        }
    }
    depth
}
