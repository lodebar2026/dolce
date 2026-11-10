//! **墨层**：不去线。原图不改，只把谱线上的像素标成「存疑」，各判据在原图上算、存疑像素按需不计。
//!
//! 存疑 = 落在某条谱线的线带里、且这一列的纵向墨段不比线宽厚多少（上下都没连着别的墨）的像素——即只属于谱线的墨。
//! 符号压在线上的部分（符头、符干、谱号穿过谱线的笔画）纵向墨段长，不算存疑，原样是墨。
//! 空心头、全音符内腔里那一截谱线是存疑的：判内腔时它不算墨。
use dolce_omr_core::image::{Binary, Rect};
use dolce_omr_core::pixel::ccl::connected_components;
use dolce_omr_sheet::{Staff, Unit};
use serde::{Deserialize, Serialize};

/// 墨层里一个像素的三种状态。
pub const BG: u8 = 0;
pub const INK: u8 = 1;
pub const LINE: u8 = 2;

/// 一页的墨层。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InkLayers {
    pub w: usize,
    pub h: usize,
    /// 逐像素 `BG` / `INK` / `LINE`。
    pub tri: Vec<u8>,
}

impl InkLayers {
    /// 由二值图与谱表标出存疑像素。`slack`：纵向墨段比该线带厚多出几像素以内仍算只属于谱线（扫描件线边毛糙）。
    pub fn new(bin: &Binary, staves: &[Staff], unit: &Unit) -> Self {
        let (w, h) = (bin.w, bin.h);
        let mut tri = bin.data.clone();
        let slack = (unit.thick * 0.5).ceil().max(1.0);
        for s in staves {
            let lines: &[usize] = if s.one_line { &[2] } else { &[0, 1, 2, 3, 4] };
            let (x0, x1) = (s.left.floor().max(0.0) as usize, (s.right.ceil() as usize).min(w - 1));
            for &k in lines {
                let t = s.thick[k];
                let reach = (t / 2.0 + slack).ceil() as i64;
                let max_run = (t + slack) as i64;
                for x in x0..=x1 {
                    let yc = s.line_y(k, x as f64).round() as i64;
                    // 线带里的每一段纵向墨：整段落在 [yc − reach, yc + reach] 内且不厚过 max_run 的，标存疑
                    let mut y = yc - reach;
                    while y <= yc + reach {
                        if !bin.ink(x as i64, y) {
                            y += 1;
                            continue;
                        }
                        let (mut a, mut b) = (y, y);
                        while bin.ink(x as i64, a - 1) {
                            a -= 1;
                        }
                        while bin.ink(x as i64, b + 1) {
                            b += 1;
                        }
                        if b - a + 1 <= max_run && a >= yc - reach && b <= yc + reach {
                            for yy in a..=b {
                                tri[yy as usize * w + x] = LINE;
                            }
                        }
                        y = b + 1;
                    }
                }
            }
        }
        InkLayers { w, h, tri }
    }

    #[inline]
    pub fn at(&self, x: i64, y: i64) -> u8 {
        if x < 0 || y < 0 || x as usize >= self.w || y as usize >= self.h {
            BG
        } else {
            self.tri[y as usize * self.w + x as usize]
        }
    }

    /// 符号的墨（存疑像素当底）：取墨块、量符号形状用。
    pub fn symbol_ink(&self) -> Binary {
        Binary { w: self.w, h: self.h, data: self.tri.iter().map(|&v| (v == INK) as u8).collect() }
    }

    /// 墨块：符号的墨按 8 邻接连通。穿过谱线的笔画在线上那几行纵向墨段长、不是存疑，块照样连着。
    pub fn blobs(&self, min_area: f64) -> (Vec<Blob>, Vec<i32>) {
        let ink = self.symbol_ink();
        let mut labels = vec![0i32; self.w * self.h];
        let flat = connected_components(&ink.data, self.w, self.h, min_area, &mut labels);
        let blobs = flat
            .chunks_exact(8)
            .map(|c| Blob { id: c[0] as u32, rect: Rect::new(c[1], c[2], c[3], c[4]), area: c[5] as u32, cx: c[6], cy: c[7] })
            .collect();
        (blobs, labels)
    }

