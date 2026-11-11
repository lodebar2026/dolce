//! **找谱表**：逐列的黑白游程里找「五段细黑、四段间距相等」，串成轨迹，一行谱的五条线随 x 走（共用一条偏移曲线）。
//!
//! 不用行投影：行投影要一整行几乎全是墨，页面一斜一弯就抹平（2000 像素宽的页斜 0.5° 两端差一个线距）；
//! 逐列量的五连等距与页面斜不斜、弯不弯无关。歌词笔画、噪声凑不出五段等距的黑白相间。
//! 识别不推平、不纠斜：交出的谱表带曲线，下游一律按谱表局部坐标（`Staff::pos`）读。
use dolce_omr_core::geom::median;
use dolce_omr_core::image::Binary;
use dolce_omr_sheet::{LineCurve, Staff, Unit};
use std::sync::Arc;

/// 逐列取样的步长（像素）：谱线横跨整页，抽稀不影响。
const COL_STEP: usize = 4;
/// 线距下限（像素）；上限随长边放（高分辨率图线距能到六十来像素）。
const MIN_SPACE: f64 = 6.0;
const MAX_SPACE: f64 = 40.0;
/// 五连四个间距彼此的相对偏差上限。
const EVEN_TOL: f64 = 0.22;
/// 一段黑最厚多少（相对线距）：更厚的是符头、符杠、黑边。
const MAX_THICK: f64 = 0.45;
/// 候选线距离全页中位数超过这么多不要（同一页可能两种谱表大小）。
const SPACE_TOL: f64 = 0.2;
/// 同一轨迹相邻两次命中，中心 y 至多挪多少（相对线距）。
const TRACK_STEP: f64 = 0.5;
/// 五连的首末两条线要往左右都延续：在这几处（相对线距）各探一下有没有墨。加线只有两格来长，一条加线 + 四条谱线凑出的假五连过不了。
const CONT_PROBES: [f64; 2] = [1.6, 2.6];
/// 轨迹允许中断的宽度（相对线距）：密集的音符、符杠会把几列遮住。
const TRACK_GAP: f64 = 3.0;
/// 两截轨迹中心差不过这么多格：横向不重叠是同一行谱断成几截，重叠的是错开一条线凑出的假五连。
const SAME_STAFF: f64 = 2.5;
/// 一行谱至少有这么多取样列量到五连（占页宽取样列的比例，另有下限）。
const STAFF_SUPPORT: f64 = 0.12;
const MIN_COLS: usize = 16;
/// 偏移曲线的滑动中位数窗口（取样列数）。
const SMOOTH: usize = 9;
/// 谱行左右端内偏移起伏不过这么多像素（且整体不过一像素）的不挂曲线。
const FLAT_SPREAD: f64 = 1.5;
/// 往两头验墨定左右端：五条线里至少几条有墨才算谱线还在。
const EXTENT_LINES: usize = 4;

/// 一列上量到的五连。
#[derive(Clone, Debug)]
struct Hit {
    x: usize,
    ys: [f64; 5],
    space: f64,
    thick: f64,
}

impl Hit {
    fn cy(&self) -> f64 {
        self.ys[2]
    }
}

/// 五连的首末线在左右两边都接着走（见 `CONT_PROBES`）。探到图外的那一侧不查；斜页容上下各半格。
fn continues(bin: &Binary, h: &Hit) -> bool {
    let r = (h.space * 0.5).round() as i64;
    [h.ys[0], h.ys[4]].iter().all(|&y| {
        [-1.0, 1.0].iter().all(|&dir| {
            CONT_PROBES.iter().all(|&d| {
                let x = h.x as f64 + dir * d * h.space;
                if x < 0.0 || x >= bin.w as f64 {
                    return true;
                }
                (-r..=r).any(|dy| bin.ink(x as i64, y.round() as i64 + dy))
            })
        })
    })
}

