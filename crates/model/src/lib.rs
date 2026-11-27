//! 悦谱 Dolce 的**模型与格式层**：语义模型 [`doc::ScoreDoc`] 与围绕它的各格式读写、MusicXML 投影、试听、排版行视图。
//! 没有平台依赖，能编到 `wasm32`。
//!
//! ## 模块
//!
//! - **语义模型与 MusicXML**：[`doc`]（`ScoreDoc` 本体）、[`fromxml`]（MusicXML 读入）、[`toxml`]（唯一 MusicXML 写出端）、
//!   [`xmlsurface`]（表层旁表，往返不丢）、[`xmlproject`] / [`jianpuproject`]（投影）、[`edit`]（编辑）。
//! - **源格式读写**（[`formats`]）：123 / ABC / jcx（[`formats::abc`]）、文本谱（[`formats::fanqie`]）、
//!   `.jpwabc`（[`formats::jpw`]）、jianpu-ly（[`formats::jly`]）、MIDI 读入（[`formats::midi`]），格式能力与输出表（[`formats::capability`]、[`formats::targets`]）。
//! - **试听与时间轴**（[`play`]）：演唱顺序展开、断句、时间轴与标准 MIDI 文件写出（[`play::midi::to_midi`]）。
//! - **排版行视图**（[`view`]）：排版与试听用的行视图、断句、双向定位。
//! - **底层工具**（[`base`]）：数值口径、分数、UTF-16 区间、几何类型。
//! - **简繁转换**：[`hanconv`]，开 `hanconv-dict` 另有 OpenCC 词表引擎（`hanconv_dict`）。
//!
//! ## 示例
//!
//! 读一段 123，写出 MusicXML 与标准 MIDI：
//!
//! ```
//! use dolce_model::formats::abc::parse::parse_123;
//! use dolce_model::play::midi::to_midi;
//! use dolce_model::toxml::{score_doc_to_music_xml, ToXmlOptions};
//! use dolce_model::view::playsong::{play_source_of, PlaySongOptions};
//!
//! let doc = parse_123("T:小星星\nK:C\nM:4/4\n1 1 5 5 | 6 6 5 - |\n");
//! assert_eq!(doc.songs.len(), 1);
//!
//! // 写出 MusicXML
//! let xml = score_doc_to_music_xml(&doc, None, &ToXmlOptions::default()).unwrap();
//! assert!(xml.contains("<score-partwise"));
//!
//! // 按演唱顺序生成标准 MIDI（format 1）
//! let (src, _) = play_source_of(&doc, 0, PlaySongOptions::default()).unwrap().unwrap();
//! let midi = to_midi(&src, None, false);
//! assert!(midi.starts_with(b"MThd"));
//! ```
//!
//! ## 特性
//!
//! - `hanconv-dict`：带 OpenCC 简繁词表引擎（`hanconv_dict` 模块；词表 Apache-2.0）。
//! - `ts`：用 `ts-rs` 派生 TypeScript 类型（`npm run gen:types` 用）。

#![cfg_attr(docsrs, feature(doc_cfg))]

pub mod strenum;

// 并入的底层与格式层（原各自一个 crate）
pub mod base;
pub mod formats;
#[cfg(feature = "hanconv-dict")]
pub mod hanconv_dict;
pub mod play;
pub mod view;

pub mod beatcheck;
pub mod beatgroup;
pub mod breaks;
pub mod deconames;
pub mod directionmarks;
pub mod edit;
pub mod emitutil;
pub mod doc;
pub mod fromxml;
pub mod hanconv;
pub mod harmony;
pub mod helpers;
pub mod innervoice;
pub mod jianpu;
pub mod jianpuproject;
pub mod keyshift;
pub mod layouts;
pub mod marknames;
pub mod melodyonly;
pub mod metakeys;
pub mod multirest;
pub mod pagemeta;
pub mod parts;
pub mod sections;
pub mod staves;
pub mod timeaxis;
pub mod transcribe;
pub mod toxml;
pub mod tuplets;
pub mod xml;
pub mod xmlproject;
pub mod xmlsurface;
pub mod xmlsync;

pub use doc::*;
