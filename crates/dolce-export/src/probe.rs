//! 字体样本验证（L7 第一步）：拿几类难嵌的字体各写一页 PDF，查定位、子字体、轮廓种类、可变、AAT、合成粗斜与能不能嵌。
//! 命令行 `dolce font-probe` 再用 PDFium 把每页读回来，核对文字层（可搜）与墨迹（画出来了）。

use std::sync::Arc;

use serde::Serialize;

use crate::fonts::{FaceRef, FontBook, Outlines};
use crate::pdf::{Canvas, DocInfo, GlyphRun, PageSource, PlacedGlyph, Report};

/// 一个样本：族名、粗斜、要画的字
#[derive(Clone, Debug)]
pub struct Sample {
    pub family: String,
    pub bold: bool,
    pub italic: bool,
    pub text: String,
}

impl Sample {
    pub fn new(family: &str, bold: bool, italic: bool, text: &str) -> Sample {
        Sample { family: family.into(), bold, italic, text: text.into() }
    }
}

/// 缺省样本：本机常见的几类（系统 .ttc 中文、AAT 楷体、CFF 宋体、可变字体、Times 斜体、只有常规体的族要合成粗斜、SMuFL）
pub fn default_samples() -> Vec<Sample> {
    let zh = "神配受崇拜，哈利路亚！1=C 4/4";
    vec![
        Sample::new("PingFang SC", false, false, zh),
        Sample::new("PingFang SC", true, false, zh),
        Sample::new("Songti SC", false, false, zh),
        Sample::new("STKaiti", false, false, "「主，你是我的力量。」"),
        Sample::new("Kaiti SC", false, false, "「主，你是我的力量。」"),
        Sample::new("Hiragino Sans GB", false, false, zh),
        Sample::new("Weibei SC", true, false, zh),
        Sample::new("Heiti SC", false, true, zh),
        Sample::new("Times New Roman", false, true, "Holy, holy, holy! Lord God Almighty"),
        Sample::new("Times", true, false, "Holy, holy, holy!"),
        Sample::new("Helvetica", false, false, "Words: R. Heber"),
        Sample::new("New York", false, false, "Variable 123 Holy"),
        Sample::new("New York", true, true, "Variable 123 Holy"),
        Sample::new("SF Compact", false, false, "Variable 123"),
        Sample::new("SF India", false, false, "\u{0915}\u{093f} 123"),
        Sample::new(".SF India", false, false, "\u{0915}\u{093f} 123"),
        Sample::new("Microsoft YaHei", false, false, zh),
        Sample::new("SimSun", false, false, zh),
        Sample::new("Bravura", false, false, "\u{e050}\u{e062}\u{e0a4}\u{e260}\u{e262}"),
        Sample::new("Bravura Text", false, false, "\u{e050}\u{e0a4}"),
    ]
}

/// 一行结果
#[derive(Debug, Serialize)]
pub struct ProbeRow {
    pub family: String,
    pub bold: bool,
    pub italic: bool,
    pub found: bool,
    pub key: String,
    pub ps_name: String,
    pub weight: u16,
    pub outlines: Option<Outlines>,
    pub variable: bool,
    pub aat: bool,
    pub synth_bold: bool,
    pub synth_italic: bool,
    pub embeddable: bool,
    /// 样本里这一面没有的字
    pub missing: String,
    /// AAT 横排时竖排替换没关掉（整形出的字形与 cmap 的不同）的字
    pub vert_subst: String,
    /// 这一页画的字（PDF 读回来要对得上）
    pub text: String,
}

struct ProbeDoc<'a> {
    rows: &'a [(Sample, Option<FaceRef>)],
}

impl PageSource for ProbeDoc<'_> {
    fn page_count(&self) -> usize {
        self.rows.len()
    }
    fn page_size(&self, _: usize) -> (f64, f64) {
        (420.0, 60.0)
    }
    fn draw(&self, i: usize, c: &mut Canvas) {
        let (s, f) = &self.rows[i];
        let Some(f) = f else { return };
        let size = 18.0;
        let mut x = 10.0;
        let mut glyphs = Vec::new();
        let text = present(f, &s.text);
        let shaped = f.face.shape(&text, &[]);
        for (k, g) in shaped.iter().enumerate() {
            let end = shaped[k + 1..].iter().map(|n| n.cluster).find(|&cl| cl > g.cluster).unwrap_or(text.len());
            glyphs.push(PlacedGlyph { gid: g.gid, x, x_offset: g.x_offset, y_offset: g.y_offset, range: g.cluster..end });
            x += g.x_advance * size;
        }
        c.glyphs(&GlyphRun { font: f, glyphs: &glyphs, text: &text, y: 40.0, size, color: krilla::color::rgb::Color::black(), alpha: 1.0 });
    }
}

/// 样本里这一面有的字（缺的不画，免得画成 .notdef）
fn present(f: &FaceRef, text: &str) -> String {
    text.chars().filter(|&c| c.is_whitespace() || f.face.has(c)).collect()
}

/// 跑样本：每个样本一页（找不到的族空页），返回各行与 PDF
/// `force_outline`：把样本面都记成转曲（验证转曲 + 不可见文字层那条退路）
pub fn run(book: &FontBook, samples: &[Sample], force_outline: bool) -> Result<(Vec<ProbeRow>, Vec<u8>, Report), String> {
    let rows: Vec<(Sample, Option<FaceRef>)> = samples.iter().map(|s| (s.clone(), book.find(&s.family, s.bold, s.italic))).collect();
    let search = crate::scene::search_face(book);
    if force_outline {
        for f in rows.iter().filter_map(|(_, f)| f.as_ref()) {
            if search.as_ref().is_none_or(|s| !Arc::ptr_eq(&s.face, &f.face)) {
                f.face.mark_outline_only();
            }
        }
    }
    let mut out = Vec::new();
    for (s, f) in &rows {
        let mut r = ProbeRow {
            family: s.family.clone(),
            bold: s.bold,
            italic: s.italic,
            found: f.is_some(),
            key: String::new(),
            ps_name: String::new(),
            weight: 0,
            outlines: None,
            variable: false,
            aat: false,
            synth_bold: false,
            synth_italic: false,
            embeddable: false,
            missing: String::new(),
            vert_subst: String::new(),
            text: s.text.clone(),
        };
        if let Some(f) = f {
            let face = &f.face;
            r.key = face.key.clone();
            r.ps_name = face.ps_name.clone();
            r.weight = face.weight;
            r.outlines = Some(face.outlines);
            r.variable = face.variable;
            r.aat = face.aat;
            r.synth_bold = f.synth_bold;
            r.synth_italic = f.synth_italic;
            r.embeddable = face.embeddable();
            r.missing = s.text.chars().filter(|c| !c.is_whitespace() && !face.has(*c)).collect();
            r.text = present(f, &s.text);
            for ch in s.text.chars() {
                let Some(g) = face.glyph(ch) else { continue };
                let mut b = [0u8; 4];
                let shaped = face.shape(ch.encode_utf8(&mut b), &[]);
                if shaped.len() == 1 && shaped[0].gid != g {
                    r.vert_subst.push(ch);
                }
            }
        }
        out.push(r);
    }
    let (bytes, report) = crate::pdf::write_pdf(book, &ProbeDoc { rows: &rows }, &DocInfo { title: Some("font-probe".into()), outline: Vec::new() }, search)?;
    Ok((out, bytes, report))
}
