//! 附点的落点（`engrave/augdot.ts`）：圆心与数字墨迹中心等高，离墨迹右缘一道 `stack-gap`。

use dolce_geom::Rect;

/// 第 `i` 个附点的圆心。`digit` 是数字墨迹盒，`gap` 已乘好数字墨迹高。
pub fn aug_dot_center(digit: &Rect, i: f64, r: f64, gap: f64) -> (f64, f64) {
    (digit.right + gap + r + i * (2.0 * r + gap), (digit.top + digit.bottom) / 2.0)
}

/// `n` 个附点伸出数字墨迹右缘多远。
pub fn aug_dots_reach(n: f64, r: f64, gap: f64) -> f64 {
    if n > 0.0 {
        n * (gap + 2.0 * r)
    } else {
        0.0
    }
}
