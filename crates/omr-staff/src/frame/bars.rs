//! **小节线**（在符头之前定）：竖段里纵贯一行谱（首线到末线）、两端不伸出谱表（或伸进同系统的邻行，贯穿小节线）、
//! 两端旁边没挂着符头那样的一团墨（那是符干）的，按相邻几根并成一条（双线、终止线、反复记号的粗细两笔）。
use crate::frame::ink::{InkLayers, VSeg, BG};
use crate::frame::systems::System;
pub use dolce_omr_sheet::music::BarStyle;
use dolce_omr_sheet::{Staff, Unit};
use serde::{Deserialize, Serialize};

/// 两端可以超出首末线多少（相对线距）还算「不伸出谱表」。
const END_TOL: f64 = 0.6;
/// 两端要盖到首末线以内多少（相对线距）：短过这个的是谱表里的竖笔（升降号、符干）。
const REACH_TOL: f64 = 0.35;
/// 竖笔最宽（相对线距）：再宽是实心块。
const MAX_WIDTH: f64 = 0.8;
/// 粗笔：宽过细笔中位数的这个倍数（终止线、反复记号那一笔）。
const HEAVY: f64 = 2.0;
/// 粗笔至少这么宽（相对线距）：细笔 0.1~0.16 格，粗笔半格上下。
const HEAVY_MIN: f64 = 0.28;
/// 几根竖笔相隔不过这么多（相对线距）并成一条小节线。
const GROUP_GAP: f64 = 1.0;
/// 谱行左端这么宽（相对线距）以内的竖笔是系统线 / 括号，不算小节线。
const START_ZONE: f64 = 0.8;
/// 端点旁符头窗：宽（相对线距）、窗里墨占比过这个就当挂着符头。
const HEAD_WIN: f64 = 1.2;
const HEAD_FILL: f64 = 0.35;
/// 竖笔在谱表里横向连着的墨（平方线距）过这个数就不是小节线（见 `attached`）。
const ATTACH: f64 = 0.4;

/// 一行谱上的一条小节线。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Barline {
    /// 代表 x（几笔的中心）与左右缘。
    pub x: f64,
    pub x0: f64,
    pub x1: f64,
    pub style: BarStyle,
    /// 组成它的竖段（证据；系统内互证补出来的没有）。
    pub segs: Vec<VSeg>,
    pub src: BarSrc,
    /// 存疑：竖笔在谱表里横向连着一团墨（见 `attached`）。多行系统里要别的行作证才留；单行系统里留着带标记，由音符层按满拍裁。
    pub weak: bool,
    /// 左边有反复点（反复结束）、右边有反复点（反复开始）。
    pub repeat_left: bool,
    pub repeat_right: bool,
}

/// 小节线从哪来。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum BarSrc {
    /// 本行的竖段。
    Seg,
    /// 同系统别的行有、本行回原图验到竖墨补的。
    Ink,
    /// 三行以上的系统过半的行都有、本行照多数补的（没验墨）。
    Vote,
}

