//! 位图识别的**取图**：一页 → 一张摆正的灰度原图 [`SourceImage`]（不重采样）。二值化见 [`Binarizer`]。
//!
//! - PDF 页：取最大那块内嵌图；一页好几块图拼的（Acrobat 裁改过的扫描件，一个系统一块）按各块的页上矩阵拼回一张。
//! - 靠矩阵转正的图（手机竖拍横着存的照片、倒着贴的扫描页）：按矩阵把像素摆成页面方向（翻转与 90° 倍数旋转，最近邻、不插值）。
//! - 图片文件：解码，按 EXIF 方向摆正，一像素算一点（页面尺寸记为不可信）。
//!
//! 按谱表情况调阈值、补淡线、去网这些要先找得到谱线，属于五线谱路线的预处理（它调这里的二值化）。
use crate::model::{ImageKind, PageContent, PageImage};
use dolce_omr_core::image::{Binary, Rect};
use dolce_omr_core::pixel::preprocess::{sauvola_multi, to_gray, upsample};
use std::collections::HashMap;

/// 一页取到的原图。
#[derive(Clone, Debug)]
pub struct SourceImage {
    pub w: usize,
    pub h: usize,
    /// 灰度，0 黑 255 白。
    pub gray: Vec<u8>,
    pub kind: ImageKind,
    /// 图在页面上的位置（点，左上原点、y 向下）。
    pub rect: Rect,
    /// 页面尺寸（点）。
    pub page_w: f64,
    pub page_h: f64,
    /// 页面尺寸可信（图片文件一像素记一点，不可信，写版面时按 A4 宽折算）。
    pub size_known: bool,
}

impl SourceImage {
    /// 像素 → 页面点。
    pub fn pt_per_px(&self) -> f64 {
        self.rect.w / self.w as f64
    }
}

/// 拼图页：最大的一块图占不到页面的这个比例，才看是不是好几块拼的。
const MOSAIC_COVER: f64 = 0.5;
/// 拼图页：其余各块合起来至少有最大那块的这么大。
const MOSAIC_REST: f64 = 0.5;

/// PDF 一页 → 原图；页上没有内嵌图（纯矢量页）为 None。
pub fn page_image(pc: &PageContent) -> Option<SourceImage> {
    let page_area = pc.width * pc.height;
    let tiles: Vec<PageImage> = pc.images.iter().filter_map(upright).collect();
    let area = |t: &PageImage| t.rect.w * t.rect.h;
    let big = tiles.iter().max_by(|a, b| area(a).total_cmp(&area(b)))?;
    let rest: f64 = tiles.iter().map(area).sum::<f64>() - area(big);
    let one = |t: &PageImage| SourceImage { w: t.w, h: t.h, gray: t.gray.clone(), kind: t.kind, rect: t.rect, page_w: pc.width, page_h: pc.height, size_known: true };
    if tiles.len() < 2 || area(big) >= page_area * MOSAIC_COVER || rest < area(big) * MOSAIC_REST {
        return Some(one(big));
    }
    Some(mosaic(&tiles, big, pc.width, pc.height))
}

/// 小图的页上高度不过这么多点（一行字的量级；更高的是插图、谱面）。
const SIDE_TILE_H: f64 = 40.0;

/// 谱面大图以外的小图（已取正、页面坐标）：干净合唱谱页眉、版权行里逐字贴的汉字图就是这种。
/// `big`：谱面那张的页上框（混合页），中心落在它里面的不要。
pub fn side_tiles(pc: &PageContent, big: Option<&Rect>) -> Vec<PageImage> {
    pc.images
        .iter()
        .filter(|t| t.rect.h <= SIDE_TILE_H && t.rect.w > 0.0 && t.rect.h > 0.0)
        .filter(|t| big.is_none_or(|b| !(t.rect.cx() >= b.x && t.rect.cx() <= b.right() && t.rect.cy() >= b.y && t.rect.cy() <= b.bottom())))
        .filter_map(upright)
        .collect()
}

