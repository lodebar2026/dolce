//! 内联层：`{bz…}` 临时伴奏（主旋律上方小字号行）与 `{dsb…}` 并排块（照 `place/layers.ts`）。
//! TS 以层对象为键的表在这里按层在 `voice.elements` 里的下标为键。

use std::collections::HashMap;

use dolce_view::ast::{BarlineType, InlineLayerElement, LayerRole, MusicElement, ScoreLine};

use crate::grid::JianpuGrid;
use crate::ink::Ink;
use crate::model::{PlacedItem, PlacedLayer, PlacedSplit};
use crate::place::marks::place_marks;
use crate::place::vertical::split_rise;
use crate::place::voice::{compute_underlines, layout_voice_line, BeatCtx, VoiceLine, SPLIT_BRACE_W};
use crate::util::min;
use crate::view::LRow;

/// 并排块里那一层自己的行（括起的内容）
pub fn layer_line(voice: &ScoreLine, el: &InlineLayerElement) -> ScoreLine {
    ScoreLine {
        voice: voice.voice,
        variant: None,
        caption: None,
        elements: el.elements.clone(),
        marks: el.marks.clone(),
        lyrics: vec![],
        raw: el.code.clone(),
        source: el.source,
    }
}

/// 先排好、与主行一起归列的内联层行，与它从主行第几小节起
pub struct BelowLine {
    pub laid: VoiceLine,
    pub bar_base: f64,
    /// 字号相对主旋律（`{bz}` 伴奏行是 `size.cue`）
    pub scale: f64,
}

fn host_at(items: &[PlacedItem], src: usize) -> Option<usize> {
    items.iter().position(|it| it.src_index >= src as i64)
}

fn layout_layer(row: &LRow, src: usize, el: &InlineLayerElement, m: &JianpuGrid, ctx: &BeatCtx) -> VoiceLine {
    let ids = row.sub_ids.get(src).cloned().unwrap_or_default();
    layout_voice_line(&layer_line(&row.line, el), &ids, m, &BeatCtx { meter: ctx.meter.clone(), ..BeatCtx::default() })
}

/// 与主行一起归列的内联层：同一谱表第二声部的并排下行（`below`）与 `{bz}` 临时伴奏行，
/// 先按自己的节奏排好，层首那一小节的拍位接着宿主音的拍位，再与主行同拍位归列。键为层在 `voice.elements` 里的下标
pub fn below_layer_lines(row: &LRow, items: &[PlacedItem], m: &JianpuGrid, ctx: &BeatCtx) -> Vec<(usize, BelowLine)> {
    let mut out = vec![];
    for (src, el) in row.line.elements.iter().enumerate() {
        let MusicElement::InlineLayer(l) = el else { continue };
        let cue = l.role != LayerRole::Voice;
        if !cue && l.below != Some(true) {
            continue;
        }
        let Some(h) = host_at(items, src) else { continue };
        let mut laid = layout_layer(row, src, l, m, ctx);
        let lead = if matches!(items[h].element, MusicElement::Barline(_)) { 0.0 } else { items[h].beat };
        for it in &mut laid.items {
            it.syllables = vec![];
        }
        for it in laid.items.iter_mut() {
            if matches!(it.element, MusicElement::Barline(_)) {
                break;
            }
            it.beat += lead;
        }
        let bar_base = items[..h].iter().filter(|it| matches!(it.element, MusicElement::Barline(_))).count() as f64;
        out.push((src, BelowLine { laid, bar_base, scale: if cue { m.style.size.cue } else { 1.0 } }));
    }
    out
}

