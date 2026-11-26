//! 对拍探针：jianpu-ly 读入与和弦符号工具（dev `rs-diff.mjs jly` 的 Rust 一侧）。
//! 损失清单回的是 `diag.jly.example { what, raw }` 键，由 dev 那边经 TS `msgText` 出字再比。

use dolce_model::base::text::SourceSpan;
use dolce_model::formats::jly::{chords, fromjly};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

fn s(v: &Value) -> String {
    serde_json::to_string(v).expect("序列化")
}

fn losses_json(l: &fromjly::JlyLosses) -> Value {
    json!({ "list": l.list(), "diagnostics": l.diagnostics() })
}

/// 一个词：`{ token, losses }`（落点给 `{ line: 0, column: 0, offset: 0, length: 词长 }`）
#[wasm_bindgen(js_name = jlyScanWord)]
pub fn jly_scan_word(word: &str) -> String {
    let mut loss = fromjly::JlyLosses::new();
    let span = SourceSpan { line: 0, column: 0, offset: 0, length: word.encode_utf16().count() as u32 };
    let tk = fromjly::scan_word(word, &mut loss, Some(span));
    s(&json!({ "token": tk, "losses": losses_json(&loss) }))
}

/// 一整行曲行：`{ tokens, pos, unknown, losses }`（落点 = 第 3 行、偏移按列号 +10）
#[wasm_bindgen(js_name = jlyScanLine)]
pub fn jly_scan_line(line: &str) -> String {
    let mut loss = fromjly::JlyLosses::new();
    let span_at = |c: usize, l: usize| SourceSpan { line: 3, column: c as u32, offset: c as u32 + 10, length: l as u32 };
    let enc: Vec<u16> = line.encode_utf16().collect();
    let ml = fromjly::scan_music_line(&enc, &mut loss, Some(&span_at));
    s(&json!({ "tokens": ml.tokens, "pos": ml.pos, "unknown": ml.unknown, "losses": losses_json(&loss) }))
}

/// 和弦符号工具逐个 token：`[lyPitchToText, textPitchToLy, lySuffixToText, textSuffixToLy, parseChordToken, chordTokenToText, harmonyToChordToken(tok, whole)]`
#[wasm_bindgen(js_name = jlyChordDigest)]
pub fn jly_chord_digest(tok: &str, whole: f64) -> String {
    s(&json!([
        chords::ly_pitch_to_text(tok),
        chords::text_pitch_to_ly(tok),
        chords::ly_suffix_to_text(tok),
        chords::text_suffix_to_ly(tok),
        chords::parse_chord_token(tok),
        chords::chord_token_to_text(tok),
        chords::harmony_to_chord_token(tok, whole),
    ]))
}

/// 时值：`[wholeToDuration, durationText]`
#[wasm_bindgen(js_name = jlyDuration)]
pub fn jly_duration(whole: f64) -> String {
    let (text, exact) = chords::whole_to_duration(whole);
    s(&json!([{ "text": text, "exact": exact }, chords::duration_text(whole)]))
}

