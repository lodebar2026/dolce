//! JM3 音符数据：带内各格 → 音。数字读数（rec）、增时线、附点在带内；八度点在数字正上 / 正下的小圆块；
//! 减时线是带下方的细长横墨（按横向游程找，不靠连通块：线与数字、低音点粘着也照样量得出）。
use crate::frame::{digit_cell, digit_of, Cell, CellKind, RowFrame};
use crate::prep::{Comp, Ink};
use crate::result::JpNum;
use dolce_omr_core::image::Rect;
use dolce_omr_ocr::cache::CachedOcr;

/// 一行谱的音符层产物。
#[derive(Clone, Debug, Default)]
pub struct RowNotes {
    pub nums: Vec<JpNum>,
    pub barline_xs: Vec<f64>,
    pub double_bar_xs: Vec<f64>,
    /// 行末是细 + 粗的终止线
    pub final_end: bool,
    /// 行中的终止线（右边那根的 x）
    pub end_bar_xs: Vec<f64>,
    /// 已归了音符的墨（减时线、低音点），歌词切行时不算字
    pub claimed: Vec<Rect>,
}

/// 细长横墨：列范围与行范围（都含端点）。
#[derive(Clone, Copy, Debug)]
pub struct HLine {
    pub x0: i64,
    pub x1: i64,
    pub y0: i64,
    pub y1: i64,
}

/// 框里的细长横墨：每行取不短于 `min_len` 的横向墨段（容一像素断口），上下相邻、横向大半重叠的并成一条。
pub fn hlines(ink: &Ink, xa: i64, xb: i64, ya: i64, yb: i64, min_len: i64) -> Vec<HLine> {
    let mut done: Vec<HLine> = Vec::new();
    let mut open: Vec<HLine> = Vec::new();
    for y in ya..yb {
        let mut runs: Vec<(i64, i64)> = Vec::new();
        let mut x = xa;
        while x < xb {
            if !ink.at(x, y) {
                x += 1;
                continue;
            }
            let a = x;
            while x < xb && (ink.at(x, y) || (ink.at(x + 1, y) && x + 1 < xb)) {
                x += 1;
            }
            if x - a >= min_len {
                runs.push((a, x - 1));
            }
        }
        let mut next: Vec<HLine> = Vec::new();
        for (a, b) in runs {
            let hit = open.iter().position(|s| {
                let ov = b.min(s.x1) - a.max(s.x0) + 1;
                ov as f64 >= 0.6 * ((b - a + 1).min(s.x1 - s.x0 + 1)) as f64
            });
            match hit {
                Some(i) => {
                    let s = open.remove(i);
                    next.push(HLine { x0: s.x0.min(a), x1: s.x1.max(b), y0: s.y0, y1: y });
                }
                None => next.push(HLine { x0: a, x1: b, y0: y, y1: y }),
            }
        }
        done.append(&mut open);
        open = next;
    }
    done.append(&mut open);
    done
}

/// 八度点 / 附点样的小圆块。
pub fn dot_like(k: &Comp, h: f64) -> bool {
    let (w, hh) = (k.rect.w, k.rect.h);
    w >= h * 0.08 && hh >= h * 0.08 && w <= h * 0.42 && hh <= h * 0.42 && w / hh > 0.55 && w / hh < 1.8 && k.fill() >= 0.55
}

