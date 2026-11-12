//! 整本的页面来源：位图 PDF（每页取内嵌源图，不重采样）、转曲矢量 PDF（PDFium 整页渲染）、页图文件夹（文件名自然序、按 EXIF 摆正）。
//! 对应 web `omr/booksplit/source.node.ts` 与 `vector.node.ts`。
use dolce_omr_core::pixel::preprocess::to_gray;
use dolce_omr_source::raster::{image_file, page_image};
use dolce_omr_source::{ContentOpts, PageContent, PdfDoc};
use std::cmp::Ordering;
use std::path::{Path, PathBuf};

/// 扫描用的分辨率：与位图歌本的扫描本（300 dpi 上下）同尺度，版面判据、OCR 条的字高都按那个量级标定。
pub const SCAN_DPI: f64 = 300.0;

/// 一页的像素（原分辨率）。
pub struct PageImage {
    pub w: usize,
    pub h: usize,
    /// 灰度，0 黑 255 白。
    pub gray: Vec<u8>,
    /// 彩色页的 RGB（`w * h * 3`）；不是彩色为空。
    pub rgb: Vec<u8>,
}

enum Kind {
    /// 位图 PDF：每页取内嵌源图
    Raster(PdfDoc),
    /// 转曲矢量 PDF：整页渲染
    Vector(PdfDoc),
    Folder(Vec<PathBuf>),
}

pub struct BookSource {
    kind: Kind,
    stem: String,
}

const IMG_EXT: [&str; 7] = ["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff"];

impl BookSource {
    pub fn open(path: &Path) -> Result<BookSource, String> {
        let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        if path.is_dir() {
            let mut files: Vec<PathBuf> = std::fs::read_dir(path)
                .map_err(|e| format!("读 {}：{e}", path.display()))?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    let name = p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
                    !name.starts_with('.') && IMG_EXT.contains(&ext.as_str())
                })
                .collect();
            if files.is_empty() {
                return Err(format!("{} 里没有图片", path.display()));
            }
            files.sort_by(|a, b| natural_cmp(&a.file_name().unwrap().to_string_lossy(), &b.file_name().unwrap().to_string_lossy()));
            return Ok(BookSource { kind: Kind::Folder(files), stem });
        }
        let bytes = std::fs::read(path).map_err(|e| format!("读 {}：{e}", path.display()))?;
        if !bytes.starts_with(b"%PDF") {
            return Err(format!("{} 既不是 PDF 也不是文件夹", path.display()));
        }
        let doc = PdfDoc::open(bytes)?;
        let vector = is_vector_book(&doc)?;
        Ok(BookSource { kind: if vector { Kind::Vector(doc) } else { Kind::Raster(doc) }, stem })
    }

    pub fn count(&self) -> usize {
        match &self.kind {
            Kind::Raster(d) | Kind::Vector(d) => d.page_count(),
            Kind::Folder(f) => f.len(),
        }
    }

    /// 报告里称呼第 i 页用（文件名或「第 n 页」）。
    pub fn name(&self, i: usize) -> String {
        match &self.kind {
            Kind::Folder(f) => f[i].file_name().unwrap().to_string_lossy().into_owned(),
            _ => format!("{} 第{}页", self.stem, i + 1),
        }
    }

    /// 转曲矢量歌本（出 PNG、可逐首识别）。
    pub fn is_vector(&self) -> bool {
        matches!(self.kind, Kind::Vector(_))
    }

    /// 扫描用的页图：位图歌本是源图原分辨率，矢量歌本按 [`SCAN_DPI`] 渲。
    pub fn page(&self, i: usize) -> Result<PageImage, String> {
        match &self.kind {
            Kind::Folder(f) => {
                let bytes = std::fs::read(&f[i]).map_err(|e| format!("读 {}：{e}", f[i].display()))?;
                let s = image_file(&bytes)?;
                Ok(PageImage { w: s.w, h: s.h, gray: s.gray, rgb: s.rgb })
            }
            Kind::Raster(d) => {
                let pc = d.content(i, ContentOpts { images: true, paths: false, text: false, outlines: false })?;
                match page_image(&pc) {
                    // 彩色页的灰度取亮度（取数层的灰度可能换过通道，二值化按 RGB 自己挑）
                    Some(s) => Ok(PageImage { w: s.w, h: s.h, gray: if s.rgb.is_empty() { s.gray } else { to_gray(&s.rgb, s.w, s.h, 3) }, rgb: s.rgb }),
                    // 没有内嵌图的页（夹在扫描本里的空白页、文字页）：按扫描分辨率渲
                    None => self.render(i, SCAN_DPI),
                }
            }
            Kind::Vector(_) => self.render(i, SCAN_DPI),
        }
    }

    /// 整页按 `dpi` 渲（矢量歌本出图用；位图 PDF 没有内嵌图的页也走这里）。只有黑白灰，不留 RGB。
    pub fn render(&self, i: usize, dpi: f64) -> Result<PageImage, String> {
        let (Kind::Raster(d) | Kind::Vector(d)) = &self.kind else { return Err("页图文件夹不能重渲".into()) };
        let r = d.render(i, dpi / 72.0)?;
        Ok(PageImage { w: r.w, h: r.h, gray: to_gray(&r.rgba, r.w, r.h, 4), rgb: Vec::new() })
    }

    /// 矢量歌本一页的对象（逐首识别回原书取对象用）。
    pub fn content(&self, i: usize) -> Result<PageContent, String> {
        let Kind::Vector(d) = &self.kind else { return Err("只有转曲矢量歌本能取对象".into()) };
        d.content(i, ContentOpts::default())
    }
}

