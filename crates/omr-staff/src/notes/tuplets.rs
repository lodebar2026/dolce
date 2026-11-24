//! **连音候选**（3.8）：和弦组上方或下方、正对着这一组中间的数字。只出候选，收不收由满拍裁决定（[`super::meter`]）——
//! 指法数字、段号也是数字，光看位置分不开；折算后本小节正好满拍的才是连音。
//!
//! 现只认三连音（三个时值相同、挨着的和弦，中间不隔小节线）。带休止的连音、二连五连、只有括号没有数字的还没做。
use super::RowNotes;
use crate::attrs::lead::{cell, digits_of};
use crate::attrs::DigitReader;
use crate::page::PageFrame;
use dolce_omr_core::image::Rect;
use serde::{Deserialize, Serialize};

/// 数字的宽、高范围（相对线距）。
const DIGIT_W: (f64, f64) = (0.45, 1.5);
const DIGIT_H: (f64, f64) = (0.9, 2.3);
/// 数字离这一组和弦外沿（头缘或干端）最远这么多、数字心与这一组正中横向最多差这么多（相对线距）。
const NEAR: f64 = 2.6;
const CENTER_DX: f64 = 0.8;
/// 一组里相邻两个和弦最远隔这么多（相对线距）。
const STEP_MAX: f64 = 6.0;

/// 一处连音候选：行内这几个和弦（下标，按 x 排）`actual` 个占 `normal` 个的时值。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TupletCand {
    pub chords: Vec<usize>,
    pub actual: u8,
    pub normal: u8,
}

/// 给一页各行找连音候选（记在 [`RowNotes::tuplets`]）。没有读数字的就不找。
pub fn tuplets(f: &PageFrame, rows: &mut [RowNotes], ocr: Option<&dyn DigitReader>) {
    let Some(ocr) = ocr else { return };
    for (si, row) in rows.iter_mut().enumerate() {
        row.tuplets = Vec::new();
        add_by_blobs(f, si, row, ocr);
    }
}

/// 按页框墨块找第 `si` 行的连音候选，追加到 `row.tuplets`（已有候选占着的和弦不重复收）。位图页用。
pub fn add_by_blobs(f: &PageFrame, si: usize, row: &mut RowNotes, ocr: &dyn DigitReader) {
    let rects: Vec<Rect> = f.blobs.iter().map(|b| b.rect).collect();
    add_by_rects(&f.layout, si, row, &rects, &|r: &Rect| {
        let g = cell(f, r.x as i64, r.right() as i64, r.y as i64, r.bottom() as i64);
        ocr.read_digit(&g).and_then(|alts| digits_of(&alts, |d| d == 3)) == Some(3)
    });
}

/// 给定的候选外框里找第 `si` 行的连音候选，追加到 `row.tuplets`：数字大小、不含着头、正对着一组和弦、`is3` 读出 3 的收下。
/// 位图页的外框是墨块（[`add_by_blobs`]）；转曲矢量页的「3」是一个路径对象，外框取对象的块，读数只画这一个对象（不与谱线、干粘连）。
pub fn add_by_rects(f: &crate::page::Layout, si: usize, row: &mut RowNotes, rects: &[Rect], is3: &dyn Fn(&Rect) -> bool) {
    let s = &f.staves[si];
    let sp = s.space();
    for r in rects {
        let (w, h) = (r.w / sp, r.h / sp);
        if r.cx() < s.left || r.cx() > s.right || w < DIGIT_W.0 || w > DIGIT_W.1 || h < DIGIT_H.0 || h > DIGIT_H.1 || h < w {
            continue;
        }
        // 含着头的墨块是音符自己
        if row.chords.iter().any(|c| c.heads.iter().any(|hd| hd.x >= r.x && hd.x <= r.right() && hd.y >= r.y && hd.y <= r.bottom())) {
            continue;
        }
        let Some(w) = group_at(f, si, row, *r) else { continue };
        if row.tuplets.iter().any(|t| t.chords.iter().any(|i| w.contains(i))) {
            continue;
        }
        if is3(r) {
            row.tuplets.push(TupletCand { chords: w, actual: 3, normal: 2 });
        }
    }
}

/// 数字（外框 `r`）上方 / 下方挨着的和弦里，挨着的三个、时值相同、不隔小节线、正中对着数字的那一组。两种证据共用。
pub fn group_at(f: &crate::page::Layout, si: usize, row: &RowNotes, r: Rect) -> Option<Vec<usize>> {
    let sp = f.staves[si].space();
    let (cx, cy) = (r.cx(), r.y + r.h / 2.0);
    let bar_between = |a: f64, b: f64| f.bars.get(si).is_some_and(|bs| bs.iter().any(|l| l.x > a && l.x < b));
    let near: Vec<usize> = (0..row.chords.len())
        .filter(|&i| {
            let c = &row.chords[i];
            let top = (c.heads[0].y - 0.5 * sp).min(c.stem.map_or(f64::MAX, |st| st.top as f64));
            let bot = (c.heads.last().unwrap().y + 0.5 * sp).max(c.stem.map_or(f64::MIN, |st| st.bottom as f64));
            let gap = if cy < top { top - r.bottom() } else if cy > bot { r.y - bot } else { return false };
            gap <= NEAR * sp && (c.x - cx).abs() <= STEP_MAX * sp
        })
        .collect();
    near.windows(3)
        .filter(|w| {
            let c = |k: usize| &row.chords[w[k]];
            c(0).ntype() == c(1).ntype() && c(1).ntype() == c(2).ntype() && c(0).dots + c(1).dots + c(2).dots == 0 && c(1).x - c(0).x <= STEP_MAX * sp && c(2).x - c(1).x <= STEP_MAX * sp && !bar_between(c(0).x, c(2).x)
        })
        .map(|w| (((row.chords[w[0]].x + row.chords[w[2]].x) / 2.0 - cx).abs(), w))
        .filter(|(d, _)| *d <= CENTER_DX * sp)
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, w)| w.to_vec())
}
