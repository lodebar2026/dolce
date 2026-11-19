//! **符干与挂头**（3.3，最简）：从头两侧贴着的墨里找一根竖笔——纵向连着够长、其中有一段是细的（头叠成的墨柱没有细段）。
//! 同一根竖笔上的头成一个和弦。竖笔直接在原图上量（谱线上的存疑像素算连着：竖笔过线处本来是墨，这里只为不在线上断开）。
use super::heads::Head;
use crate::frame::ink::{Probe, BG, INK};
use serde::{Deserialize, Serialize};

/// 量头左右缘的两行离中心多远（相对线距）：避开中心那一行可能压着的加线。
const EDGE_ROW: f64 = 0.22;
/// 头的左右缘最远离中心多远（相对线距）。
const EDGE_CAP: f64 = 1.0;
/// 符干从头中心起至少伸出这么长（相对线距）。
const MIN_LEN: f64 = 2.0;
/// 其中细的一段至少这么长（相对线距）；细 = 横向墨宽不过 `THIN_W`。
const MIN_THIN: f64 = 0.8;
const THIN_W: f64 = 0.35;
/// 干的断口最宽（相对线距）与断口那头细墨至少连着多长（相对线距），见 [`run_end`]。
const STEM_BREAK: f64 = 0.4;
const STEM_RESUME: f64 = 0.3;
/// 断口宽过 `STEM_BREAK`、不过 `STEM_BREAK_LONG` 格的，这头连着 `STEM_RESUME` 格以上的细墨、那头同一列连着 `STEM_LONG_SIDE` 格以上的细墨才接
/// （新编 265 细干在头上方一格不到处断 10 像素；全局放到 0.6 格独唱、合唱都退，见计划文档）。
const STEM_BREAK_LONG: f64 = 0.6;
const STEM_LONG_SIDE: f64 = 0.5;
/// 松阈值图上整段有墨的断口最宽（相对线距）：扫描件干靠头那段印得淡（新编 263 断 12~14 像素）。
const STEM_BREAK_SOFT: f64 = 1.0;
/// 干的列可以在量到的头缘之外这么多（相对线距）：斜着印的头，干接在头的下角 / 上角，量缘的那两行够不着它。
const EDGE_OUT: f64 = 0.15;

/// 一根符干。
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Stem {
    pub x: i64,
    /// 这一列连着的墨的上下端（含头里的一段）。
    pub top: i64,
    pub bottom: i64,
    /// 干朝上（细的一段在头上方）。
    pub up: bool,
}

/// (x, y) 处横向墨宽（只数符号墨；超过 `cap` 就不再数）。
pub(crate) fn width_at<P: Probe + ?Sized>(ink: &P, x: i64, y: i64, cap: i64) -> i64 {
    let (mut a, mut b) = (x, x);
    while x - a <= cap && ink.at(a - 1, y) == INK {
        a -= 1;
    }
    while b - x <= cap && ink.at(b + 1, y) == INK {
        b += 1;
    }
    b - a + 1
}

