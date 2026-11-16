//! 段落与演唱顺序（同 `src/model/sections.ts`，M2 先迁投影要用的部分）。

use crate::doc::*;
use crate::jianpu::melody_chords;

/// 演唱顺序各项定好首尾和弦（`fromAnchor` / `toAnchor`）：投影与读回后小节会拆会并，按它们定位。
pub fn anchor_play_order(song: &Song) -> Vec<PlayPass> {
    let measures: &[Measure] = song.parts.first().map_or(&[], |p| &p.measures);
    let sounding = |i: f64| -> Vec<ElementId> {
        let Some(m) = dolce_base::js::index(i).and_then(|i| measures.get(i)) else { return vec![] };
        melody_chords(m, None)
            .into_iter()
            .filter_map(|k| match &m.elements[k] {
                Element::Chord(c) if c.grace.is_none() => Some(c.id),
                _ => None,
            })
            .collect()
    };
    song.play_order
        .iter()
        .flatten()
        .map(|p| {
            let mut out = p.clone();
            let mut i = p.from_measure - 1.0;
            while out.from_anchor.is_none() && i < p.to_measure {
                out.from_anchor = p.from_element.or_else(|| sounding(i).first().copied());
                i += 1.0;
            }
            let mut i = p.to_measure - 1.0;
            while out.to_anchor.is_none() && i >= p.from_measure - 1.0 {
                out.to_anchor = p.to_element.or_else(|| sounding(i).last().copied());
                i -= 1.0;
            }
            out
        })
        .collect()
}

const MAX_SEQ: usize = 2000;

/// `P:((AB)3.(CD)3)2` → `A B A B A B C D …`。点与空白只作分隔；写不明白或展开太长返回 `None`。
/// 按 UTF-16 码元走（同 TS `s[i]`）。
pub fn expand_section_order(text: &str) -> Option<Vec<String>> {
    let s: Vec<u16> = text.encode_utf16().filter(|&u| !(u == b'.' as u16 || char::from_u32(u as u32).is_some_and(dolce_base::js::is_space))).collect();
    fn seq(s: &[u16], i: &mut usize, depth: u32) -> Option<Vec<String>> {
        let mut out: Vec<String> = vec![];
        while *i < s.len() && s[*i] != b')' as u16 {
            let item: Vec<String>;
            if s[*i] == b'(' as u16 {
                *i += 1;
                let inner = seq(s, i, depth + 1)?;
                if s.get(*i) != Some(&(b')' as u16)) {
                    return None;
                }
                *i += 1;
                item = inner;
            } else if (s[*i] as u8 as u16 == s[*i]) && (s[*i] as u8).is_ascii_alphabetic() {
                item = vec![String::from(s[*i] as u8 as char)];
                *i += 1;
            } else {
                return None;
            }
            let start = *i;
            while *i < s.len() && (b'0' as u16..=b'9' as u16).contains(&s[*i]) {
                *i += 1;
            }
            let times = if *i > start { dolce_base::js::number(&String::from_utf16_lossy(&s[start..*i])) } else { 1.0 };
            if out.len() as f64 + item.len() as f64 * times > MAX_SEQ as f64 {
                return None;
            }
            if !item.is_empty() {
                for _ in 0..(times as usize) {
                    out.extend(item.iter().cloned());
                }
            }
        }
        if depth == 0 && *i < s.len() {
            None
        } else {
            Some(out)
        }
    }
    let mut i = 0;
    let out = seq(&s, &mut i, 0)?;
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// 音乐前最后一个字段上的 `P:` 是顺序还是第一个标记：多于一项的全大写顺序串才算顺序（`P:BA`、`P:A2`、`P:(AB)2`）；
/// `P:A`、`P:Intro` 是标记。
pub fn looks_like_order(text: &str) -> bool {
    if text.is_empty() || !text.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '(' || c == ')' || c == '.' || dolce_base::js::is_space(c)) {
        return false;
    }
    expand_section_order(text).is_some_and(|s| s.len() > 1)
}
