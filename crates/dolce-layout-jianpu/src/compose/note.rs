//! 音符：数字、升降号、八度点、附点、和弦与注释、倚音、`&xx` 记号（照 `compose/note.ts`）。

use dolce_engrave::accidental::{AccidentalGlyph, AccidentalStyle, DigitRef};
use dolce_engrave::arpeggio::{arpeggio_group, JP_ARPEGGIO_SIZE};
use dolce_engrave::augdot::aug_dot_center;
use dolce_engrave::breath::breath_path;
use dolce_engrave::chord::{chord_text_segs, layout_harmony_segs};
use dolce_engrave::jpglyph::{accidental_glyph, is_accomp_bracket};
use dolce_engrave::jpslide::{jp_slide_arrow, jp_slide_of};
use dolce_engrave::jptremolo::{jp_tremolo_count, jp_tremolo_strokes};
use dolce_engrave::prims::music_text;
use dolce_engrave::spacing::{AccidentalSide, AccidentalStyleKind};
use dolce_engrave::stack::{high_dot_y, low_dot_y};
use dolce_geom::Rect;
use dolce_model::Accidental;
use dolce_scene::{Identity, IdentityKind, Node, Role};
use dolce_view::ast::{NoteElement, Ornament, Sound};

use super::ctx::{digit_item, digit_origin, dot, eid, font, ident, octave_dot, rect, stroke, text, Ctx, ItemsKey};
use crate::model::{Face, PlacedItem, PlacedText, TextKind};
use crate::place::spacing::MULTI_REST_WIDTH;
use crate::place::vertical::{accidental_lead_of, grace_layout, note_beams, stacked_digits};
use crate::util::acc_kind;

const NOTE_TEXT: &[TextKind] = &[TextKind::Chord, TextKind::SectionWord, TextKind::KeyLabel];
const NOTE_MARKS: &[TextKind] = &[TextKind::Artic, TextKind::Direction];

/// 音符/增时线上方的和弦（`harmony` 标签；挂在增时线上时带增时线自己的 id）
fn paint_chord(c: &Ctx, g: &mut Node, t: &PlacedText, x: f64, baseline: f64, own_id: Option<i64>) {
    let m = c.m;
    let word = font(&m.style.font.text.family, t.size, false);
    let music = font("Bravura", t.size, false);
    let side = AccidentalSide::parse(m.style.look.accidental_side.as_deref());
    let mut grp = layout_harmony_segs(&chord_text_segs(&t.text, m.style.look.chord_plain, side), &word, &music, c.ink, c.env);
    grp.set_x(x);
    grp.set_y(baseline);
    grp.id = Some(Identity { id: own_id.map(eid), ..ident(IdentityKind::Harmony) });
    g.push(grp);
}

/// 上方带里挂在 (`key`, `at`) 上的字；`kinds` 给了就只画这几种
pub fn paint_band(c: &Ctx, g: &mut Node, key: ItemsKey, at: usize, kinds: Option<&[TextKind]>, own_id: Option<i64>) {
    let Some((bkey, map)) = &c.band else { return };
    if *bkey != key {
        return;
    }
    let Some(list) = map.get(&at) else { return };
    let (ox, oy) = c.band_origin;
    let m = c.m;
    for t in list {
        if kinds.is_some_and(|k| !k.contains(&t.kind)) {
            continue;
        }
        let (x, y) = (ox + t.x, oy + t.y);
        if t.kind == TextKind::Chord {
            paint_chord(c, g, t, x, y, own_id);
            continue;
        }
        let family = if t.face == Face::Lyric { &m.style.font.lyric.family } else { &m.style.font.text.family };
        let mut tf = if t.face == Face::Music {
            let mut n = music_text(&t.text, font("Bravura", t.size, false), c.ink);
            n.set_x(x);
            n.set_y(y);
            n
        } else {
            text(&t.text, x, y, font(family, t.size, t.bold), c.ink, c.env)
        };
        if let Some(xs) = &t.xs {
            tf.text_mut().char_xs = Some(xs.clone());
        }
        match t.kind {
            TextKind::SectionWord => {
                tf.add_class("annotation");
                tf.add_class("section-word");
                tf.id = Some(ident(IdentityKind::Annotation));
            }
            TextKind::KeyLabel => tf.add_class("key-change"),
            k => tf.add_class(k.as_str()),
        }
        g.push(tf);
        if t.boxed {
            let b = t.ink.offset(ox, oy);
            let mut p = stroke(c.ink, 1.0);
            {
                let ps = p.path_mut();
                ps.move_to(b.left, b.top);
                ps.line_to(b.right, b.top);
                ps.line_to(b.right, b.bottom);
                ps.line_to(b.left, b.bottom);
                ps.close();
            }
            p.add_class("rehearsal");
            g.push(p);
        }
    }
}

