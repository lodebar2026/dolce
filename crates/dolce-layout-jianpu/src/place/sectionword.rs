//! 段落词（音符注释）的横向落点（照 `place/sectionword.ts`）：判据在 `dolce_engrave::sectionword::place_section_word`，
//! 这里只把一行里的符号换算成它要的几何——横向撑开（spacing）与真正摆（band）用同一个换算。

use dolce_engrave::sectionword::{place_section_word, section_word_hang_left, SectionChord, SectionWordGeom, SectionWordSlot};
use dolce_base::geom::Rect;
use dolce_view::ast::MusicElement;

use crate::grid::JianpuGrid;
use crate::model::PlacedItem;
use crate::util::max;

/// 挂得住段落词的符号（音符、增时线）上的那条注释
pub fn section_word_of(el: &MusicElement) -> Option<&str> {
    match el {
        MusicElement::Note(n) => n.annotation.as_deref(),
        MusicElement::Sustain(s) => s.annotation.as_deref(),
        _ => None,
    }
}

/// 一个音上的几条段落词（按换行隔开、先写的在上）
pub fn section_word_lines(text: &str) -> Vec<String> {
    text.split('\n').filter(|l| !l.is_empty()).map(str::to_string).collect()
}

/// 几行里最宽那一行的墨迹（`reduce`：更宽才换）
pub fn widest_line(lines: &[String], measure: impl Fn(&str) -> Rect) -> Rect {
    let mut best = measure(&lines[0]);
    for l in &lines[1..] {
        let b = measure(l);
        if b.right - b.left > best.right - best.left {
            best = b;
        }
    }
    best
}

/// 一行里第一个音符/增时线的下标（没有为 −1）
pub fn line_start_index(items: &[PlacedItem]) -> i64 {
    items.iter().position(|it| matches!(it.element, MusicElement::Note(_) | MusicElement::Sustain(_))).map_or(-1, |i| i as i64)
}

/// 和弦在行里的横向范围（按墨迹）；`at` = 挂在第几个符号上
#[derive(Clone, Copy, Debug)]
pub struct ChordSpan {
    pub x0: f64,
    pub x1: f64,
    pub at: usize,
}

/// 第 `i` 个符号上那条段落词落在哪儿：返回 (落笔点 x 的那一份 slot, anchorX)
pub fn section_word_slot(
    items: &[PlacedItem],
    i: usize,
    x_of: &dyn Fn(usize) -> f64,
    chords: &[ChordSpan],
    word: Rect,
    m: &JianpuGrid,
    line_right: f64,
) -> (SectionWordSlot, f64) {
    let anchor_x = x_of(i) - m.ink.note_height * 0.35;
    let mut bars: Vec<f64> = items.iter().enumerate().filter(|(_, o)| matches!(o.element, MusicElement::Barline(_))).map(|(k, _)| x_of(k)).collect();
    dolce_base::js::sort_num(&mut bars);
    let bar_left_at = bars.iter().rev().find(|&&bx| bx <= anchor_x).copied();
    let mut own: Option<f64> = None;
    for c in chords {
        if c.at == i {
            own = Some(max(own.unwrap_or(f64::NEG_INFINITY), c.x1));
        }
    }
    let slot = place_section_word(&SectionWordGeom {
        anchor_x,
        width: word.right - word.left,
        size: m.style.size.section_word,
        gap: Some(m.style.size.chord * 0.28),
        base_y: 0.0,
        chords: chords.iter().map(|c| SectionChord { x0: c.x0, x1: c.x1, y: 0.0 }).collect(),
        bar_left: bar_left_at.unwrap_or(0.0),
        bar_right: bars.iter().find(|&&bx| bx > anchor_x).copied().unwrap_or(line_right),
        hang_left: section_word_hang_left(bar_left_at),
        right_limit: line_right,
        at_line_start: line_start_index(items) == i as i64,
        straddle: false,
        own_chord_right: own,
    });
    (SectionWordSlot { x: slot.x - word.left, ..slot }, anchor_x)
}
