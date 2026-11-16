//! 简繁转换（同 `src/model/hanconv.ts`）：**以 ScoreDoc 为准**决定哪些是人读的文字、按什么上下文送词表，五种源格式通用。
//!
//! - 文字槽按「一起送词表的上下文」分组：头部每个字段一组；歌词同一声部、同一段号（+ 行号）的音节**整首**按元素顺序连成一组，
//!   词组跨音节、跨行都能按词转。
//! - MusicXML 没有代码区：改模型后整份重写（`convert_score_doc`）。
//! - 文本格式**只改原文里文字所在的位置**（`convert_source_text`）：有源区间的按区间，没有的按原字符串在原文里认领；
//!   改完重新解析，逐片与期望对照，对不上的那处撤回。
//!
//! 词表引擎由调用方给（`HanConv`）：网页版是 TS 那边的词表，桌面 / 命令行用 Rust 的实现。
//! 区间、长度一律按 UTF-16（同源区间口径）。

use crate::doc::*;
use crate::metakeys::meta_key_def;
use dolce_base::{js, Msg, SourceSpan};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 一个方向的简繁词表：整串进、整串出。
pub trait HanConv {
    fn conv(&self, s: &str) -> String;
}

impl<F: Fn(&str) -> String> HanConv for F {
    fn conv(&self, s: &str) -> String {
        self(s)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HanDirection {
    S2t,
    T2s,
}

// ───────────────────────── 文字槽 ─────────────────────────

/// 文字槽归哪一组：自成一组，或某段歌词（同声部同段号同行号，整首连成一组）。
enum Group {
    Own,
    Verse(String),
}

/// 按固定次序走遍所有文字槽（与 TS `textGroups` 同序）；空串、没有的不算。
trait Visit {
    fn piece(&mut self, g: Group, s: &mut String, source: Option<SourceSpan>);
    /// 一个声部走完：这一声部的歌词各组排在它的其他组之后
    fn end_part(&mut self);
    /// 碰到某段的一个字（哪怕三片都空）：TS 这时就建了组，组的先后按第一次碰到
    fn touch_verse(&mut self, _key: &str) {}
}

fn opt(v: &mut dyn Visit, s: &mut Option<String>, source: Option<SourceSpan>) {
    if let Some(s) = s.as_mut().filter(|s| !s.is_empty()) {
        v.piece(Group::Own, s, source);
    }
}

fn own(v: &mut dyn Visit, s: &mut String, source: Option<SourceSpan>) {
    if !s.is_empty() {
        v.piece(Group::Own, s, source);
    }
}

fn arr(v: &mut dyn Visit, a: &mut [String], sources: Option<&[SourceSpan]>) {
    for (i, s) in a.iter_mut().enumerate() {
        own(v, s, sources.and_then(|x| x.get(i)).copied());
    }
}

fn lyric(v: &mut dyn Visit, l: &mut Lyric) {
    let key = format!("{}|{}", js::num_to_string(l.number), js::num_to_string(l.line_index.unwrap_or(0.0)));
    let src = l.source;
    v.touch_verse(&key);
    if let Some(s) = l.leading_punctuation.as_mut().filter(|s| !s.is_empty()) {
        v.piece(Group::Verse(key.clone()), s, None);
    }
    if !l.text.is_empty() {
        v.piece(Group::Verse(key.clone()), &mut l.text, src);
    }
    if let Some(s) = l.trailing_punctuation.as_mut().filter(|s| !s.is_empty()) {
        v.piece(Group::Verse(key.clone()), s, None);
    }
    opt(v, &mut l.verse_label, None);
}

fn annotation(a: &Option<Vec<AttachedSource>>) -> Option<SourceSpan> {
    a.iter().flatten().find(|x| x.kind == AttachedKind::Annotation).map(|x| x.source)
}

fn layers(v: &mut dyn Visit, items: &mut Option<Vec<InlineItem>>) {
    for it in items.iter_mut().flatten() {
        if let InlineItem::Layer { measures, .. } = it {
            walk_measures(v, measures);
        }
    }
}

/// 按元素顺序走小节（含文本谱临时伴奏 / 多声部层里的小节）。
fn walk_measures(v: &mut dyn Visit, measures: &mut [Measure]) {
    for m in measures {
        if let Some(pr) = &mut m.print {
            opt(v, &mut pr.caption, None);
            if let Some(texts) = &mut pr.texts {
                arr(v, texts, pr.text_sources.as_deref());
            }
            for ll in pr.lyric_lines.iter_mut().flatten() {
                opt(v, &mut ll.annotation, ll.source);
            }
        }
        for d in m.directions.iter_mut().flatten() {
            let src = d.source;
            opt(v, &mut d.text, src);
            for mo in d.more.iter_mut().flatten() {
                opt(v, &mut mo.text, src);
            }
        }
        for el in &mut m.elements {
            match el {
                Element::Chord(c) => {
                    let annot = annotation(&c.attached_sources);
                    opt(v, &mut c.section_word, annot);
                    for l in c.lyrics.iter_mut().flatten() {
                        lyric(v, l);
                    }
                    for s in c.sustains.iter_mut().flatten() {
                        let sa = annotation(&s.attached_sources);
                        opt(v, &mut s.section_word, sa);
                        for l in s.lyrics.iter_mut().flatten() {
                            lyric(v, l);
                        }
                    }
                }
                Element::Space(s) => {
                    for l in s.lyrics.iter_mut().flatten() {
                        lyric(v, l);
                    }
                }
            }
        }
        for el in &mut m.elements {
            if let Element::Chord(c) = el {
                layers(v, &mut c.before);
                for s in c.sustains.iter_mut().flatten() {
                    layers(v, &mut s.before);
                }
            }
        }
        layers(v, &mut m.trailing);
    }
}

/// 走遍所有人读的文字。和弦、调号拍号、小节号、字体名、纸张等代码类字段不碰。
fn walk(doc: &mut ScoreDoc, v: &mut dyn Visit) {
    for song in &mut doc.songs {
        let w = &mut song.work;
        opt(v, &mut w.title, None);
        opt(v, &mut w.movement_title, None);
        arr(v, &mut w.subtitles, None);
        if let Some(id) = &mut song.identification {
            for c in &mut id.creators {
                own(v, &mut c.text, None);
            }
            opt(v, &mut id.rights, None);
        }
        for c in song.credits.iter_mut().flatten() {
            own(v, &mut c.text, None);
            if let Some(words) = &mut c.words {
                arr(v, words, None);
            }
        }
        for t in song.tempos.iter_mut().flatten() {
            if let Tempo::Text(s) = t {
                own(v, s, None);
            }
        }
        opt(v, &mut song.time_note, None);
        if let Some(r) = &mut song.remarks {
            arr(v, r, None);
        }
        if let Some(pt) = &mut song.page_text {
            opt(v, &mut pt.index_left, None);
            opt(v, &mut pt.index_right, None);
            for a in [&mut pt.top_left, &mut pt.top_right, &mut pt.bottom_left, &mut pt.bottom_center, &mut pt.bottom_right] {
                arr(v, a, None);
            }
        }
        // 只转有排版角色的键（经文、标签、分类…）；字体族、纸张、开关等值是代码，转了会认不出
        for (key, vals) in song.meta.iter_mut().flatten() {
            if meta_key_def(key).is_some_and(|d| d.role.is_some()) {
                arr(v, vals, None);
            }
        }
        for g in song.part_groups.iter_mut().flatten() {
            opt(v, &mut g.name, None);
            opt(v, &mut g.abbrev, None);
        }
        for part in &mut song.parts {
            opt(v, &mut part.name, None);
            opt(v, &mut part.abbrev, None);
            walk_measures(v, &mut part.measures);
            v.end_part();
        }
    }
}

/// 一片文字（读出来的）：文字与它在原文里的区间。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TextPiece {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceSpan>,
}

/// 收集：各片按走的次序编号，组按 TS 的次序排。
#[derive(Default)]
struct Collect {
    pieces: Vec<TextPiece>,
    groups: Vec<Vec<usize>>,
    verses: IndexMap<String, Vec<usize>>,
}

impl Visit for Collect {
    fn piece(&mut self, g: Group, s: &mut String, source: Option<SourceSpan>) {
        let i = self.pieces.len();
        self.pieces.push(TextPiece { text: s.clone(), source });
        match g {
            Group::Own => self.groups.push(vec![i]),
            Group::Verse(k) => self.verses.entry(k).or_default().push(i),
        }
    }
    fn end_part(&mut self) {
        for (_, g) in self.verses.drain(..) {
            self.groups.push(g);
        }
    }
    fn touch_verse(&mut self, key: &str) {
        if !self.verses.contains_key(key) {
            self.verses.insert(key.to_owned(), vec![]);
        }
    }
}

/// 按走的次序给各片写新文字。
struct Assign<'a> {
    next: usize,
    to: &'a [Option<String>],
}

