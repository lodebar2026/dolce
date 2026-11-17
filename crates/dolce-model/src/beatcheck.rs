//! 小节时值自检（同 TS `src/model/beatcheck.ts::checkMeasureDurations`，那边留门面与说法）：逐小节把时值加起来，与拍号对不上的报出来。**不需要 GT**。
//!
//! 消费者：编辑器把拍数不对的小节标红（`editor/visual/`）、简谱识别核对视图（`editor/omrctl.ts`）、私有仓库 `beat-check.mjs`。
//!
//! 口径：
//! - MusicXML 形状按起点算声部终点：`<forward>` 空过的前几拍也算这个声部的（钢琴一只手前两拍不出声）。
//! - 一律折成「四分音符 = 1 拍」；附点、增时线已并在 `Chord.duration` 里，多连音按比例折实际时值；倚音、`y` 不占时值。
//! - 拍号按小节生效（曲中转拍号）；混合拍（头部并排几个拍号 `Song.extraTimes`，或识别给的 `meters`）对上任意一个就算过。
//! - **合法的例外**只放过这几种：弱起（首小节不满；首尾相加凑满一小节时末小节一并放过，只在调用方认它是弱起时）、
//!   相邻两个都不满的小节相加恰好一小节、MusicXML 标了 `implicit` 的小节、没有拍号（散板）的整首不查。

use crate::doc::*;
use crate::xmlproject::is_xml_shaped;
use dolce_base::SourceSpan;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatIssue {
    pub song_index: usize,
    pub part_index: usize,
    pub measure_index: usize,
    /// 该有几拍、实际几拍（四分音符为 1）
    pub want: f64,
    pub got: f64,
    /// 这一小节里的元素 id（按顺序；高亮用）
    pub ids: Vec<ElementId>,
    /// 第一个带原文位置的元素的位置
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceSpan>,
}

/// 一个拍号（`meters` 用）
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meter {
    pub beats: f64,
    pub beat_type: f64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatCheckOptions {
    /// 混合拍：这些拍号对上任意一个就算过（识别结果的 `meters`）。空 = 按模型里的拍号
    #[serde(default)]
    pub meters: Vec<Meter>,
    /// 各首各声部的首小节不满算不算弱起（`[首][声部]`）；缺的一律算
    #[serde(default)]
    pub pickup: Option<Vec<Vec<bool>>>,
}

const EPS: f64 = 1e-6;

fn beats_of(beats: f64, beat_type: f64) -> f64 {
    beats * (4.0 / beat_type)
}

fn source_of(el: &Element) -> Option<&SourceSpan> {
    match el {
        Element::Chord(c) => c.source.as_ref(),
        Element::Space(s) => s.source.as_ref(),
    }
}

/// 一小节里**各声部**的实际时值（四分音符为 1），按出现先后。
/// 同一小节多个声部只有 ABC `&` 的临时多声部一种来源，各分支都该占满一小节。
/// 按 `divisions` 算：MusicXML 形状的已是实际时值，简谱形状的多连音记名义值、要按比例折回；
/// MusicXML 形状按**起点**算声部的终点（`onset`，缺省接前一个元素的终点）。
fn measure_quarters(m: &Measure, divisions: f64, xml: bool) -> Vec<(f64, f64)> {
    let mut out: Vec<(f64, f64)> = Vec::new();
    let mut end = 0.0;
    for el in &m.elements {
        let grace = matches!(el, Element::Chord(c) if c.grace.is_some());
        let d = if grace { None } else { el.duration() };
        let start = if xml { el.onset().unwrap_or(end) } else { 0.0 };
        end = start + d.map_or(0.0, |d| d.divisions);
        let Some(d) = d else { continue };
        let raw = d.divisions / divisions;
        let q = match (&d.time_mod, xml) {
            (Some(tm), false) => (raw * tm.normal) / tm.actual,
            _ => raw,
        };
        let voice = el.voice();
        let slot = match out.iter().position(|(v, _)| *v == voice) {
            Some(i) => i,
            None => {
                out.push((voice, 0.0));
                out.len() - 1
            }
        };
        let cur = out[slot].1;
        out[slot].1 = if xml { dolce_base::js::max(cur, end / divisions) } else { cur + q };
    }
    out
}

struct Row<'a> {
    m: &'a Measure,
    wants: Vec<f64>,
    by_voice: Vec<(f64, f64)>,
    got: f64,
}

fn issue(song_index: usize, part_index: usize, measure_index: usize, m: &Measure, want: f64, got: f64) -> BeatIssue {
    BeatIssue {
        song_index,
        part_index,
        measure_index,
        want,
        got,
        ids: m.elements.iter().map(|e| e.id()).collect(),
        source: m.elements.iter().find_map(source_of).copied(),
    }
}

