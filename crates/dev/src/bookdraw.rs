//! `dolce-dev book-draw-check <cases.jsonl> --measure=<measure.jsonl>`：成书迁 Rust（L6）的 `browser.ts` / `songbook.ts` 对拍。
//! 用例由 dev `book-draw-rs-diff.mjs` 让 TS 现算（`cli/bookdrawref.ts`）；这里在量字回放下用 `dolce-book` 重算，逐段比：
//!
//! - 成书一首（`kind: "song"`）：`doc`（`book_doc_of`，去掉 `source` 与身份 `_oid`）、`cells`（`book_cells_per_line`）、
//!   `spans`（`measure_book_spans`）、`draw`（各页高 × 各调法的 DrawPage、谱行数、最长谱行格数，另带 `naturalH`）；
//! - 混排歌本整本（`kind: "songbook"`）：`songbook`（整个 SongbookResult，报错只比标题）。
//!
//! 比法、容差、`--native` 验收门同 `jianpu-check`（见 `jianpu.rs`）。
//! 选项：`--stage=doc,cells,spans,draw,songbook`（缺省全比）、`--limit=N`、`--key=子串`、`--show=N`、`--redist=<目录>`。

use crate::jianpu::{judge_json, panic_text, Tally, Verdict, TOL};
use crate::layout::{flag, lines, positional, show_n};
use dolce_layout::book::draw::PageMeta;
use dolce_layout::book::draw::PageSong;
use dolce_layout::book::scenedraw::{
    book_cells_per_line, book_doc_of, count_staff_rows, layout_book_doc, max_staff_row_cells, measure_book_spans, page_items_to_draw_page, RoleOf, ToDrawOptions,
};
use dolce_layout::book::songbook::{layout_mixed_songbook, ManifestSong, SongSource, SongbookInput};
use dolce_engrave::Env;
use dolce_engrave::scene::smufl::MetaData;
use dolce_engrave::text::{MeasureCtx, ReplayMeasurer};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const STAGES: [&str; 5] = ["doc", "cells", "spans", "draw", "songbook"];

/// 数：非有限数写成 `"NaN"` / `"Inf"` / `"-Inf"`（同 TS `jn`）
fn jn(x: f64) -> Value {
    if x.is_finite() {
        json!(x)
    } else if x.is_nan() {
        json!("NaN")
    } else if x > 0.0 {
        json!("Inf")
    } else {
        json!("-Inf")
    }
}

/// 去掉身份 `_oid`（TS 镜像里没有）
fn strip_oid(v: &mut Value) {
    match v {
        Value::Object(o) => {
            o.remove("_oid");
            o.values_mut().for_each(strip_oid);
        }
        Value::Array(a) => a.iter_mut().for_each(strip_oid),
        _ => {}
    }
}

fn to_json<T: serde::Serialize>(v: &T) -> Value {
    serde_json::to_value(v).expect("写得出 JSON")
}

