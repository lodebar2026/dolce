//! **空心头与全音符**（墨块性质这一路）：从符号墨里的「孔」（封闭的白团）找。
//!
//! 墨层里孤零零的谱线是存疑、不算符号墨，所以谱线之间的空白不是孔；空心头压在线上时，孔里那截谱线也是存疑，
//! 孔照样是完整的一个（头的环与谱线交叉处纵向墨段长，是墨，环不断）。
//! 孔落在音级格点上、外圈（孔加上下左右的环壁）像符头那么大的才要：升降还原号的孔外圈窄，字母的孔在谱表外没有加线作证。
//! 有干的是二分音符；没干、所在墨块就是孤立一个环的是全音符。
use super::heads::{band, Head, HeadKind, POS_MAX, POS_MIN};
use super::ledgers::ledger_ok;
use super::resolve::Claims;
use super::stems::{find_stem, Stem};
use crate::frame::ink::LINE;
use crate::page::PageFrame;
use dolce_omr_core::image::Binary;
use dolce_omr_core::pixel::contour::find_holes_area;

/// 孔的宽高范围（相对线距）。
const HOLE_W: (f64, f64) = (0.3, 1.25);
const HOLE_H: (f64, f64) = (0.2, 1.0);
/// 比最小的孔还小的白块（面积，相对线距的平方）不是头的内腔：实心头找候选时当墨（[`super::page_notes`]）。
pub const SLIT_AREA: f64 = HOLE_W.0 * HOLE_H.0;
/// 孔心离音级格点最远多少（半格为 1）。
const GRID_TOL: f64 = 0.35;
/// 外圈高、宽的范围（相对线距）。
const OUTER_H: (f64, f64) = (0.75, 1.3);
const OUTER_W: (f64, f64) = (0.95, 2.2);
/// 环壁最厚（相对线距）：全音符两侧的壁有半格多，实心头有一格多。
const WALL_MAX: f64 = 0.8;
const WALL_V: f64 = 0.3;
/// 原图上的孔占包围盒的比例过这个数的是方格子。
const BOX_FULL: f64 = 0.88;
/// 全音符：外圈至少这么宽、所在墨块不超过这么大（相对线距）。
const WHOLE_W: f64 = 1.25;
const WHOLE_BLOB: (f64, f64) = (2.3, 1.4);
/// 叠着的全音符（三度「8」字、几个摞着）连成的墨块最高（相对线距）。
const WHOLE_STACK_H: f64 = 3.2;

/// 加线那样的细横线：纵向不比谱线厚多少、横向连着至少这么长（相对线距）。找孔前先抹掉（只在找孔用的副本里），
/// 不然压在加线上的空心头，孔被加线劈成上下两半。头的环壁与它交叉处纵向墨段长，抹不到，环不断。
const LEDGER_RUN: f64 = 1.2;

/// 一页的孔，连同找孔用的两张图。
pub struct Holes {
    /// 0：符号墨抹掉加线样的细横线（压在线上的头：孔里那截线不算墨）；1：原图（间里的头：环的上下沿并在谱线里，谱线当环壁）。
    pub imgs: [Binary; 2],
    /// `(x, y, w, h)`（像素）、面积、出自哪张图。原图上的孔与第一张图的孔交叠的不重复收（压线的头在原图上被线劈成两半）。
    pub list: Vec<((i64, i64, i64, i64), i64, usize)>,
}

