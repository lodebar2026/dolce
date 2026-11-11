//! 简谱路线（位图）：各页原图 → [`result::RecognizedScore`]。
//!
//! - [`prep`]（JM0）：成像、连通块
//! - [`frame`]（JM1）：数字高、数字行与行带、带内切格（数字 / 小节线 / 增时线 / 点）
//! - [`notes`]（JM3）：读数、八度点、减时线、建音
//! - [`spans`]（JM5）：弧
//! - [`text`]（JM2 / JM4）：歌词、页眉、调号拍号速度
pub mod frame;
pub mod notes;
pub mod prep;
pub mod result;
pub mod spans;
pub mod text;

use dolce_omr_ocr::cache::CachedOcr;
use dolce_omr_source::raster::SourceImage;
use result::{RecognizedScore, StaffRow};

/// 识别一首（各页原图按序）。没有找到数字行回 Err。
pub fn recognize(srcs: &[SourceImage], ocr: &CachedOcr) -> Result<RecognizedScore, String> {
    let ink = prep::Ink::load(srcs).ok_or("没有页面")?;
    let num_h = frame::estimate_num_h(&ink.comps);
    let rows = frame::find_rows(&ink, num_h, ocr);
    if rows.is_empty() {
        return Err("没有找到数字行".into());
    }
    let w = ink.bin.w as f64;
    let mut score = RecognizedScore { key: "C".into(), beats: 4, beat_type: 4, ..Default::default() };
    let mut notes: Vec<notes::RowNotes> = rows.iter().map(|row| notes::build(&ink, row, ocr)).collect();
    let mut labels: Vec<Vec<String>> = vec![Vec::new(); rows.len()];
    text::lyrics(&ink, &rows, &mut notes, &mut labels, ocr, &mut score.lyric_regions);
    text::header(&ink, &rows, num_h, ocr, &mut score);
    for i in 0..rows.len() {
        // 上方带的顶：上一行最末一行歌词的底
        let y_min = if i == 0 { 0.0 } else { score.lyric_regions.iter().map(|r| r.bbox.bottom()).filter(|&b| b < rows[i].top_at(w / 2.0) && b > rows[i - 1].bottom_at(w / 2.0)).fold(rows[i - 1].bottom_at(w / 2.0), f64::max) };
        spans::arcs(&ink, &rows[i], &mut notes[i], y_min);
        text::chords_above(&ink, &rows[i], &mut notes[i], ocr, y_min, &mut score.chord_regions);
    }
    let sys = frame::systems(&ink, &rows);
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
