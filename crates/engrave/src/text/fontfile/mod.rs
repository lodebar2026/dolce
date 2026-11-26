//! 字体文件这一层（fontdb + rustybuzz）：定位（系统字体目录 / 宿主给的字节）、解析（.ttc 子字体、TrueType / CFF / CFF2、可变字体）、
//! 整形与字形度量、紧墨迹盒、轮廓、合成粗斜的判定、族串的逐字回退。
//!
//! 导出（`dolce-layout::export::fonts`，PDF 选字体、嵌入、转曲）与 Linux 的系统量字（`native::linux`）共用这一份。
//! 一份 [`FontBook`] 是一个 fontdb 库加字节缓存：桌面 / 命令行装系统字体（`fontfile-system` 特性），
//! wasm 只装宿主给的字节。族名的展开（泛称、标准字体）与量字同一份（[`crate::text::css_families`]）。
//!
//! **Linux 选字照 Chromium**（[`fc`]）：有 fontconfig 时族名匹配与缺字回退都问它（度量兼容替身、用户配置都跟得上），
//! 只把注册的字体文件（Bravura 等）留在 fontdb 里先查；没有 fontconfig 时退回 fontdb 扫目录，族名查不到再试 [`LINUX_ALIASES`]。
//!
//! `fontfile` 特性才编；不开时本 crate 没有这些依赖。

use std::any::Any;
use std::cell::{OnceCell, RefCell};
use std::collections::HashMap;
use std::sync::Arc;

pub use rustybuzz::ttf_parser;

use serde::Serialize;

use crate::text::Platform;

#[cfg(all(target_os = "linux", feature = "fontfile-system"))]
pub mod fc;

/// fontconfig 缺字回退的语言：排版的页面是中文页面（`lang="zh-CN"`），同浏览器口径层的泛称
#[cfg(all(target_os = "linux", feature = "fontfile-system"))]
const FALLBACK_LANG: &str = "zh-cn";

/// Linux 上没有 fontconfig 时族名的替身（fontconfig 配置里常见的那几条：Chromium 泛称缺省名 → 装得最多的度量兼容字体）
pub const LINUX_ALIASES: &[(&str, &[&str])] = &[
    ("Arial", &["Liberation Sans", "Arimo"]),
    ("Helvetica", &["Liberation Sans", "Arimo"]),
    ("Times New Roman", &["Liberation Serif", "Tinos"]),
    ("Times", &["Liberation Serif", "Tinos"]),
    ("Courier New", &["Liberation Mono", "Cousine"]),
    ("Courier", &["Liberation Mono", "Cousine"]),
    ("monospace", &["DejaVu Sans Mono", "Liberation Mono", "Noto Sans Mono"]),
    // 中文页面的泛称（见 `fc` 模块注释）
    ("sans-serif", &["Noto Sans CJK SC", "WenQuanYi Zen Hei", "WenQuanYi Micro Hei", "Source Han Sans SC", "DejaVu Sans"]),
    ("serif", &["Noto Serif CJK SC", "Source Han Serif SC", "AR PL UMing CN", "Noto Sans CJK SC", "DejaVu Serif"]),
    ("Sans", &["DejaVu Sans", "Liberation Sans", "Noto Sans"]),
    ("Serif", &["DejaVu Serif", "Liberation Serif", "Noto Serif"]),
];

/// 字形轮廓的种类（嵌入能力看它）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Outlines {
    TrueType,
    Cff,
    Cff2,
    /// 只有位图（sbix / CBDT）或 SVG 字形
    Bitmap,
}

/// 一个字体面（`.ttc` 里的一个子字体）。字节共享。
pub struct Face {
    pub data: Arc<Vec<u8>>,
    pub index: u32,
    /// 来源（`路径#序号`，宿主给的字节是宿主起的名）
    pub key: String,
    pub family: String,
    pub ps_name: String,
    pub weight: u16,
    /// 粗体标记：OS/2 fsSelection 的粗体位，或英文子族名是粗体（有的粗体字体粗细写的是 400、标记位也不设，如 WeibeiSC-Bold）
    pub bold_flag: bool,
    pub italic: bool,
    pub upem: f64,
    /// hhea 的上下沿（em，上正下负）
    pub ascent: f64,
    pub descent: f64,
    pub outlines: Outlines,
    pub variable: bool,
    /// 有 `morx`（AAT 整形）
    pub aat: bool,
    /// 可变字体取的实例（轴, 值）；空 = 缺省实例
    pub coords: Vec<([u8; 4], f32)>,
    /// 下游挂在这个面上的缓存（导出的 PDF 字体对象与嵌入判定），本层不碰
    pub ext: OnceCell<Box<dyn Any>>,
}

