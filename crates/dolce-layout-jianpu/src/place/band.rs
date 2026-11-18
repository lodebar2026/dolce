//! 谱行**上方那一带**的定位（照 `place/band.ts`）：弧、连音、奏法记号、和弦、注释、松叶、转调标签、力度/术语/跳转字、
//! 临时伴奏行、房号。堆叠走公共那一份（`dolce_engrave::upperband::stack_upper_band`）。
//!
//! TS 以对象身份当堆叠钥匙（`PlacedText` / `PlacedMark` / `PlacedSplit` / `PlacedLayer`），这里盒子自带 [`KeyRef`]
//! 指回各自的表；送进公共堆叠时钥匙就是盒子的下标（各盒钥匙本来互不相同）。`topAt` 闭包换成可求值的 [`TopAt`]，
//! 抬升时逐次记下位移、求值时依次加上（与 TS 层层包闭包的浮点次序一致）。

use dolce_engrave::arc::{flat_hx, slur_tie, ArcKind, SlurStyle};
use dolce_engrave::dynamics::DYNAMIC_SIZE;
use dolce_engrave::ending::{ending_drop, ending_label_dx, label_baseline_of};
use dolce_engrave::hairpin::{jp_hairpin, jp_hairpin_line_width};
use dolce_engrave::jpglyph::{barline_mark, dynamic};
use dolce_engrave::jpslide::{jp_slide_arrow, jp_slide_of};
use dolce_engrave::stack::{stack_bottom, stack_top as stack_top_of, StackStyle};
use dolce_engrave::tuplet::tuplet_digits;
use dolce_engrave::upperband::{stack_upper_band, BandItem};
use dolce_base::geom::{Point, Rect};
use dolce_model::deconames::{rehearsal_bracketed, rehearsal_of};
use dolce_model::marknames::term_text;
use dolce_view::ast::{MarkType, MusicElement};

use crate::grid::{barline_span, bracket_line_width, jianpu_slur_style, key_label_size, JianpuGrid};
use crate::ink::Ink;
use crate::model::{Face, InkTextRole, PlacedItem, PlacedLayer, PlacedMark, PlacedText, TextKind};
use crate::place::marks::below_arcs_bottom;
use crate::place::sectionword::{section_word_lines, section_word_of, section_word_slot, widest_line, ChordSpan};
use crate::place::spacing::barline_box;
use crate::place::vertical::{artic_stack, entry_top, note_beams, note_ink_bottom, stack_top};
use crate::util::{max, max_of, min, min_of};

/// 一个声部（或并排块上行）的上方带排完的结果
pub struct VoiceBand {
    pub texts: Vec<PlacedText>,
    /// 本行头顶最高的墨迹（相对基线，负为上）
    pub top: f64,
    /// 字里最高的墨迹顶；没有字为 None
    pub text_top: Option<f64>,
    /// 器乐谱谱行下方那条带的墨迹底；没有为 None
    pub bottom: Option<f64>,
}

/// 盒子指回谁（TS 的 `key`）
#[derive(Clone, Copy, Debug, PartialEq)]
enum KeyRef {
    Text(usize),
    Mark(usize),
    Split(usize),
    Cue(usize),
}

/// 「这一段 x 上多高」（TS `topAt` 闭包）
#[derive(Clone, Debug)]
enum TopAtFn {
    Slur { x0: f64, x1: f64, top: f64, bottom: f64, flat: bool },
    Tuplet { cx: f64, half_w: f64, top: f64, line_top: f64 },
}

#[derive(Clone, Debug)]
struct TopAt {
    f: TopAtFn,
    /// 抬升时依次包上的位移（`(a, c) => f(a, c) + d`）
    shifts: Vec<f64>,
}

impl TopAt {
    fn eval(&self, a: f64, c: f64) -> f64 {
        let mut v = match self.f {
            TopAtFn::Slur { x0, x1, top, bottom, flat } => {
                let at = |x: f64| -> f64 {
                    if flat {
                        return top;
                    }
                    let u = if x1 > x0 { min(1.0, max(0.0, (x - x0) / (x1 - x0))) } else { 0.0 };
                    bottom - 4.0 * (bottom - top) * u * (1.0 - u)
                };
                let lo = max(a, x0);
                let hi = min(c, x1);
                if lo > hi {
                    bottom
                } else {
                    let mid = (x0 + x1) / 2.0;
                    if lo <= mid && mid <= hi {
                        top
                    } else {
                        min(at(lo), at(hi))
                    }
                }
            }
            TopAtFn::Tuplet { cx, half_w, top, line_top } => {
                if c > cx - half_w && a < cx + half_w {
                    top
                } else {
                    line_top
                }
            }
        };
        for d in &self.shifts {
            v += d;
        }
        v
    }
}

#[derive(Clone, Debug)]
struct BBox {
    key: KeyRef,
    x0: f64,
    x1: f64,
    top: f64,
    bottom: f64,
    layer: f64,
    rank: Option<f64>,
    kind: &'static str,
    spread: Option<&'static str>,
    top_at: Option<TopAt>,
    skip_kinds: Vec<&'static str>,
}

impl BBox {
    #[allow(clippy::too_many_arguments)]
    fn new(key: KeyRef, x0: f64, x1: f64, top: f64, bottom: f64, layer: f64, rank: Option<f64>, kind: &'static str) -> BBox {
        BBox { key, x0, x1, top, bottom, layer, rank, kind, spread: None, top_at: None, skip_kinds: vec![] }
    }
    fn top_in(&self, a: f64, c: f64) -> f64 {
        match &self.top_at {
            Some(f) => f.eval(a, c),
            None => self.top,
        }
    }
    fn lower(mut self, dy: Option<f64>) -> BBox {
        if dy.is_some() {
            self.skip_kinds = LOWER_ROW.to_vec();
        }
        self
    }
}

/// 带里算「字」的那几种
const TEXT_KINDS: [&str; 4] = ["chord", "section-word", "key", "direction"];

/// 并排块下行上的东西不为上行让位
const LOWER_ROW: [&str; 1] = ["split"];

/// JS `Number.MAX_SAFE_INTEGER`
const MAX_SAFE: f64 = 9007199254740991.0;

fn text_size(m: &JianpuGrid) -> f64 {
    if m.style.size.chord > 0.0 {
        m.style.size.chord
    } else {
        m.style.size.note * 0.6
    }
}

fn width_or_inf(width: f64) -> f64 {
    if width == 0.0 || width.is_nan() {
        f64::INFINITY
    } else {
        width
    }
}