pub fn page_holes(f: &PageFrame) -> Holes {
    let mut ink = f.ink.symbol_ink();
    let (w, h) = (ink.w, ink.h);
    // 墨层标存疑时容线带比线宽厚出一点（线边毛糙）；间里的空心头，环的上下沿只有一两像素厚、正贴着谱线，
    // 会被一并当成线。找孔时把存疑像素里落在线宽以外的那一圈还给符号墨，环才是闭的。
    for s in &f.staves {
        let lines: &[usize] = if s.one_line { &[2] } else { &[0, 1, 2, 3, 4] };
        let (x0, x1) = (s.left.floor().max(0.0) as usize, (s.right.ceil() as usize).min(w - 1));
        for &k in lines {
            let t = s.thick[k];
            let reach = (t / 2.0 + f.unit.thick).ceil() as i64 + 1;
            for x in x0..=x1 {
                let yc = s.line_y(k, x as f64);
                let c = yc.round() as i64;
                for y in (c - reach).max(0)..=(c + reach).min(h as i64 - 1) {
                    if f.ink.at(x as i64, y) == LINE && (y as f64 - yc).abs() > t / 2.0 {
                        ink.data[y as usize * w + x] = 1;
                    }
                }
            }
        }
    }
    let max_t = (f.unit.thick * 1.5).ceil() as usize + 1;
    let min_run = (f.unit.space * LEDGER_RUN) as usize;
    // 逐像素：所在纵向墨段不厚过 max_t 的记 1
    let mut thin = vec![0u8; w * h];
    for x in 0..w {
        let mut y = 0;
        while y < h {
            if ink.data[y * w + x] == 0 {
                y += 1;
                continue;
            }
            let a = y;
            while y < h && ink.data[y * w + x] != 0 {
                y += 1;
            }
            if y - a <= max_t {
                for yy in a..y {
                    thin[yy * w + x] = 1;
                }
            }
        }
    }
    // 一行里连着的墨够长、其中细的像素抹掉
    for y in 0..h {
        let mut x = 0;
        while x < w {
            if ink.data[y * w + x] == 0 {
                x += 1;
                continue;
            }
            let a = x;
            while x < w && ink.data[y * w + x] != 0 {
                x += 1;
            }
            if x - a >= min_run {
                for xx in a..x {
                    if thin[y * w + xx] != 0 {
                        ink.data[y * w + xx] = 0;
                    }
                }
            }
        }
    }
    let min_area = (f.unit.space * f.unit.space * 0.06).max(4.0) as u32;
    let rects = |img: &Binary| -> Vec<((i64, i64, i64, i64), i64)> { find_holes_area(&img.data, w, h, min_area).chunks_exact(5).map(|c| ((c[0] as i64, c[1] as i64, c[2] as i64, c[3] as i64), c[4] as i64)).collect() };
    let first = rects(&ink);
    let cross = |a: &(i64, i64, i64, i64), b: &(i64, i64, i64, i64)| a.0 < b.0 + b.2 && b.0 < a.0 + a.2 && a.1 < b.1 + b.3 && b.1 < a.1 + a.3;
    let second: Vec<_> = rects(&f.bin).into_iter().filter(|r| !first.iter().any(|a| cross(&a.0, &r.0))).collect();
    let list = first.into_iter().map(|(r, a)| (r, a, 0)).chain(second.into_iter().map(|(r, a)| (r, a, 1))).collect();
    Holes { imgs: [ink, f.bin.clone()], list }
}

/// 孔的一侧的环壁：在包围盒那条边中点两侧各 `half` 像素的那些行（列）上，先从边往里退到孔里（斜椭圆的孔，边上那一格多半还是壁），
/// 再往外 (dx, dy) 数连着的墨。回 (最厚的壁厚, 壁伸出包围盒最远多少)。`depth`：往里最多退多少；数到 `cap` 为止。
fn wall(img: &Binary, x: i64, y: i64, dx: i64, dy: i64, half: i64, depth: i64, cap: i64) -> (i64, i64) {
    let mut best = (0, 0);
    for k in -half..=half {
        let (sx, sy) = (x + k * dy.abs(), y + k * dx.abs());
        let Some(back) = (0..depth).find(|&d| !img.ink(sx - dx * d, sy - dy * d)) else { continue };
        let (hx, hy) = (sx - dx * back, sy - dy * back);
        let t = (0..cap).take_while(|&t| img.ink(hx + dx * (t + 1), hy + dy * (t + 1))).count() as i64;
        best = (best.0.max(t), best.1.max(t - back));
    }
    best
}

