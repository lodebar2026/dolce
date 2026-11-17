//! 换气记号（`engrave/breath.ts`）：细笔画的 V，挂在音符右上角；尺寸都是数字墨迹高 H 的倍数。

use dolce_scene::Node;

const DX: f64 = 0.75;
const WIDTH: f64 = 0.383;
const ARM: f64 = 0.477;
const TIP_ABOVE_BASELINE: f64 = 0.522;

/// 换气 V 的墨迹在横向占到音符墨心右边多远（÷ H）。
pub const BREATH_REACH: f64 = DX + WIDTH / 2.0;

/// 换气记号。`cx` 数字墨心 x、`baseline` 数字基线、`h` 数字墨迹高。
pub fn breath_path(cx: f64, baseline: f64, h: f64, line_width: f64, color: f64) -> Node {
    let mut n = Node::path();
    n.add_class("breath");
    let p = n.path_mut();
    p.stroke = true;
    p.stroke_color = color;
    p.stroke_width = line_width;
    let x = cx + h * DX;
    let w = h * WIDTH;
    let vy = baseline - h * TIP_ABOVE_BASELINE;
    p.move_to(x - w / 2.0, vy - h * ARM);
    p.line_to(x, vy);
    p.line_to(x + w / 2.0, vy - h * ARM);
    n
}
