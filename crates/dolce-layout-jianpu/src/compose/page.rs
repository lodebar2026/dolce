//! 一页：谱组、声部、连谱号的绘制（照 `compose/page.ts`）。内联层（`paint_layer`）与 `paint_voice` 互相调用，同在本文件。

use std::collections::HashSet;

use dolce_engrave::dash::{sustain_dash, DashStyle};
use dolce_engrave::jpnumber::beam_line;
use dolce_engrave::stack::{beam_y, high_dot_y, low_dot_y, StackStyle};
use dolce_scene::{Edge, Identity, IdentityKind, Node, Role};
use dolce_text::syllable::syllable_run;
use dolce_text::CompressMode;
use dolce_view::ast::{LyricLine, MusicElement};

use super::barline::paint_barline;
use super::brace::{brace_item, paint_brace, BraceKind};
use super::ctx::{add_barline_owner, band_of, digit_item, digit_origin, dot, eid, font, ident, items_key, rect, text, Ctx};
use super::header::paint_header;
use super::lyric::{paint_join_brace, paint_lyric_annotations, paint_syllables};
use super::marks::paint_mark;
use super::note::{paint_band, paint_note};
use crate::model::{PlacedGroup, PlacedItem, PlacedLayer, PlacedMark, PlacedPage, PlacedText, PlacedUnderline, PlacedVoice};
use crate::place::vertical::{note_beams, words_lead};
use crate::util::{max, min};

