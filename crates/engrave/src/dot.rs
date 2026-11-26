//! 实心圆：八度点、附点、反复点共用（`engrave/dot.ts`）。

use crate::scene::Node;

/// 实心圆：四段三次贝塞尔的标准正圆近似（k = 0.5523）。
pub fn jp_dot(cx: f64, cy: f64, r: f64, color: f64) -> Node {
    let mut n = Node::path();
    let p = n.path_mut();
    p.fill = true;
    p.stroke = false;
    p.fill_color = color;
    let k = r * 0.5523;
    p.move_to(cx - r, cy);
    p.cubic_to(cx - r, cy - k, cx - k, cy - r, cx, cy - r);
    p.cubic_to(cx + k, cy - r, cx + r, cy - k, cx + r, cy);
    p.cubic_to(cx + r, cy + k, cx + k, cy + r, cx, cy + r);
    p.cubic_to(cx - k, cy + r, cx - r, cy + k, cx - r, cy);
    p.close();
    n
}
