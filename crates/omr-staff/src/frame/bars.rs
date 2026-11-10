//! **小节线**（在符头之前定）：竖段里纵贯一行谱（首线到末线）、两端不伸出谱表（或伸进同系统的邻行，贯穿小节线）、
//! 两端旁边没挂着符头那样的一团墨（那是符干）的，按相邻几根并成一条（双线、终止线、反复记号的粗细两笔）。
use crate::frame::ink::{InkLayers, VSeg, BG};
use dolce_omr_sheet::{Staff, Unit};
use serde::{Deserialize, Serialize};

/// 两端可以超出首末线多少（相对线距）还算「不伸出谱表」。
const END_TOL: f64 = 0.6;
/// 两端要盖到首末线以内多少（相对线距）：短过这个的是谱表里的竖笔（升降号、符干）。
const REACH_TOL: f64 = 0.35;
/// 竖笔最宽（相对线距）：再宽是实心块。
const MAX_WIDTH: f64 = 0.8;
/// 粗笔：宽过细笔中位数的这个倍数（终止线、反复记号那一笔）。
const HEAVY: f64 = 2.0;
/// 几根竖笔相隔不过这么多（相对线距）并成一条小节线。
const GROUP_GAP: f64 = 1.0;
/// 谱行左端这么宽（相对线距）以内的竖笔是系统线 / 括号，不算小节线。
const START_ZONE: f64 = 0.8;
/// 端点旁符头窗：宽（相对线距）、窗里墨占比过这个就当挂着符头。
const HEAD_WIN: f64 = 1.2;
const HEAD_FILL: f64 = 0.35;

/// 小节线的样式（MusicXML `bar-style` 的口径）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum BarStyle {
    Regular,
    /// 两根细
    LightLight,
    /// 细 + 粗（终止线、反复结束）
    LightHeavy,
    /// 粗 + 细（反复开始）
    HeavyLight,
    Heavy,
}

/// 一行谱上的一条小节线。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Barline {
    /// 代表 x（几笔的中心）与左右缘。
    pub x: f64,
    pub x0: f64,
    pub x1: f64,
    pub style: BarStyle,
    /// 组成它的竖段（证据）。
    pub segs: Vec<VSeg>,
}

/// 一行谱的小节线候选（未经系统内互证）。`above` / `below`：同系统上下邻行（贯穿小节线可以伸进去）。
pub fn staff_barlines(ink: &InkLayers, segs: &[VSeg], s: &Staff, unit: &Unit, above: Option<&Staff>, below: Option<&Staff>) -> Vec<Barline> {
    let sp = s.space();
    let mut cands: Vec<VSeg> = segs
        .iter()
        .copied()
        .filter(|v| {
            let x = v.cx();
            // 谱行左端那根是系统线（框架层另认），不是小节线
            if x < s.left + sp * START_ZONE || x > s.right + sp || v.cols as f64 > sp * MAX_WIDTH {
                return false;
            }
            let (top, bot) = (s.top(x), s.bottom(x));
            let (y0, y1) = (v.y0 as f64, v.y1 as f64);
            if y0 > top + sp * REACH_TOL || y1 < bot - sp * REACH_TOL {
                return false;
            }
            let up_ok = y0 >= top - sp * END_TOL || above.is_some_and(|a| y0 <= a.bottom(x) + sp * END_TOL);
            let down_ok = y1 <= bot + sp * END_TOL || below.is_some_and(|b| y1 >= b.top(x) - sp * END_TOL);
            up_ok && down_ok && !head_at_end(ink, v, s, sp)
        })
        .collect();
    cands.sort_by(|a, b| a.x0.cmp(&b.x0));
    let thin = {
        let mut w: Vec<usize> = cands.iter().map(|v| v.cols).collect();
        w.sort();
        w.get(w.len() / 2).copied().unwrap_or(unit.thick.round() as usize).max(1) as f64
    };
    let mut out: Vec<Barline> = Vec::new();
    for v in cands {
        match out.last_mut() {
            Some(b) if (v.x0 as f64) - b.x1 <= sp * GROUP_GAP => {
                b.x1 = b.x1.max(v.x1 as f64);
                b.segs.push(v);
            }
            _ => out.push(Barline { x: v.cx(), x0: v.x0 as f64, x1: v.x1 as f64, style: BarStyle::Regular, segs: vec![v] }),
        }
    }
    for b in &mut out {
        b.x = (b.x0 + b.x1) / 2.0;
        let heavy: Vec<bool> = b.segs.iter().map(|v| v.cols as f64 >= thin * HEAVY).collect();
        b.style = match heavy.as_slice() {
            [true] => BarStyle::Heavy,
            [_] => BarStyle::Regular,
            [false, false, ..] => BarStyle::LightLight,
            [false, true, ..] => BarStyle::LightHeavy,
            [true, false, ..] => BarStyle::HeavyLight,
            _ => BarStyle::Heavy,
        };
    }
    out
}

/// 竖段的上端或下端旁边（左或右一个符头宽的窗）墨很满：挂着符头，是符干不是小节线。窗里的谱线存疑像素不算墨。
fn head_at_end(ink: &InkLayers, v: &VSeg, s: &Staff, sp: f64) -> bool {
    let hw = (sp * HEAD_WIN).round() as i64;
    let hh = (sp * 0.5).round() as i64;
    let _ = s;
    for &yend in &[v.y0 as i64, v.y1 as i64] {
        for &(xa, xb) in &[(v.x0 as i64 - hw, v.x0 as i64 - 1), (v.x1 as i64 + 1, v.x1 as i64 + hw)] {
            let (mut n, mut ink_n) = (0, 0);
            for y in yend - hh..=yend + hh {
                for x in xa..=xb {
                    n += 1;
                    let t = ink.at(x, y);
                    if t != BG && t != crate::frame::ink::LINE {
                        ink_n += 1;
                    }
                }
            }
            if n > 0 && ink_n as f64 / n as f64 >= HEAD_FILL {
                return true;
            }
        }
    }
    false
}
