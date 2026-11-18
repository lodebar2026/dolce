//! 模型簇（crates/dolce-model）给编辑器的同步门面：MusicXML 读写、表层查询、源码同步索引、编辑动作、声部面板、转记、简繁。
//!
//! 模型以 JSON 过边界（形状 = `doc.ts`，可绑对象带 `_oid`）；MusicXML 的表层（原树 + 绑定表）留在这里，按句柄取，
//! TS 侧镜像对象经旁表记着自己的句柄与 `_oid`（`src/model/rustdoc.ts`）。句柄由 TS 在镜像回收后释放。
//! 失败抛 `Error`，`message` 是 `Msg` 的 JSON（`{"key":…}`），门面转成 `ModelError`。

use dolce_base::Msg;
use dolce_model::edit::{self, EditCmd, EditHooks};
use dolce_model::xmlsurface::Surface;
use dolce_model::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

/// 一份读进来的 MusicXML：读入时的模型（同步索引按它建）与表层
struct Handle {
    doc: ScoreDoc,
    surface: Surface,
    /// 原文长度（按它估占用）
    size: usize,
    /// 表层改过几次（桌面版原生排版按它判断要不要重送快照，`modelSurfaceGen`）
    gen: u32,
    /// 最近一次用到的时刻（淘汰用）
    last: u64,
}

/// 句柄表。TS 镜像回收后由 `FinalizationRegistry` 释放；但同步一口气跑完的批处理（Node 脚本）里回收回调轮不到，
/// 所以另设上限：原文总量超过 [`BUDGET`] 时淘汰最久没用的（至少留 [`KEEP`] 个）。被淘汰的再被问到当没有表层，并在控制台警告一次。
#[derive(Default)]
struct Registry {
    map: HashMap<u32, Handle>,
    total: usize,
    tick: u64,
    next: u32,
    warned: bool,
}

const BUDGET: usize = 16 << 20;
const KEEP: usize = 8;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = warn)]
    fn console_warn(s: &str);
}

impl Registry {
    fn insert(&mut self, doc: ScoreDoc, surface: Surface, size: usize) -> u32 {
        self.next += 1;
        self.tick += 1;
        let h = self.next;
        self.total += size;
        self.map.insert(h, Handle { doc, surface, size, gen: 0, last: self.tick });
        while self.total > BUDGET && self.map.len() > KEEP {
            let Some((&old, _)) = self.map.iter().filter(|(&k, _)| k != h).min_by_key(|(_, x)| x.last) else { break };
            self.remove(old);
        }
        h
    }

    fn remove(&mut self, h: u32) {
        if let Some(x) = self.map.remove(&h) {
            self.total -= x.size;
        }
    }

    /// 取句柄并记下用过（0 = 没有表层）
    fn get(&mut self, h: u32) -> Option<&mut Handle> {
        if h == 0 {
            return None;
        }
        self.tick += 1;
        let tick = self.tick;
        if !self.map.contains_key(&h) && h <= self.next && !self.warned {
            self.warned = true;
            console_warn(&format!("dolce-wasm：MusicXML 表层句柄 {h} 已被淘汰（同时留着的原文超过 {} MB），这份模型按没有表层处理", BUDGET >> 20));
        }
        let x = self.map.get_mut(&h)?;
        x.last = tick;
        Some(x)
    }
}

thread_local! {
    static REG: RefCell<Registry> = RefCell::new(Registry::default());
}

/// 取句柄（会记下用过）
fn with_handle<R>(h: u32, f: impl FnOnce(Option<&mut Handle>) -> R) -> R {
    REG.with(|r| f(r.borrow_mut().get(h)))
}

fn msg_err(m: &Msg) -> JsValue {
    super::js_sys_error(&serde_json::to_string(m).unwrap_or_default())
}

fn bad_input(what: &str, e: impl std::fmt::Display) -> JsValue {
    super::js_sys_error(&serde_json::to_string(&Msg::new("engine.badInput").arg("what", what).arg("error", e.to_string())).unwrap_or_default())
}

pub(crate) fn parse<T: for<'de> Deserialize<'de>>(what: &str, s: &str) -> Result<T, JsValue> {
    serde_json::from_str(s).map_err(|e| bad_input(what, e))
}

pub(crate) fn to_json<T: Serialize + ?Sized>(v: &T) -> String {
    serde_json::to_string(v).expect("序列化")
}

