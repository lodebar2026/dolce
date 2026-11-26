//! B 路整本（照 dev `rebuild.mjs` 的排版部分）：逐首断句与排版迭代 → 装箱（半页起排、正反面）→ 两遍法装订（前置页、索引）
//! → 对开镜像 → 注解落位 → 装饰层（页眉页码、标题块）。产出与 TS 写的 `rebuild-drawlist.json` / `rebuild-lines.json` 同形。
//!
//! 读语料、读书级元数据库、写 PDF 与 CSV、打日志仍在脚本里；这里吃脚本导出的输入（[`RebuildInput`]：样式表原文、曲目与 musicxml、元数据行），
//! 排版引擎量字经 [`Env`]、书级量字经 [`BookMeasure`] 注入（迁移期都回放 TS 的录制）。判据与常量照搬，曲目病例见 TS 那份注释。
//!
//! TS 靠对象引用认页（`b.pages[0] === dp`、`free` 按页作键、撤销半页起排比 `dp !== m.dp`）：这里所有页进一张表（[`Book::store`]），
//! 乐谱页序列、各首的页、半页起排的现场一律存下标。`ownItems` 在独占页上是**活引用**（后面接排进来的曲子也在里面），照样区分。

use crate::draw::{DrawItem, DrawPage, PageMeta, PageSong};
use crate::measure::BookMeasure;
use dolce_model::base::js;
use dolce_engrave::Env;
use dolce_model::doc::{ScoreDoc, Song};
use dolce_model::play::applybreaks::{self as ab, CapacityOptions, LayoutMode};
use dolce_model::play::phrase::{self, FitMetric, PhraseBreaks, PhraseOptions, Span};
use dolce_model::play::phraseinput::PhrasePart;
use crate::parts::{self, AnnotationOptions, FrontPageSpec, IndexItem, KeyMeterSpec, PageFrameOptions, TocItem};
use crate::scenedraw;
use crate::template::{BookRegionEnv, KeyMeterComponent};
use dolce_engrave::style::template::{FieldExtra, FieldValue, RegionEnv};
use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

// ───────────────────────── 输入 ─────────────────────────

#[derive(Deserialize)]
pub struct StyleFile {
    pub name: String,
    pub text: String,
}

#[derive(Deserialize, Clone)]
pub struct Category {
    pub name: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SongIn {
    pub id: String,
    pub title: String,
    pub category: Option<String>,
    pub xml: String,
    /// `gtKeyTime(xml)`：`{fifths, key, beats, beatType}` 或 null
    pub gt_km: Value,
}

/// 书级元数据（校对.db 各表的行，原样 JSON）
#[derive(Deserialize, Default)]
pub struct MetaIn {
    pub song: Vec<Value>,
    pub section: Vec<Value>,
    pub annotation: Vec<Value>,
    pub toc: Vec<Value>,
    pub index: Vec<Value>,
    pub front: Vec<Value>,
    pub tiles: Vec<Value>,
}

/// dev `rebuild.mjs --rs-input=` 写的 `input.json`
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildInput {
    pub style_files: Vec<StyleFile>,
    /// `--one=`：单曲试排（默认不出前置页与索引）
    pub only: bool,
    /// `--parts`：单曲试排也出书级内容
    pub parts: bool,
    pub categories: Vec<Category>,
    pub songs: Vec<SongIn>,
    pub meta: MetaIn,
}

/// 两份产物：`rebuild-drawlist.json`（`{style, songs, pages}`）与 `rebuild-lines.json`（`{style, songs}`）
pub struct RebuildOut {
    pub drawlist: Value,
    pub lines: Value,
    /// 与 TS 日志同口径的几行汇总
    pub log: Vec<String>,
}

// ───────────────────────── 小工具 ─────────────────────────

fn at<'a>(v: &'a Value, path: &[&str]) -> &'a Value {
    let mut cur = v;
    for k in path {
        cur = &cur[*k];
    }
    cur
}
fn num(v: &Value, path: &[&str]) -> f64 {
    at(v, path).as_f64().unwrap_or(f64::NAN)
}
fn opt_num(v: &Value, path: &[&str]) -> Option<f64> {
    at(v, path).as_f64()
}
/// JS 真值（库里的 0/1、空串、null）
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
fn s_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        Value::Number(n) => js::num_to_string(n.as_f64().unwrap_or(f64::NAN)),
        other => other.to_string(),
    }
}
fn round2(v: f64) -> f64 {
    js::round(v * 100.0) / 100.0
}
fn fixed3(v: f64) -> f64 {
    js::number(&js::to_fixed(v, 3))
}

/// `node-harness.mjs::songRank`：曲号排序键（附录 J、D 两套在后，`A/B` 变体紧随）
pub fn song_rank(id: &str) -> f64 {
    let b = id.as_bytes();
    let mut i = 0;
    let pre = match b.first() {
        Some(b'J') => {
            i = 1;
            1000.0
        }
        Some(b'D') => {
            i = 1;
            2000.0
        }
        _ => 0.0,
    };
    let ds = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i == ds {
        return 9007199254740991.0;
    }
    let n: f64 = id[ds..i].parse().unwrap_or(0.0);
    let suf = match &b[i..] {
        [] | [b'A'] => 0.0,
        [b'B'] => 1.0,
        _ => return 9007199254740991.0,
    };
    (pre + n) * 10.0 + suf
}

/// `jianpuinput.ts::xmlTitleOf`：credit 里的 title，没有就 work-title（与乐章名相同时不算）/ movement-title
pub fn xml_title_of(song: &Song) -> String {
    for c in song.credits.iter().flatten() {
        if c.kind.as_deref().map(js::trim) != Some("title") {
            continue;
        }
        let first = match c.words.as_ref().and_then(|w| w.first()) {
            Some(w) => w.clone(),
            None => c.text.split('\n').next().unwrap_or("").to_string(),
        };
        let t = js::trim(&first);
        if !t.is_empty() {
            return t.to_string();
        }
    }
    let w = &song.work;
    let wt = if w.title != w.movement_title { w.title.as_deref().map(js::trim) } else { None };
    match wt {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => w.movement_title.as_deref().map(js::trim).unwrap_or("").to_string(),
    }
}

/// 一页上内容的最低处（`contentBottom`）
fn content_bottom(items: &[DrawItem]) -> f64 {
    let mut y = 0.0f64;
    for it in items {
        match it {
            DrawItem::Text(t) => y = js::max(y, t.y + t.size * 0.25),
            DrawItem::Rect(r) => y = js::max(y, r.y + r.h),
            DrawItem::Line(l) => y = js::max(y, js::max(l.y1, l.y2)),
            DrawItem::Path(_) => {}
        }
    }
    y
}

// ───────────────────────── 逐首 ─────────────────────────

/// 一首排好的结果（`RENDER_SONG` 的返回）
struct SongRes {
    phrase_lines: Vec<Value>,
    pages: Vec<DrawPage>,
    natural_h: f64,
    title: String,
    credits: Vec<(String, String)>,
    sizes: Map<String, Value>,
    fit: Value,
    lines: Vec<Value>,
}

const SIZE_ROLES: [&str; 13] =
    ["title", "songNumber", "category", "credit", "keyMeter", "header", "footer", "sectionWord", "story", "toc", "tocHeading", "tocSub", "frontTitle"];

struct Ctx<'a> {
    st: &'a Value,
    /// computed 样式表（模板区域从 `template.regions` 取）
    sheet: &'a Value,
    env: &'a Env<'a>,
    bm: &'a dyn BookMeasure,
}