struct ArcB {
    top: f64,
    bottom: f64,
    flat: bool,
}

fn arc_box(mk: &PlacedMark, m: &JianpuGrid, ink: &Ink, y: f64, gap: Option<(f64, f64)>) -> ArcB {
    let x1 = max(mk.x1, mk.x0 + 6.0);
    let style = SlurStyle { gap: gap.or(None), ..jianpu_slur_style(m, 0.0) };
    let arc = slur_tie(ArcKind::Slur, Point::new(mk.x0, y), Point::new(x1, y), &style, ink.env);
    ArcB { top: arc.y(), bottom: arc.y() + arc.h, flat: flat_hx(&arc) > 0.0 }
}

fn shift_text(t: &mut PlacedText, dx: f64, dy: f64) {
    t.x += dx;
    t.y += dy;
    t.ink = t.ink.offset(dx, dy);
}

fn run_stack(boxes: &[BBox], gap: f64) -> Vec<f64> {
    let items: Vec<BandItem> = boxes
        .iter()
        .enumerate()
        .map(|(i, b)| BandItem {
            key: i,
            x0: b.x0,
            x1: b.x1,
            top: b.top,
            bottom: b.bottom,
            layer: b.layer,
            rank: b.rank,
            kind: Some(b.kind.to_string()),
            spread: b.spread.map(str::to_string),
            top_at: b.top_at.clone().map(|f| Box::new(move |a: f64, c: f64| f.eval(a, c)) as Box<dyn Fn(f64, f64) -> f64>),
            gap_scale: None,
            skip_kinds: b.skip_kinds.iter().map(|s| s.to_string()).collect(),
        })
        .collect();
    let lift = stack_upper_band(&items, gap);
    (0..boxes.len()).map(|i| lift.get(&i).copied().unwrap_or(0.0)).collect()
}

