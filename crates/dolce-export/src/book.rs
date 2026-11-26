//! 成书：DrawList（`dolce_book::draw`）→ PDF，与书级量字（[`BookMeasure`] 的原生实现）。取代 dev 的
//! `pdfwrite.mjs` / `textmetrics.mjs` / `fontres.mjs`——**量字与落字读同一份字体、同一个挤压**（`compress_run` 半身档），
//! 折行拿的宽与画出来的宽才一致。
//!
//! 字体：BookStyle 的 `fonts`（`{family, file?, face?, mode?}`）逐个解析——给了文件读文件（`.ttc` 按 `face` 取子字体：
//! 序号，或全名先全等再包含），没给按族名在字体目录里找文件名（原样全名 → 去空格 → 首词，取最短路径），再不行按族名 /
//! PostScript 名问字体库。`mode: path` 的字体不嵌、画轮廓（Bravura 那类）。
//!
//! 角色 → 字体链：角色的主字体，后接同书其它字体（样式表里的书写顺序）；缺字顺链回退，再缺把半角 CJK 标点换全角等价字。
//!
//! 逐字笔位（`DrawText.align`）：
//! - `pen`：`xs` 就是笔位；
//! - `inkCenter`：把新字体的墨迹中心摆到原墨迹（`xs` + `ws`/2）上；
//! - 其余（连排：`left` / `center` / `right` / `outer`）：整段挤压后自然排，首字墨迹对 `xs[0]`；右 / 中对 `box`；
//!   自然宽与 `box` 宽差过 8% 时逐字摆（墨迹左缘对 `xs[i]`），绝不横向缩放。
//!
//! 搜索层：词类角色（歌词、标题、署名、注解、目录…）字距撑开过 5% 且含汉字的，叠一层紧排的不可见文字。

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use dolce_book::draw::{DrawItem, DrawPage, DrawText};
use dolce_book::measure::BookMeasure;
use dolce_engrave::text::cjkpunct::{code_points, compress_run, CompressMode, SlackLR};
use serde_json::Value;

use crate::fonts::{Face, FaceRef, FontBook, Ink, PdfFace};
use crate::pdf::{parse_d, rgb24, Canvas, DocInfo, GlyphRun, PageSource, PlacedGlyph, Report};

/// 半角 CJK 标点 → 全角等价（印刷字库常没有 U+FF61 这些码位）
const PUNCT_EQUIV: [(char, char); 7] = [('\u{ff61}', '。'), ('\u{ff62}', '「'), ('\u{ff63}', '」'), ('\u{ff64}', '、'), ('\u{ff65}', '・'), ('\u{ff0e}', '．'), ('\u{ff0c}', '，')];

/// 要叠搜索层的角色（「词」）；音符、和弦不要
const SEARCH_ROLES: [&str; 9] = ["lyric", "lyric2", "title", "credit", "story", "toc", "header", "sectionWord", "category"];

/// 按族名找文件的目录（macOS 的中文字体多散在 AssetsV2 下、路径带哈希）
fn font_dirs() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "windows") {
        v.push(PathBuf::from(std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into())).join("Fonts"));
        if let Ok(l) = std::env::var("LOCALAPPDATA") {
            v.push(PathBuf::from(l).join("Microsoft\\Windows\\Fonts"));
        }
    } else {
        v.extend(["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts"].map(PathBuf::from));
        if let Ok(h) = std::env::var("HOME") {
            v.push(PathBuf::from(&h).join("Library/Fonts"));
            v.push(PathBuf::from(&h).join(".local/share/fonts"));
        }
        v.extend(["/System/Library/AssetsV2", "/usr/share/fonts", "/usr/local/share/fonts"].map(PathBuf::from));
    }
    v
}

fn walk(dir: &Path, key: &str, hits: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            walk(&p, key, hits);
        } else if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
            let low = name.to_lowercase();
            if low.contains(key) && [".otf", ".ttf", ".ttc"].iter().any(|x| low.ends_with(x)) {
                hits.push(p);
            }
        }
    }
}

