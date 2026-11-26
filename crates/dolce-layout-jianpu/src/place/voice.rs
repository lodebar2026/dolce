//! 一行一个声部的符号序列（照 `place/voice.ts`）：占位符号、拍位与拍组、减时线分段、歌词音节挂到跟词的符号上。

use std::collections::HashSet;

use dolce_engrave::accidental::ACCIDENTAL_CLEARANCE;
use dolce_engrave::beatgroup::{beat_group_index, beat_group_size, pickup_offset};
use dolce_engrave::grace::grace_advance;
use dolce_model::view::ast::{BarlineElement, BarlineType, LyricLine, MarkType, Meter, MusicElement, ScoreLine};
use dolce_model::view::phraselines::element_quarters;

use crate::grid::{jianpu_grace_metrics, jianpu_grace_notes, JianpuGrid};
use crate::model::{PlacedItem, PlacedUnderline, Syl};
use crate::place::vertical::accidental_lead_of;
use crate::util::max;

/// 并排块右花括号的字形宽（`BRACE_GLYPHS.splitRight.box[2]`）
pub const SPLIT_BRACE_W: f64 = 9.61;

const ZERO_SPAN: dolce_model::base::SourceSpan = dolce_model::base::SourceSpan { line: 0, column: 0, offset: 0, length: 0 };

/// 音符/增时线的时值（拍）
pub fn element_beats(el: &MusicElement) -> f64 {
    element_quarters(el).to_float()
}

fn is_beamed(el: &MusicElement) -> bool {
    matches!(el, MusicElement::Note(n) if n.duration > 4)
}

fn plain_barline(el: &MusicElement) -> Option<&BarlineElement> {
    match el {
        MusicElement::Barline(b)
            if b.ornaments.is_empty() && b.annotation.is_none() && b.temporary_meter.is_none() && b.temporary_key.is_none() && b.repeat_forward_after != Some(true) =>
        {
            Some(b)
        }
        _ => None,
    }
}

fn plain_normal(el: &MusicElement) -> bool {
    plain_barline(el).is_some_and(|b| b.kind == BarlineType::Normal)
}

pub fn takes_lyric(el: &MusicElement) -> bool {
    match el {
        MusicElement::Note(n) => n.lyric_anchor,
        MusicElement::Sustain(s) => s.lyric_anchor,
        _ => false,
    }
}

/// 每个元素下标的多连音比例 (num, den)
pub fn tuplet_ratios(line: &ScoreLine) -> Vec<Option<(f64, f64)>> {
    let count = line.elements.len();
    let mut out = vec![None; count];
    for mk in &line.marks {
        if mk.kind != MarkType::Tuplet {
            continue;
        }
        let n = mk.end - mk.start + 1;
        if n <= 1 {
            continue;
        }
        let mut i = mk.start;
        while i <= mk.end && i < count as i64 {
            if i >= 0 {
                out[i as usize] = Some(((n - 1) as f64, n as f64));
            }
            i += 1;
        }
    }
    out
}

/// 把一行歌词的音节按顺序发给该行「跟词」的符号。`owners` 与 `lyrics` 平行（各音节的归属音 id）
pub fn assign_lyrics(items: &mut [PlacedItem], lyrics: &[LyricLine], owners: &[Vec<Option<i64>>]) {
    for (verse, line) in lyrics.iter().enumerate() {
        let mut cursor = 0usize;
        for item in items.iter_mut() {
            if !takes_lyric(&item.element) {
                continue;
            }
            let k = cursor;
            cursor += 1;
            let syl = line.syllables.get(k).filter(|s| !s.text.is_empty()).map(|s| Syl {
                syl: s.clone(),
                owner: owners.get(verse).and_then(|o| o.get(k).copied().flatten()),
            });
            if item.syllables.len() <= verse {
                item.syllables.resize(verse + 1, None);
            }
            item.syllables[verse] = syl;
        }
    }
}

/// 一行的拍组上下文
#[derive(Clone, Debug, Default)]
pub struct BeatCtx {
    pub meter: Option<Meter>,
    pub carry_in: Option<f64>,
    pub song_start: bool,
    pub song_end: bool,
    pub lead_repeat: bool,
    pub lead_meter: Option<Meter>,
}

/// `layoutVoiceLine` 的结果
pub struct VoiceLine {
    pub items: Vec<PlacedItem>,
    pub width: f64,
    pub groups: Vec<f64>,
    pub tail: f64,
    pub pad: Vec<f64>,
}

