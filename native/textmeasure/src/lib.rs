//! Node 侧排版量字：同步 N-API，按平台走系统文字引擎（字体匹配、逐字回退、OpenType 特性、字形轮廓都由系统给）。
//!   - macOS：CoreText（`mac.rs`）
//!   - Windows：DirectWrite（`win.rs`）
//! 其它平台不编这个模块，TS 侧（`src/common/measure.native.ts`）退回 fontkit 后端。
//!
//! 坐标口径同 `src/common/measure.ts`：基线 y = 0、向下为正，单位 px（= 字号的单位）。

#[macro_use]
extern crate napi_derive;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
use mac as sys;

#[cfg(target_os = "windows")]
mod win;
#[cfg(target_os = "windows")]
use win as sys;

/// 一串字的量法结果。
#[napi(object)]
pub struct Measured {
    /// 总 advance
    pub width: f64,
    /// 墨迹盒（相对落笔点）；没有墨（空白）时 `ink` 为 false、四边为 0
    pub ink: bool,
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    /// 每个**码点**的落笔点（shaping 之后，含特性的挤压）
    pub xs: Vec<f64>,
}

/// 字体全局度量（首个可用的族）。
#[napi(object)]
pub struct Metrics {
    /// 基线以上，正值
    pub ascent: f64,
    /// 基线以下，正值
    pub descent: f64,
    /// 实际用到的族名（浏览器对个别族有度量修正，TS 侧按名判）
    pub family: String,
}

/// `families` 是已经展开泛称的具体族名（按序，前面的优先，缺字逐字回退到后面的再到系统回退）。
/// `features` 是要开的 OpenType 特性（`chws`、`halt`）。
#[napi]
pub fn measure(text: String, families: Vec<String>, size: f64, bold: bool, italic: bool, features: Vec<String>) -> Measured {
    sys::measure(&text, &families, size, bold, italic, &features)
}

#[napi]
pub fn font_metrics(families: Vec<String>, size: f64, bold: bool, italic: bool) -> Metrics {
    sys::font_metrics(&families, size, bold, italic)
}

/// 一串字的字形轮廓（SVG path `d`，落笔点在原点、基线 y = 0、向下为正），字体选择与回退同 `measure`。
/// Node 侧出位图前把 `<text>` 换成路径用（不靠栅格化器自己找字体）。
#[napi]
pub fn outline(text: String, families: Vec<String>, size: f64, bold: bool, italic: bool, features: Vec<String>) -> String {
    sys::outline(&text, &families, size, bold, italic, &features)
}

/// 注册一个不在系统里的字体文件（Bravura 等），只对本进程有效。成功返回 true（已注册过也算成功）。
#[napi]
pub fn register_font(path: String) -> bool {
    sys::register_font(&path)
}

/// 这个族在系统里有没有（不回退到别的字体）。
#[napi]
pub fn has_family(family: String) -> bool {
    sys::has_family(&family)
}

/// 调试：族名 → CoreText / DirectWrite 实际解析到的字体（PostScript 名）。
#[napi]
pub fn resolve_name(family: String) -> String {
    sys::resolve_name(&family)
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
pub(crate) struct Ink {
    pub any: bool,
    pub l: f64,
    pub t: f64,
    pub r: f64,
    pub b: f64,
}

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
