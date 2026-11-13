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

/// 跨行圆滑线的两半：一条弧跨过换行时画成两半——上一行行末一段拖到右界（开口），下一行行首一段从首音左缘之前起笔（收口）。
#[derive(Clone, Copy, Debug, Default)]
pub struct Halves {
    /// 开口弧起在这个音上
    pub open: Option<usize>,
    /// 收口弧收在这个音上
    pub head: Option<usize>,
}

/// 相邻两行一头开口、一头收口的配成一条跨行圆滑线。单有一头的不记（TS `slur.ts` 跨行圆滑线同判据）。
pub fn pair_halves(notes: &mut [RowNotes], halves: &[Halves]) {
    for i in 0..halves.len().saturating_sub(1) {
        if let (Some(a), Some(b)) = (halves[i].open, halves[i + 1].head) {
            notes[i].nums[a].slur_start += 1;
            notes[i + 1].nums[b].slur_stop += 1;
        }
    }
}

/// 一行谱上方的弧，记到两端的音上。`y_min`：上方带的顶（上一行的歌词底）。回这一行的跨行半弧，留给 [`pair_halves`] 配对。
pub fn arcs(ink: &Ink, row: &RowFrame, rn: &mut RowNotes, y_min: f64, ocr: &CachedOcr) -> Halves {
    let h = row.h();
    let w = ink.w();
    let wf = w as f64;
    let top_min = row.top_at(0.0).min(row.top_at(wf));
    let top_max = row.top_at(0.0).max(row.top_at(wf));
    let ya = y_min.max(top_min - h * 1.5).max(0.0) as i64;
    let yb = top_max.ceil() as i64;
    let mut halves = Halves::default();
    if yb <= ya + 2 || rn.nums.len() < 2 {
        return halves;
    }
    // 行的右界：末条小节线或末音右缘
    let row_right = rn.barline_xs.iter().copied().chain(rn.nums.iter().map(|n| n.bbox.right())).fold(f64::MIN, f64::max);
    let first_left = rn.nums[0].bbox.x;
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
    let dbg = std::env::var("OMR_ARC_DEBUG").is_ok();
    for s in &strokes {
        if dbg && s.width() >= h * 0.3 {
            let sh = s.shape();
            let (arch, up) = sh.arch();
            eprintln!("  笔 x{:.0}-{:.0} y{:.0}/{:.0} 宽{:.0} 拱{arch:.1} 上{up} 回{:.1} 粗{:.1} 峰{:.2}", sh.a.0, sh.b.0, sh.a.1 + ya as f64, sh.b.1 + ya as f64, s.width(), sh.back(), sh.thick, sh.peak);
        }
        let sh = s.shape();
        // 跨行的半弧：细、两端都离数字顶不远、从音那头往外拱起（最高处比落音那头高 0.1 字号以上）。
        // 开口弧右端顶到行右界（行内正常收尾的弧离右界还差一个音）；收口弧左端起在首音左缘之前（行内起弧的从首音质心附近起笔）
        if s.width() >= h * 0.5 && sh.thick <= h * 0.2 && sh.back() <= h * 0.15 {
            let (ax, ay) = (sh.a.0, sh.a.1 + ya as f64);
            let (bx, by) = (sh.b.0, sh.b.1 + ya as f64);
            let top = s.top() as f64 + ya as f64;
            let near = |x: f64| rn.nums.iter().enumerate().map(|(i, n)| (i, (n.bbox.cx() - x).abs())).min_by(|a, b| a.1.total_cmp(&b.1)).filter(|p| p.1 <= h * 0.9).map(|p| p.0);
            if halves.open.is_none() && bx >= row_right - h * 0.3 && row.top_at(ax) - ay <= h && top <= ay - h * 0.1 && near(bx).is_none_or(|j| rn.nums[j].bbox.right() < ax) {
                if let Some(i) = near(ax) {
                    halves.open = Some(i);
                    continue;
                }
            }
            if halves.head.is_none() && ax <= first_left && row.top_at(bx) - by <= h && top <= by - h * 0.1 && near(ax).is_none_or(|i| i == 0 && rn.nums[0].bbox.x > bx) {
                if let Some(j) = near(bx) {
                    halves.head = Some(j);
                    continue;
                }
            }
        }
        if s.width() < h * MIN_W {
            continue;
        }
        let (arch, up) = sh.arch();
        // M 形：两道相邻的小弧在中间那个音上接成一笔，整笔中间凹下去（嵌在一道大弧底下的「((2 (3) 3))」）——在中间的音处劈成两道
        if !up && arch >= h * MIN_ARCH && sh.thick <= h * 0.2 {
            let (ax, bx) = (sh.a.0, sh.b.0);
            let (ay, by) = (sh.a.1 + ya as f64, sh.b.1 + ya as f64);
            if row.top_at(ax) - ay <= h * 1.0 && row.top_at(bx) - by <= h * 1.0 {
                let near = |x: f64| rn.nums.iter().enumerate().map(|(i, n)| (i, (n.bbox.cx() - x).abs())).min_by(|a, b| a.1.total_cmp(&b.1)).filter(|p| p.1 <= h * 0.9).map(|p| p.0);
                let mid = rn.nums.iter().enumerate().filter(|(_, n)| n.bbox.cx() > ax + h * 0.3 && n.bbox.cx() < bx - h * 0.3).min_by(|a, b| (a.1.bbox.cx() - (ax + bx) / 2.0).abs().total_cmp(&(b.1.bbox.cx() - (ax + bx) / 2.0).abs())).map(|p| p.0);
                if let (Some(i), Some(m), Some(j)) = (near(ax), mid, near(bx)) {
                    if i < m && m < j && j - i == 2 {
                        for (p, q) in [(i, m), (m, j)] {
                            if !found.iter().any(|f| f.0 == p && f.1 == q) {
                                found.push((p, q, 0.0, ((ax + bx) / 2.0, ay.min(by))));
                            }
                        }
                    }
                }
            }
            continue;
        }
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
        let cand = ink.comps().iter().find(|k| {
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
    halves
}
