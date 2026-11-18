//! 排版量字的系统文字引擎（字体匹配、逐字回退、OpenType 特性、字形轮廓都由系统给）：
//!   - macOS：CoreText（`mac.rs`）
//!   - Windows：DirectWrite（`win.rs`）
//!
//! 其它平台没有实现（[`NativeText::available`] 为 false，量什么都给 0）；字体文件回退（fontdb）留到导出期一起做。
//!
//! `native` 特性才编。坐标口径同本 crate：基线 y = 0、向下为正，单位 px。原先是 `native/textmeasure` 的 N-API 模块，
//! 现在那边只剩 napi 外壳调这里（Node 侧 TS 排版在 H 期前仍用它）。
//!
//! 浏览器口径（泛称展开、取整、1/64、缺省挤压）不在这层，见 [`crate::BrowserCompat`]；
//! [`node_measure`] 装好两层，等价于 TS 的 `nodeMeasure()`。

use crate::{BrowserCompat, Engine, Measured, Platform, RawFontMetrics, SystemText};

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
use mac as sys;

#[cfg(target_os = "windows")]
mod win;
#[cfg(target_os = "windows")]
use win as sys;

/// 系统文字引擎。字体缓存是线程局部的（CoreText / DirectWrite 对象不跨线程）。
#[derive(Clone, Copy, Debug, Default)]
pub struct NativeText;

impl NativeText {
    /// 本平台有没有系统文字引擎。
    pub const fn available() -> bool {
        cfg!(any(target_os = "macos", target_os = "windows"))
    }

    /// 调试：族名 → 实际解析到的字体（PostScript 名 / 族名）。
    pub fn resolve_name(&self, family: &str) -> String {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        return sys::resolve_name(family);
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = family;
            String::new()
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl SystemText for NativeText {
    fn measure(&self, text: &str, families: &[String], size: f64, bold: bool, italic: bool, features: &[String]) -> Measured {
        sys::measure(text, families, size, bold, italic, features)
    }
    fn font_metrics(&self, families: &[String], size: f64, bold: bool, italic: bool) -> RawFontMetrics {
        sys::font_metrics(families, size, bold, italic)
    }
    fn outline(&self, text: &str, families: &[String], size: f64, bold: bool, italic: bool, features: &[String]) -> String {
        sys::outline(text, families, size, bold, italic, features)
    }
    fn register_font(&self, path: &str) -> bool {
        sys::register_font(path)
    }
    fn has_family(&self, family: &str) -> bool {
        sys::has_family(family)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl SystemText for NativeText {
    fn measure(&self, text: &str, _: &[String], _: f64, _: bool, _: bool, _: &[String]) -> Measured {
        Measured { xs: vec![0.0; text.chars().count()], ..Measured::default() }
    }
    fn font_metrics(&self, _: &[String], size: f64, _: bool, _: bool) -> RawFontMetrics {
        RawFontMetrics { ascent: size * 0.8, descent: size * 0.2, family: String::new() }
    }
    fn outline(&self, _: &str, _: &[String], _: f64, _: bool, _: bool, _: &[String]) -> String {
        String::new()
    }
    fn register_font(&self, _: &str) -> bool {
        false
    }
    fn has_family(&self, _: &str) -> bool {
        false
    }
}

/// 本仓库按文件给的字体（不在系统里）：族名 → 文件名，在 `public/redist/` 下。
pub const REPO_FONTS: &[(&str, &str)] = &[("Bravura", "Bravura.otf"), ("Bravura Text", "BravuraText.otf")];

/// TS `nodeMeasure(files)` 的原生那条路：注册仓库字体（`redist` 目录下）与额外的字体文件，套上浏览器口径层（Chromium）。
pub fn node_measure(redist: Option<&std::path::Path>, files: &[(String, String)]) -> BrowserCompat<NativeText> {
    measure_for(redist, files, Engine::Chromium)
}

/// 桌面版的量字：同 [`node_measure`]，口径照本平台的 WebView（macOS WKWebView 是 WebKit，Windows WebView2 是 Chromium）。
pub fn webview_measure(redist: Option<&std::path::Path>, files: &[(String, String)]) -> BrowserCompat<NativeText> {
    measure_for(redist, files, if cfg!(target_os = "macos") { Engine::WebKit } else { Engine::Chromium })
}

fn measure_for(redist: Option<&std::path::Path>, files: &[(String, String)], engine: Engine) -> BrowserCompat<NativeText> {
    let sys = NativeText;
    let mut paths: Vec<String> = Vec::new();
    if let Some(dir) = redist {
        for (_, f) in REPO_FONTS {
            paths.push(dir.join(f).to_string_lossy().into_owned());
        }
    }
    paths.extend(files.iter().map(|(_, p)| p.clone()));
    for p in paths {
        if std::path::Path::new(&p).exists() {
            sys.register_font(&p);
        }
    }
    BrowserCompat::with_engine(sys, Platform::current(), engine)
}

/// 把 UTF-16 下标换成码点下标。
pub(crate) fn utf16_to_cp(text: &str) -> Vec<usize> {
    let mut map = Vec::with_capacity(text.len());
    for (cp, ch) in text.chars().enumerate() {
        for _ in 0..ch.len_utf16() {
            map.push(cp);
        }
    }
    map
}

/// 各字形的落笔点（UTF-16 下标 → x）归到码点上：一个码点取它头一个字形的落笔点，
/// 没分到字形的（被连字吃掉）沿用前一个码点的。
#[allow(dead_code)]
pub(crate) fn cp_positions(text: &str, glyph_pos: &[(usize, f64)]) -> Vec<f64> {
    let map = utf16_to_cp(text);
    let n = text.chars().count();
    let mut xs: Vec<Option<f64>> = vec![None; n];
    for &(u16i, x) in glyph_pos {
        if let Some(&cp) = map.get(u16i) {
            if xs[cp].is_none() {
                xs[cp] = Some(x);
            }
        }
    }
    let mut out = Vec::with_capacity(n);
    let mut last = 0.0;
    for v in xs {
        let x = v.unwrap_or(last);
        out.push(x);
        last = x;
    }
    out
}

/// 墨迹盒累加。
#[derive(Default)]
#[allow(dead_code)]
pub(crate) struct Ink {
    pub any: bool,
    pub l: f64,
    pub t: f64,
    pub r: f64,
    pub b: f64,
}

#[allow(dead_code)]
impl Ink {
    pub fn add(&mut self, l: f64, t: f64, r: f64, b: f64) {
        if !self.any {
            *self = Ink { any: true, l, t, r, b };
        } else {
            self.l = self.l.min(l);
            self.t = self.t.min(t);
            self.r = self.r.max(r);
            self.b = self.b.max(b);
        }
    }
    pub fn into_measured(self, width: f64, xs: Vec<f64>) -> Measured {
        Measured { width, ink: self.any, left: self.l, top: self.t, right: self.r, bottom: self.b, xs }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::{FontStyle, TextMeasurer, Weight};

    #[test]
    fn pingfang_digit() {
        let b = node_measure(None, &[]);
        let m = b.glyph("1", "sans-serif", 28.0, Weight::Normal, &[], FontStyle::Normal);
        assert!(m.width > 10.0 && m.width < 20.0, "{m:?}");
        // 1/64 取整
        assert_eq!((m.width * 64.0).fract(), 0.0);
        assert!(m.bbox.top < 0.0 && m.bbox.bottom <= 1.0);
    }
}