impl Ctx<'_> {
    fn lay(&self, k: &str) -> &Value {
        &self.st["layout"][k]
    }
    fn page_w(&self) -> f64 {
        num(self.st, &["page", "w"])
    }
    fn page_h(&self) -> f64 {
        num(self.st, &["page", "h"])
    }
    fn role_size(&self, role: &str) -> f64 {
        num(self.st, &["roles", role, "size"])
    }
    fn tb(&self, k: &str) -> f64 {
        num(self.st, &["titleBlock", k])
    }
    fn footer_top(&self) -> f64 {
        self.tb("footerBaseline") - self.role_size("footer") * 1.1
    }
    /// 版心左右缘（对开页镜像：奇数书页 inner 在左）
    fn content_edges(&self, page_no: i64) -> (f64, f64) {
        let inner = num(self.st, &["page", "margin", "inner"]);
        let outer = num(self.st, &["page", "margin", "outer"]);
        let odd = page_no.rem_euclid(2) == 1;
        (if odd { inner } else { outer }, self.page_w() - if odd { outer } else { inner })
    }

    /// 排好的页 → DrawPage[]（`drawPages`：首页给标题块让位的整页平移，不许推进页脚）
    fn draw_pages(&self, list: &[dolce_engrave::scene::Node], id: &str, title: &str, delta: f64) -> Vec<DrawPage> {
        let mut out: Vec<DrawPage> = Vec::new();
        let (w, h) = (self.page_w(), self.page_h());
        for g in list {
            let first = out.is_empty();
            let page_no = out.len() as i64 + 1;
            let mk = |dy: f64| {
                let meta = PageMeta { kind: "score".into(), songs: vec![PageSong { id: Some(id.to_string()), title: Some(title.to_string()), first, y_from: None, y_to: None }], page_label: None };
                a_to_draw(Some(g), w, h, self.st, page_no, meta, dy, self.env)
            };
            let probe = mk(0.0);
            let mut note_top = f64::INFINITY;
            for it in &probe.items {
                if let DrawItem::Text(t) = it {
                    if t.role == "note" {
                        note_top = js::min(note_top, t.y - t.size);
                    }
                }
            }
            let want = if first { self.tb("firstSystemTop") } else { self.tb("contSystemTop") };
            let footer_top = self.footer_top();
            let mut ink_bottom = f64::NEG_INFINITY;
            for it in &probe.items {
                let v = match it {
                    DrawItem::Text(t) => t.y + t.size * 0.25,
                    DrawItem::Line(l) => js::max(l.y1, l.y2),
                    _ => f64::NEG_INFINITY,
                };
                ink_bottom = js::max(ink_bottom, v);
            }
            let mut dy = delta + want - note_top;
            if ink_bottom.is_finite() && ink_bottom + dy > footer_top {
                dy = footer_top - ink_bottom;
            }
            out.push(if note_top.is_finite() { mk(dy) } else { mk(delta) });
        }
        out
    }

    /// `RENDER_SONG`：断句与排版迭代到不再被二次折行为止（至多 6 轮）
    fn render_song(&self, s: &SongIn, section_rows: &[(String, f64)], delta: f64, compact: bool) -> Result<SongRes, String> {
        let st = self.st;
        let mut natural_h = 0.0;
        let render_pages = |score: &ScoreDoc, natural_h: &mut f64| -> Result<Vec<dolce_engrave::scene::Node>, String> {
            let (mut pages, mut nh) = a_layout(score, st, self.page_h() - delta, false, self.env)?;
            *natural_h = nh;
            if compact {
                let mt = num(st, &["page", "margin", "top"]);
                let mb = num(st, &["page", "margin", "bottom"]);
                (pages, nh) = a_layout(score, st, mt + nh + 0.5 + mb, false, self.env)?;
                *natural_h = nh;
            }
            Ok(pages)
        };
        let sdoc = dolce_model::fromxml::load_score_doc(&s.xml).map_err(|e| format!("{e:?}"))?.doc;
        let load_score = || a_book_doc(&s.xml);
        let sdoc_song = sdoc.songs.first().ok_or("没有曲子")?;
        let mut cells = a_cells(load_score()?, st, self.env)?;
        let (input, ids) = dolce_model::view::phrasedoc::phrase_part_of_doc(sdoc_song, 0, false).map_err(|e| format!("{e:?}"))?;
        let phrase_on = truthy(self.lay("phrase"));
        let mid_opt = self.lay("phraseMidBreak").as_bool();
        let mid = mid_opt.unwrap_or(true);
        let mut score;
        let mut page_items: Vec<DrawPage>;
        let mut expect_lines;
        let mut iters;
        let mut line_info: Vec<Value> = vec![];
        let mut phrase_lines: Vec<Value> = vec![];
        let mut content_width = 0.0;
        let mut target_used = 0.0;
        let mut mode = "phrase";
        let mut pairs_from = 0usize;
        let mut jump_seen: Vec<usize> = vec![];
        let mut iter = 0;
        loop {
            iters = iter + 1;
            score = load_score()?;
            put_section_words(score.songs.first_mut().ok_or("没有曲子")?, &input, &ids, section_rows);
            let mut expect = 1.0;
            if phrase_on && !score.songs.is_empty() {
                let ptm = opt_num(st, &["layout", "phraseTargetMeas"]).unwrap_or(f64::NAN);
                let target_meas = if ptm > 0.0 { ptm } else { phrase::target_meas_for_cells(&input, cells) };
                target_used = target_meas;
                let jump = dolce_model::view::phrasedoc::phrase_jump_measures(sdoc_song, 0);
                jump_seen = jump.clone();
                let fit = fit_for_ids(a_spans(a_book_doc(&s.xml)?, st, self.env)?, &ids);
                let lay = |k: &str| opt_num(st, &["layout", k]);
                let opts = PhraseOptions {
                    fit: Some(fit.clone()),
                    target_meas: Some(target_meas),
                    len_weight: lay("phraseLenWeight"),
                    break_weight: lay("phraseBreakWeight"),
                    content_only: Some(self.lay("phraseContentOnly").as_bool() != Some(false)),
                    jump_measures: Some(jump),
                    parallel_weight: Some(lay("phraseParallelWeight").unwrap_or(6.0)),
                    parallel_score: Some(lay("phraseParallelScore").unwrap_or(8.0)),
                    tail_long_weight: Some(lay("phraseTailLongWeight").unwrap_or(0.0)),
                    short_sentence_words: Some(4.0),
                    repeat_len_bonus: Some(true),
                    even_weight: Some(lay("phraseEvenWeight").unwrap_or(0.0)),
                    tail_weight: Some(lay("phraseTailWeight").unwrap_or(0.0)),
                    fit_slack: Some(lay("phraseFitSlack").unwrap_or(0.0)),
                    more_rows_slack: Some(lay("phraseMoreRowsSlack").unwrap_or(0.0)),
                    max_cells: Some(cells),
                    max_sentence_cells: Some(cells),
                    cells_are_items: Some(true),
                    ..Default::default()
                };
                let mut brk = phrase::compute_phrase_breaks(&input, &opts);
                brk.capacity_cuts.clear();
                let pre = ab::describe_lines(&input, &brk, mid);
                phrase_lines = pre
                    .iter()
                    .map(|l| {
                        let tail = if l.tail.last_word.is_empty() { l.tail.text.clone() } else { l.tail.last_word.clone() };
                        json!({ "tail": tail, "dur": fixed3(l.dur) })
                    })
                    .collect();
                let lines_before = pre.len();
                let allow_pairs = self.lay("phraseMergeShort").as_bool() != Some(false);
                let m = layout_op(&input, &mut brk, |p, b| ab::choose_line_layout(p, b, cells, mid, allow_pairs, Some(&fit)));
                mode = match m {
                    LayoutMode::Pairs => "pairs",
                    LayoutMode::Phrase => "phrase",
                    LayoutMode::Even => "even",
                };
                pairs_from = if mode == "pairs" { lines_before } else { 0 };
                layout_op(&input, &mut brk, |p, b| {
                    ab::apply_capacity_cuts(p, b, cells, &CapacityOptions { target_meas, use_mid_breaks: mid, avoid_spans: false, fit: Some(&fit) })
                });
                layout_op(&input, &mut brk, |p, b| ab::tidy_line_heads(p, b, mid, cells, Some(&fit)));
                layout_op(&input, &mut brk, |p, b| ab::tidy_line_tails(p, b, mid, cells, Some(&fit)));
                layout_op(&input, &mut brk, |p, b| ab::merge_sliver_lines(p, b, mid, cells, Some(&fit)));
                let raw = ab::describe_lines(&input, &brk, mid);
                let ranges: Vec<(usize, usize)> = raw.iter().map(|l| (l.from, l.to)).collect();
                let (width, widths) = ab::measure_lines(&input, &ranges, Some(&fit));
                content_width = width;
                line_info = raw
                    .iter()
                    .enumerate()
                    .map(|(li, l)| {
                        json!({
                            "cells": l.cells, "dur": l.dur, "fromMi": l.from_mi, "toMi": l.to_mi, "bars": l.bars, "beats": l.beats,
                            "head": serde_json::to_value(&l.head).unwrap(), "tail": serde_json::to_value(&l.tail).unwrap(),
                            "headFp": l.head_fp, "section": l.section, "mid": l.chord.is_some(),
                            "width": js::round(widths[li] * 100.0) / 100.0, "fromCut": l.from_cut,
                        })
                    })
                    .collect();
                let d = dolce_model::view::bookbreaks::ApplyBreakOptions::default();
                let abo = dolce_model::view::bookbreaks::ApplyBreakOptions {
                    lines_per_page: lay("linesPerPage").unwrap_or(d.lines_per_page),
                    section_new_page: d.section_new_page,
                    use_mid_breaks: mid_opt.unwrap_or(d.use_mid_breaks),
                };
                let lines = apply_phrase_breaks_to_doc(score.songs.first_mut().unwrap(), &input, &ids, &brk, abo)?;
                expect = lines + 1.0;
            }
            expect_lines = expect;
            let title = xml_title_of(&score.songs[0]);
            let pages = render_pages(&score, &mut natural_h)?;
            page_items = self.draw_pages(&pages, &s.id, &title, delta);
            let rows = a_count_rows(&page_items) as f64;
            if !phrase_on || rows <= expect || cells <= 8.0 {
                break;
            }
            let fit_cells = a_max_cells(&page_items) as f64;
            cells = js::max(8.0, js::min(cells - 1.0, if fit_cells > 0.0 { fit_cells } else { cells - 1.0 }));
            iter += 1;
            if iter >= 6 {
                break;
            }
        }
        let overflow = if phrase_on { js::max(0.0, a_count_rows(&page_items) as f64 - expect_lines) } else { 0.0 };
        let fit = json!({
            "iters": iters, "cells": cells, "width": round2(content_width), "target": target_used, "mode": mode,
            "pairsFrom": pairs_from, "jump": jump_seen, "overflow": overflow,
        });
        let mut sizes = Map::new();
        for r in SIZE_ROLES {
            sizes.insert(r.into(), st["roles"][r]["size"].clone());
        }
        // 词曲作者：同一 type 后写的覆盖先写的（Map 的插入位置是头一次出现处）
        let mut cr: IndexMap<String, String> = IndexMap::new();
        if let Some(idn) = &sdoc_song.identification {
            for c in &idn.creators {
                cr.insert(c.kind.clone(), c.text.clone());
            }
        }
        let title = xml_title_of(&score.songs[0]);
        Ok(SongRes { phrase_lines, pages: page_items, natural_h, title, credits: cr.into_iter().collect(), sizes, fit, lines: line_info })
    }
}

