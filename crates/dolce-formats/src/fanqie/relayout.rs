//! 「按乐句重排」写回文本谱原文（TS `fanqie/relayout.ts` 照搬）。
//!
//! **只做原文片段的搬运**：新的每一行都是原文里那几段字符接起来的，不重新生成任何记号——和弦、`&记号`、注释、
//! 并字号、跳词符都跟着原文走。切点落在**元素之间的间隙**里：收口的（`)` `]` `"注释"`）留给上一行，起头的（`(` `[`）归下一行，
//! 跨行的弧线与跳房子因此由读入端自己接上；渐强渐弱要在同一行收口，切在中间就上一行补 `!`、下一行重开。
//!
//! 新行怎么分由 `dolce_view::phraselines` 给（按乐句 / 每行 n 小节要量行长，由门面逐首算好传进来；增删一刀在这里直接算）。
//! 原文、源码列一律按 UTF-16 码元（同 TS 的 `slice`）。

use std::collections::{HashMap, HashSet};

use dolce_base::js;
use dolce_model::ScoreDoc;
use dolce_view::ast::{BarlineType, LyricLine, MarkType, MusicElement, ScoreLine};
use dolce_view::phraselines::{lines_edited, voice_stream, NewLine, RowKey, VoiceStream};
use dolce_view::phrasesong::{view_song, voice_numbers};
use dolce_view::slots::{doc_view, DocView, RowView, SongView};

use super::dialect::Dialect;
use super::parse::body_prefix;
use crate::abc::u16s::{self, U16};

/// 行首的 `Q1:` / `C1-2:` / `W:` 标签（不含声部名与段号说明）
fn label_of(raw: &U16) -> Vec<u16> {
    let Some(m) = body_prefix(raw) else { return vec![] };
    let range = m.range_end.map(|r| format!("-{r}")).unwrap_or_default();
    u16s::enc(&format!("{}{}{}{}{}:", m.kind, m.variant_before, m.number, range, m.variant_after))
}

/// `Q1: ` / `C1: <1.>` 这段前缀的长度（内容从这里开始）
fn prefix_len(raw: &U16) -> usize {
    body_prefix(raw).map_or(0, |m| m.len)
}

/// JS `s.slice(a, b)`（下标已非负；越界截到尾，`a ≥ b` 回空）
fn slice(s: &U16, a: usize, b: usize) -> &U16 {
    let b = b.min(s.len());
    if a >= b {
        &[]
    } else {
        &s[a..b]
    }
}

fn trim_end(s: &U16) -> &U16 {
    let mut b = s.len();
    while b > 0 && u16s::space(s[b - 1]) {
        b -= 1;
    }
    &s[..b]
}

/// 在第 k 个元素**之前**下刀，刀落在原文的哪一列（收口的留在上一行，`(` `[` 归下一行）
fn cut_column(line: &ScoreLine, raw: &U16, k: usize) -> usize {
    if k == 0 {
        return prefix_len(raw);
    }
    let prev = line.elements[k - 1].source();
    let prev_end = (prev.column + prev.length) as usize;
    if k >= line.elements.len() {
        return raw.len();
    }
    let next = line.elements[k].source().column as usize;
    (prev_end..next).find(|&i| u16s::is(raw, i, '(') || u16s::is(raw, i, '[')).unwrap_or(next)
}

fn takes_lyric(el: &MusicElement) -> bool {
    match el {
        MusicElement::Note(n) => n.lyric_anchor,
        MusicElement::Sustain(s) => s.lyric_anchor,
        _ => false,
    }
}

/// 该行 [from, to) 里有几个跟词的元素（== 歌词音节要跳过几个）
fn lyric_count(line: &ScoreLine, from: usize, to: usize) -> usize {
    line.elements[from..to].iter().filter(|e| takes_lyric(e)).count()
}

/// 一条曲行的片段（同一新行可能横跨几条源行）
struct Piece<'a> {
    row: &'a RowView,
    raw: Vec<u16>,
    from: usize,
    to: usize,
}

