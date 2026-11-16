//! **断行的读写对**：模型里的换行 ↔ 「新行从哪个元素起」（同 `src/model/breaks.ts`）。
//!
//! 小节级的在 `Measure.print.newSystem/newPage`（本小节**起**新系统），小节中间的在前一个和弦（或它的增时线）的
//! `lineBreakAfter` 上。`breaks_of` 读出现有断行，`apply_breaks` 把一组行首写进模型、**替换**原有断行。

use crate::doc::*;
use crate::helpers::inline_break_of;
use std::collections::{HashMap, HashSet};

/// 新的一行从这个元素（和弦或增时线）起。`page`：这一行起新页。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LineStart {
    pub id: ElementId,
    pub page: bool,
}

/// 小节中间的行首怎么落
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MidMode {
    /// 原位记 `lineBreakAfter`
    Inline,
    /// 挪到下一根小节线
    Snap,
    /// 只留源文本来就在那里换行的（原位），其余挪到下一根小节线
    Source,
}

/// 换页怎么处理
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageMode {
    /// 清掉原有换页，按 `LineStart.page` 重写
    Write,
    /// 原有换页不动
    Keep,
}

#[derive(Clone, Copy, Debug)]
pub struct ApplyBreaksOptions {
    /// 多声部也在小节中间断（只断旋律那一路）
    pub mid_in_any_part: bool,
    pub mid: MidMode,
    pub pages: PageMode,
}

#[derive(Clone, Copy, Debug)]
struct Spot {
    part: usize,
    measure: usize,
    index: usize,
    sustain: Option<usize>,
}

fn spots_of(song: &Song) -> HashMap<ElementId, Spot> {
    let mut out = HashMap::new();
    for (pi, part) in song.parts.iter().enumerate() {
        for (mi, mea) in part.measures.iter().enumerate() {
            for (ei, el) in mea.elements.iter().enumerate() {
                out.insert(el.id(), Spot { part: pi, measure: mi, index: ei, sustain: None });
                let Element::Chord(c) = el else { continue };
                for (si, su) in c.sustains.iter().flatten().enumerate() {
                    out.insert(su.id, Spot { part: pi, measure: mi, index: ei, sustain: Some(si) });
                }
            }
        }
    }
    out
}

fn is_grace(el: Option<&Element>) -> bool {
    matches!(el, Some(Element::Chord(c)) if c.grace.is_some())
}

fn grace_head(mea: &Measure, ei: usize) -> usize {
    let mut j = ei;
    while j > 0 && is_grace(mea.elements.get(j - 1)) {
        j -= 1;
    }
    j
}

fn at_measure_start(mea: &Measure, ei: usize) -> bool {
    for el in &mea.elements[..ei.min(mea.elements.len())] {
        // 隐藏的占位不占谱面
        if let Element::Chord(c) = el {
            if c.grace.is_none() && c.print_object != Some(false) {
                return false;
            }
        }
    }
    true
}

/// 挂得住换行的东西：和弦本身或它的第几根增时线
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Host {
    Chord { measure: usize, index: usize },
    Sustain { measure: usize, index: usize, sustain: usize },
}

fn host_before(mea: &Measure, mi: usize, spot: &Spot) -> Option<(Host, Option<BreakKind>)> {
    if let Some(si) = spot.sustain {
        let Some(Element::Chord(chord)) = mea.elements.get(spot.index) else { return None };
        if si > 0 {
            if let Some(su) = chord.sustains.as_ref().and_then(|s| s.get(si - 1)) {
                return Some((Host::Sustain { measure: mi, index: spot.index, sustain: si - 1 }, su.line_break_after.clone()));
            }
        }
        return Some((Host::Chord { measure: mi, index: spot.index }, chord.line_break_after.clone()));
    }
    let gh = grace_head(mea, spot.index);
    if gh == 0 {
        return None;
    }
    let prev_i = gh - 1;
    let Some(prev @ Element::Chord(pc)) = mea.elements.get(prev_i) else { return None };
    let n = pc.sustains.as_ref().map_or(0, |s| s.len());
    let host = if n > 0 {
        Host::Sustain { measure: mi, index: prev_i, sustain: n - 1 }
    } else {
        Host::Chord { measure: mi, index: prev_i }
    };
    Some((host, inline_break_of(prev)))
}

fn host_slot(part: &mut Part, h: Host) -> &mut Option<BreakKind> {
    match h {
        Host::Chord { measure, index } => match &mut part.measures[measure].elements[index] {
            Element::Chord(c) => &mut c.line_break_after,
            _ => unreachable!(),
        },
        Host::Sustain { measure, index, sustain } => match &mut part.measures[measure].elements[index] {
            Element::Chord(c) => &mut c.sustains.as_mut().unwrap()[sustain].line_break_after,
            _ => unreachable!(),
        },
    }
}

