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