/// 成书一首：Rust 算出的各段
fn run_song(case: &Value, env: &Env) -> Result<BTreeMap<&'static str, Value>, String> {
    let xml = case["xml"].as_str().ok_or("用例缺 xml")?;
    let style = &case["style"];
    let mut got = BTreeMap::new();

    let mut doc = to_json(&book_doc_of(xml)?);
    if let Some(o) = doc.as_object_mut() {
        o.remove("source");
    }
    strip_oid(&mut doc);
    got.insert("doc", doc);
    got.insert("cells", jn(book_cells_per_line(&mut book_doc_of(xml)?, style, env)?));
    let (w, spans) = measure_book_spans(&mut book_doc_of(xml)?, style, env)?;
    got.insert(
        "spans",
        json!({ "width": jn(w), "spans": spans.iter().map(|(id, s)| json!([id, { "x0": jn(s.x0), "x1": jn(s.x1), "x1b": s.x1b.map_or(Value::Null, jn) }])).collect::<Vec<_>>() }),
    );

    let num = |v: &Value| v.as_f64().unwrap_or(f64::NAN);
    let (pw, ph) = (num(&style["page"]["w"]), num(&style["page"]["h"]));
    let (mt, mb) = (num(&style["page"]["margin"]["top"]), num(&style["page"]["margin"]["bottom"]));
    let id = case["id"].as_str().map(str::to_string);
    let title = case["title"].as_str().map(str::to_string);
    let variants = case["variants"].as_array().ok_or("用例缺 variants")?;
    let mut natural0: Option<f64> = None;
    let mut layouts = Vec::new();
    for (li, h0) in case["pageHs"].as_array().ok_or("用例缺 pageHs")?.iter().enumerate() {
        let page_h = if h0.as_str() == Some("compact") { mt + natural0.unwrap_or(0.0) + 0.5 + mb } else { num(h0) };
        let r = layout_book_doc(&book_doc_of(xml)?, style, page_h, false, env)?;
        natural0.get_or_insert(r.natural_h);
        let mut draws = Vec::new();
        for v in variants.get(li).unwrap_or(&variants[0]).as_array().ok_or("variants 不是数组")? {
            let mut pages = Vec::new();
            for (i, g) in r.layout.pages.iter().enumerate() {
                let o = ToDrawOptions {
                    role_of: if v["role"] == "book" { RoleOf::Book } else { RoleOf::Item },
                    page_no: i as i64 + 1,
                    meta: PageMeta { kind: "score".into(), songs: vec![PageSong { id: id.clone(), title: title.clone(), first: i == 0, y_from: None, y_to: None }], page_label: None },
                    scale: v.get("scale").and_then(Value::as_f64),
                    offset: Some((num(&v["offset"][0]), num(&v["offset"][1]))),
                };
                pages.push(page_items_to_draw_page(Some(g), pw, ph, o, env).map_err(|e| e.0)?);
            }
            draws.push(json!({ "variant": v, "pages": to_json(&pages), "rows": count_staff_rows(&pages), "maxCells": max_staff_row_cells(&pages) }));
        }
        layouts.push(json!({ "pageH": jn(page_h), "naturalH": jn(r.natural_h), "draws": draws }));
    }
    got.insert("draw", Value::Array(layouts));
    Ok(got)
}