/// `phraseLayoutOp` 的写回口径：Rust 改过的断点集合里只有 `measureBreaks` / `midBreaks` / `capacityCuts` 回到 TS，其余字段照旧
fn layout_op<T>(part: &PhrasePart, brk: &mut PhraseBreaks, f: impl FnOnce(&PhrasePart, &mut PhraseBreaks) -> T) -> T {
    let mut b = brk.clone();
    let out = f(part, &mut b);
    brk.measure_breaks = b.measure_breaks;
    brk.mid_breaks = b.mid_breaks;
    brk.capacity_cuts = b.capacity_cuts;
    out
}

/// `fitForIds`：引擎量的自然跨度（键为元素 id）换成断句输入的拍平下标
fn fit_for_ids(spans: (f64, Vec<(i64, Span)>), ids: &[Option<dolce_model::ElementId>]) -> FitMetric {
    let (width, list) = spans;
    let by: HashMap<i64, Span> = list.into_iter().collect();
    FitMetric { width, spans: ids.iter().map(|id| id.and_then(|i| by.get(&(i as i64)).cloned())).collect() }
}

/// `putSectionWords`：段落词按原书音符序号写到第一声部的和弦上
fn put_section_words(song: &mut Song, input: &PhrasePart, ids: &[Option<dolce_model::ElementId>], rows: &[(String, f64)]) {
    if rows.is_empty() {
        return;
    }
    let got = dolce_model::view::bookbreaks::section_word_targets(song, input, ids, rows);
    let by: HashMap<_, _> = got.into_iter().collect();
    if let Some(p) = song.parts.first_mut() {
        for m in &mut p.measures {
            for el in &mut m.elements {
                if let dolce_model::doc::Element::Chord(c) = el {
                    if let Some(w) = by.get(&c.id) {
                        c.section_word = Some(w.clone());
                    }
                }
            }
        }
    }
}

/// `applyPhraseBreaksToDoc`：断点换成行首写进文档（`cuts` 不带、`capacityCuts` 不带，同 `phraseBookIn`）
fn apply_phrase_breaks_to_doc(
    song: &mut Song, input: &PhrasePart, ids: &[Option<dolce_model::ElementId>], brk: &PhraseBreaks, opt: dolce_model::view::bookbreaks::ApplyBreakOptions,
) -> Result<f64, String> {
    let mut b = brk.clone();
    b.cuts.clear();
    b.capacity_cuts.clear();
    let (starts, lines, _pages) = dolce_model::view::bookbreaks::phrase_line_starts(song, input, ids, &b, opt).map_err(|e| format!("{e:?}"))?;
    use dolce_model::breaks::{apply_breaks, ApplyBreaksOptions, MidMode, PageMode};
    apply_breaks(song, &starts, &ApplyBreaksOptions { mid_in_any_part: false, mid: MidMode::Inline, pages: PageMode::Write });
    Ok(lines)
}

// ───────────────────────── 整本 ─────────────────────────

/// 一首在整本那一层的账（`songBlocks` 的一项）
struct Block {
    id: String,
    title: String,
    full_pages: Vec<usize>,
    pages: Vec<usize>,
    n: usize,
    natural_h: f64,
    dy: f64,
    src: usize,
    own_items: Own,
    sizes: Map<String, Value>,
    credits: Vec<(String, String)>,
    category: String,
    km: Option<Value>,
}

/// `b.ownItems`：独占页上是活引用（读的时候取页的现状）；半页起排时是那次紧排的那份
enum Own {
    None,
    Live(usize),
    Copy(Vec<DrawItem>),
}

struct MidStart {
    b: usize,
    dp: usize,
    page_idx: usize,
    item_count: usize,
    song_count: usize,
    prev_y_to: f64,
}

