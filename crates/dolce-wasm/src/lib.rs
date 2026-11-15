//! wasm 绑定。数据过边界一律 JSON 字符串（结构由 ts-rs 生成的类型说明），报错抛 `Error`，`message` 是 JSON：
//! `{"kind":"stale",…}` / `{"kind":"failure",…}`（同 `dolce_session::EngineError`）。
//!
//! 迁移期另出几样对拍用的纯函数（`xmlDigest` 等），Node 门面 `out/cli/dolce.js` 与 dev `rs-diff.mjs` 用。

use dolce_session::{EngineError, UpdateRequest};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

/// 本 crate 的版本（门面核对载的是哪一份）。
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").into()
}

fn engine_err(e: EngineError) -> JsValue {
    js_sys_error(&serde_json::to_string(&e).unwrap_or_default())
}

fn js_sys_error(message: &str) -> JsValue {
    // 不引 js-sys：`Error` 构造经 wasm-bindgen 的内建导入
    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_name = Error)]
        fn make_error(message: &str) -> JsValue;
    }
    make_error(message)
}

/// 文档会话（`EngineSession` 的 wasm 侧）。
#[wasm_bindgen]
pub struct Session(dolce_session::Session);

#[wasm_bindgen]
impl Session {
    #[wasm_bindgen(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Session {
        Session(dolce_session::Session::new())
    }

    /// `req` 是 `UpdateRequest` 的 JSON，回 `UpdateReply` 的 JSON。
    pub fn update(&mut self, req: &str) -> Result<String, JsValue> {
        let req: UpdateRequest = serde_json::from_str(req).map_err(|e| js_sys_error(&format!("UpdateRequest：{e}")))?;
        let r = self.0.update(req).map_err(engine_err)?;
        Ok(serde_json::to_string(&r).expect("序列化"))
    }

    pub fn page(&self, rev: u32, index: u32) -> Result<String, JsValue> {
        self.0.page(rev, index).map_err(engine_err)
    }

    pub fn emit(&self, rev: u32, target: &str) -> Result<String, JsValue> {
        self.0.emit(rev, target).map_err(engine_err)
    }
}

/// XML 树对拍原料（同 `dolce xml-dump` 的口径，哈希由调用方算）：解析成功回
/// `{"ok":true,"xml":序列化文本,"spans":"start-end,…"}`（各元素原文区间，UTF-16、文档序）；读不出回 `{"ok":false,"message":…,"at":…}`。
#[wasm_bindgen(js_name = xmlDigest)]
pub fn xml_digest(text: &str) -> String {
    match dolce_xml::parse(text) {
        Ok(d) => {
            let mut spans = String::new();
            let mut stack = vec![d.root];
            while let Some(id) = stack.pop() {
                spans.push_str(&format!("{}-{},", d.tree.start(id), d.tree.end(id)));
                let kids: Vec<_> = d.tree.children(id).collect();
                stack.extend(kids.into_iter().rev());
            }
            serde_json::json!({ "ok": true, "xml": d.serialize(), "spans": spans }).to_string()
        }
        Err(e) => serde_json::json!({ "ok": false, "message": e.message, "at": e.at }).to_string(),
    }
}
