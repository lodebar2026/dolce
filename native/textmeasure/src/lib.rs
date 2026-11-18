//! Node 侧排版量字：同步 N-API 外壳。系统文字引擎本体在 `crates/dolce-text-native`（macOS CoreText / Windows DirectWrite），
//! 浏览器口径层在 `crates/dolce-text`（`BrowserCompat`），Rust 排版与这里用同一份。只编 macOS / Windows。
//!
//! 两组接口：
//! - `compat*`：排版用的量字（`dolce_text_native::node_measure`，Chromium 口径：CSS 族串展开、单字宽取 1/64、全角标点挤压、f32），
//!   TS 侧 `src/cli/textmeasure.node.ts` 只是把它接成 `MeasureBackend`（Node 里的 dolce-wasm 回调它）；
//! - 其余：系统文字引擎原样（具体族名列表、不套口径），冒烟测试与排查用。
//!
//! 坐标口径同 `src/common/measure.ts`：基线 y = 0、向下为正，单位 px（= 字号的单位）。

#[macro_use]
extern crate napi_derive;

use dolce_text::{BrowserCompat, FontStyle, SystemText, TextMeasurer, Weight};
use dolce_text_native::NativeText;
use std::cell::RefCell;

thread_local! {
    /// 当前的口径层（`compatInit` 装；Node 主线程一份）
    static COMPAT: RefCell<Option<BrowserCompat<NativeText>>> = const { RefCell::new(None) };
}

fn with_compat<R>(f: impl FnOnce(&BrowserCompat<NativeText>) -> R) -> R {
    COMPAT.with(|c| {
        let mut c = c.borrow_mut();
        let b = c.get_or_insert_with(|| dolce_text_native::node_measure(None, &[]));
        f(b)
    })
}

const fn weight(bold: bool) -> Weight {
    if bold {
        Weight::Bold
    } else {
        Weight::Normal
    }
}

const fn style(italic: bool) -> FontStyle {
    if italic {
        FontStyle::Italic
    } else {
        FontStyle::Normal
    }
}

/// 装口径层：注册 `redist` 目录下的仓库字体（Bravura 两支）与 `files`（族名 → 字体文件路径，成书注册的字体）。再调一次即换一份（缓存随之作废）。
#[napi]
pub fn compat_init(redist: String, files: Vec<Vec<String>>) {
    let files: Vec<(String, String)> = files.into_iter().filter_map(|f| Some((f.first()?.clone(), f.get(1)?.clone()))).collect();
    let b = dolce_text_native::node_measure(Some(std::path::Path::new(&redist)), &files);
    COMPAT.with(|c| *c.borrow_mut() = Some(b));
}

/// 一串字的 advance 与墨迹盒：`[width, left, top, right, bottom]`（没有墨四边为 0）。`family` 是 CSS 族串，`features` 空 = 不开。
#[napi]
pub fn compat_glyph(text: String, family: String, size: f64, bold: bool, features: Vec<String>, italic: bool) -> Vec<f64> {
    let m = with_compat(|b| b.glyph(&text, &family, size, weight(bold), &features, style(italic)));
    vec![m.width, m.bbox.left, m.bbox.top, m.bbox.right, m.bbox.bottom]
}

/// 逐码点落笔点，末尾一项是总宽。
#[napi]
pub fn compat_positions(text: String, family: String, size: f64, bold: bool, features: Vec<String>) -> Vec<f64> {
    let p = with_compat(|b| b.positions(&text, &family, size, weight(bold), &features));
    let mut out = p.xs;
    out.push(p.width);
    out
}

/// 字体全局度量 `[ascent(负), descent(正)]`（浏览器取整与修正之后）。
#[napi]
pub fn compat_font_metrics(family: String, size: f64, bold: bool, italic: bool) -> Vec<f64> {
    let m = with_compat(|b| b.font_metrics(&family, size, weight(bold), style(italic)));
    vec![m.ascent, m.descent]
}

/// SVG 路径 `d` 的紧包围盒 `[left, top, right, bottom]`。
#[napi]
pub fn compat_path_bounds(d: String) -> Vec<f64> {
    let r = with_compat(|b| b.path_bounds(&d));
    vec![r.left, r.top, r.right, r.bottom]
}

/// 一串字的轮廓（SVG path `d`，落笔点在原点、基线 y = 0），字体选择同量字（CSS 族串）。
#[napi]
pub fn compat_outline(text: String, family: String, size: f64, bold: bool, italic: bool) -> String {
    with_compat(|b| b.outline(&text, &family, size, bold, italic))
}

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
