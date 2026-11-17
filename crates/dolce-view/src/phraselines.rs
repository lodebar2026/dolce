//! 按乐句重排 / 每行 n 小节：**把断点换算到排版行视图的行上**（TS `jianpu/phrase.ts` 照搬）。
//!
//! 断句本身格式无关（`dolce_play::phrase`，输入由 `phrasesong` 拼），这里只做两件事：
//!
//! 1. **断点 → 行里的位置**：断点是「第 n 小节之前」/「某个和弦之后」，落点得是「某个声部元素流的第 k 个元素之前」。
//!    桥是断句输入的 `ids`（拍平下标 → 元素 id），再经视图的元素表回到行里的元素（元素带原文区间，重排据此切原文）。
//! 2. **多声部对齐**：断点只按主旋律算，合唱谱各声部得在同一拍位断行；对齐按**累计时值**，不按元素下标。
//!
//! 产出是一份新的行划分（[`NewLine`]），消费者（`dolce-formats` 的文本谱 / `.jpwabc` 重排、123 / ABC 写回换行位）据此改原文。
//! 「量行长的尺子」由宿主量好传进来（[`Measured`]：版心宽 + 各元素的自然跨度，键是元素 id）。

use std::collections::HashMap;

use dolce_base::{Fraction, SourceSpan};
use dolce_model::{ElementId, ScoreDoc};
use dolce_play::applybreaks::{choose_line_layout, merge_sliver_lines, page_break_lines, tidy_line_heads, tidy_line_tails, LayoutMode};
use dolce_play::phrase::{compute_phrase_breaks, FitMetric, PhraseBreaks, PhraseOptions, Span};
use dolce_play::phraseinput::PhrasePart;
use serde::{Deserialize, Serialize};

use crate::ast::{BarlineType, MarkType, MusicElement};
use crate::phrasedoc::phrase_jump_measures;
use crate::phrasesong::{phrase_part_of_song, ViewResult};
use crate::slots::{DocView, RowView, SongView};

/// 乐句排版时一页排几行。分页与断句共用这一个数。
const PAGE_LINES: usize = 4;

// ───────────────────────── 输出形状 ─────────────────────────

/// 一个声部在某一新行上占的元素区间（半开区间，下标是该声部整曲元素流的下标）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LineSeg {
    pub voice: f64,
    pub from: usize,
    pub to: usize,
}

/// 重排后的一行（一个「系统」：同组各声部各一条）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewLine {
    pub segs: Vec<LineSeg>,
    /// 本行行尾换页（下一行另起一页）
    pub page_after: bool,
}

/// 一个断点：新行从这个元素起。写回模型的那条路按 `id` 找元素，改写原文的那条路按 `source` 下刀；
/// `|:` 领起的新行 `id` 取它后面那个音（小节线不是模型元素），`source` 仍是 `|:` 自己的。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PhraseCut {
    pub id: Option<i64>,
    pub source: Option<SourceSpan>,
    /// 这一行另起一页
    pub page: bool,
}

/// 宿主量好的行长尺子：版心宽与这一首各元素的自然跨度（键是元素 id）。
#[derive(Debug, Clone, Default)]
pub struct Measured {
    pub width: f64,
    pub spans: HashMap<i64, Span>,
}

/// 新的行怎么分。
#[derive(Debug, Clone)]
pub enum LinePlan<'a> {
    /// 按乐句；`content` 是有尺子时的断句参数（成书出厂值，由宿主从样式表取；`jump_measures` 这里填），`mid` 采用行内断点
    Phrase { content: &'a PhraseOptions, mid: bool },
    /// 每行固定 n 小节
    Bars(f64),
}

/// 分行的结果：新行（没有可排的曲行为 None）、乐句方案放不下而保持原排版（`kept`）、每行 n 小节有一行放不下（`overflow`，1 基行号）。
#[derive(Debug, Clone, Default)]
pub struct PlanOut {
    pub lines: Option<Vec<NewLine>>,
    pub kept: bool,
    pub overflow: Option<usize>,
}

