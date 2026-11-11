//! JM3 其余（7g）：贴着音的记号——临时升降号（数字左上的 ♯ / ♭ / ♮）、倚音（左上的小号数字，底下压着减时线）、
//! 数字头顶的顿音 ▼、重音 >、波音（锯齿）、延长记号（小弧扣一个点）。都靠记号自身的形状认，尺寸按本行字号归一。
//! 认下的连通块记进 `used`：八度点不再收它们（延长记号的点、顿音三角的尺寸都落在八度点那一档里）。
use crate::frame::{digit_cell, RowFrame};
use crate::notes::{dot_like, RowNotes};
use crate::prep::{Comp, Ink};
use crate::result::{Grace, JpNum, RHYTHM_DIGIT};
use dolce_omr_core::geom::median;
use dolce_omr_core::image::Rect;
use dolce_omr_ocr::cache::CachedOcr;

/// 框里各列最高墨点离框顶多少行（没墨的列是 None）。
fn top_profile(ink: &Ink, r: &Rect) -> Vec<Option<f64>> {
    let (x0, x1, y0, y1) = (r.x.round() as i64, r.right().round() as i64, r.y.round() as i64, r.bottom().round() as i64);
    (x0..x1).map(|x| (y0..y1).find(|&y| ink.at(x, y)).map(|y| (y - y0) as f64)).collect()
}

/// 各行墨的左右缘（相对框左；没墨的行是 None）。
fn row_spans(ink: &Ink, r: &Rect) -> Vec<Option<(f64, f64)>> {
    let (x0, x1, y0, y1) = (r.x.round() as i64, r.right().round() as i64, r.y.round() as i64, r.bottom().round() as i64);
    (y0..y1)
        .map(|y| {
            let a = (x0..x1).find(|&x| ink.at(x, y))?;
            let b = (x0..x1).rev().find(|&x| ink.at(x, y))?;
            Some(((a - x0) as f64, (b - x0) as f64))
        })
        .collect()
}

/// 锯齿：上缘线有两个分得开（≥ 0.35 宽）的峰，峰之间有不浅于 `min_valley` 的谷。弧的峰挤在正中一处。
fn zigzag(ink: &Ink, r: &Rect, min_valley: f64, skip: Option<(i64, i64)>) -> bool {
    let x0 = r.x.round() as i64;
    let top: Vec<Option<f64>> = top_profile(ink, r).into_iter().enumerate().map(|(i, v)| if skip.is_some_and(|s| x0 + i as i64 >= s.0 && x0 + i as i64 <= s.1) { None } else { v }).collect();
    let Some(peak) = top.iter().flatten().copied().reduce(f64::min) else { return false };
    let hi: Vec<usize> = top.iter().enumerate().filter(|(_, v)| v.is_some_and(|v| v <= peak + r.h * 0.15)).map(|(i, _)| i).collect();
    let (pl, pr) = (hi[0], hi[hi.len() - 1]);
    if ((pr - pl) as f64) < r.w * 0.35 {
        return false;
    }
    let valley = top[pl..=pr].iter().flatten().copied().fold(f64::MIN, f64::max);
    valley - peak >= min_valley
}

/// 拱：上缘两端都比最高点低 0.12 字号以上（斜着的一道短笔一头到一头单调下降，过不了）。
fn arched(ink: &Ink, r: &Rect, h: f64) -> bool {
    let top = top_profile(ink, r);
    let n = top.len();
    if n < 4 {
        return false;
    }
    let peak = top.iter().flatten().copied().fold(f64::MAX, f64::min);
    let end = |it: &mut dyn Iterator<Item = &Option<f64>>| it.take((n / 5).max(1)).flatten().copied().fold(f64::MIN, f64::max);
    let (l, r) = (end(&mut top.iter()), end(&mut top.iter().rev()));
    l - peak >= h * 0.12 && r - peak >= h * 0.12
}

/// 居中的竖杠（下波音中间那一道）：块中部 [0.3, 0.7] 宽内贯穿 0.85 块高的连续几列，宽不过 0.12 字号。
fn center_stroke(ink: &Ink, b: &Rect, h: f64) -> Option<(i64, i64)> {
    let (y0, y1) = (b.y.round() as i64, b.bottom().round() as i64);
    let mut s: Option<(i64, i64)> = None;
    for x in (b.x + b.w * 0.3).ceil() as i64..=(b.x + b.w * 0.7).floor() as i64 {
        let (mut best, mut cur) = (0, 0);
        for y in y0..y1 {
            if ink.at(x, y) {
                cur += 1;
                best = best.max(cur);
            } else {
                cur = 0;
            }
        }
        if (best as f64) < b.h * 0.85 {
            continue;
        }
        s = match s {
            None => Some((x, x)),
            Some((a, e)) if x == e + 1 => Some((a, x)),
            Some(_) => return None,
        };
    }
    s.filter(|s| ((s.1 - s.0 + 1) as f64) <= (h * 0.12).max(3.0))
}

