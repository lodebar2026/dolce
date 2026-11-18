//! 横向排列（照 `place/spacing.ts`）：同一拍位的符号归成一列，列宽按内容定，再做歌词避让与两端对齐，解出每个符号的最终 x。
//! 锚点 x 是数字墨迹中心；占位按数字字面宽算。TS 的 `Map<PlacedItem, …>` 换成 (第几行, 第几个符号) 下标。

use std::collections::HashMap;

use dolce_base::js::NumKey;
use dolce_engrave::accidental::ACCIDENTAL_CLEARANCE;
use dolce_engrave::barline::{BarlineGlyph, BarlineStyle};
use dolce_engrave::grace::grace_advance;
use dolce_engrave::jpglyph::barline_mark;
use dolce_engrave::jpslide::{jp_slide_arrow, jp_slide_of};
use dolce_engrave::jptremolo::{jp_tremolo_count, jp_tremolo_strokes};
use dolce_engrave::syllable::latin_word_break;
use dolce_engrave::timesig::time_sig_width;
use dolce_geom::Rect;
use dolce_view::ast::{BarlineElement, Meter, MusicElement, Sound};

use crate::barspec::fanqie_barline_spec;
use crate::grid::{barline_span, jianpu_grace_metrics, jianpu_grace_notes, JianpuGrid};
use crate::ink::Ink;
use crate::model::{LyricRun, PlacedItem};
use crate::place::sectionword::{line_start_index, section_word_lines, section_word_of, section_word_slot, widest_line, ChordSpan};
use crate::place::vertical::accidental_lead_of;
use crate::util::{max, max_of, min, min_of};

/// 一列：同一拍位（或同一条小节线）上各声部的符号
#[derive(Clone, Debug)]
struct Column {
    /// (第几行, 行内第几个符号)
    members: Vec<(usize, usize)>,
    bar: bool,
    left: f64,
    right: f64,
    lead: f64,
    want: f64,
    over: f64,
    pad: f64,
}

/// 行中转拍：拍号前后各留的那一格 ÷ 音符字号
pub const TIME_SIG_PAD_EM: f64 = 1.0 / 4.0;

/// 小节线占位（相对锚点）
#[derive(Clone, Copy, Debug)]
pub struct BarBox {
    pub left: f64,
    pub right: f64,
    pub first: f64,
}

fn barline_glyph(el: &BarlineElement, m: &JianpuGrid) -> Option<(BarlineGlyph, dolce_engrave::barline::BarlineSpec)> {
    let (spec, fin) = fanqie_barline_spec(el)?;
    let (top, bot) = barline_span(m);
    let g = BarlineGlyph::new(
        &spec,
        fin,
        &BarlineStyle { top, bot, light: m.style.stroke.barline, heavy: m.style.stroke.final_barline, gap: None, dot_radius: Some(m.style.dot.repeat), dots: None, color: 0.0 },
    );
    Some((g, spec))
}

fn line_xw(g: &BarlineGlyph, k: usize) -> (f64, f64) {
    let n = &g.items[g.lines[k]];
    (n.x(), n.line_ref().map_or(0.0, |l| l.stroke_width))
}

/// 小节线的占位（相对锚点的左右）与线前那一小格要按的高。隐藏线 None
pub fn barline_box(el: &BarlineElement, m: &JianpuGrid) -> Option<BarBox> {
    let (g, spec) = barline_glyph(el, m)?;
    if g.lines.is_empty() {
        return None;
    }
    let (fx, _) = line_xw(&g, 0);
    let (lx, lw) = line_xw(&g, g.lines.len() - 1);
    let r = m.style.dot.repeat;
    let lo = if spec.repeat_backward { 0.0 } else { fx };
    let hi = if spec.repeat_forward { g.width + 2.0 * r } else { lx + lw };
    let (top, bot) = barline_span(m);
    Some(BarBox { left: g.width / 2.0 - lo, right: hi - g.width / 2.0, first: if spec.repeat_backward { 2.0 * r } else { bot - top } })
}

