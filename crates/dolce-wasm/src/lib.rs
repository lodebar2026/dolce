//! wasm 绑定。数据过边界一律 JSON 字符串（结构由 ts-rs 生成的类型说明），报错抛 `Error`，`message` 是 JSON：
//! `{"kind":"stale",…}` / `{"kind":"failure",…}`（同 `dolce_session::EngineError`）。
//!
//! 迁移期另出几样对拍用的纯函数（`xmlDigest` 等），Node 门面 `out/cli/dolce.js` 与 dev `rs-diff.mjs` 用。

mod formats;
mod model;

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

#[cfg(feature = "probe")]
/// XML 树对拍原料（同 `dolce xml-dump` 的口径，哈希由调用方算）：解析成功回
/// `{"ok":true,"xml":序列化文本,"spans":"start-end,…"}`（各元素原文区间，UTF-16、文档序）；读不出回 `{"ok":false,"message":…,"at":…}`。
#[cfg(feature = "probe")]
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

// ───────────────────────── 模型对拍探针（dolce-model）─────────────────────────

#[cfg(feature = "probe")]
mod probe;

#[cfg(feature = "probe")]
mod probe_fanqie;

#[cfg(feature = "probe")]
mod probes {
    //! 对拍探针（dev `rs-diff.mjs` 各档的 Rust 一侧），只在 `--features probe` 的那份里（`build-wasm.mjs probe` → out/dolce-probe/，不进打包）。
    use super::{json, parse, probe};
    use wasm_bindgen::prelude::*;

    /// 对拍用：`ScoreDoc` 的 JSON 读进 Rust 类型再写回（核对类型与 `doc.ts` 逐字段对得上）。读不进抛 `Error`。
    #[wasm_bindgen(js_name = docRoundtrip)]
    pub fn doc_roundtrip(doc: &str) -> Result<String, JsValue> {
        let d: dolce_model::ScoreDoc = parse("ScoreDoc", doc)?;
        Ok(json(&d))
    }


    /// 对拍用：查询层（`model/jianpu.ts` 等）在这份谱上的摘要（口径见 dev `rs-diff.mjs query`）
    #[wasm_bindgen(js_name = queryDigest)]
    pub fn query_digest(doc: &str) -> Result<String, JsValue> {
        let d: dolce_model::ScoreDoc = parse("ScoreDoc", doc)?;
        Ok(json(&probe::query_digest(&d)))
    }

    /// 对拍用：MusicXML 读入的摘要（模型、绑定表、读后的树；口径见 dev `rs-diff.mjs fromxml`）
    #[wasm_bindgen(js_name = fromXmlDigest)]
    pub fn from_xml_digest(text: &str) -> String {
        json(&probe::from_xml_digest(text))
    }

    /// 对拍用：MusicXML 写出的摘要（口径见 dev `rs-diff.mjs toxml`）
    #[wasm_bindgen(js_name = toXmlDigest)]
    pub fn to_xml_digest(text: &str) -> String {
        json(&probe::to_xml_digest(text))
    }

    /// 对拍用：MusicXML 上执行一串编辑动作（口径见 dev `rs-diff.mjs edit`）
    #[wasm_bindgen(js_name = editDigest)]
    pub fn edit_digest(text: &str, script: &str) -> Result<String, JsValue> {
        let s: probe::EditScript = parse("EditScript", script)?;
        Ok(json(&probe::edit_digest(text, &s)))
    }

    /// 对拍用：简繁转换（口径见 dev `rs-diff.mjs hanconv`）。`doc` 是读好的 ScoreDoc JSON，`text` 是原文（空串 = 不做原文写回）；
    /// `parse(text) → ScoreDoc JSON`、`s2t` / `t2s` 是 TS 那边的读入与词表
    #[wasm_bindgen(js_name = hanconvDigest)]
    pub fn hanconv_digest(doc: &str, text: &str, parse: &js_sys::Function, s2t: &js_sys::Function, t2s: &js_sys::Function) -> String {
        json(&probe::hanconv_digest(doc, text, parse, s2t, t2s))
    }

    /// 对拍用：编辑层的纯函数小表
    #[wasm_bindgen(js_name = editTables)]
    pub fn edit_tables() -> String {
        json(&probe::edit_tables())
    }

    /// 对拍用：文本来源投成 MusicXML 形状及周边（口径见 dev `rs-diff.mjs project`）
    #[wasm_bindgen(js_name = projectDigest)]
    pub fn project_digest(doc: &str) -> Result<String, JsValue> {
        let d: dolce_model::ScoreDoc = parse("ScoreDoc", doc)?;
        Ok(json(&probe::project_digest(&d)))
    }

