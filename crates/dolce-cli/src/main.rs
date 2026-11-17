//! `dolce`：模型 / 格式 / 排版的命令行。迁移期给 dev 的对拍脚本（`rs-diff.mjs`）出可比的摘要。
//!
//! 子命令：
//! - `xml-dump`：标准输入每行一个 XML 文件路径，逐份解析，每份出一行 JSON：
//!   `{"file", "ok", "hash"}`（序列化文本 + 各元素原文区间的 SHA-256）或 `{"file", "ok": false, "message", "at"}`。
//! - `scene-svg` / `measure-check` / `diff-scene` / `scene-dump`：排版迁移的对拍（见 `layout.rs`）。
//! - `style-check`：样式层的对拍（见 `style.rs`）。

mod engrave;
mod layout;
mod style;

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
        _ => {
            eprintln!("用法：dolce <xml-dump | scene-svg | measure-check | diff-scene | scene-dump | style-check | engrave-check> …");
            std::process::exit(2);
        }
    }
}

/// 序列化文本、`\0`、按文档序各元素的 `start-end,`（UTF-16）——与 `rs-diff.mjs` 的 TS 侧同口径。
fn xml_digest(d: &dolce_xml::XmlDoc) -> String {
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
        let row = match dolce_xml::parse(&text) {
            Ok(d) => serde_json::json!({ "file": file, "ok": true, "hash": xml_digest(&d) }),
            Err(e) => serde_json::json!({ "file": file, "ok": false, "message": e.message, "at": e.at }),
        };
        writeln!(out, "{row}").expect("写标准输出");
    }
}