// ───────────────────────── 元素流 ─────────────────────────

/// 行在视图里的位置（页、组、组里第几行）：行的身份
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct RowKey {
    pub page: usize,
    pub group: usize,
    pub row: usize,
}

/// 视图里一个元素的身份：行里第几个，或行里第 `.1` 个并排块里的第 `.2` 个
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum ElKey {
    Top(usize, RowKey, usize),
    Sub(usize, RowKey, usize, usize),
}

/// 某个声部整曲的元素流：把它的各行首尾接起来。
pub struct VoiceStream<'a> {
    pub voice: f64,
    pub lines: Vec<(RowKey, &'a RowView)>,
    /// 平行于元素流：每个元素属于哪一条源行、在源行里是第几个
    pub origin: Vec<(usize, usize)>,
    pub elements: Vec<&'a MusicElement>,
    /// 平行于元素流：元素的模型 id（行视图 `refs`）
    pub ids: Vec<Option<i64>>,
    /// 平行于元素流：该元素之前的累计时值（四分音符为 1）
    pub ticks: Vec<Fraction>,
}

/// 每个元素下标的多连音比例：n 连音占 n−1 个基本时值（`tupletRatios`）
pub fn tuplet_ratios(line: &RowView) -> Vec<Option<(f64, f64)>> {
    let count = line.line.elements.len();
    let mut out = vec![None; count];
    for mk in &line.line.marks {
        if mk.kind != MarkType::Tuplet {
            continue;
        }
        let n = mk.end - mk.start + 1;
        if n <= 1 {
            continue;
        }
        let mut i = mk.start;
        while i <= mk.end && i < count as i64 {
            if i >= 0 {
                out[i as usize] = Some(((n - 1) as f64, n as f64));
            }
            i += 1;
        }
    }
    out
}

/// 音符 / 增时线的时值，以四分音符为 1（`elementQuarters`；多连音比例由调用方另乘）
pub fn element_quarters(el: &MusicElement) -> Fraction {
    match el {
        MusicElement::Sustain(_) => Fraction::int(1.0),
        MusicElement::Note(n) if n.placeholder != Some(true) => {
            let base = Fraction::new(4.0, n.duration as f64);
            if n.dots == 0 {
                return base;
            }
            let denom = (1u64 << n.dots) as f64;
            base.times_int(2.0 * denom - 1.0).div_int(denom)
        }
        _ => Fraction::int(0.0),
    }
}

fn rows_of(song: &SongView) -> impl Iterator<Item = (RowKey, &RowView)> {
    song.pages.iter().enumerate().flat_map(|(page, p)| {
        p.groups.iter().enumerate().flat_map(move |(group, g)| g.voices.iter().enumerate().map(move |(row, r)| (RowKey { page, group, row }, r)))
    })
}

/// 一首里出现过的声部号（按首次出现）。一个都没有退回 [1]
fn voices_of(song: &SongView) -> Vec<f64> {
    crate::phrasesong::voice_numbers(song)
}

/// 把一个声部的各行接成一条元素流（含累计时值，多连音按比例折算）
pub fn voice_stream(song: &SongView, voice: f64) -> VoiceStream<'_> {
    let mut st = VoiceStream { voice, lines: vec![], origin: vec![], elements: vec![], ids: vec![], ticks: vec![] };
    let mut tick = Fraction::int(0.0);
    for (key, row) in rows_of(song).filter(|(_, r)| r.line.voice == voice) {
        let line_idx = st.lines.len();
        st.lines.push((key, row));
        let ratios = tuplet_ratios(row);
        for (el_idx, el) in row.line.elements.iter().enumerate() {
            st.origin.push((line_idx, el_idx));
            st.elements.push(el);
            st.ids.push(row.refs.get(el_idx).and_then(|r| r.id));
            st.ticks.push(tick);
            let q = element_quarters(el);
            tick = tick.plus(&match ratios[el_idx] {
                Some((num, den)) => q.times_int(num).div_int(den),
                None => q,
            });
        }
    }
    st
}

