//! 导出（迁移计划 L7）：场景 / 成书 DrawList → PDF（krilla），场景 → PPTX。
//!
//! - [`fonts`]：字体库（定位、解析、整形在 `dolce_engrave::text::fontfile`，这里再导出）与「嵌不了退转曲」的判定
//! - [`pdf`]：PDF 写出核心（画布、字形串、不可见文字层、书签、整份重试）
//! - [`scene`]：场景页 → PDF（编辑器导出那一路）
//! - [`book`]：成书 DrawList → PDF 与书级量字（取代 dev pdfwrite / textmetrics / fontres）
//! - [`probe`]：字体样本验证（.ttc、可变字体、CFF / CFF2、合成粗斜）

#[cfg(feature = "book")]
pub mod book;
pub mod fonts;
pub mod pdf;
pub mod pptx;
pub mod probe;
pub mod scene;
