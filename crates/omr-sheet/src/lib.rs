//! 谱面元素层（两条路线共用）。现在有谱表与谱表局部坐标（[`staff`]）、音乐基本量（[`music`]：谱号、调号、拍号、小节线样式）、
//! 识别结果模型与 MusicXML 写出（[`score`]，骨架）、
//! 满拍验收与候选组合（[`meter`]）；元素库、证据、归属与互斥、空间查询随五线谱路线逐步加。
pub mod meter;
pub mod music;
pub mod score;
pub mod staff;

pub use staff::{LineCurve, Staff, Unit};