struct Flat {
    el: MusicElement,
    src: i64,
    /// 换了样子 / 补出来的（TS `srcMap` 里的新对象，`idOf` 查不到）
    made: bool,
}

/// 一行一个声部的符号序列、拍位与拍组。`ids` 与 `voice.elements` 平行（缺的当没有 id）
pub fn layout_voice_line(voice: &ScoreLine, ids: &[Option<i64>], m: &JianpuGrid, ctx: &BeatCtx) -> VoiceLine {
    let els = &voice.elements;
    let inter: Vec<usize> = (0..els.len()).filter(|&i| matches!(els[i], MusicElement::Note(_) | MusicElement::Sustain(_) | MusicElement::Barline(_))).collect();
    let mut flat: Vec<Flat> = vec![];
    for (p, &i) in inter.iter().enumerate() {
        let el = &els[i];
        if p > 0 {
            if let MusicElement::Barline(prev) = &els[inter[p - 1]] {
                if prev.kind != BarlineType::Invisible && prev.kind != BarlineType::Hidden && plain_normal(el) {
                    continue;
                }
            }
        }
        let mut j = p + 1;
        while j < inter.len() && plain_normal(&els[inter[j]]) {
            j += 1;
        }
        let next_rs = j < inter.len() && matches!(&els[inter[j]], MusicElement::Barline(b) if b.kind == BarlineType::RepeatStart);
        if let Some(b) = plain_barline(el) {
            if next_rs && matches!(b.kind, BarlineType::Normal | BarlineType::Double | BarlineType::End) {
                continue;
            }
        }
        flat.push(Flat { el: el.clone(), src: i as i64, made: false });
    }
    // 行末的 `|:` 画成普通线、`:|:` 画成 `:|`
    if let Some(last) = flat.last_mut() {
        if let MusicElement::Barline(b) = &last.el {
            if forward_repeat_at_end(b) {
                let kind = match b.kind {
                    BarlineType::RepeatBoth => BarlineType::RepeatEnd,
                    BarlineType::RepeatStart => BarlineType::Normal,
                    k => k,
                };
                let plain = BarlineElement { kind, repeat_forward_after: Some(false), ..b.clone() };
                last.el = MusicElement::Barline(plain);
                last.made = true;
            }
        }
    }
    if ctx.lead_repeat {
        match flat.first_mut() {
            Some(Flat { el: MusicElement::Barline(head), made, .. }) => {
                if head.kind == BarlineType::Normal {
                    head.kind = BarlineType::RepeatStart;
                    *made = true;
                }
            }
            _ => flat.insert(
                0,
                Flat {
                    el: MusicElement::Barline(BarlineElement {
                        kind: BarlineType::RepeatStart,
                        ornaments: vec![],
                        temporary_meter: None,
                        temporary_key: None,
                        annotation: None,
                        repeat_forward_after: None,
                        code: "|:".into(),
                        source: ZERO_SPAN,
                    }),
                    src: -1,
                    made: true,
                },
            ),
        }
    }
    if let Some(lm) = &ctx.lead_meter {
        match flat.first_mut() {
            Some(Flat { el: MusicElement::Barline(head), made, .. }) => {
                if head.temporary_meter.is_none() {
                    head.temporary_meter = Some(lm.clone());
                    *made = true;
                }
            }
            _ => flat.insert(
                0,
                Flat {
                    el: MusicElement::Barline(BarlineElement {
                        kind: BarlineType::Invisible,
                        ornaments: vec![],
                        temporary_meter: Some(lm.clone()),
                        temporary_key: None,
                        annotation: None,
                        repeat_forward_after: None,
                        code: String::new(),
                        source: ZERO_SPAN,
                    }),
                    src: -1,
                    made: true,
                },
            ),
        }
    }
    let ratios = tuplet_ratios(voice);
    // `{dsb}` 并排块的花括号让位
    let mut split_at: Vec<i64> = vec![];
    let mut split_end: HashSet<usize> = HashSet::new();
    for (i, el) in els.iter().enumerate() {
        let MusicElement::InlineLayer(l) = el else { continue };
        if l.role != dolce_model::view::ast::LayerRole::Voice {
            continue;
        }
        split_at.push(i as i64);
        let total: f64 = l.elements.iter().map(element_beats).sum();
        let Some(mut at) = flat.iter().position(|f| f.src > i as i64) else { continue };
        let mut acc = 0.0;
        while at < flat.len() {
            acc += element_beats(&flat[at].el);
            if acc >= total - 1e-6 {
                break;
            }
            at += 1;
        }
        let mut after = at;
        while after + 1 < flat.len() && matches!(flat[after + 1].el, MusicElement::Barline(_)) {
            after += 1;
        }
        if after + 1 < flat.len() {
            split_end.insert(at);
        }
    }
    let mut items: Vec<PlacedItem> = vec![];
    let mut beat = 0.0;
    for (i, f) in flat.iter().enumerate() {
        let r = if f.src >= 0 { ratios.get(f.src as usize).copied().flatten() } else { None };
        let beats = element_beats(&f.el) * r.map_or(1.0, |(n, d)| n / d);
        items.push(PlacedItem {
            index: i,
            src_index: f.src,
            x: 0.0,
            advance: 0.0,
            element: f.el.clone(),
            id: if f.made || f.src < 0 { None } else { ids.get(f.src as usize).copied().flatten() },
            beat,
            beats,
            syllables: vec![],
            dy: None,
            no_barline: false,
        });
        if matches!(f.el, MusicElement::Barline(_)) {
            beat = 0.0;
        } else {
            beat += beats;
        }
    }
    let (groups, tail) = beat_groups(&items, ctx);
    let mut pad = vec![0.0; flat.len()];
    let mut x = 0.0;
    let gm = jianpu_grace_metrics(m);
    for i in 0..flat.len() {
        let el = &flat[i].el;
        let src_index = items[i].src_index;
        items[i].x = x;
        let next = flat.get(i + 1).map(|f| &f.el);
        let mut advance = match next {
            None => {
                if matches!(el, MusicElement::Barline(_)) {
                    0.0
                } else {
                    m.note.note_step
                }
            }
            Some(n) if matches!(el, MusicElement::Barline(_)) || matches!(n, MusicElement::Barline(_)) => m.note.barline_space,
            Some(n) => {
                if is_beamed(el) && is_beamed(n) && groups[i] == groups[i + 1] {
                    m.note.beamed_note_step
                } else {
                    m.note.note_step
                }
            }
        };
        if let MusicElement::Note(n) = el {
            advance += m.note.aug_dot_step * n.dots as f64;
        }
        if let MusicElement::Barline(b) = el {
            if b.ornaments.iter().any(|o| o.name == "sbf") {
                pad[i] += m.ink.note_height * 1.5;
            }
        }
        let next_lead = match next {
            Some(MusicElement::Note(n)) => accidental_lead_of(n, m),
            _ => 0.0,
        };
        if next_lead > 0.0 {
            advance += next_lead + m.ink.note_height * ACCIDENTAL_CLEARANCE;
        }
        if let Some(MusicElement::Note(n)) = next {
            if !n.grace_before.is_empty() {
                advance += grace_advance(&jianpu_grace_notes(&n.grace_before), &gm);
            }
        }
        if let MusicElement::Note(n) = el {
            if !n.grace_after.is_empty() {
                advance += grace_advance(&jianpu_grace_notes(&n.grace_after), &gm);
            }
        }
        if split_end.contains(&i) {
            pad[i] += SPLIT_BRACE_W + m.ink.note_height * 0.95;
        }
        if next.is_some() {
            let next_at = flat[i + 1].src;
            for &at in &split_at {
                if at > src_index && at < next_at {
                    pad[i] += SPLIT_BRACE_W + m.ink.note_height * 0.95;
                    break;
                }
            }
        }
        advance += pad[i];
        items[i].advance = advance;
        x += advance;
    }
    VoiceLine { items, width: x, groups, tail, pad }
}

