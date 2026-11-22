//! `dolce-dev book-meta-check <cases.jsonl> --measure=<book-measure.jsonl>`：成书（L6）书级元数据与书籍样式统计迁 Rust 的对拍。
//! 用例由 dev `book-meta-rs-diff.mjs` 让 TS 现算（`src/cli/bookmetaref.ts::bookMetaCases`）；这里用 `dolce-book` 的
//! `meta` / `stats` 重算逐字段比（比法同 `jianpu-check`：骨架一致、数差 ≤ 1e-6）。
//!
//! 用例种类（`kind`）：
//! - `setup`（首行）：版面规格路径（`layout`，读 `pages` / `profile` / `classHeights`）、逐字覆盖表（`override`：形状键 → 定案字）；
//! - `noteHeightOf`：音符字号；
//! - `page`：逐页中间结果——各行 `runText`（带 / 不带覆盖）、`parseKeyMeter`、`isTocPage` / `isIndexPage`、`clusterRuleFrames`、
//!   `scoreAnnotationGroups`（框、重新聚行的文本与行内字序）、花边框的 `regroupBoxLines` / `extractOrnamentTiles` / `edgeMask`、
//!   索引页逐行 `parseIndexLine`；
//! - `indexLine`：拼出来的索引行；
//! - `bookMeta`：整本 `buildBookMeta`（带覆盖 + 实测音符字号 / 不带覆盖 + 缺省）；
//! - `roleSamples` / `metricSamples` / `tocRule`：统计原料；
//! - `bookStyle`：`inferBookStyle` 的样式与报告，外加 `printBookSs` 文本逐字节。
//!
//! 选项：`--kind=种类`、`--key=子串`、`--show=N`。

use crate::jianpu::{judge_json, panic_text, Tally, Verdict};
use crate::layout::{flag, lines, positional, show_n};
use dolce_book::measure::ReplayBookMeasure;
use dolce_book::meta::{self, CharOverride, UNREAD};
use dolce_book::spec::{PageSpec, TextRun};
use dolce_book::stats::{self, BookProfile, InferOptions, SampleOptions};
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

struct Book {
    pages: Vec<PageSpec>,
    profile: BookProfile,
    class_heights: Option<IndexMap<String, Vec<f64>>>,
    table: HashMap<String, String>,
}

fn to_json<T: serde::Serialize>(v: &T) -> Value {
    serde_json::to_value(v).expect("可序列化")
}

/// 一页上所有的文字行（同 TS `pageRuns`）
fn page_runs(spec: &PageSpec) -> Vec<&TextRun> {
    let mut out: Vec<&TextRun> = vec![];
    out.extend(spec.header.as_ref());
    out.extend(spec.footer.as_ref());
    out.extend(&spec.text_lines);
    for s in &spec.songs {
        out.extend(s.number_run.as_ref());
        out.extend(s.title_run.as_ref());
        out.extend(s.key_meter_run.as_ref());
        out.extend(s.category_run.as_ref());
        out.extend(&s.credit_runs);
        for y in &s.systems {
            out.extend(&y.chord_lines);
            out.extend(&y.lyric_lines);
        }
    }
    for b in &spec.story_boxes {
        out.extend(&b.lines);
    }
    out
}

