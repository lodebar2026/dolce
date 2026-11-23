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
    accidental_of_by(&|x, y| ink.at(x, y), b)
}

/// 同 [`accidental_of`]，墨由 `at` 给（粘连块重分后只看本块的墨）。
fn accidental_of_by(at: &dyn Fn(i64, i64) -> bool, b: &Rect) -> Option<&'static str> {
    struct P<'a>(&'a dyn Fn(i64, i64) -> bool);
    impl P<'_> {
        fn at(&self, x: i64, y: i64) -> bool {
            (self.0)(x, y)
        }
    }
    let ink = P(at);
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

/// 粘连的临时号：窗取数字左边一个半数字宽（不越过左邻音）、数字顶上 0.7 到数字底上 0.2 字高，扣掉各音的框，
/// 窗里重分 8 邻接块；块左头只有一道细墨（拖进来的弧笔）的列削掉。剩下的块要悬高（底比数字底高出 0.2 字高以上）、
/// 碰着窗顶窗底的块不算（被窗切开的连谱号、竖线）。尺寸在临时号那一档（高 0.45~1.1、宽 0.3~1.5 数字）、离数字不过 0.5 字号，形状判得出 ♯ / ♭。
fn glued_accidental(ink: &Ink, nums: &[JpNum], i: usize, med_h: f64, med_w: f64, h: f64) -> Option<(Rect, &'static str)> {
    use dolce_omr_core::pixel::ccl::connected_components;
    let nb = nums[i].bbox;
    let left = if i > 0 && nums[i - 1].bbox.right() < nb.x { nums[i - 1].bbox.right() + 1.0 } else { nb.x - med_w * 1.5 };
    let x0 = left.max(nb.x - med_w * 1.5).max(0.0).round() as i64;
    // 窗左界是左邻音的右缘时，从左边拖进来的弧笔是那个音的；否则碰着窗左界的是窗外的大块（连谱号的钩）
    let left_is_note = i > 0 && nums[i - 1].bbox.right() + 1.0 >= nb.x - med_w * 1.5;
    let x1 = nb.x.round() as i64;
    let y0 = (nb.y - med_h * 0.7).max(0.0).round() as i64;
    let y1 = (nb.bottom() - med_h * 0.2).round() as i64;
    if x1 - x0 < 3 || y1 - y0 < 3 {
        return None;
    }
    let (w, hh) = ((x1 - x0) as usize, (y1 - y0) as usize);
    let inside = |x: f64, y: f64| nums.iter().any(|n| x >= n.bbox.x && x < n.bbox.right() && y >= n.bbox.y && y < n.bbox.bottom());
    let mut data = vec![0u8; w * hh];
    for y in 0..hh {
        for x in 0..w {
            let (gx, gy) = (x0 + x as i64, y0 + y as i64);
            if ink.at(gx, gy) && !inside(gx as f64, gy as f64) {
                data[y * w + x] = 1;
            }
        }
    }
    let mut labels = vec![0i32; w * hh];
    let flat = connected_components(&data, w, hh, 1.0, &mut labels);
    if std::env::var("OMR_ACC_DEBUG").is_ok() {
        eprintln!("  粘连窗 音{} 窗 x{x0}-{x1} y{y0}-{y1} 块数{}", nums[i].digit, flat.len() / 8);
    }
    let thin = (med_h * 0.12).max(2.0);
    for (ci, c) in flat.chunks(8).enumerate() {
        let lab = ci as i32 + 1;
        let (cx0, cy0, cw, ch) = (c[1] as usize, c[2] as usize, c[3] as usize, c[4] as usize);
        // 碰着窗顶、窗底的是被窗切开的大块（连谱号的钩、竖线）
        if cy0 == 0 || cy0 + ch >= hh || (cx0 == 0 && !left_is_note) {
            continue;
        }
        // 左头只有一道细墨的列削掉（拖进来的弧笔）
        let col = |x: usize| {
            let (mut runs, mut long, mut cur) = (0, 0usize, 0usize);
            for y in cy0..cy0 + ch {
                if labels[y * w + x] == lab {
                    if cur == 0 {
                        runs += 1;
                    }
                    cur += 1;
                    long = long.max(cur);
                } else {
                    cur = 0;
                }
            }
            (runs, long)
        };
        let mut a = cx0;
        while a < cx0 + cw && { let (r, l) = col(a); r <= 1 && (l as f64) <= thin } {
            a += 1;
        }
        if a >= cx0 + cw {
            continue;
        }
        // 削过的块重量上下界
        let ys: Vec<usize> = (cy0..cy0 + ch).filter(|&y| (a..cx0 + cw).any(|x| labels[y * w + x] == lab)).collect();
        let (Some(&t), Some(&bt)) = (ys.first(), ys.last()) else { continue };
        let r = Rect::new((x0 + a as i64) as f64, (y0 + t as i64) as f64, (cx0 + cw - a) as f64, (bt - t + 1) as f64);
        let gap = nb.x - r.right();
        if std::env::var("OMR_ACC_DEBUG").is_ok() {
            eprintln!("  粘连窗 音{} 块 {:.0}x{:.0} @{:.0},{:.0} 缝{gap:.0} 底高出{:.0} 形{:?}", nums[i].digit, r.w, r.h, r.x, r.y, nb.bottom() - r.bottom(), accidental_of_by(&|gx, gy| { let (x, y) = (gx - x0, gy - y0); x >= a as i64 && x < w as i64 && y >= 0 && y < hh as i64 && labels[y as usize * w + x as usize] == lab }, &r));
        }
        if r.h < med_h * 0.45 || r.h > med_h * 1.1 || r.w < med_w * 0.3 || r.w > med_w * 1.5 || gap > h * 0.5 || nb.bottom() - r.bottom() < med_h * 0.2 || r.bottom() < nb.y + med_h * 0.1 {
            continue;
        }
        // 削掉的弧笔不能留在形状判里：按窗里的标号图另画一份只含本块的墨
        let only = |gx: i64, gy: i64| {
            let (x, y) = (gx - x0, gy - y0);
            x >= a as i64 && x < w as i64 && y >= 0 && y < hh as i64 && labels[y as usize * w + x as usize] == lab
        };
        let kind = accidental_of_by(&only, &r);
        if let Some(k @ ("sharp" | "flat")) = kind {
            return Some((r, k));
        }
    }
    None
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
/// 行所在的版式：连谱号括着的声部行、声部页上没归进系统的行、单声部页的行。临时号的放宽门按它分。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowCtx {
    Single,
    InSystem,
    VoicedLoose,
}

