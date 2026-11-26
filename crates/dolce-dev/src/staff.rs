//! `dolce-dev staff-check <cases.jsonl> --measure=<measure.jsonl>`：五线谱 / 混排引擎迁 Rust（L5）的对拍。
//! 用例由 dev `staff-rs-diff.mjs` 让 TS 整份排出（文档 + MusicXML 原文 + 选项 + 各阶段 dump + 整页场景）；这里在量字回放下用
//! `dolce-layout-staff` 重排，逐档比五段：
//!
//! - `read` / `systems` / `layout` / `pages`：版面态 dump（`dolce_layout_staff::dump::staff_dump`，TS `cli/staffref.ts::staffDump`），
//!   依次是读入建树后、分系统与 `layoutAttr` 之后、`layoutStaff` 返回、装页之后（另带 `placed`）；
//! - `scene`：各页场景（`dolce_engrave::scene::dump::diff_pages`）。
//!
//! 表层：用例带了 MusicXML 原文的，Rust 重读一遍拿表层（`_oid` 由读入次序定，两边同号）；重读出的文档与用例的对不上时记「文档不符」
//! （混排歌本用例带 `docEdited`：清单改过页眉、可能裁过声部，不比）。
//! 比法、容差、`--native` 验收门同 `jianpu-check`（见 `jianpu.rs`）。
//!
//! 选项：`--stage=read,systems,layout,pages,scene`（缺省全比）、`--limit=N`、`--key=子串`、`--cfg=档名`、`--show=N`、`--redist=<目录>`。

use crate::jianpu::{judge_json, judge_pages, panic_text, Tally, Verdict, TOL};
use crate::layout::{flag, lines, positional, show_n};
use dolce_engrave::Env;
use dolce_model::doc::ScoreDoc;
use dolce_engrave::scene::build::freeze;
use dolce_engrave::scene::{Dialect, Page};
use dolce_engrave::scene::smufl::MetaData;
use dolce_engrave::style::staff::MixedOptions;
use dolce_engrave::text::{MeasureCtx, ReplayMeasurer};
use serde_json::Value;
use std::collections::BTreeMap;

const STAGES: [&str; 5] = ["read", "systems", "layout", "pages", "scene"];

/// Rust 排出来的、要比的几段
#[derive(Default)]
struct Got {
    dumps: BTreeMap<String, Value>,
    pages: Option<Vec<Page>>,
    doc_mismatch: bool,
}

fn run(case: &Value, env: &Env) -> Result<Got, String> {
    use dolce_layout_staff::{dump, pages, read};
    let mut doc: ScoreDoc = serde_json::from_value(case["doc"].clone()).map_err(|e| format!("文档读不进：{e}"))?;
    let options: MixedOptions = serde_json::from_value(case["options"].clone()).map_err(|e| format!("选项读不进：{e}"))?;
    let mixed = case["mixed"].as_bool().unwrap_or(false);
    let jianpu_part = case["jianpuPart"].as_u64().unwrap_or(0) as usize;
    let mut got = Got::default();
    let loaded = match case["xml"].as_str() {
        Some(xml) => {
            let l = dolce_model::fromxml::load_score_doc(xml).map_err(|m| format!("原文读不进：{m:?}"))?;
            let mut v = serde_json::to_value(&l.doc).map_err(|e| e.to_string())?;
            if let Some(o) = v.as_object_mut() {
                o.remove("source");
            }
            // 演唱顺序（jpwabc 自带、不进 MusicXML）与表层身份无关，不比
            let mut want = case["doc"].clone();
            for d in [&mut want, &mut v] {
                for sg in d["songs"].as_array_mut().into_iter().flatten() {
                    if let Some(o) = sg.as_object_mut() {
                        o.remove("playOrder");
                    }
                }
            }
            // 歌本用例（`docEdited`）的文档是清单改过的，重读对不上是预期的
            got.doc_mismatch = !case["docEdited"].as_bool().unwrap_or(false)
                && match judge_json(&want, Some(&v)) {
                    Verdict::Same(_) => false,
                    Verdict::Skeleton(xs) => {
                        if std::env::var_os("STAFF_DOC_DIFF").is_some() {
                            eprintln!("文档不符：{}", xs.iter().take(5).cloned().collect::<Vec<_>>().join("；"));
                        }
                        true
                    }
                    _ => true,
                };
            doc.source = l.doc.source.clone();
            Some(l)
        }
        None => None,
    };
    let surface = loaded.as_ref().map(|l| &l.surface);
    let song0 = doc.songs.first().ok_or("这份文档里没有曲子")?;
    let song = read::prepare_song(song0);
    let mut dumps = BTreeMap::new();
    let meta = env.meta.ok_or("没有 SMuFL 元数据")?;
    let mut score = read::layout_staff(&song, surface, options, meta, env.mc, &mut |stage: &str, s| {
        dumps.insert(stage.to_string(), dump::staff_dump(s));
    });
    dumps.insert("layout".into(), dump::staff_dump(&score));
    let (roots, placed) = pages::layout_staff_pages(&mut score, mixed, jianpu_part);
    let mut pd = dump::staff_dump(&score);
    pd["placed"] = dump::placed_json(&placed);
    dumps.insert("pages".into(), pd);
    let w = score.defaults.page_width;
    let h = score.defaults.page_height;
    got.pages = Some(
        roots
            .into_iter()
            .map(|mut root| {
                freeze(&mut root, env);
                Page { dialect: Dialect::Mixed, cls: "score-page mixed-page".into(), w, h, root: Some(root) }
            })
            .collect(),
    );
    got.dumps = dumps;
    Ok(got)
}