/// 上方带：收集 → 堆叠 → 力度/跳转字 → 临时伴奏行 → 房号。`width` 是版心宽（字不出版心）；`below` = 器乐谱
#[allow(clippy::too_many_arguments)]
pub fn place_band(items: &[PlacedItem], marks: &mut [PlacedMark], layers: &mut [PlacedLayer], m: &JianpuGrid, ink: &Ink, width: f64, below: bool) -> VoiceBand {
    let nh = m.ink.note_height;
    let gap = m.style.vertical.slur_gap;
    let mut texts: Vec<PlacedText> = vec![];
    let mut boxes: Vec<BBox> = vec![];

    // ---- 层 0：并排块的上行 ----
    for (li, lay) in layers.iter_mut().enumerate() {
        if lay.items.is_empty() {
            continue;
        }
        let Some(sp) = lay.split.as_mut() else { continue };
        let inner = place_band(&lay.items, &mut sp.marks, &mut [], m, ink, width, false);
        sp.band = Some(inner.texts);
        let xs = lay.items.iter().map(|it| it.x);
        let x0 = min_of(xs.clone()) - nh / 2.0;
        let x1 = max_of(xs) + nh / 2.0;
        boxes.push(BBox::new(KeyRef::Split(li), x0, x1, sp.dy + min(inner.top, sp.brace_top - sp.dy), sp.dy + nh / 2.0, 0.0, Some(-1.0), "split"));
    }

    // ---- 层 0：弧、连音 ----
    for (mi, mk) in marks.iter().enumerate() {
        let Some(my) = mk.y else { continue };
        if mk.below || !matches!(mk.mark.kind, MarkType::Slur | MarkType::Tuplet) {
            continue;
        }
        let dy = mk.dy.unwrap_or(0.0);
        let x0 = mk.x0;
        let x1 = max(mk.x1, mk.x0 + 6.0);
        if mk.mark.kind == MarkType::Slur {
            let b = arc_box(mk, m, ink, my + dy, None);
            let mut bx = BBox::new(KeyRef::Mark(mi), x0, x1, b.top, b.bottom, 0.0, Some(x1 - x0), "slur").lower(mk.dy);
            bx.top_at = Some(TopAt { f: TopAtFn::Slur { x0, x1, top: b.top, bottom: b.bottom, flat: b.flat }, shifts: vec![] });
            boxes.push(bx);
            continue;
        }
        let num_n = mk.mark.caption.as_deref().map_or(f64::NAN, dolce_base::js::number);
        let n = if num_n == 0.0 || num_n.is_nan() { (mk.mark.end - mk.mark.start + 1) as f64 } else { num_n };
        let num = ink.smufl(&tuplet_digits(n), m.style.size.note);
        let half_w = num.width() / 2.0;
        let cx = (x0 + x1) / 2.0;
        let half_gap = half_w + m.style.size.note * 0.15;
        let (line_top, num_cy) = if m.style.look.tuplet_style == "bracket" {
            let foot = if m.style.vertical.bracket_foot > 0.0 { m.style.vertical.bracket_foot * 0.55 } else { m.style.size.note * 0.25 };
            let lw = bracket_line_width(m);
            let ly = my + dy - foot;
            (ly - lw / 2.0, ly)
        } else {
            let b = arc_box(mk, m, ink, my + dy, Some((cx - half_gap, cx + half_gap)));
            (b.top, b.top + m.style.stroke.slur / 4.0)
        };
        let num_top = num_cy - num.height() / 2.0;
        let top = min(line_top, num_top);
        let mut bx = BBox::new(KeyRef::Mark(mi), x0, x1, top, my + dy, 0.0, Some(x1 - x0), "tuplet").lower(mk.dy);
        bx.top_at = Some(TopAt { f: TopAtFn::Tuplet { cx, half_w, top, line_top }, shifts: vec![] });
        boxes.push(bx);
    }

    // ---- 层 0：奏法记号字形；层 1：和弦、段落词；层 2：转调标签 ----
    struct Word {
        i: usize,
        base: f64,
    }
    let mut words: Vec<Word> = vec![];
    let push_chord = |texts: &mut Vec<PlacedText>, boxes: &mut Vec<BBox>, at: usize, cx: f64, base: f64, chord: &str, dy: f64| {
        let (advance, r) = ink.chord(chord);
        let Some(r) = r else { return };
        let x = cx - advance / 2.0;
        let t = PlacedText { kind: TextKind::Chord, at, text: chord.to_string(), face: Face::Text, size: m.style.size.chord, x, y: base, ink: r.offset(x, base), xs: None, boxed: false, bold: false };
        let mut bx = BBox::new(KeyRef::Text(texts.len()), t.ink.left, t.ink.right, t.ink.top, t.ink.bottom, 1.0, Some(0.0), "chord");
        bx.spread = Some("chord");
        if dy != 0.0 {
            bx.skip_kinds = LOWER_ROW.to_vec();
        }
        texts.push(t);
        boxes.push(bx);
    };
    let section_word_text = |at: usize, text: &str, x: f64, base: f64, r: &(f64, Option<Vec<f64>>, Rect)| PlacedText {
        kind: TextKind::SectionWord,
        at,
        text: text.to_string(),
        face: Face::Lyric,
        size: m.style.size.section_word,
        x,
        y: base,
        ink: r.2.offset(x, base),
        xs: r.1.clone(),
        boxed: false,
        bold: false,
    };
    for (item_index, it) in items.iter().enumerate() {
        let dy = it.dy.unwrap_or(0.0);
        match &it.element {
            MusicElement::Note(n) => {
                let (glyphs, art_top) = artic_stack(&it.element, m, ink, gap);
                for g in glyphs {
                    let t = PlacedText { kind: TextKind::Artic, at: item_index, text: g.glyph, face: Face::Music, size: g.size, x: it.x + g.x, y: g.y + dy, ink: g.ink.offset(it.x, dy), xs: None, boxed: false, bold: false };
                    let mut bx = BBox::new(KeyRef::Text(texts.len()), t.ink.left, t.ink.right, t.ink.top, t.ink.bottom, 0.0, Some(MAX_SAFE), "artic");
                    bx.skip_kinds = if dy != 0.0 { vec!["tuplet", "split"] } else { vec!["tuplet"] };
                    texts.push(t);
                    boxes.push(bx);
                }
                let base = art_top - m.style.vertical.chord_gap + dy;
                if let Some(c) = n.chord.as_deref().filter(|c| !c.is_empty()) {
                    push_chord(&mut texts, &mut boxes, item_index, it.x, base, c, dy);
                }
                let mut key: Option<usize> = None;
                if let Some(label) = n.key_label.as_deref().filter(|s| !s.is_empty()) {
                    let r = ink.text(label, InkTextRole::KeyLabel);
                    let x = it.x - nh * 0.35;
                    let t = PlacedText { kind: TextKind::KeyLabel, at: item_index, text: label.to_string(), face: Face::Text, size: key_label_size(m), x, y: base, ink: r.ink.offset(x, base), xs: None, boxed: false, bold: false };
                    boxes.push(BBox::new(KeyRef::Text(texts.len()), t.ink.left, t.ink.right, t.ink.top, t.ink.bottom, 2.0, None, "key").lower(it.dy));
                    key = Some(texts.len());
                    texts.push(t);
                }
                if let Some(ann) = n.annotation.as_deref().filter(|s| !s.is_empty()) {
                    if let Some(k) = key {
                        let ann = section_word_lines(ann).join(" ");
                        let r = ink.section_word(&ann);
                        let bar = items.iter().find(|o| matches!(o.element, MusicElement::Barline(_)) && o.x > it.x);
                        let at = texts[k].ink.right + m.style.size.chord * 0.4 - r.2.left;
                        let fits = at + r.2.right <= min(bar.map_or(f64::INFINITY, |b| b.x - nh * 0.3), width_or_inf(width));
                        let x = if fits { at } else { it.x - nh * 0.35 };
                        let t = section_word_text(item_index, &ann, x, base, &r);
                        boxes.push(
                            BBox::new(KeyRef::Text(texts.len()), t.ink.left, t.ink.right, t.ink.top, t.ink.bottom, if fits { 2.0 } else { 2.2 }, Some(1.0), if fits { "key" } else { "section-word" })
                                .lower(it.dy),
                        );
                        texts.push(t);
                    } else {
                        words.push(Word { i: item_index, base });
                    }
                }
            }
            MusicElement::Sustain(s) => {
                let base = -nh / 2.0 - m.style.vertical.chord_gap + dy;
                if let Some(c) = s.chord.as_deref().filter(|c| !c.is_empty()) {
                    push_chord(&mut texts, &mut boxes, item_index, it.x, base, c, dy);
                }
                if s.annotation.as_deref().is_some_and(|a| !a.is_empty()) {
                    words.push(Word { i: item_index, base });
                }
            }
            _ => {}
        }
    }

    spread_chords(items, &mut texts, &mut boxes, m, width);

    // ---- 段落词 ----
    let mut lane_words: Vec<(usize, f64)> = vec![];
    if !words.is_empty() && m.style.size.section_word > 0.0 {
        let spans: Vec<ChordSpan> = texts.iter().filter(|t| t.kind == TextKind::Chord).map(|t| ChordSpan { x0: t.ink.left, x1: t.ink.right, at: t.at }).collect();
        for w in &words {
            let wit = &items[w.i];
            let lines = section_word_lines(section_word_of(&wit.element).unwrap_or(""));
            if lines.is_empty() {
                continue;
            }
            let rs: Vec<(f64, Option<Vec<f64>>, Rect)> = lines.iter().map(|l| ink.section_word(l)).collect();
            let row: Vec<ChordSpan> = spans.iter().copied().filter(|c| items[c.at].dy.unwrap_or(0.0) == wit.dy.unwrap_or(0.0)).collect();
            let word_ink = widest_line(&lines, |l| ink.section_word(l).2);
            let (slot, _) = section_word_slot(items, w.i, &|k| items[k].x, &row, word_ink, m, width_or_inf(width));
            let mut base = w.base;
            for k in (0..lines.len()).rev() {
                let t = section_word_text(w.i, &lines[k], slot.x, base, &rs[k]);
                let ti = texts.len();
                boxes.push(BBox::new(KeyRef::Text(ti), t.ink.left, t.ink.right, t.ink.top, t.ink.bottom, 1.0, Some(1.0), "section-word").lower(wit.dy));
                let ink_top = t.ink.top;
                texts.push(t);
                if k == lines.len() - 1 && !slot.lifted && wit.dy.is_none() {
                    lane_words.push((ti, w.base));
                }
                if k > 0 {
                    base = ink_top - m.style.size.section_word * 0.2 - rs[k - 1].2.bottom;
                }
            }
        }
    }

    // ---- 层 1.5：松叶 ----
    let hairpin_lw = jp_hairpin_line_width(m.style.stroke.hairpin, nh);
    let hairpin_height = nh * jp_hairpin::HALF * 2.0 + hairpin_lw;
    for (mi, mk) in marks.iter_mut().enumerate() {
        if !matches!(mk.mark.kind, MarkType::Crescendo | MarkType::Decrescendo) || below {
            continue;
        }
        let mut top = f64::INFINITY;
        for it in items {
            if matches!(it.element, MusicElement::Barline(_)) || it.x < mk.x0 - nh || it.x > mk.x1 + nh {
                continue;
            }
            top = min(top, entry_top(&it.element, m) + it.dy.unwrap_or(0.0));
        }
        if !top.is_finite() {
            top = -nh / 2.0 + mk.dy.unwrap_or(0.0);
        }
        let y = top - m.ink.stack.gap - (mk.level - 1.0) * m.note.level_step;
        mk.y = Some(y);
        let x1 = max(mk.x1, mk.x0 + 6.0);
        boxes.push(BBox::new(KeyRef::Mark(mi), mk.x0, x1, y - hairpin_height, y, 1.5, Some(x1 - mk.x0), "wedge").lower(mk.dy));
    }

    // ---- 堆叠，dy 回填 ----
    let box_of_text = |boxes: &[BBox], ti: usize| boxes.iter().position(|b| b.key == KeyRef::Text(ti));
    let lane_chords: Vec<usize> = (0..texts.len())
        .filter(|&ti| texts[ti].kind == TextKind::Chord && !box_of_text(&boxes, ti).is_some_and(|b| boxes[b].skip_kinds.contains(&"split")))
        .collect();
    let mut lift: Vec<f64>;
    if !lane_chords.is_empty() {
        let mut lane = min_of(lane_chords.iter().map(|&t| texts[t].y));
        lift = vec![];
        for _ in 0..6 {
            let all: Vec<(usize, f64)> = lane_chords.iter().map(|&t| (t, f64::INFINITY)).chain(lane_words.iter().copied()).collect();
            for (t, wb) in all {
                let d = min(lane, wb) - texts[t].y;
                if d == 0.0 {
                    continue;
                }
                shift_text(&mut texts[t], 0.0, d);
                let b = box_of_text(&boxes, t).unwrap();
                boxes[b].top += d;
                boxes[b].bottom += d;
            }
            lift = run_stack(&boxes, gap);
            let next = min_of(lane_chords.iter().map(|&t| texts[t].y + box_of_text(&boxes, t).map_or(0.0, |b| lift[b])));
            if next >= lane - 0.01 {
                break;
            }
            lane = next;
        }
    } else {
        lift = run_stack(&boxes, gap);
    }
    for (bi, d) in lift.iter().copied().enumerate() {
        if d == 0.0 {
            continue;
        }
        let b = &mut boxes[bi];
        b.top += d;
        b.bottom += d;
        match b.key {
            KeyRef::Text(t) => shift_text(&mut texts[t], 0.0, d),
            KeyRef::Mark(k) => {
                if let Some(y) = marks[k].y.as_mut() {
                    *y += d;
                }
            }
            _ => {}
        }
        if let Some(f) = b.top_at.as_mut() {
            f.shifts.push(d);
        }
    }

    let mut low_texts: Vec<PlacedText> = vec![];
    let groups = place_directions(items, &mut boxes, &mut texts, m, ink, width, if below { Some(&mut low_texts) } else { None });
    place_cue(items, layers, &mut boxes, m);
    place_endings(items, marks, &mut boxes, &mut texts, &groups, m, ink);
    for mk in marks.iter_mut() {
        if let (Some(y), Some(d)) = (mk.y.as_mut(), mk.dy) {
            if !matches!(mk.mark.kind, MarkType::Slur | MarkType::Tuplet) {
                *y -= d;
            }
        }
    }

    // ---- 头顶 ----
    let mut top = -nh / 2.0;
    let mut text_top: Option<f64> = None;
    for it in items {
        let dy = it.dy.unwrap_or(0.0);
        if let MusicElement::Note(n) = &it.element {
            if !n.hidden {
                top = min(top, entry_top(&it.element, m) + dy);
            }
        }
        let orns = match &it.element {
            MusicElement::Note(n) => &n.ornaments,
            MusicElement::Sustain(s) => &s.ornaments,
            MusicElement::Barline(b) => &b.ornaments,
            _ => continue,
        };
        for orn in orns {
            if orn.name == "hx" {
                top = min(top, -nh * 1.05 + dy);
            } else if orn.name == "zkh" || orn.name == "ykh" {
                top = min(top, -nh * 0.75 + dy);
            } else if jp_slide_of(&[orn.name.as_str()]).is_some() {
                let a = jp_slide_arrow(orn.name == "shy", nh);
                top = min(top, nh / 2.0 + min_of([a.y0, a.y1, a.arms[0][1], a.arms[1][1]]) - a.line_width / 2.0 + dy);
            }
        }
    }
    for b in &boxes {
        top = min(top, b.top);
        if TEXT_KINDS.contains(&b.kind) {
            text_top = Some(min(text_top.unwrap_or(f64::INFINITY), b.top));
        }
    }
    let bottom = if below { place_below(items, marks, layers, &mut low_texts, m, ink) } else { None };
    texts.extend(low_texts);
    VoiceBand { texts, top, text_top, bottom }
}

