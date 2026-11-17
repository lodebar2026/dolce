//! 混排的简谱叠层（照 `jianpuoverlay.ts`）。**接口约定**：`render::draw_sys_staff` 调。
#![allow(unused_variables)]

use crate::model::{MeasId, StaffLayout, SysId};
use dolce_scene::Node;

/// `drawJianpuOverlay(grp, sys, st, m)`：`st` 是系统里第几行谱（`Sys.staves` 的下标）
pub fn draw_jianpu_overlay(grp: &mut Node, score: &StaffLayout, sys: SysId, st: usize, m: MeasId) {
    todo!()
}
