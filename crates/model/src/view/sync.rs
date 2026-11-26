//! 双向定位索引的建表：**源文本偏移 ↔ 谱面元素**（同 TS `src/editor/sync.ts::SyncIndex.build`，有原文位置的四种格式共用）。
//!
//! 音符与歌词音节走排版行视图（[`crate::view::slots::DocView`]）：音节配给哪个音符视图里已经定好，与排版器同一份；
//! 增时线、小节线、挂载记号、弧、换行符视图里不带原文区间，直接从模型取。条目形状共用 `crate::xmlsync`，
//! **按推入次序**给（音符那张反查表「后来的覆盖先来的」、排序都在 TS，与 `.musicxml` 那一路同口径）。

use crate::view::ast::MusicElement;
use crate::view::phraselines::{element_table, sub_element, top_element, ElKey};
use crate::view::slots::{DocView, RowView};
use crate::base::SourceSpan;
use crate::doc::{AttachedSource, BarLocation, BreakKind, Chord, Element, ElementId, MarkType, Measure, Part, ScoreDoc};
use crate::helpers::break_after;
use crate::xmlsync::{BreakAt, Span, SyncEntry, XmlSync};
use std::collections::{HashMap, VecDeque};

fn span_of(s: &SourceSpan) -> Span {
    Span { from: s.offset as usize, to: (s.offset + s.length) as usize }
}

/// 有原文区间（零长不算：转换来的元素可能没有真实 span）
fn real(s: Option<&SourceSpan>) -> Option<&SourceSpan> {
    s.filter(|s| s.length > 0)
}

/// 视图里这个元素是不是音符（`elementOf.get(id)?.kind === "note"`）
fn is_note(view: &DocView, table: &HashMap<i64, ElKey>, id: i64) -> bool {
    let el = match table.get(&id) {
        Some(&ElKey::Top(s, key, ei)) => top_element(view, s, key, ei),
        Some(&ElKey::Sub(s, key, ei, k)) => sub_element(view, s, key, ei, k),
        None => None,
    };
    matches!(el, Some(MusicElement::Note(_)))
}

/// 一行里的音符与歌词音节
fn row_entries(view: &DocView, table: &HashMap<i64, ElKey>, row: &RowView, out: &mut Vec<SyncEntry>) {
    // 同一谱表的第二声部（123 / ABC 的 `&`）并在块里：块里的音也进索引；补拍位的临时负号不算
    for (ei, el) in row.line.elements.iter().enumerate() {
        let subs: Vec<(&MusicElement, Option<i64>)> = match el {
            MusicElement::InlineLayer(l) if l.role == crate::view::ast::LayerRole::Voice => l
                .elements
                .iter()
                .enumerate()
                .map(|(k, sub)| (sub, l.ids.as_ref().and_then(|ids| ids.get(k).copied().flatten()).filter(|&id| id >= 0)))
                .collect(),
            _ => vec![(el, row.refs.get(ei).and_then(|r| r.id))],
        };
        for (el, id) in subs {
            let (MusicElement::Note(n), Some(id)) = (el, id) else { continue };
            let sp = span_of(&n.source);
            if sp.to > sp.from {
                out.push(SyncEntry::new("note", sp, id));
            }
        }
    }
    // 歌词音节按序配给跟歌词的音符 / 增时线（视图里已经定好），配到的得是音符
    let anchors: Vec<Option<i64>> = row
        .line
        .elements
        .iter()
        .enumerate()
        .filter(|(_, el)| match el {
            MusicElement::Note(n) => n.lyric_anchor,
            MusicElement::Sustain(s) => s.lyric_anchor,
            _ => false,
        })
        .map(|(ei, _)| row.refs.get(ei).and_then(|r| r.id))
        .collect();
    for (verse, line) in row.line.lyrics.iter().enumerate() {
        for (k, syl) in line.syllables.iter().enumerate() {
            if syl.text.is_empty() {
                continue; // 空音节是「跳过一个音符」，没有原文可指
            }
            let Some(Some(id)) = anchors.get(k).copied() else { continue };
            if !is_note(view, table, id) {
                continue;
            }
            let sp = span_of(&syl.source);
            if sp.to > sp.from {
                let mut e = SyncEntry::new("lyric", sp, id);
                e.verse = Some(verse as f64);
                e.verse_no = Some(line.verse_from);
                out.push(e);
            }
        }
    }
}

fn attached_of(el: &Element) -> Option<&Vec<AttachedSource>> {
    match el {
        Element::Chord(c) => c.attached_sources.as_ref(),
        Element::Space(s) => s.attached_sources.as_ref(),
    }
}

/// `own`：挂在增时线上时那条增时线的 id（条目仍记在宿主音符名下）
fn push_attached(list: Option<&Vec<AttachedSource>>, id: ElementId, own: Option<ElementId>, out: &mut Vec<SyncEntry>) {
    for a in list.into_iter().flatten() {
        let Some(s) = real(Some(&a.source)) else { continue };
        let mut e = SyncEntry::new("mark", span_of(s), id as i64);
        e.mark_kind = Some(a.kind.as_str().to_owned().into());
        e.name = Some(a.name.clone());
        e.own = own;
        out.push(e);
    }
}