/// 整形出的一个字形（em 单位；`cluster` 是原串的字节起点）。
#[derive(Clone, Copy, Debug)]
pub struct Shaped {
    pub gid: u16,
    pub cluster: usize,
    pub x_advance: f64,
    pub x_offset: f64,
    pub y_offset: f64,
}

/// 墨迹盒（em，y 向下：`top` 是上缘、负数在基线上方）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ink {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

impl Face {
    /// 从字节解析一个子字体。解析不了（不是字体、序号越界）返回 None。
    pub fn parse(data: Arc<Vec<u8>>, index: u32, key: String) -> Option<Face> {
        let f = ttf_parser::Face::parse(&data, index).ok()?;
        let family = name_of(&f, &[ttf_parser::name_id::TYPOGRAPHIC_FAMILY, ttf_parser::name_id::FAMILY]).unwrap_or_default();
        let ps_name = name_of(&f, &[ttf_parser::name_id::POST_SCRIPT_NAME]).unwrap_or_default();
        let tables = f.tables();
        let outlines = if tables.glyf.is_some() {
            Outlines::TrueType
        } else if tables.cff.is_some() {
            Outlines::Cff
        } else if f.raw_face().table(ttf_parser::Tag::from_bytes(b"CFF2")).is_some() {
            Outlines::Cff2
        } else {
            Outlines::Bitmap
        };
        let upem = f.units_per_em() as f64;
        let face = Face {
            index,
            key,
            family,
            ps_name,
            weight: f.weight().to_number(),
            bold_flag: f.is_bold() || name_of(&f, &[ttf_parser::name_id::TYPOGRAPHIC_SUBFAMILY, ttf_parser::name_id::SUBFAMILY]).is_some_and(|n| ["bold", "heavy", "black", "semibold", "demibold"].iter().any(|w| n.to_lowercase().contains(w))),
            italic: f.is_italic() || f.is_oblique(),
            upem,
            ascent: f.ascender() as f64 / upem,
            descent: f.descender() as f64 / upem,
            outlines,
            variable: f.is_variable(),
            aat: f.raw_face().table(ttf_parser::Tag::from_bytes(b"morx")).is_some(),
            coords: Vec::new(),
            ext: OnceCell::new(),
            data: data.clone(),
        };
        Some(face)
    }