/// 句柄 0 = 没有表层（文本来源）
pub(crate) fn with_surface<R>(h: u32, f: impl FnOnce(Option<&Surface>) -> R) -> R {
    with_handle(h, |x| f(x.map(|x| &x.surface)))
}

/// 要改表层的（改完代号加一）
fn with_surface_mut<R>(h: u32, f: impl FnOnce(Option<&mut Surface>) -> R) -> R {
    with_handle(h, |x| {
        f(x.map(|x| {
            x.gen += 1;
            &mut x.surface
        }))
    })
}

/// 表层的代号（改一次加一；句柄没了回 0）。
#[wasm_bindgen(js_name = modelSurfaceGen)]
pub fn model_surface_gen(h: u32) -> u32 {
    with_handle(h, |x| x.map_or(0, |x| x.gen))
}

/// 表层整份快照（bincode，桌面版交给原生排版；句柄没了回空）。
#[wasm_bindgen(js_name = modelSurfaceSnapshot)]
pub fn model_surface_snapshot(h: u32) -> Vec<u8> {
    with_surface(h, |s| s.map(|s| bincode::serialize(s).expect("表层可序列化")).unwrap_or_default())
}

/// MusicXML 文本 → `[句柄, ScoreDoc 的 JSON]`（`doc.source` 不带，门面自己记）。读不出抛 `err.xmlParse`。
#[wasm_bindgen(js_name = modelLoadXml)]
pub fn model_load_xml(text: &str) -> Result<js_sys::Array, JsValue> {
    let loaded = fromxml::load_score_doc(text).map_err(|m| msg_err(&m))?;
    let mut doc = loaded.doc;
    doc.source = None;
    let json = to_json(&doc);
    let h = REG.with(|r| r.borrow_mut().insert(doc, loaded.surface, text.len()));
    Ok(js_sys::Array::of2(&JsValue::from(h), &JsValue::from_str(&json)))
}

/// 释放句柄（镜像回收后由门面调）。
#[wasm_bindgen(js_name = modelRelease)]
pub fn model_release(h: u32) {
    REG.with(|r| r.borrow_mut().remove(h));
}

/// 现存句柄数（门面自检用）。
#[wasm_bindgen(js_name = modelHandleCount)]
pub fn model_handle_count() -> u32 {
    REG.with(|r| r.borrow().map.len() as u32)
}

/// `.musicxml` 的源码同步索引（`SyncIndex.buildXml`）：按读入时的模型与表层建；原节点对不上这份原文为 `"null"`。
#[wasm_bindgen(js_name = modelXmlSync)]
pub fn model_xml_sync(h: u32, text: &str) -> String {
    with_handle(h, |x| to_json(&x.and_then(|x| xmlsync::build_xml_sync(&x.doc, &x.surface, text))))
}

