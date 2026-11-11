//! 简谱行的定位与划出：混排谱在谱表上方（闭合人声谱在上行谱表与歌词之间）印一行简谱——数字、减时线、高低音点、增时线，
//! 以及与谱表小节线**同 x** 的一截短竖线。判据就是这排短竖线：悬在谱表外、彼此同一高度、长度整齐、对得上本行过半的小节线。
//! 独唱谱、合唱谱的谱表上方没有这种东西（符干从谱表里伸出来、不悬空；字母笔画短、不成排），对不上就没有带。
//!
//! 带里**整块**落在带内的墨从五线谱的各层候选里划出去（[`erase`]），划之前切成条（[`Strip`]）交简谱路线认。
use crate::frame::bars::Barline;
use crate::frame::ink::VSeg;
use dolce_omr_core::image::Binary;
use dolce_omr_sheet::{Staff, Unit};

/// 简谱小节线的长度（相对线距）：简谱字号比线距大得多的谱面上，带高低音点的一行能到五格上下。
const BAR_LEN: (f64, f64) = (1.2, 5.5);
/// 对上的几条里，长过中位数这么多倍的不要（与上方字母笔画连成一根的）。
const LEN_SPREAD: f64 = 1.15;
/// 简谱小节线的下端离谱表首线至少这么远（相对线距）：再近是符干、符杠那一带。
const CLEAR: f64 = 0.5;
/// 往上最多找这么远（相对线距）。
const REACH: f64 = 6.0;
/// 与谱表小节线的 x 容差（相对线距）。
const DX: f64 = 0.6;
/// 至少对上几条、且占本行小节线的这么多成（歌词字的竖笔偶然与两根符干同 x 的不算）。
const MIN_MATCH: usize = 2;
const MIN_FRAC: f64 = 0.4;
/// 同一高度的其余短竖线（行首线）长度至少是对上那几条最短者的这么多成，才算简谱小节线（「1」「7」的竖笔短）。
const SIBLING: f64 = 0.75;
/// 带在小节线上下各放多少（相对线距）：上面罩住高音点与弧顶，下面罩住减时线与低音点、又不碰往上的符杠。
const PAD_TOP: f64 = 0.8;
const PAD_BOTTOM: f64 = 0.3;
/// 叠印的上一行简谱：下一行谱表离这行不过谱表高的这么多倍才算同一系统；对上这行小节线的成数。
const STACK_GAP: f64 = 3.0;
const STACK_MATCH: f64 = 0.6;
/// 竖段两侧紧挨着有墨的行占它长度的上限（见 [`bare`]）。
const SIDE_INK: f64 = 0.2;
/// 同一高度的长竖段里对上谱表小节线的至少占这么多（歌词行里竖笔成排，对上的只是少数）。
const ROW_PURE: f64 = 0.5;

/// 一条简谱行。纵向范围相对所属谱表首线记（`y0`、`y1` 是 x 处首线 y 的偏移，负的在谱表上方），带随谱线弯、斜。
#[derive(Clone, Debug, PartialEq)]
pub struct Band {
    /// 这行简谱是哪一行谱的旋律（页内下标）。
    pub staff: usize,
    /// 纵向范围量自哪一行谱的首线（叠印两行时，上面那行量自紧挨着的那行谱）。
    pub anchor: usize,
    pub y0: f64,
    pub y1: f64,
    pub x0: f64,
    pub x1: f64,
    /// 行内小节线的 x（升序）。
    pub bars: Vec<f64>,
}

impl Band {
    fn covers(&self, st: &Staff, x: i64, y: i64) -> bool {
        let t = st.top(x as f64);
        (x as f64) >= self.x0 && (x as f64) < self.x1 && (y as f64) >= t + self.y0 && (y as f64) < t + self.y1
    }
}

/// 竖段相对谱表首线的纵向范围。
fn span(v: &VSeg, st: &Staff) -> (f64, f64) {
    let t = st.top(v.cx());
    (v.y0 as f64 - t, v.y1 as f64 + 1.0 - t)
}

/// 两根竖段在同一高度：纵向重叠过短者的一半。
fn level(a: (f64, f64), b: (f64, f64)) -> bool {
    a.1.min(b.1) - a.0.max(b.0) > (a.1 - a.0).min(b.1 - b.0) * 0.5
}

/// 一组竖段里彼此同高最多的那一簇。
fn cluster<'a>(vs: &[&'a VSeg], st: &Staff) -> Vec<&'a VSeg> {
    let deg: Vec<usize> = vs.iter().map(|v| vs.iter().filter(|o| level(span(v, st), span(o, st))).count()).collect();
    let Some(hub) = (0..vs.len()).max_by_key(|&i| (deg[i], std::cmp::Reverse(i))) else { return Vec::new() };
    vs.iter().copied().filter(|v| level(span(v, st), span(vs[hub], st))).collect()
}