/// 这条小节线带不带「下一小节起反复」
pub fn forward_repeat_at_end(b: &BarlineElement) -> bool {
    b.kind == BarlineType::RepeatStart || b.kind == BarlineType::RepeatBoth || b.repeat_forward_after == Some(true)
}

/// 一行的末个占位符号是带反复起点的小节线
pub fn line_ends_with_forward_repeat(voice: &ScoreLine) -> bool {
    for el in voice.elements.iter().rev() {
        match el {
            MusicElement::Note(_) | MusicElement::Sustain(_) => return false,
            MusicElement::Barline(b) => return forward_repeat_at_end(b),
            _ => {}
        }
    }
    false
}

/// 一行的末个占位符号是带转拍号的小节线：返回那个拍号
pub fn line_end_meter(voice: &ScoreLine) -> Option<Meter> {
    for el in voice.elements.iter().rev() {
        match el {
            MusicElement::Note(_) | MusicElement::Sustain(_) => return None,
            MusicElement::Barline(b) => return b.temporary_meter.clone(),
            _ => {}
        }
    }
    None
}

struct Seg {
    from: usize,
    to: usize,
    meter: Option<Meter>,
    carried: bool,
}

/// 谱面拍组（`beatGroups`）
fn beat_groups(items: &[PlacedItem], ctx: &BeatCtx) -> (Vec<f64>, f64) {
    let mut segs: Vec<Seg> = vec![];
    let mut cur = ctx.meter.clone();
    let mut from = 0;
    let carry_in = ctx.carry_in.unwrap_or(0.0);
    let mut carried = carry_in > 0.0;
    for (i, it) in items.iter().enumerate() {
        let MusicElement::Barline(b) = &it.element else { continue };
        segs.push(Seg { from, to: i, meter: cur.clone(), carried });
        if let Some(tm) = &b.temporary_meter {
            cur = Some(tm.clone());
        }
        carried = b.kind == BarlineType::Hidden;
        from = i + 1;
    }
    segs.push(Seg { from, to: items.len(), meter: cur, carried });
    let dur_of = |s: &Seg| -> f64 {
        let mut d = 0.0;
        for it in &items[s.from..s.to] {
            d += it.beats;
        }
        d
    };
    let mut last_filled: i64 = -1;
    for (si, s) in segs.iter().enumerate() {
        if s.to > s.from {
            last_filled = si as i64;
        }
    }
    let mut out = vec![0.0; items.len()];
    let mut tail = 0.0;
    let n = segs.len();
    for (si, seg) in segs.iter().enumerate() {
        let size = seg.meter.as_ref().map_or(1.0, |mt| beat_group_size(mt.numerator, mt.denominator));
        let mut offset = if seg.carried { carry_in } else { 0.0 };
        let open_tail = si == n - 1 && !(si == 0 && ctx.song_start);
        if !seg.carried && !open_tail {
            if let Some(mt) = &seg.meter {
                let next = segs.get(si + 1);
                let skip = pickup_offset((mt.numerator * 4.0) / mt.denominator, dur_of(seg), ctx.song_end && si as i64 == last_filled, next.map(dur_of));
                if skip > 0.0 {
                    offset = skip;
                }
            }
        }
        for i in seg.from..seg.to {
            out[i] = beat_group_index(items[i].beat, offset, size);
        }
        if si == n - 1 && seg.to > seg.from {
            tail = offset + dur_of(seg);
        }
    }
    (out, tail)
}

