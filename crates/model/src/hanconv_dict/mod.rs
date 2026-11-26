//! 简繁转换词表引擎：大陆简体 ↔ 台湾正体（同网页版所用词表的 `cn → tw` / `tw → cn`，逐字一致）。
//!
//! 一个方向是一串步骤：先把兼容区汉字规范化，再按词组切段，然后每个词表组在各段上做最长匹配替换。
//! 一个组里有几份词表时，排在前面的优先（同一词条以前面的为准）。匹配按码位；认不出的「表意文字描述序列」整串跳过。

use crate::hanconv::HanConv;
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Default)]
struct Node {
    next: HashMap<char, usize>,
    val: Option<String>,
}

/// 字典树：节点放在一个数组里。
struct Trie {
    nodes: Vec<Node>,
}

impl Trie {
    /// 一组词表；前面的优先（后加的盖前加的，所以倒着加）
    fn group(dicts: &[&str]) -> Trie {
        let mut t = Trie { nodes: vec![Node::default()] };
        for d in dicts.iter().rev() {
            for line in d.split('|') {
                let mut it = line.split(' ');
                let (Some(l), Some(r)) = (it.next(), it.next()) else { continue };
                t.add(l, r);
            }
        }
        t
    }

    fn add(&mut self, s: &str, v: &str) {
        let mut cur = 0;
        for c in s.chars() {
            cur = match self.nodes[cur].next.get(&c) {
                Some(&n) => n,
                None => {
                    self.nodes.push(Node::default());
                    let n = self.nodes.len() - 1;
                    self.nodes[cur].next.insert(c, n);
                    n
                }
            };
        }
        self.nodes[cur].val = Some(v.to_owned());
    }

    /// 从 `i` 起最长的词条：（终点，替换成什么）
    fn match_prefix(&self, s: &[char], i: usize) -> Option<(usize, &str)> {
        let mut cur = 0;
        let mut best = None;
        for (j, c) in s.iter().enumerate().skip(i) {
            let Some(&n) = self.nodes[cur].next.get(c) else { break };
            cur = n;
            if let Some(v) = &self.nodes[cur].val {
                best = Some((j + 1, v.as_str()));
            }
        }
        best
    }

    /// 切段：词条各成一段，中间认不出的连成一段。
    fn segment(&self, s: &[char]) -> Vec<String> {
        let mut out = vec![];
        let mut orig: Option<usize> = None;
        let mut i = 0;
        while i < s.len() {
            if let Some((end, _)) = self.match_prefix(s, i) {
                if let Some(o) = orig.take() {
                    out.push(s[o..i].iter().collect());
                }
                out.push(s[i..end].iter().collect());
                i = end;
            } else {
                orig.get_or_insert(i);
                i += unmatched_len(s, i);
            }
        }
        if let Some(o) = orig {
            out.push(s[o..].iter().collect());
        }
        out
    }

    fn convert(&self, s: &str) -> String {
        let s: Vec<char> = s.chars().collect();
        let mut out = String::new();
        let mut orig: Option<usize> = None;
        let mut i = 0;
        while i < s.len() {
            if let Some((end, v)) = self.match_prefix(&s, i) {
                if let Some(o) = orig.take() {
                    out.extend(&s[o..i]);
                }
                out.push_str(v);
                i = end;
            } else {
                orig.get_or_insert(i);
                i += unmatched_len(&s, i);
            }
        }
        if let Some(o) = orig {
            out.extend(&s[o..]);
        }
        out
    }
}

/// 表意文字描述符带几个部件（⿰⿱ 两个、⿲⿳ 三个……）
fn ids_arity(c: char) -> usize {
    match c as u32 {
        0x2ff0..=0x2ff1 => 2,
        0x2ff2..=0x2ff3 => 3,
        0x2ff4..=0x2fff => 2,
        _ => 0,
    }
}

/// 从 `i` 起一整串表意文字描述序列的终点；不是描述序列为 0
fn ids_end(s: &[char], i: usize) -> usize {
    let arity = ids_arity(s[i]);
    if arity == 0 {
        return 0;
    }
    let mut end = i + 1;
    for _ in 0..arity {
        if end >= s.len() {
            return 0;
        }
        let child = ids_end(s, end);
        end = if child != 0 { child } else { end + 1 };
    }
    end
}

fn unmatched_len(s: &[char], i: usize) -> usize {
    let e = ids_end(s, i);
    if e > i {
        e - i
    } else {
        1
    }
}

/// 一个转换方向。
pub struct Converter {
    normalize: Trie,
    segmentation: Trie,
    chain: Vec<Trie>,
}

impl Converter {
    pub fn convert(&self, s: &str) -> String {
        let s = self.normalize.convert(s);
        let chars: Vec<char> = s.chars().collect();
        self.segmentation
            .segment(&chars)
            .iter()
            .map(|seg| self.chain.iter().fold(seg.clone(), |acc, t| t.convert(&acc)))
            .collect()
    }
}

impl HanConv for Converter {
    fn conv(&self, s: &str) -> String {
        self.convert(s)
    }
}

macro_rules! dict {
    ($n:literal) => {
        include_str!(concat!("../../data/hanconv/", $n, ".txt"))
    };
}

const CJK_COMPAT: &str = dict!("CJK_Compatibility_Ideographs");
const ST_PHRASES: &str = dict!("STPhrases");
const ST_REGIONAL: &str = dict!("STPhrases_GeneratedFromRegionalPhrases");

/// 简 → 繁（台湾正体）
pub fn s2t() -> &'static Converter {
    static C: OnceLock<Converter> = OnceLock::new();
    C.get_or_init(|| Converter {
        normalize: Trie::group(&[CJK_COMPAT]),
        segmentation: Trie::group(&[ST_PHRASES, ST_REGIONAL]),
        chain: vec![
            Trie::group(&[ST_PHRASES, ST_REGIONAL, dict!("STCharacters")]),
            Trie::group(&[dict!("TWVariantsPhrases"), dict!("TWVariants")]),
        ],
    })
}

/// 繁（台湾正体）→ 简
pub fn t2s() -> &'static Converter {
    static C: OnceLock<Converter> = OnceLock::new();
    C.get_or_init(|| Converter {
        normalize: Trie::group(&[CJK_COMPAT]),
        segmentation: Trie::group(&[dict!("TSPhrases")]),
        chain: vec![
            Trie::group(&[dict!("TWVariantsRevPhrases"), dict!("TWVariantsRev")]),
            Trie::group(&[dict!("TSPhrases"), dict!("TSCharacters")]),
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn earlier_dict_wins_and_longest_match() {
        let t = Trie::group(&["甲 A|甲乙 AB", "甲 X|乙 Y"]);
        assert_eq!(t.convert("甲乙乙丙"), "ABY丙");
        assert_eq!(t.convert("甲丙"), "A丙");
    }

    #[test]
    fn ids_sequence_is_skipped_whole() {
        let t = Trie::group(&["木 X"]);
        // ⿰木木 是一整串描述序列，不拆开换
        assert_eq!(t.convert("⿰木木木"), "⿰木木X");
    }
}
