//! 场景 → `.pptx`（照 `editor/pptx.ts`）：页面树的叶子逐个变成 DrawingML 形状——文字成文本框、线与路径成 `custGeom` 自由曲线、
//! SMuFL 字按 Bravura 轮廓**转曲**（PPT 里不能指望装了 Bravura）；OOXML 手写、zip 自己打。
//!
//! 坐标不走矩阵累积：同 TS `item.pos(null)`，叶子的绝对位置是自己与各级祖先的平移之和（缩放只取叶子自己的 `scaleY` 乘字号）。
//!
//! **目标字体的适配**：排版拿 PingFang SC 量，片子里写的是 Microsoft YaHei（投影机与 Windows 上真正用的那份），两套度量不同——
//! - 竖向：文本框 `anchor="b"`，框底 = 基线 + **雅黑**的 descent（[`TARGET_DESCENT`]）；
//! - 横向：音符数字按雅黑的等宽数字宽给框、居中，框心落在排版的墨迹中心（场景角色 `JpNumber.cx`）上；
//!   减时线两端（角色 `BeamLine.ends`）接回数字盒、附点（角色 `JpOctaveDot.aug`）按雅黑的数字墨迹右缘重摆；
//! - 带逐字笔位（标点挤压）的文字拆成逐字文本框，收尾标点并进前一个字并换半角形（[`trail_punct`]）。
//!
//! 文本框高 = 字体的 descent − ascent（排版那份度量，宿主按 [`FontMetric`] 表给；只定框顶，框底不随它）。

use std::collections::HashMap;
use std::io::Write;

use dolce_scene::{Node, Page, PathOp, PathSeg, Role, Shape};
use dolce_text::Font;
use serde::Deserialize;

use crate::fonts::Face;

/// 1 pt = 12700 EMU（JS `Math.round` 的舍入：.5 往正无穷）
fn emu(v: f64) -> i64 {
    (v * 12700.0 + 0.5).floor() as i64
}

fn xml(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '&' => o.push_str("&amp;"),
            '\'' => o.push_str("&apos;"),
            '"' => o.push_str("&quot;"),
            _ => o.push(c),
        }
    }
    o
}

fn hex(argb: f64) -> String {
    format!("{:06X}", dolce_base::js::to_int32(argb) as u32 & 0xffffff)
}

// ── 目标字体（Microsoft YaHei，msyh.ttf 的 hmtx/hhea，与 2019 年那批成品量到的一致）──

const TARGET_UPM: f64 = 2048.0;
const TARGET_DESCENT: f64 = 536.0 / TARGET_UPM;
/// 目标字体里数字的墨迹右缘（em，advance 起点算 0；0–9 在 0.512~0.551 之间取中）——附点按它摆
const TARGET_DIGIT_INK_RIGHT: f64 = 0.532;
/// 目标字体里数字「1」的墨迹高（em）：附点离数字那道空按它乘 `stack-gap`
const TARGET_DIGIT_INK: f64 = 0.7725;

/// 目标字体里这个字的 advance（em）。表外的字照排版量到的宽走（汉字两套都是 1 em，本来就对得上）
fn target_advance(c: char) -> Option<f64> {
    Some(match c {
        '-' => 886.0,
        '.' | '\u{b7}' => 493.0,
        '0'..='9' => 1201.0,
        _ => return None,
    } / TARGET_UPM)
}

/// 收尾类标点 → 目标字体里的半角形（并进前一个字的 run；开头类跟后一个字，照旧单独成框）
fn trail_punct(c: char) -> Option<&'static str> {
    Some(match c {
        '\u{ff0c}' => ",",
        '\u{3002}' => "\u{ff61}",
        '\u{ff1b}' => ";",
        '\u{ff1a}' => ":",
        '\u{ff01}' => "!",
        '\u{ff1f}' => "?",
        '\u{3001}' => "\u{ff64}",
        '\u{ff09}' => ")",
        '\u{300d}' | '\u{300f}' => "\u{ff63}",
        _ => return None,
    })
}

/// 排版那份字体度量（宿主给：TS `Font.metrics`；ascent 在基线上方为负）
#[derive(Clone, Debug, Deserialize)]
pub struct FontMetric {
    pub font: Font,
    pub ascent: f64,
    pub descent: f64,
}

