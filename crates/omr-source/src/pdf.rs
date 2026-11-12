//! PDF 文档：打开、逐页取内容（内嵌图、路径、文字层与字形轮廓）、整页渲染。
//! 所有原生调用都在 [`crate::pdfium::with`] 的锁里；交出去的是 `model` 里的纯数据。
use crate::model::*;
use crate::pdfium::{with, Lib};
use dolce_omr_core::image::Rect;
use pdfium_render::prelude::*;
use std::os::raw::{c_char, c_double, c_float, c_int, c_uint, c_ulong};

/// 打开的 PDF。字节要比文档句柄活得久（PDFium 按引用读），所以存在这里。
pub struct PdfDoc {
    _bytes: Box<[u8]>,
    doc: usize,
    pages: usize,
}

// 句柄只在锁里用
unsafe impl Send for PdfDoc {}
unsafe impl Sync for PdfDoc {}

/// 逐页取什么（字形轮廓与像素都不便宜，只在要用时取）。
#[derive(Clone, Copy, Debug)]
pub struct ContentOpts {
    pub images: bool,
    pub paths: bool,
    pub text: bool,
    pub outlines: bool,
}

impl Default for ContentOpts {
    fn default() -> Self {
        ContentOpts { images: true, paths: true, text: true, outlines: true }
    }
}

/// 整页渲染结果：RGBA，白底。
pub struct Rendered {
    pub w: usize,
    pub h: usize,
    pub rgba: Vec<u8>,
}

impl PdfDoc {
    pub fn open(bytes: Vec<u8>) -> Result<Self, String> {
        let bytes = bytes.into_boxed_slice();
        with(|l| unsafe {
            let doc = l.b.FPDF_LoadMemDocument64(&bytes, None);
            if doc.is_null() {
                return Err(format!("打不开 PDF（错误码 {}）", l.b.FPDF_GetLastError()));
            }
            let pages = l.b.FPDF_GetPageCount(doc).max(0) as usize;
            Ok((doc as usize, pages))
        })?
        .map(|(doc, pages)| PdfDoc { _bytes: bytes, doc, pages })
    }

    pub fn page_count(&self) -> usize {
        self.pages
    }

    /// 页面尺寸（点）。
    pub fn page_size(&self, i: usize) -> Result<(f64, f64), String> {
        self.with_page(i, |l, page| unsafe { (l.b.FPDF_GetPageWidthF(page) as f64, l.b.FPDF_GetPageHeightF(page) as f64) })
    }

    pub fn content(&self, i: usize, o: ContentOpts) -> Result<PageContent, String> {
        self.with_page(i, |l, page| unsafe {
            let (w, h) = (l.b.FPDF_GetPageWidthF(page) as f64, l.b.FPDF_GetPageHeightF(page) as f64);
            let mut pc = PageContent { width: w, height: h, ..Default::default() };
            if o.images || o.paths {
                let n = l.b.FPDFPage_CountObjects(page);
                for k in 0..n {
                    walk(l, page, l.b.FPDFPage_GetObject(page, k), IDENT, h, o, &mut pc);
                }
            }
            if o.text {
                pc.chars = text_chars(l, page, h, o.outlines);
            }
            pc
        })
    }

    /// 整页渲染（`scale` 倍，1 = 每点一像素），透明处按白纸。
    pub fn render(&self, i: usize, scale: f64) -> Result<Rendered, String> {
        self.with_page(i, |l, page| unsafe {
            let w = (l.b.FPDF_GetPageWidthF(page) as f64 * scale).round().max(1.0) as c_int;
            let h = (l.b.FPDF_GetPageHeightF(page) as f64 * scale).round().max(1.0) as c_int;
            let bmp = l.b.FPDFBitmap_Create(w, h, 0);
            if bmp.is_null() {
                return Err(format!("建 {w}×{h} 位图失败"));
            }
            l.b.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xFFFF_FFFF);
            // 1 = FPDF_ANNOT（画注释外观）
            l.b.FPDF_RenderPageBitmap(bmp, page, 0, 0, w, h, 0, 1);
            let out = bitmap_rgba(l, bmp);
            l.b.FPDFBitmap_Destroy(bmp);
            Ok(out)
        })?
    }

    fn with_page<T>(&self, i: usize, f: impl FnOnce(&Lib, FPDF_PAGE) -> T) -> Result<T, String> {
        if i >= self.pages {
            return Err(format!("第 {i} 页超出（共 {} 页）", self.pages));
        }
        with(|l| unsafe {
            let page = l.b.FPDF_LoadPage(self.doc as FPDF_DOCUMENT, i as c_int);
            if page.is_null() {
                return Err(format!("载不进第 {i} 页"));
            }
            let r = f(l, page);
            l.b.FPDF_ClosePage(page);
            Ok(r)
        })?
    }
}

