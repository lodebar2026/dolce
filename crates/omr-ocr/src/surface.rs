//! 灰度画面与缩放贴图（送 OCR 的条、格都在这里缩到模型输入大小）。
//! **缩小用面积平均，放大用双线性**（与 web `omrkit/surface.ts::blit` 同一办法）：缩小时朴素双线性只采两个点，细笔画会整根丢失。
use dolce_omr_core::image::{Binary, Rect};

/// 灰度画面，0 黑 255 白。
#[derive(Clone, Debug, PartialEq)]
pub struct Gray {
    pub w: usize,
    pub h: usize,
    pub data: Vec<u8>,
}

impl Gray {
    pub fn new(w: usize, h: usize, fill: u8) -> Self {
        let (w, h) = (w.max(1), h.max(1));
        Gray { w, h, data: vec![fill; w * h] }
    }

    /// 排查用：设了环境变量 `OMR_STRIPS`（目录）就把这条存成 `<y>_<x>.pgm`（`(x, y)` 是条在页内的位置）。
    pub fn dump_strip(&self, x: f64, y: f64) {
        if let Ok(dir) = std::env::var("OMR_STRIPS") {
            let _ = std::fs::write(format!("{dir}/{y:.0}_{x:.0}.pgm"), [format!("P5 {} {} 255\n", self.w, self.h).as_bytes(), &self.data].concat());
        }
    }

    /// 二值图（1 = 墨）→ 白底黑字。
    pub fn from_binary(b: &Binary) -> Self {
        Gray { w: b.w, h: b.h, data: b.data.iter().map(|&v| if v != 0 { 0 } else { 255 }).collect() }
    }

    /// 从二值图裁一块（出界部分是白），四周再垫 `pad` 白。
    pub fn crop_binary(b: &Binary, r: Rect, pad: usize) -> Self {
        let (x0, y0) = (r.x.round() as i64, r.y.round() as i64);
        let (w, h) = (r.w.round().max(1.0) as usize, r.h.round().max(1.0) as usize);
        let mut g = Gray::new(w + 2 * pad, h + 2 * pad, 255);
        for y in 0..h {
            for x in 0..w {
                if b.ink(x0 + x as i64, y0 + y as i64) {
                    g.data[(y + pad) * g.w + x + pad] = 0;
                }
            }
        }
        g
    }
}

/// 一维重采样权重：目标像素 i ← Σ 源像素 `idx` × 权重（越界的源下标夹到边上；
/// 别像 web 那份那样整段平移起点——那样放大、原尺寸时最右一列会取成倒数第二列的值）。
fn taps(dst: usize, s0: f64, span: f64, lim: usize) -> Vec<Vec<(usize, f32)>> {
    let scale = span / dst as f64;
    let clamp = |x: i64| x.clamp(0, lim as i64 - 1) as usize;
    (0..dst)
        .map(|i| {
            if scale > 1.0 {
                let a = s0 + i as f64 * scale;
                let b = a + scale;
                let mut v: Vec<(usize, f32)> = Vec::new();
                let mut x = a.floor() as i64;
                while (x as f64) < b {
                    let w = (b.min(x as f64 + 1.0) - a.max(x as f64)).max(0.0) as f32;
                    if w > 0.0 {
                        v.push((clamp(x), w));
                    }
                    x += 1;
                }
                let sum: f32 = v.iter().map(|p| p.1).sum();
                v.iter_mut().for_each(|p| p.1 /= sum.max(f32::MIN_POSITIVE));
                v
            } else {
                let c = s0 + (i as f64 + 0.5) * scale - 0.5;
                let i0 = c.floor();
                let f = (c - i0) as f32;
                vec![(clamp(i0 as i64), 1.0 - f), (clamp(i0 as i64 + 1), f)]
            }
        })
        .collect()
}

/// 把 `src` 的源矩形缩放画到 `dst` 的目标矩形（分离式两趟，先横后纵；源矩形出界的部分裁掉）。
pub fn blit(dst: &mut Gray, src: &Gray, s: Rect, d: Rect) {
    let (sx, sy) = (s.x.max(0.0), s.y.max(0.0));
    let (sw, sh) = ((src.w as f64 - sx).min(s.w), (src.h as f64 - sy).min(s.h));
    let (dx, dy) = (d.x.round() as i64, d.y.round() as i64);
    let (dw, dh) = (d.w.round().max(1.0) as usize, d.h.round().max(1.0) as usize);
    if sw <= 0.0 || sh <= 0.0 {
        return;
    }
    let tx = taps(dw, sx, sw, src.w);
    let ty = taps(dh, sy, sh, src.h);
    // 第一趟：只横向重采样纵向用得到的那些源行
    let (r0, r1) = ty.iter().flatten().fold((usize::MAX, 0), |(a, b), p| (a.min(p.0), b.max(p.0)));
    let rows = r1 + 1 - r0;
    let mut mid = vec![0f32; dw * rows];
    for y in 0..rows {
        let srow = &src.data[(r0 + y) * src.w..(r0 + y + 1) * src.w];
        for (i, t) in tx.iter().enumerate() {
            mid[y * dw + i] = t.iter().map(|&(x, w)| srow[x] as f32 * w).sum();
        }
    }
    for (j, t) in ty.iter().enumerate() {
        let oy = dy + j as i64;
        if oy < 0 || oy as usize >= dst.h {
            continue;
        }
        for i in 0..dw {
            let ox = dx + i as i64;
            if ox < 0 || ox as usize >= dst.w {
                continue;
            }
            let v: f32 = t.iter().map(|&(y, w)| mid[(y - r0) * dw + i] * w).sum();
            dst.data[oy as usize * dst.w + ox as usize] = (v + 0.5).clamp(0.0, 255.0) as u8;
        }
    }
}

/// 整幅缩放到 `w × h`。
pub fn resize(src: &Gray, w: usize, h: usize) -> Gray {
    let mut out = Gray::new(w, h, 255);
    blit(&mut out, src, Rect::new(0.0, 0.0, src.w as f64, src.h as f64), Rect::new(0.0, 0.0, w as f64, h as f64));
    out
}

/// 单字格：把 `src` 整张等比缩进 64×64 白格的中间 48×48（四周各留 8）。数字格送检都用这个（简谱数字、歌本页码与曲号；
/// 对应 web `paddleocr.ts::cellOf`）。
pub fn fit_cell(src: &Gray) -> Gray {
    let (w, h) = (src.w as f64, src.h as f64);
    let s = (48.0 / w).min(48.0 / h);
    let mut out = Gray::new(64, 64, 255);
    blit(&mut out, src, Rect::new(0.0, 0.0, w, h), Rect::new((64.0 - w * s) / 2.0, (64.0 - h * s) / 2.0, w * s, h * s));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shrink_keeps_thin_stroke() {
        // 30 宽的白条中间一列黑，缩到 10 宽：面积平均下那一列变成灰而不是丢掉
        let mut g = Gray::new(30, 3, 255);
        for y in 0..3 {
            g.data[y * 30 + 15] = 0;
        }
        let r = resize(&g, 10, 1);
        assert!(r.data.iter().any(|&v| v < 200), "{:?}", r.data);
    }

    #[test]
    fn identity_and_upscale() {
        let g = Gray { w: 2, h: 1, data: vec![0, 255] };
        assert_eq!(resize(&g, 2, 1), g);
        let u = resize(&g, 4, 1);
        assert_eq!(u.data.len(), 4);
        assert!(u.data[0] < u.data[3]);
    }
}
