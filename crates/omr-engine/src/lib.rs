//! 识别的统一入口：桌面版（Tauri 命令）、网页版（wasm）、命令行都经这里，不各自拼「文件 → 页面 → 判路 → 识别」。
//!
//! - [`Doc`]：打开 PDF（PDFium）或单张图片（图片直接当一页，不再像 TS 那样先封成 PDF）；页数、页尺寸、整页渲染
//! - [`recognize`]：判路（先按五线谱认，没有一页找到谱表就走简谱）、带进度与取消（[`Hook`]）
//! - [`Recognition`]：五线谱交会话（[`Session`]，改关联表 / 切分 / 钉住都在它上面），简谱交识别结果与识别用的二值图
//! - [`staff_binary`]：五线谱核对视图的底图（坐标与核对 JSON 一致）
use dolce_omr_core::image::Binary;
use dolce_omr_core::pixel::preprocess::otsu;
use dolce_omr_core::progress::Hook;
use dolce_omr_jianpu::result::RecognizedScore;
use dolce_omr_ocr::cache::CachedOcr;
use dolce_omr_ocr::surface::Gray;
use dolce_omr_sheet::prims::VEC_SCALE;
use dolce_omr_source::raster::{image_file, page_image, SourceImage};
use dolce_omr_source::{ContentOpts, PdfDoc, Rendered};
use dolce_omr_staff::page::{recognize_source, Page, PageSource};
use dolce_omr_staff::session::Session;
use serde::{Deserialize, Serialize};

pub use dolce_omr_core::progress::{Step, CANCELLED};

/// 一份打开的文档。
pub struct Doc {
    pdf: Option<PdfDoc>,
    image: Option<SourceImage>,
}

/// 识别哪一路：自动（先试五线谱）/ 指定。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    #[default]
    Auto,
    Staff,
    Jianpu,
}

/// 识别选项。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Opts {
    pub kind: Kind,
    /// 只认这几页（0 起）；空 = 全部
    pub pages: Vec<usize>,
}

pub enum Recognition {
    /// 五线谱（含混排）：`pages` = 各结果页对应文档的第几页（0 起；没找到谱表的页不在里面）
    Staff { session: Session, pages: Vec<usize> },
    /// 简谱：识别结果与识别用的二值图（各页上下拼起，结果坐标在它上面）
    Jianpu { score: RecognizedScore, binary: Binary },
}

impl Doc {
    /// 打开字节：`%PDF` 开头当 PDF，其余当图片。
    pub fn open(bytes: Vec<u8>) -> Result<Doc, String> {
        if bytes.starts_with(b"%PDF") {
            Ok(Doc { pdf: Some(PdfDoc::open(bytes)?), image: None })
        } else {
            Ok(Doc { pdf: None, image: Some(image_file(&bytes)?) })
        }
    }

    pub fn is_pdf(&self) -> bool {
        self.pdf.is_some()
    }

    pub fn page_count(&self) -> usize {
        self.pdf.as_ref().map_or(1, |d| d.page_count())
    }

    /// 页尺寸：PDF 是点，图片是像素。
    pub fn page_size(&self, i: usize) -> Result<(f64, f64), String> {
        match (&self.pdf, &self.image) {
            (Some(d), _) => d.page_size(i),
            (_, Some(im)) => Ok((im.w as f64, im.h as f64)),
            _ => Err("没有页面".into()),
        }
    }