/// 同一拍组内连续的减时线音符连成一条线，跨组断开（`~`/`^` 可强制连断）
pub fn compute_underlines(voice: &ScoreLine, items: &[PlacedItem], m: &JianpuGrid, group_at: &[f64]) -> Vec<PlacedUnderline> {
    let mut force_join: HashSet<i64> = HashSet::new();
    let mut force_split: HashSet<i64> = HashSet::new();
    let mut seen: i64 = if items.first().is_some_and(|it| it.src_index == -1) { 1 } else { 0 };
    for el in &voice.elements {
        match el {
            MusicElement::Note(_) | MusicElement::Sustain(_) | MusicElement::Barline(_) => seen += 1,
            MusicElement::BeatBoundary(b) => {
                if b.behavior == dolce_model::view::ast::Behavior::Join {
                    force_join.insert(seen - 1);
                } else {
                    force_split.insert(seen - 1);
                }
            }
            _ => {}
        }
    }
    let level_of = |it: &PlacedItem| -> f64 {
        match &it.element {
            MusicElement::Note(n) if !n.hidden => max(0.0, (n.duration as f64 / 4.0).log2()),
            _ => 0.0,
        }
    };
    let mut out = vec![];
    let max_level = items.iter().map(level_of).fold(0.0, max);
    let mut level = 1.0;
    while level <= max_level {
        let mut run: Option<(usize, usize)> = None;
        let flush = |run: &mut Option<(usize, usize)>, out: &mut Vec<PlacedUnderline>| {
            if let Some((a, b)) = run.take() {
                out.push(PlacedUnderline { level, x0: items[a].x - m.note.beam_half_span, x1: items[b].x + m.note.beam_half_span, dy: None });
            }
        };
        for (i, it) in items.iter().enumerate() {
            if level_of(it) < level {
                flush(&mut run, &mut out);
                continue;
            }
            let ii = i as i64;
            let breaks = i == 0 || force_split.contains(&(ii - 1)) || (!force_join.contains(&(ii - 1)) && group_at[i - 1] != group_at[i]);
            if run.is_some() && breaks {
                flush(&mut run, &mut out);
            }
            run = Some(match run {
                None => (i, i),
                Some((a, _)) => (a, i),
            });
        }
        flush(&mut run, &mut out);
        level += 1.0;
    }
    out
}