/// 一个声部里的增时线、小节线、挂载记号
fn part_extras(part: &Part, out: &mut Vec<SyncEntry>) {
    let mut last_id: Option<ElementId> = None;
    for m in &part.measures {
        let bars = m.barlines.as_deref().unwrap_or(&[]);
        for bl in bars.iter().filter(|b| b.location == BarLocation::Left) {
            let Some(s) = real(bl.source.as_ref()) else { continue };
            if let Some(first) = m.elements.first().map(|e| e.id()).or(last_id) {
                let mut e = SyncEntry::new("barline", span_of(s), first as i64);
                e.edge = Some("before");
                out.push(e);
            }
        }
        for el in &m.elements {
            push_attached(attached_of(el), el.id(), None, out);
            let Element::Chord(ch) = el else { continue };
            for (ord, su) in ch.sustains.iter().flatten().enumerate() {
                if let Some(s) = real(su.source.as_ref()) {
                    let mut e = SyncEntry::new("sustain", span_of(s), ch.id as i64);
                    e.own = Some(su.id);
                    e.ord = Some(ord);
                    out.push(e);
                }
                push_attached(su.attached_sources.as_ref(), ch.id, Some(su.id), out);
            }
            last_id = Some(ch.id);
        }
        for bl in bars.iter().filter(|b| b.location != BarLocation::Left) {
            let (Some(s), Some(last)) = (real(bl.source.as_ref()), last_id) else { continue };
            let mut e = SyncEntry::new("barline", span_of(s), last as i64);
            e.edge = Some("after");
            out.push(e);
        }
    }
}

/// 和弦（或它的某条增时线）后面的小节中间换行
fn inline_break_of(ch: &Chord) -> Option<&BreakKind> {
    ch.line_break_after.as_ref().or_else(|| ch.sustains.iter().flatten().find_map(|su| su.line_break_after.as_ref()))
}

/// 一个声部里的全部换行：小节级（`Print` / `Part.endBreak`）与小节中间（`lineBreakAfter`），
/// 再按「符号前面那个元素」对上原文里记下的符号位置（`Part.breakSources`）
fn part_breaks(part: &Part) -> Vec<BreakAt> {
    let mut spans: HashMap<Option<ElementId>, VecDeque<SourceSpan>> = HashMap::new();
    for b in part.break_sources.iter().flatten() {
        spans.entry(b.after).or_default().push_back(b.source);
    }
    let mut take = |after: ElementId| spans.get_mut(&Some(after)).and_then(|q| q.pop_front()).map(|s| span_of(&s));
    let last_of = |m: &Measure| m.elements.last().map(|e| e.id());
    let mut out = Vec::new();
    for (i, m) in part.measures.iter().enumerate() {
        let mut inline = false;
        for el in &m.elements {
            let Element::Chord(ch) = el else { continue };
            let Some(kind) = inline_break_of(ch) else { continue };
            out.push(BreakAt { page: *kind == BreakKind::Page, after: ch.id, span: take(ch.id) });
            inline = true;
        }
        // 小节中间换过行的，下一小节那份小节级换行是同一处，不重复画
        let (Some(kind), false, Some(after)) = (break_after(part, i), inline, last_of(m)) else { continue };
        // 声部末尾的换行（`Part.endBreak`）只在原文里真有符号时画：文本谱每行行尾都记了一份
        let span = take(after);
        if i == part.measures.len() - 1 && span.is_none() {
            continue;
        }
        out.push(BreakAt { page: kind == BreakKind::Page, after, span });
    }
    out
}

/// 同 `SyncIndex.build`：条目按推入次序、换行符只按各首第一声部（多声部各行一起换，画一遍就够）
pub fn build_sync(doc: &ScoreDoc, view: &DocView) -> XmlSync {
    let table = element_table(view);
    let mut out = Vec::new();
    for sv in &view.songs {
        for page in &sv.pages {
            for group in &page.groups {
                for row in &group.voices {
                    row_entries(view, &table, row, &mut out);
                }
            }
        }
    }
    // 音符以外的东西直接从模型取（视图里它们不带原文区间）
    let mut breaks = Vec::new();
    for song in &doc.songs {
        for (pi, part) in song.parts.iter().enumerate() {
            part_extras(part, &mut out);
            if pi == 0 {
                breaks.extend(part_breaks(part));
            }
        }
        for mk in &song.marks {
            let (MarkType::Slur, Some(open)) = (&mk.kind, real(mk.open_source.as_ref())) else { continue };
            let open = span_of(open);
            let close = real(mk.close_source.as_ref()).map(span_of);
            let base = |sp: Span, pair: Option<Span>| {
                let mut e = SyncEntry::new("mark", sp, mk.start as i64);
                e.end = Some(mk.end);
                e.mark_kind = Some("slur".into());
                e.name = Some("slur".to_owned());
                e.pair = pair;
                e
            };
            out.push(base(open, close));
            if let Some(close) = close {
                out.push(base(close, Some(open)));
            }
        }
    }
    for b in &breaks {
        if let Some(sp) = b.span {
            let mut e = SyncEntry::new("break", sp, b.after as i64);
            e.page = Some(b.page);
            out.push(e);
        }
    }
    XmlSync { entries: out, breaks }
}
