//! 写出：按摆放从源图原分辨率裁片、贴到纸色画布上，位图歌本写 JPEG（保留原色）；转曲矢量歌本按 `dpi` 重渲整页再裁，写灰度 PNG。
//! 对应 web `omr/booksplit/write.node.ts`。按首分块并行，每块自己留最近几页的源图。
use crate::book::plan::Layout;
use crate::book::source::{BookSource, PageImage, SCAN_DPI};
use dolce_omr_core::image::Rect;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder};
use rayon::prelude::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

/// 本来源写出的图片扩展名：矢量歌本 png，位图歌本 jpg。
pub fn song_image_ext(src: &BookSource) -> &'static str {
    if src.is_vector() {
        ".png"
    } else {
        ".jpg"
    }
}

/// 只留最近用到的几页源图（一首最多跨几页，按首顺序写出时命中率很高）。
struct PageCache<'a> {
    src: &'a BookSource,
    dpi: Option<f64>,
    pages: Vec<(usize, PageImage)>,
}

const KEEP: usize = 4;

impl PageCache<'_> {
    fn get(&mut self, i: usize) -> Result<&PageImage, String> {
        if let Some(k) = self.pages.iter().position(|p| p.0 == i) {
            let p = self.pages.remove(k);
            self.pages.push(p);
        } else {
            let img = match self.dpi {
                Some(d) => self.src.render(i, d)?,
                None => self.src.page(i)?,
            };
            self.pages.push((i, img));
            if self.pages.len() > KEEP {
                self.pages.remove(0);
            }
        }
        Ok(&self.pages.last().unwrap().1)
    }
}

/// 摆放整体缩放 k 倍（扫描分辨率 → 出图分辨率）。
fn scale_layout(l: &Layout, k: f64) -> Layout {
    if k == 1.0 {
        return l.clone();
    }
    let r = |v: f64| (v * k).round();
    let rect = |q: &Rect| Rect::new(r(q.x), r(q.y), r(q.right()) - r(q.x), r(q.bottom()) - r(q.y));
    Layout {
        width: r(l.width),
        height: r(l.height),
        paper: l.paper,
        parts: l.parts.iter().map(|p| crate::book::plan::Placement { page: p.page, src: rect(&p.src), dx: r(p.dx), dy: r(p.dy) }).collect(),
        erase: l.erase.iter().map(rect).collect(),
    }
}

/// 合成一张：RGB 画布（`color`）或灰度画布。
fn compose(cache: &mut PageCache, l: &Layout, color: bool) -> Result<(usize, usize, Vec<u8>), String> {
    let (cw, ch) = (l.width.round().max(1.0) as i64, l.height.round().max(1.0) as i64);
    let nc = if color { 3 } else { 1 };
    let [pr, pg, pb] = l.paper;
    let mut out: Vec<u8> = if color { (0..cw * ch).flat_map(|_| [pr, pg, pb]).collect() } else { vec![pr; (cw * ch) as usize] };
    for part in &l.parts {
        let img = cache.get(part.page)?;
        let (sx, sy, sw, sh) = (part.src.x.round() as i64, part.src.y.round() as i64, part.src.w.round() as i64, part.src.h.round() as i64);
        let (dx, dy) = (part.dx.round() as i64, part.dy.round() as i64);
        // 裁到画布与源图内
        let x0 = sx.max(sx - dx).max(0);
        let y0 = sy.max(sy - dy).max(0);
        let x1 = (sx + sw).min(img.w as i64).min(cw - dx + sx);
        let y1 = (sy + sh).min(img.h as i64).min(ch - dy + sy);
        if x1 <= x0 || y1 <= y0 {
            continue;
        }
        for y in y0..y1 {
            let ty = (dy + y - sy) as usize;
            for x in x0..x1 {
                let tx = (dx + x - sx) as usize;
                let si = y as usize * img.w + x as usize;
                let o = (ty * cw as usize + tx) * nc;
                if color {
                    if img.rgb.is_empty() {
                        out[o..o + 3].fill(img.gray[si]);
                    } else {
                        out[o..o + 3].copy_from_slice(&img.rgb[si * 3..si * 3 + 3]);
                    }
                } else {
                    out[o] = img.gray[si];
                }
            }
        }
    }
    for e in &l.erase {
        let (x, y) = (e.x.round().max(0.0) as i64, e.y.round().max(0.0) as i64);
        let (x1, y1) = (cw.min(e.right().round() as i64), ch.min(e.bottom().round() as i64));
        for yy in y..y1 {
            for xx in x..x1 {
                let o = (yy * cw + xx) as usize * nc;
                if color {
                    out[o..o + 3].copy_from_slice(&[pr, pg, pb]);
                } else {
                    out[o] = pr;
                }
            }
        }
    }
    Ok((cw as usize, ch as usize, out))
}

pub struct WriteOpts<'a> {
    /// JPEG 质量（位图歌本）。
    pub quality: u8,
    /// 出图分辨率（矢量歌本），缺省 300。
    pub dpi: Option<f64>,
    pub on_progress: Option<&'a (dyn Fn(usize, usize) + Sync)>,
}

/// 按 layouts 逐首写出 `<names[k]>.jpg`（位图歌本，原分辨率）或 `<names[k]>.png`（矢量歌本，按 dpi 重渲）。
pub fn write_songs(src: &BookSource, layouts: &[Layout], names: &[String], out_dir: &Path, o: &WriteOpts) -> Result<Vec<PathBuf>, String> {
    std::fs::create_dir_all(out_dir).map_err(|e| format!("建 {}：{e}", out_dir.display()))?;
    let vector = src.is_vector();
    let dpi = vector.then(|| o.dpi.unwrap_or(300.0));
    let k0 = dpi.map_or(1.0, |d| d / SCAN_DPI);
    let ext = song_image_ext(src);
    let done = AtomicUsize::new(0);
    let idx: Vec<usize> = (0..layouts.len()).collect();
    let chunks: Vec<Vec<PathBuf>> = idx
        .par_chunks(8)
        .map(|chunk| -> Result<Vec<PathBuf>, String> {
            let mut cache = PageCache { src, dpi, pages: Vec::new() };
            let mut out = Vec::new();
            for &k in chunk {
                let l = scale_layout(&layouts[k], k0);
                // 位图歌本：本首用到的页有彩色的就出彩色
                let color = !vector && l.parts.iter().any(|p| cache.get(p.page).is_ok_and(|img| !img.rgb.is_empty()));
                let (w, h, px) = compose(&mut cache, &l, color)?;
                let path = out_dir.join(format!("{}{ext}", names[k]));
                let mut buf = Vec::new();
                if vector {
                    PngEncoder::new_with_quality(&mut buf, CompressionType::Best, FilterType::Adaptive).write_image(&px, w as u32, h as u32, ExtendedColorType::L8).map_err(|e| e.to_string())?;
                } else {
                    JpegEncoder::new_with_quality(&mut buf, o.quality)
                        .write_image(&px, w as u32, h as u32, if color { ExtendedColorType::Rgb8 } else { ExtendedColorType::L8 })
                        .map_err(|e| e.to_string())?;
                }
                std::fs::write(&path, buf).map_err(|e| format!("写 {}：{e}", path.display()))?;
                out.push(path);
                if let Some(f) = o.on_progress {
                    f(done.fetch_add(1, Ordering::Relaxed) + 1, layouts.len());
                }
            }
            Ok(out)
        })
        .collect::<Result<_, _>>()?;
    Ok(chunks.into_iter().flatten().collect())
}
