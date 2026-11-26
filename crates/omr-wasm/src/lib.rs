//! 网页版绑定：Worker（`src/omrrust/worker.ts`）里跑，接口与桌面版 Tauri 命令（`src-tauri/src/omr.rs`）一一对应，
//! 都是 `dolce-omr::Handle` 外面的薄壳；字节与 JSON 的格式两边相同。
//!
//! 先后：Worker 加载 PDFium 的 wasm 模块后调 `initialize_pdfium_render`（pdfium-render 导出）与 [`set_pdfium_module`]，要识别前调 [`load_ocr`] 交模型字节。
//! wasm 下没有线程：识别同步跑完，进度回调里由 JS 查取消标志（`SharedArrayBuffer`），回真就在下一步停。
use dolce_omr_core::image::Rect;
use dolce_omr_core::progress::{Hook, Step};
use dolce_omr::{Handle, Opts};
use dolce_omr_core::ocr::cache::{decode_reqs, encode_reqs, exec, jobs, CachedOcr};
use dolce_omr_core::ocr::surface::Gray;
use dolce_omr_core::ocr::tract::TractInfer;
use dolce_omr_core::ocr::{Ocr, OcrCache};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use wasm_bindgen::prelude::*;

static OCR: OnceLock<CachedOcr> = OnceLock::new();

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

fn err(e: String) -> JsError {
    JsError::new(&e)
}

fn ocr() -> Result<&'static CachedOcr, String> {
    OCR.get().ok_or_else(|| "OCR 模型还没加载".to_string())
}

/// 交 PDFium 的 emscripten 模块：先调 pdfium-render 导出的 `initialize_pdfium_render(模块, 本模块导出, false)`，再调这个
/// （取数层有两个接口绕开绑定直接调模块，见 `omr-core::source/src/pdfium_wasm.rs`）。
#[wasm_bindgen]
pub fn set_pdfium_module(module: JsValue) {
    dolce_omr_core::source::set_wasm_module(module);
}

/// 交 OCR 模型（rec / det 的 ONNX 字节与字典）；只第一次有效。
#[wasm_bindgen]
pub fn load_ocr(rec: &[u8], det: &[u8], dict: &str) -> Result<(), JsError> {
    if OCR.get().is_none() {
        let infer = TractInfer::new(rec, det).map_err(err)?;
        let _ = OCR.set(CachedOcr::new(Some(Ocr::new(Box::new(infer), dict)), OcrCache::memory()));
    }
    Ok(())
}

#[wasm_bindgen]
pub fn ocr_loaded() -> bool {
    OCR.get().is_some()
}

/// 一份打开的文档（几个文件合成一份）。
#[wasm_bindgen]
pub struct OmrDoc {
    h: Handle,
}

/// JS 回调没有 `Sync`；wasm 只有一个线程，包一层过 `Hook` 的约束。
struct Single<T>(T);
unsafe impl<T> Sync for Single<T> {}

#[wasm_bindgen]
impl OmrDoc {
    /// 请求体同 Tauri 的 `omr_open`（`u32 个数` + 各 `u32 长度` + 字节）。
    pub fn open(body: &[u8]) -> Result<OmrDoc, JsError> {
        Ok(OmrDoc { h: Handle::open(body).map_err(err)? })
    }

    /// `{pdf, sizes}` 的 JSON。
    pub fn info(&self) -> Result<String, JsError> {
        Ok(self.h.info().map_err(err)?.to_string())
    }

    pub fn render(&self, page: usize, scale: f64) -> Result<Vec<u8>, JsError> {
        self.h.render_bytes(page, scale).map_err(err)
    }

    pub fn binary(&self, page: usize) -> Result<Vec<u8>, JsError> {
        self.h.binary_bytes(page).map_err(err)
    }

    /// 识别：`opts` 是 `Opts` 的 JSON；`progress(done, total, stage)` 回真表示要取消。回 JSON。
    pub fn recognize(&self, opts: &str, progress: &js_sys::Function) -> Result<String, JsError> {
        let opts: Opts = serde_json::from_str(opts).map_err(|e| err(e.to_string()))?;
        with_hook(progress, |hook| Ok(self.h.recognize(ocr().map_err(err)?, &opts, hook).map_err(err)?.to_string()))
    }