/// 一行谱的小节线候选（未经系统内互证）。`above` / `below`：同系统上下邻行（贯穿小节线可以伸进去）。
pub fn staff_barlines(ink: &InkLayers, segs: &[VSeg], s: &Staff, unit: &Unit, above: Option<&Staff>, below: Option<&Staff>) -> Vec<Barline> {
    let sp = s.space();
    let mut cands: Vec<VSeg> = segs
        .iter()
        .copied()
        .filter(|v| {
            let x = v.cx();
            // 谱行左端那根是系统线（框架层另认），不是小节线
            if x < s.left + sp * START_ZONE || x > s.right + sp || v.cols as f64 > sp * MAX_WIDTH {
                return false;
            }
            let (top, bot) = (s.top(x), s.bottom(x));
            let (y0, y1) = (v.y0 as f64, v.y1 as f64);
            if y0 > top + sp * REACH_TOL || y1 < bot - sp * REACH_TOL {
                return false;
            }
            let up_ok = y0 >= top - sp * END_TOL || above.is_some_and(|a| y0 <= a.bottom(x) + sp * END_TOL);
            let down_ok = y1 <= bot + sp * END_TOL || below.is_some_and(|b| y1 >= b.top(x) - sp * END_TOL);
            up_ok && down_ok && !head_at_end(ink, v, s, sp)
        })
        .collect();
    cands.sort_by(|a, b| a.x0.cmp(&b.x0));
    let thin = {
        let mut w: Vec<usize> = cands.iter().map(|v| v.cols).collect();
        w.sort();
        w.get(w.len() / 2).copied().unwrap_or(unit.thick.round() as usize).max(1) as f64
    };
    let mut out: Vec<Barline> = Vec::new();
    for v in cands {
        match out.last_mut() {
            Some(b) if (v.x0 as f64) - b.x1 <= sp * GROUP_GAP => {
                b.x1 = b.x1.max(v.x1 as f64);
                b.segs.push(v);
            }
            _ => out.push(Barline { x: v.cx(), x0: v.x0 as f64, x1: v.x1 as f64, style: BarStyle::Regular, segs: vec![v], src: BarSrc::Seg, weak: false, repeat_left: false, repeat_right: false }),
        }
    }
    for b in &mut out {
        // 一组里有孤立的一笔、也有旁边连着一团墨的（紧挨着小节线的符干）：只留孤立的
        if b.segs.len() >= 2 {
            let lone: Vec<VSeg> = b.segs.iter().copied().filter(|v| attached(ink, v, s, sp) < attach_max()).collect();
            if !lone.is_empty() && lone.len() < b.segs.len() {
                b.x0 = lone.iter().map(|v| v.x0).min().unwrap() as f64;
                b.x1 = lone.iter().map(|v| v.x1).max().unwrap() as f64;
                b.segs = lone;
            }
        }
        b.x = (b.x0 + b.x1) / 2.0;
        b.repeat_left = repeat_dots(ink, s, b.x0 - sp * 1.1, b.x0 - 2.0);
        b.repeat_right = repeat_dots(ink, s, b.x1 + 2.0, b.x1 + sp * 1.1);
        b.weak = b.segs.iter().all(|v| attached(ink, v, s, sp) >= attach_max());
        let heavy: Vec<bool> = b.segs.iter().map(|v| v.cols as f64 >= thin * HEAVY && v.cols as f64 >= sp * HEAVY_MIN).collect();
        b.style = match heavy.as_slice() {
            [true] => BarStyle::Heavy,
            [_] => BarStyle::Regular,
            [false, false, ..] => BarStyle::LightLight,
            [false, true, ..] => BarStyle::LightHeavy,
            [true, false, ..] => BarStyle::HeavyLight,
            _ => BarStyle::Heavy,
        };
    }
    out
}

/// 反复点：[xa, xb] 这一条里，第二间与第三间（音级位置 3、5）各有一个孤立的小圆点——各自的墨不大不小、
/// 上下左右都不过大半格，点与点之间的中线一带没有符号墨。
fn repeat_dots(ink: &InkLayers, s: &Staff, xa: f64, xb: f64) -> bool {
    let sp = s.space();
    let xm = (xa + xb) / 2.0;
    let (xa, xb) = (xa.round() as i64, xb.round() as i64);
    let dot = |pos: f64| {
        let (y0, y1) = (s.y_of(xm, pos - 0.85).round() as i64, s.y_of(xm, pos + 0.85).round() as i64);
        let (mut n, mut lx, mut hx, mut ly, mut hy) = (0usize, i64::MAX, i64::MIN, i64::MAX, i64::MIN);
        for y in y0..=y1 {
            for x in xa..=xb {
                if ink.at(x, y) == crate::frame::ink::INK {
                    n += 1;
                    lx = lx.min(x);
                    hx = hx.max(x);
                    ly = ly.min(y);
                    hy = hy.max(y);
                }
            }
        }
        let a = n as f64 / (sp * sp);
        (0.05..=0.4).contains(&a) && ((hx - lx + 1) as f64) <= sp * 0.7 && ((hy - ly + 1) as f64) <= sp * 0.7 && ((hx - lx + 1) as f64) >= sp * 0.2 && ly > y0 && hy < y1
    };
    let mid_clear = {
        let (y0, y1) = (s.y_of(xm, 3.9).round() as i64, s.y_of(xm, 4.1).round() as i64);
        (y0..=y1).all(|y| (xa..=xb).all(|x| ink.at(x, y) != crate::frame::ink::INK))
    };
    dot(3.0) && dot(5.0) && mid_clear
}