/// 一个片段的正文，并把跨行断开的渐强渐弱接上（上一行开的这里重开，还没收口的本行先收）
fn piece_text(p: &Piece) -> Vec<u16> {
    let line = &p.row.line;
    let begin = cut_column(line, &p.raw, p.from);
    let mut text = slice(&p.raw, begin, cut_column(line, &p.raw, p.to)).to_vec();
    let mut head = String::new();
    let mut tail = "";
    for mk in &line.marks {
        if mk.kind != MarkType::Crescendo && mk.kind != MarkType::Decrescendo {
            continue;
        }
        let sign = format!("{}{}", if mk.kind == MarkType::Crescendo { "<" } else { ">" }, "+".repeat(mk.level.max(0.0) as usize));
        let (from, to) = (p.from as i64, p.to as i64);
        if mk.start < from && mk.end >= from {
            head = sign; // 上一行开的，这里重开
        }
        if mk.start < to && mk.end > to - 1 {
            tail = "!"; // 还没收口，本行先收
        }
    }
    if !head.is_empty() {
        // `<` 是跟在音符后面写的（起点就是那个音符），所以补在本片段第一个元素之后
        let first = line.elements[p.from].source();
        let at = ((first.column + first.length) as usize).saturating_sub(begin).min(text.len());
        let mut t = text[..at].to_vec();
        t.extend(u16s::enc(&head));
        t.extend_from_slice(&text[at..]);
        text = t;
    }
    let mut t = trim_end(&text).to_vec();
    t.extend(u16s::enc(tail));
    u16s::trim(&t).to_vec()
}

fn plain_barline(el: Option<&MusicElement>) -> Option<&dolce_view::ast::BarlineElement> {
    match el {
        Some(MusicElement::Barline(b)) => Some(b),
        _ => None,
    }
}

/// 把若干片段拼成一行 `Q` 的正文
fn music_text(pieces: &[Piece]) -> Vec<u16> {
    let mut texts: Vec<Vec<u16>> = pieces.iter().map(piece_text).collect();
    for i in 1..pieces.len() {
        let first = plain_barline(pieces[i].row.line.elements.get(pieces[i].from));
        let prev = &pieces[i - 1];
        let last = plain_barline(prev.to.checked_sub(1).and_then(|k| prev.row.line.elements.get(k)));
        // 反复起点已表示这处边界，拼进同一行时不再保留前面的普通收线
        if let (Some(f), Some(l)) = (first, last) {
            if f.kind == BarlineType::RepeatStart
                && l.kind == BarlineType::Normal
                && l.repeat_forward_after != Some(true)
                && l.ornaments.is_empty()
                && l.annotation.is_none()
                && l.temporary_meter.is_none()
                && l.temporary_key.is_none()
            {
                // `/(?<![|:])\|\s*$/` → ""，再 trimEnd
                let t = &texts[i - 1];
                let end = trim_end(t).len();
                if end > 0 && t[end - 1] == b'|' as u16 && !(end >= 2 && (t[end - 2] == b'|' as u16 || t[end - 2] == b':' as u16)) {
                    let cut = trim_end(&t[..end - 1]).to_vec();
                    texts[i - 1] = cut;
                } else {
                    texts[i - 1] = trim_end(t).to_vec();
                }
            }
        }
    }
    let mut out: Vec<u16> = Vec::new();
    for (i, p) in pieces.iter().enumerate() {
        let mut text: &[u16] = &texts[i];
        let first = plain_barline(p.row.line.elements.get(p.from));
        let last = if i > 0 {
            let prev = &pieces[i - 1];
            plain_barline(prev.to.checked_sub(1).and_then(|k| prev.row.line.elements.get(k)))
        } else {
            None
        };
        // 拼接源行时，前一片段已收线，下一片段的普通前导线不能再造一个分隔（带反复、临时拍号或注记的线照留）
        if let (Some(_), Some(f)) = (last, first) {
            if f.kind == BarlineType::Normal && f.ornaments.is_empty() && f.annotation.is_none() && f.temporary_meter.is_none() && f.temporary_key.is_none() {
                // `/^\|(?![|:/*])\s*/` → ""
                if text.first() == Some(&(b'|' as u16)) && !u16s::one_of(text.get(1).copied(), "|:/*") {
                    let rest = &text[1..];
                    text = &rest[u16s::spaces(rest, 0)..];
                }
            }
        }
        if text.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(b' ' as u16);
        }
        out.extend_from_slice(text);
    }
    out
}