/// 在行首领起的小节线：反复开始要印在新行的行首，其余的都该留在上一行行尾
fn opens_line(el: &MusicElement) -> bool {
    matches!(el, MusicElement::Barline(b) if matches!(b.kind, BarlineType::RepeatStart | BarlineType::RepeatBoth))
}

/// 把切点挪到元素之间该断的地方：小节线与 `~` / `^` 的时值都是 0，按累计时值找过来会正落在它们身上，
/// 而小节线是上一行的收尾，只有 `|:` 是下一行的起头。
fn align_cut(els: &[&MusicElement], k: usize) -> usize {
    let mut at = k;
    while at < els.len() && !opens_line(els[at]) && matches!(els[at], MusicElement::Barline(_) | MusicElement::BeatBoundary(_)) {
        at += 1;
    }
    while at > 0 && opens_line(els[at - 1]) {
        at -= 1;
    }
    at
}

/// 连音中间的切点挪到连音之后（MusicXML 连音拆不开小节，简谱里一组三连音分在两行也看不出是一组）。「切在 k 之前」。
fn past_tuplet(st: &VoiceStream, k: usize) -> usize {
    let mut base = 0usize;
    for (_, line) in &st.lines {
        let n = line.line.elements.len();
        if k > base && k < base + n {
            let rel = (k - base) as i64;
            for mk in &line.line.marks {
                if mk.kind != MarkType::Tuplet || rel <= mk.start || rel > mk.end {
                    continue;
                }
                let mut at = (base as i64 + mk.end + 1) as usize;
                while at < st.elements.len() && matches!(st.elements[at], MusicElement::Sustain(_)) {
                    at += 1;
                }
                return align_cut(&st.elements, at);
            }
        }
        base += n;
    }
    k
}

/// 元素流里第一个累计时值 ≥ tick 的下标（对齐用；找不到就是流末）
fn index_at_tick(st: &VoiceStream, tick: &Fraction) -> usize {
    for i in 0..st.ticks.len() {
        if st.ticks[i].compare_to(tick) >= 0 {
            return align_cut(&st.elements, i);
        }
    }
    st.elements.len()
}

/// 主旋律元素流 `[from, to)` 这一行 → 各声部同拍位的那一段
fn segs_of(streams: &[VoiceStream], lead: usize, from: usize, to: usize) -> Vec<LineSeg> {
    let ld = &streams[lead];
    let tick_from = ld.ticks.get(from).cloned().unwrap_or_else(|| Fraction::int(0.0));
    let tick_to = if to < ld.ticks.len() { Some(&ld.ticks[to]) } else { None };
    let mut segs = Vec::new();
    for (si, st) in streams.iter().enumerate() {
        let a = if si == lead { from } else { index_at_tick(st, &tick_from) };
        let b = if si == lead {
            to
        } else {
            match tick_to {
                None => st.elements.len(),
                Some(t) => index_at_tick(st, t),
            }
        };
        if b > a {
            segs.push(LineSeg { voice: st.voice, from: a, to: b });
        }
    }
    segs
}

/// 视图里元素 id → 元素（全文档头一次出现的那个；并排块里的元素先于块本身登记，补拍位的临时负号不登记）。同 `slots.ts` 的 `elementOf`
fn element_table(view: &DocView) -> HashMap<i64, ElKey> {
    let mut out: HashMap<i64, ElKey> = HashMap::new();
    for (si, sv) in view.songs.iter().enumerate() {
        for (key, row) in rows_of(sv) {
            for (ei, el) in row.line.elements.iter().enumerate() {
                if let MusicElement::InlineLayer(l) = el {
                    for (k, _) in l.elements.iter().enumerate() {
                        if let Some(Some(sid)) = l.ids.as_ref().and_then(|ids| ids.get(k)) {
                            if *sid >= 0 {
                                out.entry(*sid).or_insert(ElKey::Sub(si, key, ei, k));
                            }
                        }
                    }
                }
                if let Some(id) = row.refs.get(ei).and_then(|r| r.id) {
                    out.entry(id).or_insert(ElKey::Top(si, key, ei));
                }
            }
        }
    }
    out
}