/// 表层查询（`xmlsurface.ts` 的同名函数）：`what` 选哪一样，回 JSON（没有为 `null`）。
#[wasm_bindgen(js_name = modelSurface)]
pub fn model_surface(h: u32, what: &str, oid: u32) -> String {
    with_surface(h, |s| {
        let Some(s) = s else { return "null".into() };
        let o = Oid(oid);
        let some = |x: Option<Oid>| if oid == 0 { None } else { x };
        let v: Value = match what {
            "pos" => json!(s.xml_pos(o)),
            "spread" => json!(s.wedge_spread(o)),
            "width" => json!(s.measure_width(o)),
            "stem" => match s.note_stem(o) {
                Some((dir, y)) => match y {
                    Some(y) => json!({ "dir": dir, "y": y }),
                    None => json!({ "dir": dir }),
                },
                None => Value::Null,
            },
            "align" => {
                let (j, h, v) = s.xml_align(o);
                let mut m = serde_json::Map::new();
                if let Some(j) = j {
                    m.insert("justify".into(), json!(j));
                }
                if let Some(h) = h {
                    m.insert("halign".into(), json!(h));
                }
                if let Some(v) = v {
                    m.insert("valign".into(), json!(v));
                }
                Value::Object(m)
            }
            "font" => json!(s.xml_font(o)),
            "staffDetails" => Value::Array(
                s.staff_details_of(some(Some(o)))
                    .into_iter()
                    .map(|(n, po)| {
                        let mut m = serde_json::Map::new();
                        if let Some(n) = n {
                            m.insert("staff".into(), json!(n));
                        }
                        if let Some(po) = po {
                            m.insert("printObject".into(), json!(po));
                        }
                        Value::Object(m)
                    })
                    .collect(),
            ),
            "partSymbol" => match s.part_symbol_of(some(Some(o))) {
                Some((symbol, top, bottom)) => {
                    let mut m = serde_json::Map::new();
                    m.insert("symbol".into(), json!(symbol));
                    if let Some(t) = top {
                        m.insert("top".into(), json!(t));
                    }
                    if let Some(b) = bottom {
                        m.insert("bottom".into(), json!(b));
                    }
                    Value::Object(m)
                }
                None => Value::Null,
            },
            "print" => json!(s.print_layout(some(Some(o)))),
            "defaultsFonts" => {
                let (mf, wf) = s.defaults_fonts(o);
                let mut m = serde_json::Map::new();
                if let Some(f) = mf {
                    m.insert("musicFont".into(), json!(f));
                }
                if let Some(f) = wf {
                    m.insert("wordFont".into(), json!(f));
                }
                Value::Object(m)
            }
            "id" => json!(s.of0(o).and_then(|n| s.tree().get_attribute(n, "id"))),
            "idStart" => json!(s.of(o, xmlsurface::Slot::Start).and_then(|n| s.tree().get_attribute(n, "id"))),
            "idStop" => json!(s.of(o, xmlsurface::Slot::Stop).and_then(|n| s.tree().get_attribute(n, "id"))),
            _ => Value::Null,
        };
        to_json(&v)
    })
}

/// 把识别 id 写进表层原节点的 `id` 属性（`oids[k]` 的节点写 `ids[k]`），回整份 XML；一个也没写上回 `null`（`omrlinks.ts::stampXmlIds`）。
#[wasm_bindgen(js_name = modelStampIds)]
pub fn model_stamp_ids(h: u32, oids: Vec<u32>, ids: Vec<String>) -> Option<String> {
    with_surface_mut(h, |s| {
        let s = s?;
        let mut any = false;
        for (o, id) in oids.iter().zip(&ids) {
            if *o == 0 || id.is_empty() {
                continue;
            }
            if let Some(n) = s.of0(Oid(*o)) {
                s.tree_mut().set_attribute(n, "id", id.as_str());
                any = true;
            }
        }
        any.then(|| s.xml.serialize())
    })
}

/// `hasEmbeddedLayout` 的两半：这些小节里有没有正的 `width`、这些对象里有没有 `default-x`。
#[wasm_bindgen(js_name = modelHasEmbeddedLayout)]
pub fn model_has_embedded_layout(h: u32, measures: Vec<u32>, positioned: Vec<u32>) -> bool {
    with_surface(h, |s| {
        let Some(s) = s else { return false };
        measures.iter().any(|&m| m != 0 && s.measure_width(Oid(m)).is_some_and(|w| w > 0.0))
            || positioned.iter().any(|&o| o != 0 && s.xml_pos(Oid(o)).and_then(|p| p.default_x).is_some())
    })
}

/// 字体全名拆回族名与字重 / 字形（`splitFaceName`）
#[wasm_bindgen(js_name = modelSplitFaceName)]
pub fn model_split_face_name(font: &str) -> Result<String, JsValue> {
    let f: FontSpec = parse("FontSpec", font)?;
    Ok(to_json(&xmlsurface::split_face_name(f)))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ToXmlWire {
    song: usize,
    source_ids: bool,
    line_starts: Option<Vec<ElementId>>,
    mid_line_starts: bool,
    slur_ties: Option<bool>,
}

/// `ScoreDoc`（JSON，带 `_oid`）→ MusicXML 文本（`scoreDocToMusicXml`）。`h` 是表层句柄（0 = 不回填）。
#[wasm_bindgen(js_name = modelToXml)]
pub fn model_to_xml(doc: &str, h: u32, opts: &str) -> Result<String, JsValue> {
    let doc: ScoreDoc = parse("ScoreDoc", doc)?;
    let w: ToXmlWire = parse("ToXmlOptions", opts)?;
    let o = toxml::ToXmlOptions {
        project: xmlproject::ProjectOptions { line_starts: w.line_starts, mid_line_starts: w.mid_line_starts, slur_ties: w.slur_ties },
        song: w.song,
        source_ids: w.source_ids,
        layout: None,
        rids: None,
    };
    with_surface(h, |s| toxml::score_doc_to_music_xml(&doc, s, &o).map_err(|e| msg_err(&e)))
}

/// 编辑钩子：表层作废落到句柄的表层上（`hooks` 为假时不作废，同 TS 没传钩子）；提示文字回调 TS 的 `msgText`。
struct JsHooks<'a> {
    surface: Option<&'a mut Surface>,
    tr: Option<&'a js_sys::Function>,
}