/// 各块按页上位置拼回一张：分辨率取最大那块的，最近邻取样，重叠处取深的。
fn mosaic(tiles: &[PageImage], big: &PageImage, pw: f64, ph: f64) -> SourceImage {
    let s = big.w as f64 / big.rect.w;
    let x0 = tiles.iter().map(|t| t.rect.x).fold(f64::MAX, f64::min);
    let y0 = tiles.iter().map(|t| t.rect.y).fold(f64::MAX, f64::min);
    let x1 = tiles.iter().map(|t| t.rect.right()).fold(f64::MIN, f64::max);
    let y1 = tiles.iter().map(|t| t.rect.bottom()).fold(f64::MIN, f64::max);
    let (w, h) = (((x1 - x0) * s).ceil() as usize, ((y1 - y0) * s).ceil() as usize);
    let mut out = vec![255u8; w * h];
    for t in tiles {
        let xa = ((t.rect.x - x0) * s).floor().max(0.0) as usize;
        let xb = (((t.rect.right() - x0) * s).ceil() as usize).min(w);
        let ya = ((t.rect.y - y0) * s).floor().max(0.0) as usize;
        let yb = (((t.rect.bottom() - y0) * s).ceil() as usize).min(h);
        for y in ya..yb {
            let sy = (((y as f64 + 0.5) / s + y0 - t.rect.y) / t.rect.h * t.h as f64).floor();
            if sy < 0.0 || sy >= t.h as f64 {
                continue;
            }
            for x in xa..xb {
                let sx = (((x as f64 + 0.5) / s + x0 - t.rect.x) / t.rect.w * t.w as f64).floor();
                if sx < 0.0 || sx >= t.w as f64 {
                    continue;
                }
                let v = t.gray[sy as usize * t.w + sx as usize];
                let o = &mut out[y * w + x];
                *o = (*o).min(v);
            }
        }
    }
    let kind = if tiles.iter().any(|t| t.kind == ImageKind::Color) { ImageKind::Color } else if tiles.iter().all(|t| t.kind == ImageKind::Mask) { ImageKind::Mask } else { ImageKind::Gray };
    SourceImage { w, h, gray: out, kind, rect: Rect::new(x0, y0, x1 - x0, y1 - y0), page_w: pw, page_h: ph, size_known: true }
}

/// 轴对齐（含翻转、90° 倍数旋转）的图摆成页面方向：交出的图矩阵是 `[rect.w, 0, 0, rect.h, rect.x, rect.y]`。
/// 带错切、斜放的原样交（不插值）；退化矩阵的不要。
fn upright(im: &PageImage) -> Option<PageImage> {
    let [a, b, c, d, _, _] = im.ctm;
    let eps = 1e-6 * (a.abs() + b.abs() + c.abs() + d.abs());
    let swap = if b.abs() <= eps && c.abs() <= eps {
        false
    } else if a.abs() <= eps && d.abs() <= eps {
        true
    } else {
        return Some(im.clone());
    };
    if (a * d - b * c).abs() <= eps * eps {
        return None;
    }
    if !swap && a > 0.0 && d > 0.0 {
        return Some(im.clone());
    }
    let (w, h) = if swap { (im.h, im.w) } else { (im.w, im.h) };
    let r = im.rect;
    // 页面点 → 图像单位坐标：解 ctm 的逆
    let det = a * d - b * c;
    let inv = |px: f64, py: f64| {
        let (x, y) = (px - im.ctm[4], py - im.ctm[5]);
        ((d * x - c * y) / det, (-b * x + a * y) / det)
    };
    let pick = |src: &[u8], ch: usize| {
        let mut out = vec![0u8; w * h * ch];
        for y in 0..h {
            for x in 0..w {
                let (u, v) = inv(r.x + (x as f64 + 0.5) / w as f64 * r.w, r.y + (y as f64 + 0.5) / h as f64 * r.h);
                let sx = ((u * im.w as f64).floor().max(0.0) as usize).min(im.w - 1);
                let sy = ((v * im.h as f64).floor().max(0.0) as usize).min(im.h - 1);
                let (o, i) = ((y * w + x) * ch, (sy * im.w + sx) * ch);
                out[o..o + ch].copy_from_slice(&src[i..i + ch]);
            }
        }
        out
    };
    Some(PageImage {
        w,
        h,
        gray: pick(&im.gray, 1),
        rgb: if im.rgb.is_empty() { Vec::new() } else { pick(&im.rgb, 3) },
        ctm: [r.w, 0.0, 0.0, r.h, r.x, r.y],
        ..im.clone()
    })
}

