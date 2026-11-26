//! 连音（三连音等）的画法（`engrave/tuplet.ts`）：括号 / 两段弧 / 只印数字。数字是 SMuFL tuplet 字形，按墨迹居中。

use dolce_model::base::geom::{Point, Rect};
use dolce_scene::build::update;
use dolce_scene::Node;
use dolce_text::Font;

use crate::arc::{slur_tie, ArcKind, SlurStyle};
use crate::glyph;
use crate::prims::{music_ink, music_text};
use crate::Env;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TupletKind {
    Bracket,
    Arc,
    Number,
}

impl TupletKind {
    pub fn parse(s: &str) -> TupletKind {
        match s {
            "arc" => TupletKind::Arc,
            "number" => TupletKind::Number,
            _ => TupletKind::Bracket,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct TupletStyle {
    pub kind: TupletKind,
    pub color: f64,
    /// 数字的 SMuFL 字体（字号即数字字号）
    pub music: Font,
    /// 有元数据就按元数据量数字墨迹
    pub meta: bool,
    pub line_width: Option<f64>,
    /// 括号竖脚：从横线量到脚尖的有向长度
    pub foot: Option<f64>,
    /// 数字两侧各留的空 ÷ 数字字号，缺省 0.15
    pub gap_pad: Option<f64>,
    /// `arc` 样子的弧形参数
    pub arc: Option<SlurStyle>,
}

/// 连音数字 → SMuFL 字形串（`tuplet0` 起连续编码）。
pub fn tuplet_digits(n: f64) -> String {
    let zero = glyph("tuplet0").chars().next().unwrap() as i64;
    dolce_model::base::js::num_to_string(n)
        .encode_utf16()
        .filter_map(|c| char::from_u32((zero + c as i64 - 48) as u32))
        .collect()
}

/// 一组连音记号。图元直接按调用方坐标摆（不另包组）。
#[derive(Clone, Debug, PartialEq)]
pub struct TupletGlyph {
    pub items: Vec<Node>,
    /// 断口半宽（数字墨迹半宽 + 两侧留空）
    pub half_gap: f64,
    /// 线那一截的顶（括号是横线上沿，弧是弧顶）
    pub line_top: f64,
    /// 数字的墨迹盒
    pub num_box: Rect,
}

impl TupletGlyph {
    pub fn new(p0: Point, p1: Point, n: f64, style: &TupletStyle, env: &Env) -> TupletGlyph {
        let glyphs = tuplet_digits(n);
        let font = &style.music;
        let ink = music_ink(&glyphs, font, style.meta, env);
        let ink_cx = (ink.left + ink.right) / 2.0;
        let ink_cy = (ink.top + ink.bottom) / 2.0;
        let half_gap = ink.width() / 2.0 + font.size * style.gap_pad.unwrap_or(0.15);
        let cx = (p0.x + p1.x) / 2.0;
        let mut cy = (p0.y + p1.y) / 2.0;
        let mut line_top = dolce_model::base::js::min(p0.y, p1.y);
        let mut items = Vec::new();
        match style.kind {
            TupletKind::Bracket => {
                let lw = style.line_width.unwrap_or(1.0);
                let foot = style.foot.unwrap_or(0.0);
                let k = if p1.x != p0.x { (p1.y - p0.y) / (p1.x - p0.x) } else { 0.0 };
                let dx = dolce_model::base::js::max(0.0, (p1.x - p0.x) / 2.0 - half_gap);
                let mut path = Node::path();
                path.add_class("tuplet-line");
                let p = path.path_mut();
                p.stroke_width = lw;
                p.fill = false;
                p.stroke = true;
                p.stroke_color = style.color;
                p.move_to(p0.x, p0.y + foot);
                p.line_to(p0.x, p0.y);
                if dx > 0.0 {
                    p.line_to(p0.x + dx, p0.y + dx * k);
                }
                p.move_to(p1.x, p1.y + foot);
                p.line_to(p1.x, p1.y);
                if dx > 0.0 {
                    p.line_to(p1.x - dx, p1.y - dx * k);
                }
                items.push(path);
                line_top -= lw / 2.0;
            }
            TupletKind::Arc => {
                let mut st = style.arc.clone().expect("arc 样子要给弧形参数");
                st.gap = Some((cx - half_gap, cx + half_gap));
                let mut arc = slur_tie(ArcKind::Slur, p0, p1, &st, env);
                // 弧里只有路径，取盒不会失败
                update(&mut arc, env).expect("弧的盒");
                arc.add_class("tuplet-arc");
                line_top = arc.y();
                cy = arc.y() + st.thickness / 4.0;
                items.push(arc);
            }
            TupletKind::Number => {}
        }
        let mut txt = music_text(&glyphs, font.clone(), style.color);
        txt.set_x(cx - ink_cx);
        txt.set_y(cy - ink_cy);
        let num_box = ink.offset(txt.x(), txt.y());
        items.push(txt);
        TupletGlyph { items, half_gap, line_top, num_box }
    }
}
