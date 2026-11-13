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
    let mut rows = frame::find_rows(ink, num_h, ocr);
    if rows.is_empty() {
        return Err("没有找到数字行".into());
    }
    let w = ink.w() as f64;
    let mut score = RecognizedScore { key: "C".into(), beats: 4, beat_type: 4, ..Default::default() };
    hook.step(1, STEPS, "notes")?;
    let sys = frame::systems(ink, &rows);
    frame::mutual_bars(ink, &mut rows, &sys);
    let voiced = sys.iter().any(|s| s.is_some());
    let ctx = |i: usize| match (sys[i], voiced) {
        (Some(_), _) => marks::RowCtx::InSystem,
        (None, true) => marks::RowCtx::VoicedLoose,
        _ => marks::RowCtx::Single,
    };
    let mut notes: Vec<notes::RowNotes> = rows.iter().enumerate().map(|(i, row)| notes::build(ink, row, ocr, ctx(i))).collect();
    settle_shared_dots(&mut notes);
    promote_glued_up(&mut notes);
    spans::endings(ink, &rows, &mut notes, ocr);
    let mut labels: Vec<Vec<String>> = vec![Vec::new(); rows.len()];
    hook.step(2, STEPS, "lyrics")?;
    text::stacked_meters(ink, &rows, &mut notes, ocr);
    marks::segno(ink, &rows, &mut notes, num_h);
    text::lyrics(ink, &rows, &mut notes, &mut labels, ocr, &mut score.lyric_regions, &mut score.stanza_regions, &mut score.footnotes);
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
    text::split_spanning_words(&mut notes);
    // 全局合理性（同 TS）：真配了和弦的谱子基本上每小节至少一个（最稀的一首 0.56 个/小节）；稀稀拉拉几个多半是弧、点、页眉读成的，整批作废
    {
        let bars: usize = notes.iter().map(|r| r.barline_xs.len()).sum();
        let chord_n: usize = notes.iter().map(|r| r.nums.iter().filter(|n| n.chord.is_some()).count()).sum();
        if bars >= 4 && (chord_n as f64) < bars as f64 * 0.4 {
            for n in notes.iter_mut().flat_map(|r| r.nums.iter_mut()) {
                n.chord = None;
                n.chord_offset = None;
                n.extra_chords.clear();
            }
            score.chord_regions.clear();
        }
    }
    hook.step(5, STEPS, "beats")?;
    text::slash_meters(ink, &rows, &mut notes, ocr);
    let tally = beats::settle(&mut notes, &sys, &mut score);
    implied_ties(&mut notes);
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
    // 末行（多声部谱是末系统的各声部行）行末并排两根不作他想，就是终止线——细粗之别常印不出来
    let last_sys = sys.last().copied().flatten().map(|s| s.0);
    let mut thin_end = vec![false; rows.len()];
    for (i, rn) in notes.iter_mut().enumerate() {
        let last = i + 1 == rows.len() || (last_sys.is_some() && sys[i].map(|s| s.0) == last_sys);
        let tail = rn.nums.last().map_or(f64::MIN, |n| n.bbox.right());
        if last && !rn.final_end && rn.double_bar_xs.last().is_some_and(|&x| x > tail) {
            rn.double_bar_xs.pop();
            rn.final_end = true;
            thin_end[i] = true;
        }
        // 末音之后还有两根单线、中间什么都没有：小节不会是空的，是隔得开的终止线（青年诗歌 98 两根隔一个字号）
        let n = rn.barline_xs.len();
        let h = rows[i].h();
        if last && !rn.final_end && n >= 2 && rn.barline_xs[n - 2] > tail && rn.barline_xs[n - 1] - rn.barline_xs[n - 2] <= h * 1.5 {
            rn.barline_xs.pop();
            rn.final_end = true;
            thin_end[i] = true;
        }
    }
    for ((((row, rn), labels), sv), thin) in rows.iter().zip(notes).zip(labels).zip(sys).zip(thin_end) {
        score.rows.push(StaffRow {
            system: sv.map(|s| s.0),
            voice: sv.map(|s| s.1),
            lyric_labels: labels,
            top_y: row.top_at(w / 2.0),
            bottom_y: row.bottom_at(w / 2.0),
            nums: rn.nums,
            barline_xs: rn.barline_xs,
            final_barline: rn.final_end.then_some("end"),
            final_barline_thin: thin,
            double_bar_xs: rn.double_bar_xs,
            end_bar_xs: rn.end_bar_xs,
            meters: rn.meters,
            ..Default::default()
        });
    }
    Ok(score)
}