struct Book<'a> {
    cx: Ctx<'a>,
    input: &'a RebuildInput,
    /// 所有页（乐谱页、前置页、索引页）
    store: Vec<DrawPage>,
    score_pages: Vec<usize>,
    blocks: Vec<Block>,
    mid_starts: Vec<MidStart>,
    holes: Vec<(i64, String)>,
    undone: Vec<(String, i64)>,
    last_multi_start: i64,
    front_len: usize,
    sections: HashMap<String, Vec<(String, f64)>>,
}

impl<'a> Book<'a> {
    fn page_no_at(&self, i: usize) -> i64 {
        (self.front_len + i + 1) as i64
    }
    fn add(&mut self, p: DrawPage) -> usize {
        self.store.push(p);
        self.store.len() - 1
    }
    fn blank_page(&self) -> DrawPage {
        let mut p = DrawPage::new(0, self.cx.page_w(), self.cx.page_h(), PageMeta { kind: "score".into(), songs: vec![], page_label: None });
        p.label = Some(String::new());
        p
    }

    fn undo_last_mid(&mut self) -> bool {
        for k in (0..self.mid_starts.len()).rev() {
            let (pi, dp_id) = (self.mid_starts[k].page_idx, self.mid_starts[k].dp);
            if (pi as i64) < self.last_multi_start {
                return false;
            }
            if self.score_pages[pi] != dp_id {
                continue;
            }
            let m = self.mid_starts.remove(k);
            let dp = &mut self.store[dp_id];
            dp.items.truncate(m.item_count);
            dp.meta.songs.truncate(m.song_count);
            if let Some(prev) = dp.meta.songs.last_mut() {
                prev.y_to = Some(m.prev_y_to);
            }
            let ph = self.cx.page_h();
            let b = &mut self.blocks[m.b];
            b.pages = b.full_pages.clone();
            b.own_items = Own::Live(b.full_pages[0]);
            b.dy = 0.0;
            let fp = b.full_pages[0];
            let (bid, btitle, bcat, bsizes) = (b.id.clone(), b.title.clone(), b.category.clone(), b.sizes.clone());
            let p = &mut self.store[fp];
            p.meta.songs = vec![PageSong { id: Some(bid.clone()), title: Some(btitle), first: true, y_from: Some(0.0), y_to: Some(ph) }];
            p.cat = Some(bcat);
            p.sizes = Some(bsizes);
            self.score_pages.insert(m.page_idx + 1, fp);
            for mm in &mut self.mid_starts {
                if mm.page_idx > m.page_idx {
                    mm.page_idx += 1;
                }
            }
            let at = self.page_no_at(m.page_idx + 1);
            self.undone.push((bid, at));
            return true;
        }
        false
    }

    fn pack_alone(&mut self, bi: usize) {
        let n = self.blocks[bi].n;
        if n >= 2 && self.page_no_at(self.score_pages.len()).rem_euclid(2) == 1 && !(self.undo_last_mid() && self.page_no_at(self.score_pages.len()).rem_euclid(2) == 0) {
            let mut blank = self.blank_page();
            blank.cat = Some(self.blocks[bi].category.clone());
            blank.sizes = Some(self.blocks[bi].sizes.clone());
            let at = self.page_no_at(self.score_pages.len());
            self.holes.push((at, self.blocks[bi].id.clone()));
            let id = self.add(blank);
            self.score_pages.push(id);
        }
        if n >= 2 {
            self.last_multi_start = self.score_pages.len() as i64;
        }
        let ph = self.cx.page_h();
        let b = &mut self.blocks[bi];
        b.pages = b.full_pages.clone();
        b.own_items = Own::Live(b.full_pages[0]);
        b.dy = 0.0;
        let (id, title, cat, sizes, fps) = (b.id.clone(), b.title.clone(), b.category.clone(), b.sizes.clone(), b.full_pages.clone());
        for (i, fp) in fps.into_iter().enumerate() {
            let p = &mut self.store[fp];
            p.meta.songs = vec![PageSong { id: Some(id.clone()), title: Some(title.clone()), first: i == 0, y_from: Some(0.0), y_to: Some(ph) }];
            p.cat = Some(cat.clone());
            p.sizes = Some(sizes.clone());
            self.score_pages.push(fp);
        }
    }

