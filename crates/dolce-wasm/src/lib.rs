//! wasm 绑定。数据过边界一律 JSON 字符串（结构由 ts-rs 生成的类型说明），报错抛 `Error`，`message` 是 JSON：
//! `{"kind":"stale",…}` / `{"kind":"failure",…}`（同 `dolce_session::EngineError`）。
//!
//! 迁移期另出几样对拍用的纯函数（`xmlDigest` 等），Node 门面 `out/cli/dolce.js` 与 dev `rs-diff.mjs` 用。

use dolce_session::{EngineError, UpdateRequest};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

/// 本 crate 的版本（门面核对载的是哪一份）。
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").into()
}

fn engine_err(e: EngineError) -> JsValue {
    js_sys_error(&serde_json::to_string(&e).unwrap_or_default())
}

fn js_sys_error(message: &str) -> JsValue {
    // 不引 js-sys：`Error` 构造经 wasm-bindgen 的内建导入
    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_name = Error)]
        fn make_error(message: &str) -> JsValue;
    }
    make_error(message)
}

/// 文档会话（`EngineSession` 的 wasm 侧）。
#[wasm_bindgen]
pub struct Session(dolce_session::Session);

#[wasm_bindgen]
impl Session {
    #[wasm_bindgen(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Session {
        Session(dolce_session::Session::new())
    }

    /// `req` 是 `UpdateRequest` 的 JSON，回 `UpdateReply` 的 JSON。
    pub fn update(&mut self, req: &str) -> Result<String, JsValue> {
        let req: UpdateRequest = serde_json::from_str(req).map_err(|e| js_sys_error(&format!("UpdateRequest：{e}")))?;
        let r = self.0.update(req).map_err(engine_err)?;
        Ok(serde_json::to_string(&r).expect("序列化"))
    }

    pub fn page(&self, rev: u32, index: u32) -> Result<String, JsValue> {
        self.0.page(rev, index).map_err(engine_err)
    }

    pub fn emit(&self, rev: u32, target: &str) -> Result<String, JsValue> {
        self.0.emit(rev, target).map_err(engine_err)
    }
}

/// XML 树对拍原料（同 `dolce xml-dump` 的口径，哈希由调用方算）：解析成功回
/// `{"ok":true,"xml":序列化文本,"spans":"start-end,…"}`（各元素原文区间，UTF-16、文档序）；读不出回 `{"ok":false,"message":…,"at":…}`。
#[wasm_bindgen(js_name = xmlDigest)]
pub fn xml_digest(text: &str) -> String {
    match dolce_xml::parse(text) {
        Ok(d) => {
            let mut spans = String::new();
            let mut stack = vec![d.root];
            while let Some(id) = stack.pop() {
                spans.push_str(&format!("{}-{},", d.tree.start(id), d.tree.end(id)));
                let kids: Vec<_> = d.tree.children(id).collect();
                stack.extend(kids.into_iter().rev());
            }
            serde_json::json!({ "ok": true, "xml": d.serialize(), "spans": spans }).to_string()
        }
        Err(e) => serde_json::json!({ "ok": false, "message": e.message, "at": e.at }).to_string(),
    }
}

// ───────────────────────── 演唱顺序、断句、时间轴、MIDI（dolce-play）─────────────────────────
//
// 入参、回值都是 JSON（形状见 dolce-play 各输入 / 产物类型；TS 侧编解码在 src/engine/play.ts）。
// TS 原实现会抛错的输入（没有和弦的小节取时值等）这里抛 `Error`，message 是说明文字。

fn parse<T: serde::de::DeserializeOwned>(what: &str, json: &str) -> Result<T, JsValue> {
    serde_json::from_str(json).map_err(|e| js_sys_error(&format!("{what}：{e}")))
}

fn json<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("序列化")
}

fn play_err(e: dolce_play::PlayError) -> JsValue {
    js_sys_error(&e.0)
}

use dolce_play::{phrase, phraseinput, playorder, timeline};

#[wasm_bindgen(js_name = playOrderOf)]
pub fn play_order_of(parts: &str, jumps: &str) -> Result<String, JsValue> {
    let parts: Vec<playorder::PlayPart> = parse("parts", parts)?;
    let jumps: playorder::PlayJumps = parse("jumps", jumps)?;
    playorder::play_order_of(&parts, &jumps).map(|o| json(&o)).map_err(play_err)
}

/// 回 `PlayOrder` 的 JSON，或 `"null"`（`seq` 里的段落一个都不存在）
#[wasm_bindgen(js_name = sectionPlayOrder)]
pub fn section_play_order(parts: &str, jumps: &str, seq: &str, marks: &str) -> Result<String, JsValue> {
    let parts: Vec<playorder::PlayPart> = parse("parts", parts)?;
    let jumps: playorder::PlayJumps = parse("jumps", jumps)?;
    let seq: Vec<String> = parse("seq", seq)?;
    let marks: Vec<playorder::SectionMark> = parse("marks", marks)?;
    playorder::section_play_order(&parts, &jumps, &seq, &marks).map(|o| json(&o)).map_err(play_err)
}

#[wasm_bindgen(js_name = singPlayOrder)]
pub fn sing_play_order(parts: &str, marks: &str, pages: &str) -> Result<String, JsValue> {
    let parts: Vec<playorder::PlayPart> = parse("parts", parts)?;
    let marks: Vec<playorder::SectionMark> = parse("marks", marks)?;
    let pages: Vec<playorder::SingPassSpec> = parse("pages", pages)?;
    playorder::sing_play_order(&parts, &marks, &pages).map(|o| json(&o)).map_err(play_err)
}

