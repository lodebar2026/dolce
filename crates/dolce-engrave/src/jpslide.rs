//! 简谱的上滑音 / 下滑音（`engrave/jpslide.ts`，GB/T 46845—2025 7.6.4.3）：直线短箭头 ↗ / ↘，记在本音右侧偏上。

const GAP: f64 = 0.1;
const WIDTH: f64 = 0.5;
const ARM: f64 = 0.25;

/// 滑音箭头：箭杆 (x0, y0) → 箭尖 (x1, y1)，两臂端点 `arms`；`width` 相对锚点伸出的横宽（含笔画半宽）。
#[derive(Clone, Debug, PartialEq)]
pub struct JpSlideArrow {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub arms: [[f64; 2]; 2],
    pub line_width: f64,
    pub width: f64,
}

/// 锚点：x 为数字墨迹右缘（有附点为最后一个附点的墨迹右缘），y 为数字基线。`up` = 上滑音 ↗。
pub fn jp_slide_arrow(up: bool, h: f64) -> JpSlideArrow {
    let spread = (28.0 * std::f64::consts::PI) / 180.0;
    let line_width = h * 0.07;
    let x0 = h * GAP + line_width / 2.0;
    let x1 = x0 + h * WIDTH;
    let (y0, y1) = if up { (-h * 0.57, -h * 1.41) } else { (-h * 1.24, -h * 0.4) };
    let back = (y0 - y1).atan2(x0 - x1);
    let arm = |s: f64| [x1 + h * ARM * (back + s).cos(), y1 + h * ARM * (back + s).sin()];
    let arms = [arm(-spread), arm(spread)];
    let right = dolce_model::base::js::max(dolce_model::base::js::max(x1, arms[0][0]), arms[1][0]);
    JpSlideArrow { x0, y0, x1, y1, arms, line_width, width: right + line_width / 2.0 }
}

/// 记号名 → 滑音方向：`shy` 上（Some(true)）、`xhy` 下（Some(false)）。
pub fn jp_slide_of(names: &[&str]) -> Option<bool> {
    if names.contains(&"shy") {
        Some(true)
    } else if names.contains(&"xhy") {
        Some(false)
    } else {
        None
    }
}