/// 器乐谱谱行下方那条带：力度记号与渐强渐弱。返回这条带的墨迹底（相对基线）
fn place_below(items: &[PlacedItem], marks: &mut [PlacedMark], layers: &[PlacedLayer], dyns: &mut [PlacedText], m: &JianpuGrid, ink: &Ink) -> Option<f64> {
    let wedges: Vec<usize> = (0..marks.len()).filter(|&k| matches!(marks[k].mark.kind, MarkType::Crescendo | MarkType::Decrescendo)).collect();
    if wedges.is_empty() && dyns.is_empty() {
        return None;
    }
    let nh = m.ink.note_height;
    let gap = m.style.vertical.slur_gap;
    let mut low = nh / 2.0;
    for it in items {
        let MusicElement::Note(n) = &it.element else { continue };
        if n.hidden {
            continue;
        }
        low = max(low, note_ink_bottom(n, m) + it.dy.unwrap_or(0.0));
    }
    for lay in layers {
        let Some(sp) = &lay.split else { continue };
        for it in &lay.items {
            let MusicElement::Note(n) = &it.element else { continue };
            if n.hidden {
                continue;
            }
            low = max(low, note_ink_bottom(n, m) + sp.dy + it.dy.unwrap_or(0.0));
        }
    }
    low = max(low, below_arcs_bottom(marks, m, ink));
    let hairpin_lw = jp_hairpin_line_width(m.style.stroke.hairpin, nh);
    let hairpin_height = nh * jp_hairpin::HALF * 2.0 + hairpin_lw;
    let half = max_of(std::iter::once(hairpin_height).chain(dyns.iter().map(|t| t.ink.bottom - t.ink.top))) / 2.0;
    let mid = low + gap * 1.5 + half;
    for t in dyns.iter_mut() {
        let d = mid - (t.ink.top + t.ink.bottom) / 2.0;
        t.y += d;
        t.ink = t.ink.offset(0.0, d);
    }
    for &k in &wedges {
        let mk = &mut marks[k];
        for t in dyns.iter() {
            if t.ink.right <= mk.x0 - gap || t.ink.left >= mk.x1 + gap {
                continue;
            }
            if t.ink.left <= mk.x0 + nh {
                mk.x0 = max(mk.x0, t.ink.right + gap);
            } else if t.ink.right >= mk.x1 - nh {
                mk.x1 = min(mk.x1, t.ink.left - gap);
            }
        }
        mk.y = Some(mid + hairpin_height / 2.0 - mk.dy.unwrap_or(0.0));
    }
    Some(mid + half)
}

