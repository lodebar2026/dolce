//! 记号层：弧线、多连音、跳房子、渐强渐弱（照 `compose/marks.ts`）。

use dolce_engrave::arc::{slur_tie, ArcKind, SlurStyle};
use dolce_engrave::ending::{add_ending_bracket, ending_drop, ending_label_dx, EndingBracket, EndingLabel};
use dolce_engrave::hairpin::{hairpin_path, jp_hairpin, jp_hairpin_halves, jp_hairpin_line_width, HairpinSpec};
use dolce_engrave::tuplet::{TupletGlyph, TupletKind, TupletStyle};
use dolce_geom::Point;
use dolce_scene::build::update;
use dolce_scene::{Identity, IdentityKind, Node};
use dolce_view::ast::MarkType;

use super::ctx::{eid, font, ident, Ctx};
use crate::grid::{bracket_line_width, jianpu_slur_style};
use crate::model::PlacedMark;
use crate::place::marks::below_arc_style;
use crate::util::max;

/// 弧线（月牙形）；`flat` 强制扁平、`below` 叠印下方的那条
fn paint_arc(c: &Ctx, x0: f64, x1: f64, y: f64, flat: bool, below: bool) -> Node {
    let style = if below { below_arc_style(c.m, c.ink) } else { jianpu_slur_style(c.m, c.ink) };
    let style = if flat { SlurStyle { force_flat: true, ..style } } else { style };
    let mut arc = slur_tie(ArcKind::Slur, Point::new(x0, y), Point::new(x1, y), &style, c.env);
    update(&mut arc, c.env).unwrap_or_else(|e| panic!("{}", e.0));
    arc
}

pub fn paint_mark(c: &Ctx, root: &mut Node, mk: &PlacedMark, left: f64, baseline: f64) {
    let m = c.m;
    let x0 = left + mk.x0;
    let x1 = max(left + mk.x1, x0 + 6.0);
    let nh = m.ink.note_height;
    match mk.mark.kind {
        MarkType::Slur => {
            let y = baseline + mk.y.unwrap_or(-nh / 2.0);
            let mut arc = paint_arc(c, x0, x1, y, mk.flat, mk.below);
            if mk.has_ends {
                if let (Some(s), Some(e)) = (mk.start_id, mk.end_id) {
                    arc.id = Some(Identity { id: Some(eid(s)), end: Some(eid(e)), ..ident(IdentityKind::Slur) });
                }
            }
            root.push(arc);
        }
        MarkType::Tuplet => {
            let y = baseline + mk.y.unwrap_or(-nh / 2.0);
            let cap = mk.mark.caption.as_deref().map_or(f64::NAN, dolce_base::js::number);
            let n = if cap != 0.0 && !cap.is_nan() { cap } else { (mk.mark.end - mk.mark.start + 1) as f64 };
            let bracket = m.style.look.tuplet_style == "bracket";
            let foot = if m.style.vertical.bracket_foot > 0.0 { m.style.vertical.bracket_foot * 0.55 } else { m.style.size.note * 0.25 };
            let ly = if bracket { y - foot } else { y };
            let tg = TupletGlyph::new(
                Point::new(x0, ly),
                Point::new(x1, ly),
                n,
                &TupletStyle {
                    kind: if bracket { TupletKind::Bracket } else { TupletKind::Arc },
                    color: c.ink,
                    music: font("Bravura", c.digit_font.size, false),
                    meta: false,
                    line_width: Some(bracket_line_width(m)),
                    foot: Some(foot),
                    gap_pad: None,
                    arc: Some(jianpu_slur_style(m, c.ink)),
                },
                c.env,
            );
            for it in tg.items {
                root.push(it);
            }
        }
        MarkType::Crescendo | MarkType::Decrescendo => {
            let lw = jp_hairpin_line_width(m.style.stroke.hairpin, nh);
            let y = baseline + mk.y.unwrap_or(-nh / 2.0) - lw / 2.0 - nh * jp_hairpin::HALF;
            let (half0, half1) = jp_hairpin_halves(mk.mark.kind == MarkType::Crescendo, nh, mk.open_left, mk.open_right);
            let mut hp = hairpin_path(&HairpinSpec { x0, x1, y, half0, half1, line_width: lw, color: c.ink });
            hp.add_class("hairpin");
            root.push(hp);
        }
        MarkType::Volta => {
            let y = baseline + mk.y.unwrap_or(-nh / 2.0);
            let size = m.style.size.ending;
            let foot = m.style.vertical.bracket_foot;
            let lw = bracket_line_width(m);
            let caption = mk.mark.caption.as_deref().unwrap_or("");
            let show_label = !caption.is_empty() && !mk.open_left;
            add_ending_bracket(
                root,
                &EndingBracket {
                    x0,
                    x1,
                    top: y,
                    drop: ending_drop(foot, size),
                    left_foot: !mk.open_left,
                    right_foot: !mk.open_right && mk.mark.open_end != Some(true),
                    line_width: lw,
                    color: c.ink,
                    label: show_label.then(|| EndingLabel { text: caption.to_string(), font: c.digit_font.with_size(size), dx: ending_label_dx(lw, size, foot) }),
                    classes: Some(("ending-line".into(), "ending".into())),
                },
                c.env,
            );
        }
    }
}
