//! `dolce-dev layout-wire <wires.jsonl> --out=<pages.jsonl> [--redist=<目录>] [--webview]`：按编辑器录下的排版请求原生重排（系统量字），出各页 SVG。
//! 宿主对账（dev `layout-node-parity.mjs`）用：浏览器 / 桌面 WebView 里排的一份对它比。
//!
//! 入行（编辑器 `rustlayout.ts::wireDump` 的形状）：`{key, cfg, kind: "jianpu"|"staff", doc: "<ScoreDoc JSON>", req: "<请求 JSON>", surface: "<表层快照 hex>"|null}`；
//! 出行：`{key, cfg, svgs: [...], missing: [...]}`，排不出为 `{key, cfg, error}`。`missing` 是页上 `font-family` 里一个都找不到的族串
//! （浏览器量宽与量墨迹会落到不同的回退字体，这类差已知不追，对账脚本单独归类）。量字是系统文字引擎 + 浏览器口径层（字体取 `--redist`，缺省 `public/redist`）：
//! 缺省 Chromium 口径（`node_measure`，对网页），`--webview` 照本平台桌面版的 WebView（`webview_measure`，对桌面版）。

use crate::layout::{flag, lines, positional};
use dolce_engrave::Env;
use dolce_model::doc::ScoreDoc;
use dolce_model::xmlsurface::Surface;
use dolce_layout::layout::{layout_jianpu_doc, layout_staff_doc, Laid};
use dolce_engrave::scene::smufl::MetaData;
use dolce_engrave::text::{MeasureCtx, SystemText};
use serde::Deserialize;
use serde_json::json;
use std::io::Write;

#[derive(Deserialize)]
struct Wire {
    key: String,
    cfg: String,
    kind: String,
    doc: String,
    req: String,
    #[serde(default)]
    surface: Option<String>,
}

fn unhex(s: &str) -> Result<Vec<u8>, String> {
    if !s.len().is_multiple_of(2) {
        return Err("表层 hex 长度不是偶数".into());
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| format!("表层 hex：{e}"))).collect()
}

/// 页上 `font-family="…"` 里各族都不在系统（也不是泛称）的那些族串。
fn missing_families(svgs: &[String]) -> Vec<String> {
    let sys = dolce_engrave::text::native::NativeText;
    let mut out: Vec<String> = Vec::new();
    for svg in svgs {
        for part in svg.split("font-family=\"").skip(1) {
            let Some(fam) = part.split('"').next() else { continue };
            if out.iter().any(|f| f == fam) {
                continue;
            }
            let none = fam.split(',').map(str::trim).all(|f| !matches!(f, "sans-serif" | "serif" | "monospace") && !sys.has_family(f.trim_matches('\'')));
            if none {
                out.push(fam.to_string());
            }
        }
    }
    out
}

fn lay(w: &Wire, env: &Env) -> Result<Laid, String> {
    let doc: ScoreDoc = serde_json::from_str(&w.doc).map_err(|e| format!("ScoreDoc：{e}"))?;
    match w.kind.as_str() {
        "jianpu" => layout_jianpu_doc(&doc, &serde_json::from_str(&w.req).map_err(|e| format!("JianpuRequest：{e}"))?, env),
        "staff" => {
            let surface: Option<Surface> = match &w.surface {
                Some(h) => Some(bincode::deserialize(&unhex(h)?).map_err(|e| format!("表层快照：{e}"))?),
                None => None,
            };
            layout_staff_doc(&doc, surface.as_ref(), &serde_json::from_str(&w.req).map_err(|e| format!("StaffRequest：{e}"))?, env)
        }
        k => Err(format!("不认得的排版路 {k}")),
    }
}

pub fn layout_wire(args: &[String]) -> i32 {
    let pos = positional(args);
    let (Some(src), Some(out)) = (pos.first(), flag(args, "out")) else {
        eprintln!("用法：dolce-dev layout-wire <wires.jsonl> --out=<pages.jsonl> [--redist=<目录>] [--webview]");
        return 2;
    };
    let redist = std::path::PathBuf::from(flag(args, "redist").unwrap_or("public/redist"));
    let backend = if args.iter().any(|a| a == "--webview") {
        dolce_engrave::text::native::webview_measure(Some(&redist), &[])
    } else {
        dolce_engrave::text::native::node_measure(Some(&redist), &[])
    };
    let mc = MeasureCtx::new(&backend);
    let meta = MetaData::from_json(&std::fs::read_to_string(redist.join("bravura_metadata.json")).expect("读 SMuFL 元数据")).expect("SMuFL 元数据");
    let env = Env { mc: &mc, meta: Some(&meta) };
    let mut f = std::io::BufWriter::new(std::fs::File::create(out).expect("写出文件"));
    let (mut n, mut bad) = (0, 0);
    for line in lines(src) {
        let w: Wire = match serde_json::from_str(&line) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("读不懂的一行：{e}");
                bad += 1;
                continue;
            }
        };
        n += 1;
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| lay(&w, &env))).unwrap_or_else(|p| Err(crate::jianpu::panic_text(&p)));
        let row = match r {
            Ok(laid) => {
                let svgs: Vec<String> = (0..laid.pages.len()).map(|i| laid.svg(i).unwrap_or_default()).collect();
                json!({ "key": w.key, "cfg": w.cfg, "missing": missing_families(&svgs), "svgs": svgs })
            }
            Err(e) => {
                bad += 1;
                json!({ "key": w.key, "cfg": w.cfg, "error": e })
            }
        };
        writeln!(f, "{row}").expect("写出");
    }
    eprintln!("{n} 份，排不出 {bad} 份");
    0
}
