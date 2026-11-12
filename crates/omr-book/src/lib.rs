//! 歌本切分：整本分页歌谱（PDF / 页图文件夹）→ 一首一张图。按标题切开一页多首、拼接跨页，去页码，
//! 拼缝处用本首的系统间距，边距照源图；再按书内目录核对缺漏。对应 web `omr/booksplit/`。
//!
//! - [`source`]：取页（位图 PDF 取内嵌源图、转曲矢量 PDF 用 PDFium 渲、页图文件夹）
//! - [`layout`] / [`scan`]：逐页版面带、页码、标题、目录（只留几何与文字）
//! - [`plan`]：歌谱区、目录投票、配号、分段、摆放（纯计算）
//! - [`report`]：文件名与核对报告；[`write`]：按摆放回源图原分辨率裁拼写出；[`recognize`]：转曲矢量歌本逐首取对象
//!
//! 第一遍逐页**并行**扫描；页码要拿「上一页 + 1」从几个候选里挑，扫描时先取最靠下读得出的，扫完按页序顺推，
//! 挑中别的候选的页再重扫（只有几页）。
pub mod layout;
pub mod ocr;
pub mod plan;
pub mod recognize;
pub mod report;
pub mod scan;
pub mod source;
pub mod write;

use dolce_omr_ocr::cache::CachedOcr;
use plan::{assign_numbers, book_margins, build_toc, find_region, layout_song, plan_songs, segment_songs, BookRegion, Layout, Margins, SongPlan, Toc};
use rayon::prelude::*;
use scan::{prepare, scan_page, PageInfo};
use source::BookSource;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};

pub struct BookPlan {
    pub pages: Vec<PageInfo>,
    pub region: BookRegion,
    pub toc: Toc,
    /// 目录读自哪几页（源序号）。
    pub toc_pages: Vec<usize>,
    pub margins: Margins,
    pub songs: Vec<SongPlan>,
    pub layouts: Vec<Layout>,
    /// 歌谱区里第一个标题之前、不属于任何一首的页。
    pub orphans: Vec<usize>,
}

#[derive(Default)]
pub struct PlanOptions<'a> {
    /// 指定目录页（源序号，0 起）；不给则自动认（歌谱区之前、全是字行的页）。
    pub toc_pages: Option<Vec<usize>>,
    pub on_progress: Option<&'a (dyn Fn(usize, usize) + Sync)>,
}

/// 扫一页：取图、二值化、读页脚候选，再按 `footer`（页脚候选下标；None = 取第一个读得出的）建版面认标题。
fn scan_one(src: &BookSource, ocr: &CachedOcr, i: usize, footer: Option<usize>, toc: Option<bool>) -> Result<PageInfo, String> {
    let img = src.page(i)?;
    let p = prepare(&img, ocr);
    let pick = footer.or((!p.footers.is_empty()).then_some(0));
    Ok(scan_page(i, &img, &p, ocr, pick, toc))
}

/// 页码在候选里挑哪个（页码区常有折痕、污点也读得出数，候选里有等于「上一页 + 1」的就取它）。
fn footer_pick(p: &PageInfo) -> Option<usize> {
    p.footer.and_then(|f| p.footer_cands.iter().position(|c| c.bbox == f))
}

pub fn plan_book(src: &BookSource, ocr: &CachedOcr, opts: &PlanOptions) -> Result<BookPlan, String> {
    let n = src.count();
    let forced: Option<BTreeSet<usize>> = opts.toc_pages.as_ref().map(|v| v.iter().copied().collect());
    let toc_flag = |i: usize| forced.as_ref().map(|s| s.contains(&i));
    let done = AtomicUsize::new(0);
    let mut pages: Vec<PageInfo> = (0..n)
        .into_par_iter()
        .map(|i| {
            let r = scan_one(src, ocr, i, None, toc_flag(i));
            if let Some(f) = opts.on_progress {
                f(done.fetch_add(1, Ordering::Relaxed) + 1, n);
            }
            r
        })
        .collect::<Result<_, _>>()?;

    // 按页序顺推页码：候选里有等于「上一页 + 1」的而扫描时取了别的，记下重扫
    let mut redo: Vec<(usize, usize)> = Vec::new();
    let mut last: Option<u32> = None;
    for p in &pages {
        let expect = last.map(|l| l + 1);
        let mut printed = p.printed;
        if let Some(e) = expect {
            if let Some(k) = p.footer_cands.iter().position(|c| c.n == e) {
                if Some(k) != footer_pick(p) {
                    redo.push((p.index, k));
                }
                printed = Some(e);
            }
        }
        last = printed.or(expect);
    }
    let again: Vec<PageInfo> = redo.par_iter().map(|&(i, k)| scan_one(src, ocr, i, Some(k), toc_flag(i))).collect::<Result<_, _>>()?;
    for p in again {
        let i = p.index;
        pages[i] = p;
    }

    let region = find_region(&pages);
    // 目录页成片排：与已认出的目录页相邻、在歌谱区外、没有标题的页也整页 OCR 一遍（三位曲号全以「1」打头时，
    // 笔画细的「1」一行好几个都像小节线，按版面认不出是目录）
    if forced.is_none() {
        let outside = |i: usize| i < region.first || i > region.last;
        let mut grew = true;
        while grew {
            grew = false;
            for i in 0..n {
                let p = &pages[i];
                if !p.toc.is_empty() || !p.titles.is_empty() || !outside(i) {
                    continue;
                }
                let near = (i > 0 && !pages[i - 1].toc.is_empty()) || pages.get(i + 1).is_some_and(|q| !q.toc.is_empty());
                if !near {
                    continue;
                }
                let a = scan_one(src, ocr, i, footer_pick(p), Some(true))?;
                if a.toc.is_empty() {
                    continue;
                }
                pages[i] = a;
                grew = true;
            }
        }
    }
    // 目录只取歌谱区之外的页（区内纯歌词页也可能像目录）
    let toc_pages: Vec<usize> = pages
        .iter()
        .filter(|p| !p.toc.is_empty() && forced.as_ref().map_or(p.index < region.first || p.index > region.last, |s| s.contains(&p.index)))
        .map(|p| p.index)
        .collect();
    let max_page = region.printed(region.last);
    let entries: Vec<_> = toc_pages.iter().flat_map(|&i| pages[i].toc.iter().cloned()).collect();
    let toc = build_toc(&entries, max_page);
    let nums = assign_numbers(&pages, &region, &toc);
    let (segs, orphans) = segment_songs(&pages, &region, &nums);
    let songs = plan_songs(&pages, &segs);
    let margins = book_margins(&pages, &region);
    let layouts = songs.iter().map(|s| layout_song(s, &pages, &margins)).collect();
    Ok(BookPlan { pages, region, toc, toc_pages, margins, songs, layouts, orphans })
}
