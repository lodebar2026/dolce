//! 一首（及一份文档）的定位（照 `place/song.ts`）：逐组排声部、组间让位、分页，长图把各页接成一张。
//!
//! TS 就地改行视图（行末段落词挪到下一行、自动段号）；这里先克隆出本首的谱组再改，`PlacedGroup.group` /
//! `PlacedVoice.voice` 指的是改过的那份（与 TS compose 读到的一致）。

use std::collections::HashMap;
use std::rc::Rc;

use dolce_view::ast::{LayerRole, Meter, MusicElement};

use crate::grid::{content_width, JianpuGrid};
use crate::ink::Ink;
use crate::model::{InkTextRole, PlacedGroup, PlacedPage, PlacedScore, PlacedVoice};
use crate::paginate::{paginate, PaginateSpec, SystemBlock};
use crate::place::band::place_band;
use crate::place::layers::{below_layer_lines, place_layers};
use crate::place::marks::{below_arcs_bottom, place_marks};
use crate::place::spacing::{apply_placement, place_columns, SpacedLine};
use crate::place::vertical::{brace_reach, group_headroom, line_ink_bottom, split_rise, voice_headroom, words_lead, GROUP_CLEAR};
use crate::place::voice::{assign_lyrics, compute_underlines, layout_voice_line, line_end_meter, line_ends_with_forward_repeat, BeatCtx, VoiceLine};
use crate::util::{max, min, min_of};
use crate::view::{LGroup, LRow, LSong};

/// `&sbf` 标出的分声部位置：标着它的那条小节线之后第一个符号的 x，取最早的一处
fn brace_start_x(voices: &[PlacedVoice]) -> Option<f64> {
    let mut best: Option<f64> = None;
    for v in voices {
        let items = &v.items;
        for i in 0..items.len() {
            let MusicElement::Barline(b) = &items[i].element else { continue };
            if !b.ornaments.iter().any(|o| o.name == "sbf") {
                continue;
            }
            let x = items.get(i + 1).map_or(items[i].x, |n| n.x);
            if best.is_none_or(|b| x < b) {
                best = Some(x);
            }
        }
    }
    best
}

/// 组内相邻声部、上面那个没有歌词时，在声部间距之外再空的一道（÷ 音符字号）
const NO_LYRIC_VOICE_GAP_EM: f64 = 0.6;

/// 分声部之前那几个小节，没分出来的声部只是占位：小节线不画
fn hide_empty_barlines(voices: &mut [PlacedVoice], brace_from_x: f64) {
    for v in voices {
        let mut empty = true;
        let mut any = false;
        for it in &mut v.items {
            if it.x > brace_from_x + 1e-6 {
                break;
            }
            match &it.element {
                MusicElement::Barline(_) => {
                    if any && empty {
                        it.no_barline = true;
                    }
                    empty = true;
                    any = false;
                }
                el => {
                    any = true;
                    if !matches!(el, MusicElement::Note(n) if n.hidden) {
                        empty = false;
                    }
                }
            }
        }
    }
}

struct Pre {
    pv: PlacedVoice,
    ink_bottom: f64,
    digit_bottom: f64,
    lyric_y0: f64,
    split_drop: f64,
}

struct Block {
    group: PlacedGroup,
    sb: SystemBlock,
}

