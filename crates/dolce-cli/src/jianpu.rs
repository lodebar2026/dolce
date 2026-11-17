//! `dolce jianpu-check <cases.jsonl> --measure=<measure.jsonl>`：简谱引擎迁 Rust（L3 place / L4 compose）的对拍。
//! 用例由 dev `jianpu-rs-diff.mjs` 让 TS 整份排出（文档 + 外部配置 + 期望）；这里在量字回放下用 `dolce-layout-jianpu` 重排，逐档比四段：
//!
//! - `grid`：定稿栅格（`JianpuGrid::to_json`，TS `plainOf(metrics)`）；
//! - `placed`：规范化定位结构（`placedjson::placed_json`，TS `layoutref.ts::placedJson`）；
//! - `scene`：各页场景（`dolce_scene::dump::diff_pages`，同 `diff-scene`）；
//! - `size`：页宽高、各行首音 id（`lineStarts`）与量宽档的自然跨度（`spans`：版心宽 + 按插入序的 `[id, {x0, x1, x1b}]`）。
//!
//! JSON 两段的比法：键、串、布尔、数组长要一样（缺键与 `null` 视同），数差 ≤ 1e-6（回放下两边吃同一份量字）。
//! `--native` 代替 `--measure`：验收门，Rust 自己量字（`dolce_text_native::node_measure`），数差容差放到 0.5。
//! 每档 `catch_unwind` 包住：`todo!()` 记「未实现」、别的 panic 记「报错」，不中断。
//!
//! 选项：`--stage=grid|placed|scene|size`（逗号分隔，缺省全比）、`--limit=N`、`--key=子串`、`--cfg=档名`、`--show=N`、`--redist=<目录>`。

use crate::layout::{flag, lines, positional, show_n};
use dolce_engrave::Env;
use dolce_layout_jianpu::grid::GridPage;
use dolce_model::doc::ScoreDoc;
use dolce_scene::dump::diff_pages;
use dolce_scene::Page;
use dolce_smufl::MetaData;
use dolce_style::jianpustyle::JianpuStyle;
use dolce_text::{MeasureCtx, ReplayMeasurer};
use serde_json::Value;
use std::collections::BTreeMap;

/// 数差容差：回放下 1e-6（开发门）；`--native` 自量时 0.5（验收门）
pub(crate) static TOL: std::sync::OnceLock<f64> = std::sync::OnceLock::new();

fn tol() -> f64 {
    *TOL.get().unwrap_or(&1e-6)
}
const STAGES: [&str; 4] = ["grid", "placed", "scene", "size"];

// ── 读用例 ──

fn num(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) if s == "Inf" => f64::INFINITY,
        Value::String(s) if s == "-Inf" => f64::NEG_INFINITY,
        _ => f64::NAN,
    }
}

/// 用例里的外部配置（TS `jianpuCfgOf` 那份）
pub struct CaseConfig {
    pub style: JianpuStyle,
    pub page: GridPage,
    pub user_margins: bool,
    pub foot: Option<dolce_style::ss::Region>,
    pub no_reflow: bool,
    pub expanded: bool,
    pub break_desc: Option<String>,
    pub book: bool,
    pub measure: bool,
    pub snippet: bool,
    pub ink: Option<f64>,
}

fn config_of(c: &Value) -> Result<CaseConfig, String> {
    let b = |k: &str| c[k].as_bool().unwrap_or(false);
    Ok(CaseConfig {
        style: serde_json::from_value(c["style"].clone()).map_err(|e| format!("尺子读不进：{e}"))?,
        page: GridPage { width: num(&c["page"]["width"]), height: num(&c["page"]["height"]), continuous: c["page"]["continuous"].as_bool().unwrap_or(false) },
        user_margins: b("userMargins"),
        foot: match &c["foot"] {
            Value::Null => None,
            v => Some(serde_json::from_value(v.clone()).map_err(|e| format!("页脚模板读不进：{e}"))?),
        },
        no_reflow: b("noReflow"),
        expanded: b("expanded"),
        break_desc: c["breakDesc"].as_str().map(str::to_string),
        book: b("book"),
        measure: b("measure"),
        snippet: b("snippet"),
        ink: c.get("ink").filter(|v| !v.is_null()).map(num),
    })
}

// ── 排 ──

/// Rust 排出来的、要比的几段（没排到的那段为 None）
#[derive(Default)]
struct Got {
    grid: Option<Value>,
    placed: Option<Value>,
    pages: Option<Vec<Page>>,
    size: Option<Value>,
}