impl RowCtx {
    fn in_voiced_page(self) -> bool {
        self != RowCtx::Single
    }
}

/// 高悬又窄的 ♯ 最高到数字的几倍（同 TS `TALL_SHARP_H`）。
const TALL_SHARP_H: f64 = 1.6;

pub fn apply(ink: &Ink, row: &RowFrame, out: &mut RowNotes, ocr: &CachedOcr, ctx: RowCtx) -> Vec<i32> {
    let h = row.h();
    let w = ink.w() as f64;
    let (ya, yb) = (row.top_at(0.0).min(row.top_at(w)) - h * 2.0, row.bottom_at(0.0).max(row.bottom_at(w)));
    let near: Vec<&Comp> = ink.comps().iter().filter(|k| k.rect.bottom() > ya && k.rect.y < yb).collect();
    let dots: Vec<&Comp> = near.iter().copied().filter(|k| dot_like(k, h)).collect();
    let mut used: Vec<i32> = Vec::new();
    let debug = std::env::var("OMR_JP_DEBUG").is_ok();
    let acc_debug = std::env::var("OMR_ACC_DEBUG").is_ok();
    let in_note = |b: &Rect, nums: &[JpNum]| nums.iter().any(|n| b.x < n.bbox.right() && b.right() > n.bbox.x && b.y < n.bbox.bottom() && b.bottom() > n.bbox.y);

    // 临时升降号（判据照 TS `jianpu.ts` 临时号一节）：紧贴数字左边、形状判得出 ♯ / ♭ / ♮ 的一块。
    // 尺子用本行数字的中位高 / 宽（带高被骑在上方的记号撑大）；宽度尺子不算「1」（窄竖笔，满是 1 的行中位宽只剩竖笔宽）。
    let med_w_all = median(&out.nums.iter().map(|n| n.bbox.w).collect::<Vec<_>>(), h * 0.6);
    let med_h = median(&out.nums.iter().filter(|n| n.digit != 0 && n.digit != RHYTHM_DIGIT).map(|n| n.bbox.h).collect::<Vec<_>>(), h * 0.65);
    let wide: Vec<f64> = out.nums.iter().map(|n| n.bbox.w).filter(|&w| w >= med_h * 0.45).collect();
    let med_w = median(if wide.is_empty() { &[] } else { &wide[..] }, h * 0.6);
    // 脚下压着减时线的是倚音的小号数字（形似 ♯）：块底两行起扫到底下 0.15 字高，有一行墨占满九成宽
    let underlined = |b: &Rect| {
        let (x0, x1) = (b.x.round() as i64, b.right().round() as i64);
        (b.bottom().round() as i64 - 2..=(b.bottom() + med_h * 0.15).round() as i64).any(|y| ((x0..x1).filter(|&x| ink.at(x, y)).count() as f64) >= b.w * 0.9)
    };
    let bar_xs: Vec<f64> = out.barline_xs.iter().chain(&out.double_bar_xs).chain(&out.end_bar_xs).copied().collect();
    let on_bar = |b: &Rect| row.bars().any(|c| (c.x0 as f64) <= b.right() && (c.x1 as f64) >= b.x) || bar_xs.iter().any(|&x| x >= b.x - 1.0 && x <= b.right() + 1.0);
    for i in 0..out.nums.len() {
        let nb = out.nums[i].bbox;
        if out.nums[i].digit == 0 || out.nums[i].digit == RHYTHM_DIGIT || nb.h < med_h * 0.85 {
            continue;
        }
        let mut found: Option<(i32, &'static str)> = None;
        for k in &near {
            let b = &k.rect;
            let gap = nb.x - b.right();
            // 记号与右邻数字纵向得交叠一截（和弦行、上一行的字在上方）；小节线格不是记号
            let paren = out.parens.iter().any(|p| p.x < b.right() && p.right() > b.x && p.y < b.bottom() && p.bottom() > b.y);
            if gap < -h * 0.08 || gap > h * 1.0 || used.contains(&k.id) || in_note(b, &out.nums) || b.right() > nb.cx() || b.bottom() < nb.y + med_h * 0.1 || on_bar(b) || paren {
                continue;
            }
            let top_up = nb.y - b.y; // 顶比数字高出
            let bot_up = nb.bottom() - b.bottom(); // 底比数字底高出
            let shape = || accidental_of(ink, b);
            if acc_debug {
                eprintln!("  临时号候选 {:.0}x{:.0} @{:.0},{:.0} → 音{} {:.0}x{:.0}（中位 {med_h:.0}高 {med_w:.0}宽）缝{gap:.0} 顶高出{top_up:.0} 底高出{bot_up:.0} 形{:?} 压线{}", b.w, b.h, b.x, b.y, out.nums[i].digit, nb.w, nb.h, shape(), underlined(b));
            }
            let sharp = || shape() == Some("sharp") && !underlined(b);
            // 高悬的大 ♯（比数字还高、整个悬在右邻上方）；又高又窄的 ♯（底不垂到数字底下）。只在单声部行
            if !ctx.in_voiced_page() && b.h >= med_h * 0.95 && top_up >= med_h * 0.25 && gap >= 0.0 {
                let tall_hung = b.h <= med_h * 1.45 && b.w <= med_w * 1.2 && bot_up >= med_h * 0.3 && gap <= h * 1.0;
                let tall_narrow = b.h <= med_h * TALL_SHARP_H && b.w <= med_w * 0.85 && bot_up >= 0.0 && gap <= h * 0.5;
                if (tall_hung || tall_narrow) && sharp() {
                    found = Some((k.id, "sharp"));
                    break;
                }
            }
            if b.h > med_h * 1.25 {
                continue;
            }
            let hung_low = bot_up >= med_h * 0.2;
            let hung_both = b.h <= med_h * 1.1 && top_up >= med_h * 0.25 && bot_up >= med_h * 0.3;
            let raised = b.h < med_h * 0.9 || hung_both;
            let gate = match ctx {
                RowCtx::InSystem => raised,
                RowCtx::VoicedLoose => b.h < med_h * 0.8,
                RowCtx::Single => hung_both,
            };
            let wide_sharp = gate && hung_low && b.w <= med_w * 1.5 && sharp();
            // 上标小 ♭：矮、整个悬在右邻上半截
            let small_flat = b.h <= med_h * 0.7 && bot_up >= med_h * 0.35 && b.w <= med_w * 1.5 && shape() == Some("flat") && !underlined(b);
            if b.w > med_w * 0.85 && !wide_sharp && !small_flat {
                continue;
            }
            if b.h < med_h * 0.45 || b.w < med_w * 0.3 {
                continue;
            }
            let hung_sharp = hung_low && top_up >= med_h * 0.2 && sharp();
            if gap > h * (if wide_sharp || small_flat || hung_sharp { 0.5 } else { 0.35 }) {
                continue;
            }
            // 印在音符左上角：顶不低于数字顶下 0.15、底不垂到数字底下
            if b.y > nb.y + med_h * 0.15 || b.bottom() > nb.bottom() + med_h * 0.1 {
                continue;
            }
            let Some(kind) = shape() else { continue };
            // ♮ 要悬高：与数字齐底的多半是别的字（「1」紧贴下一个数字、「4」的右半、括号）
            if kind == "natural" && bot_up < med_h * 0.1 {
                continue;
            }
            found = Some((k.id, kind));
            break;
        }
        if found.is_none() {
            // 粘在别的墨上的记号（弧笔从左邻数字拖到 ♯ 上，整块挂在左邻音上）：在数字左上开窗、窗里重分连通块再按形状认
            if let Some((r, kind)) = glued_accidental(ink, &out.nums, i, med_h, med_w, h) {
                if debug {
                    eprintln!("临时号（粘连）{kind} x{:.0} y{:.0} {:.0}x{:.0} → 音{}", r.x, r.y, r.w, r.h, out.nums[i].digit);
                }
                if !underlined(&r) {
                    out.nums[i].accidental = Some(kind);
                }
            }
            continue;
        }
        let Some((id, kind)) = found else { continue };
        if debug {
            let r = near.iter().find(|k| k.id == id).unwrap().rect;
            eprintln!("临时号 {kind} x{:.0} y{:.0} {:.0}x{:.0} → 音{}", r.x, r.y, r.w, r.h, out.nums[i].digit);
        }
        out.nums[i].accidental = Some(kind);
        used.push(id);
    }

    // 倚音：小一号的数字，底边贴着行带顶，底下压着减时线，右边紧跟着主音
    let mut graces: Vec<(usize, Rect, u32, i32)> = Vec::new();
    for k in &near {
        let b = &k.rect;
        if used.contains(&k.id) || b.h < h * 0.45 || b.h > h * 0.8 || b.w > med_w_all * 0.9 || b.w < h * 0.08 || in_note(b, &out.nums) {
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
            out.mark_ink.extend([k.id, dot.id]);
        }
    }
    // 下滑音 ↘（同 TS fallOf，迦南诗选 2252「5⌒6↘ 3」）：数字右上紧挨着一笔向右下弯的细线、末端带箭头。与数字靠笔画粗细分——
    // 逐行墨段的中位宽不到左邻数字的六成；下部四成里最宽的一行至少是上部箭杆中位宽的 1.8 倍（箭头）；高 0.5~1.05 字高、不比数字宽出八成，
    // 顶不低于数字顶下 0.2 字高、底收在数字底线上方 0.1 字高
    let run_med = |b: &Rect| {
        let mut runs: Vec<f64> = Vec::new();
        for y in b.y.round() as i64..b.bottom().round() as i64 {
            let mut n = 0;
            for x in b.x.round() as i64..=b.right().round() as i64 {
                if x < b.right().round() as i64 && ink.at(x, y) {
                    n += 1;
                } else if n > 0 {
                    runs.push(n as f64);
                    n = 0;
                }
            }
        }
        median(&runs, 0.0)
    };
    for i in 0..out.nums.len() {
        let pb = out.nums[i].bbox;
        if out.nums[i].digit == 0 || pb.h < med_h * 0.85 {
            continue;
        }
        let next_x = out.nums.get(i + 1).map_or(f64::MAX, |n| n.bbox.x);
        let hit = near.iter().find(|k| {
            let b = &k.rect;
            let gap = b.x - pb.right();
            !used.contains(&k.id) && !in_note(b, &out.nums) && b.right() < next_x && gap >= -h * 0.05 && gap <= h * 0.3 && b.h >= med_h * 0.5 && b.h <= med_h * 1.05 && b.w <= pb.w * 0.8
                && b.y <= pb.y + med_h * 0.2 && b.bottom() <= pb.bottom() - med_h * 0.1
                // 箭头在行带里切成了格（与数字同高、读不出数，或没归上类）：块得罩着行里一个没成音的格
                && row.cells.iter().any(|c| matches!(c.kind, crate::frame::CellKind::Digit | crate::frame::CellKind::Other) && (c.x0 as f64) < b.right() && (c.x1 as f64) >= b.x && !out.nums.iter().any(|n| (n.bbox.cx() - c.cx()).abs() < 1.0))
        });
        let Some(k) = hit else { continue };
        let b = k.rect;
        let (rm, pm) = (run_med(&b), run_med(&pb));
        if rm <= 0.0 || rm > pm * 0.6 {
            continue;
        }
        let rows: Vec<f64> = (b.y.round() as i64..b.bottom().round() as i64).map(|y| (b.x.round() as i64..b.right().round() as i64).filter(|&x| ink.at(x, y)).count() as f64).collect();
        let cut = (b.h * 0.6).round() as usize;
        let shaft = median(&rows[..cut.min(rows.len())].iter().copied().filter(|&v| v > 0.0).collect::<Vec<_>>(), 0.0);
        if shaft <= 0.0 || rows[cut.min(rows.len())..].iter().copied().fold(0.0, f64::max) < shaft * 1.8 {
            continue;
        }
        if debug {
            eprintln!("下滑音 x{:.0} y{:.0} {:.0}x{:.0} → 音{}", b.x, b.y, b.w, b.h, out.nums[i].digit);
        }
        out.nums[i].fall = true;
        used.push(k.id);
    }
    // 延长记号的弧粘在上方的字上（和弦「Dm」的 D 底压着弧，青年诗歌 91）：弧不单独成块，上面那条认不出，点就被收成高音点。
    // 改从点认：音头顶（0.7 字号内）居中的一个点，点正上方 0.6 字号内有墨（弧顶）、点与弧顶之间空着，
    // 从弧顶顺着笔画往两边一路平着或往下走，走到 0.3 字号开外落到点的高度（弧脚）
    for i in 0..out.nums.len() {
        let n = &out.nums[i];
        if n.fermata || n.digit == 0 || n.digit == RHYTHM_DIGIT {
            continue;
        }
        let nb = n.bbox;
        let Some(dot) = dots.iter().find(|o| !used.contains(&o.id) && (o.cx - nb.cx()).abs() <= h * 0.25 && nb.y - o.rect.bottom() >= -h * 0.1 && nb.y - o.rect.bottom() <= h * 0.7) else { continue };
        let r = dot.rect;
        let (cy, dy0) = (r.cy().round() as i64, r.y.round() as i64);
        let cx = r.cx().round() as i64;
        let top = (dy0 - (h * 0.6) as i64..dy0).rev().find(|&y| ink.at(cx, y));
        let gap = top.is_some_and(|t| dy0 - t >= 2 && (t + 1..dy0).all(|y| !ink.at(cx, y)));
        // 从弧顶顺着笔画往两边走：每列取紧挨着上一列的那截墨的底沿，只许平着或往下（一列至多落 2 像素、不许回升），走到 0.3 字号开外落到点的高度
        let leg = |dir: i64| {
            let Some(mut y) = top else { return false };
            let (reach, lo) = ((h * 0.6).round() as i64, cy - (h * 0.2) as i64);
            for k in 1..=reach {
                let x = cx + dir * k;
                let Some(ny) = (y - 1..=y + 2).rev().find(|&yy| ink.at(x, yy) && !ink.at(x, yy + 1)) else { return false };
                y = ny;
                if (k as f64) >= h * 0.3 && y >= lo {
                    return true;
                }
            }
            false
        };
        if gap && leg(-1) && leg(1) {
            if debug {
                eprintln!("延长记号（弧粘别的墨）点 x{:.0} y{:.0} → 音{}", r.x, r.y, out.nums[i].digit);
            }
            out.nums[i].fermata = true;
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

/// segno 𝄋（跳转目标，同 TS `detectSegno`）：不是文字，OCR 够不着，按形认——主体是一块空心的 S（一个字号上下、窄于高、墨占框 28%~62%），
/// 斜笔两侧各扣一颗小圆点（对角两侧），或直立的 S 左右齐半高夹着两颗点（`·S·`，青年诗歌 4）。上方带里别的东西（和弦、段落词、房号、倚音）
/// 都凑不出「一块空心斜体 + 两颗孤立圆点」。左右一个字号内另有字号级墨块的是字的一半（选本 375 书眉「难」的「又」）。
/// 锚到正下方最近的音（写出端提升为该小节左线上的记号：D.S. 跳回来落在这条线上）。
pub fn segno(ink: &Ink, rows: &[RowFrame], notes: &mut [RowNotes], num_h: f64) {
    let comps = ink.comps();
    let small = |d: &Comp| {
        let s = d.rect.w.max(d.rect.h);
        s >= num_h * 0.08 && s <= num_h * 0.3
    };
    for (ri, _) in rows.iter().enumerate() {
        let rn = &notes[ri];
        if rn.nums.is_empty() {
            continue;
        }
        let row_top = rn.nums.iter().map(|n| n.bbox.y).fold(f64::MAX, f64::min);
        let (y0, y1, y_diag) = (row_top - num_h * 4.0, row_top - num_h * 0.2, row_top - num_h * 2.8);
        let mut hits: Vec<(usize, Vec<i32>)> = Vec::new();
        for k in comps {
            let b = &k.rect;
            if b.bottom() > y1 || b.y < y0 {
                continue;
            }
            if b.h < num_h * 0.85 || b.h > num_h * 1.6 || b.w < num_h * 0.45 || b.w > num_h * 1.1 {
                continue;
            }
            let aspect = b.w / b.h;
            if !(0.45..=1.0).contains(&aspect) || !(0.28..=0.62).contains(&k.fill()) {
                continue;
            }
            let cy = b.cy();
            let side: Vec<&Comp> = comps.iter().filter(|d| d.id != k.id && small(d) && (d.rect.cy() - cy).abs() <= b.h * 0.3).collect();
            let l = side.iter().filter(|d| d.rect.right() <= b.x && d.rect.right() >= b.x - num_h * 0.7).map(|d| d.rect.x).fold(f64::MAX, f64::min);
            let r = side.iter().filter(|d| d.rect.x >= b.right() && d.rect.x <= b.right() + num_h * 0.7).map(|d| d.rect.right()).fold(f64::MIN, f64::max);
            let pad = num_h * 0.2;
            let near: Vec<&Comp> = comps.iter().filter(|d| d.id != k.id && small(d) && d.rect.cx() >= b.x - pad && d.rect.cx() <= b.right() + pad && d.rect.cy() >= b.y - pad && d.rect.cy() <= b.bottom() + pad).collect();
            let form_side = l < f64::MAX && r > f64::MIN;
            let form_diag = !form_side && {
                let above: Vec<&&Comp> = near.iter().filter(|d| d.rect.cy() < cy).collect();
                let below: Vec<&&Comp> = near.iter().filter(|d| d.rect.cy() > cy).collect();
                above.iter().any(|a| below.iter().any(|z| (a.rect.cx() - z.rect.cx()).abs() >= num_h * 0.2 && (a.rect.cy() - z.rect.cy()).abs() >= num_h * 0.1))
            };
            if !form_side && !form_diag {
                continue;
            }
            if form_diag && b.y < y_diag {
                continue;
            }
            let (sx0, sx1) = if form_side { (l, r) } else { (b.x - num_h, b.right() + num_h) };
            if comps.iter().any(|o| o.id != k.id && o.rect.w.max(o.rect.h) > num_h * 0.4 && o.rect.bottom().min(b.bottom()) - o.rect.y.max(b.y) > b.h * 0.3 && o.rect.x < sx1 && o.rect.right() > sx0) {
                continue;
            }
            let cx = b.cx();
            let Some(best) = rn.nums.iter().position(|n| n.bbox.right() >= cx - num_h * 1.5) else { continue };
            let pad_x = if form_side { num_h * 0.7 } else { num_h * 0.2 };
            let mut ids = vec![k.id];
            ids.extend(comps.iter().filter(|d| d.id != k.id && d.rect.w.max(d.rect.h) <= num_h * 0.3 && d.rect.cx() >= b.x - pad_x && d.rect.cx() <= b.right() + pad_x && d.rect.cy() >= b.y - num_h * 0.2 && d.rect.cy() <= b.bottom() + num_h * 0.2).map(|d| d.id));
            hits.push((best, ids));
        }
        let rn = &mut notes[ri];
        for (best, ids) in hits {
            rn.nums[best].segno = true;
            rn.mark_ink.extend(ids);
        }
    }
}
