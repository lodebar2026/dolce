//! MIDI 导入（`dolce-model::formats::midi`）的对拍探针（dev `rsdiff/midiimport.mjs`）。只在 `--features probe` 的那份里。

use crate::json;
use dolce_model::formats::midi::smf;
use wasm_bindgen::prelude::*;

/// SMF 读取：事件表的 JSON（读不出为 `null`）
#[wasm_bindgen(js_name = midiParseSmf)]
pub fn midi_parse_smf(bytes: &[u8]) -> String {
    json(&smf::parse_smf(bytes))
}

