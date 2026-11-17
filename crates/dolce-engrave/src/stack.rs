//! 简谱数字上下那一摞（高音点 / 减时线 / 低音点）的竖向落点（`engrave/stack.ts`）：**墨迹到墨迹等距**，一道空 `gap` 管到底。
//! 纯算术。

/// `stack-gap` 的缺省值（÷ 数字墨迹高）。
pub const STACK_GAP_DEFAULT: f64 = 0.17;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StackStyle {
    /// 相邻两件墨迹之间的空（已乘好 H）
    pub gap: f64,
    pub dot_radius: f64,
    pub beam_width: f64,
}

/// 第 `i` 个高音点（0 = 离数字最近）的圆心 y。
pub fn high_dot_y(ink_top: f64, i: f64, s: &StackStyle) -> f64 {
    ink_top - s.gap - s.dot_radius - i * (2.0 * s.dot_radius + s.gap)
}

/// 第 `level` 层减时线（1 起）的线心 y。
pub fn beam_y(ink_bottom: f64, level: f64, s: &StackStyle) -> f64 {
    ink_bottom + s.gap + s.beam_width / 2.0 + (level - 1.0) * (s.beam_width + s.gap)
}

/// `n` 层减时线最下一层的墨迹底；没有减时线就是数字墨迹底。
pub fn beams_bottom(ink_bottom: f64, n: f64, s: &StackStyle) -> f64 {
    if n > 0.0 {
        ink_bottom + n * (s.gap + s.beam_width)
    } else {
        ink_bottom
    }
}

/// 第 `i` 个低音点的圆心 y，挂在 `beams` 层减时线之下。
pub fn low_dot_y(ink_bottom: f64, beams: f64, i: f64, s: &StackStyle) -> f64 {
    beams_bottom(ink_bottom, beams, s) + s.gap + s.dot_radius + i * (2.0 * s.dot_radius + s.gap)
}

/// `oct` 个高音点之后这一摞的墨迹顶。
pub fn stack_top(ink_top: f64, oct: f64, s: &StackStyle) -> f64 {
    if oct > 0.0 {
        high_dot_y(ink_top, oct - 1.0, s) - s.dot_radius
    } else {
        ink_top
    }
}

/// 减时线 + 低音点之后这一摞的墨迹底。
pub fn stack_bottom(ink_bottom: f64, beams: f64, low_dots: f64, s: &StackStyle) -> f64 {
    if low_dots > 0.0 {
        low_dot_y(ink_bottom, beams, low_dots - 1.0, s) + s.dot_radius
    } else {
        beams_bottom(ink_bottom, beams, s)
    }
}
