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
use dolce_omr_ocr::cache::CachedOcr;
use dolce_omr_sheet::Staff;
use dolce_omr_source::vector::{VKind, VObj, VecPage};

/// 外框 `r` 整个落在带里。
pub fn inside(b: &Band, st: &Staff, r: &Rect) -> bool {
    let ok = |x: f64, y: f64| {
        let t = st.top(x);
        x >= b.x0 && x < b.x1 && y >= t + b.y0 && y < t + b.y1
    };
    ok(r.x, r.y) && ok(r.right(), r.bottom()) && ok(r.x, r.bottom()) && ok(r.right(), r.y)
}

/// 一个对象画进条（条左上角 `(ox, oy)`、一工作单位一像素）：填充的按轮廓扫描线，描边的折线与直线段按线宽描。
fn draw(o: &VObj, vp: &VecPage, ox: f64, oy: f64, bin: &mut Binary) {
    let (w, h) = (bin.w, bin.h);
    let mut put = |x: f64, y: f64| {
        let (px, py) = ((x - ox).floor() as i64, (y - oy).floor() as i64);
        if px >= 0 && py >= 0 && (px as usize) < w && (py as usize) < h {
            bin.data[py as usize * w + px as usize] = 1;
        }
    };
    let stroke = |a: (f64, f64), b: (f64, f64), half: f64, put: &mut dyn FnMut(f64, f64)| {
        let n = ((b.0 - a.0).hypot(b.1 - a.1) * 2.0).ceil().max(1.0) as usize;
        let r = half.max(0.5);
        for i in 0..=n {
            let t = i as f64 / n as f64;
            let (cx, cy) = (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
            let k = r.ceil() as i64;
            for dy in -k..=k {
                for dx in -k..=k {
                    if ((dx * dx + dy * dy) as f64) <= r * r + 0.25 {
                        put(cx + dx as f64, cy + dy as f64);
                    }
                }
            }
        }
    };
    if o.kind == VKind::Line {
        for l in vp.lines.iter().filter(|l| l.obj == o.id) {
            stroke(l.a, l.b, l.w / 2.0, &mut put);
        }
        return;
    }
    if o.fill {
        let rs: Vec<Vec<(f64, f64)>> = o.rings.iter().map(|r| r.iter().map(|&(x, y)| (x - ox, y - oy)).collect()).collect();
        dolce_omr_sheet::shapes::fill_rings(&rs, w, h, &mut |x, y| bin.data[y * w + x] = 1);
        return;
    }
    for r in &o.rings {
        for s in r.windows(2) {
            stroke(s[0], s[1], o.stroke / 2.0, &mut put);
        }
    }
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
        draw(o, vp, x0, y0, &mut bin);
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