/// 变音记号的形状（判据照 TS `omr/accidental.ts`）：♯ 四象限都有墨；♭ 右上空、左竖到底；♮ 左竖高、右竖低。
pub fn accidental_of(ink: &Ink, b: &Rect) -> Option<&'static str> {
    let (bx0, bx1, by0, by1) = (b.x.round() as i64, b.right().round() as i64, b.y.round() as i64, b.bottom().round() as i64);
    let frac = |x0: i64, x1: i64, y0: i64, y1: i64| {
        let tot = ((x1 - x0) * (y1 - y0)).max(1) as f64;
        (y0..y1).map(|y| (x0..x1).filter(|&x| ink.at(x, y)).count()).sum::<usize>() as f64 / tot
    };
    let center_y = |x0: i64, x1: i64| {
        let (mut sum, mut n) = (0.0, 0.0);
        for y in by0..by1 {
            for x in x0..x1 {
                if ink.at(x, y) {
                    n += 1.0;
                    sum += (y - by0) as f64;
                }
            }
        }
        (n > 0.0).then(|| sum / n / (b.h - 1.0).max(1.0))
    };
    let (mx, my) = ((b.x + b.w / 2.0).round() as i64, (b.y + b.h / 2.0).round() as i64);
    let (lt, rt, lb, rb) = (frac(bx0, mx, by0, my), frac(mx, bx1, by0, my), frac(bx0, mx, my, by1), frac(mx, bx1, my, by1));
    if lt + rt + lb + rb < 0.3 {
        return None;
    }
    if rt < rb * 0.62 && lt > rt && lb >= rb * 0.7 {
        return Some("flat");
    }
    if let (Some(lc), Some(rc)) = (center_y(bx0, mx), center_y(mx, bx1)) {
        if rc - lc > 0.18 {
            return Some("natural");
        }
    }
    // 小号粗印的 ♭ 四格墨量差不多：看轮廓——顶上只有一根竖笔（每行一段窄墨），底下是肚子（宽）
    let row_runs = |y: i64| {
        let (mut lo, mut hi, mut runs, mut prev) = (-1i64, -1i64, 0, false);
        for x in bx0..bx1 {
            let on = ink.at(x, y);
            if on {
                if lo < 0 {
                    lo = x;
                }
                hi = x;
                if !prev {
                    runs += 1;
                }
            }
            prev = on;
        }
        (if lo < 0 { 0.0 } else { (hi - lo + 1) as f64 / b.w }, runs)
    };
    let band = |y0: f64, y1: f64| -> Vec<(f64, i32)> { (y0.round() as i64..(y1.round() as i64).max(y0.round() as i64 + 1)).map(row_runs).collect() };
    let top = band(b.y, b.y + b.h * 0.12);
    let bottom = band(b.bottom() - b.h * 0.25, b.bottom());
    let avg = bottom.iter().map(|r| r.0).sum::<f64>() / bottom.len().max(1) as f64;
    if top.iter().all(|r| r.1 == 1 && r.0 < 0.4) && avg >= 0.6 {
        return Some("flat");
    }
    (lt.min(rt).min(lb).min(rb) >= 0.12).then_some("sharp")
}

/// 记号正下方的音：横向对正（中线差不过 `dx` 字号）、是有音高的音；纵向间隙量到数字顶，或数字头上夹着的高八度点。
fn owner_below(nums: &[JpNum], dots: &[&Comp], b: &Rect, h: f64, dx: f64, gap_lo: f64, gap_hi: f64, own: i32) -> Option<usize> {
    nums.iter().position(|n| {
        if (n.bbox.cx() - b.cx()).abs() > h * dx || n.digit == 0 {
            return false;
        }
        let mut top = n.bbox.y;
        for o in dots {
            let ob = &o.rect;
            if o.id == own || o.cx < n.bbox.x || o.cx > n.bbox.right() || ob.bottom() > n.bbox.y + 1.0 || n.bbox.y - ob.bottom() > h * 0.6 || ob.y < b.bottom() - h * 0.25 {
                continue;
            }
            top = top.min(ob.y);
        }
        let gap = top - b.bottom();
        gap >= -h * gap_lo && gap <= h * gap_hi
    })
}