/// 图片文件（JPEG / PNG …）→ 原图：按 EXIF 方向摆正，一像素算一点。
pub fn image_file(bytes: &[u8]) -> Result<SourceImage, String> {
    use image::{DynamicImage, ImageDecoder, ImageReader};
    let reader = ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format().map_err(|e| e.to_string())?;
    let mut dec = reader.into_decoder().map_err(|e| e.to_string())?;
    let orient = dec.orientation().map_err(|e| e.to_string())?;
    let mut img = DynamicImage::from_decoder(dec).map_err(|e| e.to_string())?;
    img.apply_orientation(orient);
    let color = img.color().has_color();
    let rgb = img.to_rgb8();
    let (w, h) = (rgb.width() as usize, rgb.height() as usize);
    let gray = if color { ink_gray(rgb.as_raw(), w, h) } else { img.to_luma8().into_raw() };
    Ok(SourceImage { w, h, gray, kind: if color { ImageKind::Color } else { ImageKind::Gray }, rect: Rect::new(0.0, 0.0, w as f64, h as f64), page_w: w as f64, page_h: h as f64, size_known: false })
}

/// 换通道要比亮度的墨底差大出这么多倍（黑墨、灰墨各通道一样，不换）。
const CHANNEL_GAIN: f64 = 1.25;

/// 彩色页 → 灰度。彩色油墨印在同色调的底上（橙字印在浅橙的底纹上）按亮度转，墨与底差得很少，纸纹、底图的起伏盖得过笔画；
/// 这种页取**墨底差最大的那个颜色通道**：墨底差 = 本页该通道的中位（底）减去最暗的百分之二（墨）。
fn ink_gray(px: &[u8], w: usize, h: usize) -> Vec<u8> {
    let luma = to_gray(px, w, h, 3);
    let n = w * h;
    let step = (n / 200_000).max(1);
    let spread = |at: &dyn Fn(usize) -> u8| -> f64 {
        let mut hist = [0usize; 256];
        let mut total = 0usize;
        for i in (0..n).step_by(step) {
            hist[at(i) as usize] += 1;
            total += 1;
        }
        let q = |f: f64| -> f64 {
            let (mut acc, want) = (0usize, (total as f64 * f) as usize);
            for (v, c) in hist.iter().enumerate() {
                acc += c;
                if acc > want {
                    return v as f64;
                }
            }
            255.0
        };
        q(0.5) - q(0.02)
    };
    let base = spread(&|i| luma[i]);
    let best = (0..3).map(|c| (c, spread(&|i| px[i * 3 + c]))).max_by(|a, b| a.1.total_cmp(&b.1)).unwrap();
    if best.1 > base * CHANNEL_GAIN && best.1 > base + 8.0 {
        return (0..n).map(|i| px[i * 3 + best.0]).collect();
    }
    luma
}

/// Sauvola 窗口半径占页宽的比例。
pub const SAUVOLA_WIN: f64 = 1.0 / 40.0;

/// 一页的二值化器：灰度（各放大倍数）只算一次；按几档 `k` 取二值图时共用积分图（`sauvola_multi`）。
/// 1 位的原图（`Mask`）没有灰度可分，按 128 切。交出的二值图 1 = 墨；极性见 [`fix_polarity`]。
pub struct Binarizer<'a> {
    src: &'a SourceImage,
    grays: HashMap<usize, Vec<u8>>,
}

