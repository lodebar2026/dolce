//! 文本谱、`.jpwabc`、jianpu-ly 读入与和弦符号、MIDI 导入（`dolce-formats::{fanqie, jpw, jly, midi}`）给编辑器的同步门面（M4 起 TS 只剩门面）。
//!
//! 模型 JSON 的口径同 `formats.rs`：读出的 `ScoreDoc` 带 `source`（门面换回 JS 原文）。提示一律只出 `Msg` 键，门面按界面语言出字。

use crate::model::{parse, to_json};
use dolce_formats::abc::u16s;
use dolce_formats::fanqie::ast::FanqieDoc;
use dolce_formats::fanqie::dialect::{sniff_dialect, Dialect};
use dolce_formats::fanqie::emit::{emit_fanqie, emit_fanqie_song, key_name_of, EmitFanqieOptions};
use dolce_formats::fanqie::fromfanqie::fanqie_to_score_doc;
use dolce_formats::fanqie::dialect::KeyStyle;
use dolce_formats::fanqie::{parse as fparse, plan};
use dolce_formats::jly::{chords, fromjly};
use dolce_formats::jpw::file::{JpwFile, SectionKind, WordsSegment};
use dolce_formats::jpw::lex::{lex_voice, JpwToken};
use dolce_formats::jpw::read::{jpw_to_score_doc, read_jpw_source, JpwError};
use dolce_formats::midi::import;
use dolce_model::{ScoreDoc, Song};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

// ───────────────────────── 文本谱 ─────────────────────────

fn fanqie_options(dialect: &str) -> fparse::ParseOptions {
    fparse::ParseOptions { dialect: Dialect::parse(dialect) }
}

/// 文本谱 → 语法树（`FanqieDoc`）的 JSON。`dialect` 空串 = 嗅探
#[wasm_bindgen(js_name = fanqieParseAst)]
pub fn fanqie_parse_ast(text: &str, dialect: &str) -> String {
    to_json(&fparse::parse_fanqie_ast(text, fanqie_options(dialect)))
}

/// 文本谱 → `ScoreDoc` 的 JSON。`dialect` 空串 = 嗅探
#[wasm_bindgen(js_name = fanqieParse)]
pub fn fanqie_parse(text: &str, dialect: &str) -> String {
    to_json(&fparse::parse_fanqie(text, fanqie_options(dialect)))
}

/// 语法树（JSON）→ `ScoreDoc` 的 JSON
#[wasm_bindgen(js_name = fanqieToScoreDoc)]
pub fn fanqie_to_doc(ast: &str) -> Result<String, JsValue> {
    let ast: FanqieDoc = parse("FanqieDoc", ast)?;
    Ok(to_json(&fanqie_to_score_doc(&ast)))
}

/// 按头部字段判方言：`{ dialect: "tomato" | "shige" | null, reason: Msg }`
#[wasm_bindgen(js_name = fanqieSniff)]
pub fn fanqie_sniff(text: &str) -> String {
    let r = sniff_dialect(text);
    json!({ "dialect": r.dialect.map(Dialect::as_str), "reason": r.reason }).to_string()
}

/// 方言表里编辑器要用的那几样（八度、变音、节奏音、跳字、分隔）
#[wasm_bindgen(js_name = fanqieDialectSpec)]
pub fn fanqie_dialect_spec(dialect: &str) -> Result<String, JsValue> {
    let d = Dialect::parse(dialect).ok_or_else(|| crate::js_sys_error(&format!("未知的文本谱方言 {dialect}")))?;
    let s = d.spec();
    let acc: serde_json::Map<String, Value> = s.accidentals.iter().map(|(k, a)| ((*k).to_string(), serde_json::to_value(a).unwrap())).collect();
    Ok(json!({
        "id": d.as_str(), "name": s.name, "shortName": s.short_name,
        "octaveUp": s.octave_up.to_string(), "octaveDown": s.octave_down.to_string(),
        "accidentals": acc, "rhythmToken": s.rhythm_token.to_string(), "nineIsRhythm": s.nine_is_rhythm,
        "lyricSkip": s.lyric_skip.iter().map(|c| c.to_string()).collect::<Vec<_>>(),
        "wordSeparator": s.word_separator.to_string(), "joinToken": s.join_token.map(|c| c.to_string()),
    })
    .to_string())
}

