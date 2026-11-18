//! 场景（`dolce_scene::Page`）→ PDF：编辑器「导出 PDF」那一路。语义与 SVG 出口（`dolce_scene::svg`）同口径：
//! 两种方言的颜色规则（混排里线与字一律黑）、`invisible` 跳过、SMuFL 字在简谱方言里一律 Bravura。
//!
//! 文字：
//! - 带逐字笔位（`char_xs`）的照笔位逐字落（同 SVG 的 `x` 列表），同一字体面的连成一个 `TJ`；
//!   字距为对位撑开（比自然宽宽出 5% 以上）且含汉字的，另叠一层紧排的不可见文字（提取器见大字距会插空格，搜不到）。
//! - 不带的整串整形连排（空白照 SVG 折叠），整形宽与场景记的宽（排版量字的结果）差过 0.5pt 时把差额按字距摊开、
//!   两端对齐排版位置（[`crate::pdf::Report::reconciled`] 计数）。
//! - 选字：族串（同量字展开）里第一个有这个字的面，再试平台的末位回退；都没有记缺字。

use dolce_scene::{Dialect, Node, Page, Role, Shape, TextShape};

use crate::fonts::{FaceRef, FontBook};
use crate::pdf::{argb, Affine, Canvas, DocInfo, GlyphRun, PageSource, PlacedGlyph, Report, Seg};

/// 一页：场景 + 纸的大小（pt；场景的 viewBox 按它缩放，五线谱的 tenths 在这里换成 pt）
pub struct ScenePage {
    pub scene: Page,
    pub w_pt: f64,
    pub h_pt: f64,
}

pub struct SceneDoc<'a> {
    pub book: &'a FontBook,
    pub pages: &'a [ScenePage],
    /// 纸张底色（ARGB）；白不铺
    pub bg: Option<f64>,
}

impl PageSource for SceneDoc<'_> {
    fn page_count(&self) -> usize {
        self.pages.len()
    }
    fn page_size(&self, i: usize) -> (f64, f64) {
        (self.pages[i].w_pt, self.pages[i].h_pt)
    }
    fn draw(&self, i: usize, c: &mut Canvas) {
        let p = &self.pages[i];
        if let Some(bg) = self.bg {
            if dolce_base::js::to_int32(bg) as u32 & 0xffffff != 0xffffff {
                let (col, a) = argb(bg);
                c.rect(0.0, 0.0, p.w_pt, p.h_pt, Some((col, a)), None);
            }
        }
        let Some(root) = &p.scene.root else { return };
        let sx = if p.scene.w > 0.0 { p.w_pt / p.scene.w } else { 1.0 };
        let sy = if p.scene.h > 0.0 { p.h_pt / p.scene.h } else { sx };
        let base = Affine([sx, 0.0, 0.0, sy, 0.0, 0.0]);
        let mut w = Walker { book: self.book, mixed: p.scene.dialect == Dialect::Mixed };
        w.node(root, &base, c);
    }
}

struct Walker<'a> {
    book: &'a FontBook,
    mixed: bool,
}

