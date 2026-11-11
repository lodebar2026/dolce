//! 房子（反复的第几房）：谱表上方一条平直的长横线，左端垂着一截竖钩、钩对着一根小节线。房号不读字，在整曲拼接时按反复线推。
use super::Piece;
use crate::attrs::RowAttrs;
use crate::page::Layout;
use dolce_omr_sheet::element::{Probe, BG};

/// 横线宽度下限（相对线距）、离两端连线最远不过、墨厚上限、两端相对谱表的高差上限（音级位置）。
const MIN_W: f64 = 5.0;
const DEV: f64 = 0.15;
const THICK: f64 = 0.3;
const TILT_POS: f64 = 0.7;
/// 横线在谱表首线上方多远（相对线距）。
const ABOVE_MIN: f64 = 1.2;
const ABOVE_MAX: f64 = 7.0;
/// 竖钩：长度范围（相对线距）、在横线端点左右多远内找。
const HOOK_MIN: f64 = 0.7;
const HOOK_MAX: f64 = 5.0;
const HOOK_NEAR: f64 = 0.5;
/// 钩离小节线不过这么多（相对线距）。
const BAR_NEAR: f64 = 1.5;
/// 钩底也往右拉着这么长横墨的是文字框（相对线距）。
const BOX_RUN: f64 = 2.0;

/// 一个房子：归哪一行谱、横线的范围与高度、右端有没有收口的钩。
#[derive(Clone, Debug, PartialEq)]
pub struct Volta {
    pub staff: usize,
    pub x0: f64,
    pub x1: f64,
    pub y: f64,
    pub closed: bool,
}

/// 横线端点 `(x, y)` 附近往下垂的竖墨：回 `(列, 底端 y)`。
fn hook(ink: &dyn Probe, x: i64, y: i64, sp: f64) -> Option<(i64, i64)> {
    let near = (HOOK_NEAR * sp).ceil() as i64;
    (x - near..=x + near)
        .filter_map(|cx| {
            // 从横线那一行附近起往下数连着的墨
            let y0 = (y - 2..=y + 2).find(|&yy| ink.at(cx, yy) != BG)?;
            let mut yy = y0;
            while ink.at(cx, yy + 1) != BG {
                yy += 1;
            }
            let len = (yy - y) as f64;
            (len >= HOOK_MIN * sp && len <= HOOK_MAX * sp).then_some((cx, yy))
        })
        .max_by_key(|&(_, yy)| yy)
}

/// `ink`：回看墨迹的探针（像素页的墨层、矢量页的对象库）。
pub fn voltas(f: &Layout, ink: &dyn Probe, attrs: &[RowAttrs], pieces: &[Piece]) -> Vec<Volta> {
    let mut out: Vec<Volta> = Vec::new();
    for p in pieces {
        let (a, b) = (p.shape.a, p.shape.b);
        let mx = (a.0 + b.0) / 2.0;
        // 归它正下方最近的那行谱
        let Some(si) = (0..f.staves.len())
            .filter(|&k| {
                let s = &f.staves[k];
                let d = (s.top(mx) - p.mid_y()) / s.space();
                a.0 >= s.left - s.space() && b.0 <= s.right + s.space() && (ABOVE_MIN..=ABOVE_MAX).contains(&d)
            })
            .min_by(|&p1, &p2| f.staves[p1].top(mx).total_cmp(&f.staves[p2].top(mx)))
        else {
            continue;
        };
        let st = &f.staves[si];
        let sp = st.space();
        if p.width() < MIN_W * sp || p.shape.up.max(p.shape.down) > DEV * sp || p.shape.thick > THICK * sp || (st.pos(a.0, a.1) - st.pos(b.0, b.1)).abs() > TILT_POS {
            continue;
        }
        let Some((hx, hy)) = hook(ink, a.0 as i64, a.1.round() as i64, sp) else { continue };
        // 钩对着一根小节线；行首接着上一行的那一房，钩落在第一小节里
        let lead = attrs.get(si).map_or(st.left, |r| r.lead_end.max(st.left));
        let first_bar = f.bars[si].iter().map(|b| b.x).filter(|&x| x > lead).fold(f64::MAX, f64::min);
        let at_bar = f.bars[si].iter().any(|b| (b.x - hx as f64).abs() <= BAR_NEAR * sp);
        if !at_bar && !((hx as f64) < first_bar && hx as f64 >= lead - 2.0 * sp) {
            continue;
        }
        // 钩底也往右拉着横线的是文字框
        let run = (1..).take_while(|d| ink.at(hx + d, hy) != BG || ink.at(hx + d, hy - 1) != BG).count();
        if run as f64 >= BOX_RUN * sp {
            continue;
        }
        let closed = hook(ink, b.0 as i64, b.1.round() as i64, sp).is_some();
        out.push(Volta { staff: si, x0: hx as f64, x1: b.0, y: p.mid_y(), closed });
    }
    out.sort_by(|a, b| a.staff.cmp(&b.staff).then(a.x0.total_cmp(&b.x0)));
    out
}
