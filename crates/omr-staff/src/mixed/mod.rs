//! **混排简谱互证**（M6）：简线混排谱上同一段旋律印了两遍——五线谱给绝对音高，简谱给级数、高低点与时值。
//!
//! - [`band`]：简谱行定位（悬在谱表外、与谱表小节线同 x 的一排短竖线）；带里整块的墨从五线谱候选里划出去，切成条
//! - [`claim`]：一页是不是混排由候选带切条试认定；条交简谱路线认（[`dolce_omr_jianpu::recognize_strip`]），读数换回页面坐标
//! - [`fuse`]：逐小节按 x 与五线谱的音配对，音高信简谱、时值只在五线谱不自洽时改、缺的照简谱补
pub mod band;
pub mod fuse;

use band::{Band, Strip};
use dolce_omr_ocr::cache::CachedOcr;
use dolce_omr_source::model::ImageKind;
use dolce_omr_source::raster::SourceImage;
use dolce_omr_core::image::{Binary, Rect};
use dolce_omr_sheet::Staff;

/// 简谱行里的一个音（页面像素坐标）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct JpNote {
    /// 数字中心 x。
    pub x: f64,
    /// 0–7（0 = 休止）。
    pub digit: u8,
    pub octave: i32,
    /// 减时线条数、附点数、增时线条数。
    pub div: u32,
    pub dots: u32,
    pub aug: u32,
    /// 数字前的升降号，相对本调音阶的那一级（♯ +1、♭ −1、♮ 0）。
    pub acc: Option<i8>,
}

/// 一条简谱行的读数。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct JpRow {
    /// 是哪一行谱的旋律（页内下标）。
    pub staff: usize,
    pub notes: Vec<JpNote>,
    /// 倚音：修饰的那个数字的中心 x、倚音的级数与八度（自左而右）。
    pub graces: Vec<JpGrace>,
}

/// 简谱行里的一个倚音（小号数字，挂在右边紧跟的主音上）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct JpGrace {
    /// 主音数字中心 x（页面像素坐标）。
    pub x: f64,
    pub digit: u8,
    pub octave: i32,
}

/// 一条读出的音至少是它小节线数的这么多倍才算认出来了（一小节一个音都不到的不是简谱行）。
const MIN_NOTES_PER_BAR: usize = 1;

/// 一条交简谱路线认，读数换回页面坐标。
fn read_strip(b: &Band, s: &Strip, ocr: &CachedOcr, known: bool) -> Option<JpRow> {
    let (w, h) = (s.bin.w, s.bin.h);
    let gray: Vec<u8> = s.bin.data.iter().map(|&v| if v != 0 { 0 } else { 255 }).collect();
    // 排查：各条写成 PGM
    if let Ok(dir) = std::env::var("OMR_MIXED_DUMP") {
        let mut out = format!("P5\n{w} {h}\n255\n").into_bytes();
        out.extend_from_slice(&gray);
        let _ = std::fs::write(format!("{dir}/strip-staff{}-y{}.pgm", b.staff, s.y), out);
    }
    let src = SourceImage { w, h, gray, rgb: Vec::new(), kind: ImageKind::Gray, rect: Rect::new(0.0, 0.0, w as f64, h as f64), page_w: w as f64, page_h: h as f64, size_known: false };
    let (scale, row) = dolce_omr_jianpu::recognize_strip(&src, ocr, known)?;
    let graces: Vec<JpGrace> = row
        .nums
        .iter()
        .flat_map(|n| n.grace.iter().filter(|g| (1..=7).contains(&g.digit)).map(move |g| JpGrace { x: s.x as f64 + (n.bbox.x + n.bbox.w / 2.0) / scale, digit: g.digit, octave: g.octave }))
        .collect();
    let notes: Vec<JpNote> = row
        .nums
        .iter()
        .filter(|n| n.digit <= 7)
        .map(|n| JpNote { x: s.x as f64 + (n.bbox.x + n.bbox.w / 2.0) / scale, digit: n.digit, octave: n.octave, div: n.div, dots: n.dot, aug: n.augment, acc: n.accidental.and_then(|a| match a { "sharp" => Some(1), "flat" => Some(-1), "natural" => Some(0), _ => None }) })
        .collect();
    (notes.len() >= b.bars.len() * MIN_NOTES_PER_BAR).then_some(JpRow { staff: b.staff, notes, graces })
}

