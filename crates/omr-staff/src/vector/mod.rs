//! **矢量证据的取原语**（计划 §5.5「设计 5」）：这里只把对象库（`omr-source::vector`）化成原语与探针，不放识别判据——
//! 判据在框架、结构信息、音符、文字、线性符号各模块里，像素页、矢量页同一份。
//!
//! - [`VecInk`]：矢量页的探针。逐点按对象几何作答：落在谱线对象上、又不在别的对象里的点是「只属于谱线的墨」，其余有对象的点是符号墨。
//! - [`frame_vector`]：横线段成谱表（`frame::staves::staves_from_hsegs`）→ 竖线段 → 系统（`frame::systems`）→ 小节线（`frame::bars`），
//!   系统与小节线是位图那份代码，只是探针与竖段换成矢量的。
pub mod glyphs;
pub mod mixed;
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

/// 矢量页画成像素的页框：`keep` 收下的对象按工作坐标画进二值图，版面照搬矢量的。
/// 字形字典在行首认不出谱号的行（转曲页换了一套字体，谱号、调号、拍号都不在字典里）把整页（简谱带里的不画）画成像素，
/// 行首读法（谱号自举、调号按竖笔数、拍号读数字）与行中拍号走位图同一份 `attrs::lead`，不另写一套矢量判据。
fn raster_frame(vp: &VecPage, f: &Layout, keep: &dyn Fn(&dolce_omr_source::vector::VObj) -> bool) -> crate::page::PageFrame {
    use dolce_omr_core::image::Binary;
    let (w, h) = (vp.w.max(1), vp.h.max(1));
    let mut bin = Binary::new(w, h);
    for o in vp.objs.iter().filter(|o| o.twin_of.is_none() && keep(o)) {
        dolce_omr_source::vector::draw_obj(vp, o, 0.0, 0.0, 1.0, w, h, &mut |x, y| bin.data[y * w + x] = 1);
    }
    let unit = f.unit;
    let ink = crate::frame::ink::InkLayers::new(&bin, &f.staves, &unit);
    let segs = ink.vsegs((unit.space * VSEG_MIN) as usize, unit.thick.ceil().max(2.0) as usize);
    let (blobs, labels) = ink.blobs(4.0);
    crate::page::PageFrame { layout: f.clone(), bin, soft: None, ink, segs, blobs, labels, band_ink: None }
}