/// 把一首曲子排成若干页
pub fn layout_song(song: &LSong, m: &JianpuGrid, song_index: usize, header_bottom: f64, ink: &Ink, expanded: bool) -> Vec<PlacedPage> {
    let width = content_width(m);
    // 本首的谱组（按页），可改的一份
    let mut pages_src: Vec<Vec<LGroup>> = song.pages.iter().map(|p| p.groups.iter().map(|g| (**g).clone()).collect()).collect();
    move_trailing_section_words(&mut pages_src);
    auto_verse_numbers(&mut pages_src, m);

    let bottom_limit = m.page.height - m.page.margin.bottom;
    let instrumental = !pages_src.iter().any(|pg| pg.iter().any(|g| g.voices.iter().any(|v| !v.line.lyrics.is_empty())));
    let mut meter_cursor: Option<Meter> = song.metadata.meters.first().cloned();
    let mut carry_cursor = 0.0;
    let mut at_song_start = true;
    let last_page = pages_src.len().checked_sub(1);
    let last_group = last_page.and_then(|p| pages_src[p].len().checked_sub(1).map(|g| (p, g)));
    let mut blocks: Vec<Block> = vec![];
    let mut lead_repeat: Vec<bool> = vec![];
    let mut lead_meter: Vec<Option<Meter>> = vec![];
    for (page_idx, src_page) in pages_src.into_iter().enumerate() {
        for (group_idx, group) in src_page.into_iter().enumerate() {
            let group = Rc::new(group);
            let mut y = 0.0;
            let beat_ctx = BeatCtx {
                meter: meter_cursor.clone(),
                carry_in: Some(carry_cursor),
                song_start: at_song_start,
                song_end: last_group == Some((page_idx, group_idx)),
                ..BeatCtx::default()
            };
            at_song_start = false;
            if let Some(v0) = group.voices.first() {
                for el in &v0.line.elements {
                    if let MusicElement::Barline(b) = el {
                        if let Some(tm) = &b.temporary_meter {
                            meter_cursor = Some(tm.clone());
                        }
                    }
                }
            }
            let mut laid_out: Vec<VoiceLine> = group
                .voices
                .iter()
                .enumerate()
                .map(|(vi, row)| {
                    let ctx = BeatCtx {
                        lead_repeat: lead_repeat.get(vi).copied() == Some(true),
                        lead_meter: lead_meter.get(vi).cloned().flatten(),
                        ..beat_ctx.clone()
                    };
                    layout_voice_line(&row.line, &row.ids, m, &ctx)
                })
                .collect();
            lead_repeat = group.voices.iter().map(|v| line_ends_with_forward_repeat(&v.line)).collect();
            lead_meter = group.voices.iter().map(|v| line_end_meter(&v.line)).collect();
            carry_cursor = laid_out.first().map_or(0.0, |l| l.tail);
            for (vi, l) in laid_out.iter_mut().enumerate() {
                let row = &group.voices[vi];
                for it in &mut l.items {
                    it.syllables = vec![None; row.line.lyrics.len()];
                }
                assign_lyrics(&mut l.items, &row.line.lyrics, &row.owners);
            }
            let mut below: Vec<Vec<(usize, crate::place::layers::BelowLine)>> =
                laid_out.iter().enumerate().map(|(vi, l)| below_layer_lines(&group.voices[vi], &l.items, m, &beat_ctx)).collect();
            {
                let mut lines: Vec<SpacedLine> = laid_out.iter().map(|l| SpacedLine::main(&l.items, &l.pad)).collect();
                for b in &below {
                    for (_, bl) in b {
                        lines.push(SpacedLine { items: &bl.laid.items, pad: &bl.laid.pad, bar_base: Some(bl.bar_base), scale: bl.scale });
                    }
                }
                let (_, placed) = place_columns(&lines, m, ink, width);
                drop(lines);
                let mut k = 0;
                for l in laid_out.iter_mut() {
                    apply_placement(&mut l.items, &placed[k]);
                    k += 1;
                }
                for b in below.iter_mut() {
                    for (_, bl) in b.iter_mut() {
                        apply_placement(&mut bl.laid.items, &placed[k]);
                        k += 1;
                    }
                }
            }

            let mut pre: Vec<Pre> = vec![];
            for (vi, (l, bl)) in laid_out.into_iter().zip(below).enumerate() {
                let row = &group.voices[vi];
                let mut items = l.items;
                let mut underlines = compute_underlines(&row.line, &items, m, &l.groups);
                let prelaid: HashMap<usize, VoiceLine> = bl.into_iter().map(|(k, b)| (k, b.laid)).collect();
                let mut layers = place_layers(row, &mut items, m, ink, &beat_ctx, prelaid);
                let mut split_drop: f64 = 0.0;
                for lay in &layers {
                    if let Some(sp) = &lay.split {
                        split_drop = max(split_drop, sp.dy.abs());
                    }
                }
                for u in &mut underlines {
                    let at = items.iter().find(|it| it.x >= u.x0 - 0.01 && it.x <= u.x1 + 0.01);
                    if let Some(d) = at.and_then(|it| it.dy) {
                        u.dy = Some(d);
                    }
                }
                let mut marks = place_marks(&row.line, &items, m, ink);
                let ink_bottom = max(line_ink_bottom(&items, m), below_arcs_bottom(&marks, m, ink));
                let digit_bottom = m.ink.note_height / 2.0;
                let lyric_y0 = max(
                    m.style.vertical.lyric_baseline,
                    digit_bottom + m.style.size.note + max(m.style.size.note * 0.4, ink_bottom - digit_bottom),
                );
                let band = place_band(&items, &mut marks, &mut layers, m, ink, width, instrumental);
                let pv = PlacedVoice {
                    voice: row.clone(),
                    y: 0.0,
                    items,
                    underlines,
                    layers,
                    marks,
                    lyric_y: vec![],
                    band: band.texts,
                    top: band.top,
                    text_top: band.text_top,
                    bottom: band.bottom,
                };
                pre.push(Pre { pv, ink_bottom: max(ink_bottom, band.bottom.unwrap_or(f64::NEG_INFINITY)), digit_bottom, lyric_y0, split_drop });
            }

            // `W:` 说明行
            let texts = &group.texts;
            let mut text_rel = 0.0;
            let mut text_ink_top: Option<f64> = None;
            if let Some(last) = texts.last() {
                let last_ink = ink.text(&last.text, InkTextRole::Words).ink;
                text_rel = pre.first().map_or(-m.ink.note_height / 2.0, |p| p.pv.top)
                    - max(m.style.vertical.slur_gap, m.style.size.words * 0.8)
                    - last_ink.bottom
                    - (texts.len() - 1) as f64 * words_lead(m);
                text_ink_top = Some(text_rel + ink.text(&texts[0].text, InkTextRole::Words).ink.top);
            }
            let head = group_headroom(&pre.iter().map(|p| &p.pv).collect::<Vec<_>>(), texts.len(), text_ink_top, m);
            y += max(0.0, head + GROUP_CLEAR * m.style.size.lyric - m.style.vertical.system_gap);
            let text_y = y + text_rel;

            let n = pre.len();
            for vi in 0..n {
                let (lyric_count, has_inline_voice_next, next_headroom) = {
                    let next = pre.get(vi + 1).map(|p| &p.pv);
                    (
                        pre[vi].pv.voice.line.lyrics.len(),
                        next.is_some_and(|nx| nx.voice.line.elements.iter().any(|el| matches!(el, MusicElement::InlineLayer(l) if l.role == LayerRole::Voice))),
                        next.map(voice_headroom),
                    )
                };
                let p = &mut pre[vi];
                p.pv.y = y;
                p.pv.lyric_y = (0..lyric_count).map(|li| y + p.lyric_y0 + p.split_drop + li as f64 * m.style.vertical.lyric_stack).collect();
                let is_last = vi == n - 1;
                let has_lyrics = lyric_count > 0;
                let consumed = if has_lyrics {
                    p.lyric_y0 + p.split_drop + (lyric_count - 1) as f64 * m.style.vertical.lyric_stack
                } else {
                    p.split_drop
                        + max(0.0, p.ink_bottom - p.digit_bottom)
                        + if is_last { p.digit_bottom } else { NO_LYRIC_VOICE_GAP_EM * m.style.size.note }
                };
                let mut after = if is_last { m.style.vertical.system_gap } else { m.style.vertical.voice_gap };
                if let Some(hr) = next_headroom {
                    after = max(after, hr + m.ink.note_height * 0.6);
                    if has_inline_voice_next {
                        after = max(after, m.style.vertical.voice_gap + split_rise(m));
                    }
                }
                y += consumed + after;
            }

            let ink_bottoms: Vec<f64> = pre.iter().map(|p| p.ink_bottom).collect();
            let mut voices: Vec<PlacedVoice> = pre.into_iter().map(|p| p.pv).collect();
            let has_brace = voices.len() > 1;
            let brace_top = voices.first().map_or(f64::NAN, |v| v.y);
            let brace_bottom = voices.last().map_or(f64::NAN, |v| v.y);
            let sbf = brace_start_x(&voices);
            if let Some(x) = sbf {
                hide_empty_barlines(&mut voices, x);
            }
            if voices.is_empty() {
                if let Some(last) = texts.last() {
                    let last_ink = ink.text(&last.text, InkTextRole::Words).ink;
                    y = max(y, text_y + (texts.len() - 1) as f64 * words_lead(m) + last_ink.bottom + m.style.vertical.system_gap);
                }
            }
            let (top, bottom) = if expanded { slide_block(&voices, &ink_bottoms, ink) } else { (0.0, y) };
            let placed_group = PlacedGroup { group: group.clone(), voices, text_y, brace_top, brace_bottom, has_brace, brace_from_x: sbf, song: song_index };
            blocks.push(Block { group: placed_group, sb: SystemBlock { top, bottom, break_before: group_idx == 0 && page_idx > 0 } });
        }
    }
    // 连谱号的上下花头：只在真会相压时把上一块往下撑
    let reach = brace_reach(m);
    for i in 0..blocks.len().saturating_sub(1) {
        let (bb, bt) = (blocks[i + 1].group.has_brace, blocks[i + 1].group.brace_top);
        let a = &mut blocks[i];
        if !a.group.has_brace || !bb {
            continue;
        }
        let need = a.group.brace_bottom + 2.0 * reach - bt + m.ink.note_height * 0.3;
        if a.sb.bottom < need {
            a.sb.bottom = need;
        }
    }
    let mut first_top = m.page.margin.top + m.page.first_system_top;
    if let Some(g0) = blocks.first().map(|b| &b.group) {
        if header_bottom > 0.0 {
            let v0 = g0.voices.first();
            let mut ink_top = v0.map_or(0.0, |v| v.y) + v0.map_or(-m.ink.note_height / 2.0, |v| v.top);
            if let Some(t0) = g0.group.texts.first() {
                ink_top = min(ink_top, g0.text_y + ink.text(&t0.text, InkTextRole::Words).ink.top);
            }
            first_top = header_bottom + m.style.size.lyric - ink_top;
        }
    }
    let other_top = m.page.margin.top + m.page.first_system_top * 0.35;
    let sbs: Vec<SystemBlock> = blocks.iter().map(|b| b.sb).collect();
    let laid = if expanded {
        let top = m.page.margin.top;
        paginate(&sbs, &PaginateSpec { page_top: &move |_| top, bottom: bottom_limit, gap: m.style.vertical.staff_dist, spread: Some(m.style.vertical.system_spread) })
    } else {
        paginate(
            &sbs,
            &PaginateSpec {
                page_top: &|i| if i == 0 { first_top } else { other_top },
                bottom: if m.page.long_image { f64::INFINITY } else { bottom_limit },
                gap: 0.0,
                spread: None,
            },
        )
    };
    if laid.is_empty() {
        return vec![PlacedPage { groups: vec![], song: song_index, first_of_song: true, ..PlacedPage::default() }];
    }
    let mut slots: Vec<Option<Block>> = blocks.into_iter().map(Some).collect();
    laid.into_iter()
        .enumerate()
        .map(|(i, pg)| {
            let natural = if expanded {
                let mut h = 0.0;
                for &(b, _) in &pg {
                    h += sbs[b].bottom - sbs[b].top;
                }
                Some(h + max(0.0, pg.len() as f64 - 1.0) * m.style.vertical.staff_dist)
            } else {
                None
            };
            let groups = pg
                .into_iter()
                .map(|(b, y)| {
                    let mut g = slots[b].take().unwrap().group;
                    shift_group(&mut g, y);
                    g
                })
                .collect();
            PlacedPage { song: song_index, first_of_song: i == 0, natural, groups, ..PlacedPage::default() }
        })
        .collect()
}

