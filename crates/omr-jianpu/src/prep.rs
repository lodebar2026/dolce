//! JM0 预处理：各页原图 → 一张灰度工作图与二值图、连通块。
//!
//! 多页竖着拼成一张（靠左、白底）；过宽的等比缩到 [`MAX_W`]（面积平均）。二值化用 Sauvola（窗口约短边的 1/30、k = 0.2）：
//! 水印、泛黄的底局部方差小，阈值贴着均值走，不当墨。
use dolce_omr_core::image::{Binary, Rect};
use dolce_omr_core::pixel::ccl::connected_components;
use dolce_omr_core::pixel::preprocess::sauvola_multi;
use dolce_omr_core::ocr::surface::{resize, Gray};
use dolce_omr_core::source::raster::{fix_polarity, SourceImage};

/// 工作图宽上限。
const MAX_W: usize = 2200;
const SAUVOLA_K: f64 = 0.2;
/// 面积不到「字号平方的这么多倍」的墨是孤点（八度点、附点的直径在字号的一成半上下，面积是它的三四倍）。
const SPECK: f64 = 0.006;

/// 一个连通块（墨的 8 邻接块）。`id` = 标号图里的值。
#[derive(Clone, Debug)]
pub struct Comp {
    pub id: i32,
    pub rect: Rect,
    pub area: f64,
    pub cx: f64,
    pub cy: f64,
}

impl Comp {
    /// 墨占外框的比例。
    pub fn fill(&self) -> f64 {
        self.area / (self.rect.w * self.rect.h).max(1.0)
    }
}

/// 一页（整曲拼成的一张）的像素层：灰度、二值、标号图、连通块。
pub struct RasterInk {
    pub gray: Gray,
    pub bin: Binary,
    pub labels: Vec<i32>,
    pub comps: Vec<Comp>,
}

impl RasterInk {
    pub fn load(srcs: &[SourceImage]) -> Option<RasterInk> {
        let w = srcs.iter().map(|s| s.w).max()?;
        let h: usize = srcs.iter().map(|s| s.h).sum();
        let mut gray = Gray::new(w, h, 255);
        let mut y0 = 0;
        for s in srcs {
            for y in 0..s.h {
                gray.data[(y0 + y) * w..(y0 + y) * w + s.w].copy_from_slice(&s.gray[y * s.w..(y + 1) * s.w]);
            }
            y0 += s.h;
        }
        if w > MAX_W {
            let hh = ((h as f64 * MAX_W as f64 / w as f64).round() as usize).max(1);
            gray = resize(&gray, MAX_W, hh);
        }
        let (w, h) = (gray.w, gray.h);
        let win = (((w.min(h) as f64 / 30.0).round() as usize) | 1).max(15);
        let mut data = vec![0u8; w * h];
        sauvola_multi(&gray.data, w, h, win >> 1, &[SAUVOLA_K], &mut data);
        let mut bin = Binary { w, h, data };
        fix_polarity(&mut bin);
        let mut labels = vec![0i32; w * h];
        let flat = connected_components(&bin.data, w, h, 1.0, &mut labels);
        let comps = flat.as_chunks::<8>().0.iter().map(|c| Comp { id: c[0] as i32, rect: Rect::new(c[1], c[2], c[3], c[4]), area: c[5], cx: c[6], cy: c[7] }).collect();
        Some(RasterInk { gray, bin, labels, comps })
    }

    /// 抹孤点：深底、网点上二值化撒出来的碎墨（面积按字号定，至少两个像素才算块）从二值图、标号图、块表里去掉。
    /// 带内切格逐列看墨，一粒孤点就把增时线、小节线的格撑高、把空白隔成格。
    pub fn despeckle(&mut self, num_h: f64) {
        let min = (num_h * num_h * SPECK).max(2.0);
        let mut small = vec![false; self.comps.iter().map(|k| k.id).max().unwrap_or(0) as usize + 1];
        for k in self.comps.iter().filter(|k| k.area < min) {
            small[k.id as usize] = true;
        }
        for (v, l) in self.bin.data.iter_mut().zip(self.labels.iter_mut()) {
            if *l > 0 && small[*l as usize] {
                *v = 0;
                *l = 0;
            }
        }
        self.comps.retain(|k| k.area >= min);
    }
}