/// 一行谱的空心头与全音符（各带找到的干；全音符没有）。`scale`：本页符头比常见的大多少（[`super::head_scale`]），
/// 孔、外圈、环壁、全音符墨块的尺寸上限照它放大——上限是照常见字体定的，头大的字体整页的孔都会超。
pub fn hollow_heads(f: &PageFrame, holes: &Holes, claims: &Claims, si: usize, x_from: f64, scale: f64) -> Vec<(Head, Option<Stem>)> {
    hollow_heads_traced(f, holes, claims, si, x_from, scale, &mut |_, _| {})
}

/// 同 [`hollow_heads`]，每个落在本行范围里的孔在哪一关被丢（或留下）报给 `trace(孔, 说明)`：排查用。
pub fn hollow_heads_traced(f: &PageFrame, holes: &Holes, claims: &Claims, si: usize, x_from: f64, scale: f64, trace: &mut dyn FnMut((i64, i64, i64, i64), String)) -> Vec<(Head, Option<Stem>)> {
    let s = &f.staves[si];
    let sp = s.space();
    let (lo, hi) = band(f, si);
    let wall_max = (WALL_MAX * scale * sp) as i64;
    let mut out = Vec::new();
    for &((hx, hy, hw, hh), area, which) in &holes.list {
        let img = &holes.imgs[which];
        let (cx, cy) = (hx as f64 + hw as f64 / 2.0, hy as f64 + hh as f64 / 2.0);
        if cx < x_from || cx > s.right || cy < lo || cy > hi {
            continue;
        }
        let (w, h) = (hw as f64 / sp, hh as f64 / sp);
        let hole = (hx, hy, hw, hh);
        if w < HOLE_W.0 || w > HOLE_W.1 * scale || h < HOLE_H.0 || h > HOLE_H.1 * scale {
            trace(hole, format!("孔的大小 {w:.2} × {h:.2} 格不像"));
            continue;
        }
        // 原图上的孔：两根符干（或干与小节线）夹在上下两条谱线之间的方格子也是「孔」。头的孔是斜椭圆被线截出来的，
        // 占不满包围盒；方格子占满
        let full = area as f64 / (hw * hh) as f64;
        if which == 1 && full > BOX_FULL {
            trace(hole, format!("原图上的孔占满包围盒（{full:.2}）：是线与竖笔围出的格子"));
            continue;
        }
        let at = s.pos(cx, cy);
        let pos = at.round() as i32;
        if (at - pos as f64).abs() > GRID_TOL || !(POS_MIN..=POS_MAX).contains(&pos) {
            trace(hole, format!("孔心音级 {at:.2} 不在格点上"));
            continue;
        }
        // 外圈：孔的包围盒加四面的环壁（各面在中点附近几行 / 列上取最厚的）
        let (x, y) = (cx.round() as i64, cy.round() as i64);
        let half = ((0.22 * sp).round() as i64).max(1);
        let (up, down) = (wall(img, x, hy, 0, -1, half, hh, wall_max), wall(img, x, hy + hh - 1, 0, 1, half, hh, wall_max));
        let (left, right) = (wall(img, hx, y, -1, 0, half, hw, wall_max), wall(img, hx + hw - 1, y, 1, 0, half, hw, wall_max));
        if up.1 <= 0 || down.1 <= 0 || left.1 <= 0 || right.1 <= 0 {
            trace(hole, "有一侧没有环壁".into());
            continue;
        }
        // 左右的壁厚到顶的不是环：那是一个实心头与旁边的竖笔、上下两条谱线围出的空当
        if left.0 >= wall_max || right.0 >= wall_max {
            trace(hole, format!("左右的壁太厚（左{} 右{}）：旁边是实心的墨", left.0, right.0));
            continue;
        }
        // 上下的壁只算到 `WALL_V` 格：和弦里上下相邻的头共用一道壁，间里的头上下是整条谱线。
        // 正上 / 正下另有一个头那么大的孔（三度叠着的两个空心头）：中间那道壁两家共用，这一侧只算两孔间距的一半
        let wall_v = (WALL_V * sp).ceil() as i64;
        let shared = |below: bool| -> Option<i64> {
            holes
                .list
                .iter()
                .filter(|&&((ox, oy, ow, oh), _, _)| {
                    let head_like = (ow as f64 / sp) <= HOLE_W.1 * scale && (oh as f64 / sp) <= HOLE_H.1 * scale && (ow as f64 / sp) >= HOLE_W.0;
                    head_like && (ox, oy, ow, oh) != hole && ox.max(hx) < (ox + ow).min(hx + hw) && ((ox + ow).min(hx + hw) - ox.max(hx)) * 2 >= ow.min(hw)
                })
                .map(|&((_, oy, _, oh), _, _)| if below { oy - (hy + hh) } else { hy - (oy + oh) })
                .filter(|&g| g >= 0 && g <= wall_v)
                .min()
                .map(|g| (g + 1) / 2)
        };
        let up_v = up.1.min(wall_v).min(shared(false).unwrap_or(i64::MAX));
        let down_v = down.1.min(wall_v).min(shared(true).unwrap_or(i64::MAX));
        let outer_h = (hh + up_v + down_v) as f64 / sp;
        let (xl, xr) = (hx - left.1, hx + hw - 1 + right.1);
        let outer_w = (xr - xl + 1) as f64 / sp;
        if outer_h < OUTER_H.0 || outer_h > OUTER_H.1 * scale || outer_w < OUTER_W.0 || outer_w > OUTER_W.1 * scale {
            trace(hole, format!("外圈 {outer_w:.2} × {outer_h:.2} 格不像（壁 上{} 下{} 左{} 右{}）", up.1, down.1, left.1, right.1));
            continue;
        }
        let half_w = (xr - xl + 1) as f64 / 2.0;
        let mut head = Head { staff: si, x: (xl + xr) as f64 / 2.0, y: cy, pos, kind: HeadKind::Half, fill: 0.0, score: 0.0, acc: None, rid: None };
        if !ledger_ok(f, &head, half_w) {
            trace(hole, format!("位 {pos} 在谱表外、没有加线"));
            continue;
        }
        match find_stem(&f.ink, &head, sp, f.unit.thick, Some((xl, xr)), &|x| claims.bar_col(si, x)) {
            Some(st) => {
                trace(hole, format!("二分，位 {pos}，干 {st:?}"));
                out.push((head, Some(st)))
            }
            None => {
                // 全音符：够宽、所在墨块就是孤立的一个环
                // 孔左右两边的环壁所在墨块（孔框贴着壁的那一列在符号墨里可能是白，往外找到壁）：叠成「8」字的全音符去线后常劈成左右两半，
                // 两块合起来量。合框里上下另有头那么大的孔（叠着的全音符）高可到 `WHOLE_STACK_H` 格
                let side = |x0: i64, dir: i64, reach: i64| -> i32 {
                    (1..=reach.max(1) + 1)
                        .flat_map(|dx| (0..=half).flat_map(move |k| [(dx, k), (dx, -k)]))
                        .map(|(dx, k)| (x0 + dir * dx, y + k))
                        .filter(|&(xx, yy)| xx >= 0 && (xx as usize) < f.ink.w && yy >= 0 && (yy as usize) < f.ink.h)
                        .map(|(xx, yy)| f.labels[yy as usize * f.ink.w + xx as usize])
                        .find(|&v| v != 0)
                        .unwrap_or(0)
                };
                let ids = [side(hx, -1, left.1), side(hx + hw - 1, 1, right.1)];
                let rects: Vec<_> = f.blobs.iter().filter(|b| b.id as i32 != 0 && ids.contains(&(b.id as i32))).map(|b| b.rect).collect();
                let union = rects.iter().fold(None::<(f64, f64, f64, f64)>, |u, r| {
                    let (x0, y0, x1, y1) = (r.x as f64, r.y as f64, (r.x + r.w) as f64, (r.y + r.h) as f64);
                    Some(u.map_or((x0, y0, x1, y1), |u| (u.0.min(x0), u.1.min(y0), u.2.max(x1), u.3.max(y1))))
                });
                let stacked = union.is_some_and(|u| {
                    holes.list.iter().any(|&((ox, oy, ow, oh), _, _)| {
                        (ox, oy, ow, oh) != hole && (ow as f64) <= HOLE_W.1 * scale * sp && (oh as f64) <= HOLE_H.1 * scale * sp && (ow as f64) >= HOLE_W.0 * sp
                            && ox.max(hx) < (ox + ow).min(hx + hw) && (ox as f64) >= u.0 && ((ox + ow) as f64) <= u.2 && (oy as f64) >= u.1 && ((oy + oh) as f64) <= u.3
                    })
                });
                let max_h = if stacked { WHOLE_STACK_H } else { WHOLE_BLOB.1 };
                let alone = union.is_some_and(|u| u.2 - u.0 <= WHOLE_BLOB.0 * scale * sp && u.3 - u.1 <= max_h * scale * sp);
                if outer_w >= WHOLE_W * scale && alone {
                    trace(hole, format!("全音符，位 {pos}"));
                    head.kind = HeadKind::Whole;
                    out.push((head, None));
                } else {
                    let r = union.map(|u| ((u.2 - u.0) / sp, (u.3 - u.1) / sp));
                    trace(hole, format!("位 {pos} 没有干，外圈宽 {outer_w:.2} 格、独立成块 {alone}（块 {r:.1?}）：不是全音符"));
                }
            }
        }
    }
    out
}