/// 这一首的断句输入、各声部元素流，以及断点落在哪个声部（主旋律）上
struct Ctx<'a> {
    part: PhrasePart,
    ids: Vec<Option<ElementId>>,
    /// 平行于拍平和弦：它对着的音符元素在哪个声部流的第几个（`noteMap` + `where`；对不上为 None），以及对不对得上音符元素
    at: Vec<(bool, Option<(usize, usize)>)>,
    streams: Vec<VoiceStream<'a>>,
    lead: usize,
}

fn lead_of<'a>(doc: &ScoreDoc, view: &'a DocView, song_idx: usize) -> ViewResult<Option<Ctx<'a>>> {
    let Some(song) = view.songs.get(song_idx) else { return Ok(None) };
    let Some((part, ids)) = phrase_part_of_song(doc, view, song_idx)? else { return Ok(None) };
    let table = element_table(view);
    let voices = voices_of(song);
    let streams: Vec<VoiceStream> = voices.iter().map(|&v| voice_stream(song, v)).collect();
    if streams.is_empty() {
        return Ok(None);
    }
    let mut place: HashMap<(RowKey, usize), (usize, usize)> = HashMap::new();
    for (si, st) in streams.iter().enumerate() {
        for (idx, &(li, ei)) in st.origin.iter().enumerate() {
            if matches!(st.elements[idx], MusicElement::Note(_)) {
                place.insert((st.lines[li].0, ei), (si, idx));
            }
        }
    }
    let at: Vec<(bool, Option<(usize, usize)>)> = ids
        .iter()
        .map(|id| {
            let Some(ElKey::Top(s, key, ei)) = id.and_then(|id| table.get(&(id as i64)).copied()) else {
                // 并排块里的音符：对得上音符元素，但不在元素流里
                let sub_note = id.and_then(|id| table.get(&(id as i64)).copied()).is_some_and(|k| match k {
                    ElKey::Sub(s, key, ei, k) => sub_element(view, s, key, ei, k).is_some_and(|e| matches!(e, MusicElement::Note(_))),
                    ElKey::Top(..) => false,
                });
                return (sub_note, None);
            };
            let el = top_element(view, s, key, ei);
            if !matches!(el, Some(MusicElement::Note(_))) {
                return (false, None);
            }
            (true, if s == song_idx { place.get(&(key, ei)).copied() } else { None })
        })
        .collect();
    let lead_voice = at.iter().find(|a| a.0).and_then(|a| a.1).map(|(si, _)| streams[si].voice).unwrap_or(voices[0]);
    let Some(lead) = streams.iter().position(|s| s.voice == lead_voice) else { return Ok(None) };
    Ok(Some(Ctx { part, ids, at, streams, lead }))
}

fn row_at(view: &DocView, s: usize, key: RowKey) -> Option<&RowView> {
    view.songs.get(s)?.pages.get(key.page)?.groups.get(key.group)?.voices.get(key.row)
}
fn top_element(view: &DocView, s: usize, key: RowKey, ei: usize) -> Option<&MusicElement> {
    row_at(view, s, key)?.line.elements.get(ei)
}
fn sub_element(view: &DocView, s: usize, key: RowKey, ei: usize, k: usize) -> Option<&MusicElement> {
    match top_element(view, s, key, ei)? {
        MusicElement::InlineLayer(l) => l.elements.get(k),
        _ => None,
    }
}

