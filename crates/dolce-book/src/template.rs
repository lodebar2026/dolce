//! 成书那一路的模板件（照 `src/pdflayout/booktemplate.ts`）：模板排版结果 → DrawList 图元，外加 `key-meter()` 组件
//! （调号 + 叠排拍号 + 避让首行）。模板排版本身在 `dolce_style::template`。
//!
//! [`BookRegionEnv`] 是 dev `rebuild.mjs::regionEnv` 那份环境（字段经 `songFields(undefined, fields)`、字号取本曲回传或样式表、
//! 书级量字、`key-meter` 组件），整本那一层（`rebuild`）与对拍共用。

use crate::draw::DrawItem;
use crate::measure::BookMeasure;
use crate::parts::{key_meter_items, role_size, text_item, KeyMeterSpec};
use dolce_style::ss::{parse_avoid, Cell, SsError};
use dolce_style::template::{song_field, ComponentCall, FieldExtra, FieldValue, Placed, RegionEnv};
use indexmap::IndexMap;
use serde_json::Value;

/// 模板排出来的东西 → DrawList 图元（`placedToDrawItems`）：文字走 `text_item`，组件产出的原样图元按 DrawItem 读回。
pub fn placed_to_draw_items(placed: &[Placed]) -> Result<Vec<DrawItem>, serde_json::Error> {
    placed
        .iter()
        .map(|p| match p {
            Placed::Raw { item } => serde_json::from_value(item.clone()),
            Placed::Text(t) => Ok(DrawItem::Text(text_item(t.text.as_str(), &t.role, t.size, t.x, t.y, &t.align))),
        })
        .collect()
}

/// `key-meter()` 组件（`keyMeterComponent`）：调号拍号，格上写了 `avoid` 就按本曲首行那一带的和弦 / 音符墨迹顶兜底上抬。
pub struct KeyMeterComponent<'a> {
    pub style: &'a Value,
    pub measure: &'a dyn BookMeasure,
    pub km: Option<KeyMeterSpec>,
    /// 本页已有的图元（避让要看首行）
    pub page_items: &'a [DrawItem],
    pub size: Option<f64>,
}

struct InkBox {
    x0: f64,
    x1: f64,
    bot: f64,
}

impl KeyMeterComponent<'_> {
    pub fn call(&self, x: f64, y: f64, cell: &Cell) -> Result<Vec<DrawItem>, SsError> {
        let Some(km) = &self.km else { return Ok(vec![]) };
        let mut items = key_meter_items(self.style, km, x, y, self.measure, self.size);
        let Some(avoid) = cell.props.get("avoid") else { return Ok(items) };
        let av = parse_avoid(avoid, None)?;
        let box_of = |it: &DrawItem| -> InkBox {
            let (x0, w, bot) = match it {
                DrawItem::Rect(r) => (r.x, r.w, r.y + r.h),
                DrawItem::Text(t) => {
                    let x0 = t.xs.first().copied().or(t.ink_box.map(|b| b.x)).unwrap_or(0.0);
                    (x0, self.measure.advance(&t.role, &t.text, t.size), t.y)
                }
                _ => (0.0, 0.0, 0.0),
            };
            InkBox { x0, x1: x0 + w, bot }
        };
        let km_boxes: Vec<InkBox> = items.iter().map(box_of).collect();
        let km_bot = km_boxes.iter().map(|b| b.bot).fold(f64::NEG_INFINITY, dolce_model::base::js::max);
        let mut need = 0.0;
        for it in self.page_items {
            let DrawItem::Text(t) = it else { continue };
            if !av.roles.contains(&t.role) {
                continue;
            }
            let x0 = t.xs.first().copied().unwrap_or(0.0);
            let x1 = x0 + self.measure.advance(&t.role, &t.text, t.size);
            let top = t.y - t.size * 0.72;
            if top < y || top > y + av.scan {
                continue;
            }
            if top > km_bot || !km_boxes.iter().any(|b| b.x1 > x0 && b.x0 < x1 && b.bot > top) {
                continue;
            }
            need = dolce_model::base::js::max(need, km_bot - top + av.gap);
        }
        for it in &mut items {
            match it {
                DrawItem::Text(t) => t.y -= need,
                DrawItem::Rect(r) => r.y -= need,
                _ => {}
            }
        }
        Ok(items)
    }
}

/// 成书模板排版的环境（dev `rebuild.mjs::regionEnv`）
pub struct BookRegionEnv<'a> {
    pub style: &'a Value,
    pub measure: &'a dyn BookMeasure,
    /// `songFields(undefined, fields)` 的 `fields`
    pub fields: IndexMap<String, Option<FieldExtra>>,
    pub page_no: f64,
    /// 版心左右缘
    pub content: (f64, f64),
    pub dy: f64,
    /// 本曲排版回传的各角色字号（`ctx.sizes`）；没有的取样式表
    pub sizes: IndexMap<String, f64>,
    /// 有它才认 `key-meter()`
    pub key_meter: Option<KeyMeterComponent<'a>>,
}

impl RegionEnv for BookRegionEnv<'_> {
    fn field(&self, path: &str) -> Option<Vec<FieldValue>> {
        song_field(None, &self.fields, path)
    }
    fn page_no(&self) -> f64 {
        self.page_no
    }
    fn content(&self) -> (f64, f64) {
        self.content
    }
    fn dy(&self) -> Option<f64> {
        Some(self.dy)
    }
    fn size_of(&self, role: &str) -> f64 {
        self.sizes.get(role).copied().unwrap_or_else(|| role_size(self.style, role))
    }
    fn measure(&self, role: &str, text: &str, size: f64) -> f64 {
        self.measure.advance(role, text, size)
    }
    fn component(&self, name: &str, call: &ComponentCall) -> Option<Result<Vec<Value>, SsError>> {
        if name != "key-meter" {
            return None;
        }
        let km = self.key_meter.as_ref()?;
        Some(km.call(call.x, call.y, call.cell).map(|v| v.into_iter().map(|it| serde_json::to_value(it).expect("图元转 JSON")).collect()))
    }
}
