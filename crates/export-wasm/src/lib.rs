//! 导出 PDF（`dolce_layout::export`）的 wasm 绑定，网页版「导出 PDF」用。体积大（krilla、整形、子集化），单出一份按需载入
//!（`editor/pdfexport.ts`）。
//!
//! - [`PdfFonts`]：字体由宿主给字节（本地字体访问授权拿到的系统字体 + 随站点的 Bravura），按场景用到的族串挑着给
//!   （[`PdfFonts::families`] 列出族串展开后要的族，含平台末位回退）；[`PdfFonts::scene_pdf`] 出矢量 PDF。
//! - [`RasterPdf`]：逐页 PNG 铺满出栅格 PDF（没授权时）。
//! - [`pptx`]：场景 → `.pptx`（`editor/pptxexport.ts`；网页与桌面同走这一份）。

use dolce_layout::export::fonts::{FontBook, Platform};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

fn platform_of(p: &str) -> Platform {
    if p.eq_ignore_ascii_case("win32") || p.to_lowercase().starts_with("win") {
        Platform::Win32
    } else if p.to_lowercase().starts_with("linux") {
        Platform::Linux
    } else {
        Platform::Darwin
    }
}

/// 一份矢量 PDF：字节 + 报账（JSON：缺字、转曲面、回退）
#[wasm_bindgen]
pub struct PdfOut {
    bytes: Vec<u8>,
    report: String,
}

#[wasm_bindgen]
impl PdfOut {
    #[wasm_bindgen(getter)]
    pub fn bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn report(&self) -> String {
        self.report.clone()
    }
}

#[wasm_bindgen]
pub struct PdfFonts {
    book: FontBook,
}

#[wasm_bindgen]
impl PdfFonts {
    /// `platform`：`darwin` / `win32`（泛称展开与末位回退按它）
    #[wasm_bindgen(constructor)]
    pub fn new(platform: &str) -> PdfFonts {
        PdfFonts { book: FontBook::empty(platform_of(platform)) }
    }

    /// 族串（逗号分隔的 CSS 族串，可多条用换行隔开）展开后要的具体族（去重、按序），末尾接平台的末位回退
    pub fn families(&self, css: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for line in css.lines() {
            for f in self.book.families(line) {
                if !out.contains(&f) {
                    out.push(f);
                }
            }
        }
        for f in &self.book.last_resort {
            if !out.contains(f) {
                out.push(f.clone());
            }
        }
        out
    }

    /// 加一份字体字节（`.ttc` 的各子字体都进库）
    #[wasm_bindgen(js_name = addFont)]
    pub fn add_font(&mut self, key: String, bytes: Vec<u8>) {
        self.book.add_bytes(key, bytes);
    }

    /// 场景页（`[{scene, w, h}]` 的 JSON，同桌面 `export_scene_pdf`）→ 矢量 PDF。`bg`：纸张底色 ARGB
    #[wasm_bindgen(js_name = scenePdf)]
    pub fn scene_pdf(&self, pages_json: &str, bg: f64, title: &str) -> Result<PdfOut, JsError> {
        let v: serde_json::Value = serde_json::from_str(pages_json).map_err(|e| JsError::new(&format!("页 JSON：{e}")))?;
        let mut pages = Vec::new();
        for p in v.as_array().ok_or_else(|| JsError::new("页 JSON 要是数组"))? {
            let scene: dolce_engrave::scene::Page = serde_json::from_value(p["scene"].clone()).map_err(|e| JsError::new(&format!("场景：{e}")))?;
            pages.push(dolce_layout::export::scene::ScenePage { scene, w_pt: p["w"].as_f64().unwrap_or(0.0), h_pt: p["h"].as_f64().unwrap_or(0.0) });
        }
        let info = dolce_layout::export::pdf::DocInfo { title: (!title.is_empty()).then(|| title.to_string()), outline: Vec::new() };
        let (bytes, r) = dolce_layout::export::scene::scene_pdf(&self.book, &pages, Some(bg), &info).map_err(|e| JsError::new(&e))?;
        let report = serde_json::json!({
            "missing": r.missing.iter().map(|(p, fam, ch)| serde_json::json!([p + 1, fam, ch])).collect::<Vec<_>>(),
            "outlined": r.outlined,
            "fallbacks": r.fallbacks.len(),
        })
        .to_string();
        Ok(PdfOut { bytes, report })
    }
}

/// 栅格 PDF：逐页 `addPage(png, 宽 pt, 高 pt)`，`finish(标题)` 出字节
#[wasm_bindgen]
#[derive(Default)]
pub struct RasterPdf {
    pages: Vec<(Vec<u8>, f64, f64)>,
}

#[wasm_bindgen]
impl RasterPdf {
    #[wasm_bindgen(constructor)]
    pub fn new() -> RasterPdf {
        RasterPdf::default()
    }
    #[wasm_bindgen(js_name = addPage)]
    pub fn add_page(&mut self, png: Vec<u8>, w: f64, h: f64) {
        self.pages.push((png, w, h));
    }
    pub fn finish(&mut self, title: &str) -> Result<Vec<u8>, JsError> {
        let pages = std::mem::take(&mut self.pages);
        dolce_layout::export::pdf::raster_pdf(&pages, (!title.is_empty()).then_some(title)).map_err(|e| JsError::new(&e))
    }
}

/// 场景 → `.pptx` 字节。`input` 是 `PptxInput` 的 JSON，`bravura` 是 Bravura.otf 的字节（SMuFL 字转曲用）。
#[wasm_bindgen]
pub fn pptx(input: &str, bravura: Vec<u8>) -> Result<Vec<u8>, JsError> {
    let input: dolce_layout::export::pptx::PptxInput = serde_json::from_str(input).map_err(|e| JsError::new(&format!("PPTX 料：{e}")))?;
    let face = dolce_layout::export::fonts::Face::parse(std::sync::Arc::new(bravura), 0, "Bravura.otf".into()).ok_or_else(|| JsError::new("Bravura.otf 读不了"))?;
    Ok(dolce_layout::export::pptx::pptx(&input, &face))
}
