//! 排版（H 期）：两条引擎经 `dolce_layout::layout` 排好，结果留在 wasm 里（[`Layout`] 句柄），TS 按页取 SVG、身份表、场景。
//!
//! 量字由宿主给（[`setLayoutHost`]）：网页是浏览器量字（`common/measure.browser.ts`，含 WebKit 逐像素墨迹），
//! Node 门面是 `cli/textmeasure.node.ts` 那份（系统文字引擎 + 浏览器口径层）。缓存在 Rust 的 `MeasureCtx` 里，
//! 键与 TS `measure.ts` 相同；字体载完要清（[`clearMeasureCache`]）。
//!
//! 过边界的量字结果一律是数组：`glyph` → `[advance, l, t, r, b]`、`positions` → `[x0, x1, …, 总宽]`、
//! `fontMetrics` → `[ascent, descent]`、`pathBounds` → `[l, t, r, b]`；特性表用逗号连成一串。

use std::cell::RefCell;

use dolce_engrave::Env;
use dolce_model::base::geom::Rect;
use dolce_model::doc::ScoreDoc;
use dolce_layout::layout::{self, JianpuRequest, Laid, StaffRequest};
use dolce_engrave::scene::smufl::MetaData;
use dolce_engrave::text::{FontMetrics, FontStyle, MeasureCtx, Positions, TextMeasurer, TextMetrics, Weight};
use wasm_bindgen::prelude::*;

use crate::model::{parse, to_json, with_surface};

#[wasm_bindgen]
extern "C" {
    /// TS 侧的量字适配器（`common/dolce.ts::wasmMeasure`）。
    pub type JsMeasure;
    #[wasm_bindgen(method)]
    fn glyph(this: &JsMeasure, text: &str, family: &str, size: f64, bold: bool, features: &str, italic: bool) -> Vec<f64>;
    #[wasm_bindgen(method)]
    fn positions(this: &JsMeasure, text: &str, family: &str, size: f64, bold: bool, features: &str) -> Vec<f64>;
    #[wasm_bindgen(method, js_name = fontMetrics)]
    fn font_metrics(this: &JsMeasure, family: &str, size: f64, bold: bool, italic: bool) -> Vec<f64>;
    #[wasm_bindgen(method, js_name = pathBounds)]
    fn path_bounds(this: &JsMeasure, d: &str) -> Vec<f64>;
}

fn rect(a: &[f64]) -> Rect {
    let at = |i: usize| a.get(i).copied().unwrap_or(f64::NAN);
    Rect { left: at(0), top: at(1), right: at(2), bottom: at(3) }
}

struct JsBackend(JsMeasure);

impl TextMeasurer for JsBackend {
    fn glyph(&self, text: &str, family: &str, size: f64, weight: Weight, features: &[String], style: FontStyle) -> TextMetrics {
        let v = self.0.glyph(text, family, size, weight == Weight::Bold, &features.join(","), style == FontStyle::Italic);
        TextMetrics { width: v.first().copied().unwrap_or(f64::NAN), bbox: rect(v.get(1..).unwrap_or(&[])) }
    }
    fn positions(&self, text: &str, family: &str, size: f64, weight: Weight, features: &[String]) -> Positions {
        let mut xs = self.0.positions(text, family, size, weight == Weight::Bold, &features.join(","));
        let width = xs.pop().unwrap_or(0.0);
        Positions { xs, width }
    }
    fn font_metrics(&self, family: &str, size: f64, weight: Weight, style: FontStyle) -> FontMetrics {
        let v = self.0.font_metrics(family, size, weight == Weight::Bold, style == FontStyle::Italic);
        FontMetrics { ascent: v.first().copied().unwrap_or(0.0), descent: v.get(1).copied().unwrap_or(0.0) }
    }
    fn path_bounds(&self, d: &str) -> Rect {
        rect(&self.0.path_bounds(d))
    }
}

