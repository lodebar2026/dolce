//! 歌本切分用的三样 OCR（都走 [`CachedOcr`]，第二遍起读缓存）：整片检测 + 逐框读字、单字格认数字、整条重读。
//! 对应 web `paddleocr.ts` 的 `recognizeRegion` / `recognizeNumerals` / `recognizeTexts`。
use dolce_omr_core::image::{Binary, Rect};
use dolce_omr_core::ocr::cache::CachedOcr;
use dolce_omr_core::ocr::surface::{blit, fit_cell, Gray};

/// 一个字：左缘（`cx`，沿用 TS 的名字，其实是字段起点）与右缘，页面像素。
#[derive(Clone, Debug, PartialEq)]
pub struct OChar {
    pub text: String,
    pub cx: f64,
    pub x1: f64,
}

/// 检测出的一行字。
#[derive(Clone, Debug, PartialEq)]
pub struct OcrLine {
    pub text: String,
    pub bbox: Rect,
    pub chars: Vec<OChar>,
}

impl OcrLine {
    /// 逐字位置与正文逐字对得上（TS 里 `chars.length === text.length` 的判断）。
    pub fn chars_aligned(&self) -> bool {
        !self.chars.is_empty() && self.chars.len() == self.text.chars().count()
    }
}

/// 二值图的一块 → 白底黑字灰度（出界为白）。
fn crop(bin: &Binary, x: usize, y: usize, w: usize, h: usize) -> Gray {
    let mut g = Gray::new(w, h, 255);
    for yy in 0..h {
        let row = &bin.data[(y + yy) * bin.w + x..(y + yy) * bin.w + x + w];
        for (xx, &v) in row.iter().enumerate() {
            if v != 0 {
                g.data[yy * w + xx] = 0;
            }
        }
    }
    g
}

/// 夹到图里的整数框 (x, y, w, h)；空框为 None。
fn clamp_rect(bin: &Binary, r: &Rect) -> Option<(usize, usize, usize, usize)> {
    let x = r.x.round().max(0.0) as usize;
    let y = r.y.round().max(0.0) as usize;
    let x1 = (r.right().round().max(0.0) as usize).min(bin.w);
    let y1 = (r.bottom().round().max(0.0) as usize).min(bin.h);
    (x1 > x && y1 > y).then(|| (x, y, x1 - x, y1 - y))
}

/// 区域里检测文字行、逐行读字（坐标回到整页）。读不出字的行不要。
pub fn region(ocr: &CachedOcr, bin: &Binary, r: &Rect) -> Vec<OcrLine> {
    let Some((rx, ry, rw, rh)) = clamp_rect(bin, r) else { return Vec::new() };
    let src = crop(bin, rx, ry, rw, rh);
    let Ok(boxes) = ocr.detect(&src) else { return Vec::new() };
    let mut out = Vec::new();
    for b in boxes {
        let x = b.x.round().max(0.0) as usize;
        let y = b.y.round().max(0.0) as usize;
        let w = (b.w.round() as usize).min(src.w.saturating_sub(x));
        let h = (b.h.round() as usize).min(src.h.saturating_sub(y));
        if w < 4 || h < 4 {
            continue;
        }
        let mut cv = Gray::new(w, h, 255);
        blit(&mut cv, &src, Rect::new(x as f64, y as f64, w as f64, h as f64), Rect::new(0.0, 0.0, w as f64, h as f64));
        let Ok(cp) = ocr.read_line(&cv) else { continue };
        let text: String = cp.iter().map(|c| c.ch.as_str()).collect();
        if text.trim().is_empty() {
            continue;
        }
        let (px, py) = ((rx + x) as f64, (ry + y) as f64);
        out.push(OcrLine {
            text,
            bbox: Rect::new(px, py, w as f64, h as f64),
            chars: cp.iter().map(|c| OChar { text: c.ch.clone(), cx: px + c.x0 * w as f64, x1: px + c.x1 * w as f64 }).collect(),
        });
    }
    out
}

/// 逐格认一位数字（0–9）；认不出的为 None。
pub fn numerals(ocr: &CachedOcr, bin: &Binary, rects: &[Rect]) -> Vec<Option<u32>> {
    if rects.is_empty() {
        return Vec::new();
    }
    let cells: Vec<Gray> = rects
        .iter()
        .map(|r| match clamp_rect(bin, r) {
            Some((x, y, w, h)) => fit_cell(&crop(bin, x, y, w, h)),
            None => Gray::new(64, 64, 255),
        })
        .collect();
    let Ok(texts) = ocr.read_cells(&cells) else { return vec![None; rects.len()] };
    texts
        .iter()
        .map(|t| {
            let mut cs = t.chars();
            match (cs.next(), cs.next()) {
                (Some(c), None) => c.to_digit(10),
                _ => None,
            }
        })
        .collect()
}

/// 框里的墨整条裁出、四周垫 `pad` 白，读一遍字。
pub fn reread(ocr: &CachedOcr, bin: &Binary, r: &Rect, pad: usize) -> Option<String> {
    let (x, y, w, h) = clamp_rect(bin, r)?;
    let g = crop(bin, x, y, w, h);
    let mut cv = Gray::new(w + 2 * pad, h + 2 * pad, 255);
    blit(&mut cv, &g, Rect::new(0.0, 0.0, w as f64, h as f64), Rect::new(pad as f64, pad as f64, w as f64, h as f64));
    let cp = ocr.read_line(&cv).ok()?;
    Some(cp.iter().map(|c| c.ch.as_str()).collect())
}
