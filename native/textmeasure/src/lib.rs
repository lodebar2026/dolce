//! Node 侧排版量字：同步 N-API 外壳。系统文字引擎本体在 `crates/dolce-text-native`（macOS CoreText / Windows DirectWrite），
//! Rust 排版与这里用同一份；其它平台不编这个模块，TS 侧（`src/cli/textmeasure.node.ts`）退回 fontkit 后端。
//!
//! 坐标口径同 `src/common/measure.ts`：基线 y = 0、向下为正，单位 px（= 字号的单位）。

#[macro_use]
extern crate napi_derive;

use dolce_text::SystemText;
use dolce_text_native::NativeText;

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
    let m = NativeText.measure(&text, &families, size, bold, italic, &features);
    Measured { width: m.width, ink: m.ink, left: m.left, top: m.top, right: m.right, bottom: m.bottom, xs: m.xs }
}

#[napi]
pub fn font_metrics(families: Vec<String>, size: f64, bold: bool, italic: bool) -> Metrics {
    let m = NativeText.font_metrics(&families, size, bold, italic);
    Metrics { ascent: m.ascent, descent: m.descent, family: m.family }
}

/// 一串字的字形轮廓（SVG path `d`，落笔点在原点、基线 y = 0、向下为正），字体选择与回退同 `measure`。
/// Node 侧出位图前把 `<text>` 换成路径用（不靠栅格化器自己找字体）。
#[napi]
pub fn outline(text: String, families: Vec<String>, size: f64, bold: bool, italic: bool, features: Vec<String>) -> String {
    NativeText.outline(&text, &families, size, bold, italic, &features)
}

/// 注册一个不在系统里的字体文件（Bravura 等），只对本进程有效。成功返回 true（已注册过也算成功）。
#[napi]
pub fn register_font(path: String) -> bool {
    NativeText.register_font(&path)
}

/// 这个族在系统里有没有（不回退到别的字体）。
#[napi]
pub fn has_family(family: String) -> bool {
    NativeText.has_family(&family)
}

/// 调试：族名 → CoreText / DirectWrite 实际解析到的字体（PostScript 名）。
#[napi]
pub fn resolve_name(family: String) -> String {
    NativeText.resolve_name(&family)
}