    pub fn ttf(&self) -> ttf_parser::Face<'_> {
        let mut f = ttf_parser::Face::parse(&self.data, self.index).expect("建 Face 时解析过");
        for (t, v) in &self.coords {
            f.set_variation(ttf_parser::Tag::from_bytes(t), *v);
        }
        f
    }

    /// 可变字体的轴（标签, 最小, 缺省, 最大）
    pub fn axes(&self) -> Vec<([u8; 4], f32, f32, f32)> {
        self.ttf().variation_axes().into_iter().map(|a| (a.tag.to_bytes(), a.min_value, a.def_value, a.max_value)).collect()
    }

    /// 取可变字体的一个实例（字重 / 斜体按轴设，轴外的不动）。字重设在 wght 轴上，`ital` / `slnt` 管斜体。
    pub fn instance(&self, weight: f32, italic: bool) -> Option<Face> {
        let axes = self.axes();
        let mut coords = Vec::new();
        for (tag, min, _def, max) in &axes {
            match tag {
                // 老 GX 字体（Skia）的 wght 不是 CSS 刻度（0.48~3.2），不按字重取
                b"wght" if *max >= 100.0 => coords.push((*tag, weight.clamp(*min, *max))),
                b"ital" if italic => coords.push((*tag, max.min(1.0))),
                b"slnt" if italic => coords.push((*tag, min.max(-12.0))),
                _ => {}
            }
        }
        if coords.is_empty() {
            return None;
        }
        let mut f = Face::parse(self.data.clone(), self.index, format!("{}@{}", self.key, coords.iter().map(|(t, v)| format!("{}={v}", String::from_utf8_lossy(t))).collect::<Vec<_>>().join(",")))?;
        f.weight = coords.iter().find(|(t, _)| t == b"wght").map_or(f.weight, |(_, v)| *v as u16);
        f.italic = f.italic || coords.iter().any(|(t, _)| t == b"ital" || t == b"slnt");
        f.coords = coords;
        Some(f)
    }

    pub fn glyph(&self, ch: char) -> Option<u16> {
        self.ttf().glyph_index(ch).map(|g| g.0).filter(|&g| g != 0)
    }

    pub fn has(&self, ch: char) -> bool {
        self.glyph(ch).is_some()
    }

    /// 字形的 advance（em）
    pub fn advance(&self, gid: u16) -> f64 {
        self.ttf().glyph_hor_advance(ttf_parser::GlyphId(gid)).unwrap_or(0) as f64 / self.upem
    }

    /// 字形墨迹盒（em，y 向下）；空字形（空格）为 None
    pub fn ink(&self, gid: u16) -> Option<Ink> {
        let b = self.ttf().glyph_bounding_box(ttf_parser::GlyphId(gid))?;
        let u = self.upem;
        Some(Ink { left: b.x_min as f64 / u, top: -(b.y_max as f64) / u, right: b.x_max as f64 / u, bottom: -(b.y_min as f64) / u })
    }

    /// 字形墨迹的**紧**包围盒（em，y 向下）：按轮廓算、曲线取极值（`glyf` 头里记的是控制点盒，曲线外凸时偏大；
    /// 成书写出端照 fontkit `glyph.bbox` 的口径用这个）。空字形为 None
    pub fn tight_ink(&self, gid: u16) -> Option<Ink> {
        let segs = self.outline(gid, 1.0);
        let (mut l, mut t, mut r, mut b) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        let mut add = |x: f64, y: f64| {
            l = l.min(x);
            r = r.max(x);
            t = t.min(y);
            b = b.max(y);
        };
        let mut cur = (0.0, 0.0);
        for (op, p) in &segs {
            match op {
                'M' | 'L' => {
                    add(p[0], p[1]);
                    cur = (p[0], p[1]);
                }
                'C' => {
                    let (x0, y0) = cur;
                    let (x3, y3) = (p[4], p[5]);
                    add(x3, y3);
                    let mut ts = cubic_extrema(x0, p[0], p[2], x3);
                    ts.extend(cubic_extrema(y0, p[1], p[3], y3));
                    for tt in ts {
                        add(bez(x0, p[0], p[2], x3, tt), bez(y0, p[1], p[3], y3, tt));
                    }
                    cur = (x3, y3);
                }
                _ => {}
            }
        }
        l.is_finite().then_some(Ink { left: l, top: t, right: r, bottom: b })
    }

    /// 整形（横排、缺省特性外加 `features`，如 `halt`；前缀 `-` 的是关掉，如 `-kern`）。AAT 字体关掉竖排替换：morx 的缺省开关里常开着它，
    /// 系统排版器横排时自己关（`pdfwrite.mjs::horizontalFontkit` 同一个毛病）。
    pub fn shape(&self, text: &str, features: &[&str]) -> Vec<Shaped> {
        self.shape_lang(text, features, "")
    }

    /// 同 [`Face::shape`]，带语言（BCP 47，如 `zh-cn`；空串不带）。语言改 `locl` 等的替换：
    /// Noto CJK 不带语言时「a 1」里的「1」换成另一个字形（宽 550 而不是 471），浏览器整形时带页面语言。
    pub fn shape_lang(&self, text: &str, features: &[&str], lang: &str) -> Vec<Shaped> {
        let Some(mut face) = rustybuzz::Face::from_slice(&self.data, self.index) else { return Vec::new() };
        if !self.coords.is_empty() {
            let v: Vec<rustybuzz::Variation> = self.coords.iter().map(|(t, v)| rustybuzz::Variation { tag: ttf_parser::Tag::from_bytes(t), value: *v }).collect();
            face.set_variations(&v);
        }
        let mut buf = rustybuzz::UnicodeBuffer::new();
        buf.push_str(text);
        buf.set_direction(rustybuzz::Direction::LeftToRight);
        if let Ok(l) = lang.parse::<rustybuzz::Language>() {
            if !lang.is_empty() {
                buf.set_language(l);
            }
        }
        let mut feats: Vec<rustybuzz::Feature> = features
            .iter()
            .filter_map(|f| {
                let (tag, on) = match f.strip_prefix('-') {
                    Some(t) => (t, 0),
                    None => (*f, 1),
                };
                tag.as_bytes().try_into().ok().map(|t: [u8; 4]| rustybuzz::Feature::new(ttf_parser::Tag::from_bytes(&t), on, ..))
            })
            .collect();
        if self.aat {
            feats.push(rustybuzz::Feature::new(ttf_parser::Tag::from_bytes(b"vert"), 0, ..));
        }
        let out = rustybuzz::shape(&face, &feats, buf);
        let u = self.upem;
        out.glyph_infos()
            .iter()
            .zip(out.glyph_positions())
            .map(|(i, p)| Shaped {
                gid: i.glyph_id as u16,
                cluster: i.cluster as usize,
                x_advance: p.x_advance as f64 / u,
                x_offset: p.x_offset as f64 / u,
                y_offset: p.y_offset as f64 / u,
            })
            .collect()
    }

    /// 一串字整形后的总宽（em）
    pub fn shaped_width(&self, text: &str, features: &[&str]) -> f64 {
        self.shape(text, features).iter().map(|g| g.x_advance).sum()
    }

    /// 字形轮廓（字号 `size`，落笔点在原点、基线 y = 0、向下为正；二次曲线升成三次）
    pub fn outline(&self, gid: u16, size: f64) -> Vec<(char, Vec<f64>)> {
        let mut b = OutlineSink { s: size / self.upem, segs: Vec::new(), last: (0.0, 0.0) };
        self.ttf().outline_glyph(ttf_parser::GlyphId(gid), &mut b);
        b.segs
    }
}