    fn pack_mid(&mut self, bi: usize) -> bool {
        let Some(&cur) = self.score_pages.last() else { return false };
        if self.blocks[bi].n != 1 || self.store[cur].meta.songs.is_empty() {
            return false;
        }
        let cx = &self.cx;
        let delta = round2(content_bottom(&self.store[cur].items) + cx.tb("midStartGap") - cx.tb("numberBaseline"));
        if delta <= 0.0 {
            return false;
        }
        let title_h = cx.tb("firstSystemTop") - cx.tb("numberBaseline");
        let footer_top = cx.footer_top();
        if cx.tb("numberBaseline") + delta + title_h + self.blocks[bi].natural_h > footer_top {
            return false;
        }
        let s = &self.input.songs[self.blocks[bi].src];
        let rows = self.sections.get(&s.id).cloned().unwrap_or_default();
        let res = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cx.render_song(s, &rows, delta, true))) {
            Ok(Ok(r)) => r,
            _ => return false,
        };
        if res.pages.len() != 1 {
            return false;
        }
        let src = res.pages.into_iter().next().unwrap();
        if content_bottom(&src.items) > footer_top {
            return false;
        }
        let num_size = self.blocks[bi].sizes.get("songNumber").and_then(Value::as_f64).unwrap_or(cx.role_size("songNumber"));
        let y_from = cx.tb("numberBaseline") + delta - num_size;
        let ph = cx.page_h();
        let page = &mut self.store[cur];
        let item_count = page.items.len();
        let song_count = page.meta.songs.len();
        let prev = page.meta.songs.last_mut();
        let prev_y_to = prev.as_ref().and_then(|p| p.y_to).unwrap_or(ph);
        if let Some(p) = prev {
            p.y_to = Some(y_from);
        }
        page.items.extend(src.items.iter().cloned());
        let b = &mut self.blocks[bi];
        page.meta.songs.push(PageSong { id: Some(b.id.clone()), title: Some(b.title.clone()), first: true, y_from: Some(y_from), y_to: Some(ph) });
        b.pages = vec![cur];
        b.own_items = Own::Copy(src.items);
        b.dy = delta;
        let ms = MidStart { b: bi, dp: cur, page_idx: self.score_pages.len() - 1, item_count, song_count, prev_y_to };
        self.mid_starts.push(ms);
        true
    }

    fn own_items<'s>(&'s self, b: &'s Block) -> &'s [DrawItem] {
        match &b.own_items {
            Own::Live(p) => &self.store[*p].items,
            Own::Copy(v) => v,
            Own::None => b.pages.first().map_or(&[][..], |p| &self.store[*p].items),
        }
    }

    // ── 装订 ──

    fn sorted_blocks(&self) -> Vec<usize> {
        let mut v: Vec<usize> = (0..self.blocks.len()).collect();
        v.sort_by(|&x, &y| song_rank(&self.blocks[x].id).partial_cmp(&song_rank(&self.blocks[y].id)).unwrap());
        v
    }

    /// 目录条目（`tocItems`）：按曲目表生成，原书目录只提供分类标题落在哪个曲号之前
    fn toc_items(&self, page_of_song: &IndexMap<String, i64>) -> Vec<Value> {
        let norm = |t: &str| t.chars().filter(|c| !(dolce_model::base::js::is_space(*c) || "（）()".contains(*c))).collect::<String>();
        let cat_of: HashMap<&str, Option<&str>> = self.input.songs.iter().map(|s| (s.id.as_str(), s.category.as_deref())).collect();
        let sorted = self.sorted_blocks();
        let mut first_of_cat: HashMap<String, String> = HashMap::new();
        for c in &self.input.categories {
            if let Some(&bi) = sorted.iter().find(|&&bi| cat_of.get(self.blocks[bi].id.as_str()).copied().flatten() == Some(c.name.as_str())) {
                first_of_cat.insert(norm(&c.name), self.blocks[bi].id.clone());
            }
        }
        let mut headings: HashMap<String, Vec<Value>> = HashMap::new();
        let mut pend: Vec<Value> = vec![];
        let mut last_rank = -1.0;
        for r in &self.input.meta.toc {
            let kind = s_of(&r["kind"]);
            if kind != "entry" {
                let text = s_of(&r["text"]);
                match first_of_cat.get(&norm(&text)) {
                    Some(cat) if kind == "category" => headings.entry(cat.clone()).or_default().push(json!({ "kind": "category", "text": r["text"] })),
                    _ => pend.push(json!({ "kind": r["kind"], "text": r["text"] })),
                }
                continue;
            }
            if !truthy(&r["song_no"]) {
                continue;
            }
            let no = s_of(&r["song_no"]);
            let rank = song_rank(&no);
            if rank < last_rank {
                pend.clear();
            }
            last_rank = rank;
            if !pend.is_empty() {
                headings.entry(no).or_default().append(&mut pend);
            }
        }
        let mut out = vec![];
        for bi in sorted {
            let b = &self.blocks[bi];
            for h in headings.get(&b.id).into_iter().flatten() {
                out.push(h.clone());
            }
            out.push(json!({ "kind": "entry", "songNo": b.id, "title": b.title, "page": page_of_song.get(&b.id).copied().unwrap_or(0) }));
        }
        out
    }

    fn role_sizes(&self) -> Map<String, Value> {
        self.blocks.first().map(|b| b.sizes.clone()).unwrap_or_default()
    }

    /// 前置页（`buildFront`）：前言 → 目录 → 附录扉页
    fn build_front(&self, page_of_song: &IndexMap<String, i64>) -> Vec<DrawPage> {
        let front = &self.input.meta.front;
        let prose: Vec<Value> = front.iter().filter(|f| s_of(&f["kind"]) == "prose").map(|f| json!({ "kind": "prose", "title": f["title"], "body": f["body"] })).collect();
        let dividers: Vec<Value> = front.iter().filter(|f| s_of(&f["kind"]) == "divider").map(|f| json!({ "kind": "divider", "title": f["title"], "body": "" })).collect();
        let sizes = self.role_sizes();
        let mut out = b_front_pages(self.cx.st, &prose, 1, self.cx.bm);
        let toc = if self.input.meta.toc.is_empty() {
            vec![]
        } else {
            b_toc_pages(self.cx.st, &self.toc_items(page_of_song), out.len() as i64 + 1, "目录", &sizes, self.cx.bm)
        };
        let start = (out.len() + toc.len()) as i64 + 1;
        out.extend(toc);
        out.extend(b_front_pages(self.cx.st, &dividers, start, self.cx.bm));
        out
    }

    fn index_items(&self, name: &str, first_lines: &HashMap<String, String>) -> Vec<Value> {
        let mut out = vec![];
        for r in &self.input.meta.index {
            if s_of(&r["index_name"]) != name {
                continue;
            }
            if s_of(&r["kind"]) == "heading" {
                out.push(json!({ "kind": "heading", "text": r["text"], "songNo": null }));
                continue;
            }
            let no = s_of(&r["song_no"]);
            let rt = s_of(&r["text"]);
            let mut text = rt.clone();
            if let Some(b) = self.blocks.iter().find(|b| b.id == no && r["song_no"].is_string()) {
                let want = if name == "title" { b.title.clone() } else { first_lines.get(&b.id).cloned().unwrap_or_else(|| b.title.clone()) };
                if !want.is_empty() {
                    // 码点计
                    let (wn, rn) = (want.chars().count(), rt.chars().count());
                    text = if wn > rn + 2 { want.chars().take(rn).collect() } else { want };
                }
            }
            out.push(json!({ "kind": "entry", "text": text, "songNo": r["song_no"] }));
        }
        out
    }

    // ── 注解 ──

    fn tiles_of(&self, style_id: &Value) -> Vec<Value> {
        let mut by: IndexMap<String, Vec<Value>> = IndexMap::new();
        for t in &self.input.meta.tiles {
            let ox = if t["ox"].is_null() { json!(0) } else { t["ox"].clone() };
            let oy = if t["oy"].is_null() { json!(0) } else { t["oy"].clone() };
            by.entry(s_of(&t["style_id"]))
                .or_default()
                .push(json!({ "slot": t["slot"], "w": t["w"], "h": t["h"], "pitch": t["pitch"], "ox": ox, "oy": oy, "path": t["path"] }));
        }
        let key = if style_id.is_null() { None } else { Some(s_of(style_id)) };
        key.and_then(|k| by.get(&k).cloned()).or_else(|| by.values().next().cloned()).unwrap_or_default()
    }

    /// 一页的谱行往上收（`squeezePage`），只收 yMin 以下的行；路径没有 y、不动（同 TS）
    fn squeeze_page(&mut self, dp: usize, need: f64, y_min: f64) -> f64 {
        if need <= 0.0 {
            return 0.0;
        }
        let items = &mut self.store[dp].items;
        let mut ys: Vec<f64> = vec![];
        for it in items.iter() {
            if let DrawItem::Text(t) = it {
                if t.role == "lyric" && t.y >= y_min {
                    let y = js::round(t.y * 10.0) / 10.0;
                    if !ys.contains(&y) {
                        ys.push(y);
                    }
                }
            }
        }
        ys.sort_by(|a, b| a.partial_cmp(b).unwrap());
        if ys.len() < 2 {
            return 0.0;
        }
        let mut rows = vec![ys[0]];
        for &y in &ys[1..] {
            if y - rows[rows.len() - 1] > 20.0 {
                rows.push(y);
            }
        }
        if rows.len() < 2 {
            return 0.0;
        }
        let gaps: Vec<f64> = rows.windows(2).map(|w| w[1] - w[0]).collect();
        let room = gaps.iter().fold(0.0, |a, g| a + g * SQUEEZE_MAX);
        let take = js::min(need, room);
        if take <= 0.5 {
            return 0.0;
        }
        let per = take / gaps.len() as f64;
        let bounds: Vec<f64> = rows.windows(2).map(|w| (w[0] + w[1]) / 2.0).collect();
        let row_of = |y: f64| bounds.iter().take_while(|b| y > **b).count();
        for it in items.iter_mut() {
            let y = match it {
                DrawItem::Line(l) => js::min(l.y1, l.y2),
                DrawItem::Text(t) => t.y,
                DrawItem::Rect(r) => r.y,
                DrawItem::Path(_) => continue,
            };
            if y < y_min {
                continue;
            }
            let d = row_of(y) as f64 * per;
            if d == 0.0 {
                continue;
            }
            match it {
                DrawItem::Line(l) => {
                    l.y1 -= d;
                    l.y2 -= d;
                }
                DrawItem::Text(t) => t.y -= d,
                DrawItem::Rect(r) => r.y -= d,
                DrawItem::Path(_) => {}
            }
        }
        take
    }

    fn place_annotations(&mut self, ann_gap_ratio: f64) -> (usize, usize, usize) {
        let size = self.cx.role_size("story");
        let line_gap = size * ann_gap_ratio;
        let footer_top = self.cx.footer_top();
        let content_top = self.cx.tb("contSystemTop");
        let sp = self.score_pages.clone();
        let idx_of: HashMap<usize, usize> = sp.iter().enumerate().map(|(i, &p)| (p, i)).collect();
        let mut free: HashMap<usize, f64> = sp.iter().map(|&p| (p, footer_top - js::max(content_bottom(&self.store[p].items), content_top))).collect();
        let (mut placed, mut squeezed, mut lost) = (0usize, 0usize, 0usize);
        let mut anns_by: IndexMap<String, Vec<Value>> = IndexMap::new();
        for a in &self.input.meta.annotation {
            anns_by.entry(s_of(&a["song_no"])).or_default().push(a.clone());
        }
        for bi in 0..self.blocks.len() {
            let Some(anns) = anns_by.get(&self.blocks[bi].id).cloned() else { continue };
            let home = *self.blocks[bi].pages.last().unwrap();
            let hi = idx_of[&home];
            for a in &anns {
                let mut cands = vec![Some(home)];
                let spread = if self.store[home].page_no.rem_euclid(2) == 0 { sp.get(hi + 1).copied() } else { hi.checked_sub(1).and_then(|i| sp.get(i).copied()) };
                if spread.is_some() {
                    cands.push(spread);
                }
                for d in 1..=ANN_NEAR_PAGES {
                    if let Some(&p) = sp.get(hi + d) {
                        cands.push(Some(p));
                    }
                }
                for d in 1..=ANN_NEAR_PAGES {
                    if let Some(&p) = hi.checked_sub(d).and_then(|i| sp.get(i)) {
                        cands.push(Some(p));
                    }
                }
                // 全书空位最多的那页（同值取先出现的，同 JS 稳定排序取 [0]）
                let mut best: Option<usize> = None;
                for &p in &sp {
                    if best.is_none_or(|b| free[&p] > free[&b]) {
                        best = Some(p);
                    }
                }
                cands.push(best);
                let mut at: Option<usize> = None;
                for dp in cands.into_iter().flatten() {
                    if self.try_put(a, dp, &mut free, footer_top, line_gap, size) {
                        at = Some(dp);
                        break;
                    }
                }
                if at.is_none() {
                    let y_min = self.store[home].meta.songs.last().and_then(|s| s.y_from).unwrap_or(0.0);
                    let fh = free[&home];
                    let want = self.build_ann(a, home, footer_top - fh, line_gap, size).0 - fh;
                    let got = self.squeeze_page(home, want, y_min);
                    if got > 0.5 {
                        free.insert(home, free[&home] + got);
                        if self.try_put(a, home, &mut free, footer_top, line_gap, size) {
                            at = Some(home);
                            squeezed += 1;
                        }
                    }
                }
                if at.is_none() {
                    lost += 1;
                    continue;
                }
                placed += 1;
            }
        }
        (placed, lost, squeezed)
    }

    fn build_ann(&self, a: &Value, dp: usize, top: f64, line_gap: f64, size: f64) -> (f64, Vec<DrawItem>) {
        let (left, right) = self.cx.content_edges(self.store[dp].page_no);
        let framed = truthy(&a["framed"]);
        let frame = if a["frame_kind"].is_null() { json!(if framed { "tile" } else { "none" }) } else { a["frame_kind"].clone() };
        let or_undef = |v: &Value| if truthy(v) { v.clone() } else { Value::Null };
        let o = json!({
            "text": a["text"], "framed": framed, "frame": frame,
            "frameOuter": or_undef(&a["frame_outer"]), "frameInner": or_undef(&a["frame_inner"]), "frameGap": or_undef(&a["frame_gap"]),
            "left": left, "right": right, "top": top, "lineGap": line_gap,
            "tiles": self.tiles_of(&a["frame_style"]), "frameEdges": or_undef(&a["frame_edges"]), "size": size,
        });
        b_annotation_block(self.cx.st, &o, self.cx.bm)
    }

    fn try_put(&mut self, a: &Value, dp: usize, free: &mut HashMap<usize, f64>, footer_top: f64, line_gap: f64, size: f64) -> bool {
        let room = free[&dp];
        let (height, items) = self.build_ann(a, dp, footer_top - room, line_gap, size);
        if height > room {
            return false;
        }
        self.store[dp].items.extend(items);
        free.insert(dp, room - height - size);
        true
    }

    // ── 装饰层 ──

    fn region_env<'e>(&'e self, page_no: i64, fields: IndexMap<String, Option<FieldExtra>>, dy: f64, sizes: Option<&Map<String, Value>>) -> BookRegionEnv<'e> {
        BookRegionEnv {
            style: self.cx.st,
            measure: self.cx.bm,
            fields,
            page_no: page_no as f64,
            content: self.cx.content_edges(page_no),
            dy,
            sizes: sizes.map(sizes_f64).unwrap_or_default(),
            key_meter: None,
        }
    }

    /// 页的装饰：页眉与页码（一页一次）
    fn decorate_page(&mut self, dp: usize, category: &str, sizes: Option<&Map<String, Value>>) {
        let label = self.store[dp].label.clone().unwrap_or_default();
        let mut fields = IndexMap::new();
        fields.insert("meta.category".to_string(), Some(FieldExtra::Str(category.to_string())));
        fields.insert("page.label".to_string(), Some(FieldExtra::Str(label)));
        let env = self.region_env(self.store[dp].page_no, fields, 0.0, sizes);
        let mut add = vec![];
        for name in ["page-header", "page-footer"] {
            add.extend(region_items(self.cx.sheet, name, None, &env));
        }
        self.store[dp].items.extend(add);
    }

    /// 每首开头的标题块：逐行排、逐行入列（调号拍号的避让要看这一页上已有的图元）
    fn decorate_song(&mut self, bi: usize) {
        let b = &self.blocks[bi];
        let dp = b.pages[0];
        let creators: Vec<FieldValue> = b.credits.iter().map(|(k, t)| FieldValue { text: t.clone(), kind: Some(k.clone()) }).collect();
        let mut fields = IndexMap::new();
        fields.insert("work.number".to_string(), Some(FieldExtra::Str(b.id.clone())));
        fields.insert("work.title".to_string(), Some(FieldExtra::Str(b.title.clone())));
        fields.insert("creators.*".to_string(), Some(FieldExtra::Vals(creators)));
        let (sizes, dy) = (b.sizes.clone(), b.dy);
        let km: Option<KeyMeterSpec> = b.km.as_ref().map(|v| serde_json::from_value(v.clone()).expect("调号拍号"));
        let km_size = sizes.get("keyMeter").and_then(Value::as_f64);
        let nrows = self.cx.sheet.get("template").and_then(|t| t.get("regions")).and_then(|r| r.get("song-head")).and_then(|r| r.get("rows")).and_then(Value::as_array).map_or(0, Vec::len);
        for row in 0..nrows {
            let snapshot = self.store[dp].items.clone();
            let mut env = self.region_env(self.store[dp].page_no, fields.clone(), dy, Some(&sizes));
            env.key_meter = Some(KeyMeterComponent { style: self.cx.st, measure: self.cx.bm, km: km.clone(), page_items: &snapshot, size: km_size });
            let add = region_items(self.cx.sheet, "song-head", Some(row), &env);
            self.store[dp].items.extend(add);
        }
    }
}

