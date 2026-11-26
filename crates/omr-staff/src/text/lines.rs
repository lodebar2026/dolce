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
use dolce_omr_core::ocr::surface::Gray;
use dolce_omr_core::source::raster::SourceImage;
use dolce_omr_core::text::spaces::{box_ink, recover_spaces, spread_all};
use dolce_omr_core::text::Ch;
use std::collections::HashSet;

/// 字身的墨块：高在这个范围（相对线距），宽不过上限。
const BODY_H: (f64, f64) = (0.4, 3.8);
const BODY_W: f64 = 8.0;
/// 不当文字的大墨块：宽过 / 高过这么多格，或宽过 `ARC_W` 格而墨占外框不到 `ARC_FILL`。
const WIDE: f64 = 8.0;
const HIGH: f64 = 6.5;
const ARC_W: f64 = 3.0;
const ARC_FILL: f64 = 0.22;
/// 短弧样的墨块：宽过高的 `FLAT` 倍、宽过 `FLAT_W` 格、墨占外框不到 `FLAT_FILL`（横笔、连字符是实心的，占得满）。
const FLAT: f64 = 2.0;
const FLAT_W: f64 = 1.2;
const FLAT_FILL: f64 = 0.45;
/// 贴着谱表（首末线外这么多格以内）的墨块不当文字。
const STAFF_PAD: f64 = 0.25;
/// 首行上方、末行下方的带伸出去这么多格。
const TOP_REACH: f64 = 9.0;
const BOTTOM_REACH: f64 = 24.0;
/// 过高的一截（超过行距这么多倍）按行距切成几行。
const TALL: f64 = 1.7;
/// 一截里的深谷：投影不到峰的这个比例、离两头都有字高的这么多倍。
const VALLEY: f64 = 0.12;
const VALLEY_EDGE: f64 = 0.45;
/// 相邻两截投影合起来不过字高的这么多倍，是一个字的上下部件、并成一行。
const ONE_CHAR: f64 = 1.15;
/// 字的上下部件：横向落在字身块左右之内，两头各容字高的这么多倍。
const PART_TOL: f64 = 0.15;
/// 行内横向空当超过行高这么多倍就分段。
const SEG_GAP: f64 = 2.0;
/// 一行里另有这么多个字身，行里认出的符头才算字。
const TEXT_ROW: usize = 3;
/// 横向分栏的白道：整条带都空着、宽过字高这么多倍。
const GUTTER: f64 = 3.0;
/// 两栏的行中心相差不过全带正常行高（`one_h`）的这个比例，算同一行（短截无上下延笔画时中心可偏出两三成，仍远小于行距或插空副歌行）。
const SAME_ROW: f64 = 0.32;
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

/// 字行里的假符头：哪一行谱、头的位置。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FalseHead {
    pub staff: usize,
    pub x: f64,
    pub y: f64,
}

