//! `.jpwabc` 对拍探针（dev `rsdiff/jpw.mjs` 的 Rust 一侧，口径与该脚本里的 TS 摘要相同）。只在 `--features probe` 的那份里。

use dolce_formats::abc::u16s;
use dolce_formats::jpw::file::{JpwFile, SectionKind, WordsSegment};
use dolce_formats::jpw::lex::{lex_voice, JpwToken};
use dolce_formats::jpw::read::{jpw_to_score_doc, read_jpw_source, JpwError};
use dolce_formats::jpw::write::{write_jpwabc, JpwScoreIn};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

fn tok(t: &JpwToken) -> Value {
    json!([t.kind, u16s::text(&t.text), t.start, t.end, t.line, t.column])
}

fn segs(s: &[WordsSegment]) -> Value {
    Value::Array(
        s.iter()
            .map(|g| {
                json!({
                    "passFirst": g.pass_first, "passLast": g.pass_last, "measure": g.measure, "noteIndex": g.note_index, "control": g.control,
                    "data": g.data.iter().map(|d| json!([u16s::text(&d.text), d.align_pos, d.source])).collect::<Vec<_>>(),
                })
            })
            .collect(),
    )
}

fn err(e: &JpwError) -> Value {
    match e {
        JpwError::Model(m) => json!({ "model": m.key }),
        JpwError::Fail(_) => json!({ "error": true }),
    }
}

/// `.Voice` 正文的词法（含空白、注释）：[类型, 原文, 起, 止, 行, 列]
#[wasm_bindgen(js_name = jpwLexDigest)]
pub fn jpw_lex_digest(text: &str) -> String {
    Value::Array(lex_voice(&u16s::enc(text)).iter().map(tok).collect()).to_string()
}

/// 分节解析：读不出 `null`，否则各节（名、行、行号、行首偏移、按节类的内容）
#[wasm_bindgen(js_name = jpwFileDigest)]
pub fn jpw_file_digest(text: &str) -> String {
    let Some(f) = JpwFile::from_str(text) else { return "null".into() };
    let secs: Vec<Value> = f
        .sections
        .iter()
        .map(|s| {
            let body = match &s.kind {
                SectionKind::Voice { voice_data } => json!({ "voice": voice_data.iter().map(tok).collect::<Vec<_>>() }),
                SectionKind::Words { segments } => json!({ "words": segs(segments) }),
                SectionKind::Title { values } => json!({ "title": values.iter().collect::<Vec<_>>() }),
                SectionKind::Layout { lines_per_page, break_points } => json!({ "layout": [lines_per_page, break_points] }),
                SectionKind::Repeat { data } => json!({ "repeat": data }),
                SectionKind::Generic => json!({}),
            };
            json!({ "name": s.name, "lines": s.lines.iter().map(|l| u16s::text(l)).collect::<Vec<_>>(), "lineNos": s.line_nos, "lineOffsets": s.line_offsets, "body": body })
        })
        .collect();
    Value::Array(secs).to_string()
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

/// 写出：输入形状（门面打好 `kind` 的 JSON）→ `.jpwabc` 文本；写不出抛 `Error`
#[wasm_bindgen(js_name = jpwWrite)]
pub fn jpw_write(input: &str) -> Result<String, JsValue> {
    let scr: JpwScoreIn = crate::parse("JpwScoreIn", input)?;
    write_jpwabc(&scr).map_err(|e| crate::js_sys_error(&e.0))
}