/// `part0` 是 `PlayPart` 的 JSON 或 `"null"`
#[wasm_bindgen(js_name = playOrderFromSpec)]
pub fn play_order_from_spec(items: &str, part0: &str) -> Result<String, JsValue> {
    let items: Vec<playorder::RepeatSpecItem> = parse("items", items)?;
    let part0: Option<playorder::PlayPart> = parse("part0", part0)?;
    Ok(json(&playorder::play_order_from_spec(&items, part0.as_ref())))
}

#[wasm_bindgen(js_name = playOrderByVerses)]
pub fn play_order_by_verses(measure_count: f64, passes: f64) -> String {
    json(&playorder::play_order_by_verses(measure_count, passes))
}

/// `items` 只要各项的 `mid` / `end`
#[wasm_bindgen(js_name = unplayedMeasures)]
pub fn unplayed_measures(items: &str, measure_count: usize) -> Result<String, JsValue> {
    let items: Vec<playorder::PlayItem> = parse("items", items)?;
    Ok(json(&playorder::unplayed_measures(&items, measure_count)))
}

#[wasm_bindgen(js_name = buildTimeline)]
pub fn build_timeline(src: &str) -> Result<String, JsValue> {
    let src: timeline::PlaySource = parse("PlaySource", src)?;
    Ok(json(&timeline::build_timeline(&src)))
}

/// `opts` 是 `PlayOptions` 的 JSON 或 `"null"`
#[wasm_bindgen(js_name = toMidi)]
pub fn to_midi(src: &str, opts: &str, click: bool) -> Result<Vec<u8>, JsValue> {
    let src: timeline::PlaySource = parse("PlaySource", src)?;
    let opts: Option<timeline::PlayOptions> = parse("PlayOptions", opts)?;
    Ok(dolce_play::midi::to_midi(&src, opts.as_ref(), click))
}

#[wasm_bindgen(js_name = playTempo)]
pub fn play_tempo(tempo: f64, opts: &str) -> Result<f64, JsValue> {
    let opts: Option<timeline::PlayOptions> = parse("PlayOptions", opts)?;
    Ok(timeline::play_tempo(tempo, opts.as_ref()))
}

#[wasm_bindgen(js_name = partGain)]
pub fn part_gain(opts: &str, part: usize) -> Result<f64, JsValue> {
    let opts: Option<timeline::PlayOptions> = parse("PlayOptions", opts)?;
    Ok(timeline::part_gain(opts.as_ref(), part))
}

#[wasm_bindgen(js_name = computePhraseBreaks)]
pub fn compute_phrase_breaks(part: &str, opts: &str) -> Result<String, JsValue> {
    let part: phraseinput::PhrasePart = parse("PhrasePart", part)?;
    let opts: phrase::PhraseOptions = parse("PhraseOptions", opts)?;
    Ok(json(&phrase::compute_phrase_breaks(&part, &opts)))
}

#[wasm_bindgen(js_name = targetMeasForCells)]
pub fn target_meas_for_cells(part: &str, cells: f64) -> Result<f64, JsValue> {
    let part: phraseinput::PhrasePart = parse("PhrasePart", part)?;
    Ok(phrase::target_meas_for_cells(&part, cells))
}

/// 断句的逐和弦事实（`applybreaks.ts` 还在 TS，经这里取）：`[主歌词, 标点分, 旋律键]`
#[wasm_bindgen(js_name = phraseChordFacts)]
pub fn phrase_chord_facts(chord: &str) -> Result<String, JsValue> {
    let c: phraseinput::PhraseChord = parse("PhraseChord", chord)?;
    Ok(json(&(phrase::main_lyric_text(&c), phrase::lyric_punct_score(&c), phrase::note_key_of(&c))))
}

/// 一行开头的旋律指纹（`chords` 是 `PhraseChord[]` 的 JSON）
#[wasm_bindgen(js_name = headFpOf)]
pub fn head_fp_of(chords: &str) -> Result<String, JsValue> {
    let cs: Vec<phraseinput::PhraseChord> = parse("PhraseChord[]", chords)?;
    let refs: Vec<&phraseinput::PhraseChord> = cs.iter().collect();
    Ok(phrase::head_fp_of(&refs))
}

// ───────────────────────── 模型（dolce-model，M2 迁移中）─────────────────────────

/// 对拍用：`ScoreDoc` 的 JSON 读进 Rust 类型再写回（核对类型与 `doc.ts` 逐字段对得上）。读不进抛 `Error`。
#[wasm_bindgen(js_name = docRoundtrip)]
pub fn doc_roundtrip(doc: &str) -> Result<String, JsValue> {
    let d: dolce_model::ScoreDoc = parse("ScoreDoc", doc)?;
    Ok(json(&d))
}

mod probe;

/// 对拍用：查询层（`model/jianpu.ts` 等）在这份谱上的摘要（口径见 dev `rs-diff.mjs query`）
#[wasm_bindgen(js_name = queryDigest)]
pub fn query_digest(doc: &str) -> Result<String, JsValue> {
    let d: dolce_model::ScoreDoc = parse("ScoreDoc", doc)?;
    Ok(json(&probe::query_digest(&d)))
}