/// 小节线第一根、最后一根竖线的线心（相对锚点）
pub fn barline_lines(el: &BarlineElement, m: &JianpuGrid) -> Option<(f64, f64)> {
    let (g, _) = barline_glyph(el, m)?;
    if g.lines.is_empty() {
        return None;
    }
    Some((line_xw(&g, 0).0 - g.width / 2.0, line_xw(&g, g.lines.len() - 1).0 - g.width / 2.0))
}

/// 行中转拍的拍号占位（含前后两格）
pub fn meter_advance(meter: &Meter, m: &JianpuGrid) -> f64 {
    let pad = m.style.size.note * TIME_SIG_PAD_EM;
    pad + time_sig_width(meter.numerator, meter.denominator, m.style.vertical.barline_height, None, None) + pad
}

/// 多小节休止那道横杠的宽（数字墨迹高的倍数）
pub const MULTI_REST_WIDTH: f64 = 3.2;

struct ItemBox {
    left: f64,
    right: f64,
    lead: f64,
    want: f64,
    over: f64,
}

fn item_box(it: &PlacedItem, m: &JianpuGrid, ink: &Ink) -> ItemBox {
    let el = &it.element;
    if let MusicElement::Barline(b) = el {
        let meter = b.temporary_meter.as_ref().map_or(0.0, |mt| meter_advance(mt, m));
        let Some(bx) = barline_box(b, m) else { return ItemBox { left: 0.0, right: meter, lead: 0.0, want: 0.0, over: 0.0 } };
        return ItemBox { left: bx.left, right: bx.right + meter, lead: if b.temporary_meter.is_some() { 0.0 } else { bx.first / 5.0 }, want: 0.0, over: 0.0 };
    }
    let ch = match el {
        MusicElement::Sustain(_) => "-".to_string(),
        MusicElement::Note(n) if n.sound == Sound::Rhythm => "X".to_string(),
        MusicElement::Note(n) => n.pitch.to_string(),
        _ => "undefined".to_string(),
    };
    let d = ink.digit(&ch);
    let center = (d.ink.left + d.ink.right) / 2.0;
    let mut right = d.advance - center;
    let (mut lead, mut want, mut over) = (0.0, 0.0, 0.0);
    if let MusicElement::Note(n) = el {
        if n.multi_rest.is_some() {
            let half = (m.ink.note_height * MULTI_REST_WIDTH) / 2.0;
            return ItemBox { left: half, right: half + (d.advance - (d.ink.right - d.ink.left)) / 2.0, lead: 0.0, want: 0.0, over: 0.0 };
        }
        if n.dots > 0 {
            right += ink.digit("·").advance * n.dots as f64;
        }
        let names: Vec<&str> = n.ornaments.iter().map(|o| o.name.as_str()).collect();
        let trem = jp_tremolo_count(&names);
        if trem > 0 && !n.hidden {
            right += jp_tremolo_strokes(trem, m.ink.note_height).1;
        }
        if let Some(up) = jp_slide_of(&names) {
            if !n.hidden {
                let ink_end = d.ink.right - center + if n.dots > 0 { ink.digit("·").advance * n.dots as f64 } else { 0.0 };
                right = max(right, ink_end + jp_slide_arrow(up, m.ink.note_height).width);
            }
        }
        let gm = jianpu_grace_metrics(m);
        if !n.grace_before.is_empty() {
            lead = grace_advance(&jianpu_grace_notes(&n.grace_before), &gm);
        }
        if !n.grace_after.is_empty() {
            right += grace_advance(&jianpu_grace_notes(&n.grace_after), &gm);
        }
        let lead0 = accidental_lead_of(n, m);
        if lead0 > 0.0 && m.style.look.accidental_style != "classic" {
            let h = m.ink.note_height;
            over = max(0.0, lead0 - d.ink.left);
            want = over + h * ACCIDENTAL_CLEARANCE;
        }
    }
    ItemBox { left: center, right, lead, want, over }
}

/// 参加归列的一行：各声部的主行，外加内联层（并排下行、`{bz}` 伴奏行；`bar_base` = 它从主行第几小节起）
pub struct SpacedLine<'a> {
    pub items: &'a [PlacedItem],
    pub pad: &'a [f64],
    pub bar_base: Option<f64>,
    /// 这一行的字号相对主旋律（`{bz}` 伴奏行是 `size.cue`，其余 1）：占位盒与 pad 按它缩
    pub scale: f64,
}

