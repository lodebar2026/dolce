//! 纵向量（照 `place/vertical.ts`）：头顶让位、倚音落位、音符叠层的顶与底、连谱号伸出量。

use dolce_engrave::accidental::{accidental_lead, accidental_rise};
use dolce_engrave::arpeggio::JP_ARPEGGIO_LEAD;
use dolce_engrave::grace::{grace_bottom, grace_geometry, GraceGeom};
use dolce_engrave::jpglyph::ornament;
use dolce_engrave::jpslide::jp_slide_of;
use dolce_engrave::jptremolo::jp_tremolo_count;
use dolce_engrave::stack::{low_dot_y, stack_bottom, stack_top as stack_top_of};
use dolce_geom::Rect;
use dolce_model::Accidental;
use dolce_view::ast::{MusicElement, NoteElement};

use crate::grid::{jianpu_grace_metrics, jianpu_grace_notes, JianpuGrid};
use crate::ink::Ink;
use crate::model::{PlacedItem, PlacedVoice};
use crate::util::{acc_kind, max, min};

/// 一组倚音画在哪（画与让位共用这一份）。`before` = 前倚音
pub fn grace_layout(note: &NoteElement, before: bool, m: &JianpuGrid, x: f64, baseline: f64) -> GraceGeom {
    let list = if before { &note.grace_before } else { &note.grace_after };
    let dir = if before { -1.0 } else { 1.0 };
    let gn = jianpu_grace_notes(list);
    let gm = jianpu_grace_metrics(m);
    let probe = grace_geometry(&gn, &gm, x, 0.0, dir, m.style.size.note, Some(0.0));
    let center_y = baseline + stack_top(Some(&MusicElement::Note(note.clone())), m, true) - m.ink.stack.gap - grace_bottom(&probe, &gm);
    grace_geometry(&gn, &gm, x, baseline, dir, m.style.size.note, Some(center_y))
}

/// 倚音那几块的墨迹顶（相对基线）；没有倚音为 None
pub fn grace_top(el: &MusicElement, m: &JianpuGrid) -> Option<f64> {
    let MusicElement::Note(n) = el else { return None };
    if n.grace_before.is_empty() && n.grace_after.is_empty() {
        return None;
    }
    let g_ink = m.ink.note_height * 0.5;
    let mut top = f64::INFINITY;
    for before in [true, false] {
        let g = grace_layout(n, before, m, 0.0, 0.0);
        for d in &g.digits {
            top = min(top, d.cy - g_ink / 2.0);
        }
        for d in &g.dots {
            top = min(top, d.cy - d.r);
        }
        for a in &g.accidentals {
            top = min(top, a.ink_cy - a.ink_height / 2.0);
        }
    }
    top.is_finite().then_some(top)
}

/// 上一组末行与本组头顶之间至少留几个歌词字号
pub const GROUP_CLEAR: f64 = 0.75;

/// 一组曲行头顶需要留多少空间（相对首声部基线）
pub fn group_headroom(voices: &[&PlacedVoice], texts: usize, text_top: Option<f64>, m: &JianpuGrid) -> f64 {
    let mut top: f64 = 0.0;
    for v in voices {
        top = min(top, v.top);
        if let Some(t) = v.text_top {
            top = min(top, t - m.ink.note_height);
        }
    }
    if texts > 0 {
        if let Some(t) = text_top {
            top = min(top, t - m.ink.note_height);
        }
    }
    if voices.len() > 1 {
        top = min(top, -brace_reach(m));
    }
    -top
}

/// 多条 `W:` 文字行的行距
pub fn words_lead(m: &JianpuGrid) -> f64 {
    m.style.size.words * 1.35
}

/// `{dsb}` 并排块里上行比主旋律抬高多少
pub fn split_rise(m: &JianpuGrid) -> f64 {
    m.ink.note_height * 1.552
}

/// 连谱号上下花头伸出首/末声部基线多少
pub fn brace_reach(m: &JianpuGrid) -> f64 {
    m.ink.note_height * (0.85 + (1.18 / 4.0) * 2.2)
}

/// 一个声部自己头顶需要多少空间
pub fn voice_headroom(v: &PlacedVoice) -> f64 {
    -min(0.0, v.top)
}

fn rise(acc: Option<&Accidental>, m: &JianpuGrid, with_accidental: bool) -> f64 {
    match acc {
        Some(a) if with_accidental => accidental_rise(acc_kind(a), m.ink.note_height, m.style.look.accidental_scale),
        _ => 0.0,
    }
}

/// 音符「上方堆叠」的顶端（相对基线，负为上）
pub fn stack_top(el: Option<&MusicElement>, m: &JianpuGrid, with_accidental: bool) -> f64 {
    let ink_top = -m.ink.note_height / 2.0;
    let Some(MusicElement::Note(n)) = el else { return ink_top };
    note_stack_top(n, m, with_accidental)
}

pub fn note_stack_top(n: &NoteElement, m: &JianpuGrid, with_accidental: bool) -> f64 {
    let ink_top = -m.ink.note_height / 2.0;
    let mut top = min(ink_top - rise(n.accidental.as_ref(), m, with_accidental), digits_top(n, m));
    for d in stacked_digits(n, m) {
        top = min(top, d.y + ink_top - rise(d.accidental.as_ref(), m, with_accidental));
    }
    top
}

/// 和音里叠上去的一个数字：基线（相对本音基线）
#[derive(Clone, Debug)]
pub struct StackedDigit {
    pub pitch: u32,
    pub octave: i32,
    pub accidental: Option<Accidental>,
    pub y: f64,
}