fn bez(a0: f64, a1: f64, a2: f64, a3: f64, t: f64) -> f64 {
    let u = 1.0 - t;
    u * u * u * a0 + 3.0 * u * u * t * a1 + 3.0 * u * t * t * a2 + t * t * t * a3
}

/// 三次贝塞尔一维导数的零点（0 < t < 1）
fn cubic_extrema(a0: f64, a1: f64, a2: f64, a3: f64) -> Vec<f64> {
    let (a, b, c) = (-a0 + 3.0 * a1 - 3.0 * a2 + a3, 2.0 * (a0 - 2.0 * a1 + a2), a1 - a0);
    let mut out = Vec::new();
    if a.abs() < 1e-12 {
        if b.abs() > 1e-12 {
            out.push(-c / b);
        }
    } else {
        let d = b * b - 4.0 * a * c;
        if d >= 0.0 {
            let sq = d.sqrt();
            out.push((-b + sq) / (2.0 * a));
            out.push((-b - sq) / (2.0 * a));
        }
    }
    out.retain(|t| *t > 0.0 && *t < 1.0);
    out
}

struct OutlineSink {
    s: f64,
    segs: Vec<(char, Vec<f64>)>,
    last: (f64, f64),
}

impl ttf_parser::OutlineBuilder for OutlineSink {
    fn move_to(&mut self, x: f32, y: f32) {
        let p = (x as f64 * self.s, -(y as f64) * self.s);
        self.segs.push(('M', vec![p.0, p.1]));
        self.last = p;
    }
    fn line_to(&mut self, x: f32, y: f32) {
        let p = (x as f64 * self.s, -(y as f64) * self.s);
        self.segs.push(('L', vec![p.0, p.1]));
        self.last = p;
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let q = (x1 as f64 * self.s, -(y1 as f64) * self.s);
        let p = (x as f64 * self.s, -(y as f64) * self.s);
        let (x0, y0) = self.last;
        let c1 = (x0 + 2.0 / 3.0 * (q.0 - x0), y0 + 2.0 / 3.0 * (q.1 - y0));
        let c2 = (p.0 + 2.0 / 3.0 * (q.0 - p.0), p.1 + 2.0 / 3.0 * (q.1 - p.1));
        self.segs.push(('C', vec![c1.0, c1.1, c2.0, c2.1, p.0, p.1]));
        self.last = p;
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let s = self.s;
        let p = (x as f64 * s, -(y as f64) * s);
        self.segs.push(('C', vec![x1 as f64 * s, -(y1 as f64) * s, x2 as f64 * s, -(y2 as f64) * s, p.0, p.1]));
        self.last = p;
    }
    fn close(&mut self) {
        self.segs.push(('Z', Vec::new()));
    }
}

