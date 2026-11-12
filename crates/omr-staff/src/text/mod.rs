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
    /// 落在字行里的假符头（M4 4.7：由页识别从音符里摘掉）。
    pub false_heads: Vec<lines::FalseHead>,
}

pub fn page_text(f: &PageFrame, src: &SourceImage, notes: &[RowNotes], ocr: Option<&dyn DigitReader>) -> PageText {
    let Some(ocr) = ocr else { return PageText { rows: (0..f.staves.len()).map(|_| RowText::default()).collect(), ..Default::default() } };
    let (bands, false_heads) = lines::page_bands(f, src, notes, ocr);
    let mut rows = classify::classify(f, &bands);
    let (credits, tempo) = header::page_credits(f, src, ocr);
    // 页眉里的速度记号归首行谱（那行谱上方的带里已认出节拍器的不重复记）
    if let Some(si) = (0..f.staves.len()).min_by(|&a, &b| f.staves[a].ys[0].total_cmp(&f.staves[b].ys[0])) {
        if !rows[si].marks.iter().any(|m| matches!(m.dir, dolce_omr_sheet::score::Dir::Metronome { .. })) {
            rows[si].marks.extend(tempo.into_iter().take(1));
        }
    }
    if std::env::var("OMR_TEXT_DEBUG").is_ok() {
        eprintln!("页眉 {:?}", credits.iter().map(|c| &c.text).collect::<Vec<_>>());
        for b in &bands {
            for l in &b.lines {
                eprintln!("文字带 上{:?} 下{:?} y{:.0}-{:.0} {:?}", b.above, b.below, l.y0, l.y1, l.segs.iter().map(|s| format!("{}@{:.0}", s.text(), s.rect.x)).collect::<Vec<_>>());
            }
        }
    }
    PageText { rows, credits, bands, false_heads }
}