/// 按 `plan` 分出这一首的新行。
pub fn plan_lines(doc: &ScoreDoc, view: &DocView, song_idx: usize, plan: &LinePlan, measured: Option<&Measured>) -> ViewResult<PlanOut> {
    match plan {
        LinePlan::Phrase { content, mid } => phrase_lines(doc, view, song_idx, content, *mid, measured),
        LinePlan::Bars(n) => {
            let Some(ctx) = lead_of(doc, view, song_idx)? else { return Ok(PlanOut::default()) };
            let lines = bar_lines_of(&ctx, *n);
            let overflow = match (&lines, measured) {
                (Some(ls), Some(m)) => bar_lines_overflow(&ctx, ls, m),
                _ => None,
            };
            Ok(PlanOut { lines, kept: false, overflow })
        }
    }
}

/// **每行 n 小节**：只按主旋律的小节线数，原有换行一律作废。弱起不计数并进首行；源里原有的换页照留（换页处一定切一刀，
/// 之后从下一个完整小节起重新数）；剩下不足 n 的照留为末行；`|:` 领起新行。
pub fn bar_lines(doc: &ScoreDoc, view: &DocView, song_idx: usize, n: f64) -> ViewResult<Option<Vec<NewLine>>> {
    Ok(lead_of(doc, view, song_idx)?.and_then(|ctx| bar_lines_of(&ctx, n)))
}

fn bar_lines_of(ctx: &Ctx, n: f64) -> Option<Vec<NewLine>> {
    if n < 1.0 {
        return None;
    }
    let lead = &ctx.streams[ctx.lead];
    let els = &lead.elements;
    // 小节起点：小节线之后（`|:` 退到它自己前面）
    let mut starts: Vec<usize> = Vec::new();
    for i in 1..els.len() {
        if !matches!(els[i - 1], MusicElement::Barline(_)) || matches!(els[i], MusicElement::Barline(_)) {
            continue;
        }
        let at = align_cut(els, i);
        if at > 0 && at < els.len() && starts.last() != Some(&at) {
            starts.push(at);
        }
    }
    if starts.is_empty() {
        return None;
    }
    let tick_at = |i: usize| if i < lead.ticks.len() { lead.ticks[i] } else { Fraction::int(0.0) };
    let pickup = starts.len() >= 2 && tick_at(starts[0]).compare_to(&tick_at(starts[1]).minus(&tick_at(starts[0]))) < 0;
    // 源里的换页：主旋律流里换了页的地方
    let mut page_cuts: Vec<usize> = Vec::new();
    for i in 1..lead.origin.len() {
        let a = lead.lines[lead.origin[i - 1].0].0;
        let b = lead.lines[lead.origin[i].0].0;
        if a != b && a.page != b.page {
            let c = align_cut(els, i);
            if !page_cuts.contains(&c) {
                page_cuts.push(c);
            }
        }
    }
    let mut all: Vec<usize> = starts.clone();
    for &c in &page_cuts {
        if !all.contains(&c) {
            all.push(c);
        }
    }
    all.sort_unstable();
    let mut cuts: Vec<(usize, bool)> = Vec::new(); // 切点 → 这一刀换页（插入次序）
    let set_cut = |cuts: &mut Vec<(usize, bool)>, b: usize, page: bool| match cuts.iter_mut().find(|c| c.0 == b) {
        Some(c) => c.1 = page,
        None => cuts.push((b, page)),
    };
    let mut count = 0.0;
    let mut partial = false;
    for &b in &all {
        if b == 0 || b >= els.len() {
            continue;
        }
        if page_cuts.contains(&b) {
            set_cut(&mut cuts, b, true);
            count = 0.0;
            partial = !starts.contains(&b);
            continue;
        }
        if (b == starts[0] && pickup) || partial {
            partial = false;
            continue;
        }
        count += 1.0;
        if count >= n {
            set_cut(&mut cuts, b, false);
            count = 0.0;
        }
    }
    let mut bounds: Vec<usize> = cuts.iter().map(|c| c.0).collect();
    bounds.sort_unstable();
    bounds.insert(0, 0);
    let mut lines = Vec::new();
    for (i, &from) in bounds.iter().enumerate() {
        let to = bounds.get(i + 1).copied().unwrap_or(els.len());
        let segs = segs_of(&ctx.streams, ctx.lead, from, to);
        if !segs.is_empty() {
            let page_after = to < els.len() && cuts.iter().any(|c| c.0 == to && c.1);
            lines.push(NewLine { segs, page_after });
        }
    }
    if lines.is_empty() {
        None
    } else {
        Some(lines)
    }
}