/// 逐小节查时值，返回对不上的那些。
pub fn check_measure_durations(doc: &ScoreDoc, opts: &BeatCheckOptions) -> Vec<BeatIssue> {
    let mut out = Vec::new();
    for (song_index, song) in doc.songs.iter().enumerate() {
        let xml = is_xml_shaped(song);
        for (part_index, part) in song.parts.iter().enumerate() {
            // `is_song`：当前拍号还是头部那个（TS 按对象身份比 `time !== song.time`）
            let mut time: Option<(&Time, bool)> = song.time.as_ref().map(|t| (t, true));
            let mut divisions = SIMPLE_DIVISIONS;
            // 文本谱的临时拍号记在小节线上（`Barline.time`）：右线上的自下一小节起生效、左线上的管本小节
            let mut pending: Option<&Time> = None;
            let rows: Vec<Row> = part
                .measures
                .iter()
                .map(|m| {
                    if let Some(p) = pending.take() {
                        time = Some((p, false));
                    }
                    let bars = m.barlines.as_deref().unwrap_or(&[]);
                    if let Some(t) = bars.iter().find(|b| b.location == BarLocation::Left && b.time.is_some()).and_then(|b| b.time.as_ref()) {
                        time = Some((t, false));
                    }
                    if let Some(t) = m.attrs.as_ref().and_then(|a| a.time.as_ref()) {
                        time = Some((t, false));
                    }
                    pending = bars.iter().find(|b| b.location == BarLocation::Right && b.time.is_some()).and_then(|b| b.time.as_ref());
                    if let Some(d) = m.attrs.as_ref().and_then(|a| a.divisions).filter(|&d| d != 0.0 && !d.is_nan()) {
                        divisions = d;
                    }
                    // 混合拍：头部并排写的几个拍号对上任意一个都算；识别给的拍号压不过曲中转拍号
                    let wants: Vec<f64> = if !opts.meters.is_empty() {
                        let mut w: Vec<f64> = opts.meters.iter().map(|t| beats_of(t.beats, t.beat_type)).collect();
                        if let Some((t, false)) = time {
                            w.push(beats_of(t.beats, t.beat_type));
                        }
                        w
                    } else if let Some((t, _)) = time {
                        let mut w = vec![beats_of(t.beats, t.beat_type)];
                        if let (Some(extra), Some(st)) = (song.extra_times.as_ref().filter(|e| !e.is_empty()), song.time.as_ref()) {
                            w.push(beats_of(st.beats, st.beat_type));
                            w.extend(extra.iter().map(|t| beats_of(t.beats, t.beat_type)));
                        }
                        w
                    } else {
                        vec![]
                    };
                    let by_voice = measure_quarters(m, divisions, xml);
                    let got = by_voice.first().map_or(0.0, |v| v.1);
                    Row { m, wants, by_voice, got }
                })
                .collect();
            let n = rows.len();
            let implicit = |i: usize| rows[i].m.implicit == Some(true);
            let mut ok: Vec<bool> = (0..n)
                .map(|i| {
                    let r = &rows[i];
                    r.wants.is_empty() || r.m.elements.is_empty() || implicit(i) || r.wants.iter().any(|w| (r.got - w).abs() < EPS)
                })
                .collect();
            let short = |i: usize| rows[i].wants.iter().any(|w| rows[i].got < w - EPS);
            // 两头拍号不同时对上哪一头都算
            let fills = |a: usize, b: usize| rows[a].wants.iter().chain(&rows[b].wants).any(|w| (rows[a].got + rows[b].got - w).abs() < EPS);
            let pickup = opts.pickup.as_ref().and_then(|p| p.get(song_index)).and_then(|p| p.get(part_index)).copied().unwrap_or(true);
            // 弱起：首尾相加一小节（只有一小节时首尾是同一个，不算）
            if pickup && n >= 2 && !ok[0] && short(0) && short(n - 1) && fills(0, n - 1) {
                ok[0] = true;
                ok[n - 1] = true;
            }
            // 首小节单独弱起、末小节是满的：首小节不满一律放过
            if pickup && n >= 2 && !ok[0] && short(0) {
                ok[0] = true;
            }
            // 相邻两个不满的相加一小节（反复记号劈开的小节）；后一个标了 `implicit` 的照样能替前一个凑满
            for i in 0..n.saturating_sub(1) {
                if !ok[i] && (!ok[i + 1] || implicit(i + 1)) && short(i) && short(i + 1) && fills(i, i + 1) {
                    ok[i] = true;
                    ok[i + 1] = true;
                }
            }
            // 临时多声部：各分支与主分支等长才算过；MusicXML 的副声部可以提前收尾，只查比主声部长的
            for (mi, r) in rows.iter().enumerate() {
                for &(_, q) in r.by_voice.iter().skip(1) {
                    if (q - r.got).abs() < EPS || (xml && q < r.got) {
                        continue;
                    }
                    out.push(issue(song_index, part_index, mi, r.m, r.got, q));
                }
            }
            for (mi, r) in rows.iter().enumerate() {
                if ok[mi] {
                    continue;
                }
                let want = r.wants.iter().copied().fold(r.wants[0], |best, w| if (w - r.got).abs() < (best - r.got).abs() { w } else { best });
                out.push(issue(song_index, part_index, mi, r.m, want, r.got));
            }
        }
    }
    out
}