/// 一份片子的料（`editor/pptx.ts::PptxSource` + 底色 + 度量表）
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptxInput {
    pub pages: Vec<Page>,
    /// 附点离数字的那道空（`engrave/stack.ts`；缺省 0.17）
    #[serde(default = "stack_gap_default")]
    pub stack_gap: f64,
    pub page_width: f64,
    pub page_height: f64,
    /// 幻灯片底色（ARGB）；白不写（留给母版的 bg1）
    #[serde(default = "white")]
    pub bg: f64,
    #[serde(default)]
    pub metrics: Vec<FontMetric>,
}

fn stack_gap_default() -> f64 {
    0.17
}
fn white() -> f64 {
    4294967295.0
}

/// 一个形状
enum ShapeOut {
    Text { x: f64, y: f64, w: f64, h: f64, text: String, size: f64, color: String, bold: bool, family: String, center: bool },
    Geom { x: f64, y: f64, w: f64, h: f64, segs: Vec<PathSeg>, fill: Option<String>, stroke: Option<String>, stroke_w: f64 },
}

fn scale_y(n: &Node) -> f64 {
    n.m.mat[4]
}

struct Walker<'a> {
    bravura: &'a Face,
    stack_gap: f64,
    metrics: HashMap<(String, u64, bool, bool), (f64, f64)>,
    out: Vec<ShapeOut>,
}

/// 数字在片子里的横向占位：以排版墨迹中心为心、目标字体的宽为宽（只认单字；多字或表外的字按排版宽）
struct Span {
    cx: f64,
    half: f64,
    tw: Option<f64>,
}

fn number_span(num: &Node, abs_x: f64) -> Span {
    let (Some(t), Some(Role::JpNumber { aug_dot_advance, cx })) = (num.text_ref(), &num.role) else {
        return Span { cx: abs_x, half: 0.0, tw: None };
    };
    let size = t.font.size * scale_y(num);
    let mut chars = t.text.chars();
    let tw = match (chars.next(), chars.next()) {
        (Some(c), None) => target_advance(c).map(|a| a * size),
        _ => None,
    };
    // numberPos：去掉附点那份留白的 advance（数字串里早已不写 `·`）
    let number_pos = num.w - aug_dot_advance;
    Span { cx: abs_x + cx, half: tw.unwrap_or(number_pos) / 2.0, tw }
}

