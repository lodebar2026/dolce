//! 排版量字层，照 `src/common/measure.ts`（缓存与和后端无关的规则）、`src/pagetree/font.ts`（`Font` 的量法）、
//! `src/cli/textmeasure.node.ts`（浏览器口径层）。
//!
//! 分三层，各自可换：
//! - [`TextMeasurer`]：后端——「这串字在这个字体下多宽、墨在哪」，不缓存。实现有
//!   [`BrowserCompat`]（套在系统文字引擎上，把结果折成浏览器的口径；桌面 / CLI 用 `dolce-text-native` 的 CoreText / DirectWrite）、
//!   [`ReplayMeasurer`]（回放 TS 录下的量字，迁移期把逻辑差与量字差分开），在线版将来是 wasm 导入的浏览器量法；
//! - [`MeasureCtx`]：一次排版贯穿两引擎的量字上下文——按键缓存、`chws` 探测、挤压后的逐字笔位（取代 TS 全局的 `setMeasureBackend`）；
//! - [`Font`]：族串 + 字号 + 粗斜，量法都经 `MeasureCtx`。
//!
//! 坐标口径：基线 y = 0、向下为正，单位 px（= 字号的单位）。

use std::cell::RefCell;
use std::collections::HashMap;

use dolce_geom::Rect;
use serde::{Deserialize, Serialize};

pub mod cjkpunct;
mod compat;
mod replay;
pub mod syllable;

pub use cjkpunct::CompressMode;
pub use compat::{browser_path_bounds, css_families, han_kern_shifts, BrowserCompat, Engine, Measured, Platform, RawFontMetrics, SystemText};
pub use replay::{MeasureRecord, ReplayMeasurer};

use cjkpunct::{code_points, compress_run, pair_trim_px, trim_left, SlackLR};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Weight {
    #[default]
    Normal,
    Bold,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FontStyle {
    #[default]
    Normal,
    Italic,
}

impl Weight {
    pub fn as_str(self) -> &'static str {
        match self {
            Weight::Normal => "normal",
            Weight::Bold => "bold",
        }
    }
}
impl FontStyle {
    pub fn as_str(self) -> &'static str {
        match self {
            FontStyle::Normal => "normal",
            FontStyle::Italic => "italic",
        }
    }
}

/// 一串字的 advance 与墨迹盒（相对落笔点，基线 y = 0）。
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct TextMetrics {
    pub width: f64,
    pub bbox: Rect,
}

/// 逐码点落笔点与总宽。
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Positions {
    pub xs: Vec<f64>,
    pub width: f64,
}

/// 字体全局 ascent（负，基线以上）/ descent（正）。
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct FontMetrics {
    pub ascent: f64,
    pub descent: f64,
}

/// 量字后端（`MeasureBackend`）。`features` 为空 = 不开特性（TS 的 `undefined` 与 `[]` 同义）。
pub trait TextMeasurer {
    fn glyph(&self, text: &str, family: &str, size: f64, weight: Weight, features: &[String], style: FontStyle) -> TextMetrics;
    fn positions(&self, text: &str, family: &str, size: f64, weight: Weight, features: &[String]) -> Positions;
    fn font_metrics(&self, family: &str, size: f64, weight: Weight, style: FontStyle) -> FontMetrics;
    fn path_bounds(&self, d: &str) -> Rect;
}

/// JS `\s`（码点级）。
fn is_js_space(c: char) -> bool {
    dolce_base::js::is_space(c)
}

