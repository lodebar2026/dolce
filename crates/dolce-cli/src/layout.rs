//! 排版迁移的对拍子命令（L0 起）。参照由 dev `layout-ref.mjs` 从 TS 导出（`dev/data/ref-layout/<提交>/`）。
//!
//! - `scene-svg <scene.jsonl> [--show=N]`：读 TS 页面树出 SVG，与 TS 那页的 sha256 比（逐字节相同才算过）；
//!   行里带 `svg`（导出时加 `--svg`）的，不同处给出头一处差异的上下文。
//! - `measure-check <measure.jsonl> [--redist=<目录>] [--show=N] [--webview]`：原生量字（系统文字引擎 + 浏览器口径层）把每条录下的调用再量一遍，
//!   逐键逐位比（等同 TS `nodeMeasure()`；`--webview` 改照本平台桌面版 WebView 的口径）。`--redist` 缺省 `public/redist`（Bravura 字体文件所在）。
//! - `diff-scene <a.jsonl> <b.jsonl> [--show=N]`：两份场景按 (key, cfg, page) 配对，先比骨架、再看数与页面绝对坐标的最大差。
//! - `scene-dump <scene.jsonl> --key=<子串> [--page=N]`：打印一页的规范化记录（查 diff-scene 报的差在哪）。

use std::collections::HashMap;
use std::io::BufRead;

use dolce_scene::dump::{diff_pages, normalize};
use dolce_scene::svg::page_svg;
use dolce_scene::Page;
use dolce_text::{MeasureRecord, TextMeasurer};
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// scene.jsonl 的一行。
#[derive(Deserialize)]
struct SceneLine {
    key: String,
    cfg: String,
    page: usize,
    #[serde(default)]
    sha: Option<String>,
    #[serde(default)]
    svg: Option<String>,
    #[serde(flatten)]
    page_data: Page,
}

pub(crate) fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    let pre = format!("--{name}=");
    args.iter().find_map(|a| a.strip_prefix(&pre))
}

pub(crate) fn show_n(args: &[String]) -> usize {
    flag(args, "show").and_then(|v| v.parse().ok()).unwrap_or(10)
}

pub(crate) fn positional(args: &[String]) -> Vec<&str> {
    args.iter().filter(|a| !a.starts_with("--")).map(String::as_str).collect()
}

pub(crate) fn lines(path: &str) -> impl Iterator<Item = String> {
    let f = std::fs::File::open(path).unwrap_or_else(|e| panic!("读 {path}：{e}"));
    std::io::BufReader::new(f).lines().map(|l| l.expect("读行")).filter(|l| !l.trim().is_empty())
}

fn sha_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// 头一处不同的上下文。
fn first_diff(a: &str, b: &str) -> String {
    let (ab, bb) = (a.as_bytes(), b.as_bytes());
    let i = ab.iter().zip(bb).position(|(x, y)| x != y).unwrap_or(ab.len().min(bb.len()));
    let ctx = |s: &str, i: usize| {
        let mut lo = i.saturating_sub(80).min(s.len());
        while !s.is_char_boundary(lo) {
            lo -= 1;
        }
        let mut hi = (i + 80).min(s.len());
        while !s.is_char_boundary(hi) {
            hi += 1;
        }
        s[lo..hi].to_string()
    };
    format!("@{i}\n    TS:   {}\n    Rust: {}", ctx(a, i), ctx(b, i))
}

pub fn scene_svg(args: &[String]) -> i32 {
    let pos = positional(args);
    let Some(path) = pos.first() else {
        eprintln!("用法：dolce scene-svg <scene.jsonl> [--show=N]");
        return 2;
    };
    let show = show_n(args);
    let (mut total, mut same, mut bad, mut nohash) = (0usize, 0usize, 0usize, 0usize);
    for l in lines(path) {
        let row = parse_scene(path, &l);
        total += 1;
        let svg = page_svg(&row.page_data);
        let Some(want) = &row.sha else {
            nohash += 1;
            continue;
        };
        if &sha_hex(&svg) == want {
            same += 1;
            continue;
        }
        bad += 1;
        if bad <= show {
            println!("✗ {} [{}] 第 {} 页", row.key, row.cfg, row.page + 1);
            if let Some(ts) = &row.svg {
                println!("    {}", first_diff(ts, &svg));
            }
        }
    }
    println!("{total} 页：SVG 逐字节相同 {same}、不同 {bad}{}", if nohash > 0 { format!("、无参照 {nohash}") } else { String::new() });
    i32::from(bad > 0)
}

fn same_num(a: f64, b: f64) -> bool {
    a == b || (a.is_nan() && b.is_nan())
}

