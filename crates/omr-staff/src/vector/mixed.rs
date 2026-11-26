//! 矢量页的**混排简谱行**（计划 §5.5「设计 6」/ 9g）：定位、认领、互证都是位图那一份（`mixed::band::find`、`mixed::{has_bands, trial_read,
//! finish_rows, settle_bands}`、整曲拼接里的 `fuse`），这里只取原语——
//!
//! - 回看墨迹走对象库探针、短竖段取矢量竖线；
//! - 「整块落在带里的墨切成条」在矢量页就是「外框整个落在带里的对象」：只把这些对象按轮廓扫描线画成条（不整页渲染），交简谱路线认。
use super::{vsegs, VecInk};
use crate::mixed::band::{Band, Strip};
use crate::mixed::JpRow;
use crate::page::Layout;
use dolce_omr_core::image::{Binary, Rect};
use dolce_omr_core::ocr::cache::CachedOcr;
use dolce_omr_core::sheet::Staff;
use dolce_omr_core::source::vector::VecPage;

/// 外框 `r` 整个落在带里。
pub fn inside(b: &Band, st: &Staff, r: &Rect) -> bool {
    let ok = |x: f64, y: f64| {
        let t = st.top(x);
        x >= b.x0 && x < b.x1 && y >= t + b.y0 && y < t + b.y1
    };
    ok(r.x, r.y) && ok(r.right(), r.bottom()) && ok(r.x, r.bottom()) && ok(r.right(), r.y)
}

/// 一条简谱行的条：外框整个落在带里的对象画成的二值图（页面工作坐标的左上角）。
fn strip_of(vp: &VecPage, b: &Band, st: &Staff) -> Strip {
    let tops = [st.top(b.x0), st.top(b.x1), st.top((b.x0 + b.x1) / 2.0)];
    let (lo, hi) = (tops.iter().copied().fold(f64::MAX, f64::min), tops.iter().copied().fold(f64::MIN, f64::max));
    let (x0, y0) = (b.x0.floor().max(0.0), (lo + b.y0).floor().max(0.0));
    let (x1, y1) = (b.x1.ceil(), (hi + b.y1).ceil());
    let (w, h) = ((x1 - x0).max(1.0) as usize, (y1 - y0).max(1.0) as usize);
    let mut bin = Binary::new(w, h);
    for o in vp.objs.iter().filter(|o| o.twin_of.is_none() && inside(b, st, &o.rect)) {
        let (bw, bh) = (bin.w, bin.h);
        dolce_omr_core::source::vector::draw_obj(vp, o, x0, y0, 1.0, bw, bh, &mut |x, y| bin.data[y * bw + x] = 1);
    }
    Strip { x: x0 as i64, y: y0 as i64, bin }
}

/// 认领矢量页的简谱行：回收下的带与各条读数（不是混排回两个空表）。
pub fn claim(vp: &VecPage, ink: &VecInk, f: &Layout, ocr: &CachedOcr) -> (Vec<Band>, Vec<JpRow>) {
    let short = vsegs(vp, f.unit.space * crate::page::SHORT_SEG);
    let cands = crate::mixed::band::find(ink, &short, &f.staves, &f.bars, &f.unit);
    let systems: Vec<Vec<usize>> = f.systems.iter().map(|s| s.staves.clone()).collect();
    if !crate::mixed::has_bands(&systems, &cands) {
        return (Vec::new(), Vec::new());
    }
    let strips: Vec<Strip> = cands.iter().map(|b| strip_of(vp, b, &f.staves[b.anchor])).collect();
    let Some(strict) = crate::mixed::trial_read(&cands, &strips, ocr) else { return (Vec::new(), Vec::new()) };
    let mut jianpu = crate::mixed::finish_rows(&cands, &strips, strict, ocr);
    let mut bands = cands;
    crate::mixed::settle_bands(&mut bands, &mut jianpu, &f.systems);
    (bands, jianpu)
}
