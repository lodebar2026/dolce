//! 成书 PDF（L7 第三步）的命令：
//! - `dolce-dev book-pdf --in=<drawlist.json> --out=<x.pdf> [--style=a.ss,b.ss] [--title=] [--base=<目录>]`：DrawList → PDF。
//!   输入 `{style, pages, title?, outline?: [{title, page}]}`；`style` 是 BookStyle 对象，或只是 id（rebuild 的产物）时
//!   用 `--style=` 指的样式表现算。相对路径的字体文件相对 `--base`（缺省当前目录）。stdout 出一行 JSON 报账。
//! - `dolce-dev book-measure-check <book-measure.jsonl> --style=a.ss,b.ss`：书级量字原生实现 ↔ TS 录制（`textmetrics.mjs`）。
//! - `dolce-dev pdf-compare <a.pdf> <b.pdf> [--scale=1] [--worst=N]`：两份 PDF 逐页栅格比（墨迹像素里灰度差过 96 的占比）与文字层比。

use std::path::{Path, PathBuf};

use dolce_book::draw::DrawPage;
use dolce_book::measure::BookMeasure;
use dolce_book::rebuild::{book_style_files, StyleFile};
use dolce_export::book::{book_pdf, BookFonts};
use dolce_export::fonts::FontBook;
use dolce_export::pdf::DocInfo;
use dolce_omr_source::pdf::PdfDoc;
use serde_json::{json, Value};

use crate::export::{raster_diff, read_back};

fn flag<'a>(args: &'a [String], k: &str) -> Option<&'a str> {
    args.iter().find_map(|a| a.strip_prefix(&format!("--{k}=")))
}

fn positional(args: &[String]) -> Vec<&str> {
    args.iter().filter(|a| !a.starts_with("--")).map(String::as_str).collect()
}

/// `--style=a.ss,b.ss` → BookStyle
fn style_from_files(list: &str) -> Result<Value, String> {
    let files: Vec<StyleFile> = list
        .split(',')
        .map(|n| std::fs::read_to_string(n).map(|text| StyleFile { name: n.to_string(), text }).map_err(|e| format!("读 {n}：{e}")))
        .collect::<Result<_, _>>()?;
    Ok(book_style_files(&files)?.1)
}

pub fn book_pdf_cmd(args: &[String]) -> i32 {
    let (Some(inp), Some(out)) = (flag(args, "in"), flag(args, "out")) else {
        eprintln!("用法：dolce-dev book-pdf --in=<drawlist.json> --out=<x.pdf> [--style=a.ss,b.ss] [--title=] [--base=<目录>]");
        return 2;
    };
    let run = || -> Result<Value, String> {
        let t0 = std::time::Instant::now();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(inp).map_err(|e| format!("读 {inp}：{e}"))?).map_err(|e| format!("{inp}：{e}"))?;
        let style = match flag(args, "style") {
            Some(list) => style_from_files(list)?,
            None if v["style"].is_object() => v["style"].clone(),
            None => return Err("DrawList 里的 style 只是 id，要用 --style= 给样式表".into()),
        };
        let pages: Vec<DrawPage> = serde_json::from_value(v["pages"].clone()).map_err(|e| format!("pages：{e}"))?;
        let base = PathBuf::from(flag(args, "base").unwrap_or("."));
        let book = FontBook::system();
        let fonts = BookFonts::resolve(&style, &book, &base);
        let title = flag(args, "title").map(str::to_string).or_else(|| v["title"].as_str().map(str::to_string));
        let outline = v["outline"]
            .as_array()
            .map(|a| a.iter().filter_map(|o| Some((o["title"].as_str()?.to_string(), o["page"].as_u64()? as usize))).collect())
            .unwrap_or_default();
        let (bytes, r) = book_pdf(&book, &fonts, &pages, &DocInfo { title, outline })?;
        std::fs::write(out, &bytes).map_err(|e| format!("写 {out}：{e}"))?;
        Ok(json!({
            "pages": r.pages,
            "bytes": r.bytes,
            "ms": t0.elapsed().as_millis() as u64,
            "missing": r.missing.iter().map(|(p, role, ch)| json!({"page": p + 1, "role": role, "ch": ch})).collect::<Vec<_>>(),
            "missingFonts": fonts.missing.iter().map(|(id, fam, why)| json!({"id": id, "family": fam, "why": why})).collect::<Vec<_>>(),
            "fonts": fonts.fonts.iter().map(|f| json!({"id": f.id, "file": f.file, "ps": f.face.face.ps_name, "path": f.path_mode})).collect::<Vec<_>>(),
            // 换字体的 from 是主字体 id；换等价字的 from 是原字（同 pdfwrite.mjs 的口径）
            "fallbacks": r.fallbacks.iter().map(|(role, ch, to)| {
                let font_swap = fonts.fonts.iter().any(|f| &f.id == to);
                let from = if font_swap { fonts.main_font_id(role).unwrap_or("").to_string() } else { ch.clone() };
                json!({"role": role, "ch": ch, "from": from, "to": to})
            }).collect::<Vec<_>>(),
            "embedded": r.embedded,
            "outlined": r.outlined,
            "badPaths": r.bad_paths,
            "retries": r.retries,
        }))
    };
    match run() {
        Ok(v) => {
            println!("{v}");
            0
        }
        Err(e) => {
            eprintln!("✗ {e}");
            1
        }
    }
}