#[derive(Clone, Copy)]
struct ChordRow {
    x0: f64,
    x1: f64,
    base: f64,
    ink_top: f64,
}

#[derive(Clone, Copy)]
struct BarRow {
    x: f64,
    left: f64,
    right: f64,
    dy: f64,
}

/// 一组横排的记号（落位期间不在 `texts` 里）
struct Group {
    ts: Vec<PlacedText>,
}

impl Group {
    fn mv(&mut self, dx: f64, dy: f64) {
        for t in &mut self.ts {
            shift_text(t, dx, dy);
        }
    }
    fn gx(&self) -> f64 {
        min_of(self.ts.iter().map(|t| t.ink.left))
    }
    fn top(&self) -> f64 {
        min_of(self.ts.iter().map(|t| t.ink.top))
    }
    fn bottom(&self) -> f64 {
        max_of(self.ts.iter().map(|t| t.ink.bottom))
    }
}

/// 力度、术语、跳转字的落位。返回各组（组首在 `texts` 里的下标 → 整组下标）
#[allow(clippy::too_many_arguments)]
fn place_directions(
    items: &[PlacedItem],
    boxes: &mut Vec<BBox>,
    texts: &mut Vec<PlacedText>,
    m: &JianpuGrid,
    ink: &Ink,
    width: f64,
    mut low_dyns: Option<&mut Vec<PlacedText>>,
) -> Vec<(usize, Vec<usize>)> {
    let mut out: Vec<(usize, Vec<usize>)> = vec![];
    let nh = m.ink.note_height;
    let gap = m.style.vertical.slur_gap;
    let size = text_size(m);
    let chords: Vec<ChordRow> = texts.iter().filter(|t| t.kind == TextKind::Chord).map(|t| ChordRow { x0: t.ink.left, x1: t.ink.right, base: t.y, ink_top: t.ink.top }).collect();
    let bars: Vec<BarRow> = items
        .iter()
        .filter_map(|it| {
            let MusicElement::Barline(bl) = &it.element else { return None };
            let b = barline_box(bl, m);
            Some(BarRow { x: it.x, left: it.x - b.map_or(0.0, |b| b.left), right: it.x + b.map_or(0.0, |b| b.right), dy: it.dy.unwrap_or(0.0) })
        })
        .collect();
    let mut rehearsals: Vec<(usize, String)> = vec![];
    for (at, it) in items.iter().enumerate() {
        let (orns, at_bar) = match &it.element {
            MusicElement::Note(n) => (&n.ornaments, false),
            MusicElement::Barline(b) => (&b.ornaments, true),
            _ => continue,
        };
        let dy = it.dy.unwrap_or(0.0);
        let mut group = Group { ts: vec![] };
        let mut pen = 0.0;
        let mut level: f64 = 0.0;
        for orn in orns {
            let dyn_g = dynamic(&orn.name);
            let term = term_text(&orn.name);
            let bm = barline_mark(&orn.name);
            let t: PlacedText;
            if let Some(mark) = rehearsal_of(&orn.name) {
                rehearsals.push((at, mark));
                continue;
            } else if let Some(g) = dyn_g {
                let fs = m.style.size.note * DYNAMIC_SIZE;
                let r = ink.smufl(&g, fs);
                if let Some(low) = low_dyns.as_deref_mut() {
                    let x = if at_bar { it.x } else { it.x - (r.right - r.left) / 2.0 - r.left };
                    low.push(PlacedText { kind: TextKind::Direction, at, text: g, face: Face::Music, size: fs, x, y: dy, ink: r.offset(x, dy), xs: None, boxed: false, bold: false });
                    continue;
                }
                t = PlacedText { kind: TextKind::Direction, at, text: g, face: Face::Music, size: fs, x: pen - r.left, y: 0.0, ink: r.offset(pen - r.left, 0.0), xs: None, boxed: false, bold: false };
            } else if let Some(s) = term.or_else(|| bm.as_ref().and_then(|b| b.0)) {
                let r = ink.text(s, if bm.is_some() { InkTextRole::Jump } else { InkTextRole::Term });
                let i0 = r.ink.offset(pen, 0.0);
                t = PlacedText {
                    kind: TextKind::Direction,
                    at,
                    text: s.to_string(),
                    face: Face::Text,
                    size: m.style.size.chord,
                    x: pen,
                    y: 0.0,
                    ink: Rect::new(min(i0.left, pen), i0.top, max(i0.right, pen + r.advance), i0.bottom),
                    xs: None,
                    boxed: false,
                    bold: false,
                };
            } else if let Some(glyph) = bm.as_ref().and_then(|b| b.1.clone()) {
                let fs = m.style.size.note * 0.95;
                let r = ink.smufl(&glyph, fs);
                t = PlacedText { kind: TextKind::Direction, at, text: glyph, face: Face::Music, size: fs, x: pen - r.left, y: 0.0, ink: r.offset(pen - r.left, 0.0), xs: None, boxed: false, bold: false };
            } else {
                continue;
            }
            pen = t.ink.right + size * 0.25;
            group.ts.push(t);
            if orn.below != Some(true) {
                level = max(level, orn.level);
            }
        }
        if group.ts.is_empty() {
            continue;
        }
        let gw = max_of(group.ts.iter().map(|t| t.ink.right)) - min_of(group.ts.iter().map(|t| t.ink.left));
        let bar_right = if at_bar { bars.iter().find(|b| (b.x - it.x).abs() < 1e-6) } else { bars.iter().find(|b| b.left > it.x) }.copied();
        let bar_left = bars.iter().rev().find(|b| b.right <= it.x - if at_bar { 1e-6 } else { 0.0 }).copied();
        let mut x = match (at_bar, bar_right) {
            (true, Some(br)) => br.right - gw,
            _ => it.x - gw / 2.0,
        };
        x = max(0.0, min(x, width_or_inf(width) - gw));
        let gx0 = group.gx();
        group.mv(x - gx0, 0.0);
        let above = match &it.element {
            MusicElement::Note(_) => min(-nh / 2.0, stack_top(Some(&it.element), m, true)),
            _ => -nh / 2.0,
        };
        let fallback = above - if m.style.vertical.chord_gap > 0.0 { m.style.vertical.chord_gap } else { size } + dy;
        let own: Vec<ChordRow> = match (at_bar, bar_right) {
            (true, Some(br)) => chords.iter().copied().filter(|c| c.x0 < br.right).collect(),
            _ => chords.clone(),
        };
        place_direction(&own, boxes, fallback, bar_left.map_or(0.0, |b| b.right), size, gap, &mut group, gw);
        if let (true, Some(br)) = (at_bar, bar_right) {
            let bar_top = barline_span(m).0 + br.dy;
            if group.bottom() > bar_top - gap {
                let d = bar_top - gap - group.bottom();
                group.mv(0.0, d);
            }
        }
        {
            let x0 = group.gx();
            let x1 = x0 + gw;
            let mut low_top = f64::INFINITY;
            for b in boxes.iter() {
                if b.layer == 1.0 || b.layer == 2.0 || b.x1 <= x0 || b.x0 >= x1 {
                    continue;
                }
                let t = b.top_in(x0, x1);
                if t < group.bottom() && b.bottom > group.top() {
                    low_top = min(low_top, t);
                }
            }
            for o in items {
                if matches!(o.element, MusicElement::Barline(_)) || o.x + nh / 2.0 <= x0 || o.x - nh / 2.0 >= x1 {
                    continue;
                }
                let t = entry_top(&o.element, m) + o.dy.unwrap_or(0.0);
                if t - gap < group.bottom() {
                    low_top = min(low_top, t);
                }
            }
            if low_top.is_finite() {
                let d = low_top - gap - group.bottom();
                group.mv(0.0, d);
            }
        }
        if level > 0.0 {
            group.mv(0.0, -level * m.note.level_step);
        }
        {
            let x0 = group.gx();
            let x1 = x0 + gw;
            let mut prev_top = f64::INFINITY;
            for b in boxes.iter() {
                if b.kind != "direction" || b.x1 <= x0 || b.x0 >= x1 {
                    continue;
                }
                if b.top < group.bottom() && b.bottom > group.top() {
                    prev_top = min(prev_top, b.top);
                }
            }
            if prev_top.is_finite() {
                let d = prev_top - gap - group.bottom();
                group.mv(0.0, d);
            }
        }
        let (gx, gt, gb) = (group.gx(), group.top(), group.bottom());
        lift_texts_over(boxes, texts, gx, gx + gw, gt, gb, gap, size * 0.25);
        let first = texts.len();
        let idx: Vec<usize> = (first..first + group.ts.len()).collect();
        texts.extend(group.ts);
        boxes.push(BBox::new(KeyRef::Text(first), gx, gx + gw, gt, gb, 1.0, None, "direction"));
        out.push((first, idx));
    }
    for (at, mark) in rehearsals {
        place_rehearsal(at, &mark, items, boxes, texts, m, ink, width);
    }
    out
}