/// 把一组声部切成若干「小节线贯穿块」（声部下标）：带歌词（或曲中别处带过词）的声部是一块的末尾
fn barline_blocks(voices: &[PlacedVoice], sung: &HashSet<usize>) -> Vec<Vec<usize>> {
    let mut blocks = vec![];
    let mut cur = vec![];
    for (vi, v) in voices.iter().enumerate() {
        cur.push(vi);
        if !v.voice.line.lyrics.is_empty() || sung.contains(&vi) {
            blocks.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        blocks.push(cur);
    }
    blocks
}

/// 一首里在任一行带过词的声部（按组内序号）
fn sung_voices(c: &Ctx, song: usize) -> HashSet<usize> {
    let mut out = HashSet::new();
    if let Some(s) = c.doc.songs.get(song) {
        for pg in &s.pages {
            for g in &pg.groups {
                for (vi, v) in g.voices.iter().enumerate() {
                    if !v.line.lyrics.is_empty() {
                        out.insert(vi);
                    }
                }
            }
        }
    }
    out
}

struct SystemMetrics {
    notes_left: f64,
    brace_x: f64,
    label_left: f64,
}

/// 一组（system）的左缘布局：段号占位 → 细竖线 → 连谱号
fn system_metrics(c: &Ctx, group: &PlacedGroup, page: &PlacedPage) -> SystemMetrics {
    let m = c.m;
    let mc = c.env.mc;
    let label_font = font(&m.style.font.text.family, m.style.size.verse_num, false);
    let width_of = |g: &PlacedGroup| -> f64 {
        let mut w: f64 = 0.0;
        for v in &g.voices {
            for line in &v.voice.line.lyrics {
                if let Some(a) = line.annotation.as_deref().filter(|s| !s.is_empty()) {
                    w = max(w, label_font.measure_text(mc, a));
                }
            }
        }
        w
    };
    let label_width = width_of(group);
    let mut slot_width = label_width;
    for g in &page.groups {
        slot_width = max(slot_width, width_of(g));
    }
    let notes_left = m.page.margin.left;
    let label_to_lyric = m.style.size.verse_num * 0.2;
    let line_to_label = m.style.size.verse_num * 0.55;
    let lyric_font = font(&m.style.font.lyric.family, m.style.size.lyric, false);
    let mode = CompressMode::parse(&m.style.look.punct_compress);
    let mut lead: f64 = 0.0;
    for v in &group.voices {
        for line in &v.voice.line.lyrics {
            if let Some(syl) = line.syllables.iter().find(|x| !x.text.is_empty()) {
                lead = max(lead, syllable_run(&syl.text, &lyric_font, mc, mode).lead);
            }
        }
    }
    let first_char_half = m.style.size.lyric * 0.5 + lead;
    let label_slot = if slot_width > 0.0 { first_char_half + label_to_lyric + slot_width + line_to_label } else { 0.0 };
    let thin_x = notes_left - max(max(label_slot, m.note.barline_space * 0.55), if lead > 0.0 { first_char_half + label_to_lyric } else { 0.0 });
    let brace_x = thin_x - m.ink.note_height * 0.55;
    let mut label_left = notes_left;
    for v in &group.voices {
        for (verse, line) in v.voice.line.lyrics.iter().enumerate() {
            let Some(ann) = line.annotation.as_deref().filter(|s| !s.is_empty()) else { continue };
            let w = label_font.measure_text(mc, ann);
            let gap = max(line.annotation_gap / 100.0, 0.1) * m.style.size.lyric;
            let first = v.items.iter().find(|it| matches!(it.syllables.get(verse), Some(Some(_))));
            let mut x0 = notes_left - first_char_half;
            if let Some(first) = first {
                let syl = &first.syllables[verse].as_ref().unwrap().syl;
                let s = format!("{}{}", syl.text, syl.trailing_punctuation.as_deref().unwrap_or(""));
                let run = syllable_run(&s, &lyric_font, mc, mode);
                x0 = notes_left + first.x - run.lead - run.body / 2.0;
            }
            label_left = min(label_left, x0 - gap - w);
        }
    }
    SystemMetrics { notes_left, brace_x, label_left }
}

/// 整页的 system 左缘（多声部时是连谱号，单声部时是音符起点 / 段号左缘）
pub fn system_left(c: &Ctx, page: &PlacedPage) -> f64 {
    let mut left = c.m.page.margin.left;
    for group in &page.groups {
        let g = system_metrics(c, group, page);
        left = min(left, if group.has_brace { g.brace_x } else { min(g.notes_left, g.label_left) });
    }
    left
}

pub fn paint_page(c: &mut Ctx, page: &PlacedPage, page_index: usize) -> Node {
    let m = c.m;
    let env = c.env;
    let mut root = Node::group();
    if page.first_of_song {
        let sl = system_left(c, page);
        paint_header(c, &mut root, page.song, sl);
    }
    for &(song, dy) in page.headers.iter().flatten() {
        let mut hg = Node::group();
        let sl = system_left(c, page);
        paint_header(c, &mut hg, song, sl);
        hg.shift(0.0, dy);
        root.push(hg);
    }
    for group in &page.groups {
        let mut sys = Node::group();
        sys.add_class("system");
        sys.id = Some(ident(IdentityKind::System));
        let texts = &group.group.texts;
        if !texts.is_empty() {
            let f = font(&m.style.font.text.family, m.style.size.words, false);
            for (i, t) in texts.iter().enumerate() {
                sys.push(text(&t.text, m.page.margin.left, group.text_y + i as f64 * words_lead(m), f.clone(), c.ink, env));
            }
        }
        let sm = system_metrics(c, group, page);
        let brace_at = match group.brace_from_x {
            Some(bx) => sm.notes_left + bx - m.ink.note_height * 1.41,
            None => sm.brace_x,
        };
        if group.has_brace {
            paint_brace(c, &mut sys, brace_at, group.brace_top, group.brace_bottom);
            let name_font = font(&m.style.font.text.family, m.style.size.chord, false);
            for v in &group.voices {
                let Some(caption) = v.voice.line.caption.as_deref().filter(|s| !s.is_empty()) else { continue };
                let w = name_font.measure_text(env.mc, caption);
                sys.push(text(caption, brace_at - 6.0 - w, v.y + m.ink.note_height * 0.35, name_font.clone(), c.ink, env));
            }
        }
        let span_barlines = group.voices.len() > 1;
        for voice in &group.voices {
            paint_voice(c, &mut sys, &VoiceArgs::of(voice), page_index, span_barlines);
        }
        if span_barlines {
            let sung = sung_voices(c, group.song);
            for block in barline_blocks(&group.voices, &sung) {
                let first = &group.voices[block[0]];
                let last = &group.voices[*block.last().unwrap()];
                // 同一处（按横坐标）的小节线共用这一条线（Map 以 x 为键，后设的覆盖）
                let mut drawn: Vec<(f64, usize)> = vec![];
                let key = items_key(&first.items);
                for (at, it) in first.items.iter().enumerate() {
                    if !matches!(it.element, MusicElement::Barline(_)) || it.dy.is_some() {
                        continue;
                    }
                    if let Some(gi) = paint_barline(c, &mut sys, m.page.margin.left + it.x, first.y, it, key, at, last.y - first.y) {
                        match drawn.iter_mut().find(|(x, _)| same_key(*x, it.x)) {
                            Some(slot) => slot.1 = gi,
                            None => drawn.push((it.x, gi)),
                        }
                    }
                }
                for &vi in &block {
                    let voice = &group.voices[vi];
                    let mut prev: Option<i64> = None;
                    for it in &voice.items {
                        match it.element {
                            MusicElement::Barline(_) => {
                                let g = drawn.iter().find(|(x, _)| same_key(*x, it.x)).map(|d| d.1);
                                if let (Some(gi), Some(id)) = (g, prev) {
                                    add_barline_owner(&mut sys.k[gi], id, Edge::After);
                                }
                            }
                            MusicElement::Sustain(_) => {}
                            _ => prev = it.id.or(prev),
                        }
                    }
                }
            }
        }
        root.push(sys);
    }
    root
}

/// `Map` 键的 SameValueZero
fn same_key(a: f64, b: f64) -> bool {
    a == b || (a.is_nan() && b.is_nan())
}

/// 画一个声部要的那几样（TS 直接传 `PlacedVoice`；并排块上行借这套画法时另拼一份）
pub struct VoiceArgs<'b> {
    pub lyrics: &'b [LyricLine],
    pub passes: Option<&'b [f64]>,
    pub y: f64,
    pub items: &'b [PlacedItem],
    pub underlines: &'b [PlacedUnderline],
    /// 减时线的 `dy` 一律当 0（并排块上行）
    pub zero_dy: bool,
    pub marks: &'b [PlacedMark],
    pub band: &'b [PlacedText],
    pub lyric_y: &'b [f64],
    pub layers: &'b [PlacedLayer],
}