pub fn build(ink: &Ink, row: &RowFrame, ocr: &CachedOcr) -> RowNotes {
    let h = row.h();
    let mut out = RowNotes::default();
    // 读数
    let digit_cells: Vec<&Cell> = row.digits().collect();
    let imgs: Vec<_> = digit_cells.iter().map(|c| digit_cell(ink, &c.rect())).collect();
    let texts = ocr.read_cells(&imgs).unwrap_or_else(|_| vec![String::new(); imgs.len()]);
    let mut read: Vec<Option<u8>> = Vec::with_capacity(texts.len());
    for (i, t) in texts.iter().enumerate() {
        let mut d = digit_of(t);
        if d.is_none() && !t.trim().is_empty() {
            // 粗体小图把 3 / 5 / 6 的开口糊成闭环读成 8 / B：取候选里排最前的 0–7
            if let Ok(r) = ocr.rank_chars(&imgs[i], 10) {
                d = r.first().and_then(|c| c.alts.iter().find_map(|a| a.chars().next().filter(|c| ('0'..='7').contains(c) && a.chars().count() == 1))).map(|c| c as u8 - b'0');
            }
        }
        read.push(d);
    }
    // 按 x 走一遍各格：数字起一个音，增时线、附点记到前一个音上，小节线与冒号记结构
    let mut di = 0;
    let mut pending_forward = false;
    let mut bars: Vec<&Cell> = Vec::new();
    let mut last_bar_x1: Option<i64> = None;
    for c in &row.cells {
        match c.kind {
            CellKind::Digit => {
                let d = read[di];
                di += 1;
                let Some(d) = d else { continue };
                let mut n = JpNum { digit: d, bbox: c.rect(), ..Default::default() };
                n.repeat_forward = std::mem::take(&mut pending_forward);
                out.nums.push(n);
            }
            CellKind::Dash => {
                if let Some(n) = out.nums.last_mut() {
                    n.augment += 1;
                    n.augment_rects.push(c.rect());
                }
            }
            CellKind::Dot => {
                if let Some(n) = out.nums.last_mut() {
                    let after_bar = last_bar_x1.is_some_and(|b| b as f64 > n.bbox.right());
                    if n.augment == 0 && !after_bar && c.x0 as f64 - n.bbox.right() <= h * 0.9 && c.x0 as f64 >= n.bbox.right() - 1.0 {
                        n.dot += 1;
                    }
                }
            }
            CellKind::Bar { .. } => {
                bars.push(c);
                last_bar_x1 = Some(c.x1);
                out.barline_xs.push(c.cx());
            }
            CellKind::Colon => {
                // 冒号贴着小节线：在线左是反复结束，在线右是反复开始
                match last_bar_x1 {
                    Some(b) if (c.x0 - b) as f64 <= h * 0.6 => pending_forward = true,
                    _ => {
                        if let Some(n) = out.nums.last_mut() {
                            n.repeat_backward = true;
                        }
                    }
                }
            }
            CellKind::Other => {}
        }
    }
    // 并排两根：复纵线；右边那根粗的是终止线（行末的记 final_end）
    let last_num_right = out.nums.last().map_or(f64::MIN, |n| n.bbox.right());
    for w in bars.windows(2) {
        let (a, b) = (w[0], w[1]);
        if (b.x0 - a.x1) as f64 > h * 0.35 {
            continue;
        }
        let thick = matches!(b.kind, CellKind::Bar { thick: true });
        let at_end = b.cx() > last_num_right && std::ptr::eq(b, *bars.last().unwrap());
        let repeat = out.nums.iter().any(|n| n.repeat_backward && n.bbox.right() < a.cx() && a.cx() - n.bbox.right() < h * 3.0)
            || out.nums.iter().any(|n| n.repeat_forward && n.bbox.x > b.cx() && n.bbox.x - b.cx() < h * 3.0);
        if repeat {
            continue;
        }
        if thick && at_end {
            out.final_end = true;
        } else if thick {
            out.end_bar_xs.push(b.cx());
        } else {
            out.double_bar_xs.push(b.cx());
        }
    }
    underlines(ink, row, &mut out);
    octave_dots(ink, row, &mut out);
    out
}

/// 减时线：数字正下方一道道细横线。第一道离数字底不过 0.4 字号，其后每道离上一道不过 0.25 字号、不比上一道宽出去。
fn underlines(ink: &Ink, row: &RowFrame, out: &mut RowNotes) {
    let h = row.h();
    let w = ink.bin.w as f64;
    let ya = row.bottom_at(0.0).min(row.bottom_at(w)).floor() as i64;
    let yb = row.bottom_at(0.0).max(row.bottom_at(w)).ceil() as i64 + (h * 1.0) as i64;
    let max_thick = (h * 0.2).max(4.0);
    let lines: Vec<HLine> = hlines(ink, 0, ink.bin.w as i64, ya, yb, (h * 0.4) as i64).into_iter().filter(|l| ((l.y1 - l.y0 + 1) as f64) <= max_thick).collect();
    let slack = h * 0.15;
    let mut used: Vec<usize> = Vec::new();
    for n in &mut out.nums {
        let cx = n.bbox.cx();
        let bottom = row.bottom_at(cx).max(n.bbox.bottom());
        let mut under: Vec<usize> = (0..lines.len())
            .filter(|&i| {
                let l = &lines[i];
                l.x0 as f64 - slack <= cx && cx <= l.x1 as f64 + slack && l.y0 as f64 >= bottom - h * 0.02
            })
            .collect();
        under.sort_by_key(|&i| lines[i].y0);
        let mut prev: Option<&HLine> = None;
        for i in under {
            let l = &lines[i];
            let ok = match prev {
                None => l.y0 as f64 - bottom <= h * 0.4,
                Some(p) => (l.y0 - p.y1) as f64 <= h * 0.25 && l.y0 > p.y1 && l.x0 as f64 >= p.x0 as f64 - slack && l.x1 as f64 <= p.x1 as f64 + slack,
            };
            if !ok {
                break;
            }
            n.div += 1;
            prev = Some(l);
            if !used.contains(&i) {
                used.push(i);
            }
            if n.div >= 4 {
                break;
            }
        }
    }
    for i in used {
        let l = &lines[i];
        out.claimed.push(Rect::new(l.x0 as f64, l.y0 as f64, (l.x1 - l.x0 + 1) as f64, (l.y1 - l.y0 + 1) as f64));
    }
}