const ANN_NEAR_PAGES: usize = 4;
const SQUEEZE_MAX: f64 = 0.25;

/// 各角色字号表（数值才收）
fn sizes_f64(m: &Map<String, Value>) -> IndexMap<String, f64> {
    m.iter().filter_map(|(k, v)| v.as_f64().map(|x| (k.clone(), x))).collect()
}

/// 排一个模板区域（`row` 给了就只排那一行），结果换成图元
fn region_items(sheet: &Value, name: &str, row: Option<usize>, env: &dyn RegionEnv) -> Vec<DrawItem> {
    let Some(rv) = sheet.get("template").and_then(|t| t.get("regions")).and_then(|r| r.get(name)) else {
        panic!("样式表里没有 @template {name}")
    };
    let mut region: dolce_engrave::style::ss::Region = serde_json::from_value(rv.clone()).expect("模板区域");
    if let Some(r) = row {
        region.rows = vec![region.rows[r].clone()];
    }
    let res = dolce_engrave::style::template::layout_region(Some(&region), env).unwrap_or_else(|e| panic!("模板 {name} 排不出：{}", e.message));
    crate::template::placed_to_draw_items(&res.items).expect("模板图元")
}

/// 成书样式：歌本样式表（实测部分 + 模板与手调）按序叠，id 取最后一份的文件名。返回（层叠后的表, BookStyle）
pub fn book_style_files(files: &[StyleFile]) -> Result<(dolce_engrave::style::sheet::StyleSheet, Value), String> {
    let mut rules = vec![];
    for f in files {
        rules.extend(dolce_engrave::style::ss::parse_ss(&f.text).map_err(|e| format!("{}：{}", f.name, e.message))?);
    }
    let mut ctx = dolce_engrave::style::cascade::StyleContext::new();
    ctx.insert("engine".into(), json!("book"));
    let sheet = dolce_engrave::style::cascade::compute_style(&[&rules], &ctx);
    let last = files.last().map_or("", |f| f.name.as_str());
    let id = last.rsplit('/').next().unwrap_or(last).trim_end_matches(".ss");
    let st = dolce_engrave::style::bookss::book_style_of(&sheet, id).map_err(|e| e.to_string())?;
    Ok((sheet, st))
}

