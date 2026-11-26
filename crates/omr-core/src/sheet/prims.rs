//! **原语**（计划 §5.5「设计 5」）：两种证据先化成同一批原语，原语之上的识别判断只写一份。
//!
//! | 原语 | 像素怎么取 | 矢量怎么取 |
//! |---|---|---|
//! | 竖线段 [`VSeg`] | 逐列纵向游程连成段（`omr-staff::frame::ink::InkLayers::vsegs`） | 竖的线对象、窄的填充矩形 |
//! | 横线段 [`HSeg`] | 横向游程 | 横的线对象、扁的填充矩形 |
//!
//! 块（符头、休止、谱号…）与细笔画（弧）各由识别模块按自己的证据取，交出同一种元素。
use serde::{Deserialize, Serialize};

/// 矢量页的工作坐标：每点这么多单位（量级同位图页的像素，下游相对线距的常数不用改）。
pub const VEC_SCALE: f64 = 4.0;

/// 一根竖段：横跨 [x0, x1] 列、纵向 [y0, y1]（含）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VSeg {
    pub x0: usize,
    pub x1: usize,
    pub y0: usize,
    pub y1: usize,
    /// 连了几列（宽）。
    pub cols: usize,
}

impl VSeg {
    pub fn cx(&self) -> f64 {
        (self.x0 + self.x1) as f64 / 2.0
    }
    pub fn len(&self) -> usize {
        self.y1 - self.y0 + 1
    }
    pub fn is_empty(&self) -> bool {
        false
    }
    /// 由精确几何（中线 x、上下端、线宽）落到工作坐标的列与行：至少占一列。
    pub fn from_exact(cx: f64, y0: f64, y1: f64, w: f64) -> Option<VSeg> {
        let half = (w / 2.0).max(0.5);
        let (a, b) = ((cx - half).round().max(0.0) as usize, ((cx + half).round() as i64 - 1).max(0) as usize);
        let b = b.max(a);
        if y1 < 0.0 {
            return None;
        }
        let (ya, yb) = (y0.round().max(0.0) as usize, y1.round().max(0.0) as usize);
        Some(VSeg { x0: a, x1: b, y0: ya.min(yb), y1: yb.max(ya), cols: b - a + 1 })
    }
}

/// 一根横段（精确几何，工作坐标）：中线 y、左右端、线宽。
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct HSeg {
    pub x0: f64,
    pub x1: f64,
    pub y: f64,
    pub w: f64,
    /// 来自哪个对象组（矢量）；像素段为 `u32::MAX`。
    pub obj: u32,
}

impl HSeg {
    pub fn len(&self) -> f64 {
        self.x1 - self.x0
    }
    pub fn is_empty(&self) -> bool {
        self.x1 <= self.x0
    }
}