/// 认领一页的简谱行：候选带（[`band::find`]）先切条试认，**一页要么是混排要么不是**——过半的系统带着候选带、
/// 过半的候选带照简谱路线自己的标准（多数格读得出数字）认得出数字行，这一页才算混排：带里的墨从 `bin`、`soft` 上划掉，
/// 个别没认出来的条（夹着说明文字）放宽再认一遍。否则一条都不收——歌词行里汉字的竖笔、页眉里的年份偶尔也凑得出一排。
///
/// 回收下的带、各条的读数、划掉的墨（页面那么大的二值图；文字从原图取条送检时要把这些墨抹白）。
pub fn claim(bin: &mut Binary, mut soft: Option<&mut Binary>, staves: &[Staff], systems: &[Vec<usize>], cands: Vec<Band>, ocr: &CachedOcr) -> (Vec<Band>, Vec<JpRow>, Option<Binary>) {
    let none = (Vec::new(), Vec::new(), None);
    if !has_bands(systems, &cands) {
        return none;
    }
    // 在副本上切条试认
    let mut trial = bin.clone();
    let strips: Vec<Strip> = cands.iter().map(|b| band::erase(&mut [&mut trial], b, &staves[b.anchor])).collect();
    let Some(strict) = trial_read(&cands, &strips, ocr) else { return none };
    if let Some(soft) = soft.as_mut().filter(|s| s.w == bin.w && s.h == bin.h) {
        for (b, s) in cands.iter().zip(&strips) {
            for (i, _) in s.bin.data.iter().enumerate().filter(|(_, v)| **v != 0) {
                soft.data[(s.y as usize + i / s.bin.w) * bin.w + s.x as usize + i % s.bin.w] = 0;
            }
            let _ = b;
        }
    }
    let mut gone = Binary::new(bin.w, bin.h);
    for s in &strips {
        for (i, _) in s.bin.data.iter().enumerate().filter(|(_, v)| **v != 0) {
            gone.data[(s.y as usize + i / s.bin.w) * bin.w + s.x as usize + i % s.bin.w] = 1;
        }
    }
    *bin = trial;
    let rows = finish_rows(&cands, &strips, strict, ocr);
    (cands, rows, Some(gone))
}

/// 过半的系统带着候选带（两种证据共用的认领第一关）。
pub fn has_bands(systems: &[Vec<usize>], cands: &[Band]) -> bool {
    let with = systems.iter().filter(|sys| cands.iter().any(|b| sys.contains(&b.anchor))).count();
    !cands.is_empty() && with * 2 > systems.len()
}

/// 各条照简谱路线自己的标准试认；过半认得出才算混排，否则 None。
pub fn trial_read(cands: &[Band], strips: &[Strip], ocr: &CachedOcr) -> Option<Vec<Option<JpRow>>> {
    let strict: Vec<Option<JpRow>> = cands.iter().zip(strips).map(|(b, s)| read_strip(b, s, ocr, false)).collect();
    (strict.iter().flatten().count() * 2 > cands.len()).then_some(strict)
}

/// 没认出来的条（夹着说明文字）放宽再认一遍。
pub fn finish_rows(cands: &[Band], strips: &[Strip], strict: Vec<Option<JpRow>>, ocr: &CachedOcr) -> Vec<JpRow> {
    cands.iter().zip(strips).zip(strict).filter_map(|((b, s), r)| r.or_else(|| read_strip(b, s, ocr, true))).collect()
}

/// 印在大谱表两行之间、量自下面那行谱的简谱行是上面那行谱的旋律（闭合人声谱的女高音）。两种证据共用。
pub fn settle_bands(bands: &mut [Band], jianpu: &mut [JpRow], systems: &[crate::frame::systems::System]) {
    for b in bands.iter_mut().filter(|b| b.staff == b.anchor && b.y1 <= 0.0) {
        if systems.iter().any(|sys| sys.staves.iter().position(|&i| i == b.staff).is_some_and(|n| n > 0)) {
            jianpu.iter_mut().filter(|r| r.staff == b.staff).for_each(|r| r.staff -= 1);
            b.staff -= 1;
        }
    }
}