/// 内联层：`{bz}` 是上方小字号行，`{dsb}` 是与主旋律并排的一块。`prelaid`：已与主行一起归过列的并排下行，x 照用
pub fn place_layers(
    row: &LRow,
    items: &mut [PlacedItem],
    m: &JianpuGrid,
    ink: &Ink,
    ctx: &BeatCtx,
    mut prelaid: HashMap<usize, VoiceLine>,
) -> Vec<PlacedLayer> {
    let voice = &row.line;
    let mut out = vec![];
    for (src, el) in voice.elements.iter().enumerate() {
        let MusicElement::InlineLayer(layer) = el else { continue };
        let host = host_at(items, src);
        let origin_x = match host {
            Some(h) => items[h].x,
            None => items.last().map_or(0.0, |it| it.x),
        };
        let inner = layer_line(voice, layer);
        let pre = prelaid.remove(&src);
        let had_pre = pre.is_some();
        let mut laid = pre.unwrap_or_else(|| layout_layer(row, src, layer, m, ctx));

        let Some(host_at) = host.filter(|_| layer.role == LayerRole::Voice) else {
            // `{bz}`：上方另排一小行。有宿主音的已与主行同拍位归过列（`below_layer_lines`），x 照用；
            // 行尾没有宿主音的，从行末那个符号起按自己的步距缩小排
            for it in &mut laid.items {
                if !had_pre {
                    it.x = origin_x + it.x * m.style.size.cue;
                    it.advance *= m.style.size.cue;
                }
                it.syllables = vec![];
            }
            let underlines = compute_underlines(&inner, &laid.items, m, &laid.groups);
            out.push(PlacedLayer { at: src, layer: layer.clone(), items: laid.items, underlines, split: None, y: None });
            continue;
        };

        // `{dsb}`：并排块
        let split = split_rise(m) * if layer.below == Some(true) { -1.0 } else { 1.0 };
        let mut total = 0.0;
        for it in &laid.items {
            total += it.beats;
        }
        let mut acc = 0.0;
        let mut last_at = host_at;
        for (i, it) in items.iter().enumerate().skip(host_at) {
            last_at = i;
            acc += it.beats;
            if acc >= total - 1e-6 {
                break;
            }
        }
        while last_at + 1 < items.len() && matches!(items[last_at + 1].element, MusicElement::Barline(_)) {
            last_at += 1;
        }
        // 主旋律这一段的拍位 → x
        struct Col {
            beat: f64,
            bar: bool,
            x: f64,
        }
        let mut cols: Vec<Col> = vec![];
        let mut at = 0.0;
        for it in &items[host_at..=last_at] {
            cols.push(Col { beat: at, bar: matches!(it.element, MusicElement::Barline(_)), x: it.x });
            at += it.beats;
        }
        let mut beat_at = 0.0;
        if !had_pre {
            for it in &mut laid.items {
                let bar = matches!(it.element, MusicElement::Barline(_));
                let hit = cols
                    .iter()
                    .find(|c| c.bar == bar && (c.beat - beat_at).abs() < 1e-6)
                    .or_else(|| cols.iter().find(|c| (c.beat - beat_at).abs() < 1e-6));
                match hit {
                    Some(c) => it.x = c.x,
                    None => {
                        let span = cols[cols.len() - 1].x - cols[0].x;
                        it.x = cols[0].x + if total > 0.0 { (beat_at / total) * span } else { 0.0 };
                    }
                }
                it.syllables = vec![];
                beat_at += it.beats;
            }
        }
        let tail_has_note = items[last_at + 1..].iter().any(|it| !matches!(it.element, MusicElement::Barline(_)));
        let mut note_end = last_at;
        while note_end > host_at && matches!(items[note_end].element, MusicElement::Barline(_)) {
            note_end -= 1;
        }
        let end_at = if tail_has_note { note_end } else { items.len() - 1 };
        for it in &mut items[host_at..=end_at] {
            it.dy = Some(split);
        }
        let mut underlines = compute_underlines(&inner, &laid.items, m, &laid.groups);
        for u in &mut underlines {
            u.dy = Some(-split);
        }
        let marks = place_marks(&inner, &laid.items, m, ink);
        let nh = m.ink.note_height;
        let mut placed = PlacedSplit {
            dy: -split,
            line: inner,
            marks,
            brace_left_x: None,
            brace_right_x: None,
            brace_top: -split.abs() - nh * 0.64,
            brace_bottom: split.abs() + nh * 0.64,
            band: None,
        };
        let before = &items[..host_at];
        let shows_left = layer.below == Some(true)
            || before.iter().any(|it| match &it.element {
                MusicElement::Barline(b) => b.kind != BarlineType::Hidden && b.kind != BarlineType::Invisible,
                _ => true,
            });
        if shows_left {
            placed.brace_left_x = Some(match host_at.checked_sub(1).map(|p| &items[p]) {
                Some(prev) if matches!(prev.element, MusicElement::Barline(_)) => prev.x + nh * 0.48,
                _ => items[host_at].x - nh * 1.07 - SPLIT_BRACE_W,
            });
        }
        if tail_has_note {
            for it in laid.items.iter_mut().rev() {
                if !matches!(it.element, MusicElement::Barline(_)) {
                    break;
                }
                it.no_barline = true;
            }
            let mut right = items[note_end].x + nh * 1.07;
            if let Some(bar) = items.get(note_end + 1) {
                if matches!(bar.element, MusicElement::Barline(_)) {
                    right = min(right, bar.x - nh * 0.48 - SPLIT_BRACE_W);
                }
            }
            placed.brace_right_x = Some(right);
        }
        out.push(PlacedLayer { at: src, layer: layer.clone(), items: laid.items, underlines, split: Some(placed), y: None });
    }
    out
}
