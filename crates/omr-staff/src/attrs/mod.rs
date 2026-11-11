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
    /// 同系统里各自读出这个拍号的行数（互证前）。
    pub time_votes: u8,
    /// 行首区（谱号、调号、拍号）的右缘 x。
    pub lead_end: f64,
    pub changes: Vec<Change>,
}

/// 读一个数字格（拍号的上下两个数字）。回 OCR 逐字的候选（每个字按分降序的前若干名）；读不了回 None。
pub trait DigitReader: Sync {
    fn read_digit(&self, cell: &Gray) -> Option<Vec<Vec<String>>>;
    /// 读一条文字：逐字与左右缘（占条宽的比例）。
    fn read_line(&self, _strip: &Gray) -> Option<Vec<dolce_omr_ocr::CharPos>> {
        None
    }
    /// 检测画面里的文本行框（画面坐标）。
    fn detect(&self, _image: &Gray) -> Option<Vec<Rect>> {
        None
    }
}

impl DigitReader for CachedOcr {
    fn read_digit(&self, cell: &Gray) -> Option<Vec<Vec<String>>> {
        Some(self.rank_chars(cell, 40).ok()?.into_iter().map(|c| c.alts).collect())
    }
    fn read_line(&self, strip: &Gray) -> Option<Vec<dolce_omr_ocr::CharPos>> {
        CachedOcr::read_line(self, strip).ok()
    }
    fn detect(&self, image: &Gray) -> Option<Vec<Rect>> {
        CachedOcr::detect(self, image).ok()
    }
}

/// 一页各行谱的结构信息：逐行读行首区，再同系统互证。
pub fn page_attrs(f: &PageFrame, ocr: Option<&dyn DigitReader>) -> Vec<RowAttrs> {
    let mut rows: Vec<RowAttrs> = (0..f.staves.len()).map(|i| lead::read_lead(f, i, ocr)).collect();
    agree::system_agree(f, &mut rows);
    rows
}