/// 找一页的谱表；一行都凑不出（封面、歌词页、简谱页）回 None。谱表自上而下排好。
pub fn find_staves(bin: &Binary) -> Option<(Unit, Vec<Staff>)> {
    let max_space = MAX_SPACE.max((bin.w.max(bin.h) / 50) as f64);
    let hits = column_hits(bin, max_space);
    if hits.len() < 20 {
        return None;
    }
    let space = median(&hits.iter().map(|h| h.space).collect::<Vec<_>>(), 0.0);
    let hits: Vec<Hit> = hits.into_iter().filter(|h| (h.space - space).abs() <= space * SPACE_TOL && continues(bin, h)).collect();
    let cols = bin.w.div_ceil(COL_STEP);
    let mut tracks = build_tracks(hits, space);
    tracks.sort_by_key(|t| std::cmp::Reverse(t.len()));

    // 按量到的列数从多到少收：与已收的横向重叠又挨着的是错开一条线的假五连，丢；横向不重叠的是同一行谱的另一截，并进去
    struct Row {
        hits: Vec<Hit>,
        cy: f64,
        x0: usize,
        x1: usize,
    }
    let mut rows: Vec<Row> = Vec::new();
    // 短截也收（压满符杠的谱行逐列五连断成许多几列长的小截），拼完再按列数筛
    for t in tracks {
        let cy = median(&t.iter().map(Hit::cy).collect::<Vec<_>>(), 0.0);
        let (x0, x1) = (t[0].x, t[t.len() - 1].x);
        let near: Vec<usize> = (0..rows.len()).filter(|&i| (rows[i].cy - cy).abs() < space * SAME_STAFF).collect();
        if near.iter().any(|&i| x0 <= rows[i].x1 && x1 >= rows[i].x0) {
            continue;
        }
        // 同一行谱被密集音符隔断的几截：比**相邻两端**的中心（斜、弯的谱行两截各自的中位数可以差过一格），
        // 容半格加上两端间距的 2%（页面倾斜）
        let joins = |r: &Row| {
            let (a, b) = if r.x1 < x0 { (r.hits.iter().max_by_key(|h| h.x).unwrap().cy(), t[0].cy()) } else { (r.hits.iter().min_by_key(|h| h.x).unwrap().cy(), t[t.len() - 1].cy()) };
            let gap = if r.x1 < x0 { x0 - r.x1 } else { r.x0.saturating_sub(x1) };
            (a - b).abs() <= space * TRACK_STEP + gap as f64 * 0.02
        };
        if let Some(&i) = near.iter().filter(|&&i| joins(&rows[i])).min_by(|&&a, &&b| (rows[a].cy - cy).abs().total_cmp(&(rows[b].cy - cy).abs())) {
            {
                let r = &mut rows[i];
                r.hits.extend(t);
                r.x0 = r.x0.min(x0);
                r.x1 = r.x1.max(x1);
                continue;
            }
        }
        rows.push(Row { hits: t, cy, x0, x1 });
    }

    let need = MIN_COLS.max((cols as f64 * STAFF_SUPPORT) as usize);
    let mut staves = Vec::new();
    for r in rows {
        let mut xs: Vec<usize> = r.hits.iter().map(|h| h.x).collect();
        xs.dedup();
        if xs.len() < need {
            continue;
        }
        staves.push(make_staff(bin, &r.hits, r.x0, r.x1, cols));
    }
    if staves.is_empty() {
        return None;
    }
    staves.sort_by(|a, b| a.ys[0].total_cmp(&b.ys[0]));
    // 同一行谱认成两行（两截都往外验墨延到整行）：横向重叠、首线在重叠段中点差不过半格的，留横跨更长的那行
    let mut keep: Vec<Staff> = Vec::new();
    for s in staves {
        let dup = keep.iter_mut().find(|k| {
            let (l, r) = (k.left.max(s.left), k.right.min(s.right));
            l < r && (k.top((l + r) / 2.0) - s.top((l + r) / 2.0)).abs() < space * 0.5
        });
        match dup {
            Some(k) if s.right - s.left > k.right - k.left => *k = s,
            Some(_) => {}
            None => keep.push(s),
        }
    }
    let mut staves = keep;
    let thicks: Vec<f64> = staves.iter().flat_map(|s| s.thick).collect();
    let spaces: Vec<f64> = staves.iter().map(Staff::space).collect();
    let unit = Unit { space: median(&spaces, 0.0), thick: median(&thicks, 1.0) };
    let ones = single_line_staves(bin, &staves, &unit);
    if !ones.is_empty() {
        staves.extend(ones);
        staves.sort_by(|a, b| a.ys[0].total_cmp(&b.ys[0]));
    }
    Some((unit, staves))
}

