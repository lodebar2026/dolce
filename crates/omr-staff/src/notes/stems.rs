//! **符干与挂头**（3.3，最简）：从头两侧贴着的墨里找一根竖笔——纵向连着够长、其中有一段是细的（头叠成的墨柱没有细段）。
//! 同一根竖笔上的头成一个和弦。竖笔直接在原图上量（谱线上的存疑像素算连着：竖笔过线处本来是墨，这里只为不在线上断开）。
use super::heads::Head;
use crate::frame::ink::{InkLayers, BG, INK};
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
pub(crate) fn width_at(ink: &InkLayers, x: i64, y: i64, cap: i64) -> i64 {
    let (mut a, mut b) = (x, x);
    while x - a <= cap && ink.at(a - 1, y) == INK {
        a -= 1;
    }
    while b - x <= cap && ink.at(b + 1, y) == INK {
        b += 1;
    }
    b - a + 1
}

/// 从 (x, y) 沿列往 `dir` 方向走到墨断开（不过 `gap` 像素的白缝接上），回最后一个墨像素的 y。
fn run_end(ink: &InkLayers, x: i64, y: i64, dir: i64, gap: i64) -> i64 {
    let mut end = y;
    let mut cur = y;
    loop {
        let next = (1..=gap + 1).map(|d| cur + dir * d).find(|&yy| ink.at(x, yy) != BG);
        match next {
            Some(yy) if yy >= 0 && (yy as usize) < ink.h => {
                end = yy;
                cur = yy;
            }
            _ => return end,
        }
    }
}

/// 给一个头找符干。`sp`：所在行的线距；`thick`：谱线线宽；`edges`：头的左右缘（空心头由外圈量得；实心头给 None，在这里按两行墨量）。
pub fn find_stem(ink: &InkLayers, h: &Head, sp: f64, thick: f64, edges: Option<(i64, i64)>) -> Option<Stem> {
    let (cx, cy) = (h.x.round() as i64, h.y.round() as i64);
    let off = ((EDGE_ROW * sp).round() as i64).max(1);
    let rows = [cy - off, cy + off];
    let cap = (EDGE_CAP * sp) as i64;
    let (xl, xr) = edges.unwrap_or_else(|| {
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
    });
    let gap = (thick.ceil() as i64).max(1);
    let thin_w = ((THIN_W * sp) as i64).max((thick * 2.5) as i64);
    let half = (0.5 * sp).round() as i64;
    // (细段长, 干)
    let mut best: Option<(i64, Stem)> = None;
    for x in xl..=xr {
        let Some(&r0) = rows.iter().find(|&&r| ink.at(x, r) == INK) else { continue };
        let (top, bottom) = (run_end(ink, x, r0, -1, gap), run_end(ink, x, r0, 1, gap));
        if ((cy - top).max(bottom - cy) as f64) < MIN_LEN * sp {
            continue;
        }
        let thin = |a: i64, b: i64| (a..=b).filter(|&y| ink.at(x, y) == INK && width_at(ink, x, y, thin_w) <= thin_w).count() as i64;
        let (tu, td) = (thin(top, cy - half), thin(cy + half, bottom));
        let t = tu.max(td);
        if (t as f64) < MIN_THIN * sp {
            continue;
        }
        if best.is_none_or(|(bt, _)| t > bt) {
            best = Some((t, Stem { x, top, bottom, up: tu >= td }));
        }
    }
    best.map(|b| b.1)
}
