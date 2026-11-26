//! `sing-fit <谱.123> <歌词.txt> [--redist=<目录>] [--json] [--svg=<目录>] [--ss=<样式.ss>] [--phrase]`：按参照歌词切段落、排 `%%sing`（`dolce-model::view::singfit`），
//! 把写回后的 123 打到 stdout、差异打到 stderr（`--json` 改出生成结果 JSON；`--svg` 另把写回后的投影档逐页出 SVG 核对）。投影行数用本平台桌面版的量字口径。
//! 歌词给 `-`：不生成，只把谱面照现有的 `%%sing` 排投影档出 SVG（对比排版改动用）；`--ss=<样式.ss>` 叠在出厂投影样式上；`--phrase` 给投影版面加 `linebreak=phrase`（逐遍按乐句断行，生成时也照它试排行数，写回的 123 里也带着）；
//! `--hits` 出 SVG 时另写 `info.json`（排版概要，含各遍段落出现表）与逐页身份表 `NN.hits.json`（核对谱面上增删断点用的槽位）。

use dolce_model::formats::abc::emit::emit_123;
use dolce_model::formats::abc::parse::parse_123;
use dolce_layout::sing::{fit_sing_doc, projection_request};
use dolce_model::view::reflyrics::decode_lyrics_bytes;
use dolce_model::view::singfit::apply_sing_fit;

pub fn sing_fit(args: &[String]) -> i32 {
    let pos: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    let (Some(score), Some(lyrics)) = (pos.first(), pos.get(1)) else {
        eprintln!("用法：dolce-dev sing-fit <谱.123> <歌词.txt | -> [--redist=<目录>] [--json] [--svg=<目录>] [--ss=<样式.ss>] [--phrase]");
        return 2;
    };
    let text = std::fs::read_to_string(score).unwrap_or_else(|e| panic!("读不了 {score}：{e}"));
    let redist = std::path::PathBuf::from(args.iter().find_map(|a| a.strip_prefix("--redist=")).unwrap_or("public/redist"));
    let mut doc = parse_123(&text);
    let backend = dolce_engrave::text::native::webview_measure(redist.exists().then_some(redist.as_path()), &[]);
    let mc = dolce_engrave::text::MeasureCtx::new(&backend);
    let env = dolce_engrave::Env { mc: &mc, meta: None };
    let style = args.iter().find_map(|a| a.strip_prefix("--ss=")).map(|f| {
        let rules = dolce_engrave::style::ss::parse_ss(&std::fs::read_to_string(f).unwrap_or_else(|e| panic!("读不了 {f}：{e}"))).unwrap_or_else(|e| panic!("{f}：{e:?}"));
        let ctx = dolce_engrave::style::cascade::ctx(&[("mode", serde_json::Value::String("expanded".into())), ("engine", serde_json::Value::String("jianpu".into()))]);
        dolce_engrave::style::themes::compute_style_for_paper(&[dolce_engrave::style::themes::theme(dolce_engrave::style::themes::ThemeId::Projection), &rules], &ctx).0
    });
    let req = projection_request(style);
    if args.iter().any(|a| a == "--phrase") {
        set_projection_linebreak(&mut doc.songs[0], "phrase");
    }
    if lyrics.as_str() == "-" {
        let dir = args.iter().find_map(|a| a.strip_prefix("--svg=")).unwrap_or(".");
        return write_svgs(&doc, &req, &env, dir, args.iter().any(|a| a == "--hits"));
    }
    let lyrics = decode_lyrics_bytes(&std::fs::read(lyrics).unwrap_or_else(|e| panic!("读不了 {lyrics}：{e}")));
    let fit = fit_sing_doc(&doc, 0, &lyrics, &req, &env);
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
        write_svgs(&doc, &req, &env, dir, args.iter().any(|a| a == "--hits"));
    }
    print!("{}", emit_123(&doc));
    0
}

/// 投影版面的断行方式（没有投影版面就加一个）
fn set_projection_linebreak(song: &mut dolce_model::Song, v: &str) {
    use dolce_model::layouts::PROJECTION;
    let layouts = song.layouts.get_or_insert_with(Vec::new);
    match layouts.iter_mut().find(|l| l.name == PROJECTION) {
        Some(l) => l.linebreak = Some(v.into()),
        None => layouts.push(dolce_model::LayoutSpec { name: PROJECTION.into(), linebreak: Some(v.into()), ..Default::default() }),
    }
}

/// 投影档逐页出 SVG（`01.svg`…）
fn write_svgs(doc: &dolce_model::ScoreDoc, req: &dolce_layout::layout::JianpuRequest, env: &dolce_engrave::Env, dir: &str, hits: bool) -> i32 {
    let laid = dolce_layout::layout::layout_jianpu_doc(doc, req, env).unwrap_or_else(|e| panic!("投影档排不了：{e}"));
    std::fs::create_dir_all(dir).unwrap_or_else(|e| panic!("建不了 {dir}：{e}"));
    for i in 0..laid.pages.len() {
        let f = format!("{dir}/{:02}.svg", i + 1);
        std::fs::write(&f, laid.svg(i).unwrap_or_default()).unwrap_or_else(|e| panic!("写不了 {f}：{e}"));
        if hits {
            let h = format!("{dir}/{:02}.hits.json", i + 1);
            std::fs::write(&h, serde_json::to_string(&laid.hits(i)).unwrap()).unwrap_or_else(|e| panic!("写不了 {h}：{e}"));
        }
    }
    if hits {
        std::fs::write(format!("{dir}/info.json"), serde_json::to_string_pretty(&laid.info()).unwrap()).unwrap_or_else(|e| panic!("写不了 info.json：{e}"));
    }
    eprintln!("投影档 {} 页 → {dir}", laid.pages.len());
    0
}
