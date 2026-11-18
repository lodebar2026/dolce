//! 量字回放：TS 排版时录下的后端调用（`measure.jsonl`，一行一条，见 dev `layout-ref.mjs`）原样答回去。
//! 迁移期用它把「排版逻辑差」与「量字差」分开：Rust 排版吃回放，结果就该与 TS 逐位相同（开发门 ≤ 1e-6）。
//!
//! 录的是 `setMeasureBackend` 装上的那一层（浏览器口径层之上、`measure.ts` 缓存之下），键同 TS 缓存键。
//! 没录到的调用记进 [`ReplayMeasurer::misses`]、答 0——调用方跑完查它，不在半路抛。

use std::cell::RefCell;
use std::collections::HashMap;

use dolce_base::geom::Rect;
use serde::{Deserialize, Serialize};

use crate::{feature_settings, FontMetrics, FontStyle, Positions, TextMeasurer, TextMetrics, Weight};

/// 一条录下的后端调用与结果。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum MeasureRecord {
    Glyph {
        text: String,
        family: String,
        size: f64,
        weight: Weight,
        #[serde(default)]
        features: Vec<String>,
        style: FontStyle,
        width: f64,
        bbox: Rect,
    },
    Positions {
        text: String,
        family: String,
        size: f64,
        weight: Weight,
        #[serde(default)]
        features: Vec<String>,
        xs: Vec<f64>,
        width: f64,
    },
    FontMetrics {
        family: String,
        size: f64,
        weight: Weight,
        style: FontStyle,
        ascent: f64,
        descent: f64,
    },
    PathBounds {
        d: String,
        bbox: Rect,
    },
}

fn num(x: f64) -> String {
    dolce_base::js::num_to_string(x)
}

fn glyph_key(text: &str, family: &str, size: f64, weight: Weight, features: &[String], style: FontStyle) -> String {
    format!("g\x01{family}\x01{}\x01{}\x01{}\x01{}\x01{text}", weight.as_str(), style.as_str(), num(size), feature_settings(features))
}
fn pos_key(text: &str, family: &str, size: f64, weight: Weight, features: &[String]) -> String {
    format!("p\x01{family}\x01{}\x01{}\x01{}\x01{text}", weight.as_str(), num(size), feature_settings(features))
}
fn fm_key(family: &str, size: f64, weight: Weight, style: FontStyle) -> String {
    format!("m\x01{family}\x01{}\x01{}\x01{}", weight.as_str(), style.as_str(), num(size))
}

impl MeasureRecord {
    /// 回放表里的键（同一调用两边同键）。
    pub fn key(&self) -> String {
        match self {
            MeasureRecord::Glyph { text, family, size, weight, features, style, .. } => glyph_key(text, family, *size, *weight, features, *style),
            MeasureRecord::Positions { text, family, size, weight, features, .. } => pos_key(text, family, *size, *weight, features),
            MeasureRecord::FontMetrics { family, size, weight, style, .. } => fm_key(family, *size, *weight, *style),
            MeasureRecord::PathBounds { d, .. } => format!("d\x01{d}"),
        }
    }

    /// 拿另一个后端把同一调用再量一遍（原生对 TS 录的那份逐键比）。
    pub fn remeasure(&self, b: &dyn TextMeasurer) -> MeasureRecord {
        match self.clone() {
            MeasureRecord::Glyph { text, family, size, weight, features, style, .. } => {
                let m = b.glyph(&text, &family, size, weight, &features, style);
                MeasureRecord::Glyph { text, family, size, weight, features, style, width: m.width, bbox: m.bbox }
            }
            MeasureRecord::Positions { text, family, size, weight, features, .. } => {
                let p = b.positions(&text, &family, size, weight, &features);
                MeasureRecord::Positions { text, family, size, weight, features, xs: p.xs, width: p.width }
            }
            MeasureRecord::FontMetrics { family, size, weight, style, .. } => {
                let m = b.font_metrics(&family, size, weight, style);
                MeasureRecord::FontMetrics { family, size, weight, style, ascent: m.ascent, descent: m.descent }
            }
            MeasureRecord::PathBounds { d, .. } => {
                let bbox = b.path_bounds(&d);
                MeasureRecord::PathBounds { d, bbox }
            }
        }
    }

    /// 结果的数（比对用，按字段次序）。
    pub fn values(&self) -> Vec<f64> {
        match self {
            MeasureRecord::Glyph { width, bbox, .. } => vec![*width, bbox.left, bbox.top, bbox.right, bbox.bottom],
            MeasureRecord::Positions { xs, width, .. } => {
                let mut v = vec![*width];
                v.extend_from_slice(xs);
                v
            }
            MeasureRecord::FontMetrics { ascent, descent, .. } => vec![*ascent, *descent],
            MeasureRecord::PathBounds { bbox, .. } => vec![bbox.left, bbox.top, bbox.right, bbox.bottom],
        }
    }
}