/// 单线谱：横线够长（不短过本页五线谱表宽的这个比例）。
const ONE_LINE_LEN: f64 = 0.35;
/// 单线谱：沿线逐列线带里有墨的占比下限（实线连着；歌词延长的虚线一半是空）。
const ONE_LINE_FILL: f64 = 0.85;
/// 单线谱：小节线上下各伸出至少这么多格（照五线谱表的高度印；符干只伸一边），至多这么多格（再长是穿过两行之间的贯穿小节线）。
const ONE_LINE_BAR: f64 = 1.2;
const ONE_LINE_BAR_MAX: f64 = 3.0;
/// 单线谱：上下一格、两格处平行走着的线沿线有墨过这么多，是没认出来的五线谱行里的一条。
const ONE_LINE_SIBLING: f64 = 0.4;

/// **单线谱（打击乐）**：五线谱表之外一道细实横线，带两根以上上下对称穿过它的小节线。判据全是结构：
/// 逐列细游程且上下各 0.4 格内空、串成够长的一道、沿线逐列有墨（歌词延长虚线过不了）、上下一两格处没有平行的线（漏检的五线谱行）、
/// 两根以上上下各伸 `ONE_LINE_BAR`~`ONE_LINE_BAR_MAX` 格的竖笔穿过（小节线；符干只往一边伸，页框、标题下划线没有；
/// 钢琴两行之间的长渐强线也有贯穿小节线穿过，但伸得更远）。
/// 建成五线谱表：实线当第三线，上下四条按本页线距补出（`one_line`）——这种谱的小节线、谱号照五线谱表的高度印，判据照五线走。
fn single_line_staves(bin: &Binary, staves: &[Staff], unit: &Unit) -> Vec<Staff> {
    let (w, h) = (bin.w, bin.h);
    let space = unit.space;
    if staves.is_empty() || space <= 0.0 {
        return vec![];
    }
    let cols = w.div_ceil(COL_STEP);
    let col_of = |x: f64| ((x / COL_STEP as f64).round().max(0.0) as usize).min(cols - 1);
    let max_thick = 2.0f64.max(unit.thick * 2.0).max((space * 0.25).round()) as usize;
    let iso = 2.max((space * 0.4).round() as usize);
    let in_staff = |x: f64, y: f64| staves.iter().any(|s| y > s.top(x) - space * 1.5 && y < s.bottom(x) + space * 1.5);
    // 逐列：细游程、上下各 iso 内空
    let mut hits: Vec<(usize, f64)> = Vec::new();
    for x in (0..w).step_by(COL_STEP) {
        let mut y = 0;
        while y < h {
            if bin.data[y * w + x] == 0 {
                y += 1;
                continue;
            }
            let a = y;
            while y < h && bin.data[y * w + x] != 0 {
                y += 1;
            }
            if y - a > max_thick {
                continue;
            }
            let clear = (a.saturating_sub(iso)..a.saturating_sub(1)).all(|yy| bin.data[yy * w + x] == 0) && (y + 1..(y + iso).min(h)).all(|yy| bin.data[yy * w + x] == 0);
            let c = a as f64 + (y - a - 1) as f64 / 2.0;
            if clear && !in_staff(x as f64, c) {
                hits.push((x, c));
            }
        }
    }
    // 串成轨迹：中心差不过一个线宽（至少 1.5 像素），横向空档不过两格
    let dy = unit.thick.max(1.5);
    let jump = space * 2.0;
    let mut open: Vec<Vec<(usize, f64)>> = Vec::new();
    let mut tracks: Vec<Vec<(usize, f64)>> = Vec::new();
    for p in hits {
        let mut k = 0;
        while k < open.len() {
            if (p.0 - open[k].last().unwrap().0) as f64 > jump {
                tracks.push(open.swap_remove(k));
            } else {
                k += 1;
            }
        }
        let best = open.iter_mut().filter(|o| o.last().unwrap().0 < p.0 && (o.last().unwrap().1 - p.1).abs() <= dy).min_by(|a, b| (a.last().unwrap().1 - p.1).abs().total_cmp(&(b.last().unwrap().1 - p.1).abs()));
        match best {
            Some(o) => o.push(p),
            None => open.push(vec![p]),
        }
    }
    tracks.extend(open);
    tracks.sort_by_key(|t| std::cmp::Reverse(t.len()));
    let staff_w = median(&staves.iter().map(|s| s.right - s.left).collect::<Vec<_>>(), 0.0);
    let min_len = (space * 8.0).max(staff_w * ONE_LINE_LEN);
    let mut out: Vec<Staff> = Vec::new();
    for pts in tracks {
        if pts.len() < 8 || ((pts[pts.len() - 1].0 - pts[0].0) as f64) < min_len * 0.6 {
            continue;
        }
        let y = median(&pts.iter().map(|p| p.1).collect::<Vec<_>>(), 0.0);
        if out.iter().any(|g| (g.ys[2] - y).abs() < space * 4.0 && (pts[0].0 as f64) <= g.right && (pts[pts.len() - 1].0 as f64) >= g.left) {
            continue;
        }
        let mut per: Vec<Vec<f64>> = vec![Vec::new(); cols];
        for p in &pts {
            per[col_of(p.0 as f64)].push(p.1 - y);
        }
        let raw: Vec<f64> = per.iter().map(|a| if a.is_empty() { f64::NAN } else { median(a, 0.0) }).collect();
        let curve = LineCurve { step: COL_STEP, d: fill_curve(&raw) };
        let y_at = |x: usize| y + curve.at(x as f64);
        let r = (unit.thick / 2.0).ceil() as i64 + 1;
        let ink_at = |x: usize, k: f64| {
            let yc = (y_at(x) + k * space).round() as i64;
            (yc - r..=yc + r).any(|yy| bin.ink(x as i64, yy))
        };
        // 左右端：从轨迹两头沿线逐列往外走，断口容一格（扫描件淡线成串点）
        let gap_max = 2.max(space.round() as usize);
        let walk = |from: usize, dir: i64| {
            let (mut end, mut gap) = (from, 0);
            let mut x = from as i64;
            while x >= 0 && (x as usize) < w {
                if ink_at(x as usize, 0.0) {
                    end = x as usize;
                    gap = 0;
                } else {
                    gap += 1;
                    if gap > gap_max {
                        break;
                    }
                }
                x += dir;
            }
            end
        };
        let (left, right) = (walk(pts[0].0, -1), walk(pts[pts.len() - 1].0, 1));
        let span = (right - left + 1) as f64;
        if ((right - left) as f64) < min_len || ((left..=right).filter(|&x| ink_at(x, 0.0)).count() as f64) < span * ONE_LINE_FILL {
            continue;
        }
        if [-2.0, -1.0, 1.0, 2.0].iter().any(|&k| (left..=right).filter(|&x| ink_at(x, k)).count() as f64 >= span * ONE_LINE_SIBLING) {
            continue;
        }
        // 上下对称穿过的竖笔（小节线）：线心上下各 ONE_LINE_BAR 格逐行有墨（容 0.2 格的断口）、又不连过 ONE_LINE_BAR_MAX 格；相邻几列算一根
        let reach = (space * ONE_LINE_BAR).round() as i64;
        let reach_max = (space * ONE_LINE_BAR_MAX).round() as i64;
        let vgap = 1.max((space * 0.2).round() as i64);
        let extent = |x: usize, yc: i64, dir: i64| {
            let (mut e, mut gap) = (0, 0);
            for k in 1..=reach_max + vgap + 1 {
                if bin.ink(x as i64, yc + dir * k) {
                    e = k;
                    gap = 0;
                } else {
                    gap += 1;
                    if gap > vgap {
                        break;
                    }
                }
            }
            e
        };
        let solid = |x: usize, y0: i64, y1: i64| {
            let mut gap = 0;
            for yy in y0..=y1 {
                if bin.ink(x as i64, yy) {
                    gap = 0;
                } else {
                    gap += 1;
                    if gap > vgap {
                        return false;
                    }
                }
            }
            true
        };
        let (mut bars, mut last) = (0, f64::NEG_INFINITY);
        for x in left..=right {
            let yc = y_at(x).round() as i64;
            if !solid(x, yc - reach, yc + reach) || extent(x, yc, -1) > reach_max || extent(x, yc, 1) > reach_max {
                continue;
            }
            if x as f64 - last > space * 0.5 {
                bars += 1;
            }
            last = x as f64;
        }
        if bars < 2 {
            continue;
        }
        let (lo, hi) = (col_of(left as f64)..=col_of(right as f64)).map(|c| curve.d[c] as f64).fold((f64::MAX, f64::MIN), |(l, h), v| (l.min(v), h.max(v)));
        let flat = hi - lo <= FLAT_SPREAD && ((hi + lo) / 2.0).abs() <= 1.0;
        out.push(Staff {
            ys: std::array::from_fn(|k| y + (k as f64 - 2.0) * space),
            thick: [unit.thick; 5],
            curve: if flat { None } else { Some(Arc::new(curve)) },
            left: left as f64,
            right: right as f64,
            one_line: true,
        });
    }
    out
}