/// 整份走简谱引擎（`compose::layout_jianpu`，L4 的驱动）
fn run(doc: &ScoreDoc, c: CaseConfig, env: &Env) -> Got {
    use dolce_layout_jianpu::compose::{layout_jianpu, JianpuConfig};
    use dolce_layout_jianpu::placedjson::placed_json;
    use dolce_scene::build::freeze;
    use dolce_scene::Dialect;
    let cfg = JianpuConfig {
        style: c.style,
        page: c.page,
        user_margins: c.user_margins,
        foot: c.foot,
        no_reflow: c.no_reflow,
        expanded: c.expanded,
        break_desc: c.break_desc,
        book: c.book,
        measure: c.measure,
        snippet: c.snippet,
        ink: c.ink,
    };
    let r = layout_jianpu(doc, &cfg, env);
    let pages = r
        .pages
        .into_iter()
        .map(|mut root| {
            freeze(&mut root, env);
            Page { dialect: Dialect::Jianpu, cls: "score-page".into(), w: r.width, h: r.height, root: Some(root) }
        })
        .collect();
    Got {
        grid: Some(r.metrics.to_json()),
        placed: Some(placed_json(&r.placed)),
        pages: Some(pages),
        size: Some(serde_json::json!({
            "width": r.width,
            "height": r.height,
            "lineStarts": r.line_starts,
            // 量宽：按插入序的 [id, {x0, x1, x1b}]（x1b 缺省写 null，比时与缺键视同）
            "spans": r.spans.as_ref().map(|(w, xs)| serde_json::json!({
                "width": w,
                "spans": xs.iter().map(|(id, s)| serde_json::json!([id, { "x0": s.x0, "x1": s.x1, "x1b": s.x1b }])).collect::<Vec<_>>(),
            })),
        })),
    }
}


// ── 比 ──

#[derive(Default)]
struct Diff {
    skeleton: Vec<String>,
    max_num: f64,
    max_at: String,
    num_over: usize,
}

fn numish(v: &Value) -> bool {
    matches!(v, Value::Number(_)) || matches!(v, Value::String(s) if matches!(s.as_str(), "NaN" | "Inf" | "-Inf"))
}

fn short(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "(无)".into(),
        Some(v) => {
            let t = v.to_string();
            if t.chars().count() > 160 {
                format!("{}…", t.chars().take(160).collect::<String>())
            } else {
                t
            }
        }
    }
}

fn diff(path: &str, a: &Value, b: &Value, d: &mut Diff) {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for k in x.keys().chain(y.keys().filter(|k| !x.contains_key(*k))) {
                let (va, vb) = (x.get(k).unwrap_or(&Value::Null), y.get(k).unwrap_or(&Value::Null));
                diff(&format!("{path}.{k}"), va, vb, d);
            }
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            for (i, (p, q)) in x.iter().zip(y).enumerate() {
                diff(&format!("{path}[{i}]"), p, q, d);
            }
        }
        (Value::Array(x), Value::Array(y)) => d.skeleton.push(format!("{path}：长 {} → {}", x.len(), y.len())),
        _ if numish(a) && numish(b) => {
            let (p, q) = (num(a), num(b));
            if p.is_finite() && q.is_finite() {
                let e = (p - q).abs();
                if e > d.max_num {
                    d.max_num = e;
                    d.max_at = format!("{path}：{p} → {q}");
                }
                if e > tol() {
                    d.num_over += 1;
                }
            } else if !(p.is_nan() && q.is_nan()) && p != q {
                d.skeleton.push(format!("{path}：{p} → {q}"));
            }
        }
        _ => {
            if a != b {
                d.skeleton.push(format!("{path}：{} → {}", short(Some(a)), short(Some(b))));
            }
        }
    }
}

/// 一段的比对结果
pub(crate) enum Verdict {
    Same(f64),
    /// 数超差（骨架一致）：最大差与出处
    Num(f64, String),
    Skeleton(Vec<String>),
    Missing,
}

pub(crate) fn judge_json(want: &Value, got: Option<&Value>) -> Verdict {
    let Some(got) = got else { return Verdict::Missing };
    let mut d = Diff::default();
    diff("", want, got, &mut d);
    if !d.skeleton.is_empty() {
        Verdict::Skeleton(d.skeleton)
    } else if d.num_over > 0 {
        Verdict::Num(d.max_num, d.max_at)
    } else {
        Verdict::Same(d.max_num)
    }
}

