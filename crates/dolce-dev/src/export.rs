//! 导出（L7）的命令：字体样本验证、PDF 读回比对。PDF 读回走识别取数层的 PDFium（`dolce-omr-source`）。

use dolce_layout::export::fonts::FontBook;
use dolce_omr_core::source::pdf::{ContentOpts, PdfDoc};

fn flag<'a>(args: &'a [String], k: &str) -> Option<&'a str> {
    args.iter().find_map(|a| a.strip_prefix(&format!("--{k}=")))
}

/// 一页读回：文字层（不含 PDFium 补的空格换行）与墨迹像素数（2 倍渲染、灰度 < 128）
pub struct PageBack {
    pub text: String,
    pub ink: usize,
    pub w: usize,
    pub h: usize,
    pub gray: Vec<u8>,
}

pub fn read_back(doc: &PdfDoc, i: usize, scale: f64) -> Result<PageBack, String> {
    let pc = doc.content(i, ContentOpts { images: false, paths: false, text: true, outlines: false })?;
    let text: String = pc.chars.iter().filter(|c| !c.generated).filter_map(|c| char::from_u32(c.unicode)).collect();
    let r = doc.render(i, scale)?;
    let gray: Vec<u8> = r.rgba.chunks(4).map(|p| ((p[0] as u32 * 299 + p[1] as u32 * 587 + p[2] as u32 * 114) / 1000) as u8).collect();
    let ink = gray.iter().filter(|&&g| g < 128).count();
    Ok(PageBack { text, ink, w: r.w, h: r.h, gray })
}

/// `dolce-dev font-probe [--out=样本.pdf] [--outline] [--font=文件 …] [族:粗:斜:字 …]`（`--outline` 全部转曲，验退路）：缺省样本见 `dolce_layout::export::probe::default_samples`。
/// 每个样本出一行 JSON：定位、轮廓种类、可变、AAT、合成粗斜、能否嵌，外加读回的文字层是否等于样本字、墨迹像素数。
/// `--require=族,族…`（CI 用）：这些族本机必须找得到，找不到也算不过（缺省样本里别的平台的字体找不到不算错）。
pub fn font_probe(args: &[String]) -> i32 {
    let mut book = FontBook::system();
    for f in args.iter().filter_map(|a| a.strip_prefix("--font=")) {
        if let Err(e) = book.add_file(std::path::Path::new(f)) {
            eprintln!("读 {f}：{e}");
        }
    }
    let samples: Vec<_> = {
        let given: Vec<_> = args
            .iter()
            .filter(|a| !a.starts_with("--"))
            .map(|a| {
                let p: Vec<&str> = a.splitn(4, ':').collect();
                dolce_layout::export::probe::Sample::new(p[0], p.get(1) == Some(&"1"), p.get(2) == Some(&"1"), p.get(3).copied().unwrap_or("Abc 一二三"))
            })
            .collect();
        if given.is_empty() { dolce_layout::export::probe::default_samples() } else { given }
    };
    let (rows, bytes, report) = match dolce_layout::export::probe::run(&book, &samples, args.iter().any(|a| a == "--outline")) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    if let Some(out) = flag(args, "out") {
        std::fs::write(out, &bytes).expect("写 PDF");
    }
    let doc = match PdfDoc::open(bytes) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("PDFium 读不回：{e}");
            return 1;
        }
    };
    let required: Vec<&str> = flag(args, "require").map(|s| s.split(',').map(str::trim).filter(|s| !s.is_empty()).collect()).unwrap_or_default();
    let mut bad = 0;
    for f in &required {
        if !rows.iter().any(|r| r.found && r.family == *f) {
            eprintln!("✗ 要求的字体族 {f} 本机没找到（或不在样本里）");
            bad += 1;
        }
    }
    for (i, r) in rows.iter().enumerate() {
        let back = read_back(&doc, i, 2.0).unwrap_or(PageBack { text: String::new(), ink: 0, w: 0, h: 0, gray: Vec::new() });
        let want: String = r.text.chars().filter(|c| !c.is_whitespace()).collect();
        let got: String = back.text.chars().filter(|c| !c.is_whitespace()).collect();
        let ok = !r.found || (back.ink > 0 && got == want);
        if !ok {
            bad += 1;
        }
        let mut v = serde_json::to_value(r).unwrap();
        v["readback"] = serde_json::json!(got);
        v["textOk"] = serde_json::json!(got == want);
        v["ink"] = serde_json::json!(back.ink);
        v["ok"] = serde_json::json!(ok);
        println!("{v}");
    }
    eprintln!("样本 {} 个，不过 {bad} 个（读回不对或要求的族没找到）；嵌入 {} 面、转曲 {} 面、合成 {} 面、重试 {} 次", rows.len(), report.embedded.len(), report.outlined.len(), report.synthesized.len(), report.retries);
    if bad > 0 { 1 } else { 0 }
}