/// 逐取样列找五连：相邻五段黑，各段不厚过间距的 `MAX_THICK`，四个间距彼此相差不过 `EVEN_TOL`。
fn column_hits(bin: &Binary, max_space: f64) -> Vec<Hit> {
    let mut out = Vec::new();
    let mut runs: Vec<(usize, usize)> = Vec::new();
    for x in (0..bin.w).step_by(COL_STEP) {
        runs.clear();
        let mut y = 0;
        while y < bin.h {
            if bin.data[y * bin.w + x] == 0 {
                y += 1;
                continue;
            }
            let a = y;
            while y < bin.h && bin.data[y * bin.w + x] != 0 {
                y += 1;
            }
            runs.push((a, y));
        }
        let mut i = 0;
        while i + 5 <= runs.len() {
            let c: Vec<f64> = runs[i..i + 5].iter().map(|&(a, b)| (a + b - 1) as f64 / 2.0).collect();
            let gaps: Vec<f64> = c.windows(2).map(|p| p[1] - p[0]).collect();
            let (lo, hi) = gaps.iter().fold((f64::MAX, f64::MIN), |(l, h), &g| (l.min(g), h.max(g)));
            let mean = (c[4] - c[0]) / 4.0;
            let thick = runs[i..i + 5].iter().map(|&(a, b)| (b - a) as f64).sum::<f64>() / 5.0;
            let max_run = runs[i..i + 5].iter().map(|&(a, b)| b - a).max().unwrap_or(0) as f64;
            if mean >= MIN_SPACE && mean <= max_space && (hi - lo) <= mean * EVEN_TOL && max_run <= mean * MAX_THICK {
                out.push(Hit { x, ys: [c[0], c[1], c[2], c[3], c[4]], space: mean, thick });
                i += 5; // 这五段用掉了（同一列下一行谱从下一段起）
            } else {
                i += 1;
            }
        }
    }
    out
}