impl EditHooks for JsHooks<'_> {
    fn forget_stem(&mut self, ch: &Chord) {
        if let Some(s) = self.surface.as_deref_mut() {
            s.forget_note_layout(ch);
        }
    }
    fn forget_layout(&mut self, song: &Song) {
        if let Some(s) = self.surface.as_deref_mut() {
            s.drop_embedded_layout(song);
        }
    }
    fn text(&self, m: &Msg) -> String {
        let Some(f) = self.tr else { return m.key.clone() };
        f.call1(&JsValue::NULL, &JsValue::from_str(&to_json(m))).ok().and_then(|v| v.as_string()).unwrap_or_else(|| m.key.clone())
    }
}

/// 执行一个编辑动作（`EditCmd` 的 JSON），回 `{"edit": ModelEdit, "doc": 改后的 ScoreDoc}`。
/// `h`：改动作废的表层落在哪个句柄（0 = 无）；`hooks` 假时不作废（TS 调用方没传钩子）；`tr`：提示文字（缺省声部名等）。
#[wasm_bindgen(js_name = modelEdit)]
pub fn model_edit(doc: &str, h: u32, cmd: &str, hooks: bool, tr: Option<js_sys::Function>) -> Result<String, JsValue> {
    let mut doc: ScoreDoc = parse("ScoreDoc", doc)?;
    let cmd: EditCmd = parse("EditCmd", cmd)?;
    let r = with_surface_mut(if hooks { h } else { 0 }, |surface| {
        let mut hk = JsHooks { surface, tr: tr.as_ref() };
        edit::apply(&mut doc, &cmd, &mut hk)
    });
    Ok(format!(r#"{{"edit":{},"doc":{}}}"#, to_json(&r), to_json(&doc)))
}

/// 只改一个小节的临时记号拼写（`respellMeasure`），回改后的小节。
#[wasm_bindgen(js_name = modelRespellMeasure)]
pub fn model_respell_measure(measure: &str, key: &str) -> Result<String, JsValue> {
    let mut m: Measure = parse("Measure", measure)?;
    let key: Key = parse("Key", key)?;
    edit::respell_measure(&mut m, &key);
    Ok(to_json(&m))
}

/// 简繁：整份转换（`convertScoreDoc`），`conv` 是 TS 的转换函数（字符串 → 字符串）。回 `{"doc": 改后的 ScoreDoc, "changed": 改了几处}`。
#[wasm_bindgen(js_name = modelHanconvDoc)]
pub fn model_hanconv_doc(doc: &str, conv: &js_sys::Function) -> Result<String, JsValue> {
    let mut doc: ScoreDoc = parse("ScoreDoc", doc)?;
    let n = hanconv::convert_score_doc(&mut doc, &JsConv(conv));
    Ok(format!(r#"{{"doc":{},"changed":{}}}"#, to_json(&doc), to_json(&n)))
}

/// 简繁：判断方向（`detectHanDirection`），回 `"s2t"` / `"t2s"`。
#[wasm_bindgen(js_name = modelHanDirection)]
pub fn model_han_direction(doc: &str, t2s: &js_sys::Function) -> Result<String, JsValue> {
    let doc: ScoreDoc = parse("ScoreDoc", doc)?;
    Ok(to_json(&hanconv::detect_han_direction(&doc, &JsConv(t2s))))
}

/// 简繁：原文写回（`convertSourceText`）：`parse` 是 TS 的读入（原文 → ScoreDoc 的 JSON，读不出抛错），回 `SourceConvResult`。
#[wasm_bindgen(js_name = modelHanconvSource)]
pub fn model_hanconv_source(text: &str, parse_fn: &js_sys::Function, conv: &js_sys::Function) -> Result<String, JsValue> {
    let thrown: RefCell<Option<JsValue>> = RefCell::new(None);
    let read = |t: &str| -> Result<ScoreDoc, Msg> {
        match parse_fn.call1(&JsValue::NULL, &JsValue::from_str(t)) {
            Ok(v) => {
                let json = v.as_string().unwrap_or_default();
                serde_json::from_str(&json).map_err(|e| Msg::new("engine.badInput").arg("what", "ScoreDoc").arg("error", e.to_string()))
            }
            Err(e) => {
                *thrown.borrow_mut() = Some(e);
                Err(Msg::new("engine.thrown"))
            }
        }
    };
    // 头一次读入就抛了（TS 那边直接往外抛）；后面重读抛的由比对那一步当「结构变了」处理，不往外抛
    match hanconv::convert_source_text(text, &read, &JsConv(conv)) {
        Ok(x) => Ok(to_json(&x)),
        Err(m) => Err(thrown.into_inner().unwrap_or_else(|| msg_err(&m))),
    }
}

struct JsConv<'a>(&'a js_sys::Function);

impl hanconv::HanConv for JsConv<'_> {
    fn conv(&self, s: &str) -> String {
        self.0.call1(&JsValue::NULL, &JsValue::from_str(s)).ok().and_then(|v| v.as_string()).unwrap_or_else(|| s.to_owned())
    }
}

/// MusicXML 是否多声部（≥2 part、单 part 多谱表、或 ≥2 voice）→ 打开时默认混排（`paintreq.ts::isMultiPartXml`）。读不出为假。
#[wasm_bindgen(js_name = xmlIsMultiPart)]
pub fn xml_is_multi_part(xml: &str) -> bool {
    use dolce_base::js;
    let Ok(d) = dolce_model::xml::parse(xml) else { return false };
    if d.get_elements_by_tag_name("score-part").len() >= 2 {
        return true;
    }
    if d.get_elements_by_tag_name("staves").into_iter().any(|s| js::parse_int(&d.tree.text_content(s), 10) >= 2.0) {
        return true;
    }
    let mut voices: Vec<String> = vec![];
    for v in d.get_elements_by_tag_name("voice") {
        let t = d.tree.text_content(v);
        let t = js::trim(&t);
        if !t.is_empty() && !voices.iter().any(|x| x == t) {
            voices.push(t.to_owned());
        }
    }
    voices.len() >= 2
}

/// 歌词视图（`withLyricsFrom`）：各首第 `to` 声部的歌词换成按时刻从第 `from` 声部抄来的。回新文档（同一声部时回 `null`，门面回原对象）。
#[wasm_bindgen(js_name = modelWithLyricsFrom)]
pub fn model_with_lyrics_from(doc: &str, from: usize, to: usize) -> Result<String, JsValue> {
    let doc: ScoreDoc = parse("ScoreDoc", doc)?;
    Ok(match parts::with_lyrics_from(&doc, from, to) {
        std::borrow::Cow::Borrowed(_) => "null".into(),
        std::borrow::Cow::Owned(d) => to_json(&d),
    })
}

// ───────────────────────── 断行（`model/breaks.ts` 的门面） ─────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LineStartWire {
    id: ElementId,
    #[serde(default)]
    page: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyBreaksWire {
    #[serde(default)]
    mid_in_any_part: bool,
    mid: String,
    pages: String,
}

/// 断行改动的补丁：TS 就地改原对象（保住对象身份）。`measures`：`[声部, 小节, print 里断行三项或 null = 删掉 print]`；
/// `hosts`：`[和弦或增时线 id, 换行种类或 null]`；`barlines`：`[声部, 小节, 第几根, 换行种类或 null]`
fn breaks_patch(before: &Song, after: &Song) -> Value {
    fn brk(k: &Option<BreakKind>) -> Option<String> {
        k.as_ref().map(|k| k.as_str().to_owned())
    }
    let mut measures = vec![];
    let mut hosts = vec![];
    let mut barlines = vec![];
    for (pi, (pa, pb)) in before.parts.iter().zip(&after.parts).enumerate() {
        for (mi, (ma, mb)) in pa.measures.iter().zip(&pb.measures).enumerate() {
            let three = |p: &Option<Print>| p.as_ref().map(|p| (p.new_system, p.new_page, p.system));
            if ma.print.is_some() != mb.print.is_some() || three(&ma.print) != three(&mb.print) {
                measures.push(match &mb.print {
                    None => json!([pi, mi, null]),
                    Some(p) => json!([pi, mi, { "newSystem": p.new_system, "newPage": p.new_page, "system": p.system }]),
                });
            }
            for (ea, eb) in ma.elements.iter().zip(&mb.elements) {
                let (Element::Chord(ca), Element::Chord(cb)) = (ea, eb) else { continue };
                if ca.line_break_after != cb.line_break_after {
                    hosts.push(json!([cb.id, brk(&cb.line_break_after)]));
                }
                for (sa, sb) in ca.sustains.iter().flatten().zip(cb.sustains.iter().flatten()) {
                    if sa.line_break_after != sb.line_break_after {
                        hosts.push(json!([sb.id, brk(&sb.line_break_after)]));
                    }
                }
            }
            for (bi, (ba, bb)) in ma.barlines.iter().flatten().zip(mb.barlines.iter().flatten()).enumerate() {
                if ba.line_break_after != bb.line_break_after {
                    barlines.push(json!([pi, mi, bi, brk(&bb.line_break_after)]));
                }
            }
        }
    }
    json!({ "measures": measures, "hosts": hosts, "barlines": barlines })
}

/// `applyBreaks`：一组行首写进这首歌，回补丁（一个都对不上、没落下换行时回 `"null"`）
#[wasm_bindgen(js_name = modelApplyBreaks)]
pub fn model_apply_breaks(song: &str, starts: &str, opts: &str) -> Result<String, JsValue> {
    let before: Song = parse("Song", song)?;
    let starts: Vec<LineStartWire> = parse("LineStart[]", starts)?;
    let o: ApplyBreaksWire = parse("ApplyBreaksOptions", opts)?;
    let opt = breaks::ApplyBreaksOptions {
        mid_in_any_part: o.mid_in_any_part,
        mid: match o.mid.as_str() {
            "snap" => breaks::MidMode::Snap,
            "source" => breaks::MidMode::Source,
            _ => breaks::MidMode::Inline,
        },
        pages: if o.pages == "keep" { breaks::PageMode::Keep } else { breaks::PageMode::Write },
    };
    let starts: Vec<breaks::LineStart> = starts.into_iter().map(|s| breaks::LineStart { id: s.id, page: s.page }).collect();
    let mut after = before.clone();
    if !breaks::apply_breaks(&mut after, &starts, &opt) {
        return Ok("null".into());
    }
    Ok(to_json(&breaks_patch(&before, &after)))
}

/// `clearSongBreaks`：清掉整首的换行与换页，回补丁
#[wasm_bindgen(js_name = modelClearSongBreaks)]
pub fn model_clear_song_breaks(song: &str) -> Result<String, JsValue> {
    let before: Song = parse("Song", song)?;
    let mut after = before.clone();
    breaks::clear_song_breaks(&mut after);
    Ok(to_json(&breaks_patch(&before, &after)))
}

// ───────────────────────── 投影、纸与页眉、段落（M5-5） ─────────────────────────

/// 去掉 `_oid`：投影、改写出来的新对象没有表层身份（Rust 现发的号回 TS 会跟表层的号撞上）
pub(crate) fn strip_oids(v: &mut Value) {
    match v {
        Value::Array(a) => a.iter_mut().for_each(strip_oids),
        Value::Object(o) => {
            o.remove("_oid");
            o.values_mut().for_each(strip_oids);
        }
        _ => {}
    }
}

/// 一首曲子的 JSON（不带身份）
pub(crate) fn song_json(s: &Song) -> Value {
    let mut v = serde_json::to_value(s).expect("序列化");
    strip_oids(&mut v);
    v
}

/// 页眉字体表 → `{title?: {family?, size?, bold?}, …}`（同 TS `Partial<Record<HeaderRole, HeaderFontSpec>>`）
pub(crate) fn header_fonts_json(fonts: impl IntoIterator<Item = (pagemeta::HeaderRole, pagemeta::HeaderFontSpec)>) -> Value {
    let map: serde_json::Map<String, Value> = fonts
        .into_iter()
        .map(|(r, f)| {
            let mut o = serde_json::Map::new();
            if let Some(x) = f.family {
                o.insert("family".into(), json!(x));
            }
            if let Some(x) = f.size {
                o.insert("size".into(), json!(x));
            }
            if f.bold {
                o.insert("bold".into(), json!(true));
            }
            (r.as_str().to_owned(), Value::Object(o))
        })
        .collect();
    Value::Object(map)
}

/// 纸 → `{w, h, margins?}`（同 TS `PagePt`）
pub(crate) fn page_json(p: Option<pagemeta::PagePt>) -> Value {
    p.map_or(Value::Null, |p| {
        let mut o = json!({ "w": p.w, "h": p.h });
        if let Some(m) = p.margins {
            o["margins"] = json!(m);
        }
        o
    })
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ProjectWire {
    line_starts: Option<Vec<ElementId>>,
    mid_line_starts: bool,
    slur_ties: Option<bool>,
}

/// `projectForMusicXml`：简谱来源的曲子投成 MusicXML 形状（不带身份；MusicXML 形状的门面不送来）。`opts`：`{lineStarts?, midLineStarts?, slurTies?}`
#[wasm_bindgen(js_name = modelProjectForMusicXml)]
pub fn model_project_for_music_xml(song: &str, opts: &str) -> Result<String, JsValue> {
    let song: Song = parse("Song", song)?;
    let w: ProjectWire = parse("ProjectOptions", opts)?;
    let o = xmlproject::ProjectOptions { line_starts: w.line_starts, mid_line_starts: w.mid_line_starts, slur_ties: w.slur_ties };
    let out = xmlproject::project_for_music_xml(&song, &o).map_err(|e| msg_err(&e))?;
    Ok(song_json(&out).to_string())
}

/// 改写结果：没改回 undefined（门面原样用入参），改了回新曲子（不带身份）
fn changed_song(c: std::borrow::Cow<'_, Song>) -> Option<String> {
    match c {
        std::borrow::Cow::Borrowed(_) => None,
        std::borrow::Cow::Owned(s) => Some(song_json(&s).to_string()),
    }
}

/// `slursAsTies`：简谱口径括住相邻两个同音的弧改记延音线；没有要改的回 undefined
#[wasm_bindgen(js_name = modelSlursAsTies)]
pub fn model_slurs_as_ties(song: &str) -> Result<Option<String>, JsValue> {
    let song: Song = parse("Song", song)?;
    Ok(changed_song(xmlproject::slurs_as_ties(&song)))
}

/// `voltasOfPlayOrder`：`[[小节号, {start?, stop, repeatBack}]]`
#[wasm_bindgen(js_name = modelVoltasOfPlayOrder)]
pub fn model_voltas_of_play_order(song: &str) -> Result<String, JsValue> {
    let song: Song = parse("Song", song)?;
    let out: Vec<Value> = xmlproject::voltas_of_play_order(&song)
        .into_iter()
        .map(|(m, v)| {
            let mut o = json!({ "stop": v.stop, "repeatBack": v.repeat_back });
            if let Some(s) = v.start {
                o["start"] = json!(s);
            }
            json!([m, o])
        })
        .collect();
    Ok(to_json(&out))
}

/// `projectForJianpu`：MusicXML 形状（与只记 `divisions` 的原生 ABC）投成简谱形状；不必投的回 undefined
#[wasm_bindgen(js_name = modelProjectForJianpu)]
pub fn model_project_for_jianpu(song: &str) -> Result<Option<String>, JsValue> {
    let song: Song = parse("Song", song)?;
    Ok(changed_song(jianpuproject::project_for_jianpu(&song)))
}

/// 谱里自带的纸、谱表高、歌词字号、页眉字体一趟出：`{page, staffSize, lyricSize, headerFonts}`。
/// `song` 只需 `meta` / `defaults` / `credits` 与身份（页眉字体缺族时按身份到表层 `h` 取 `<word-font>`）
#[wasm_bindgen(js_name = modelPageInfo)]
pub fn model_page_info(song: &str, h: u32) -> Result<String, JsValue> {
    let song: Song = parse("Song", song)?;
    let fonts = with_surface(h, |s| pagemeta::song_header_fonts(&song, s));
    Ok(to_json(&json!({
        "page": page_json(pagemeta::song_page(&song)),
        "staffSize": pagemeta::song_staff_size(&song),
        "lyricSize": pagemeta::song_lyric_size(&song),
        "headerFonts": header_fonts_json(fonts),
    })))
}

/// `standardPaperOf`：`{name, landscape}` 或 null
#[wasm_bindgen(js_name = modelStandardPaperOf)]
pub fn model_standard_paper_of(w: f64, h: f64) -> String {
    to_json(&pagemeta::standard_paper_of(w, h).map(|(name, landscape)| json!({ "name": name, "landscape": landscape })))
}

/// `headerRoleOfCredit`：`<credit>` 归到页眉角色（`""` 当没写）；归不上为 undefined
#[wasm_bindgen(js_name = modelHeaderRoleOfCredit)]
pub fn model_header_role_of_credit(kind: Option<String>, justify: Option<String>, biggest: bool) -> Option<String> {
    pagemeta::header_role_of_credit(kind.as_deref(), justify.as_deref(), biggest).map(|r| r.as_str().to_owned())
}

/// `withPageMeta`：MusicXML 的纸、谱表大小、歌词字号、页眉字体写进 meta。没有要写的回 undefined（门面原样用入参）；
/// 有就回整份新文档（带身份，门面按同一份表层认回）
#[wasm_bindgen(js_name = modelWithPageMeta)]
pub fn model_with_page_meta(doc: &str, h: u32) -> Result<Option<String>, JsValue> {
    let doc: ScoreDoc = parse("ScoreDoc", doc)?;
    Ok(with_surface(h, |s| match pagemeta::with_page_meta(&doc, s) {
        std::borrow::Cow::Borrowed(_) => None,
        std::borrow::Cow::Owned(d) => Some(to_json(&d)),
    }))
}

/// `carryPlayOrder`：写明的演唱顺序搬到读回的那份上，回各首要设的字段（与 `to.songs` 平行）
#[wasm_bindgen(js_name = modelCarryPlayOrder)]
pub fn model_carry_play_order(from: &str, to: &str) -> Result<String, JsValue> {
    let from: ScoreDoc = parse("ScoreDoc", from)?;
    let to: ScoreDoc = parse("ScoreDoc", to)?;
    Ok(to_json(&sections::carry_play_order(&from, &to)))
}

/// `checkMeasureDurations`：小节时值自检（`dolce_model::beatcheck`）。`opts`：`{meters?, pickup?: [首][声部]}`
#[wasm_bindgen(js_name = modelBeatCheck)]
pub fn model_beat_check(doc: &str, opts: &str) -> Result<String, JsValue> {
    let d: ScoreDoc = parse("ScoreDoc", doc)?;
    let o: beatcheck::BeatCheckOptions = parse("BeatCheckOptions", opts)?;
    Ok(to_json(&beatcheck::check_measure_durations(&d, &o)))
}

/// `breaksOf`：读出现有断行（`[{id, page?}]`）
#[wasm_bindgen(js_name = modelBreaksOf)]
pub fn model_breaks_of(song: &str) -> Result<String, JsValue> {
    let song: Song = parse("Song", song)?;
    let out: Vec<Value> = breaks::breaks_of(&song).into_iter().map(|s| if s.page { json!({ "id": s.id, "page": true }) } else { json!({ "id": s.id }) }).collect();
    Ok(to_json(&out))
}

/// `docView`：排版行视图（`dolce_view::slots::doc_view`）。`source`：原文（文本谱来源取各行 `raw`；空串当没有）。
/// 回 id 化的视图（`refs` 存下标、投影改过曲子的另带 `song`），对象由门面 `jianpu/slots.ts` 认回；
/// 另带 `sync`：双向定位索引的条目（`dolce_view::sync::build_sync`，按推入次序），同一趟出、不必再建一遍视图。
#[wasm_bindgen(js_name = modelDocView)]
pub fn model_doc_view(doc: &str, source: &str) -> Result<String, JsValue> {
    #[derive(Serialize)]
    struct Wire<'a> {
        #[serde(flatten)]
        view: &'a dolce_view::slots::DocView,
        sync: dolce_model::xmlsync::XmlSync,
    }
    let d: ScoreDoc = parse("ScoreDoc", doc)?;
    let src = (!source.is_empty()).then_some(source);
    let view = dolce_view::slots::doc_view(&d, src);
    let sync = dolce_view::sync::build_sync(&d, &view);
    Ok(to_json(&Wire { view: &view, sync }))
}
