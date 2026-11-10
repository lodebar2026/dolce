//! 谱面元素层（两条路线共用）。现在只有谱表与谱表局部坐标（[`staff`]）；元素库、证据、归属与互斥、空间查询随五线谱路线逐步加。
pub mod staff;

pub use staff::{LineCurve, Staff, Unit};