/// 族名 → 字体文件（文件名关键词：原样全名 → 去空格全名 → 首词；同一关键词取路径最短的）
pub fn find_font_file(family: &str) -> Option<PathBuf> {
    let mut keys: Vec<String> = vec![family.to_string(), family.split_whitespace().collect(), family.split_whitespace().next().unwrap_or("").to_string()];
    keys.retain(|k| !k.is_empty());
    keys.dedup();
    let dirs = font_dirs();
    for k in keys {
        let k = k.to_lowercase();
        for d in &dirs {
            let mut hits = Vec::new();
            walk(d, &k, &mut hits);
            if let Some(h) = hits.into_iter().min_by_key(|p| p.as_os_str().len()) {
                return Some(h);
            }
        }
    }
    None
}

/// 子字体全名（nameID 4）
fn full_name(data: &[u8], index: u32) -> Option<String> {
    let f = crate::fonts::ttf_parser::Face::parse(data, index).ok()?;
    let mut any = None;
    for n in f.names() {
        if n.name_id == crate::fonts::ttf_parser::name_id::FULL_NAME {
            if let Some(s) = n.to_string() {
                if n.language() == crate::fonts::ttf_parser::Language::English_UnitedStates {
                    return Some(s);
                }
                any.get_or_insert(s);
            }
        }
    }
    any
}

/// `face` 字段（序号或名字）→ 子字体序号
fn pick_index(data: &[u8], face: &Value) -> Result<u32, String> {
    let n = crate::fonts::ttf_parser::fonts_in_collection(data).unwrap_or(1);
    match face {
        Value::Null => Ok(0),
        Value::Number(x) => Ok(x.as_u64().unwrap_or(0) as u32),
        Value::String(s) => {
            if let Ok(i) = s.parse::<u32>() {
                return Ok(i);
            }
            let want = s.to_lowercase();
            let names: Vec<String> = (0..n).map(|i| full_name(data, i).unwrap_or_default().to_lowercase()).collect();
            names
                .iter()
                .position(|nm| *nm == want)
                .or_else(|| names.iter().position(|nm| nm.contains(&want)))
                .map(|i| i as u32)
                .ok_or_else(|| format!("字体集里没有 {s}：{}", names.join(" / ")))
        }
        _ => Ok(0),
    }
}

/// 成书的一个字体
pub struct BookFont {
    pub id: String,
    pub face: FaceRef,
    /// `mode: path`：画轮廓不嵌
    pub path_mode: bool,
    pub file: String,
}

/// 一个字在某一面里：单字整形出的字形、advance（em）、紧墨迹（em）
#[derive(Clone, Copy)]
struct CharInfo {
    gid: u16,
    adv: f64,
    ink: Option<Ink>,
}

/// 成书字体表 + 角色 → 主字体；兼书级量字
pub struct BookFonts {
    pub fonts: Vec<BookFont>,
    roles: HashMap<String, String>,
    /// 解析不到的字体：(id, 族名, 原因)
    pub missing: Vec<(String, String, String)>,
    chars: RefCell<HashMap<(usize, char), CharInfo>>,
}

impl BookFonts {
    /// BookStyle（`book_style_of` 的 JSON）→ 字体表。相对路径的 `file` 相对 `base`。
    pub fn resolve(style: &Value, book: &FontBook, base: &Path) -> BookFonts {
        let mut fonts = Vec::new();
        let mut missing = Vec::new();
        if let Some(m) = style.get("fonts").and_then(Value::as_object) {
            for (id, r) in m {
                let family = r.get("family").and_then(Value::as_str).unwrap_or("").to_string();
                let path_mode = r.get("mode").and_then(Value::as_str) == Some("path");
                match resolve_one(r, &family, book, base) {
                    Ok((face, file)) => {
                        if path_mode {
                            face.face.mark_outline_only();
                        }
                        fonts.push(BookFont { id: id.clone(), face, path_mode, file });
                    }
                    Err(e) => missing.push((id.clone(), family, e)),
                }
            }
        }
        let mut roles = HashMap::new();
        if let Some(m) = style.get("roles").and_then(Value::as_object) {
            for (role, d) in m {
                if let Some(f) = d.get("font").and_then(Value::as_str) {
                    roles.insert(role.clone(), f.to_string());
                }
            }
        }
        BookFonts { fonts, roles, missing, chars: RefCell::default() }
    }