/// 命中串成轨迹：按 x 扫，接到中心最近、相差不过半格、中断不过 `TRACK_GAP` 格的轨迹上。
fn build_tracks(mut hits: Vec<Hit>, space: f64) -> Vec<Vec<Hit>> {
    hits.sort_by(|a, b| a.x.cmp(&b.x).then(a.cy().total_cmp(&b.cy())));
    let gap = (space * TRACK_GAP).max((COL_STEP * 2) as f64);
    let mut open: Vec<Vec<Hit>> = Vec::new();
    let mut done: Vec<Vec<Hit>> = Vec::new();
    for h in hits {
        // 中断太久的轨迹收尾
        let mut k = 0;
        while k < open.len() {
            if (h.x - open[k].last().unwrap().x) as f64 > gap {
                done.push(open.swap_remove(k));
            } else {
                k += 1;
            }
        }
        let best = open
            .iter_mut()
            .filter(|t| t.last().unwrap().x < h.x && (t.last().unwrap().cy() - h.cy()).abs() <= space * TRACK_STEP)
            .min_by(|a, b| (a.last().unwrap().cy() - h.cy()).abs().total_cmp(&(b.last().unwrap().cy() - h.cy()).abs()));
        match best {
            Some(t) => t.push(h),
            None => open.push(vec![h]),
        }
    }
    done.extend(open);
    done
}