/// 上端吊在一条长横线下（左右任一边伸出两格以上）的竖段：房子括线的竖钩，也与谱表小节线同 x。
fn hooked(bin: &Binary, v: &VSeg, unit: &Unit) -> bool {
    let reach = unit.thick.round() as i64 + 2;
    let x = v.cx().round() as i64;
    for y in v.y0 as i64 - reach..=v.y0 as i64 + reach {
        for xx in x - 1..=x + 1 {
            if !bin.ink(xx, y) {
                continue;
            }
            let (mut a, mut b) = (xx, xx);
            while bin.ink(a - 1, y) {
                a -= 1;
            }
            while bin.ink(b + 1, y) {
                b += 1;
            }
            if ((xx - a).max(b - xx) as f64) >= unit.space * 2.0 {
                return true;
            }
        }
    }
    false
}

/// 光竖条：两侧紧挨着有墨的行不过 [`SIDE_INK`]。汉字的竖笔总有横笔穿过或接着，简谱小节线是孤零零一根。
fn bare(bin: &Binary, v: &VSeg) -> bool {
    let side = (v.y0..=v.y1).filter(|&y| bin.ink(v.x0 as i64 - 2, y as i64) || bin.ink(v.x1 as i64 + 2, y as i64)).count();
    side as f64 <= v.len() as f64 * SIDE_INK
}

/// 定位各行谱的简谱行：先找谱表上方的；上方没有的再找下方的（闭合人声谱把简谱印在上行谱表与歌词之间）。
/// `short`：不短于 [`BAR_LEN`] 下限的竖段；`bars`：各行谱的小节线（与 `staves` 同序）。
pub fn find(bin: &Binary, short: &[VSeg], staves: &[Staff], bars: &[Vec<Barline>], unit: &Unit) -> Vec<Band> {
    let mut out: Vec<Band> = Vec::new();
    for below in [false, true] {
        for k in 0..staves.len() {
            let found = find_at(bin, short, staves, bars, unit, k, below);
            // 同一条带不收两遍（两行谱之间的那条，上一行的「下方」与下一行的「上方」是同一条）
            let mid = |b: &Band| {
                let x = (b.x0 + b.x1) / 2.0;
                let t = staves[b.anchor].top(x);
                (t + b.y0, t + b.y1)
            };
            for b in found {
                let (a0, a1) = mid(&b);
                if !out.iter().any(|o| mid(o).0 < a1 && mid(o).1 > a0) {
                    out.push(b);
                }
            }
        }
    }
    out.sort_by(|a, b| a.staff.cmp(&b.staff));
    out
}

/// 第 `k` 行谱上方（`below` 时下方）的简谱行。
fn find_at(bin: &Binary, short: &[VSeg], staves: &[Staff], bars: &[Vec<Barline>], unit: &Unit, k: usize, below: bool) -> Vec<Band> {
    let st = &staves[k];
    let sp = st.space();
    let depth = st.bottom(st.left) - st.top(st.left);
    let staff_bars: Vec<f64> = bars[k].iter().map(|b| b.x).filter(|&x| x > st.left + sp * 2.0 && x < st.right + sp).collect();
    // 压着别的谱行的竖段是那一行自己的小节线、符干
    let on_other = |v: &VSeg| staves.iter().enumerate().any(|(o, s)| o != k && (v.y0 as f64) < s.bottom(v.cx()) && (v.y1 as f64) > s.top(v.cx()));
    let ok = |v: &VSeg| !on_other(v) && bare(bin, v) && !hooked(bin, v, unit);
    let cands: Vec<&VSeg> = short
        .iter()
        .filter(|v| {
            let (a, b) = span(v, st);
            let len = (b - a) / sp;
            let placed = if below { a >= depth + sp * CLEAR && a <= depth + sp * REACH } else { b <= -sp * CLEAR && b >= -sp * REACH };
            len >= BAR_LEN.0 && len <= BAR_LEN.1 && placed && v.cx() >= st.left - sp && v.cx() <= st.right + sp && ok(v)
        })
        .collect();
    let hit: Vec<&VSeg> = cands.iter().copied().filter(|v| staff_bars.iter().any(|x| (v.cx() - x).abs() <= sp * DX)).collect();
    // 长度整齐：比中位数长出一截的是与字母笔画连成一根的，短一截的是数字的竖笔
    let row = cluster(&hit, st);
    let mut lens: Vec<f64> = row.iter().map(|v| v.len() as f64).collect();
    lens.sort_by(f64::total_cmp);
    let med = lens.get(lens.len() / 2).copied().unwrap_or(0.0);
    let row: Vec<&VSeg> = row.into_iter().filter(|v| v.len() as f64 <= med * LEN_SPREAD && v.len() as f64 >= med * SIBLING).collect();
    if row.len() < MIN_MATCH || (row.len() as f64) < staff_bars.len() as f64 * MIN_FRAC {
        return Vec::new();
    }
    let top = row.iter().map(|v| span(v, st).0).fold(f64::MAX, f64::min);
    let bot = row.iter().map(|v| span(v, st).1).fold(f64::MIN, f64::max);
    let min_len = med * SIBLING;
    let mut xs: Vec<f64> = cands.iter().filter(|v| span(v, st).0 <= bot && span(v, st).1 >= top && v.len() as f64 >= min_len).map(|v| v.cx()).collect();
    xs.sort_by(f64::total_cmp);
    if (row.len() as f64) < xs.len() as f64 * ROW_PURE {
        return Vec::new();
    }
    let (x0, x1) = (st.left - sp, st.right + sp);
    if below {
        // 上面留得少（往下的符干、符杠），下面罩住低音点
        let (y0, y1) = ((top - sp * PAD_BOTTOM).max(depth + sp * 0.2), bot + sp * PAD_TOP);
        return vec![Band { staff: k, anchor: k, y0, y1, x0, x1, bars: xs }];
    }
    let (y0, y1) = (top - sp * PAD_TOP, (bot + sp * PAD_BOTTOM).min(-sp * 0.2));
    // 叠印两行简谱（一个系统两行谱表，两行简谱都印在上行谱表上方）：自上而下与谱表一一对应，
    // 上面那行归这行谱，紧贴着的那行归下一行谱
    let next = staves.get(k + 1).filter(|b| b.top(b.left) - st.bottom(st.left) < depth * STACK_GAP);
    let upper = next.and_then(|_| {
        let ups: Vec<&VSeg> = short
            .iter()
            .filter(|v| {
                let (a, b) = span(v, st);
                b - a >= min_len && b - a <= sp * BAR_LEN.1 && b <= top - sp * 0.3 && b >= top - (bot - top) - sp * 3.0 && xs.iter().any(|x| (v.cx() - x).abs() <= sp * DX) && ok(v)
            })
            .collect();
        let r = cluster(&ups, st);
        (r.len() >= MIN_MATCH && r.len() as f64 >= xs.len() as f64 * STACK_MATCH).then_some(r)
    });
    match upper {
        Some(r) => {
            let u0 = r.iter().map(|v| span(v, st).0).fold(f64::MAX, f64::min) - sp * PAD_TOP;
            let u1 = (r.iter().map(|v| span(v, st).1).fold(f64::MIN, f64::max) + sp * PAD_BOTTOM).min(y0);
            let mut ux: Vec<f64> = r.iter().map(|v| v.cx()).collect();
            ux.sort_by(f64::total_cmp);
            vec![Band { staff: k, anchor: k, y0: u0, y1: u1, x0, x1, bars: ux }, Band { staff: k + 1, anchor: k, y0, y1, x0, x1, bars: xs }]
        }
        None => vec![Band { staff: k, anchor: k, y0, y1, x0, x1, bars: xs }],
    }
}

