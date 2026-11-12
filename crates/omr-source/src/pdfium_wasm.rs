//! wasm 下绕开 pdfium-render 0.9.5 wasm 绑定的两处毛病，直接调 PDFium 的 emscripten 模块（宿主经 [`set_module`] 交来）：
//!
//! - `FPDFPageObj_GetMatrix`：绑定先在本模块内存上开视图、再分配 `Vec`，分配一长内存视图就失效（报 detached ArrayBuffer）
//! - `FPDFText_GetCharBox`：绑定把出参按 左、上、右、下 的次序交给 PDFium（原型是 左、右、下、上），框读反
//!
//! 句柄在 wasm 下就是 PDFium 堆上的地址。
use js_sys::{Array, Float32Array, Float64Array, Function, Reflect};
use std::cell::RefCell;
use wasm_bindgen::{JsCast, JsValue};

thread_local! {
    static MODULE: RefCell<Option<JsValue>> = const { RefCell::new(None) };
}

/// 交 PDFium 的 emscripten 模块（`initialize_pdfium_render` 用的同一个）。
pub fn set_module(m: JsValue) {
    MODULE.with(|c| *c.borrow_mut() = Some(m));
}

fn with_module<T>(f: impl FnOnce(&JsValue) -> Option<T>) -> Option<T> {
    MODULE.with(|c| c.borrow().as_ref().and_then(f))
}

fn call(m: &JsValue, name: &str, args: &[f64]) -> Option<f64> {
    let f: Function = Reflect::get(m, &JsValue::from_str(&format!("_{name}"))).ok()?.dyn_into().ok()?;
    let a: Array = args.iter().map(|&v| JsValue::from_f64(v)).collect();
    f.apply(&JsValue::NULL, &a).ok()?.as_f64()
}

/// 文字对象 / 路径对象的变换矩阵 (a, b, c, d, e, f)。
pub(crate) fn obj_matrix(obj: usize) -> Option<[f32; 6]> {
    with_module(|m| {
        let ptr = call(m, "malloc", &[24.0])?;
        let ok = call(m, "FPDFPageObj_GetMatrix", &[obj as f64, ptr]);
        let heap: Float32Array = Reflect::get(m, &JsValue::from_str("HEAPF32")).ok()?.dyn_into().ok()?;
        let i = ptr as u32 / 4;
        let v = [0, 1, 2, 3, 4, 5].map(|k| heap.get_index(i + k));
        call(m, "free", &[ptr]);
        (ok? != 0.0).then_some(v)
    })
}

/// 第 `index` 个字的框（左、右、下、上，页面点）。
pub(crate) fn char_box(text_page: usize, index: i32) -> Option<[f64; 4]> {
    with_module(|m| {
        let ptr = call(m, "malloc", &[32.0])?;
        let p = |k: f64| ptr + 8.0 * k;
        let ok = call(m, "FPDFText_GetCharBox", &[text_page as f64, index as f64, p(0.0), p(1.0), p(2.0), p(3.0)]);
        let heap: Float64Array = Reflect::get(m, &JsValue::from_str("HEAPF64")).ok()?.dyn_into().ok()?;
        let i = ptr as u32 / 8;
        let v = [0, 1, 2, 3].map(|k| heap.get_index(i + k));
        call(m, "free", &[ptr]);
        (ok? != 0.0).then_some(v)
    })
}
