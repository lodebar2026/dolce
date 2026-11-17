//! 横向 / 分系统 / 纵向（照 `layoutpass.ts`）。**接口约定**（分身各自实现，签名不改）：
//! 读入（`read`）用 `bar_glyph_from_style` / `met_note_glyph` / `parse_ending_nums` 与输入类型、末尾调 `finish_mixed_score`；
//! 装页（`pages`）用 `auto_staff_distances`。
#![allow(unused_variables)]

use crate::model::{BarGlyph, PartGroup, StaffLayout};

/// `<print>` 里的 `<system-layout>`（`PrintInput.systemLayout`）
#[derive(Clone, Debug, Default)]
pub struct SystemLayoutInput {
    /// `margins`：None = TS 的 null；内层 left / right 各自可缺
    pub margins: Option<(Option<f64>, Option<f64>)>,
    pub top_system_distance: Option<f64>,
    pub system_distance: Option<f64>,
}

/// `<staff-layout>`：`number` 为 1 基谱表号
#[derive(Clone, Debug, Default)]
pub struct StaffLayoutInput {
    pub number: i64,
    pub staff_distance: Option<f64>,
}

#[derive(Clone, Debug, Default)]
pub struct PrintInput {
    pub new_page: bool,
    pub new_system: bool,
    pub system_layout: Option<SystemLayoutInput>,
    pub staff_layouts: Vec<StaffLayoutInput>,
}

/// `<staff-details>`：`number` 为 1 基谱表号，`print_object` 为属性原文（缺省 None）
#[derive(Clone, Debug, Default)]
pub struct StaffDetailInput {
    pub number: i64,
    pub print_object: Option<String>,
}

/// 一个声部的一个小节里，版面那几步要读的东西
#[derive(Clone, Debug, Default)]
pub struct MeasureLayoutInput {
    pub prints: Vec<PrintInput>,
    pub staff_details: Vec<StaffDetailInput>,
}

/// 声部 → 小节 → 版面输入
pub type LayoutInput = Vec<Vec<MeasureLayoutInput>>;

/// 对拍取中间 dump 的探针（`read` / `systems` 两处）
pub type Probe<'p> = &'p mut dyn FnMut(&str, &StaffLayout);

pub fn bar_glyph_from_style(style: &str) -> Option<BarGlyph> {
    todo!()
}

pub fn met_note_glyph(note_type: &str) -> String {
    todo!()
}

/// TS 回 `Set<number>`（插入序）
pub fn parse_ending_nums(s: &str) -> Vec<i64> {
    todo!()
}

pub fn auto_staff_distances(score: &mut StaffLayout) {
    todo!()
}

pub fn finish_mixed_score(score: &mut StaffLayout, input: &LayoutInput, part_groups: Vec<PartGroup>, probe: Probe) {
    todo!()
}