/// 一条歌词行在 [s0, s1) 这几个音节上的原文切片、实际给出的音节数与字数。`cols` 是原文全部音节的区间
fn lyric_slice(lyric: &LyricLine, cols: &[dolce_base::SourceSpan], raw: &U16, s0: usize, s1: usize) -> (Vec<u16>, usize, usize) {
    if s0 >= cols.len() {
        return (vec![], 0, 0);
    }
    let begin = cols[s0].column as usize;
    let stop = s1.min(cols.len());
    let end = if s1 >= cols.len() { raw.len() } else { cols[s1].column as usize };
    let words = (s0..stop).filter(|&i| lyric.syllables.get(i).is_some_and(|s| !s.text.is_empty())).count();
    (u16s::trim(slice(raw, begin, end)).to_vec(), stop - s0, words)
}

/// 一段歌词切片：段号相同的几段来自不同源行时按顺序接起来
struct LyricPiece<'a> {
    head: &'a LyricLine,
    head_raw: Vec<u16>,
    at_head: bool,
    texts: Vec<Vec<u16>>,
    filled: Vec<usize>,
    words: usize,
}

/// 这一新行上该跟哪几条歌词行（按「段号 + 同段号第几条」接片段，并补齐音节数）
fn lyric_lines(pieces: &[Piece], song: Option<&dolce_model::Song>, raws: &[Vec<u16>], skip: &str) -> Vec<Vec<u16>> {
    let mut order: Vec<String> = Vec::new();
    let mut by_key: HashMap<String, LyricPiece> = HashMap::new();
    let mut needs: Vec<usize> = Vec::new();
    for (pi, p) in pieces.iter().enumerate() {
        let line = &p.row.line;
        let before = lyric_count(line, 0, p.from);
        let inside = lyric_count(line, p.from, p.to);
        needs.push(inside);
        let mut seen: HashMap<String, usize> = HashMap::new();
        let infos = p
            .row
            .measures
            .first()
            .and_then(|&m| song?.parts.get(p.row.part)?.measures.get(m))
            .and_then(|m| m.print.as_ref())
            .and_then(|pr| pr.lyric_lines.as_ref());
        for (li, lyric) in line.lyrics.iter().enumerate() {
            let verse = format!("{}-{}", js::num_to_string(lyric.verse_from), js::num_to_string(lyric.verse_to));
            let dup = *seen.get(&verse).unwrap_or(&0);
            seen.insert(verse.clone(), dup + 1);
            let key = format!("{verse}#{dup}");
            let raw = raws.get(lyric.source.line as usize).cloned().unwrap_or_default();
            let own: Vec<dolce_base::SourceSpan>;
            let cols: &[dolce_base::SourceSpan] = match infos.and_then(|v| v.get(li)).and_then(|i| i.sources.as_ref()) {
                Some(s) => s,
                None => {
                    own = lyric.syllables.iter().map(|s| s.source).collect();
                    &own
                }
            };
            let (text, count, words) = lyric_slice(lyric, cols, &raw, before, before + inside);
            let cur = by_key.entry(key.clone()).or_insert_with(|| {
                order.push(key.clone());
                LyricPiece { head: lyric, head_raw: raw.clone(), at_head: before == 0, texts: vec![], filled: vec![], words: 0 }
            });
            while cur.texts.len() < pi {
                cur.texts.push(vec![]);
                cur.filled.push(0);
            }
            cur.texts.push(text);
            cur.filled.push(count);
            cur.words += words;
        }
        // 这一段缺的段号也要占住位置，后面的片段才不会顶上来
        for key in &order {
            let cur = by_key.get_mut(key).unwrap();
            while cur.texts.len() < pi + 1 {
                cur.texts.push(vec![]);
                cur.filled.push(0);
            }
        }
    }
    let skip16 = u16s::enc(skip);
    let mut out = Vec::new();
    for key in &order {
        let cur = &by_key[key];
        let label = label_of(&cur.head_raw);
        // 一个字都没有的段不占行（段号写死的才敢丢：裸 `C:` 按出现顺序编号，丢一条后面全串位）
        if cur.words == 0 && label.iter().any(|&u| u16s::digit(u)) {
            continue;
        }
        // 每一段都补到它该有的音节数（末段不补，行尾的跳词符没有意义）
        let tail = cur.texts.iter().rposition(|t| !t.is_empty());
        let mut parts: Vec<Vec<u16>> = Vec::new();
        if let Some(tail) = tail {
            for (i, t) in cur.texts.iter().enumerate().take(tail + 1) {
                let pad = needs.get(i).copied().unwrap_or(0).saturating_sub(cur.filled.get(i).copied().unwrap_or(0));
                let mut s = t.clone();
                if i < tail {
                    for _ in 0..pad {
                        s.extend_from_slice(&skip16);
                    }
                }
                parts.push(s);
            }
        }
        let parts: Vec<Vec<u16>> = parts.into_iter().filter(|t| !t.is_empty()).collect();
        let body = parts.join(&(b' ' as u16));
        if body.is_empty() {
            continue;
        }
        // 首段连 `<1.>` 这类说明文字一起带上，其后各行只留 `C1:`
        let mut line = if cur.at_head {
            let col = cur.head.syllables.first().map_or_else(|| prefix_len(&cur.head_raw), |s| s.source.column as usize);
            slice(&cur.head_raw, 0, col).to_vec()
        } else {
            let mut l = label;
            l.push(b' ' as u16);
            l
        };
        line.extend(body);
        out.push(trim_end(&line).to_vec());
    }
    out
}

