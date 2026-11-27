//! 悦谱 Dolce 的**五线谱 / 混排引擎**：读入建树（[`read`]）→ 横向 / 分系统 / 纵向（[`pass`]）→ 画系统与简谱叠层（[`render`]、[`overlay`]）→ 装页（[`pages`]）。
//!
//! > 内部实现；外部请用排版的对外入口 [`dolce-layout`](https://docs.rs/dolce-layout)（`layout::layout_staff_doc`、`layout::engraved_music_xml`）。
//!
//! ## 数据：arena + id（`model`）
//!
//! TS 的节点类互相用对象引用（父指针、`prev/next`、跨度两端的音……）。这里全部节点放进 [`model::StaffLayout`] 的各张表，
//! 互指一律用下标（`PartId`、`MeasId`、`PmId`、`ChordId`、`NoteId`、`EntryId`、`LyricId`、`HarmId`、`TextId`、`BeamId`、
//! `SysId`、各种跨度的下标……），父指针变成 id 字段。TS 里按对象作键的 `Map` / `WeakMap` 换成按 id 的表或字段。
//! 节点自己就能答的（`note.cy()` 只看 `writtenPitch` 与谱号）写成节点上的方法或 `StaffLayout` 上 `{节点}_{方法}` 的方法
//! （`chord_stem_x(c)`、`measure_get_ent_pos(m, t)`、`sys_ypos(s, stf)`），名字照 TS 方法名蛇形化，读的人对得上。
//!
//! 文档节点（`src`）借用：`StaffLayout<'d>` 持 `&'d Song`（多小节休止并过的那份由调用方先 [`read::prepare_song`] 留住）
//! 与 `&'d Chord` / `&'d Lyric` / `&'d Harmony` / `&'d Direction`……；MusicXML 表层 `Option<&'d Surface>` 按对象的 `oid` 问，
//! `Oid::NONE` 或没有表层 = TS 里查不到身份（克隆出来的新对象）。
//!
//! ## 量字与场景
//!
//! 量字走 `dolce_engrave::text::MeasureCtx`、SMuFL 元数据走 `dolce_engrave::scene::smufl::MetaData`，两样合在 `dolce_engrave::scene::build::Env`。
//! 画出来的是 `dolce_engrave::scene::Node`（子节点次序与 TS 页面树一致，`dolce_engrave` 里已有的画法直接用）。
//! 浮点运算的次序照 TS 写（回放下要逐位一致）；`Math.round` 用 `dolce_model::base::js::round`，`String(n)` 用 `dolce_model::base::js::num_to_string`。

pub mod dump;
pub mod jprow;
pub mod model;
pub mod overlay;
pub mod pages;
pub mod pass;
pub mod prims;
pub mod read;
pub mod render;