fn name_of(f: &ttf_parser::Face, ids: &[u16]) -> Option<String> {
    for &id in ids {
        // 先英文（Windows 平台 0x409 / Mac 平台英文），再随便一个能解出来的
        let mut any = None;
        for n in f.names() {
            if n.name_id != id {
                continue;
            }
            if let Some(s) = n.to_string() {
                if n.language() == ttf_parser::Language::English_UnitedStates {
                    return Some(s);
                }
                any.get_or_insert(s);
            }
        }
        if any.is_some() {
            return any;
        }
    }
    None
}

/// 选中的字体面 + 要不要合成粗 / 斜（族里没有粗体 / 斜体时浏览器与系统排版器都会合成）。
#[derive(Clone)]
pub struct FaceRef {
    pub face: Arc<Face>,
    pub synth_bold: bool,
    pub synth_italic: bool,
}

/// 合成粗体的描边宽（字号的倍数）：照 Skia 假粗体的插值（9 号 1/24 → 36 号 1/32），描边一半在外。
pub fn synth_bold_stroke(size: f64) -> f64 {
    let t = ((size - 9.0) / 27.0).clamp(0.0, 1.0);
    size * (1.0 / 24.0 + t * (1.0 / 32.0 - 1.0 / 24.0))
}

/// 合成斜体的错切（Skia / CoreText 都是 tan ≈ 0.25）
pub const SYNTH_ITALIC_SKEW: f64 = 0.25;

/// fontconfig 缺字回退缓存的键：(族名, 字, 粗, 斜)
type FcCharKey = (String, char, bool, bool);

/// 可变字体实例的键：(面的来源键, 字重, 斜体)
type InstanceKey = (String, u16, bool);

/// 字体库：fontdb（族名、粗细、斜正的匹配）+ 已读字节 + 已解析的面。
pub struct FontBook {
    db: fontdb::Database,
    platform: Platform,
    faces: RefCell<HashMap<fontdb::ID, Option<Arc<Face>>>>,
    instances: RefCell<HashMap<InstanceKey, Option<Arc<Face>>>>,
    bytes: RefCell<HashMap<String, Arc<Vec<u8>>>>,
    found: RefCell<HashMap<(String, bool, bool), Option<FaceRef>>>,
    /// 直接按文件 + 子字体序号收进来的面（成书样式表指名的字体），不进 fontdb 的族名匹配
    adopted: RefCell<Vec<Arc<Face>>>,
    /// [`FontBook::pick_any`] 的按字缓存：(字, 粗, 斜)
    any_char: RefCell<HashMap<(char, bool, bool), Option<FaceRef>>>,
    /// fontconfig 缺字回退的缓存：(族名, 字, 粗, 斜)
    fc_char: RefCell<HashMap<FcCharKey, Option<FaceRef>>>,
    /// 按文件 + 序号建的面（fontconfig 给的），键 `路径#序号`
    path_faces: RefCell<HashMap<String, Option<Arc<Face>>>>,
    /// 族名匹配与缺字回退问 fontconfig（Linux 且载得到时）
    fc: bool,
    /// 族串里的字体都缺这个字时依次试的族（平台的 CJK / 符号字体）
    pub last_resort: Vec<String>,
}

impl FontBook {
    /// 空库（wasm、测试：字体全由宿主给）
    pub fn empty(platform: Platform) -> FontBook {
        FontBook {
            db: fontdb::Database::new(),
            platform,
            faces: RefCell::default(),
            instances: RefCell::default(),
            bytes: RefCell::default(),
            found: RefCell::default(),
            adopted: RefCell::default(),
            any_char: RefCell::default(),
            path_faces: RefCell::default(),
            fc_char: RefCell::default(),
            fc: false,
            last_resort: last_resort(platform),
        }
    }

