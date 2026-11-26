//! 窄纸整首重新断行（照 `place/reflow.ts`）：源里的行放不下时求新的行首。元素 id 走 `PlacedItem.id` / `LRow.ids`（TS `idOf`）。

use std::collections::HashMap;

use dolce_model::view::ast::MusicElement;

use crate::grid::{content_width, JianpuGrid};
use crate::ink::Ink;
use crate::model::PlacedItem;
use crate::place::expand::{fill_lines, FillOpts};
use crate::place::spacing::{natural_columns, SpacedLine};
use crate::place::voice::{assign_lyrics, layout_voice_line, BeatCtx, VoiceLine};
use crate::util::{max, min};
use crate::view::{LRow, LSong};

/// 一个音的自然横向区间
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NaturalSpan {
    pub x0: f64,
    pub x1: f64,
    /// 后面紧跟小节线时，含这条线的右缘
    pub x1b: Option<f64>,
}

/// 排一行（只为量宽）：符号、拍位，挂上音节
fn laid_row(row: &LRow, song: &LSong, m: &JianpuGrid) -> VoiceLine {
    let mut l = layout_voice_line(&row.line, &row.ids, m, &BeatCtx { meter: song.metadata.meters.first().cloned(), ..BeatCtx::default() });
    for it in &mut l.items {
        it.syllables = vec![None; row.line.lyrics.len()];
    }
    assign_lyrics(&mut l.items, &row.line.lyrics, &row.owners);
    l
}

#[derive(Clone, Copy)]
struct Bar {
    w: f64,
    first: Option<i64>,
}

/// 窄纸重断行的行首 id（每首一份，首行不列）；都放得下为 None
pub fn reflow_line_starts(songs: &[LSong], m: &JianpuGrid, ink: &Ink) -> Option<Vec<Vec<i64>>> {
    let width = content_width(m);
    if width.is_nan() || width <= 0.0 {
        return None;
    }
    let mut overflow = false;
    let per_song: Vec<Vec<Bar>> = songs
        .iter()
        .map(|song| {
            let mut bars: Vec<Bar> = vec![];
            let mut open: Option<Bar> = None;
            for page in &song.pages {
                for group in &page.groups {
                    let laid_out: Vec<VoiceLine> = group.voices.iter().map(|row| laid_row(row, song, m)).collect();
                    let lines: Vec<SpacedLine> = laid_out.iter().map(|l| SpacedLine::main(&l.items, &l.pad)).collect();
                    let nat = natural_columns(&lines, m, ink, 0.0);
                    let Some(lead) = laid_out.first() else { continue };
                    if nat.width > width {
                        overflow = true;
                    }
                    let x_of = |k: usize| nat.x[0][k];
                    let mut start = 0.0;
                    let mut first: Option<i64> = None;
                    let mut has_content = false;
                    for (k, it) in lead.items.iter().enumerate() {
                        if matches!(it.element, MusicElement::Barline(_)) {
                            if first.is_some() || open.is_some() {
                                let w = max(0.0, x_of(k) - start);
                                match open.take() {
                                    Some(mut o) => {
                                        o.w += w;
                                        if o.first.is_none() {
                                            o.first = first;
                                        }
                                        bars.push(o);
                                    }
                                    None => bars.push(Bar { w, first }),
                                }
                                first = None;
                            }
                            start = x_of(k);
                            has_content = false;
                            continue;
                        }
                        has_content = true;
                        if first.is_none() && matches!(it.element, MusicElement::Note(_)) {
                            first = it.id;
                        }
                    }
                    if has_content {
                        open = Some(Bar { w: nat.width - start, first });
                    }
                }
            }
            if let Some(o) = open {
                bars.push(o);
            }
            bars
        })
        .collect();
    if !overflow {
        return None;
    }
    Some(
        per_song
            .iter()
            .map(|bars| {
                let n = bars.len();
                let mut best = vec![f64::INFINITY; n + 1];
                let mut prev = vec![-1i64; n + 1];
                best[0] = 0.0;
                for j in 1..=n {
                    let mut w = 0.0;
                    for i in (0..j).rev() {
                        w += bars[i].w;
                        if w > width && i < j - 1 {
                            break;
                        }
                        if best[i] == f64::INFINITY {
                            continue;
                        }
                        let c = best[i] + max(0.0, width - w).powi(2);
                        if c < best[j] {
                            best[j] = c;
                            prev[j] = i as i64;
                        }
                    }
                }
                let mut cuts: Vec<i64> = vec![];
                let mut j = n as i64;
                while j > 0 {
                    let p = prev[j as usize];
                    cuts.insert(0, p);
                    j = p;
                }
                cuts.into_iter().filter(|&i| i > 0).filter_map(|i| bars[i as usize].first).collect()
            })
            .collect(),
    )
}

