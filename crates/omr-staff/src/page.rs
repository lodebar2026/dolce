//! 一页的识别：成像 → 框架结构（谱表、墨层、系统、小节线）→ 结构信息（谱号、调号、拍号）。逐页独立，可并行；
//! 跨页的事（沿用、声部指派、写出）在 [`crate::song`]。
use crate::attrs::{self, DigitReader, RowAttrs};
use crate::frame::bars::{page_barlines, Barline};
use crate::frame::ink::{Blob, InkLayers, VSeg};
use crate::frame::systems::{find_systems, System};
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
}

/// 一页的识别结果（现到结构信息）。
pub struct Page {
    pub frame: PageFrame,
    /// 各行谱的谱号 / 调号 / 拍号（与 `staves` 同序）。
    pub attrs: Vec<RowAttrs>,
}

/// 框架结构；页上没有谱表回 None。
pub fn frame_page(src: &SourceImage) -> Option<PageFrame> {
    let im = image_page(src);
    let (unit, mut staves) = im.staves?;
    crate::frame::staves::align_lefts(&im.bin, &mut staves);
    let ink = InkLayers::new(&im.bin, &staves, &unit);
    let segs = ink.vsegs((unit.space * 3.0) as usize, unit.thick.ceil().max(2.0) as usize);
    let (blobs, labels) = ink.blobs(4.0);
    let systems = find_systems(&im.bin, im.soft.as_ref(), &staves, &unit);
    let bars = page_barlines(&ink, &segs, &staves, &systems, &unit);
    Some(PageFrame { bin: im.bin, soft: im.soft, up: im.up, unit, staves, ink, segs, blobs, labels, systems, bars })
}

/// 识别一页；没有谱表回 None。
pub fn recognize_page(src: &SourceImage, ocr: Option<&dyn DigitReader>) -> Option<Page> {
    let frame = frame_page(src)?;
    let attrs = attrs::page_attrs(&frame, ocr);
    Some(Page { frame, attrs })
}