impl Walker<'_> {
    fn node(&mut self, n: &Node, abs: (f64, f64)) {
        if n.has_class("invisible") {
            return;
        }
        let me = (abs.0 + n.x(), abs.1 + n.y());
        match &n.shape {
            Shape::Path(_) | Shape::Line(_) | Shape::Text(_) | Shape::Smufl(_) => self.leaf(n, me, None),
            _ => {
                for k in &n.k {
                    if k.has_class("invisible") {
                        continue;
                    }
                    let km = (me.0 + k.x(), me.1 + k.y());
                    match &k.shape {
                        Shape::Path(_) | Shape::Line(_) | Shape::Text(_) | Shape::Smufl(_) => self.leaf(k, km, Some((n, me))),
                        _ => self.node(k, me),
                    }
                }
            }
        }
    }

    /// 叶子；`parent` 是父节点与它的绝对位置（减时线、附点找所挂的数字用）
    fn leaf(&mut self, n: &Node, pp: (f64, f64), parent: Option<(&Node, (f64, f64))>) {
        match &n.shape {
            Shape::Line(l) => {
                let (mut x0, mut x1) = (l.p0.x + pp.0, l.p1.x + pp.0);
                let (y0, y1) = (l.p0.y + pp.1, l.p1.y + pp.1);
                // 减时线：两端接回目标字体的数字盒（排版给的是排版字体的 advance 边缘）
                if let (Some(Role::BeamLine { ends: Some([a, b]), .. }), Some((par, pa))) = (&n.role, parent) {
                    let num_at = |i: u32| {
                        let g = par.k.get(i as usize)?;
                        let num = g.k.first()?;
                        Some(number_span(num, pa.0 + g.x() + num.x()))
                    };
                    if let (Some(l), Some(r)) = (num_at(*a), num_at(*b)) {
                        x0 = l.cx - l.half;
                        x1 = r.cx + r.half;
                    }
                }
                let (ox, oy) = (x0.min(x1), y0.min(y1));
                self.out.push(ShapeOut::Geom {
                    x: ox,
                    y: oy,
                    w: (x1 - x0).abs().max(0.01),
                    h: (y1 - y0).abs().max(0.01),
                    segs: vec![PathSeg { op: PathOp::M, pts: vec![x0 - ox, y0 - oy] }, PathSeg { op: PathOp::L, pts: vec![x1 - ox, y1 - oy] }],
                    fill: None,
                    stroke: Some(hex(l.stroke_color)),
                    stroke_w: l.stroke_width,
                });
            }
            Shape::Path(p) => {
                let mut x = pp.0;
                if let (Some(Role::JpOctaveDot { radius, aug: Some(i) }), Some((par, pa))) = (&n.role, parent) {
                    if let Some(num) = par.k.first() {
                        x = self.aug_dot_x(num, pa.0 + num.x(), *i as f64, radius * scale_y(n));
                    }
                }
                self.out.push(ShapeOut::Geom {
                    x,
                    y: pp.1,
                    w: n.w.max(0.01),
                    h: n.h.max(0.01),
                    segs: p.segs.clone(),
                    fill: p.fill.then(|| hex(p.fill_color)),
                    stroke: p.stroke.then(|| hex(p.stroke_color)),
                    stroke_w: p.stroke_width,
                });
            }
            Shape::Text(_) | Shape::Smufl(_) => self.text(n, pp),
            _ => {}
        }
    }

    /// 附点的横向落点（圆的左缘）：规则同排版（离数字墨迹右缘一道空、点与点之间一道空），墨迹右缘与墨迹高换成目标字体的
    fn aug_dot_x(&self, num: &Node, num_x: f64, index: f64, r: f64) -> f64 {
        let size = num.text_ref().map_or(0.0, |t| t.font.size) * scale_y(num);
        let s = number_span(num, num_x);
        let ink_right = s.cx - s.half + TARGET_DIGIT_INK_RIGHT * size;
        let gap = self.stack_gap * TARGET_DIGIT_INK * size;
        ink_right + gap + index * (2.0 * r + gap)
    }

    fn text(&mut self, n: &Node, pp: (f64, f64)) {
        let t = n.text_ref().expect("文字节点");
        if matches!(n.shape, Shape::Smufl(_)) || n.has_class("smufl") {
            // SMuFL 转曲：逐字取 Bravura 轮廓，框按轮廓的紧包围盒
            let size = t.font.size * scale_y(n);
            let mut cx = 0.0;
            for ch in t.text.chars() {
                let Some(gid) = self.bravura.glyph(ch) else { continue };
                if let Some(ink) = self.bravura.tight_ink(gid) {
                    let (ox, oy) = (ink.left * size, ink.top * size);
                    let segs = self
                        .bravura
                        .outline(gid, size)
                        .into_iter()
                        .map(|(op, pts)| PathSeg {
                            op: match op {
                                'M' => PathOp::M,
                                'L' => PathOp::L,
                                'C' => PathOp::C,
                                _ => PathOp::Z,
                            },
                            pts: pts.iter().enumerate().map(|(i, v)| v - if i % 2 == 0 { ox } else { oy }).collect(),
                        })
                        .collect();
                    self.out.push(ShapeOut::Geom {
                        x: pp.0 + cx + ox,
                        y: pp.1 + oy,
                        w: ((ink.right - ink.left) * size).max(0.01),
                        h: ((ink.bottom - ink.top) * size).max(0.01),
                        segs,
                        fill: Some(hex(t.color)),
                        stroke: None,
                        stroke_w: 0.0,
                    });
                }
                cx += self.bravura.advance(gid) * size;
            }
            return;
        }
        let f = &t.font;
        let (asc, desc) = self.metrics.get(&(f.family.clone(), f.size.to_bits(), f.bold, f.italic)).copied().unwrap_or((-1.06 * f.size, 0.36 * f.size));
        let height = desc - asc;
        let sz = f.size * scale_y(n);
        // 场景的 y 是基线；框底 = 基线 + 目标字体的 descent
        let y = pp.1 + TARGET_DESCENT * sz - height;
        let color = hex(t.color);
        let mk = |text: String, x: f64, w: f64, center: bool| ShapeOut::Text {
            x,
            y,
            w: w.max(1.0),
            h: height,
            text,
            size: sz,
            color: color.clone(),
            bold: f.bold,
            family: f.family.clone(),
            center,
        };
        if matches!(n.role, Some(Role::JpNumber { .. })) {
            let s = number_span(n, pp.0);
            if let Some(tw) = s.tw {
                self.out.push(mk(t.text.clone(), s.cx - s.half, tw, true));
                return;
            }
        }
        let chars: Vec<char> = t.text.chars().collect();
        if let Some(xs) = t.char_xs.as_ref().filter(|xs| xs.len() == chars.len() && chars.len() > 1) {
            let mut groups: Vec<(usize, String)> = Vec::new();
            for (i, &c) in chars.iter().enumerate() {
                match (trail_punct(c), groups.last_mut()) {
                    (Some(h), Some(last)) => last.1.push_str(h),
                    _ => groups.push((i, c.to_string())),
                }
            }
            for g in 0..groups.len() {
                let x = xs[groups[g].0];
                let next = groups.get(g + 1).map_or(n.w, |nx| xs[nx.0]);
                let s = mk(std::mem::take(&mut groups[g].1), pp.0 + x, next - x, false);
                self.out.push(s);
            }
            return;
        }
        self.out.push(mk(t.text.clone(), pp.0, n.w, false));
    }
}

