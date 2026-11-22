//! `dolce-dev book-rebuild <目录>`：成书 B 路整本迁 Rust（L6）的对拍。目录由 dev `rebuild.mjs --rs-input=<目录>` 写：
//! `input.json`（样式表原文、曲目与 musicxml、书级元数据行）、`measure.jsonl`（排版引擎量字录制）、`book-measure.jsonl`（书级量字录制）、
//! `expect-rebuild-drawlist.json` / `expect-rebuild-lines.json`（TS 产物）。
//!
//! 逐页比 drawlist（`pages[i]`）、逐首比 `songs`（两份），判法同 `jianpu-check`：骨架（键、串、数组长）要一样、数差 ≤ 1e-6；
//! `--native` 时排版引擎改 Rust 自量，数差放到 0.5；`--book-native` 时书级量字也改原生（`dolce_export::book::BookFonts`）。
//! 选项：`--show=N`（列几条差异）、`--out=<目录>`（把 Rust 产物写出来）、`--redist=<目录>`、
//! `--fonts=<族名→文件.json>`（`--native` 时排版量字先注册这些字体文件，同 PDF 嵌入的那份）。
//!
//! **出书**（dev `rebuild.mjs`）：目录里只有 `input.json`、带 `--native --book-native --out=` 跑——没有期望文件就不比，只写产物。

use crate::jianpu::{judge_json, Verdict, TOL};
use crate::layout::{flag, positional, show_n};
use dolce_book::measure::ReplayBookMeasure;
use dolce_book::rebuild::{rebuild, RebuildInput};
use dolce_engrave::Env;
use dolce_scene::smufl::MetaData;
use dolce_text::{MeasureCtx, ReplayMeasurer};
use serde_json::Value;
use std::path::Path;

fn read(dir: &Path, name: &str) -> String {
    std::fs::read_to_string(dir.join(name)).unwrap_or_else(|e| panic!("读 {}：{e}", dir.join(name).display()))
}

/// 比一组同长的条目（页 / 曲），返回（一致、数超差、骨架不同）并打印前 `show` 条
fn judge_list(what: &str, want: &[Value], got: &[Value], label: impl Fn(usize, &Value) -> String, show: usize) -> (usize, usize, usize, f64) {
    let (mut same, mut num, mut skel, mut max, mut shown) = (0, 0, 0, 0.0f64, 0);
    if want.len() != got.len() {
        println!("  {what}：条数 {} → {}", want.len(), got.len());
    }
    for (i, w) in want.iter().enumerate() {
        match judge_json(w, got.get(i)) {
            Verdict::Same(m) => {
                same += 1;
                max = max.max(m);
            }
            Verdict::Num(m, at) => {
                num += 1;
                max = max.max(m);
                if shown < show {
                    shown += 1;
                    println!("  ≈ {what} {}：{at}", label(i, w));
                }
            }
            Verdict::Skeleton(d) => {
                skel += 1;
                if shown < show {
                    shown += 1;
                    println!("  ✗ {what} {}：", label(i, w));
                    for l in d.iter().take(6) {
                        println!("      {l}");
                    }
                    if d.len() > 6 {
                        println!("      …共 {} 处", d.len());
                    }
                }
            }
            Verdict::Missing => skel += 1,
        }
    }
    println!("{what}：{} 条，一致 {same}、数超差 {num}、骨架不同 {skel}；最大数差 {max:e}", want.len());
    (same, num, skel, max)
}

