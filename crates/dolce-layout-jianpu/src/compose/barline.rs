//! 小节线（含反复点、跳转记号）的绘制（照 `compose/barline.ts`）。

use dolce_engrave::barline::{BarlineGlyph, BarlineStyle};
use dolce_scene::Node;
use dolce_view::ast::{BarlineType, MusicElement};

use super::ctx::{font, Ctx, ItemsKey};
use super::header::paint_meter;
use super::note::paint_ornaments;
use crate::barspec::fanqie_barline_spec;
use crate::grid::barline_span;
use crate::model::PlacedItem;
use crate::place::spacing::TIME_SIG_PAD_EM;

/// 一条小节线。线本身收在一个组里，返回它在 `root.k` 里的下标（线不画时为 None）。
/// `key` / `at`：这条线在哪串 items 的第几个（查上方带用）。`span_height` > 0 时贯穿到 baseline + span_height
#[allow(clippy::too_many_arguments)]
pub fn paint_barline(c: &Ctx, root: &mut Node, x: f64, baseline: f64, it: &PlacedItem, key: ItemsKey, at: usize, span_height: f64) -> Option<usize> {
    let m = c.m;
    let MusicElement::Barline(el) = &it.element else { return None };
    let meter_font = || font(&m.style.font.text.family, m.style.size.key_meter * 0.85, false);
    if matches!(el.kind, BarlineType::Hidden | BarlineType::Invisible) || it.no_barline {
        if !el.ornaments.is_empty() {
            let mut g = Node::group();
            paint_ornaments(c, &mut g, &el.ornaments, key, at, x, baseline);
            root.push(g);
        }
        if let Some(tm) = &el.temporary_meter {
            paint_meter(c, root, x + m.style.size.note * TIME_SIG_PAD_EM, baseline, tm.numerator, tm.denominator, &meter_font());
        }
        return None;
    }
    let (top, bottom) = barline_span(m);
    let Some((spec, final_)) = fanqie_barline_spec(el) else {
        if !el.ornaments.is_empty() {
            let mut og = Node::group();
            paint_ornaments(c, &mut og, &el.ornaments, key, at, x, baseline);
            root.push(og);
        }
        return None;
    };
    let r = BarlineGlyph::new(
        &spec,
        final_,
        &BarlineStyle {
            top,
            bot: bottom + span_height,
            light: m.style.stroke.barline,
            heavy: m.style.stroke.final_barline,
            gap: None,
            dot_radius: Some(m.style.dot.repeat),
            dots: None,
            color: c.ink,
        },
    );
    let ox = x - r.width / 2.0;
    if let Some(tm) = &el.temporary_meter {
        let right = if spec.repeat_forward {
            r.width + 2.0 * m.style.dot.repeat
        } else {
            r.lines.last().map_or(f64::NAN, |&i| {
                let n = &r.items[i];
                n.x() + n.line_ref().map_or(0.0, |l| l.stroke_width)
            })
        };
        paint_meter(c, root, ox + right + m.style.size.note * TIME_SIG_PAD_EM, baseline, tm.numerator, tm.denominator, &meter_font());
    }
    if !el.ornaments.is_empty() {
        let mut og = Node::group();
        paint_ornaments(c, &mut og, &el.ornaments, key, at, x, baseline);
        root.push(og);
    }
    let mut g = Node::group();
    for mut item in r.items {
        item.shift(ox, baseline);
        g.push(item);
    }
    root.push(g);
    Some(root.k.len() - 1)
}