/// 从 (x, y) 沿列往 `dir` 方向走到墨断开（不过 `gap` 像素的白缝接上），回 `(最后一个墨像素的 y, 离开 cy ± half 后的细墨行数)`。
/// 扫描件有轻微倾斜时竖干会逐行横向偏移一像素，允许在 `x ± max_drift` 内顺着细墨跟过去。
/// `wide`：扫描件的干常断成几截（头与干之间、干中段），断口宽过 `gap`、不过 `wide.0` 像素时，
/// 断口这头是细墨（顺着干走过来的）就接；这头是头的，那头接着的要是细墨（横向墨宽不过 `wide.1`；看 `wide.2` 行，那截先断了的要有两行以上）才接上——接着的是另一个头（上下贴着的两个头之间的缝）不接。
#[allow(clippy::too_many_arguments)]
fn run_end<P: Probe + ?Sized>(ink: &P, x0: i64, y: i64, dir: i64, cy: i64, half: i64, gap: i64, max_drift: i64, wide: (i64, i64, i64), long: (i64, i64, i64)) -> (i64, i64) {
    let mut end = y;
    let mut cur = y;
    let mut x = x0;
    let mut last_shift_y = y;
    let mut thin_n = 0i64;
    let h = ink.height() as i64;
    // 从 y0 往 d 方向连着的细墨有几行（谱线上的存疑像素算连着、不计数；不过 `gap` 像素的白缝接上）
    let thin_run = |cx: i64, y0: i64, d: i64| {
        let (mut k, mut n) = (0, 0);
        loop {
            if ink.at(cx, y0 + d * k) == BG {
                match (1..=gap).find(|&j| ink.at(cx, y0 + d * (k + j)) != BG) {
                    Some(j) => k += j,
                    None => break,
                }
            }
            if ink.at(cx, y0 + d * k) == INK {
                if width_at(ink, cx, y0 + d * k, wide.1) > wide.1 {
                    break;
                }
                n += 1;
            }
            k += 1;
        }
        n
    };
    loop {
        let mut next = (1..=gap + 1).map(|d| cur + dir * d).find(|&yy| ink.at(x, yy) != BG);
        // 扫描件歪斜时竖干横向移了一像素：当前列断成白/线，而邻列连着两行以上细墨就跟过去（限斜率不超过 1:5，不追斜弧/符杠）
        if max_drift > 0 && (cur - last_shift_y).abs() >= 5 && ink.at(x, cur + dir) != INK {
            if let Some(nx) = [-1, 1].into_iter().map(|dx| x + dx).find(|&nx| {
                (nx - x0).abs() <= max_drift
                    && ink.at(nx, cur + dir) == INK
                    && width_at(ink, nx, cur + dir, wide.1) <= wide.1
                    && ink.at(nx, cur + 2 * dir) == INK
                    && width_at(ink, nx, cur + 2 * dir, wide.1) <= wide.1
            }) {
                x = nx;
                last_shift_y = cur + dir;
                next = Some(cur + dir);
            }
        }
        // 扫描件印淡的干：断口不过一格、松阈值图上同一列（容左右一列）整段有墨的接上
        let soft = next.is_none().then(|| (gap + 2..=long.2 + 1).map(|d| cur + dir * d).find(|&yy| ink.at(x, yy) != BG)).flatten().filter(|&yy| {
            let mut y = cur + dir;
            while y != yy {
                if !(x - 1..=x + 1).any(|xx| ink.faint(xx, y)) {
                    return false;
                }
                y += dir;
            }
            true
        });
        let next = next.or(soft).or_else(|| {
            if (gap + 2..=wide.0 + 1).map(|d| cur + dir * d).all(|yy| ink.at(x, yy) == BG) {
                // 长断口：两头都是长的细墨
                let yy = (wide.0 + 2..=long.0 + 1).map(|d| cur + dir * d).find(|&yy| ink.at(x, yy) != BG)?;
                return (thin_run(x, cur, -dir) >= wide.2 && thin_run(x, yy, dir) >= long.1).then_some(yy);
            }
            let yy = (gap + 2..=wide.0 + 1).map(|d| cur + dir * d).find(|&yy| ink.at(x, yy) != BG)?;
            // 断口这头是细墨（顺着干走过来）：那头接着什么都接（干断开后接着和弦的另一个头）
            // （谱线上的存疑像素横向连不成墨宽，量出来都细，不算）
            if (0..2).all(|k| ink.at(x, cur - dir * k) == INK && width_at(ink, x, cur - dir * k, wide.1) <= wide.1) {
                return Some(yy);
            }
            // 细墨连着 wide.2 行；先断了也行（干断成几小截），只要那截有两行以上、都细
            let (mut k, mut n) = (0, 0);
            while k < wide.2 && ink.at(x, yy + dir * k) != BG {
                if ink.at(x, yy + dir * k) == INK {
                    if width_at(ink, x, yy + dir * k, wide.1) > wide.1 {
                        return None;
                    }
                    n += 1;
                }
                k += 1;
            }
            (n >= 2).then_some(yy)
        });
        match next {
            Some(yy) if yy >= 0 && yy < h => {
                if (yy - cy) * dir > half && ink.at(x, yy) == INK && width_at(ink, x, yy, wide.1) <= wide.1 {
                    thin_n += 1;
                }
                end = yy;
                cur = yy;
            }
            _ => return (end, thin_n),
        }
    }
}

/// 给一个头找符干。`sp`：所在行的线距；`thick`：谱线线宽；`edges`：头的左右缘（空心头由外圈量得；实心头给 None，在这里按两行墨量）；
/// `taken(x)`：这一列的竖笔已经归了别的元素（定下的小节线，见 [`super::resolve::Claims`]），不当符干。
pub fn find_stem<P: Probe + ?Sized>(ink: &P, h: &Head, sp: f64, thick: f64, edges: Option<(i64, i64)>, taken: &dyn Fn(i64) -> bool) -> Option<Stem> {
    let cy = h.y.round() as i64;
    let (xl, xr) = edges.unwrap_or_else(|| head_edges(ink, h, sp));
    let drift = (0.35 * sp).round().max(3.0) as i64;
    scan_stem(ink, cy, sp, thick, xl, xr, None, 0, taken)
        .or_else(|| scan_stem(ink, cy, sp, thick, xl, xr, None, drift, taken))
}

