//! 从原书的版面规格统计出 BookStyle（照 `src/pdflayout/stats.ts`）。
//!
//! 统计的是中位数（原件排好付印，抖动来自轮廓量测）；角色判定用 PageSpec 的具名字段位置。
//! BookStyle 用 `serde_json::Value` 承载（同 `dolce_engrave::style::bookstyle`），BookProfile 只读用到的几项。
//! 判据阈值照搬 TS，量法说明与病例在 TS 原文注释里。

use crate::measure::BookMeasure;
use crate::meta::{fixed, jsre, max_of, min_of, or, u16len};
use crate::spec::{MarkSpec, PageSpec, SChar, SRect, TextRun};
use dolce_model::base::js;
use dolce_engrave::style::bookstyle::{default_book_style, ink_sample_of, role_font_defaults};
use dolce_engrave::style::sheet::STYLE_ROLES;
use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::sync::LazyLock;

/// 段落词（印在和弦带里）。词表与 meta.rs 的 `SECTION_WORDS` 同源（TS 这份少「结束」「反复」，照搬）。
static SECTION_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(副歌|间奏|前奏|尾奏|结束句|齐唱|独唱|轮唱|合唱|重唱|末节|尾声)").expect("正则"));

fn bottom(r: &SRect) -> f64 {
    r.y + r.h
}
fn right(r: &SRect) -> f64 {
    r.x + r.w
}
fn cx(r: &SRect) -> f64 {
    r.x + r.w / 2.0
}
fn cy(r: &SRect) -> f64 {
    r.y + r.h / 2.0
}
fn ccx(c: &SChar) -> f64 {
    c.x + c.w / 2.0
}
fn ccy(c: &SChar) -> f64 {
    c.y + c.h / 2.0
}

