//! 文字行（M4 4.1）：两行谱之间（以及首行上方、末行下方）的带里，把不属于音符的墨块按纵向投影切成行、
//! 按横向空当切成段，逐段从原图取灰度条送 OCR，得带位置的字。
//!
//! 行是几何切出来的，不靠整页文字检测：密排的五段词与谱表贴在一起，检测模型把整个系统圈成一个框。
use crate::attrs::DigitReader;
use crate::frame::ink::{Blob, INK};
use crate::notes::RowNotes;
use crate::page::PageFrame;
use dolce_omr_core::geom::median;
use dolce_omr_core::image::Rect;
use dolce_omr_ocr::surface::Gray;
use dolce_omr_source::raster::SourceImage;
use dolce_omr_text::spaces::recover_spaces;
use dolce_omr_text::Ch;
use std::collections::HashSet;

/// 字身的墨块：高在这个范围（相对线距），宽不过上限。
const BODY_H: (f64, f64) = (0.4, 2.8);
const BODY_W: f64 = 4.0;
/// 贴着谱表（首末线外这么多格以内）的墨块不当文字。
const STAFF_PAD: f64 = 0.25;
/// 首行上方、末行下方的带伸出去这么多格。
const TOP_REACH: f64 = 9.0;
const BOTTOM_REACH: f64 = 24.0;
/// 过高的行（超过带内字高中位数这么多倍）在中段的投影谷切开；谷底要低到峰的这个比例。
const TALL: f64 = 1.7;
const VALLEY: f64 = 0.35;
/// 行内横向空当超过行高这么多倍就分段。
const SEG_GAP: f64 = 2.0;
/// 送检条四周留的白边（原图像素）。
const PAD: usize = 3;

/// 一段字：读出来的字（页内坐标，已补词间空格）与墨的外框。
#[derive(Clone, Debug)]
pub struct Seg {
    pub chars: Vec<Ch>,
    pub rect: Rect,
}

impl Seg {
    pub fn text(&self) -> String {
        self.chars.iter().map(|c| c.ch).collect()
    }
}

/// 一行字：纵向范围（实际坐标，取各段外框）与各段（按 x 排）。
#[derive(Clone, Debug)]
pub struct GeoLine {
    pub y0: f64,
    pub y1: f64,
    pub segs: Vec<Seg>,
}

impl GeoLine {
    pub fn cx(&self) -> f64 {
        let a = self.segs.first().map_or(0.0, |s| s.rect.x);
        let b = self.segs.last().map_or(0.0, |s| s.rect.right());
        (a + b) / 2.0
    }
    pub fn h(&self) -> f64 {
        self.y1 - self.y0
    }
}

/// 一条带：上面那行谱、下面那行谱（`staves` 下标；页顶 / 页底的带缺一头），带里的行自上而下。
#[derive(Clone, Debug)]
pub struct Band {
    pub above: Option<usize>,
    pub below: Option<usize>,
    pub lines: Vec<GeoLine>,
}

/// 音符占着的墨块、贴着谱表的墨块、太大的墨块：不当文字，送检时抹白。
fn excluded(f: &PageFrame, notes: &[RowNotes]) -> HashSet<i32> {
    let mut out: HashSet<i32> = HashSet::new();
    let (w, h) = (f.ink.w as i64, f.ink.h as i64);
    let label = |x: i64, y: i64| if x >= 0 && y >= 0 && x < w && y < h { f.labels[(y * w + x) as usize] } else { 0 };
    for (si, row) in notes.iter().enumerate() {
        let sp = f.staves[si].space();
        for c in &row.chords {
            for hd in &c.heads {
                let (rx, ry) = ((sp * 0.5) as i64, (sp * 0.3) as i64);
                for y in (hd.y as i64 - ry..=hd.y as i64 + ry).step_by(2) {
                    for x in (hd.x as i64 - rx..=hd.x as i64 + rx).step_by(2) {
                        out.insert(label(x, y));
                    }
                }
            }
            if let Some(st) = c.stem {
                for y in (st.top..=st.bottom).step_by(2) {
                    out.insert(label(st.x, y));
                }
            }
        }
        for r in &row.rests {
            out.insert(label(r.x as i64, r.y as i64));
        }
    }
    for b in &f.blobs {
        let sp = f.unit.space;
        let big = b.rect.h > BODY_H.1 * sp || b.rect.w > BODY_W * sp;
        let on_staff = f.staves.iter().any(|s| {
            let x = b.cx.clamp(s.left, s.right);
            b.rect.bottom() > s.top(x) - STAFF_PAD * s.space() && b.rect.y < s.bottom(x) + STAFF_PAD * s.space() && b.rect.right() > s.left - 2.0 * s.space() && b.rect.x < s.right + 2.0 * s.space()
        });
        if big || on_staff {
            out.insert(b.id as i32);
        }
    }
    out.remove(&0);
    out
}

