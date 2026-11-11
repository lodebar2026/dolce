//! 一页的识别：成像 → 框架结构（谱表、墨层、系统、小节线）→ 结构信息（谱号、调号、拍号）→ 音符数据。逐页独立，可并行；
//! 跨页的事（沿用、声部指派、写出）在 [`crate::song`]。
use crate::attrs::{self, DigitReader, RowAttrs};
use crate::frame::bars::{page_barlines, Barline};
use crate::frame::ink::{Blob, InkLayers, VSeg};
use crate::notes::{page_notes, RowNotes};
use crate::frame::systems::{find_systems, System};
use crate::mixed::band::{self, Band};
use crate::mixed::JpRow;
use crate::prep::imaging::image_page;
use dolce_omr_core::image::Binary;
use dolce_omr_sheet::{Staff, Unit};
use dolce_omr_source::raster::SourceImage;

/// 一页的框架结构与各层墨（识别各模块的共同输入）。
pub struct PageFrame {
    pub bin: Binary,
    pub soft: Option<Binary>,
    /// 相对原图的放大倍数。
    pub up: usize,
    pub unit: Unit,
    pub staves: Vec<Staff>,
    pub ink: InkLayers,
    /// 竖段（不短于三格）。
    pub segs: Vec<VSeg>,
    /// 符号墨块与标号图（标号图里的值是块的 `id`；小碎块被筛掉，`id` 不等于下标）。
    pub blobs: Vec<Blob>,
    pub labels: Vec<i32>,
    pub systems: Vec<System>,
    /// 各行谱的小节线（与 `staves` 同序）。
    pub bars: Vec<Vec<Barline>>,
    /// 混排谱的简谱行与各条的读数；带里的墨已从上面各层划出去。
    pub bands: Vec<Band>,
    pub jianpu: Vec<JpRow>,
    /// 简谱行划掉的墨（没有简谱行为 None）。
    pub band_ink: Option<Binary>,
}

/// 一页的识别结果（现到音符数据的实心头）。
pub struct Page {
    pub frame: PageFrame,
    /// 各行谱的谱号 / 调号 / 拍号（与 `staves` 同序）。
    pub attrs: Vec<RowAttrs>,
    /// 各行谱的音符（与 `staves` 同序）。
    pub notes: Vec<RowNotes>,
    /// 文字：各行谱的歌词与记号、页眉。
    pub text: crate::text::PageText,
    /// 线性符号：弧、松叶、房子。
    pub spans: crate::spans::PageSpans,
}

/// 简谱小节线候选的竖段至少这么长（相对线距；与 [`band`] 的下限一致）。
const SHORT_SEG: f64 = 1.2;

/// 框架结构；页上没有谱表回 None。
pub fn frame_page(src: &SourceImage, ocr: Option<&dolce_omr_ocr::cache::CachedOcr>) -> Option<PageFrame> {
    let im = image_page(src);
    let (unit, mut staves) = im.staves?;
    let (mut bin, mut soft, up) = (im.bin, im.soft, im.up);
    crate::frame::staves::align_lefts(&bin, &mut staves);
    let gap = unit.thick.ceil().max(2.0) as usize;
    let layers = |bin: &Binary, soft: Option<&Binary>| {
        let ink = InkLayers::new(bin, &staves, &unit);
        let segs = ink.vsegs((unit.space * 3.0) as usize, gap);
        let (blobs, labels) = ink.blobs(4.0);
        let systems = find_systems(bin, soft, &staves, &unit);
        let bars = page_barlines(&ink, &segs, &staves, &systems, &unit);
        (ink, segs, blobs, labels, systems, bars)
    };
    let mut got = layers(&bin, soft.as_ref());
    // 混排谱：简谱行整块的墨划出去，各层重建（认带要读数字，没有 OCR 就不认）
    let (mut bands, mut jianpu, mut band_ink) = (Vec::new(), Vec::new(), None);
    if let Some(ocr) = ocr {
        let short = got.0.vsegs((unit.space * SHORT_SEG) as usize, gap);
        let cands = band::find(&bin, &short, &staves, &got.5, &unit);
        let systems: Vec<Vec<usize>> = got.4.iter().map(|s| s.staves.clone()).collect();
        (bands, jianpu, band_ink) = crate::mixed::claim(&mut bin, soft.as_mut(), &staves, &systems, cands, ocr);
        if !bands.is_empty() {
            got = layers(&bin, soft.as_ref());
            // 印在大谱表两行之间、量自下面那行谱的简谱行是上面那行谱的旋律（闭合人声谱的女高音）
            for b in bands.iter_mut().filter(|b| b.staff == b.anchor && b.y1 <= 0.0) {
                if got.4.iter().any(|sys| sys.staves.iter().position(|&i| i == b.staff).is_some_and(|n| n > 0)) {
                    jianpu.iter_mut().filter(|r| r.staff == b.staff).for_each(|r| r.staff -= 1);
                    b.staff -= 1;
                }
            }
        }
    }
    let (ink, segs, blobs, labels, systems, bars) = got;
    Some(PageFrame { bin, soft, up, unit, staves, ink, segs, blobs, labels, systems, bars, bands, jianpu, band_ink })
}

/// 识别一页；没有谱表回 None。
pub fn recognize_page(src: &SourceImage, ocr: Option<&dyn DigitReader>) -> Option<Page> {
    let frame = frame_page(src, ocr.and_then(|o| o.cached()))?;
    let attrs = attrs::page_attrs(&frame, ocr);
    let notes = page_notes(&frame, &attrs, ocr);
    let mut notes = notes;
    let text = crate::text::page_text(&frame, src, &notes, ocr);
    // 文字回馈：落在字行里的假符头摘掉
    for h in &text.false_heads {
        let row = &mut notes[h.staff];
        for c in row.chords.iter_mut() {
            c.heads.retain(|x| !(x.x == h.x && x.y == h.y));
        }
        row.chords.retain(|c| !c.heads.is_empty());
    }
    let spans = crate::spans::page_spans(&frame, &attrs, &notes, &text);
    Some(Page { frame, attrs, notes, text, spans })
}
