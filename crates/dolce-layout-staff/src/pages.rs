//! 混排上方带、分页、画页（照 `staffpages.ts`）。**接口约定**：对拍入口调 `layout_staff_pages`。
#![allow(unused_variables)]

use crate::model::{StaffLayout, SysId};
use dolce_scene::Node;

pub const PAGE_HEIGHT_FALLBACK: f64 = 1870.0;

/// `StaffPages.placed` 的一条
#[derive(Clone, Copy, Debug)]
pub struct Placed {
    pub sys: SysId,
    pub page: usize,
    pub top: f64,
}

/// 回各页根节点与各系统落在哪页、页内 top
pub fn layout_staff_pages(score: &mut StaffLayout, mixed: bool, jianpu_part: usize) -> (Vec<Node>, Vec<Placed>) {
    todo!()
}