impl Visit for Assign<'_> {
    fn piece(&mut self, _g: Group, s: &mut String, _source: Option<SourceSpan>) {
        if let Some(Some(t)) = self.to.get(self.next) {
            *s = t.clone();
        }
        self.next += 1;
    }
    fn end_part(&mut self) {}
}

fn collect(doc: &ScoreDoc) -> Collect {
    // 走的时候要可变借用；读文字用一份副本
    let mut d = doc.clone();
    let mut c = Collect::default();
    walk(&mut d, &mut c);
    c
}

/// 所有人读的文字，按「一起送词表」分组（同 TS `textGroups`）。
pub fn text_groups(doc: &ScoreDoc) -> Vec<Vec<TextPiece>> {
    let c = collect(doc);
    c.groups.iter().map(|g| g.iter().map(|&i| c.pieces[i].clone()).collect()).collect()
}

fn u16s(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// 一组整串转换，按片切回。整串长度变了就逐片转，再不行逐字；仍对不齐的片不动。
fn convert_group(src: &[&str], conv: &dyn HanConv) -> Vec<String> {
    let joined: String = src.concat();
    let all = conv.conv(&joined);
    if utf16_len(&all) == utf16_len(&joined) {
        let all16 = u16s(&all);
        let mut at = 0;
        return src
            .iter()
            .map(|t| {
                let n = utf16_len(t);
                let s = String::from_utf16_lossy(&all16[at..at + n]);
                at += n;
                s
            })
            .collect();
    }
    src.iter()
        .map(|t| {
            let o = conv.conv(t);
            if utf16_len(&o) == utf16_len(t) {
                return o;
            }
            let c: String = t.chars().map(|ch| conv.conv(ch.encode_utf8(&mut [0; 4]))).collect();
            if utf16_len(&c) == utf16_len(t) {
                c
            } else {
                (*t).to_owned()
            }
        })
        .collect()
}

/// 按组转换，返回各片（按走的次序编号）的新文字，以及组序摊平的片号。
fn convert_all(c: &Collect, conv: &dyn HanConv) -> (Vec<String>, Vec<usize>) {
    let mut out = vec![String::new(); c.pieces.len()];
    let mut flat = vec![];
    for g in &c.groups {
        let src: Vec<&str> = g.iter().map(|&i| c.pieces[i].text.as_str()).collect();
        for (k, s) in convert_group(&src, conv).into_iter().enumerate() {
            out[g[k]] = s;
        }
        flat.extend(g.iter().copied());
    }
    (out, flat)
}

/// 所有文字拼起来过一遍繁→简词表：被改动说明含繁体字形 → 转简；否则（纯简体或无中文）→ 转繁。
pub fn detect_han_direction(doc: &ScoreDoc, t2s: &dyn HanConv) -> HanDirection {
    let text: Vec<String> = text_groups(doc).into_iter().flatten().map(|p| p.text).collect();
    let text = text.join("\n");
    if t2s.conv(&text) == text {
        HanDirection::S2t
    } else {
        HanDirection::T2s
    }
}

/// 就地转换模型里的文字（没有代码区的 MusicXML 用，转完整份重写）。返回改动的片数。
pub fn convert_score_doc(doc: &mut ScoreDoc, conv: &dyn HanConv) -> usize {
    let c = collect(doc);
    let (outs, _) = convert_all(&c, conv);
    let mut n = 0;
    let to: Vec<Option<String>> = outs
        .into_iter()
        .zip(&c.pieces)
        .map(|(o, p)| {
            if o != p.text {
                n += 1;
                Some(o)
            } else {
                None
            }
        })
        .collect();
    walk(doc, &mut Assign { next: 0, to: &to });
    n
}

// ───────────────────────── 文本格式写回原文 ─────────────────────────

#[derive(Clone, Debug)]
struct Edit {
    from: usize,
    to: usize,
    text: Vec<u16>,
}

fn apply_edits(text: &[u16], edits: &[Edit]) -> Vec<u16> {
    let mut sorted: Vec<&Edit> = edits.iter().collect();
    // 稳定排序，从后往前改
    sorted.sort_by_key(|e| std::cmp::Reverse(e.from));
    let mut out = text.to_vec();
    for e in sorted {
        out.splice(e.from..e.to, e.text.iter().copied());
    }
    out
}

/// `indexOf(needle, from)`（UTF-16）
fn index_of(hay: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(from.min(hay.len()));
    }
    if from >= hay.len() || needle.len() > hay.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&k| &hay[k..k + needle.len()] == needle)
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SourceConvResult {
    pub text: String,
    /// 改动了的片数
    pub changed: usize,
    /// 该转却没能写回原文的片数（找不到位置、或写回后重解析对不上而撤回）
    pub missed: usize,
}

