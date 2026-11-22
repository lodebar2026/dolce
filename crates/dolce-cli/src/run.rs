//! `dolce run`：批量识别、出 JSON（私有仓库的自检脚本吃它）。每个文件一首，判路同编辑器（`omr-engine::recognize`：先按五线谱认，一页谱表都没有再走简谱）。
//!
//! 每认完一首往 stdout 写一行 JSON：`{"file", "kind": "staff", "xml"}`（带识别 id 的 MusicXML）、`{"file", "kind": "jianpu", "score"}`（`RecognizedScore`）
//! 或 `{"file", "error"}`；各步进度写 stderr（`{"file", "done", "total", "stage"}` 一行一条，`--progress` 时才写）。
//! 给人用的识别（出各格式、参照歌词）在 [`crate::cli`]。
use crate::recognize::open_ocr;
use dolce_omr_core::progress::{Hook, Step};
use dolce_omr_engine::{Doc, Kind, Opts, Recognition};
use dolce_omr_sheet::jianpu::RecognizedScore;
use serde_json::json;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

pub const USAGE: &str = "  dolce run <文件…|目录…> [--kind=auto|staff|jianpu] [--cache=OCR缓存.json] [--progress]
      批量识别（图片 jpg/png/webp/bmp/tif 与 PDF，一个文件一首；目录取里面这些文件，不递归、按名排序），每首往 stdout 写一行 JSON：
      {file, kind: \"staff\", xml} / {file, kind: \"jianpu\", score} / {file, error}；--progress 时 stderr 逐步写 {file, done, total, stage}
";

/// 能识别的扩展名（小写）。
pub const EXTS: [&str; 8] = ["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff", "pdf"];

/// 展开输入：目录 → 里面能识别的文件（不递归，按名排序）。
pub fn expand(inputs: &[String]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for p in inputs.iter().map(PathBuf::from) {
        if !p.is_dir() {
            out.push(p);
            continue;
        }
        let mut v: Vec<PathBuf> = std::fs::read_dir(&p)
            .map(|d| d.flatten().map(|e| e.path()).filter(|f| f.extension().and_then(|e| e.to_str()).is_some_and(|e| EXTS.contains(&e.to_ascii_lowercase().as_str()))).collect())
            .unwrap_or_default();
        v.sort();
        if v.is_empty() {
            eprintln!("跳过（目录里没有能识别的文件）：{}", p.display());
        }
        out.extend(v);
    }
    out
}

/// 认完一首：五线谱给带识别 id 的 MusicXML，简谱给识别结果。
pub enum Got {
    Staff(String),
    Jianpu(Box<RecognizedScore>),
}

/// 识别一个文件（判路同编辑器）；`progress`：各步进度按 JSON 一行一条写 stderr。
pub fn recognize_file(path: &Path, kind: Kind, ocr: &dolce_omr_ocr::cache::CachedOcr, progress: bool) -> Result<Got, String> {
    let doc = Doc::open(std::fs::read(path).map_err(|e| format!("读不了：{e}"))?)?;
    let file = path.display().to_string();
    let send = |s: Step| {
        if progress {
            eprintln!("{}", json!({ "file": file, "done": s.done, "total": s.total, "stage": s.stage }));
        }
    };
    let title = path.file_stem().map(|s| s.to_string_lossy().into_owned());
    let opts = Opts { kind, pages: Vec::new(), title };
    // 分轮预取：各轮缺的 OCR 一批分给会话池的 3 个会话（冷启动时多开会话的加载开销抵掉并行的收益，3 个最快，同桌面版缺省）
    let threads = std::env::var("DOLCE_OCR_SESS").ok().and_then(|v| v.parse().ok()).filter(|&v: &usize| v > 0).unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()).min(3));
    let rec = ocr.rounds(|| dolce_omr_engine::recognize(&doc, ocr, &opts, &Hook { on: Some(&send), cancel: None }), |o, q| o.fill_local(q, threads))?;
    Ok(match rec {
        Recognition::Staff { session, .. } => Got::Staff(dolce_omr_engine::staff_output(&session).0),
        Recognition::Jianpu { score, .. } => Got::Jianpu(Box::new(score)),
    })
}

fn one(path: &Path, kind: Kind, ocr: &dolce_omr_ocr::cache::CachedOcr, progress: bool) -> Result<serde_json::Value, String> {
    let file = path.display().to_string();
    Ok(match recognize_file(path, kind, ocr, progress)? {
        Got::Staff(xml) => json!({ "file": file, "kind": "staff", "xml": xml }),
        Got::Jianpu(score) => json!({ "file": file, "kind": "jianpu", "score": score }),
    })
}

pub fn run(args: &[String]) -> Result<ExitCode, String> {
    let mut kind = Kind::Auto;
    let mut cache = None;
    let mut progress = false;
    let mut inputs = Vec::new();
    for a in args {
        if let Some(k) = a.strip_prefix("--kind=") {
            kind = serde_json::from_value(json!(k)).map_err(|_| format!("--kind 只有 auto / staff / jianpu：{k}"))?;
        } else if let Some(c) = a.strip_prefix("--cache=") {
            cache = Some(PathBuf::from(c));
        } else if a == "--progress" {
            progress = true;
        } else {
            inputs.push(a.clone());
        }
    }
    let files = expand(&inputs);
    if files.is_empty() {
        return Err("没有可识别的文件".into());
    }
    let ocr = open_ocr(cache.as_deref())?;
    let mut failed = 0;
    let stdout = std::io::stdout();
    for f in &files {
        let line = one(f, kind, &ocr, progress).unwrap_or_else(|e| {
            failed += 1;
            json!({ "file": f.display().to_string(), "error": e })
        });
        let mut o = stdout.lock();
        writeln!(o, "{line}").and_then(|_| o.flush()).map_err(|e| e.to_string())?;
    }
    ocr.cache.save()?;
    Ok(if failed > 0 { ExitCode::from(1) } else { ExitCode::SUCCESS })
}
