//! ABC 家族：123（简谱主格式）、标准 ABC、Muse `.jcx` 的读写（迁自 `src/abcfamily/`）。
//!
//! - [`lex`]：音乐体词法（基类 + 三方言钩子）
//! - [`token`]：词法产物

pub mod lex;
pub mod token;
pub mod u16s;