/// 一行谱的命中 → 谱表：五条线各取中位、共同偏移曲线、左右端、各线带厚。
fn make_staff(bin: &Binary, hits: &[Hit], x0: usize, x1: usize, cols: usize) -> Staff {
    let ys: [f64; 5] = std::array::from_fn(|k| median(&hits.iter().map(|h| h.ys[k]).collect::<Vec<_>>(), 0.0));
    let space = (ys[4] - ys[0]) / 4.0;
    let thick0 = median(&hits.iter().map(|h| h.thick).collect::<Vec<_>>(), 1.0);
    let mut per: Vec<Vec<f64>> = vec![Vec::new(); cols];
    for h in hits {
        let d: Vec<f64> = (0..5).map(|k| h.ys[k] - ys[k]).collect();
        per[(h.x / COL_STEP).min(cols - 1)].push(median(&d, 0.0));
    }
    let raw: Vec<f64> = per.iter().map(|a| if a.is_empty() { f64::NAN } else { median(a, 0.0) }).collect();
    let curve = LineCurve { step: COL_STEP, d: fill_curve(&raw) };
    let y_at = |k: usize, x: usize| ys[k] + curve.at(x as f64);

    // 左右端：沿曲线往外逐列验墨，断口容半格，连着一格有墨才挪端点（括号、乐器名的笔画擦到谱线那一带，不能一擦就把端点拉过去）
    let r = (thick0 / 2.0).ceil() as i64 + 1;
    let present = |x: usize| {
        (0..5)
            .filter(|&k| {
                let yc = y_at(k, x).round() as i64;
                (yc - r..=yc + r).any(|y| bin.ink(x as i64, y))
            })
            .count()
            >= EXTENT_LINES
    };
    let gap_max = 3.max((space * 0.5).round() as usize);
    let run_min = 4.max(space.round() as usize);
    let walk = |from: usize, dir: i64| {
        let (mut end, mut gap, mut streak) = (from, 0, 0);
        let mut x = from as i64;
        while x >= 0 && (x as usize) < bin.w {
            if present(x as usize) {
                gap = 0;
                streak += 1;
                if streak >= run_min {
                    end = x as usize;
                }
            } else {
                streak = 0;
                gap += 1;
                if gap > gap_max {
                    break;
                }
            }
            x += dir;
        }
        end
    };
    // 从轨迹端点往里退一段再起步：连着 `run_min` 列有墨才挪端点，从端点本身起步的话最后几列（取样步长以内）挪不过去
    let (left, right) = (walk((x0 + run_min).min(x1), -1), walk(x1.saturating_sub(run_min).max(x0), 1));
    let (lo, hi) = (left / COL_STEP..=right / COL_STEP).filter_map(|c| curve.d.get(c)).fold((f64::MAX, f64::MIN), |(l, h), &v| (l.min(v as f64), h.max(v as f64)));
    let flat = hi - lo <= FLAT_SPREAD && ((hi + lo) / 2.0).abs() <= 1.0;

    // 各线带厚：沿线取样，量线心所在纵向墨段的长度（不厚过两倍粗估线宽的才算，压着符头、符杠的列不算）
    let thick: [f64; 5] = std::array::from_fn(|k| {
        let mut v = Vec::new();
        let mut x = left;
        while x <= right {
            let yc = y_at(k, x).round() as i64;
            if let Some(y) = (yc - r..=yc + r).find(|&y| bin.ink(x as i64, y)) {
                let (mut a, mut b) = (y, y);
                while bin.ink(x as i64, a - 1) {
                    a -= 1;
                }
                while bin.ink(x as i64, b + 1) {
                    b += 1;
                }
                let len = (b - a + 1) as f64;
                if len <= thick0 * 2.0 {
                    v.push(len);
                }
            }
            x += COL_STEP * 2;
        }
        median(&v, thick0.round().max(1.0))
    });
    Staff { ys, thick, curve: if flat { None } else { Some(Arc::new(curve)) }, left: left as f64, right: right as f64, one_line: false }
}

/// 逐取样列的偏移（量不到是 NaN）补成整页一条：量到的列之间线性插值，两头按整段斜率（两两连线斜率的中位数）外推，
/// 再滑动中位数压掉单列的跳变。
fn fill_curve(raw: &[f64]) -> Vec<f32> {
    let known: Vec<usize> = (0..raw.len()).filter(|&i| !raw[i].is_nan()).collect();
    if known.is_empty() {
        return vec![0.0; raw.len()];
    }
    let every = (known.len() / 60).max(1);
    let pick: Vec<usize> = known.iter().copied().step_by(every).collect();
    let mut slopes = Vec::new();
    for a in 0..pick.len() {
        for b in a + 1..pick.len() {
            slopes.push((raw[pick[b]] - raw[pick[a]]) / (pick[b] - pick[a]) as f64);
        }
    }
    let slope = median(&slopes, 0.0);
    let (first, last) = (known[0], known[known.len() - 1]);
    let mut filled = vec![0.0; raw.len()];
    let mut prev = first;
    for c in 0..raw.len() {
        filled[c] = if c < first {
            raw[first] + slope * (c as f64 - first as f64)
        } else if c > last {
            raw[last] + slope * (c as f64 - last as f64)
        } else if !raw[c].is_nan() {
            prev = c;
            raw[c]
        } else {
            let next = (c + 1..raw.len()).find(|&n| !raw[n].is_nan()).unwrap_or(last);
            raw[prev] + (raw[next] - raw[prev]) * (c - prev) as f64 / (next - prev) as f64
        };
    }
    let half = SMOOTH / 2;
    (0..raw.len())
        .map(|c| {
            let a: Vec<f64> = (c.saturating_sub(half)..(c + half + 1).min(raw.len())).map(|k| filled[k]).collect();
            median(&a, 0.0) as f32
        })
        .collect()
}