/// 投影档的谱行占位盒（相对组原点）
fn slide_block(voices: &[PlacedVoice], ink_bottoms: &[f64], ink: &Ink) -> (f64, f64) {
    let d = ink.digit("1").ink;
    let base_rel = -(d.top + d.bottom) / 2.0;
    let (note_top, note_bottom) = ink.font_box(true);
    let (_, lyric_bottom) = ink.font_box(false);
    let mut top = f64::INFINITY;
    let mut bottom = f64::NEG_INFINITY;
    for (pv, &ink_bottom) in voices.iter().zip(ink_bottoms) {
        top = min(min(top, pv.y + pv.top), pv.y + base_rel + note_top);
        bottom = max(max(bottom, pv.y + ink_bottom), pv.y + base_rel + note_bottom);
        for &ly in &pv.lyric_y {
            bottom = max(bottom, ly + lyric_bottom);
        }
    }
    if top.is_finite() {
        (top, bottom)
    } else {
        (0.0, 0.0)
    }
}

/// 排一整份文档（`layoutDocument`）。`expanded` = 投影档 / 成书（slide）
pub fn layout_document(songs: &[LSong], m: &JianpuGrid, header_bottoms: &[f64], ink: &Ink, footer_spans: &[f64], expanded: bool) -> PlacedScore {
    let mut pages: Vec<PlacedPage> = vec![];
    for (i, song) in songs.iter().enumerate() {
        pages.extend(layout_song(song, m, i, header_bottoms.get(i).copied().unwrap_or(0.0), ink, expanded));
    }
    if m.page.long_image && pages.len() > 1 {
        let mut merged = PlacedPage { groups: vec![], song: pages[0].song, first_of_song: pages[0].first_of_song, headers: Some(vec![]), ..PlacedPage::default() };
        let mut prev_song = pages[0].song;
        for (i, mut pg) in pages.into_iter().enumerate() {
            if i > 0 {
                let low = lowest_of(&merged) + if pg.song != prev_song { footer_spans.get(prev_song).copied().unwrap_or(0.0) } else { 0.0 };
                let offset;
                if pg.first_of_song {
                    let head_top = m.head.title_baseline - m.style.header.title.size;
                    offset = low + m.style.vertical.system_gap * 2.0 - head_top;
                    merged.headers.as_mut().unwrap().push((pg.song, offset));
                } else {
                    let g0 = pg.groups.first();
                    let mut top = g0.and_then(|g| g.voices.first()).map_or(0.0, |v| v.y);
                    if let Some(g) = g0 {
                        if !g.group.texts.is_empty() {
                            top = min(top, g.text_y - m.style.size.words);
                        }
                    }
                    let mut o = low + m.style.vertical.system_gap * 1.4 - top;
                    if let Some(g) = g0 {
                        o = max(o, low + GROUP_CLEAR * m.style.size.lyric - min_of(g.voices.iter().map(|v| v.y + v.top)));
                    }
                    offset = o;
                }
                for g in &mut pg.groups {
                    shift_group(g, offset);
                }
            }
            prev_song = pg.song;
            merged.groups.extend(pg.groups);
        }
        pages = vec![merged];
    }
    let content_bottom = pages.iter().fold(0.0, |b, p| max(b, lowest_of(p)));
    let content_right = pages.iter().fold(0.0, |r, p| max(r, rightmost_of(p)));
    PlacedScore { pages, metrics: m.clone(), content_bottom, content_right }
}

