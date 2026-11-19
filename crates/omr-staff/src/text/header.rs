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
use dolce_omr_text::spaces::{box_ink, recover_spaces, spread};
use dolce_omr_text::{chords, words, Ch};
use super::classify::Mark;
use dolce_omr_sheet::score::Dir;

/// 行底离第一行谱至少这么多格（再近的是和弦、速度、压着谱表的杂墨）。
const CLEAR: f64 = 0.3;
/// 离谱表这么多格以内的行，像节拍器 / 力度 / 速度术语的不进页眉；和弦记号可达 `CHORD_NEAR` 格（同 `classify::CHORD_REACH`）。
const NEAR: f64 = 6.0;
const CHORD_NEAR: f64 = 9.0;
/// 图片文件没有可信的页面尺寸：按 A4 宽折算字号。
const A4_W: f64 = 595.0;

/// 页眉各条（字号折成点），与页眉里的速度记号（「♩=110」：等号前只有一个字——音符字形读成 J / q / 」之类——等号后是速度；
/// 离首行谱远、首行上方那条带收不到，同 TS 转曲路 `findTempoMark`）。
pub fn page_credits(f: &PageFrame, src: &SourceImage, ocr: &dyn DigitReader) -> (Vec<Credit>, Vec<Mark>) {
    let Some(first) = f.staves.iter().min_by(|a, b| a.ys[0].total_cmp(&b.ys[0])) else { return (Vec::new(), Vec::new()) };
    let up = f.up as f64;
    let sp = first.space();
    let top = (first.left as usize..first.right as usize).step_by(8).map(|x| first.top(x as f64)).fold(f64::MAX, f64::min);
    let h = ((top / up) as usize).min(src.h);
    if h < 16 {
        return (Vec::new(), Vec::new());
    }
    let g = Gray { w: src.w, h, data: src.gray[..src.w * h].to_vec() };
    let Some(boxes) = ocr.detect(&g) else { return (Vec::new(), Vec::new()) };
    let pw = f.ink.w;
    let mut lines: Vec<WordLine> = Vec::new();
    let mut tempo: Vec<Mark> = Vec::new();
    for b in boxes {
        if (b.y + b.h) * up > top - CLEAR * sp || b.w < 4.0 || b.h < 4.0 {
            continue;
        }
        let mut s = Gray::new(b.w.round() as usize, b.h.round() as usize, 255);
        blit(&mut s, &g, b, Rect::new(0.0, 0.0, b.w.round(), b.h.round()));
        let Some(got) = ocr.read_line(&s) else { continue };
        let mut chars: Vec<Ch> = Vec::new();
        for c in got {
            spread(c.ch.chars(), (b.x + c.x0 * b.w) * up, (b.x + c.x1 * b.w) * up, &mut chars);
        }
        // 框里的空白列（页内坐标）
        let (x0, x1) = (((b.x * up).max(0.0)) as usize, (((b.x + b.w) * up) as usize).min(pw));
        let (y0, y1) = (((b.y * up).max(0.0)) as usize, (((b.y + b.h) * up) as usize).min(f.ink.h));
        let at = |x: usize, y: usize| f.ink.tri[y * pw + x] == INK;
        let (ink_h, ia, ib, blanks) = match box_ink(x0 as i64, x1 as i64, y0 as i64, y1 as i64, |x| (y0..y1).any(|y| at(x as usize, y)), |y| (x0..x1).any(|x| at(x, y as usize))) {
            Some(bi) => (bi.height, bi.left, bi.right, bi.blanks),
            None => (b.h * up, x0 as f64, x1 as f64, Vec::new()),
        };
        let text: String = recover_spaces(&chars, &blanks, ink_h, ia, ib).iter().map(|c| c.ch).collect();
        let t = text.trim();
        if std::env::var("OMR_HEADER_DEBUG").is_ok() {
            eprintln!("页眉行 {t:?} 距谱表{:.1}格 框{:.0},{:.0} {:.0}x{:.0}", (top - (b.y + b.h) * up) / sp, b.x, b.y, b.w, b.h);
        }
        if let Some(m) = tempo_mark(t) {
            tempo.push(Mark { x: b.x * up, rect: Rect::new(b.x * up, b.y * up, b.w * up, b.h * up), dir: m });
            continue;
        }
        if !header_line_ok(t, (top - (b.y + b.h) * up) / sp) {
            continue;
        }
        lines.push(WordLine { text: t.to_string(), x: b.x, y: b.y, w: b.w, h: b.h });
    }
    let pt = if src.size_known { src.pt_per_px() } else { A4_W / src.w as f64 };
    let mut out = credits(&lines, 0.0, src.w as f64);
    for c in out.iter_mut() {
        c.size *= pt;
    }
    (out, tempo)
}

/// 一行是不是速度记号：等号前（去掉开括号与空格）至多一个字，等号后是速度（后面可以接速度术语）。
fn tempo_mark(t: &str) -> Option<Dir> {
    let eq = t.find(['=', '＝'])?;
    let pre = t[..eq].trim().trim_start_matches(['(', '（']).trim();
    if pre.chars().count() > 1 {
        return None;
    }
    // 后面紧跟的速度术语（「=88中速」）不算
    let tail = &t[eq..];
    let tail = &tail[..tail.find(dolce_omr_text::chars::is_han).unwrap_or(tail.len())];
    let (per_minute, circa) = words::metronome(tail)?;
    Some(Dir::Metronome { per_minute, circa })
}

/// 页眉候选行要不要：没有汉字、拉丁字母不到三个、也没有数字的不要；离谱表 [`NEAR`] 格以内（`gap`，格）像和弦 / 节拍器 / 力度 / 速度术语的不要。
/// 两种证据共用（矢量页的行来自文字层）。
pub fn header_line_ok(t: &str, gap: f64) -> bool {
    if han_count(t) == 0 && latin_count(t) < 3 && !t.chars().any(|c| c.is_ascii_digit()) {
        return false;
    }
    if gap <= CHORD_NEAR && chords::is_annotation_line(t) {
        return false;
    }
    !(gap <= NEAR && (words::metronome(t).is_some() || words::dynamic(t).is_some() || (words::has_term(t) && han_count(t) == 0)))
}

/// 第一行谱（最上面那行）的下标。
pub fn first_index(f: &crate::page::Layout) -> usize {
    (0..f.staves.len()).min_by(|&a, &b| f.staves[a].ys[0].total_cmp(&f.staves[b].ys[0])).unwrap_or(0)
}

/// 这行谱上方印着简谱行（混排谱）时，页眉区的下界从最上面那条简谱带的上沿量起（负数，相对谱表首线）；没有为 0。
/// 同 `classify` 量和弦区的口径：简谱行与它上面的和弦行都不是页眉。
pub fn band_lift(f: &crate::page::Layout, staff: usize) -> f64 {
    f.bands.iter().filter(|k| k.anchor == staff && k.y1 <= 0.0).map(|k| k.y0).fold(0.0, f64::min)
}
