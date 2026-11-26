//! 小工具：JS `Math.min(...arr)` / `Math.max(...arr)` 口径（空为 ±Infinity、遇 NaN 为 NaN）、临时记号换形。

use dolce_engrave::accidental::AccidentalKind;
use dolce_model::Accidental;
use dolce_model::view::ast::MusicElement;

/// `Math.min(...xs)`
pub fn min_of(xs: impl IntoIterator<Item = f64>) -> f64 {
    xs.into_iter().fold(f64::INFINITY, dolce_model::base::js::min)
}

/// `Math.max(...xs)`
pub fn max_of(xs: impl IntoIterator<Item = f64>) -> f64 {
    xs.into_iter().fold(f64::NEG_INFINITY, dolce_model::base::js::max)
}

pub use dolce_model::base::js::{max, min};

/// 模型临时记号 → 图元的临时记号
pub fn acc_kind(a: &Accidental) -> AccidentalKind {
    AccidentalKind::parse(a.as_str()).unwrap_or(AccidentalKind::Natural)
}

pub fn is_note(el: &MusicElement) -> bool {
    matches!(el, MusicElement::Note(_))
}

pub fn is_barline(el: &MusicElement) -> bool {
    matches!(el, MusicElement::Barline(_))
}

/// 记号名列表（`el.ornaments.map(o => o.name)` 的一项）
pub fn names1(name: &str) -> [&str; 1] {
    [name]
}