pub fn staff_check(args: &[String]) -> i32 {
    let pos = positional(args);
    let native = args.iter().any(|a| a == "--native");
    let mpath = flag(args, "measure");
    let (Some(path), true) = (pos.first(), native || mpath.is_some()) else {
        eprintln!("用法：dolce-dev staff-check <cases.jsonl> (--measure=<measure.jsonl> | --native) [--stage=read,systems,layout,pages,scene] [--limit=N] [--key=子串] [--cfg=档名] [--show=N] [--redist=<目录>]");
        return 2;
    };
    let stages: Vec<&str> = flag(args, "stage").map_or(STAGES.to_vec(), |s| s.split(',').collect());
    let limit: usize = flag(args, "limit").and_then(|v| v.parse().ok()).unwrap_or(usize::MAX);
    let key_sub = flag(args, "key");
    let cfg_only = flag(args, "cfg");
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
    let (mut cases, mut todo, mut failed, mut shown, mut doc_mismatch) = (0usize, 0usize, 0usize, 0usize, 0usize);
    let mut by_cfg: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for l in lines(path) {
        if cases >= limit {
            break;
        }
        let case: Value = serde_json::from_str(&l).unwrap_or_else(|e| panic!("{path} 读不进：{e}"));
        let key = case["key"].as_str().unwrap_or("?").to_string();
        let cfg = case["cfg"].as_str().unwrap_or("?").to_string();
        if key_sub.is_some_and(|k| !key.contains(k)) || cfg_only.is_some_and(|c| c != cfg) {
            continue;
        }
        cases += 1;
        let at = format!("{key} [{cfg}]");
        let expect = &case["expect"];
        let got = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&case, &env)));
        let got = match got {
            Ok(Ok(g)) => g,
            Ok(Err(e)) => {
                failed += 1;
                if shown < show {
                    shown += 1;
                    println!("✗ {at}：{e}");
                }
                continue;
            }
            Err(p) => {
                let msg = panic_text(&*p);
                if msg.starts_with("not yet implemented") {
                    todo += 1;
                } else {
                    failed += 1;
                    if shown < show {
                        shown += 1;
                        println!("✗ {at}：panic {msg}");
                    }
                }
                continue;
            }
        };
        if got.doc_mismatch {
            doc_mismatch += 1;
            if shown < show {
                shown += 1;
                println!("✗ {at}：重读原文得到的文档与用例的不符（表层的号可能对不上）");
            }
        }
        let mut ok = true;
        for st in &stages {
            let v = match *st {
                "scene" => judge_pages(&expect["scenes"], got.pages.as_ref()),
                "read" | "systems" | "layout" | "pages" => judge_json(&expect[*st], got.dumps.get(*st)),
                other => {
                    eprintln!("未知的 stage：{other}");
                    return 2;
                }
            };
            let t = tally.get_mut(st).expect("已建");
            match v {
                Verdict::Same(e) => {
                    t.same += 1;
                    if e > t.max {
                        t.max = e;
                        t.max_at = at.clone();
                    }
                }
                Verdict::Num(e, w) => {
                    t.num += 1;
                    ok = false;
                    if e > t.max {
                        t.max = e;
                        t.max_at = format!("{at} {w}");
                    }
                    if shown < show {
                        shown += 1;
                        println!("✗ [{st}] {at}：数超差 {e:e} @ {w}");
                    }
                }
                Verdict::Skeleton(xs) => {
                    t.skeleton += 1;
                    ok = false;
                    if shown < show {
                        shown += 1;
                        println!("✗ [{st}] {at}：骨架 {} 处", xs.len());
                        for x in xs.iter().take(8) {
                            println!("    {x}");
                        }
                    }
                }
                Verdict::Missing => t.missing += 1,
            }
        }
        let e = by_cfg.entry(cfg).or_default();
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
    println!("—— {cases} 档（未实现 {todo}、报错 {failed}、文档不符 {doc_mismatch}）");
    for (c, (n, ok)) in &by_cfg {
        println!("  {c:<10} {n:>5} 档  全一致 {ok}");
    }
    let mut bad = todo + failed + doc_mismatch;
    for (st, t) in &tally {
        bad += t.num + t.skeleton;
        println!(
            "  {st:<7} 一致 {:>5}  骨架差 {:>4}  数超差 {:>4}  未比 {:>4}  最大数差 {:e}{}",
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
