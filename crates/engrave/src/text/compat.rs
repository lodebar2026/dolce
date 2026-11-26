//! 浏览器口径层，照 `src/cli/textmeasure.node.ts`：系统文字引擎（CoreText / DirectWrite）量出来的数，
//! 折成浏览器（中文页面里的 SVG `<text>`）的口径——泛称按浏览器缺省展开、族串末尾补标准字体、
//! ascent/descent 取整（macOS 的 Times/Helvetica/Courier 再加 15% 行高）、单字 advance 向上取到 1/64 px、
//! 相邻全角标点的缺省挤压（`text-spacing-trim`）、结果过一道 f32。
//!
//! 系统文字引擎本身在 `native` 模块（`native` 特性，实现 [`SystemText`]）；这里不碰平台。

use std::cell::RefCell;
use std::collections::HashMap;

use dolce_model::base::geom::{fround, path_bounds, Rect};

use crate::text::cjkpunct::{code_points, punct_class, PunctClass};
use crate::text::{svg_collapsed_text, FontMetrics, FontStyle, Positions, TextMeasurer, TextMetrics, Weight, HALT};

/// 浏览器缺省的相邻全角标点挤压（`text-spacing-trim`）：各码点往左挪多少（它前面累计挤掉的），一处都不挤给 None。
/// `is_full`：这个字是全角宽的标点；`half_of`：它开 `halt` 能省下的宽。量字（[`BrowserCompat`]）与 PDF 写出端共用。
pub fn han_kern_shifts(chars: &[&str], is_full: impl Fn(&str) -> bool, half_of: impl Fn(&str) -> f64) -> Option<Vec<f64>> {
    if chars.len() < 2 {
        return None;
    }
    let mut shift = vec![0.0; chars.len()];
    let mut acc = 0.0;
    for i in 1..chars.len() {
        let (a, c) = (chars[i - 1], chars[i]);
        let (ka, kc) = (punct_class(a), punct_class(c));
        if ka != PunctClass::None && kc != PunctClass::None && is_full(a) && is_full(c) {
            if kc == PunctClass::Open {
                acc += half_of(c);
            } else if matches!(ka, PunctClass::Close | PunctClass::Stop) && matches!(kc, PunctClass::Close | PunctClass::Stop | PunctClass::Middle) {
                acc += half_of(a);
            }
        }
        shift[i] = acc;
    }
    (acc > 0.0).then_some(shift)
}

/// 系统文字引擎量一串字的结果（`native/textmeasure` 的 `Measured`）。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Measured {
    /// 总 advance
    pub width: f64,
    /// 墨迹盒（相对落笔点）；没有墨时 `ink` 为 false、四边为 0
    pub ink: bool,
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    /// 每个码点的落笔点（shaping 之后，含特性的挤压）
    pub xs: Vec<f64>,
}

/// 字体全局度量（首个可用的族），ascent / descent 都是正值。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RawFontMetrics {
    pub ascent: f64,
    pub descent: f64,
    /// 实际用到的族名（浏览器对个别族有度量修正，按名判）
    pub family: String,
}

/// 系统文字引擎：`families` 是已展开泛称的具体族名（按序，缺字逐字回退），`features` 是要开的 OpenType 特性。
pub trait SystemText {
    fn measure(&self, text: &str, families: &[String], size: f64, bold: bool, italic: bool, features: &[String]) -> Measured;
    fn font_metrics(&self, families: &[String], size: f64, bold: bool, italic: bool) -> RawFontMetrics;
    /// 字形轮廓（SVG path `d`，落笔点在原点、基线 y = 0、向下为正）
    fn outline(&self, text: &str, families: &[String], size: f64, bold: bool, italic: bool, features: &[String]) -> String;
    /// 注册不在系统里的字体文件（只对本进程有效）
    fn register_font(&self, path: &str) -> bool;
    fn has_family(&self, family: &str) -> bool;
}

/// 画字的是哪种浏览器内核：网页 / Node 回归与 Windows 桌面版（WebView2）是 Chromium，macOS 桌面版（WKWebView）是 WebKit。
/// 两家量字口径的差别：单字宽 Chromium 向上取到 1/64 px，WebKit 不取（`getComputedTextLength` 原样是浮点）；
/// 相邻全角标点 Chromium 缺省挤掉半个字（`text-spacing-trim`），WebKit 不挤；WebKit 的 SVG 文字不做字距调整（kerning），Chromium 做。
/// 还有一处不学：WebKit 给苹方粗体（Semibold）按屏幕像素字号套 `trak` 字距（随缩放、屏幕倍率变），原生按字号排、不套。
/// 墨迹不分：WebKit 页面里自己量的墨迹是离屏画布逐像素量的（台阶约 1/200 em），原生量的才是真墨迹，不去学它。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    Chromium,
    WebKit,
}

