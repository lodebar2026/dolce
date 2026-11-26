//! `dolce-dev`：开发用命令行——模型 / 格式 / 排版 / 成书的对拍、回归与探针（不进分发包；给人用的命令行是 `dolce-cli` 的 `dolce`）。
//!
//! 子命令：
//! - `xml-dump`：标准输入每行一个 XML 文件路径，逐份解析，每份出一行 JSON：
//!   `{"file", "ok", "hash"}`（序列化文本 + 各元素原文区间的 SHA-256）或 `{"file", "ok": false, "message", "at"}`。
//! - `scene-svg` / `measure-check` / `diff-scene` / `scene-dump`：排版迁移的对拍（见 `layout.rs`）。
//! - `style-check`：样式层的对拍（见 `style.rs`）。
//! - `engrave-check`：图元层的对拍（见 `engrave.rs`）。
//! - `jianpu-check`：简谱引擎的对拍（见 `jianpu.rs`）。
//! - `staff-check`：五线谱 / 混排引擎的对拍（见 `staff.rs`）。
//! - `book-parts-check`：成书部件的对拍（见 `bookparts.rs`）。
//! - `book-meta-check`：成书书级元数据与书籍样式统计的对拍（见 `bookmeta.rs`）。
//! - `book-rebuild`：成书 B 路整本的对拍（见 `book.rs`）。
//! - `book-draw-check`：成书（`browser.ts` / `songbook.ts`）的对拍（见 `bookdraw.rs`）；`songbook`：混排歌本整本排版（同文件）。
//! - `book-pdf` / `book-measure-check` / `pdf-compare`：成书 DrawList → PDF、书级量字原生 ↔ 录制、两份 PDF 栅格比（见 `bookpdf.rs`）。
//! - `pptx`：场景 → `.pptx`（见 `pptx.rs`）。
//! - `font-probe` / `scene-pdf`：导出的字体样本验证、场景 → PDF 与旧链栅格比对（见 `export.rs`）。
//! - `sing-fit`：按参照歌词切段落、排 `%%sing`（见 `singfit.rs`）。
//! - `onnx-fp16`：OCR 模型权重改存 FP16（见 `onnx.rs`）。

mod book;
mod bookdraw;
mod bookpdf;
mod pptx;
mod bookmeta;
mod bookparts;
mod engrave;
mod export;
mod jianpu;
mod layout;
mod onnx;
mod singfit;
mod staff;
mod style;
mod wire;

use sha2::{Digest, Sha256};
use std::io::{self, BufRead, Write};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("xml-dump") => xml_dump(),
        Some("scene-svg") => std::process::exit(layout::scene_svg(&args[1..])),
        Some("measure-check") => std::process::exit(layout::measure_check(&args[1..])),
        Some("diff-scene") => std::process::exit(layout::diff_scene(&args[1..])),
        Some("scene-dump") => std::process::exit(layout::scene_dump(&args[1..])),
        Some("style-check") => std::process::exit(style::style_check(&args[1..])),
        Some("engrave-check") => std::process::exit(engrave::engrave_check(&args[1..])),
        Some("jianpu-check") => std::process::exit(jianpu::jianpu_check(&args[1..])),
        Some("staff-check") => std::process::exit(staff::staff_check(&args[1..])),
        Some("book-parts-check") => std::process::exit(bookparts::book_parts_check(&args[1..])),
        Some("book-meta-check") => std::process::exit(bookmeta::book_meta_check(&args[1..])),
        Some("book-draw-check") => std::process::exit(bookdraw::book_draw_check(&args[1..])),
        Some("book-pdf") => std::process::exit(bookpdf::book_pdf_cmd(&args[1..])),
        Some("book-measure-check") => std::process::exit(bookpdf::book_measure_check(&args[1..])),
        Some("pdf-compare") => std::process::exit(bookpdf::pdf_compare(&args[1..])),
        Some("pptx") => std::process::exit(pptx::pptx_cmd(&args[1..])),
        Some("book-rebuild") => std::process::exit(book::book_rebuild(&args[1..])),
        Some("font-probe") => std::process::exit(export::font_probe(&args[1..])),
        Some("scene-pdf") => std::process::exit(export::scene_pdf(&args[1..])),
        Some("layout-wire") => std::process::exit(wire::layout_wire(&args[1..])),
        Some("songbook") => std::process::exit(bookdraw::songbook(&args[1..])),
        Some("relayout") => std::process::exit(bookpdf::relayout_cmd(&args[1..])),
        Some("annotation-blocks") => std::process::exit(bookpdf::annotation_blocks_cmd(&args[1..])),
        Some("sing-fit") => std::process::exit(singfit::sing_fit(&args[1..])),
        Some("onnx-fp16") => std::process::exit(onnx::onnx_fp16(&args[1..])),
        _ => {
            eprintln!("用法：dolce-dev <xml-dump | scene-svg | measure-check | diff-scene | scene-dump | style-check | engrave-check | jianpu-check | staff-check | book-parts-check | book-meta-check | book-draw-check | book-rebuild | font-probe | scene-pdf | book-pdf | book-measure-check | pdf-compare | pptx | layout-wire | songbook | relayout | annotation-blocks | onnx-fp16> …");
            std::process::exit(2);
        }
    }
}

/// 序列化文本、`\0`、按文档序各元素的 `start-end,`（UTF-16）——与 `rs-diff.mjs` 的 TS 侧同口径。
fn xml_digest(d: &dolce_model::xml::XmlDoc) -> String {
    let mut h = Sha256::new();
    h.update(d.serialize().as_bytes());
    h.update(b"\0");
    let mut stack = vec![d.root];
    let mut spans = String::new();
    while let Some(id) = stack.pop() {
        spans.push_str(&format!("{}-{},", d.tree.start(id), d.tree.end(id)));
        let kids: Vec<_> = d.tree.children(id).collect();
        stack.extend(kids.into_iter().rev());
    }
    h.update(spans.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn xml_dump() {
    let stdin = io::stdin();
    let mut out = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let file = line.expect("读标准输入");
        if file.is_empty() {
            continue;
        }
        let bytes = std::fs::read(&file).unwrap_or_else(|e| panic!("读 {file}：{e}"));
        let text = String::from_utf8_lossy(&bytes);
        let row = match dolce_model::xml::parse(&text) {
            Ok(d) => serde_json::json!({ "file": file, "ok": true, "hash": xml_digest(&d) }),
            Err(e) => serde_json::json!({ "file": file, "ok": false, "message": e.message, "at": e.at }),
        };
        writeln!(out, "{row}").expect("写标准输出");
    }
}