fn page_case(spec: &PageSpec, ov: CharOverride, note_h: f64) -> Value {
    let runs = page_runs(spec);
    let rule_frames = meta::cluster_rule_frames(&spec.frames);
    let is_index = meta::is_index_page(spec, ov);
    let groups: Vec<Value> = meta::score_annotation_groups(spec, &rule_frames, ov)
        .iter()
        .map(|g| {
            let rows: Vec<Value> =
                meta::group_box_rows(&g.lines).iter().map(|r| Value::Array(r.iter().map(|c| json!([c.x, c.ch])).collect())).collect();
            json!({ "frame": to_json(&g.frame), "lines": meta::regroup_box_lines(&g.lines, ov), "rows": rows })
        })
        .collect();
    let stories: Vec<Value> = spec
        .story_boxes
        .iter()
        .map(|b| {
            let tiles = meta::extract_ornament_tiles(spec, &b.bx, note_h);
            json!({
                "lines": meta::regroup_box_lines(&b.lines, ov),
                "linesRaw": meta::regroup_box_lines(&b.lines, None),
                "tiles": to_json(&tiles),
                "edges": meta::edge_mask(&tiles),
            })
        })
        .collect();
    json!({
        "texts": runs.iter().map(|r| meta::run_text(Some(r), ov)).collect::<Vec<_>>(),
        "textsRaw": runs.iter().map(|r| meta::run_text(Some(r), None)).collect::<Vec<_>>(),
        "keyMeters": spec.songs.iter().map(|s| to_json(&meta::parse_key_meter(s, spec.page, ov))).collect::<Vec<_>>(),
        "keyMetersRaw": spec.songs.iter().map(|s| to_json(&meta::parse_key_meter(s, spec.page, None))).collect::<Vec<_>>(),
        "isToc": meta::is_toc_page(spec, ov),
        "isIndex": is_index,
        "ruleFrames": to_json(&rule_frames),
        "annGroups": groups,
        "stories": stories,
        "indexLines": if is_index {
            Value::Array(spec.text_lines.iter().map(|l| to_json(&meta::parse_index_line(dolce_base::js::trim(&meta::run_text(Some(l), ov))))).collect())
        } else {
            Value::Null
        },
    })
}

fn sample_opt(c: &Value) -> SampleOptions {
    SampleOptions { from_page: c["fromPage"].as_f64(), to_page: c["toPage"].as_f64() }
}

/// 现算一档；`Err` 是 TS 侧会抛出的那类报错原文
fn run(c: &Value, book: &Book, measure: &ReplayBookMeasure) -> Result<Value, String> {
    let table = &book.table;
    let ov_fn = |key: &str, cur: &str| table.get(key).cloned().or_else(|| (cur != UNREAD).then(|| cur.to_string()));
    let ov: CharOverride = Some(&ov_fn);
    let pages = &book.pages;
    Ok(match c["kind"].as_str().unwrap_or("") {
        "noteHeightOf" => json!(stats::note_height_of(&book.profile)),
        "page" => {
            let n = c["page"].as_i64().ok_or("缺页号")?;
            let spec = pages.iter().find(|p| p.page == n).ok_or_else(|| format!("没有第 {n} 页"))?;
            page_case(spec, ov, c["noteH"].as_f64().unwrap_or(8.3))
        }
        "indexLine" => to_json(&meta::parse_index_line(c["text"].as_str().unwrap_or(""))),
        "bookMeta" => {
            let with_ov = c["ov"].as_bool().unwrap_or(false);
            to_json(&meta::build_book_meta(pages, if with_ov { ov } else { None }, c["noteH"].as_f64()))
        }
        "roleSamples" => to_json(&stats::collect_role_samples(pages, sample_opt(c))),
        "metricSamples" => to_json(&stats::collect_metric_samples(pages, sample_opt(c))),
        "tocRule" => Value::Object(stats::infer_toc_rule(pages)),
        "bookStyle" => {
            let opt = InferOptions {
                sample: sample_opt(c),
                id: c["id"].as_str().map(String::from),
                class_heights: book.class_heights.as_ref(),
                measure,
            };
            let (style, report) = stats::infer_book_style(&book.profile, pages, &c["fonts"], &opt)?;
            let ss = dolce_style::bookss::print_book_ss(&style).map_err(|e| format!("printBookSs：{e}"))?;
            json!({ "style": style, "report": to_json(&report), "ss": ss })
        }
        other => return Err(format!("未知的用例种类 {other}")),
    })
}

fn load_book(c: &Value) -> Book {
    let path = c["layout"].as_str().expect("setup 缺 layout");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap_or_else(|e| panic!("读 {path}：{e}"))).expect("版面规格 JSON");
    let pages: Vec<PageSpec> = serde_json::from_value(v["pages"].clone()).expect("pages");
    let profile: BookProfile = serde_json::from_value(v["profile"].clone()).expect("profile");
    let class_heights = serde_json::from_value(v["classHeights"].clone()).ok();
    let table = c["override"].as_object().map(|o| o.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect()).unwrap_or_default();
    Book { pages, profile, class_heights, table }
}

