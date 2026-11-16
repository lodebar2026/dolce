//! Muse .jcx 字节编解码（`dolce_formats::jcxcodec`）的 wasm 绑定。码表占体积，单出一份按需载入：
//! 网页开机后空闲时预取（`common/jcx.ts::loadJcx`），开 / 存 .jcx 前兜底等它；Node 由 `cli/dolcewasm.node.ts` 同步载。

use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen(js_name = decodeJcx)]
pub fn decode_jcx(bytes: &[u8]) -> String {
    dolce_formats::jcxcodec::decode_jcx(bytes)
}

/// `encodeJcx` 的结果：字节与 GBK 写不出的字
#[wasm_bindgen]
pub struct JcxBytes {
    bytes: Vec<u8>,
    missing: Vec<char>,
}

#[wasm_bindgen]
impl JcxBytes {
    #[wasm_bindgen(getter)]
    pub fn bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }
    /// 写成 `?` 的字，接成一串（按出现先后、不重复）
    #[wasm_bindgen(getter)]
    pub fn missing(&self) -> String {
        self.missing.iter().collect()
    }
}

#[wasm_bindgen(js_name = encodeJcx)]
pub fn encode_jcx(text: &str) -> JcxBytes {
    let (bytes, missing) = dolce_formats::jcxcodec::encode_jcx(text);
    JcxBytes { bytes, missing }
}