/// 一行里从第 `from` 个元素起第一个音符 / 增时线的元素 id
fn start_id_of(row: &LRow, from: usize) -> Option<i64> {
    for i in from..row.line.elements.len() {
        if !matches!(row.line.elements[i], MusicElement::Note(_) | MusicElement::Sustain(_)) {
            continue;
        }
        if let Some(id) = row.ids.get(i).copied().flatten() {
            return Some(id);
        }
    }
    None
}

/// 成书的折行：源里每一行按自然宽逐行装满，折出新行首（含源里原有的行首）；都放得下为 None
pub fn fold_line_starts(songs: &[LSong], m: &JianpuGrid, ink: &Ink) -> Option<Vec<Vec<i64>>> {
    let width = content_width(m);
    if width.is_nan() || width <= 0.0 {
        return None;
    }
    let mut folded = false;
    let out: Vec<Vec<i64>> = songs
        .iter()
        .map(|song| {
            let mut starts = vec![];
            let mut first_group = true;
            for page in &song.pages {
                for group in &page.groups {
                    let Some(row) = group.voices.first() else { continue };
                    let lines = fill_lines(&row.line, &HashMap::new(), m, ink, width, song.metadata.meters.first(), &FillOpts::default());
                    if lines.len() > 1 {
                        folded = true;
                    }
                    for (n, l) in lines.iter().enumerate() {
                        if n == 0 && first_group {
                            continue;
                        }
                        if let Some(id) = start_id_of(row, l.start) {
                            starts.push(id);
                        }
                    }
                    first_group = false;
                }
            }
            starts
        })
        .collect();
    folded.then_some(out)
}

/// 整首的自然横向区间（键为元素 id，按插入序）
pub fn natural_spans(song: &LSong, m: &JianpuGrid, ink: &Ink) -> Vec<(i64, NaturalSpan)> {
    let mut out: Vec<(i64, NaturalSpan)> = vec![];
    let mut base = 0.0;
    for page in &song.pages {
        for group in &page.groups {
            let Some(row) = group.voices.first() else { continue };
            let mut right = base;
            let laid = laid_row(row, song, m);
            let items: &[PlacedItem] = &laid.items;
            let nat = natural_columns(&[SpacedLine::main(items, &laid.pad)], m, ink, 0.0);
            let mut owner: Option<i64> = None;
            for (k, it) in items.iter().enumerate() {
                match &it.element {
                    MusicElement::Barline(_) => {
                        if let Some(sp) = owner.and_then(|o| out.iter_mut().find(|(id, _)| *id == o)) {
                            sp.1.x1b = Some(max(sp.1.x1b.unwrap_or(sp.1.x1), base + nat.right[0][k]));
                        }
                        continue;
                    }
                    MusicElement::Note(_) => owner = it.id,
                    MusicElement::Sustain(_) => {}
                    _ => continue,
                }
                let Some(o) = owner else { continue };
                let x0 = base + nat.left[0][k];
                let x1 = base + nat.right[0][k];
                right = max(right, x1);
                match out.iter_mut().find(|(id, _)| *id == o) {
                    Some(p) => {
                        p.1.x0 = min(p.1.x0, x0);
                        p.1.x1 = max(p.1.x1, x1);
                    }
                    None => out.push((o, NaturalSpan { x0, x1, x1b: None })),
                }
            }
            base = right;
        }
    }
    out
}