    /// 角色的字体链（下标进 `fonts`）：主字体在前，其余照书写顺序
    fn chain(&self, role: &str) -> Vec<usize> {
        let main = self.roles.get(role).and_then(|id| self.fonts.iter().position(|f| &f.id == id));
        main.into_iter().chain((0..self.fonts.len()).filter(|&i| Some(i) != main)).collect()
    }

    /// 角色的主字体 id（样式表里写的，解析不到也照给）
    pub fn main_font_id(&self, role: &str) -> Option<&str> {
        self.roles.get(role).map(String::as_str)
    }

    fn info(&self, fi: usize, ch: char) -> CharInfo {
        if let Some(c) = self.chars.borrow().get(&(fi, ch)) {
            return *c;
        }
        let face = &self.fonts[fi].face.face;
        let mut b = [0u8; 4];
        let shaped = face.shape(ch.encode_utf8(&mut b), &[]);
        let gid = shaped.first().map_or(0, |g| g.gid);
        let c = CharInfo { gid, adv: shaped.iter().map(|g| g.x_advance).sum(), ink: face.tight_ink(gid) };
        self.chars.borrow_mut().insert((fi, ch), c);
        c
    }

    fn has(&self, fi: usize, ch: char) -> bool {
        self.fonts[fi].face.face.has(ch)
    }

    /// 量字口径的选字：链上第一个有这个字的，都没有退主字体（`textmetrics.mjs::fontFor`）
    fn measure_font(&self, role: &str, ch: char) -> Option<usize> {
        let chain = self.chain(role);
        chain.iter().copied().find(|&i| self.has(i, ch)).or(chain.first().copied())
    }

    /// 写出口径的选字：链上找，再找全角等价字；都没有为 None（记缺字）
    fn draw_font(&self, role: &str, ch: char) -> Option<(usize, char)> {
        let chain = self.chain(role);
        let equiv = PUNCT_EQUIV.iter().find(|(a, _)| *a == ch).map(|(_, b)| *b);
        for cand in std::iter::once(ch).chain(equiv) {
            if let Some(i) = chain.iter().copied().find(|&i| self.has(i, cand)) {
                return Some((i, cand));
            }
        }
        None
    }

    fn raw_advance(&self, fi: Option<usize>, ch: char, size: f64) -> f64 {
        fi.map_or(0.0, |i| self.info(i, ch).adv * size)
    }

    /// 墨迹（pt，相对笔位、y 向下）
    fn ink(&self, fi: Option<usize>, ch: char, size: f64) -> Option<Ink> {
        let i = self.info(fi?, ch).ink?;
        Some(Ink { left: i.left * size, top: i.top * size, right: i.right * size, bottom: i.bottom * size })
    }

    /// 一段字挤压后的逐字笔位与总宽（`textmetrics.mjs::run`；半身档，挤压量受实际留白封顶）
    fn run(&self, role: &str, chars: &[&str], size: f64) -> (Vec<f64>, f64) {
        let first = |s: &str| s.chars().next().unwrap_or(' ');
        let adv = |s: &str| {
            let c = first(s);
            self.raw_advance(self.measure_font(role, c), c, size)
        };
        let slack = |s: &str| {
            let c = first(s);
            let fi = self.measure_font(role, c);
            match self.ink(fi, c, size) {
                Some(b) => SlackLR { left: b.left, right: self.raw_advance(fi, c, size) - b.right },
                None => SlackLR { left: 0.0, right: 0.0 },
            }
        };
        compress_run(chars, &adv, size, CompressMode::Halfwidth, Some(&slack))
    }
}

impl BookMeasure for BookFonts {
    fn advance(&self, role: &str, text: &str, size: f64) -> f64 {
        self.run(role, &code_points(text), size).1
    }
    fn ink_ratio(&self, role: &str, sample: &str) -> f64 {
        let Some(c) = sample.chars().next() else { return f64::NAN };
        match self.ink(self.measure_font(role, c), c, 1.0) {
            Some(b) => b.bottom - b.top,
            None => f64::NAN,
        }
    }
}

