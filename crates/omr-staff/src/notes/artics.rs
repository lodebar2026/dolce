//! **贴头奏法**（3.8）：延长记号、断奏点、保持线、重音。都从符号墨的墨块认——形状用记号自身的结构（拱与拱下的点、
//! 圆点、短横、左开口的楔），位置相对它挂的那个和弦（或休止）；尺寸一律按本行线距归一。
//!
//! 琶音线、震音、倚音还没做。
use super::RowNotes;
use crate::frame::ink::Blob;
use crate::page::PageFrame;
use dolce_omr_sheet::score::Art;

/// 延长记号的拱：宽、高（相对线距）与宽高比。
const FERMATA_W: (f64, f64) = (1.4, 3.8);
const FERMATA_H: (f64, f64) = (0.6, 2.0);
const FERMATA_ASPECT: (f64, f64) = (1.2, 3.4);
/// 拱离它那一行谱最远这么多（相对线距）；拱心与挂的音横向最多差这么多。
const FERMATA_FAR: f64 = 7.0;
const FERMATA_DX: f64 = 1.3;
/// 圆点（延长记号的点、断奏点）：边长范围（相对线距）、宽高比、占包围盒的比例。
const DOT_SIZE: (f64, f64) = (0.25, 0.85);
const DOT_ASPECT: (f64, f64) = (0.65, 1.55);
const DOT_FILL: f64 = 0.65;
/// 断奏点比这个大的不要（延长记号的点更大）。
const STACC_MAX: f64 = 0.6;
/// 贴头记号离和弦外沿（头缘或干端）的空隙范围、横向离和弦最多多远（相对线距）。
const ART_GAP: (f64, f64) = (0.05, 1.1);
const ART_DX: f64 = 0.35;
/// 保持线：宽范围、最厚多少（相对线距）、占包围盒的比例。
const TENUTO_W: (f64, f64) = (0.8, 1.7);
const TENUTO_H: f64 = 0.4;
const TENUTO_FILL: f64 = 0.7;
/// 重音：宽、高范围（相对线距）、占包围盒的比例上限、横向与空隙放宽到多少。
const ACCENT_W: (f64, f64) = (0.9, 2.0);
const ACCENT_H: (f64, f64) = (0.45, 1.3);
const ACCENT_FILL: f64 = 0.55;
const ACCENT_DX: f64 = 0.9;
const ACCENT_GAP: f64 = 2.2;
/// 附点的位置（与 [`super::marks`] 同）：在头右边这么远、音级差不过这么多的点是附点，不当断奏。
const AUG_DX: (f64, f64) = (0.7, 2.6);
const AUG_POS: f64 = 1.4;
/// 点左边这一截（相对线距，与点同高）里的墨占到这么多的，是挨着头的附点（那个头不一定认出来了），不当断奏。
const AUG_LEFT: (f64, f64) = (0.3, 1.4);
const AUG_LEFT_INK: f64 = 0.15;

/// 墨块 `b` 在第 `x` 列（左右各让一列）自己的墨的上下端。
fn column(f: &PageFrame, b: &Blob, x: i64) -> Option<(i64, i64)> {
    let (y0, y1) = (b.rect.y as i64, b.rect.bottom() as i64);
    let own = |x: i64, y: i64| x >= 0 && y >= 0 && (x as usize) < f.ink.w && (y as usize) < f.ink.h && f.labels[y as usize * f.ink.w + x as usize] == b.id as i32;
    let ys: Vec<i64> = (y0..=y1).filter(|&y| (-1..=1).any(|d| own(x + d, y))).collect();
    Some((*ys.first()?, *ys.last()?))
}

fn is_dot(b: &Blob, sp: f64, max: f64) -> bool {
    let (w, h) = (b.rect.w / sp, b.rect.h / sp);
    w >= DOT_SIZE.0 && w <= max && h >= DOT_SIZE.0 && h <= max && w / h >= DOT_ASPECT.0 && w / h <= DOT_ASPECT.1 && b.area as f64 >= DOT_FILL * b.rect.w * b.rect.h
}