/// 开口内腔离谱表上下至多几格：歌词里的字母 o 也围得出一个。
const OPEN_BAND: f64 = 2.0;
/// 开口内腔的宽、高下限（相对线距）：比封闭的孔严，开口的白不论形状，太小的是笔画间的缝。
const OPEN_HOLE: (f64, f64) = (0.45, 0.3);
/// 开口内腔挂上的干比本行干宽中位宽出这么多倍的不收。
const STEM_WIDE: f64 = 1.5;
/// 开口内腔收出的头盒里的墨占比范围（环）：实心头满、空当几乎没墨。
const OPEN_FILL: (f64, f64) = (0.3, 0.75);
/// 开口内腔收出的头盒（相对线距，照本页头的放大倍数放大）。
const OPEN_HEAD: (f64, f64) = (1.25, 1.0);
/// 上下隔着这么多格以内（且多于一格）有实心头、横向又相交的：内腔是弯回符干的八分符尾围出来的。
const FLAG_REACH: f64 = 7.0;

/// 干在头外那一截的墨宽中位（像素）：从头心起 0.8 格往干梢量到梢前 0.3 格。
fn stem_width(f: &PageFrame, h: &Head, st: &Stem, sp: f64) -> f64 {
    let cy = h.y.round() as i64;
    let (a, b) = if st.up { (st.top + (0.3 * sp) as i64, cy - (0.8 * sp) as i64) } else { (cy + (0.8 * sp) as i64, st.bottom - (0.3 * sp) as i64) };
    let mut v: Vec<i64> = (a..=b).filter(|&y| f.ink.at(st.x, y) == crate::frame::ink::INK).map(|y| super::stems::width_at(&f.ink, st.x, y, sp as i64)).collect();
    if v.is_empty() {
        return 0.0;
    }
    v.sort();
    v[v.len() / 2] as f64
}