pub(crate) fn judge_pages(want: &Value, got: Option<&Vec<Page>>) -> Verdict {
    let Some(got) = got else { return Verdict::Missing };
    let want: Vec<Page> = match serde_json::from_value(want.clone()) {
        Ok(p) => p,
        Err(e) => return Verdict::Skeleton(vec![format!("期望页读不进：{e}")]),
    };
    if want.len() != got.len() {
        return Verdict::Skeleton(vec![format!("页数 {} → {}", want.len(), got.len())]);
    }
    let (mut max, mut at) = (0.0f64, String::new());
    for (i, (a, b)) in want.iter().zip(got).enumerate() {
        let d = diff_pages(a, b);
        if let Some((k, x, y)) = d.skeleton {
            return Verdict::Skeleton(vec![format!("第 {} 页节点 {k}\n      TS:   {x}\n      Rust: {y}", i + 1)]);
        }
        for (e, k, what) in [(d.max_num, d.max_num_at, "数"), (d.max_abs, d.max_abs_at, "页面坐标")] {
            if e > max {
                max = e;
                at = format!("第 {} 页节点 {k}（{what}）", i + 1);
            }
        }
    }
    if max > tol() {
        Verdict::Num(max, at)
    } else {
        Verdict::Same(max)
    }
}

#[derive(Default)]
pub(crate) struct Tally {
    pub(crate) same: usize,
    pub(crate) num: usize,
    pub(crate) skeleton: usize,
    pub(crate) missing: usize,
    pub(crate) max: f64,
    pub(crate) max_at: String,
}

pub(crate) fn panic_text(p: &(dyn std::any::Any + Send)) -> String {
    p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()
}

pub fn jianpu_check(args: &[String]) -> i32 {
    let pos = positional(args);
    let native = args.iter().any(|a| a == "--native");
    let mpath = flag(args, "measure");
    let (Some(path), true) = (pos.first(), native || mpath.is_some()) else {
        eprintln!("用法：dolce jianpu-check <cases.jsonl> (--measure=<measure.jsonl> | --native) [--stage=grid,placed,scene,size] [--limit=N] [--key=子串] [--cfg=档名] [--show=N] [--redist=<目录>]");
        return 2;
    };
    let stages: Vec<&str> = flag(args, "stage").map_or(STAGES.to_vec(), |s| s.split(',').collect());
    let limit: usize = flag(args, "limit").and_then(|v| v.parse().ok()).unwrap_or(usize::MAX);
    let key_sub = flag(args, "key");
    let cfg_only = flag(args, "cfg");
    let show = show_n(args);
    let redist = std::path::PathBuf::from(flag(args, "redist").unwrap_or("public/redist"));
    let meta = MetaData::from_json(&std::fs::read_to_string(redist.join("bravura_metadata.json")).expect("读 SMuFL 元数据")).expect("SMuFL 元数据");
    // `--native`：验收门——Rust 自己量字（系统文字引擎 + 浏览器口径层），对 TS 输出骨架一致、数差 ≤ 0.5
    let replay: Option<ReplayMeasurer> = (!native).then(|| {
        ReplayMeasurer::from_jsonl(&std::fs::read_to_string(mpath.unwrap()).expect("读量字录制")).expect("量字录制").with_path_fallback()
    });
    let native_backend = native.then(|| dolce_text_native::node_measure(Some(&redist), &[]));
    if native {
        TOL.get_or_init(|| 0.5);
    }
    let mc = match (&replay, &native_backend) {
        (Some(r), _) => MeasureCtx::new(r),
        (_, Some(n)) => MeasureCtx::new(n),
        _ => unreachable!(),
    };
    let env = Env { mc: &mc, meta: Some(&meta) };
    // todo!() 与别的 panic 照样接住记账，不往终端刷栈
    std::panic::set_hook(Box::new(|_| {}));

    let mut tally: BTreeMap<&str, Tally> = stages.iter().map(|s| (*s, Tally::default())).collect();
    let (mut cases, mut todo, mut failed, mut shown) = (0usize, 0usize, 0usize, 0usize);
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
        let got = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<Got, String> {
            let doc: ScoreDoc = serde_json::from_value(case["doc"].clone()).map_err(|e| format!("文档读不进：{e}"))?;
            let c = config_of(&case["config"])?;
            Ok(run(&doc, c, &env))
        }));
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
        let mut ok = true;
        for st in &stages {
            let v = match *st {
                "grid" => judge_json(&expect["grid"], got.grid.as_ref()),
                "placed" => judge_json(&expect["placed"], got.placed.as_ref()),
                "scene" => judge_pages(&expect["pages"], got.pages.as_ref()),
                "size" => {
                    let want = serde_json::json!({ "width": expect["width"], "height": expect["height"], "lineStarts": expect["lineStarts"], "spans": expect["spans"] });
                    judge_json(&want, got.size.as_ref())
                }
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
    println!("—— {cases} 档（未实现 {todo}、报错 {failed}）");
    for (c, (n, ok)) in &by_cfg {
        println!("  {c:<10} {n:>5} 档  全一致 {ok}");
    }
    let mut bad = todo + failed;
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