/// 一段字的条：从原图裁（四周留白），不当文字的墨抹白。回 (条, 条左上角在原图上的位置)。
fn strip(f: &PageFrame, src: &SourceImage, rect: &Rect, drop: &HashSet<i32>) -> (Gray, i64, i64) {
    let up = f.up as i64;
    let x0 = (rect.x / up as f64).floor() as i64 - PAD as i64;
    let y0 = (rect.y / up as f64).floor() as i64 - PAD as i64;
    let x1 = (rect.right() / up as f64).ceil() as i64 + PAD as i64;
    let y1 = (rect.bottom() / up as f64).ceil() as i64 + PAD as i64;
    let (w, h) = ((x1 - x0).max(1) as usize, (y1 - y0).max(1) as usize);
    let mut g = Gray::new(w, h, 255);
    let (pw, ph) = (f.ink.w as i64, f.ink.h as i64);
    let dropped = |sx: i64, sy: i64| {
        // 这个原图像素及其一圈邻居在页内坐标上的标号
        for dy in -1..=1 {
            for dx in -1..=1 {
                let (x, y) = ((sx + dx) * up + up / 2, (sy + dy) * up + up / 2);
                if x >= 0 && y >= 0 && x < pw && y < ph {
                    let l = f.labels[(y * pw + x) as usize];
                    if l != 0 && drop.contains(&l) {
                        return true;
                    }
                }
            }
        }
        false
    };
    for y in 0..h as i64 {
        let sy = y0 + y;
        if sy < 0 || sy >= src.h as i64 {
            continue;
        }
        for x in 0..w as i64 {
            let sx = x0 + x;
            if sx < 0 || sx >= src.w as i64 || dropped(sx, sy) {
                continue;
            }
            g.data[y as usize * w + x as usize] = src.gray[sy as usize * src.w + sx as usize];
        }
    }
    (g, x0, y0)
}

/// 框里没被抹掉的墨的空白列段 `(起, 宽)`（页内坐标）。
fn blanks(f: &PageFrame, rect: &Rect, drop: &HashSet<i32>) -> Vec<(f64, f64)> {
    let pw = f.ink.w;
    let (x0, x1) = (rect.x.max(0.0) as usize, (rect.right() as usize).min(pw));
    let (y0, y1) = (rect.y.max(0.0) as usize, (rect.bottom() as usize).min(f.ink.h));
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    for x in x0..x1 {
        let ink = (y0..y1).any(|y| f.ink.tri[y * pw + x] == INK && !drop.contains(&f.labels[y * pw + x]));
        match (ink, start) {
            (false, None) => start = Some(x),
            (true, Some(s)) => {
                if s > x0 {
                    out.push((s as f64, (x - s) as f64));
                }
                start = None;
            }
            _ => {}
        }
    }
    out
}

/// 读一段：送 OCR、字位折回页内坐标、补词间空格。读不出字回 None。
fn read_seg(f: &PageFrame, src: &SourceImage, rect: Rect, drop: &HashSet<i32>, ocr: &dyn DigitReader) -> Option<Seg> {
    let (g, sx0, _) = strip(f, src, &rect, drop);
    let got = ocr.read_line(&g)?;
    let up = f.up as f64;
    let w = g.w as f64;
    let mut chars: Vec<Ch> = Vec::new();
    for c in got {
        let cs: Vec<char> = c.ch.chars().collect();
        let (a, b) = ((sx0 as f64 + c.x0 * w) * up, (sx0 as f64 + c.x1 * w) * up);
        let n = cs.len().max(1) as f64;
        for (i, ch) in cs.into_iter().enumerate() {
            chars.push(Ch { ch, x0: a + (b - a) * i as f64 / n, x1: a + (b - a) * (i + 1) as f64 / n });
        }
    }
    if chars.is_empty() {
        return None;
    }
    let chars = recover_spaces(&chars, &blanks(f, &rect, drop), rect.h);
    Some(Seg { chars, rect })
}

