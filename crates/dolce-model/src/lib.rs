//! 语义模型 `ScoreDoc` 与围绕它的查询、MusicXML 读写、投影、编辑（迁自 `src/model/`，忠实移植语义）。

pub mod strenum;

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
pub mod marknames;
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
pub mod xmlproject;
pub mod xmlsurface;
pub mod xmlsync;

pub use doc::*;