/// 多小节休止：基线上一道横线、两头竖短线，横线上方居中印小节数
fn paint_multi_rest(c: &Ctx, g: &mut Node, bars: f64, x: f64, baseline: f64) {
    let h = c.m.ink.note_height;
    let w = h * MULTI_REST_WIDTH;
    let t = h * 0.12;
    g.push(rect(c.ink, x - w / 2.0, baseline - t / 2.0, w, t));
    for ex in [x - w / 2.0, x + w / 2.0 - t] {
        g.push(rect(c.ink, ex, baseline - h * 0.4, t, h * 0.8));
    }
    let label: Vec<String> = dolce_base::js::num_to_string(bars).chars().map(String::from).collect();
    let step = c.digit_font.measure_text(c.env.mc, "0");
    let n = label.len() as f64;
    for (k, ch) in label.iter().enumerate() {
        let (dx, dy, _) = digit_origin(c, ch);
        g.push(digit_item(ch, x + dx + (k as f64 - (n - 1.0) / 2.0) * step, baseline + dy - h * 0.81, c.digit_font.clone(), c.ink));
    }
}

fn accidental_item(c: &Ctx, a: &Accidental, ch: &str, x: f64, y: f64) -> Option<Node> {
    let kind = acc_kind(a);
    accidental_glyph(a.as_str())?;
    let m = c.m;
    let digit = DigitRef { font: c.digit_font.clone(), text: ch.to_string(), x, y, scale: None };
    Some(
        AccidentalGlyph::new(
            kind,
            &digit,
            &AccidentalStyle {
                music: font("Bravura", 20.0, false),
                color: c.ink,
                meta: false,
                kind: AccidentalStyleKind::parse(&m.style.look.accidental_style),
                scale: Some(m.style.look.accidental_scale),
            },
            c.env,
        )
        .item,
    )
}

fn names(note: &NoteElement) -> Vec<&str> {
    note.ornaments.iter().map(|o| o.name.as_str()).collect()
}