/// **开口内腔** → 二分头：扫描件上头的环有缺口（一笔印淡、二值化断开），内腔从缺口漏到谱线间的空白里，
/// [`page_holes`] 找不到孔。改认「四向都碰得到墨」的白像素：从它往左右、上下各走不过一个内腔那么远都碰到符号墨
/// （谱线不算墨，漏进谱间的白往上下走不到墨），按四连通拼成块，内腔大小的块、以它的中心定头。
/// 内腔不论形状（缺口那一侧常连着头与干之间的一截），改按头盒里的墨像环、要挂得上干、不是符尾围出来的收。
/// `taken`：已认出的头，盖住的不再收。
pub fn open_cavity_heads(f: &PageFrame, holes: &Holes, claims: &Claims, si: usize, x_from: f64, scale: f64, taken: &[(Head, Option<Stem>)]) -> Vec<(Head, Option<Stem>)> {
    let s = &f.staves[si];
    let sp = s.space();
    let img = &holes.imgs[0];
    let (bw, bh) = (img.w as i64, img.h as i64);
    let (lo, hi) = band(f, si);
    let xm = (s.left + s.right) / 2.0;
    let y0 = (s.top(xm) - OPEN_BAND * sp).max(lo).max(0.0) as i64;
    let y1 = ((s.bottom(xm) + OPEN_BAND * sp).min(hi).ceil() as i64).min(bh - 1);
    let x0 = x_from.max(0.0) as i64;
    let x1 = (s.right.ceil() as i64).min(bw - 1);
    if x1 <= x0 || y1 <= y0 {
        return Vec::new();
    }
    let (rw, rh) = ((x1 - x0 + 1) as usize, (y1 - y0 + 1) as usize);
    let reach_h = (HOLE_W.1 * scale * sp).ceil() as i64;
    let reach_v = (HOLE_H.1 * scale * sp).ceil() as i64;
    let ink = |x: i64, y: i64| img.ink(x, y);
    // 各白像素往四向到墨的距离是否都在 reach 内：逐行、逐列各扫两遍
    let mut ok = vec![0u8; rw * rh];
    for y in 0..rh {
        let yy = y0 + y as i64;
        let mut last: Option<i64> = (x0 - reach_h..x0).rev().find(|&x| ink(x, yy));
        for x in 0..rw {
            let xx = x0 + x as i64;
            if ink(xx, yy) {
                last = Some(xx);
            } else if last.is_some_and(|l| xx - l <= reach_h) {
                ok[y * rw + x] = 1;
            }
        }
        let mut next: Option<i64> = (x1 + 1..=x1 + reach_h).find(|&x| ink(x, yy));
        for x in (0..rw).rev() {
            let xx = x0 + x as i64;
            if ink(xx, yy) {
                next = Some(xx);
            } else if ok[y * rw + x] == 1 && next.is_some_and(|n| n - xx <= reach_h) {
                ok[y * rw + x] = 2;
            }
        }
    }
    for x in 0..rw {
        let xx = x0 + x as i64;
        let mut last: Option<i64> = (y0 - reach_v..y0).rev().find(|&y| ink(xx, y));
        for y in 0..rh {
            let yy = y0 + y as i64;
            if ink(xx, yy) {
                last = Some(yy);
            } else if ok[y * rw + x] == 2 && last.is_some_and(|l| yy - l <= reach_v) {
                ok[y * rw + x] = 3;
            }
        }
        let mut next: Option<i64> = (y1 + 1..=y1 + reach_v).find(|&y| ink(xx, y));
        for y in (0..rh).rev() {
            let yy = y0 + y as i64;
            if ink(xx, yy) {
                next = Some(yy);
            } else if ok[y * rw + x] == 3 && next.is_some_and(|n| n - yy <= reach_v) {
                ok[y * rw + x] = 4;
            }
        }
    }
    let min_area = (sp * sp * 0.06).max(4.0) as usize;
    // 本页没认出封闭的空心头就不找（TS 同：头盒照本页二分头定）
    if !taken.iter().any(|(h, _)| h.kind == HeadKind::Half) {
        return Vec::new();
    }
    // 本行已认出的头的干宽中位：开口内腔挂上的「干」照它比（粗笔记号的竖笔被当成干）
    let mut sw: Vec<f64> = taken.iter().filter(|(h, _)| h.staff == si).filter_map(|(h, st)| st.as_ref().map(|st| stem_width(f, h, st, sp))).filter(|&w| w > 0.0).collect();
    sw.sort_by(f64::total_cmp);
    let stem_med = sw.get(sw.len() / 2).copied().unwrap_or(f.unit.thick);
    let (hw, hh) = ((OPEN_HEAD.0 * scale * sp).round() as i64, (OPEN_HEAD.1 * scale * sp).round() as i64);
    let mut out: Vec<(Head, Option<Stem>)> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    for i in 0..ok.len() {
        if ok[i] != 4 {
            continue;
        }
        ok[i] = 5;
        stack.push(i);
        let (mut n, mut ax, mut ay, mut bx, mut by) = (0usize, rw, rh, 0usize, 0usize);
        while let Some(k) = stack.pop() {
            let (x, y) = (k % rw, k / rw);
            n += 1;
            (ax, ay, bx, by) = (ax.min(x), ay.min(y), bx.max(x), by.max(y));
            let nb = [(x > 0).then(|| k - 1), (x + 1 < rw).then(|| k + 1), (y > 0).then(|| k - rw), (y + 1 < rh).then(|| k + rw)];
            for q in nb.into_iter().flatten() {
                if ok[q] == 4 {
                    ok[q] = 5;
                    stack.push(q);
                }
            }
        }
        let (cw, ch) = ((bx - ax + 1) as f64 / sp, (by - ay + 1) as f64 / sp);
        if n < min_area || cw < OPEN_HOLE.0 || cw > HOLE_W.1 * scale || ch < OPEN_HOLE.1 || ch > HOLE_H.1 * scale {
            continue;
        }
        let cav = (x0 + ax as i64, y0 + ay as i64, (bx - ax + 1) as i64, (by - ay + 1) as i64);
        // 封闭的孔归 [`hollow_heads`] 管：它那里丢了的（升降号、实心墨夹出的空当）这里不再捡
        let cross = |a: &(i64, i64, i64, i64), b: &(i64, i64, i64, i64)| a.0 < b.0 + b.2 && b.0 < a.0 + a.2 && a.1 < b.1 + b.3 && b.1 < a.1 + a.3;
        if holes.list.iter().any(|(r, _, _)| (r.2 as f64) <= HOLE_W.1 * scale * sp && (r.3 as f64) <= HOLE_H.1 * scale * sp && cross(r, &cav)) {
            continue;
        }
        let (cx, cy) = (cav.0 as f64 + cav.2 as f64 / 2.0, cav.1 as f64 + cav.3 as f64 / 2.0);
        let pos = s.pos(cx, cy).round() as i32;
        if !(POS_MIN..=POS_MAX).contains(&pos) {
            continue;
        }
        // 已认出的头盖着的不收；上下隔一格多有实心头、横向相交的，这「内腔」是弯回干的符尾
        let clash = taken.iter().chain(out.iter()).any(|(h, _)| {
            if h.staff != si {
                return false;
            }
            let (dx, dy) = ((h.x - cx).abs(), (h.y - cy).abs());
            (dx < hw as f64 * 0.8 && dy < sp * 0.6) || (h.kind == HeadKind::Filled && dx < hw as f64 && dy >= sp && dy <= FLAG_REACH * sp)
        });
        if clash {
            continue;
        }
        let (bx0, by0) = ((cx - hw as f64 / 2.0).round() as i64, (cy - hh as f64 / 2.0).round() as i64);
        let mut n_ink = 0;
        for y in by0..by0 + hh {
            for x in bx0..bx0 + hw {
                n_ink += img.ink(x, y) as i64;
            }
        }
        let fill = n_ink as f64 / (hw * hh).max(1) as f64;
        if fill < OPEN_FILL.0 || fill > OPEN_FILL.1 {
            continue;
        }
        let head = Head { staff: si, x: cx, y: cy, pos, kind: HeadKind::Half, fill: 0.0, score: 0.0, acc: None, rid: None };
        if !ledger_ok(f, &head, hw as f64 / 2.0) {
            continue;
        }
        let Some(st) = find_stem(&f.ink, &head, sp, f.unit.thick, Some((bx0, bx0 + hw - 1)), &|x| claims.bar_col(si, x)) else { continue };
        // 挂上的干要像本行的干那么细：粗笔记号（花括号、大号字）两笔夹出的白，「干」是它自己的粗笔
        let stw = stem_width(f, &head, &st, sp);
        if stw > (STEM_WIDE * stem_med).max(stem_med + 1.0) {
            continue;
        }
        if std::env::var("OMR_OPEN_DEBUG").is_ok() {
            eprintln!("开口内腔 行{si} 孔 {cav:?} 位 {pos} 墨 {fill:.2} 干 {st:?} 干宽 {stw} / {stem_med}");
        }
        out.push((head, Some(st)));
    }
    out
}
