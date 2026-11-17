//! 版面态 dump（照 `cli/staffref.ts::staffDump`，键与形两边同一口径）。
#![allow(unused_variables)]

use crate::model::StaffLayout;
use crate::pages::Placed;
use serde_json::Value;

pub fn staff_dump(score: &StaffLayout) -> Value {
    todo!()
}

pub fn placed_json(placed: &[Placed]) -> Value {
    todo!()
}
