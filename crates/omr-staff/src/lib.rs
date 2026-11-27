//! 悦谱 Dolce 的**五线谱识别路线**（含五线谱与简谱混排）。
//!
//! > 内部实现；外部请用识别的对外入口 [`dolce-omr`](https://docs.rs/dolce-omr)。
//!
//! ## 模块
//!
//! - [`prep`]：预处理——按谱表定的成像策略、网点与网纹
//! - [`frame`]：框架结构——谱线与谱表、墨层、系统、小节线
//! - [`attrs`]：结构信息——行首谱号 / 调号 / 拍号、行中切换、同系统互证
//! - [`notes`]：音符数据——符头候选、符干与挂头、休止、符杠符尾、临时记号与附点、连音
//! - [`text`]：文本及符号——文字行、分类与归属、页眉
//! - [`spans`]：线性符号——弧、松叶、房子
//! - [`mixed`]：混排简谱互证——简谱行定位与划出、交简谱路线认、逐小节配对纠错
//! - [`page`] / [`song`] / [`session`]：一页的流水线、整曲拼接与可编辑识别会话
//! - [`vector`]：矢量 PDF 取原语与探针
//!
//! 各模块的判据见仓库 `docs/模块/识别-Rust.md`。
pub mod attrs;
pub mod frame;
pub mod mixed;
pub mod notes;
pub mod page;
pub mod prep;
pub mod session;
pub mod song;
pub mod spans;
pub mod text;
pub mod vector;
