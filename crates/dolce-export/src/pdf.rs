//! PDF 写出核心（krilla）：一页一块画布，画路径 / 线 / 矩形 / 字形串。场景与成书两条路都落到这里。
//!
//! 坐标一律 SVG 系（左上原点、y 向下、单位 pt），krilla 内部自己翻。
//! 字形串（[`GlyphRun`]）带每个字形的**绝对笔位**：落成一个 `TJ`，字距差进调整量，文字层保持连续（可选可搜）。
//! 字体面嵌不了时画轮廓（转曲），另叠一层不可见文字保住可搜（见 `fonts` 模块注释的判法）。

use std::sync::Arc;

use krilla::color::rgb;
use krilla::geom::{Path, PathBuilder, Point, Transform};
use krilla::num::NormalizedF32;
use krilla::paint::{Fill, FillRule, LineCap, Stroke};
use krilla::surface::Surface;
use krilla::text::{GlyphId, KrillaGlyph};

use crate::fonts::{face_by_pdf_font, synth_bold_stroke, Face, FaceRef, FontBook, PdfFace, SYNTH_ITALIC_SKEW};

/// ARGB（`0xAARRGGBB`，场景里存成 f64）→ krilla 颜色与不透明度
pub fn argb(c: f64) -> (rgb::Color, f32) {
    let v = dolce_base::js::to_int32(c) as u32;
    let a = ((v >> 24) & 0xff) as f32 / 255.0;
    (rgb::Color::new(((v >> 16) & 0xff) as u8, ((v >> 8) & 0xff) as u8, (v & 0xff) as u8), a)
}

/// `0xRRGGBB`（成书 DrawList 的颜色，没有 alpha）
pub fn rgb24(c: u32) -> rgb::Color {
    rgb::Color::new(((c >> 16) & 0xff) as u8, ((c >> 8) & 0xff) as u8, (c & 0xff) as u8)
}

fn fill_of(c: rgb::Color, a: f32) -> Fill {
    Fill { paint: c.into(), opacity: NormalizedF32::new(a.clamp(0.0, 1.0)).unwrap_or(NormalizedF32::ONE), rule: FillRule::NonZero }
}

fn stroke_of(c: rgb::Color, a: f32, w: f64) -> Stroke {
    Stroke {
        paint: c.into(),
        width: w as f32,
        opacity: NormalizedF32::new(a.clamp(0.0, 1.0)).unwrap_or(NormalizedF32::ONE),
        line_cap: LineCap::Butt,
        ..Stroke::default()
    }
}

/// 仿射矩阵（`[a b c d e f]`，SVG `matrix()` 次序）
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Affine(pub [f64; 6]);