/// 一个音符。`key` / `at`：在哪串 items 的第几个（查上方带用）。
/// 画了主数字（TS `paintNote` 返回的 `num`）时返回这组在 `root` 里的下标——数字是组的头一个子节点，减时线记两端接哪两组。
pub fn paint_note(c: &Ctx, root: &mut Node, it: &PlacedItem, key: ItemsKey, at: usize, x: f64, baseline: f64) -> Option<usize> {
    let dolce_view::ast::MusicElement::Note(note) = &it.element else { return None };
    let m = c.m;
    let mut g = Node::group();
    g.add_class("entry");
    let half = m.ink.note_height / 2.0;
    let digit_ch = |p: u32| if p == 9 { "X".to_string() } else { p.to_string() };

    // TS 按真值判（0 不算多小节休止）
    let multi = note.multi_rest.filter(|v| *v != 0.0 && !v.is_nan());
    let mut has_num = false;
    if let (Some(mr), false) = (multi, note.hidden) {
        paint_multi_rest(c, &mut g, mr, x, baseline);
    } else if !note.hidden {
        has_num = true;
        let ch = if note.sound == Sound::Rhythm { "X".to_string() } else { note.pitch.to_string() };
        let (dx, dy, _) = digit_origin(c, &ch);
        g.push(digit_item(&ch, x + dx, baseline + dy, c.digit_font.clone(), c.ink));
        if let Some(a) = &note.accidental {
            if let Some(n) = accidental_item(c, a, &ch, x + dx, baseline + dy) {
                g.push(n);
            }
        }
        for i in 0..note.octave.max(0) {
            g.push(octave_dot(c.ink, x, baseline + high_dot_y(-half, i as f64, &m.ink.stack), m.style.dot.octave));
        }
        for i in 0..(-note.octave).max(0) {
            g.push(octave_dot(c.ink, x, baseline + low_dot_y(half, note_beams(note), i as f64, &m.ink.stack), m.style.dot.octave));
        }
        for sd in stacked_digits(note, m) {
            let sch = digit_ch(sd.pitch);
            let (odx, ody, ob) = digit_origin(c, &sch);
            let by = baseline + sd.y;
            g.push(digit_item(&sch, x + odx, by + ody, c.digit_font.clone(), c.ink));
            if let Some(a) = &sd.accidental {
                if let Some(n) = accidental_item(c, a, &sch, x + odx, by + ody) {
                    g.push(n);
                }
            }
            for i in 0..sd.octave.max(0) {
                g.push(octave_dot(c.ink, x, by + high_dot_y(-half, i as f64, &m.ink.stack), m.style.dot.octave));
            }
            for i in 0..(-sd.octave).max(0) {
                g.push(octave_dot(c.ink, x, by + low_dot_y(half, 0.0, i as f64, &m.ink.stack), m.style.dot.octave));
            }
            let ink = ob.offset(x + odx, by + ody);
            for i in 0..note.dots {
                let (cx, cy) = aug_dot_center(&ink, i as f64, m.style.dot.aug, m.ink.stack.gap);
                g.push(octave_dot(c.ink, cx, cy, m.style.dot.aug));
            }
            paint_tremolo(c, &mut g, note, &ink);
        }
    }

    if !note.hidden && note.ornaments.iter().any(|o| o.name == "arp") {
        let h = m.ink.note_height;
        let (odx, _, ob) = digit_origin(c, &note.pitch.to_string());
        let ink_left = x + odx + ob.left;
        let sd = stacked_digits(note, m);
        let top = baseline + sd.last().map_or(0.0, |d| d.y) - h / 2.0;
        let bare = NoteElement { ornaments: vec![], ..note.clone() };
        let acc_lead = accidental_lead_of(&bare, m);
        g.push(arpeggio_group(ink_left - acc_lead - h * 0.5, top, baseline + h / 2.0, h * JP_ARPEGGIO_SIZE, c.ink, c.env));
    }

    let ach = if note.sound == Sound::Rhythm { "X".to_string() } else { note.pitch.to_string() };
    let (adx, ady, ab) = digit_origin(c, &ach);
    let digit_ink = ab.offset(x + adx, baseline + ady);
    for i in 0..note.dots {
        let (cx, cy) = aug_dot_center(&digit_ink, i as f64, m.style.dot.aug, m.ink.stack.gap);
        let mut d = octave_dot(c.ink, cx, cy, m.style.dot.aug);
        if let (true, Some(Role::JpOctaveDot { aug, .. })) = (has_num, &mut d.role) {
            *aug = Some(i);
        }
        d.add_class("aug-dot");
        d.id = Some(ident(IdentityKind::AugDot));
        g.push(d);
    }
    if !note.hidden && multi.is_none() {
        paint_tremolo(c, &mut g, note, &digit_ink);
        paint_slide(c, &mut g, note, &digit_ink);
    }

    paint_band(c, &mut g, key, at, Some(NOTE_TEXT), None);

    paint_grace(c, &mut g, note, true, x, baseline);
    paint_grace(c, &mut g, note, false, x, baseline);

    let before = g.k.len();
    paint_ornaments(c, &mut g, &note.ornaments, key, at, x, baseline);
    for n in &mut g.k[before..] {
        n.id = Some(ident(IdentityKind::Deco));
    }

    if let Some(id) = it.id {
        g.id = Some(Identity { id: Some(eid(id)), pass: c.pass.map(|p| p as u32), ..ident(IdentityKind::Note) });
    }
    root.push(g);
    has_num.then(|| root.k.len() - 1)
}

/// 附点（或数字）右缘：震音、滑音从这里起
fn dots_right(c: &Ctx, note: &NoteElement, digit_ink: &Rect) -> f64 {
    let r = c.m.style.dot.aug;
    if note.dots > 0 {
        aug_dot_center(digit_ink, (note.dots - 1) as f64, r, c.m.ink.stack.gap).0 + r
    } else {
        digit_ink.right
    }
}

/// 同音高震音号：数字（连同附点）右下角几道细斜线
fn paint_tremolo(c: &Ctx, g: &mut Node, note: &NoteElement, digit_ink: &Rect) {
    let n = jp_tremolo_count(&names(note));
    if n == 0 {
        return;
    }
    let right = dots_right(c, note, digit_ink);
    let cy = (digit_ink.top + digit_ink.bottom) / 2.0;
    for s in jp_tremolo_strokes(n, c.m.ink.note_height).0 {
        let mut p = Node::path();
        {
            let ps = p.path_mut();
            ps.move_to(right + s.x0 - s.thick / 2.0, cy + s.y0);
            ps.line_to(right + s.x0 + s.thick / 2.0, cy + s.y0);
            ps.line_to(right + s.x1 + s.thick / 2.0, cy + s.y1);
            ps.line_to(right + s.x1 - s.thick / 2.0, cy + s.y1);
            ps.close();
            ps.fill = true;
            ps.fill_color = c.ink;
        }
        p.add_class("artic");
        p.id = Some(ident(IdentityKind::Deco));
        g.push(p);
    }
}