fn dialect_or_tomato(d: &str) -> Dialect {
    Dialect::parse(d).unwrap_or(Dialect::Tomato)
}

/// `ScoreDoc`（JSON）→ 文本谱原文（没有行结构的曲子先按乐句断行）
#[wasm_bindgen(js_name = fanqieEmit)]
pub fn fanqie_emit(doc: &str, dialect: &str) -> Result<String, JsValue> {
    let doc: ScoreDoc = parse("ScoreDoc", doc)?;
    Ok(emit_fanqie(&doc, dialect_or_tomato(dialect)))
}

/// 一首（JSON）→ 文本谱原文（不带结尾换行）
#[wasm_bindgen(js_name = fanqieEmitSong)]
pub fn fanqie_emit_song(song: &str, dialect: &str, from_fanqie: bool, from_abc: bool) -> Result<String, JsValue> {
    let song: Song = parse("Song", song)?;
    Ok(emit_fanqie_song(&song, dialect_or_tomato(dialect), EmitFanqieOptions { from_fanqie, from_abc }))
}

/// fifths → 调号名（`suffix`：升降号写在字母后）
#[wasm_bindgen(js_name = fanqieKeyNameOf)]
pub fn fanqie_key_name_of(fifths: f64, suffix: bool) -> String {
    key_name_of(fifths, if suffix { KeyStyle::Suffix } else { KeyStyle::Prefix })
}

/// 写成文本谱会丢的弧线：`[嵌套, 奇数连音, 倚音弧]`
#[wasm_bindgen(js_name = fanqieArcLosses)]
pub fn fanqie_arc_losses(song: &str) -> Result<Vec<u32>, JsValue> {
    let song: Song = parse("Song", song)?;
    let l = plan::fanqie_arc_losses(&song);
    Ok(vec![l.nested as u32, l.odd_tuplet as u32, l.grace_arc as u32])
}

// ───────────────────────── .jpwabc ─────────────────────────

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

/// `.Voice` 正文的词法（含空白、注释）：每个 token `[类型, 原文, 起, 止, 行, 列]`
#[wasm_bindgen(js_name = jpwLex)]
pub fn jpw_lex(text: &str) -> String {
    Value::Array(lex_voice(&u16s::enc(text)).iter().map(tok).collect()).to_string()
}