impl Affine {
    pub const IDENTITY: Affine = Affine([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    pub fn translate(x: f64, y: f64) -> Affine {
        Affine([1.0, 0.0, 0.0, 1.0, x, y])
    }
    pub fn scale(s: f64) -> Affine {
        Affine([s, 0.0, 0.0, s, 0.0, 0.0])
    }
    /// 场景节点的矩阵（`Matrix33` 行主序 9 元）
    pub fn of_matrix(m: &dolce_base::geom::Matrix33) -> Affine {
        let a = &m.mat;
        Affine([a[0], a[3], a[1], a[4], a[2], a[5]])
    }
    /// `self × o`（先施 `o`）
    pub fn then(&self, o: &Affine) -> Affine {
        let [a, b, c, d, e, f] = self.0;
        let [a2, b2, c2, d2, e2, f2] = o.0;
        Affine([a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2, a * e2 + c * f2 + e, b * e2 + d * f2 + f])
    }
    pub fn is_identity(&self) -> bool {
        *self == Affine::IDENTITY
    }
    fn krilla(&self) -> Transform {
        let [a, b, c, d, e, f] = self.0.map(|v| v as f32);
        Transform::from_row(a, b, c, d, e, f)
    }
    pub fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        let [a, b, c, d, e, f] = self.0;
        (a * x + c * y + e, b * x + d * y + f)
    }
}

/// 路径段（`M`/`L`/`C`/`Z` + 坐标）
pub type Seg = (char, Vec<f64>);

fn build_path(segs: &[Seg]) -> Option<Path> {
    let mut pb = PathBuilder::new();
    let mut open = false;
    for (op, p) in segs {
        if p.iter().any(|v| !v.is_finite()) {
            return None;
        }
        let f = |i: usize| p[i] as f32;
        match op {
            'M' if p.len() >= 2 => {
                pb.move_to(f(0), f(1));
                open = true;
            }
            'L' if p.len() >= 2 && open => pb.line_to(f(0), f(1)),
            'C' if p.len() >= 6 && open => pb.cubic_to(f(0), f(1), f(2), f(3), f(4), f(5)),
            'Q' if p.len() >= 4 && open => pb.quad_to(f(0), f(1), f(2), f(3)),
            'Z' if open => pb.close(),
            _ => {}
        }
    }
    pb.finish()
}

/// SVG `d` → 段（M/L/C/Q/Z，全换成绝对坐标）。命令全认：相对命令、H/V、S/T 平滑曲线、A 椭圆弧（拆成三次曲线）；
/// 同一命令后的多组参数照规范续用（M 后续的按 L）。
pub fn parse_d(d: &str) -> Vec<Seg> {
    // 先切成（命令, 数）
    let b = d.as_bytes();
    let mut toks: Vec<(char, Vec<f64>)> = Vec::new();
    let mut i = 0usize;
    while i < b.len() {
        let c = b[i] as char;
        if c.is_ascii_alphabetic() && c != 'e' && c != 'E' {
            toks.push((c, Vec::new()));
            i += 1;
        } else if c == '-' || c == '+' || c == '.' || c.is_ascii_digit() {
            let s = i;
            i += 1;
            let mut dot = c == '.';
            while i < b.len() {
                let ch = b[i] as char;
                let prev = b[i - 1] as char;
                if ch.is_ascii_digit() || (ch == '.' && !dot) || ch == 'e' || ch == 'E' || ((ch == '-' || ch == '+') && (prev == 'e' || prev == 'E')) {
                    dot |= ch == '.';
                    i += 1;
                } else {
                    break;
                }
            }
            if let Some(t) = toks.last_mut() {
                t.1.push(dolce_base::js::number(&d[s..i]));
            }
        } else {
            i += 1;
        }
    }
    let mut out: Vec<Seg> = Vec::new();
    let (mut cx, mut cy, mut sx, mut sy) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    // 上一段的第二控制点（S / T 反射用）
    let mut last_c: Option<(f64, f64)> = None;
    let mut last_q: Option<(f64, f64)> = None;
    for (cmd, nums) in toks {
        let rel = cmd.is_ascii_lowercase();
        let up = cmd.to_ascii_uppercase();
        let need = match up {
            'M' | 'L' | 'T' => 2,
            'H' | 'V' => 1,
            'C' => 6,
            'S' | 'Q' => 4,
            'A' => 7,
            _ => 0,
        };
        if up == 'Z' {
            out.push(('Z', Vec::new()));
            cx = sx;
            cy = sy;
            last_c = None;
            last_q = None;
            continue;
        }
        if need == 0 {
            continue;
        }
        let mut k = 0;
        let mut first = true;
        while k + need <= nums.len() {
            let p = &nums[k..k + need];
            let (ox, oy) = if rel { (cx, cy) } else { (0.0, 0.0) };
            let (mut nc, mut nq) = (None, None);
            match up {
                'M' if first => {
                    cx = ox + p[0];
                    cy = oy + p[1];
                    sx = cx;
                    sy = cy;
                    out.push(('M', vec![cx, cy]));
                }
                'M' | 'L' => {
                    cx = ox + p[0];
                    cy = oy + p[1];
                    out.push(('L', vec![cx, cy]));
                }
                'H' => {
                    cx = if rel { cx + p[0] } else { p[0] };
                    out.push(('L', vec![cx, cy]));
                }
                'V' => {
                    cy = if rel { cy + p[0] } else { p[0] };
                    out.push(('L', vec![cx, cy]));
                }
                'C' | 'S' => {
                    let (x1, y1, rest) = if up == 'C' {
                        (ox + p[0], oy + p[1], &p[2..])
                    } else {
                        let (px, py) = last_c.unwrap_or((cx, cy));
                        (2.0 * cx - px, 2.0 * cy - py, p)
                    };
                    let (x2, y2, x, y) = (ox + rest[0], oy + rest[1], ox + rest[2], oy + rest[3]);
                    out.push(('C', vec![x1, y1, x2, y2, x, y]));
                    nc = Some((x2, y2));
                    cx = x;
                    cy = y;
                }
                'Q' | 'T' => {
                    let (qx, qy, x, y) = if up == 'Q' {
                        (ox + p[0], oy + p[1], ox + p[2], oy + p[3])
                    } else {
                        let (px, py) = last_q.unwrap_or((cx, cy));
                        (2.0 * cx - px, 2.0 * cy - py, ox + p[0], oy + p[1])
                    };
                    out.push(('Q', vec![qx, qy, x, y]));
                    nq = Some((qx, qy));
                    cx = x;
                    cy = y;
                }
                _ => {
                    let (x, y) = (ox + p[5], oy + p[6]);
                    arc_to_cubics(cx, cy, p[0], p[1], p[2], p[3] != 0.0, p[4] != 0.0, x, y, &mut out);
                    cx = x;
                    cy = y;
                }
            }
            last_c = nc;
            last_q = nq;
            first = false;
            k += need;
        }
    }
    out
}

/// SVG 椭圆弧（端点参数）→ 三次曲线（每段不超过 90°）
#[allow(clippy::too_many_arguments)]
fn arc_to_cubics(x1: f64, y1: f64, rx: f64, ry: f64, rot_deg: f64, large: bool, sweep: bool, x2: f64, y2: f64, out: &mut Vec<Seg>) {
    use std::f64::consts::PI;
    let (mut rx, mut ry) = (rx.abs(), ry.abs());
    if rx == 0.0 || ry == 0.0 || (x1 == x2 && y1 == y2) {
        out.push(('L', vec![x2, y2]));
        return;
    }
    let phi = rot_deg.to_radians();
    let (cp, sp) = (phi.cos(), phi.sin());
    let (dx, dy) = ((x1 - x2) / 2.0, (y1 - y2) / 2.0);
    let (x1p, y1p) = (cp * dx + sp * dy, -sp * dx + cp * dy);
    let lam = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry);
    if lam > 1.0 {
        rx *= lam.sqrt();
        ry *= lam.sqrt();
    }
    let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let mut co = (num / den).max(0.0).sqrt();
    if large == sweep {
        co = -co;
    }
    let (cxp, cyp) = (co * rx * y1p / ry, -co * ry * x1p / rx);
    let (cx, cy) = (cp * cxp - sp * cyp + (x1 + x2) / 2.0, sp * cxp + cp * cyp + (y1 + y2) / 2.0);
    let ang = |ux: f64, uy: f64, vx: f64, vy: f64| {
        let a = (ux * vx + uy * vy) / ((ux * ux + uy * uy).sqrt() * (vx * vx + vy * vy).sqrt());
        let a = a.clamp(-1.0, 1.0).acos();
        if ux * vy - uy * vx < 0.0 {
            -a
        } else {
            a
        }
    };
    let t1 = ang(1.0, 0.0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let mut dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if !sweep && dt > 0.0 {
        dt -= 2.0 * PI;
    } else if sweep && dt < 0.0 {
        dt += 2.0 * PI;
    }
    let n = (dt.abs() / (PI / 2.0)).ceil().max(1.0) as usize;
    let step = dt / n as f64;
    let kappa = 4.0 / 3.0 * (step / 4.0).tan();
    let pt = |t: f64| {
        let (x, y) = (rx * t.cos(), ry * t.sin());
        (cp * x - sp * y + cx, sp * x + cp * y + cy)
    };
    let der = |t: f64| {
        let (x, y) = (-rx * t.sin(), ry * t.cos());
        (cp * x - sp * y, sp * x + cp * y)
    };
    let mut t = t1;
    for _ in 0..n {
        let (p0, p3) = (pt(t), pt(t + step));
        let (d0, d3) = (der(t), der(t + step));
        out.push(('C', vec![p0.0 + kappa * d0.0, p0.1 + kappa * d0.1, p3.0 - kappa * d3.0, p3.1 - kappa * d3.1, p3.0, p3.1]));
        t += step;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_d_relative_and_arcs() {
        let s = parse_d("M50.54 504.49h311.88v28.32h-311.88ZM52 506v25h308v-25Z m1 1 l2 0");
        assert_eq!(s[1], ('L', vec![362.42, 504.49]));
        assert!((s[2].1[1] - 532.81).abs() < 1e-9);
        assert!((s[3].1[0] - 50.54).abs() < 1e-9 && (s[3].1[1] - 532.81).abs() < 1e-9);
        assert_eq!(s[4].0, 'Z');
        // Z 后相对移动从子路径起点算
        let m = s.iter().rposition(|x| x.0 == 'M').unwrap();
        assert_eq!(s[m], ('M', vec![53.0, 507.0]));
        assert_eq!(s[m + 1], ('L', vec![55.0, 507.0]));
        // 半圆弧落到终点
        let a = parse_d("M0 0A10 10 0 0 1 20 0");
        let last = a.last().unwrap();
        assert!((last.1[4] - 20.0).abs() < 1e-9 && last.1[5].abs() < 1e-9);
        assert_eq!(a.len(), 3);
        // S 反射控制点
        let c = parse_d("M0 0C0 10 10 10 10 0S20 -10 20 0");
        assert_eq!(c[2], ('C', vec![10.0, -10.0, 20.0, -10.0, 20.0, 0.0]));
    }
}

/// 字形串里的一个字：字形号、绝对笔位、字形偏移（em）、对应原串的字节区间
#[derive(Clone, Debug)]
pub struct PlacedGlyph {
    pub gid: u16,
    pub x: f64,
    pub x_offset: f64,
    pub y_offset: f64,
    pub range: std::ops::Range<usize>,
}

/// 同一字体面、同一基线的一串字
pub struct GlyphRun<'a> {
    pub font: &'a FaceRef,
    pub glyphs: &'a [PlacedGlyph],
    /// 原串（ToUnicode 按 `range` 取）
    pub text: &'a str,
    pub y: f64,
    pub size: f64,
    pub color: rgb::Color,
    pub alpha: f32,
}

/// 写出过程中的账（缺字、转曲、合成粗斜、画不出的路径）
#[derive(Default, Debug, serde::Serialize)]
pub struct Report {
    pub pages: usize,
    pub bytes: usize,
    /// 哪一页缺哪个字（族串里与末位回退都没有）
    pub missing: Vec<(usize, String, String)>,
    /// 画不出的路径（含 NaN 等）
    pub bad_paths: usize,
    /// 转曲的字体面（key）
    pub outlined: Vec<String>,
    /// 合成粗 / 斜体的字体面（key）
    pub synthesized: Vec<String>,
    /// 嵌入的字体面（key）
    pub embedded: Vec<String>,
    /// 连排文字整形宽与场景记的宽对不上（> 0.5pt）而按字距摊开的次数，及最大差
    pub reconciled: usize,
    pub reconcile_max: f64,
    /// 回退：(角色或族串, 字, 用了哪个字体面)
    pub fallbacks: Vec<(String, String, String)>,
    /// 写出重试了几次（整份写出时 krilla 报字体错、补记转曲后重写）
    pub retries: usize,
}

impl Report {
    fn note(list: &mut Vec<String>, k: &str) {
        if !list.iter().any(|x| x == k) {
            list.push(k.to_string());
        }
    }
}

/// 一页的画布
pub struct Canvas<'s, 'p> {
    pub s: &'s mut Surface<'p>,
    pub page: usize,
    pub report: &'s mut Report,
    /// 转曲时给不可见文字层用的字体面（能嵌、有汉字）
    pub search_face: Option<FaceRef>,
}

impl Canvas<'_, '_> {
    pub fn push(&mut self, t: &Affine) {
        self.s.push_transform(&t.krilla());
    }
    pub fn pop(&mut self) {
        self.s.pop();
    }