// ── OOXML ──

#[allow(clippy::too_many_arguments)]
fn geom_xml(o: &mut String, id: usize, x: f64, y: f64, w: f64, h: f64, segs: &[PathSeg], fill: &Option<String>, stroke: &Option<String>, stroke_w: f64) {
    let (ww, hh) = (emu(w), emu(h));
    let mut path = String::new();
    for s in segs {
        let p = |i: usize| format!("<a:pt x=\"{}\" y=\"{}\"/>", emu(s.pts[i]), emu(s.pts[i + 1]));
        match s.op {
            PathOp::M => path += &format!("<a:moveTo>{}</a:moveTo>", p(0)),
            PathOp::L => path += &format!("<a:lnTo>{}</a:lnTo>", p(0)),
            PathOp::C => path += &format!("<a:cubicBezTo>{}{}{}</a:cubicBezTo>", p(0), p(2), p(4)),
            PathOp::Z => path += "<a:close/>",
        }
    }
    let fill = fill.as_ref().map_or("<a:noFill/>".to_string(), |c| format!("<a:solidFill><a:srgbClr val=\"{c}\"/></a:solidFill>"));
    let ln = stroke.as_ref().map_or("<a:ln><a:noFill/></a:ln>".to_string(), |c| format!("<a:ln w=\"{}\"><a:solidFill><a:srgbClr val=\"{c}\"/></a:solidFill></a:ln>", emu(stroke_w)));
    o.push_str(&format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"g{id}\"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>\
         <p:spPr><a:xfrm><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{ww}\" cy=\"{hh}\"/></a:xfrm>\
         <a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l=\"0\" t=\"0\" r=\"{ww}\" b=\"{hh}\"/>\
         <a:pathLst><a:path w=\"{ww}\" h=\"{hh}\">{path}</a:path></a:pathLst></a:custGeom>{fill}{ln}</p:spPr>\
         <p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>",
        emu(x),
        emu(y)
    ));
}

/// DrawingML 只收一个字体名：族串里有雅黑就用雅黑（Windows 上真正会用的那份），否则第一个非泛称，再不然 Arial
fn ppt_typeface(css: &str) -> String {
    let fams: Vec<String> = css
        .split(',')
        .map(|f| {
            let f = f.trim();
            let b = f.as_bytes();
            if b.len() >= 2 && (b[0] == b'"' || b[0] == b'\'') && b[b.len() - 1] == b[0] {
                f[1..f.len() - 1].to_string()
            } else {
                f.to_string()
            }
        })
        .collect();
    if let Some(y) = fams.iter().find(|f| f.to_lowercase() == "microsoft yahei") {
        return y.clone();
    }
    fams.into_iter()
        .find(|f| !f.is_empty() && !["sans-serif", "serif", "monospace", "system-ui"].contains(&f.to_lowercase().as_str()))
        .unwrap_or_else(|| "Arial".into())
}

