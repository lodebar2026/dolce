//! 成书部件对拍（迁 Rust L6）：`dolce-dev book-parts-check <cases.jsonl> --measure=<book-measure.jsonl> [--layout=<pdf-layout.json>] [--kind=…] [--show=N]`。
//!
//! 用例由 dev `book-parts-rs-diff.mjs` 让 TS 现算导出（`{ kind, key, …输入, expect | error }`），书级量字录成 `book-measure.jsonl`
//! （格式见 `dolce_layout::book::measure`）回放；Rust 用 `dolce-layout::book` 重算后逐字段比：骨架（键、串、数组长）一致、数差 ≤ 1e-6，缺键与 `null` 视同。
//!
//! 上下文行（不计用例）：`ctx`（`style`：成书 BookStyle）、`relayoutCtx`（`style`：校验过的 BookStyle，`fallback`：形状键 → 回填字）。
//! 用例 `kind`：
//!
//! - `keyMeter`（`km`、`x`、`baseline`、`size?`）→ `keyMeterItems`
//! - `region`（`region`、`env`：`pageNo`/`content`/`dy`/`sizes`/`fields`，`km?`/`kmSize?`/`pageItems?` 有就挂 `key-meter`）
//!   → `{ items: placedToDrawItems(…), span, content }`
//! - `wrap`（`text`、`role`、`size`、`width`）、`ornament`（`tiles`、`box`、`edges`）、`annotation`（`o`）
//! - `toc` / `index` / `front`（`items` | `specs`、`o`）→ DrawPage 数组
//! - `relayout`（`page`：`pdf-layout.json` 的页下标，`lyric2Cut?`，`noFallback?`）→ `specToDrawPage` 结果
//! - `shift`（`page`、`dx`）→ 平移后的页
//! - `manifest`（`text`）→ 解析结果或报错；`applyManifest`（`song`、`entry`）→ 覆盖后的 Song
//! - `align`（`gt`、`dec`、`opt`）→ `alignSeq`

use crate::jianpu::{judge_json, panic_text, Tally, Verdict};
use crate::layout::{flag, lines, positional, show_n};
use dolce_layout::book::draw::{shift_draw_page_x, DrawItem, DrawPage};
use dolce_layout::book::measure::{BookMeasure, ReplayBookMeasure};
use dolce_layout::book::parts::{self, KeyMeterSpec, PageFrameOptions};
use dolce_layout::book::relayout::{spec_to_draw_page, SpecToDrawOptions};
use dolce_layout::book::spec::PageSpec;
use dolce_layout::book::template::{placed_to_draw_items, BookRegionEnv, KeyMeterComponent};
use dolce_layout::book::{align, manifest};
use dolce_engrave::style::bookstyle::ink_sample_of;
use dolce_engrave::style::ss::Region;
use dolce_engrave::style::template::{layout_region, FieldExtra};
use indexmap::IndexMap;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

fn de<T: DeserializeOwned>(v: &Value, what: &str) -> Result<T, String> {
    serde_json::from_value(v.clone()).map_err(|e| format!("{what} 读不进：{e}"))
}

fn val<T: serde::Serialize>(v: T) -> Value {
    serde_json::to_value(v).expect("结果转 JSON")
}

struct Ctx {
    style: Value,
    relayout_style: Value,
    fallback: HashMap<String, Option<String>>,
    layout_path: Option<String>,
    specs: Option<Vec<PageSpec>>,
}

impl Ctx {
    fn specs(&mut self) -> Result<(), String> {
        if self.specs.is_none() {
            let p = self.layout_path.as_deref().ok_or("缺 --layout=<pdf-layout.json>")?;
            let t = std::fs::read_to_string(p).map_err(|e| format!("读 {p}：{e}"))?;
            let v: Value = serde_json::from_str(&t).map_err(|e| format!("{p}：{e}"))?;
            self.specs = Some(de(&v["pages"], "版面规格")?);
        }
        Ok(())
    }
}