    /// 路径；`fill` / `stroke` 都为 None 时不画
    pub fn path(&mut self, segs: &[Seg], fill: Option<(rgb::Color, f32)>, stroke: Option<(rgb::Color, f32, f64)>) {
        if fill.is_none() && stroke.is_none() {
            return;
        }
        let Some(p) = build_path(segs) else {
            if segs.iter().any(|(_, p)| p.iter().any(|v| !v.is_finite())) {
                self.report.bad_paths += 1;
            }
            return;
        };
        self.s.set_fill(fill.map(|(c, a)| fill_of(c, a)));
        self.s.set_stroke(stroke.map(|(c, a, w)| stroke_of(c, a, w)));
        self.s.draw_path(&p);
        self.s.set_stroke(None);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn line(&mut self, x0: f64, y0: f64, x1: f64, y1: f64, w: f64, c: rgb::Color, a: f32) {
        self.path(&[('M', vec![x0, y0]), ('L', vec![x1, y1])], None, Some((c, a, w)));
    }

    pub fn rect(&mut self, x: f64, y: f64, w: f64, h: f64, fill: Option<(rgb::Color, f32)>, stroke: Option<(rgb::Color, f32, f64)>) {
        let segs = [('M', vec![x, y]), ('L', vec![x + w, y]), ('L', vec![x + w, y + h]), ('L', vec![x, y + h]), ('Z', vec![])];
        self.path(&segs, fill, stroke);
    }

    /// 一串字。嵌得了画真文字（合成粗体 = 填充 + 同色描边、合成斜体 = 错切）；嵌不了画轮廓并叠不可见文字。
    pub fn glyphs(&mut self, run: &GlyphRun) {
        if run.glyphs.is_empty() {
            return;
        }
        let face = &run.font.face;
        let embeddable = face.embeddable();
        if run.font.synth_bold || run.font.synth_italic {
            Report::note(&mut self.report.synthesized, &face.key);
        }
        let skew = run.font.synth_italic;
        if skew {
            // 以首字笔位、基线为原点错切
            let (x0, y0) = (run.glyphs[0].x, run.y);
            self.push(&Affine([1.0, 0.0, -SYNTH_ITALIC_SKEW, 1.0, SYNTH_ITALIC_SKEW * y0, 0.0]));
            let _ = x0;
        }
        let fill = fill_of(run.color, run.alpha);
        let stroke = run.font.synth_bold.then(|| stroke_of(run.color, run.alpha, synth_bold_stroke(run.size)));
        self.s.set_fill(Some(fill));
        self.s.set_stroke(stroke);
        if embeddable {
            Report::note(&mut self.report.embedded, &face.key);
            let font = face.pdf_font().expect("能嵌必有字体对象");
            let (start, glyphs) = krilla_glyphs(run, face);
            self.s.draw_glyphs(start, &glyphs, font, run.text, run.size as f32, false);
        } else {
            Report::note(&mut self.report.outlined, &face.key);
            self.outline_glyphs(run, face);
        }
        self.s.set_stroke(None);
        if skew {
            self.pop();
        }
        if !embeddable {
            if let Some(sf) = self.search_face.clone() {
                self.hidden_text(run.text, run.glyphs.first().map_or(0.0, |g| g.x), run.y, run.size, &sf);
            }
        }
    }

    fn outline_glyphs(&mut self, run: &GlyphRun, face: &Arc<Face>) {
        for g in run.glyphs {
            let segs: Vec<Seg> = face
                .outline(g.gid, run.size)
                .into_iter()
                .map(|(op, mut p)| {
                    for k in (0..p.len()).step_by(2) {
                        p[k] += g.x + g.x_offset * run.size;
                        p[k + 1] += run.y - g.y_offset * run.size;
                    }
                    (op, p)
                })
                .collect();
            if let Some(p) = build_path(&segs) {
                self.s.draw_path(&p);
            }
        }
    }

    /// 不可见文字层（填充不透明度 0）：字距为对位撑开的行、转曲的行，搜索与选取靠它。
    /// 紧排画在 `x` 起、基线 `y` 上，字体面里没有的字与私用区的字跳过。
    pub fn hidden_text(&mut self, text: &str, x: f64, y: f64, size: f64, f: &FaceRef) {
        let Some(font) = f.face.pdf_font() else { return };
        if !f.face.embeddable() {
            return;
        }
        // 私用区（SMuFL 记号）不是可搜的字；GBK 印刷字库在私用区常有造字，不滤会写进乱码
        let shown: String = text.chars().filter(|&c| !c.is_whitespace() && !('\u{e000}'..='\u{f8ff}').contains(&c) && f.face.has(c)).collect();
        if shown.is_empty() {
            return;
        }
        let shaped = f.face.shape(&shown, &[]);
        let glyphs: Vec<KrillaGlyph> = shaped
            .iter()
            .enumerate()
            .map(|(i, g)| {
                let end = shaped[i + 1..].iter().map(|n| n.cluster).find(|&c| c > g.cluster).unwrap_or(shown.len());
                KrillaGlyph::new(GlyphId::new(g.gid as u32), g.x_advance as f32, g.x_offset as f32, g.y_offset as f32, 0.0, g.cluster..end, None)
            })
            .collect();
        self.s.set_fill(Some(Fill { paint: rgb::Color::black().into(), opacity: NormalizedF32::ZERO, rule: FillRule::NonZero }));
        self.s.set_stroke(None);
        self.s.draw_glyphs(Point::from_xy(x as f32, y as f32), &glyphs, font, &shown, size as f32, false);
    }
}

/// 绝对笔位 → krilla 的「起点 + 逐字 advance」
fn krilla_glyphs(run: &GlyphRun, face: &Face) -> (Point, Vec<KrillaGlyph>) {
    let size = run.size;
    let n = run.glyphs.len();
    let mut out = Vec::with_capacity(n);
    for (i, g) in run.glyphs.iter().enumerate() {
        let adv = if i + 1 < n { (run.glyphs[i + 1].x - g.x) / size } else { face.advance(g.gid) };
        out.push(KrillaGlyph::new(GlyphId::new(g.gid as u32), adv as f32, g.x_offset as f32, g.y_offset as f32, 0.0, g.range.clone(), None));
    }
    (Point::from_xy(run.glyphs[0].x as f32, run.y as f32), out)
}

/// 试嵌：单拿这一面出一份几个字的 PDF，写得出就算能嵌。
pub(crate) fn trial_embed(face: &Face, font: krilla::text::Font) -> bool {
    let probe: Vec<u16> = ['A', '1', '一', '，', '\u{e050}']
        .iter()
        .filter_map(|&c| face.glyph(c))
        .chain((1..4).filter(|g| (*g as usize) < face.ttf().number_of_glyphs() as usize))
        .collect();
    let mut doc = krilla::Document::new();
    {
        let Some(ps) = krilla::page::PageSettings::from_wh(100.0, 100.0) else { return false };
        let mut page = doc.start_page_with(ps);
        let mut s = page.surface();
        let glyphs: Vec<KrillaGlyph> = probe.iter().map(|&g| KrillaGlyph::new(GlyphId::new(g as u32), 0.5, 0.0, 0.0, 0.0, 0..1, None)).collect();
        s.draw_glyphs(Point::from_xy(10.0, 50.0), &glyphs, font, "x", 12.0, false);
        s.finish();
        page.finish();
    }
    doc.finish().is_ok()
}

/// 一份 PDF 的写出参数
#[derive(Default, Clone)]
pub struct DocInfo {
    pub title: Option<String>,
    /// 书签：(标题, 页序 0 起)
    pub outline: Vec<(String, usize)>,
}

/// 页面尺寸（pt）
pub trait PageSource {
    fn page_count(&self) -> usize;
    fn page_size(&self, i: usize) -> (f64, f64);
    fn draw(&self, i: usize, c: &mut Canvas);
}

/// 整份写出：逐页画，krilla 报某字体面嵌不了时把它记成转曲重写（最多重试 8 次）。
pub fn write_pdf(book: &FontBook, src: &dyn PageSource, info: &DocInfo, search_face: Option<FaceRef>) -> Result<(Vec<u8>, Report), String> {
    let mut retries = 0usize;
    loop {
        let mut report = Report { retries, ..Report::default() };
        let mut doc = krilla::Document::new();
        let mut meta = krilla::metadata::Metadata::new().creator("Dolce".to_string());
        if let Some(t) = &info.title {
            meta = meta.title(t.clone());
        }
        doc.set_metadata(meta);
        for i in 0..src.page_count() {
            let (w, h) = src.page_size(i);
            let ps = krilla::page::PageSettings::from_wh(w as f32, h as f32).ok_or_else(|| format!("第 {} 页尺寸不对：{w}×{h}", i + 1))?;
            let mut page = doc.start_page_with(ps);
            {
                let mut s = page.surface();
                let mut c = Canvas { s: &mut s, page: i, report: &mut report, search_face: search_face.clone() };
                src.draw(i, &mut c);
                s.finish();
            }
            page.finish();
        }
        if !info.outline.is_empty() {
            let mut ol = krilla::outline::Outline::new();
            for (t, p) in &info.outline {
                if *p < src.page_count() {
                    ol.push_child(krilla::outline::OutlineNode::new(t.clone(), krilla::destination::XyzDestination::new(*p, Point::from_xy(0.0, 0.0))));
                }
            }
            doc.set_outline(ol);
        }
        report.pages = src.page_count();
        match doc.finish() {
            Ok(bytes) => {
                report.bytes = bytes.len();
                return Ok((bytes, report));
            }
            Err(krilla::error::KrillaError::Font(font, msg)) if retries < 8 => {
                let Some(face) = face_by_pdf_font(book, &font) else { return Err(format!("字体嵌不进：{msg}")) };
                face.mark_outline_only();
                retries += 1;
            }
            Err(e) => return Err(format!("写 PDF 失败：{e:?}")),
        }
    }
}

/// 栅格容器：每页一张 PNG 铺满（网页版没有本地字体授权时的导出；取代 jsPDF）。`pages`：(PNG 字节, 页宽 pt, 页高 pt)
pub fn raster_pdf(pages: &[(Vec<u8>, f64, f64)], title: Option<&str>) -> Result<Vec<u8>, String> {
    let mut doc = krilla::Document::new();
    let mut meta = krilla::metadata::Metadata::new().creator("Dolce".to_string());
    if let Some(t) = title {
        meta = meta.title(t.to_string());
    }
    doc.set_metadata(meta);
    for (i, (png, w, h)) in pages.iter().enumerate() {
        let ps = krilla::page::PageSettings::from_wh(*w as f32, *h as f32).ok_or_else(|| format!("第 {} 页尺寸不对：{w}×{h}", i + 1))?;
        let img = krilla::image::Image::from_png(krilla::Data::from(png.clone()), true).map_err(|e| format!("第 {} 页 PNG：{e}", i + 1))?;
        let mut page = doc.start_page_with(ps);
        {
            let mut s = page.surface();
            let size = krilla::geom::Size::from_wh(*w as f32, *h as f32).ok_or("页尺寸")?;
            s.draw_image(img, size);
            s.finish();
        }
        page.finish();
    }
    doc.finish().map_err(|e| format!("写 PDF 失败：{e:?}"))
}
