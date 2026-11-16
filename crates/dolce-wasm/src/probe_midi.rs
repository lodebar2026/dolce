//! MIDI 导入（`dolce-formats::midi`）的对拍探针（dev `rsdiff/midiimport.mjs`）。只在 `--features probe` 的那份里。

use crate::{json, parse};
use dolce_formats::midi::{import, smf};
use serde_json::json as j;
use wasm_bindgen::prelude::*;

/// SMF 读取：事件表的 JSON（读不出为 `null`）
#[wasm_bindgen(js_name = midiParseSmf)]
pub fn midi_parse_smf(bytes: &[u8]) -> String {
    json(&smf::parse_smf(bytes))
}

/// MIDI → `ScoreDoc`：`{ doc, warnings }`（提示是 `Msg`），读不出 / 太大回 `{ error: Msg }`。`opts` 是 `MidiImportOptions` 的 JSON
#[wasm_bindgen(js_name = midiImport)]
pub fn midi_import(bytes: &[u8], title: &str, opts: &str) -> Result<String, JsValue> {
    let o: import::MidiImportOptions = parse("MidiImportOptions", opts)?;
    Ok(match import::midi_to_score_doc(bytes, title, &o) {
        Ok(r) => json(&r),
        Err(m) => json(&j!({ "error": m })),
    })
}