/// 一页里最右沿的 x（行内坐标）
fn rightmost_of(page: &PlacedPage) -> f64 {
    let mut right: f64 = 0.0;
    for g in &page.groups {
        for v in &g.voices {
            if let Some(last) = v.items.last() {
                right = max(right, last.x);
            }
            for layer in &v.layers {
                if let Some(l) = layer.items.last() {
                    right = max(right, l.x);
                }
            }
        }
    }
    right
}

/// 一页里最下沿的 y（末行歌词或末个声部）
fn lowest_of(page: &PlacedPage) -> f64 {
    let mut bottom: f64 = 0.0;
    for g in &page.groups {
        for v in &g.voices {
            bottom = max(bottom, v.y);
            for &ly in &v.lyric_y {
                bottom = max(bottom, ly);
            }
            bottom = max(bottom, v.bottom.map_or(0.0, |b| v.y + b));
            for l in &v.layers {
                if let Some(sp) = &l.split {
                    bottom = max(bottom, v.y + sp.dy.abs());
                }
            }
        }
    }
    bottom
}

fn shift_group(g: &mut PlacedGroup, dy: f64) {
    g.text_y += dy;
    g.brace_top += dy;
    g.brace_bottom += dy;
    for v in &mut g.voices {
        v.y += dy;
        for ly in &mut v.lyric_y {
            *ly += dy;
        }
    }
}