    /// 竖段：逐列纵向墨段（存疑像素也算墨——竖笔与谱线交叉处本来就不是存疑，这里只为不在纯谱线上断开）
    /// 长不短过 `min_len` 的，相邻列横向连成一段（纵向重叠过短者一半）。符干、小节线、系统线、升降号竖笔、谱号竖笔都在里面，归属由用它的模块定。
    pub fn vsegs(&self, min_len: usize) -> Vec<VSeg> {
        let mut open: Vec<VSeg> = Vec::new();
        let mut done: Vec<VSeg> = Vec::new();
        for x in 0..self.w {
            let mut runs = Vec::new();
            let mut y = 0;
            while y < self.h {
                if self.tri[y * self.w + x] == BG {
                    y += 1;
                    continue;
                }
                let a = y;
                while y < self.h && self.tri[y * self.w + x] != BG {
                    y += 1;
                }
                if y - a >= min_len {
                    runs.push((a, y - 1));
                }
            }
            let mut next = Vec::new();
            for (a, b) in runs {
                let hit = open.iter().position(|s| s.x1 + 1 == x && overlap(s.y0, s.y1, a, b) * 2 >= (s.y1 - s.y0).min(b - a) + 1);
                match hit {
                    Some(i) => {
                        let mut s = open.swap_remove(i);
                        s.x1 = x;
                        s.y0 = s.y0.min(a);
                        s.y1 = s.y1.max(b);
                        s.cols += 1;
                        next.push(s);
                    }
                    None => next.push(VSeg { x0: x, x1: x, y0: a, y1: b, cols: 1 }),
                }
            }
            done.append(&mut open);
            open = next;
        }
        done.extend(open);
        done.sort_by(|a, b| a.x0.cmp(&b.x0).then(a.y0.cmp(&b.y0)));
        done
    }
}

fn overlap(a0: usize, a1: usize, b0: usize, b1: usize) -> usize {
    (a1.min(b1) + 1).saturating_sub(a0.max(b0))
}

/// 一团墨（符号的墨的 8 邻接连通块）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Blob {
    pub id: u32,
    pub rect: Rect,
    pub area: u32,
    pub cx: f64,
    pub cy: f64,
}

/// 一根竖段：横跨 [x0, x1] 列、纵向 [y0, y1]（含）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VSeg {
    pub x0: usize,
    pub x1: usize,
    pub y0: usize,
    pub y1: usize,
    /// 连了几列（宽）。
    pub cols: usize,
}

impl VSeg {
    pub fn cx(&self) -> f64 {
        (self.x0 + self.x1) as f64 / 2.0
    }
    pub fn len(&self) -> usize {
        self.y1 - self.y0 + 1
    }
    pub fn is_empty(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::staves::find_staves;

    #[test]
    fn line_pixels_marked_symbols_kept() {
        let (w, h) = (300, 120);
        let mut b = Binary::new(w, h);
        for k in 0..5 {
            for x in 20..280 {
                for d in 0..2 {
                    b.data[(30 + k * 12 + d) * w + x] = 1;
                }
            }
        }
        // 一根竖笔穿过五条线、一个实心头压在第二间
        for y in 20..90 {
            b.data[y * w + 150] = 1;
            b.data[y * w + 151] = 1;
        }
        for y in 44..53 {
            for x in 100..112 {
                b.data[y * w + x] = 1;
            }
        }
        let (unit, staves) = find_staves(&b).unwrap();
        let ink = InkLayers::new(&b, &staves, &unit);
        assert_eq!(ink.at(60, 30), LINE);
        assert_eq!(ink.at(150, 30), INK); // 竖笔穿线处是墨
        assert_eq!(ink.at(105, 48), INK); // 头里的线是墨
        let (blobs, _) = ink.blobs(4.0);
        assert_eq!(blobs.len(), 2, "{blobs:?}"); // 竖笔一块（穿过谱线仍连着）、头一块
        let v = ink.vsegs(40);
        assert_eq!(v.len(), 1);
        assert_eq!((v[0].x0, v[0].x1, v[0].y0, v[0].y1), (150, 151, 20, 89));
    }
}
