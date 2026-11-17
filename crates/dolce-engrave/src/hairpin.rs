//! 渐强 / 渐弱（松叶，`engrave/hairpin.ts`）：两条直线；简谱两引擎的几何（`JP_HAIRPIN`）同一份。

use dolce_scene::Node;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HairpinSpec {
    pub x0: f64,
    pub x1: f64,
    /// 中线 y
    pub y: f64,
    /// 左、右两端的半开口
    pub half0: f64,
    pub half1: f64,
    pub line_width: f64,
    pub color: f64,
}

pub fn hairpin_path(h: &HairpinSpec) -> Node {
    let mut n = Node::path();
    let p = n.path_mut();
    p.fill = false;
    p.stroke = true;
    p.stroke_color = h.color;
    p.stroke_width = h.line_width;
    p.move_to(h.x0, h.y + h.half0);
    p.line_to(h.x1, h.y + h.half1);
    p.move_to(h.x0, h.y - h.half0);
    p.line_to(h.x1, h.y - h.half1);
    n
}

/// 简谱松叶的几何（÷ 数字墨迹高 H）。
pub mod jp_hairpin {
    pub const PAD: f64 = 0.3;
    pub const HALF: f64 = 0.35;
    pub const LINE_WIDTH: f64 = 0.07;
    pub const PART: f64 = 0.6;
    pub const CARRY_LEAD: f64 = 0.9;
}

/// 线宽：尺子给了就用它，否则 0.07 H。
pub fn jp_hairpin_line_width(width: f64, ink_height: f64) -> f64 {
    if width > 0.0 {
        width
    } else {
        ink_height * jp_hairpin::LINE_WIDTH
    }
}

/// 左右两端的半开口（按「张开到几成」算，跨行两截接起来是同一个松叶）。`crescendo` 为假即渐弱。
pub fn jp_hairpin_halves(crescendo: bool, ink_height: f64, open_left: bool, open_right: bool) -> (f64, f64) {
    let half = ink_height * jp_hairpin::HALF;
    let p = jp_hairpin::PART;
    let (f0, f1) = if crescendo {
        (if open_left { p } else { 0.0 }, if open_right { p } else { 1.0 })
    } else {
        (if open_left { 1.0 - p } else { 1.0 }, if open_right { 1.0 - p } else { 0.0 })
    };
    (half * f0, half * f1)
}
