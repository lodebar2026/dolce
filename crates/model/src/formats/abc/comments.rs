//! 重排后把原文的注释缝回去（123 / ABC；TS `jianpu/docrelayout.ts::spliceComments` 照搬）。
//!
//! 注释不进模型，整份重出自然就丢了。每条注释跟着**它后面那条音乐行**走（注释说的是下面那段谱），
//! 落点用「第几个和弦」认——两份文本内容一样，序号对得上，行号对不上。文件开头那一批（任何正文之前）留在文件开头，
//! 全曲之后的追加在末尾。`%%` 指令不算注释（等价 `I:`，已经进了模型、写出端自己会写）。行、列按 UTF-16 码元。

use std::collections::HashMap;

use crate::{Element, ScoreDoc};

use super::u16s::{self, U16};

/// 引号外第一个 `%` 的下标（`"F#m"` 这类和弦里的不算）
fn comment_start(raw: &U16) -> Option<usize> {
    let mut quoted = false;
    for (i, &u) in raw.iter().enumerate() {
        if u == b'"' as u16 {
            quoted = !quoted;
        } else if u == b'%' as u16 && !quoted {
            return Some(i);
        }
    }
    None
}

/// 文件头的版本声明（`%123-` / `%abc-`）：写出端自己会写，不当注释收
fn is_version(t: &U16) -> bool {
    u16s::starts(t, 0, "%123-") || u16s::starts(t, 0, "%abc-")
}

/// 平行于「全曲第几个和弦」：它在原文的第几行（拿不到原文位置的记 None）
fn chord_lines(doc: &ScoreDoc) -> Vec<Option<u32>> {
    let mut out = Vec::new();
    for song in &doc.songs {
        for part in &song.parts {
            for m in &part.measures {
                for el in &m.elements {
                    if let Element::Chord(c) = el {
                        out.push(c.source.map(|s| s.line));
                    }
                }
            }
        }
    }
    out
}

struct Comment {
    text: Vec<u16>,
    /// 跟着第几个和弦走；None = 全曲之后
    at: Option<usize>,
    /// 在任何正文之前（文件头那一批）
    head: bool,
}

fn trim_end(s: &U16) -> &U16 {
    let mut b = s.len();
    while b > 0 && u16s::space(s[b - 1]) {
        b -= 1;
    }
    &s[..b]
}

/// 扫原文收注释，并把每条锚到「后面那条音乐行的第一个和弦」
fn collect_comments(text: &str, line_to_chord: &HashMap<u32, usize>) -> Vec<Comment> {
    let t = u16s::enc(text);
    let mut lines: Vec<&U16> = t.split(|&u| u == b'\n' as u16).collect();
    let n = lines.len();
    for l in lines.iter_mut().take(n.saturating_sub(1)) {
        if l.last() == Some(&(b'\r' as u16)) {
            *l = &l[..l.len() - 1];
        }
    }
    let mut out = Vec::new();
    let mut pending: Vec<(Vec<u16>, bool)> = Vec::new();
    let mut seen = false;
    for (ln, raw) in lines.iter().enumerate() {
        let trimmed = u16s::trim(raw);
        if trimmed.is_empty() {
            continue;
        }
        let cut = comment_start(raw);
        if u16s::is(trimmed, 0, '%') {
            if !u16s::starts(trimmed, 0, "%%") && !is_version(trimmed) {
                pending.push((trimmed.to_vec(), !seen));
            }
            continue;
        }
        let tail = cut.filter(|&c| c > 0).map(|c| trim_end(&raw[c..]).to_vec());
        match line_to_chord.get(&(ln as u32)) {
            Some(&at) => {
                for (text, head) in pending.drain(..) {
                    out.push(Comment { text, at: Some(at), head });
                }
                // 行尾注释：就近跟着本行（缝回去时成了这一行上方的独立注释行）
                if let Some(text) = tail {
                    out.push(Comment { text, at: Some(at), head: false });
                }
            }
            None => {
                // 字段行 / 歌词行行尾的，跟着下一条音乐行
                if let Some(text) = tail {
                    pending.push((text, !seen));
                }
            }
        }
        seen = true;
    }
    for (text, head) in pending {
        out.push(Comment { text, at: None, head });
    }
    out
}

/// 把原文里的注释缝进重排后的文本。`old_doc` 是 `old_text` 读出来的那一份（和弦的原文位置要在），`new_doc` 是 `new_text` 读出来的；
/// 两边和弦数对不上就原样返回 `new_text`
pub fn splice_comments(old_text: &str, old_doc: &ScoreDoc, new_text: &str, new_doc: &ScoreDoc) -> String {
    let old_lines = chord_lines(old_doc);
    let new_lines = chord_lines(new_doc);
    if old_lines.len() != new_lines.len() {
        return new_text.to_string();
    }
    let mut line_to_chord: HashMap<u32, usize> = HashMap::new();
    for (k, line) in old_lines.iter().enumerate() {
        if let Some(l) = line {
            line_to_chord.entry(*l).or_insert(k);
        }
    }
    let comments = collect_comments(old_text, &line_to_chord);
    if comments.is_empty() {
        return new_text.to_string();
    }
    let mut head: Vec<Vec<u16>> = Vec::new();
    let mut tail: Vec<Vec<u16>> = Vec::new();
    let mut before: HashMap<usize, Vec<Vec<u16>>> = HashMap::new();
    for c in comments {
        let line = c.at.and_then(|k| new_lines.get(k).copied().flatten());
        if c.head {
            head.push(c.text);
        } else if let Some(l) = line {
            before.entry(l as usize).or_default().push(c.text);
        } else {
            tail.push(c.text);
        }
    }
    let t = u16s::enc(new_text);
    let raws: Vec<&U16> = t.split(|&u| u == b'\n' as u16).collect();
    let mut out: Vec<Vec<u16>> = Vec::new();
    // 文件头那一批留在文件头（版本声明仍在最前）
    let mut at = 0;
    if !head.is_empty() {
        if raws.first().is_some_and(|r| is_version(u16s::trim(r))) {
            out.push(raws[0].to_vec());
            at = 1;
        }
        out.extend(head);
    }
    for (i, raw) in raws.iter().enumerate().skip(at) {
        if let Some(b) = before.remove(&i) {
            out.extend(b);
        }
        out.push(raw.to_vec());
    }
    out.extend(tail);
    String::from_utf16_lossy(&out.join(&(b'\n' as u16)))
}
