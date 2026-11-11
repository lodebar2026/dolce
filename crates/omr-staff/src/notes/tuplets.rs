//! **连音候选**（3.8）：和弦组上方或下方、正对着这一组中间的数字。只出候选，收不收由满拍裁决定（[`super::meter`]）——
//! 指法数字、段号也是数字，光看位置分不开；折算后本小节正好满拍的才是连音。
//!
//! 现只认三连音（三个时值相同、挨着的和弦，中间不隔小节线）。带休止的连音、二连五连、只有括号没有数字的还没做。
use super::RowNotes;
use crate::attrs::lead::{cell, digits_of};
use crate::attrs::DigitReader;
use crate::page::PageFrame;
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
        let s = &f.staves[si];
        let sp = s.space();
        let mut found: Vec<TupletCand> = Vec::new();
        for b in &f.blobs {
            let (w, h) = (b.rect.w / sp, b.rect.h / sp);
            if b.cx < s.left || b.cx > s.right || w < DIGIT_W.0 || w > DIGIT_W.1 || h < DIGIT_H.0 || h > DIGIT_H.1 || h < w {
                continue;
            }
            // 含着头的墨块是音符自己
            if row.chords.iter().any(|c| c.heads.iter().any(|hd| hd.x >= b.rect.x && hd.x <= b.rect.right() && hd.y >= b.rect.y && hd.y <= b.rect.bottom())) {
                continue;
            }
            let Some(w) = group_at(&f.layout, si, row, b.rect) else { continue };
            if found.iter().any(|t| t.chords.iter().any(|i| w.contains(i))) {
                continue;
            }
            let g = cell(f, b.rect.x as i64, b.rect.right() as i64, b.rect.y as i64, b.rect.bottom() as i64);
            if ocr.read_digit(&g).and_then(|alts| digits_of(&alts, |d| d == 3)) == Some(3) {
                found.push(TupletCand { chords: w, actual: 3, normal: 2 });
            }
        }
        row.tuplets = found;
    }
}

/// 数字（外框 `r`）上方 / 下方挨着的和弦里，挨着的三个、时值相同、不隔小节线、正中对着数字的那一组。两种证据共用。
pub fn group_at(f: &crate::page::Layout, si: usize, row: &RowNotes, r: dolce_omr_core::image::Rect) -> Option<Vec<usize>> {
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