/// 回放后端。
#[derive(Default)]
pub struct ReplayMeasurer {
    table: HashMap<String, MeasureRecord>,
    misses: RefCell<Vec<String>>,
    /// 路径盒没录到时照 TS 后端同一算式现算（[`crate::browser_path_bounds`]），不记作未录到
    path_fallback: bool,
    path_fallbacks: std::cell::Cell<usize>,
}

impl ReplayMeasurer {
    pub fn new(records: impl IntoIterator<Item = MeasureRecord>) -> Self {
        let table = records.into_iter().map(|r| (r.key(), r)).collect();
        ReplayMeasurer { table, ..Default::default() }
    }

    /// 路径盒没录到时现算。TS 的 Node 后端路径盒本就是纯算（`f32(pathBounds(d))`），录的键是 `d` 串——
    /// 弧的坐标经 `cos` / `atan2` / `log10`，Rust 与 V8 末位可能不同，串就对不上；现算与回放同一算式，不掩盖排版差。
    pub fn with_path_fallback(mut self) -> Self {
        self.path_fallback = true;
        self
    }

    /// 走了现算的路径盒次数。
    pub fn path_fallbacks(&self) -> usize {
        self.path_fallbacks.get()
    }

    /// 读 `measure.jsonl`（空行跳过）。
    pub fn from_jsonl(text: &str) -> Result<Self, serde_json::Error> {
        let mut recs = Vec::new();
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            recs.push(serde_json::from_str::<MeasureRecord>(line)?);
        }
        Ok(Self::new(recs))
    }

    pub fn len(&self) -> usize {
        self.table.len()
    }
    pub fn is_empty(&self) -> bool {
        self.table.is_empty()
    }

    /// 没录到的调用（键，可读化：`\x01` 换成 `|`）。
    pub fn misses(&self) -> Vec<String> {
        self.misses.borrow().iter().map(|k| k.replace('\x01', "|")).collect()
    }

    fn get(&self, key: String) -> Option<&MeasureRecord> {
        let hit = self.table.get(&key);
        if hit.is_none() {
            self.misses.borrow_mut().push(key);
        }
        hit
    }
}

impl TextMeasurer for ReplayMeasurer {
    fn glyph(&self, text: &str, family: &str, size: f64, weight: Weight, features: &[String], style: FontStyle) -> TextMetrics {
        match self.get(glyph_key(text, family, size, weight, features, style)) {
            Some(MeasureRecord::Glyph { width, bbox, .. }) => TextMetrics { width: *width, bbox: *bbox },
            _ => TextMetrics::default(),
        }
    }
    fn positions(&self, text: &str, family: &str, size: f64, weight: Weight, features: &[String]) -> Positions {
        match self.get(pos_key(text, family, size, weight, features)) {
            Some(MeasureRecord::Positions { xs, width, .. }) => Positions { xs: xs.clone(), width: *width },
            _ => Positions::default(),
        }
    }
    fn font_metrics(&self, family: &str, size: f64, weight: Weight, style: FontStyle) -> FontMetrics {
        match self.get(fm_key(family, size, weight, style)) {
            Some(MeasureRecord::FontMetrics { ascent, descent, .. }) => FontMetrics { ascent: *ascent, descent: *descent },
            _ => FontMetrics::default(),
        }
    }
    fn path_bounds(&self, d: &str) -> Rect {
        let key = format!("d\x01{d}");
        if self.path_fallback && !self.table.contains_key(&key) {
            self.path_fallbacks.set(self.path_fallbacks.get() + 1);
            return crate::browser_path_bounds(d);
        }
        match self.get(key) {
            Some(MeasureRecord::PathBounds { bbox, .. }) => *bbox,
            _ => Rect::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MeasureCtx;

    #[test]
    fn replay_roundtrip() {
        let lines = r#"{"op":"glyph","text":"1","family":"PingFang SC","size":12.08,"weight":"normal","features":[],"style":"normal","width":7.03125,"bbox":[0.5,-8.7,4.4,0]}
{"op":"fontMetrics","family":"PingFang SC","size":12.08,"weight":"bold","style":"normal","ascent":-13,"descent":3}
{"op":"pathBounds","d":"M0 0L1 1","bbox":[0,0,1,1]}"#;
        let r = ReplayMeasurer::from_jsonl(lines).unwrap();
        assert_eq!(r.len(), 3);
        let ctx = MeasureCtx::new(&r);
        let m = ctx.glyph_text("1", "PingFang SC", 12.08, Weight::Normal, &[], FontStyle::Normal);
        assert_eq!(m.width, 7.03125);
        assert_eq!(ctx.font_metrics("PingFang SC", 12.08, Weight::Bold, FontStyle::Normal).ascent, -13.0);
        assert_eq!(ctx.path_tight_bounds("M0 0L1 1"), Rect::new(0.0, 0.0, 1.0, 1.0));
        assert!(r.misses().is_empty());
        ctx.glyph_text("2", "PingFang SC", 12.08, Weight::Normal, &[], FontStyle::Normal);
        assert_eq!(r.misses().len(), 1);
    }
}
