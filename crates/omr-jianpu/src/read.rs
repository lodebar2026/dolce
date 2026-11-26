//! **认字门面**：带文字层的矢量页（Word 等排出的可复制文本 PDF）直接取文字层的字，不送 OCR；像素页、转曲页（没有文字层）照旧走 OCR，送的图一样不变。
//!
//! 各处认字原来都是「按框裁图 → OCR」，这里多收一个框：先问证据 [`JpInk::text_in`] 框里有没有文字层的字，有就按 OCR 的口径交回
//! （全角数字、字母折半角，同 [`crate::text::fold`]；一行的逐字横向位置折成条宽的比例），没有才裁图送 OCR。
//! 判据一行不改：文字层只替换「读出来是什么字」，切格、定带、对位照旧看墨。
use crate::prep::Ink;
use dolce_omr_core::image::Rect;
use dolce_omr_ocr::cache::CachedOcr;
use dolce_omr_ocr::{CharPos, RankedChar};
use dolce_omr_ocr::surface::Gray;

/// `ink.strip(r, pad)` 那张条盖住的框。
pub fn strip_frame(r: &Rect, pad: i64) -> Rect {
    let (x0, y0) = (r.x.floor() - pad as f64, r.y.floor() - pad as f64);
    Rect::new(x0, y0, (r.w.ceil() + 2.0 * pad as f64).max(1.0), (r.h.ceil() + 2.0 * pad as f64).max(1.0))
}

/// `ink.crop_bin(r)` 那张图盖住的框。
pub fn crop_frame(r: &Rect) -> Rect {
    Rect::new(r.x.round(), r.y.round(), r.w.round().max(1.0), r.h.round().max(1.0))
}

fn text_of(cs: &[(char, Rect)]) -> String {
    cs.iter().map(|c| crate::text::fold(c.0)).collect()
}

/// 框里文字层的字（没有回 None）。
pub fn layer(ink: &Ink, r: &Rect) -> Option<String> {
    ink.text_in(r).map(|cs| text_of(&cs))
}

/// 逐格读（同 `CachedOcr::read_cells`）：`rects[i]` 是第 i 格的框，文字层没字的格才用 `img(i)` 裁图送 OCR。
pub fn cells(ink: &Ink, ocr: &CachedOcr, rects: &[Rect], img: impl Fn(usize) -> Gray) -> Result<Vec<String>, String> {
    let mut out: Vec<Option<String>> = rects.iter().map(|r| layer(ink, r)).collect();
    let miss: Vec<usize> = (0..rects.len()).filter(|&i| out[i].is_none()).collect();
    if !miss.is_empty() {
        let imgs: Vec<Gray> = miss.iter().map(|&i| img(i)).collect();
        for (i, t) in miss.into_iter().zip(ocr.read_cells(&imgs)?) {
            out[i] = Some(t);
        }
    }
    Ok(out.into_iter().map(Option::unwrap_or_default).collect())
}

/// 文字层的一行字 → OCR 一行的形状（逐字左右缘折成 `frame` 宽的比例）。
fn line_of(cs: &[(char, Rect)], frame: &Rect) -> Vec<CharPos> {
    cs.iter()
        .map(|(c, r)| CharPos { ch: crate::text::fold(*c).to_string(), x0: (r.x - frame.x) / frame.w, x1: (r.right() - frame.x) / frame.w })
        .collect()
}

/// 读一行（同 `CachedOcr::read_line`）：`frame` 是条盖住的框（见 [`strip_frame`] / [`crop_frame`]）。
pub fn line(ink: &Ink, ocr: &CachedOcr, frame: &Rect, img: impl FnOnce() -> Gray) -> Result<Vec<CharPos>, String> {
    match ink.text_in(frame) {
        Some(cs) => Ok(line_of(&cs, frame)),
        None => ocr.read_line(&img()),
    }
}

/// 文字层的字是确定的：候选只有它自己、满分。
fn ranked_of(cs: &[CharPos]) -> Vec<RankedChar> {
    cs.iter().map(|c| RankedChar { ch: c.ch.clone(), alts: vec![c.ch.clone()], scores: vec![1.0] }).collect()
}

/// 同 `CachedOcr::read_line_ranked`。
pub fn line_ranked(ink: &Ink, ocr: &CachedOcr, frame: &Rect, k: usize, img: impl FnOnce() -> Gray) -> Result<(Vec<CharPos>, Vec<RankedChar>), String> {
    match ink.text_in(frame) {
        Some(cs) => {
            let l = line_of(&cs, frame);
            let r = ranked_of(&l);
            Ok((l, r))
        }
        None => ocr.read_line_ranked(&img(), k),
    }
}

/// 文字检测（同 `CachedOcr::detect`，框在 `frame` 那张图的坐标里）：文字层有字就按字排行——中心 y 相差不过半个字高的同行、
/// 行内空当过两个字高分段，各段的外框就是一个检出框。
pub fn detect(ink: &Ink, ocr: &CachedOcr, frame: &Rect, img: impl FnOnce() -> Gray) -> Result<Vec<Rect>, String> {
    let Some(mut cs) = ink.text_in(frame) else { return ocr.detect(&img()) };
    cs.sort_by(|a, b| a.1.cy().total_cmp(&b.1.cy()));
    let mut lines: Vec<Vec<(char, Rect)>> = Vec::new();
    for c in cs {
        match lines.last_mut() {
            Some(l) if (c.1.cy() - l[0].1.cy()).abs() <= l.iter().map(|x| x.1.h).fold(c.1.h, f64::max) * 0.5 => l.push(c),
            _ => lines.push(vec![c]),
        }
    }
    let mut out = Vec::new();
    for mut l in lines {
        l.sort_by(|a, b| a.1.x.total_cmp(&b.1.x));
        let h = l.iter().map(|x| x.1.h).fold(0.0, f64::max);
        let mut seg = l[0].1;
        for c in &l[1..] {
            if c.1.x - seg.right() > h * 2.0 {
                out.push(seg);
                seg = c.1;
            } else {
                seg = seg.union(&c.1);
            }
        }
        out.push(seg);
    }
    Ok(out.into_iter().map(|r| Rect::new(r.x - frame.x, r.y - frame.y, r.w, r.h)).collect())
}