/// 转曲页读字用的像素页框：只画字大小的块（简谱带里的不画）。
///
/// 对象按子路径外框相交拆块（一个对象画一串字的照样一字一块），字的尺度按本页统计：离开谱线一格以上、字身高（[`TEXT_BODY_H`] 格起）
/// 不过 [`TEXT_BODY_W`] 格宽的块，宽高各取 85 分位；宽或高过它 [`TEXT_BLOCK`] 倍的块不画——谱线、符杠、小节线、符干、
/// 弧与延音线都比字大，画进去反倒与贴着的字粘成一块大墨块被剔掉（裴克经文诗歌 003 末字「美。」压着延音线）。
/// 不按对象种类挑：直笔画的字归成多边形、单笔轮廓的字与叹号归成弧类。
fn text_frame(vp: &VecPage, f: &Layout, in_band: &dyn Fn(&dolce_omr_core::image::Rect) -> bool) -> crate::page::PageFrame {
    use dolce_omr_core::geom::quantile;
    use dolce_omr_core::image::Rect;
    let sp = f.unit.space;
    let off_lines = |r: &Rect| {
        let (cx, cy) = (r.x + r.w / 2.0, r.y + r.h / 2.0);
        f.staves.iter().all(|st| cx < st.left - st.space() || cx > st.right + st.space() || cy < st.ys[0] - st.space() || cy > st.ys[4] + st.space())
    };
    // 整个落在谱线范围内的不画（位图读法本就剔掉贴着谱表的墨块，字不在谱表里）
    let in_staff = |r: &Rect| f.staves.iter().any(|st| r.x >= st.left - st.space() && r.right() <= st.right + st.space() && r.y >= st.ys[0] && r.bottom() <= st.ys[4]);
    let objs: Vec<(&dolce_omr_source::vector::VObj, Vec<glyphs::GlyphPiece>)> =
        vp.objs.iter().filter(|o| o.twin_of.is_none() && !in_band(&o.rect) && !in_staff(&o.rect)).map(|o| (o, dolce_omr_source::vector::obj_pieces(o))).collect();
    let body: Vec<&Rect> = objs.iter().flat_map(|(_, ps)| ps.iter().map(|p| &p.rect)).filter(|r| r.h >= sp * TEXT_BODY_H && r.w <= sp * TEXT_BODY_W && off_lines(r)).collect();
    let (qw, qh) = (quantile(&body.iter().map(|r| r.w).collect::<Vec<_>>(), 0.85), quantile(&body.iter().map(|r| r.h).collect::<Vec<_>>(), 0.85));
    let fits = |r: &Rect| body.is_empty() || (r.w <= qw * TEXT_BLOCK && r.h <= qh * TEXT_BLOCK);
    let (w, h) = (vp.w.max(1), vp.h.max(1));
    let mut bin = dolce_omr_core::image::Binary::new(w, h);
    for (o, ps) in &objs {
        let keep: Vec<&glyphs::GlyphPiece> = ps.iter().filter(|p| fits(&p.rect)).collect();
        if keep.len() == ps.len() {
            dolce_omr_source::vector::draw_obj(vp, o, 0.0, 0.0, 1.0, w, h, &mut |x, y| bin.data[y * w + x] = 1);
        } else if o.fill {
            for p in keep {
                dolce_omr_core::geom::fill_rings(&p.rings, w, h, &mut |x, y| bin.data[y * w + x] = 1);
            }
        }
    }
    let unit = f.unit;
    let ink = crate::frame::ink::InkLayers::new(&bin, &f.staves, &unit);
    let segs = ink.vsegs((unit.space * VSEG_MIN) as usize, unit.thick.ceil().max(2.0) as usize);
    let (blobs, labels) = ink.blobs(4.0);
    crate::page::PageFrame { layout: f.clone(), bin, soft: None, ink, segs, blobs, labels, band_ink: None }
}

/// [`text_frame`] 的尺度（线距 / 倍数）。
const TEXT_BODY_H: f64 = 0.8;
const TEXT_BODY_W: f64 = 8.0;
const TEXT_BLOCK: f64 = 2.0;

/// 谱表区：字形落在谱表上下这么多线距以内才当音乐符号认（加线上的低音、谱表上方的附点与符尾；同 TS 转曲路）。
const STAFF_ZONE_ABOVE: f64 = 4.5;
const STAFF_ZONE_BELOW: f64 = 4.0;

