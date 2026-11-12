//! 网页版绑定。现在只有 OCR 探针（P12 12a：量 tract 在浏览器里的加载与单条耗时），12g 补齐文档、识别与会话。
use dolce_omr_core::image::Rect;
use dolce_omr_ocr::surface::Gray;
use dolce_omr_ocr::tract::TractInfer;
use dolce_omr_ocr::Ocr;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct OcrProbe {
    ocr: Ocr,
}

#[wasm_bindgen]
impl OcrProbe {
    #[wasm_bindgen(constructor)]
    pub fn new(rec: &[u8], det: &[u8], dict: &str) -> Result<OcrProbe, JsError> {
        let infer = TractInfer::new(rec, det).map_err(|e| JsError::new(&e))?;
        Ok(OcrProbe { ocr: Ocr::new(Box::new(infer), dict) })
    }

    /// 读一条灰度文本条，回识别出的字串。
    pub fn read_line(&self, gray: &[u8], w: usize, h: usize) -> Result<String, JsError> {
        let g = Gray { w, h, data: gray.to_vec() };
        let r = self.ocr.read_lines(std::slice::from_ref(&g)).map_err(|e| JsError::new(&e))?;
        Ok(r[0].iter().map(|c| c.ch.as_str()).collect())
    }

    /// 检测整个画面的文本框个数。
    pub fn detect(&self, gray: &[u8], w: usize, h: usize) -> Result<usize, JsError> {
        let g = Gray { w, h, data: gray.to_vec() };
        let r = self.ocr.detect(&g, Rect::new(0.0, 0.0, w as f64, h as f64)).map_err(|e| JsError::new(&e))?;
        Ok(r.len())
    }
}