/// 排版宿主：量字上下文与 SMuFL 元数据。设一次就一直用（换宿主时旧的泄漏掉，一次会话至多几次）。
struct Host {
    mc: MeasureCtx<'static>,
    meta: Option<MetaData>,
}

thread_local! {
    // 只存 `'static` 引用、取出即放：排版途中 panic 也不会把 RefCell 留在借出状态
    static HOST: RefCell<Option<&'static Host>> = const { RefCell::new(None) };
}

fn host() -> Result<&'static Host, JsValue> {
    HOST.with(|h| *h.borrow()).ok_or_else(|| crate::js_sys_error("排版宿主还没设（setLayoutHost）"))
}

/// 设排版宿主：量字适配器与 SMuFL 元数据（`bravura_metadata.json` 原文；空串 = 没有，用到 SMuFL 盒的记号时报错）。
#[wasm_bindgen(js_name = setLayoutHost)]
pub fn set_layout_host(measure: JsMeasure, smufl: &str) -> Result<(), JsValue> {
    let meta = if smufl.is_empty() { None } else { Some(MetaData::from_json(smufl).map_err(|e| crate::js_sys_error(&format!("SMuFL 元数据：{e}")))?) };
    let backend: &'static JsBackend = Box::leak(Box::new(JsBackend(measure)));
    let h: &'static Host = Box::leak(Box::new(Host { mc: MeasureCtx::new(backend), meta }));
    HOST.with(|x| *x.borrow_mut() = Some(h));
    Ok(())
}

/// 清量字缓存（网页字体载完、换了字体时；同 TS `clearMeasureCache`）。
#[wasm_bindgen(js_name = clearMeasureCache)]
pub fn clear_measure_cache() {
    if let Some(h) = HOST.with(|h| *h.borrow()) {
        h.mc.clear();
    }
}