impl<'a> SpacedLine<'a> {
    /// 主旋律那样的一整行
    pub fn main(items: &'a [PlacedItem], pad: &'a [f64]) -> Self {
        SpacedLine { items, pad, bar_base: None, scale: 1.0 }
    }
}

struct ColKey {
    bar: f64,
    beat: f64,
    occ: f64,
    col: Column,
}

fn columns_of(lines: &[SpacedLine], m: &JianpuGrid, ink: &Ink) -> Vec<Column> {
    let mut keys: HashMap<(NumKey, NumKey, usize), usize> = HashMap::new();
    let mut entries: Vec<ColKey> = vec![];
    for (v, l) in lines.iter().enumerate() {
        let mut bar = l.bar_base.unwrap_or(0.0);
        let mut seen: HashMap<(NumKey, NumKey), usize> = HashMap::new();
        for (i, it) in l.items.iter().enumerate() {
            let is_bar = matches!(it.element, MusicElement::Barline(_));
            let beat = if is_bar { f64::INFINITY } else { dolce_base::js::round(it.beat * 1e4) / 1e4 };
            let base = (NumKey::new(bar), NumKey::new(beat));
            let occ = *seen.get(&base).unwrap_or(&0);
            seen.insert(base, occ + 1);
            let key = (base.0, base.1, occ);
            let e = *keys.entry(key).or_insert_with(|| {
                entries.push(ColKey {
                    bar,
                    beat,
                    occ: occ as f64,
                    col: Column { members: vec![], bar: is_bar, left: 0.0, right: 0.0, lead: 0.0, want: 0.0, over: 0.0, pad: 0.0 },
                });
                entries.len() - 1
            });
            let mut b = item_box(it, m, ink);
            if l.scale != 1.0 {
                let k = l.scale;
                b = ItemBox { left: b.left * k, right: b.right * k, lead: b.lead * k, want: b.want * k, over: b.over * k };
            }
            let c = &mut entries[e].col;
            c.members.push((v, i));
            c.left = max(c.left, b.left);
            c.right = max(c.right, b.right);
            c.lead = max(c.lead, b.lead);
            c.want = max(c.want, b.want);
            c.over = max(c.over, b.over);
            c.pad = max(c.pad, l.pad.get(i).copied().unwrap_or(0.0) * l.scale);
            if is_bar {
                bar += 1.0;
            }
        }
    }
    let mut order: Vec<usize> = (0..entries.len()).collect();
    dolce_base::js::sort_by(&mut order, |&a, &b| {
        let (a, b) = (&entries[a], &entries[b]);
        or_else(or_else(a.bar - b.bar, a.beat - b.beat), a.occ - b.occ)
    });
    order.into_iter().map(|k| entries[k].col.clone()).collect()
}

/// JS `a || b`（数：0 与 NaN 为假）
fn or_else(a: f64, b: f64) -> f64 {
    if a == 0.0 || a.is_nan() {
        b
    } else {
        a
    }
}

const SQUEEZED_DIGIT: f64 = 0.75;

fn squeezed_cols(cols: &[Column], squeeze: f64) -> Vec<Column> {
    let k = 1.0 - (1.0 - SQUEEZED_DIGIT) * squeeze;
    cols.iter().map(|c| if c.bar { c.clone() } else { Column { right: c.right * k, ..c.clone() } }).collect()
}

struct Packed {
    x: Vec<f64>,
    lyric_right: Vec<f64>,
    lyric_left: Vec<f64>,
}

struct LyricState {
    cur_x: f64,
    prev_blank: f64,
    prev_latin: Vec<String>,
}