/// 泛称表与标准字体按哪个平台的浏览器取（`process.platform`；别的平台按 macOS）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Darwin,
    Win32,
    Linux,
}

/// Linux 上的泛称原样交给字体层（`fontfile::FontBook::find`）：Chromium 在中文页面里把 sans-serif / serif / 标准字体换成
/// fontconfig 对汉字代表字的回退字体（常见是 Noto Sans / Serif CJK SC），monospace 照 fontconfig 的 monospace；装了什么由 fontconfig 定，这里列不出实名。
const LINUX_SANS: &[&str] = &["sans-serif"];
const LINUX_SERIF: &[&str] = &["serif"];
const LINUX_MONO: &[&str] = &["monospace"];

impl Platform {
    pub fn current() -> Platform {
        if cfg!(target_os = "windows") {
            Platform::Win32
        } else if cfg!(target_os = "linux") {
            Platform::Linux
        } else {
            Platform::Darwin
        }
    }

    /// 泛称 → 具体族（中文页面里 SVG `<text>` 的解析结果）；Linux 上是一串候选。
    fn generic(self, name: &str) -> Option<&'static [&'static str]> {
        match (self, name) {
            (Platform::Darwin, "sans-serif") => Some(&["PingFang SC"]),
            (Platform::Darwin, "serif") => Some(&["Songti SC"]),
            (Platform::Darwin, "monospace") => Some(&["Menlo"]),
            (Platform::Darwin, "system-ui") => Some(&["PingFang SC"]),
            (Platform::Win32, "sans-serif") => Some(&["Microsoft YaHei"]),
            (Platform::Win32, "serif") => Some(&["SimSun"]),
            (Platform::Win32, "monospace") => Some(&["Consolas"]),
            (Platform::Win32, "system-ui") => Some(&["Microsoft YaHei UI"]),
            (Platform::Linux, "sans-serif" | "system-ui") => Some(LINUX_SANS),
            (Platform::Linux, "serif") => Some(LINUX_SERIF),
            (Platform::Linux, "monospace") => Some(LINUX_MONO),
            _ => None,
        }
    }

    /// 族串里一个都没有时浏览器用的标准字体（Linux 上是一串候选）。
    fn standard(self) -> &'static [&'static str] {
        match self {
            Platform::Darwin => &["PingFang SC"],
            Platform::Win32 => &["Microsoft YaHei"],
            Platform::Linux => LINUX_SANS,
        }
    }
}

/// `ceil64`：向上取到 1/64 px。
fn ceil64(v: f64) -> f64 {
    (v * 64.0 - 1e-6).ceil() / 64.0
}