/// 分出来的行里第一个在版心里放不下的（1 基行号）。量法同断句的容量判据：行首音的 `x0` 到行末音的 `x1b`（没有就 `x1`）
fn bar_lines_overflow(ctx: &Ctx, lines: &[NewLine], measured: &Measured) -> Option<usize> {
    let lead = &ctx.streams[ctx.lead];
    for (li, line) in lines.iter().enumerate() {
        let Some(seg) = line.segs.iter().find(|s| s.voice == lead.voice) else { continue };
        let mut x0 = f64::INFINITY;
        let mut x1 = f64::NEG_INFINITY;
        for id in &lead.ids[seg.from..seg.to] {
            let Some(sp) = id.and_then(|id| measured.spans.get(&id)) else { continue };
            x0 = dolce_base::js::min(x0, sp.x0);
            x1 = dolce_base::js::max(x1, sp.x1b.unwrap_or(sp.x1));
        }
        if x1 > x0 && x1 - x0 > measured.width + 0.5 {
            return Some(li + 1);
        }
    }
    None
}

/// 原文现有的行（主旋律那一路，按源行切）：判「原始排版放不放得下」用
fn source_lines(lead: &VoiceStream) -> Vec<NewLine> {
    let mut lines = Vec::new();
    let mut from = 0;
    for i in 1..=lead.origin.len() {
        if i < lead.origin.len() && lead.origin[i].0 == lead.origin[i - 1].0 {
            continue;
        }
        lines.push(NewLine { segs: vec![LineSeg { voice: lead.voice, from, to: i }], page_after: false });
        from = i;
    }
    lines
}

/// 有尺子时的断句：与成书同一套——断句只看内容，行长只在最后一步用（选档、收拾行首行尾、并碎行）。
/// 有行放不下就整个放弃（`ok` false，`breaks` 是均匀排版那一档），调用方先看原始排版放不放得下。
fn content_breaks(part: &PhrasePart, fit: &FitMetric, jump_measures: Vec<usize>, content: &PhraseOptions, mid: bool) -> (PhraseBreaks, bool) {
    let mut opts = content.clone();
    opts.jump_measures = Some(jump_measures);
    let mut breaks = compute_phrase_breaks(part, &opts);
    // 两档都许两两合并（用户定 2026-11-03）
    let mode = choose_line_layout(part, &mut breaks, 0.0, mid, true, Some(fit));
    tidy_line_heads(part, &mut breaks, mid, 0.0, Some(fit));
    tidy_line_tails(part, &mut breaks, mid, 0.0, Some(fit));
    merge_sliver_lines(part, &mut breaks, mid, 0.0, Some(fit));
    (breaks, mode != LayoutMode::Even)
}

