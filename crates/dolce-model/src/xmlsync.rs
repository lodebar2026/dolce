//! `.musicxml` 的源码同步索引（同 `src/editor/sync.ts::SyncIndex.buildXml`）：模型不记原文位置，条目区间取表层原节点记的区间。
//!
//! 条目形状同 TS `SyncEntry`（JSON 直接给编辑器），按推入次序给（排序在 TS）；区间一律 UTF-16 码元。原节点不是从这份原文读出来的（区间对不上）就整份不建，回 `None`。

use crate::doc::*;
use crate::xmlsurface::{Slot, Surface};
use dolce_xml::{NodeId, Tree};
use serde::Serialize;

/// 同 TS `SyncEntry`（只出 `buildXml` 会填的字段）
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncEntry {
    pub kind: &'static str,
    pub from: usize,
    pub to: usize,
    pub id: i64,
    pub verse: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verse_no: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mark_kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir: Option<DirAt>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir_end: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edge: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<ElementId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pair: Option<Span>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<bool>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
pub struct DirAt {
    pub pi: usize,
    pub mi: usize,
    pub index: usize,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
pub struct Span {
    pub from: usize,
    pub to: usize,
}

/// 同 TS `SyncIndex.breakList` 的一条
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct BreakAt {
    pub page: bool,
    pub after: ElementId,
    pub span: Option<Span>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct XmlSync {
    pub entries: Vec<SyncEntry>,
    pub breaks: Vec<BreakAt>,
}

impl SyncEntry {
    fn new(kind: &'static str, sp: Span, id: i64) -> SyncEntry {
        SyncEntry {
            kind,
            from: sp.from,
            to: sp.to,
            id,
            verse: None,
            verse_no: None,
            mark_kind: None,
            name: None,
            dir: None,
            dir_end: None,
            edge: None,
            end: None,
            pair: None,
            page: None,
        }
    }
}

fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// `text.startsWith(pat, at)`（UTF-16）
fn starts_with(text: &[u16], at: usize, pat: &[u16]) -> bool {
    at <= text.len() && text[at..].starts_with(pat)
}

/// `text.indexOf(pat, from)`（UTF-16）
fn index_of(text: &[u16], pat: &[u16], from: usize) -> Option<usize> {
    if pat.is_empty() {
        return Some(from.min(text.len()));
    }
    (from..text.len().saturating_sub(pat.len() - 1)).find(|&i| text[i..].starts_with(pat))
}

fn is_word(c: u16) -> bool {
    (b'a' as u16..=b'z' as u16).contains(&c) || (b'A' as u16..=b'Z' as u16).contains(&c) || (b'0' as u16..=b'9' as u16).contains(&c) || c == b'_' as u16
}

/// 在 `text[at..lim]` 上试配 `<tag\b[^>]*>(body)</tag>`（`body_plus`：`[^<]+`，否则 `[^<]*`）。配上回（整段终点、正文起止）。
fn match_tag(text: &[u16], at: usize, lim: usize, tag: &[u16], body_plus: bool) -> Option<(usize, usize, usize)> {
    let open: Vec<u16> = std::iter::once(b'<' as u16).chain(tag.iter().copied()).collect();
    if at + open.len() > lim || !text[at..].starts_with(&open) {
        return None;
    }
    let mut i = at + open.len();
    if i < lim && is_word(text[i]) {
        return None;
    }
    while i < lim && text[i] != b'>' as u16 {
        i += 1;
    }
    if i >= lim {
        return None;
    }
    let body = i + 1;
    let mut j = body;
    while j < lim && text[j] != b'<' as u16 {
        j += 1;
    }
    if body_plus && j == body {
        return None;
    }
    let close: Vec<u16> = [b'<' as u16, b'/' as u16].into_iter().chain(tag.iter().copied()).chain(std::iter::once(b'>' as u16)).collect();
    if j + close.len() > lim || !text[j..].starts_with(&close) {
        return None;
    }
    Some((j + close.len(), body, j))
}

struct Cx<'a> {
    t: &'a Tree,
    s: &'a Surface,
    text: Vec<u16>,
}

impl Cx<'_> {
    fn sur(&self, oid: Oid, slot: Slot) -> Option<NodeId> {
        if oid.is_none() {
            None
        } else {
            self.s.of(oid, slot)
        }
    }

    /// 节点在原文里的区间：开标签起，到配对的闭标签止。新建、克隆的节点没有
    fn span_of(&self, el: Option<NodeId>, tag: &str) -> Option<Span> {
        let el = el?;
        let start = self.t.start(el);
        if start < 0 || self.t.tag(el) != tag || !starts_with(&self.text, start as usize, &utf16(&format!("<{tag}"))) {
            return None;
        }
        Some(Span { from: start as usize, to: self.t.end(el) as usize })
    }

    fn element_children(&self, el: Option<NodeId>) -> Vec<NodeId> {
        el.map(|e| self.t.children(e).collect()).unwrap_or_default()
    }
}

/// 同 `SyncIndex.buildXml`。原节点对不上原文为 `None`。
pub fn build_xml_sync(doc: &ScoreDoc, surface: &Surface, text: &str) -> Option<XmlSync> {
    let cx = Cx { t: surface.tree(), s: surface, text: utf16(text) };
    let song0 = doc.songs.first()?;
    let root = cx.sur(song0.oid, Slot::Default)?;
    let (rs, re) = (cx.t.start(root), cx.t.end(root));
    if rs < 0 || re as usize > cx.text.len() || re < 1 || cx.text[re as usize - 1] != b'>' as u16 || !starts_with(&cx.text, rs as usize, &utf16(&format!("<{}", cx.t.tag(root)))) {
        return None;
    }
    let mut out: Vec<SyncEntry> = vec![];
    let mut breaks: Vec<BreakAt> = vec![];
    let lyric_pat = utf16("<lyric");
    for song in &doc.songs {
        for (pi, part) in song.parts.iter().enumerate() {
            let mut last_id: Option<ElementId> = None;
            for (mi, m) in part.measures.iter().enumerate() {
                for el in &m.elements {
                    let Element::Chord(ch) = el else { continue };
                    let id = ch.id as i64;
                    let head = cx.span_of(cx.sur(ch.oid, Slot::Default), "note");
                    let tail_node = ch.notes.last().and_then(|n| cx.sur(n.oid, Slot::Default));
                    let tail = if ch.notes.is_empty() { head } else { tail_node.and_then(|n| cx.span_of(Some(n), "note")) };
                    if let (Some(h), Some(tl)) = (head, tail) {
                        // 歌词写在 `<note>` 里面：音符的区间截到第一个 `<lyric` 之前
                        let mut to = h.to.max(tl.to);
                        if let Some(ly) = index_of(&cx.text, &lyric_pat, h.from) {
                            if ly < to {
                                to = ly;
                            }
                        }
                        out.push(SyncEntry::new("note", Span { from: h.from, to }, id));
                    }
                    for ly in ch.lyrics.iter().flatten() {
                        let Some(bx) = cx.span_of(cx.sur(ly.oid, Slot::Default), "lyric") else { continue };
                        // `/<text\b[^>]*>([^<]*)<\/text>/.exec(片段)`：片段里第一处
                        let tag = utf16("text");
                        let hit = (bx.from..bx.to).find_map(|i| match_tag(&cx.text, i, bx.to, &tag, false));
                        let Some((_, b0, b1)) = hit else { continue };
                        if b1 == b0 {
                            continue;
                        }
                        let mut e = SyncEntry::new("lyric", Span { from: b0, to: b1 }, id);
                        e.verse = Some(ly.number - 1.0);
                        e.verse_no = Some(ly.number);
                        out.push(e);
                    }
                    // 音符上的记号（`<notations>` 里的奏法、装饰、延长号）
                    for (ni, n) in ch.notes.iter().enumerate() {
                        let ne = cx.sur(n.oid, Slot::Default).or_else(|| if ni == 0 { cx.sur(ch.oid, Slot::Default) } else { None });
                        for nt in cx.element_children(ne).into_iter().filter(|&c| cx.t.tag(c) == "notations") {
                            for c in cx.t.children(nt) {
                                let tg = cx.t.tag(c);
                                let items: Vec<NodeId> = if tg == "articulations" || tg == "ornaments" {
                                    cx.t.children(c).collect()
                                } else if tg == "fermata" {
                                    vec![c]
                                } else {
                                    vec![]
                                };
                                for it in items {
                                    let itag = cx.t.tag(it).to_owned();
                                    let Some(sp) = cx.span_of(Some(it), &itag) else { continue };
                                    let name = if itag == "fermata" && cx.t.get_attribute(it, "type") == Some("inverted") { "fermata-inverted".to_owned() } else { itag };
                                    let mut e = SyncEntry::new("mark", sp, id);
                                    e.mark_kind = Some("deco");
                                    e.name = Some(name);
                                    out.push(e);
                                }
                            }
                        }
                    }
                    if let Some(h) = &ch.harmony {
                        if let Some(sp) = cx.span_of(cx.sur(h.oid, Slot::Default), "harmony") {
                            let mut e = SyncEntry::new("mark", sp, id);
                            e.mark_kind = Some("harmony");
                            e.name = Some(h.text.clone().unwrap_or_default());
                            out.push(e);
                        }
                    }
                    last_id = Some(ch.id);
                }
                // `<direction>`：挂在 `afterElements` 指的那个音前（之后第一个和弦；小节末的借最后一个和弦）
                for (index, d) in m.directions.iter().flatten().enumerate() {
                    let sp = cx.span_of(cx.sur(d.oid, Slot::Default), "direction");
                    let k = dolce_base::js::max(0.0, d.after_elements.unwrap_or(0.0));
                    let same_voice = |e: &&Element| matches!(e, Element::Chord(c) if d.voice.is_none() || Some(c.voice) == d.voice);
                    let after = m.elements.iter().skip(if k.is_nan() { 0 } else { k as usize }).find(same_voice);
                    let host = after
                        .or_else(|| m.elements.iter().rev().find(same_voice))
                        .or_else(|| m.elements.iter().rev().find(|e| matches!(e, Element::Chord(_))));
                    let (Some(sp), Some(host)) = (sp, host) else { continue };
                    let mark_kind = match d.kind.as_str() {
                        "dynamics" => "dynamic",
                        "words" | "rehearsal" => "annotation",
                        _ => "dir",
                    };
                    let mut e = SyncEntry::new("mark", sp, host.id() as i64);
                    e.mark_kind = Some(mark_kind);
                    e.name = Some(if mark_kind == "dir" { d.kind.clone() } else { d.text.clone().unwrap_or_else(|| d.kind.clone()) });
                    e.dir = Some(DirAt { pi, mi, index });
                    if after.is_none() {
                        e.dir_end = Some(true);
                    }
                    out.push(e);
                }
                // 小节边界就是这一小节的 `</measure>`
                let bx = cx.span_of(cx.sur(m.oid, Slot::Default), "measure");
                if let (Some(bx), Some(last)) = (bx, last_id) {
                    let mut e = SyncEntry::new("barline", Span { from: bx.to - "</measure>".len(), to: bx.to }, last as i64);
                    e.edge = Some("after");
                    out.push(e);
                }
                // 换行 / 换页记在下一小节的 `<print new-system|new-page>` 上，只按第一声部显示
                let next = part.measures.get(mi + 1);
                let pr = next.and_then(|n| n.print.as_ref());
                let page = pr.and_then(|p| p.new_page) == Some(true);
                let system = pr.and_then(|p| p.new_system) == Some(true);
                if pi == 0 && (page || system) {
                    if let Some(last) = last_id {
                        let nx = next.unwrap();
                        let pr_el = cx.element_children(cx.sur(nx.oid, Slot::Default)).into_iter().find(|&c| cx.t.tag(c) == "print");
                        let ps = cx.span_of(pr_el, "print");
                        let span = ps.map(|ps| Span { from: ps.from, to: index_of(&cx.text, &[b'>' as u16], ps.from).map_or(0, |i| i + 1) });
                        breaks.push(BreakAt { page, after: last, span });
                        if let Some(span) = span {
                            let mut e = SyncEntry::new("break", span, last as i64);
                            e.page = Some(page);
                            out.push(e);
                        }
                    }
                }
            }
        }
        for mk in &song.marks {
            let tag = match mk.kind {
                MarkType::Slur => "slur",
                MarkType::Tied => "tied",
                _ => continue,
            };
            let open = cx.span_of(cx.sur(mk.oid, Slot::Start), tag);
            let close = cx.span_of(cx.sur(mk.oid, Slot::Stop), tag);
            let Some(open) = open else { continue };
            let base = |sp: Span, pair: Option<Span>| {
                let mut e = SyncEntry::new("mark", sp, mk.start as i64);
                e.end = Some(mk.end);
                e.mark_kind = Some(tag);
                e.name = Some(tag.to_owned());
                e.pair = pair;
                e
            };
            out.push(base(open, close));
            if let Some(close) = close {
                out.push(base(close, Some(open)));
            }
        }
    }
    // 页眉：`<work-title>` / `<movement-title>` 与各条 `<credit-words>` 里的字
    for tag in ["work-title", "movement-title", "credit-words"] {
        let t = utf16(tag);
        let open: Vec<u16> = std::iter::once(b'<' as u16).chain(t.iter().copied()).collect();
        let mut i = 0;
        while let Some(at) = index_of(&cx.text, &open, i) {
            match match_tag(&cx.text, at, cx.text.len(), &t, true) {
                Some((end, b0, b1)) => {
                    let body = String::from_utf16_lossy(&cx.text[b0..b1]);
                    if !dolce_base::js::trim(&body).is_empty() {
                        out.push(SyncEntry::new("header", Span { from: b0, to: b1 }, -1));
                    }
                    i = end;
                }
                None => i = at + 1,
            }
        }
    }
    // 不排序：调用方按推入次序建「音符 → 条目」表（同 id 后来的盖前面的），再按偏移排
    Some(XmlSync { entries: out, breaks })
}