pub fn book_rebuild(args: &[String]) -> i32 {
    let pos = positional(args);
    let Some(dir) = pos.first().map(Path::new) else {
        eprintln!("用法：dolce-dev book-rebuild <目录> [--native] [--book-native] [--show=N] [--out=<目录>] [--redist=<目录>] [--fonts=<族名→文件.json>]");
        return 2;
    };
    let native = args.iter().any(|a| a == "--native");
    let show = show_n(args);
    let redist = std::path::PathBuf::from(flag(args, "redist").unwrap_or("public/redist"));
    let meta = MetaData::from_json(&std::fs::read_to_string(redist.join("bravura_metadata.json")).expect("读 SMuFL 元数据")).expect("SMuFL 元数据");
    let replay = (!native).then(|| ReplayMeasurer::from_jsonl(&read(dir, "measure.jsonl")).expect("量字录制").with_path_fallback());
    let files: Vec<(String, String)> = match flag(args, "fonts") {
        Some(f) => {
            let v: std::collections::BTreeMap<String, String> = serde_json::from_str(&std::fs::read_to_string(f).expect("读字体表")).expect("字体表要是 {族名: 路径}");
            v.into_iter().collect()
        }
        None => vec![],
    };
    let native_backend = native.then(|| dolce_text::native::node_measure(Some(&redist), &files));
    if native {
        TOL.get_or_init(|| 0.5);
    }
    let mc = match (&replay, &native_backend) {
        (Some(r), _) => MeasureCtx::new(r),
        (_, Some(n)) => MeasureCtx::new(n),
        _ => unreachable!(),
    };
    let env = Env { mc: &mc, meta: Some(&meta) };
    let input: RebuildInput = serde_json::from_str(&read(dir, "input.json")).expect("input.json");
    let book_native = args.iter().any(|a| a == "--book-native");
    let replay_bm = if book_native { ReplayBookMeasure::from_jsonl("").expect("空录制") } else { ReplayBookMeasure::from_jsonl(&read(dir, "book-measure.jsonl")).expect("书级量字录制") };
    // `--book-native`：书级量字也走原生（读样式表指的字体文件、整形 + 挤压，与 PDF 写出端同一份）
    let font_book = dolce_export::fonts::FontBook::system();
    let native_bm = book_native.then(|| {
        let (_, st) = dolce_book::rebuild::book_style_files(&input.style_files).expect("成书样式");
        let f = dolce_export::book::BookFonts::resolve(&st, &font_book, Path::new("."));
        for (id, fam, why) in &f.missing {
            println!("⚠ 字体 {id}（{fam}）：{why}");
        }
        f
    });
    let bm: &dyn dolce_book::measure::BookMeasure = match &native_bm {
        Some(f) => f,
        None => &replay_bm,
    };
    std::panic::set_hook(Box::new(|_| {}));
    let t0 = std::time::Instant::now();
    let out = match rebuild(&input, &env, bm) {
        Ok(o) => o,
        Err(e) => {
            println!("✗ 排不出：{e}");
            return 1;
        }
    };
    println!("排完 {:.1} s", t0.elapsed().as_secs_f64());
    for l in &out.log {
        println!("{l}");
    }
    if native_bm.is_none() && replay_bm.miss_count() > 0 {
        println!("⚠ 书级量字没录到 {} 次：", replay_bm.miss_count());
        for m in replay_bm.misses.borrow().iter().take(show.max(5)) {
            println!("    {m}");
        }
    }
    if let Some(o) = flag(args, "out") {
        let o = Path::new(o);
        std::fs::create_dir_all(o).expect("建输出目录");
        std::fs::write(o.join("rebuild-drawlist.json"), serde_json::to_string(&out.drawlist).unwrap()).expect("写 drawlist");
        std::fs::write(o.join("rebuild-lines.json"), serde_json::to_string(&out.lines).unwrap()).expect("写 lines");
    }
    if !dir.join("expect-rebuild-drawlist.json").exists() {
        // 出书：没有期望就不比
        return 0;
    }
    let want_d: Value = serde_json::from_str(&read(dir, "expect-rebuild-drawlist.json")).expect("期望 drawlist");
    let want_l: Value = serde_json::from_str(&read(dir, "expect-rebuild-lines.json")).expect("期望 lines");
    let arr = |v: &Value, k: &str| v[k].as_array().cloned().unwrap_or_default();
    let mut bad = 0;
    if want_d["style"] != out.drawlist["style"] {
        println!("✗ style：{} → {}", want_d["style"], out.drawlist["style"]);
        bad += 1;
    }
    let song_label = |_: usize, v: &Value| format!("{} {}", v["id"].as_str().unwrap_or("?"), v["title"].as_str().unwrap_or(""));
    let page_label = |i: usize, v: &Value| format!("#{} (页码 {})", i + 1, v["label"].as_str().unwrap_or("?"));
    for (what, w, g, by_song) in [
        ("drawlist.songs", arr(&want_d, "songs"), arr(&out.drawlist, "songs"), true),
        ("lines.songs", arr(&want_l, "songs"), arr(&out.lines, "songs"), true),
        ("drawlist.pages", arr(&want_d, "pages"), arr(&out.drawlist, "pages"), false),
    ] {
        let (_, num, skel, _) = if by_song { judge_list(what, &w, &g, song_label, show) } else { judge_list(what, &w, &g, page_label, show) };
        bad += num + skel + usize::from(w.len() != g.len());
    }
    if bad == 0 {
        println!("✓ 全一致");
        0
    } else {
        1
    }
}