/// 这一首该怎么按乐句分行。有尺子按真实宽度（`content` 是断句参数），没有就只按小节数断、行长目标取出厂值。
pub fn phrase_lines(doc: &ScoreDoc, view: &DocView, song_idx: usize, content: &PhraseOptions, mid: bool, measured: Option<&Measured>) -> ViewResult<PlanOut> {
    let Some(ctx) = lead_of(doc, view, song_idx)? else { return Ok(PlanOut::default()) };
    let part = &ctx.part;
    let breaks = match measured {
        Some(m) => {
            let fit = FitMetric { width: m.width, spans: ctx.ids.iter().map(|id| id.and_then(|id| m.spans.get(&(id as i64)).copied())).collect() };
            let jump = doc.songs.get(song_idx).map(|s| phrase_jump_measures(s, 0)).unwrap_or_default();
            let (breaks, ok) = content_breaks(part, &fit, jump, content, mid);
            // 乐句方案有行放不下 → 原始排版每行放得下就保持原样，否则用均匀排版
            if !ok && bar_lines_overflow(&ctx, &source_lines(&ctx.streams[ctx.lead]), m).is_none() {
                return Ok(PlanOut { lines: None, kept: true, overflow: None });
            }
            breaks
        }
        None => compute_phrase_breaks(part, &PhraseOptions { page_lines: Some(PAGE_LINES as f64), ..Default::default() }),
    };
    let lead = &ctx.streams[ctx.lead];
    let n = lead.elements.len();
    // 断点 → 主旋律元素流下标（「在此元素之前起新行」）
    let idx_of = |k: usize| ctx.at[k].1.filter(|&(si, _)| si == ctx.lead).map(|(_, i)| i);
    let mut cuts: Vec<usize> = Vec::new();
    let mut section_at: Vec<usize> = Vec::new();
    let mut flat = 0usize;
    for (mid_i, m) in part.measures.iter().enumerate() {
        let cnt = m.chords.len();
        if mid_i > 0 && breaks.measure_breaks.contains(&mid_i) {
            // 小节边界：落在本小节第一个音符之前（小节线元素留在上一行行尾）
            let first = (flat..flat + cnt).find(|&k| ctx.at[k].0);
            if let Some(i) = first.and_then(idx_of).map(|raw| align_cut(&lead.elements, raw)) {
                if i > 0 {
                    if !cuts.contains(&i) {
                        cuts.push(i);
                    }
                    if breaks.section_starts.contains(&mid_i) && !section_at.contains(&i) {
                        section_at.push(i);
                    }
                }
            }
        }
        for (k, a) in ctx.at.iter().enumerate().skip(flat).take(cnt) {
            if !a.0 {
                continue;
            }
            let sect = breaks.section_cut_chords.contains(&k);
            if !breaks.mid_breaks.contains(&k) && !sect {
                continue;
            }
            let Some(i) = idx_of(k) else { continue };
            // 行内断点：在该音符之后换行；跟在它后面的增时线属于同一个音，一并带走
            let mut at = i + 1;
            while at < n && matches!(lead.elements[at], MusicElement::Sustain(_)) {
                at += 1;
            }
            let at = past_tuplet(lead, align_cut(&lead.elements, at));
            if at > 0 && at < n {
                if !cuts.contains(&at) {
                    cuts.push(at);
                }
                if sect && !section_at.contains(&at) {
                    section_at.push(at);
                }
            }
        }
        flat += cnt;
    }
    // 切点 → 各声部同拍位的切点 → 新的行
    cuts.sort_unstable();
    cuts.insert(0, 0);
    let mut section_ends: Vec<usize> = Vec::new();
    let mut lines: Vec<NewLine> = Vec::new();
    for (i, &from) in cuts.iter().enumerate() {
        let to = cuts.get(i + 1).copied().unwrap_or(n);
        let segs = segs_of(&ctx.streams, ctx.lead, from, to);
        if !segs.is_empty() {
            lines.push(NewLine { segs, page_after: false });
        }
        if to < n && section_at.contains(&to) && !section_ends.contains(&lines.len()) {
            section_ends.push(lines.len());
        }
    }
    if lines.is_empty() {
        return Ok(PlanOut::default());
    }
    // 分页：与 `.jpwabc` 同一个助手、同一套「放不下才在段界换页」的口径
    let page_at = page_break_lines(lines.len(), &section_ends, PAGE_LINES);
    let total = lines.len();
    for (i, l) in lines.iter_mut().enumerate() {
        l.page_after = page_at.contains(&(i + 1)) && i + 1 < total;
    }
    Ok(PlanOut { lines: Some(lines), kept: false, overflow: None })
}