/// 拱：正中那一列的墨只在靠拱顶的一头，两端的墨离拱顶远。回「拱顶朝上」。
fn arch(f: &PageFrame, b: &Blob, sp: f64) -> Option<bool> {
    let (w, h) = (b.rect.w / sp, b.rect.h / sp);
    if w < FERMATA_W.0 || w > FERMATA_W.1 || h < FERMATA_H.0 || h > FERMATA_H.1 || w / h < FERMATA_ASPECT.0 || w / h > FERMATA_ASPECT.1 {
        return None;
    }
    let (x0, y0) = (b.rect.x, b.rect.y);
    let at = |fx: f64| column(f, b, (x0 + b.rect.w * fx).round() as i64).map(|(a, c)| ((a as f64 - y0) / b.rect.h, (c as f64 - y0) / b.rect.h));
    let (mid, l, r) = (at(0.5)?, at(0.06)?, at(0.94)?);
    if mid.0 <= 0.2 && mid.1 <= 0.6 && l.0 >= 0.3 && r.0 >= 0.3 {
        return Some(true);
    }
    if mid.1 >= 0.8 && mid.0 >= 0.4 && l.1 <= 0.7 && r.1 <= 0.7 {
        return Some(false);
    }
    None
}

/// 重音「>」：左端上下两笔分开、中间是空的，右端收在中间。
fn wedge(f: &PageFrame, b: &Blob, sp: f64) -> bool {
    let (w, h) = (b.rect.w / sp, b.rect.h / sp);
    if w < ACCENT_W.0 || w > ACCENT_W.1 || h < ACCENT_H.0 || h > ACCENT_H.1 || w < h || b.area as f64 > ACCENT_FILL * b.rect.w * b.rect.h {
        return false;
    }
    let (x0, y0) = (b.rect.x, b.rect.y);
    let own = |x: i64, y: i64| x >= 0 && y >= 0 && (x as usize) < f.ink.w && (y as usize) < f.ink.h && f.labels[y as usize * f.ink.w + x as usize] == b.id as i32;
    let at = |fx: f64| column(f, b, (x0 + b.rect.w * fx).round() as i64).map(|(a, c)| ((a as f64 - y0) / b.rect.h, (c as f64 - y0) / b.rect.h));
    let (Some(l), Some(r)) = (at(0.1), at(0.92)) else { return false };
    // 左端正中是空的
    let (lx, my) = ((x0 + b.rect.w * 0.1).round() as i64, (y0 + b.rect.h * 0.5).round() as i64);
    let hollow = !(-1..=1).any(|dx| (-1..=1).any(|dy| own(lx + dx, my + dy)));
    l.0 <= 0.25 && l.1 >= 0.75 && hollow && r.0 >= 0.2 && r.1 <= 0.8
}

