//! 由 `ScoreDoc` 拼演唱顺序 / 试听 / 断句输入 / `.jpwabc` 写出（`dolce_view::{playsong,playdoc,phrasesong,phrasedoc}`、
//! `dolce_formats::jpw::input`）。门面 `score/play.ts`。推理出错抛 `Error`，`message` 是说明原文（同 `playOrderOf` 等）。

use dolce_model::{ScoreDoc, Song};
use dolce_view::{phrasedoc, phrasesong, playdoc, playsong, slots};
use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::model::{parse, to_json};

fn view_err(e: dolce_play::PlayError) -> JsValue {
    super::js_sys_error(&e.0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceOut<'a> {
    source: &'a dolce_play::timeline::PlaySource,
    play_data: &'a dolce_view::playdata::PlayData,
}

fn source_out(r: Option<(dolce_play::timeline::PlaySource, dolce_view::playdata::PlayData)>) -> String {
    match r {
        Some((source, pd)) => to_json(&SourceOut { source: &source, play_data: &pd }),
        None => "null".into(),
    }
}

/// 试听 / MIDI 的统一入口（`playSourceOf`）：回 `{source: PlaySource, playData: PlayData}`，这首没有曲行回 `"null"`
#[wasm_bindgen(js_name = modelPlaySource)]
pub fn model_play_source(doc: &str, song: usize, for_expanded: bool) -> Result<String, JsValue> {
    let d: ScoreDoc = parse("ScoreDoc", doc)?;
    playsong::play_source_of(&d, song, playsong::PlaySongOptions { for_expanded }).map(source_out).map_err(view_err)
}

/// MusicXML 形状的一首（`playSourceOfDoc`）：回 `{source, playData}`
#[wasm_bindgen(js_name = modelPlaySourceOfDoc)]
pub fn model_play_source_of_doc(song: &str, melody_only: bool) -> Result<String, JsValue> {
    let s: Song = parse("Song", song)?;
    playdoc::play_source_of_doc(&s, melody_only).map(|r| source_out(Some(r))).map_err(view_err)
}

/// 简谱形状的演唱顺序（`playDataOfSong`，已折回第一份声部）：回 `PlayData`，这首没有曲行回 `"null"`
#[wasm_bindgen(js_name = modelPlayData)]
pub fn model_play_data(doc: &str, song: usize, for_expanded: bool) -> Result<String, JsValue> {
    let d: ScoreDoc = parse("ScoreDoc", doc)?;
    let view = slots::doc_view(&d, None);
    playsong::play_data_of_song(&d, &view, song, playsong::PlaySongOptions { for_expanded }).map(|pd| to_json(&pd)).map_err(view_err)
}

#[derive(Serialize)]
struct PhraseOut {
    part: dolce_play::phraseinput::PhrasePart,
    /// 拍平下标 → 元素 id
    ids: Vec<Option<dolce_model::ElementId>>,
}

/// 简谱形状的断句输入（`phrasePartOfSong`）：回 `{part, ids}`，这首没有曲行回 `"null"`
#[wasm_bindgen(js_name = modelPhrasePart)]
pub fn model_phrase_part(doc: &str, song: usize) -> Result<String, JsValue> {
    let d: ScoreDoc = parse("ScoreDoc", doc)?;
    let view = slots::doc_view(&d, None);
    phrasesong::phrase_part_of_song(&d, &view, song).map(|r| to_json(&r.map(|(part, ids)| PhraseOut { part, ids }))).map_err(view_err)
}

/// MusicXML 形状的断句输入（`phrasePartOfDoc`）：回 `{part, ids}`
#[wasm_bindgen(js_name = modelPhrasePartOfDoc)]
pub fn model_phrase_part_of_doc(song: &str, part_index: usize, distinct: bool) -> Result<String, JsValue> {
    let s: Song = parse("Song", song)?;
    phrasedoc::phrase_part_of_doc(&s, part_index, distinct).map(|(part, ids)| to_json(&PhraseOut { part, ids })).map_err(view_err)
}

/// 跳转记号所在的小节下标（`phraseJumpMeasures`，升序）
#[wasm_bindgen(js_name = modelPhraseJumpMeasures)]
pub fn model_phrase_jump_measures(song: &str, part_index: usize) -> Result<Vec<u32>, JsValue> {
    let s: Song = parse("Song", song)?;
    Ok(phrasedoc::phrase_jump_measures(&s, part_index).into_iter().map(|i| i as u32).collect())
}

/// `ScoreDoc` → `.jpwabc`（`emitJpwabc`）：这首没有曲行回 None
#[wasm_bindgen(js_name = modelEmitJpwabc)]
pub fn model_emit_jpwabc(doc: &str, song: usize) -> Result<Option<String>, JsValue> {
    let d: ScoreDoc = parse("ScoreDoc", doc)?;
    dolce_formats::jpw::input::emit_jpwabc(&d, song).map_err(|e| super::js_sys_error(&e))
}