    /// 系统字体库（桌面、命令行）。Linux 上有 fontconfig 就不扫目录（选字全问它），fontdb 里只放注册的字体文件。
    #[cfg(feature = "fontfile-system")]
    pub fn system() -> FontBook {
        let mut b = FontBook::empty(Platform::current());
        #[cfg(target_os = "linux")]
        if fc::available() {
            b.fc = true;
            return b;
        }
        b.db.load_system_fonts();
        b
    }

    /// 选字走不走 fontconfig
    pub fn uses_fontconfig(&self) -> bool {
        self.fc
    }

    /// 加一个字体文件（随包的 Bravura、样式表里指名的文件）
    #[cfg(feature = "fontfile-system")]
    pub fn add_file(&mut self, path: &std::path::Path) -> std::io::Result<()> {
        let data = std::fs::read(path)?;
        self.add_bytes(path.to_string_lossy().into_owned(), data);
        Ok(())
    }

    /// 加一份字体字节（`.ttc` 的各子字体都进库）
    pub fn add_bytes(&mut self, key: String, data: Vec<u8>) {
        let data = Arc::new(data);
        self.bytes.borrow_mut().insert(key, data.clone());
        self.db.load_font_source(fontdb::Source::Binary(data));
        self.found.borrow_mut().clear();
        self.any_char.borrow_mut().clear();
    }

    pub fn platform(&self) -> Platform {
        self.platform
    }

    /// CSS 族串 → 具体族（同量字）
    pub fn families(&self, css: &str) -> Vec<String> {
        crate::text::css_families(css, self.platform)
    }

    fn face_of(&self, id: fontdb::ID) -> Option<Arc<Face>> {
        if let Some(f) = self.faces.borrow().get(&id) {
            return f.clone();
        }
        let info = self.db.face(id)?;
        let index = info.index;
        let (key, data) = match &info.source {
            fontdb::Source::Binary(d) => {
                let bytes: &[u8] = (**d).as_ref();
                let key = self
                    .bytes
                    .borrow()
                    .iter()
                    .find(|(_, v)| v.as_slice().as_ptr() == bytes.as_ptr())
                    .map(|(k, _)| k.clone())
                    .unwrap_or_else(|| format!("<bytes {}>", info.post_script_name));
                let data = self.bytes.borrow().get(&key).cloned().unwrap_or_else(|| Arc::new(bytes.to_vec()));
                (key, data)
            }
            #[cfg(feature = "fontfile-system")]
            fontdb::Source::File(p) | fontdb::Source::SharedFile(p, _) => {
                let key = p.to_string_lossy().into_owned();
                let hit = self.bytes.borrow().get(&key).cloned();
                let data = match hit {
                    Some(d) => d,
                    None => {
                        let d = Arc::new(std::fs::read(p).ok()?);
                        self.bytes.borrow_mut().insert(key.clone(), d.clone());
                        d
                    }
                };
                (key, data)
            }
            #[allow(unreachable_patterns)]
            _ => return None,
        };
        let face = Face::parse(data, index, format!("{key}#{index}")).map(Arc::new);
        self.faces.borrow_mut().insert(id, face.clone());
        face
    }

    /// fontdb 里按族名（各语言的名字表都认）、再按 PostScript 名找
    fn db_find(&self, family: &str, bold: bool, italic: bool) -> Option<Arc<Face>> {
        let q = fontdb::Query {
            families: &[fontdb::Family::Name(family)],
            weight: if bold { fontdb::Weight::BOLD } else { fontdb::Weight::NORMAL },
            stretch: fontdb::Stretch::Normal,
            style: if italic { fontdb::Style::Italic } else { fontdb::Style::Normal },
        };
        let id = self.db.query(&q).or_else(|| self.db.faces().find(|f| f.post_script_name == family).map(|f| f.id))?;
        self.face_of(id)
    }

    /// 按文件 + 子字体序号建面（同一面只建一次）
    #[cfg(feature = "fontfile-system")]
    #[allow(dead_code)]
    fn face_at(&self, file: &str, index: u32) -> Option<Arc<Face>> {
        let key = format!("{file}#{index}");
        if let Some(f) = self.path_faces.borrow().get(&key) {
            return f.clone();
        }
        let face = self.file_bytes(std::path::Path::new(file)).ok().and_then(|d| Face::parse(d, index, key.clone())).map(Arc::new);
        self.path_faces.borrow_mut().insert(key, face.clone());
        face
    }