/// 整本（`rebuild.mjs` 自读样式起、写文件止的那一段）
pub fn rebuild(input: &RebuildInput, env: &Env, bm: &dyn BookMeasure) -> Result<RebuildOut, String> {
    let (sheet, st) = book_style_files(&input.style_files)?;
    let style_id = st["id"].clone();
    let cx = Ctx { st: &st, sheet: sheet.value(), env, bm };
    let mut log = vec![];

    // 注解正文的行距比例
    let story_ink = bm.ink_ratio("story", dolce_engrave::style::bookstyle::ink_sample_of("story"));
    let ann_gap_ratio = {
        let mut rs: Vec<f64> = vec![];
        for a in &input.meta.annotation {
            let n = s_of(&a["text"]).split('\n').count() as f64;
            let (bh, sz) = (a["box_h"].as_f64().unwrap_or(f64::NAN), a["size"].as_f64().unwrap_or(f64::NAN));
            if truthy(&a["framed"]) && n > 2.0 && bh > 0.0 && sz > 2.0 {
                rs.push((bh - 10.0) / (n - 1.0) / (sz / story_ink));
            }
        }
        rs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        if rs.is_empty() { 1.5 * story_ink } else { fixed3(rs[rs.len() / 2]) }
    };

    let mut sections: HashMap<String, Vec<(String, f64)>> = HashMap::new();
    for r in &input.meta.section {
        sections.entry(s_of(&r["song_no"])).or_default().push((s_of(&r["text"]), r["note_ordinal"].as_f64().unwrap_or(f64::NAN)));
    }
    let km_db: HashMap<String, &Value> = input.meta.song.iter().map(|r| (s_of(&r["song_no"]), r)).collect();

    let mut bk = Book {
        cx,
        input,
        store: vec![],
        score_pages: vec![],
        blocks: vec![],
        mid_starts: vec![],
        holes: vec![],
        undone: vec![],
        last_multi_start: -1,
        front_len: 0,
        sections,
    };
    let mut per_song: Vec<Value> = vec![];
    let mut per_lines: Vec<Value> = vec![];
    let mut failed = 0usize;
    for (si, s) in input.songs.iter().enumerate() {
        let rows = bk.sections.get(&s.id).cloned().unwrap_or_default();
        let res = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| bk.cx.render_song(s, &rows, 0.0, false))) {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                failed += 1;
                log.push(format!("  ✗ {} {}：{e}", s.id, s.title));
                continue;
            }
            Err(p) => {
                failed += 1;
                let m = p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
                log.push(format!("  ✗ {} {}：panic {m}", s.id, s.title));
                continue;
            }
        };
        let km = match km_db.get(&s.id) {
            Some(r) => Some(json!({ "tonic": r["tonic"], "beats": r["beats"], "beatType": r["beat_type"], "altTonic": r["alt_tonic"] })),
            None if truthy(&s.gt_km["beats"]) => {
                let g = &s.gt_km;
                Some(json!({ "tonic": g["key"], "beats": g["beats"], "beatType": g["beatType"], "altTonic": null }))
            }
            None => None,
        };
        let n = res.pages.len();
        let ids: Vec<usize> = res.pages.into_iter().map(|p| bk.add(p)).collect();
        per_song.push(json!({ "id": s.id, "title": res.title, "pages": n, "fit": res.fit }));
        per_lines.push(json!({
            "id": s.id, "title": res.title, "phraseLines": res.phrase_lines, "cells": res.fit["cells"], "width": res.fit["width"],
            "target": res.fit["target"], "mode": res.fit["mode"], "pairsFrom": res.fit["pairsFrom"], "lines": res.lines,
        }));
        bk.blocks.push(Block {
            id: s.id.clone(),
            title: res.title,
            full_pages: ids.clone(),
            pages: ids,
            n,
            natural_h: res.natural_h,
            dy: 0.0,
            src: si,
            own_items: Own::None,
            sizes: res.sizes,
            credits: res.credits,
            category: s.category.clone().unwrap_or_default(),
            km,
        });
    }

    // 装箱
    bk.front_len = if input.only && !input.parts { 0 } else { bk.build_front(&IndexMap::new()).len() };
    for bi in 0..bk.blocks.len() {
        if !bk.pack_mid(bi) {
            bk.pack_alone(bi);
        }
    }
    log.push(format!(
        "装箱：乐谱 {} 页；半页起排 {} 首；正反面撤回半页起排 {} 首、留空 {} 页",
        bk.score_pages.len(),
        bk.mid_starts.len(),
        bk.undone.len(),
        bk.holes.len()
    ));

    // 首句
    let mut first_lines: HashMap<String, String> = HashMap::new();
    for b in &bk.blocks {
        let mut best: Option<&crate::draw::DrawText> = None;
        for it in bk.own_items(b) {
            if let DrawItem::Text(t) = it {
                if t.role == "lyric" && best.is_none_or(|c| t.y < c.y || (t.y == c.y && t.xs[0] < c.xs[0])) {
                    best = Some(t);
                }
            }
        }
        if let Some(t) = best {
            first_lines.insert(b.id.clone(), js::trim(&strip_verse_no(&t.text)).to_string());
        }
    }

    // 两遍法装订
    let mut page_of_song: IndexMap<String, i64> = IndexMap::new();
    let mut front: Vec<DrawPage> = vec![];
    let mut back: Vec<DrawPage> = vec![];
    let mut rounds = 0;
    for iter in 0..3 {
        rounds = iter + 1;
        let mut next: IndexMap<String, i64> = IndexMap::new();
        for (i, &dp) in bk.score_pages.clone().iter().enumerate() {
            bk.store[dp].label = Some((i + 1).to_string());
            for b in &bk.blocks {
                if b.pages[0] == dp {
                    next.insert(b.id.clone(), (i + 1) as i64);
                }
            }
        }
        let same = next.len() == page_of_song.len() && next.iter().all(|(k, v)| page_of_song.get(k) == Some(v));
        page_of_song = next;
        if same && iter > 0 {
            break;
        }
        if input.only && !input.parts {
            front = vec![];
            back = vec![];
            break;
        }
        front = bk.build_front(&page_of_song);
        let sizes = bk.role_sizes();
        back = vec![];
        for (name, title) in [("title", "诗题笔划索引"), ("firstline", "歌词首句索引")] {
            let items = bk.index_items(name, &first_lines);
            if !items.is_empty() {
                back.extend(b_index_pages(&st, &items, title, &sizes, bm));
            }
        }
        if same {
            break;
        }
    }
    if front.len() != bk.front_len {
        log.push(format!("⚠ 前置页数与装箱时的估值不符：装箱按 {} 页算，实际 {} 页", bk.front_len, front.len()));
    }
    for (i, dp) in front.iter_mut().enumerate() {
        dp.page_no = i as i64 + 1;
        dp.label = Some((i + 1).to_string());
    }
    let nf = front.len();
    let ns = bk.score_pages.len();
    for (i, &dp) in bk.score_pages.clone().iter().enumerate() {
        bk.store[dp].page_no = (nf + i + 1) as i64;
        bk.store[dp].label = Some((i + 1).to_string());
    }
    for (i, dp) in back.iter_mut().enumerate() {
        dp.page_no = (nf + ns + i + 1) as i64;
        dp.label = Some((ns + i + 1).to_string());
    }

    // 对开页镜像
    let mirror = num(&st, &["page", "margin", "inner"]) - num(&st, &["page", "margin", "outer"]);
    if mirror != 0.0 {
        for &dp in &bk.score_pages.clone() {
            if bk.store[dp].page_no.rem_euclid(2) == 0 {
                crate::draw::shift_draw_page_x(&mut bk.store[dp], -mirror);
            }
        }
    }

    let (placed, left, squeezed) = bk.place_annotations(ann_gap_ratio);

    // 装饰层
    for dp in bk.score_pages.clone() {
        let p = &bk.store[dp];
        if p.meta.songs.is_empty() && p.items.is_empty() {
            continue;
        }
        let (cat, sizes) = (p.cat.clone().unwrap_or_default(), p.sizes.clone());
        bk.decorate_page(dp, &cat, sizes.as_ref());
    }
    for bi in 0..bk.blocks.len() {
        bk.decorate_song(bi);
    }
    let fb_start = bk.store.len();
    let nfront = front.len();
    for p in front.into_iter().chain(back) {
        bk.store.push(p);
    }
    for dp in fb_start..bk.store.len() {
        bk.decorate_page(dp, "", None);
    }

    let mut pages: Vec<Value> = vec![];
    let order: Vec<usize> = (fb_start..fb_start + nfront).chain(bk.score_pages.iter().copied()).chain(fb_start + nfront..bk.store.len()).collect();
    for i in order {
        pages.push(serde_json::to_value(&bk.store[i]).map_err(|e| e.to_string())?);
    }
    log.push(format!("装订：前置 {nfront} 页、乐谱 {ns} 页、索引 {} 页；目录两遍法 {rounds} 轮", bk.store.len() - fb_start - nfront));
    log.push(format!("注解排入 {placed}，压过谱面 {squeezed}，没排下 {left}；曲目 {}/{}，失败 {failed}", per_song.len(), input.songs.len()));
    Ok(RebuildOut {
        drawlist: json!({ "style": style_id, "songs": per_song, "pages": pages }),
        lines: json!({ "style": style_id, "songs": per_lines }),
        log,
    })
}

