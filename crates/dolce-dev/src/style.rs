//! 样式层对拍（迁 Rust L1）：`dolce-dev style-check <cases.jsonl> [--redist=<目录>] [--show=N]`。
//!
//! 每行一个用例（dev `style-rs-diff.mjs` 由 TS 现算导出）：`{ key, kind, …输入, expect | error }`，Rust 重算后逐字段比
//! （对象不看键序；数逐位相等；TS 的 `undefined` 不进 JSON、Rust 的 `None` 同样不写）。`kind`：
//!
//! - `parse`（`src`）→ 规则数组或报错原文；`print`（`rules`）→ `.ss` 文本
//! - `compute`（`layers`、`ctx`、`paper`）→ computed 样式表（`paper` 为真走两趟的 `computeStyleForPaper`）
//! - `jianpu`（`sheet`）→ `JianpuStyle`；`staff`（`sheet`，可缺）→ `MixedOptions`；`header`（`sheet`）→ 页眉四项
//! - `book`（`sheet`、`id`）→ BookStyle；`printBook`（`style`）→ 歌本实测部分的 `.ss` 文本
//! - `songLayers`（`song`，或 MusicXML 原文件 `xml` + 曲号 `index`）→ `{ header, headerNoSize, page }` 三份曲内层
//! - `theme`（`id`）→ 内置主题那一层规则
//! - `region`（`region`、`env`）→ 模板区域排版结果；环境是两边约定的一套假环境（[`SynthEnv`]：字段按路径长短给 0/1/2 项、
//!   量宽 = UTF-16 长 × 字号 × 0.55、组件回显调用参数），只验排法本身
//!
//! `book` 预设的 `jianpu` 要量字（附点），用同 `nodeMeasure()` 口径的原生后端。

use crate::layout::{flag, lines, positional, show_n};
use dolce_style::cascade::{compute_style, layer_from_json, StyleContext, StyleRule};
use dolce_style::sheet::StyleSheet;
use dolce_style::themes::{compute_style_for_paper, theme, ThemeId};
use dolce_text::MeasureCtx;
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// 两份 JSON 的差：路径与两边的值。对象不看键序。
fn diff(path: &str, a: &Value, b: &Value, out: &mut Vec<String>) {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for k in x.keys().chain(y.keys().filter(|k| !x.contains_key(*k))) {
                let n = Value::Null;
                let (va, vb) = (x.get(k), y.get(k));
                if va.is_none() || vb.is_none() {
                    out.push(format!("{path}.{k}：{} → {}", va.map_or("(无)".into(), Value::to_string), vb.map_or("(无)".into(), Value::to_string)));
                    continue;
                }
                diff(&format!("{path}.{k}"), va.unwrap_or(&n), vb.unwrap_or(&n), out);
            }
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            for (i, (p, q)) in x.iter().zip(y).enumerate() {
                diff(&format!("{path}[{i}]"), p, q, out);
            }
        }
        (Value::Number(x), Value::Number(y)) => {
            if x.as_f64() != y.as_f64() {
                out.push(format!("{path}：{x} → {y}"));
            }
        }
        _ => {
            if a != b {
                let s = |v: &Value| {
                    let t = v.to_string();
                    if t.chars().count() > 300 { format!("{}…", t.chars().take(300).collect::<String>()) } else { t }
                };
                out.push(format!("{path}：{} → {}", s(a), s(b)));
            }
        }
    }
}

fn sheet_of(v: &Value) -> StyleSheet {
    let mut v = v.clone();
    dolce_style::value::normalize(&mut v);
    StyleSheet(v)
}

fn layer(v: &Value) -> Vec<StyleRule> {
    layer_from_json(v).unwrap_or_else(|e| panic!("规则层读不进：{e}"))
}

fn rules_json(r: &[StyleRule]) -> Value {
    serde_json::to_value(r).expect("规则可序列化")
}

/// `region` 用例的假环境（与 `style-rs-diff.mjs` 的 `synthEnv` 逐条同口径）。
struct SynthEnv {
    page_no: f64,
    left: f64,
    right: f64,
    page_width: Option<f64>,
    dy: Option<f64>,
    sizes: serde_json::Map<String, Value>,
    metrics: bool,
}