/// 力度、术语落定后压着的段落词、转调标签让到它之上一道空
#[allow(clippy::too_many_arguments)]
fn lift_texts_over(boxes: &mut [BBox], texts: &mut [PlacedText], x0: f64, x1: f64, top: f64, bottom: f64, gap: f64, pad: f64) {
    // 队列：None = 起点那块（不在 boxes 里），Some(i) = 盒子下标；读实时坐标
    let mut queue: std::collections::VecDeque<Option<usize>> = std::collections::VecDeque::from([None]);
    let mut guard = 0;
    while !queue.is_empty() && guard < 200 {
        let o = queue.pop_front().unwrap();
        let (ox0, ox1, otop, obottom, p) = match o {
            None => (x0, x1, top, bottom, pad),
            Some(i) => (boxes[i].x0, boxes[i].x1, boxes[i].top, boxes[i].bottom, 0.0),
        };
        #[allow(clippy::needless_range_loop)]
        for bi in 0..boxes.len() {
            if Some(bi) == o {
                continue;
            }
            let b = &boxes[bi];
            if (b.kind != "section-word" && b.kind != "key") || b.x1 <= ox0 - p || b.x0 >= ox1 + p {
                continue;
            }
            if b.bottom <= otop - gap + 1e-6 || b.top >= obottom || (b.top + b.bottom) / 2.0 > obottom {
                continue;
            }
            let d = otop - gap - b.bottom;
            if let KeyRef::Text(t) = b.key {
                shift_text(&mut texts[t], 0.0, d);
            }
            let b = &mut boxes[bi];
            b.top += d;
            b.bottom += d;
            queue.push_back(Some(bi));
        }
        guard += 1;
    }
}

/// 排练号：大一号的字母套方框，抬到这一段里一切墨迹之上一道空
#[allow(clippy::too_many_arguments)]
fn place_rehearsal(at: usize, mark: &str, items: &[PlacedItem], boxes: &mut Vec<BBox>, texts: &mut Vec<PlacedText>, m: &JianpuGrid, ink: &Ink, width: f64) {
    let it = &items[at];
    let fs = m.style.size.note * 0.9;
    let r = ink.text(mark, InkTextRole::Term);
    let k = fs / m.style.size.chord;
    let framed = !rehearsal_bracketed(mark);
    let pad = if framed { fs * 0.25 } else { 0.0 };
    let w = (r.ink.right - r.ink.left) * k + pad * 2.0;
    let nh = m.ink.note_height;
    let x0 = max(0.0, min(it.x - nh / 2.0, width_or_inf(width) - w));
    let x1 = x0 + w;
    let gap = m.style.vertical.slur_gap;
    let a0 = x0 - nh / 2.0;
    let a1 = x1 + nh / 2.0;
    let mut top = min_of(
        std::iter::once(-nh / 2.0).chain(
            items
                .iter()
                .filter(|o| matches!(o.element, MusicElement::Note(_)) && o.x + nh / 2.0 > a0 && o.x - nh / 2.0 < a1)
                .map(|o| entry_top(&o.element, m) + o.dy.unwrap_or(0.0)),
        ),
    );
    for b in boxes.iter() {
        if b.x1 <= a0 || b.x0 >= a1 {
            continue;
        }
        top = min(top, b.top_in(x0, x1));
    }
    for t in texts.iter() {
        if t.ink.right > x0 && t.ink.left < x1 {
            top = min(top, t.ink.top);
        }
    }
    let bottom = top - gap;
    let box_bottom_rel = r.ink.bottom * k + pad;
    let y = bottom - box_bottom_rel;
    let t = PlacedText {
        kind: TextKind::Direction,
        at,
        text: mark.to_string(),
        face: Face::Text,
        size: fs,
        x: x0 + pad - r.ink.left * k,
        y,
        boxed: framed,
        bold: true,
        ink: Rect::new(x0, y + r.ink.top * k - pad, x1, bottom),
        xs: None,
    };
    boxes.push(BBox::new(KeyRef::Text(texts.len()), x0, x1, t.ink.top, t.ink.bottom, 1.0, None, "direction"));
    texts.push(t);
}