impl Walker<'_> {
    fn node(&mut self, n: &Node, parent: &Affine, c: &mut Canvas) {
        if n.is_invisible() {
            return;
        }
        let m = parent.then(&Affine::of_matrix(&n.m));
        let black = (krilla::color::rgb::Color::black(), 1.0f32);
        match &n.shape {
            Shape::Path(p) => {
                let segs: Vec<Seg> = p
                    .segs
                    .iter()
                    .map(|s| {
                        let op = match s.op {
                            dolce_scene::PathOp::M => 'M',
                            dolce_scene::PathOp::L => 'L',
                            dolce_scene::PathOp::C => 'C',
                            dolce_scene::PathOp::Z => 'Z',
                        };
                        (op, s.pts.clone())
                    })
                    .collect();
                c.push(&m);
                c.path(&segs, p.fill.then(|| argb(p.fill_color)), p.stroke.then(|| {
                    let (col, a) = argb(p.stroke_color);
                    (col, a, p.stroke_width)
                }));
                c.pop();
            }
            Shape::Line(l) => {
                let (col, a) = if self.mixed { black } else { argb(l.stroke_color) };
                c.push(&m);
                c.line(l.p0.x, l.p0.y, l.p1.x, l.p1.y, l.stroke_width, col, a);
                c.pop();
            }
            Shape::Text(t) => {
                let (col, a) = if self.mixed { black } else { argb(t.color) };
                let expect = match &n.role {
                    None if n.w > 0.0 => Some(n.w),
                    Some(Role::JpNumber { aug_dot_advance, .. }) => Some(n.w - aug_dot_advance),
                    _ => None,
                };
                c.push(&m);
                self.text(t, &t.font.family, expect, col, a, c);
                c.pop();
            }
            Shape::Smufl(s) => {
                let (col, a) = if self.mixed { black } else { argb(s.text.color) };
                let fam = if self.mixed { s.text.font.family.clone() } else { "Bravura".to_string() };
                c.push(&m);
                self.text(&s.text, &fam, None, col, a, c);
                c.pop();
            }
            Shape::Group | Shape::Item => {}
        }
        // 混排方言只递归组；简谱方言每个节点都递归
        if !self.mixed || n.is_group() {
            for k in &n.k {
                self.node(k, &m, c);
            }
        }
    }

    fn text(&mut self, t: &TextShape, family: &str, expect: Option<f64>, color: krilla::color::rgb::Color, alpha: f32, c: &mut Canvas) {
        let (bold, italic, size) = (t.font.bold, t.font.italic, t.font.size);
        let chain = self.book.chain(family, bold, italic);
        let per_char = matches!(&t.char_xs, Some(xs) if xs.len() > 1);
        let text: String = if per_char { t.text.clone() } else { dolce_text::svg_collapsed_text(&t.text) };
        // 逐字定字体面
        let mut picks: Vec<(usize, char, Option<FaceRef>)> = Vec::new();
        for (bi, ch) in text.char_indices() {
            let f = if ch.is_whitespace() { chain.first().cloned() } else { self.book.pick(&chain, ch, bold, italic) };
            if f.is_none() && !ch.is_whitespace() {
                c.report.missing.push((c.page, family.to_string(), ch.to_string()));
            } else if let (Some(f), Some(main)) = (&f, chain.first()) {
                if !std::sync::Arc::ptr_eq(&f.face, &main.face) && !ch.is_whitespace() {
                    let k = (family.to_string(), ch.to_string(), f.face.key.clone());
                    if !c.report.fallbacks.contains(&k) {
                        c.report.fallbacks.push(k);
                    }
                }
            }
            picks.push((bi, ch, f));
        }
        // 笔位
        let mut placed: Vec<(PlacedGlyph, FaceRef)> = Vec::new();
        if per_char {
            let xs = t.char_xs.as_ref().unwrap();
            for (i, (bi, ch, f)) in picks.iter().enumerate() {
                let Some(f) = f else { continue };
                if ch.is_whitespace() {
                    continue;
                }
                let x = xs.get(i).copied().unwrap_or_else(|| xs.last().copied().unwrap_or(0.0));
                let s = &text[*bi..*bi + ch.len_utf8()];
                for g in f.face.shape(s, &[]) {
                    placed.push((PlacedGlyph { gid: g.gid, x: x + g.x_offset * 0.0, x_offset: g.x_offset, y_offset: g.y_offset, range: *bi..*bi + ch.len_utf8() }, f.clone()));
                }
            }
        } else {
            // 浏览器缺省的相邻全角标点挤压（量字时 `BrowserCompat` 挤过，排版宽里已扣掉）：照同一判法逐字左挪
            let cps = dolce_text::cjkpunct::code_points(&text);
            let face_of = |c: &str| picks.iter().find(|(bi, _, _)| text[*bi..].starts_with(c)).and_then(|(_, _, f)| f.clone());
            let adv1 = |f: &FaceRef, c: &str, feats: &[&str]| f.face.shaped_width(c, feats);
            let shifts = dolce_text::han_kern_shifts(
                &cps,
                |c| dolce_text::cjkpunct::punct_class(c) != dolce_text::cjkpunct::PunctClass::None && face_of(c).is_some_and(|f| (adv1(&f, c, &[]) - 1.0).abs() <= 0.02),
                |c| face_of(c).map_or(0.0, |f| (adv1(&f, c, &[]) - adv1(&f, c, &["halt"])).max(0.0) * size),
            );
            let char_at: std::collections::HashMap<usize, usize> = picks.iter().enumerate().map(|(k, (bi, _, _))| (*bi, k)).collect();
            // 按字体面切段整形、连排
            let mut x = 0.0;
            let mut i = 0;
            while i < picks.len() {
                let Some(f) = picks[i].2.clone() else {
                    i += 1;
                    continue;
                };
                let mut j = i + 1;
                while j < picks.len() && picks[j].2.as_ref().is_some_and(|g| same(g, &f)) {
                    j += 1;
                }
                let b0 = picks[i].0;
                let b1 = if j < picks.len() { picks[j].0 } else { text.len() };
                let seg = &text[b0..b1];
                let shaped = f.face.shape(seg, &[]);
                for (k, g) in shaped.iter().enumerate() {
                    let end = shaped[k + 1..].iter().map(|n| n.cluster).find(|&cl| cl > g.cluster).unwrap_or(seg.len());
                    let kern = shifts.as_ref().and_then(|sh| char_at.get(&(b0 + g.cluster)).map(|&k| sh[k])).unwrap_or(0.0);
                    placed.push((PlacedGlyph { gid: g.gid, x: x - kern, x_offset: g.x_offset, y_offset: g.y_offset, range: b0 + g.cluster..b0 + end }, f.clone()));
                    x += g.x_advance * size;
                }
                i = j;
            }
            if let Some(sh) = &shifts {
                x -= sh[sh.len() - 1];
            }
            // 与排版量的宽对账
            if let Some(w) = expect {
                let d = w - x;
                if d.abs() > 0.5 && placed.len() > 1 && x > 0.0 {
                    let gaps = (placed.len() - 1) as f64;
                    for (k, (g, _)) in placed.iter_mut().enumerate() {
                        g.x += d * k as f64 / gaps;
                    }
                    c.report.reconciled += 1;
                    c.report.reconcile_max = c.report.reconcile_max.max(d.abs());
                }
            }
        }
        // 同一字体面的连成一串画（空白字形也画：ToUnicode 留着词间空格）
        let mut i = 0;
        while i < placed.len() {
            let f = placed[i].1.clone();
            let mut j = i + 1;
            while j < placed.len() && same(&placed[j].1, &f) {
                j += 1;
            }
            let glyphs: Vec<PlacedGlyph> = placed[i..j].iter().map(|(g, _)| g.clone()).collect();
            c.glyphs(&GlyphRun { font: &f, glyphs: &glyphs, text: &text, y: 0.0, size, color, alpha });
            i = j;
        }
        // 字距撑开的汉字行叠不可见紧排层
        if per_char && placed.len() > 1 && text.chars().any(|ch| ch as u32 > 0x2e7f) {
            if let Some(main) = chain.first() {
                let body: String = text.chars().filter(|ch| !ch.is_whitespace()).collect();
                let natural = main.face.shaped_width(&body, &[]) * size;
                let spread = placed.last().unwrap().0.x - placed[0].0.x;
                if spread > natural * 1.05 && main.face.embeddable() {
                    c.hidden_text(&body, placed[0].0.x, 0.0, size, main);
                }
            }
        }
    }
}

fn same(a: &FaceRef, b: &FaceRef) -> bool {
    std::sync::Arc::ptr_eq(&a.face, &b.face) && a.synth_bold == b.synth_bold && a.synth_italic == b.synth_italic
}

/// 转曲时给不可见文字层用的面：平台末位回退里第一个能嵌、有汉字的
pub fn search_face(book: &FontBook) -> Option<FaceRef> {
    book.last_resort.iter().filter_map(|f| book.find(f, false, false)).find(|f| f.face.has('一') && f.face.embeddable())
}

/// 场景页 → PDF 字节
pub fn scene_pdf(book: &FontBook, pages: &[ScenePage], bg: Option<f64>, info: &DocInfo) -> Result<(Vec<u8>, Report), String> {
    let doc = SceneDoc { book, pages, bg };
    crate::pdf::write_pdf(book, &doc, info, search_face(book))
}