pub fn book_measure_check(args: &[String]) -> i32 {
    let (Some(rec), Some(list)) = (positional(args).first().copied(), flag(args, "style")) else {
        eprintln!("用法：dolce-dev book-measure-check <book-measure.jsonl> --style=a.ss,b.ss [--base=<目录>] [--show=N]");
        return 2;
    };
    let style = match style_from_files(list) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("✗ {e}");
            return 1;
        }
    };
    let show: usize = flag(args, "show").and_then(|s| s.parse().ok()).unwrap_or(10);
    let book = FontBook::system();
    let fonts = BookFonts::resolve(&style, &book, Path::new(flag(args, "base").unwrap_or(".")));
    for (id, fam, why) in &fonts.missing {
        println!("⚠ 字体 {id}（{fam}）：{why}");
    }
    let text = std::fs::read_to_string(rec).expect("读录制");
    let (mut n, mut same, mut max, mut shown) = (0usize, 0usize, 0.0f64, 0usize);
    let mut buckets = [0usize; 4];
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let r: Value = serde_json::from_str(line).expect("录制行");
        let role = r["role"].as_str().unwrap_or("");
        let want = r["v"].as_f64().unwrap_or(f64::NAN);
        let (got, what) = if r["op"] == "inkRatio" {
            let s = r["sample"].as_str().unwrap_or("");
            (fonts.ink_ratio(role, s), format!("inkRatio {role} {s:?}"))
        } else {
            let t = r["text"].as_str().unwrap_or("");
            let size = r["size"].as_f64().unwrap_or(0.0);
            (fonts.advance(role, t, size), format!("advance {role} {t:?} {size}"))
        };
        n += 1;
        let d = if want.is_nan() && got.is_nan() { 0.0 } else { (got - want).abs() };
        let d = if d.is_nan() { f64::INFINITY } else { d };
        if d <= 1e-6 {
            same += 1;
        } else {
            buckets[if d <= 0.01 { 0 } else if d <= 0.1 { 1 } else if d <= 0.5 { 2 } else { 3 }] += 1;
            if shown < show {
                shown += 1;
                println!("  ≈ {what}：录 {want} → 量 {got}（差 {d:.4}）");
            }
        }
        if d.is_finite() {
            max = max.max(d);
        }
    }
    println!("书级量字 {n} 次：一致 {same}；差 ≤0.01 {}、≤0.1 {}、≤0.5 {}、>0.5 {}；最大差 {max:.4} pt", buckets[0], buckets[1], buckets[2], buckets[3]);
    i32::from(buckets[3] > 0)
}

pub fn pdf_compare(args: &[String]) -> i32 {
    let pos = positional(args);
    let (Some(a), Some(b)) = (pos.first(), pos.get(1)) else {
        eprintln!("用法：dolce-dev pdf-compare <a.pdf> <b.pdf> [--scale=1] [--worst=N]");
        return 2;
    };
    let scale: f64 = flag(args, "scale").and_then(|s| s.parse().ok()).unwrap_or(1.0);
    let worst_n: usize = flag(args, "worst").and_then(|s| s.parse().ok()).unwrap_or(10);
    let open = |p: &str| std::fs::read(p).map_err(|e| format!("读 {p}：{e}")).and_then(PdfDoc::open);
    let (da, db) = match (open(a), open(b)) {
        (Ok(x), Ok(y)) => (x, y),
        (Err(e), _) | (_, Err(e)) => {
            eprintln!("✗ 打不开：{e}");
            return 1;
        }
    };
    let (na, nb) = (da.page_count(), db.page_count());
    if na != nb {
        println!("页数不同：{na} / {nb}");
    }
    let bins = [0.001, 0.01, 0.03, 0.1, 0.3];
    let mut hist = [0usize; 6];
    let mut worst: Vec<(f64, usize)> = Vec::new();
    let (mut text_same, mut text_diff) = (0usize, Vec::new());
    for i in 0..na.min(nb) {
        let (pa, pb) = match (read_back(&da, i, scale), read_back(&db, i, scale)) {
            (Ok(x), Ok(y)) => (x, y),
            (Err(e), _) | (_, Err(e)) => {
                println!("第 {} 页读不出：{e}", i + 1);
                continue;
            }
        };
        let (ink, diff) = raster_diff(&pa, &pb);
        let r = diff as f64 / ink.max(1) as f64;
        hist[bins.iter().position(|&t| r < t).unwrap_or(5)] += 1;
        worst.push((r, i));
        let norm = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
        let (ta, tb) = (norm(&pa.text), norm(&pb.text));
        if ta == tb {
            text_same += 1;
        } else {
            text_diff.push((i, ta, tb));
        }
    }
    worst.sort_by(|x, y| y.0.total_cmp(&x.0));
    println!("栅格差（墨迹像素里灰度差过 96 的占比）：<0.1% {}、<1% {}、<3% {}、<10% {}、<30% {}、≥30% {}", hist[0], hist[1], hist[2], hist[3], hist[4], hist[5]);
    println!("最差几页：{}", worst.iter().take(worst_n).map(|(r, i)| format!("#{} {:.2}%", i + 1, r * 100.0)).collect::<Vec<_>>().join("  "));
    println!("文字层（去空白）一致 {text_same} 页、不同 {} 页", text_diff.len());
    for (i, ta, tb) in text_diff.iter().take(worst_n) {
        let k = ta.chars().zip(tb.chars()).take_while(|(x, y)| x == y).count();
        let snip = |s: &str| s.chars().skip(k.saturating_sub(8)).take(30).collect::<String>();
        println!("  #{}：{} 字 / {} 字，首个不同处 …{}… | …{}…", i + 1, ta.chars().count(), tb.chars().count(), snip(ta), snip(tb));
    }
    0
}