fn pack_columns(cols: &[Column], lines: &[SpacedLine], m: &JianpuGrid, ink: &Ink, squeeze: f64) -> Packed {
    let voices = lines.len();
    let gap = m.style.spacing.lyric_gap * (1.0 - squeeze);
    let mut n_: Vec<f64> = vec![];
    let mut cur = 0.0;
    for (i, c) in cols.iter().enumerate() {
        cur += if i == 0 { max(c.lead, c.over) } else { max(c.lead, c.want) };
        n_.push(cur + c.left);
        cur = n_[i] + c.right + c.pad;
    }
    let mut xs: Vec<f64> = vec![];
    let mut lyric_right = vec![f64::NEG_INFINITY; cols.len()];
    let mut lyric_left = vec![f64::INFINITY; cols.len()];
    let mut state: Vec<LyricState> = (0..voices).map(|_| LyricState { cur_x: 0.0, prev_blank: 0.0, prev_latin: vec![] }).collect();
    let mut offset = 0.0;
    for (ci, c) in cols.iter().enumerate() {
        let mut x = n_[ci] + offset;
        let mut runs: Vec<(usize, Vec<LyricRun>)> = vec![];
        for &(v, i) in &c.members {
            let it = &lines[v].items[i];
            let rs: Vec<LyricRun> = it.syllables.iter().flatten().filter(|s| !s.syl.text.is_empty()).map(|s| ink.lyric(&s.syl)).collect();
            if !rs.is_empty() {
                match runs.iter_mut().find(|(vv, _)| *vv == v) {
                    Some(e) => e.1 = rs,
                    None => runs.push((v, rs)),
                }
            }
        }
        for (v, rs) in &runs {
            let st = &state[*v];
            let room = st.prev_blank + gap + min_of(rs.iter().map(|r| r.head_blank));
            let hang = max(0.0, min(min(min_of(rs.iter().map(|r| r.lead)), room), gap));
            let left_most = min_of(rs.iter().map(|r| -(r.lead + r.body / 2.0))) + hang;
            let word_gap = if rs.iter().enumerate().any(|(k, r)| {
                let prev = st.prev_latin.get(k).or(st.prev_latin.first()).map_or("", String::as_str);
                latin_word_break(prev, &r.text)
            }) {
                ink.lyric_space * (1.0 - squeeze / 2.0)
            } else {
                0.0
            };
            x = max(x, st.cur_x + word_gap - left_most);
        }
        offset = x - n_[ci];
        xs.push(x);
        for (v, rs) in &runs {
            let st = &mut state[*v];
            let right_most = max_of(rs.iter().map(|r| r.width - r.lead - r.body / 2.0));
            let tail = min_of(rs.iter().map(|r| r.tail_blank));
            st.cur_x = x + right_most + gap - tail * squeeze;
            st.prev_blank = tail * (1.0 - squeeze);
            st.prev_latin = rs.iter().map(|r| r.text.clone()).collect();
            lyric_right[ci] = max(lyric_right[ci], x + right_most);
            lyric_left[ci] = min(lyric_left[ci], x + min_of(rs.iter().map(|r| -(r.lead + r.body / 2.0))));
        }
    }
    Packed { x: xs, lyric_right, lyric_left }
}

/// 水位法两端对齐（`Line.adjust`）
fn justify(cols: &[Column], xs: &mut [f64], extra: f64, even: bool) {
    #[derive(Clone)]
    struct Info {
        i: usize,
        dist: f64,
        rate: f64,
    }
    let mut infos: Vec<Info> = vec![];
    for i in 0..cols.len().saturating_sub(1) {
        let (a, b) = (&cols[i], &cols[i + 1]);
        infos.push(Info { i, dist: xs[i + 1] - b.left - (xs[i] + a.right), rate: if !a.bar && !b.bar { 2.0 } else { 1.0 } });
    }
    if even {
        let last_bar: i64 = if cols[cols.len() - 1].bar { infos.len() as i64 - 1 } else { -1 };
        let mut sum = 0.0;
        for (k, it) in infos.iter().enumerate() {
            sum += if k as i64 == last_bar { 0.0 } else { it.rate };
        }
        if sum == 0.0 {
            return;
        }
        let mut moved = 0.0;
        for (k, it) in infos.iter().enumerate() {
            xs[k] += moved;
            if k as i64 != last_bar {
                moved += (extra * it.rate) / sum;
            }
        }
        let n = infos.len();
        xs[n] += moved;
        return;
    }
    dolce_base::js::sort_by(&mut infos, |p, q| {
        let diff = p.dist * q.rate - q.dist * p.rate;
        if diff < 0.0 {
            -1.0
        } else if diff > 0.0 {
            1.0
        } else {
            p.rate - q.rate
        }
    });
    let (mut total_dist, mut total_rate) = (0.0, 0.0);
    let mut end = 0;
    while end < infos.len() {
        let it = &infos[end];
        let share = (extra + total_dist + it.dist) / (total_rate + it.rate);
        if share < it.dist / it.rate {
            break;
        }
        total_dist += it.dist;
        total_rate += it.rate;
        end += 1;
    }
    if total_rate == 0.0 {
        return;
    }
    let share = (extra + total_dist) / total_rate;
    let mut add = vec![0.0; cols.len()];
    for it in &infos[..end] {
        add[it.i] = share * it.rate - it.dist;
    }
    let mut offset = 0.0;
    for i in 0..cols.len() {
        xs[i] += offset;
        offset += add[i];
    }
}