#[allow(clippy::too_many_arguments)]
fn text_xml(o: &mut String, id: usize, x: f64, y: f64, w: f64, h: f64, text: &str, size: f64, color: &str, bold: bool, family: &str, center: bool) {
    let sz = (size * 100.0 + 0.5).floor() as i64;
    let fam = xml(&ppt_typeface(family));
    let b = if bold { " b=\"1\"" } else { "" };
    let algn = if center { "ctr" } else { "l" };
    o.push_str(&format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"t{id}\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr/></p:nvSpPr>\
         <p:spPr><a:xfrm><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm>\
         <a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>\
         <p:txBody><a:bodyPr wrap=\"none\" lIns=\"0\" tIns=\"0\" rIns=\"0\" bIns=\"0\" anchor=\"b\" horzOverflow=\"overflow\" vertOverflow=\"overflow\"><a:noAutofit/></a:bodyPr><a:lstStyle/>\
         <a:p><a:pPr algn=\"{algn}\"/><a:r><a:rPr lang=\"zh-CN\" sz=\"{sz}\"{b}><a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill>\
         <a:latin typeface=\"{fam}\"/><a:ea typeface=\"{fam}\"/></a:rPr><a:t>{}</a:t></a:r></a:p></p:txBody></p:sp>",
        emu(x),
        emu(y),
        emu(w),
        emu(h),
        xml(text)
    ));
}

const NS: &str = "xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"";
const HEAD: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>";
const CLR_MAP: &str = "bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"";
const EMPTY_TREE: &str = "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\
     <p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>";
const REL_NS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL_T: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

fn slide_xml(shapes: &[ShapeOut], bg: f64) -> String {
    let mut body = String::new();
    for (i, s) in shapes.iter().enumerate() {
        let id = i + 2;
        match s {
            ShapeOut::Text { x, y, w, h, text, size, color, bold, family, center } => text_xml(&mut body, id, *x, *y, *w, *h, text, *size, color, *bold, family, *center),
            ShapeOut::Geom { x, y, w, h, segs, fill, stroke, stroke_w } => geom_xml(&mut body, id, *x, *y, *w, *h, segs, fill, stroke, *stroke_w),
        }
    }
    // 底色：白（没改过）不写，留给母版的 bg1
    let bg = if dolce_base::js::to_int32(bg) as u32 & 0xffffff == 0xffffff {
        String::new()
    } else {
        format!("<p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>", hex(bg))
    };
    format!("{HEAD}<p:sld {NS}><p:cSld>{bg}<p:spTree>{EMPTY_TREE}{body}</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping {CLR_MAP}/></p:clrMapOvr></p:sld>")
}

const THEME: &str = concat!(
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
    "<a:theme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" name=\"Office\"><a:themeElements>",
    "<a:clrScheme name=\"Office\"><a:dk1><a:sysClr val=\"windowText\" lastClr=\"000000\"/></a:dk1><a:lt1><a:sysClr val=\"window\" lastClr=\"FFFFFF\"/></a:lt1>",
    "<a:dk2><a:srgbClr val=\"44546A\"/></a:dk2><a:lt2><a:srgbClr val=\"E7E6E6\"/></a:lt2>",
    "<a:accent1><a:srgbClr val=\"4472C4\"/></a:accent1><a:accent2><a:srgbClr val=\"ED7D31\"/></a:accent2><a:accent3><a:srgbClr val=\"A5A5A5\"/></a:accent3>",
    "<a:accent4><a:srgbClr val=\"FFC000\"/></a:accent4><a:accent5><a:srgbClr val=\"5B9BD5\"/></a:accent5><a:accent6><a:srgbClr val=\"70AD47\"/></a:accent6>",
    "<a:hlink><a:srgbClr val=\"0563C1\"/></a:hlink><a:folHlink><a:srgbClr val=\"954F72\"/></a:folHlink></a:clrScheme>",
    "<a:fontScheme name=\"Office\"><a:majorFont><a:latin typeface=\"Calibri Light\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/></a:majorFont>",
    "<a:minorFont><a:latin typeface=\"Calibri\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/></a:minorFont></a:fontScheme>",
    "<a:fmtScheme name=\"Office\"><a:fillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:fillStyleLst>",
    "<a:lnStyleLst><a:ln w=\"6350\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln><a:ln w=\"12700\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln><a:ln w=\"19050\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln></a:lnStyleLst>",
    "<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>",
    "<a:bgFillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>",
    "</a:themeElements></a:theme>"
);

