//! `.jpwabc` 对拍探针（词法、分节、写出已是正式入口 `textformats.rs`）（dev `rsdiff/jpw.mjs` 的 Rust 一侧，口径与该脚本里的 TS 摘要相同）。只在 `--features probe` 的那份里。

use dolce_formats::jpw::file::JpwFile;
use dolce_formats::jpw::read::{jpw_to_score_doc, read_jpw_source, JpwError};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

fn err(e: &JpwError) -> Value {
    match e {
        JpwError::Model(m) => json!({ "model": m.key }),
        JpwError::Fail(_) => json!({ "error": true }),
    }
}

/// 读入：`{ src: readJpwSource 结果 | 报错, doc: ScoreDoc | 报错 }`；分节读不出整份 `null`
#[wasm_bindgen(js_name = jpwRead)]
pub fn jpw_read(text: &str) -> String {
    let Some(f) = JpwFile::from_str(text) else { return "null".into() };
    let src = match read_jpw_source(&f) {
        Ok(s) => serde_json::to_value(&s).unwrap(),
        Err(e) => err(&e),
    };
    let doc = match jpw_to_score_doc(&f) {
        Ok(d) => serde_json::to_value(&d).unwrap(),
        Err(e) => err(&e),
    };
    json!({ "src": src, "doc": doc }).to_string()
}