/// 给一页各行的和弦与休止挂奏法。
pub fn artics(f: &PageFrame, rows: &mut [RowNotes]) {

    let mut used: Vec<u32> = Vec::new();
    // 延长记号：拱 + 拱下（倒着的在拱上）正中的点
    for b in &f.blobs {
        let sp = f.unit.space;
        let Some(up) = arch(f, b, sp) else { continue };
        let cx = b.rect.cx();
        let dot = f.blobs.iter().find(|d| {
            let t = (d.cy - b.rect.y) / b.rect.h;
            d.id != b.id && is_dot(d, sp, DOT_SIZE.1) && (d.cx - cx).abs() <= 0.2 * b.rect.w && if up { (0.35..=1.3).contains(&t) } else { (-0.3..=0.65).contains(&t) }
        });
        let Some(dot) = dot else { continue };
        // 拱顶朝上的记在它下面那一行谱上，倒着的记在上面那一行
        let row = (0..f.staves.len())
            .filter_map(|si| {
                let s = &f.staves[si];
                if cx < s.left - s.space() || cx > s.right + s.space() {
                    return None;
                }
                let d = if up { s.top(cx) - b.rect.bottom() } else { b.rect.y - s.bottom(cx) };
                (d >= -0.5 * s.space() && d <= FERMATA_FAR * s.space()).then_some((d, si))
            })
            .min_by(|a, b| a.0.total_cmp(&b.0));
        let Some((_, si)) = row else { continue };
        let ssp = f.staves[si].space();
        let row = &mut rows[si];
        // 横向最近的音；并排两个声部的取朝拱那一边的（拱在上取干朝上的）
        let key = |x: f64, toward: bool| (((x - cx).abs() / ssp > 0.5) as u8, !toward as u8, ((x - cx).abs() * 100.0) as i64);
        let c = row.chords.iter().enumerate().filter(|(_, c)| (c.x - cx).abs() <= FERMATA_DX * ssp).min_by_key(|(_, c)| key(c.x, c.stem.is_none_or(|s| s.up == up))).map(|(i, c)| (i, (c.x - cx).abs()));
        let r = row.rests.iter().enumerate().filter(|(_, r)| (r.x - cx).abs() <= FERMATA_DX * ssp).min_by_key(|(_, r)| key(r.x, true)).map(|(i, r)| (i, (r.x - cx).abs()));
        let arts = match (c, r) {
            (Some((i, dc)), Some((_, dr))) if dc <= dr => &mut row.chords[i].arts,
            (Some((i, _)), None) => &mut row.chords[i].arts,
            (_, Some((i, _))) => &mut row.rests[i].arts,
            _ => continue,
        };
        if !arts.contains(&Art::Fermata) {
            arts.push(Art::Fermata);
        }
        used.extend([b.id, dot.id]);
    }
    // 贴头的：断奏点、保持线、重音。在和弦外沿（头缘或干端）之外
    for (si, row) in rows.iter_mut().enumerate() {
        let s = &f.staves[si];
        let sp = s.space();
        let heads: Vec<(f64, f64)> = row.chords.iter().flat_map(|c| c.heads.iter().map(|h| (h.x, h.pos as f64))).collect();
        let (zone_top, zone_bot) = (s.top(s.left) - 9.0 * sp, s.bottom(s.left) + 9.0 * sp);
        for b in f.blobs.iter().filter(|b| b.cx >= s.left && b.cx <= s.right && b.cy >= zone_top && b.cy <= zone_bot && !used.contains(&b.id)) {
            let (w, h) = (b.rect.w / sp, b.rect.h / sp);
            let fill = b.area as f64 / (b.rect.w * b.rect.h).max(1.0);
            let (kind, dx_max, gap_max) = if is_dot(b, sp, STACC_MAX) {
                // 附点（在某个头右边、与它差不多高）不当断奏
                let pos = s.pos(b.cx, b.cy);
                if heads.iter().any(|&(hx, hp)| (b.cx - hx) / sp >= AUG_DX.0 && (b.cx - hx) / sp <= AUG_DX.1 && (pos - hp).abs() <= AUG_POS) {
                    continue;
                }
                let (xa, xb) = ((b.rect.x - AUG_LEFT.1 * sp) as i64, (b.rect.x - AUG_LEFT.0 * sp) as i64);
                let (ya, yb) = (b.rect.y as i64, b.rect.bottom() as i64);
                let ink = (ya..=yb).flat_map(|y| (xa..=xb).map(move |x| (x, y))).filter(|&(x, y)| f.ink.at(x, y) == crate::frame::ink::INK).count();
                if ink as f64 > AUG_LEFT_INK * ((xb - xa + 1) * (yb - ya + 1)) as f64 {
                    continue;
                }
                (Art::Staccato, ART_DX, ART_GAP.1)
            } else if w >= TENUTO_W.0 && w <= TENUTO_W.1 && h <= TENUTO_H && fill >= TENUTO_FILL {
                (Art::Tenuto, ART_DX, ART_GAP.1)
            } else if wedge(f, b, sp) {
                (Art::Accent, ACCENT_DX, ACCENT_GAP)
            } else {
                continue;
            };
            let hit = row
                .chords
                .iter_mut()
                .filter(|c| (c.x - b.cx).abs() <= dx_max * sp)
                .filter_map(|c| {
                    let top = (c.heads[0].y - 0.5 * sp).min(c.stem.map_or(f64::MAX, |st| st.top as f64));
                    let bot = (c.heads.last().unwrap().y + 0.5 * sp).max(c.stem.map_or(f64::MIN, |st| st.bottom as f64));
                    let above = b.cy < top;
                    // 断奏点、保持线只认贴着头的（干端那一侧的离头远、横向对的是干，与杂墨分不开）
                    if kind != Art::Accent && c.stem.is_some_and(|st| st.up == above) {
                        return None;
                    }
                    let x = if above { c.heads[0].x } else { c.heads.last().unwrap().x };
                    if (x - b.cx).abs() > dx_max * sp {
                        return None;
                    }
                    let gap = if above { top - b.rect.bottom() } else if b.cy > bot { b.rect.y - bot } else { return None };
                    (gap >= ART_GAP.0 * sp && gap <= gap_max * sp).then_some((gap, c))
                })
                .min_by(|a, b| a.0.total_cmp(&b.0));
            if let Some((_, c)) = hit {
                if !c.arts.contains(&kind) {
                    c.arts.push(kind);
                }
            }
        }
    }
}