/// 一首歌在原文里占的行区间（曲行 / 歌词行 / `W:` 行的最小外包）
fn song_region(song: &SongView) -> Option<(usize, usize)> {
    let mut from = usize::MAX;
    let mut to: Option<usize> = None;
    let mut take = |l: u32| {
        from = from.min(l as usize);
        to = Some(to.map_or(l as usize, |t: usize| t.max(l as usize)));
    };
    for pg in &song.pages {
        for g in &pg.groups {
            for t in &g.texts {
                take(t.source.line);
            }
            for v in &g.voices {
                take(v.line.source.line);
                for l in &v.line.lyrics {
                    take(l.source.line);
                }
            }
        }
    }
    to.map(|t| (from, t))
}

/// 生成新的曲行 / 歌词行文本
fn emit(song: &SongView, model: Option<&dolce_model::Song>, plan: &[NewLine], streams: &[VoiceStream], raws: &[Vec<u16>], skip: &str) -> Vec<Vec<u16>> {
    // `W:` 文字行跟着它那一组走：该组的第一条源行头一次出现在哪一新行，就印在那一行之前
    let mut texts_of_line: HashMap<RowKey, Vec<Vec<u16>>> = HashMap::new();
    for (pi, pg) in song.pages.iter().enumerate() {
        for (gi, g) in pg.groups.iter().enumerate() {
            if g.texts.is_empty() || g.voices.is_empty() {
                continue;
            }
            texts_of_line.insert(RowKey { page: pi, group: gi, row: 0 }, g.texts.iter().map(|t| raws.get(t.source.line as usize).cloned().unwrap_or_default()).collect());
        }
    }
    let mut text_done: HashSet<RowKey> = HashSet::new();
    let mut caption_done: Vec<f64> = Vec::new(); // 声部名只在该声部第一行印一次
    let mut out: Vec<Vec<u16>> = Vec::new();
    for (li, nl) in plan.iter().enumerate() {
        if li > 0 {
            out.push(vec![]);
        }
        let mut block: Vec<Vec<u16>> = Vec::new();
        for seg in &nl.segs {
            let Some(st) = streams.iter().find(|s| s.voice == seg.voice) else { continue };
            let mut pieces: Vec<(usize, usize, usize)> = Vec::new(); // (源行, from, to)
            for &(line_idx, el_idx) in &st.origin[seg.from..seg.to] {
                match pieces.last_mut() {
                    Some(last) if last.0 == line_idx => last.2 = el_idx + 1,
                    _ => pieces.push((line_idx, el_idx, el_idx + 1)),
                }
            }
            if pieces.is_empty() {
                continue;
            }
            for &(line_idx, _, _) in &pieces {
                let key = st.lines[line_idx].0;
                if let Some(t) = texts_of_line.get(&key) {
                    if text_done.insert(key) {
                        out.extend(t.iter().cloned());
                    }
                }
            }
            let pieces: Vec<Piece> = pieces.into_iter().map(|(li, from, to)| Piece { row: st.lines[li].1, raw: u16s::enc(&st.lines[li].1.line.raw), from, to }).collect();
            let head = &pieces[0].raw;
            // 首行保留原前缀（含声部名），其后各行只留 `Q1:`
            let mut line = if caption_done.contains(&seg.voice) { label_of(head) } else { slice(head, 0, prefix_len(head)).to_vec() };
            if !caption_done.contains(&seg.voice) {
                caption_done.push(seg.voice);
            }
            line.push(b' ' as u16);
            line.extend(music_text(&pieces));
            block.push(trim_end(&line).to_vec());
            block.extend(lyric_lines(&pieces, model, raws, skip));
        }
        out.extend(block);
        if nl.page_after {
            out.push(vec![]);
            out.push(u16s::enc("[fenye]"));
        }
    }
    out
}