    /// 选中的面 → [`FaceRef`]：可变字体按要的字重 / 斜体取实例（fontdb、fontconfig 都只给缺省实例，如 .SF Compact 缺省是 Black），判合成粗斜
    fn finish(&self, mut face: Arc<Face>, bold: bool, italic: bool) -> FaceRef {
        if face.variable {
            let want = if bold { 700.0 } else { 400.0 };
            let k = (face.key.clone(), want as u16, italic);
            let inst = self.instances.borrow().get(&k).cloned();
            let inst = match inst {
                Some(v) => v,
                None => {
                    let v = face.instance(want, italic).map(Arc::new);
                    self.instances.borrow_mut().insert(k, v.clone());
                    v
                }
            };
            if let Some(f) = inst {
                face = f;
            }
        }
        FaceRef { synth_bold: bold && face.weight < 600 && !face.bold_flag, synth_italic: italic && !face.italic, face }
    }

    /// 具体族名 + 粗斜 → 字体面。先查 fontdb（注册的字体文件优先，同 macOS 注册字体优先于系统里的同名族）；
    /// Linux 上再问 fontconfig（照 Chromium 判这支算不算要的族），没有 fontconfig 时试 [`LINUX_ALIASES`]。
    pub fn find(&self, family: &str, bold: bool, italic: bool) -> Option<FaceRef> {
        let k = (family.to_string(), bold, italic);
        if let Some(hit) = self.found.borrow().get(&k) {
            return hit.clone();
        }
        let mut face = self.db_find(family, bold, italic);
        #[cfg(all(target_os = "linux", feature = "fontfile-system"))]
        if face.is_none() && self.fc {
            // 中文页面的 sans-serif / serif = 以泛称为族名对「一」的缺字回退（见 `fc` 模块注释）
            face = if family == "sans-serif" || family == "serif" {
                fc::fallback('\u{4E00}', family, bold, italic, FALLBACK_LANG)
            } else {
                fc::match_family(family, bold, italic)
            }
            .and_then(|f| self.face_at(&f.file, f.index));
        }
        if face.is_none() && !self.fc && self.platform == Platform::Linux {
            if let Some((_, alts)) = LINUX_ALIASES.iter().find(|(n, _)| n.eq_ignore_ascii_case(family)) {
                face = alts.iter().find_map(|a| self.db_find(a, bold, italic));
            }
        }
        let hit = face.map(|f| self.finish(f, bold, italic));
        self.found.borrow_mut().insert(k, hit.clone());
        hit
    }

    /// 收一个直接解析出的面（写出时报字体错能找回它、记成转曲）
    #[allow(clippy::arc_with_non_send_sync)] // 面带 RefCell 缓存、只在一个线程里用；Arc 是为与 fontdb 那路同型
    pub fn adopt(&self, face: Face) -> Arc<Face> {
        let f = Arc::new(face);
        self.adopted.borrow_mut().push(f.clone());
        f
    }

    /// 读一份字体文件的字节（同一路径只读一次）
    #[cfg(feature = "fontfile-system")]
    pub fn file_bytes(&self, path: &std::path::Path) -> std::io::Result<Arc<Vec<u8>>> {
        let key = path.to_string_lossy().into_owned();
        if let Some(d) = self.bytes.borrow().get(&key) {
            return Ok(d.clone());
        }
        let d = Arc::new(std::fs::read(path)?);
        self.bytes.borrow_mut().insert(key, d.clone());
        Ok(d)
    }

    /// 已用到的各字体面
    pub fn loaded(&self) -> Vec<Arc<Face>> {
        let mut v: Vec<Arc<Face>> = self.faces.borrow().values().flatten().cloned().collect();
        v.extend(self.instances.borrow().values().flatten().cloned());
        v.extend(self.path_faces.borrow().values().flatten().cloned());
        v.extend(self.adopted.borrow().iter().cloned());
        v
    }

    /// 族串（CSS）里各族的字体面，按序；没装的跳过
    pub fn chain(&self, css: &str, bold: bool, italic: bool) -> Vec<FaceRef> {
        self.chain_of(&self.families(css), bold, italic)
    }

    /// 已展开的具体族名 → 各族的字体面，按序；没装的跳过
    pub fn chain_of(&self, families: &[String], bold: bool, italic: bool) -> Vec<FaceRef> {
        families.iter().filter_map(|f| self.find(f, bold, italic)).collect()
    }

