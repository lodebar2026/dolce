//! **矢量证据的取原语**（计划 §5.5「设计 5」）：这里只把对象库（`omr-source::vector`）化成原语与探针，不放识别判据——
//! 判据在框架、结构信息、音符、文字、线性符号各模块里，像素页、矢量页同一份。
//!
//! - [`VecInk`]：矢量页的探针。逐点按对象几何作答：落在谱线对象上、又不在别的对象里的点是「只属于谱线的墨」，其余有对象的点是符号墨。
//! - [`frame_vector`]：横线段成谱表（`frame::staves::staves_from_hsegs`）→ 竖线段 → 系统（`frame::systems`）→ 小节线（`frame::bars`），
//!   系统与小节线是位图那份代码，只是探针与竖段换成矢量的。
pub mod glyphs;
pub mod notes;
pub mod spans;
pub mod text;

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
    /// 只看这几种对象（None 全看）：数杠时只看厚带原语（平行四边形填充），连音括线、数字不冒充杠。
    only: Option<&'static [VKind]>,
    /// 线对象里只看不薄于这么多的线段（厚带模式；0 全看）。
    min_w: f64,
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
        VecInk { vp, obj_lines, staff_line, only: None, min_w: 0.0 }
    }

    /// 只看厚带原语的探针（符杠）：平行四边形填充，与不薄于 `min_w` 的线段（画成细长填充矩形的杠）。
    pub fn bands_only(&self, min_w: f64) -> VecInk<'a> {
        VecInk { vp: self.vp, obj_lines: self.obj_lines.clone(), staff_line: self.staff_line.clone(), only: Some(&[VKind::Poly, VKind::Line]), min_w }
    }

    /// 点 (x, y)（工作坐标的实数点）的状态。
    pub fn at_f(&self, x: f64, y: f64) -> u8 {
        let mut line = false;
        for o in self.vp.hits(x, y) {
            if self.only.is_some_and(|k| !k.contains(&o.kind)) {
                continue;
            }
            if o.kind == VKind::Line && !self.obj_lines[o.id as usize].is_empty() {
                for &li in &self.obj_lines[o.id as usize] {
                    if self.vp.lines[li].w >= self.min_w && on_line(&self.vp.lines[li], x, y) {
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
    fn exact(&self) -> bool {
        true
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
    joined_hsegs(vp).into_iter().map(|(h, _)| h).collect()
}

/// 横线原语与各自由 `vp.lines` 里哪几段并成：同高（差不过线宽的一半）、同宽、首尾相接或交叠的段并成一条——
/// 平铺的谱线字形（`staff5Lines` 一块块排过去）、按小节分段画的谱线都是这样。
fn joined_hsegs(vp: &VecPage) -> Vec<(HSeg, Vec<usize>)> {
    let mut idx: Vec<usize> = (0..vp.lines.len()).filter(|&i| vp.lines[i].is_h()).collect();
    let y = |i: usize| (vp.lines[i].a.1 + vp.lines[i].b.1) / 2.0;
    let x0 = |i: usize| vp.lines[i].a.0.min(vp.lines[i].b.0);
    let x1 = |i: usize| vp.lines[i].a.0.max(vp.lines[i].b.0);
    idx.sort_by(|&a, &b| y(a).total_cmp(&y(b)).then(x0(a).total_cmp(&x0(b))));
    let mut out: Vec<(HSeg, Vec<usize>)> = Vec::new();
    for i in idx {
        let l = &vp.lines[i];
        let tol = (l.w / 2.0).max(0.5);
        let hit = out.iter_mut().rev().take_while(|(h, _)| y(i) - h.y <= tol).find(|(h, _)| {
            (h.y - y(i)).abs() <= tol && (h.w - l.w).abs() <= 0.5 * h.w.max(l.w) && x0(i) <= h.x1 + tol && x1(i) >= h.x0 - tol
        });
        match hit {
            Some((h, m)) => {
                h.x0 = h.x0.min(x0(i));
                h.x1 = h.x1.max(x1(i));
                m.push(i);
            }
            None => out.push((HSeg { x0: x0(i), x1: x1(i), y: y(i), w: l.w, obj: l.obj }, vec![i])),
        }
    }
    out
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
    let joined = joined_hsegs(vp);
    let hs: Vec<HSeg> = joined.iter().map(|(h, _)| *h).collect();
    let height = staff_height(vp);
    let found = staves_from_hsegs(&hs, height);
    if found.is_empty() {
        return None;
    }
    // 横段 → 并成它的 `vp.lines` 下标
    let staff_lines: Vec<usize> = found.iter().flat_map(|(_, five)| five.iter().flat_map(|&k| joined[k].1.iter().copied())).collect();
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
pub fn recognize_vector(pc: &dolce_omr_source::PageContent, rendered: Option<&dolce_omr_ocr::surface::Gray>, ocr: Option<&dyn crate::attrs::DigitReader>) -> Option<crate::page::Page> {
    let vp = VecPage::build(pc, dolce_omr_sheet::prims::VEC_SCALE, (0.0, 0.0));
    let f = frame_vector(&vp)?;
    let ink = VecInk::new(&vp, &f.staff_lines);
    let syms = glyphs::music_chars(&vp);
    let attrs = notes::page_attrs(&f.layout, &syms);
    let mut notes = notes::page_notes(&f.layout, &ink, &attrs, &syms);
    // 多小节休止：粗横段 + 两端竖段 + 上方的数字（共用判据 `notes::rests::multi_rests`）
    let sp = f.layout.unit.space;
    let bars: Vec<dolce_omr_core::image::Rect> = vp
        .lines
        .iter()
        .filter(|l| l.is_h() && l.w >= 0.3 * sp)
        .map(|l| dolce_omr_core::image::Rect::new(l.a.0.min(l.b.0), (l.a.1 + l.b.1) / 2.0 - l.w / 2.0, (l.b.0 - l.a.0).abs(), l.w))
        .collect();
    for r in crate::notes::rests::multi_rests(&f.layout.staves, &bars, &vsegs(&vp, 0.0), &text::numbers(&vp)) {
        let si = r.staff;
        notes[si].rests.push(r);
        notes[si].rests.sort_by(|a, b| a.x.total_cmp(&b.x));
    }
    // 谱表以外的升降号字形（和弦记号里的）插进字行
    let accs: Vec<(char, dolce_omr_core::image::Rect)> = syms
        .iter()
        .filter(|s| matches!(s.name, "accidentalSharp" | "accidentalFlat"))
        .filter(|s| !f.layout.staves.iter().any(|st| st.covers(s.cx(), s.cy(), 1.5) && s.cx() >= st.left && s.cx() <= st.right))
        .map(|s| (if s.name == "accidentalSharp" { '#' } else { 'b' }, s.rect))
        .collect();
    let tiles = dolce_omr_source::raster::side_tiles(pc, None);
    let lines = text::text_lines(&vp, ocr, rendered, &tiles, &accs);
    let credits = text::header(&f.layout, &vp, &lines, 1.0);
    let bands = text::bands(&f.layout, lines);
    if std::env::var("OMR_VEC_DEBUG").is_ok() {
        for b in &bands {
            for l in &b.lines {
                let t: Vec<String> = l.segs.iter().map(|s| format!("{}@{:.0}", s.chars.iter().map(|c| c.ch).collect::<String>(), s.rect.x)).collect();
                let da = b.above.map(|a| (l.y0 - f.layout.staves[a].ys[4]) / f.layout.staves[a].space());
                let dz = b.below.map(|z| (f.layout.staves[z].ys[0] - l.y1) / f.layout.staves[z].space());
                eprintln!("矢量带 上{:?} 下{:?} y{:.0}-{:.0} 距上{da:.1?} 距下{dz:.1?} {t:?}", b.above, b.below, l.y0, l.y1);
            }
        }
    }
    let mut rows = crate::text::classify::classify(&f.layout, &bands);
    text::dynamics(&f.layout, &syms, &mut rows);
    if std::env::var("OMR_VEC_DEBUG").is_ok() {
        for (i, r) in rows.iter().enumerate() {
            let hs: Vec<String> = r.marks.iter().map(|m| format!("{:?}@{:.0}", m.dir, m.x)).collect();
            if !hs.is_empty() {
                eprintln!("矢量记号 行{i} {hs:?}");
            }
        }
    }
    let text = crate::text::PageText { rows, credits, bands, false_heads: Vec::new() };
    let ps = spans::pieces(&vp, &f.staff_lines, f.layout.unit.space);
    if std::env::var("OMR_VEC_PIECES").is_ok() {
        let sp = f.layout.unit.space;
        for p in ps.iter().filter(|p| p.width() >= 2.0 * sp && p.shape.up.max(p.shape.down) <= 0.2 * sp) {
            eprintln!("直笔画 x{}-{} a{:.0?} b{:.0?} 厚{:.1} 斜{:.2} sp{sp:.1}", p.stroke.x0, p.stroke.x1(), p.shape.a, p.shape.b, p.shape.thick, p.shape.slope());
        }
    }
    let spans = crate::spans::judge(&f.layout, &ink, &attrs, &notes, ps);
    if std::env::var("OMR_VEC_DEBUG").is_ok() {
        eprintln!("矢量线性符号 弧{} 松叶{} 房子{}", spans.arcs.len(), spans.wedges.len(), spans.voltas.len());
    }
    Some(crate::page::Page { layout: f.layout, attrs, notes, text, spans })
}
