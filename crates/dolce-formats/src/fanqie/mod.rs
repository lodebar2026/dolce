//! 文本谱（番茄 / 诗歌本，TS `fanqie/`）：方言表、语法树、读入（解析 → `ScoreDoc`）、写出端的弧线规划。

pub mod ast;
pub mod dialect;
pub mod emit;
pub mod fromfanqie;
pub mod parse;
pub mod plan;
pub mod relayout;