fn print_empty(p: &Print) -> bool {
    p.new_system.is_none()
        && p.new_page.is_none()
        && p.system.is_none()
        && p.texts.is_none()
        && p.caption.is_none()
        && p.variant.is_none()
        && p.lyric_lines.is_none()
        && p.source.is_none()
        && p.text_sources.is_none()
}

/// `Object.keys(print).length === 0` 时删掉
pub(crate) fn drop_empty_print(m: &mut Measure) {
    if m.print.as_ref().is_some_and(print_empty) {
        m.print = None;
    }
}

fn clear_breaks(song: &mut Song, pages: PageMode) {
    for part in &mut song.parts {
        for mea in &mut part.measures {
            if let Some(pr) = &mut mea.print {
                pr.new_system = None;
                pr.system = None;
                if pages == PageMode::Write {
                    pr.new_page = None;
                }
                drop_empty_print(mea);
            }
            for el in &mut mea.elements {
                let Element::Chord(c) = el else { continue };
                c.line_break_after = None;
                for su in c.sustains.iter_mut().flatten() {
                    su.line_break_after = None;
                }
            }
            for b in mea.barlines.iter_mut().flatten() {
                b.line_break_after = None;
            }
        }
    }
}

/// 清掉整首的换行与换页。
pub fn clear_song_breaks(song: &mut Song) {
    clear_breaks(song, PageMode::Write);
}

fn set_new_system(m: &mut Measure) -> &mut Print {
    let pr = m.print.get_or_insert_with(Print::default);
    pr.new_system = Some(true);
    pr
}

/// 把一组行首写进模型的换行位，**替换**原有的断行。返回有没有落下任何换行（一个都对不上时不改模型）。
pub fn apply_breaks(song: &mut Song, starts: &[LineStart], opt: &ApplyBreaksOptions) -> bool {
    if song.parts.len() > 1 && song.parts.iter().any(|p| p.measures.iter().any(|m| m.print.as_ref().is_some_and(|pr| pr.system.is_some()))) {
        return false;
    }
    let where_ = spots_of(song);
    let mut by_part: HashMap<usize, Vec<(Spot, bool)>> = HashMap::new();
    for s in starts {
        let Some(spot) = where_.get(&s.id) else { continue };
        by_part.entry(spot.part).or_default().push((*spot, s.page));
    }
    let Some(&pi) = by_part.keys().min() else { return false };
    let mut hits = by_part.remove(&pi).unwrap();
    // 稳定排序（同 JS sort）
    hits.sort_by(|a, b| {
        a.0.measure
            .cmp(&b.0.measure)
            .then(a.0.index.cmp(&b.0.index))
            .then(a.0.sustain.map_or(-1, |x| x as isize).cmp(&b.0.sustain.map_or(-1, |x| x as isize)))
    });

    // 小节 → 是否换页（保持插入次序）
    let mut measure_starts: Vec<(usize, bool)> = vec![];
    let mut inline: Vec<(Host, BreakKind, usize)> = vec![];
    let single = song.parts.len() == 1;
    for (spot, page) in &hits {
        let mea = &song.parts[pi].measures[spot.measure];
        let mut mi = spot.measure;
        if spot.sustain.is_some() || !at_measure_start(mea, spot.index) {
            let h = if opt.mid == MidMode::Snap || (!single && !opt.mid_in_any_part) {
                None
            } else {
                host_before(mea, spot.measure, spot)
            };
            let kind = match &h {
                None => None,
                Some((_, was)) => match opt.mid {
                    MidMode::Source => was.clone(),
                    _ if opt.pages == PageMode::Write => Some(if *page { BreakKind::Page } else { BreakKind::System }),
                    _ => Some(was.clone().unwrap_or(BreakKind::System)),
                },
            };
            if let (Some((host, _)), Some(kind)) = (h, kind) {
                inline.push((host, kind, spot.measure));
                continue;
            }
            mi = spot.measure + 1;
        }
        if mi == 0 || mi >= song.parts[pi].measures.len() {
            continue;
        }
        match measure_starts.iter_mut().find(|(m, _)| *m == mi) {
            Some(e) => e.1 = e.1 || *page,
            None => measure_starts.push((mi, *page)),
        }
    }
    if measure_starts.is_empty() && inline.is_empty() {
        return false;
    }
    let inline_next: HashSet<usize> = inline.iter().map(|(_, _, mi)| mi + 1).collect();
    measure_starts.retain(|(mi, _)| !inline_next.contains(mi));

    clear_breaks(song, opt.pages);
    for part in &mut song.parts {
        for &(mi, page) in &measure_starts {
            let Some(target) = part.measures.get_mut(mi) else { continue };
            let pr = set_new_system(target);
            if page && opt.pages == PageMode::Write {
                pr.new_page = Some(true);
            }
        }
    }
    if opt.pages == PageMode::Write {
        for (host, kind, _) in &inline {
            *host_slot(&mut song.parts[pi], *host) = Some(kind.clone());
        }
    } else {
        // 换页留着原样时：小节中间的换页归到这一刀上（同一小节里只认最后那刀）
        let mut paged: HashSet<usize> = HashSet::new();
        for k in (0..inline.len()).rev() {
            let (host, ref kind0, mi) = inline[k];
            let mut kind = kind0.clone();
            let next_page = song.parts.first().and_then(|p| p.measures.get(mi + 1)).and_then(|m| m.print.as_ref()).and_then(|p| p.new_page)
                == Some(true);
            if !paged.contains(&mi) && (kind == BreakKind::Page || next_page) {
                kind = BreakKind::Page;
            } else if kind == BreakKind::Page {
                kind = BreakKind::System;
            }
            *host_slot(&mut song.parts[pi], host) = Some(kind.clone());
            inline[k].1 = kind.clone();
            if kind != BreakKind::Page {
                continue;
            }
            paged.insert(mi);
            for part in &mut song.parts {
                let Some(m) = part.measures.get_mut(mi + 1) else { continue };
                let Some(pr) = &mut m.print else { continue };
                pr.new_page = None;
                drop_empty_print(m);
            }
        }
    }
    // 小节中间的换行在下一小节上另记一份小节级的；种类取本小节最后那刀
    let mut last: Vec<(usize, BreakKind)> = vec![];
    for (_, kind, mi) in &inline {
        match last.iter_mut().find(|(m, _)| m == mi) {
            Some(e) => e.1 = kind.clone(),
            None => last.push((*mi, kind.clone())),
        }
    }
    for part in &mut song.parts {
        for (mi, kind) in &last {
            let Some(next) = part.measures.get_mut(mi + 1) else { continue };
            let pr = set_new_system(next);
            if *kind == BreakKind::Page {
                pr.new_page = Some(true);
            }
        }
    }
    true
}

