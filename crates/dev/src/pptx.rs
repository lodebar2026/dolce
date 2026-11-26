//! `dolce-dev pptx --in=<料.json> --out=<x.pptx> [--bravura=public/redist/Bravura.otf]`：场景 → `.pptx`（`dolce_layout::export::pptx`）。
//! 料是 `PptxInput`（`{pages: [场景页], stackGap, pageWidth, pageHeight, bg, metrics}`，TS `editor/pptxexport.ts::pptxInput` 拼）。

use std::sync::Arc;

use dolce_layout::export::fonts::Face;
use dolce_layout::export::pptx::{pptx, PptxInput};

fn flag<'a>(args: &'a [String], k: &str) -> Option<&'a str> {
    args.iter().find_map(|a| a.strip_prefix(&format!("--{k}=")))
}

pub fn pptx_cmd(args: &[String]) -> i32 {
    let (Some(inp), Some(out)) = (flag(args, "in"), flag(args, "out")) else {
        eprintln!("用法：dolce-dev pptx --in=<料.json> --out=<x.pptx> [--bravura=<Bravura.otf>]");
        return 2;
    };
    let run = || -> Result<usize, String> {
        let input: PptxInput = serde_json::from_str(&std::fs::read_to_string(inp).map_err(|e| format!("读 {inp}：{e}"))?).map_err(|e| format!("{inp}：{e}"))?;
        let bp = flag(args, "bravura").unwrap_or("public/redist/Bravura.otf");
        let data = std::fs::read(bp).map_err(|e| format!("读 {bp}：{e}"))?;
        let bravura = Face::parse(Arc::new(data), 0, bp.to_string()).ok_or_else(|| format!("{bp} 不是字体"))?;
        let bytes = pptx(&input, &bravura);
        std::fs::write(out, &bytes).map_err(|e| format!("写 {out}：{e}"))?;
        Ok(bytes.len())
    };
    match run() {
        Ok(n) => {
            println!("{{\"bytes\":{n}}}");
            0
        }
        Err(e) => {
            eprintln!("✗ {e}");
            1
        }
    }
}
