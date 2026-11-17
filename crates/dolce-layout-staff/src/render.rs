//! 画一个系统（照 `render.ts`）。**接口约定**：装页（`pages`）用下面三个。
#![allow(unused_variables)]

use crate::model::{EndingId, HarmId, StaffLayout, SysId};
use dolce_scene::Node;

/// `endingPlace` 的结果
#[derive(Clone, Copy, Debug)]
pub struct EndingPlace {
    pub left: f64,
    pub right: f64,
    pub y_pos: Option<f64>,
    pub starts_here: bool,
    pub ends_here: bool,
}

pub fn ending_place(score: &StaffLayout, e: EndingId, sys: SysId, mixed: bool) -> EndingPlace {
    todo!()
}

pub fn harmony_width_of(score: &StaffLayout, h: HarmId) -> f64 {
    todo!()
}

/// TS `drawSystem(container, sys)` 先把 `res` 加进 container 再返回它；这里只返回 `res`，由调用方改完矩阵再挂上（树一样）
pub fn draw_system(score: &StaffLayout, sys: SysId) -> Node {
    todo!()
}
