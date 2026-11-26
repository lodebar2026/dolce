//! 减时线按拍成组的**拍位判据**（同 `engrave/beatgroup.ts`）：三引擎与写出端共用一份。
//!
//! 组长（四分音符为 1）：复拍子（分母 8、分子是 3 的倍数）三个八分一组 = 1.5，其余一拍一组；
//! 残节按小节**末尾**对齐（`pickup_offset`）。

/// 一个拍组多长（四分音符为 1）
pub fn beat_group_size(beats: f64, beat_type: f64) -> f64 {
    if beat_type == 8.0 && beats % 3.0 == 0.0 { 1.5 } else { 1.0 }
}

/// 残节该补的拍位偏移（四分音符为 1）；不补返回 0
pub fn pickup_offset(expect: f64, actual: f64, is_last: bool, next_actual: Option<f64>) -> f64 {
    if is_last {
        return 0.0;
    }
    let skip = expect - actual;
    if skip <= 1e-9 {
        return 0.0;
    }
    if let Some(n) = next_actual {
        if (n - skip).abs() < 1e-9 {
            return 0.0;
        }
    }
    skip
}

/// 小节内拍位 `pos`（四分音符为 1）落在第几拍组
pub fn beat_group_index(pos: f64, offset: f64, size: f64) -> f64 {
    ((offset + pos) / size + 1e-9).floor()
}