/// 识别一页纯矢量页；没有谱表回 None。
pub fn recognize_vector(pc: &dolce_omr_source::PageContent, rendered: Option<&dolce_omr_ocr::surface::Gray>, ocr: Option<&dyn crate::attrs::DigitReader>) -> Option<crate::page::Page> {
    let vp = VecPage::build(pc, dolce_omr_sheet::prims::VEC_SCALE, (0.0, 0.0));
    let mut f = frame_vector(&vp)?;
    let ink = VecInk::new(&vp, &f.staff_lines);
    // 混排：简谱行（定位、认领、互证同位图；条只画落在带里的对象）
    if let Some(c) = ocr.and_then(|o| o.cached()) {
        let (bands, jianpu) = mixed::claim(&vp, &ink, &f.layout, c);
        f.layout.bands = bands;
        f.layout.jianpu = jianpu;
    }
    let in_band = |r: &dolce_omr_core::image::Rect| f.layout.bands.iter().any(|b| mixed::inside(b, &f.layout.staves[b.anchor], r));
    // 字形：文字层里的音乐字体字，加上路径画的字形块（转曲页）
    // 带里的对象归简谱行，不进字形候选、不读字
    let pieces: Vec<glyphs::GlyphPiece> = glyphs::path_pieces(&vp).into_iter().filter(|p| !in_band(&p.rect)).collect();
    let mut syms: Vec<glyphs::VSym> = glyphs::music_chars(&vp).into_iter().filter(|s| !in_band(&s.rect)).collect();
    let mut path_syms = glyphs::path_glyphs(&pieces, f.layout.unit.space, &vp, pc);
    let staff_zone = |r: &dolce_omr_core::image::Rect| {
        let (cx, cy) = (r.x + r.w / 2.0, r.y + r.h / 2.0);
        f.layout.staves.iter().any(|st| {
            let sp = st.space();
            cx > st.left - sp && cx < st.right + sp && cy > st.ys[0] - sp * STAFF_ZONE_ABOVE && cy < st.ys[4] + sp * STAFF_ZONE_BELOW
        })
    };
    glyphs::hollow_heads(&pieces, &mut path_syms, &staff_zone);
    syms.extend(path_syms.iter().filter(|s| !s.name.is_empty()).cloned());
    syms.extend(glyphs::curve_glyphs(&vp, f.layout.unit.space, pc, &in_band));
    let by_strokes = glyphs::stroke_accidentals(&vp, f.layout.unit.space, &syms, &in_band);
    syms.extend(by_strokes);
    let lead_frame = std::cell::OnceCell::new();
    let lead_frame_of = || lead_frame.get_or_init(|| raster_frame(&vp, &f.layout, &|o| !in_band(&o.rect)));
    let lead = |si: usize| crate::attrs::lead::read_lead(lead_frame_of(), si, ocr);
    let mid_time = |si: usize, a: f64, b: f64| crate::attrs::lead::read_time_between(lead_frame_of(), si, a, b, ocr);
    let mid_key = |si: usize, c: dolce_omr_sheet::music::Clef, a: f64| crate::attrs::lead::read_key_after(lead_frame_of(), si, c, a);
    let attrs = notes::page_attrs(&f.layout, &syms, Some(&lead), Some(&mid_time), Some(&mid_key));
    let mut notes = notes::page_notes(&f.layout, &ink, &attrs, &syms);
    // 转曲页（文字层里没有正文的字）：连音的「3」也是路径，在画成像素的页框上按位图同一份墨块读数字找候选
    let outlined = !vp.chars.iter().any(|c| !c.generated && glyphs::music_family(&c.font).is_none());
    if let (true, Some(o)) = (outlined, ocr) {
        for (si, row) in notes.iter_mut().enumerate() {
            crate::notes::tuplets::add_by_blobs(lead_frame_of(), si, row, o);
        }
    }
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
    // 转曲页（文字层里没有正文的字）：字都是路径，字大小的块画成像素（[`text_frame`]）走位图同一份文字读法 `text::page_text`
    // ——带里的墨块按字身框收字、投影切行切段、裁条送 OCR，页眉同样
    let text = if outlined {
        let mut full = text_frame(&vp, &f.layout, &in_band);
        // 像素就画在工作坐标上：位图读法按「页内坐标 = 原图像素 × up」裁条，这里 up 是 1
        full.layout.up = 1.0;
        let gray: Vec<u8> = full.bin.data.iter().map(|&v| if v != 0 { 0 } else { 255 }).collect();
        let (w, h) = (full.bin.w, full.bin.h);
        let src = dolce_omr_source::raster::SourceImage {
            w,
            h,
            gray,
            rgb: Vec::new(),
            kind: dolce_omr_source::model::ImageKind::Mask,
            rect: dolce_omr_core::image::Rect::new(vp.origin.0, vp.origin.1, w as f64 / vp.scale, h as f64 / vp.scale),
            page_w: pc.width,
            page_h: pc.height,
            size_known: true,
        };
        if let Ok(path) = std::env::var("OMR_TEXT_BIN") {
            let _ = std::fs::write(path, [format!("P5 {w} {h} 255\n").as_bytes(), &src.gray].concat());
        }
        let mut t = crate::text::page_text(&full, &src, &notes, ocr);
        text::dynamics(&f.layout, &syms, &mut t.rows);
        t
    } else {
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
        crate::text::PageText { rows, credits, bands, false_heads: Vec::new() }
    };
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