fn main_chord_from(mea: &Measure, ei: usize) -> Option<ElementId> {
    mea.elements.iter().skip(ei).find_map(|el| match el {
        Element::Chord(c) if c.grace.is_none() => Some(c.id),
        _ => None,
    })
}

/// 读出一首现有的断行：第一声部上的行首元素，按谱序。
pub fn breaks_of(song: &Song) -> Vec<LineStart> {
    let mut out = vec![];
    let Some(part) = song.parts.first() else { return out };
    let mut seen: HashSet<ElementId> = HashSet::new();
    let mut add = |id: Option<ElementId>, page: bool, out: &mut Vec<LineStart>| {
        let Some(id) = id else { return };
        if seen.insert(id) {
            out.push(LineStart { id, page });
        }
    };
    let first_chord_from = |from: usize| -> Option<ElementId> { part.measures.iter().skip(from).find_map(|m| main_chord_from(m, 0)) };
    let mut inline_before = false;
    for (mi, mea) in part.measures.iter().enumerate() {
        let pr = mea.print.as_ref();
        let ns = pr.and_then(|p| p.new_system) == Some(true);
        let np = pr.and_then(|p| p.new_page) == Some(true);
        if mi > 0 && !inline_before && (ns || np) {
            add(first_chord_from(mi), np, &mut out);
        }
        inline_before = mea.elements.iter().any(|el| inline_break_of(el).is_some());
        let next_after = |ei: usize, si: usize| -> Option<ElementId> {
            let sus: &[Sustain] = match mea.elements.get(ei) {
                Some(Element::Chord(c)) => c.sustains.as_deref().unwrap_or(&[]),
                _ => &[],
            };
            if si < sus.len() {
                return Some(sus[si].id);
            }
            main_chord_from(mea, ei + 1).or_else(|| first_chord_from(mi + 1))
        };
        for (ei, el) in mea.elements.iter().enumerate() {
            let Element::Chord(c) = el else { continue };
            let sus = c.sustains.as_deref().unwrap_or(&[]);
            if let Some(k) = &c.line_break_after {
                add(next_after(ei, sus.len()), *k == BreakKind::Page, &mut out);
            }
            for (si, su) in sus.iter().enumerate() {
                if let Some(k) = &su.line_break_after {
                    add(next_after(ei, si + 1), *k == BreakKind::Page, &mut out);
                }
            }
        }
    }
    out
}