/// 行右缘：从末列往回，到最后一个带歌词的列为止
fn right_of(cols: &[Column], xs: &[f64], lyric_right: &[f64]) -> f64 {
    let mut r: f64 = 0.0;
    for i in (0..cols.len()).rev() {
        r = max(max(r, xs[i] + cols[i].right), lyric_right[i]);
        if lyric_right[i] > f64::NEG_INFINITY {
            break;
        }
    }
    r
}

struct Ctx<'a> {
    m: &'a JianpuGrid,
    width: f64,
}

impl Ctx<'_> {
    fn extra_of(&self, r: f64) -> (f64, bool) {
        let cap = self.m.style.spacing.max_horizontal_scale * r;
        if self.width - r > cap {
            (cap, true)
        } else {
            (self.width - r, false)
        }
    }
    /// `justified(xs)`：rightOf 读的是当前的 X（与 xs 同值），按它两端对齐 xs
    fn justified(&self, cols: &[Column], r: f64, xs: &mut [f64]) {
        if self.width > r {
            justify(cols, xs, self.extra_of(r).0, self.m.style.look.even_justify.unwrap_or(false));
        }
    }
}

/// 各符号最终的 (x, advance)，与 `lines` / `items` 平行
pub type Placement = Vec<Vec<(f64, f64)>>;