fn resolve_one(r: &Value, family: &str, book: &FontBook, base: &Path) -> Result<(FaceRef, String), String> {
    let file = r.get("file").and_then(Value::as_str).map(|f| {
        let p = PathBuf::from(f);
        if p.is_absolute() {
            p
        } else {
            base.join(p)
        }
    });
    let file = file.filter(|p| p.is_file()).or_else(|| find_font_file(family));
    if let Some(path) = file {
        let data = book.file_bytes(&path).map_err(|e| format!("读不了 {}：{e}", path.display()))?;
        let index = pick_index(&data, r.get("face").unwrap_or(&Value::Null))?;
        let key = format!("{}#{index}", path.display());
        let face = Face::parse(data, index, key).ok_or_else(|| format!("{} 不是字体", path.display()))?;
        let face = book.adopt(face);
        return Ok((FaceRef { face, synth_bold: false, synth_italic: false }, path.display().to_string()));
    }
    let f = book.find(family, false, false).ok_or_else(|| "找不到字体文件".to_string())?;
    let key = f.face.key.clone();
    Ok((FaceRef { face: f.face, synth_bold: false, synth_italic: false }, key))
}

/// 一本书（DrawList 页）
pub struct BookDoc<'a> {
    pub fonts: &'a BookFonts,
    pub pages: &'a [DrawPage],
    /// 叠搜索层（缺省开）
    pub search_layer: bool,
}

impl PageSource for BookDoc<'_> {
    fn page_count(&self) -> usize {
        self.pages.len()
    }
    fn page_size(&self, i: usize) -> (f64, f64) {
        (self.pages[i].w, self.pages[i].h)
    }
    fn draw(&self, i: usize, c: &mut Canvas) {
        for it in &self.pages[i].items {
            match it {
                DrawItem::Rect(r) => c.rect(r.x, r.y, r.w, r.h, Some((rgb24(r.fill.unwrap_or(0)), 1.0)), None),
                DrawItem::Line(l) => c.line(l.x1, l.y1, l.x2, l.y2, l.sw, rgb24(l.color.unwrap_or(0)), 1.0),
                DrawItem::Path(p) => {
                    let col = rgb24(p.fill.or(p.stroke).unwrap_or(0));
                    let segs = parse_d(&p.d);
                    c.path(&segs, p.fill.map(|_| (col, 1.0)), p.stroke.map(|_| (col, 1.0, p.sw.unwrap_or(0.0))));
                }
                DrawItem::Text(t) => self.text(t, c),
            }
        }
    }
}

