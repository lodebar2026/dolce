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
const WHOLE_W: f64 = 1.3;
const WHOLE_BLOB: (f64, f64) = (2.3, 1.4);

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

/// 一行谱的空心头与全音符（各带找到的干；全音符没有）。
pub fn hollow_heads(f: &PageFrame, holes: &Holes, claims: &Claims, si: usize, x_from: f64) -> Vec<(Head, Option<Stem>)> {
    hollow_heads_traced(f, holes, claims, si, x_from, &mut |_, _| {})
}

/// 同 [`hollow_heads`]，每个落在本行范围里的孔在哪一关被丢（或留下）报给 `trace(孔, 说明)`：排查用。
pub fn hollow_heads_traced(f: &PageFrame, holes: &Holes, claims: &Claims, si: usize, x_from: f64, trace: &mut dyn FnMut((i64, i64, i64, i64), String)) -> Vec<(Head, Option<Stem>)> {
    let s = &f.staves[si];
    let sp = s.space();
    let (lo, hi) = band(f, si);
    let wall_max = (WALL_MAX * sp) as i64;
    let mut out = Vec::new();
    for &((hx, hy, hw, hh), area, which) in &holes.list {
        let img = &holes.imgs[which];
        let (cx, cy) = (hx as f64 + hw as f64 / 2.0, hy as f64 + hh as f64 / 2.0);
        if cx < x_from || cx > s.right || cy < lo || cy > hi {
            continue;
        }
        let (w, h) = (hw as f64 / sp, hh as f64 / sp);
        let hole = (hx, hy, hw, hh);
        if w < HOLE_W.0 || w > HOLE_W.1 || h < HOLE_H.0 || h > HOLE_H.1 {
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
        // 上下的壁只算到 `WALL_V` 格：和弦里上下相邻的头共用一道壁，间里的头上下是整条谱线
        let wall_v = (WALL_V * sp).ceil() as i64;
        let outer_h = (hh + up.1.min(wall_v) + down.1.min(wall_v)) as f64 / sp;
        let (xl, xr) = (hx - left.1, hx + hw - 1 + right.1);
        let outer_w = (xr - xl + 1) as f64 / sp;
        if outer_h < OUTER_H.0 || outer_h > OUTER_H.1 || outer_w < OUTER_W.0 || outer_w > OUTER_W.1 {
            trace(hole, format!("外圈 {outer_w:.2} × {outer_h:.2} 格不像（壁 上{} 下{} 左{} 右{}）", up.1, down.1, left.1, right.1));
            continue;
        }
        let half_w = (xr - xl + 1) as f64 / 2.0;
        let mut head = Head { staff: si, x: (xl + xr) as f64 / 2.0, y: cy, pos, kind: HeadKind::Half, fill: 0.0, score: 0.0, acc: None };
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
                let id = (0..=half).flat_map(|k| [k, -k]).map(|k| f.labels[(y + k) as usize * f.ink.w + (hx - 1) as usize]).find(|&v| v != 0).unwrap_or(0);
                let alone = f.blobs.iter().find(|b| b.id as i32 == id).is_some_and(|b| b.rect.w <= WHOLE_BLOB.0 * sp && b.rect.h <= WHOLE_BLOB.1 * sp);
                if outer_w >= WHOLE_W && alone {
                    trace(hole, format!("全音符，位 {pos}"));
                    head.kind = HeadKind::Whole;
                    out.push((head, None));
                } else {
                    trace(hole, format!("位 {pos} 没有干，外圈宽 {outer_w:.2} 格、独立成块 {alone}：不是全音符"));
                }
            }
        }
    }
    out
}