/// 一行里的音符（不含占位）下标
fn note_slots(row: &LRow) -> Vec<usize> {
    (0..row.line.elements.len())
        .filter(|&i| matches!(&row.line.elements[i], MusicElement::Note(n) if n.placeholder != Some(true)))
        .collect()
}

/// 段落词挂在行末那个音符上时，挪到下一行（同一声部）行首那个音符上（那里已有段落词就不挪）。只改行视图
fn move_trailing_section_words(pages: &mut [Vec<LGroup>]) {
    let mut flat: Vec<&mut LGroup> = pages.iter_mut().flat_map(|p| p.iter_mut()).collect();
    for gi in 0..flat.len().saturating_sub(1) {
        let (head, tail) = flat.split_at_mut(gi + 1);
        let cur = &mut head[gi];
        let next = &mut tail[0];
        for vi in 0..cur.voices.len() {
            let Some(next_row) = next.voices.get(vi) else { continue };
            let ns = note_slots(&cur.voices[vi]);
            let Some(&last) = ns.last() else { continue };
            let Some(&first) = note_slots(next_row).first() else { continue };
            let MusicElement::Note(ln) = &cur.voices[vi].line.elements[last] else { continue };
            let MusicElement::Note(fnote) = &next_row.line.elements[first] else { continue };
            if ln.annotation.as_deref().is_none_or(str::is_empty) || fnote.annotation.is_some() {
                continue;
            }
            let (ann, src) = (ln.annotation.clone(), ln.annotation_source);
            let next_row = Rc::make_mut(&mut next.voices[vi]);
            if let MusicElement::Note(f) = &mut next_row.line.elements[first] {
                f.annotation = ann;
                if src.is_some() {
                    f.annotation_source = src;
                }
            }
            let cur_row = Rc::make_mut(&mut cur.voices[vi]);
            if let MusicElement::Note(l) = &mut cur_row.line.elements[last] {
                l.annotation = None;
                l.annotation_source = None;
            }
        }
    }
}