fn run(case: &Value, kind: &str, cx: &mut Ctx, m: &dyn BookMeasure) -> Result<Value, String> {
    let num = |k: &str| case[k].as_f64().ok_or(format!("缺 {k}"));
    if kind == "relayout" {
        let idx = case["page"].as_u64().ok_or("缺 page")? as usize;
        cx.specs()?;
        let spec = cx.specs.as_ref().unwrap().get(idx).ok_or(format!("没有第 {idx} 页"))?;
        let ink = |role: &str| m.ink_ratio(role, ink_sample_of(role));
        let fallback = |key: &str| cx.fallback.get(key).cloned().flatten();
        let opt = SpecToDrawOptions {
            ink_ratio: &ink,
            fallback_char: if case["noFallback"].as_bool() == Some(true) { None } else { Some(&fallback) },
            lyric2_cut: case["lyric2Cut"].as_f64(),
        };
        return Ok(val(spec_to_draw_page(spec, &cx.relayout_style, &opt)));
    }
    let style = &cx.style;
    Ok(match kind {
        "keyMeter" => {
            let km: KeyMeterSpec = de(&case["km"], "km")?;
            val(parts::key_meter_items(style, &km, num("x")?, num("baseline")?, m, case["size"].as_f64()))
        }
        "region" => {
            let region: Region = de(&case["region"], "区域")?;
            let env = &case["env"];
            let fields: IndexMap<String, Option<FieldExtra>> = de(&env["fields"], "字段")?;
            let sizes: IndexMap<String, f64> = if env["sizes"].is_null() { IndexMap::new() } else { de(&env["sizes"], "字号")? };
            let page_items: Vec<DrawItem> = if case["pageItems"].is_null() { vec![] } else { de(&case["pageItems"], "本页图元")? };
            let key_meter = case.get("km").map(|k| -> Result<_, String> {
                Ok(KeyMeterComponent { style, measure: m, km: if k.is_null() { None } else { Some(de(k, "km")?) }, page_items: &page_items, size: case["kmSize"].as_f64() })
            });
            let key_meter = key_meter.transpose()?;
            let content = (env["content"]["left"].as_f64().unwrap_or(f64::NAN), env["content"]["right"].as_f64().unwrap_or(f64::NAN));
            let renv = BookRegionEnv {
                style,
                measure: m,
                fields,
                page_no: env["pageNo"].as_f64().unwrap_or(f64::NAN),
                content,
                dy: env["dy"].as_f64().unwrap_or(0.0),
                sizes,
                key_meter,
            };
            let r = layout_region(Some(&region), &renv).map_err(|e| e.message)?;
            let items = placed_to_draw_items(&r.items).map_err(|e| format!("组件图元读不回：{e}"))?;
            json!({ "items": val(items), "span": r.span, "content": r.content })
        }
        "wrap" => val(parts::wrap_text(case["text"].as_str().unwrap_or(""), case["role"].as_str().unwrap_or(""), num("size")?, num("width")?, m)),
        "ornament" => {
            let tiles: Vec<parts::OrnamentTileSpec> = de(&case["tiles"], "花边")?;
            let bx: parts::BoxRect = de(&case["box"], "框")?;
            json!(parts::ornament_frame_path(&tiles, bx, case["edges"].as_str().unwrap_or("TBLR")))
        }
        "annotation" => {
            let o: parts::AnnotationOptions = de(&case["o"], "注解选项")?;
            val(parts::annotation_block(style, &o, m))
        }
        "toc" | "index" | "front" => {
            let o: PageFrameOptions = de(&case["o"], "页选项")?;
            let pages = match kind {
                "toc" => parts::toc_pages(style, &de::<Vec<parts::TocItem>>(&case["items"], "目录条目")?, &o, m),
                "index" => parts::index_pages(style, &de::<Vec<parts::IndexItem>>(&case["items"], "索引条目")?, &o, m),
                _ => parts::front_pages(style, &de::<Vec<parts::FrontPageSpec>>(&case["specs"], "扉页")?, &o, m),
            };
            val(pages)
        }
        "shift" => {
            let mut p: DrawPage = de(&case["page"], "页")?;
            shift_draw_page_x(&mut p, num("dx")?);
            val(p)
        }
        "manifest" => val(manifest::parse_manifest(case["text"].as_str().unwrap_or(""))?),
        "applyManifest" => {
            let mut song: dolce_model::doc::Song = de(&case["song"], "曲")?;
            let entry: manifest::ManifestSong = de(&case["entry"], "清单项")?;
            manifest::apply_manifest_song(&mut song, &entry);
            val(song)
        }
        "align" => {
            let dec: Vec<Option<String>> = de(&case["dec"], "字形序列")?;
            let opt: align::AlignOptions = if case["opt"].is_null() { Default::default() } else { de(&case["opt"], "参数")? };
            val(align::align_seq(case["gt"].as_str().unwrap_or(""), &dec, &opt))
        }
        _ => return Err(format!("不认识的用例种类 {kind}")),
    })
}

