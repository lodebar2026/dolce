//! 倚音的几何（`engrave/grace.ts`）：小号数字 + 八度点 + 减时线 + 连接钩。只算坐标，落笔各引擎自己做。
//! 横向比例单位 = 主音数字的墨迹高（`ink`）；竖向的点与线走叠层（`stack`，按倚音自己的墨迹高）。

use crate::stack::{beam_y, high_dot_y, low_dot_y, stack_bottom, StackStyle};

/// 主音那一侧的度量。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GraceMetrics {
    /// 主音数字的墨迹高——所有比例的基准
    pub ink: f64,
    /// 倚音字号 ÷ 主音字号
    pub scale: f64,
    pub octave_up_y: f64,
    pub octave_down_y: f64,
    pub octave_dot_gap: f64,
    pub octave_dot_radius: f64,
    pub underline_gap: f64,
    /// 叠层的空 ÷ 数字墨迹高
    pub stack_gap: f64,
}

const GRACE_STEP: f64 = 0.45;
const GRACE_ACC_INSET: f64 = 0.32;
const GRACE_INK: f64 = 0.5;
const GRACE_BEAM_H: f64 = 0.055;

/// 倚音的临时升降号。
pub type GraceAlter = crate::accidental::AccidentalKind;

/// 一颗倚音：数字、八度（正 = 高音点、负 = 低音点）、时值（4 = 四分，缺省 8）、升降号。
#[derive(Clone, Debug, PartialEq)]
pub struct GraceNote {
    pub digit: String,
    pub octave: f64,
    pub duration: Option<f64>,
    pub alter: Option<GraceAlter>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GraceDigit {
    pub text: String,
    pub cx: f64,
    pub cy: f64,
    pub size: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GraceDot {
    pub cx: f64,
    pub cy: f64,
    pub r: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GraceAccidental {
    pub alter: GraceAlter,
    pub ink_right: f64,
    pub ink_cy: f64,
    pub ink_height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GraceBeam {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 连接钩：一段三次贝塞尔（`m` 起点，`c` 两个控制点 + 终点）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GraceHook {
    pub m: [f64; 2],
    pub c: [f64; 6],
    pub width: f64,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct GraceGeom {
    pub digits: Vec<GraceDigit>,
    pub dots: Vec<GraceDot>,
    pub accidentals: Vec<GraceAccidental>,
    pub beams: Vec<GraceBeam>,
    pub hook: Option<GraceHook>,
}

/// 一组倚音该画在哪儿。`x` 主音墨迹中心、`baseline` 主音基线、`dir` -1 前倚音 / 1 后倚音；
/// `center_y` 倚音数字墨迹中心的 y（不给 = 基线上方 0.94 个墨迹高）。
pub fn grace_geometry(notes: &[GraceNote], m: &GraceMetrics, x: f64, baseline: f64, dir: f64, font_size: f64, center_y: Option<f64>) -> GraceGeom {
    let mut out = GraceGeom::default();
    if notes.is_empty() {
        return out;
    }
    let ink = m.ink;
    let size = font_size * m.scale;
    let nearest = x + dir * ink * 0.665;
    let gy = center_y.unwrap_or(baseline - ink * 0.94);
    let half_beam = ink * 0.194;
    let mut centers = Vec::with_capacity(notes.len());
    let mut cursor = 0.0;
    for gn in notes {
        let inset = if gn.alter.is_some() { ink * GRACE_ACC_INSET } else { 0.0 };
        centers.push(cursor + inset + ink * (GRACE_STEP / 2.0));
        cursor += inset + ink * GRACE_STEP;
    }
    let anchor = if dir < 0.0 { notes.len() - 1 } else { 0 };
    let shift = nearest - centers[anchor];
    let gxs: Vec<f64> = centers.iter().map(|c| c + shift).collect();
    let g_ink = ink * m.scale;
    let st = StackStyle { gap: m.stack_gap * g_ink, dot_radius: m.octave_dot_radius * m.scale, beam_width: ink * GRACE_BEAM_H };
    let ink_top = gy - g_ink / 2.0;
    let ink_bottom = gy + g_ink / 2.0;
    let lv_counts: Vec<f64> = notes.iter().map(|gn| dolce_model::base::js::max(1.0, ((gn.duration.unwrap_or(8.0) / 4.0).log2()).ceil())).collect();
    let beam_top = |lv: f64| beam_y(ink_bottom, lv + 1.0, &st) - st.beam_width / 2.0;
    let max_lv = lv_counts.iter().copied().fold(f64::NEG_INFINITY, dolce_model::base::js::max);
    let mut lv = 0.0;
    while lv < max_lv {
        let mut run_start: Option<usize> = None;
        for i in 0..=notes.len() {
            let on = i < notes.len() && lv_counts[i] > lv;
            if on && run_start.is_none() {
                run_start = Some(i);
            }
            if !on {
                if let Some(rs) = run_start.take() {
                    let x1 = gxs[rs] - half_beam;
                    let x2 = gxs[i - 1] + half_beam;
                    out.beams.push(GraceBeam { x: x1, y: beam_top(lv), w: x2 - x1, h: st.beam_width });
                }
            }
        }
        lv += 1.0;
    }
    let mut hook_at: Option<(f64, f64, bool)> = None;
    for (i, gn) in notes.iter().enumerate() {
        let gx = gxs[i];
        out.digits.push(GraceDigit { text: gn.digit.clone(), cx: gx, cy: gy, size });
        if let Some(alter) = gn.alter {
            out.accidentals.push(GraceAccidental {
                alter,
                ink_right: gx - half_beam - g_ink * 0.1,
                ink_cy: gy + g_ink * 0.5 - g_ink * 0.34 + if alter.is_flat() { g_ink * 0.08 } else { 0.0 },
                ink_height: g_ink * 0.78,
            });
        }
        let beams = lv_counts[i];
        let mut k = 0.0;
        while k < gn.octave {
            out.dots.push(GraceDot { cx: gx, cy: high_dot_y(ink_top, k, &st), r: st.dot_radius });
            k += 1.0;
        }
        let mut k = 0.0;
        while k < -gn.octave {
            out.dots.push(GraceDot { cx: gx, cy: low_dot_y(ink_bottom, beams, k, &st), r: st.dot_radius });
            k += 1.0;
        }
        if i == anchor {
            let low = gn.octave < 0.0;
            let y = if low { stack_bottom(ink_bottom, beams, -gn.octave, &st) + st.gap } else { beam_top(beams - 1.0) };
            hook_at = Some((gx, y, low));
        }
    }
    let Some((mid, uy, low)) = hook_at else { return out };
    let start_y = if low { uy } else { uy + ink * 0.033 };
    let (hm, hc) = grace_hook(mid, start_y, ink * GRACE_INK, -dir);
    out.hook = Some(GraceHook { m: hm, c: hc, width: ink * GRACE_BEAM_H });
    out
}

const HOOK_DROP: f64 = 0.304 / GRACE_INK;
const HOOK_REACH: f64 = 0.249 / GRACE_INK;

/// 连接钩的那一笔：从 (mid, start_y) 垂下再朝主音弯（`toward` = 1 朝右）。
pub fn grace_hook(mid: f64, start_y: f64, g_ink: f64, toward: f64) -> ([f64; 2], [f64; 6]) {
    let drop = g_ink * HOOK_DROP;
    let reach = g_ink * HOOK_REACH * toward;
    ([mid, start_y], [mid, start_y + drop * 0.6, mid - reach * 0.15, start_y + drop * 0.87, mid + reach, start_y + drop])
}

/// 一组倚音那一摞的墨迹底缘（相对 `center_y`）：数字、减时线、低音点里最低的；不算连接钩。
pub fn grace_bottom(g: &GraceGeom, m: &GraceMetrics) -> f64 {
    let mut low = (m.ink * m.scale) / 2.0;
    for b in &g.beams {
        low = dolce_model::base::js::max(low, b.y + b.h);
    }
    for d in &g.dots {
        low = dolce_model::base::js::max(low, d.cy + d.r);
    }
    low
}

/// 一组倚音占多宽（主音之外的那一截）。
pub fn grace_advance(notes: &[GraceNote], m: &GraceMetrics) -> f64 {
    let mut w = 0.0;
    for gn in notes {
        w += m.ink * (GRACE_STEP + if gn.alter.is_some() { GRACE_ACC_INSET } else { 0.0 });
    }
    w
}