    /// 对拍用：ABC 家族音乐体词法（口径见 dev `rs-diff.mjs lex`）：全文按 `\n` 切行、逐行扫，回各行的 token 与报错
    #[wasm_bindgen(js_name = lexDigest)]
    pub fn lex_digest(dialect: &str, text: &str) -> String {
        json(&probe::lex_digest(dialect, text))
    }

    /// 对拍用：字段行与各字段值的读法（口径见 dev `rs-diff.mjs fields`）
    #[wasm_bindgen(js_name = fieldsDigest)]
    pub fn fields_digest(text: &str) -> String {
        json(&probe::fields_digest(text))
    }

    /// 对拍用：ABC 家族整篇解析成 `ScoreDoc`（口径见 dev `rs-diff.mjs parse`）
    #[wasm_bindgen(js_name = parseAbcFamily)]
    pub fn parse_abc_family(dialect: &str, text: &str) -> String {
        use dolce_formats::abc::{lex::Dialect, parse};
        let d = match dialect {
            "abc" => Dialect::Abc,
            "jcx" => Dialect::Jcx,
            _ => Dialect::J123,
        };
        json(&parse::parse_abc_family(text, d))
    }

    /// 对拍用：ScoreDoc（JSON）→ 123 / ABC / jcx 文本（口径见 dev `rs-diff.mjs emit`）
    #[wasm_bindgen(js_name = emitAbcFamily)]
    pub fn emit_abc_family(dialect: &str, doc: &str) -> Result<String, JsValue> {
        use dolce_formats::abc::emit;
        let doc: dolce_model::ScoreDoc = super::parse("ScoreDoc", doc)?;
        Ok(match dialect {
            "abc" => emit::emit_abc(&doc),
            "jcx" => emit::emit_jcx(&doc),
            _ => emit::emit_123(&doc),
        })
    }

    /// 对拍用：文本按 `from` 方言解析、再按 `to` 方言写出（全走 Rust）
    #[wasm_bindgen(js_name = convertAbcFamily)]
    pub fn convert_abc_family(from: &str, to: &str, text: &str) -> String {
        use dolce_formats::abc::{emit, lex::Dialect, parse};
        let d = match from {
            "abc" => Dialect::Abc,
            "jcx" => Dialect::Jcx,
            _ => Dialect::J123,
        };
        let doc = parse::parse_abc_family(text, d);
        match to {
            "abc" => emit::emit_abc(&doc),
            "jcx" => emit::emit_jcx(&doc),
            _ => emit::emit_123(&doc),
        }
    }

    /// 对拍用：丢失清单。`{"used":[…],"loss":{目标:[…]}}`，各列表按名字排（口径见 dev `rs-diff.mjs capability`）
    fn capability_digest(doc: &dolce_model::ScoreDoc, surface: Option<&dolce_model::xmlsurface::Surface>) -> String {
        use dolce_formats::capability::{features_used, plan_save, TargetFormat};
        let names = |v: Vec<dolce_formats::capability::Feature>| {
            let mut s: Vec<&str> = v.into_iter().map(|f| f.as_str()).collect();
            s.sort();
            s
        };
        let mut loss = serde_json::Map::new();
        for t in ["123", "abc", "jpwabc", "tomato", "shige", "jly", "jcx", "musicxml"] {
            loss.insert(t.into(), serde_json::json!(names(plan_save(doc, TargetFormat::parse(t).unwrap(), surface))));
        }
        json(&serde_json::json!({ "used": names(features_used(doc, surface)), "loss": loss }))
    }

    /// 对拍用：ScoreDoc（JSON，无表层）的丢失清单
    #[wasm_bindgen(js_name = capabilityDoc)]
    pub fn capability_doc(doc: &str) -> Result<String, JsValue> {
        let doc: dolce_model::ScoreDoc = super::parse("ScoreDoc", doc)?;
        Ok(capability_digest(&doc, None))
    }

    /// 对拍用：MusicXML 原文（Rust 自己读，带表层）的丢失清单
    #[wasm_bindgen(js_name = capabilityXml)]
    pub fn capability_xml(text: &str) -> String {
        match dolce_model::fromxml::load_score_doc(text) {
            Ok(l) => capability_digest(&l.doc, Some(&l.surface)),
            Err(e) => json(&serde_json::json!({ "error": e.key })),
        }
    }

    /// 对拍用：方言时值换算等小表
    #[wasm_bindgen(js_name = dialectTables)]
    pub fn dialect_tables() -> String {
        json(&probe::dialect_tables())
    }
}