impl Drop for PdfDoc {
    fn drop(&mut self) {
        let _ = with(|l| unsafe { l.b.FPDF_CloseDocument(self.doc as FPDF_DOCUMENT) });
    }
}

// PDFium 头文件里的枚举值（pdfium-render 的 prelude 不导出这些常量）
const PAGEOBJ_PATH: c_int = 2;
const PAGEOBJ_IMAGE: c_int = 3;
const PAGEOBJ_FORM: c_int = 5;
const SEGMENT_LINETO: c_int = 0;
const SEGMENT_BEZIERTO: c_int = 1;
const SEGMENT_MOVETO: c_int = 2;
const BITMAP_GRAY: c_int = 1;
const BITMAP_BGR: c_int = 2;
const BITMAP_BGRX: c_int = 3;

type M = [f64; 6];
const IDENT: M = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// m1 之后再 m2（点先过 m1 再过 m2）。
fn mul(m1: &M, m2: &M) -> M {
    [
        m1[0] * m2[0] + m1[1] * m2[2],
        m1[0] * m2[1] + m1[1] * m2[3],
        m1[2] * m2[0] + m1[3] * m2[2],
        m1[2] * m2[1] + m1[3] * m2[3],
        m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
        m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
    ]
}

fn apply(m: &M, x: f64, y: f64) -> (f64, f64) {
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}