/// 不当文字的墨块（送检时抹白）：贴着谱表的、太大的（带干的音符、弧、杠）、休止。
/// 谱表外、字身大小的墨块上认出的符头先不定（`maybe`：块 → 头）：落在成行的字里的是字（「口」「日」的框读成了空心头），
/// 孤零零的才是音符（加线上的全音符）。
fn excluded(f: &PageFrame, notes: &[RowNotes]) -> (HashSet<i32>, std::collections::HashMap<i32, Vec<FalseHead>>) {
    let mut out: HashSet<i32> = HashSet::new();
    let (w, h) = (f.ink.w as i64, f.ink.h as i64);
    let label = |x: i64, y: i64| if x >= 0 && y >= 0 && x < w && y < h { f.labels[(y * w + x) as usize] } else { 0 };
    for b in &f.blobs {
        let sp = f.unit.space;
        // 太大的：横向很长的（弧、松叶、横线）、纵向很长的（花括号、竖线）、又宽又稀的（短弧）。
        // 上下两行字相接连成的一块不在此列——它比两行字高不了多少
        let big = b.rect.w > WIDE * sp || b.rect.h > HIGH * sp || (b.rect.w > ARC_W * sp && (b.area as f64) < ARC_FILL * b.rect.w * b.rect.h);
        let on_staff = f.staves.iter().any(|s| {
            let x = b.cx.clamp(s.left, s.right);
            b.rect.bottom() > s.top(x) - STAFF_PAD * s.space() && b.rect.y < s.bottom(x) + STAFF_PAD * s.space() && b.rect.right() > s.left - 2.0 * s.space() && b.rect.x < s.right + 2.0 * s.space()
        });
        if big || on_staff {
            out.insert(b.id as i32);
        }
    }
    let mut maybe: std::collections::HashMap<i32, Vec<FalseHead>> = std::collections::HashMap::new();
    // 扁而稀的墨块（延音线、小圆滑线，也可能是字里的一撇一捺）同样先不定：成行的字里的留着，否则不当文字
    for b in &f.blobs {
        let sp = f.unit.space;
        if !out.contains(&(b.id as i32)) && b.rect.w >= FLAT * b.rect.h && b.rect.w >= FLAT_W * sp && (b.area as f64) < FLAT_FILL * b.rect.w * b.rect.h {
            maybe.entry(b.id as i32).or_default();
        }
    }
    for (si, row) in notes.iter().enumerate() {
        let sp = f.staves[si].space();
        for c in &row.chords {
            for hd in &c.heads {
                let (rx, ry) = ((sp * 0.5) as i64, (sp * 0.3) as i64);
                let mut seen: Vec<i32> = Vec::new();
                for y in (hd.y as i64 - ry..=hd.y as i64 + ry).step_by(2) {
                    for x in (hd.x as i64 - rx..=hd.x as i64 + rx).step_by(2) {
                        let l = label(x, y);
                        if l != 0 && !out.contains(&l) && !seen.contains(&l) {
                            seen.push(l);
                        }
                    }
                }
                for l in seen {
                    maybe.entry(l).or_default().push(FalseHead { staff: si, x: hd.x, y: hd.y });
                }
            }
        }
        for r in &row.rests {
            out.insert(label(r.x as i64, r.y as i64));
        }
    }
    out.remove(&0);
    (out, maybe)
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
                    // 简谱行划掉的墨不是这一路的字
                    if (l != 0 && drop.contains(&l)) || f.band_ink.as_ref().is_some_and(|b| b.data[(y * pw + x) as usize] != 0) {
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

/// 读一段：送 OCR、字位折回页内坐标、补词间空格。读不出字回 None。
fn read_seg(f: &PageFrame, src: &SourceImage, rect: Rect, drop: &HashSet<i32>, ocr: &dyn DigitReader) -> Option<Seg> {
    let (g, sx0, _) = strip(f, src, &rect, drop);
    g.dump_strip(rect.x, rect.y);
    let got = ocr.read_line(&g)?;
    let up = f.up;
    let w = g.w as f64;
    let chars = spread_all(got.iter().map(|c| (c.ch.as_str(), c.x0, c.x1)), |r| (sx0 as f64 + r * w) * up, Some);
    if chars.is_empty() {
        return None;
    }
    // 框里没被抹掉的墨：空白列段与左右缘
    let pw = f.ink.w;
    let (x0, x1) = (rect.x.max(0.0) as usize, (rect.right() as usize).min(pw));
    let (y0, y1) = (rect.y.max(0.0) as usize, (rect.bottom() as usize).min(f.ink.h));
    let col = |x: i64| (y0..y1).any(|y| f.ink.tri[y * pw + x as usize] == INK && !drop.contains(&f.labels[y * pw + x as usize]));
    let chars = match box_ink(x0 as i64, x1 as i64, 0, 0, col, |_| false) {
        Some(bi) => recover_spaces(&chars, &bi.blanks, rect.h, bi.left, bi.right),
        None => recover_spaces(&chars, &[], rect.h, x0 as f64, x1 as f64),
    };
    Some(Seg { chars, rect })
}

/// 一条带里的行。`ref_si`：拿哪一行谱的弯度拉平；`(y0, y1)`：带的纵向范围（拉平后的坐标）。
///
/// 行按**像素**的纵向投影切（不按墨块外框：上下两行的笔画相接时两行的字连成一块，外框把谷填平了）；
/// 几行挤成一截的按行距切开。送检的条纵向只取这一行的范围，连到邻行的墨块在行界处截断。
fn band_lines(f: &PageFrame, src: &SourceImage, cx: &mut Ctx, ref_si: usize, y0: f64, y1: f64, ocr: &dyn DigitReader) -> Vec<GeoLine> {
    let s = &f.staves[ref_si];
    let sp = s.space();
    let off = |x: f64| s.bottom(x.clamp(s.left, s.right)) - s.ys[4];
    // 带里的墨块（中心在带里、不在排除之列）与拉平后的中心 y
    // 谱行之间的带（下面还有谱行）里右缘不过谱表左端半格的墨是系统线、括号的一截，不是字（新编 239 系统线断成几截读成「1」自成一栏，
    // 切出的行与正文行错开半行，并行时把第 1 段词劈成两行）
    let below = f.staves.iter().any(|t| t.ys[0] >= y1 - 1.0);
    let lead = s.left + sp * 0.5;
    let cand: Vec<(&Blob, f64)> = f
        .blobs
        .iter()
        .filter(|b| !cx.drop.contains(&(b.id as i32)) && !(below && b.rect.right() <= lead))
        .map(|b| (b, b.cy - off(b.cx)))
        .filter(|&(b, y)| y >= y0 && y < y1 && b.rect.y - off(b.cx) >= y0 - sp)
        .collect();
    let body = |b: &Blob| b.rect.h >= BODY_H.0 * sp && b.rect.w <= BODY_W * sp;
    let single: Vec<f64> = cand.iter().filter(|(b, _)| body(b) && b.rect.h <= BODY_H.1 * sp).map(|(b, _)| b.rect.h).collect();
    if single.is_empty() {
        return Vec::new();
    }
    // 字高取字身墨块高的 85 分位（偏旁、标点、小写字母把中位数拉低）
    let char_h = dolce_omr_core::geom::quantile(&single, 0.85);
    // 一个字高的另一个估计：整条带投影的各截高（行高）的中位数。扫描件的方块字常碎成几块（「三」「主」），字身块高偏低，
    // 一个字的上下部件按它并不起来（新编 009「三一上主」切成上下两行）
    let rows: Vec<f64> = profile(f, &cand, &off, y0, y1).1.iter().map(|&(a, z)| (z - a + 1) as f64).filter(|&h| h >= char_h * 0.8 && h <= char_h * TALL).collect();
    let one_h = char_h.max(median(&rows, char_h));
    // 横向分栏：整条带从上到下都空着的宽白道两边各切各的行——主歌几行词右边接着副歌，副歌的行夹在主歌两行之间的高度上，
    // 合在一起投影就并进了主歌的行。两栏切出的行高度对得上的再并回一行
    let mut by_x: Vec<&(&Blob, f64)> = cand.iter().collect();
    by_x.sort_by(|p, q| p.0.rect.x.total_cmp(&q.0.rect.x));
    let mut blocks: Vec<Vec<(&Blob, f64)>> = Vec::new();
    let mut right = f64::MIN;
    for c in by_x {
        if blocks.is_empty() || c.0.rect.x - right > GUTTER * char_h {
            blocks.push(Vec::new());
        }
        right = right.max(c.0.rect.right());
        blocks.last_mut().unwrap().push(*c);
    }
    let mut out: Vec<GeoLine> = Vec::new();
    for b in blocks {
        for l in block_lines(f, src, cx, &b, &off, sp, char_h, one_h, y0, y1, ocr) {
            let same = out.iter_mut().find(|o| {
                ((o.y0 + o.y1) / 2.0 - (l.y0 + l.y1) / 2.0).abs() <= SAME_ROW * one_h
            });
            match same {
                Some(o) => {
                    o.y0 = o.y0.min(l.y0);
                    o.y1 = o.y1.max(l.y1);
                    o.segs.extend(l.segs);
                }
                None => out.push(l),
            }
        }
    }
    out.sort_by(|a, b| a.y0.total_cmp(&b.y0));
    out
}

/// 纵向投影（带里各墨块的像素按拉平后的行数）与有墨的各截。
fn profile(f: &PageFrame, cand: &[(&Blob, f64)], off: &dyn Fn(f64) -> f64, y0: f64, y1: f64) -> (Vec<f64>, Vec<(usize, usize)>) {
    let n = (y1 - y0).ceil().max(1.0) as usize;
    let mut prof = vec![0.0f64; n + 1];
    let pw = f.ink.w;
    for (b, _) in cand {
        let o = off(b.cx);
        let id = b.id as i32;
        for y in b.rect.y as usize..(b.rect.bottom() as usize).min(f.ink.h) {
            let r = y as f64 - o - y0;
            if r < 0.0 || r > n as f64 {
                continue;
            }
            let cnt = (b.rect.x as usize..(b.rect.right() as usize).min(pw)).filter(|&x| f.labels[y * pw + x] == id).count();
            prof[r as usize] += cnt as f64;
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
    (prof, runs)
}

/// 一栏里的行。
#[allow(clippy::too_many_arguments)]
/// `one_h`：一个字高（并部件、不切深谷用；见 `band_lines`）。
fn block_lines(f: &PageFrame, src: &SourceImage, cx: &mut Ctx, cand: &[(&Blob, f64)], off: &dyn Fn(f64) -> f64, sp: f64, char_h: f64, one_h: f64, y0: f64, y1: f64, ocr: &dyn DigitReader) -> Vec<GeoLine> {
    let body = |b: &Blob| b.rect.h >= BODY_H.0 * sp && b.rect.w <= BODY_W * sp;
    let (prof, runs) = profile(f, cand, off, y0, y1);
    // 一个字的上下部件不相连（「二」、碎开的「三」「主」）：相邻两截合起来不过一个字高、两截各有正经字身块（不是待定的扁稀块）的是同一行。
    // 单字成栏时只有它自己的投影，会在部件之间断开（新编 009「三一上主」）；字行上方贴着的延音线那一截只有扁稀块，不并（破碎干净版）
    let has_body = |a: usize, z: usize| {
        cand.iter().any(|(b, _)| {
            let t = b.rect.y - off(b.cx) - y0;
            body(b) && !cx.maybe.contains_key(&(b.id as i32)) && t < z as f64 + 1.0 && t + b.rect.h > a as f64
        })
    };
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (a, z) in runs {
        match merged.last_mut() {
            Some(m) if (z - m.0 + 1) as f64 <= one_h * ONE_CHAR && has_body(m.0, m.1) && has_body(a, z) => m.1 = z,
            _ => merged.push((a, z)),
        }
    }
    let runs = merged;
    // 上下两行只靠几笔相接的（拉丁词的降部碰到下一行汉字的顶）：一截里有深谷（不到峰的一成多）、两边都够一行高的，在谷底切开
    let mut stack = runs;
    let mut runs: Vec<(usize, usize)> = Vec::new();
    while let Some((a, z)) = stack.pop() {
        let edge = (char_h * VALLEY_EDGE) as usize;
        // 不过一个字高的一截就是一行字，不切（单字成栏时只有它自己的投影，「美」腰上那几行很淡）
        if z - a > 2 * edge + 2 && (z - a + 1) as f64 > one_h * ONE_CHAR {
            let peak = prof[a..=z].iter().cloned().fold(0.0, f64::max);
            let cut = (a + edge..=z - edge).min_by(|&p, &q| prof[p].total_cmp(&prof[q])).unwrap();
            if prof[cut] < peak * VALLEY {
                stack.push((a, cut - 1));
                stack.push((cut + 1, z));
                continue;
            }
        }
        runs.push((a, z));
    }
    runs.sort();
    if std::env::var("OMR_TEXT_DEBUG").is_ok() {
        eprintln!("切行 带y{y0:.0} x{:.0}~{:.0} 字高{char_h:.1}/{one_h:.1} 截{:?}", cand.iter().map(|c| c.0.rect.x).fold(f64::MAX, f64::min), cand.iter().map(|c| c.0.rect.right()).fold(f64::MIN, f64::max), runs.iter().map(|&(a, z)| (y0 as usize + a, y0 as usize + z)).collect::<Vec<_>>());
    }
    // 几行挤成一截的：按本带的行距切开，切在预期位置附近投影最低处
    let normal: Vec<f64> = runs.iter().map(|&(a, z)| (z - a + 1) as f64).filter(|&h| h >= char_h * 0.8 && h <= char_h * TALL).collect();
    let pitch = median(&normal, char_h * 1.15);
    let mut rows: Vec<(usize, usize)> = Vec::new();
    for (a, z) in runs {
        let hgt = (z - a + 1) as f64;
        let k = (hgt / pitch).round() as usize;
        if hgt > TALL * pitch && k >= 2 {
            let step = hgt / k as f64;
            let mut from = a;
            for i in 1..k {
                let c = a as f64 + step * i as f64;
                let (m0, m1) = ((c - step * 0.25) as usize, (c + step * 0.25) as usize);
                let cut = (m0.max(from + 1)..=m1.min(z - 1)).min_by(|&p, &q| prof[p].total_cmp(&prof[q])).unwrap_or(c as usize);
                rows.push((from, cut));
                from = cut + 1;
            }
            rows.push((from, z));
        } else if hgt >= BODY_H.0 * sp {
            rows.push((a, z));
        }
    }
    let mut out = Vec::new();
    for (a, z) in rows {
        let (ra, rz) = (y0 + a as f64, y0 + z as f64 + 1.0);
        // 这一行的墨块：纵向与行交叠过自己一半高、或盖住行的一半
        let over = |b: &Blob| {
            let (t, u) = (b.rect.y - off(b.cx), b.rect.bottom() - off(b.cx));
            let ov = (u.min(rz) - t.max(ra)).max(0.0);
            ov >= (u - t) * 0.5 || ov >= (rz - ra) * 0.5
        };
        let mut mem: Vec<&Blob> = cand.iter().map(|(b, _)| *b).filter(|b| over(b)).collect();
        // 行里认出过符头的墨块：同行另有三个以上字身就是字（记下假符头），否则是音符、不进这一行
        let plain = mem.iter().filter(|b| body(b) && !cx.maybe.contains_key(&(b.id as i32))).count();
        if plain >= TEXT_ROW {
            for b in &mem {
                if let Some(h) = cx.maybe.get(&(b.id as i32)) {
                    cx.false_heads.extend(h.iter().copied());
                }
            }
        } else {
            // 矢量页（转曲页画成的像素）：横向落在本行某个字身块左右之内的扁块是那个字的上下部件（裴克经文诗歌 003 单字成栏的「美」的大底），留下。
            // 位图页不这样留：短延音线同样落在字宽里，吃进文字行就被弧那边剔掉（破碎干净版多补 6 条延音线）
            let tol = char_h * PART_TOL;
            let bodies: Vec<Rect> = mem.iter().filter(|b| body(b) && !cx.maybe.contains_key(&(b.id as i32))).map(|b| b.rect).collect();
            let part = |b: &Blob| f.vector && bodies.iter().any(|r| b.rect.x >= r.x - tol && b.rect.right() <= r.right() + tol);
            let gone: Vec<i32> = mem.iter().filter(|b| cx.maybe.contains_key(&(b.id as i32)) && !part(b)).map(|b| b.id as i32).collect();
            cx.drop.extend(gone.iter().copied());
            mem.retain(|b| !gone.contains(&(b.id as i32)));
        }
        mem.sort_by(|p, q| p.rect.x.total_cmp(&q.rect.x));
        let row_h = (z - a + 1) as f64;
        // 横向分段：(左, 右, 有没有字身)
        let mut segs: Vec<(f64, f64, bool)> = Vec::new();
        for b in mem {
            match segs.last_mut() {
                Some((_, r, has)) if b.rect.x - *r <= SEG_GAP * row_h => {
                    *r = r.max(b.rect.right());
                    *has |= body(b);
                }
                _ => segs.push((b.rect.x, b.rect.right(), body(b))),
            }
        }
        let segs: Vec<Seg> = segs
            .into_iter()
            .filter(|s| s.2)
            .filter_map(|(xa, xb, _)| {
                // 条的纵向范围：这一行（折回这一段所在处的实际 y）
                let o = off((xa + xb) / 2.0);
                read_seg(f, src, Rect::new(xa, ra + o, xb - xa, rz - ra), &cx.drop, ocr)
            })
            .collect();
        if segs.is_empty() {
            continue;
        }
        let ya = segs.iter().map(|s| s.rect.y).fold(f64::MAX, f64::min);
        let yb = segs.iter().map(|s| s.rect.bottom()).fold(f64::MIN, f64::max);
        out.push(GeoLine { y0: ya, y1: yb, segs });
    }
    out
}

/// 切行时的账：不当文字的墨块、谱表外认出过符头的墨块、判成字的假符头。
struct Ctx {
    drop: HashSet<i32>,
    maybe: std::collections::HashMap<i32, Vec<FalseHead>>,
    false_heads: Vec<FalseHead>,
}

/// 一页各条带的文字行，与落在字行里的假符头。
pub fn page_bands(f: &PageFrame, src: &SourceImage, notes: &[RowNotes], ocr: &dyn DigitReader) -> (Vec<Band>, Vec<FalseHead>) {
    let (drop, maybe) = excluded(f, notes);
    if let Some(q) = std::env::var("OMR_TEXT_PROBE").ok().map(|v| v.split(',').filter_map(|t| t.parse::<usize>().ok()).collect::<Vec<_>>()).filter(|q| q.len() == 2) {
        let l = f.labels[q[1] * f.ink.w + q[0]];
        let b = f.blobs.iter().find(|b| b.id as i32 == l);
        eprintln!("探墨块 {q:?} 标号{l} 块{:?} 排除{} 待定{}", b.map(|b| (b.rect, b.area)), drop.contains(&l), maybe.contains_key(&l));
    }
    let mut cx = Ctx { drop, maybe, false_heads: Vec::new() };
    let n = f.staves.len();
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| f.staves[a].ys[0].total_cmp(&f.staves[b].ys[0]));
    let mut out = Vec::new();
    let Some(&first) = order.first() else { return (out, Vec::new()) };
    let s0 = &f.staves[first];
    out.push(Band { above: None, below: Some(first), lines: band_lines(f, src, &mut cx, first, (s0.ys[0] - TOP_REACH * s0.space()).max(0.0), s0.ys[0], ocr) });
    for (k, &si) in order.iter().enumerate() {
        let s = &f.staves[si];
        let next = order.get(k + 1).copied();
        let y1 = match next {
            Some(ni) => f.staves[ni].ys[0],
            None => (s.ys[4] + BOTTOM_REACH * s.space()).min(f.ink.h as f64),
        };
        out.push(Band { above: Some(si), below: next, lines: band_lines(f, src, &mut cx, si, s.ys[4], y1, ocr) });
    }
    (out, cx.false_heads)
}