    /// 整页渲染（RGBA）：PDF 每点 `scale` 像素；图片按 `scale` 缩放原图。
    pub fn render(&self, i: usize, scale: f64) -> Result<Rendered, String> {
        if let Some(d) = &self.pdf {
            return d.render(i, scale);
        }
        let im = self.image.as_ref().ok_or("没有页面")?;
        let (w, h) = (((im.w as f64 * scale).round() as usize).max(1), ((im.h as f64 * scale).round() as usize).max(1));
        let mut rgba = vec![255u8; w * h * 4];
        for y in 0..h {
            let sy = (y * im.h / h).min(im.h - 1);
            for x in 0..w {
                let sx = (x * im.w / w).min(im.w - 1);
                let k = sy * im.w + sx;
                let px = &mut rgba[(y * w + x) * 4..(y * w + x) * 4 + 3];
                if im.rgb.len() == im.w * im.h * 3 {
                    px.copy_from_slice(&im.rgb[k * 3..k * 3 + 3]);
                } else {
                    px.fill(im.gray[k]);
                }
            }
        }
        Ok(Rendered { w, h, rgba })
    }

    /// 一页的识别输入（PDF 取内嵌图与矢量内容；文字层有不可靠字体的纯矢量页另渲一张灰度图）。
    pub fn source(&self, i: usize) -> Result<PageSource, String> {
        let Some(doc) = &self.pdf else {
            return Ok(PageSource { raster: self.image.clone(), content: None, rendered: None });
        };
        let pc = doc.content(i, ContentOpts { images: true, paths: true, text: true, outlines: true })?;
        let raster = page_image(&pc);
        let rendered = (raster.is_none() && !dolce_omr_source::vector::unreliable_fonts(&pc).is_empty())
            .then(|| doc.render(i, VEC_SCALE).ok())
            .flatten()
            .map(|r| gray_of(&r));
        Ok(PageSource { raster, content: Some(pc), rendered })
    }

    /// 各页的识别输入（`pages` 空 = 全部；取不出内容的页跳过）。
    pub fn sources(&self, pages: &[usize]) -> Result<Vec<(usize, PageSource)>, String> {
        let all: Vec<usize> = if pages.is_empty() { (0..self.page_count()).collect() } else { pages.to_vec() };
        Ok(all.into_iter().filter_map(|i| Some((i, self.source(i).ok()?))).collect())
    }
}

fn gray_of(r: &Rendered) -> Gray {
    Gray { w: r.w, h: r.h, data: r.rgba.chunks_exact(4).map(|p| ((p[0] as u32 * 299 + p[1] as u32 * 587 + p[2] as u32 * 114) / 1000) as u8).collect() }
}

fn binarize(gray: &[u8], w: usize, h: usize) -> Binary {
    let (t, _) = otsu(gray);
    Binary { w, h, data: gray.iter().map(|&v| (v <= t) as u8).collect() }
}

/// 识别：五线谱各页先认（页级并行），一页谱表都没有（且没指定五线谱）就走简谱。
pub fn recognize(doc: &Doc, ocr: &CachedOcr, opts: &Opts, hook: &Hook) -> Result<Recognition, String> {
    let srcs = doc.sources(&opts.pages)?;
    hook.step(0, srcs.len() + 1, "page")?;
    if opts.kind != Kind::Jianpu {
        let pages = staff_pages(&srcs, ocr, hook)?;
        if !pages.is_empty() || opts.kind == Kind::Staff {
            if pages.is_empty() {
                return Err("没有找到谱表".into());
            }
            hook.step(srcs.len(), srcs.len() + 1, "assemble")?;
            let (idx, pages): (Vec<usize>, Vec<Page>) = pages.into_iter().unzip();
            return Ok(Recognition::Staff { session: Session::new(pages, None), pages: idx });
        }
    }
    jianpu(doc, srcs, ocr, hook)
}

/// 五线谱逐页识别（找不到谱表的页丢掉）；回 (文档页号, 页)。
fn staff_pages(srcs: &[(usize, PageSource)], ocr: &CachedOcr, hook: &Hook) -> Result<Vec<(usize, Page)>, String> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let done = AtomicUsize::new(0);
    let total = srcs.len() + 1;
    let one = |(i, s): &(usize, PageSource)| -> Result<Option<(usize, Page)>, String> {
        if hook.cancelled() {
            return Err(CANCELLED.into());
        }
        let p = recognize_source(s, Some(ocr)).map(|p| (*i, p));
        hook.step(done.fetch_add(1, Ordering::Relaxed) + 1, total, "page")?;
        Ok(p)
    };
    #[cfg(feature = "parallel")]
    let got: Result<Vec<_>, String> = {
        use rayon::prelude::*;
        srcs.par_iter().map(one).collect()
    };
    #[cfg(not(feature = "parallel"))]
    let got: Result<Vec<_>, String> = srcs.iter().map(one).collect();
    Ok(got?.into_iter().flatten().collect())
}