fn env(h: &'static Host) -> Env<'static> {
    Env { mc: &h.mc, meta: h.meta.as_ref() }
}

fn fail(e: String) -> JsValue {
    crate::js_sys_error(&e)
}

/// 排好的一份（`ScorePainter` 持有；换结果时由 TS `free()`）。
#[wasm_bindgen]
pub struct Layout(Laid);

#[wasm_bindgen]
impl Layout {
    /// 概要 JSON（`LaidInfo`：路、曲名、各页几何、行首、演唱顺序）。
    pub fn info(&self) -> String {
        to_json(&self.0.info())
    }
    #[wasm_bindgen(js_name = pageCount)]
    pub fn page_count(&self) -> u32 {
        self.0.pages.len() as u32
    }
    /// 第 `i` 页的 SVG（越界回空串）。
    pub fn svg(&self, i: u32) -> String {
        self.0.svg(i as usize).unwrap_or_default()
    }
    /// 第 `i` 页的身份表 JSON（`dolce_engrave::scene::index::Hit` 数组）。
    pub fn hits(&self, i: u32) -> String {
        to_json(&self.0.hits(i as usize).unwrap_or_default())
    }
    /// 第 `i` 页的场景 JSON（导出 PDF / PPTX 交给写出端）。
    pub fn scene(&self, i: u32) -> String {
        self.0.pages.get(i as usize).map(to_json).unwrap_or_default()
    }
    /// 简谱：定稿栅格（TS `plainOf(metrics)`，样式快照核对用）；五线谱回空串。
    #[wasm_bindgen(js_name = gridJson)]
    pub fn grid_json(&self) -> String {
        self.0.jianpu.as_ref().map(|j| to_json(&j.metrics.to_json())).unwrap_or_default()
    }
    /// 简谱：规范化定位结构（`placedJson`，回归核对几何用）；五线谱回空串。
    #[wasm_bindgen(js_name = placedJson)]
    pub fn placed_json(&self) -> String {
        self.0.jianpu.as_ref().map(|j| to_json(&dolce_layout_jianpu::placedjson::placed_json(&j.placed))).unwrap_or_default()
    }
}

/// 简谱 / 投影档：`doc` 是 `ScoreDoc` JSON，`req` 是 `JianpuRequest` JSON。
#[wasm_bindgen(js_name = layoutJianpu)]
pub fn layout_jianpu(doc: &str, req: &str) -> Result<Layout, JsValue> {
    let h = host()?;
    let doc: ScoreDoc = parse("ScoreDoc", doc)?;
    let req: JianpuRequest = parse("JianpuRequest", req)?;
    layout::layout_jianpu_doc(&doc, &req, &env(h)).map(Layout).map_err(fail)
}

/// 五线谱 / 混排：`h` 是 MusicXML 表层句柄（0 = 没有）。
#[wasm_bindgen(js_name = layoutStaff)]
pub fn layout_staff(doc: &str, surface: u32, req: &str) -> Result<Layout, JsValue> {
    let h = host()?;
    let doc: ScoreDoc = parse("ScoreDoc", doc)?;
    let req: StaffRequest = parse("StaffRequest", req)?;
    with_surface(surface, |s| layout::layout_staff_doc(&doc, s, &req, &env(h))).map(Layout).map_err(fail)
}

/// 自然量宽（乐句重排的尺子）：回 `{"width": 版心宽, "spans": [[id, {x0, x1, x1b}], …]}`。
#[wasm_bindgen(js_name = measureDocument)]
pub fn measure_document(doc: &str, style: &str, width: f64, slide: bool, song: u32) -> Result<String, JsValue> {
    let h = host()?;
    let doc: ScoreDoc = parse("ScoreDoc", doc)?;
    let style: Option<serde_json::Value> = parse("StyleSheet", style)?;
    let (w, xs) = layout::measure_document(&doc, &style, width, slide, song as usize, &env(h)).map_err(fail)?;
    let spans: Vec<_> = xs.iter().map(|(id, s)| serde_json::json!([id, { "x0": s.x0, "x1": s.x1, "x1b": s.x1b }])).collect();
    Ok(to_json(&serde_json::json!({ "width": w, "spans": spans })))
}

/// 导出 MusicXML（带五线谱引擎排的版面）：`doc` + 表层句柄 `surface`，`req` 是 `EngraveRequest` JSON。
#[wasm_bindgen(js_name = engravedMusicXml)]
pub fn engraved_music_xml(doc: &str, surface: u32, req: &str) -> Result<String, JsValue> {
    let h = host()?;
    let doc: ScoreDoc = parse("ScoreDoc", doc)?;
    let req: layout::EngraveRequest = parse("EngraveRequest", req)?;
    with_surface(surface, |s| layout::engraved_music_xml(&doc, s, &req, &env(h))).map_err(fail)
}

/// 五线谱的断句尺子：回 `{"width": 版心宽, "spans": [[源元素 id, x0, x1], …]}`。
#[wasm_bindgen(js_name = staffChordSpans)]
pub fn staff_chord_spans(doc: &str, surface: u32, req: &str) -> Result<String, JsValue> {
    let h = host()?;
    let doc: ScoreDoc = parse("ScoreDoc", doc)?;
    let req: layout::StaffSpansRequest = parse("StaffSpansRequest", req)?;
    let s = with_surface(surface, |s| layout::staff_chord_spans(&doc, s, &req, &env(h))).map_err(fail)?;
    Ok(to_json(&serde_json::json!({ "width": s.width, "spans": s.by_id })))
}

/// 按参照歌词生成段落标记与 `%%sing`（`dolce_layout::sing`）：`req` 是投影档 `JianpuRequest` JSON（空串 = 出厂投影样式），
/// 回 `{marks, order, notes, refChars, matched, sing}`。
#[wasm_bindgen(js_name = singFromLyrics)]
pub fn sing_from_lyrics(doc: &str, song: u32, lyrics: &str, req: &str) -> Result<String, JsValue> {
    let h = host()?;
    dolce_layout::sing::sing_from_lyrics_json(doc, song as usize, lyrics, req, &env(h)).map(|v| to_json(&v)).map_err(fail)
}