    /// 分轮预取的一轮（见 `CachedOcr::rounds`）：识别结果齐了回 JSON 字符串；还缺 OCR 回各份活（`Uint8Array` 的数组，
    /// 每份是 `encode_reqs` 的字节），页面把它们分给几个 Worker 调 [`ocr_exec`]、结果交 [`ocr_put`] 后再调这个。
    pub fn recognize_round(&self, opts: &str, progress: &js_sys::Function) -> Result<JsValue, JsError> {
        let opts: Opts = serde_json::from_str(opts).map_err(|e| err(e.to_string()))?;
        with_hook(progress, |hook| match self.h.recognize_round(ocr().map_err(err)?, &opts, hook).map_err(err)? {
            Ok(v) => Ok(JsValue::from_str(&v.to_string())),
            Err(reqs) => {
                let arr = js_sys::Array::new();
                for j in jobs(reqs) {
                    arr.push(&js_sys::Uint8Array::from(encode_reqs(&j).as_slice()));
                }
                Ok(arr.into())
            }
        })
    }

    /// 会话操作：`op` 的 JSON，同 Tauri 的 `omr_session`。回 JSON。
    pub fn session(&self, op: &str) -> Result<String, JsError> {
        let op = serde_json::from_str(op).map_err(|e| err(e.to_string()))?;
        Ok(self.h.session(op, ocr).map_err(err)?.to_string())
    }
}

/// 进度回调与取消标志包成 `Hook` 交给 `f`。
fn with_hook<R>(progress: &js_sys::Function, f: impl FnOnce(&Hook) -> R) -> R {
    let cancel = AtomicBool::new(false);
    let pf = Single(progress);
    let send = |s: Step| {
        let r = pf.0.call3(&JsValue::NULL, &JsValue::from(s.done as u32), &JsValue::from(s.total as u32), &JsValue::from_str(s.stage));
        if r.is_ok_and(|v| v.is_truthy()) {
            cancel.store(true, Ordering::Relaxed);
        }
    };
    let send = Single(send);
    let on = |s: Step| (send.0)(s);
    f(&Hook { on: Some(&on), cancel: Some(&cancel) })
}

/// 推理一份活（[`OmrDoc::recognize_round`] 交出的字节）；回 `[[缓存键, 结果], …]` 的 JSON。识别 Worker 自己和帮手 Worker 都能调。
#[wasm_bindgen]
pub fn ocr_exec(job: &[u8]) -> Result<String, JsError> {
    let reqs = decode_reqs(job).ok_or_else(|| err("OCR 活的字节坏了".into()))?;
    let o = ocr().map_err(err)?.ocr.as_ref().ok_or_else(|| err("没有 OCR".into()))?;
    serde_json::to_string(&exec(o, &reqs).map_err(err)?).map_err(|e| err(e.to_string()))
}

/// [`ocr_exec`] 的结果写进本 Worker 的 OCR 缓存。
#[wasm_bindgen]
pub fn ocr_put(results: &str) -> Result<(), JsError> {
    let got: Vec<(String, serde_json::Value)> = serde_json::from_str(results).map_err(|e| err(e.to_string()))?;
    ocr().map_err(err)?.put_all(got);
    Ok(())
}

/// OCR 探针（P12 12a：量 tract 在浏览器里的单条耗时；用 [`load_ocr`] 交的模型）。
#[wasm_bindgen]
pub fn ocr_read_line(gray: &[u8], w: usize, h: usize) -> Result<String, JsError> {
    let g = Gray { w, h, data: gray.to_vec() };
    let o = ocr().map_err(err)?.ocr.as_ref().ok_or_else(|| err("没有 OCR".into()))?;
    let r = o.read_lines(std::slice::from_ref(&g)).map_err(err)?;
    Ok(r[0].iter().map(|c| c.ch.as_str()).collect())
}

/// OCR 探针：整个画面检测出几个文本框。
#[wasm_bindgen]
pub fn ocr_detect(gray: &[u8], w: usize, h: usize) -> Result<usize, JsError> {
    let g = Gray { w, h, data: gray.to_vec() };
    let o = ocr().map_err(err)?.ocr.as_ref().ok_or_else(|| err("没有 OCR".into()))?;
    Ok(o.detect(&g, Rect::new(0.0, 0.0, w as f64, h as f64)).map_err(err)?.len())
}

