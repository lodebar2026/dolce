//! 增时线「-」（`engrave/dash.ts`）：矢量横线，尺寸取数字字体「-」的墨迹（线宽 = 墨迹高、半长 = 墨迹半宽），墨心落在 (cx, cy)。

use dolce_geom::Point;
use dolce_scene::Node;
use dolce_text::Font;

use crate::Env;

#[derive(Clone, Debug, PartialEq)]
pub struct DashStyle {
    /// 数字字体：尺寸按它的「-」墨迹量
    pub font: Font,
    pub color: f64,
}

/// 一条增时线，墨心落在 (cx, cy)。
pub fn sustain_dash(cx: f64, cy: f64, style: &DashStyle, env: &Env) -> Node {
    let b = style.font.char_bound(env.mc, "-");
    let half = (b.right - b.left) / 2.0;
    let mut n = Node::line();
    let l = n.line_mut();
    l.p0 = Point::new(cx - half, cy);
    l.p1 = Point::new(cx + half, cy);
    l.stroke_color = style.color;
    l.stroke_width = b.bottom - b.top;
    n
}
