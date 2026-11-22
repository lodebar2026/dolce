//! 一档语料的一首曲子 → 识别产物。五线谱走 `omr-staff`，简谱走 `omr-jianpu`。
use dolce_omr_ocr::cache::CachedOcr;
use dolce_omr_ocr::native::{NativeInfer, REC_FILE};
use dolce_omr_ocr::{Ocr, OcrCache};
use dolce_omr_source::raster::SourceImage;
use dolce_omr_source::PdfDoc;
use dolce_omr_staff::page::{recognize_source, Page, PageSource};
use dolce_omr_staff::song::assemble;
use dolce_omr_todoc::staff::score_to_music_xml;
use rayon::prelude::*;
use std::path::{Path, PathBuf};

/// 识别产物：判分脚本 `--from` 读的那几样文件的内容。
pub enum RecOutput {
    /// 五线谱：MusicXML 与版面摘要（形状见私有仓库 `chorus-opslib.mjs::recLayoutOf`；独唱谱只要 `notes` / `rowSp`）
    Staff { musicxml: String, layout: String },
    /// 简谱：识别结果（形状同 web `omr/types.ts::RecognizedScore`）与直出模型写成的 123（同编辑器落地：`omr-todoc::jianpu` → `emit_123`）
    Jianpu { recognized: String, text123: String },
}

/// 一个输入文件的各页（取数走 `omr-engine`，与桌面版、网页版同一份）。
pub fn sources(p: &Path) -> Result<Vec<PageSource>, String> {
    let doc = dolce_omr_engine::Doc::open(std::fs::read(p).map_err(|e| format!("读 {}：{e}", p.display()))?)?;
    Ok(doc.sources(&[])?.into_iter().map(|s| s.1).collect())
}

pub fn recognize(kind: &str, inputs: &[String], ocr: &CachedOcr) -> Result<RecOutput, String> {
    let mut srcs = Vec::new();
    for f in inputs {
        srcs.extend(sources(Path::new(f))?);
    }
    if kind == "jianpu" {
        // 没有内嵌图的纯矢量页（转曲简谱）走对象库证据
        if srcs.iter().all(|s| s.raster.is_none()) && srcs.iter().any(|s| s.content.is_some()) {
            let pcs: Vec<_> = srcs.into_iter().filter_map(|s| s.content).collect();
            return jianpu_output(&dolce_omr_jianpu::recognize_vector(&pcs, ocr)?);
        }
        let srcs: Vec<SourceImage> = srcs.into_iter().filter_map(|s| s.raster).collect();
        return jianpu_output(&dolce_omr_jianpu::recognize(&srcs, ocr)?);
    }
    let pages: Vec<Page> = srcs.par_iter().filter_map(|s| recognize_source(s, Some(ocr))).collect();
    if pages.is_empty() {
        return Err("没有找到谱表".into());
    }
    let song = assemble(&pages, None);
    Ok(RecOutput::Staff { musicxml: score_to_music_xml(&song.score), layout: song.layout_json() })
}

fn jianpu_output(score: &dolce_omr_jianpu::result::RecognizedScore) -> Result<RecOutput, String> {
    Ok(RecOutput::Jianpu { recognized: serde_json::to_string(score).map_err(|e| e.to_string())?, text123: jianpu_123(score) })
}

/// 简谱识别结果 → 123（同编辑器识别的缺省输出格式 `convert/targets.ts` 的 123：直出模型、补纸张 meta、`emit_123`）。
pub fn jianpu_123(score: &dolce_omr_jianpu::result::RecognizedScore) -> String {
    let doc = dolce_omr_todoc::jianpu::recognized_to_doc(score).doc;
    dolce_formats::abc::emit::emit_123(&dolce_model::pagemeta::with_page_meta(&doc, None))
}

/// OCR 模型目录：环境变量 `OMR_MODELS` → 可执行文件旁的 `models/`（分发包）→ 本检出的 `public/redist/ocr`（开发、回归）。
pub fn model_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("OMR_MODELS") {
        return PathBuf::from(d);
    }
    if let Some(d) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.join("models"))).filter(|d| d.join(REC_FILE).exists()) {
        return d;
    }
    crate::checkout("public/redist/ocr")
}

