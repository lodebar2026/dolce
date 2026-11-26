//! **谱面元素的证据**与**回看页面的入口**（像素、矢量两种证据共用；计划 §5.5「设计 1」）。
//!
//! - 每个元素带一份 [`Evidence`]：像素（墨块 / 像素框）、矢量（对象组号）、推断补的（互证、满拍）。
//!   判据问证据的能力（[`EvidenceOps`]：几何准不准、把握多大），不问它是哪一种。
//! - 要回看墨迹的判据走 [`Probe`]：像素页是墨层（三值图），矢量页是对象库按路径几何逐点作答。
//!   两种页交出同样的三种状态（底 / 符号墨 / 只属于谱线的墨），判据一份。
use serde::{Deserialize, Serialize};

/// 页面上一点的三种状态。
pub const BG: u8 = 0;
/// 符号的墨（含压在谱线上的那部分）。
pub const INK: u8 = 1;
/// 只属于谱线的墨（像素页：线带里纵向墨段不比线宽厚的；矢量页：只落在谱线对象上的点）。
pub const LINE: u8 = 2;

/// 回看页面：逐点问是底、符号墨还是谱线。坐标是工作坐标（像素页是像素；矢量页每点 [`crate::sheet::prims::VEC_SCALE`] 单位）。
pub trait Probe: Sync {
    fn width(&self) -> usize;
    fn height(&self) -> usize;
    /// 出界回 [`BG`]。
    fn at(&self, x: i64, y: i64) -> u8;
    /// 几何精确（矢量页）：判据的容差取线宽量级，不取像素糊度。
    fn exact(&self) -> bool {
        false
    }
    /// 松阈值图上这里有墨（扫描件印淡的笔画：给断口作佐证）；没有松图的一律 false。
    fn faint(&self, _x: i64, _y: i64) -> bool {
        false
    }
}

/// 元素的证据。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Evidence {
    /// 像素：墨块 / 像素框（量值留在元素自己的字段里：种子框墨占比、模板分）。
    #[default]
    Ink,
    /// 矢量：对象组号（对象库里拆并好的一组，见 `omr-core::source::vector`）。
    Vector(u32),
    /// 推断补的（互证、满拍），没有墨也没有对象。
    Inferred,
}

/// 证据的共同接口：判据只经它问差别。
pub trait EvidenceOps {
    /// 几何是否精确（矢量 true）：容差取线宽量级还是像素糊度。
    fn exact(&self) -> bool;
    /// 身份的把握（0~1）：矢量字典命中为 1；像素由元素自己的分数定，这里回 None。
    fn confidence(&self) -> Option<f64>;
}

impl EvidenceOps for Evidence {
    fn exact(&self) -> bool {
        matches!(self, Evidence::Vector(_))
    }
    fn confidence(&self) -> Option<f64> {
        match self {
            Evidence::Vector(_) => Some(1.0),
            _ => None,
        }
    }
}

/// 二值图当探针：墨即 [`INK`]（不分谱线）。只看「有没有墨」的判据（系统线、竖段）用它。
impl Probe for crate::image::Binary {
    fn width(&self) -> usize {
        self.w
    }
    fn height(&self) -> usize {
        self.h
    }
    #[inline]
    fn at(&self, x: i64, y: i64) -> u8 {
        if self.ink(x, y) { INK } else { BG }
    }
}