impl<'a> Binarizer<'a> {
    pub fn new(src: &'a SourceImage) -> Self {
        Binarizer { src, grays: HashMap::new() }
    }

    pub fn source(&self) -> &SourceImage {
        self.src
    }

    /// 放大 `up` 倍的灰度（双线性，像素中心对齐）。
    pub fn gray(&mut self, up: usize) -> &[u8] {
        if !self.grays.contains_key(&up) {
            let g = if up == 1 { self.src.gray.clone() } else { upsample(&self.src.gray, self.src.w, self.src.h, up) };
            self.grays.insert(up, g);
        }
        &self.grays[&up]
    }

    /// 按几档阈值各出一张二值图（放大 `up` 倍）；1 位原图忽略 `ks` 与 `up`，只出一张。
    pub fn binarize(&mut self, ks: &[f64], up: usize) -> Vec<Binary> {
        let (w, h) = (self.src.w, self.src.h);
        if self.src.kind == ImageKind::Mask {
            return vec![Binary { w, h, data: self.src.gray.iter().map(|&v| (v < 128) as u8).collect() }];
        }
        let (bw, bh) = (w * up, h * up);
        let r = ((bw as f64 * SAUVOLA_WIN).round() as usize).max(8);
        let g = self.gray(up).to_vec();
        let mut out = vec![0u8; ks.len() * bw * bh];
        sauvola_multi(&g, bw, bh, r, ks, &mut out);
        out.chunks_exact(bw * bh).map(|c| Binary { w: bw, h: bh, data: c.to_vec() }).collect()
    }
}

/// 墨迹占比。
pub fn ink_ratio(b: &Binary) -> f64 {
    b.data.iter().map(|&v| v as usize).sum::<usize>() as f64 / (b.w * b.h).max(1) as f64
}

/// 极性自检：整页乐谱的墨不可能过半（实测约一成），过半就是反的（`/Decode` 翻过、或 1 位灰度置位是白），整幅取反。回是否翻了。
pub fn fix_polarity(b: &mut Binary) -> bool {
    if ink_ratio(b) > 0.5 {
        for v in &mut b.data {
            *v ^= 1;
        }
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn img(w: usize, h: usize, ctm: [f64; 6], rect: Rect) -> PageImage {
        PageImage { w, h, kind: ImageKind::Gray, gray: (0..(w * h) as u8).collect(), rgb: vec![], ctm, rect, bpp: 8, filters: vec![] }
    }

    #[test]
    fn upright_rotations() {
        // 2×3 的图，顺时针转 90° 贴进页面上 3×2 的框：(u,v) → (x = 3 − 3v… ) 用矩阵 [0, 2, -3, 0, 3, 0]
        let im = img(2, 3, [0.0, 2.0, -3.0, 0.0, 3.0, 0.0], Rect::new(0.0, 0.0, 3.0, 2.0));
        let u = upright(&im).unwrap();
        assert_eq!((u.w, u.h), (3, 2));
        // 页面左上角那个像素：页面点 (0.5, 0.5) → u = 0.25, v = 5/6 → 源 (0, 2) = 4
        assert_eq!(u.gray[0], 4);
        // 已正的原样交
        let im = img(2, 2, [2.0, 0.0, 0.0, 2.0, 1.0, 1.0], Rect::new(1.0, 1.0, 2.0, 2.0));
        assert_eq!(upright(&im).unwrap().gray, im.gray);
        // 上下翻
        let im = img(1, 2, [1.0, 0.0, 0.0, -2.0, 0.0, 2.0], Rect::new(0.0, 0.0, 1.0, 2.0));
        assert_eq!(upright(&im).unwrap().gray, vec![1, 0]);
    }

    #[test]
    fn polarity() {
        let mut b = Binary { w: 2, h: 2, data: vec![1, 1, 1, 0] };
        assert!(fix_polarity(&mut b));
        assert_eq!(b.data, vec![0, 0, 0, 1]);
        assert!(!fix_polarity(&mut b));
    }
}