/// 一条带里的行。`ref_si`：拿哪一行谱的弯度拉平；`(y0, y1)`：带的纵向范围（拉平后的坐标）。
fn band_lines(f: &PageFrame, src: &SourceImage, drop: &HashSet<i32>, ref_si: usize, y0: f64, y1: f64, ocr: &dyn DigitReader) -> Vec<GeoLine> {
    let s = &f.staves[ref_si];
    let sp = s.space();
    // 拉平：减去这行谱在该 x 处相对左端的偏移
    let flat = |b: &Blob| {
        let x = b.cx.clamp(s.left, s.right);
        b.cy - (s.bottom(x) - s.ys[4])
    };
    let cand: Vec<(&Blob, f64)> = f.blobs.iter().filter(|b| !drop.contains(&(b.id as i32))).map(|b| (b, flat(b))).filter(|&(_, y)| y >= y0 && y < y1).collect();
    let body = |b: &Blob| b.rect.h >= BODY_H.0 * sp && b.rect.h <= BODY_H.1 * sp && b.rect.w <= BODY_W * sp;
    let bodies: Vec<&(&Blob, f64)> = cand.iter().filter(|(b, _)| body(b)).collect();
    if bodies.is_empty() {
        return Vec::new();
    }
    let char_h = median(&bodies.iter().map(|(b, _)| b.rect.h).collect::<Vec<_>>(), sp * 1.5);
    // 纵向投影（按拉平后的行）
    let n = (y1 - y0).ceil().max(1.0) as usize;
    let mut prof = vec![0.0f64; n + 1];
    for (b, y) in &bodies {
        let a = ((y - b.rect.h / 2.0 - y0).max(0.0) as usize).min(n);
        let z = ((y + b.rect.h / 2.0 - y0).max(0.0) as usize).min(n);
        for p in &mut prof[a..=z] {
            *p += b.rect.w;
        }
    }
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i <= n {
        if prof[i] > 0.0 {
            let mut j = i;
            while j < n && prof[j + 1] > 0.0 {
                j += 1;
            }
            runs.push((i, j));
            i = j + 1;
        } else {
            i += 1;
        }
    }
    // 过高的行在中段的谷切开
    let mut rows: Vec<(usize, usize)> = Vec::new();
    while let Some((a, z)) = runs.pop() {
        let hgt = (z - a + 1) as f64;
        if hgt > TALL * char_h {
            let (m0, m1) = (a + (hgt * 0.25) as usize, a + (hgt * 0.75) as usize);
            let peak = prof[a..=z].iter().cloned().fold(0.0, f64::max);
            let cut = (m0..=m1).min_by(|&p, &q| prof[p].total_cmp(&prof[q])).unwrap();
            if prof[cut] < peak * VALLEY && cut > a && cut < z {
                runs.push((a, cut - 1));
                runs.push((cut + 1, z));
                continue;
            }
        }
        if hgt >= BODY_H.0 * sp {
            rows.push((a, z));
        }
    }
    rows.sort();
    let mut out = Vec::new();
    for (a, z) in rows {
        let (ra, rz) = (y0 + a as f64 - char_h * 0.1, y0 + z as f64 + char_h * 0.1);
        let mut mem: Vec<&Blob> = cand.iter().filter(|(b, y)| *y >= ra && *y <= rz && b.rect.h <= (rz - ra) * 1.3).map(|(b, _)| *b).collect();
        mem.sort_by(|p, q| p.rect.x.total_cmp(&q.rect.x));
        let row_h = (z - a + 1) as f64;
        let mut segs: Vec<(Rect, bool)> = Vec::new();
        for b in mem {
            match segs.last_mut() {
                Some((r, has)) if b.rect.x - r.right() <= SEG_GAP * row_h => {
                    *r = dolce_omr_core::geom::union_rect(r, &b.rect);
                    *has |= body(b);
                }
                _ => segs.push((b.rect, body(b))),
            }
        }
        let segs: Vec<Seg> = segs.into_iter().filter(|s| s.1).filter_map(|(r, _)| read_seg(f, src, r, drop, ocr)).collect();
        if segs.is_empty() {
            continue;
        }
        let ya = segs.iter().map(|s| s.rect.y).fold(f64::MAX, f64::min);
        let yb = segs.iter().map(|s| s.rect.bottom()).fold(f64::MIN, f64::max);
        out.push(GeoLine { y0: ya, y1: yb, segs });
    }
    out
}

/// 一页各条带的文字行。
pub fn page_bands(f: &PageFrame, src: &SourceImage, notes: &[RowNotes], ocr: &dyn DigitReader) -> Vec<Band> {
    let drop = excluded(f, notes);
    let n = f.staves.len();
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| f.staves[a].ys[0].total_cmp(&f.staves[b].ys[0]));
    let mut out = Vec::new();
    let Some(&first) = order.first() else { return out };
    let s0 = &f.staves[first];
    out.push(Band { above: None, below: Some(first), lines: band_lines(f, src, &drop, first, (s0.ys[0] - TOP_REACH * s0.space()).max(0.0), s0.ys[0], ocr) });
    for (k, &si) in order.iter().enumerate() {
        let s = &f.staves[si];
        let next = order.get(k + 1).copied();
        // 下一行谱的首线折到这一行的拉平坐标里（两行弯度相近，取左端处）
        let y1 = match next {
            Some(ni) => f.staves[ni].ys[0],
            None => (s.ys[4] + BOTTOM_REACH * s.space()).min(f.ink.h as f64),
        };
        out.push(Band { above: Some(si), below: next, lines: band_lines(f, src, &drop, si, s.ys[4], y1, ocr) });
    }
    out
}
