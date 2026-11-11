//! **系统**：哪几行谱同时演奏。两行谱之间左端那条系统线（或方括号、花括号）的墨连着，就是同一个系统。
//!
//! 不按连通块认括号：方括号的粗竖笔、上下衬线、细系统线连成一块又太宽，拆开又各只罩两行；而「墨连不连着」不受碎块影响——
//! 直接在两行之间的缝里逐行数左端那一小条窗口里有没有墨。窗口只开在谱行左缘（往外几格、往里半格）：歌词、力度都在更右边，
//! 页边框在更左边，都进不来。淡得断成虚线的系统线再看松阈值图里贴着左端的那一根。左端标记没印出来的单行按间距并回去。
use dolce_omr_core::image::Binary;
use dolce_omr_sheet::element::{Probe, BG};
use dolce_omr_sheet::{Staff, Unit};
use serde::{Deserialize, Serialize};

/// 左端窗口：谱行左缘往外几格（谱线在谱号处断开时左端会量到谱号右边，系统线离它近三格）、往里几格。
const LEFT_OUT: f64 = 3.5;
const LEFT_IN: f64 = 0.5;
/// 缝里窗口有墨的行占这几成算连着。
const LINK_FRAC: f64 = 0.9;
/// 挨着单线谱、两行左端对齐（不过 `ONE_ALIGN` 格）时只要这几成（单线谱上沿按补出的第一线算，系统线在这段常断）。
const LINK_FRAC_ONE: f64 = 0.6;
const ONE_ALIGN: f64 = 1.0;
/// 松阈值图上看贴着左端的那一根：左端往外几格起找最强的一列；够 `LINK_FRAC` 照算，只到 `SOFT_FRAC` 的要比标准图多出 `SOFT_GAIN`。
/// 窗口要窄：两个系统之间页边的竖线（离左端三格多）松图上也成列。
const SOFT_OUT: f64 = 1.0;
const SOFT_FRAC: f64 = 0.6;
const SOFT_GAIN: f64 = 0.3;
/// 系统线淡成虚线：两行左端之间最满的一列（左右各宽一列），有墨的行过这几成、且最长一段空白不到 `DASH_GAP` 格（括号钩之间的白有一格半）。
const DASH_INK: f64 = 0.5;
const DASH_GAP: f64 = 0.8;
/// 顺着虚线走时每行允许的平均横漂（扫描错切的竖线几十分之一）。
const DASH_DRIFT: f64 = 0.06;
/// 两行左端差在这么多格以内，才在两个左端之间整段找那条线（差得远的是缩进不同的两个系统，只看上面那行的）。
const DASH_DX: f64 = 6.0;
/// 左端标记断开的单行：与相邻组的空白小于本页多行系统之间最小空白的这么多倍，并过去。
const BREAK_GAP: f64 = 0.8;

/// 一个系统：几行谱（`staves` 的下标，自上而下）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct System {
    pub staves: Vec<usize>,
    /// 由左端标记连起来的（否则是单行，或按间距并的）。
    pub linked: bool,
}

/// 左端那一处的首末线 y。
fn edge(s: &Staff) -> (f64, f64) {
    (s.top(s.left), s.bottom(s.left))
}

/// 把一页的谱行分成系统（`staves` 自上而下）。`soft`：松阈值图（与 `bin` 同尺寸才用）。
pub fn find_systems<P: Probe + ?Sized>(bin: &P, soft: Option<&Binary>, staves: &[Staff], unit: &Unit) -> Vec<System> {
    if staves.is_empty() {
        return vec![];
    }
    let sp = unit.space;
    let soft = soft.filter(|s| s.w == bin.width() && s.h == bin.height());
    let mut lefts: Vec<f64> = staves.iter().map(|s| s.left).collect();
    lefts.sort_by(f64::total_cmp);
    let med_left = lefts[lefts.len() / 2];
    let mut groups: Vec<Vec<usize>> = vec![vec![0]];
    for i in 1..staves.len() {
        let (a, b) = (&staves[i - 1], &staves[i]);
        let y0 = edge(a).1.round() as i64 + 1;
        let y1 = edge(b).0.round() as i64 - 1;
        let left = a.left.min(b.left);
        let x0 = ((left.min(med_left) - sp * LEFT_OUT).round() as i64).max(0);
        let x1 = ((left + sp * LEFT_IN).round() as i64).min(bin.width() as i64 - 1);
        let rows = (y0..=y1).filter(|&y| y >= 0 && (y as usize) < bin.height()).count();
        let frac = if (a.one_line || b.one_line) && (a.left - b.left).abs() <= sp * ONE_ALIGN { LINK_FRAC_ONE } else { LINK_FRAC };
        let std = if rows == 0 { 1.0 } else { (y0..=y1).filter(|&y| (x0..=x1).any(|x| bin.at(x, y) != BG)).count() as f64 / rows as f64 };
        let mut linked = std >= frac;
        if !linked && rows > 0 {
            if let Some(sf) = soft {
                // 松图上贴着左端最强的一列（左右各宽一列）逐行有墨的成数
                let c0 = ((left - sp * SOFT_OUT).round() as i64).max(1);
                let best = (c0..=x1.min(sf.w as i64 - 2)).map(|x| (y0..=y1).filter(|&y| sf.ink(x, y) || sf.ink(x - 1, y) || sf.ink(x + 1, y)).count()).max().unwrap_or(0);
                let f = best as f64 / rows as f64;
                linked = f >= frac || (f >= frac.min(SOFT_FRAC) && f - std >= SOFT_GAIN);
            }
        }
        if !linked {
            linked = dashed(bin, a, b, sp);
        }
        if linked {
            groups.last_mut().unwrap().push(i);
        } else {
            groups.push(vec![i]);
        }
    }
    join_by_gap(groups.into_iter().map(|g| System { linked: g.len() > 1, staves: g }).collect(), staves)
}