fn attach_max() -> f64 {
    std::env::var("OMR_ATTACH").ok().and_then(|v| v.parse().ok()).unwrap_or(ATTACH)
}

/// 竖段在谱表范围内横向连着的墨（竖笔列以外、与它八邻接连通的符号墨，谱线存疑像素不算）有多大（平方线距）。
/// 小节线是孤立的一笔；挂着空心头的干、共用一根竖笔的降号肚子、升号的横杠都连着一团。
fn attached(ink: &InkLayers, v: &VSeg, s: &Staff, sp: f64) -> f64 {
    let x = v.cx();
    let (ya, yb) = ((s.top(x) - sp * 0.5).floor() as i64, (s.bottom(x) + sp * 0.5).ceil() as i64);
    let (xa, xb) = (v.x0 as i64 - (sp * 1.5) as i64, v.x1 as i64 + (sp * 1.5) as i64);
    let (w, h) = ((xb - xa + 1) as usize, (yb - ya + 1) as usize);
    let mut seen = vec![false; w * h];
    let mut stack: Vec<(i64, i64)> = Vec::new();
    let is_ink = |x: i64, y: i64| ink.at(x, y) == crate::frame::ink::INK;
    for y in ya.max(v.y0 as i64)..=yb.min(v.y1 as i64) {
        for x in v.x0 as i64..=v.x1 as i64 {
            if is_ink(x, y) {
                seen[(y - ya) as usize * w + (x - xa) as usize] = true;
                stack.push((x, y));
            }
        }
    }
    let mut out = 0usize;
    while let Some((x, y)) = stack.pop() {
        if x < v.x0 as i64 - 1 || x > v.x1 as i64 + 1 {
            out += 1;
        }
        for dy in -1..=1 {
            for dx in -1..=1 {
                let (nx, ny) = (x + dx, y + dy);
                if nx < xa || nx > xb || ny < ya || ny > yb {
                    continue;
                }
                let i = (ny - ya) as usize * w + (nx - xa) as usize;
                if !seen[i] && is_ink(nx, ny) {
                    seen[i] = true;
                    stack.push((nx, ny));
                }
            }
        }
    }
    out as f64 / (sp * sp)
}

/// 竖段的上端或下端旁边（左或右一个符头宽的窗）墨很满：挂着符头，是符干不是小节线。窗里的谱线存疑像素不算墨。
fn head_at_end(ink: &InkLayers, v: &VSeg, s: &Staff, sp: f64) -> bool {
    let hw = (sp * HEAD_WIN).round() as i64;
    let hh = (sp * 0.5).round() as i64;
    let _ = s;
    // 贴着竖笔的那一小条（符头是挂在干上的：紧挨着就有墨；隔着一截白的是旁边另一个音的头、符杠的一截）
    let near = (sp * 0.35).round().max(2.0) as i64;
    let fill = |xa: i64, xb: i64, y0: i64, y1: i64| {
        let (mut n, mut ink_n) = (0, 0);
        for y in y0..=y1 {
            for x in xa..=xb {
                n += 1;
                ink_n += (ink.at(x, y) == crate::frame::ink::INK) as i32;
            }
        }
        n > 0 && ink_n as f64 / n as f64 >= HEAD_FILL
    };
    for &yend in &[v.y0 as i64, v.y1 as i64] {
        let (l, r) = (v.x0 as i64, v.x1 as i64);
        if fill(l - hw, l - 1, yend - hh, yend + hh) && fill(l - near, l - 1, yend - hh, yend + hh) {
            return true;
        }
        if fill(r + 1, r + hw, yend - hh, yend + hh) && fill(r + 1, r + near, yend - hh, yend + hh) {
            return true;
        }
    }
    false
}

