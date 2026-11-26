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
use dolce_omr_core::sheet::{Staff, Unit};
use dolce_omr_core::source::raster::SourceImage;
use dolce_omr_core::source::PageContent;

/// 一页的**版面**：只读版面的判断（文字分类、同系统互证、线性符号、整曲拼接）吃它，像素页、矢量页同一个形状。
#[derive(Clone, Debug)]
pub struct Layout {
    /// 工作坐标相对源图（像素页：相对原图的放大倍数；矢量页：每点几单位）。写版面摘要、源图框时除掉它。
    pub up: f64,
    pub unit: Unit,
    pub staves: Vec<Staff>,
    pub systems: Vec<System>,
    /// 各行谱的小节线（与 `staves` 同序）。
    pub bars: Vec<Vec<Barline>>,
    /// 混排谱的简谱行与各条的读数；带里的墨已从像素各层划出去。
    pub bands: Vec<Band>,
    pub jianpu: Vec<JpRow>,
    /// 矢量页（框架与音符取自对象库）。
    pub vector: bool,
}

/// 一页的框架结构与各层墨（位图各模块的共同输入）：版面 + 像素层。`f.staves` 之类经 `Deref` 读版面。
pub struct PageFrame {
    pub layout: Layout,
    pub bin: Binary,
    pub soft: Option<Binary>,
    pub ink: InkLayers,
    /// 竖段（不短于三格）。
    pub segs: Vec<VSeg>,
    /// 符号墨块与标号图（标号图里的值是块的 `id`；小碎块被筛掉，`id` 不等于下标）。
    pub blobs: Vec<Blob>,
    pub labels: Vec<i32>,
    /// 简谱行划掉的墨（没有简谱行为 None）。
    pub band_ink: Option<Binary>,
}

impl PageFrame {
    /// 挂干用的墨层（带松阈值图，同尺寸才带）。
    pub fn stem_ink(&self) -> crate::frame::ink::WithSoft<'_> {
        crate::frame::ink::WithSoft { ink: &self.ink, soft: self.soft.as_ref().filter(|s| s.w == self.ink.w && s.h == self.ink.h) }
    }
}

impl std::ops::Deref for PageFrame {
    type Target = Layout;
    fn deref(&self) -> &Layout {
        &self.layout
    }
}

impl std::ops::DerefMut for PageFrame {
    fn deref_mut(&mut self) -> &mut Layout {
        &mut self.layout
    }
}

/// 一页的识别结果（现到音符数据的实心头）。
pub struct Page {
    pub layout: Layout,
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
pub(crate) const SHORT_SEG: f64 = 1.2;

/// 框架结构；页上没有谱表回 None。
pub fn frame_page(src: &SourceImage, ocr: Option<&dolce_omr_core::ocr::cache::CachedOcr>) -> Option<PageFrame> {
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
        let probe = crate::frame::ink::WithSoft { ink: &ink, soft: soft.filter(|s| s.w == ink.w && s.h == ink.h) };
        let bars = page_barlines(&probe, &segs, &staves, &systems, &unit);
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
            crate::mixed::settle_bands(&mut bands, &mut jianpu, &got.4);
        }
    }
    let (ink, segs, blobs, labels, systems, bars) = got;
    let layout = Layout { up: up as f64, unit, staves, systems, bars, bands, jianpu, vector: false };
    Some(PageFrame { layout, bin, soft, ink, segs, blobs, labels, band_ink })
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
    Some(Page { layout: frame.layout, attrs, notes, text, spans })
}

/// 一页的输入：像素层（内嵌的谱面大图 / 图片）与矢量层（路径、文字层），可以同时有（计划 §5.5「设计 3」）。
pub struct PageSource {
    pub raster: Option<SourceImage>,
    /// PDF 页的内容（路径、文字层与字形轮廓）；图片文件没有。
    pub content: Option<PageContent>,
    /// 文字层有不可靠字体时整页渲染的灰度图（每点 `VEC_SCALE` 像素，与矢量页工作坐标对齐），那几段字从它裁条读。
    pub rendered: Option<dolce_omr_core::ocr::surface::Gray>,
}

/// 识别一页：谱表从哪一层找到，框架与音符就以那一层为主——先试像素层，找不到谱表再试矢量层。
pub fn recognize_source(src: &PageSource, ocr: Option<&dyn DigitReader>) -> Option<Page> {
    if let Some(r) = src.raster.as_ref() {
        if let Some(mut p) = recognize_page(r, ocr) {
            // 混合页：谱面是内嵌大图、页眉页脚是文字层（干净合唱谱）。文字层按大图的像素格换进工作坐标，页眉两边合池
            if let Some(pc) = src.content.as_ref().filter(|pc| pc.chars.iter().any(|c| !c.generated)) {
                let scale = p.layout.up * r.w as f64 / r.rect.w.max(1e-9);
                let vp = dolce_omr_core::source::vector::VecPage::build(pc, scale, (r.rect.x, r.rect.y));
                let tiles = dolce_omr_core::source::raster::side_tiles(pc, Some(&r.rect));
                let lines = crate::vector::text::text_lines(&vp, ocr, None, &tiles, &[]);
                let pt = if r.size_known { r.pt_per_px() } else { 1.0 };
                let layer = crate::vector::text::header(&p.layout, &vp, &lines, pt);
                if std::env::var("OMR_VEC_DEBUG").is_ok() {
                    let segs: Vec<String> = lines.iter().flat_map(|l| l.segs.iter().map(|s| s.chars.iter().map(|c| c.ch).collect::<String>())).collect();
                    eprintln!("混合页 行{segs:?} 页眉{:?} 原{:?}", layer.iter().map(|c| &c.text).collect::<Vec<_>>(), p.text.credits.iter().map(|c| (&c.text, c.rect)).collect::<Vec<_>>());
                }
                if !layer.is_empty() {
                    p.text.credits = crate::vector::text::merge_credits(std::mem::take(&mut p.text.credits), layer);
                }
            }
            return Some(p);
        }
    }
    crate::vector::recognize_vector(src.content.as_ref()?, src.rendered.as_ref(), ocr)
}