/// 认一行谱的贴音记号，记到各音上。回认下的连通块 id。
pub fn apply(ink: &Ink, row: &RowFrame, out: &mut RowNotes, ocr: &CachedOcr) -> Vec<i32> {
    let h = row.h();
    let w = ink.bin.w as f64;
    let (ya, yb) = (row.top_at(0.0).min(row.top_at(w)) - h * 2.0, row.bottom_at(0.0).max(row.bottom_at(w)));
    let near: Vec<&Comp> = ink.comps.iter().filter(|k| k.rect.bottom() > ya && k.rect.y < yb).collect();
    let dots: Vec<&Comp> = near.iter().copied().filter(|k| dot_like(k, h)).collect();
    let mut used: Vec<i32> = Vec::new();
    let debug = std::env::var("OMR_JP_DEBUG").is_ok();
    let in_note = |b: &Rect, nums: &[JpNum]| nums.iter().any(|n| b.x < n.bbox.right() && b.right() > n.bbox.x && b.y < n.bbox.bottom() && b.bottom() > n.bbox.y);

    // 临时升降号：紧贴数字左边、不比数字宽、顶不低于数字腰的一块，形状判得出 ♯ / ♭ / ♮
    let med_w = median(&out.nums.iter().map(|n| n.bbox.w).collect::<Vec<_>>(), h * 0.6);
    for i in 0..out.nums.len() {
        let nb = out.nums[i].bbox;
        if out.nums[i].digit == 0 || out.nums[i].digit == RHYTHM_DIGIT {
            continue;
        }
        let hit = near.iter().find(|k| {
            let b = &k.rect;
            let gap = nb.x - b.right();
            gap >= -h * 0.08
                && gap <= h * 0.35
                && b.h >= h * 0.4
                && b.h <= h * 1.15
                && b.w >= h * 0.18
                && b.w <= med_w * 1.0
                && b.cy() <= nb.cy() + h * 0.05
                && b.bottom() >= nb.y + h * 0.1
                && b.y >= nb.y - h * 0.7
                && !used.contains(&k.id)
                && !in_note(b, &out.nums)
        });
        let Some(k) = hit else { continue };
        let Some(kind) = accidental_of(ink, &k.rect) else { continue };
        // ♮ 与数字齐底的多半是别的字（「4」的右半、括号）
        if kind == "natural" && nb.bottom() - k.rect.bottom() < h * 0.1 {
            continue;
        }
        if debug {
            eprintln!("临时号 {kind} x{:.0} y{:.0} {:.0}x{:.0} → 音{}", k.rect.x, k.rect.y, k.rect.w, k.rect.h, out.nums[i].digit);
        }
        out.nums[i].accidental = Some(kind);
        used.push(k.id);
    }

    // 倚音：小一号的数字，底边贴着行带顶，底下压着减时线，右边紧跟着主音
    let mut graces: Vec<(usize, Rect, u32, i32)> = Vec::new();
    for k in &near {
        let b = &k.rect;
        if used.contains(&k.id) || b.h < h * 0.45 || b.h > h * 0.8 || b.w > med_w * 0.9 || b.w < h * 0.08 || in_note(b, &out.nums) {
            continue;
        }
        let top = row.top_at(b.cx());
        if b.bottom() > top + h * 0.25 || b.bottom() < top - h * 0.5 {
            continue;
        }
        let Some(owner) = out.nums.iter().position(|n| n.bbox.x >= b.right() - 2.0 && n.bbox.x - b.right() < h * 0.9) else { continue };
        // 底下压着几道减时线：逐行看有没有横贯小数字的墨段（≥ 0.8 宽），连着的几行算一道
        let (xa, xb) = ((b.x - b.w * 0.4).round() as i64, (b.right() + b.w * 0.4).round() as i64);
        let (mut div, mut in_run) = (0u32, false);
        for y in b.bottom().round() as i64 + 1..(b.bottom() + h * 0.6).round() as i64 {
            let (mut best, mut cur) = (0, 0);
            for x in xa..=xb {
                if ink.at(x, y) {
                    cur += 1;
                    best = best.max(cur);
                } else {
                    cur = 0;
                }
            }
            let wide = best as f64 >= b.w * 0.8;
            if wide && !in_run {
                div += 1;
            }
            in_run = wide;
        }
        if div == 0 || div > 3 {
            continue;
        }
        let dot = dots.iter().any(|o| (o.cx - b.cx()).abs() <= (b.w * 0.5).max(h * 0.2) && b.y - o.rect.bottom() >= -2.0 && b.y - o.rect.bottom() < h * 0.5);
        graces.push((owner, *b, div, dot as i32));
        used.push(k.id);
    }
    if !graces.is_empty() {
        let imgs: Vec<_> = graces.iter().map(|g| digit_cell(ink, &g.1)).collect();
        let texts = ocr.read_cells(&imgs).unwrap_or_else(|_| vec![String::new(); imgs.len()]);
        for (g, t) in graces.iter().zip(texts) {
            let t = t.trim();
            let Some(d) = t.chars().next().filter(|c| ('1'..='7').contains(c) && t.chars().count() == 1) else { continue };
            if debug {
                eprintln!("倚音 {d} x{:.0} y{:.0} 线{} → 音{}", g.1.x, g.1.y, g.2, out.nums[g.0].digit);
            }
            out.nums[g.0].grace.push(Grace { digit: d as u8 - b'0', octave: g.3, div: g.2, bbox: g.1 });
        }
        for n in &mut out.nums {
            n.grace.sort_by(|a, b| a.bbox.x.total_cmp(&b.bbox.x));
        }
    }

    // 数字头顶的记号
    for k in &near {
        let b = &k.rect;
        if used.contains(&k.id) || in_note(b, &out.nums) || b.bottom() > row.top_at(b.cx()) + h * 0.15 {
            continue;
        }
        let ratio = b.w / b.h;
        // 顿音 ▼：实心倒三角，逐行墨宽上宽下尖、一路不回头
        if b.w >= h * 0.2 && b.w <= h * 0.6 && b.h >= h * 0.2 && b.h <= h * 0.6 && (0.6..=1.6).contains(&ratio) && k.fill() >= 0.4 && k.fill() <= 0.75 {
            let ws: Vec<f64> = row_spans(ink, b).iter().map(|s| s.map_or(0.0, |s| s.1 - s.0 + 1.0)).collect();
            let tri = ws.len() >= 4 && ws[0] >= b.w * 0.8 && ws[ws.len() - 1] <= b.w * 0.4 && !ws.windows(2).any(|p| p[1] > p[0] + 1.0);
            if tri {
                if let Some(i) = owner_below(&out.nums, &[], b, h, 0.35, 0.1, 1.0, k.id) {
                    out.nums[i].articulation = Some("staccato");
                    used.push(k.id);
                    continue;
                }
            }
        }
        // 重音 >：空心、尖朝右的楔——右缘在中间几行最靠右，顶行底行缩回左半，中间行的左缘离开左边
        if b.w >= h * 0.25 && b.w <= h * 0.7 && b.h >= h * 0.2 && b.h <= h * 0.6 && (0.9..=2.2).contains(&ratio) && k.fill() <= 0.6 {
            let sp = row_spans(ink, b);
            if sp.len() >= 5 && sp.iter().all(|s| s.is_some()) {
                let sp: Vec<(f64, f64)> = sp.into_iter().flatten().collect();
                let n = sp.len();
                let mid = (0..n).max_by(|&a, &c| sp[a].1.total_cmp(&sp[c].1).then(c.cmp(&a))).unwrap();
                let wedge = (mid as f64) >= n as f64 * 0.25
                    && (mid as f64) <= n as f64 * 0.75
                    && sp[mid].1 >= b.w * 0.85 - 1.0
                    && sp[0].1 <= b.w * 0.55
                    && sp[n - 1].1 <= b.w * 0.55
                    && sp[0].0 <= b.w * 0.25
                    && sp[n - 1].0 <= b.w * 0.25
                    && sp[mid].0 >= b.w * 0.35;
                if wedge {
                    if let Some(i) = owner_below(&out.nums, &dots, b, h, 0.35, 0.1, 1.0, k.id) {
                        out.nums[i].articulation = Some("accent");
                        used.push(k.id);
                        continue;
                    }
                }
            }
        }
        // 波音：一个字宽的锯齿（大档）、小号的（宽不到 0.6 字号）；中间穿一道竖杠的是下波音
        let big = b.w >= h * 0.6 && b.w <= h * 1.4 && b.h >= h * 0.25 && b.h <= h * 0.6;
        let small = b.w >= h * 0.25 && b.w < h * 0.6 && b.h >= h * 0.12 && b.h < h * 0.3;
        if (big || small) && ratio >= 1.6 {
            if let Some(i) = owner_below(&out.nums, &dots, b, h, 0.4, 0.25, 0.5, k.id) {
                // 大档只罩一个音：圆滑线至少跨两个
                let two = big && out.nums.iter().enumerate().any(|(j, n)| j != i && n.bbox.cx() > b.x && n.bbox.cx() < b.right() && (n.bbox.cx() - out.nums[i].bbox.cx()).abs() >= h * 0.5);
                if !two && zigzag(ink, b, if big { b.h * 0.3 } else { 2.0 }, None) {
                    out.nums[i].ornament = Some("upper-mordent");
                    used.push(k.id);
                    continue;
                }
            }
        }
        if b.w >= h * 0.5 && b.w <= h * 1.4 && b.h >= h * 0.3 && b.h <= h * 1.0 && ratio >= 1.0 {
            if let Some(s) = center_stroke(ink, b, h) {
                // 锯齿在竖杠的中段：上下各去掉竖杠伸出去的一截再看
                let rows = row_spans(ink, b);
                let wide: Vec<usize> = rows.iter().enumerate().filter(|(_, r)| r.is_some_and(|r| r.1 - r.0 + 1.0 >= b.w * 0.5)).map(|(i, _)| i).collect();
                if let (Some(&a), Some(&e)) = (wide.first(), wide.last()) {
                    let core = Rect::new(b.x, b.y + a as f64, b.w, (e - a + 1) as f64);
                    if core.w / core.h >= 1.6 && zigzag(ink, &core, 2.0, Some(s)) {
                        if let Some(i) = owner_below(&out.nums, &dots, b, h, 0.4, 0.25, 0.5, k.id) {
                            out.nums[i].ornament = Some("lower-mordent");
                            used.push(k.id);
                            // 竖杠下端切出来的小点也不是八度点
                            used.extend(dots.iter().filter(|o| o.cx > b.x && o.cx < b.right() && o.cy > b.y - 1.0 && o.cy < b.bottom() + h * 0.2).map(|o| o.id));
                            continue;
                        }
                    }
                }
            }
        }
        // 弧尾粘着小号波音：弧形块两端各取 0.45 字号宽的窗照小号档判
        if b.w > h * 1.4 && b.h <= h * 0.7 {
            for left in [false, true] {
                let win = Rect::new(if left { b.x } else { b.right() - h * 0.45 }, b.y, h * 0.45, b.h);
                let Some(t) = ink.tight(&win) else { continue };
                if t.w / t.h < 1.6 || !zigzag(ink, &t, 2.0, None) {
                    continue;
                }
                if let Some(i) = owner_below(&out.nums, &dots, &t, h, 0.4, 0.25, 0.5, k.id) {
                    if out.nums[i].ornament.is_none() {
                        out.nums[i].ornament = Some("upper-mordent");
                    }
                }
            }
        }
        // 延长记号：拱起的小弧，弧下居中扣一个点，再下面紧跟着数字；只罩一个音
        if b.w >= h * 0.5 && b.w <= h * 1.6 && b.h <= h * 0.7 && ratio >= 1.3 && arched(ink, b, h) {
            let dot = dots.iter().find(|o| !used.contains(&o.id) && o.id != k.id && (o.cx - b.cx()).abs() <= h * 0.25 && o.rect.y >= b.y && o.rect.bottom() <= b.bottom() + h * 0.4);
            let Some(dot) = dot else { continue };
            let owner = out.nums.iter().position(|n| n.digit != RHYTHM_DIGIT && (n.bbox.cx() - b.cx()).abs() <= h * 0.4 && n.bbox.y - dot.rect.bottom() >= -h * 0.1 && n.bbox.y - dot.rect.bottom() <= h * 0.7);
            let Some(i) = owner else { continue };
            let two = out.nums.iter().enumerate().any(|(j, n)| j != i && n.bbox.right().min(b.right()) - n.bbox.x.max(b.x) >= n.bbox.w * 0.5);
            if two {
                continue;
            }
            out.nums[i].fermata = true;
            used.push(k.id);
            used.push(dot.id);
        }
    }
    if debug {
        let cnt = |f: &dyn Fn(&JpNum) -> bool| out.nums.iter().filter(|n| f(n)).count();
        eprintln!(
            "记号：升降 {}，倚音 {}，顿音 {}，重音 {}，波音 {}，延长 {}",
            cnt(&|n| n.accidental.is_some()),
            cnt(&|n| !n.grace.is_empty()),
            cnt(&|n| n.articulation == Some("staccato")),
            cnt(&|n| n.articulation == Some("accent")),
            cnt(&|n| n.ornament.is_some()),
            cnt(&|n| n.fermata)
        );
    }
    used
}
