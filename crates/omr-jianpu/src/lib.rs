//! 简谱路线（位图）：各页原图 → [`result::RecognizedScore`]。
//!
//! - [`prep`]（JM0）：成像、连通块
//! - [`frame`]（JM1）：数字高、数字行与行带、带内切格（数字 / 小节线 / 增时线 / 点）
//! - [`notes`]（JM3）：读数、八度点、减时线、建音
//! - [`marks`]（JM3）：临时升降号、倚音、顿音、重音、波音、延长记号
//! - [`spans`]（JM5）：弧
//! - [`beats`]（JM6）：满拍裁决、可疑清单
//! - [`text`]（JM2 / JM4）：歌词、页眉、调号拍号速度
pub mod beats;
pub mod frame;
pub mod marks;
pub mod notes;
pub mod prep;
use prep::{Ink, JpInk};
pub mod result;
pub mod spans;
pub mod text;
pub mod vector;

use dolce_omr_core::image::Binary;
use dolce_omr_core::progress::Hook;
use dolce_omr_ocr::cache::CachedOcr;
use dolce_omr_source::raster::SourceImage;
use result::{RecognizedScore, StaffRow};

/// 认一条简谱行（混排谱里从谱表上方切下来的条）：回工作图相对条的缩放与读出音最多的那一行。
/// 只到建音（数字、八度点、减时线、附点、增时线、小节线），不挂歌词、不裁满拍——拍号在五线谱那边。
/// `known`：已知是简谱行，不按「多数格读得出数字」筛（见 [`frame::find_rows_in`]）；调用方拿不带它的那一遍验带的真假。
pub fn recognize_strip(src: &SourceImage, ocr: &CachedOcr, known: bool) -> Option<(f64, notes::RowNotes)> {
    let mut ink = prep::RasterInk::load(std::slice::from_ref(src))?;
    let num_h = frame::estimate_num_h(ink.comps());
    ink.despeckle(num_h);
    let rows = frame::find_rows_in(&ink, num_h, ocr, known);
    let scale = ink.w() as f64 / src.w as f64;
    if std::env::var("OMR_JP_DEBUG").is_ok() {
        eprintln!("条 {}x{} 字号 {num_h:.1}：{} 行，各行数字 {:?}", ink.w(), ink.h(), rows.len(), rows.iter().map(|r| r.digits().count()).collect::<Vec<_>>());
    }
    rows.iter().map(|row| notes::build(&ink, row, ocr, marks::RowCtx::Single)).max_by_key(|r| r.nums.len()).map(|r| (scale, r))
}

/// 识别一首（各页原图按序）。没有找到数字行回 Err。
pub fn recognize(srcs: &[SourceImage], ocr: &CachedOcr) -> Result<RecognizedScore, String> {
    recognize_hooked(srcs, ocr, &Hook::NONE).map(|r| r.0)
}

/// 同 [`recognize`]，带进度与取消；另交出识别用的二值图（各页上下拼起、过宽的已缩，结果坐标就在它上面；编辑器核对视图拿它当底图）。
pub fn recognize_hooked(srcs: &[SourceImage], ocr: &CachedOcr, hook: &Hook) -> Result<(RecognizedScore, Binary), String> {
    let mut ink = prep::RasterInk::load(srcs).ok_or("没有页面")?;
    let num_h = frame::estimate_num_h(ink.comps());
    ink.despeckle(num_h);
    let score = recognize_ink_hooked(&ink, num_h, ocr, hook)?;
    Ok((score, ink.bin.clone()))
}

/// 识别一首纯矢量的简谱（各页的路径与文字层，按序）：证据换成对象库（[`vector::VecJpInk`]），判据同像素路。
pub fn recognize_vector(pcs: &[dolce_omr_source::model::PageContent], ocr: &CachedOcr) -> Result<RecognizedScore, String> {
    recognize_vector_hooked(pcs, ocr, &Hook::NONE)
}

/// 同 [`recognize_vector`]，带进度与取消。
pub fn recognize_vector_hooked(pcs: &[dolce_omr_source::model::PageContent], ocr: &CachedOcr, hook: &Hook) -> Result<RecognizedScore, String> {
    let ink = vector::VecJpInk::new(pcs).ok_or("没有对象")?;
    let num_h = frame::estimate_num_h(ink.comps());
    recognize_ink_hooked(&ink, num_h, ocr, hook)
}

/// 识别一首（证据已备好：像素页的墨层或矢量页的对象库；`num_h` 数字字号）。像素、矢量两种证据同一份判据。
pub fn recognize_ink(ink: &Ink, num_h: f64, ocr: &CachedOcr) -> Result<RecognizedScore, String> {
    recognize_ink_hooked(ink, num_h, ocr, &Hook::NONE)
}

