//! 弧（圆滑线 / 延音线）：拱着的细笔画，两端各挂一个和弦；行首、行尾只挂得上一端的是跨行的半条。
use super::Piece;
use crate::attrs::RowAttrs;
use crate::notes::{Chord, RowNotes};
use crate::page::Layout;

/// 弧的宽度下限、拱高下限（相对线距）；拱高还不得低于宽的这么多、不得高过宽的这么多（延长记号的拱又短又高）。
const MIN_W: f64 = 1.1;
const MIN_ARCH: f64 = 0.15;
const ARCH_PER_W: f64 = 0.03;
const ARCH_MAX_PER_W: f64 = 0.45;
/// 背面（不朝拱的一侧）鼓出不过这么多（相对线距）与拱高的这么多。
const BACK_MAX: f64 = 0.12;
const BACK_PER_ARCH: f64 = 0.3;
/// 墨厚（各列中位）不过这么多（相对线距）；两端连线的斜率上限；拱顶不在最外这一截里。
const THICK_MAX: f64 = 0.32;
const SLOPE_MAX: f64 = 1.2;
const PEAK_EDGE: f64 = 0.12;
/// 挂端：弧端在和弦左 / 右多远以内（相对线距；起端在头心稍右、止端在头心稍左是常态）。
const END_OUT: f64 = 1.0;
const END_IN: f64 = 2.0;
const END_BIAS: f64 = 0.6;
/// 弧端离和弦（各头、干端）纵向不过这么多（相对线距）。
const END_DY: f64 = 2.6;
/// 跨行的半条：空着的那一端要越过本行最外的和弦这么多、离谱表端不过这么多（相对线距）。
const OPEN_PAST: f64 = 0.8;
const OPEN_EDGE: f64 = 3.5;

/// 指认一个和弦：它的 x 与最上面那个头的 y（同一拍点上下两个声部各带干的两个和弦 x 相同）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChordRef {
    pub x: f64,
    pub y: f64,
}

impl ChordRef {
    fn of(c: &Chord) -> Self {
        ChordRef { x: c.x, y: c.heads[0].y }
    }
}

/// 一条弧。
#[derive(Clone, Debug, PartialEq)]
pub struct Arc {
    pub staff: usize,
    /// 两端（像素）。
    pub a: (f64, f64),
    pub b: (f64, f64),
    /// 朝上拱（画在音的上方）。
    pub above: bool,
    /// 起端、止端挂的和弦；空着的一端是跨行的（弧画到行尾 / 从行首来）。
    pub start: Option<ChordRef>,
    pub end: Option<ChordRef>,
}

/// 和弦纵向占的几处（各头、干端）里离 `y` 最近的距离。
fn dy_to(c: &Chord, y: f64) -> f64 {
    let tips = c.stem.iter().flat_map(|s| [s.top as f64, s.bottom as f64]);
    c.heads.iter().map(|h| h.y).chain(tips).map(|v| (v - y).abs()).fold(f64::MAX, f64::min)
}

/// 弧的一端 `(x, y)` 在这一行里挂哪个和弦：回 `(和弦下标, 花费)`。`start`：起端（和弦在弧端左边一点）。
fn anchor(chords: &[Chord], sp: f64, (x, y): (f64, f64), start: bool) -> Option<(usize, f64)> {
    let (lo, hi) = if start { (x - END_IN * sp, x + END_OUT * sp) } else { (x - END_OUT * sp, x + END_IN * sp) };
    let want = if start { x - END_BIAS * sp } else { x + END_BIAS * sp };
    chords
        .iter()
        .enumerate()
        .filter(|(_, c)| c.x >= lo && c.x <= hi)
        .map(|(i, c)| (i, c, dy_to(c, y)))
        .filter(|&(_, _, dy)| dy <= END_DY * sp)
        .map(|(i, c, dy)| (i, ((c.x - want).abs() + 0.4 * dy) / sp))
        .min_by(|a, b| a.1.total_cmp(&b.1))
}

/// 像不像弧。
fn arch_like(p: &Piece, sp: f64) -> bool {
    let (arch, _) = p.shape.arch();
    let w = p.width();
    w >= MIN_W * sp
        && arch >= (MIN_ARCH * sp).max(ARCH_PER_W * w)
        && arch <= ARCH_MAX_PER_W * w
        && p.shape.back() <= (BACK_MAX * sp).max(BACK_PER_ARCH * arch)
        && p.shape.thick <= THICK_MAX * sp
        && p.shape.slope().abs() <= SLOPE_MAX
        && p.shape.peak > PEAK_EDGE
        && p.shape.peak < 1.0 - PEAK_EDGE
}

pub fn arcs(f: &Layout, attrs: &[RowAttrs], notes: &[RowNotes], pieces: &[Piece]) -> Vec<Arc> {
    let mut out: Vec<(Arc, f64)> = Vec::new();
    for p in pieces {
        if !arch_like(p, f.unit.space) {
            continue;
        }
        let (a, b) = (p.shape.a, p.shape.b);
        let (_, above) = p.shape.arch();
        // 各行谱里各自找两端，取挂得最好的那一行；两端都挂上的优先
        let mut best: Option<(Arc, f64)> = None;
        for (si, st) in f.staves.iter().enumerate() {
            let sp = st.space();
            let my = (a.1 + b.1) / 2.0;
            let mx = (a.0 + b.0) / 2.0;
            if my < st.top(mx) - 7.0 * sp || my > st.bottom(mx) + 7.0 * sp || !arch_like(p, sp) {
                continue;
            }
            let chords = &notes[si].chords;
            let (s, e) = (anchor(chords, sp, a, true), anchor(chords, sp, b, false));
            let cand = match (s, e) {
                (Some((i, ci)), Some((j, cj))) if chords[i].x < chords[j].x => Some((Some(ChordRef::of(&chords[i])), Some(ChordRef::of(&chords[j])), ci + cj)),
                (Some((i, ci)), _) => {
                    // 画到行尾：越过本行最后一个和弦、离谱表右端不远
                    let last = chords.last().map_or(f64::MIN, |c| c.x);
                    (b.0 > last + OPEN_PAST * sp && b.0 >= st.right - OPEN_EDGE * sp && chords[i].x >= last - 1.0).then_some((Some(ChordRef::of(&chords[i])), None, ci + 10.0))
                }
                (None, Some((j, cj))) => {
                    // 从行首来：起在本行第一个和弦之前、离行首区不远
                    let first = chords.first().map_or(f64::MAX, |c| c.x);
                    let lead = attrs.get(si).map_or(st.left, |r| r.lead_end.max(st.left));
                    (a.0 < first - OPEN_PAST * sp && a.0 <= lead + OPEN_EDGE * sp && chords[j].x <= first + 1.0).then_some((None, Some(ChordRef::of(&chords[j])), cj + 10.0))
                }
                _ => None,
            };
            if let Some((start, end, cost)) = cand {
                if best.as_ref().is_none_or(|b| cost < b.1) {
                    best = Some((Arc { staff: si, a, b, above, start, end }, cost));
                }
            }
        }
        if let Some((arc, _)) = best {
            // 同样两端的只留最宽的一条（没接上的碎段）
            match out.iter_mut().find(|(o, _)| o.staff == arc.staff && o.start == arc.start && o.end == arc.end && o.above == arc.above) {
                Some(o) if p.width() > o.1 => *o = (arc, p.width()),
                Some(_) => {}
                None => out.push((arc, p.width())),
            }
        }
    }
    out.into_iter().map(|(a, _)| a).collect()
}
