//! **矢量证据的取原语**（计划 §5.5「设计 5」）：这里只把对象库（`omr-source::vector`）化成原语与探针，不放识别判据——
//! 判据在框架、结构信息、音符、文字、线性符号各模块里，像素页、矢量页同一份。
//!
//! - [`VecInk`]：矢量页的探针。逐点按对象几何作答：落在谱线对象上、又不在别的对象里的点是「只属于谱线的墨」，其余有对象的点是符号墨。
//! - [`frame_vector`]：横线段成谱表（`frame::staves::staves_from_hsegs`）→ 竖线段 → 系统（`frame::systems`）→ 小节线（`frame::bars`），
//!   系统与小节线是位图那份代码，只是探针与竖段换成矢量的。
pub mod glyphs;

use crate::frame::bars::page_barlines;
use crate::frame::staves::staves_from_hsegs;
use crate::frame::systems::find_systems;
use crate::page::Layout;
use dolce_omr_core::geom::median;
use dolce_omr_sheet::element::{Probe, BG, INK, LINE};
use dolce_omr_sheet::prims::{HSeg, VSeg};
use dolce_omr_sheet::Unit;
use dolce_omr_source::vector::{VKind, VLine, VecPage};

/// 竖线段至少这么长（相对线距）才进小节线 / 系统线候选（同位图的竖段下限）。
const VSEG_MIN: f64 = 3.0;

/// 矢量页的探针。
pub struct VecInk<'a> {
    pub vp: &'a VecPage,
    /// 各对象的直线段（线对象逐段作答：一个对象里可能画了整行谱线连同别的线）。
    obj_lines: Vec<Vec<usize>>,
    /// 谱线段（`vp.lines` 的下标）。
    staff_line: Vec<bool>,
}

impl<'a> VecInk<'a> {
    pub fn new(vp: &'a VecPage, staff_lines: &[usize]) -> Self {
        let mut obj_lines = vec![Vec::new(); vp.objs.len()];
        for (i, l) in vp.lines.iter().enumerate() {
            obj_lines[l.obj as usize].push(i);
        }
        let mut staff_line = vec![false; vp.lines.len()];
        for &i in staff_lines {
            staff_line[i] = true;
        }
        VecInk { vp, obj_lines, staff_line }
    }

    /// 点 (x, y)（工作坐标的实数点）的状态。
    pub fn at_f(&self, x: f64, y: f64) -> u8 {
        let mut line = false;
        for o in self.vp.hits(x, y) {
            if o.kind == VKind::Line && !self.obj_lines[o.id as usize].is_empty() {
                for &li in &self.obj_lines[o.id as usize] {
                    if on_line(&self.vp.lines[li], x, y) {
                        if self.staff_line[li] {
                            line = true;
                        } else {
                            return INK;
                        }
                    }
                }
                continue;
            }
            return INK;
        }
        if line { LINE } else { BG }
    }
}

impl Probe for VecInk<'_> {
    fn width(&self) -> usize {
        self.vp.w
    }
    fn height(&self) -> usize {
        self.vp.h
    }
    /// 像素格 (x, y) 按格心取样。
    fn at(&self, x: i64, y: i64) -> u8 {
        if x < 0 || y < 0 {
            return BG;
        }
        self.at_f(x as f64 + 0.5, y as f64 + 0.5)
    }
}

/// 点在线段的墨里（到中线不过半个线宽，至少半个单位）。
fn on_line(l: &VLine, x: f64, y: f64) -> bool {
    let half = (l.w / 2.0).max(0.5);
    let (dx, dy) = (l.b.0 - l.a.0, l.b.1 - l.a.1);
    let l2 = dx * dx + dy * dy;
    let t = if l2 <= 0.0 { 0.0 } else { (((x - l.a.0) * dx + (y - l.a.1) * dy) / l2).clamp(0.0, 1.0) };
    let (qx, qy) = (l.a.0 + t * dx, l.a.1 + t * dy);
    (x - qx).powi(2) + (y - qy).powi(2) <= half * half
}