/// 两份栅格的差：(两边都算的墨迹像素, 差过阈值的像素)
pub fn raster_diff(a: &PageBack, b: &PageBack) -> (usize, usize) {
    if a.w != b.w || a.h != b.h {
        return (a.ink.max(b.ink).max(1), a.ink.max(b.ink).max(1));
    }
    let mut ink = 0;
    let mut diff = 0;
    for (x, y) in a.gray.iter().zip(&b.gray) {
        if *x < 128 || *y < 128 {
            ink += 1;
            if (*x as i32 - *y as i32).abs() > 96 {
                diff += 1;
            }
        }
    }
    (ink, diff)
}

/// 页面 SVG 补上宽高与命名空间（旧链 usvg 要）
#[cfg(feature = "oldpdf")]
fn old_page_pdf(page: &dolce_engrave::scene::Page, w: f64, h: f64, opt: &svg2pdf::usvg::Options) -> Result<Vec<u8>, String> {
    let svg = dolce_engrave::scene::svg::page_svg(page);
    let svg = svg.replacen("<svg ", &format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{h}\" "), 1);
    let tree = svg2pdf::usvg::Tree::from_str(&svg, opt).map_err(|e| format!("usvg: {e}"))?;
    svg2pdf::to_pdf(&tree, svg2pdf::ConversionOptions::default(), svg2pdf::PageOptions::default()).map_err(|e| format!("svg2pdf: {e}"))
}