/// SVG `<text>` 的空白折叠（`svgCollapsedText`）：ASCII 空格、制表、换行连成一段折成一个空格，去掉串首串尾那一个；
/// 整串都是空白（JS `\s`，含不换行空格、全角空格）的不折。
pub fn svg_collapsed_text(text: &str) -> String {
    if !text.is_empty() && text.chars().all(is_js_space) {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut in_ws = false;
    for c in text.chars() {
        if matches!(c, ' ' | '\t' | '\n' | '\r') {
            if !in_ws {
                out.push(' ');
                in_ws = true;
            }
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    let s = out.strip_prefix(' ').unwrap_or(&out);
    let s = s.strip_suffix(' ').unwrap_or(s);
    s.to_string()
}

/// 横排标点挤压（上下文）。
pub const CHWS: &str = "chws";
/// 无条件半角标点。
pub const HALT: &str = "halt";
/// 伪特性「不做字距调整」：WebKit 的 SVG 文字不 kern（`BrowserCompat` 在 WebKit 口径下给每次量字带上），
/// 系统后端见到它就去掉、改关字距（CoreText `kCTKernAttributeName = 0`）。不是 OpenType 特性，不进 `font-feature-settings`。
pub const NO_KERN: &str = "-kern";

/// 拆出 [`NO_KERN`]：(要不要关字距, 余下的真特性)。
pub fn split_no_kern(features: &[String]) -> (bool, Vec<String>) {
    let off = features.iter().any(|f| f == NO_KERN);
    (off, features.iter().filter(|f| *f != NO_KERN).cloned().collect())
}

/// 挤压档 → OpenType 特性。
pub fn features_for(mode: CompressMode) -> Vec<String> {
    match mode {
        CompressMode::Halfwidth => vec![HALT.into()],
        CompressMode::Clreq => vec![CHWS.into()],
        CompressMode::None => vec![],
    }
}

/// CSS `font-feature-settings` 写法（也当缓存键）。
pub fn feature_settings(features: &[String]) -> String {
    features.iter().map(|f| format!("\"{f}\" 1")).collect::<Vec<_>>().join(", ")
}

fn size_key(size: f64) -> String {
    dolce_base::js::num_to_string(size)
}

/// 一次排版的量字上下文：后端 + 按键缓存（`measure.ts` 的四张缓存表）。
pub struct MeasureCtx<'a> {
    backend: &'a dyn TextMeasurer,
    text_cache: RefCell<HashMap<String, TextMetrics>>,
    path_cache: RefCell<HashMap<String, Rect>>,
    metrics_cache: RefCell<HashMap<String, FontMetrics>>,
    feature_cache: RefCell<HashMap<String, bool>>,
}

impl<'a> MeasureCtx<'a> {
    pub fn new(backend: &'a dyn TextMeasurer) -> Self {
        MeasureCtx {
            backend,
            text_cache: RefCell::default(),
            path_cache: RefCell::default(),
            metrics_cache: RefCell::default(),
            feature_cache: RefCell::default(),
        }
    }

    pub fn backend(&self) -> &dyn TextMeasurer {
        self.backend
    }

    /// 字体变了以后，之前量的数作废。
    pub fn clear(&self) {
        self.text_cache.borrow_mut().clear();
        self.path_cache.borrow_mut().clear();
        self.metrics_cache.borrow_mut().clear();
        self.feature_cache.borrow_mut().clear();
    }

    /// `measureGlyphText`（features 进键：开不开 `chws` 宽度不同）。
    pub fn glyph_text(&self, text: &str, family: &str, size: f64, weight: Weight, features: &[String], style: FontStyle) -> TextMetrics {
        let key = format!(
            "{family}\x01{}\x01{}\x01{}\x01{}\x01{text}",
            weight.as_str(),
            style.as_str(),
            size_key(size),
            feature_settings(features)
        );
        if let Some(m) = self.text_cache.borrow().get(&key) {
            return *m;
        }
        let m = self.backend.glyph(text, family, size, weight, features, style);
        self.text_cache.borrow_mut().insert(key, m);
        m
    }

    /// `pathTightBounds`。
    pub fn path_tight_bounds(&self, d: &str) -> Rect {
        if let Some(r) = self.path_cache.borrow().get(d) {
            return *r;
        }
        let r = self.backend.path_bounds(d);
        self.path_cache.borrow_mut().insert(d.to_string(), r);
        r
    }

    /// `measureFontMetrics`。
    pub fn font_metrics(&self, family: &str, size: f64, weight: Weight, style: FontStyle) -> FontMetrics {
        let key = format!("{family}\x01{}\x01{}\x01{}", weight.as_str(), style.as_str(), size_key(size));
        if let Some(m) = self.metrics_cache.borrow().get(&key) {
            return *m;
        }
        let m = self.backend.font_metrics(family, size, weight, style);
        self.metrics_cache.borrow_mut().insert(key, m);
        m
    }

    /// `slackOf`：一个字两侧的实际留白（advance 减墨迹）。
    pub fn slack(&self, ch: &str, family: &str, size: f64, weight: Weight) -> SlackLR {
        let m = self.glyph_text(ch, family, size, weight, &[], FontStyle::Normal);
        SlackLR { left: m.bbox.left, right: m.width - m.bbox.right }
    }

    /// `hasFontFeature`：开 / 关同一样本串比 advance。缓存键只有族与特性（不含字号，同 TS）。
    pub fn has_font_feature(&self, family: &str, feature: &str, size: f64) -> bool {
        self.has_font_feature_sample(family, feature, size, "：“")
    }

    pub fn has_font_feature_sample(&self, family: &str, feature: &str, size: f64, sample: &str) -> bool {
        let key = format!("{family}\x01{feature}");
        if let Some(&v) = self.feature_cache.borrow().get(&key) {
            return v;
        }
        let on = self.glyph_text(sample, family, size, Weight::Normal, &[feature.to_string()], FontStyle::Normal).width;
        let off = self.glyph_text(sample, family, size, Weight::Normal, &[], FontStyle::Normal).width;
        let res = (on - off).abs() > 0.01;
        self.feature_cache.borrow_mut().insert(key, res);
        res
    }

    /// `measureGlyphRun`：挤压后的逐码点笔位与总宽。
    pub fn glyph_run(&self, text: &str, family: &str, size: f64, weight: Weight, mode: CompressMode) -> Positions {
        let chars = code_points(text);
        if chars.is_empty() {
            return Positions::default();
        }
        let features = features_for(mode);
        let use_feature = !features.is_empty() && features.iter().any(|f| self.has_font_feature(family, f, size));
        if !use_feature {
            let adv = |ch: &str| self.glyph_text(ch, family, size, weight, &[], FontStyle::Normal).width;
            let slack = |ch: &str| self.slack(ch, family, size, weight);
            let (xs, width) = compress_run(&chars, &adv, size, mode, Some(&slack));
            return Positions { xs, width };
        }
        let Positions { mut xs, width } = self.backend.positions(text, family, size, weight, &features);
        // 起始类标点把笔位往左挪回压掉的那截（绘制端画的是全宽字形），见 TS 注释
        for (i, ch) in chars.iter().enumerate() {
            if trim_left(ch) <= 0.0 {
                continue;
            }
            let next = if i + 1 < chars.len() { xs[i + 1] } else { width };
            let feat_adv = next - xs[i];
            let full_adv = self.glyph_text(ch, family, size, weight, &[], FontStyle::Normal).width;
            if full_adv - feat_adv > 0.5 {
                xs[i] -= full_adv - feat_adv;
            }
        }
        Positions { xs, width }
    }

    /// `punctTrim`：相邻两字之间该压掉多少 px——标点挤压的唯一出口。
    pub fn punct_trim(&self, prev: &str, next: &str, family: &str, size: f64, weight: Weight, mode: CompressMode) -> f64 {
        if prev.is_empty() || next.is_empty() || mode == CompressMode::None {
            return 0.0;
        }
        let features = features_for(mode);
        if features.iter().any(|f| self.has_font_feature(family, f, size)) {
            let w = |s: &str| self.glyph_text(s, family, size, weight, &features, FontStyle::Normal).width;
            let joined = format!("{prev}{next}");
            return dolce_base::js::max(0.0, w(prev) + w(next) - w(&joined));
        }
        let slack = |ch: &str| self.slack(ch, family, size, weight);
        pair_trim_px(mode, prev, next, size, Some(&slack))
    }
}

/// 字体：CSS 族串 + 字号（+ 粗 / 斜），照 `pagetree/font.ts`。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Font {
    pub family: String,
    pub size: f64,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
}

impl Font {
    pub fn new(family: impl Into<String>, size: f64) -> Font {
        Font { family: family.into(), size, bold: false, italic: false }
    }
    pub fn weight(&self) -> Weight {
        if self.bold {
            Weight::Bold
        } else {
            Weight::Normal
        }
    }
    pub fn style(&self) -> FontStyle {
        if self.italic {
            FontStyle::Italic
        } else {
            FontStyle::Normal
        }
    }
    pub fn scaled(&self, sc: f64) -> Font {
        Font { size: self.size * sc, ..self.clone() }
    }
    pub fn with_size(&self, sz: f64) -> Font {
        Font { size: sz, ..self.clone() }
    }
    pub fn with_bold(&self) -> Font {
        Font { bold: true, ..self.clone() }
    }

    /// advance（空串 0）。
    pub fn measure_text(&self, ctx: &MeasureCtx, s: &str) -> f64 {
        if s.is_empty() {
            return 0.0;
        }
        ctx.glyph_text(s, &self.family, self.size, self.weight(), &[], self.style()).width
    }

    /// 挤压后的逐字笔位与总宽（`run`）。
    pub fn run(&self, ctx: &MeasureCtx, s: &str, mode: CompressMode) -> Positions {
        if s.is_empty() {
            return Positions::default();
        }
        ctx.glyph_run(s, &self.family, self.size, self.weight(), mode)
    }

    pub fn punct_trim(&self, ctx: &MeasureCtx, prev: &str, next: &str, mode: CompressMode) -> f64 {
        ctx.punct_trim(prev, next, &self.family, self.size, self.weight(), mode)
    }

    /// 紧墨迹盒（`charBound`）。
    pub fn char_bound(&self, ctx: &MeasureCtx, ch: &str) -> Rect {
        ctx.glyph_text(ch, &self.family, self.size, self.weight(), &[], self.style()).bbox
    }

    /// 墨迹横向中心（相对落笔点）。
    pub fn ink_center(&self, ctx: &MeasureCtx, ch: &str) -> f64 {
        let b = self.char_bound(ctx, ch);
        (b.left + b.right) / 2.0
    }

    /// 字体全局 ascent / descent。
    pub fn metrics(&self, ctx: &MeasureCtx) -> FontMetrics {
        ctx.font_metrics(&self.family, self.size, self.weight(), self.style())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapse() {
        assert_eq!(svg_collapsed_text("  a \t\n b  "), "a b");
        assert_eq!(svg_collapsed_text("   "), "   ");
        assert_eq!(svg_collapsed_text("\u{3000}"), "\u{3000}");
        assert_eq!(svg_collapsed_text(""), "");
        assert_eq!(svg_collapsed_text("a\u{3000} b"), "a\u{3000} b");
    }
}