/// 横段成谱表（[`staves_from_hsegs`]）：候选线要长过全页最长横段的这个比例；或左端与长线左端对齐、长过 `SHORT_STAFF` 个谱表高（末行短谱表）。
const HSEG_LONG: f64 = 0.35;
const SHORT_STAFF: f64 = 3.0;
/// 线距相对「谱表高的估计」的上下限（防吉他和弦图的品格线凑成谱表）。
const HSEG_GAP: (f64, f64) = (0.1, 0.4);
/// 往下推第 n 条线时的容差（相对线距）；五条按平均间距等距的兜底容差。
const HSEG_TOL: f64 = 0.2;
/// 五条的公共横跨至少是最短那条的这么多、且不短于这么多个谱表高。
const HSEG_SPAN: (f64, f64) = (0.8, 4.0);

/// **横段成谱表**（精确几何的横段：矢量页的谱线对象；判据照「左端对齐、等距、连着五条」）：
/// 拿每条候选当顶线、试后面几条当第二线定出线距，再按「已找到那几条的平均间距」往下推（误差不累积），推不出时按紧挨的五条平均间距等距兜底。
/// `height`：谱表高的估计（音乐字号；没有就按页宽估），只用来卡线距上下限。回各谱表与所用横段的下标。
pub fn staves_from_hsegs(hs: &[dolce_omr_sheet::prims::HSeg], height: f64) -> Vec<(Staff, [usize; 5])> {
    let max_len = hs.iter().map(|h| h.len()).fold(0.0, f64::max);
    if max_len <= 0.0 {
        return vec![];
    }
    let long_lefts: Vec<f64> = hs.iter().filter(|h| h.len() >= max_len * 0.9).map(|h| h.x0).collect();
    let long_left = median(&long_lefts, 0.0);
    let mut cands: Vec<usize> = (0..hs.len()).filter(|&i| hs[i].len() >= max_len * HSEG_LONG || (hs[i].len() >= height * SHORT_STAFF && (hs[i].x0 - long_left).abs() <= height * 0.25)).collect();
    cands.sort_by(|&a, &b| hs[a].y.total_cmp(&hs[b].y));
    let mut used = vec![false; hs.len()];
    let mut out = Vec::new();
    let span_ok = |five: &[usize], d: f64| {
        let left = five.iter().map(|&i| hs[i].x0).fold(f64::MIN, f64::max);
        let right = five.iter().map(|&i| hs[i].x1).fold(f64::MAX, f64::min);
        let shortest = five.iter().map(|&i| hs[i].len()).fold(f64::MAX, f64::min);
        right - left >= shortest * HSEG_SPAN.0 && right - left >= d * 4.0 * HSEG_SPAN.1
    };
    for (ci, &i) in cands.iter().enumerate() {
        if used[i] {
            continue;
        }
        let mut picked: Option<Vec<usize>> = None;
        for &k in cands.iter().skip(ci + 1).take(3) {
            if used[k] || picked.is_some() {
                continue;
            }
            let d = hs[k].y - hs[i].y;
            if d < height * HSEG_GAP.0 {
                continue;
            }
            if d > height * HSEG_GAP.1 {
                break;
            }
            let mut five = vec![i, k];
            let mut dd = d;
            for n in 2..=4 {
                let want = hs[i].y + dd * n as f64;
                let best = cands.iter().copied().filter(|&c| !used[c] && !five.contains(&c)).map(|c| (c, (hs[c].y - want).abs())).filter(|&(_, e)| e < dd * HSEG_TOL).min_by(|a, b| a.1.total_cmp(&b.1));
                let Some((c, _)) = best else { break };
                five.push(c);
                dd = (hs[c].y - hs[i].y) / n as f64;
            }
            if five.len() == 5 && span_ok(&five, d) {
                picked = Some(five);
            }
        }
        if picked.is_none() && ci + 4 < cands.len() {
            let five: Vec<usize> = cands[ci..ci + 5].to_vec();
            if !five.iter().any(|&c| used[c]) {
                let ds: Vec<f64> = (1..5).map(|k| hs[five[k]].y - hs[five[k - 1]].y).collect();
                let avg = ds.iter().sum::<f64>() / 4.0;
                if avg >= height * HSEG_GAP.0 && avg <= height * HSEG_GAP.1 && ds.iter().all(|d| (d - avg).abs() <= avg * HSEG_TOL) && span_ok(&five, avg) {
                    picked = Some(five);
                }
            }
        }
        let Some(mut five) = picked else { continue };
        five.sort_by(|&a, &b| hs[a].y.total_cmp(&hs[b].y));
        for &c in &five {
            used[c] = true;
        }
        let left = five.iter().map(|&c| hs[c].x0).fold(f64::MAX, f64::min);
        let right = five.iter().map(|&c| hs[c].x1).fold(f64::MIN, f64::max);
        let ys = [0, 1, 2, 3, 4].map(|n| hs[five[n]].y);
        let thick = [0, 1, 2, 3, 4].map(|n| hs[five[n]].w.max(1.0));
        out.push((Staff { ys, thick, curve: None, left, right, one_line: false }, [five[0], five[1], five[2], five[3], five[4]]));
    }
    out.sort_by(|a, b| a.0.ys[0].total_cmp(&b.0.ys[0]));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 画一页：两行谱（线距 12、线宽 2），第二行整体右斜 4 像素，外加几个符头大小的黑块。
    fn page() -> Binary {
        let (w, h) = (600, 300);
        let mut b = Binary::new(w, h);
        let mut put = |x: usize, y: usize| b.data[y * w + x] = 1;
        for (top, tilt) in [(40.0, 0.0), (160.0, 4.0)] {
            for k in 0..5 {
                for x in 50..560 {
                    let y = top + k as f64 * 12.0 + tilt * (x as f64 - 50.0) / 510.0;
                    put(x, y as usize);
                    put(x, y as usize + 1);
                }
            }
        }
        for (cx, cy) in [(200, 46), (320, 70), (400, 180)] {
            for y in cy - 5..cy + 5 {
                for x in cx - 7..cx + 7 {
                    put(x, y);
                }
            }
        }
        b
    }

    #[test]
    fn finds_two_staves() {
        let (unit, staves) = find_staves(&page()).expect("找得到");
        assert_eq!(staves.len(), 2);
        assert!((unit.space - 12.0).abs() < 0.6, "{unit:?}");
        let s = &staves[1];
        assert!((s.top(60.0) - 160.5).abs() < 1.5, "{}", s.top(60.0));
        assert!((s.top(540.0) - 164.0).abs() < 1.5, "{}", s.top(540.0));
        assert!(s.left <= 54.0 && s.right >= 555.0, "{} {}", s.left, s.right);
        assert!((staves[0].pos(300.0, staves[0].top(300.0) + 18.0) - 3.0).abs() < 0.2);
    }
}