/// 原书版面画像（TS `BookProfile`，只取统计用到的几项）
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookProfile {
    #[serde(default)]
    pub id: Option<String>,
    pub page_w: f64,
    pub page_h: f64,
    pub content_box: SRect,
    #[serde(default)]
    pub families: Vec<FamilySpec>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct FamilySpec {
    pub h: f64,
    pub w: f64,
    pub count: f64,
}

/// 从 profile 推音符字号族（窄字、实例最多；照 `inventory.ts::noteHeightOf`，成书元数据的 `noteH` 由它给）
pub fn note_height_of(profile: &BookProfile) -> f64 {
    let mut f: Vec<&FamilySpec> = profile.families.iter().filter(|f| f.count > 100.0 && f.w / f.h < 0.75 && f.h > 4.0).collect();
    js::sort_by(&mut f, |a, b| b.count - a.count);
    f.first().map_or(8.3, |f| f.h)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub n: usize,
    pub p25: f64,
    pub p50: f64,
    pub p75: f64,
    /// 中位绝对偏差 ÷ 中位数
    pub mad_ratio: f64,
}

/// TS `summarize`
pub fn summarize(v: &[f64]) -> Summary {
    let mut s: Vec<f64> = v.iter().copied().filter(|x| x.is_finite()).collect();
    js::sort_num(&mut s);
    if s.is_empty() {
        return Summary::default();
    }
    let n = s.len();
    let q = |f: f64| s[((f * n as f64).floor().max(0.0) as usize).min(n - 1)];
    let p50 = q(0.5);
    let mut dev: Vec<f64> = s.iter().map(|x| (x - p50).abs()).collect();
    js::sort_num(&mut dev);
    let mad = dev[n / 2];
    Summary { n, p25: q(0.25), p50, p75: q(0.75), mad_ratio: if p50 != 0.0 { mad / p50.abs() } else { 0.0 } }
}

fn med(v: &[f64]) -> f64 {
    summarize(v).p50
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RoleSample {
    pub role: &'static str,
    pub h: f64,
    pub w: f64,
    pub page: i64,
    pub ch: String,
}

/// 只采正文页的页段（缺省 40–560）
#[derive(Clone, Copy, Debug, Default)]
pub struct SampleOptions {
    pub from_page: Option<f64>,
    pub to_page: Option<f64>,
}

/// 一行里的主字高：剔掉标点与上标后的中位数
fn run_body_height(run: &TextRun) -> f64 {
    let hs: Vec<f64> = run.chars.iter().filter(|c| c.h > 0.0).map(|c| c.h).collect();
    if hs.is_empty() {
        return 0.0;
    }
    let m = med(&hs);
    let top = med(&hs.iter().copied().filter(|h| *h >= m).collect::<Vec<_>>());
    or(top, med(&hs))
}

fn sample_chars(run: Option<&TextRun>) -> Vec<(f64, f64, String)> {
    let Some(run) = run else { return vec![] };
    let body = run_body_height(run);
    run.chars
        .iter()
        .filter(|c| c.h > 0.0 && c.w > 0.0 && (body <= 0.0 || c.h >= body * 0.72))
        .map(|c| (c.h, c.w, c.ch.clone()))
        .collect()
}

fn push_run(out: &mut Vec<RoleSample>, role: &'static str, run: Option<&TextRun>, page: i64) {
    for (h, w, ch) in sample_chars(run) {
        out.push(RoleSample { role, h, w, page, ch });
    }
}

/// 谱行上方那一带：和弦（拉丁）与署名（含汉字）按非 ASCII 占比分开
fn chord_line_role(run: &TextRun) -> &'static str {
    let t: String = run.text.chars().filter(|c| !js::is_space(*c)).collect();
    if t.is_empty() {
        return "chord";
    }
    // `[...t]` 按码点数、`t.length` 按 UTF-16 码元数（照搬）
    let cjk = t.chars().filter(|c| *c as u32 > 0x2e7f).count();
    if cjk as f64 / u16len(&t) as f64 > 0.4 {
        "credit"
    } else {
        "chord"
    }
}

static TOC_TAIL: LazyLock<Regex> = LazyLock::new(|| jsre(r"[（(]\d+[)）]\s*$"));
static DIGIT_END: LazyLock<Regex> = LazyLock::new(|| jsre(r"\d\s*$"));

/// 各角色的字形尺寸样本（TS `collectRoleSamples`）
pub fn collect_role_samples(pages: &[PageSpec], opt: SampleOptions) -> Vec<RoleSample> {
    let from = opt.from_page.unwrap_or(40.0);
    let to = opt.to_page.unwrap_or(560.0);
    let mut out = vec![];
    let mut lyric_sizes = vec![];
    for p in pages {
        if p.kind != "score" {
            continue;
        }
        for s in &p.songs {
            for y in &s.systems {
                for l in &y.lyric_lines {
                    let h = run_body_height(l);
                    if h >= 3.0 {
                        lyric_sizes.push(h);
                    }
                }
            }
        }
    }
    let lyric_mid = med(&lyric_sizes);
    let lyric2_cut = lyric_mid - 0.6;

    for p in pages {
        let pg = p.page as f64;
        let in_range = pg >= from && pg <= to;
        if p.kind == "toc" || p.kind == "index" || p.kind == "front-matter" {
            let toc_page = p.kind == "toc" || p.kind == "index";
            for t in &p.text_lines {
                let txt = js::trim(&t.text);
                let entry = TOC_TAIL.is_match(txt) || DIGIT_END.is_match(txt);
                if t.size >= 16.0 {
                    push_run(&mut out, "frontTitle", Some(t), p.page);
                } else if !toc_page {
                    continue;
                } else if entry {
                    push_run(&mut out, "toc", Some(t), p.page);
                } else if t.size >= 13.5 {
                    push_run(&mut out, "tocHeading", Some(t), p.page);
                } else if t.size >= 9.8 {
                    push_run(&mut out, "tocSub", Some(t), p.page);
                }
            }
        }
        if p.header.is_some() {
            push_run(&mut out, "header", p.header.as_ref(), p.page);
        }
        if p.footer.is_some() {
            push_run(&mut out, "footer", p.footer.as_ref(), p.page);
        }
        if !in_range || p.kind != "score" {
            continue;
        }
        for b in &p.story_boxes {
            for l in &b.lines {
                push_run(&mut out, "story", Some(l), p.page);
            }
        }
        for s in &p.songs {
            push_run(&mut out, "title", s.title_run.as_ref(), p.page);
            push_run(&mut out, "songNumber", s.number_run.as_ref(), p.page);
            push_run(&mut out, "keyMeter", s.key_meter_run.as_ref(), p.page);
            push_run(&mut out, "category", s.category_run.as_ref(), p.page);
            for c in &s.credit_runs {
                push_run(&mut out, "credit", Some(c), p.page);
            }
            for y in &s.systems {
                let note_med = med(&y.notes.iter().filter(|c| c.h > 0.0).map(|c| c.h).collect::<Vec<_>>());
                for c in &y.notes {
                    if c.h.is_nan() || c.h <= 0.0 {
                        continue;
                    }
                    let role = if note_med > 0.0 && c.h < note_med * 0.72 { "tuplet" } else { "note" };
                    out.push(RoleSample { role, h: c.h, w: c.w, page: p.page, ch: c.ch.clone() });
                }
                for c in &y.chord_lines {
                    let role = if SECTION_WORD.is_match(&c.text) { "sectionWord" } else { chord_line_role(c) };
                    push_run(&mut out, role, Some(c), p.page);
                }
                for l in &y.lyric_lines {
                    let h = run_body_height(l);
                    if h < lyric_mid * 0.5 {
                        continue;
                    }
                    push_run(&mut out, if h < lyric2_cut { "lyric2" } else { "lyric" }, Some(l), p.page);
                }
            }
        }
    }
    out
}

/// 间距原料（TS `MetricSamples`；各项量法见 TS 字段注释）
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricSamples {
    pub note_h: Vec<f64>,
    pub system_gap: Vec<f64>,
    pub note_step: Vec<f64>,
    pub bar_gap: Vec<f64>,
    pub octave_dot_up_gap: Vec<f64>,
    pub octave_dot_down_gap: Vec<f64>,
    pub octave_dot_step: Vec<f64>,
    pub div_line_gap: Vec<f64>,
    pub div_line_step: Vec<f64>,
    pub div_line_len: Vec<f64>,
    pub div_line_width: Vec<f64>,
    pub bracket_width: Vec<f64>,
    pub bracket_foot_len: Vec<f64>,
    pub tuplet_num_h: Vec<f64>,
    pub augment_line_len: Vec<f64>,
    pub augment_line_width: Vec<f64>,
    pub augment_dot_gap: Vec<f64>,
    pub barline_height: Vec<f64>,
    pub barline_width: Vec<f64>,
    pub repeat_dot_diam: Vec<f64>,
    pub slur_thickness: Vec<f64>,
    pub slur_height: Vec<f64>,
    pub chord_to_note: Vec<f64>,
    pub music_to_lyric: Vec<f64>,
    pub lyric_to_lyric: Vec<f64>,
    pub title_to_system: Vec<f64>,
    /// TS 声明了却从没填（照搬，恒空）
    pub credit_to_system: Vec<f64>,
    pub key_meter_to_system: Vec<f64>,
    #[serde(rename = "oddX0")]
    pub odd_x0: Vec<f64>,
    #[serde(rename = "oddX1")]
    pub odd_x1: Vec<f64>,
    #[serde(rename = "evenX0")]
    pub even_x0: Vec<f64>,
    #[serde(rename = "evenX1")]
    pub even_x1: Vec<f64>,
    #[serde(rename = "topY")]
    pub top_y: Vec<f64>,
    #[serde(rename = "bottomY")]
    pub bottom_y: Vec<f64>,
    pub number_baseline: Vec<f64>,
    pub title_baseline: Vec<f64>,
    pub key_meter_baseline: Vec<f64>,
    pub credit_first_baseline: Vec<f64>,
    pub credit_line_gap: Vec<f64>,
    pub first_system_top: Vec<f64>,
    pub cont_system_top: Vec<f64>,
    pub mid_start_gap: Vec<f64>,
}

/// 把一个记号归到 x 最近的音符上（超过 tol 就不算；回 `notes` 里的下标）
fn nearest_note(notes: &[&SChar], x: f64, tol: f64) -> Option<usize> {
    let mut best = None;
    let mut bd = f64::INFINITY;
    for (i, n) in notes.iter().enumerate() {
        let d = (ccx(n) - x).abs();
        if d < bd {
            bd = d;
            best = Some(i);
        }
    }
    best.filter(|_| bd <= tol)
}

/// 按插入序的「音符 → 记号」表（JS `Map<Note, MarkSpec[]>`）
fn push_to(map: &mut Vec<(usize, Vec<usize>)>, k: usize, v: usize) {
    match map.iter_mut().find(|e| e.0 == k) {
        Some(e) => e.1.push(v),
        None => map.push((k, vec![v])),
    }
}

/// TS `collectMetricSamples`
pub fn collect_metric_samples(pages: &[PageSpec], opt: SampleOptions) -> MetricSamples {
    let from = opt.from_page.unwrap_or(40.0);
    let to = opt.to_page.unwrap_or(560.0);
    let mut out = MetricSamples::default();
    for p in pages {
        let pg = p.page as f64;
        if p.kind != "score" || pg < from || pg > to {
            continue;
        }
        for f in &p.frames {
            if f.kind != "bracket" {
                continue;
            }
            out.bracket_width.push(js::min(f.bx.w, f.bx.h));
            if f.bx.h > f.bx.w && f.bx.h > 1.0 {
                out.bracket_foot_len.push(f.bx.h);
            }
        }
        let mut page_x0 = f64::INFINITY;
        let mut page_x1 = f64::NEG_INFINITY;
        let mut songs_on_page: Vec<usize> = (0..p.songs.len()).collect();
        js::sort_by(&mut songs_on_page, |a, b| p.songs[*a].y_from - p.songs[*b].y_from);
        let mut prev_bottom = f64::NEG_INFINITY;
        for (si, &song_i) in songs_on_page.iter().enumerate() {
            let s = &p.songs[song_i];
            let sys = &s.systems;
            let at_page_top = si == 0;
            for i in 0..sys.len() {
                let y = &sys[i];
                let notes: Vec<&SChar> = y.notes.iter().filter(|n| n.h > 0.0 && n.w > 0.0).collect();
                if notes.len() < 3 {
                    continue;
                }
                let note_h = med(&notes.iter().map(|n| n.h).collect::<Vec<_>>());
                let note_w = med(&notes.iter().map(|n| n.w).collect::<Vec<_>>());
                if note_h.is_nan() || note_h <= 0.0 {
                    continue;
                }
                out.note_h.push(note_h);
                page_x0 = js::min(page_x0, y.x0);
                page_x1 = js::max(page_x1, y.x1);
                for l in y.lyric_lines.iter().chain(&y.chord_lines) {
                    page_x0 = js::min(page_x0, l.bx.x);
                    page_x1 = js::max(page_x1, right(&l.bx));
                }

                if i + 1 < sys.len() {
                    let nx = &sys[i + 1];
                    let last_lyric = if y.lyric_lines.is_empty() { y.note_bottom } else { max_of(y.lyric_lines.iter().map(|l| l.baseline_y)) };
                    let chord_top = if nx.chord_lines.is_empty() { nx.note_top } else { min_of(nx.chord_lines.iter().map(|c| c.bx.y)) };
                    out.system_gap.push(js::min(nx.note_top, chord_top) - last_lyric);
                }

                let mut xs = notes.clone();
                js::sort_by(&mut xs, |a, b| a.x - b.x);
                let steps: Vec<f64> = xs.windows(2).map(|w| ccx(w[1]) - ccx(w[0])).collect();
                let step_med = med(&steps);
                for d in &steps {
                    if step_med > 0.0 && *d <= step_med * 1.6 {
                        out.note_step.push(*d);
                    }
                }

                let band: Vec<&MarkSpec> = p
                    .marks
                    .iter()
                    .filter(|m| {
                        bottom(&m.bx) > y.note_top - note_h * 4.0
                            && m.bx.y < y.note_bottom + note_h * 4.0
                            && right(&m.bx) > y.x0 - note_w
                            && m.bx.x < y.x1 + note_w
                    })
                    .collect();
                let mut up_dots: Vec<(usize, Vec<usize>)> = vec![];
                let mut down_dots: Vec<(usize, Vec<usize>)> = vec![];
                let mut divs_of: Vec<(usize, Vec<usize>)> = vec![];
                for (mi, m) in band.iter().enumerate() {
                    match m.cls.as_str() {
                        "octaveDot" => {
                            let Some(n) = nearest_note(&notes, cx(&m.bx), note_w * 0.8) else { continue };
                            let map = if cy(&m.bx) < ccy(notes[n]) { &mut up_dots } else { &mut down_dots };
                            push_to(map, n, mi);
                        }
                        "divLine" => {
                            let Some(n) = nearest_note(&notes, cx(&m.bx), note_w * 1.2) else { continue };
                            push_to(&mut divs_of, n, mi);
                            out.div_line_len.push(m.bx.w);
                            out.div_line_width.push(m.bx.h);
                        }
                        "augmentLine" => {
                            out.augment_line_len.push(m.bx.w);
                            out.augment_line_width.push(m.bx.h);
                        }
                        "augmentDot" => {
                            if let Some(n) = nearest_note(&notes, cx(&m.bx) - note_w, note_w * 1.5) {
                                out.augment_dot_gap.push(m.bx.x - (notes[n].x + notes[n].w));
                            }
                        }
                        "barline" => {
                            if m.bx.h > note_h * 0.8 && m.bx.h < note_h * 3.0 {
                                out.barline_height.push(m.bx.h / note_h);
                                out.barline_width.push(m.bx.w);
                            }
                        }
                        "tupletNum" => {
                            if m.bx.h > 2.0 {
                                out.tuplet_num_h.push(m.bx.h);
                            }
                        }
                        "repeatDot" => {
                            let d = js::max(m.bx.w, m.bx.h);
                            if d > 0.8 {
                                out.repeat_dot_diam.push(d);
                            }
                        }
                        "slur" => {
                            out.slur_thickness.push(or(m.line_width, 0.0));
                            out.slur_height.push(m.bx.h / note_h);
                        }
                        _ => {}
                    }
                }
                let sorted_marks = |ds: &[usize], desc: bool| -> Vec<&MarkSpec> {
                    let mut v: Vec<&MarkSpec> = ds.iter().map(|&i| band[i]).collect();
                    js::sort_by(&mut v, |a, b| if desc { b.bx.y - a.bx.y } else { a.bx.y - b.bx.y });
                    v
                };
                for (_, ds) in &up_dots {
                    let sorted = sorted_marks(ds, true);
                    out.octave_dot_up_gap.push(y.note_top - bottom(&sorted[0].bx));
                    for k in 1..sorted.len() {
                        out.octave_dot_step.push(sorted[k - 1].bx.y - bottom(&sorted[k].bx));
                    }
                }
                for (n, ds) in &down_dots {
                    let sorted = sorted_marks(ds, false);
                    let divs = divs_of.iter().find(|e| e.0 == *n);
                    let above = match divs {
                        Some((_, d)) if !d.is_empty() => max_of(d.iter().map(|&i| bottom(&band[i].bx))),
                        _ => y.note_bottom,
                    };
                    out.octave_dot_down_gap.push(sorted[0].bx.y - above);
                    for k in 1..sorted.len() {
                        out.octave_dot_step.push(sorted[k].bx.y - bottom(&sorted[k - 1].bx));
                    }
                }
                for (n, ds) in &divs_of {
                    let sorted = sorted_marks(ds, false);
                    out.div_line_gap.push(sorted[0].bx.y - (notes[*n].y + notes[*n].h));
                    for k in 1..sorted.len() {
                        out.div_line_step.push(sorted[k].bx.y - bottom(&sorted[k - 1].bx));
                    }
                }

                for &bx in &y.barline_xs {
                    let mut left_d = f64::INFINITY;
                    let mut right_d = f64::INFINITY;
                    for n in &notes {
                        if n.x + n.w <= bx {
                            left_d = js::min(left_d, bx - (n.x + n.w));
                        } else if n.x >= bx {
                            right_d = js::min(right_d, n.x - bx);
                        }
                    }
                    if left_d.is_finite() && left_d < note_w * 4.0 {
                        out.bar_gap.push(left_d);
                    }
                    if right_d.is_finite() && right_d < note_w * 4.0 {
                        out.bar_gap.push(right_d);
                    }
                }

                for c in &y.chord_lines {
                    if chord_line_role(c) == "chord" {
                        out.chord_to_note.push(y.note_top - c.baseline_y);
                    }
                }
                let mut lyr: Vec<&TextRun> = y.lyric_lines.iter().collect();
                js::sort_by(&mut lyr, |a, b| a.baseline_y - b.baseline_y);
                if let Some(first) = lyr.first() {
                    out.music_to_lyric.push(first.baseline_y - y.note_bottom);
                }
                for k in 1..lyr.len() {
                    out.lyric_to_lyric.push(lyr[k].baseline_y - lyr[k - 1].baseline_y);
                }
            }

            for r in [s.title_run.as_ref(), s.number_run.as_ref(), s.key_meter_run.as_ref()].into_iter().flatten().chain(&s.credit_runs) {
                page_x0 = js::min(page_x0, r.bx.x);
                page_x1 = js::max(page_x1, right(&r.bx));
            }

            if s.starts_here && !sys.is_empty() {
                let top = sys[0].note_top;
                if let Some(t) = &s.title_run {
                    out.title_to_system.push(top - t.baseline_y);
                }
                if let Some(k) = &s.key_meter_run {
                    out.key_meter_to_system.push(top - k.baseline_y);
                }
                let mut cr: Vec<f64> = s.credit_runs.iter().filter(|c| c.baseline_y < top).map(|c| c.baseline_y).collect();
                js::sort_num(&mut cr);
                for k in 1..cr.len() {
                    out.credit_line_gap.push(cr[k] - cr[k - 1]);
                }
                if at_page_top {
                    out.first_system_top.push(top);
                    if let Some(t) = &s.title_run {
                        out.title_baseline.push(t.baseline_y);
                    }
                    if let Some(n) = &s.number_run {
                        out.number_baseline.push(n.baseline_y);
                    }
                    if let Some(k) = &s.key_meter_run {
                        out.key_meter_baseline.push(k.baseline_y);
                    }
                    if let Some(c0) = cr.first() {
                        out.credit_first_baseline.push(*c0);
                    }
                } else if let (Some(n), true) = (&s.number_run, prev_bottom.is_finite()) {
                    out.mid_start_gap.push(n.baseline_y - prev_bottom);
                }
            } else if !sys.is_empty() {
                out.cont_system_top.push(sys[0].note_top);
            }

            for y in sys {
                for l in &y.lyric_lines {
                    prev_bottom = js::max(prev_bottom, bottom(&l.bx));
                }
                prev_bottom = js::max(prev_bottom, y.note_bottom);
            }
        }
        let odd = p.page % 2 == 1;
        if page_x0.is_finite() {
            if odd { &mut out.odd_x0 } else { &mut out.even_x0 }.push(page_x0);
        }
        if page_x1.is_finite() {
            if odd { &mut out.odd_x1 } else { &mut out.even_x1 }.push(page_x1);
        }
        if let Some(h) = &p.header {
            out.top_y.push(h.baseline_y);
        }
        if let Some(f) = &p.footer {
            out.bottom_y.push(f.baseline_y);
        }
    }
    out
}

/// 目录/索引的版面几何（TS `inferTocRule`）：只出量得到的键，键序同 TS
pub fn infer_toc_rule(pages: &[PageSpec]) -> Map<String, Value> {
    let mut toc_gaps = vec![];
    let mut toc_first = vec![];
    let mut idx_gaps = vec![];
    let mut idx_first = vec![];
    let mut lefts = vec![];
    let mut rights = vec![];
    let mut titles = vec![];
    let mut head_above = vec![];
    let mut head_below = vec![];
    let is_toc_entry = |t: &str| TOC_TAIL.is_match(js::trim(t));
    let is_idx_entry = |t: &str| !is_toc_entry(t) && DIGIT_END.is_match(js::trim(t));
    for p in pages {
        if p.kind != "toc" && p.kind != "index" {
            continue;
        }
        for toc in [true, false] {
            let lines: Vec<&TextRun> = p.text_lines.iter().filter(|l| if toc { is_toc_entry(&l.text) } else { is_idx_entry(&l.text) }).collect();
            if lines.len() < 5 {
                continue;
            }
            let mut bl: Vec<f64> = lines.iter().map(|l| l.baseline_y).collect();
            js::sort_num(&mut bl);
            for i in 1..bl.len() {
                let d = bl[i] - bl[i - 1];
                if d > 4.0 {
                    if toc { &mut toc_gaps } else { &mut idx_gaps }.push(d);
                }
            }
            if toc { &mut toc_first } else { &mut idx_first }.push(bl[0]);
            for l in &lines {
                lefts.push(l.bx.x);
                rights.push(right(&l.bx));
            }
        }
        if p.kind == "toc" {
            let entries: Vec<&TextRun> = p.text_lines.iter().filter(|l| is_toc_entry(&l.text)).collect();
            let entry_size = if entries.is_empty() { 0.0 } else { med(&entries.iter().map(|l| l.size).collect::<Vec<_>>()) };
            if entry_size > 0.0 {
                for h in p.text_lines.iter().filter(|l| !is_toc_entry(&l.text) && l.size > entry_size * 1.4 && l.size < 16.0) {
                    let mut above: Vec<&&TextRun> = entries.iter().filter(|e| e.baseline_y < h.baseline_y).collect();
                    js::sort_by(&mut above, |a, b| b.baseline_y - a.baseline_y);
                    let mut below: Vec<&&TextRun> = entries.iter().filter(|e| e.baseline_y > h.baseline_y).collect();
                    js::sort_by(&mut below, |a, b| a.baseline_y - b.baseline_y);
                    if let Some(a) = above.first() {
                        head_above.push(h.baseline_y - a.baseline_y);
                    }
                    if let Some(b) = below.first() {
                        head_below.push(b.baseline_y - h.baseline_y);
                    }
                }
            }
        }
        let mut big: Vec<&TextRun> = p.text_lines.iter().collect();
        js::sort_by(&mut big, |a, b| b.size - a.size);
        if let Some(b) = big.first().filter(|b| b.size >= 15.0) {
            titles.push(b.baseline_y);
        }
    }
    let mut out = Map::new();
    for (k, v) in [
        ("lineGap", &toc_gaps),
        ("firstBaseline", &toc_first),
        ("indexLineGap", &idx_gaps),
        ("indexFirstBaseline", &idx_first),
        ("left", &lefts),
        ("right", &rights),
        ("titleBaseline", &titles),
        ("headingGapAbove", &head_above),
        ("headingGapBelow", &head_below),
    ] {
        if !v.is_empty() {
            out.insert(k.into(), json!(fixed(med(v), 2)));
        }
    }
    out
}

/// `inferBookStyle` 的选项
pub struct InferOptions<'a> {
    pub sample: SampleOptions,
    pub id: Option<String>,
    /// page-report 顺带落下的逐类字高（`classHeights`）
    pub class_heights: Option<&'a IndexMap<String, Vec<f64>>>,
    /// 样本字的「墨迹高 ÷ 字号」（`metrics.inkRatio`）
    pub measure: &'a dyn BookMeasure,
}

