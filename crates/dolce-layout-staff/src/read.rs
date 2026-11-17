//! 读入建树（照 `layout.ts`）。**接口约定**：
//! 调用方先 `prepare_song`（多小节休止并成一小节，并过的新对象清掉 oid——TS 里展开出来的新对象查不到表层身份），
//! 留住那份歌，再 `layout_staff`。
#![allow(unused_variables)]

use crate::model::StaffLayout;
use crate::pass::Probe;
use dolce_model::doc::Song;
use dolce_model::xmlsurface::Surface;
use dolce_smufl::MetaData;
use dolce_style::staff::MixedOptions;
use dolce_text::MeasureCtx;
use std::borrow::Cow;

pub fn prepare_song(song: &Song) -> Cow<'_, Song> {
    todo!()
}

pub fn layout_staff<'d>(
    song: &'d Song,
    surface: Option<&'d Surface>,
    options: MixedOptions,
    meta: &'d MetaData,
    mc: &'d MeasureCtx<'d>,
    probe: Probe,
) -> StaffLayout<'d> {
    todo!()
}
