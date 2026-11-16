//! 语义模型 `ScoreDoc` 与围绕它的查询、MusicXML 读写、投影、编辑（迁自 `src/model/`，忠实移植语义）。

pub mod strenum;

pub mod deconames;
pub mod doc;
pub mod fromxml;
pub mod harmony;
pub mod helpers;
pub mod jianpu;
pub mod keyshift;
pub mod marknames;
pub mod metakeys;
pub mod multirest;
pub mod toxml;
pub mod tuplets;
pub mod xmlproject;
pub mod xmlsurface;

pub use doc::*;
