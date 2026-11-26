//! 识别结果直出 `ScoreDoc`（模型排版迁 Rust 计划 M6）：
//!
//! - [`jianpu`]：简谱识别结果（`omr-core::sheet::jianpu::RecognizedScore`）→ 简谱形状的模型，123 / 文本谱 / jcx 等写出端直接吃；
//! - [`staff`]：五线谱识别结果（`omr-core::sheet::score::Score`）→ MusicXML 形状的模型 + 识别 id 附件，MusicXML 由唯一写出端
//!   `dolce-model::toxml` 写（带 `id`，编辑器的对照、重建、回放按它认框）；
//! - [`reflyrics`]：参照歌词互证（拿歌本配套歌词改形近字、补漏字，其余只报告）。
pub mod reflyrics;
pub mod jianpu;
pub mod staff;