fn rels(items: &[(String, &str, String)]) -> String {
    let mut s = format!("{HEAD}<Relationships xmlns=\"{REL_NS}\">");
    for (id, ty, target) in items {
        s += &format!("<Relationship Id=\"{id}\" Type=\"{REL_T}/{ty}\" Target=\"{target}\"/>");
    }
    s + "</Relationships>"
}

/// 整副片子的部件（名, 内容），次序同 TS（zip 里也按这个次序）
fn deck(slides: Vec<String>, w: i64, h: i64) -> Vec<(String, String)> {
    let n = slides.len();
    let ct = "application/vnd.openxmlformats-officedocument.presentationml";
    let mut types = format!(
        "{HEAD}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
         <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
         <Default Extension=\"xml\" ContentType=\"application/xml\"/>\
         <Override PartName=\"/ppt/presentation.xml\" ContentType=\"{ct}.presentation.main+xml\"/>\
         <Override PartName=\"/ppt/slideMasters/slideMaster1.xml\" ContentType=\"{ct}.slideMaster+xml\"/>\
         <Override PartName=\"/ppt/slideLayouts/slideLayout1.xml\" ContentType=\"{ct}.slideLayout+xml\"/>\
         <Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/>"
    );
    for i in 1..=n {
        types += &format!("<Override PartName=\"/ppt/slides/slide{i}.xml\" ContentType=\"{ct}.slide+xml\"/>");
    }
    types += "</Types>";
    let mut files = vec![
        ("[Content_Types].xml".to_string(), types),
        ("_rels/.rels".into(), rels(&[("rId1".into(), "officeDocument", "ppt/presentation.xml".into())])),
    ];
    let ids: String = (0..n).map(|i| format!("<p:sldId id=\"{}\" r:id=\"rId{}\"/>", 256 + i, i + 2)).collect();
    files.push((
        "ppt/presentation.xml".into(),
        format!(
            "{HEAD}<p:presentation {NS}><p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst>\
             <p:sldIdLst>{ids}</p:sldIdLst><p:sldSz cx=\"{w}\" cy=\"{h}\"/><p:notesSz cx=\"{h}\" cy=\"{w}\"/></p:presentation>"
        ),
    ));
    let mut pr = vec![("rId1".to_string(), "slideMaster", "slideMasters/slideMaster1.xml".to_string())];
    pr.extend((0..n).map(|i| (format!("rId{}", i + 2), "slide", format!("slides/slide{}.xml", i + 1))));
    pr.push((format!("rId{}", n + 2), "theme", "theme/theme1.xml".into()));
    files.push(("ppt/_rels/presentation.xml.rels".into(), rels(&pr)));
    files.push(("ppt/theme/theme1.xml".into(), THEME.into()));
    files.push((
        "ppt/slideMasters/slideMaster1.xml".into(),
        format!(
            "{HEAD}<p:sldMaster {NS}><p:cSld><p:bg><p:bgRef idx=\"1001\"><a:schemeClr val=\"bg1\"/></p:bgRef></p:bg>\
             <p:spTree>{EMPTY_TREE}</p:spTree></p:cSld><p:clrMap {CLR_MAP}/>\
             <p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst>\
             <p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>"
        ),
    ));
    files.push((
        "ppt/slideMasters/_rels/slideMaster1.xml.rels".into(),
        rels(&[("rId1".into(), "slideLayout", "../slideLayouts/slideLayout1.xml".into()), ("rId2".into(), "theme", "../theme/theme1.xml".into())]),
    ));
    files.push((
        "ppt/slideLayouts/slideLayout1.xml".into(),
        format!(
            "{HEAD}<p:sldLayout {NS} type=\"blank\" preserve=\"1\"><p:cSld name=\"Blank\"><p:spTree>{EMPTY_TREE}</p:spTree></p:cSld>\
             <p:clrMapOvr><a:overrideClrMapping {CLR_MAP}/></p:clrMapOvr></p:sldLayout>"
        ),
    ));
    files.push(("ppt/slideLayouts/_rels/slideLayout1.xml.rels".into(), rels(&[("rId1".into(), "slideMaster", "../slideMasters/slideMaster1.xml".into())])));
    for (i, s) in slides.into_iter().enumerate() {
        files.push((format!("ppt/slides/slide{}.xml", i + 1), s));
        files.push((format!("ppt/slides/_rels/slide{}.xml.rels", i + 1), rels(&[("rId1".into(), "slideLayout", "../slideLayouts/slideLayout1.xml".into())])));
    }
    files
}

