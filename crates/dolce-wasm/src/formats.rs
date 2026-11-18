//! ABC 家族（123 / ABC / jcx，crates/dolce-formats::abc）与丢失清单（`capability`）给编辑器的同步门面（M3-6 起 TS 只剩门面）。
//!
//! 模型 JSON 的口径同 `model.rs`：送进来的带 `_oid`、不带 `source`；读出的 `ScoreDoc` 带 `source`（门面换回 JS 原文，孤立代理过边界会变 U+FFFD）；
//! 丢失清单的页眉字体要查 MusicXML 表层，按句柄给（0 = 没有）。

use crate::model::{parse, to_json, with_surface};
use dolce_formats::abc::lex::Dialect;
use dolce_formats::abc::lyricslot::{is_lyric_slot, LyricSlotRule};
use dolce_formats::abc::{dialect, emit, fields, lex, lyricline, parse as abcparse, u16s};
use dolce_formats::capability::{self, Feature, TargetFormat};
use dolce_base::text::SourceSpan;
use dolce_model::{ScoreDoc, SourceFormat};
use wasm_bindgen::prelude::*;

fn dialect_of(name: &str) -> Dialect {
    match name {
        "abc" => Dialect::Abc,
        "jcx" => Dialect::Jcx,
        _ => Dialect::J123,
    }
}

/// 原文 → `ScoreDoc` 的 JSON（`dialect`：`123` / `abc` / `jcx`；诊断在 `diagnostics` 里，不抛）
#[wasm_bindgen(js_name = formatsParse)]
pub fn formats_parse(dialect: &str, text: &str) -> String {
    to_json(&abcparse::parse_abc_family(text, dialect_of(dialect)))
}

/// `ScoreDoc`（JSON）→ 原文
#[wasm_bindgen(js_name = formatsEmit)]
pub fn formats_emit(dialect: &str, doc: &str) -> Result<String, JsValue> {
    let doc: ScoreDoc = parse("ScoreDoc", doc)?;
    Ok(match dialect_of(dialect) {
        Dialect::Abc => emit::emit_abc(&doc),
        Dialect::Jcx => emit::emit_jcx(&doc),
        Dialect::J123 => emit::emit_123(&doc),
    })
}

fn target(name: &str) -> Result<TargetFormat, JsValue> {
    TargetFormat::parse(name).ok_or_else(|| crate::js_sys_error(&format!("未知的目标格式 {name}")))
}

fn names(v: impl IntoIterator<Item = Feature>) -> String {
    to_json(&v.into_iter().map(Feature::as_str).collect::<Vec<_>>())
}

/// 这份文档用到的特性（JSON 字符串数组，按发现先后）
#[wasm_bindgen(js_name = formatsFeaturesUsed)]
pub fn formats_features_used(doc: &str, h: u32) -> Result<String, JsValue> {
    let doc: ScoreDoc = parse("ScoreDoc", doc)?;
    Ok(with_surface(h, |s| names(capability::features_used(&doc, s))))
}

/// 存成 `target` 会丢掉的特性（JSON 字符串数组；名字与排序门面按界面语言做）
#[wasm_bindgen(js_name = formatsPlanSave)]
pub fn formats_plan_save(doc: &str, h: u32, target_name: &str) -> Result<String, JsValue> {
    let t = target(target_name)?;
    let doc: ScoreDoc = parse("ScoreDoc", doc)?;
    Ok(with_surface(h, |s| names(capability::plan_save(&doc, t, s))))
}

/// 目标格式装不下的特性（能力表那一行）
#[wasm_bindgen(js_name = formatsGone)]
pub fn formats_gone(target_name: &str) -> Result<String, JsValue> {
    Ok(names(capability::gone(target(target_name)?)))
}

/// 全部特性名（能力表的列）
#[wasm_bindgen(js_name = formatsAllFeatures)]
pub fn formats_all_features() -> String {
    names(Feature::ALL.iter().copied())
}

/// 歌词行各音节（含跳音符、续记号这类空音节）在 `body` 里的起点（UTF-16）。`skip`：跳音符（123 `/`、ABC `*`）；
/// `join_tilde`：Muse `.jcx` 的 `~` 并字
#[wasm_bindgen(js_name = formatsLyricStarts)]
pub fn formats_lyric_starts(body: &str, skip: &str, join_tilde: bool) -> Vec<u32> {
    let skip = if skip == "*" { '*' } else { '/' };
    lyricline::parse_lyric_line(&u16s::enc(body), 1.0, SourceSpan { line: 0, column: 0, offset: 0, length: 0 }, None, skip, &mut |_, _| {}, join_tilde, false)
        .starts
        .into_iter()
        .map(|s| s as u32)
        .collect()
}

/// 原文区间 `[from, to)` 里的歌词对位格数（按元素的原文位置；休止占不占格按来源方言）
#[wasm_bindgen(js_name = formatsSlotsBetween)]
pub fn formats_slots_between(doc: &str, from: u32, to: u32) -> Result<u32, JsValue> {
    let doc: ScoreDoc = parse("ScoreDoc", doc)?;
    let rule = if matches!(doc.source_format, SourceFormat::Abc | SourceFormat::Jcx) { LyricSlotRule::Abc } else { LyricSlotRule::J123 };
    let mut n = 0;
    for song in &doc.songs {
        for part in &song.parts {
            for m in &part.measures {
                for el in &m.elements {
                    let Some(off) = el.source().map(|s| s.offset) else { continue };
                    if off < from || off >= to {
                        continue;
                    }
                    if is_lyric_slot(el, rule, 1.0) {
                        n += 1;
                    }
                }
            }
        }
    }
    Ok(n)
}

/// 和弦名能不能不带引号写（123 规范 §8.1）
#[wasm_bindgen(js_name = formatsIsBareChord)]
pub fn formats_is_bare_chord(name: &str) -> bool {
    lex::is_bare_chord(&u16s::enc(name))
}

/// 123 的时值（减时线、附点、增时线）→ `Duration` 的 JSON
#[wasm_bindgen(js_name = formatsDuration123)]
pub fn formats_duration_123(beams: u32, dots: u32, sustains: u32) -> String {
    to_json(&dialect::duration_123(beams, dots, sustains as usize))
}

/// 调号拼写归一（`♭A` → `bA` 等）
#[wasm_bindgen(js_name = formatsNormalizeSpelling)]
pub fn formats_normalize_spelling(s: &str) -> String {
    fields::normalize_spelling(s)
}