/// 取样几页判路：都没有内嵌图、有路径 → 矢量歌本；有文字层的矢量页本期不收（报错）。是位图歌本回 false。
fn is_vector_book(doc: &PdfDoc) -> Result<bool, String> {
    let n = doc.page_count();
    if n == 0 {
        return Err("PDF 没有页".into());
    }
    let mut picks: Vec<usize> = [0.2, 0.5, 0.8].iter().map(|f| ((n as f64 * f).round() as usize).clamp(1, n) - 1).collect();
    picks.dedup();
    let mut text = false;
    for pn in picks {
        let pc = doc.content(pn, ContentOpts { images: true, paths: true, text: true, outlines: false })?;
        if !pc.images.is_empty() || pc.paths.is_empty() {
            return Ok(false);
        }
        if pc.chars.iter().any(|c| !c.generated && !char::from_u32(c.unicode).is_some_and(char::is_whitespace)) {
            text = true;
        }
    }
    if text {
        return Err("这份矢量 PDF 带文字层（字没有转曲），歌本切分暂只收转曲的矢量 PDF 或位图歌本".into());
    }
    Ok(true)
}

/// 文件名自然序：数字段按数值比，其余按字符比（「h2」排在「h10」前）。
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut ia, mut ib) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ia.peek().copied(), ib.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let take = |it: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut s = String::new();
                    while let Some(c) = it.peek().copied().filter(char::is_ascii_digit) {
                        s.push(c);
                        it.next();
                    }
                    s
                };
                let (sa, sb) = (take(&mut ia), take(&mut ib));
                let (ta, tb) = (sa.trim_start_matches('0'), sb.trim_start_matches('0'));
                let o = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb)).then_with(|| sa.len().cmp(&sb.len()));
                if o != Ordering::Equal {
                    return o;
                }
            }
            (Some(x), Some(y)) => {
                if x != y {
                    return x.cmp(&y);
                }
                ia.next();
                ib.next();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::natural_cmp;
    use std::cmp::Ordering;

    #[test]
    fn natural_order() {
        assert_eq!(natural_cmp("h2.jpg", "h10.jpg"), Ordering::Less);
        assert_eq!(natural_cmp("h010.jpg", "h9.jpg"), Ordering::Greater);
        assert_eq!(natural_cmp("a.jpg", "a.jpg"), Ordering::Equal);
    }
}
