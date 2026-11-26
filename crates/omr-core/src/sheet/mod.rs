//! 谱面元素层（两条路线共用）。现在有谱表与谱表局部坐标（[`staff`]）、音乐基本量（[`music`]：谱号、调号、拍号、小节线样式）、
//! 五线谱识别结果模型（[`score`]）、简谱识别结果模型（[`jianpu`]）、
//! 满拍验收与候选组合（[`meter`]）、细长笔画的追踪与拼接（[`curves`]：弧、松叶、房子横线共用）；元素库、证据、归属与互斥、空间查询随五线谱路线逐步加。
pub mod curves;
pub mod element;
pub mod jianpu;
pub mod meter;
pub mod music;
pub mod prims;
pub mod result;
pub mod score;
pub mod shapes;
pub mod staff;

pub use element::{Evidence, EvidenceOps, Probe, BG, INK, LINE};
pub use staff::{LineCurve, Staff, Unit};