/// `text.split(/\r?\n/)`
fn split_lines(text: &str) -> Vec<Vec<u16>> {
    let t = u16s::enc(text);
    let mut parts: Vec<Vec<u16>> = t.split(|&u| u == b'\n' as u16).map(|s| s.to_vec()).collect();
    let n = parts.len();
    for p in parts.iter_mut().take(n.saturating_sub(1)) {
        if p.last() == Some(&(b'\r' as u16)) {
            p.pop();
        }
    }
    parts
}

fn join_lines(lines: &[Vec<u16>]) -> String {
    String::from_utf16_lossy(&lines.join(&(b'\n' as u16)))
}

fn skip_of(doc: &ScoreDoc) -> String {
    let d = doc.fanqie_dialect.as_deref().and_then(Dialect::parse).unwrap_or(Dialect::Tomato);
    d.spec().lyric_skip.first().map_or_else(|| "@".to_string(), |c| c.to_string())
}

fn streams_of(song: &SongView) -> Vec<VoiceStream<'_>> {
    voice_numbers(song).into_iter().map(|v| voice_stream(song, v)).collect()
}

/// 重排一份文本谱原文：逐首按 `plans[i]`（`phraselines::plan_lines` 的结果，门面逐首算好）换掉曲行与歌词行所在的那一段，
/// 头部字段、`W:` 文字行、`-----` 原样保留（分组空行与 `[fenye]` 随行结构重来）。`doc` 必须是 `text` 解析出来的那一份
pub fn relayout_fanqie_text(text: &str, doc: &ScoreDoc, plans: &[Option<Vec<NewLine>>]) -> String {
    let raws = split_lines(text);
    let view = doc_view(doc, None);
    let skip = skip_of(doc);
    let mut patches: Vec<(usize, usize, Vec<Vec<u16>>)> = Vec::new();
    for (si, song) in view.songs.iter().enumerate() {
        let Some(Some(plan)) = plans.get(si) else { continue };
        let Some((from, to)) = song_region(song) else { continue };
        let streams = streams_of(song);
        let out = emit(song, view_song(doc, &view, si), plan, &streams, &raws, &skip);
        if !out.is_empty() {
            patches.push((from, to, out));
        }
    }
    if patches.is_empty() {
        return text.to_string();
    }
    patches.sort_by_key(|p| p.0);
    let mut merged: Vec<Vec<u16>> = Vec::new();
    let mut at = 0usize;
    for (from, to, lines) in patches {
        if at < from {
            merged.extend(raws[at..from.min(raws.len())].iter().cloned());
        }
        merged.extend(lines);
        at = to + 1;
    }
    if at < raws.len() {
        merged.extend(raws[at..].iter().cloned());
    }
    join_lines(&merged)
}

/// 可视化编辑增删一处换行：照现有行结构只在元素 `after_id` 之后加一刀、或去掉它后面那一刀，写回办法同乐句重排。
/// 只改 `after_id` 所在的那一首；这一刀加不上 / 去不掉时回 None
pub fn relayout_fanqie_break(text: &str, doc: &ScoreDoc, after_id: i64, add: bool, page: bool) -> Option<String> {
    let raws = split_lines(text);
    let view: DocView = doc_view(doc, None);
    let skip = skip_of(doc);
    for (si, song) in view.songs.iter().enumerate() {
        let Some(plan) = lines_edited(&view, si, after_id, add, page) else { continue };
        let (from, to) = song_region(song)?;
        let streams = streams_of(song);
        let out = emit(song, view_song(doc, &view, si), &plan, &streams, &raws, &skip);
        if out.is_empty() {
            return None;
        }
        let mut merged: Vec<Vec<u16>> = raws[..from.min(raws.len())].to_vec();
        merged.extend(out);
        if to + 1 < raws.len() {
            merged.extend(raws[to + 1..].iter().cloned());
        }
        return Some(join_lines(&merged));
    }
    None
}
