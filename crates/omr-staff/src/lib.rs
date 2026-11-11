//! 五线谱路线（含混排）。按模块分目录：
//!
//! - [`prep`]：预处理——按谱表定的成像策略、网点与网纹
//! - [`frame`]：框架结构——谱线与谱表、墨层、系统、小节线（版面分区待做）
//! - [`attrs`]：结构信息——行首谱号 / 调号 / 拍号、行中切换、同系统互证
//! - [`notes`]：音符数据——符头候选、符干与挂头（时值、休止、符杠、临时记号待做）
//! - [`text`]：文本及符号——文字行、分类与归属、页眉
//! - [`spans`]：线性符号——弧、松叶、房子
//! - [`mixed`]：混排简谱互证——简谱行定位与划出、交简谱路线认、逐小节配对纠错
//! - [`page`]：一页的流水线；[`song`]：整曲拼接与结果模型（骨架）
//!
//! 各模块的判据见 web 模块页「识别-Rust」。
pub mod attrs;
pub mod frame;
pub mod mixed;
pub mod notes;
pub mod page;
pub mod prep;
pub mod song;
pub mod spans;
pub mod text;