/// 和弦横向让位（堆叠之前跑）
fn spread_chords(items: &[PlacedItem], texts: &mut [PlacedText], boxes: &mut [BBox], m: &JianpuGrid, width: f64) {
    let size = m.style.size.chord;
    if size <= 0.0 {
        return;
    }
    let right = width_or_inf(width);
    let gap = size * 0.28;
    let limit = size * 1.2;
    let mut chords: Vec<usize> = (0..texts.len()).filter(|&i| texts[i].kind == TextKind::Chord).collect();
    if chords.is_empty() {
        return;
    }
    let shift = |texts: &mut [PlacedText], boxes: &mut [BBox], t: usize, dx: f64| {
        texts[t].x += dx;
        texts[t].ink = texts[t].ink.offset(dx, 0.0);
        if let Some(b) = boxes.iter_mut().find(|b| b.key == KeyRef::Text(t)) {
            b.x0 += dx;
            b.x1 += dx;
        }
    };
    let top = barline_span(m).0;
    let bars: Vec<(f64, f64, f64)> = items
        .iter()
        .filter_map(|it| {
            let MusicElement::Barline(bl) = &it.element else { return None };
            barline_box(bl, m).map(|b| (it.x - b.left, it.x + b.right, top + it.dy.unwrap_or(0.0)))
        })
        .collect();
    for &c in &chords {
        let ci = texts[c].ink;
        let hit = bars.iter().find(|&&(l, r, t)| r > ci.left - gap && l < ci.right && (l + r) / 2.0 < (ci.left + ci.right) / 2.0 && t < ci.bottom);
        if let Some(&(_, r, _)) = hit {
            shift(texts, boxes, c, r + gap - ci.left);
        }
    }
    dolce_base::js::sort_by(&mut chords, |&a, &b| texts[a].ink.left - texts[b].ink.left);
    if texts[chords[0]].ink.left < 0.0 {
        let d = -texts[chords[0]].ink.left;
        shift(texts, boxes, chords[0], d);
    }
    for i in 1..chords.len() {
        let (prev, cur) = (chords[i - 1], chords[i]);
        let need = texts[prev].ink.right + gap - texts[cur].ink.left;
        if need <= 0.0 {
            continue;
        }
        let dx = min(min(need, limit), max(0.0, right - texts[cur].ink.right));
        if dx > 0.0 {
            shift(texts, boxes, cur, dx);
        }
    }
    for i in (0..chords.len()).rev() {
        let cur = chords[i];
        let prev_x1 = if i > 0 { texts[chords[i - 1]].ink.right } else { 0.0 };
        let mut dx = 0.0;
        if texts[cur].ink.right > right {
            dx = max(right - texts[cur].ink.right, prev_x1 + gap - texts[cur].ink.left);
        }
        if texts[cur].ink.left + dx < 0.0 {
            dx = -texts[cur].ink.left;
        }
        if dx != 0.0 {
            shift(texts, boxes, cur, dx);
        }
    }
}

/// 一组记号的纵向落位（`Line.placeDirection`）
#[allow(clippy::too_many_arguments)]
fn place_direction(chords: &[ChordRow], boxes: &[BBox], fallback: f64, bar_left: f64, size: f64, gap: f64, g: &mut Group, gw: f64) {
    if chords.is_empty() {
        g.mv(0.0, fallback);
        return;
    }
    let anchor_x = g.gx();
    let mut near = chords[0];
    for c in chords {
        if ((c.x0 + c.x1) / 2.0 - anchor_x).abs() < ((near.x0 + near.x1) / 2.0 - anchor_x).abs() {
            near = *c;
        }
    }
    g.mv(0.0, near.base);
    let top = min(near.base - size * 0.85, g.top());
    let bot = max(near.base + size * 0.25, g.bottom());
    let low: Vec<&BBox> = boxes.iter().filter(|b| b.layer != 1.0 && b.layer != 2.0).collect();
    let pad = size * 0.35;
    let hit_chord = |c: &ChordRow, x0: f64| c.ink_top < bot && c.base + size * 0.25 > top && c.x1 > x0 - pad && c.x0 < x0 + gw + pad;
    let hits = |x0: f64| {
        chords.iter().any(|c| hit_chord(c, x0)) || low.iter().any(|b| b.top < bot && b.bottom > top && b.x1 > x0 - pad && b.x0 < x0 + gw + pad)
    };
    if !hits(g.gx()) {
        return;
    }
    let gx = g.gx();
    let left = chords.iter().filter(|c| hit_chord(c, gx)).fold(f64::INFINITY, |a, c| min(a, c.x0));
    let alt = left - gw - size * 0.3;
    if alt.is_finite() && alt >= bar_left && alt >= 0.0 && !hits(alt) {
        g.mv(alt - g.gx(), 0.0);
        return;
    }
    let x0 = g.gx();
    let x1 = x0 + gw;
    let mut low_top = f64::INFINITY;
    for b in &low {
        if b.x1 <= x0 || b.x0 >= x1 {
            continue;
        }
        low_top = min(low_top, b.top_in(x0, x1));
    }
    for c in chords {
        if c.x1 <= x0 || c.x0 >= x1 {
            continue;
        }
        low_top = min(low_top, c.ink_top);
    }
    let d = if low_top.is_finite() { low_top - gap - g.bottom() } else { -size * 1.2 };
    g.mv(0.0, d);
}