/// 两行之间的系统线断成虚线（扫描件上人声方括号与钢琴大谱表之间那一截细线）：左端附近找墨最满的一列，
/// 墨过 `DASH_INK`、且最长一段空白不到 `DASH_GAP` 格——真正的系统间隔那一列是白的，两个系统挨得近时上一个括号的下钩、
/// 下一个括号的上钩把间隔两头填满，墨量过半、中间却隔着一格半的白。
fn dashed<P: Probe + ?Sized>(bin: &P, a: &Staff, b: &Staff, sp: f64) -> bool {
    let y0 = (edge(a).1 + sp * 0.5).round() as i64;
    let y1 = (edge(b).0 - sp * 0.5).round() as i64;
    if ((y1 - y0) as f64) < sp * 2.0 {
        return false;
    }
    let near = (a.left - b.left).abs() <= sp * DASH_DX;
    let (xa, xb) = if near { (a.left.min(b.left), a.left.max(b.left)) } else { (a.left, a.left) };
    let rows = (y1 - y0 + 1) as f64;
    // 竖线可能歪（扫描错切）：顺着墨走，每行可挪一列，总漂移不过 `DASH_DRIFT` × 行数
    let drift = (rows * DASH_DRIFT).max(2.0);
    ((xa - sp).round() as i64..=(xb + sp).round() as i64).any(|x0| {
        let (mut x, mut n, mut gap, mut worst) = (x0, 0usize, 0usize, 0usize);
        for y in y0..=y1 {
            let hit = [x, x - 1, x + 1].into_iter().find(|&xx| bin.at(xx, y) != BG);
            match hit {
                Some(xx) => {
                    x = xx;
                    n += 1;
                    gap = 0;
                    if ((x - x0).abs() as f64) > drift {
                        return false;
                    }
                }
                None => {
                    gap += 1;
                    worst = worst.max(gap);
                }
            }
        }
        n as f64 / rows >= DASH_INK && (worst as f64) < sp * DASH_GAP
    })
}


/// 左端标记断开的系统按间距并回去：系统间距取本页两个相邻多行系统之间最小的空白；单行与上下组的空白小于它的 `BREAK_GAP` 倍就并。
/// 不拿系统内最大空白当上限：人声行下面带歌词，系统内空白常比系统之间还大。
fn join_by_gap(gs: Vec<System>, staves: &[Staff]) -> Vec<System> {
    let gap = |a: &System, b: &System| {
        let (sa, sb) = (&staves[*a.staves.last().unwrap()], &staves[b.staves[0]]);
        edge(sb).0 - edge(sa).1
    };
    let inter = gs.windows(2).filter(|w| w[0].staves.len() > 1 && w[1].staves.len() > 1).map(|w| gap(&w[0], &w[1])).fold(f64::INFINITY, f64::min);
    if !inter.is_finite() {
        return gs;
    }
    let mut out: Vec<System> = Vec::new();
    for g in gs {
        if let Some(prev) = out.last_mut() {
            if (prev.staves.len() == 1 || g.staves.len() == 1) && gap(prev, &g) < inter * BREAK_GAP {
                prev.staves.extend(g.staves);
                continue;
            }
        }
        out.push(g);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::staves::find_staves;

    /// 四行谱：前两行左端一根系统线连着，后两行不连、间距大。
    #[test]
    fn left_line_links() {
        let (w, h) = (400, 400);
        let mut b = Binary::new(w, h);
        let tops = [30usize, 110, 220, 300];
        for &t in &tops {
            for k in 0..5 {
                for x in 40..380 {
                    b.data[(t + k * 10) * w + x] = 1;
                }
            }
        }
        for y in 30..=150 {
            b.data[y * w + 40] = 1;
            b.data[y * w + 41] = 1;
        }
        let (unit, staves) = find_staves(&b).unwrap();
        assert_eq!(staves.len(), 4);
        let sys = find_systems(&b, None, &staves, &unit);
        assert_eq!(sys.iter().map(|s| s.staves.clone()).collect::<Vec<_>>(), vec![vec![0, 1], vec![2], vec![3]]);
    }

    /// 两行之间的系统线断成虚线、还有点歪：顺着墨走接得上。
    #[test]
    fn dashed_slanted_line() {
        let (w, h) = (400, 300);
        let mut b = Binary::new(w, h);
        for &t in &[30usize, 200] {
            for k in 0..5 {
                for x in 60..380 {
                    b.data[(t + k * 10) * w + x] = 1;
                }
            }
        }
        // 第一行底线 70 到第二行顶线 200：每 12 行断 4 行，往下每 25 行左移一列
        for y in 70..200 {
            if y % 12 < 8 {
                b.data[y * w + 60 - (y - 70) / 25] = 1;
            }
        }
        let (unit, staves) = find_staves(&b).unwrap();
        assert_eq!(staves.len(), 2);
        let sys = find_systems(&b, None, &staves, &unit);
        assert_eq!(sys.len(), 1, "{sys:?}");
    }
}