/// 左端该对齐的谱行：个别行左段的谱线印得淡、断成碎点，逐列验墨（五条里要四条）走不过去，左端停在半路。
/// 同页谱行的左端是对齐排的（首行缩进除外）：左端比本页常见左端靠右一格半以上的，按放宽的验墨（五条里有两条、
/// 两格一窗里四分之一的列）往左走，走得到常见左端就挪过去；一路没有线墨的（真缩进）不动。
pub fn align_lefts(bin: &Binary, staves: &mut [Staff]) {
    if staves.len() < 3 {
        return;
    }
    let lefts: Vec<f64> = staves.iter().map(|s| s.left).collect();
    let target = median(&lefts, 0.0);
    for s in staves.iter_mut().filter(|s| !s.one_line) {
        let sp = s.space();
        if s.left - target <= sp * 1.5 {
            continue;
        }
        let r = (s.thick.iter().cloned().fold(0.0, f64::max) / 2.0).ceil() as i64 + 1;
        let lines_at = |x: i64| {
            (0..5)
                .filter(|&k| {
                    let yc = s.line_y(k, x as f64).round() as i64;
                    (yc - r..=yc + r).any(|y| bin.ink(x, y))
                })
                .count()
        };
        let win = (sp * 2.0).round() as i64;
        let mut x = s.left.round() as i64;
        let goal = target.round() as i64;
        while x > goal {
            let a = (x - win).max(goal);
            let hit = (a..x).filter(|&c| lines_at(c) >= 2).count();
            if (hit as f64) < (x - a) as f64 * 0.25 {
                break;
            }
            x = a;
        }
        if x == goal {
            s.left = target;
        }
    }
}