/// 简谱识别分几步报进度：数字行、建音、歌词、页眉、弧与和弦、满拍裁决。
const STEPS: usize = 6;

pub fn recognize_ink_hooked(ink: &Ink, num_h: f64, ocr: &CachedOcr, hook: &Hook) -> Result<RecognizedScore, String> {
    hook.step(0, STEPS, "rows")?;
    let rows = frame::find_rows(ink, num_h, ocr);
    if rows.is_empty() {
        return Err("没有找到数字行".into());
    }
    let w = ink.w() as f64;
    let mut score = RecognizedScore { key: "C".into(), beats: 4, beat_type: 4, ..Default::default() };
    hook.step(1, STEPS, "notes")?;
    let sys = frame::systems(ink, &rows);
    let voiced = sys.iter().any(|s| s.is_some());
    let ctx = |i: usize| match (sys[i], voiced) {
        (Some(_), _) => marks::RowCtx::InSystem,
        (None, true) => marks::RowCtx::VoicedLoose,
        _ => marks::RowCtx::Single,
    };
    let mut notes: Vec<notes::RowNotes> = rows.iter().enumerate().map(|(i, row)| notes::build(ink, row, ocr, ctx(i))).collect();
    let mut labels: Vec<Vec<String>> = vec![Vec::new(); rows.len()];
    hook.step(2, STEPS, "lyrics")?;
    text::lyrics(ink, &rows, &mut notes, &mut labels, ocr, &mut score.lyric_regions, &mut score.stanza_regions);
    hook.step(3, STEPS, "header")?;
    text::header(ink, &rows, num_h, ocr, &mut score);
    hook.step(4, STEPS, "spans")?;
    let mut halves = Vec::with_capacity(rows.len());
    for i in 0..rows.len() {
        // 上方带的顶：上一行最末一行歌词的底
        // 末一条词带常把底下的弧切进来（带高比别的词行高出一截）：各条按本处词行高的中位封底
        let y_min = if i == 0 {
            0.0
        } else {
            let (lo, hi) = (rows[i - 1].bottom_at(w / 2.0), rows[i].top_at(w / 2.0));
            let between: Vec<&dolce_omr_core::image::Rect> = score.lyric_regions.iter().map(|r| &r.bbox).filter(|b| b.bottom() < hi && b.bottom() > lo).collect();
            let med = dolce_omr_core::geom::median(&between.iter().map(|b| b.h).collect::<Vec<_>>(), 0.0);
            between.iter().map(|b| if between.len() >= 2 { b.bottom().min(b.y + med * 1.15) } else { b.bottom() }).fold(lo, f64::max)
        };
        halves.push(spans::arcs(ink, &rows[i], &mut notes[i], y_min, ocr));
        text::chords_above(ink, &rows[i], &mut notes[i], ocr, y_min, &mut score.chord_regions);
    }
    spans::pair_halves(&mut notes, &halves);
    hook.step(5, STEPS, "beats")?;
    let tally = beats::settle(&mut notes, &sys, &mut score);
    if std::env::var("OMR_JP_DEBUG").is_ok() {
        eprintln!("字号 {num_h:.1}，页 {}x{}；拍号 {}/{}，小节 {}：满拍 {}（其中裁决改的 {}），不满 / 超拍 {}", ink.w(), ink.h(), score.beats, score.beat_type, tally.bars, tally.full, tally.fixed, tally.bad);
        for (i, r) in rows.iter().enumerate() {
            if std::env::var("OMR_JP_CELLS").is_ok() {
                for c in &r.cells {
                    eprintln!("    格 x{}-{} y{}-{} {:?}", c.x0, c.x1, c.y0, c.y1, c.kind);
                }
            }
            eprintln!("行{i} y{:.0}-{:.0} 高{:.1} 数字{} 线{} 音{} 系统{:?}", r.top_at(w / 2.0), r.bottom_at(w / 2.0), r.h(), r.digits().count(), r.bars().count(), notes[i].nums.len(), sys[i]);
        }
    }
    for (((row, rn), labels), sv) in rows.iter().zip(notes).zip(labels).zip(sys) {
        score.rows.push(StaffRow {
            system: sv.map(|s| s.0),
            voice: sv.map(|s| s.1),
            lyric_labels: labels,
            top_y: row.top_at(w / 2.0),
            bottom_y: row.bottom_at(w / 2.0),
            nums: rn.nums,
            barline_xs: rn.barline_xs,
            final_barline: rn.final_end.then_some("end"),
            double_bar_xs: rn.double_bar_xs,
            end_bar_xs: rn.end_bar_xs,
            ..Default::default()
        });
    }
    Ok(score)
}
