//! 由 `ScoreDoc` 拼演唱顺序 / 试听 / 断句输入 / `.jpwabc` 写出（`dolce_view::{playsong,playdoc,phrasesong,phrasedoc}`、
//! `dolce_formats::jpw::input`）。门面 `score/play.ts`。推理出错抛 `Error`，`message` 是说明原文（同 `playOrderOf` 等）。

use dolce_model::{ScoreDoc, Song};
use dolce_view::{phrasedoc, phraselines, phrasesong, playdoc, playsong, slots};
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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyBreakOptionsIn {
    lines_per_page: Option<f64>,
    section_new_page: Option<bool>,
    use_mid_breaks: Option<bool>,
}

#[derive(Serialize)]
struct LineStartOut {
    id: dolce_model::ElementId,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    page: bool,
}

/// 成书：断句断点 → 行首（`applyPhraseBreaksToDoc`，写回由门面经 `applyBreaks` 做）。`part` 是断句输入、`ids` 拍平下标 → 元素 id。
/// 回 `{starts: [{id, page?}], lines, pages}`
#[wasm_bindgen(js_name = modelPhraseLineStarts)]
pub fn model_phrase_line_starts(song: &str, part: &str, ids: &str, breaks: &str, opts: &str) -> Result<String, JsValue> {
    let s: Song = parse("Song", song)?;
    let part: dolce_play::phraseinput::PhrasePart = parse("PhrasePart", part)?;
    let ids: Vec<Option<dolce_model::ElementId>> = parse("ids", ids)?;
    let b: dolce_play::phrase::PhraseBreaks = parse("PhraseBreaks", breaks)?;
    let o: ApplyBreakOptionsIn = parse("ApplyBreakOptions", opts)?;
    let d = dolce_view::bookbreaks::ApplyBreakOptions::default();
    let opt = dolce_view::bookbreaks::ApplyBreakOptions {
        lines_per_page: o.lines_per_page.unwrap_or(d.lines_per_page),
        section_new_page: o.section_new_page.unwrap_or(d.section_new_page),
        use_mid_breaks: o.use_mid_breaks.unwrap_or(d.use_mid_breaks),
    };
    let (starts, lines, pages) = dolce_view::bookbreaks::phrase_line_starts(&s, &part, &ids, &b, opt).map_err(view_err)?;
    let starts: Vec<LineStartOut> = starts.into_iter().map(|l| LineStartOut { id: l.id, page: l.page }).collect();
    Ok(to_json(&serde_json::json!({ "starts": starts, "lines": lines, "pages": pages })))
}

/// 成书段落词挂到哪个和弦（`putSectionWords`）：`rows` 是 `[{text, note_ordinal}]`，回 `[[元素 id, 词]]`
#[wasm_bindgen(js_name = modelSectionWordTargets)]
pub fn model_section_word_targets(song: &str, part: &str, ids: &str, rows: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    struct Row {
        text: String,
        note_ordinal: f64,
    }
    let s: Song = parse("Song", song)?;
    let part: dolce_play::phraseinput::PhrasePart = parse("PhrasePart", part)?;
    let ids: Vec<Option<dolce_model::ElementId>> = parse("ids", ids)?;
    let rows: Vec<Row> = parse("rows", rows)?;
    let rows: Vec<(String, f64)> = rows.into_iter().map(|r| (r.text, r.note_ordinal)).collect();
    Ok(to_json(&dolce_view::bookbreaks::section_word_targets(&s, &part, &ids, &rows)))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanIn {
    /// `"phrase"` / `"bars"`
    kind: String,
    #[serde(default)]
    n: f64,
    /// 按乐句、有尺子时的断句参数（成书出厂值，门面从样式表取）
    #[serde(default)]
    content: Option<dolce_play::phrase::PhraseOptions>,
    #[serde(default)]
    mid: bool,
}

#[derive(serde::Deserialize)]
struct MeasuredIn {
    width: f64,
    spans: Vec<(i64, dolce_play::phrase::Span)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PhraseCutsOut {
    cuts: Option<Vec<phraselines::PhraseCut>>,
    lines: Option<Vec<phraselines::NewLine>>,
    kept: bool,
    overflow: Option<usize>,
}

/// 按乐句 / 每行 n 小节重排的新行与断点（`phraseCuts` / `planLines`）。`plan`：`{kind, n?, content?, mid?}`；
/// `measured`：`{width, spans: [[元素 id, {x0, x1, x1b?}]]}` 或 `"null"`（没有尺子）。回 `{cuts, lines, kept, overflow}`
#[wasm_bindgen(js_name = modelPhraseCuts)]
pub fn model_phrase_cuts(doc: &str, song: usize, plan: &str, measured: &str) -> Result<String, JsValue> {
    let d: ScoreDoc = parse("ScoreDoc", doc)?;
    let p: PlanIn = parse("LinePlan", plan)?;
    let m: Option<MeasuredIn> = parse("Measured", measured)?;
    let m = m.map(|m| phraselines::Measured { width: m.width, spans: m.spans.into_iter().collect() });
    let content = p.content.unwrap_or_default();
    let plan = match p.kind.as_str() {
        "bars" => phraselines::LinePlan::Bars(p.n),
        _ => phraselines::LinePlan::Phrase { content: &content, mid: p.mid },
    };
    let view = slots::doc_view(&d, None);
    let (cuts, out) = phraselines::phrase_cuts(&d, &view, song, &plan, m.as_ref()).map_err(view_err)?;
    Ok(to_json(&PhraseCutsOut { cuts, lines: out.lines, kept: out.kept, overflow: out.overflow }))
}

/// 照原文现有的行结构，在元素 `afterId` 之后加一刀 / 去掉它后面那一刀（`fanqieLinesEdited`）：回新行或 `"null"`
#[wasm_bindgen(js_name = modelPhraseLinesEdited)]
pub fn model_phrase_lines_edited(doc: &str, song: usize, after_id: f64, add: bool, page: bool) -> Result<String, JsValue> {
    let d: ScoreDoc = parse("ScoreDoc", doc)?;
    let view = slots::doc_view(&d, None);
    Ok(to_json(&phraselines::lines_edited(&view, song, after_id as i64, add, page)))
}