/// 报告里的一项间距：摘要 + 按音符字号归一的 em（只有 em 项有）
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct MetricSummary {
    #[serde(flatten)]
    pub sum: Summary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub em: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StyleReport {
    pub roles: IndexMap<String, Summary>,
    pub metrics: IndexMap<String, MetricSummary>,
    pub warnings: Vec<String>,
}

const CJK_ROLES: [&str; 12] =
    ["lyric", "lyric2", "title", "credit", "story", "toc", "tocHeading", "tocSub", "frontTitle", "category", "header", "sectionWord"];

fn num(v: f64) -> Value {
    json!(v)
}

/// 统计 → BookStyle（TS `inferBookStyle`）。`fonts` 由调用方给；量不出样本字墨迹占比时报错（原文）
pub fn infer_book_style(profile: &BookProfile, pages: &[PageSpec], fonts: &Value, opt: &InferOptions) -> Result<(Value, StyleReport), String> {
    let base = default_book_style();
    let role_font = role_font_defaults();
    let samples = collect_role_samples(pages, opt.sample);
    let ms = collect_metric_samples(pages, opt.sample);
    let mut warnings: Vec<String> = vec![];

    let is_cjk = |ch: &str| ch.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c));
    let mut by_role: IndexMap<&str, Vec<f64>> = IndexMap::new();
    let mut by_role_all: IndexMap<&str, Vec<f64>> = IndexMap::new();
    for s in &samples {
        by_role_all.entry(s.role).or_default().push(s.h);
        if CJK_ROLES.contains(&s.role) && !is_cjk(&s.ch) {
            continue;
        }
        by_role.entry(s.role).or_default().push(s.h);
    }
    for (role, all) in &by_role_all {
        if by_role.get(role).is_none_or(|v| v.is_empty()) {
            by_role.insert(*role, all.clone());
        }
    }
    for (cls, role) in [("tupletNum", "tuplet"), ("verseNum", "verseNum"), ("sectionWord", "sectionWord"), ("category", "category")] {
        if let Some(hs) = opt.class_heights.and_then(|c| c.get(cls)) {
            if !hs.is_empty() && by_role.get(role).is_none_or(|v| v.is_empty()) {
                by_role.insert(role, hs.clone());
            }
        }
    }

    let mut role_size: IndexMap<&str, f64> = IndexMap::new();
    let mut role_report: IndexMap<String, Summary> = IndexMap::new();
    let mut derived: Vec<&str> = vec![];
    let font_size = |r: &str, ink: f64| -> Result<f64, String> {
        let ratio = opt.measure.ink_ratio(r, ink_sample_of(r));
        if !(ratio > 0.2 && ratio < 1.6) {
            return Err(format!("角色 {r} 量不出样本字「{}」的墨迹占比（{}）", ink_sample_of(r), js::num_to_string(ratio)));
        }
        Ok(fixed(ink / ratio, 3))
    };
    let base_size = |r: &str| base["roles"][r]["size"].as_f64().unwrap_or(f64::NAN);
    for r in STYLE_ROLES {
        let sum = summarize(by_role.get(r).map_or(&[][..], |v| &v[..]));
        role_report.insert(r.into(), sum);
        let size = if sum.n > 0 { font_size(r, fixed(sum.p50, 2))? } else { base_size(r) };
        role_size.insert(r, size);
        if sum.n == 0 {
            derived.push(r);
        } else if sum.n < 50 {
            warnings.push(format!("角色 {r} 样本偏少（n={}）", sum.n));
        }
        if sum.mad_ratio > 0.12 {
            warnings.push(format!("⚠ 角色 {r} 离散偏大（MAD/p50={}，n={}），多半是两族混在一桶", js::to_fixed(sum.mad_ratio, 3), sum.n));
        }
    }

    for r in derived {
        let src = match r {
            "verseNum" | "sectionWord" => Some("lyric"),
            "category" => Some("header"),
            "smufl" => Some("note"),
            _ => None,
        };
        if let Some(src) = src.filter(|s| role_report.get(*s).is_some_and(|x| x.n > 0)) {
            let v = role_size[src];
            role_size.insert(r, v);
            warnings.push(format!("角色 {r} 无实测样本，派生自 {src}（{}pt）", js::num_to_string(v)));
        } else if r == "tuplet" {
            let v = fixed(role_size["note"] * 0.62, 3);
            role_size.insert(r, v);
            warnings.push(format!("角色 tuplet 无实测样本，按音符字号 × 0.62 派生（{}pt）", js::num_to_string(v)));
        } else {
            warnings.push(format!("角色 {r} 无实测样本，沿用默认字号 {}", js::num_to_string(role_size[r])));
        }
    }

    let note_h = or(role_size["note"], 7.0);
    let note_ink = if role_report.get("note").is_some_and(|s| s.n > 0) { fixed(role_report["note"].p50, 2) } else { or(med(&ms.note_h), 5.0) };
    let em = |v: &[f64]| fixed(or(med(v), 0.0) / note_h, 4);
    let pt = |v: &[f64]| fixed(or(med(v), 0.0), 3);

    let mut metric_report: IndexMap<String, MetricSummary> = IndexMap::new();
    let mut rec = |name: &str, v: &[f64], as_em: bool| {
        let sum = summarize(v);
        metric_report.insert(name.into(), MetricSummary { sum, em: as_em.then(|| sum.p50 / note_h) });
        if sum.n == 0 {
            warnings.push(format!("间距 {name} 没有样本"));
        } else if sum.n < 200 {
            warnings.push(format!("间距 {name} 样本偏少（n={}）", sum.n));
        } else if sum.mad_ratio > 0.15 {
            warnings.push(format!("⚠ 间距 {name} 离散偏大（MAD/p50={}，n={}）", js::to_fixed(sum.mad_ratio, 3), sum.n));
        }
    };
    rec("systemGap", &ms.system_gap, true);
    rec("noteStep", &ms.note_step, true);
    rec("barGap", &ms.bar_gap, true);
    rec("octaveDotUpGap", &ms.octave_dot_up_gap, true);
    rec("octaveDotDownGap", &ms.octave_dot_down_gap, true);
    rec("octaveDotStep", &ms.octave_dot_step, true);
    rec("divLineGap", &ms.div_line_gap, true);
    rec("divLineStep", &ms.div_line_step, true);
    rec("divLineLen", &ms.div_line_len, true);
    rec("divLineWidth", &ms.div_line_width, false);
    rec("augmentLineLen", &ms.augment_line_len, true);
    rec("augmentLineWidth", &ms.augment_line_width, false);
    rec("augmentDotGap", &ms.augment_dot_gap, true);
    rec("barlineHeight", &ms.barline_height, false);
    rec("barlineWidth", &ms.barline_width, false);
    rec("repeatDotDiam", &ms.repeat_dot_diam, false);
    rec("bracketWidth", &ms.bracket_width, false);
    rec("bracketFootLen", &ms.bracket_foot_len, false);
    rec("tupletNumH", &ms.tuplet_num_h, false);
    rec("slurThickness", &ms.slur_thickness, false);
    rec("slurHeight", &ms.slur_height, false);
    rec("chordToNote", &ms.chord_to_note, true);
    rec("musicToLyric", &ms.music_to_lyric, true);
    rec("lyricToLyric", &ms.lyric_to_lyric, true);
    rec("titleToSystem", &ms.title_to_system, true);
    rec("creditToSystem", &ms.credit_to_system, true);
    rec("keyMeterToSystem", &ms.key_meter_to_system, true);
    rec("titleBaseline", &ms.title_baseline, false);
    rec("numberBaseline", &ms.number_baseline, false);
    rec("keyMeterBaseline", &ms.key_meter_baseline, false);
    rec("creditFirstBaseline", &ms.credit_first_baseline, false);
    rec("creditLineGap", &ms.credit_line_gap, false);
    rec("firstSystemTop", &ms.first_system_top, false);
    rec("contSystemTop", &ms.cont_system_top, false);
    rec("midStartGap", &ms.mid_start_gap, false);

    // 三个层距够近才共用一把尺子（仅供核对）
    let g_up = med(&ms.octave_dot_up_gap);
    let g_down = med(&ms.octave_dot_down_gap);
    let g_div = med(&ms.div_line_gap);
    let spread = max_of([g_up, g_down, g_div]) - min_of([g_up, g_down, g_div]);
    if spread > note_ink * 0.1 {
        warnings.push(format!(
            "⚠ 层距不等：高音点上 {} / 低音点下 {} / 减时线 {}（差 {}pt > 0.1 墨迹高），（叠层按 stack-gap 等距排，不照这三个数；仅供核对）",
            js::to_fixed(g_up, 2),
            js::to_fixed(g_down, 2),
            js::to_fixed(g_div, 2),
            js::to_fixed(spread, 2)
        ));
    }

    let mut metrics = base["metrics"].as_object().cloned().unwrap_or_default();
    let slur_arc = metrics.get("slurArcEm").cloned().unwrap_or(Value::Null);
    for (k, v) in [
        ("systemGapEm", num(em(&ms.system_gap))),
        ("noteStepEm", num(em(&ms.note_step))),
        ("repeatDotDiam", num(pt(&ms.repeat_dot_diam))),
        ("bracketWidth", num(pt(&ms.bracket_width))),
        ("bracketFootEm", num(em(&ms.bracket_foot_len))),
        ("slurArcEm", slur_arc),
        ("chordToNoteEm", num(em(&ms.chord_to_note))),
        ("lyricToLyricEm", num(em(&ms.lyric_to_lyric))),
        ("stackGapEm", num(fixed((g_up + g_down + g_div) / 3.0 / note_h, 4))),
    ] {
        metrics.insert(k.into(), v);
    }

    // 版心与页边距：奇偶页分开量，镜像与否看哪种配对差得少
    let odd_left = med(&ms.odd_x0);
    let odd_right = profile.page_w - med(&ms.odd_x1);
    let even_left = med(&ms.even_x0);
    let even_right = profile.page_w - med(&ms.even_x1);
    let mirror = (odd_left - even_right).abs() + (odd_right - even_left).abs() < (odd_left - even_left).abs() + (odd_right - even_right).abs();
    let inner = if mirror { (odd_left + even_right) / 2.0 } else { (odd_left + even_left) / 2.0 };
    let outer = if mirror { (odd_right + even_left) / 2.0 } else { (odd_right + even_right) / 2.0 };
    if !mirror {
        warnings.push(format!(
            "版心不是对开镜像（奇 {}/{} 偶 {}/{}），mirror 置 false",
            js::to_fixed(odd_left, 1),
            js::to_fixed(odd_right, 1),
            js::to_fixed(even_left, 1),
            js::to_fixed(even_right, 1)
        ));
    }
    let cb = &profile.content_box;

    let mut roles = Map::new();
    for r in STYLE_ROLES {
        let rf = &role_font[r];
        roles.insert(r.into(), json!({ "font": rf["font"], "align": rf["align"], "size": num(role_size[r]), "baselineAdjust": 0 }));
    }
    let mut toc = base["toc"].as_object().cloned().unwrap_or_default();
    for (k, v) in infer_toc_rule(pages) {
        toc.insert(k, v);
    }
    let tb = &base["titleBlock"];
    let tb_or = |v: f64, k: &str| if v == 0.0 || v.is_nan() { tb[k].clone() } else { num(v) };

    let mut style = base.clone();
    let o = style.as_object_mut().expect("默认样式是对象");
    o.insert("id".into(), json!(opt.id.clone().or_else(|| profile.id.clone()).unwrap_or_else(|| "book".into())));
    o.insert(
        "page".into(),
        json!({
            "w": num(fixed(profile.page_w, 3)),
            "h": num(fixed(profile.page_h, 3)),
            "mirror": mirror,
            "margin": {
                "inner": num(fixed(inner, 2)),
                "outer": num(fixed(outer, 2)),
                "top": num(fixed(cb.y, 2)),
                "bottom": num(fixed(profile.page_h - (cb.y + cb.h), 2)),
            },
        }),
    );
    o.insert("fonts".into(), fonts.clone());
    o.insert("roles".into(), Value::Object(roles));
    o.insert("metrics".into(), Value::Object(metrics));
    o.insert("toc".into(), Value::Object(toc));
    o.insert(
        "titleBlock".into(),
        json!({
            "numberBaseline": tb_or(pt(&ms.number_baseline), "numberBaseline"),
            "firstSystemTop": tb_or(pt(&ms.first_system_top), "firstSystemTop"),
            "contSystemTop": tb_or(pt(&ms.cont_system_top), "contSystemTop"),
            "midStartGap": tb_or(pt(&ms.mid_start_gap), "midStartGap"),
            "footerBaseline": tb_or(pt(&ms.bottom_y), "footerBaseline"),
        }),
    );
    warnings.push(format!(
        "模板基线实测：标题 {}、调号拍号 {}、署名首行 {}、署名行距 {}、页眉 {}",
        js::num_to_string(pt(&ms.title_baseline)),
        js::num_to_string(pt(&ms.key_meter_baseline)),
        js::num_to_string(pt(&ms.credit_first_baseline)),
        js::num_to_string(pt(&ms.credit_line_gap)),
        js::num_to_string(pt(&ms.top_y))
    ));

    Ok((style, StyleReport { roles: role_report, metrics: metric_report, warnings }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn summarizes() {
        let s = super::summarize(&[3.0, 1.0, 2.0, f64::NAN, 10.0]);
        assert_eq!((s.n, s.p25, s.p50, s.p75), (4, 2.0, 3.0, 10.0));
        assert!((s.mad_ratio - 2.0 / 3.0).abs() < 1e-15);
    }
}