/// 密排的多声部谱里上一行的低音点也落在下一行数字顶上的窗里：两行各收一次，一上一下抵掉了。
/// 同一个点只归缝小的那个音，另一个退回这一级。
/// 粘在数字顶上的高音点：一个音不会同时有高音点和低音点，已收了低音点的不收（新编赞美诗 78 下声部「5」顶上 6×4 的笔头，
/// 脚下另有它自己的低音点）。在共用点裁决之后做：上下两行抢同一个点的先归定。
fn promote_glued_up(notes: &mut [notes::RowNotes]) {
    for n in notes.iter_mut().flat_map(|r| r.nums.iter_mut()) {
        if n.glued_up.is_none() || n.octave != 0 || n.oct_dots.iter().any(|o| !o.1) || n.digit == 0 || n.digit == crate::result::RHYTHM_DIGIT {
            continue;
        }
        n.octave = 1;
    }
}

/// 隐含延音线（同 TS `impliedTie`）：没词的音与前一个音同音高，就是延音——简谱里同音延续本该有连音线，但跨谱行的弧画不出来
/// （原图上就没有），行内的淡弧也可能漏检。有词的音是新音节、不算延音；有词率不到四成的行（前奏、间奏、只印几个「啦」的衬词行）
/// 没有这条线索，跳过。圆滑线里面不补：一字多音的弧罩着的同音重复是重新发音（1782 `2⌒3 3⌒2` 外面再套一条大弧）。
fn implied_ties(notes: &mut [notes::RowNotes]) {
    let has_word = |n: &result::JpNum| n.lyrics.iter().any(|t| !t.trim().is_empty());
    let mut flat: Vec<(usize, usize, bool)> = Vec::new();
    for (ri, rn) in notes.iter().enumerate() {
        let with = rn.nums.iter().filter(|n| has_word(n)).count();
        let has = !rn.nums.is_empty() && with as f64 / rn.nums.len() as f64 >= 0.4;
        flat.extend((0..rn.nums.len()).map(|ni| (ri, ni, has)));
    }
    let mut depth = 0i64;
    for i in 1..flat.len() {
        let ((pr, pn, _), (cr, cn, has)) = (flat[i - 1], flat[i]);
        let (prev, cur) = (&notes[pr].nums[pn], &notes[cr].nums[cn]);
        depth = (depth + prev.slur_start as i64 - prev.slur_stop as i64).max(0);
        if depth > 0 || prev.slur_stop > 0 || cur.slur_start > 0 || !has || has_word(cur) {
            continue;
        }
        if cur.digit == 0 || prev.digit == 0 || cur.digit == result::RHYTHM_DIGIT || cur.digit != prev.digit || cur.octave != prev.octave {
            continue;
        }
        if cur.tie_stop || prev.tie_start {
            continue;
        }
        notes[pr].nums[pn].tie_start = true;
        notes[cr].nums[cn].tie_stop = true;
    }
}

fn settle_shared_dots(notes: &mut [notes::RowNotes]) {
    use std::collections::HashMap;
    let mut by_id: HashMap<i32, Vec<(usize, usize, bool, f64)>> = HashMap::new();
    for (ri, rn) in notes.iter().enumerate() {
        for (ni, n) in rn.nums.iter().enumerate() {
            for &(id, up, gap) in &n.oct_dots {
                by_id.entry(id).or_default().push((ri, ni, up, gap));
            }
        }
    }
    for owners in by_id.values().filter(|v| v.len() >= 2) {
        let best = owners.iter().min_by(|a, b| a.3.total_cmp(&b.3)).copied().unwrap();
        for &(ri, ni, up, _) in owners {
            if (ri, ni) == (best.0, best.1) {
                continue;
            }
            let n = &mut notes[ri].nums[ni];
            n.octave += if up { -1 } else { 1 };
        }
    }
}
