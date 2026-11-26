//! 线性符号（M5）：弧（[`arcs`]：圆滑线 / 延音线）、松叶（[`wedges`]）、房子（[`voltas`]）。
//!
//! 三样共用一批**细笔画**（`omr-sheet::curves`）：原图上纵向墨段不厚的墨逐列追踪成「一列一段墨」的笔画——
//! 符头、符干、符杠都比它厚，自然不在里面；粘在音符上的弧也因此与音符分开。不去线：谱线上的存疑像素不算墨，
//! 笔画贴着谱线走的那一截断开，按走向跨过谱线接回来（断口里只许是谱线、一根符干宽的墨、很短的白）。
//! 然后按形状分：拱着的是弧，直的成对张开的是松叶，直的、平的、左端垂着一截竖钩的是房子横线。
//! 这里只定「是什么、在哪、挂哪个和弦」；延音线与圆滑线之分要音高，跨行的接续要声部，都在整曲拼接时定（[`crate::song`]）。
pub mod arcs;
pub mod voltas;
pub mod wedges;

use crate::attrs::RowAttrs;
use crate::frame::ink::{BG, INK, LINE};
use crate::notes::RowNotes;
use crate::page::{Layout, PageFrame};
use dolce_omr_core::sheet::element::Probe;
use crate::text::PageText;
use dolce_omr_core::sheet::curves::{join_all, trace, JoinTol, Shape, Stroke};

/// 细墨：纵向墨段不厚过这么多（相对线距）。弧最厚处两三成格，符杠半格起。
const THIN: f64 = 0.45;
/// 追踪时不留比这窄的碎段（相对线距）。
const MIN_PIECE: f64 = 0.25;
/// 跨谱线拼接：断口最宽、其中符号墨（符干）与空白各最多多少（相对线距）。
const GAP_MAX: f64 = 3.0;
const GAP_INK: f64 = 0.35;
const GAP_BLANK: f64 = 0.3;
/// 拼接时顺走向延过去的纵向容差（相对线距；每列断口再放一点）。
const JOIN_DY: f64 = 0.3;
const JOIN_DY_PER: f64 = 0.12;

/// 一页的线性符号。
#[derive(Clone, Debug, Default)]
pub struct PageSpans {
    pub arcs: Vec<arcs::Arc>,
    pub wedges: Vec<wedges::Wedge>,
    pub voltas: Vec<voltas::Volta>,
}

/// 一条细笔画与它的形状。
pub struct Piece {
    pub stroke: Stroke,
    pub shape: Shape,
}

impl Piece {
    pub fn width(&self) -> f64 {
        self.stroke.width()
    }
    pub fn mid_y(&self) -> f64 {
        (self.shape.a.1 + self.shape.b.1) / 2.0
    }
}

/// 细墨掩膜：符号墨里纵向墨段不厚过 `max` 像素的那些。
fn thin_mask(f: &PageFrame, max: usize) -> Vec<u8> {
    let (w, h) = (f.ink.w, f.ink.h);
    let mut m = vec![0u8; w * h];
    for x in 0..w {
        let mut y = 0;
        while y < h {
            if f.ink.tri[y * w + x] != INK {
                y += 1;
                continue;
            }
            let a = y;
            while y < h && f.ink.tri[y * w + x] == INK {
                y += 1;
            }
            if y - a <= max {
                for yy in a..y {
                    m[yy * w + x] = 1;
                }
            }
        }
    }
    m
}

/// 整页的细笔画（跨谱线接好的）。落在字行里的不要。
pub fn pieces(f: &PageFrame, text: &PageText) -> Vec<Piece> {
    let sp = f.unit.space;
    let mask = thin_mask(f, (THIN * sp).round().max(2.0) as usize);
    let raw = trace(&mask, f.ink.w, f.ink.h, (MIN_PIECE * sp).round().max(3.0) as usize);
    // 字行里的笔画（横、撇、捺）不当候选
    let in_text = |s: &Stroke| {
        let (cx, cy) = ((s.x0 + s.x1()) as f64 / 2.0, s.mid((s.x0 + s.x1()) / 2));
        text.bands.iter().flat_map(|b| b.lines.iter()).flat_map(|l| l.segs.iter()).any(|g| cx >= g.rect.x && cx <= g.rect.right() && cy >= g.rect.y && cy <= g.rect.bottom())
    };
    let raw: Vec<Stroke> = raw.into_iter().filter(|s| !in_text(s)).collect();
    let tol = JoinTol { max_gap: (GAP_MAX * sp) as i64, dy: JOIN_DY * sp, dy_per_gap: JOIN_DY_PER, span: (sp * 0.8).max(3.0) as usize };
    // 断口里顺两端连线走：谱线上的存疑像素随便过，符号墨只许一根符干那么宽，空白只许很短
    let passable = |a: &Stroke, b: &Stroke| {
        let (xa, xb) = (a.x1(), b.x0);
        let (ya, yb) = (a.mid(xa), b.mid(xb));
        let (mut ink, mut blank) = (0, 0);
        for x in xa + 1..xb {
            let y = (ya + (yb - ya) * (x - xa) as f64 / (xb - xa) as f64).round() as i64;
            let v = [0i64, -1, 1].iter().map(|d| f.ink.at(x, y + d)).find(|&v| v != BG).unwrap_or(BG);
            match v {
                LINE => {}
                INK => ink += 1,
                _ => blank += 1,
            }
        }
        ink as f64 <= GAP_INK * sp && blank as f64 <= GAP_BLANK * sp
    };
    join_all(raw, tol, &passable).into_iter().map(|stroke| Piece { shape: stroke.shape(), stroke }).collect()
}

/// 一页的线性符号。
pub fn page_spans(f: &PageFrame, attrs: &[RowAttrs], notes: &[RowNotes], text: &PageText) -> PageSpans {
    let ps = pieces(f, text);
    judge(&f.layout, &f.ink, attrs, notes, ps)
}

/// 细笔画 → 弧、松叶、房子（像素页、矢量页同一份判据；`ink` 是回看墨迹的探针）。
pub fn judge(f: &Layout, ink: &dyn Probe, attrs: &[RowAttrs], notes: &[RowNotes], ps: Vec<Piece>) -> PageSpans {
    let wedges = wedges::wedges(f, &ps);
    let voltas = voltas::voltas(f, ink, attrs, &ps);
    let arcs = arcs::arcs(f, attrs, notes, &ps);
    PageSpans { arcs, wedges, voltas }
}