/// `dolce-dev relayout --in=<input.json> --out=<result.json> [--base=<目录>]`：成书 A 路（原位替换）的版面规格 → DrawList（dev `relayout.mjs --mode=text` 用）。
/// 输入 `{style, fallback: {形状键: 字 | null}, specs: [PageSpec…], lyric2Cut?}`（`style` 是校验过的 BookStyle）；
/// 各角色「墨迹高 ÷ 字号」按样式表指的字体原生量（`BookFonts`，与 `book-pdf` 写出端同一份）。出 `[SpecToDrawResult…]`（逐页同序）。
pub fn relayout_cmd(args: &[String]) -> i32 {
    let (Some(inp), Some(out)) = (flag(args, "in"), flag(args, "out")) else {
        eprintln!("用法：dolce-dev relayout --in=<input.json> --out=<result.json> [--base=<目录>]");
        return 2;
    };
    let run = || -> Result<(), String> {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(inp).map_err(|e| format!("读 {inp}：{e}"))?).map_err(|e| format!("{inp}：{e}"))?;
        let style = v["style"].clone();
        let specs: Vec<dolce_book::spec::PageSpec> = serde_json::from_value(v["specs"].clone()).map_err(|e| format!("specs：{e}"))?;
        let fallback: std::collections::HashMap<String, Option<String>> = serde_json::from_value(v["fallback"].clone()).unwrap_or_default();
        let book = FontBook::system();
        let fonts = BookFonts::resolve(&style, &book, Path::new(flag(args, "base").unwrap_or(".")));
        let ink = |role: &str| fonts.ink_ratio(role, dolce_style::bookstyle::ink_sample_of(role));
        let fb = |key: &str| fallback.get(key).cloned().flatten();
        let opt = dolce_book::relayout::SpecToDrawOptions { ink_ratio: &ink, fallback_char: Some(&fb), lyric2_cut: v["lyric2Cut"].as_f64() };
        let res: Vec<_> = specs.iter().map(|s| dolce_book::relayout::spec_to_draw_page(s, &style, &opt)).collect();
        std::fs::write(out, serde_json::to_string(&res).map_err(|e| e.to_string())?).map_err(|e| format!("写 {out}：{e}"))
    };
    match run() {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("✗ {e}");
            1
        }
    }
}

/// `dolce-dev annotation-blocks --in=<input.json> --out=<result.json> [--base=<目录>]`：成书注解块逐条排（dev `gen-annocheck.mjs` 用）。
/// 输入 `{style, blocks: [AnnotationOptions…]}`（`style` 是校验过的 BookStyle）；书级量字原生（`BookFonts`）。出 `[AnnotationBlock…]`（同序）。
pub fn annotation_blocks_cmd(args: &[String]) -> i32 {
    let (Some(inp), Some(out)) = (flag(args, "in"), flag(args, "out")) else {
        eprintln!("用法：dolce-dev annotation-blocks --in=<input.json> --out=<result.json> [--base=<目录>]");
        return 2;
    };
    let run = || -> Result<(), String> {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(inp).map_err(|e| format!("读 {inp}：{e}"))?).map_err(|e| format!("{inp}：{e}"))?;
        let style = v["style"].clone();
        let blocks: Vec<dolce_book::parts::AnnotationOptions> = serde_json::from_value(v["blocks"].clone()).map_err(|e| format!("blocks：{e}"))?;
        let book = FontBook::system();
        let fonts = BookFonts::resolve(&style, &book, Path::new(flag(args, "base").unwrap_or(".")));
        let res: Vec<_> = blocks.iter().map(|o| dolce_book::parts::annotation_block(&style, o, &fonts)).collect();
        std::fs::write(out, serde_json::to_string(&res).map_err(|e| e.to_string())?).map_err(|e| format!("写 {out}：{e}"))
    };
    match run() {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("✗ {e}");
            1
        }
    }
}
