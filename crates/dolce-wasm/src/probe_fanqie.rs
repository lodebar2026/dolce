//! 文本谱（`dolce-formats::fanqie`）的对拍探针（dev `rsdiff/fanqie.mjs`）。只在 `--features probe` 的那份里。

use crate::json;
use dolce_formats::fanqie::{dialect::Dialect, parse};
use wasm_bindgen::prelude::*;

fn options(dialect: &str) -> parse::ParseOptions {
    parse::ParseOptions { dialect: Dialect::parse(dialect) }
}

/// 文本谱 → 语法树（`FanqieDoc`）的 JSON。`dialect` 空串 = 嗅探
#[wasm_bindgen(js_name = fanqieParseAst)]
pub fn fanqie_parse_ast(text: &str, dialect: &str) -> String {
    json(&parse::parse_fanqie_ast(text, options(dialect)))
}

/// 文本谱 → `ScoreDoc` 的 JSON。`dialect` 空串 = 嗅探
#[wasm_bindgen(js_name = fanqieParse)]
pub fn fanqie_parse(text: &str, dialect: &str) -> String {
    json(&parse::parse_fanqie(text, options(dialect)))
}

/// 门面算乐句断点：`f(songJson)` 回 `phraseCuts` 各刀行首 id 的 JSON 数组（拿不到 id 的为 null）或 `"null"`
struct JsCuts<'a>(&'a js_sys::Function);

impl dolce_formats::fanqie::emit::EmitHooks for JsCuts<'_> {
    fn phrase_cuts(&self, song: &dolce_model::Song) -> Option<Vec<Option<dolce_model::ElementId>>> {
        let v = self.0.call1(&JsValue::NULL, &JsValue::from_str(&json(song))).ok()?;
        serde_json::from_str(&v.as_string()?).ok()?
    }
}

/// `ScoreDoc` 的 JSON → 文本谱原文。`dialect`：`fanqie` / `shige`
#[wasm_bindgen(js_name = fanqieEmit)]
pub fn fanqie_emit(doc: &str, dialect: &str, phrase_cuts: &js_sys::Function) -> Result<String, JsValue> {
    let doc: dolce_model::ScoreDoc = crate::parse("ScoreDoc", doc)?;
    let d = Dialect::parse(dialect).unwrap_or(Dialect::Tomato);
    Ok(dolce_formats::fanqie::emit::emit_fanqie(&doc, d, &JsCuts(phrase_cuts)))
}
