//! 歌词：音节、标点挤压、歌词联合括号与注记（照 `compose/lyric.ts`）。

use dolce_engrave::syllable::lyric;
use dolce_scene::{Identity, IdentityKind, Node};
use dolce_text::syllable::syllable_run;
use dolce_text::CompressMode;
use dolce_view::ast::LyricLine;

use super::brace::{brace_item, BraceKind};
use super::ctx::{eid, font, ident, text, Ctx};
use crate::model::PlacedItem;
use crate::util::max;

const BRACE_GAP: f64 = 0.09;
const BRACE_TOP: f64 = 0.78;
const BRACE_BOTTOM_UP: f64 = 0.16;

fn lyric_y_of(lyric_y: &[f64], verse: usize) -> f64 {
    lyric_y.get(verse).copied().unwrap_or(f64::NAN)
}

/// 歌词的联合括号：一段连续的带 `}` 行 + 其后紧跟的一行
pub fn paint_join_brace(c: &Ctx, root: &mut Node, lyrics: &[LyricLine], lyric_y: &[f64], lyric_right: &[f64]) {
    let mut spans = vec![];
    let mut i = 0;
    while i < lyrics.len() {
        if lyrics[i].join_brace == Some(true) {
            let mut j = i;
            while j + 1 < lyrics.len() && lyrics[j + 1].join_brace == Some(true) {
                j += 1;
            }
            let last = (j + 1).min(lyrics.len() - 1);
            if last > i {
                spans.push((i, last));
            }
            i = j;
        }
        i += 1;
    }
    for (first, last) in spans {
        let m = c.m;
        let mut right: f64 = 0.0;
        for k in first..=last {
            right = max(right, lyric_right.get(k).copied().unwrap_or(0.0));
        }
        if !right.is_finite() || right <= 0.0 {
            continue;
        }
        let x = right + m.style.size.lyric * BRACE_GAP;
        let y0 = lyric_y_of(lyric_y, first) - m.style.size.lyric * BRACE_TOP;
        let y1 = lyric_y_of(lyric_y, last) - m.style.size.lyric * BRACE_BOTTOM_UP;
        if y1 - y0 <= 0.0 {
            continue;
        }
        root.push(brace_item(c.ink, x, y0, y1, 1, BraceKind::Lyric));
    }
}

/// 歌词行的前置说明（段号 `1.`、角色名「狼:」等）：右对齐到本行歌词首字实际画出来的左缘
pub fn paint_lyric_annotations(c: &Ctx, root: &mut Node, lyrics: &[LyricLine], items: &[PlacedItem], lyric_y: &[f64], left: f64) {
    let m = c.m;
    let mc = c.env.mc;
    let f = font(&m.style.font.text.family, m.style.size.verse_num, false);
    let mode = CompressMode::parse(&m.style.look.punct_compress);
    for (verse, line) in lyrics.iter().enumerate() {
        let Some(ann) = line.annotation.as_deref().filter(|s| !s.is_empty()) else { continue };
        let gap = max(line.annotation_gap / 100.0, 0.1) * m.style.size.lyric;
        let w = f.measure_text(mc, ann);
        let lyric_font = font(&m.style.font.lyric.family, m.style.size.lyric, false);
        let first = items.iter().find(|it| matches!(it.syllables.get(verse), Some(Some(_))));
        let x0 = if let Some(first) = first {
            let syl = &first.syllables[verse].as_ref().unwrap().syl;
            let s = format!("{}{}", syl.text, syl.trailing_punctuation.as_deref().unwrap_or(""));
            let run = syllable_run(&s, &lyric_font, mc, mode);
            left + first.x - run.lead - run.body / 2.0
        } else {
            let lead = line.syllables.iter().find(|x| !x.text.is_empty()).map_or(0.0, |syl| syllable_run(&syl.text, &lyric_font, mc, mode).lead);
            left - m.style.size.lyric * 0.5 - lead
        };
        root.push(text(ann, x0 - gap - w, lyric_y_of(lyric_y, verse), f.clone(), c.lyric_ink, c.env));
    }
}

/// 一个符号下的各段歌词；`right_edge`：各段墨迹最右缘（联合括号用）
pub fn paint_syllables(c: &Ctx, root: &mut Node, it: &PlacedItem, x: f64, lyric_y: &[f64], right_edge: Option<&mut Vec<f64>>) {
    let m = c.m;
    let mc = c.env.mc;
    let f = font(&m.style.font.lyric.family, m.style.size.lyric, false);
    let mode = CompressMode::parse(&m.style.look.punct_compress);
    let mut right_edge = right_edge;
    for (verse, syl) in it.syllables.iter().enumerate() {
        let Some(syl) = syl else { continue };
        let s = format!("{}{}", syl.syl.text, syl.syl.trailing_punctuation.as_deref().unwrap_or(""));
        let mut g = Node::group();
        let run = syllable_run(&s, &f, mc, mode);
        let x0 = x - run.lead - run.body / 2.0;
        let mut t = lyric(&s, f.clone(), mode, (verse + 1) as f64);
        {
            let ts = t.text_mut();
            ts.color = c.lyric_ink;
            ts.char_xs = run.xs.clone();
        }
        t.set_x(x0);
        t.set_y(lyric_y_of(lyric_y, verse));
        g.push(t);
        if let Some(re) = right_edge.as_deref_mut() {
            if re.len() <= verse {
                re.resize(verse + 1, 0.0);
            }
            re[verse] = max(re[verse], x0 + run.width);
        }
        if let Some(owner) = syl.owner {
            g.id = Some(Identity { id: Some(eid(owner)), verse: Some(verse as u32), ..ident(IdentityKind::Syllable) });
        }
        root.push(g);
    }
}
