//! 重排（按乐句 / 每行 n 小节）一份 `.jpwabc` 原文：**只挪 `.Voice` 里的 `$`**，别的字符一个不动（TS `jianpu/docrelayout.ts::relayoutJpwabcText` 照搬）。
//!
//! `.jpwabc` 是分节文件，整份重出会把写出端装不下的东西（样式、分页描述）一并抹掉；歌词在 `.Words` 里按小节 / 音符号锚定、
//! 与行结构无关，所以只重切 `.Voice` 的行就够。`.Layout` 里按行号记的 `BreakPoints` 跟着行结构作废（换页改由 `$(true,0,0,true)` 原位表达）。
//! 断点（`crate::view::phraselines::PhraseCut`）由门面按计划算好传进来，这里按它的原文区间下刀；列按 UTF-16 码元。

use std::collections::{BTreeMap, HashSet};

use crate::view::phraselines::PhraseCut;

use super::file::{JpwFile, SectionKind};
use crate::formats::abc::u16s::{self, U16};

const BREAK_LINE: &str = "$(true)";
const BREAK_PAGE: &str = "$(true,0,0,true)";

/// `/\$(\([^)]*\))?/g` 的各处匹配：(起点, 终点)
fn break_marks(s: &U16) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < s.len() {
        if s[i] != b'$' as u16 {
            i += 1;
            continue;
        }
        let mut end = i + 1;
        if u16s::is(s, end, '(') {
            if let Some(close) = u16s::find(s, ')', end + 1) {
                end = close + 1;
            }
        }
        out.push((i, end));
        i = end;
    }
    out
}

/// 去掉一段 `.Voice` 原文里的换行标记，并把空白收成单个空格、首尾收干净
fn strip_breaks(s: &U16) -> Vec<u16> {
    let mut t: Vec<u16> = Vec::with_capacity(s.len());
    let mut at = 0;
    for (a, b) in break_marks(s) {
        t.extend_from_slice(&s[at..a]);
        t.push(b' ' as u16);
        at = b;
    }
    t.extend_from_slice(&s[at..]);
    let mut out: Vec<u16> = Vec::with_capacity(t.len());
    let mut space = false;
    for &u in &t {
        if u16s::space(u) {
            space = true;
            continue;
        }
        if space && !out.is_empty() {
            out.push(b' ' as u16);
        }
        space = false;
        out.push(u);
    }
    out
}

/// `/^\s*breakpoints\s*=/i`
fn is_break_points(l: &U16) -> bool {
    let k = u16s::spaces(l, 0);
    let word = "breakpoints";
    if l.len() < k + word.len() {
        return false;
    }
    let got = u16s::text(&l[k..k + word.len()]);
    if !got.eq_ignore_ascii_case(word) {
        return false;
    }
    let e = k + word.len();
    u16s::is(l, e + u16s::spaces(l, e), '=')
}

/// 按断点重切 `.Voice` 的行；没有可落的断点、读不出 `.Voice` 时原样返回
pub fn relayout_jpwabc_text(text: &str, cuts: &[PhraseCut]) -> String {
    if cuts.is_empty() {
        return text.to_string();
    }
    let Some(file) = JpwFile::from_str(text) else { return text.to_string() };
    let Some(voice) = file.voice() else { return text.to_string() };
    if voice.lines.is_empty() {
        return text.to_string();
    }
    // 落点按原文位置排好：`.Voice` 里一个位置只会断一次
    let mut at: BTreeMap<u32, Vec<&PhraseCut>> = BTreeMap::new();
    for cut in cuts {
        if let Some(src) = &cut.source {
            at.entry(src.line).or_default().push(cut);
        }
    }
    if at.is_empty() {
        return text.to_string();
    }
    // 末行原来那个标记照旧（JP-Word 写的是 `$(true,0,0,true)`，别的来源可能只有 `$(true)`）
    let last_raw = voice.lines.last().unwrap();
    let last_mark: Vec<u16> = break_marks(last_raw).last().map_or_else(|| u16s::enc(BREAK_PAGE), |&(a, b)| last_raw[a..b].to_vec());

    let mut out: Vec<Vec<u16>> = Vec::new();
    let mut buf: Vec<u16> = Vec::new();
    let push = |buf: &mut Vec<u16>, piece: &U16| {
        let s = strip_breaks(piece);
        if s.is_empty() {
            return;
        }
        if !buf.is_empty() {
            buf.push(b' ' as u16);
        }
        buf.extend(s);
    };
    let flush = |buf: &mut Vec<u16>, out: &mut Vec<Vec<u16>>, mark: &U16| {
        if buf.is_empty() {
            return;
        }
        let mut l = std::mem::take(buf);
        l.extend_from_slice(mark);
        out.push(l);
    };
    for (i, raw) in voice.lines.iter().enumerate() {
        let mut here: Vec<&PhraseCut> = at.get(&voice.line_nos[i]).cloned().unwrap_or_default();
        here.sort_by_key(|c| c.source.unwrap().column);
        let mut from = 0usize;
        for cut in here {
            let col = cut.source.unwrap().column as usize;
            // 落点在行首（断点与原来的行结构重合）：此前攒下的就是上一行，直接收
            if col < from {
                continue;
            }
            push(&mut buf, &raw[from.min(raw.len())..col.clamp(from, raw.len().max(from)).min(raw.len())]);
            flush(&mut buf, &mut out, &u16s::enc(if cut.page { BREAK_PAGE } else { BREAK_LINE }));
            from = col;
        }
        push(&mut buf, &raw[from.min(raw.len())..]);
    }
    flush(&mut buf, &mut out, &last_mark);
    if out.is_empty() {
        return text.to_string();
    }

    // 写回原文：`.Voice` 那几行换成新的，其余行原样；按行号记的分页描述跟着作废
    let t = u16s::enc(text);
    let raws: Vec<&U16> = t.split(|&u| u == b'\n' as u16).collect();
    let crlf = text.contains("\r\n");
    let first = voice.line_nos[0] as usize;
    let mut drop: HashSet<usize> = voice.line_nos.iter().map(|&n| n as usize).collect();
    let layout = file.sections.iter().find(|s| matches!(s.kind, SectionKind::Layout { .. }));
    if let Some(l) = layout {
        if matches!(&l.kind, SectionKind::Layout { break_points: Some(_), .. }) {
            for (i, &no) in l.line_nos.iter().enumerate() {
                if is_break_points(&l.lines[i]) {
                    drop.insert(no as usize);
                }
            }
        }
    }
    let mut merged: Vec<Vec<u16>> = Vec::new();
    for (no, raw) in raws.iter().enumerate() {
        if no == first {
            for l in &out {
                let mut l = l.clone();
                if crlf {
                    l.push(b'\r' as u16);
                }
                merged.push(l);
            }
        }
        if !drop.contains(&no) {
            merged.push(raw.to_vec());
        }
    }
    String::from_utf16_lossy(&merged.join(&(b'\n' as u16)))
}
