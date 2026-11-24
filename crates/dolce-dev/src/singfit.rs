//! `sing-fit <谱.123> <歌词.txt> [--redist=<目录>] [--json] [--svg=<目录>]`：按参照歌词切段落、排 `%%sing`（`dolce-view::singfit`），
//! 把写回后的 123 打到 stdout、差异打到 stderr（`--json` 改出生成结果 JSON；`--svg` 另把写回后的投影档逐页出 SVG 核对）。投影行数用本平台桌面版的量字口径。

use dolce_formats::abc::emit::emit_123;
use dolce_formats::abc::parse::parse_123;
use dolce_session::sing::{fit_sing_doc, projection_request};
use dolce_view::reflyrics::decode_lyrics_bytes;
use dolce_view::singfit::apply_sing_fit;

pub fn sing_fit(args: &[String]) -> i32 {
    let pos: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    let (Some(score), Some(lyrics)) = (pos.first(), pos.get(1)) else {
        eprintln!("用法：dolce-dev sing-fit <谱.123> <歌词.txt> [--redist=<目录>] [--json] [--svg=<目录>]");
        return 2;
    };
    let text = std::fs::read_to_string(score).unwrap_or_else(|e| panic!("读不了 {score}：{e}"));
    let lyrics = decode_lyrics_bytes(&std::fs::read(lyrics).unwrap_or_else(|e| panic!("读不了 {lyrics}：{e}")));
    let redist = std::path::PathBuf::from(args.iter().find_map(|a| a.strip_prefix("--redist=")).unwrap_or("public/redist"));
    let mut doc = parse_123(&text);
    let backend = dolce_text::native::webview_measure(redist.exists().then_some(redist.as_path()), &[]);
    let mc = dolce_text::MeasureCtx::new(&backend);
    let env = dolce_engrave::Env { mc: &mc, meta: None };
    let fit = fit_sing_doc(&doc, 0, &lyrics, &projection_request(None), &env);
    if args.iter().any(|a| a == "--json") {
        println!("{}", serde_json::to_string_pretty(&fit).unwrap());
        return 0;
    }
    eprintln!("同字 {}/{}，{} 段、{} 遍", fit.matched, fit.ref_chars, fit.marks.len(), fit.order.len());
    for n in &fit.notes {
        eprintln!("  {}", n.format());
    }
    if fit.order.is_empty() {
        return 1;
    }
    apply_sing_fit(&mut doc.songs[0], &fit);
    if let Some(dir) = args.iter().find_map(|a| a.strip_prefix("--svg=")) {
        let laid = dolce_session::layout::layout_jianpu_doc(&doc, &projection_request(None), &env).unwrap_or_else(|e| panic!("投影档排不了：{e}"));
        std::fs::create_dir_all(dir).unwrap_or_else(|e| panic!("建不了 {dir}：{e}"));
        for i in 0..laid.pages.len() {
            let f = format!("{dir}/{:02}.svg", i + 1);
            std::fs::write(&f, laid.svg(i).unwrap_or_default()).unwrap_or_else(|e| panic!("写不了 {f}：{e}"));
        }
        eprintln!("投影档 {} 页 → {dir}", laid.pages.len());
    }
    print!("{}", emit_123(&doc));
    0
}