/// 上 / 下滑音：数字（连同附点）右侧偏上一根直线短箭头
fn paint_slide(c: &Ctx, g: &mut Node, note: &NoteElement, digit_ink: &Rect) {
    let Some(up) = jp_slide_of(&names(note)) else { return };
    let right = dots_right(c, note, digit_ink);
    let a = jp_slide_arrow(up, c.m.ink.note_height);
    let mut p = stroke(c.ink, a.line_width);
    {
        let ps = p.path_mut();
        ps.move_to(right + a.x0, digit_ink.bottom + a.y0);
        ps.line_to(right + a.x1, digit_ink.bottom + a.y1);
        for [ax, ay] in a.arms {
            ps.move_to(right + ax, digit_ink.bottom + ay);
            ps.line_to(right + a.x1, digit_ink.bottom + a.y1);
        }
    }
    p.add_class("artic");
    p.id = Some(ident(IdentityKind::Deco));
    g.push(p);
}

/// 倚音：`before` 前倚音（画在左）/ 后倚音（画在右）
fn paint_grace(c: &Ctx, g: &mut Node, note: &NoteElement, before: bool, x: f64, baseline: f64) {
    let notes = if before { &note.grace_before } else { &note.grace_after };
    if notes.is_empty() {
        return;
    }
    let m = c.m;
    let mc = c.env.mc;
    let f = font(&m.style.font.text.family, c.digit_font.size * m.style.size.grace, false);
    let geom = grace_layout(note, before, m, x, baseline);
    for d in &geom.digits {
        let b = f.char_bound(mc, &d.text);
        let mut t = text(&d.text, d.cx - (b.left + b.right) / 2.0, d.cy - (b.top + b.bottom) / 2.0, f.clone(), c.ink, c.env);
        t.add_class("grace");
        g.push(t);
    }
    for o in &geom.dots {
        g.push(dot(c.ink, o.cx, o.cy, o.r));
    }
    for acc in &geom.accidentals {
        let Some(glyph) = accidental_glyph(acc.alter.as_str()) else { continue };
        let probe = font("Bravura", 100.0, false);
        let pb = probe.char_bound(mc, &glyph);
        let h100 = (pb.bottom - pb.top).abs();
        let ink_at_100 = if h100 != 0.0 && !h100.is_nan() { h100 } else { 68.0 };
        let acc_font = font("Bravura", (acc.ink_height * 100.0) / ink_at_100, false);
        let ab = acc_font.char_bound(mc, &glyph);
        g.push(text(&glyph, acc.ink_right - ab.right, acc.ink_cy - (ab.top + ab.bottom) / 2.0, acc_font, c.ink, c.env));
    }
    for bm in &geom.beams {
        let mut r = rect(c.ink, bm.x, bm.y, bm.w, bm.h);
        r.add_class("grace-line");
        g.push(r);
    }
    if let Some(h) = &geom.hook {
        let mut p = stroke(c.ink, h.width);
        {
            let ps = p.path_mut();
            ps.move_to(h.m[0], h.m[1]);
            ps.cubic_to(h.c[0], h.c[1], h.c[2], h.c[3], h.c[4], h.c[5]);
        }
        p.add_class("grace-line");
        g.push(p);
    }
}

/// 挂在音符/小节线上的 `&xx` 记号：伴奏括弧、换气贴着音符画；奏法、力度、术语、跳转字照上方带画
pub fn paint_ornaments(c: &Ctx, g: &mut Node, ornaments: &[Ornament], key: ItemsKey, at: usize, x: f64, baseline: f64) {
    let m = c.m;
    for orn in ornaments {
        if is_accomp_bracket(&orn.name) {
            let is_left = orn.name == "zkh";
            let h = m.ink.note_height * 1.5;
            let bx = x + if is_left { -m.ink.note_height * 0.62 } else { m.ink.note_height * 0.62 };
            let mut p = stroke(c.ink, 1.4);
            let bend = if is_left { -4.5 } else { 4.5 };
            {
                let ps = p.path_mut();
                ps.move_to(bx, baseline - h / 2.0);
                ps.cubic_to(bx + bend, baseline - h / 4.0, bx + bend, baseline + h / 4.0, bx, baseline + h / 2.0);
            }
            p.add_class("artic");
            g.push(p);
        } else if orn.name == "hx" {
            g.push(breath_path(x, baseline, m.ink.note_height, 1.1, c.ink));
        }
    }
    paint_band(c, g, key, at, Some(NOTE_MARKS), None);
}