fn sung(l: &dolce_view::ast::LyricLine) -> bool {
    l.syllables.iter().any(|x| !x.text.is_empty())
}

/// 首字自带印刷段号（`1.圣`）
fn printed(l: &dolce_view::ast::LyricLine) -> bool {
    let t = l.syllables.iter().find(|x| !x.text.is_empty()).map_or("", |x| x.text.as_str());
    let digits = t.chars().take_while(|c| c.is_ascii_digit()).count();
    digits > 0 && t[digits..].starts_with('.')
}

/// 自动段号（样式键 `verse-numbers`）。只改行视图
fn auto_verse_numbers(pages: &mut [Vec<LGroup>], m: &JianpuGrid) {
    let mode = m.style.look.verse_numbers.as_str();
    if mode == "never" {
        return;
    }
    if mode == "auto" {
        let mut verses: f64 = 0.0;
        for g in pages.iter().flatten() {
            for v in &g.voices {
                verses = max(verses, v.line.lyrics.iter().filter(|l| sung(l)).count() as f64);
            }
        }
        if verses <= m.style.look.verse_number_auto_min {
            return;
        }
    }
    for g in pages.iter_mut().flatten() {
        for v in &mut g.voices {
            let lyrics = &v.line.lyrics;
            if lyrics.iter().filter(|l| sung(l)).count() < 2 || lyrics.iter().any(|l| l.annotation.as_deref().is_some_and(|a| !a.is_empty()) || printed(l)) {
                continue;
            }
            let row = Rc::make_mut(v);
            for (k, l) in row.line.lyrics.iter_mut().enumerate() {
                if sung(l) {
                    l.annotation = Some(format!("{}.", k + 1));
                }
            }
        }
    }
}
