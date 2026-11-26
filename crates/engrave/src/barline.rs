//! 小节线（含反复点）的画法（`engrave/barline.ts`）：纯函数，只认坐标与样式。

use dolce_model::base::geom::Point;
use dolce_model::doc::BarStyle;
use crate::scene::Node;

use crate::dot::jp_dot;

/// 一条小节线的样式语义。
#[derive(Clone, Debug, PartialEq, Default)]
pub struct BarlineSpec {
    /// MusicXML 的 bar-style。None = 普通细线
    pub style: Option<BarStyle>,
    /// `:‖`——两点画在左侧
    pub repeat_backward: bool,
    /// `‖:`——两点画在右侧
    pub repeat_forward: bool,
}

/// 小节线的画法参数。
#[derive(Clone, Debug, PartialEq)]
pub struct BarlineStyle {
    /// 上下缘，相对基线（y 向下）
    pub top: f64,
    pub bot: f64,
    pub light: f64,
    pub heavy: f64,
    /// 相邻两条线墨迹之间的空，缺省 = 粗线宽
    pub gap: Option<f64>,
    /// 反复点半径；<=0 或不给 = `light * 1.6`
    pub dot_radius: Option<f64>,
    /// 画不画反复点（缺省 true）
    pub dots: Option<bool>,
    pub color: f64,
}

/// 一条小节线的粗细组合（左→右）。
pub fn barline_widths(spec: &BarlineSpec, final_: bool, light: f64, heavy: f64) -> Vec<f64> {
    let st = spec.style.as_ref();
    let is = |b: BarStyle| st == Some(&b);
    if is(BarStyle::NoStyle) && !spec.repeat_backward && !spec.repeat_forward {
        return Vec::new();
    }
    let mut widths = if spec.repeat_backward && spec.repeat_forward {
        vec![light, heavy, light]
    } else if is(BarStyle::LightHeavy) || (final_ && !spec.repeat_forward) {
        vec![light, heavy]
    } else if is(BarStyle::HeavyLight) || spec.repeat_forward {
        vec![heavy, light]
    } else if is(BarStyle::LightLight) {
        vec![light, light]
    } else if is(BarStyle::HeavyHeavy) {
        vec![heavy, heavy]
    } else if is(BarStyle::Heavy) {
        vec![heavy]
    } else {
        vec![light]
    };
    if spec.repeat_backward && widths.len() == 1 {
        widths = vec![light, heavy];
    }
    widths
}

/// 一条小节线（几条竖线 + 反复点），图元相对自身原点、x 从 0 起。
#[derive(Clone, Debug, PartialEq)]
pub struct BarlineGlyph {
    pub items: Vec<Node>,
    /// 竖线在 `items` 里的下标
    pub lines: Vec<usize>,
    /// 排版占位
    pub width: f64,
    /// 一条普通细线（没有反复点、没有粗线）
    pub is_plain: bool,
}

impl BarlineGlyph {
    pub fn new(spec: &BarlineSpec, final_: bool, style: &BarlineStyle) -> BarlineGlyph {
        let (top, bot, light, heavy, color) = (style.top, style.bot, style.light, style.heavy, style.color);
        let widths = barline_widths(spec, final_, light, heavy);
        let dots = style.dots.unwrap_or(true);
        let dot_r = match style.dot_radius {
            Some(r) if r > 0.0 => r,
            _ => light * 1.6,
        };
        let dot_gap = dot_r * 1.6;
        let dist = style.gap.unwrap_or(heavy);
        let mut xpos = 0.0;
        let mut items = Vec::new();
        let mut lines = Vec::new();
        let add_dots = |cx: f64, items: &mut Vec<Node>| {
            let mid = (top + bot) / 2.0;
            let off = (bot - top) / 6.0;
            for cy in [mid - off, mid + off] {
                items.push(jp_dot(cx, cy, dot_r, color));
            }
        };
        if dots && spec.repeat_backward {
            add_dots(xpos + dot_r, &mut items);
            xpos += dot_r * 2.0 + dot_gap;
        }
        for &w in &widths {
            let mut l = Node::line();
            l.set_x(xpos + w / 2.0);
            let ls = l.line_mut();
            ls.stroke_color = color;
            ls.p0 = Point::new(0.0, top);
            ls.p1 = Point::new(0.0, bot);
            ls.stroke_width = w;
            xpos += w + dist;
            lines.push(items.len());
            items.push(l);
        }
        if dots && spec.repeat_forward {
            xpos += dot_gap - dist;
            add_dots(xpos + dot_r, &mut items);
        }
        let is_plain = widths.len() <= 1 && !spec.repeat_backward && !spec.repeat_forward;
        BarlineGlyph { items, lines, width: xpos, is_plain }
    }

    fn line_x_w(&self, i: usize) -> (f64, f64) {
        let n = &self.items[i];
        (n.x(), n.line_ref().map_or(0.0, |l| l.stroke_width))
    }

    /// 竖线墨迹左缘（建好、未经组归一时的本地坐标）
    pub fn ink_left(&self) -> f64 {
        self.lines.first().map_or(0.0, |&i| {
            let (x, w) = self.line_x_w(i);
            x - w / 2.0
        })
    }
    pub fn ink_right(&self) -> f64 {
        self.lines.last().map_or(0.0, |&i| {
            let (x, w) = self.line_x_w(i);
            x + w / 2.0
        })
    }
}