/// `dolce-dev scene-pdf --in=scene.jsonl [--filter=键子串] [--limit=份数] [--out=目录] [--compare] [--font=文件 …]`
///
/// 场景导出（`ref-layout` 的 `scene.jsonl`：一行一页，按 `key`+`cfg` 归成一份）逐份写 PDF。简谱 viewBox 即 pt；五线谱 tenths 按宽 595pt 折。
/// 每份核对：读回的文字层里有没有场景里的每个字（私用区 SMuFL 字除外）。`--compare`（要 `oldpdf` 特性）另用旧链
/// （页面 SVG → usvg → svg2pdf）出一份，两边 PDFium 2 倍栅格逐页比墨迹，报差像素占墨迹的比例。
#[cfg_attr(not(feature = "oldpdf"), allow(unused_mut))] // 新旧比对那几个累计量只在 oldpdf 下改
pub fn scene_pdf(args: &[String]) -> i32 {
    use std::io::BufRead;
    let Some(input) = flag(args, "in") else {
        eprintln!("要 --in=scene.jsonl");
        return 2;
    };
    let filter = flag(args, "filter").unwrap_or("");
    let limit: usize = flag(args, "limit").and_then(|v| v.parse().ok()).unwrap_or(usize::MAX);
    let skip: usize = flag(args, "skip").and_then(|v| v.parse().ok()).unwrap_or(0);
    let out = flag(args, "out");
    let compare = args.iter().any(|a| a == "--compare");
    let mut book = FontBook::system();
    for f in args.iter().filter_map(|a| a.strip_prefix("--font=")) {
        if let Err(e) = book.add_file(std::path::Path::new(f)) {
            eprintln!("读 {f}：{e}");
        }
    }
    #[cfg(feature = "oldpdf")]
    let old_opt = {
        let mut o = svg2pdf::usvg::Options::default();
        o.fontdb_mut().load_system_fonts();
        for f in args.iter().filter_map(|a| a.strip_prefix("--font=")) {
            o.fontdb_mut().load_font_file(f).ok();
        }
        o
    };
    if compare && !cfg!(feature = "oldpdf") {
        eprintln!("--compare 要用 `--features oldpdf` 编的 dolce");
        return 2;
    }
    let file = std::fs::File::open(input).expect("读场景");
    let mut docs: Vec<(String, Vec<dolce_layout::export::scene::ScenePage>)> = Vec::new();
    let mut seen = 0usize;
    for line in std::io::BufReader::new(file).lines() {
        let line = line.expect("读行");
        // 先粗筛键，免得每行都整份解析
        let mut cut = line.len().min(400);
        while !line.is_char_boundary(cut) {
            cut -= 1;
        }
        let head = &line[..cut];
        if !filter.is_empty() && !head.contains(filter) {
            continue;
        }
        let v: serde_json::Value = serde_json::from_str(&line).expect("场景行");
        let key = format!("{} | {}", v["key"].as_str().unwrap_or(""), v["cfg"].as_str().unwrap_or(""));
        if docs.last().is_none_or(|(k, _)| *k != key) {
            seen += 1;
            if seen <= skip {
                continue;
            }
            if docs.len() >= limit {
                break;
            }
            docs.push((key.clone(), Vec::new()));
        } else if seen <= skip {
            continue;
        }
        let page: dolce_engrave::scene::Page = serde_json::from_value(v).expect("场景页");
        let (w, h) = match page.dialect {
            dolce_engrave::scene::Dialect::Jianpu => (page.w, page.h),
            dolce_engrave::scene::Dialect::Mixed => (595.0, 595.0 * page.h / page.w.max(1.0)),
        };
        docs.last_mut().unwrap().1.push(dolce_layout::export::scene::ScenePage { scene: page, w_pt: w, h_pt: h });
    }
    let (mut n_bad_text, mut worst) = (0usize, (0.0f64, String::new()));
    let mut tot = dolce_layout::export::pdf::Report::default();
    let mut hist = [0usize; 6];
    for (di, (key, pages)) in docs.iter().enumerate() {
        let (bytes, rep) = match dolce_layout::export::scene::scene_pdf(&book, pages, None, &dolce_layout::export::pdf::DocInfo { title: Some(key.clone()), outline: Vec::new() }) {
            Ok(v) => v,
            Err(e) => {
                println!("{}", serde_json::json!({ "key": key, "error": e }));
                n_bad_text += 1;
                continue;
            }
        };
        if let Some(o) = out {
            std::fs::create_dir_all(o).ok();
            std::fs::write(format!("{o}/{:04}.pdf", di + skip), &bytes).expect("写 PDF");
        }
        let doc = PdfDoc::open(bytes).expect("PDFium 读回");
        let mut text_bad = Vec::new();
        let mut page_diffs: Vec<(usize, f64)> = Vec::new();
        for (pi, p) in pages.iter().enumerate() {
            let back = read_back(&doc, pi, 2.0).expect("读回");
            // 场景里的字都要读得回（不看空白与私用区）
            let mut want: Vec<char> = Vec::new();
            if let Some(r) = &p.scene.root {
                r.walk(&mut |n| {
                    if n.is_invisible() {
                        return;
                    }
                    if let dolce_engrave::scene::Shape::Text(t) = &n.shape {
                        want.extend(t.text.chars().filter(|c| !c.is_whitespace() && !('\u{e000}'..='\u{f8ff}').contains(c)));
                    }
                });
            }
            let mut have: std::collections::HashMap<char, usize> = std::collections::HashMap::new();
            for c in back.text.chars() {
                *have.entry(c).or_default() += 1;
            }
            let lost: String = want.iter().filter(|c| have.get(c).is_none_or(|&n| n == 0)).collect();
            if !lost.is_empty() {
                text_bad.push((pi, lost.chars().take(20).collect::<String>()));
            }
            #[cfg(feature = "oldpdf")]
            if compare {
                let old = old_page_pdf(&p.scene, p.w_pt, p.h_pt, &old_opt)
                    .inspect(|b| {
                        if let Some(o) = out {
                            std::fs::write(format!("{o}/{:04}.old{pi}.pdf", di + skip), b).ok();
                        }
                    })
                    .and_then(PdfDoc::open)
                    .and_then(|d| read_back(&d, 0, 2.0));
                if let Ok(ob) = old {
                    let (ink, diff) = raster_diff(&back, &ob);
                    let r = diff as f64 / ink.max(1) as f64;
                    page_diffs.push((pi, r));
                    let b = match r {
                        x if x < 0.001 => 0,
                        x if x < 0.01 => 1,
                        x if x < 0.03 => 2,
                        x if x < 0.1 => 3,
                        x if x < 0.3 => 4,
                        _ => 5,
                    };
                    hist[b] += 1;
                    if r > worst.0 {
                        worst = (r, format!("{key} 第 {} 页", pi + 1));
                    }
                }
            }
        }
        if !text_bad.is_empty() {
            n_bad_text += 1;
        }
        let maxd = page_diffs.iter().map(|x| x.1).fold(0.0, f64::max);
        println!(
            "{}",
            serde_json::json!({ "key": key, "pages": pages.len(), "bytes": rep.bytes, "lost": text_bad, "missing": rep.missing.len(),
                "reconciled": rep.reconciled, "reconcileMax": rep.reconcile_max, "outlined": rep.outlined, "synth": rep.synthesized,
                "fallbacks": rep.fallbacks.len(), "fb": rep.fallbacks.iter().take(12).collect::<Vec<_>>(), "maxDiff": maxd })
        );
        tot.reconciled += rep.reconciled;
        tot.reconcile_max = tot.reconcile_max.max(rep.reconcile_max);
        tot.missing.extend(rep.missing);
        for k in rep.outlined {
            if !tot.outlined.contains(&k) {
                tot.outlined.push(k);
            }
        }
        for k in rep.fallbacks {
            if !tot.fallbacks.contains(&k) {
                tot.fallbacks.push(k);
            }
        }
        tot.pages += pages.len();
    }
    eprintln!(
        "{} 份 {} 页；文字层缺字的 {} 份；缺字 {} 处；整形宽对账摊开 {} 处（最大 {:.2}pt）；转曲面 {:?}；回退 {} 种",
        docs.len(),
        tot.pages,
        n_bad_text,
        tot.missing.len(),
        tot.reconciled,
        tot.reconcile_max,
        tot.outlined,
        tot.fallbacks.len()
    );
    if compare {
        eprintln!("新旧栅格差（差像素 / 墨迹像素）分档 <0.1% <1% <3% <10% <30% ≥30%：{hist:?}；最差 {:.2}% {}", worst.0 * 100.0, worst.1);
    }
    if n_bad_text > 0 { 1 } else { 0 }
}