impl SynthEnv {
    fn of(v: &Value) -> SynthEnv {
        let n = |k: &str| v.get(k).and_then(Value::as_f64);
        SynthEnv {
            page_no: n("pageNo").unwrap_or(1.0),
            left: n("left").unwrap_or(0.0),
            right: n("right").unwrap_or(0.0),
            page_width: n("pageWidth"),
            dy: n("dy"),
            sizes: v.get("sizes").and_then(Value::as_object).cloned().unwrap_or_default(),
            metrics: v.get("metrics").and_then(Value::as_bool) == Some(true),
        }
    }
}

impl dolce_style::template::RegionEnv for SynthEnv {
    fn field(&self, path: &str) -> Option<Vec<dolce_style::template::FieldValue>> {
        use dolce_style::template::FieldValue;
        let len = path.encode_utf16().count();
        match len % 3 {
            0 => None,
            1 => Some(vec![FieldValue::text(format!("{path}·0{len}"))]),
            _ => Some(vec![
                FieldValue { text: format!("{path} 甲"), kind: Some("lyricist".into()) },
                FieldValue { text: format!("({len}) 乙;丙"), kind: Some("composer".into()) },
            ]),
        }
    }
    fn page_no(&self) -> f64 {
        self.page_no
    }
    fn content(&self) -> (f64, f64) {
        (self.left, self.right)
    }
    fn page_width(&self) -> Option<f64> {
        self.page_width
    }
    fn dy(&self) -> Option<f64> {
        self.dy
    }
    fn size_of(&self, role: &str) -> f64 {
        self.sizes.get(role).and_then(Value::as_f64).unwrap_or(10.0)
    }
    fn measure(&self, _role: &str, text: &str, size: f64) -> f64 {
        text.encode_utf16().count() as f64 * size * 0.55
    }
    fn component(&self, name: &str, c: &dolce_style::template::ComponentCall) -> Option<Result<Vec<Value>, dolce_style::ss::SsError>> {
        Some(Ok(vec![json!({ "c": name, "x": c.x, "y": c.y, "role": c.role, "size": c.size, "n": c.row.len(), "args": c.args.len() })]))
    }
    fn font_metrics(&self, _role: &str, size: f64) -> Option<dolce_style::template::FontMetricsLike> {
        self.metrics.then_some(dolce_style::template::FontMetricsLike { ascent: size * 0.8, height: size * 1.2 })
    }
}