/// PDF 坐标（y 向上）的矩阵 → 页面坐标（y 向下）：再过一道 (x, y) → (x, H − y)。
fn flip(m: &M, h: f64) -> M {
    [m[0], -m[1], m[2], -m[3], m[4], h - m[5]]
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn obj_matrix(l: &Lib, obj: FPDF_PAGEOBJECT) -> M {
    let mut fm = FS_MATRIX { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 0.0, f: 0.0 };
    if l.b.FPDFPageObj_GetMatrix(obj, &mut fm) == 0 {
        return IDENT;
    }
    [fm.a as f64, fm.b as f64, fm.c as f64, fm.d as f64, fm.e as f64, fm.f as f64]
}

/// wasm 下绑定的这一条有毛病，直接调（见 `pdfium_wasm`）。
#[cfg(target_arch = "wasm32")]
unsafe fn obj_matrix(_: &Lib, obj: FPDF_PAGEOBJECT) -> M {
    crate::pdfium_wasm::obj_matrix(obj as usize).map_or(IDENT, |m| m.map(|v| v as f64))
}

/// 第 `i` 个字的框（左、右、下、上）。
#[cfg(not(target_arch = "wasm32"))]
unsafe fn char_box(l: &Lib, tp: FPDF_TEXTPAGE, i: c_int) -> [f64; 4] {
    let (mut x0, mut x1, mut y0, mut y1) = (0 as c_double, 0 as c_double, 0 as c_double, 0 as c_double);
    l.b.FPDFText_GetCharBox(tp, i, &mut x0, &mut x1, &mut y0, &mut y1);
    [x0, x1, y0, y1]
}

/// wasm 下绑定的这一条出参次序错，直接调（见 `pdfium_wasm`）。
#[cfg(target_arch = "wasm32")]
unsafe fn char_box(_: &Lib, tp: FPDF_TEXTPAGE, i: c_int) -> [f64; 4] {
    crate::pdfium_wasm::char_box(tp as usize, i).unwrap_or([0.0; 4])
}

fn bbox_of(pts: impl Iterator<Item = (f64, f64)>) -> Rect {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for (x, y) in pts {
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
    }
    if x0 > x1 { Rect::default() } else { Rect::new(x0, y0, x1 - x0, y1 - y0) }
}

/// 页面对象树：Form 往里走（矩阵累乘），路径与图各收各的。`parent` 是 PDF 坐标里外层 Form 的累计矩阵。
unsafe fn walk(l: &Lib, page: FPDF_PAGE, obj: FPDF_PAGEOBJECT, parent: M, h: f64, o: ContentOpts, pc: &mut PageContent) {
    if obj.is_null() {
        return;
    }
    let m = mul(&obj_matrix(l, obj), &parent);
    match l.b.FPDFPageObj_GetType(obj) {
        PAGEOBJ_PATH if o.paths => pc.paths.push(path_obj(l, obj, &flip(&m, h))),
        PAGEOBJ_IMAGE if o.images => {
            if let Some(im) = image_obj(l, page, obj, &flip(&m, h)) {
                pc.images.push(im);
            }
        }
        PAGEOBJ_FORM => {
            let n = l.b.FPDFFormObj_CountObjects(obj);
            for k in 0..n.max(0) {
                walk(l, page, l.b.FPDFFormObj_GetObject(obj, k as c_ulong), m, h, o, pc);
            }
        }
        _ => {}
    }
}

unsafe fn color(l: &Lib, obj: FPDF_PAGEOBJECT, stroke: bool) -> [u8; 4] {
    let (mut r, mut g, mut b, mut a) = (0 as c_uint, 0 as c_uint, 0 as c_uint, 255 as c_uint);
    if stroke {
        l.b.FPDFPageObj_GetStrokeColor(obj, &mut r, &mut g, &mut b, &mut a);
    } else {
        l.b.FPDFPageObj_GetFillColor(obj, &mut r, &mut g, &mut b, &mut a);
    }
    [r as u8, g as u8, b as u8, a as u8]
}

/// 段的点（局部坐标）→ 页面坐标。PDFium 把一段三次贝塞尔交成连续三个 BEZIERTO 点。
unsafe fn segs_of(l: &Lib, count: c_int, get: impl Fn(c_int) -> FPDF_PATHSEGMENT, m: &M) -> Vec<Seg> {
    let mut out = Vec::with_capacity(count.max(0) as usize);
    let mut bez: Vec<(f64, f64)> = Vec::new();
    for k in 0..count.max(0) {
        let s = get(k);
        if s.is_null() {
            continue;
        }
        let (mut x, mut y) = (0 as c_float, 0 as c_float);
        l.b.FPDFPathSegment_GetPoint(s, &mut x, &mut y);
        let p = apply(m, x as f64, y as f64);
        match l.b.FPDFPathSegment_GetType(s) {
            SEGMENT_MOVETO => out.push(Seg::Move(p.0, p.1)),
            SEGMENT_LINETO => out.push(Seg::Line(p.0, p.1)),
            SEGMENT_BEZIERTO => {
                bez.push(p);
                if bez.len() == 3 {
                    out.push(Seg::Cubic(bez[0].0, bez[0].1, bez[1].0, bez[1].1, bez[2].0, bez[2].1));
                    bez.clear();
                }
            }
            _ => {}
        }
        if l.b.FPDFPathSegment_GetClose(s) != 0 {
            out.push(Seg::Close);
        }
    }
    out
}

fn seg_points(segs: &[Seg]) -> impl Iterator<Item = (f64, f64)> + '_ {
    segs.iter().flat_map(|s| match *s {
        Seg::Move(x, y) | Seg::Line(x, y) => vec![(x, y)],
        Seg::Cubic(a, b, c, d, e, f) => vec![(a, b), (c, d), (e, f)],
        Seg::Close => vec![],
    })
}

unsafe fn path_obj(l: &Lib, obj: FPDF_PAGEOBJECT, m: &M) -> PathObj {
    let segs = segs_of(l, l.b.FPDFPath_CountSegments(obj), |k| l.b.FPDFPath_GetPathSegment(obj, k), m);
    let (mut mode, mut stroke) = (0 as c_int, 0 as FPDF_BOOL);
    l.b.FPDFPath_GetDrawMode(obj, &mut mode, &mut stroke);
    let mut lw = 0 as c_float;
    l.b.FPDFPageObj_GetStrokeWidth(obj, &mut lw);
    let scale = (m[0] * m[3] - m[1] * m[2]).abs().sqrt();
    let bbox = bbox_of(seg_points(&segs));
    PathObj {
        fill: (mode != 0).then(|| color(l, obj, false)),
        stroke: (stroke != 0).then(|| color(l, obj, true)),
        line_width: lw as f64 * scale,
        even_odd: mode == 1,
        dashed: l.b.FPDFPageObj_GetDashCount(obj) > 0,
        bbox,
        segs,
    }
}