/// 和音的竖向落点
pub fn stacked_digits(el: &NoteElement, m: &JianpuGrid) -> Vec<StackedDigit> {
    let Some(stack) = el.stack.as_ref().filter(|s| !s.is_empty()) else { return vec![] };
    let half = m.ink.note_height / 2.0;
    let st = &m.ink.stack;
    let mut out = vec![];
    let mut below = stack_top_of(-half, max(0.0, el.octave as f64), st);
    for n in stack {
        let bottom = if n.octave < 0 { low_dot_y(half, 0.0, (-n.octave - 1) as f64, st) + st.dot_radius } else { half };
        let y = below - st.gap * 2.0 - bottom;
        out.push(StackedDigit { pitch: n.pitch, octave: n.octave, accidental: n.accidental.clone(), y });
        below = y + stack_top_of(-half, max(0.0, n.octave as f64), st);
    }
    out
}

/// 数字连同高八度点那一摞的顶
pub fn digits_top(el: &NoteElement, m: &JianpuGrid) -> f64 {
    let half = m.ink.note_height / 2.0;
    let ds = stacked_digits(el, m);
    match ds.last() {
        Some(t) => t.y + stack_top_of(-half, max(0.0, t.octave as f64), &m.ink.stack),
        None => stack_top_of(-half, max(0.0, el.octave as f64), &m.ink.stack),
    }
}

/// 音符那一摞（数字、高八度点、临时记号、倚音）的墨迹顶
pub fn entry_top(el: &MusicElement, m: &JianpuGrid) -> f64 {
    let mut top = min(-m.ink.note_height / 2.0, stack_top(Some(el), m, true));
    if let MusicElement::Note(n) = el {
        if n.multi_rest.is_some() {
            top = min(top, -m.ink.note_height * 1.31);
        }
    }
    if let Some(g) = grace_top(el, m) {
        top = min(top, g);
    }
    top
}

/// 音符上的一个奏法记号字形
#[derive(Clone, Debug)]
pub struct ArticGlyph {
    pub glyph: String,
    pub size: f64,
    pub x: f64,
    pub y: f64,
    pub ink: Rect,
}

/// 记号名是不是贴着音符画、不进带的（换气、震音、滑音）
fn off_band(name: &str) -> bool {
    name == "hx" || jp_tremolo_count(&[name]) > 0 || jp_slide_of(&[name]).is_some()
}

/// 奏法记号往上摞的落点与连同那一摞的墨迹顶
pub fn artic_stack(el: &MusicElement, m: &JianpuGrid, ink: &Ink, gap: f64) -> (Vec<ArticGlyph>, f64) {
    let mut top = entry_top(el, m);
    let mut glyphs = vec![];
    let MusicElement::Note(n) = el else { return (glyphs, top) };
    let nh = m.ink.note_height;
    let mut art_bottom = digits_top(n, m) - gap;
    let ds = stacked_digits(n, m);
    let top_digit = ds.last();
    let acc = match top_digit {
        Some(d) => d.accidental.as_ref(),
        None => n.accidental.as_ref(),
    };
    if let Some(a) = acc {
        art_bottom = min(
            art_bottom,
            top_digit.map_or(0.0, |d| d.y) - nh / 2.0 - accidental_rise(acc_kind(a), nh, m.style.look.accidental_scale) - gap * 1.6,
        );
    }
    for orn in &n.ornaments {
        if off_band(&orn.name) {
            continue;
        }
        let Some(g) = ornament(&orn.name) else { continue };
        let size = m.style.size.note * g.scale;
        let r = ink.smufl(&g.glyph, size);
        let y = art_bottom - r.bottom - orn.level * m.note.level_step;
        let x = -(r.left + r.right) / 2.0;
        let bx = r.offset(x, y);
        glyphs.push(ArticGlyph { glyph: g.glyph.clone(), size, x, y, ink: bx });
        art_bottom = bx.top - m.ink.stack.gap;
        top = min(top, bx.top);
    }
    (glyphs, top)
}

/// 一个音符最低的墨迹（相对基线）
pub fn note_ink_bottom(note: &NoteElement, m: &JianpuGrid) -> f64 {
    stack_bottom(m.ink.note_height / 2.0, note_beams(note), max(0.0, -note.octave as f64), &m.ink.stack)
}

/// 音符下面有几层减时线
pub fn note_beams(note: &NoteElement) -> f64 {
    max(0.0, dolce_base::js::round((note.duration as f64 / 4.0).log2()))
}

/// 一行里最低的墨迹
pub fn line_ink_bottom(items: &[PlacedItem], m: &JianpuGrid) -> f64 {
    let mut bottom = m.ink.note_height / 2.0;
    for it in items {
        let MusicElement::Note(n) = &it.element else { continue };
        if n.hidden {
            continue;
        }
        let b = note_ink_bottom(n, m);
        if b > bottom {
            bottom = b;
        }
    }
    bottom
}

/// 音符前临时记号伸出多宽（含琶音线）
pub fn accidental_lead_of(el: &NoteElement, m: &JianpuGrid) -> f64 {
    let mut w: f64 = 0.0;
    let all = std::iter::once(el.accidental.as_ref()).chain(el.stack.iter().flatten().map(|n| n.accidental.as_ref()));
    for a in all.flatten() {
        w = max(w, accidental_lead(acc_kind(a), m.ink.note_height, m.style.look.accidental_scale));
    }
    if el.ornaments.iter().any(|o| o.name == "arp") {
        w += m.ink.note_height * JP_ARPEGGIO_LEAD;
    }
    w
}