/// 一条简谱行的墨（划出去之前切下来的）：`bin` 是带的外框那么大的二值图，只有整块落在带里的墨。
#[derive(Clone, Debug)]
pub struct Strip {
    /// 外框左上角（页面像素）。
    pub x: i64,
    pub y: i64,
    pub bin: Binary,
}

/// 把**整块落在带里**的连通块（8 邻接）从 `imgs` 各张图上抹掉（按第一张判连通），抹掉的墨回成一条。
/// 从谱表伸上来的符干、符杠，从上面垂下来的字母笔画，块的一部分在带外，原样留着。
pub fn erase(imgs: &mut [&mut Binary], band: &Band, st: &Staff) -> Strip {
    let (w, h) = (imgs[0].w as i64, imgs[0].h as i64);
    let (x0, x1) = ((band.x0.floor() as i64).max(0), (band.x1.ceil() as i64).min(w));
    let tops = (x0..x1).map(|x| st.top(x as f64));
    let (lo, hi) = tops.fold((f64::MAX, f64::MIN), |(a, b), t| (a.min(t), b.max(t)));
    let (y0, y1) = (((lo + band.y0).floor() as i64).max(0), ((hi + band.y1).ceil() as i64).min(h));
    let (bw, bh) = ((x1 - x0).max(1) as usize, (y1 - y0).max(1) as usize);
    let mut strip = Binary::new(bw, bh);
    let mut seen = vec![false; bw * bh];
    let mut stack: Vec<(i64, i64)> = Vec::new();
    let mut comp: Vec<(i64, i64)> = Vec::new();
    for y in y0..y1 {
        for x in x0..x1 {
            let i = (y - y0) as usize * bw + (x - x0) as usize;
            if seen[i] || !imgs[0].ink(x, y) || !band.covers(st, x, y) {
                continue;
            }
            comp.clear();
            let mut out = false;
            seen[i] = true;
            stack.push((x, y));
            while let Some((px, py)) = stack.pop() {
                comp.push((px, py));
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        let (nx, ny) = (px + dx, py + dy);
                        if !imgs[0].ink(nx, ny) {
                            continue;
                        }
                        if !band.covers(st, nx, ny) || ny < y0 || ny >= y1 {
                            out = true;
                            continue;
                        }
                        let j = (ny - y0) as usize * bw + (nx - x0) as usize;
                        if !seen[j] {
                            seen[j] = true;
                            stack.push((nx, ny));
                        }
                    }
                }
            }
            if out {
                continue;
            }
            for &(px, py) in &comp {
                strip.data[(py - y0) as usize * bw + (px - x0) as usize] = 1;
                for im in imgs.iter_mut() {
                    im.data[py as usize * im.w + px as usize] = 0;
                }
            }
        }
    }
    Strip { x: x0, y: y0, bin: strip }
}