/// **照原文现有的行结构**，只在元素 `after_id` 之后加一刀（`add`）或去掉它后面那一刀（与下一行合并）。
/// 可视化编辑增删文本谱换行用。元素不在这首里、或这一刀加不上 / 去不掉时回 None。
pub fn lines_edited(view: &DocView, song_idx: usize, after_id: i64, add: bool, page: bool) -> Option<Vec<NewLine>> {
    let song = view.songs.get(song_idx)?;
    let ElKey::Top(s, key, ei) = *element_table(view).get(&after_id)? else { return None };
    if s != song_idx {
        return None;
    }
    let voices = voices_of(song);
    let streams: Vec<VoiceStream> = voices.iter().map(|&v| voice_stream(song, v)).collect();
    // 刀落在这个元素所在的声部上，其余声部按拍位跟
    let (lead, idx) = streams.iter().enumerate().find_map(|(si, st)| st.origin.iter().position(|&(li, e)| st.lines[li].0 == key && e == ei).map(|i| (si, i)))?;
    let ld = &streams[lead];
    let n = ld.elements.len();
    let mut cuts: Vec<usize> = Vec::new();
    let mut page_cuts: Vec<usize> = Vec::new();
    for i in 1..ld.origin.len() {
        let a = ld.origin[i - 1].0;
        let b = ld.origin[i].0;
        if a == b {
            continue;
        }
        cuts.push(i);
        if ld.lines[a].0.page != ld.lines[b].0.page {
            page_cuts.push(i);
        }
    }
    if add {
        let mut at = idx + 1;
        while at < n && matches!(ld.elements[at], MusicElement::Sustain(_)) {
            at += 1;
        }
        let at = align_cut(&ld.elements, at);
        if at == 0 || at >= n {
            return None;
        }
        if !cuts.contains(&at) {
            cuts.push(at);
        }
        if page && !page_cuts.contains(&at) {
            page_cuts.push(at);
        }
    } else {
        let at = cuts.iter().copied().filter(|&c| c > idx).min()?;
        cuts.retain(|&c| c != at);
        page_cuts.retain(|&c| c != at);
    }
    cuts.sort_unstable();
    cuts.insert(0, 0);
    let mut lines = Vec::new();
    for (i, &from) in cuts.iter().enumerate() {
        let to = cuts.get(i + 1).copied().unwrap_or(n);
        let segs = segs_of(&streams, lead, from, to);
        if !segs.is_empty() {
            lines.push(NewLine { segs, page_after: page_cuts.contains(&to) });
        }
    }
    if lines.is_empty() {
        None
    } else {
        Some(lines)
    }
}

/// 新行 → 断点（不含第一行的行首）：各声部同拍位起头，取段首那一条（主旋律优先）的第一个有 id / 有原文的元素。
pub fn cuts_of_lines(song: &SongView, lines: &[NewLine]) -> Vec<PhraseCut> {
    let voices = voices_of(song);
    let streams: Vec<VoiceStream> = voices.iter().map(|&v| voice_stream(song, v)).collect();
    let mut cuts = Vec::new();
    for i in 1..lines.len() {
        let Some(seg) = lines[i].segs.first() else { continue };
        let Some(st) = streams.iter().find(|s| s.voice == seg.voice) else { continue };
        let mut id = None;
        let mut source: Option<SourceSpan> = None;
        for k in seg.from..seg.to {
            let el = st.elements[k];
            if source.is_none() && el.source().length > 0 {
                source = Some(*el.source());
            }
            if id.is_none() {
                id = st.ids[k];
            }
            if id.is_some() && source.is_some() {
                break;
            }
        }
        cuts.push(PhraseCut { id, source, page: lines[i - 1].page_after });
    }
    cuts
}

/// 重排的断点（不含第一行的行首），新行按 `plan` 分。与格式无关：都只经行视图读谱。
pub fn phrase_cuts(doc: &ScoreDoc, view: &DocView, song_idx: usize, plan: &LinePlan, measured: Option<&Measured>) -> ViewResult<(Option<Vec<PhraseCut>>, PlanOut)> {
    let out = plan_lines(doc, view, song_idx, plan, measured)?;
    let cuts = match (&out.lines, view.songs.get(song_idx)) {
        (Some(lines), Some(song)) => Some(cuts_of_lines(song, lines)),
        _ => None,
    };
    Ok((cuts, out))
}