/// 数字正下方最低一道减时线的底（没有减时线回数字底）。
fn under_floor(n: &JpNum, claimed: &[Rect], h: f64) -> f64 {
    let cx = n.bbox.cx();
    claimed
        .iter()
        .filter(|l| l.x - h * 0.15 <= cx && cx <= l.right() + h * 0.15 && l.y >= n.bbox.bottom() - h * 0.1 && l.y - n.bbox.bottom() <= h * 1.1)
        .map(|l| l.bottom())
        .fold(n.bbox.bottom(), f64::max)
}

/// 八度点：数字正上方（高音）、减时线之下（低音）的小圆块。一个点只归横向最近的那个数字；上下各至多两个。
fn octave_dots(ink: &Ink, row: &RowFrame, out: &mut RowNotes) {
    let h = row.h();
    let w = ink.bin.w as f64;
    let (ya, yb) = (row.top_at(0.0).min(row.top_at(w)) - h * 1.2, row.bottom_at(0.0).max(row.bottom_at(w)) + h * 1.6);
    let dots: Vec<&Comp> = ink.comps.iter().filter(|k| k.cy > ya && k.cy < yb && dot_like(k, h)).collect();
    let floors: Vec<f64> = out.nums.iter().map(|n| under_floor(n, &out.claimed, h)).collect();
    // (点, 音, 上 / 下, 离数字多远)
    let mut hits: Vec<(usize, usize, bool, f64)> = Vec::new();
    for (di, d) in dots.iter().enumerate() {
        let near = out
            .nums
            .iter()
            .enumerate()
            .filter(|(_, n)| d.cx >= n.bbox.x - h * 0.12 && d.cx <= n.bbox.right() + h * 0.12)
            .min_by(|a, b| (a.1.bbox.cx() - d.cx).abs().total_cmp(&(b.1.bbox.cx() - d.cx).abs()));
        let Some((ni, n)) = near else { continue };
        let up_gap = n.bbox.y - d.rect.bottom();
        let dn_gap = d.rect.y - floors[ni];
        if up_gap >= -h * 0.08 && up_gap <= h * 0.75 {
            hits.push((di, ni, true, up_gap));
        } else if dn_gap >= -h * 0.06 && dn_gap <= h * 0.7 {
            hits.push((di, ni, false, dn_gap));
        }
    }
    for (ni, n) in out.nums.iter_mut().enumerate() {
        for up in [true, false] {
            let mut mine: Vec<&(usize, usize, bool, f64)> = hits.iter().filter(|t| t.1 == ni && t.2 == up).collect();
            mine.sort_by(|a, b| a.3.total_cmp(&b.3));
            // 第一个点贴着数字（或减时线），第二个贴着第一个
            let mut edge = 0.0;
            let mut cnt = 0;
            for t in mine {
                let first = if up { h * 0.45 } else { h * 0.38 };
                if t.3 - edge > if cnt == 0 { first } else { h * 0.3 } || cnt >= 2 {
                    break;
                }
                cnt += 1;
                edge = t.3 + dots[t.0].rect.h;
                if !up {
                    out.claimed.push(dots[t.0].rect);
                }
            }
            n.octave += if up { cnt } else { -cnt };
        }
        if n.digit == 0 || n.digit == crate::result::RHYTHM_DIGIT {
            n.octave = 0;
        }
    }
}
