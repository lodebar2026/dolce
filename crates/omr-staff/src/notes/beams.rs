//! **符杠与符尾**（3.4）：在符干的自由端（离头远的那一端）两侧各探一列，数贴着干的厚墨段。
//!
//! - 一段厚墨沿直线一路连到同一行另一根符干同样位置的厚墨段，是**符杠**（两端都有干才成立）；两根干各记一层。
//! - 已有符杠的干上，另一段到不了别的干的厚墨是**断杠**（附点节奏里的半截杠），也记一层。
//! - 一层符杠都没有的干，右侧贴着的厚墨段是**符尾**，几段就是几条。
//!
//! 探的是原图（谱线上的存疑像素算墨：杠压着线的地方本来就连着）；孤零零的谱线比杠薄得多，过不了厚度下限。
use super::{Chord, RowNotes};
use crate::frame::ink::{Probe, BG};
use dolce_omr_sheet::Staff;

/// 探测列离干多远（相对线距）：出了干的宽度、还在符尾根部最厚的那一段里。
/// 弯出去的符尾到 `PROBE` 处可能已变细，无符杠时再贴近干根部（`FLAG_PROBE`）探一次，并要求 `PROBE` 处仍有实墨。
const PROBE: f64 = 0.35;
const FLAG_PROBE: f64 = 0.26;
/// 厚墨段的纵向厚度范围（相对线距）。下限另不低于谱线线宽的 `OVER_LINE` 倍多一像素：朝下的干上斜着扫上去的符尾，
/// 根部纵向只有 0.2 格出头，仍比谱线厚得多。
const THICK: (f64, f64) = (0.18, 1.0);
const OVER_LINE: f64 = 1.6;
/// 自由端外多探这么多、往头的方向最多探这么多（相对线距）；离最近的头留这么多。
const BEYOND: f64 = 0.3;
const REACH: f64 = 3.2;
/// 杠层从干端起一层挨一层：第一段的中心离干端不过这么多、后面每段离前一段不过这么多（相对线距）。断了就不再往下数
/// （再远的厚墨是邻近的符头、下一个音的临时记号）。
const FIRST_AT: f64 = 1.3;
const NEXT_AT: f64 = 1.1;
const HEAD_CLEAR: f64 = 0.8;
/// 两段厚墨的中心相差不到这么多（相对线距）算同一层（一根干左右两侧的同一条杠）。
const SAME_LAYER: f64 = 0.4;
/// 符杠最陡的斜率，沿途取这么多个点、每点上下容这么多（相对线距）。
const SLOPE_MAX: f64 = 0.7;
const SAMPLES: usize = 7;
const PATH_TOL: f64 = 0.2;
/// 一条杠相邻两根干最远隔这么多（相对线距）。
const SPAN_MAX: f64 = 12.0;

/// 列 `x` 上 [y0, y1] 里够厚的墨段的中心 y。
fn thick_runs<P: Probe + ?Sized>(ink: &P, x: i64, y0: i64, y1: i64, sp: f64, line: f64) -> Vec<f64> {
    let min_t = (THICK.0 * sp).max(OVER_LINE * line + 1.0);
    let mut out = Vec::new();
    let mut y = y0;
    while y <= y1 {
        if ink.at(x, y) == BG {
            y += 1;
            continue;
        }
        let (mut a, mut b) = (y, y);
        while ink.at(x, a - 1) != BG && y - a < (THICK.1 * sp) as i64 + 2 {
            a -= 1;
        }
        while ink.at(x, b + 1) != BG && b - a < (THICK.1 * sp) as i64 + 2 {
            b += 1;
        }
        let t = (b - a + 1) as f64;
        if t >= min_t && t <= THICK.1 * sp && a >= y0 && b <= y1 {
            out.push((a + b) as f64 / 2.0);
        }
        y = b + 1;
    }
    out
}

/// 从 (xa, ya) 到 (xb, yb) 沿直线一路有墨。
fn connected<P: Probe + ?Sized>(ink: &P, (xa, ya): (i64, f64), (xb, yb): (i64, f64), sp: f64) -> bool {
    if xb <= xa || (yb - ya).abs() > SLOPE_MAX * (xb - xa) as f64 + SAME_LAYER * sp {
        return false;
    }
    let tol = (PATH_TOL * sp).round() as i64;
    (1..SAMPLES).all(|k| {
        let t = k as f64 / SAMPLES as f64;
        let (x, y) = (xa + ((xb - xa) as f64 * t).round() as i64, (ya + (yb - ya) * t).round() as i64);
        (-tol..=tol).any(|d| ink.at(x, y + d) != BG)
    })
}

/// 一根干自由端一侧的厚墨段（从干端往头的方向排）。
fn probe_at<P: Probe + ?Sized>(ink: &P, c: &Chord, sp: f64, line: f64, d: i64) -> (i64, Vec<f64>) {
    let st = c.stem.unwrap();
    let x = st.x + d;
    let (beyond, reach, clear) = ((BEYOND * sp) as i64, (REACH * sp) as i64, (HEAD_CLEAR * sp) as i64);
    let (y0, y1) = if st.up {
        let head = c.heads.iter().map(|h| h.y).fold(f64::MAX, f64::min) as i64;
        (st.top - beyond, (st.top + reach).min(head - clear))
    } else {
        let head = c.heads.iter().map(|h| h.y).fold(f64::MIN, f64::max) as i64;
        ((st.bottom - reach).max(head + clear), st.bottom + beyond)
    };
    // 从干端起一层挨一层
    let tip = if st.up { st.top } else { st.bottom } as f64;
    let mut runs = thick_runs(ink, x, y0, y1, sp, line);
    runs.sort_by(|a, b| (a - tip).abs().total_cmp(&(b - tip).abs()));
    let mut prev = tip;
    let mut keep = 0;
    for (i, &y) in runs.iter().enumerate() {
        if (y - prev).abs() > if i == 0 { FIRST_AT } else { NEXT_AT } * sp {
            break;
        }
        prev = y;
        keep = i + 1;
    }
    runs.truncate(keep);
    (x, runs)
}