/// 文本格式的整篇转换：只改原文里文字所在的位置。`parse` 是这个格式的读入（读不出回 Err）。
///
/// 1. 解析 → 按组转换，得到每片的期望文字。
/// 2. 有源区间的片：在区间里找原文字替换（可信）。所有带区间的片先把位置占住，免得下一步搜到歌词里去。
/// 3. 没有源区间的片：在原文里找第一处没被占的原字符串替换。
/// 4. 重新解析，逐片与期望对照。全对就完事；否则只留可信的编辑，再把搜来的编辑逐批试加，结构不变且对上的片变多才留。
pub fn convert_source_text(text: &str, parse: &dyn Fn(&str) -> Result<ScoreDoc, Msg>, conv: &dyn HanConv) -> Result<SourceConvResult, Msg> {
    let t16 = u16s(text);
    let c = collect(&parse(text)?);
    let (outs, order) = convert_all(&c, conv);
    let flat: Vec<&TextPiece> = order.iter().map(|&i| &c.pieces[i]).collect();
    let ptext: Vec<Vec<u16>> = flat.iter().map(|p| u16s(&p.text)).collect();
    let expected: Vec<Vec<u16>> = order.iter().map(|&i| u16s(&outs[i])).collect();

    let mut claimed: Vec<(usize, usize)> = vec![];
    let free = |claimed: &[(usize, usize)], a: usize, b: usize| claimed.iter().all(|&(x, y)| b <= x || a >= y);
    // 同一处原文可以对应几片（`.jpwabc` 的 `W1-6:` 按段复制成几份歌词，源区间相同）：认作同一处，只改一次
    let mut span_at: HashMap<(usize, Vec<u16>), usize> = HashMap::new();
    let mut at: Vec<Option<usize>> = vec![];
    for (i, p) in flat.iter().enumerate() {
        let Some(s) = p.source else {
            at.push(None);
            continue;
        };
        let lo = (s.offset as usize).min(t16.len());
        let hi = (s.offset as usize + s.length as usize).min(t16.len()).max(lo);
        let Some(k) = index_of(&t16[lo..hi], &ptext[i], 0) else {
            at.push(None);
            continue;
        };
        let from = lo + k;
        let key = (from, ptext[i].clone());
        if span_at.contains_key(&key) {
            at.push(Some(from));
            continue;
        }
        if !free(&claimed, from, from + ptext[i].len()) {
            at.push(None);
            continue;
        }
        claimed.push((from, from + ptext[i].len()));
        span_at.insert(key, from);
        at.push(Some(from));
    }

    let mut trusted: Vec<Edit> = vec![];
    // 搜来的编辑，一片一批（逐段搜的几段要一起留或一起撤）
    let mut searched: Vec<Vec<Edit>> = vec![];
    let mut changed = 0;
    for i in 0..flat.len() {
        let want = &expected[i];
        if *want == ptext[i] {
            continue;
        }
        changed += 1;
        if let Some(from) = at[i] {
            if !trusted.iter().any(|e| e.from == from) {
                trusted.push(Edit { from, to: from + ptext[i].len(), text: want.clone() });
            }
            continue;
        }
        let mut batch: Vec<Edit> = vec![];
        // 在 `start` 之后找第一处没被占的 `orig` 记一条编辑，返回其终点；都被占了时，已有一条同文同改的编辑就算它
        let search = |orig: &[u16], want: &[u16], start: usize, claimed: &mut Vec<(usize, usize)>, batch: &mut Vec<Edit>| -> Option<usize> {
            let mut k = index_of(&t16, orig, start);
            while let Some(x) = k {
                if free(claimed, x, x + orig.len()) {
                    claimed.push((x, x + orig.len()));
                    batch.push(Edit { from: x, to: x + orig.len(), text: want.to_vec() });
                    return Some(x + orig.len());
                }
                k = index_of(&t16, orig, x + 1);
            }
            searched
                .iter()
                .flatten()
                .chain(batch.iter())
                .find(|e| e.from >= start && e.text == want && t16[e.from..e.to] == *orig)
                .map(|e| e.to)
        };
        if search(&ptext[i], want, 0, &mut claimed, &mut batch).is_none() {
            // 整串搜不到（原文有转义）就按非 ASCII 连续段依次搜；转换逐字等长，段在新文字里的位置不变
            let t = &ptext[i];
            let mut pos = 0;
            let mut a = 0;
            while a < t.len() {
                if t[a] <= 0x7f {
                    a += 1;
                    continue;
                }
                let mut b = a;
                while b < t.len() && t[b] > 0x7f {
                    b += 1;
                }
                if want.get(a..b) != Some(&t[a..b]) {
                    let w = want.get(a..b).map(|x| x.to_vec()).unwrap_or_default();
                    if let Some(end) = search(&t[a..b], &w, pos, &mut claimed, &mut batch) {
                        pos = end;
                    }
                }
                a = b;
            }
        }
        if !batch.is_empty() {
            searched.push(batch);
        }
    }
    if changed == 0 {
        return Ok(SourceConvResult { text: text.to_owned(), changed: 0, missed: 0 });
    }

    // 对不上的片数；结构变了（片数不同或解析失败）为 None
    let mismatches = |cand: &[u16]| -> Option<usize> {
        let doc = parse(&String::from_utf16_lossy(cand)).ok()?;
        let got = text_groups(&doc).into_iter().flatten().map(|p| u16s(&p.text)).collect::<Vec<_>>();
        if got.len() != expected.len() {
            return None;
        }
        Some(got.iter().zip(&expected).filter(|(g, e)| g != e).count())
    };

    let all: Vec<Edit> = trusted.iter().cloned().chain(searched.iter().flatten().cloned()).collect();
    let full = apply_edits(&t16, &all);
    if mismatches(&full) == Some(0) {
        return Ok(SourceConvResult { text: String::from_utf16_lossy(&full), changed, missed: 0 });
    }
    let mut keep = trusted.clone();
    let mut best = match mismatches(&apply_edits(&t16, &keep)) {
        Some(n) => n,
        None => {
            keep.clear();
            changed
        }
    };
    for b in &searched {
        let cand: Vec<Edit> = keep.iter().cloned().chain(b.iter().cloned()).collect();
        if let Some(n) = mismatches(&apply_edits(&t16, &cand)) {
            if n < best {
                keep = cand;
                best = n;
            }
        }
    }
    Ok(SourceConvResult { text: String::from_utf16_lossy(&apply_edits(&t16, &keep)), changed, missed: best })
}
