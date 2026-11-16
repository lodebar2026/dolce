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