/// 识别用的 OCR：模型取 [`model_dir`]，给了 `cache` 就把结果按送检画面内容寻址落在那里（第二次起不推理），否则只在内存里。
pub fn open_ocr(cache: Option<&Path>) -> Result<CachedOcr, String> {
    let dir = model_dir();
    let dict = std::fs::read_to_string(dir.join("ppocrv6_dict.txt")).map_err(|e| format!("读 OCR 字典（{}）：{e}", dir.display()))?;
    let cache = cache.map_or_else(OcrCache::memory, OcrCache::open);
    // 会话池与桌面版同名的环境变量可调（桌面缺省 3 × 3，见 src-tauri/src/omr.rs），测速时照桌面配置跑
    let env = |k: &str, d: usize| std::env::var(k).ok().and_then(|v| v.parse().ok()).filter(|&v| v > 0).unwrap_or(d);
    Ok(CachedOcr::new(Some(Ocr::new(Box::new(NativeInfer::new(&dir, env("DOLCE_OCR_SESS", 8), env("DOLCE_OCR_THREADS", 1))), &dict)), cache))
}

/// `dolce recognize staff 文件 [--out=目录]`：识别一个五线谱文件，写出 `<曲>.musicxml`（带识别 id）与 `<曲>.review.json`（核对 JSON，交 web `omrrust/adapter.ts`）。
fn one_staff(file: &str, out: &str) -> Result<(), String> {
    let ocr = open_ocr(Some(&crate::sibling("dev/data/rust-omr/ocr-cache/session.json")))?;
    let t0 = std::time::Instant::now();
    let srcs = sources(Path::new(file))?;
    let pages: Vec<Page> = srcs.par_iter().filter_map(|s| recognize_source(s, Some(&ocr))).collect();
    ocr.cache.save()?;
    if pages.is_empty() {
        return Err("没有找到谱表".into());
    }
    let song = assemble(&pages, None);
    let stem = Path::new(file).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "score".into());
    let out = Path::new(out);
    std::fs::create_dir_all(out).map_err(|e| e.to_string())?;
    std::fs::write(out.join(format!("{stem}.musicxml")), score_to_music_xml(&song.score)).map_err(|e| e.to_string())?;
    std::fs::write(out.join(format!("{stem}.review.json")), song.review_json()).map_err(|e| e.to_string())?;
    println!("{stem}：{} 页、{} 个声部、{} 个系统，{:.1} s", pages.len(), song.score.parts.len(), song.systems.len(), t0.elapsed().as_secs_f64());
    Ok(())
}