    /// 这个字落在哪个字体面：族串里第一个有这个字的，都没有再试末位回退（Linux 有 fontconfig 时问它，照 Chromium）
    pub fn pick(&self, chain: &[FaceRef], ch: char, bold: bool, italic: bool) -> Option<FaceRef> {
        self.pick_in(chain, ch, bold, italic, "")
    }

    /// 同 [`FontBook::pick`]，带族串第一个族名（CSS 原样，泛称不展开）：fontconfig 缺字回退按它分 sans / serif，同 Skia。
    pub fn pick_in(&self, chain: &[FaceRef], ch: char, bold: bool, italic: bool, first_family: &str) -> Option<FaceRef> {
        if let Some(f) = chain.iter().find(|f| f.face.has(ch)) {
            return Some(f.clone());
        }
        if self.fc {
            return self.fc_fallback(ch, first_family, bold, italic);
        }
        self.last_resort.iter().filter_map(|fam| self.find(fam, bold, italic)).find(|f| f.face.has(ch))
    }

    /// fontconfig 的缺字回退（按族名 + 字缓存）
    fn fc_fallback(&self, ch: char, family: &str, bold: bool, italic: bool) -> Option<FaceRef> {
        let k = (family.to_string(), ch, bold, italic);
        if let Some(hit) = self.fc_char.borrow().get(&k) {
            return hit.clone();
        }
        #[cfg(all(target_os = "linux", feature = "fontfile-system"))]
        let hit = fc::fallback(ch, family, bold, italic, FALLBACK_LANG).and_then(|f| self.face_at(&f.file, f.index)).filter(|f| f.has(ch)).map(|f| self.finish(f, bold, italic));
        #[cfg(not(all(target_os = "linux", feature = "fontfile-system")))]
        let hit = None;
        self.fc_char.borrow_mut().insert(k, hit.clone());
        hit
    }

    /// 末位回退也没有这个字时：库里任一有这个字的面（按 fontdb 的顺序取第一个，按字缓存；有 fontconfig 时同 [`FontBook::pick`] 的回退）。
    /// Linux 上装什么字体不定，系统量字靠这一步保证不缺字；导出不用（缺字照报）。
    pub fn pick_any(&self, ch: char) -> Option<FaceRef> {
        if self.fc {
            return self.fc_fallback(ch, "", false, false);
        }
        let k = (ch, false, false);
        if let Some(hit) = self.any_char.borrow().get(&k) {
            return hit.clone();
        }
        // 先就地探字表（fontdb 按需映射文件、不进字节缓存），找到了才建面——不把整库字体读进内存
        let covers = |id: fontdb::ID| {
            self.db
                .with_face_data(id, |data, index| ttf_parser::Face::parse(data, index).ok().and_then(|f| f.glyph_index(ch)).is_some_and(|g| g.0 != 0))
                .unwrap_or(false)
        };
        let ids: Vec<fontdb::ID> = self.db.faces().map(|f| f.id).collect();
        let hit = ids
            .into_iter()
            .filter(|&id| covers(id))
            .filter_map(|id| self.face_of(id))
            .find(|f| f.outlines != Outlines::Bitmap)
            .map(|face| FaceRef { face, synth_bold: false, synth_italic: false });
        self.any_char.borrow_mut().insert(k, hit.clone());
        hit
    }
}

fn last_resort(p: Platform) -> Vec<String> {
    let v: &[&str] = match p {
        Platform::Darwin => &["PingFang SC", "Hiragino Sans GB", "Songti SC", "Apple Symbols", "Arial Unicode MS", "STIXGeneral"],
        Platform::Win32 => &["Microsoft YaHei", "SimSun", "Segoe UI Symbol", "Arial Unicode MS", "Cambria Math"],
        // 没有 fontconfig 时才用
        Platform::Linux => &[
            "Noto Sans CJK SC",
            "WenQuanYi Zen Hei",
            "WenQuanYi Micro Hei",
            "Source Han Sans SC",
            "Droid Sans Fallback",
            "DejaVu Sans",
            "Noto Sans Symbols2",
            "Noto Sans Symbols",
        ],
    };
    v.iter().map(|s| s.to_string()).collect()
}
