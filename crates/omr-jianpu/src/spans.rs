//! JM5 线性符号：弧（圆滑线 / 延音线）。数字行上方的细墨逐列追踪成笔画（`omr-sheet::curves`，与五线谱同一层），
//! 朝上拱、两端落在音上的是弧；两端的音相邻且同音高的是延音线，其余是圆滑线。
use crate::frame::RowFrame;
use crate::notes::RowNotes;
use crate::frame::digit_cell;
use dolce_omr_core::image::Rect;
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
    let yb = (top_max + h * 0.25).ceil() as i64;
    let mut halves = Halves::default();
    if yb <= ya + 2 + (h * 0.25) as i64 || rn.nums.len() < 2 {
        return halves;
    }
    // 行的右界：末条小节线或末音右缘
    let row_right = rn.barline_xs.iter().copied().chain(rn.nums.iter().map(|n| n.bbox.right())).fold(f64::MIN, f64::max);
    let first_left = rn.nums[0].bbox.x;
    let hh = (yb - ya) as usize;
    let thin = (THIN * h).round().max(2.0) as i64;
    // 细墨掩膜：数字顶以上、纵向墨段不厚的墨
    let mut mask = vec![0u8; w * hh];
    // 数字之间的列放到数字顶下 0.25 字号：低平的弧两端落到与数字顶齐平（四声部圣哉三一歌「(1̇ 5)」）
    let gap = (h * 0.25).round() as i64;
    let in_num = |x: i64| rn.nums.iter().any(|n| x as f64 >= n.bbox.x - 2.0 && (x as f64) < n.bbox.right() + 2.0) || rn.barline_xs.iter().any(|&b| (b - x as f64).abs() <= h * 0.2);
    for x in 0..w as i64 {
        let lim = (row.top_at(x as f64) - 1.0).floor() as i64 + if x as f64 > first_left && (x as f64) < row_right && !in_num(x) { gap } else { 0 };
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
    arc_dots(ink, row, rn, &strokes, ya);
    // 候选弧：(左端音, 右端音, 宽, 弧顶中点)
    let mut found: Vec<(usize, usize, f64, (f64, f64))> = Vec::new();
    let mut flats: Vec<(usize, usize, f64, (f64, f64))> = Vec::new();
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
            if halves.open.is_none() && bx >= row_right - h * 0.3 && row.top_at(ax) - ay <= h && top <= ay - h * 0.1 && near(bx).is_none_or(|j| Some(j) == near(ax) || rn.nums[j].bbox.right() < ax) {
                if let Some(i) = near(ax) {
                    halves.open = Some(i);
                    continue;
                }
            }
            // 收在首音自己头上的短半弧（「(5,_ | 5,-)」行首那半截只从首音左缘外起笔、落在首音头顶）：左端也就近到首音
            let on_first = near(ax) == Some(0) && near(bx) == Some(0);
            if halves.head.is_none() && ax <= first_left && row.top_at(bx) - by <= h && top <= by - h * 0.1 && (on_first || near(ax).is_none_or(|i| i == 0 && rn.nums[0].bbox.x > bx)) {
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
        // 弧尾粘着小号波音（记号段已认出、挂在端上的音上，1771「(3 2̃)」）：波音的锯齿把回折量撑大，不看回折
        let orn_end = [sh.a.0, sh.b.0].iter().any(|&x| rn.nums.iter().any(|n| n.ornament.is_some() && (n.bbox.cx() - x).abs() <= h * 0.9));
        if !up || arch < h * MIN_ARCH || arch < s.width() * 0.025 || arch > h * 1.3 || (sh.back() > arch * 0.35 && !orn_end) || sh.thick > h * 0.2 || sh.peak < 0.12 || sh.peak > 0.88 {
            // 平直的方括号式连音括线「┌3┐」（青年诗歌 21 箭之歌）：拱不够、不是弧，只留作多连音候选——顶上读得出罩着的音数才算
            if arch < h * MIN_ARCH && s.width() >= h * 1.2 && sh.thick <= h * 0.2 && sh.slope().abs() <= 0.15 {
                let (ax, ay) = (sh.a.0, sh.a.1 + ya as f64);
                let (bx, by) = (sh.b.0, sh.b.1 + ya as f64);
                let near = |x: f64| rn.nums.iter().enumerate().map(|(i, n)| (i, (n.bbox.cx() - x).abs())).min_by(|a, b| a.1.total_cmp(&b.1)).filter(|p| p.1 <= h * 0.9).map(|p| p.0);
                let top = ay.min(by) - if up { arch } else { 0.0 };
                if row.top_at(ax) - ay <= h * 1.5 && row.top_at(bx) - by <= h * 1.5 {
                    if let (Some(i), Some(j)) = (near(ax), near(bx)) {
                        if j >= i + 2 {
                            flats.push((i, j, s.width(), ((ax + bx) / 2.0, top)));
                        }
                    }
                }
            }
            continue;
        }
        // 两端离数字顶不远（端上的音头顶有高音点的，弧架在点上方，再让出半个字号：爱主颂 95「(2̇ 3̇)」）
        let (ax, ay) = (sh.a.0, sh.a.1 + ya as f64);
        let (bx, by) = (sh.b.0, sh.b.1 + ya as f64);
        let near = |x: f64| rn.nums.iter().enumerate().map(|(i, n)| (i, (n.bbox.cx() - x).abs())).min_by(|a, b| a.1.total_cmp(&b.1)).filter(|p| p.1 <= h * 0.9).map(|p| p.0);
        // 端上的音头顶有高音点、波音的，弧架在它们上方，各再让出一截（迦南 2252「(3 2̃)」弧在波音上）
        let reach = |k: Option<usize>| h * (1.0 + if k.is_some_and(|k| rn.nums[k].octave > 0) { 0.5 } else { 0.0 } + if k.is_some_and(|k| rn.nums[k].ornament.is_some()) { 0.6 } else { 0.0 });
        // 弧为让开一端的记号整体抬高，两端都按让得多的那端算
        let lim = reach(near(ax)).max(reach(near(bx)));
        if row.top_at(ax) - ay > lim || row.top_at(bx) - by > lim || sh.slope().abs() > 0.35 {
            continue;
        }
        // 整体右偏半个音的排版（圣徒诗歌 11「(3 1) (6̣ 2)」弧脚起在首音右缘外）：按两端配的音组（弧宽对音距、整体偏移取一半，同 TS fitEnds）
        // 是一字多音的形、按最近端配的不是，就改用前者
        let fit = fit_ends(rn, ax, bx, h);
        let (i, j) = match (near(ax), near(bx), fit) {
            (Some(i), Some(j), Some(f)) if i < j && (i, j) != f => if melisma(rn, f) && !melisma(rn, (i, j)) { f } else { (i, j) },
            (Some(i), Some(j), _) if i < j => (i, j),
            (_, _, Some(f)) if melisma(rn, f) => f,
            _ => continue,
        };
        if found.iter().any(|f| f.0 == i && f.1 == j) {
            continue;
        }
        // 两道相邻的弧在中间音头上接成一笔、整笔仍朝上拱（迦南 2252「(2 (3) 3)」）：中间那个音上方是个谷——两边的拱顶都比谷底高出
        // 0.15 字号以上——在谷底劈成两道
        if j == i + 2 {
            let xm = rn.nums[i + 1].bbox.cx().round() as i64;
            let (x0, x1) = (s.x0, s.x1());
            let r = (h * 0.3).round() as i64;
            if xm - r > x0 && xm + r < x1 {
                let low = (xm - r..=xm + r).map(|x| s.mid(x)).fold(f64::MIN, f64::max);
                let peak = |a: i64, b: i64| (a..=b).map(|x| s.mid(x)).fold(f64::MAX, f64::min);
                let (pl, pr) = (peak(x0, xm - r), peak(xm + r, x1));
                if low - pl.max(pr) >= h * 0.15 {
                    for (p, q) in [(i, i + 1), (i + 1, j)] {
                        if !found.iter().any(|f| f.0 == p && f.1 == q) {
                            found.push((p, q, 0.0, ((ax + bx) / 2.0, ay.min(by))));
                        }
                    }
                    // 谷底正上方还有墨（外弧从上面过）：是外弧底下套着 V 形两道内弧（迦南 1940「((3 (2) 2))」，笔追的是内弧），外弧也留
                    let top_at_m = s.cols[(xm - x0) as usize].0 as i64 + ya;
                    let over = (pl.min(pr) as i64 + ya - (h * 0.3) as i64..top_at_m - 1).any(|y| ink.at(xm, y));
                    if !over {
                        continue;
                    }
                }
            }
        }
        found.push((i, j, s.width(), ((ax + bx) / 2.0, ay.min(by) - arch)));
    }
    // 中间断开、缺口里嵌小号数字的连音弧「⌒3⌒」（诗歌本 1）：左半往右升、右半往右落，缺口一个字号内、两半里端高低相近——拼成一道，只留作多连音候选
    {
        let near = |x: f64| rn.nums.iter().enumerate().map(|(i, n)| (i, (n.bbox.cx() - x).abs())).min_by(|a, b| a.1.total_cmp(&b.1)).filter(|p| p.1 <= h * 0.9).map(|p| p.0);
        let shapes: Vec<_> = strokes.iter().filter(|s| s.width() >= h * 0.5).map(|s| s.shape()).filter(|sh| sh.thick <= h * 0.2).collect();
        for l in &shapes {
            for r in &shapes {
                let gap = r.a.0 - l.b.0;
                if gap < 0.0 || gap > h || l.a.1 - l.b.1 < h * 0.1 || r.b.1 - r.a.1 < h * 0.1 || (l.b.1 - r.a.1).abs() > h * 0.5 {
                    continue;
                }
                let (ay, by) = (l.a.1 + ya as f64, r.b.1 + ya as f64);
                if row.top_at(l.a.0) - ay > h * 1.5 || row.top_at(r.b.0) - by > h * 1.5 {
                    continue;
                }
                if let (Some(i), Some(j)) = (near(l.a.0), near(r.b.0)) {
                    if j >= i + 2 {
                        flats.push((i, j, r.b.0 - l.a.0, ((l.b.0 + r.a.0) / 2.0, (l.b.1 + r.a.1) / 2.0 + ya as f64)));
                    }
                }
            }
        }
    }
    // 嵌套双弧（迦南诗选「((5_ (6_) 6))」）：外弧罩三个音，底下两道小弧从外弧上分出来、往中间那个音头顶落成一个 V，
    // 与外弧粘成一块，追笔画只追出外弧。中间那个音两侧各一个字号内逐列从数字顶往上数墨段（到外弧顶），一侧有 0.3 字号、另一侧 0.2 字号以上的列数出两段就是（八度点只占一两列）
    // 罩四个音的「((2 3) (3 2))」同理：左内弧往第二个音头顶落、右内弧从第三个音头顶起，各在那个音朝外弧中段的一侧数出两段（迦南 1782）
    for k in 0..found.len() {
        let (i, j, _, (_, my)) = found[k];
        let has_l = found.iter().any(|f| f.0 == i && f.1 == i + 1);
        let has_r = found.iter().any(|f| f.0 == i + 2 && f.1 == j);
        if j == i + 3 && !(has_l && has_r) {
            let cx = |n: usize| rn.nums[n].bbox.cx();
            let two_runs = |x: i64| {
                let mut runs = 0;
                let mut prev = false;
                let mut y = (row.top_at(x as f64) - 1.0).floor() as i64;
                while y as f64 >= my - h * 0.25 {
                    let on = ink.at(x, y);
                    if on && !prev {
                        runs += 1;
                    }
                    prev = on;
                    y -= 1;
                }
                runs >= 2
            };
            let side = |a: f64, b: f64| (a.ceil() as i64..=b.floor() as i64).filter(|&x| two_runs(x)).count() as f64;
            let (b, c) = (cx(i + 1), cx(i + 2));
            let (l, r) = (side((b - h).max((cx(i) + b) / 2.0), b - 1.0), side(c + 1.0, (c + h).min((c + cx(j)) / 2.0)));
            // 第二、三个音之间中段：「((2 3) (3 2))」两道内弧在这里各自落下、只剩外弧一段；
            // 「(3. (4 (3) 2))」第二道内弧整个架在这两个音上、外弧底下还有一段（迦南 1921，后一道内弧在末音处并进外弧）
            let mid = side(b + (c - b) * 0.25, c - (c - b) * 0.25);
            if std::env::var("OMR_ARC_DEBUG").is_ok() {
                eprintln!("  嵌套四 {i}-{j} 两段列 左{l} 右{r} 中{mid}");
            }
            if !has_l && !has_r && mid >= (c - b) * 0.5 * 0.6 {
                found.push((i + 1, i + 2, 0.0, ((b + c) / 2.0, my)));
                if l >= h * 0.3 {
                    found.push((i, i + 1, 0.0, ((cx(i) + b) / 2.0, my)));
                }
                if r >= h * 0.3 {
                    found.push((i + 2, j, 0.0, ((c + cx(j)) / 2.0, my)));
                }
                continue;
            }
            // 一侧的内弧已单独追出来的，另一侧够 0.3 字号就补
            let (add_l, add_r) = match (has_l, has_r) {
                (false, false) => {
                    let ok = l.min(r) >= h * 0.2 && l.max(r) >= h * 0.3;
                    (ok, ok)
                }
                (true, _) => (false, r >= h * 0.3),
                (_, true) => (l >= h * 0.3, false),
            };
            if add_l {
                found.push((i, i + 1, 0.0, ((cx(i) + b) / 2.0, my)));
            }
            if add_r {
                found.push((i + 2, j, 0.0, ((c + cx(j)) / 2.0, my)));
            }
            continue;
        }
        if j != i + 2 || found.iter().any(|f| (f.0 == i && f.1 == i + 1) || (f.0 == i + 1 && f.1 == j)) {
            continue;
        }
        let cx = |n: usize| rn.nums[n].bbox.cx();
        let two_runs = |x: i64| {
            let mut runs = 0;
            let mut prev = false;
            let mut y = (row.top_at(x as f64) - 1.0).floor() as i64;
            while y as f64 >= my - h * 0.25 {
                let on = ink.at(x, y);
                if on && !prev {
                    runs += 1;
                }
                prev = on;
                y -= 1;
            }
            runs >= 2
        };
        let m = cx(i + 1);
        // 弧顶中间立着小号数字的是三连音括线（数字也数得出两段），不按单侧内弧收
        let mx = (cx(i) + cx(j)) / 2.0;
        let numbered = ink.comps().iter().any(|k| {
            let b = &k.rect;
            (b.cx() - mx).abs() <= h * 0.5 && b.h >= h * 0.3 && b.h <= h * 0.8 && b.w >= h * 0.12 && b.w <= h * 0.6 && b.bottom() <= my + h * 0.45 && b.bottom() >= my - h * 0.35 && b.bottom() < row.top_at(b.cx())
        });
        let side = |a: f64, b: f64| (a.ceil() as i64..=b.floor() as i64).filter(|&x| two_runs(x)).count() as f64;
        let (l, r) = (side((m - h).max((cx(i) + m) / 2.0), m - 1.0), side(m + 1.0, (m + h).min((m + cx(j)) / 2.0)));
        if std::env::var("OMR_ARC_DEBUG").is_ok() {
            eprintln!("  嵌套 {i}-{j} 两段列 左{l} 右{r} 中{m:.0} 顶{my:.0} 字号{h:.0} 行顶{:.0}", row.top_at(m));
        }
        if l.max(r) >= h * 0.3 && l.min(r) >= h * 0.2 {
            found.push((i, i + 1, 0.0, ((cx(i) + m) / 2.0, my)));
            found.push((i + 1, j, 0.0, ((m + cx(j)) / 2.0, my)));
        } else if l >= h * 0.3 && r < h * 0.1 && !numbered {
            // 只一侧分出内弧（迦南 2252「(2_ (3_) 3)」：外弧下只有中间到末音那一道延音线）
            found.push((i, i + 1, 0.0, ((cx(i) + m) / 2.0, my)));
        } else if r >= h * 0.3 && l < h * 0.1 && !numbered {
            found.push((i + 1, j, 0.0, ((m + cx(j)) / 2.0, my)));
        }
    }
    // 多连音：弧顶上（或嵌在弧顶里）立着一个小号数字，读出来正是弧罩着的音数——组里各音记同一份比例，不再当圆滑线
    let mut tuplets: Vec<usize> = Vec::new();
    let n_arcs = found.len();
    let flats: Vec<_> = flats.into_iter().filter(|f| !found.iter().any(|g| g.0 == f.0 && g.1 == f.1)).collect();
    found.extend(flats);
    for (fi, &(i, j, _, (mx, my))) in found.iter().enumerate() {
        let cnt = j - i + 1;
        if !(3..=7).contains(&cnt) || rn.nums[i..=j].iter().any(|n| n.tuplet.is_some()) {
            continue;
        }
        let cand = ink.comps().iter().find(|k| {
            let b = &k.rect;
            (b.cx() - mx).abs() <= h * 0.5 && b.h >= h * 0.3 && b.h <= h * 0.8 && b.w >= h * 0.12 && b.w <= h * 0.6 && b.bottom() <= my + h * 0.45 && b.bottom() >= my - h * 0.35 && b.bottom() < row.top_at(b.cx())
        });
        // 数字压在弧（括线）顶上、与弧粘成一块的（第一声呼求前奏「⌐3⌐」）：没有单独的块，就在弧顶居中开一个字宽的窗读，
        // 窗里两侧的弧墨读成横杠，只看读出的数字
        let rect = match cand {
            Some(k) => k.rect,
            None => Rect::new(mx - h * 0.3, my - h * 0.6, h * 0.6, h * 0.85),
        };
        let img = if cand.is_some() { digit_cell(ink, &rect) } else { strip_line_cell(ink, &rect) };
        let Ok(t) = ocr.read_cells(&[img]) else { continue };
        let digits: String = t[0].chars().filter(|c| c.is_ascii_digit()).collect();
        if std::env::var("OMR_ARC_DEBUG").is_ok() {
            eprintln!("  连音数字 {i}-{j} 窗 {:.0},{:.0} {:.0}x{:.0} 单块{} 读「{}」", rect.x, rect.y, rect.w, rect.h, cand.is_some(), t[0]);
        }
        let ok = if cand.is_some() { t[0].trim() == cnt.to_string() } else { digits == cnt.to_string() && t[0].trim().chars().all(|c| c.is_ascii_digit() || "-_一—~".contains(c)) };
        if !ok {
            continue;
        }
        // 连音数字先被记号段当成了倚音（赞美诗歌 936「⌒3⌒」）：摘掉
        for n in rn.nums.iter_mut() {
            n.grace.retain(|g| !(g.bbox.right() > rect.x && g.bbox.x < rect.right() && g.bbox.bottom() > rect.y && g.bbox.y < rect.bottom()));
        }
        let actual = cnt as u32;
        let normal = if actual == 3 { 2 } else { 4 };
        for (k, n) in rn.nums[i..=j].iter_mut().enumerate() {
            n.tuplet = Some(Tuplet { actual, normal, start: k == 0, stop: k + 1 == cnt });
        }
        tuplets.push(fi);
    }
    let tuplet_spans: Vec<(usize, usize)> = tuplets.iter().filter(|&&fi| fi >= n_arcs).map(|&fi| (found[fi].0, found[fi].1)).collect();
    for (fi, (i, j, _, _)) in found.into_iter().enumerate() {
        if tuplets.contains(&fi) || fi >= n_arcs {
            continue;
        }
        // 拼出来的连音括线认了，它的半截不再当弧（「⌒3⌒」右半自己也罩得住两个音）
        if tuplet_spans.iter().any(|&(ti, tj)| i >= ti && j <= tj && j - i < tj - ti) {
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

/// 高音点粘在弧上（迦南 1850「6 1̇ 1̇」两条内弧在点上首尾相接、外弧的脚也压着它）：连通块里点不单独成块，数字顶上又隔着空白。
/// 在还没有八度点的音头顶开窗（中线左右 0.3 字号、往上 0.75 字号），扣掉弧笔画本身（每列笔画墨段上下各放一像素；笔画在点那几列
/// 断开、拼接时按两端连线补上的也算），剩下的墨按 4 邻接取团：贴着笔画、横向不碰窗边、近圆够实、宽高在 0.12~0.45 字号的是点。
/// 弧端陡下来那截竖墨扣不干净，剩的是瘦高条，过不了宽高比。
fn arc_dots(ink: &Ink, row: &RowFrame, rn: &mut RowNotes, strokes: &[Stroke], ya: i64) {
    let h = row.h();
    // 本行独立的点（八度点、附点）的中位宽：粘在弧上的点与它们一般大
    let wf = ink.w() as f64;
    let (ra, rb) = (row.top_at(0.0).min(row.top_at(wf)) - h * 1.2, row.bottom_at(0.0).max(row.bottom_at(wf)) + h * 1.6);
    let dws: Vec<f64> = ink.comps().iter().filter(|k| k.cy > ra && k.cy < rb && crate::notes::dot_like(k, h)).map(|k| k.rect.w).collect();
    if dws.is_empty() {
        return;
    }
    let dot_w = dolce_omr_core::geom::median(&dws, 0.0);
    // 各笔画的中线与半粗：墨段比笔画中位粗厚出一半以上的「胖列」（点粘在那儿）中线按两侧正常列插值，在端头的按端头走向外推
    let paths: Vec<(i64, Vec<f64>, f64)> = strokes
        .iter()
        .filter(|s| s.width() >= h * 0.3)
        .map(|s| {
            let th: Vec<f64> = s.cols.iter().map(|c| (c.1 - c.0 + 1) as f64).collect();
            let t = dolce_omr_core::geom::median(&th, 1.0);
            let fat: Vec<bool> = th.iter().map(|&v| v > t * 1.5 + 1.0).collect();
            let raw: Vec<f64> = s.cols.iter().map(|c| (c.0 + c.1) as f64 / 2.0).collect();
            let n = raw.len();
            let mut mids = raw.clone();
            let good: Vec<usize> = (0..n).filter(|&i| !fat[i]).collect();
            if !good.is_empty() {
                for i in (0..n).filter(|&i| fat[i]) {
                    let l = good.iter().rev().find(|&&g| g < i).copied();
                    let r = good.iter().find(|&&g| g > i).copied();
                    mids[i] = match (l, r) {
                        (Some(l), Some(r)) => raw[l] + (raw[r] - raw[l]) * (i - l) as f64 / (r - l) as f64,
                        (Some(l), None) => {
                            let l0 = good.iter().rev().nth(3.min(good.len() - 1)).copied().unwrap_or(l);
                            raw[l] + if l > l0 { (raw[l] - raw[l0]) / (l - l0) as f64 * (i - l) as f64 } else { 0.0 }
                        }
                        (None, Some(r)) => {
                            let r0 = good.get(3.min(good.len() - 1)).copied().unwrap_or(r);
                            raw[r] - if r0 > r { (raw[r0] - raw[r]) / (r0 - r) as f64 * (r - i) as f64 } else { 0.0 }
                        }
                        (None, None) => raw[i],
                    };
                }
            }
            (s.x0, mids, t / 2.0 + 1.0)
        })
        .collect();
    for n in rn.nums.iter_mut() {
        if n.octave != 0 || n.digit == 0 || n.digit == crate::result::RHYTHM_DIGIT {
            continue;
        }
        let cx = n.bbox.cx();
        // 窄字窗宽 ±0.4 字号（别的 ±0.3）：「1」上的点常偏到框心一侧，弧脚又从那侧落下来（青年诗歌 5「2̇⌒1̇」）
        let half = if n.bbox.w < h * 0.6 { 0.4 } else { 0.3 };
        let (xa, xb) = ((cx - h * half).round() as i64, (cx + h * half).round() as i64);
        let (wa, wb) = ((n.bbox.y - h * 0.75).round() as i64, n.bbox.y.round() as i64 - 1);
        if wb <= wa {
            continue;
        }
        let on_stroke = |x: i64, y: i64| {
            paths.iter().any(|(x0, mids, half)| x >= *x0 && x < x0 + mids.len() as i64 && (y as f64 - mids[(x - x0) as usize] - ya as f64).abs() <= *half)
        };
        let (ww, wh) = ((xb - xa + 1) as usize, (wb - wa + 1) as usize);
        let mut res = vec![0u8; ww * wh];
        let mut any_stroke = false;
        for y in wa..=wb {
            for x in xa..=xb {
                if ink.at(x, y) {
                    if on_stroke(x, y) {
                        any_stroke = true;
                    } else {
                        res[(y - wa) as usize * ww + (x - xa) as usize] = 1;
                    }
                }
            }
        }
        if !any_stroke {
            continue;
        }
        // 4 邻接取团
        let mut seen = vec![false; ww * wh];
        let mut found = false;
        for start in 0..ww * wh {
            if res[start] == 0 || seen[start] || found {
                continue;
            }
            let (mut x0, mut x1, mut y0, mut y1, mut touch) = (usize::MAX, 0, usize::MAX, 0, false);
            let mut stack = vec![start];
            seen[start] = true;
            while let Some(i) = stack.pop() {
                let (x, y) = (i % ww, i / ww);
                x0 = x0.min(x);
                x1 = x1.max(x);
                y0 = y0.min(y);
                y1 = y1.max(y);
                // 团按 4 邻接取；与笔画墨斜角相接也算粘着（连通块按 8 邻接，点只斜挨弧脚一角就与弧成了一块，1801「(1̇ 2̇)」）
                for (dx, dy) in [(-1i64, 0i64), (1, 0), (0, -1), (0, 1), (-1, -1), (1, -1), (-1, 1), (1, 1)] {
                    let (nx, ny) = (x as i64 + dx, y as i64 + dy);
                    if nx < 0 || ny < 0 || nx >= ww as i64 || ny >= wh as i64 {
                        continue;
                    }
                    let j = ny as usize * ww + nx as usize;
                    if dx == 0 || dy == 0 {
                        if res[j] == 1 && !seen[j] {
                            seen[j] = true;
                            stack.push(j);
                            continue;
                        }
                    }
                    if res[j] == 0 && ink.at(xa + nx, wa + ny) {
                        touch = true;
                    }
                }
            }
            // 连同那几列里与它连着的笔画墨一起量：点被笔画压去一条，剩的团是扁的
            let (mut ft, mut fb) = (y0 as i64 + wa, y1 as i64 + wa);
            for x in x0..=x1 {
                let gx = xa + x as i64;
                for y in y0..=y1 {
                    if res[y * ww + x] == 1 {
                        let gy = wa + y as i64;
                        let mut t = gy;
                        while ink.at(gx, t - 1) && gy - t < (h * 0.5) as i64 {
                            t -= 1;
                        }
                        let mut b = gy;
                        while ink.at(gx, b + 1) && b + 1 <= wb && b - gy < (h * 0.5) as i64 {
                            b += 1;
                        }
                        ft = ft.min(t);
                        fb = fb.max(b);
                    }
                }
            }
            let (bw, bh) = ((x1 - x0 + 1) as f64, (fb - ft + 1) as f64);
            let filled = (ft..=fb).map(|y| (xa + x0 as i64..=xa + x1 as i64).filter(|&x| ink.at(x, y)).count()).sum::<usize>() as f64;
            let area = filled as usize;
            let y1 = (fb - wa) as usize;
            let edge = x0 == 0 || x1 == ww - 1;
            let gap = (wb - (wa + y1 as i64)) as f64;
            if std::env::var("OMR_DOT_DEBUG").is_ok() && area >= 4 && touch && !edge {
                eprintln!("  弧点 音x{:.0} 团{bw}x{bh} 实{:.2} 隔{gap} 点宽{dot_w}", cx, area as f64 / (bw * bh));
            }
            // 挂在括线、弧端竖钩下的点（「⌐3⌐」三连音括线两端，第一声呼求前奏）：团是棒棒糖形——底下一个本行点那么宽（九成以上，弧端的笔尖窄）的方块实而圆，上面是比点窄一半的细颈
            let lolly = bh > bw * 1.65 && bw >= dot_w * 0.9 && {
                let (xa0, xa1) = (xa + x0 as i64, xa + x1 as i64);
                let head = (fb - bw.round() as i64 + 1..=fb).map(|y| (xa0..=xa1).filter(|&x| ink.at(x, y)).count()).sum::<usize>() as f64;
                let neck: Vec<f64> = (ft..fb - bw.round() as i64).map(|y| (xa0..=xa1).filter(|&x| ink.at(x, y)).count() as f64).collect();
                head >= bw * bw * 0.7 && !neck.is_empty() && dolce_omr_core::geom::median(&neck, 0.0) <= bw * 0.5
            };
            // 夹在弧脚与数字顶之间、上下都粘着的点（青年诗歌 5「3̇⌒」）：团连着弧墨量，墨略稀；宽正是本行点宽、不比宽高出四成就收
            let snug = gap < 1.0 && bw >= dot_w * 0.9 && bw <= dot_w * 1.2 && bh <= bw * 1.4 && area as f64 >= bw * bh * 0.6;
            if touch && !edge && bw >= h * 0.12 && bh >= h * 0.12 && bw >= dot_w * 0.6 && bw <= dot_w * 1.5 && (lolly || (bh <= bw * 1.65 && bw / bh <= 1.8 && area as f64 >= bw * bh * 0.7) || snug) && gap >= if snug { 0.0 } else { 1.0 } && gap <= h * 0.6 {
                found = true;
                if std::env::var("OMR_DOT_DEBUG").is_ok() {
                    eprintln!("  弧点收 音x{:.0} y{:.0} 团{bw}x{bh} 实{:.2} 隔{gap} 点宽{dot_w}", cx, n.bbox.y, filled / (bw * bh));
                }
            }
        }
        if found {
            n.octave = 1;
        }
    }
}

/// 房子（判据照 TS `repeats.ts::endingCandidates`）：谱行上方一道够长（≥ 6 字号）、与本行音的横向范围交叠过半的横墨，
/// 左端有下垂的立脚（房括号 ⌐ 必有；歌词、弧、减时线这些长横墨没有）。窗口从数字顶上 3.4 字号起（行内有弧时括线被顶得很高），
/// 不越过上一行音底下半个字号（那里是上一行的减时线）。房号是括线左端内侧连着的一串小块，逐块读数；读不出时按阅读序 1、2 轮。
/// 括线罩着的头一个音记 `ending_start`、末一个音记 `ending_stop`。
pub fn endings(ink: &Ink, rows: &[RowFrame], notes: &mut [RowNotes], ocr: &CachedOcr) {
    let w = ink.w() as i64;
    let mut found: Vec<(usize, Rect, Vec<Rect>)> = Vec::new();
    for (ri, rn) in notes.iter().enumerate() {
        if rn.nums.is_empty() {
            continue;
        }
        let num_h = dolce_omr_core::geom::median(&rn.nums.iter().map(|n| n.bbox.h).collect::<Vec<_>>(), rows[ri].h());
        let row_top = dolce_omr_core::geom::median(&rn.nums.iter().map(|n| n.bbox.y).collect::<Vec<_>>(), 0.0);
        let (nx0, nx1) = (rn.nums[0].bbox.x, rn.nums[rn.nums.len() - 1].bbox.right());
        let prev_bottom = if ri > 0 { notes[ri - 1].nums.iter().map(|n| n.bbox.bottom()).fold(f64::MIN, f64::max) } else { f64::MIN };
        let y0 = (row_top - num_h * 3.4).floor().max((prev_bottom + num_h * 0.5).ceil()).max(0.0) as i64;
        let y1 = (row_top - num_h * 0.3).ceil() as i64;
        let mut runs: Vec<Rect> = Vec::new();
        for y in y0..=y1 {
            let (mut start, mut last) = (-1i64, -1i64);
            for x in 0..=w {
                let on = x < w && ink.at(x, y);
                if on {
                    if start < 0 {
                        start = x;
                    }
                    last = x;
                }
                if start >= 0 && ((!on && x - last > 1) || x == w) {
                    let rw = (last - start + 1) as f64;
                    let ov = ((last + 1) as f64).min(nx1) - (start as f64).max(nx0);
                    if rw >= num_h * 6.0 && ov >= rw.min(nx1 - nx0) * 0.5 {
                        runs.push(Rect::new(start as f64, y as f64, rw, 1.0));
                    }
                    start = -1;
                    last = -1;
                }
            }
        }
        // 一道横线一到三像素厚，相邻几行重复出现：每段只留最长的
        runs.sort_by(|a, b| b.w.total_cmp(&a.w));
        let mut uniq: Vec<Rect> = Vec::new();
        for r in runs {
            if !uniq.iter().any(|u| (r.right().min(u.right()) - r.x.max(u.x)).max(0.0) >= r.w.min(u.w) * 0.8 && (r.y - u.y).abs() <= 3.0) {
                uniq.push(r);
            }
        }
        for b in uniq {
            // 左端下垂的立脚
            let need = (num_h * 0.35).round().max(2.0) as i64;
            let hook = (b.x as i64..=(b.x as i64 + (num_h * 0.25).round().max(1.0) as i64)).any(|x| {
                let mut run = 0;
                (b.y as i64..(b.y + num_h * 1.6) as i64).any(|y| {
                    run = if ink.at(x, y) { run + 1 } else { 0 };
                    run >= need
                })
            });
            if !hook {
                continue;
            }
            let mut near: Vec<&Rect> = ink
                .comps()
                .iter()
                .map(|k| &k.rect)
                .filter(|r| r.cx() >= b.x - num_h * 0.1 && r.cx() <= b.x + num_h * 5.0 && r.cy() >= b.y - num_h * 0.2 && r.cy() <= b.y + num_h * 0.9 && r.h >= num_h * 0.18 && r.h <= num_h * 0.9 && r.w <= num_h * 0.9)
                .collect();
            near.sort_by(|a, b| a.x.total_cmp(&b.x));
            // 号与号之间的点（`1.`）只有数字三成高；断在头一个大空当
            let h_max = near.iter().map(|r| r.h).fold(0.0, f64::max);
            let mut labels: Vec<Rect> = Vec::new();
            for r in near {
                if r.h < h_max * 0.55 {
                    continue;
                }
                if labels.last().is_some_and(|l| r.x - l.right() > num_h * 1.2) {
                    break;
                }
                labels.push(*r);
            }
            found.push((ri, b, labels));
        }
    }
    found.sort_by(|a, b| a.1.y.total_cmp(&b.1.y).then(a.1.x.total_cmp(&b.1.x)));
    let imgs: Vec<_> = found.iter().flat_map(|f| f.2.iter().map(|r| digit_cell(ink, r))).collect();
    let texts = ocr.read_cells(&imgs).unwrap_or_else(|_| vec![String::new(); imgs.len()]);
    let mut at = 0;
    for (i, (ri, b, labels)) in found.iter().enumerate() {
        let mut nums: Vec<u8> = Vec::new();
        for t in &texts[at..at + labels.len()] {
            if let Some(d) = crate::frame::digit_of(t).filter(|d| (1..=7).contains(d)) {
                if !nums.contains(&d) {
                    nums.push(d);
                }
            }
        }
        at += labels.len();
        if nums.is_empty() {
            nums.push((i % 2) as u8 + 1);
        }
        let number = nums.iter().map(|d| d.to_string()).collect::<Vec<_>>().join(",");
        let rn = &mut notes[*ri];
        let num_h = rows[*ri].h();
        let covered: Vec<usize> = (0..rn.nums.len()).filter(|&k| rn.nums[k].bbox.cx() >= b.x - num_h * 0.5 && rn.nums[k].bbox.cx() <= b.right() + num_h * 0.5).collect();
        let (Some(&a), Some(&z)) = (covered.first(), covered.last()) else { continue };
        rn.nums[a].ending_start = Some(number.clone());
        rn.nums[z].ending_stop = Some(number);
    }
}

/// 窗里横穿两边的线（括线、弧）抹掉、只留数字：两侧窗边一两像素内都有墨的行是线行；线行以外有墨的列是数字的横向范围，
/// 裁到这个范围（线行在范围外的墨随之裁掉）送检。
fn strip_line_cell(ink: &Ink, r: &Rect) -> dolce_omr_ocr::surface::Gray {
    let (x0, y0, x1, y1) = (r.x.round() as i64, r.y.round() as i64, r.right().round() as i64, r.bottom().round() as i64);
    let edge = |y: i64, xs: std::ops::RangeInclusive<i64>| xs.into_iter().any(|x| ink.at(x, y));
    let line: Vec<bool> = (y0..y1).map(|y| edge(y, x0..=x0 + 1) && edge(y, x1 - 2..=x1 - 1)).collect();
    let cols: Vec<i64> = (x0..x1).filter(|&x| (y0..y1).enumerate().any(|(k, y)| !line[k] && ink.at(x, y))).collect();
    let (Some(&a), Some(&b)) = (cols.first(), cols.last()) else { return digit_cell(ink, r) };
    let (w, h) = ((b - a + 1) as usize, (y1 - y0) as usize);
    let mut g = dolce_omr_ocr::surface::Gray::new(w, h, 255);
    for (k, y) in (y0..y1).enumerate() {
        for x in a..=b {
            if ink.at(x, y) {
                g.data[k * w + (x - a) as usize] = 0;
            }
        }
    }
    dolce_omr_ocr::surface::fit_cell(&trim_gray(&g))
}

/// 裁掉四周的白边。
fn trim_gray(g: &dolce_omr_ocr::surface::Gray) -> dolce_omr_ocr::surface::Gray {
    let ink = |x: usize, y: usize| g.data[y * g.w + x] < 128;
    let rows: Vec<usize> = (0..g.h).filter(|&y| (0..g.w).any(|x| ink(x, y))).collect();
    let cols: Vec<usize> = (0..g.w).filter(|&x| (0..g.h).any(|y| ink(x, y))).collect();
    let (Some(&t), Some(&bt), Some(&l), Some(&rt)) = (rows.first(), rows.last(), cols.first(), cols.last()) else { return g.clone() };
    let (w, h) = (rt - l + 1, bt - t + 1);
    let mut out = dolce_omr_ocr::surface::Gray::new(w, h, 255);
    for y in 0..h {
        for x in 0..w {
            out.data[y * w + x] = g.data[(y + t) * g.w + x + l];
        }
    }
    out
}

/// 按弧的两端配起止音：弧宽对音距、整体偏移取一半（同 TS fitEnds）。
fn fit_ends(rn: &RowNotes, ax: f64, bx: f64, h: f64) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize, f64)> = None;
    for (i, a) in rn.nums.iter().enumerate() {
        let dl = ax - a.bbox.cx();
        if dl.abs() > h * 1.2 {
            continue;
        }
        for (j, b) in rn.nums.iter().enumerate().skip(i + 1) {
            let dr = bx - b.bbox.cx();
            if dr.abs() > h * 1.2 {
                continue;
            }
            let cost = (dr - dl).abs() + (dl + dr).abs() / 2.0;
            if best.is_none_or(|b| cost < b.2) {
                best = Some((i, j, cost));
            }
        }
    }
    best.map(|b| (b.0, b.1))
}

/// 一字多音的形：起音有词、其后各音在各段都没词。
fn melisma(rn: &RowNotes, (i, j): (usize, usize)) -> bool {
    let has = |k: usize| rn.nums[k].lyrics.iter().any(|t| !t.is_empty());
    j > i && has(i) && (i + 1..=j).all(|k| !has(k))
}