/// `String(text).replace(/^\d+[.、]?/, "")`
fn strip_verse_no(t: &str) -> String {
    let n = t.chars().take_while(|c| c.is_ascii_digit()).count();
    if n == 0 {
        return t.to_string();
    }
    let rest: String = t.chars().skip(n).collect();
    match rest.chars().next() {
        Some('.') | Some('、') => rest.chars().skip(1).collect(),
        _ => rest,
    }
}

// ───────────────────────── 接到别的模块 ─────────────────────────

fn a_book_doc(xml: &str) -> Result<ScoreDoc, String> {
    scenedraw::book_doc_of(xml)
}
fn a_layout(doc: &ScoreDoc, st: &Value, page_h: f64, measure: bool, env: &Env) -> Result<(Vec<dolce_engrave::scene::Node>, f64), String> {
    let r = scenedraw::layout_book_doc(doc, st, page_h, measure, env)?;
    Ok((r.layout.pages, r.natural_h))
}
fn a_spans(mut doc: ScoreDoc, st: &Value, env: &Env) -> Result<(f64, Vec<(i64, Span)>), String> {
    let (w, list) = scenedraw::measure_book_spans(&mut doc, st, env)?;
    Ok((w, list.into_iter().map(|(id, s)| (id, Span { x0: s.x0, x1: s.x1, x1b: s.x1b })).collect()))
}
fn a_cells(mut doc: ScoreDoc, st: &Value, env: &Env) -> Result<f64, String> {
    scenedraw::book_cells_per_line(&mut doc, st, env)
}
#[allow(clippy::too_many_arguments)]
fn a_to_draw(root: Option<&dolce_engrave::scene::Node>, w: f64, h: f64, _st: &Value, page_no: i64, meta: PageMeta, dy: f64, env: &Env) -> DrawPage {
    let o = scenedraw::ToDrawOptions { role_of: scenedraw::RoleOf::Book, page_no, meta, scale: None, offset: Some((0.0, dy)) };
    scenedraw::page_items_to_draw_page(root, w, h, o, env).unwrap_or_else(|e| panic!("页面树转 DrawList：{e:?}"))
}
fn a_count_rows(p: &[DrawPage]) -> usize {
    scenedraw::count_staff_rows(p)
}
fn a_max_cells(p: &[DrawPage]) -> usize {
    scenedraw::max_staff_row_cells(p)
}
fn frame_opts(start: i64, title: Option<&str>, sizes: Option<&Map<String, Value>>) -> PageFrameOptions {
    PageFrameOptions { start_page_no: start, title: title.map(str::to_string), sizes: sizes.map(sizes_f64).unwrap_or_default() }
}
fn b_front_pages(st: &Value, specs: &[Value], start: i64, bm: &dyn BookMeasure) -> Vec<DrawPage> {
    let specs: Vec<FrontPageSpec> = specs
        .iter()
        .map(|v| FrontPageSpec { kind: s_of(&v["kind"]), title: s_of(&v["title"]), body: s_of(&v["body"]) })
        .collect();
    parts::front_pages(st, &specs, &frame_opts(start, None, None), bm)
}
fn b_toc_pages(st: &Value, items: &[Value], start: i64, title: &str, sizes: &Map<String, Value>, bm: &dyn BookMeasure) -> Vec<DrawPage> {
    let items: Vec<TocItem> = items.iter().map(|v| serde_json::from_value(v.clone()).expect("目录条目")).collect();
    parts::toc_pages(st, &items, &frame_opts(start, Some(title), Some(sizes)), bm)
}
fn b_index_pages(st: &Value, items: &[Value], title: &str, sizes: &Map<String, Value>, bm: &dyn BookMeasure) -> Vec<DrawPage> {
    let items: Vec<IndexItem> = items
        .iter()
        .map(|v| IndexItem { kind: s_of(&v["kind"]), text: s_of(&v["text"]), song_no: v["songNo"].as_str().map(str::to_string) })
        .collect();
    parts::index_pages(st, &items, &frame_opts(1, Some(title), Some(sizes)), bm)
}
fn b_annotation_block(st: &Value, o: &Value, bm: &dyn BookMeasure) -> (f64, Vec<DrawItem>) {
    let o: AnnotationOptions = serde_json::from_value(o.clone()).expect("注解参数");
    let r = parts::annotation_block(st, &o, bm);
    (r.height, r.items)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranks() {
        assert_eq!(song_rank("028"), 280.0);
        assert_eq!(song_rank("J07"), 10070.0);
        assert_eq!(song_rank("D03B"), 20031.0);
        assert_eq!(song_rank("x"), 9007199254740991.0);
        assert_eq!(strip_verse_no("1.主啊"), "主啊");
        assert_eq!(strip_verse_no("12、我"), "我");
        assert_eq!(strip_verse_no("我1"), "我1");
    }
}
