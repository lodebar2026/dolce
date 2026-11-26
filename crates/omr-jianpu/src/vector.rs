//! **简谱路线的矢量证据**（计划 §5.5 9g / 7j）：[`JpInk`] 的矢量实现，判据一行不改。
//!
//! - 有没有墨：按对象几何作答（对象库的逐点查询：填充按非零环绕、描边按到折线的距离），不画整页；
//! - 块表：对象就是块（路径里画了几个字形的按子路径外框拆开，`path_pieces`），不做连通块；
//! - 送 OCR 的裁条：只把与条相交的对象画进去（扫描线填充 / 按线宽描）。
//!
//! 多页按页竖排（同像素路的拼页），工作坐标每点 [`scale`] 单位：页宽折成与像素路工作图同宽（`prep::MAX_W`），下游按字号归一的常数不用改。
use crate::prep::{Comp, JpInk};
use dolce_omr_core::image::Rect;
use dolce_omr_core::ocr::surface::Gray;
use dolce_omr_core::source::model::PageContent;
use dolce_omr_core::source::vector::{draw_obj, path_pieces, ObjSrc, VKind, VecPage};

/// 页宽折成这么多工作单位（同像素路工作图的宽上限）。
pub const PAGE_W: f64 = 2200.0;

/// 矢量页（多页竖排）的简谱证据。
pub struct VecJpInk {
    /// 各页的对象库与它在竖排里的纵向起点。
    pages: Vec<(VecPage, f64)>,
    comps: Vec<Comp>,
    /// 文字层的字（工作坐标的墨迹框），按 y 排；认字直接取，不送 OCR。
    chars: Vec<(char, Rect)>,
    w: usize,
    h: usize,
}

/// 环的面积（非零环绕近似：各环有向面积的绝对值之和）。
fn area(rings: &[Vec<(f64, f64)>]) -> f64 {
    rings
        .iter()
        .map(|g| {
            (0..g.len())
                .map(|i| {
                    let (p, q) = (g[i], g[(i + 1) % g.len()]);
                    p.0 * q.1 - q.0 * p.1
                })
                .sum::<f64>()
                .abs()
                / 2.0
        })
        .sum()
}

impl VecJpInk {
    /// 由各页内容建；页上一个对象都没有回 None。
    pub fn new(pcs: &[PageContent]) -> Option<VecJpInk> {
        let width = pcs.iter().map(|p| p.width).fold(0.0, f64::max);
        if width <= 0.0 {
            return None;
        }
        let scale = PAGE_W / width;
        let mut pages = Vec::new();
        let mut comps: Vec<Comp> = Vec::new();
        let mut chars: Vec<(char, Rect)> = Vec::new();
        let mut y0 = 0.0;
        for pc in pcs {
            let vp = VecPage::build(pc, scale, (0.0, 0.0));
            let mut push = |rect: Rect, a: f64| {
                let r = Rect::new(rect.x, rect.y + y0, rect.w.max(1.0), rect.h.max(1.0));
                comps.push(Comp { id: comps.len() as i32 + 1, rect: r, area: a.max(1.0), cx: r.x + r.w / 2.0, cy: r.y + r.h / 2.0 });
            };
            // 路径画的字形：按子路径拆块；其余对象（线、多边形、曲线、文字层的字）各是一块
            for p in path_pieces(&vp) {
                push(p.rect, area(&p.rings));
            }
            for o in vp.objs.iter().filter(|o| o.twin_of.is_none() && !(o.kind == VKind::Glyph && matches!(o.src, ObjSrc::Path(_)))) {
                let a = if o.kind == VKind::Line {
                    vp.lines.iter().filter(|l| l.obj == o.id).map(|l| l.len() * l.w.max(1.0)).sum()
                } else if o.fill {
                    area(&o.rings)
                } else {
                    o.rings.iter().flat_map(|r| r.windows(2)).map(|s| (s[1].0 - s[0].0).hypot(s[1].1 - s[0].1)).sum::<f64>() * o.stroke.max(1.0)
                };
                push(o.rect, a);
            }
            // 文字层的字：画成线的（音乐字体的谱线、符干）与私用区码位（音乐字体的记号）不算字
            for o in vp.objs.iter().filter(|o| o.twin_of.is_none() && o.kind == VKind::Glyph) {
                let Some(ch) = vp.char_of(o).and_then(|c| char::from_u32(c.unicode)) else { continue };
                if ch.is_whitespace() || ('\u{E000}'..='\u{F8FF}').contains(&ch) {
                    continue;
                }
                chars.push((ch, Rect::new(o.rect.x, o.rect.y + y0, o.rect.w, o.rect.h)));
            }
            let ph = vp.h as f64;
            pages.push((vp, y0));
            y0 += ph;
        }
        chars.sort_by(|a, b| a.1.cy().total_cmp(&b.1.cy()));
        (!comps.is_empty()).then(|| VecJpInk { pages, comps, chars, w: PAGE_W.ceil() as usize, h: y0.ceil() as usize })
    }

    /// 竖排里的 y 落在哪一页：(页, 页内 y)。
    fn page_at(&self, y: f64) -> Option<(&VecPage, f64)> {
        self.pages.iter().rev().find(|(_, off)| y >= *off).map(|(vp, off)| (vp, y - off))
    }
}

impl JpInk for VecJpInk {
    fn w(&self) -> usize {
        self.w
    }
    fn h(&self) -> usize {
        self.h
    }
    fn at(&self, x: i64, y: i64) -> bool {
        if x < 0 || y < 0 {
            return false;
        }
        let Some((vp, py)) = self.page_at(y as f64 + 0.5) else { return false };
        vp.hits(x as f64 + 0.5, py).next().is_some()
    }
    fn comps(&self) -> &[Comp] {
        &self.comps
    }
    fn strip(&self, r: &Rect, pad: i64) -> Gray {
        let (x0, y0) = ((r.x.floor() as i64 - pad) as f64, (r.y.floor() as i64 - pad) as f64);
        let (w, h) = ((r.w.ceil() as i64 + 2 * pad).max(1) as usize, (r.h.ceil() as i64 + 2 * pad).max(1) as usize);
        let mut g = Gray::new(w, h, 255);
        let win = Rect::new(x0, y0, w as f64, h as f64);
        for (vp, off) in &self.pages {
            let local = Rect::new(win.x, win.y - off, win.w, win.h);
            if local.bottom() < 0.0 || local.y > vp.h as f64 {
                continue;
            }
            for o in vp.in_rect(&local).into_iter().filter(|o| o.twin_of.is_none()) {
                draw_obj(vp, o, local.x, local.y, 1.0, w, h, &mut |x, y| g.data[y * w + x] = 0);
            }
        }
        g
    }
    fn text_in(&self, r: &Rect) -> Option<Vec<(char, Rect)>> {
        let lo = self.chars.partition_point(|c| c.1.cy() < r.y);
        let mut got: Vec<(char, Rect)> = self.chars[lo..].iter().take_while(|c| c.1.cy() <= r.bottom()).filter(|c| c.1.cx() >= r.x && c.1.cx() <= r.right()).copied().collect();
        got.sort_by(|a, b| a.1.cx().total_cmp(&b.1.cx()));
        (!got.is_empty()).then_some(got)
    }
}