fn jianpu(doc: &Doc, srcs: Vec<(usize, PageSource)>, ocr: &CachedOcr, hook: &Hook) -> Result<Recognition, String> {
    // 没有内嵌图的纯矢量页（转曲简谱）走对象库证据，底图按同一缩放渲出来拼起
    if srcs.iter().all(|s| s.1.raster.is_none()) && srcs.iter().any(|s| s.1.content.is_some()) {
        let idx: Vec<usize> = srcs.iter().filter(|s| s.1.content.is_some()).map(|s| s.0).collect();
        let pcs: Vec<_> = srcs.into_iter().filter_map(|s| s.1.content).collect();
        let score = dolce_omr_jianpu::recognize_vector_hooked(&pcs, ocr, hook)?;
        let width = pcs.iter().map(|p| p.width).fold(0.0, f64::max);
        let pdf = doc.pdf.as_ref().ok_or("没有页面")?;
        let grays = idx.iter().map(|&i| pdf.render(i, dolce_omr_jianpu::vector::PAGE_W / width).map(|r| gray_of(&r))).collect::<Result<Vec<_>, _>>()?;
        return Ok(Recognition::Jianpu { score, binary: stack(&grays) });
    }
    let imgs: Vec<SourceImage> = srcs.into_iter().filter_map(|s| s.1.raster).collect();
    let (score, binary) = dolce_omr_jianpu::recognize_hooked(&imgs, ocr, hook)?;
    Ok(Recognition::Jianpu { score, binary })
}

/// 几页灰度图上下拼起再二值化（矢量简谱的底图）。
fn stack(pages: &[Gray]) -> Binary {
    let w = pages.iter().map(|g| g.w).max().unwrap_or(1);
    let h: usize = pages.iter().map(|g| g.h).sum::<usize>().max(1);
    let mut all = vec![255u8; w * h];
    let mut y0 = 0;
    for g in pages {
        for y in 0..g.h {
            all[(y0 + y) * w..(y0 + y) * w + g.w].copy_from_slice(&g.data[y * g.w..(y + 1) * g.w]);
        }
        y0 += g.h;
    }
    binarize(&all, w, h)
}

/// 五线谱核对视图的底图：位图页是内嵌原图（原分辨率），纯矢量页按矢量工作坐标（每点 `VEC_SCALE` 像素）渲。
pub fn staff_binary(doc: &Doc, page: usize) -> Result<Binary, String> {
    let src = doc.source(page)?;
    if let Some(r) = src.raster {
        return Ok(binarize(&r.gray, r.w, r.h));
    }
    let pdf = doc.pdf.as_ref().ok_or("没有页面")?;
    let g = gray_of(&pdf.render(page, VEC_SCALE)?);
    Ok(binarize(&g.data, g.w, g.h))
}

/// 五线谱会话的当前产物：带识别 id 的 MusicXML 与核对 JSON。
pub fn staff_output(session: &Session) -> (String, String) {
    (session.song().score.to_musicxml(), session.review_json())
}

/// 识别用的二值图打成字节：前 8 字节宽高（小端 u32），其后每像素一字节 0 / 1。
pub fn binary_bytes(b: &Binary) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + b.data.len());
    out.extend_from_slice(&(b.w as u32).to_le_bytes());
    out.extend_from_slice(&(b.h as u32).to_le_bytes());
    out.extend_from_slice(&b.data);
    out
}