/// 盒子里 [x0, x1] 一段、抬完之后的最高墨迹（`bandTop`）
fn band_top<'a>(boxes: impl IntoIterator<Item = &'a BBox>, x0: f64, x1: f64) -> Option<f64> {
    let mut top = f64::INFINITY;
    for b in boxes {
        if b.x1 <= x0 || b.x0 >= x1 {
            continue;
        }
        top = min(top, b.top);
    }
    top.is_finite().then_some(top)
}

/// `{bz}` 临时伴奏行：小字号行的墨迹底贴它那一段带顶（或音符那一摞）之上一道空
fn place_cue(items: &[PlacedItem], layers: &mut [PlacedLayer], boxes: &mut Vec<BBox>, m: &JianpuGrid) {
    let nh = m.ink.note_height;
    let cs = m.style.size.cue;
    let h = nh * cs;
    let st = StackStyle { gap: m.ink.stack.gap * cs, dot_radius: m.ink.stack.dot_radius * cs, beam_width: m.ink.stack.beam_width * cs };
    for (li, lay) in layers.iter_mut().enumerate() {
        if lay.split.is_some() || lay.items.is_empty() {
            continue;
        }
        let mut cue_top = -h / 2.0;
        let mut cue_bottom = h / 2.0;
        for it in &lay.items {
            let MusicElement::Note(n) = &it.element else { continue };
            if n.hidden {
                continue;
            }
            cue_top = min(cue_top, stack_top_of(-h / 2.0, max(0.0, n.octave as f64), &st));
            cue_bottom = max(cue_bottom, stack_bottom(h / 2.0, note_beams(n), max(0.0, -n.octave as f64), &st));
        }
        let xs = lay.items.iter().map(|it| it.x);
        let x0 = min_of(xs.clone()) - h / 2.0;
        let x1 = max_of(xs) + h / 2.0;
        let mut above = band_top(boxes.iter(), x0, x1).unwrap_or(f64::INFINITY);
        for it in items {
            if it.x < x0 || it.x > x1 || matches!(it.element, MusicElement::Barline(_)) {
                continue;
            }
            above = min(above, entry_top(&it.element, m) + it.dy.unwrap_or(0.0));
        }
        if !above.is_finite() {
            above = -nh / 2.0;
        }
        let y = above - m.style.vertical.slur_gap - cue_bottom;
        lay.y = Some(y);
        boxes.push(BBox::new(KeyRef::Cue(li), x0, x1, y + cue_top, y + cue_bottom, 2.5, None, "cue"));
    }
}

/// 房号：全行同一条车道
fn place_endings(items: &[PlacedItem], marks: &mut [PlacedMark], boxes: &mut Vec<BBox>, texts: &mut [PlacedText], directions: &[(usize, Vec<usize>)], m: &JianpuGrid, ink: &Ink) {
    let voltas: Vec<usize> = (0..marks.len()).filter(|&k| marks[k].mark.kind == MarkType::Volta).collect();
    if voltas.is_empty() {
        return;
    }
    let label_size = m.style.size.ending;
    let drop = ending_drop(m.style.vertical.bracket_foot, label_size);
    let gap = m.style.vertical.slur_gap;
    let lw = bracket_line_width(m);
    let dx = ending_label_dx(lw, label_size, m.style.vertical.bracket_foot);
    let label_ink = |mk: &PlacedMark| -> Option<Rect> {
        let cap = mk.mark.caption.as_deref().filter(|c| !c.is_empty())?;
        if mk.open_left {
            return None;
        }
        let r = ink.text(cap, InkTextRole::Ending).ink;
        Some(r.offset(dx, label_baseline_of(r.top, label_size, lw)))
    };
    let span_top = barline_span(m).0;
    let band: Vec<usize> = (0..boxes.len()).filter(|&i| boxes[i].kind != "direction").collect();
    let ink_top = |boxes: &[BBox], x0: f64, x1: f64| -> f64 {
        let mut t = band_top(band.iter().map(|&i| &boxes[i]), x0, x1).unwrap_or(f64::INFINITY);
        for it in items {
            let hidden = matches!(&it.element, MusicElement::Note(n) if n.hidden);
            if matches!(it.element, MusicElement::Barline(_)) || it.x < x0 || it.x > x1 || hidden {
                continue;
            }
            t = min(t, entry_top(&it.element, m) + it.dy.unwrap_or(0.0));
        }
        t
    };
    let mut top = f64::INFINITY;
    for &k in &voltas {
        let mk = &marks[k];
        let left_foot = !mk.open_left;
        let right_foot = !mk.open_right && mk.mark.open_end != Some(true);
        if left_foot {
            let label = label_ink(mk);
            let depth = max(drop, label.map_or(0.0, |l| l.bottom));
            top = min(top, ink_top(boxes, mk.x0 - label_size, mk.x0 + label.map_or(0.0, |l| l.right)) - label_size * 0.7 - depth);
        }
        top = min(top, ink_top(boxes, mk.x0, mk.x1) - gap - lw / 2.0);
        for it in items {
            if !matches!(it.element, MusicElement::Barline(_)) || it.x < mk.x0 - 2.0 || it.x > mk.x1 + 2.0 {
                continue;
            }
            let bar_top = span_top + it.dy.unwrap_or(0.0);
            let foot = (left_foot && (it.x - mk.x0).abs() <= 2.0) || (right_foot && (it.x - mk.x1).abs() <= 2.0);
            top = min(top, bar_top - gap - if foot { drop } else { lw / 2.0 });
        }
    }
    if !top.is_finite() {
        top = -m.ink.note_height / 2.0 - label_size * 0.7 - drop;
    }
    top -= (max_of(voltas.iter().map(|&k| marks[k].level)) - 1.0) * m.note.level_step;
    for &k in &voltas {
        marks[k].y = Some(top);
        let bottom = max(drop, label_ink(&marks[k]).map_or(0.0, |l| l.bottom));
        let mk = &marks[k];
        boxes.push(BBox::new(KeyRef::Mark(k), mk.x0, mk.x1, top - lw / 2.0, top + bottom, 3.0, None, "ending"));
    }
    for b in boxes.iter_mut() {
        if b.kind != "direction" {
            continue;
        }
        let KeyRef::Text(first) = b.key else { continue };
        let Some((_, group)) = directions.iter().find(|(f, _)| *f == first) else { continue };
        if !voltas.iter().any(|&k| b.x1 > marks[k].x0 - label_size && b.x0 < marks[k].x1) {
            continue;
        }
        let d = top - lw / 2.0 - gap - b.bottom;
        if d >= 0.0 {
            continue;
        }
        for &t in group {
            shift_text(&mut texts[t], 0.0, d);
        }
        b.top += d;
        b.bottom += d;
    }
}