unsafe fn image_obj(l: &Lib, page: FPDF_PAGE, obj: FPDF_PAGEOBJECT, m_page: &M) -> Option<PageImage> {
    let mut meta: FPDF_IMAGEOBJ_METADATA = std::mem::zeroed();
    l.b.FPDFImageObj_GetImageMetadata(obj, page, &mut meta);
    let mut filters = Vec::new();
    for k in 0..l.b.FPDFImageObj_GetImageFilterCount(obj).max(0) {
        let mut buf = vec![0u8; 64];
        let n = l.b.FPDFImageObj_GetImageFilter(obj, k, buf.as_mut_ptr() as *mut _, buf.len() as c_ulong) as usize;
        filters.push(String::from_utf8_lossy(&buf[..n.saturating_sub(1).min(buf.len())]).to_string());
    }
    // 原始尺寸、不按页面缩放的位图（已解码；CCITT / JBIG2 / DCT / Flate 由 PDFium 解）
    let bmp = l.b.FPDFImageObj_GetBitmap(obj);
    if bmp.is_null() {
        return None;
    }
    let r = bitmap_rgba(l, bmp);
    let gray_fmt = l.b.FPDFBitmap_GetFormat(bmp) == BITMAP_GRAY;
    l.b.FPDFBitmap_Destroy(bmp);
    let gray = dolce_omr_core::pixel::preprocess::to_gray(&r.rgba, r.w, r.h, 4);
    let kind = if meta.bits_per_pixel == 1 {
        ImageKind::Mask
    } else if gray_fmt {
        ImageKind::Gray
    } else {
        ImageKind::Color
    };
    let rgb = if kind == ImageKind::Color { r.rgba.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect() } else { Vec::new() };
    // 图像空间单位正方形在 PDF 里 (0,0) 是左下；换成 (0,0) 左上、v 向下
    let ctm = [m_page[0], m_page[1], -m_page[2], -m_page[3], m_page[4] + m_page[2], m_page[5] + m_page[3]];
    let rect = bbox_of([(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)].into_iter().map(|(u, v)| apply(&ctm, u, v)));
    Some(PageImage { w: r.w, h: r.h, kind, gray, rgb, ctm, rect, bpp: meta.bits_per_pixel, filters })
}

/// PDFium 位图（灰度 / BGR / BGRx / BGRA）→ RGBA。
unsafe fn bitmap_rgba(l: &Lib, bmp: FPDF_BITMAP) -> Rendered {
    let w = l.b.FPDFBitmap_GetWidth(bmp).max(0) as usize;
    let h = l.b.FPDFBitmap_GetHeight(bmp).max(0) as usize;
    let stride = l.b.FPDFBitmap_GetStride(bmp).max(0) as usize;
    let fmt = l.b.FPDFBitmap_GetFormat(bmp);
    // wasm 下 PDFium 在另一块堆上，只能拷一份过来
    #[cfg(not(target_arch = "wasm32"))]
    let buf = l.b.FPDFBitmap_GetBuffer_as_slice(bmp);
    #[cfg(target_arch = "wasm32")]
    let buf = &l.b.FPDFBitmap_GetBuffer_as_vec(bmp)[..];
    if buf.len() < stride * h {
        return Rendered { w: 0, h: 0, rgba: Vec::new() };
    }
    let mut out = vec![0u8; w * h * 4];
    for y in 0..h {
        let row = &buf[y * stride..];
        for x in 0..w {
            let o = (y * w + x) * 4;
            let px = match fmt {
                BITMAP_GRAY => [row[x], row[x], row[x], 255],
                BITMAP_BGR => [row[x * 3 + 2], row[x * 3 + 1], row[x * 3], 255],
                BITMAP_BGRX => [row[x * 4 + 2], row[x * 4 + 1], row[x * 4], 255],
                _ => [row[x * 4 + 2], row[x * 4 + 1], row[x * 4], row[x * 4 + 3]],
            };
            out[o..o + 4].copy_from_slice(&px);
        }
    }
    Rendered { w, h, rgba: out }
}

