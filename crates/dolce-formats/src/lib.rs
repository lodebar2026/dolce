//! 各源格式的读写（TS `abcfamily/`、`fanqie/`、`jpword/` … 迁移中，见 dev 计划文档）。
//!
//! - [`jcxcodec`]：Muse `.jcx` 的字节 ↔ 文本（GBK / BIG5 / UTF-8 / UTF-16）
//! - [`abc`]：ABC 家族（123 / ABC / jcx）
//! - [`capability`]：格式能力表与丢失清单
//! - [`fanqie`]：文本谱（迁移中）

pub mod jcxcodec;
pub mod abc;
pub mod capability;
pub mod fanqie;
pub mod jpw;