/// 最简 zip：每项 deflate、无 zip64（一份片子远不到 4 GB）；时间戳固定 1980-01-01，同样的料出同样的字节
pub fn zip(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in files {
        let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(data).expect("写内存");
        let comp = enc.finish().expect("写内存");
        let crc = crc32fast::hash(data);
        let off = out.len() as u32;
        let head = |sig: u32, central: bool| {
            let mut h = Vec::new();
            h.extend_from_slice(&sig.to_le_bytes());
            if central {
                h.extend_from_slice(&20u16.to_le_bytes()); // 写出版本
            }
            h.extend_from_slice(&20u16.to_le_bytes()); // 需要版本
            h.extend_from_slice(&0x0800u16.to_le_bytes()); // 名字是 UTF-8
            h.extend_from_slice(&8u16.to_le_bytes()); // deflate
            h.extend_from_slice(&0u16.to_le_bytes()); // 时间
            h.extend_from_slice(&0x21u16.to_le_bytes()); // 日期 1980-01-01
            h.extend_from_slice(&crc.to_le_bytes());
            h.extend_from_slice(&(comp.len() as u32).to_le_bytes());
            h.extend_from_slice(&(data.len() as u32).to_le_bytes());
            h.extend_from_slice(&(name.len() as u16).to_le_bytes());
            h.extend_from_slice(&0u16.to_le_bytes()); // 扩展长
            if central {
                h.extend_from_slice(&[0; 6]); // 注释长、盘号、内部属性
                h.extend_from_slice(&0u32.to_le_bytes()); // 外部属性
                h.extend_from_slice(&off.to_le_bytes());
            }
            h.extend_from_slice(name.as_bytes());
            h
        };
        out.extend(head(0x04034b50, false));
        out.extend_from_slice(&comp);
        central.extend(head(0x02014b50, true));
    }
    let cd_off = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x06054b50u32.to_le_bytes());
    out.extend_from_slice(&[0; 4]); // 盘号
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&cd_off.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

/// 各页的幻灯片 XML（对拍用：与 TS 逐页比）
pub fn slides(input: &PptxInput, bravura: &Face) -> Vec<String> {
    let metrics = input.metrics.iter().map(|m| ((m.font.family.clone(), m.font.size.to_bits(), m.font.bold, m.font.italic), (m.ascent, m.descent))).collect();
    let mut w = Walker { bravura, stack_gap: input.stack_gap, metrics, out: Vec::new() };
    input
        .pages
        .iter()
        .map(|p| {
            w.out.clear();
            if let Some(root) = &p.root {
                w.node(root, (0.0, 0.0));
            }
            slide_xml(&w.out, input.bg)
        })
        .collect()
}

/// 场景 → `.pptx` 字节
pub fn pptx(input: &PptxInput, bravura: &Face) -> Vec<u8> {
    let parts = deck(slides(input, bravura), emu(input.page_width), emu(input.page_height));
    zip(&parts.into_iter().map(|(k, v)| (k, v.into_bytes())).collect::<Vec<_>>())
}
