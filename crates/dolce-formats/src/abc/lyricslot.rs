//! 歌词对位格的判据（同 `abcfamily/lyricslot.ts`）——**读写两端共用这一份**。

use dolce_model::{Element, Part};

/// 休止占不占格按方言分：123 可见休止不占、`x` 不可见休止占；ABC 休止与 `x` 都不占
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LyricSlotRule {
    J123,
    Abc,
}

/// 这个元素占不占歌词对位格（`mainVoice`：本声部的主分支号）
pub fn is_lyric_slot(el: &Element, rule: LyricSlotRule, main_voice: f64) -> bool {
    if el.voice() > main_voice {
        return false;
    }
    let Element::Chord(c) = el else { return false };
    if c.grace.is_some() || c.continued == Some(true) {
        return false;
    }
    if c.rest.is_some() {
        return rule == LyricSlotRule::J123 && c.print_object == Some(false);
    }
    true
}

/// 声部里所有对位格（小节下标、元素下标），按元素顺序。`to` 含；`to_el` 不含（`usize::MAX` = 到底）
pub fn lyric_slots(part: &Part, from: usize, to: Option<usize>, from_el: usize, to_el: usize, rule: LyricSlotRule) -> Vec<(usize, usize)> {
    let mut out = vec![];
    let mut main_voice = f64::INFINITY;
    for m in &part.measures {
        for el in &m.elements {
            if let Element::Chord(c) = el {
                if c.voice < main_voice {
                    main_voice = c.voice;
                }
            }
        }
    }
    if !main_voice.is_finite() {
        main_voice = 1.0;
    }
    let to = to.unwrap_or(part.measures.len().wrapping_sub(1));
    let mut mi = from;
    while mi <= to && mi < part.measures.len() {
        let els = &part.measures[mi].elements;
        let end = if mi == to { to_el.min(els.len()) } else { els.len() };
        let mut j = if mi == from { from_el } else { 0 };
        while j < end {
            if is_lyric_slot(&els[j], rule, main_voice) {
                out.push((mi, j));
            }
            j += 1;
        }
        mi += 1;
    }
    out
}