impl BookDoc<'_> {
    fn text(&self, it: &DrawText, c: &mut Canvas) {
        let f = self.fonts;
        let chars: Vec<char> = it.text.chars().collect();
        let Some(main) = f.chain(&it.role).first().copied() else { return };
        let size = it.size;
        let y = it.y + it.dy.unwrap_or(0.0);
        let xs = |i: usize| it.xs.get(i).copied().unwrap_or(0.0);
        let draw_or_main = |ch: char| f.draw_font(&it.role, ch).map_or(main, |(i, _)| i);

        let pens: Vec<f64> = match it.align.as_str() {
            "pen" => (0..chars.len()).map(|i| it.xs.get(i).or(it.xs.first()).copied().unwrap_or(0.0)).collect(),
            "inkCenter" => chars
                .iter()
                .enumerate()
                .map(|(i, &ch)| {
                    let x0 = xs(i);
                    let w = it.ws.as_ref().and_then(|ws| ws.get(i)).copied().unwrap_or(0.0);
                    match f.ink(Some(draw_or_main(ch)), ch, size) {
                        Some(b) => x0 + w / 2.0 - (b.left + (b.right - b.left) / 2.0),
                        None => x0,
                    }
                })
                .collect(),
            _ => {
                // 连排：与量字同一个挤压（书级正文折行就拿它算的）
                let adv = |s: &str| {
                    let ch = s.chars().next().unwrap_or(' ');
                    f.raw_advance(Some(draw_or_main(ch)), ch, size)
                };
                let slack = |s: &str| {
                    let ch = s.chars().next().unwrap_or(' ');
                    let fi = Some(draw_or_main(ch));
                    match f.ink(fi, ch, size) {
                        Some(b) => SlackLR { left: b.left, right: f.raw_advance(fi, ch, size) - b.right },
                        None => SlackLR { left: 0.0, right: 0.0 },
                    }
                };
                let cps = code_points(&it.text);
                let (cxs, natural) = compress_run(&cps, &adv, size, CompressMode::Halfwidth, Some(&slack));
                let box_w = it.ink_box.map_or(natural, |b| b.w);
                let lead = f.ink(Some(main), chars.first().copied().unwrap_or(' '), size).map_or(0.0, |b| b.left) + cxs.first().copied().unwrap_or(0.0);
                let mut x = xs(0) - lead;
                match it.align.as_str() {
                    "right" | "outer" => x = it.ink_box.map_or(x, |b| b.x + box_w) - natural,
                    "center" => x = it.ink_box.map_or(x, |b| b.x + box_w / 2.0) - natural / 2.0,
                    _ => {}
                }
                if box_w > 0.0 && (natural - box_w).abs() / box_w > 0.08 {
                    chars.iter().enumerate().map(|(i, &ch)| xs(i) - f.ink(Some(draw_or_main(ch)), ch, size).map_or(0.0, |b| b.left)).collect()
                } else {
                    cxs.iter().map(|dx| x + dx).collect()
                }
            }
        };

        // 字形串：同一字体面连成一串（空白断开）
        let color = rgb24(it.color.unwrap_or(0));
        let mut byte = 0usize;
        let mut run: Vec<PlacedGlyph> = Vec::new();
        let mut run_font: Option<usize> = None;
        let flush = |run: &mut Vec<PlacedGlyph>, fi: Option<usize>, c: &mut Canvas| {
            if let (Some(fi), false) = (fi, run.is_empty()) {
                c.glyphs(&GlyphRun { font: &f.fonts[fi].face, glyphs: run, text: &it.text, y, size, color, alpha: 1.0 });
            }
            run.clear();
        };
        for (k, &ch) in chars.iter().enumerate() {
            let b0 = byte;
            byte += ch.len_utf8();
            if ch.is_whitespace() {
                flush(&mut run, run_font, c);
                run_font = None;
                continue;
            }
            let Some((fi, shown)) = f.draw_font(&it.role, ch) else {
                c.report.missing.push((c.page, it.role.clone(), ch.to_string()));
                continue;
            };
            if shown != ch {
                let key = (it.role.clone(), ch.to_string(), shown.to_string());
                if !c.report.fallbacks.contains(&key) {
                    c.report.fallbacks.push(key);
                }
            } else if fi != main {
                let key = (it.role.clone(), ch.to_string(), f.fonts[fi].id.clone());
                if !c.report.fallbacks.contains(&key) {
                    c.report.fallbacks.push(key);
                }
            }
            if run_font != Some(fi) {
                flush(&mut run, run_font, c);
                run_font = Some(fi);
            }
            let info = f.info(fi, shown);
            run.push(PlacedGlyph { gid: info.gid, x: pens[k], x_offset: 0.0, y_offset: 0.0, range: b0..byte });
        }
        flush(&mut run, run_font, c);

        // 搜索层：字距撑开的汉字词（转曲的面在 `Canvas::glyphs` 里已叠过）
        if self.search_layer && SEARCH_ROLES.contains(&it.role.as_str()) {
            let body: String = chars.iter().filter(|c| !c.is_whitespace()).collect();
            let main_ref = &f.fonts[main].face;
            if body.chars().count() > 1 && body.chars().any(|ch| ch as u32 > 0x2e7f) && main_ref.face.embeddable() {
                let spread = if pens.len() > 1 { pens[pens.len() - 1] - pens[0] } else { 0.0 };
                let natural = main_ref.face.shaped_width(&body, &[]) * size;
                if spread > natural * 1.05 {
                    c.hidden_text(&body, pens[0], y, size, main_ref);
                }
            }
        }
    }
}

/// 字体表里第一个能嵌、有汉字的面：转曲行的不可见文字层用它
pub fn search_face(fonts: &BookFonts) -> Option<FaceRef> {
    fonts.fonts.iter().map(|f| &f.face).find(|f| f.face.has('一') && f.face.embeddable()).cloned()
}

/// 整本写出
pub fn book_pdf(book: &FontBook, fonts: &BookFonts, pages: &[DrawPage], info: &DocInfo) -> Result<(Vec<u8>, Report), String> {
    let doc = BookDoc { fonts, pages, search_layer: true };
    crate::pdf::write_pdf(book, &doc, info, search_face(fonts))
}