fn probe<P: Probe + ?Sized>(ink: &P, c: &Chord, sp: f64, line: f64, right: bool) -> (i64, Vec<f64>) {
    let d = (PROBE * sp).round() as i64;
    probe_at(ink, c, sp, line, if right { d } else { -d })
}

/// 给一页各行谱的和弦记符杠层数与符尾数。整页的干一起找：跨谱表的连桁，杠两头的干分属上下两行谱。
pub fn tails<P: Probe + ?Sized>(ink: &P, rows: &mut [RowNotes], staves: &[Staff], line: f64) {
    // (行, 行内下标, 线距)，按干的 x 排
    let mut stemmed: Vec<(usize, usize, f64)> = Vec::new();
    for (r, row) in rows.iter().enumerate() {
        stemmed.extend((0..row.chords.len()).filter(|&i| row.chords[i].stem.is_some()).map(|i| (r, i, staves[r].space())));
    }
    stemmed.sort_by_key(|&(r, i, _)| rows[r].chords[i].stem.unwrap().x);
    let left: Vec<(i64, Vec<f64>)> = stemmed.iter().map(|&(r, i, sp)| probe(ink, &rows[r].chords[i], sp, line, false)).collect();
    let right: Vec<(i64, Vec<f64>)> = stemmed.iter().map(|&(r, i, sp)| probe(ink, &rows[r].chords[i], sp, line, true)).collect();
    // 每根干：连到别的干的层（中心 y）、没连上的段
    let mut full: Vec<Vec<f64>> = vec![Vec::new(); stemmed.len()];
    let mut right_used: Vec<Vec<bool>> = right.iter().map(|r| vec![false; r.1.len()]).collect();
    let mut left_used: Vec<Vec<bool>> = left.iter().map(|l| vec![false; l.1.len()]).collect();
    for a in 0..stemmed.len() {
        let sp = stemmed[a].2;
        for (ia, &ya) in right[a].1.iter().enumerate() {
            // 往右由近及远，连上第一根就停
            'next: for b in a + 1..stemmed.len() {
                if (left[b].0 - right[a].0) as f64 > SPAN_MAX * sp {
                    break;
                }
                for (ib, &yb) in left[b].1.iter().enumerate() {
                    if connected(ink, (right[a].0, ya), (left[b].0, yb), sp) {
                        full[a].push(ya);
                        full[b].push(yb);
                        right_used[a][ia] = true;
                        left_used[b][ib] = true;
                        break 'next;
                    }
                }
            }
        }
    }
    for (k, &(r, i, sp)) in stemmed.iter().enumerate() {
        let c = &mut rows[r].chords[i];
        if full[k].is_empty() {
            // 没有符杠：右侧的厚墨段是符尾；PROBE 处变细漏掉时再贴近干根部探一次，并确认外侧仍有实墨
            let mut n = right[k].1.len();
            if n == 0 {
                let d_near = (FLAG_PROBE * sp).round().max(2.0) as i64;
                let x_far = right[k].0;
                let tol = (0.3 * sp).round() as i64;
                let near = probe_at(ink, c, sp, line, d_near).1;
                n = near.into_iter().filter(|&y| (-tol..=tol).any(|dy| ink.at(x_far, y.round() as i64 + dy) == crate::frame::ink::INK)).count();
            }
            c.tails = n.min(4) as u8;
            c.beamed = false;
            continue;
        }
        // 层：连上的，加没连上的断杠；左右两侧的同一条只算一层
        let mut layers = full[k].clone();
        let stubs = right[k].1.iter().zip(&right_used[k]).chain(left[k].1.iter().zip(&left_used[k])).filter(|(_, u)| !**u).map(|(y, _)| *y);
        layers.extend(stubs);
        layers.sort_by(f64::total_cmp);
        layers.dedup_by(|a, b| (*a - *b).abs() < SAME_LAYER * sp);
        c.tails = layers.len().min(4) as u8;
        c.beamed = true;
    }
}

/// 单独一个和弦（点原图补认）的符杠 / 符尾层数：没有别的干可连，干端左右两侧的厚墨层都算——杠连向左边的（一组的末音）也认得出。
pub fn lone_tails<P: Probe + ?Sized>(ink: &P, c: &Chord, sp: f64, line: f64) -> u8 {
    if c.stem.is_none() {
        return 0;
    }
    let mut ys = probe(ink, c, sp, line, false).1;
    ys.extend(probe(ink, c, sp, line, true).1);
    ys.sort_by(f64::total_cmp);
    ys.dedup_by(|a, b| (*a - *b).abs() < SAME_LAYER * sp);
    ys.len().min(4) as u8
}