/// **简谱路线的证据接口**（计划 §5.5 9g）：判据只问这几样——某点有没有墨、页面宽高、块表（像素页是 8 邻接连通块，矢量页是对象）、
/// 给 OCR 的裁条（像素页从灰度图裁；矢量页只画条里的对象）。数墨、紧框、二值裁格按 `at` 算，两种证据共用。
pub trait JpInk: Sync {
    fn w(&self) -> usize;
    fn h(&self) -> usize;
    fn at(&self, x: i64, y: i64) -> bool;
    fn comps(&self) -> &[Comp];
    /// `(x, y)` 的墨属不属于块 `c`（像素页查标号图；矢量页的块是对象，没有逐像素归属，按外框里有墨算）。
    fn owns(&self, c: &Comp, x: i64, y: i64) -> bool {
        let (fx, fy) = (x as f64 + 0.5, y as f64 + 0.5);
        fx >= c.rect.x && fx < c.rect.right() && fy >= c.rect.y && fy < c.rect.bottom() && self.at(x, y)
    }
    /// 送 OCR 的灰度条（出界部分是白），四周留 `pad` 白。
    fn strip(&self, r: &Rect, pad: i64) -> Gray;

    /// 文字层里中心落在 `r` 里的字（各带墨迹框，按中心 x 排）。只有带文字层的矢量页有；没有文字层、或框里一个字都没有回 None，照旧送 OCR（见 [`crate::read`]）。
    fn text_in(&self, _r: &Rect) -> Option<Vec<(char, Rect)>> {
        None
    }

    /// 一行里 `[xa, xb)` 有没有墨。
    fn row_ink(&self, y: i64, xa: i64, xb: i64) -> bool {
        (xa..xb).any(|x| self.at(x, y))
    }

    /// 框里墨的紧包围盒（没有墨回 None）。
    fn tight(&self, r: &Rect) -> Option<Rect> {
        let (x0, y0, x1, y1) = (r.x.floor() as i64, r.y.floor() as i64, r.right().ceil() as i64, r.bottom().ceil() as i64);
        let (mut a, mut b, mut c, mut d) = (i64::MAX, i64::MAX, i64::MIN, i64::MIN);
        for y in y0..y1 {
            for x in x0..x1 {
                if self.at(x, y) {
                    a = a.min(x);
                    b = b.min(y);
                    c = c.max(x);
                    d = d.max(y);
                }
            }
        }
        (c >= a).then(|| Rect::new(a as f64, b as f64, (c - a + 1) as f64, (d - b + 1) as f64))
    }

    /// 框里的墨像素数。
    fn count(&self, r: &Rect) -> usize {
        let (x0, y0, x1, y1) = (r.x.floor() as i64, r.y.floor() as i64, r.right().ceil() as i64, r.bottom().ceil() as i64);
        (y0..y1).map(|y| (x0..x1).filter(|&x| self.at(x, y)).count()).sum()
    }

    /// 框里的墨画成灰度格（墨黑、底白；不读灰度）。
    fn crop_bin(&self, r: &Rect) -> Gray {
        let (x0, y0) = (r.x.round() as i64, r.y.round() as i64);
        let (w, h) = (r.w.round().max(1.0) as usize, r.h.round().max(1.0) as usize);
        let mut g = Gray::new(w, h, 255);
        for y in 0..h {
            for x in 0..w {
                if self.at(x0 + x as i64, y0 + y as i64) {
                    g.data[y * w + x] = 0;
                }
            }
        }
        g
    }
}

/// 各模块的签名写 `&Ink`：两种证据都行。
pub type Ink = dyn JpInk;

impl JpInk for RasterInk {
    fn w(&self) -> usize {
        self.bin.w
    }
    fn h(&self) -> usize {
        self.bin.h
    }
    #[inline]
    fn at(&self, x: i64, y: i64) -> bool {
        self.bin.ink(x, y)
    }
    fn comps(&self) -> &[Comp] {
        &self.comps
    }
    fn owns(&self, c: &Comp, x: i64, y: i64) -> bool {
        x >= 0 && y >= 0 && (x as usize) < self.bin.w && (y as usize) < self.bin.h && self.labels[y as usize * self.bin.w + x as usize] == c.id
    }
    /// 从灰度图裁一条（出界部分是白），四周留 `pad` 白。
    fn strip(&self, r: &Rect, pad: i64) -> Gray {
        let (x0, y0) = (r.x.floor() as i64 - pad, r.y.floor() as i64 - pad);
        let (w, h) = ((r.w.ceil() as i64 + 2 * pad).max(1) as usize, (r.h.ceil() as i64 + 2 * pad).max(1) as usize);
        let mut g = Gray::new(w, h, 255);
        for y in 0..h as i64 {
            let sy = y0 + y;
            if sy < 0 || sy >= self.gray.h as i64 {
                continue;
            }
            for x in 0..w as i64 {
                let sx = x0 + x;
                if sx >= 0 && sx < self.gray.w as i64 {
                    g.data[y as usize * w + x as usize] = self.gray.data[sy as usize * self.gray.w + sx as usize];
                }
            }
        }
        g
    }
}