/// 矢量页的框架结构。
pub struct VecFrame {
    pub layout: Layout,
    /// 谱线段（`vp.lines` 的下标）。
    pub staff_lines: Vec<usize>,
    /// 竖段（不短于三格，小节线 / 系统线候选）。
    pub segs: Vec<VSeg>,
}

/// 横线原语。
pub fn hsegs(vp: &VecPage) -> Vec<HSeg> {
    vp.lines.iter().filter(|l| l.is_h()).map(|l| HSeg { x0: l.a.0.min(l.b.0), x1: l.a.0.max(l.b.0), y: (l.a.1 + l.b.1) / 2.0, w: l.w, obj: l.obj }).collect()
}

/// 竖线原语（`vp.lines` 里竖的，至少 `min_len` 长）。
pub fn vsegs(vp: &VecPage, min_len: f64) -> Vec<VSeg> {
    vp.lines.iter().filter(|l| l.is_v() && l.len() >= min_len).filter_map(|l| VSeg::from_exact((l.a.0 + l.b.0) / 2.0, l.a.1.min(l.b.1), l.a.1.max(l.b.1), l.w)).collect()
}

/// 谱表高的估计：音乐字体的字号中位数（1 em = 4 线距 = 谱表高）；没有音乐字体按页宽估。
fn staff_height(vp: &VecPage) -> f64 {
    let sizes: Vec<f64> = vp.chars.iter().filter(|c| glyphs::music_family(&c.font).is_some() && c.size_scaled > 0.0).map(|c| c.size_scaled * vp.scale).collect();
    if sizes.is_empty() { vp.w as f64 / 25.0 } else { median(&sizes, 0.0) }
}

/// 矢量页的框架结构；页上没有谱表回 None。
pub fn frame_vector(vp: &VecPage) -> Option<VecFrame> {
    let hs = hsegs(vp);
    let height = staff_height(vp);
    let found = staves_from_hsegs(&hs, height);
    if found.is_empty() {
        return None;
    }
    // 横段下标 → `vp.lines` 下标
    let h_idx: Vec<usize> = (0..vp.lines.len()).filter(|&i| vp.lines[i].is_h()).collect();
    let staff_lines: Vec<usize> = found.iter().flat_map(|(_, five)| five.iter().map(|&k| h_idx[k])).collect();
    let staves: Vec<_> = found.into_iter().map(|(s, _)| s).collect();
    let spaces: Vec<f64> = staves.iter().map(|s| s.space()).collect();
    let thicks: Vec<f64> = staves.iter().flat_map(|s| s.thick).collect();
    let unit = Unit { space: median(&spaces, 0.0), thick: median(&thicks, 1.0) };
    let ink = VecInk::new(vp, &staff_lines);
    let segs = vsegs(vp, unit.space * VSEG_MIN);
    let systems = find_systems(&ink, None, &staves, &unit);
    let bars = page_barlines(&ink, &segs, &staves, &systems, &unit);
    let layout = Layout { up: vp.scale, unit, staves, systems, bars, bands: Vec::new(), jianpu: Vec::new(), vector: true };
    Some(VecFrame { layout, staff_lines, segs })
}

/// 识别一页纯矢量页；没有谱表回 None。
pub fn recognize_vector(pc: &dolce_omr_source::PageContent, _ocr: Option<&dyn crate::attrs::DigitReader>) -> Option<crate::page::Page> {
    let vp = VecPage::build(pc, dolce_omr_sheet::prims::VEC_SCALE, (0.0, 0.0));
    let f = frame_vector(&vp)?;
    let n = f.layout.staves.len();
    let attrs = vec![crate::attrs::RowAttrs::default(); n];
    let notes = vec![crate::notes::RowNotes::default(); n];
    let text = crate::text::PageText { rows: (0..n).map(|_| Default::default()).collect(), ..Default::default() };
    Some(crate::page::Page { layout: f.layout, attrs, notes, text, spans: Default::default() })
}