/// 系统内互证的横向容差（相对线距）：扫描件歪一点，隔着歌词的两行就错开几像素；小节线与相邻的干至少隔一格。
const SYS_XTOL: f64 = 0.6;
/// 行末这么多格以内不互证（各行右端参差，别的行的那一根常是谱行右界）。
const LINE_END: f64 = 1.5;

/// 一页各行谱的小节线：先逐行出候选（贯穿小节线只许伸进同系统的邻行），再在多行系统里按同 x 互证——
/// 别的行有、本行没有的回原图验墨补（三行以上过半的行都有就照补）；只有少数行有、别的行原图同处也没有贯穿谱行的竖墨的摘掉。
pub fn page_barlines(ink: &InkLayers, segs: &[VSeg], staves: &[Staff], systems: &[System], unit: &Unit) -> Vec<Vec<Barline>> {
    let mut out: Vec<Vec<Barline>> = vec![Vec::new(); staves.len()];
    for sys in systems {
        let g = &sys.staves;
        for (k, &i) in g.iter().enumerate() {
            let above = if k > 0 { Some(&staves[g[k - 1]]) } else { None };
            let below = g.get(k + 1).map(|&j| &staves[j]);
            out[i] = staff_barlines(ink, segs, &staves[i], unit, above, below);
        }
        // 单行系统没有别的行作证：存疑的留着、带标记，交给音符层按满拍裁
        if g.len() < 2 {
            continue;
        }
        let sp = unit.space;
        let xtol = sp * SYS_XTOL;
        // 各行候选按 x 归簇：(行在系统里的序, 下标, x)
        let mut all: Vec<(usize, usize, f64)> = g.iter().enumerate().flat_map(|(k, &i)| out[i].iter().enumerate().map(move |(j, b)| (k, j, b.x))).collect();
        all.sort_by(|a, b| a.2.total_cmp(&b.2));
        let mut clusters: Vec<Vec<(usize, usize, f64)>> = Vec::new();
        for e in all {
            match clusters.last_mut() {
                Some(c) if e.2 - c.last().unwrap().2 <= xtol => c.push(e),
                _ => clusters.push(vec![e]),
            }
        }
        let n = g.len();
        let mut add: Vec<(usize, f64, BarSrc)> = Vec::new();
        let mut drop: Vec<(usize, usize)> = Vec::new();
        for c in &clusters {
            // 簇里全是存疑的（没有一行是孤立的一笔）：摘掉
            if c.iter().all(|e| out[g[e.0]][e.1].weak) {
                drop.extend(c.iter().map(|e| (e.0, e.1)));
                continue;
            }
            let mut rows: Vec<usize> = c.iter().map(|e| e.0).collect();
            rows.sort();
            rows.dedup();
            if rows.len() == n {
                continue;
            }
            let mut xs: Vec<f64> = c.iter().map(|e| e.2).collect();
            xs.sort_by(f64::total_cmp);
            let x = xs[xs.len() / 2];
            let missing: Vec<usize> = (0..n).filter(|k| !rows.contains(k)).collect();
            // 行末不互证
            if missing.iter().chain(rows.iter()).any(|&k| x > staves[g[k]].right - sp * LINE_END) {
                continue;
            }
            let inside = |k: usize| x >= staves[g[k]].left + sp;
            if n >= 3 && rows.len() * 2 > n {
                add.extend(missing.iter().filter(|&&k| inside(k)).map(|&k| (k, x, BarSrc::Vote)));
                continue;
            }
            // 别的行回原图验墨：行行都验到才补
            let found: Vec<Option<i64>> = missing.iter().map(|&k| bar_at(ink, &staves[g[k]], x, xtol.round() as i64, false)).collect();
            if found.iter().all(|f| f.is_some()) && missing.iter().all(|&k| inside(k)) {
                add.extend(missing.iter().zip(&found).map(|(&k, f)| (k, f.unwrap() as f64, BarSrc::Ink)));
                continue;
            }
            // 少数行有、别的行同处也没有贯穿谱行的竖墨：摘掉
            if rows.len() * 3 <= n || n == 2 {
                let backed = missing.iter().filter(|&&k| bar_at(ink, &staves[g[k]], x, xtol.round() as i64, true).is_some()).count();
                if (n == 2 && backed == 0) || (n >= 3 && (backed + rows.len()) * 3 <= n) {
                    drop.extend(c.iter().map(|e| (e.0, e.1)));
                }
            }
        }
        drop.sort();
        for &(k, j) in drop.iter().rev() {
            out[g[k]].remove(j);
        }
        for (k, x, src) in add {
            let v = &mut out[g[k]];
            v.push(Barline { x, x0: x, x1: x, style: BarStyle::Regular, segs: vec![], src, weak: false, repeat_left: false, repeat_right: false });
            v.sort_by(|a, b| a.x.total_cmp(&b.x));
        }
    }
    out
}