pub fn book_meta_check(args: &[String]) -> i32 {
    let pos = positional(args);
    let (Some(path), Some(mpath)) = (pos.first(), flag(args, "measure")) else {
        eprintln!("用法：dolce-dev book-meta-check <cases.jsonl> --measure=<book-measure.jsonl> [--kind=种类] [--key=子串] [--show=N]");
        return 2;
    };
    let kind_only = flag(args, "kind");
    let key_sub = flag(args, "key");
    let show = show_n(args);
    let measure = ReplayBookMeasure::from_jsonl(&std::fs::read_to_string(mpath).expect("读量字录制")).expect("量字录制");
    std::panic::set_hook(Box::new(|_| {}));

    let mut book: Option<Book> = None;
    let mut tally: BTreeMap<String, Tally> = BTreeMap::new();
    let (mut cases, mut failed, mut shown) = (0usize, 0usize, 0usize);
    for l in lines(path) {
        let case: Value = serde_json::from_str(&l).unwrap_or_else(|e| panic!("{path} 读不进：{e}"));
        let kind = case["kind"].as_str().unwrap_or("?").to_string();
        if kind == "setup" {
            book = Some(load_book(&case));
            continue;
        }
        let key = case["key"].as_str().unwrap_or("?").to_string();
        if kind_only.is_some_and(|k| k != kind) || key_sub.is_some_and(|k| !key.contains(k)) {
            continue;
        }
        let Some(b) = &book else {
            eprintln!("用例文件缺 setup 行");
            return 2;
        };
        cases += 1;
        let got = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&case, b, &measure)));
        let t = tally.entry(kind.clone()).or_default();
        let verdict = match got {
            Err(p) => {
                failed += 1;
                if shown < show {
                    shown += 1;
                    println!("✗ {key}：panic {}", panic_text(&*p));
                }
                continue;
            }
            Ok(Err(e)) => {
                if case["error"].as_str() == Some(e.as_str()) {
                    Verdict::Same(0.0)
                } else {
                    Verdict::Skeleton(vec![format!("Rust 报错「{e}」，TS {}", case.get("error").map_or("没报错".into(), |x| format!("报错 {x}")))])
                }
            }
            Ok(Ok(v)) => {
                if let Some(e) = case.get("error") {
                    Verdict::Skeleton(vec![format!("TS 报错 {e}，Rust 没报错")])
                } else {
                    judge_json(&case["expect"], Some(&v))
                }
            }
        };
        match verdict {
            Verdict::Same(e) => {
                t.same += 1;
                if e > t.max {
                    t.max = e;
                    t.max_at = key.clone();
                }
            }
            Verdict::Num(e, w) => {
                t.num += 1;
                if e > t.max {
                    t.max = e;
                    t.max_at = format!("{key} {w}");
                }
                if shown < show {
                    shown += 1;
                    println!("✗ [{kind}] {key}：数超差 {e:e} @ {w}");
                }
            }
            Verdict::Skeleton(xs) => {
                t.skeleton += 1;
                if shown < show {
                    shown += 1;
                    println!("✗ [{kind}] {key}：骨架 {} 处", xs.len());
                    for x in xs.iter().take(8) {
                        println!("    {x}");
                    }
                }
            }
            Verdict::Missing => t.missing += 1,
        }
    }
    let misses = measure.misses.borrow();
    for m in misses.iter().take(10) {
        println!("  量字缺键：{m}");
    }
    println!("—— {cases} 例（报错 {failed}）");
    let mut bad = failed;
    for (k, t) in &tally {
        bad += t.num + t.skeleton;
        println!(
            "  {k:<14} 一致 {:>5}  骨架差 {:>4}  数超差 {:>4}  最大数差 {:e}{}",
            t.same,
            t.skeleton,
            t.num,
            t.max,
            if t.max_at.is_empty() { String::new() } else { format!("（{}）", t.max_at) }
        );
    }
    println!("量字缺键 {}", misses.len());
    i32::from(bad > 0 || !misses.is_empty())
}