/// 用例 / 输入 JSON（`{songs: [{xml, entry}], rules, songStart, families}`）→ `SongbookInput`
fn songbook_input(case: &Value) -> Result<SongbookInput, String> {
    let songs = case["songs"]
        .as_array()
        .ok_or("缺 songs")?
        .iter()
        .map(|s| -> Result<SongSource, String> {
            Ok(SongSource {
                xml: s["xml"].as_str().ok_or("曲子缺 xml")?.to_string(),
                entry: serde_json::from_value::<ManifestSong>(s["entry"].clone()).map_err(|e| format!("清单项读不进：{e}"))?,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let rules = dolce_engrave::style::cascade::layer_from_json(&case["rules"]).map_err(|e| format!("规则读不进：{e}"))?;
    let families = case["families"].as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect()).unwrap_or_default();
    Ok(SongbookInput { songs, rules, song_start: case["songStart"].as_str().map(str::to_string), families })
}

/// 混排歌本整本
fn run_songbook(case: &Value, env: &Env) -> Result<Value, String> {
    let r = layout_mixed_songbook(&songbook_input(case)?, env)?;
    let mut v = to_json(&r);
    // 报错只比标题（错误文本是各自的栈）
    v["errors"] = Value::Array(r.errors.iter().map(|e| json!({ "title": e.title })).collect());
    Ok(v)
}

/// `dolce-dev songbook <input.json> --out=<result.json> [--fonts=<族名→文件.json>] [--redist=<目录>]`：混排歌本整本排版（dev `kl2020-book.mjs` 用）。
/// 输入同 `book-draw-check` 的 `songbook` 用例（`{songs: [{xml, entry}], rules, songStart, families}`，`rules` 是 `.ss` 解析出的规则）；
/// 出 `SongbookResult` JSON（目录页、谱面页、各曲起始页、用到的族…）。量字是系统文字引擎（Chromium 口径），`--fonts` 给的字体文件先注册。
pub fn songbook(args: &[String]) -> i32 {
    let pos = positional(args);
    let (Some(path), Some(out)) = (pos.first(), flag(args, "out")) else {
        eprintln!("用法：dolce-dev songbook <input.json> --out=<result.json> [--fonts=<族名→文件.json>] [--redist=<目录>]");
        return 2;
    };
    let redist = std::path::PathBuf::from(flag(args, "redist").unwrap_or("public/redist"));
    let files: Vec<(String, String)> = match flag(args, "fonts") {
        Some(f) => {
            let v: BTreeMap<String, String> = serde_json::from_str(&std::fs::read_to_string(f).expect("读字体表")).expect("字体表要是 {族名: 路径}");
            v.into_iter().collect()
        }
        None => vec![],
    };
    let backend = dolce_engrave::text::native::node_measure(Some(&redist), &files);
    let mc = MeasureCtx::new(&backend);
    let meta = MetaData::from_json(&std::fs::read_to_string(redist.join("bravura_metadata.json")).expect("读 SMuFL 元数据")).expect("SMuFL 元数据");
    let env = Env { mc: &mc, meta: Some(&meta) };
    let case: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("读输入")).expect("输入不是 JSON");
    let r = songbook_input(&case).and_then(|inp| layout_mixed_songbook(&inp, &env));
    match r {
        Ok(r) => {
            std::fs::write(out, serde_json::to_string(&r).expect("出 JSON")).expect("写出");
            0
        }
        Err(e) => {
            eprintln!("排不出：{e}");
            1
        }
    }
}

pub fn book_draw_check(args: &[String]) -> i32 {
    let pos = positional(args);
    let native = args.iter().any(|a| a == "--native");
    let mpath = flag(args, "measure");
    let (Some(path), true) = (pos.first(), native || mpath.is_some()) else {
        eprintln!("用法：dolce-dev book-draw-check <cases.jsonl> (--measure=<measure.jsonl> | --native) [--stage=doc,cells,spans,draw,songbook] [--limit=N] [--key=子串] [--show=N] [--redist=<目录>]");
        return 2;
    };
    let stages: Vec<&str> = flag(args, "stage").map_or(STAGES.to_vec(), |s| s.split(',').collect());
    let limit: usize = flag(args, "limit").and_then(|v| v.parse().ok()).unwrap_or(usize::MAX);
    let key_sub = flag(args, "key");
    let show = show_n(args);
    let redist = std::path::PathBuf::from(flag(args, "redist").unwrap_or("public/redist"));
    let meta = MetaData::from_json(&std::fs::read_to_string(redist.join("bravura_metadata.json")).expect("读 SMuFL 元数据")).expect("SMuFL 元数据");
    let replay: Option<ReplayMeasurer> = (!native).then(|| {
        ReplayMeasurer::from_jsonl(&std::fs::read_to_string(mpath.unwrap()).expect("读量字录制")).expect("量字录制").with_path_fallback()
    });
    let native_backend = native.then(|| dolce_engrave::text::native::node_measure(Some(&redist), &[]));
    if native {
        TOL.get_or_init(|| 0.5);
    }
    let mc = match (&replay, &native_backend) {
        (Some(r), _) => MeasureCtx::new(r),
        (_, Some(n)) => MeasureCtx::new(n),
        _ => unreachable!(),
    };
    let env = Env { mc: &mc, meta: Some(&meta) };
    std::panic::set_hook(Box::new(|_| {}));

    let mut tally: BTreeMap<&str, Tally> = stages.iter().map(|s| (*s, Tally::default())).collect();
    let (mut cases, mut failed, mut shown) = (0usize, 0usize, 0usize);
    let mut by_kind: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for l in lines(path) {
        if cases >= limit {
            break;
        }
        let case: Value = serde_json::from_str(&l).unwrap_or_else(|e| panic!("{path} 读不进：{e}"));
        let key = case["key"].as_str().unwrap_or("?").to_string();
        let kind = case["kind"].as_str().unwrap_or("?").to_string();
        if key_sub.is_some_and(|k| !key.contains(k)) {
            continue;
        }
        cases += 1;
        let expect = &case["expect"];
        let got = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<BTreeMap<&'static str, Value>, String> {
            match kind.as_str() {
                "song" => run_song(&case, &env),
                "songbook" => Ok(BTreeMap::from([("songbook", run_songbook(&case, &env)?)])),
                k => Err(format!("未知的用例种类：{k}")),
            }
        }));
        let got = match got {
            Ok(Ok(g)) => g,
            Ok(Err(e)) => {
                failed += 1;
                if shown < show {
                    shown += 1;
                    println!("✗ {key}：{e}");
                }
                continue;
            }
            Err(p) => {
                failed += 1;
                if shown < show {
                    shown += 1;
                    println!("✗ {key}：panic {}", panic_text(&*p));
                }
                continue;
            }
        };
        let mut ok = true;
        for st in &stages {
            let want = match *st {
                "doc" | "cells" | "spans" => expect[*st].clone(),
                "draw" => expect["layouts"].clone(),
                "songbook" => expect.clone(),
                other => {
                    eprintln!("未知的 stage：{other}");
                    return 2;
                }
            };
            let Some(g) = got.get(st) else { continue };
            let t = tally.get_mut(st).expect("已建");
            match judge_json(&want, Some(g)) {
                Verdict::Same(e) => {
                    t.same += 1;
                    if e > t.max {
                        t.max = e;
                        t.max_at = key.clone();
                    }
                }
                Verdict::Num(e, w) => {
                    t.num += 1;
                    ok = false;
                    if e > t.max {
                        t.max = e;
                        t.max_at = format!("{key} {w}");
                    }
                    if shown < show {
                        shown += 1;
                        println!("✗ [{st}] {key}：数超差 {e:e} @ {w}");
                    }
                }
                Verdict::Skeleton(xs) => {
                    t.skeleton += 1;
                    ok = false;
                    if shown < show {
                        shown += 1;
                        println!("✗ [{st}] {key}：骨架 {} 处", xs.len());
                        for x in xs.iter().take(8) {
                            println!("    {x}");
                        }
                    }
                }
                Verdict::Missing => t.missing += 1,
            }
        }
        let e = by_kind.entry(kind).or_default();
        e.0 += 1;
        e.1 += usize::from(ok);
    }
    let (misses, fallbacks) = match &replay {
        Some(r) if !native => (r.misses(), r.path_fallbacks()),
        _ => (vec![], 0),
    };
    for m in misses.iter().take(10) {
        println!("  缺键：{m}");
    }
    println!("—— {cases} 档（报错 {failed}）");
    for (k, (n, ok)) in &by_kind {
        println!("  {k:<10} {n:>5} 档  全一致 {ok}");
    }
    let mut bad = failed;
    for (st, t) in &tally {
        bad += t.num + t.skeleton;
        println!(
            "  {st:<8} 一致 {:>5}  骨架差 {:>4}  数超差 {:>4}  未比 {:>4}  最大数差 {:e}{}",
            t.same,
            t.skeleton,
            t.num,
            t.missing,
            t.max,
            if t.max_at.is_empty() { String::new() } else { format!("（{}）", t.max_at) }
        );
    }
    println!("量字缺键 {}、路径盒现算 {}", misses.len(), fallbacks);
    i32::from(bad > 0 || !misses.is_empty())
}