/// 头的左右缘：在中心上下各 [`EDGE_ROW`] 格的两行上数连着的墨。
fn head_edges<P: Probe + ?Sized>(ink: &P, h: &Head, sp: f64) -> (i64, i64) {
    let (cx, cy) = (h.x.round() as i64, h.y.round() as i64);
    let off = ((EDGE_ROW * sp).round() as i64).max(1);
    let rows = [cy - off, cy + off];
    let cap = (EDGE_CAP * sp) as i64;
    let (mut xl, mut xr) = (cx, cx);
    for &r in &rows {
        let (mut a, mut b) = (cx, cx);
        while cx - a < cap && ink.at(a - 1, r) == INK {
            a -= 1;
        }
        while b - cx < cap && ink.at(b + 1, r) == INK {
            b += 1;
        }
        xl = xl.min(a);
        xr = xr.max(b);
    }
    (xl, xr)
}

/// 两声部同音共用一个头：头已挂上干 `st`（朝上的贴右缘、朝下的贴左缘），对侧的缘上另有一根朝反方向的干
///（细段在反方向、不越过头往 `st` 那一边伸）。回那根干；不是共头回 None。同 TS `notedata.ts::unisonStems`。
pub fn unison_stem<P: Probe + ?Sized>(ink: &P, h: &Head, sp: f64, thick: f64, edges: Option<(i64, i64)>, st: &Stem, taken: &dyn Fn(i64) -> bool) -> Option<Stem> {
    let cy = h.y.round() as i64;
    let (xl, xr) = edges.unwrap_or_else(|| head_edges(ink, h, sp));
    let tol = (sp / 4.0).round() as i64;
    // 已挂的干贴在正经那一侧
    if (st.x - if st.up { xr } else { xl }).abs() > tol {
        return None;
    }
    let (a, b) = if st.up { (xl - tol, xl + tol) } else { (xr - tol, xr + tol) };
    let other = scan_stem(ink, cy, sp, thick, a, b, Some(!st.up), 0, taken)?;
    let half = (0.5 * sp).round() as i64;
    // 反方向那根不越过头：朝下的上端、朝上的下端都在头里
    let ok = if other.up { other.bottom <= cy + half } else { other.top >= cy - half };
    (ok && (other.x - st.x).abs() > tol).then_some(other)
}

/// 在 `[xl, xr]`（外扩 [`EDGE_OUT`]）的列里找干；`want`：只要这个朝向的（细段在头的那一侧）。
#[allow(clippy::too_many_arguments)]
fn scan_stem<P: Probe + ?Sized>(ink: &P, cy: i64, sp: f64, thick: f64, xl: i64, xr: i64, want: Option<bool>, max_drift: i64, taken: &dyn Fn(i64) -> bool) -> Option<Stem> {
    let off = ((EDGE_ROW * sp).round() as i64).max(1);
    let rows = [cy - off, cy + off];
    let gap = (thick.ceil() as i64).max(1);
    let thin_w = ((THIN_W * sp) as i64).max((thick * 2.5) as i64);
    let half = (0.5 * sp).round() as i64;
    let wide = ((STEM_BREAK * sp) as i64, thin_w, ((STEM_RESUME * sp).round() as i64).max(2));
    let long = ((STEM_BREAK_LONG * sp) as i64, ((STEM_LONG_SIDE * sp).round() as i64).max(3), (STEM_BREAK_SOFT * sp) as i64);
    // (细段长, 干)
    let mut best: Option<(i64, Stem)> = None;
    let out = ((EDGE_OUT * sp).round() as i64).max(1);
    for x in xl - out..=xr + out {
        if taken(x) {
            continue;
        }
        // 这一列从头里的哪一行起：量缘的两行上有墨的优先；缘外的列看头高以内离中心最近的墨
        let inside = (xl..=xr).contains(&x);
        let r0 = rows.iter().copied().find(|&r| inside && ink.at(x, r) == INK).or_else(|| (0..=half).flat_map(|d| [cy - d, cy + d]).find(|&r| ink.at(x, r) == INK));
        let Some(r0) = r0 else { continue };
        let (top, tu) = run_end(ink, x, r0, -1, cy, half, gap, max_drift, wide, long);
        let (bottom, td) = run_end(ink, x, r0, 1, cy, half, gap, max_drift, wide, long);
        if std::env::var("OMR_STEM_DEBUG").is_ok() {
            eprintln!("干 列 {x} 起 {r0}：上 {top} 下 {bottom}（宽口 {:?} 长口 {:?}）", wide, long);
        }
        if ((cy - top).max(bottom - cy) as f64) < MIN_LEN * sp {
            continue;
        }
        let t = match want {
            Some(true) => tu,
            Some(false) => td,
            None => tu.max(td),
        };
        if (t as f64) < MIN_THIN * sp {
            continue;
        }
        if best.is_none_or(|(bt, _)| t > bt) {
            best = Some((t, Stem { x, top, bottom, up: want.unwrap_or(tu >= td) }));
        }
    }
    best.map(|b| b.1)
}