impl<'b> VoiceArgs<'b> {
    pub fn of(v: &'b PlacedVoice) -> VoiceArgs<'b> {
        VoiceArgs {
            lyrics: &v.voice.line.lyrics,
            passes: v.voice.passes.as_deref(),
            y: v.y,
            items: &v.items,
            underlines: &v.underlines,
            zero_dy: false,
            marks: &v.marks,
            band: &v.band,
            lyric_y: &v.lyric_y,
            layers: &v.layers,
        }
    }
}

pub fn paint_voice(c: &mut Ctx, root: &mut Node, voice: &VoiceArgs, page_index: usize, skip_barlines: bool) {
    let m = c.m;
    let env = c.env;
    let left = m.page.margin.left;
    let baseline = voice.y;
    let key = items_key(voice.items);
    c.band = Some((key, band_of(voice.band)));
    c.band_origin = (left, baseline);
    let mut lyric_right: Vec<f64> = vec![];
    let mut prev: Option<i64> = None;
    // 画了主数字的音符：(落点 x, 组在 root 里的下标)；减时线按它记两端接哪两个数字（TS `nums`）
    let mut nums: Vec<(f64, usize)> = vec![];

    for (at, it) in voice.items.iter().enumerate() {
        c.pass = voice.passes.and_then(|p| if it.src_index < 0 { None } else { p.get(it.src_index as usize).copied() });
        let x = left + it.x;
        let base = baseline + it.dy.unwrap_or(0.0);
        match &it.element {
            MusicElement::Barline(_) => {
                if !skip_barlines || it.dy.is_some() {
                    let g = paint_barline(c, root, x, base, it, key, at, 0.0);
                    if let (Some(gi), Some(id)) = (g, prev) {
                        add_barline_owner(&mut root.k[gi], id, Edge::After);
                    }
                }
                continue;
            }
            MusicElement::Sustain(_) => {
                let mut line = if c.slide {
                    let (dx, dy, _) = digit_origin(c, "-");
                    digit_item("-", x + dx, base + dy, c.digit_font.clone(), c.ink)
                } else {
                    sustain_dash(x, base, &DashStyle { font: c.digit_font.clone(), color: c.ink }, env)
                };
                if let Some(sid) = it.id {
                    line.id = Some(Identity { id: Some(eid(sid)), pass: c.pass.map(|p| p as u32), ..ident(IdentityKind::Sustain) });
                }
                root.push(line);
                paint_band(c, root, key, at, None, it.id);
                paint_syllables(c, root, it, x, voice.lyric_y, Some(&mut lyric_right));
                continue;
            }
            _ => {}
        }
        if let Some(gi) = paint_note(c, root, it, key, at, x, base) {
            nums.push((it.x, gi));
        }
        prev = it.id.or(prev);
        paint_syllables(c, root, it, x, voice.lyric_y, Some(&mut lyric_right));
    }
    c.pass = None;

    for u in voice.underlines {
        let dy = if voice.zero_dy { 0.0 } else { u.dy.unwrap_or(0.0) };
        let y = baseline + dy + beam_y(m.ink.note_height / 2.0, u.level, &m.ink.stack);
        let mut b = beam_line(u.level, left + u.x0, left + u.x1, y, m.style.stroke.beam, c.ink);
        let mut under = nums.iter().filter(|n| n.0 >= u.x0 - 0.5 && n.0 <= u.x1 + 0.5).map(|n| n.1 as u32);
        if let (Some(l), Some(Role::BeamLine { ends, .. })) = (under.next(), &mut b.role) {
            *ends = Some([l, under.next_back().unwrap_or(l)]);
        }
        root.push(b);
    }

    paint_lyric_annotations(c, root, voice.lyrics, voice.items, voice.lyric_y, left);
    paint_join_brace(c, root, voice.lyrics, voice.lyric_y, &lyric_right);

    for mk in voice.marks {
        paint_mark(c, root, mk, left, baseline + mk.dy.unwrap_or(0.0));
    }
    for layer in voice.layers {
        paint_layer(c, root, layer, left, baseline, page_index);
    }
}

/// 内联层（小字层、`{dsb}` 并排块）
pub fn paint_layer(c: &mut Ctx, root: &mut Node, layer: &PlacedLayer, left: f64, baseline: f64, page_index: usize) {
    let m = c.m;
    let env = c.env;
    if let Some(split) = &layer.split {
        let args = VoiceArgs {
            lyrics: &split.line.lyrics,
            passes: None,
            y: baseline + split.dy,
            items: &layer.items,
            underlines: &layer.underlines,
            zero_dy: true,
            marks: &split.marks,
            band: split.band.as_deref().unwrap_or(&[]),
            lyric_y: &[],
            layers: &[],
        };
        paint_voice(c, root, &args, page_index, false);
        let y0 = baseline + split.brace_top;
        let y1 = baseline + split.brace_bottom;
        if let Some(bx) = split.brace_left_x {
            root.push(brace_item(c.ink, left + bx, y0, y1, -1, BraceKind::Split));
        }
        if let Some(bx) = split.brace_right_x {
            root.push(brace_item(c.ink, left + bx, y0, y1, 1, BraceKind::Split));
        }
        return;
    }
    let y = baseline + layer.y.unwrap_or(-m.ink.note_height);
    let cs = m.style.size.cue;
    let f = font(&m.style.font.text.family, c.digit_font.size * cs, false);
    let st = &m.ink.stack;
    let cue = StackStyle { gap: st.gap * cs, dot_radius: st.dot_radius * cs, beam_width: st.beam_width * cs };
    for it in &layer.items {
        let x = left + it.x;
        match &it.element {
            MusicElement::Barline(_) => {
                root.push(rect(c.ink, x - 0.6, y - 10.0, 1.2, 20.0));
                continue;
            }
            MusicElement::Sustain(_) => {
                root.push(sustain_dash(x, y, &DashStyle { font: f.clone(), color: c.ink }, env));
                continue;
            }
            _ => {}
        }
        let MusicElement::Note(n) = &it.element else { continue };
        if n.hidden {
            continue;
        }
        let ch = n.pitch.to_string();
        let b = f.char_bound(env.mc, &ch);
        root.push(text(&ch, x - (b.left + b.right) / 2.0, y - (b.top + b.bottom) / 2.0, f.clone(), c.ink, env));
        let h = m.ink.note_height * cs;
        for i in 0..n.octave.max(0) {
            root.push(dot(c.ink, x, y + high_dot_y(-h / 2.0, i as f64, &cue), cue.dot_radius));
        }
        for i in 0..(-n.octave).max(0) {
            root.push(dot(c.ink, x, y + low_dot_y(h / 2.0, note_beams(n), i as f64, &cue), cue.dot_radius));
        }
    }
    for u in &layer.underlines {
        root.push(beam_line(u.level, left + u.x0, left + u.x1, y + beam_y((m.ink.note_height * cs) / 2.0, u.level, &cue), cue.beam_width, c.ink));
    }
}