pub fn book_parts_check(args: &[String]) -> i32 {
    let pos = positional(args);
    let (Some(path), Some(mpath)) = (pos.first(), flag(args, "measure")) else {
        eprintln!("用法：dolce-dev book-parts-check <cases.jsonl> --measure=<book-measure.jsonl> [--layout=<pdf-layout.json>] [--kind=…] [--key=子串] [--show=N]");
        return 2;
    };
    let measure = ReplayBookMeasure::from_jsonl(&std::fs::read_to_string(mpath).expect("读量字录制")).expect("量字录制");
    let kinds: Option<Vec<&str>> = flag(args, "kind").map(|s| s.split(',').collect());
    let key_sub = flag(args, "key");
    let show = show_n(args);
    let mut cx = Ctx { style: Value::Null, relayout_style: Value::Null, fallback: HashMap::new(), layout_path: flag(args, "layout").map(str::to_string), specs: None };
    std::panic::set_hook(Box::new(|_| {}));
    let mut tally: BTreeMap<String, Tally> = BTreeMap::new();
    let mut shown = 0usize;
    for l in lines(path) {
        let case: Value = serde_json::from_str(&l).unwrap_or_else(|e| panic!("{path} 读不进：{e}"));
        let kind = case["kind"].as_str().unwrap_or("?").to_string();
        match kind.as_str() {
            "ctx" => {
                cx.style = case["style"].clone();
                continue;
            }
            "relayoutCtx" => {
                cx.relayout_style = case["style"].clone();
                cx.fallback = serde_json::from_value(case["fallback"].clone()).expect("回填表");
                if cx.layout_path.is_none() {
                    cx.layout_path = case["layout"].as_str().map(str::to_string);
                }
                continue;
            }
            _ => {}
        }
        let key = case["key"].as_str().unwrap_or("?").to_string();
        if kinds.as_ref().is_some_and(|k| !k.contains(&kind.as_str())) || key_sub.is_some_and(|k| !key.contains(k)) {
            continue;
        }
        let got = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&case, &kind, &mut cx, &measure)))
            .unwrap_or_else(|p| Err(format!("panic：{}", panic_text(&*p))));
        let t = tally.entry(kind.clone()).or_default();
        let verdict = match (&got, case.get("error").and_then(Value::as_str), case.get("expect")) {
            (Ok(v), None, Some(want)) => judge_json(want, Some(v)),
            // 清单的报错：TS 自己的两句要逐字一样，JSON 语法错只要都报错
            (Err(e), Some(want), _) => {
                if want.starts_with("book.json") && e != want {
                    Verdict::Skeleton(vec![format!("报错不同：{want} → {e}")])
                } else {
                    Verdict::Same(0.0)
                }
            }
            (Ok(v), Some(want), _) => Verdict::Skeleton(vec![format!("TS 报错「{want}」，Rust 得 {}", v.to_string().chars().take(200).collect::<String>())]),
            (Err(e), None, _) => Verdict::Skeleton(vec![format!("Rust 报错：{e}")]),
            (Ok(_), None, None) => Verdict::Missing,
        };
        let bad = match verdict {
            Verdict::Same(e) => {
                t.same += 1;
                if e > t.max {
                    t.max = e;
                    t.max_at = key.clone();
                }
                None
            }
            Verdict::Num(e, at) => {
                t.num += 1;
                if e > t.max {
                    t.max = e;
                    t.max_at = format!("{key} {at}");
                }
                Some(vec![format!("数超差 {e:e}：{at}")])
            }
            Verdict::Skeleton(d) => {
                t.skeleton += 1;
                Some(d)
            }
            Verdict::Missing => {
                t.missing += 1;
                Some(vec!["用例缺 expect".into()])
            }
        };
        if let Some(d) = bad {
            if shown < show {
                shown += 1;
                println!("✗ [{kind}] {key}（{} 处）", d.len());
                for x in d.iter().take(8) {
                    println!("    {x}");
                }
            }
        }
    }
    let mut bad = 0;
    for (k, t) in &tally {
        let n = t.same + t.num + t.skeleton + t.missing;
        println!("{k:<14} {n:>6} 例  一致 {}  数超差 {}  骨架不同 {}  缺 {}  最大数差 {:e}", t.same, t.num, t.skeleton, t.missing, t.max);
        bad += t.num + t.skeleton + t.missing;
    }
    let misses = measure.miss_count();
    println!("量字缺键 {misses}");
    for s in measure.misses.borrow().iter().take(show) {
        println!("    {s}");
    }
    if bad > 0 || misses > 0 {
        1
    } else {
        println!("全部一致");
        0
    }
}