/// 一组各声部的横向排列：归列 → 紧排 → 歌词避让 → 两端对齐。返回 (自然宽, 各符号的 x 与 advance)
pub fn place_columns(lines: &[SpacedLine], m: &JianpuGrid, ink: &Ink, width: f64) -> (f64, Placement) {
    let mut cols = columns_of(lines, m, ink);
    let mut out: Placement = lines.iter().map(|l| vec![(0.0, 0.0); l.items.len()]).collect();
    if cols.is_empty() {
        return (0.0, out);
    }
    let p = pack_columns(&cols, lines, m, ink, 0.0);
    let (mut xs, mut lyric_right) = (p.x, p.lyric_right);
    if right_of(&cols, &xs, &lyric_right) > width {
        let base = cols.clone();
        let at = |q: f64, cols: &mut Vec<Column>, xs: &mut Vec<f64>, lr: &mut Vec<f64>| {
            *cols = squeezed_cols(&base, q);
            let p = pack_columns(cols, lines, m, ink, q);
            *xs = p.x;
            *lr = p.lyric_right;
        };
        let (mut lo, mut hi) = (0.0, 1.0);
        at(hi, &mut cols, &mut xs, &mut lyric_right);
        if right_of(&cols, &xs, &lyric_right) <= width {
            for _ in 0..8 {
                let mid = (lo + hi) / 2.0;
                at(mid, &mut cols, &mut xs, &mut lyric_right);
                if right_of(&cols, &xs, &lyric_right) > width {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            at(hi, &mut cols, &mut xs, &mut lyric_right);
        }
    }
    let cx = Ctx { m, width };
    let words = SectionWordRoom::new(lines, &cols, m, ink, width);
    words.spread(lines, &cols, &cx, ink, &mut xs, &mut lyric_right);
    BarEndRoom::new(lines, &cols, m, ink).spread(lines, &cols, &cx, ink, &mut xs, &mut lyric_right);
    let right = right_of(&cols, &xs, &lyric_right);
    if width > right {
        let (extra, capped) = cx.extra_of(right);
        justify(&cols, &mut xs, extra, m.style.look.even_justify.unwrap_or(false));
        let n = cols.len();
        if !capped && n >= 2 && cols[n - 1].bar && !cols[n - 2].bar {
            let (last, prev) = (&cols[n - 1], &cols[n - 2]);
            let dx = xs[n - 1] - last.left - (xs[n - 2] + prev.right);
            let space = width - (xs[n - 1] + last.right);
            if space > 0.0 {
                xs[n - 1] += max(0.0, min(space, m.style.size.note * 3.0 - dx));
            }
        }
    }
    words.nudge(lines, &cols, m, ink, width, &mut xs);
    for (i, c) in cols.iter().enumerate() {
        for &(v, k) in &c.members {
            out[v][k] = (xs[i], if i + 1 < cols.len() { xs[i + 1] - xs[i] } else { c.right });
        }
    }
    (right, out)
}

/// 把 `place_columns` 的结果写回各行
pub fn apply_placement(items: &mut [PlacedItem], placed: &[(f64, f64)]) {
    for (it, &(x, a)) in items.iter_mut().zip(placed) {
        it.x = x;
        it.advance = a;
    }
}

fn col_of(cols: &[Column], lines: &[SpacedLine]) -> Vec<Vec<usize>> {
    let mut out: Vec<Vec<usize>> = lines.iter().map(|l| vec![0; l.items.len()]).collect();
    for (ci, c) in cols.iter().enumerate() {
        for &(v, i) in &c.members {
            out[v][i] = ci;
        }
    }
    out
}

/// 撑开预演用的和弦墨迹范围：按各自锚点居中、没做横向让位
fn preview_chords(items: &[PlacedItem], x_of: &dyn Fn(usize) -> f64, ink: &Ink) -> Vec<ChordSpan> {
    let mut chords = vec![];
    for (i, it) in items.iter().enumerate() {
        let text = match &it.element {
            MusicElement::Note(n) => n.chord.as_deref(),
            MusicElement::Sustain(s) => s.chord.as_deref(),
            _ => None,
        };
        let Some(text) = text.filter(|t| !t.is_empty()) else { continue };
        let (adv, r) = ink.chord(text);
        let Some(r) = r else { continue };
        let x = x_of(i) - adv / 2.0;
        chords.push(ChordSpan { x0: x + r.left, x1: x + r.right, at: i });
    }
    chords
}

struct Word {
    line: usize,
    i: usize,
    ink: Rect,
    start: bool,
}

/// 段落词要的横向地方（`Line.spreadForSectionWords` / `nudgeForSectionWords`）
struct SectionWordRoom {
    col_of: Vec<Vec<usize>>,
    words: Vec<Word>,
}

impl SectionWordRoom {
    fn new(lines: &[SpacedLine], cols: &[Column], m: &JianpuGrid, ink: &Ink, _width: f64) -> SectionWordRoom {
        let mut r = SectionWordRoom { col_of: vec![], words: vec![] };
        if m.style.size.section_word <= 0.0 {
            return r;
        }
        r.col_of = col_of(cols, lines);
        for (li, l) in lines.iter().enumerate() {
            let start = line_start_index(l.items);
            for (i, it) in l.items.iter().enumerate() {
                let Some(w) = section_word_of(&it.element) else { continue };
                let ls = section_word_lines(w);
                if ls.is_empty() {
                    continue;
                }
                r.words.push(Word { line: li, i, ink: widest_line(&ls, |x| ink.section_word(x).2), start: i as i64 == start });
            }
        }
        r
    }

    fn slot(&self, w: &Word, lines: &[SpacedLine], xs: &[f64], m: &JianpuGrid, ink: &Ink, width: f64) -> dolce_engrave::sectionword::SectionWordSlot {
        let items = lines[w.line].items;
        let cof = &self.col_of[w.line];
        let x_of = |k: usize| xs[cof[k]];
        section_word_slot(items, w.i, &x_of, &preview_chords(items, &x_of, ink), w.ink, m, width).0
    }

    fn spread(&self, lines: &[SpacedLine], cols: &[Column], cx: &Ctx, ink: &Ink, xs: &mut [f64], lyric_right: &mut [f64]) {
        let (m, width) = (cx.m, cx.width);
        let size = m.style.size.section_word;
        for w in &self.words {
            if w.start {
                continue;
            }
            let mut probe = xs.to_vec();
            cx.justified(cols, right_of(cols, xs, lyric_right), &mut probe);
            if !self.slot(w, lines, &probe, m, ink, width).lifted {
                continue;
            }
            let now = self.slot(w, lines, xs, m, ink, width);
            if !now.lifted {
                continue;
            }
            let ca = self.col_of[w.line][w.i];
            let mut cb = ca + 1;
            while cb < cols.len() && !cols[cb].bar {
                cb += 1;
            }
            let steps = (cb - ca) as f64;
            let frac = |k: usize| -> f64 {
                if k <= ca {
                    0.0
                } else if k >= cb {
                    1.0
                } else {
                    (k - ca) as f64 / steps
                }
            };
            let shifted = |s: f64| -> Vec<f64> { xs.iter().enumerate().map(|(k, x)| x + s * frac(k)).collect() };
            let mut hi = now.shortfall * steps + size;
            if self.slot(w, lines, &shifted(hi), m, ink, width).lifted {
                continue;
            }
            let mut lo = 0.0;
            while hi - lo > 0.25 {
                let mid = (lo + hi) / 2.0;
                if self.slot(w, lines, &shifted(mid), m, ink, width).lifted {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            if right_of(cols, xs, lyric_right) + hi > width {
                continue;
            }
            for k in 0..xs.len() {
                let d = hi * frac(k);
                xs[k] += d;
                if lyric_right[k] > f64::NEG_INFINITY {
                    lyric_right[k] += d;
                }
            }
        }
    }

    fn nudge(&self, lines: &[SpacedLine], cols: &[Column], m: &JianpuGrid, ink: &Ink, width: f64, xs: &mut [f64]) {
        let n = cols.len() as f64;
        for w in &self.words {
            if !w.start {
                continue;
            }
            let slot = self.slot(w, lines, xs, m, ink, width);
            if !slot.lifted || slot.shortfall <= 0.0 {
                continue;
            }
            let ca = self.col_of[w.line][w.i];
            let denom = n - 2.0 - ca as f64;
            if denom <= 0.0 {
                continue;
            }
            for (k, x) in xs.iter_mut().enumerate().take(cols.len()).skip(ca + 1) {
                *x += (slot.shortfall * (n - 1.0 - k as f64)) / denom;
            }
        }
    }
}

struct BarMark {
    line: usize,
    bar: usize,
    width: f64,
    bar_right: f64,
}

/// 小节线上的跳转字要的横向地方（`Line.spreadForBarEndMarks`）
struct BarEndRoom {
    col_of: Vec<Vec<usize>>,
    marks: Vec<BarMark>,
    size: f64,
}

impl BarEndRoom {
    fn new(lines: &[SpacedLine], cols: &[Column], m: &JianpuGrid, ink: &Ink) -> BarEndRoom {
        let size = if m.style.size.chord > 0.0 { m.style.size.chord } else { m.style.size.note * 0.6 };
        let mut marks = vec![];
        for (li, l) in lines.iter().enumerate() {
            for (i, it) in l.items.iter().enumerate() {
                let MusicElement::Barline(b) = &it.element else { continue };
                if it.dy.is_some() {
                    continue;
                }
                let texts: Vec<&str> = b.ornaments.iter().filter_map(|o| barline_mark(&o.name).and_then(|bm| bm.0)).filter(|t| !t.is_empty()).collect();
                if texts.is_empty() {
                    continue;
                }
                let mut w = 0.0;
                for t in &texts {
                    let r = ink.text(t, crate::model::InkTextRole::Jump);
                    w += max(r.advance, r.ink.right);
                }
                w += (texts.len() as f64 - 1.0) * size * 0.25;
                marks.push(BarMark { line: li, bar: i, width: w, bar_right: barline_box(b, m).map_or(0.0, |bx| bx.right) });
            }
        }
        BarEndRoom { col_of: col_of(cols, lines), marks, size }
    }

    fn shortfall(&self, k: &BarMark, lines: &[SpacedLine], xs: &[f64], ink: &Ink) -> f64 {
        let items = lines[k.line].items;
        let cof = &self.col_of[k.line];
        let x_of = |i: usize| xs[cof[i]];
        let bar_x = x_of(k.bar);
        let mut right_most = f64::NEG_INFINITY;
        let mut chords = preview_chords(items, &x_of, ink);
        dolce_base::js::sort_by(&mut chords, |a, b| a.x0 - b.x0);
        for i in 1..chords.len() {
            let need = chords[i - 1].x1 + self.size * 0.28 - chords[i].x0;
            if need <= 0.0 {
                continue;
            }
            let dx = min(need, self.size * 1.2);
            chords[i].x0 += dx;
            chords[i].x1 += dx;
        }
        for c in &chords {
            if x_of(c.at) < bar_x {
                right_most = max(right_most, c.x1);
            }
        }
        right_most + self.size * 0.35 + k.width - (bar_x + k.bar_right)
    }

    fn spread(&self, lines: &[SpacedLine], cols: &[Column], cx: &Ctx, ink: &Ink, xs: &mut [f64], lyric_right: &mut [f64]) {
        for k in &self.marks {
            let mut probe = xs.to_vec();
            cx.justified(cols, right_of(cols, xs, lyric_right), &mut probe);
            if self.shortfall(k, lines, &probe, ink) <= 0.0 {
                continue;
            }
            let need = self.shortfall(k, lines, xs, ink);
            if need <= 0.0 {
                continue;
            }
            if right_of(cols, xs, lyric_right) + need > cx.width {
                continue;
            }
            let cb = self.col_of[k.line][k.bar];
            let mut ca = cb as i64 - 1;
            while ca > 0 && !cols[ca as usize].members.iter().any(|&(v, i)| matches!(lines[v].items[i].element, MusicElement::Note(_))) {
                ca -= 1;
            }
            let steps = cb as f64 - ca as f64;
            for i in 0..xs.len() {
                let ii = i as i64;
                let d = if ii <= ca {
                    0.0
                } else if i >= cb {
                    need
                } else {
                    (need * (ii - ca) as f64) / steps
                };
                xs[i] += d;
                if d > 0.0 && lyric_right[i] > f64::NEG_INFINITY {
                    lyric_right[i] += d;
                }
            }
        }
    }
}

/// 整组的自然列锚点（紧排 + 歌词避让，不两端对齐）
pub struct Natural {
    /// 与 lines / items 平行
    pub x: Vec<Vec<f64>>,
    pub left: Vec<Vec<f64>>,
    pub right: Vec<Vec<f64>>,
    pub width: f64,
}

pub fn natural_columns(lines: &[SpacedLine], m: &JianpuGrid, ink: &Ink, squeeze: f64) -> Natural {
    let cols = squeezed_cols(&columns_of(lines, m, ink), squeeze);
    let p = pack_columns(&cols, lines, m, ink, squeeze);
    let mut out = Natural {
        x: lines.iter().map(|l| vec![0.0; l.items.len()]).collect(),
        left: lines.iter().map(|l| vec![0.0; l.items.len()]).collect(),
        right: lines.iter().map(|l| vec![0.0; l.items.len()]).collect(),
        width: 0.0,
    };
    let mut width: f64 = 0.0;
    for (i, c) in cols.iter().enumerate() {
        for &(v, k) in &c.members {
            out.x[v][k] = p.x[i];
            out.left[v][k] = min(p.x[i] - c.left, p.lyric_left[i]);
            out.right[v][k] = max(p.x[i] + c.right, p.lyric_right[i]);
        }
        width = max(max(width, p.x[i] + c.right + c.pad), p.lyric_right[i]);
    }
    out.width = width;
    out
}
