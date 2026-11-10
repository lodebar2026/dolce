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

/// 找一页的谱表；一行都凑不出（封面、歌词页、简谱页）回 None。谱表自上而下排好。
pub fn find_staves(bin: &Binary) -> Option<(Unit, Vec<Staff>)> {
    let max_space = MAX_SPACE.max((bin.w.max(bin.h) / 50) as f64);
    let hits = column_hits(bin, max_space);
    if hits.len() < 20 {
        return None;
    }
    let space = median(&hits.iter().map(|h| h.space).collect::<Vec<_>>(), 0.0);
    let hits: Vec<Hit> = hits.into_iter().filter(|h| (h.space - space).abs() <= space * SPACE_TOL).collect();
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
    for t in tracks.into_iter().filter(|t| t.len() >= 8) {
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
    let staves = keep;
    let thicks: Vec<f64> = staves.iter().flat_map(|s| s.thick).collect();
    let spaces: Vec<f64> = staves.iter().map(Staff::space).collect();
    Some((Unit { space: median(&spaces, 0.0), thick: median(&thicks, 1.0) }, staves))
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