/// 原图上验这一行在 `cx` 左右 `range` 像素内有没有一根小节线模样的竖墨，有则回它的列：
/// 从首线走到末线（逐行可左右挪一列，总共漂不过 0.15 格），断墨不过 6%、最长断口不过两像素；除谱线那几行外横向墨宽的行不多（贴着符头、穿过升号的过不了）；
/// `through` 为假时上下各往外 0.4~0.9 格不能有墨（符干、系统线会伸出去）。
pub fn bar_at(ink: &InkLayers, st: &Staff, cx: f64, range: i64, through: bool) -> Option<i64> {
    let sp = st.space();
    let on = |x: i64, y: i64| ink.at(x, y) != BG;
    let run_w = |x: i64, y: i64| {
        let (mut a, mut b) = (x, x);
        while on(a - 1, y) {
            a -= 1;
        }
        while on(b + 1, y) {
            b += 1;
        }
        b - a + 1
    };
    let top = st.top(cx).round() as i64;
    let bottom = st.bottom(cx).round() as i64;
    let rows = (bottom - top + 1) as f64;
    let inked = |xa: i64, xb: i64, y0: i64, y1: i64| (y0..=y1).filter(|&y| (xa - 1..=xb + 1).any(|x| on(x, y))).count() as f64 / ((y1 - y0 + 1).max(1)) as f64;
    let c = cx.round() as i64;
    for d in 0..=range {
        for x0 in if d == 0 { vec![c] } else { vec![c - d, c + d] } {
            let (mut x, mut miss, mut run, mut worst, mut wide, mut lo, mut hi) = (x0, 0, 0, 0, 0, x0, x0);
            let mut ok = true;
            for y in top..=bottom {
                if on(x, y) {
                    run = 0;
                } else if on(x - 1, y) {
                    x -= 1;
                    run = 0;
                } else if on(x + 1, y) {
                    x += 1;
                    run = 0;
                } else {
                    miss += 1;
                    run += 1;
                    worst = worst.max(run);
                    continue;
                }
                if ((x - x0).abs() as f64) > sp * 0.15 {
                    ok = false;
                    break;
                }
                if run_w(x, y) as f64 > sp * 0.4 {
                    wide += 1;
                }
                lo = lo.min(x);
                hi = hi.max(x);
            }
            if !ok || miss as f64 > rows * 0.06 || worst > 2 || wide as f64 > rows * 0.3 {
                continue;
            }
            if !through && (inked(lo, hi, (top as f64 - sp * 0.9).round() as i64, (top as f64 - sp * 0.4).round() as i64) > 0.3 || inked(lo, hi, (bottom as f64 + sp * 0.4).round() as i64, (bottom as f64 + sp * 0.9).round() as i64) > 0.3) {
                continue;
            }
            return Some(x0);
        }
    }
    None
}