/// `dolce recognize jianpu 文件 [--render] [--out=文件]`：识别一个简谱文件，打出各项计数（没有 GT 时两条路对照用）。
pub fn one(args: &[String]) -> Result<(), String> {
    let (kind, file) = (args.first().ok_or("缺档")?, args.get(1).ok_or("缺文件")?);
    if kind == "staff" {
        return one_staff(file, args.iter().find_map(|a| a.strip_prefix("--out=")).unwrap_or("."));
    }
    if kind != "jianpu" {
        return Err("档只有 jianpu / staff".into());
    }
    let render = args.iter().any(|a| a == "--render");
    let out = args.iter().find_map(|a| a.strip_prefix("--out="));
    let ocr = open_ocr(Some(&crate::sibling("dev/data/rust-omr/ocr-cache/jianpu.json")))?;
    let path = Path::new(file);
    let t0 = std::time::Instant::now();
    let score = if render {
        let doc = PdfDoc::open(std::fs::read(path).map_err(|e| e.to_string())?)?;
        let srcs: Vec<SourceImage> = (0..doc.page_count())
            .filter_map(|i| {
                let r = doc.render(i, 300.0 / 72.0).ok()?;
                let gray: Vec<u8> = r.rgba.chunks_exact(4).map(|p| ((p[0] as u32 * 299 + p[1] as u32 * 587 + p[2] as u32 * 114) / 1000) as u8).collect();
                Some(SourceImage { w: r.w, h: r.h, gray, rgb: Vec::new(), kind: dolce_omr_source::model::ImageKind::Gray, rect: dolce_omr_core::image::Rect::new(0.0, 0.0, r.w as f64, r.h as f64), page_w: r.w as f64, page_h: r.h as f64, size_known: false })
            })
            .collect();
        dolce_omr_jianpu::recognize(&srcs, &ocr)?
    } else {
        let srcs = sources(path)?;
        if srcs.iter().all(|s| s.raster.is_none()) {
            let pcs: Vec<_> = srcs.into_iter().filter_map(|s| s.content).collect();
            dolce_omr_jianpu::recognize_vector(&pcs, &ocr)?
        } else {
            let srcs: Vec<SourceImage> = srcs.into_iter().filter_map(|s| s.raster).collect();
            dolce_omr_jianpu::recognize(&srcs, &ocr)?
        }
    };
    ocr.cache.save()?;
    let rows = score.rows.len();
    let notes: usize = score.rows.iter().map(|r| r.nums.len()).sum();
    let bars: usize = score.rows.iter().map(|r| r.barline_xs.len()).sum();
    println!("{}：{rows} 行、{notes} 个音、{bars} 条小节线、歌词区 {}、拍号 {}/{}，{:.1} s", if render { "渲染走像素" } else { "矢量" }, score.lyric_regions.len(), score.beats, score.beat_type, t0.elapsed().as_secs_f64());
    if let Some(o) = out {
        std::fs::write(o, serde_json::to_string(&score).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// `dolce session 文件 --ops=操作.jsonl [--out=目录]`：识别一个五线谱文件，开会话，逐条做操作（每行一条 JSON，形状见 `omr-staff::session::Op`），
/// 每一步写出 `<步>.musicxml` 与 `<步>.rec.json`，报声部数、小节数、钉住几条，以及识别 id 比上一步留下 / 没了 / 新出的个数（查号码稳定）。
pub fn session(args: &[String]) -> Result<(), String> {
    use dolce_omr_staff::session::{Op, Session};
    let file = args.first().filter(|a| !a.starts_with("--")).ok_or("缺文件")?;
    let val = |k: &str| args.iter().find_map(|a| a.strip_prefix(&format!("--{k}=")).map(str::to_string));
    let ops: Vec<Op> = match val("ops") {
        Some(p) => std::fs::read_to_string(&p)
            .map_err(|e| format!("读 {p}：{e}"))?
            .lines()
            .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with("//"))
            .map(|l| serde_json::from_str(l).map_err(|e| format!("操作「{l}」：{e}")))
            .collect::<Result<_, _>>()?,
        None => Vec::new(),
    };
    let out = std::path::PathBuf::from(val("out").unwrap_or_else(|| "session-out".into()));
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let ocr = open_ocr(Some(&crate::sibling("dev/data/rust-omr/ocr-cache/session.json")))?;
    let srcs = sources(Path::new(file))?;
    let pages: Vec<Page> = srcs.par_iter().filter_map(|s| recognize_source(s, Some(&ocr))).collect();
    ocr.cache.save()?;
    if pages.is_empty() {
        return Err("没有找到谱表".into());
    }
    let ids = |x: &str| -> std::collections::BTreeSet<String> { x.split(" id=\"").skip(1).filter_map(|s| s.split('"').next()).map(str::to_string).collect() };
    let mut s = Session::new(pages, None);
    let mut prev = ids(&score_to_music_xml(&s.song().score));
    let dump = |k: usize, s: &Session, prev: &std::collections::BTreeSet<String>, what: &str| -> Result<std::collections::BTreeSet<String>, String> {
        let song = s.song();
        let x = score_to_music_xml(&song.score);
        std::fs::write(out.join(format!("{k}.musicxml")), &x).map_err(|e| e.to_string())?;
        std::fs::write(out.join(format!("{k}.rec.json")), song.layout_json()).map_err(|e| e.to_string())?;
        std::fs::write(out.join(format!("{k}.review.json")), s.review_json()).map_err(|e| e.to_string())?;
        let now = ids(&x);
        let measures = song.score.parts.first().map_or(0, |p| p.measures.len());
        let staves: Vec<u8> = song.score.parts.iter().map(|p| p.staves.max(1)).collect();
        println!(
            "{k} {what}：{} 个声部（谱表 {staves:?}）、{measures} 小节、钉住 {}；id 留 {} 没 {} 新 {}",
            song.score.parts.len(),
            s.constraints().pins.len(),
            now.intersection(prev).count(),
            prev.difference(&now).count(),
            now.difference(prev).count()
        );
        Ok(now)
    };
    prev = dump(0, &s, &prev, "识别")?;
    println!("  关联表 {:?}", s.assignment());
    for (k, op) in ops.into_iter().enumerate() {
        let what = serde_json::to_string(&op).unwrap_or_default();
        s.apply(op)?;
        prev = dump(k + 1, &s, &prev, &what)?;
    }
    Ok(())
}
