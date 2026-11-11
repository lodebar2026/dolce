//! 文本及符号（M4）：文字行（[`lines`]）→ 分类与归属（[`classify`]）；页眉另走文字检测（[`header`]）。
//! 这里只定「是什么、归哪一行谱、在哪个 x」；挂到哪个音在整曲拼接时按 x 定（[`crate::song`]）。
pub mod classify;
pub mod header;
pub mod lines;

use crate::attrs::DigitReader;
use crate::notes::RowNotes;
use crate::page::PageFrame;
use classify::RowText;
use dolce_omr_source::raster::SourceImage;
use dolce_omr_text::header::Credit;

/// 一页的文字。
#[derive(Clone, Debug, Default)]
pub struct PageText {
    /// 各行谱的歌词与记号（与 `staves` 同序）。
    pub rows: Vec<RowText>,
    /// 页眉各条（字号是点）。
    pub credits: Vec<Credit>,
    /// 各条带切出的行（排查与核对用）。
    pub bands: Vec<lines::Band>,
}

pub fn page_text(f: &PageFrame, src: &SourceImage, notes: &[RowNotes], ocr: Option<&dyn DigitReader>) -> PageText {
    let Some(ocr) = ocr else { return PageText { rows: (0..f.staves.len()).map(|_| RowText::default()).collect(), ..Default::default() } };
    let bands = lines::page_bands(f, src, notes, ocr);
    PageText { rows: classify::classify(f, &bands), credits: header::page_credits(f, src, ocr), bands }
}