/// 分节解析：读不出 `null`，否则各节（名、行、行号、行首偏移、按节类的内容）
#[wasm_bindgen(js_name = jpwFile)]
pub fn jpw_file(text: &str) -> String {
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

fn jpw_err(e: &JpwError) -> Value {
    match e {
        JpwError::Model(m) => json!({ "error": { "model": m } }),
        JpwError::Fail(why) => json!({ "error": { "fail": why } }),
    }
}

/// `.jpwabc` → `ScoreDoc`：`{ doc }` 或 `{ error: { model: Msg } | { fail: 说明 } }`；分节读不出 `null`
#[wasm_bindgen(js_name = jpwToScoreDoc)]
pub fn jpw_to_doc(text: &str) -> String {
    let Some(f) = JpwFile::from_str(text) else { return "null".into() };
    match jpw_to_score_doc(&f) {
        Ok(d) => json!({ "doc": d }).to_string(),
        Err(e) => jpw_err(&e).to_string(),
    }
}

/// `.jpwabc` 的源文小节（`readJpwSource`）：`{ src }` 或 `{ error }`；分节读不出 `null`
#[wasm_bindgen(js_name = jpwSource)]
pub fn jpw_source(text: &str) -> String {
    let Some(f) = JpwFile::from_str(text) else { return "null".into() };
    match read_jpw_source(&f) {
        Ok(s) => json!({ "src": s }).to_string(),
        Err(e) => jpw_err(&e).to_string(),
    }
}

// ───────────────────────── jianpu-ly ─────────────────────────

/// 整篇读入：`{ doc, losses: Msg[], unknown }`
#[wasm_bindgen(js_name = jlyParse)]
pub fn jly_parse(text: &str) -> String {
    to_json(&fromjly::parse_jly(text))
}

/// 按每行 N 小节重排
#[wasm_bindgen(js_name = jlyRewrap)]
pub fn jly_rewrap(text: &str, measures_per_line: f64, skip_pickup: bool) -> String {
    fromjly::rewrap_jly_text(text, measures_per_line, skip_pickup)
}

#[wasm_bindgen(js_name = jlyIsMusicLine)]
pub fn jly_is_music_line(line: &str) -> bool {
    fromjly::is_jly_music_line(line)
}

/// 一串和弦 token 的时间线（`tokens` 是 JSON 字符串数组）
#[wasm_bindgen(js_name = jlyChordTimeline)]
pub fn jly_chord_timeline(tokens: &str, fallback: f64) -> Result<String, JsValue> {
    let toks: Vec<String> = parse("string[]", tokens)?;
    Ok(to_json(&chords::chord_timeline(&toks, fallback)))
}

/// 和弦文字 + 时值 → `chords=` 的 token（写不出 `undefined`）
#[wasm_bindgen(js_name = jlyHarmonyToChordToken)]
pub fn jly_harmony_to_chord_token(text: &str, whole: f64) -> Option<String> {
    chords::harmony_to_chord_token(text, whole)
}

/// 整音符为单位的时值 → LilyPond 时值文字：`[文字, 是否精确]`
#[wasm_bindgen(js_name = jlyWholeToDuration)]
pub fn jly_whole_to_duration(whole: f64) -> String {
    let (text, exact) = chords::whole_to_duration(whole);
    json!([text, exact]).to_string()
}

// ───────────────────────── MIDI 导入 ─────────────────────────

/// MIDI → `ScoreDoc`：`{ doc, warnings: Msg[] }`，读不出 / 太大回 `{ error: Msg }`。`opts` 是 `MidiImportOptions` 的 JSON
#[wasm_bindgen(js_name = midiImport)]
pub fn midi_import(bytes: &[u8], title: &str, opts: &str) -> Result<String, JsValue> {
    let o: import::MidiImportOptions = parse("MidiImportOptions", opts)?;
    Ok(match import::midi_to_score_doc(bytes, title, &o) {
        Ok(r) => to_json(&r),
        Err(m) => to_json(&json!({ "error": m })),
    })
}

// ───────────────────────── 重排写回原文 ─────────────────────────

/// 文本谱按乐句 / 每行 n 小节重排（`relayoutFanqieText`）：`plans` 是逐首的新行（`planLines` 的结果，`null` = 这首不动）
#[wasm_bindgen(js_name = fanqieRelayoutText)]
pub fn fanqie_relayout_text(text: &str, doc: &str, plans: &str) -> Result<String, JsValue> {
    let d: ScoreDoc = parse("ScoreDoc", doc)?;
    let p: Vec<Option<Vec<dolce_view::phraselines::NewLine>>> = parse("FanqieNewLine[][]", plans)?;
    Ok(dolce_formats::fanqie::relayout::relayout_fanqie_text(text, &d, &p))
}

/// 文本谱增删一处换行（`relayoutFanqieBreak`）：加不上 / 去不掉回 `undefined`
#[wasm_bindgen(js_name = fanqieRelayoutBreak)]
pub fn fanqie_relayout_break(text: &str, doc: &str, after_id: f64, add: bool, page: bool) -> Result<Option<String>, JsValue> {
    let d: ScoreDoc = parse("ScoreDoc", doc)?;
    Ok(dolce_formats::fanqie::relayout::relayout_fanqie_break(text, &d, after_id as i64, add, page))
}

/// `.jpwabc` 按断点只挪 `.Voice` 的 `$`（`relayoutJpwabcText`）：`cuts` 是 `phraseCuts` 的结果
#[wasm_bindgen(js_name = jpwRelayoutText)]
pub fn jpw_relayout_text(text: &str, cuts: &str) -> Result<String, JsValue> {
    let c: Vec<dolce_view::phraselines::PhraseCut> = parse("PhraseCut[]", cuts)?;
    Ok(dolce_formats::jpw::relayout::relayout_jpwabc_text(text, &c))
}

/// 123 / ABC 重排后把原文注释缝回（`spliceComments`）
#[wasm_bindgen(js_name = abcSpliceComments)]
pub fn abc_splice_comments(old_text: &str, old_doc: &str, new_text: &str, new_doc: &str) -> Result<String, JsValue> {
    let o: ScoreDoc = parse("ScoreDoc", old_doc)?;
    let n: ScoreDoc = parse("ScoreDoc", new_doc)?;
    Ok(dolce_formats::abc::comments::splice_comments(old_text, &o, new_text, &n))
}
