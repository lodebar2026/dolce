//! 结构信息（M2）：每行谱开头的谱号 → 调号 → 拍号，行中的切换，同系统互证。跨页沿用在 [`crate::song`]。
pub mod agree;
pub mod lead;
pub mod units;

use crate::page::PageFrame;
use dolce_omr_ocr::cache::CachedOcr;
use dolce_omr_ocr::surface::Gray;
use dolce_omr_core::image::Rect;
use dolce_omr_sheet::music::{Clef, Key, Time};
use dolce_omr_sheet::score::Attrs;
use serde::{Deserialize, Serialize};

/// 行中的一处切换。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Change {
    pub x: f64,
    pub attrs: Attrs,
}

/// 一行谱的结构信息。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RowAttrs {
    /// 行首谱号；没认出为 None（整曲拼接时沿用上一行同声部的）。
    pub clef: Option<Clef>,
    pub clef_box: Option<Rect>,
    /// 读数把握大（与沿用值不同时敢改）。
    pub clef_sure: bool,
    /// 行首调号；`None` 是没读出（沿用），`Some(0)` 是确实没印。
    pub key: Option<Key>,
    pub key_sure: bool,
    /// 行首印的拍号。
    pub time: Option<Time>,
    /// 行首区（谱号、调号、拍号）的右缘 x。
    pub lead_end: f64,
    pub changes: Vec<Change>,
}

/// 读一个数字格（拍号的上下两个数字）。回 OCR 读出的字串；读不了回 None。
pub trait DigitReader: Sync {
    fn read_digit(&self, cell: &Gray) -> Option<String>;
}

impl DigitReader for CachedOcr {
    fn read_digit(&self, cell: &Gray) -> Option<String> {
        self.read_cell(cell).ok()
    }
}

/// 一页各行谱的结构信息：逐行读行首区，再同系统互证。
pub fn page_attrs(f: &PageFrame, ocr: Option<&dyn DigitReader>) -> Vec<RowAttrs> {
    let mut rows: Vec<RowAttrs> = f.staves.iter().map(|s| lead::read_lead(f, s, ocr)).collect();
    agree::system_agree(f, &mut rows);
    rows
}