pub fn measure_check(args: &[String]) -> i32 {
    let pos = positional(args);
    let Some(path) = pos.first() else {
        eprintln!("用法：dolce measure-check <measure.jsonl> [--redist=<目录>] [--show=N] [--webview]");
        return 2;
    };
    if !dolce_text_native::NativeText::available() {
        eprintln!("本平台没有系统文字引擎");
        return 2;
    }
    let redist = std::path::PathBuf::from(flag(args, "redist").unwrap_or("public/redist"));
    let backend = if args.iter().any(|a| a == "--webview") {
        dolce_text_native::webview_measure(Some(&redist), &[])
    } else {
        dolce_text_native::node_measure(Some(&redist), &[])
    };
    let show = show_n(args);
    let mut by_op: HashMap<&'static str, (usize, usize, f64)> = HashMap::new();
    let mut shown = 0;
    let mut total = 0;
    for l in lines(path) {
        let rec: MeasureRecord = serde_json::from_str(&l).unwrap_or_else(|e| panic!("{path} 读不进：{e}\n{}", &l[..l.len().min(200)]));
        total += 1;
        let op = match &rec {
            MeasureRecord::Glyph { .. } => "glyph",
            MeasureRecord::Positions { .. } => "positions",
            MeasureRecord::FontMetrics { .. } => "fontMetrics",
            MeasureRecord::PathBounds { .. } => "pathBounds",
        };
        let got = rec.remeasure(&backend as &dyn TextMeasurer);
        let (a, b) = (rec.values(), got.values());
        let e = by_op.entry(op).or_default();
        e.0 += 1;
        let same = a.len() == b.len() && a.iter().zip(&b).all(|(x, y)| same_num(*x, *y));
        if same {
            continue;
        }
        e.1 += 1;
        let d = if a.len() == b.len() { a.iter().zip(&b).map(|(x, y)| (x - y).abs()).fold(0.0, f64::max) } else { f64::INFINITY };
        e.2 = e.2.max(d);
        if shown < show {
            shown += 1;
            println!("✗ {}\n    TS:   {:?}\n    Rust: {:?}", rec.key().replace('\x01', "|"), a, b);
        }
    }
    let mut ops: Vec<_> = by_op.into_iter().collect();
    ops.sort_by_key(|(k, _)| *k);
    let bad: usize = ops.iter().map(|(_, v)| v.1).sum();
    for (k, (n, diff, max)) in &ops {
        println!("  {k}: {n} 条，不同 {diff}{}", if *diff > 0 { format!("（最大差 {max}）") } else { String::new() });
    }
    println!("{total} 条量字：逐键相同 {}、不同 {bad}", total - bad);
    i32::from(bad > 0)
}

fn parse_scene(path: &str, l: &str) -> SceneLine {
    serde_json::from_str(l).unwrap_or_else(|e| panic!("{path} 读不进：{e}\n{}", &l[..l.len().min(200)]))
}

pub fn diff_scene(args: &[String]) -> i32 {
    let pos = positional(args);
    let (Some(a), Some(b)) = (pos.first(), pos.get(1)) else {
        eprintln!("用法：dolce diff-scene <a.jsonl> <b.jsonl> [--show=N]");
        return 2;
    };
    let show = show_n(args);
    // b 整份进表，a 逐行读（全量场景上 GB，不两份都攒在内存里）
    let mut right: HashMap<(String, String, usize), SceneLine> =
        lines(b).map(|l| parse_scene(b, &l)).map(|r| ((r.key.clone(), r.cfg.clone(), r.page), r)).collect();
    let (mut paired, mut skel, mut only_a) = (0usize, 0usize, 0usize);
    let (mut max_num, mut max_abs) = (0.0f64, 0.0f64);
    let mut worst: Vec<(f64, String)> = Vec::new();
    let mut shown = 0;
    for l in lines(a).map(|l| parse_scene(a, &l)) {
        let Some(r) = right.remove(&(l.key.clone(), l.cfg.clone(), l.page)) else {
            only_a += 1;
            continue;
        };
        paired += 1;
        let d = diff_pages(&l.page_data, &r.page_data);
        let at = format!("{} [{}] 第 {} 页", l.key, l.cfg, l.page + 1);
        if let Some((i, x, y)) = d.skeleton {
            skel += 1;
            if shown < show {
                shown += 1;
                println!("✗ 骨架 {at} 节点 {i}\n    a: {x}\n    b: {y}");
            }
            continue;
        }
        max_num = max_num.max(d.max_num);
        max_abs = max_abs.max(d.max_abs);
        if d.max_abs > 0.0 || d.max_num > 0.0 {
            worst.push((d.max_abs.max(d.max_num), format!("{at}（数 {} @节点 {}、页面坐标 {} @节点 {}）", d.max_num, d.max_num_at, d.max_abs, d.max_abs_at)));
        }
    }
    worst.sort_by(|x, y| y.0.total_cmp(&x.0));
    for (_, w) in worst.iter().take(show) {
        println!("  {w}");
    }
    println!(
        "配对 {paired} 页（只在 a {only_a}、只在 b {}）：骨架不同 {skel}；骨架一致的页里数最大差 {max_num}、页面绝对坐标最大差 {max_abs}",
        right.len()
    );
    i32::from(skel > 0 || only_a > 0 || !right.is_empty())
}

pub fn scene_dump(args: &[String]) -> i32 {
    let pos = positional(args);
    let (Some(path), Some(key)) = (pos.first(), flag(args, "key")) else {
        eprintln!("用法：dolce scene-dump <scene.jsonl> --key=<子串> [--page=N]");
        return 2;
    };
    let page: usize = flag(args, "page").and_then(|v| v.parse().ok()).unwrap_or(1);
    for l in lines(path) {
        let row = parse_scene(path, &l);
        if !row.key.contains(key) || row.page + 1 != page {
            continue;
        }
        println!("# {} [{}] 第 {} 页", row.key, row.cfg, row.page + 1);
        for (i, r) in normalize(&row.page_data).iter().enumerate() {
            println!("{i}\t{}\t{:?}\t{:?}", r.skeleton, r.nums, r.abs);
        }
    }
    0
}
