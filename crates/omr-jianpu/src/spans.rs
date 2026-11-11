//! JM5 线性符号：弧（圆滑线 / 延音线）。数字行上方的细墨逐列追踪成笔画（`omr-sheet::curves`，与五线谱同一层），
//! 朝上拱、两端落在音上的是弧；两端的音相邻且同音高的是延音线，其余是圆滑线。
use crate::frame::RowFrame;
use crate::notes::RowNotes;
use crate::frame::digit_cell;
use crate::prep::Ink;
use crate::result::Tuplet;
use dolce_omr_ocr::cache::CachedOcr;
use dolce_omr_sheet::curves::{join_all, trace, JoinTol, Stroke};

/// 细墨：纵向墨段不厚过这么多（相对字号）。
const THIN: f64 = 0.22;
/// 弧最窄、拱最矮（相对字号）。
const MIN_W: f64 = 0.7;
const MIN_ARCH: f64 = 0.08;

/// 一行谱上方的弧，记到两端的音上。`y_min`：上方带的顶（上一行的歌词底）。
pub fn arcs(ink: &Ink, row: &RowFrame, rn: &mut RowNotes, y_min: f64, ocr: &CachedOcr) {
    let h = row.h();
    let w = ink.bin.w;
    let wf = w as f64;
    let top_min = row.top_at(0.0).min(row.top_at(wf));
    let top_max = row.top_at(0.0).max(row.top_at(wf));
    let ya = y_min.max(top_min - h * 1.5).max(0.0) as i64;
    let yb = top_max.ceil() as i64;
    if yb <= ya + 2 || rn.nums.len() < 2 {
        return;
    }
    let hh = (yb - ya) as usize;
    let thin = (THIN * h).round().max(2.0) as i64;
    // 细墨掩膜：数字顶以上、纵向墨段不厚的墨
    let mut mask = vec![0u8; w * hh];
    for x in 0..w as i64 {
        let lim = (row.top_at(x as f64) - 1.0).floor() as i64;
        let mut y = ya;
        while y < lim.min(yb) {
            if !ink.at(x, y) {
                y += 1;
                continue;
            }
            let a = y;
            while ink.at(x, y) {
                y += 1;
            }
            // 墨段从上面的带外伸进来的（上一行的字）也按整段长算
            let mut top = a;
            while a == ya && ink.at(x, top - 1) && a - top <= thin {
                top -= 1;
            }
            if y - top <= thin && y <= lim + 1 {
                for yy in a..y.min(yb) {
                    mask[(yy - ya) as usize * w + x as usize] = 1;
                }
            }
        }
    }
    let raw = trace(&mask, w, hh, (h * 0.15).max(3.0) as usize);
    let tol = JoinTol { max_gap: (h * 0.45) as i64, dy: h * 0.12, dy_per_gap: 0.35, span: (h * 0.3).max(3.0) as usize };
    let strokes: Vec<Stroke> = join_all(raw, tol, &|_, _| true);
    // 候选弧：(左端音, 右端音, 宽, 弧顶中点)
    let mut found: Vec<(usize, usize, f64, (f64, f64))> = Vec::new();
    for s in &strokes {
        if s.width() < h * MIN_W {
            continue;
        }
        let sh = s.shape();
        let (arch, up) = sh.arch();
        if !up || arch < h * MIN_ARCH || arch < s.width() * 0.025 || arch > h * 1.3 || sh.back() > arch * 0.35 || sh.thick > h * 0.2 || sh.peak < 0.12 || sh.peak > 0.88 {
            continue;
        }
        // 两端离数字顶不远
        let (ax, ay) = (sh.a.0, sh.a.1 + ya as f64);
        let (bx, by) = (sh.b.0, sh.b.1 + ya as f64);
        if row.top_at(ax) - ay > h * 1.0 || row.top_at(bx) - by > h * 1.0 || sh.slope().abs() > 0.35 {
            continue;
        }
        let near = |x: f64| rn.nums.iter().enumerate().map(|(i, n)| (i, (n.bbox.cx() - x).abs())).min_by(|a, b| a.1.total_cmp(&b.1)).filter(|p| p.1 <= h * 0.9).map(|p| p.0);
        let (Some(i), Some(j)) = (near(ax), near(bx)) else { continue };
        if i >= j || found.iter().any(|f| f.0 == i && f.1 == j) {
            continue;
        }
        found.push((i, j, s.width(), ((ax + bx) / 2.0, ay.min(by) - arch)));
    }
    // 多连音：弧顶上（或嵌在弧顶里）立着一个小号数字，读出来正是弧罩着的音数——组里各音记同一份比例，不再当圆滑线
    let mut tuplets: Vec<usize> = Vec::new();
    for (fi, &(i, j, _, (mx, my))) in found.iter().enumerate() {
        let cnt = j - i + 1;
        if !(3..=7).contains(&cnt) || rn.nums[i..=j].iter().any(|n| n.tuplet.is_some()) {
            continue;
        }
        let cand = ink.comps.iter().find(|k| {
            let b = &k.rect;
            (b.cx() - mx).abs() <= h * 0.5 && b.h >= h * 0.3 && b.h <= h * 0.8 && b.w >= h * 0.12 && b.w <= h * 0.6 && b.bottom() <= my + h * 0.45 && b.bottom() >= my - h * 0.35 && b.bottom() < row.top_at(b.cx())
        });
        let Some(k) = cand else { continue };
        let Ok(t) = ocr.read_cells(&[digit_cell(ink, &k.rect)]) else { continue };
        if t[0].trim() != cnt.to_string() {
            continue;
        }
        let actual = cnt as u32;
        let normal = if actual == 3 { 2 } else { 4 };
        for (k, n) in rn.nums[i..=j].iter_mut().enumerate() {
            n.tuplet = Some(Tuplet { actual, normal, start: k == 0, stop: k + 1 == cnt });
        }
        tuplets.push(fi);
    }
    for (fi, (i, j, _, _)) in found.into_iter().enumerate() {
        if tuplets.contains(&fi) {
            continue;
        }
        let (a, b) = (&rn.nums[i], &rn.nums[j]);
        let tie = j == i + 1 && a.digit == b.digit && a.octave == b.octave && a.digit != 0;
        if tie {
            rn.nums[i].tie_start = true;
            rn.nums[j].tie_stop = true;
        } else {
            rn.nums[i].slur_start += 1;
            rn.nums[j].slur_stop += 1;
        }
    }
}