unsafe fn font_name(l: &Lib, font: FPDF_FONT) -> String {
    let mut buf = vec![0 as c_char; 256];
    let n = l.b.FPDFFont_GetBaseFontName(font, buf.as_mut_ptr(), buf.len());
    let bytes: Vec<u8> = buf[..n.saturating_sub(1).min(buf.len())].iter().map(|&c| c as u8).collect();
    String::from_utf8_lossy(&bytes).to_string()
}

/// 子集前缀「ABCDEF+」：六个大写字母加加号。
fn strip_subset(name: &str) -> (String, bool) {
    let b = name.as_bytes();
    if b.len() > 7 && b[6] == b'+' && b[..6].iter().all(u8::is_ascii_uppercase) {
        (name[7..].to_string(), true)
    } else {
        (name.to_string(), false)
    }
}

/// 文字层：逐字（PDFium 的文本页，Form 里的字也在内）。
unsafe fn text_chars(l: &Lib, page: FPDF_PAGE, h: f64, outlines: bool) -> Vec<TextChar> {
    let tp = l.b.FPDFText_LoadPage(page);
    if tp.is_null() {
        return Vec::new();
    }
    let n = l.b.FPDFText_CountChars(tp).max(0);
    let mut out = Vec::with_capacity(n as usize);
    let mut names: Vec<(usize, String, bool)> = Vec::new();
    for i in 0..n {
        let unicode = l.b.FPDFText_GetUnicode(tp, i);
        let generated = l.b.FPDFText_IsGenerated(tp, i) == 1;
        let size = l.b.FPDFText_GetFontSize(tp, i);
        let (mut ox, mut oy) = (0 as c_double, 0 as c_double);
        l.b.FPDFText_GetCharOrigin(tp, i, &mut ox, &mut oy);
        let [x0, x1, y0, y1] = char_box(l, tp, i);
        let obj = l.b.FPDFText_GetTextObject(tp, i);
        let (mut font, mut subset, mut size_scaled, mut outline) = (String::new(), false, size, None);
        if !obj.is_null() {
            let f = l.b.FPDFTextObj_GetFont(obj);
            if !f.is_null() {
                let key = f as usize;
                let (name, sub) = match names.iter().find(|x| x.0 == key) {
                    Some(x) => (x.1.clone(), x.2),
                    None => {
                        let (nm, sb) = strip_subset(&font_name(l, f));
                        names.push((key, nm.clone(), sb));
                        (nm, sb)
                    }
                };
                font = name;
                subset = sub;
                let m = obj_matrix(l, obj);
                size_scaled = size * (m[2] * m[2] + m[3] * m[3]).sqrt();
                if outlines && !generated {
                    // 字形空间（基线原点、y 向上、已按字号缩放）→ 乘文字对象矩阵的线性部分 → 平移到原点 → 翻成 y 向下
                    let gp = l.b.FPDFFont_GetGlyphPath(f, unicode, size as c_float);
                    if !gp.is_null() {
                        let lin: M = [m[0], m[1], m[2], m[3], ox, oy];
                        let segs = segs_of(l, l.b.FPDFGlyphPath_CountGlyphSegments(gp), |k| l.b.FPDFGlyphPath_GetGlyphPathSegment(gp, k), &flip(&lin, h));
                        if !segs.is_empty() {
                            outline = Some(segs);
                        }
                    }
                }
            }
        }
        out.push(TextChar {
            unicode,
            font,
            subset,
            size,
            size_scaled,
            origin: (ox, h - oy),
            bbox: Rect::new(x0, h - y1, x1 - x0, y1 - y0),
            generated,
            outline,
        });
    }
    l.b.FPDFText_ClosePage(tp);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matrices() {
        let a: M = [2.0, 0.0, 0.0, 3.0, 10.0, 20.0];
        let b: M = [1.0, 0.0, 0.0, 1.0, 5.0, 0.0];
        let p = apply(&mul(&a, &b), 1.0, 1.0);
        assert_eq!(p, (17.0, 23.0));
        let f = flip(&IDENT, 100.0);
        assert_eq!(apply(&f, 3.0, 10.0), (3.0, 90.0));
        assert_eq!(strip_subset("LNFFGN+Maestro"), ("Maestro".into(), true));
        assert_eq!(strip_subset("Maestro"), ("Maestro".into(), false));
    }
}
