//! 页眉（M4 4.6）：页顶到第一行谱之间用文字检测找行、逐行读，再按文字与位置分类（[`dolce_omr_text::header`]）。
//! 页眉的行左右各一块、上下错开，按投影切不开；这里又没有谱表干扰，检测模型够用。
use crate::attrs::DigitReader;
use crate::frame::ink::INK;
use crate::page::PageFrame;
use dolce_omr_core::image::Rect;
use dolce_omr_ocr::surface::{blit, Gray};
use dolce_omr_source::raster::SourceImage;
use dolce_omr_text::chars::{han_count, latin_count};
use dolce_omr_text::header::{credits, Credit, WordLine};
use dolce_omr_text::spaces::recover_spaces;
use dolce_omr_text::{chords, words, Ch};

/// 行底离第一行谱至少这么多格（再近的是和弦、速度、压着谱表的杂墨）。
const CLEAR: f64 = 0.3;
/// 离谱表这么多格以内的行，像和弦 / 节拍器 / 力度的不进页眉。
const NEAR: f64 = 6.0;
/// 图片文件没有可信的页面尺寸：按 A4 宽折算字号。
const A4_W: f64 = 595.0;

/// 页眉各条（字号折成点）。
pub fn page_credits(f: &PageFrame, src: &SourceImage, ocr: &dyn DigitReader) -> Vec<Credit> {
    let Some(first) = f.staves.iter().min_by(|a, b| a.ys[0].total_cmp(&b.ys[0])) else { return Vec::new() };
    let up = f.up as f64;
    let sp = first.space();
    let top = (first.left as usize..first.right as usize).step_by(8).map(|x| first.top(x as f64)).fold(f64::MAX, f64::min);
    let h = ((top / up) as usize).min(src.h);
    if h < 16 {
        return Vec::new();
    }
    let g = Gray { w: src.w, h, data: src.gray[..src.w * h].to_vec() };
    let Some(boxes) = ocr.detect(&g) else { return Vec::new() };
    let pw = f.ink.w;
    let mut lines: Vec<WordLine> = Vec::new();
    for b in boxes {
        if (b.y + b.h) * up > top - CLEAR * sp || b.w < 4.0 || b.h < 4.0 {
            continue;
        }
        let mut s = Gray::new(b.w.round() as usize, b.h.round() as usize, 255);
        blit(&mut s, &g, b, Rect::new(0.0, 0.0, b.w.round(), b.h.round()));
        let Some(got) = ocr.read_line(&s) else { continue };
        let mut chars: Vec<Ch> = Vec::new();
        for c in got {
            let cs: Vec<char> = c.ch.chars().collect();
            let (a, z) = ((b.x + c.x0 * b.w) * up, (b.x + c.x1 * b.w) * up);
            let n = cs.len().max(1) as f64;
            for (i, ch) in cs.into_iter().enumerate() {
                chars.push(Ch { ch, x0: a + (z - a) * i as f64 / n, x1: a + (z - a) * (i + 1) as f64 / n });
            }
        }
        // 框里的空白列（页内坐标）
        let (x0, x1) = (((b.x * up).max(0.0)) as usize, (((b.x + b.w) * up) as usize).min(pw));
        let (y0, y1) = (((b.y * up).max(0.0)) as usize, (((b.y + b.h) * up) as usize).min(f.ink.h));
        let col = |x: usize| (y0..y1).any(|y| f.ink.tri[y * pw + x] == INK);
        let mut blanks = Vec::new();
        let mut start = None;
        let (mut ink_top, mut ink_bot) = (y1, y0);
        for x in x0..x1 {
            match (col(x), start) {
                (false, None) => start = Some(x),
                (true, Some(s0)) => {
                    if s0 > x0 {
                        blanks.push((s0 as f64, (x - s0) as f64));
                    }
                    start = None;
                }
                _ => {}
            }
        }
        for y in y0..y1 {
            if (x0..x1).any(|x| f.ink.tri[y * pw + x] == INK) {
                ink_top = ink_top.min(y);
                ink_bot = ink_bot.max(y);
            }
        }
        let ink_h = if ink_bot >= ink_top { (ink_bot - ink_top + 1) as f64 } else { b.h * up };
        let text: String = recover_spaces(&chars, &blanks, ink_h).iter().map(|c| c.ch).collect();
        let t = text.trim();
        if han_count(t) == 0 && latin_count(t) < 3 && !t.chars().any(|c| c.is_ascii_digit()) {
            continue;
        }
        let near = (top - (b.y + b.h) * up) / sp <= NEAR;
        if near && (chords::is_annotation_line(t) || words::metronome(t).is_some() || words::dynamic(t).is_some()) {
            continue;
        }
        lines.push(WordLine { text: t.to_string(), x: b.x, y: b.y, w: b.w, h: b.h });
    }
    let pt = if src.size_known { src.pt_per_px() } else { A4_W / src.w as f64 };
    let mut out = credits(&lines, 0.0, src.w as f64);
    for c in out.iter_mut() {
        c.size *= pt;
    }
    out
}