/// `/^(['"])(.*)\1$/` 去引号。
fn unquote(s: &str) -> &str {
    let b = s.as_bytes();
    if b.len() >= 2 && (b[0] == b'"' || b[0] == b'\'') && b[b.len() - 1] == b[0] {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

/// CSS 族串 → 具体族名（泛称按 `platform` 的浏览器展开，末尾补标准字体）。量字与导出（PDF 选字体）共用这一份。
pub fn css_families(css: &str, platform: Platform) -> Vec<String> {
    let mut hit: Vec<String> = Vec::new();
    for part in css.split(',') {
        let name = unquote(dolce_model::base::js::trim(part));
        if name.is_empty() {
            continue;
        }
        match platform.generic(&name.to_lowercase()) {
            Some(g) => hit.extend(g.iter().map(|s| s.to_string())),
            None => hit.push(name.to_string()),
        }
    }
    for std in platform.standard() {
        if !hit.iter().any(|h| h == std) {
            hit.push(std.to_string());
        }
    }
    hit
}

/// 系统文字引擎 + 浏览器口径（`nodeMeasure()` 原生那条路 = `browserLike(nativeMeasure(...))`）。
pub struct BrowserCompat<S: SystemText> {
    sys: S,
    platform: Platform,
    engine: Engine,
    lists: RefCell<HashMap<String, Vec<String>>>,
}

impl<S: SystemText> BrowserCompat<S> {
    /// Chromium 口径（网页、Node 回归）。
    pub fn new(sys: S, platform: Platform) -> Self {
        Self::with_engine(sys, platform, Engine::Chromium)
    }

    pub fn with_engine(sys: S, platform: Platform, engine: Engine) -> Self {
        BrowserCompat { sys, platform, engine, lists: RefCell::default() }
    }

    pub fn sys(&self) -> &S {
        &self.sys
    }

    /// CSS 族串 → 具体族名（泛称按浏览器展开，末尾补标准字体）。
    pub fn families_of(&self, css: &str) -> Vec<String> {
        if let Some(hit) = self.lists.borrow().get(css) {
            return hit.clone();
        }
        let hit = css_families(css, self.platform);
        self.lists.borrow_mut().insert(css.to_string(), hit.clone());
        hit
    }

    /// 一串字的轮廓，字体选择同量字。
    pub fn outline(&self, text: &str, css: &str, size: f64, bold: bool, italic: bool) -> String {
        self.sys.outline(text, &self.families_of(css), size, bold, italic, &[])
    }

    // ---- 原生那一层（`nativeMeasure`）：f32、宽度按折叠空白后的串量 ----

    /// 交给系统后端的特性：WebKit 口径添上「不做字距调整」。
    fn sys_features(&self, features: &[String]) -> Vec<String> {
        let mut f = features.to_vec();
        if self.engine == Engine::WebKit {
            f.push(crate::text::NO_KERN.to_string());
        }
        f
    }

    fn raw_glyph(&self, text: &str, family: &str, size: f64, weight: Weight, features: &[String], style: FontStyle) -> TextMetrics {
        let features = &self.sys_features(features);
        let fams = self.families_of(family);
        let bold = weight == Weight::Bold;
        let italic = style == FontStyle::Italic;
        let m = self.sys.measure(text, &fams, size, bold, italic, features);
        let bbox = if m.ink { Rect::new(fround(m.left), fround(m.top), fround(m.right), fround(m.bottom)) } else { Rect::default() };
        let shown = svg_collapsed_text(text);
        let width = if shown == text { m.width } else { self.sys.measure(&shown, &fams, size, bold, italic, features).width };
        TextMetrics { width: fround(width), bbox }
    }

    fn raw_positions(&self, text: &str, family: &str, size: f64, weight: Weight, features: &[String]) -> Positions {
        let m = self.sys.measure(text, &self.families_of(family), size, weight == Weight::Bold, false, &self.sys_features(features));
        Positions { xs: m.xs.iter().map(|&x| fround(x)).collect(), width: fround(m.width) }
    }

    // ---- 浏览器缺省的标点挤压（`hanKerning`）----

    fn is_full(&self, ch: &str, family: &str, size: f64, weight: Weight, style: FontStyle) -> bool {
        punct_class(ch) != PunctClass::None && (self.raw_glyph(ch, family, size, weight, &[], style).width - size).abs() <= size * 0.02
    }

    fn half_of(&self, ch: &str, family: &str, size: f64, weight: Weight, style: FontStyle) -> f64 {
        let halt = [HALT.to_string()];
        dolce_model::base::js::max(
            0.0,
            self.raw_glyph(ch, family, size, weight, &[], style).width - self.raw_glyph(ch, family, size, weight, &halt, style).width,
        )
    }

    /// 各码点往左挪多少（它前面累计挤掉的）；一处都不挤给 None。
    fn kern(&self, text: &str, family: &str, size: f64, weight: Weight, style: FontStyle) -> Option<Vec<f64>> {
        han_kern_shifts(&code_points(text), |c| self.is_full(c, family, size, weight, style), |c| self.half_of(c, family, size, weight, style))
    }

    /// `browserLike` 的 glyph（量化前）。WebKit 不挤标点，原样回。
    fn kerned_glyph(&self, text: &str, family: &str, size: f64, weight: Weight, features: &[String], style: FontStyle) -> TextMetrics {
        let m = self.raw_glyph(text, family, size, weight, features, style);
        if !features.is_empty() || self.engine == Engine::WebKit {
            return m;
        }
        let shown = svg_collapsed_text(text);
        let Some(shift) = self.kern(&shown, family, size, weight, style) else { return m };
        let xs = self.raw_positions(&shown, family, size, weight, &[]).xs;
        let mut ink: Option<Rect> = None;
        for (i, ch) in code_points(&shown).into_iter().enumerate() {
            let g = self.raw_glyph(ch, family, size, weight, &[], style).bbox;
            if g.right <= g.left && g.bottom <= g.top {
                continue;
            }
            let dx = xs.get(i).copied().unwrap_or(0.0) - shift[i];
            let r = Rect::new(g.left + dx, g.top, g.right + dx, g.bottom);
            ink = Some(match ink {
                Some(k) => k.union(&r),
                None => r,
            });
        }
        TextMetrics { width: m.width - shift[shift.len() - 1], bbox: ink.unwrap_or(m.bbox) }
    }
}

impl<S: SystemText> TextMeasurer for BrowserCompat<S> {
    fn glyph(&self, text: &str, family: &str, size: f64, weight: Weight, features: &[String], style: FontStyle) -> TextMetrics {
        let mut m = self.kerned_glyph(text, family, size, weight, features, style);
        // 单字（非空白）的 advance 向上取到 1/64（Chromium 的量法；WebKit 不取）
        let mut it = text.chars();
        if let (Some(c), None, Engine::Chromium) = (it.next(), it.next(), self.engine) {
            if !dolce_model::base::js::is_space(c) {
                m.width = ceil64(m.width);
            }
        }
        // Linux 上 Chromium 的 canvas 墨迹是整像素：FreeType slight hinting 只把纵向对齐到像素格，
        // 字形盒再向外取整——横向左 floor、右 ceil，纵向（已对齐）四舍五入
        if self.engine == Engine::Chromium && self.platform == Platform::Linux {
            let b = m.bbox;
            if b.right > b.left || b.bottom > b.top {
                m.bbox = Rect::new(b.left.floor(), b.top.round(), b.right.ceil(), b.bottom.round());
            }
        }
        m
    }

    fn positions(&self, text: &str, family: &str, size: f64, weight: Weight, features: &[String]) -> Positions {
        self.raw_positions(text, family, size, weight, features)
    }

    fn font_metrics(&self, family: &str, size: f64, weight: Weight, style: FontStyle) -> FontMetrics {
        let m = self.sys.font_metrics(&self.families_of(family), size, weight == Weight::Bold, style == FontStyle::Italic);
        browser_metrics(m.ascent, m.descent, &m.family, self.platform)
    }

    fn path_bounds(&self, d: &str) -> Rect {
        browser_path_bounds(d)
    }

    fn svg_kerning(&self) -> bool {
        self.engine != Engine::WebKit
    }
}

/// 路径紧包围盒的浏览器口径：纯算（同 `getBBox()`）再过 f32（同 TS `nodeMeasure().pathBounds`）。
pub fn browser_path_bounds(d: &str) -> Rect {
    let r = path_bounds(d);
    Rect::new(fround(r.left), fround(r.top), fround(r.right), fround(r.bottom))
}

/// 浏览器给的 ascent/descent 是取整过的；macOS 上 Times / Helvetica / Courier 的 ascent 再加 15% 行高。
fn browser_metrics(asc: f64, desc: f64, family: &str, platform: Platform) -> FontMetrics {
    use dolce_model::base::js::round;
    let mut a = round(asc);
    let d = round(desc);
    let f = family.to_ascii_lowercase();
    if platform == Platform::Darwin && matches!(f.as_str(), "times" | "helvetica" | "courier") {
        a += ((a + d) * 0.15 + 0.5).floor();
    }
    FontMetrics { ascent: -a, descent: d }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 假引擎：每字 10 px（标点开 halt 后 5 px），墨迹占 [1,9]×[-8,1]。
    struct Fake;
    impl SystemText for Fake {
        fn measure(&self, text: &str, _f: &[String], _s: f64, _b: bool, _i: bool, features: &[String]) -> Measured {
            let halt = features.iter().any(|f| f == "halt");
            let mut xs = Vec::new();
            let mut x = 0.0;
            for c in text.chars() {
                xs.push(x);
                let p = punct_class(c.encode_utf8(&mut [0; 4])) != PunctClass::None;
                x += if halt && p { 5.0 } else { 10.0 };
            }
            Measured { width: x, ink: !text.trim().is_empty(), left: 1.0, top: -8.0, right: x - 1.0, bottom: 1.0, xs }
        }
        fn font_metrics(&self, families: &[String], _s: f64, _b: bool, _i: bool) -> RawFontMetrics {
            RawFontMetrics { ascent: 9.6, descent: 2.4, family: families[0].clone() }
        }
        fn outline(&self, _t: &str, _f: &[String], _s: f64, _b: bool, _i: bool, _x: &[String]) -> String {
            String::new()
        }
        fn register_font(&self, _p: &str) -> bool {
            true
        }
        fn has_family(&self, _f: &str) -> bool {
            true
        }
    }

    #[test]
    fn families() {
        let b = BrowserCompat::new(Fake, Platform::Darwin);
        assert_eq!(b.families_of("'Times New Roman', serif"), vec!["Times New Roman", "Songti SC", "PingFang SC"]);
        assert_eq!(b.families_of("sans-serif"), vec!["PingFang SC"]);
        assert_eq!(b.families_of(" , "), vec!["PingFang SC"]);
    }

    #[test]
    fn kerning_and_metrics() {
        let b = BrowserCompat::new(Fake, Platform::Darwin);
        // 「：（」开括号前是全角标点：挤开括号的左半
        let m = b.glyph("：（", "x", 10.0, Weight::Normal, &[], FontStyle::Normal);
        assert_eq!(m.width, 15.0);
        let m = b.glyph("ab", "x", 10.0, Weight::Normal, &[], FontStyle::Normal);
        assert_eq!(m.width, 20.0);
        let fm = b.font_metrics("Helvetica", 10.0, Weight::Normal, FontStyle::Normal);
        // 9.6→10、2.4→2，再加 floor(12×0.15+0.5)=2
        assert_eq!((fm.ascent, fm.descent), (-12.0, 2.0));
        assert_eq!(ceil64(11.228), 11.234375);
    }
}