/// 算一个用例：`Ok(值)` 或 `Err(报错文字)`。
fn run(case: &Value, mc: &MeasureCtx) -> Result<Value, String> {
    let kind = case["kind"].as_str().unwrap_or("");
    let g = |k: &str| case.get(k).unwrap_or(&Value::Null);
    Ok(match kind {
        "parse" => rules_json(&dolce_style::ss::parse_ss(g("src").as_str().unwrap_or("")).map_err(|e| e.message)?),
        "print" => Value::String(dolce_style::ss::print_ss(&layer(g("rules"))).map_err(|e| e.message)?),
        "theme" => {
            let id = ThemeId::parse(g("id").as_str().unwrap_or("")).ok_or("认不出的主题")?;
            rules_json(theme(id))
        }
        "compute" => {
            let layers: Vec<Vec<StyleRule>> = g("layers").as_array().ok_or("layers 要数组")?.iter().map(layer).collect();
            let refs: Vec<&[StyleRule]> = layers.iter().map(Vec::as_slice).collect();
            let mut c = g("ctx").clone();
            dolce_style::value::normalize(&mut c);
            let c: StyleContext = c.as_object().cloned().unwrap_or_default();
            let s = if g("paper").as_bool() == Some(true) { compute_style_for_paper(&refs, &c) } else { compute_style(&refs, &c) };
            s.0
        }
        "jianpu" => serde_json::to_value(dolce_style::jianpu::jianpu_style_of(&sheet_of(g("sheet")), mc)?).expect("可序列化"),
        "staff" => {
            let s = (!g("sheet").is_null()).then(|| sheet_of(g("sheet")));
            serde_json::to_value(dolce_style::staff::staff_options_of(s.as_ref())).expect("可序列化")
        }
        "header" => serde_json::to_value(dolce_style::header::header_fonts_of(&sheet_of(g("sheet")))).expect("可序列化"),
        "book" => dolce_style::bookss::book_style_of(&sheet_of(g("sheet")), g("id").as_str().unwrap_or(""))?,
        "printBook" => {
            let mut s = g("style").clone();
            dolce_style::value::normalize(&mut s);
            Value::String(dolce_style::bookss::print_book_ss(&s)?)
        }
        "songLayers" => {
            // MusicXML 来的谱带表层（`<word-font>` 之类的回退在那儿）：自己读原文件；别的格式用 TS 给的曲子
            let (song, loaded) = match g("xml").as_str() {
                Some(path) => {
                    let text = std::fs::read_to_string(path).map_err(|e| format!("读 {path}：{e}"))?;
                    let l = dolce_model::fromxml::load_score_doc(&text).map_err(|m| format!("{m:?}"))?;
                    let i = g("index").as_u64().unwrap_or(0) as usize;
                    (l.doc.songs.get(i).cloned().ok_or("曲号越界")?, Some(l.surface))
                }
                None => (serde_json::from_value(g("song").clone()).map_err(|e| format!("Song 读不进：{e}"))?, None),
            };
            let sf = loaded.as_ref();
            json!({
                "header": rules_json(&dolce_style::header::header_layer_of_song(Some(&song), sf, true, true)),
                "headerNoSize": rules_json(&dolce_style::header::header_layer_of_song(Some(&song), sf, false, false)),
                "page": rules_json(&dolce_style::paper::doc_page_layer(Some(&song))),
            })
        }
        "region" => {
            let region: Option<dolce_style::ss::Region> = serde_json::from_value(g("region").clone()).map_err(|e| format!("区域读不进：{e}"))?;
            let r = dolce_style::template::layout_region(region.as_ref(), &SynthEnv::of(g("env"))).map_err(|e| e.message)?;
            serde_json::to_value(r).expect("可序列化")
        }
        _ => return Err(format!("认不出的用例种类 {kind}")),
    })
}

pub fn style_check(args: &[String]) -> i32 {
    let pos = positional(args);
    let Some(path) = pos.first() else {
        eprintln!("用法：dolce-dev style-check <cases.jsonl> [--redist=<目录>] [--show=N]");
        return 2;
    };
    let redist = std::path::PathBuf::from(flag(args, "redist").unwrap_or("public/redist"));
    let backend = dolce_text::native::node_measure(Some(&redist), &[]);
    let mc = MeasureCtx::new(&backend);
    let show = show_n(args);
    let mut by_kind: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut shown = 0;
    for l in lines(path) {
        let case: Value = serde_json::from_str(&l).unwrap_or_else(|e| panic!("{path} 读不进：{e}"));
        let kind = case["kind"].as_str().unwrap_or("?").to_string();
        let key = case["key"].as_str().unwrap_or("?").to_string();
        let got = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&case, &mc))).unwrap_or_else(|p| {
            Err(format!("panic：{}", p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()))
        });
        let mut d = vec![];
        match (&got, case.get("error").and_then(Value::as_str), case.get("expect")) {
            (Ok(v), None, Some(want)) => diff("", want, v, &mut d),
            (Err(e), Some(want), _) => {
                if e != want {
                    d.push(format!("报错不同：{want} → {e}"));
                }
            }
            (Ok(v), Some(want), _) => d.push(format!("TS 报错「{want}」，Rust 得 {}", v.to_string().chars().take(200).collect::<String>())),
            (Err(e), None, _) => d.push(format!("Rust 报错：{e}")),
            (Ok(_), None, None) => d.push("用例缺 expect".into()),
        }
        let e = by_kind.entry(kind.clone()).or_default();
        e.0 += 1;
        if !d.is_empty() {
            e.1 += 1;
            if shown < show {
                shown += 1;
                println!("✗ [{kind}] {key}（{} 处）", d.len());
                for x in d.iter().take(12) {
                    println!("    {x}");
                }
            }
        }
    }
    let mut bad = 0;
    for (k, (n, b)) in &by_kind {
        println!("{k:<12} {n:>6} 例  差异 {b}");
        bad += b;
    }
    if bad > 0 {
        1
    } else {
        println!("全部一致");
        0
    }
}
