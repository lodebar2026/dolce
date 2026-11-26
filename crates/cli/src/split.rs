//! `dolce split`：歌本切分（`omr-book`）。整本分页歌谱（PDF 取每页内嵌源图，或页图文件夹按文件名自然序）→ 输出目录里一首一张
//! `曲号 曲名.jpg`；转曲矢量 PDF 整页渲成图来扫描，出 `曲号 曲名.png`（`--dpi`，缺省 300）；`--recognize` 切完逐首识别，
//! 回原书取矢量对象，写 `曲号 曲名` 的 MusicXML（或 `-f` 选的格式）。核对报告写到 `输出目录/切分报告.txt`（及 `--report` JSON）。
//! 有缺号、重号或识别失败时退出码 1。
use crate::recognize::open_ocr;
use dolce_omr::book::recognize::song_clips;
use dolce_omr::book::report::{check_against_toc, song_file_names};
use dolce_omr::book::source::BookSource;
use dolce_omr::book::write::{song_image_ext, write_songs, WriteOpts};
use dolce_omr::book::{plan_book, BookPlan, PlanOptions};
use dolce_omr_staff::page::{recognize_source, Page, PageSource};
use dolce_omr_staff::song::assemble;
use rayon::prelude::*;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use dolce_model::formats::capability::TargetFormat;
use dolce_model::formats::targets::{message_zh, write_music_xml_as};

pub const USAGE: &str = "  dolce split <歌本.pdf | 页图目录> -o <输出目录> [--report 报告.json] [--quality 92] [--dpi 300] [--toc-pages 3-15] [--dry-run]
              [--recognize [-f 格式]] [--cache=OCR缓存.json]
      歌本切分：一页多首按标题切开、一首跨页按序拼接，去页码，按书内目录核对缺漏
      --toc-pages  目录页（按源页序，1 起；如 3-15 或 3,5,7-9）；不给则自动认歌谱区之前全是字行的页
      --dry-run    只扫描、核对并打印报告，不写图片
      --quality    位图歌本出 JPEG 的质量；--dpi 转曲矢量歌本出 PNG 的分辨率
      --recognize  切完逐首识别（只收转曲矢量歌本，取原书矢量对象），-f 选输出格式（同 dolce omr 识谱，缺省 musicxml）
      --cache      OCR 结果缓存（缺省 ../dev/data/rust-omr/ocr-cache/book-<书名>.json）";

struct Opts {
    input: Option<String>,
    out: Option<String>,
    report: Option<String>,
    quality: u32,
    dpi: Option<f64>,
    toc_pages: Option<String>,
    dry_run: bool,
    recognize: bool,
    format: TargetFormat,
    cache: Option<String>,
}

fn parse(args: &[String]) -> Result<Opts, String> {
    let mut o = Opts { input: None, out: None, report: None, quality: 92, dpi: None, toc_pages: None, dry_run: false, recognize: false, format: TargetFormat::MusicXml, cache: None };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut val = || it.next().cloned().ok_or_else(|| format!("{a} 后面缺值"));
        match a.as_str() {
            "-o" | "--out" => o.out = Some(val()?),
            "--report" => o.report = Some(val()?),
            "--quality" => o.quality = val()?.parse().map_err(|_| "--quality 要是数")?,
            "--dpi" => o.dpi = Some(val()?.parse().map_err(|_| "--dpi 要是数")?),
            "--toc-pages" => o.toc_pages = Some(val()?),
            "--dry-run" => o.dry_run = true,
            "--recognize" => o.recognize = true,
            "-f" | "--format" => o.format = crate::cli::parse_format(&val()?)?,
            _ if a.starts_with("--cache=") => o.cache = Some(a["--cache=".len()..].to_string()),
            _ if a.starts_with('-') => return Err(format!("不认识的参数 {a}")),
            _ => o.input = Some(a.clone()),
        }
    }
    Ok(o)
}

/// 「3-15」「3,5,7-9」→ 源序号（0 起）。
fn parse_ranges(s: &str) -> Result<Vec<usize>, String> {
    let mut out = Vec::new();
    for part in s.split([',', '，']) {
        let (a, b) = part.split_once('-').unwrap_or((part, part));
        let (a, b): (usize, usize) = (a.trim().parse().map_err(|_| format!("--toc-pages 写法不对：{s}"))?, b.trim().parse().map_err(|_| format!("--toc-pages 写法不对：{s}"))?);
        if a == 0 {
            return Err(format!("--toc-pages 从 1 数：{s}"));
        }
        out.extend((a..=b).map(|n| n - 1));
    }
    Ok(out)
}

fn ticker(label: &'static str) -> impl Fn(usize, usize) + Sync {
    let tty = std::io::stderr().is_terminal();
    move |d, n| {
        if tty {
            eprint!("\r{label} {d}/{n}");
        }
        if d == n {
            if tty {
                eprintln!();
            } else {
                eprintln!("{label} {n}/{n}");
            }
        }
    }
}

pub fn run(args: &[String]) -> Result<ExitCode, String> {
    let o = parse(args)?;
    let Some(input) = o.input.as_deref().filter(|_| o.out.is_some() || o.dry_run) else {
        eprintln!("用法:\n{USAGE}");
        return Ok(ExitCode::from(if o.input.is_some() { 1 } else { 0 }));
    };
    if o.recognize && o.dry_run {
        return Err("--recognize 要写文件，不能与 --dry-run 一起用".into());
    }
    if !(1..=100).contains(&o.quality) {
        return Err("--quality 要在 1–100".into());
    }
    if o.dpi.is_some_and(|d| !(36.0..=1200.0).contains(&d)) {
        return Err("--dpi 要在 36–1200".into());
    }
    let toc_pages = o.toc_pages.as_deref().map(parse_ranges).transpose()?;
    let t0 = std::time::Instant::now();
    let path = Path::new(input);
    let src = BookSource::open(path)?;
    if o.recognize && !src.is_vector() {
        return Err("--recognize 只收转曲矢量歌本；位图歌本请先 split 出图，再用 dolce omr 批量识别图片目录".into());
    }
    if src.is_vector() {
        eprintln!("转曲矢量 PDF：出 PNG（{} dpi）", o.dpi.unwrap_or(300.0));
    } else if o.dpi.is_some() {
        eprintln!("--dpi 只对转曲矢量 PDF 有效，位图歌本照源图原分辨率出 JPEG，已忽略");
    }
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "book".into());
    // 缓存：--cache 给的；开发检出（同级有 dev/）落在私有仓库；分发包里只在内存
    let dev = crate::sibling("dev/data/rust-omr/ocr-cache");
    let cache = o.cache.map(PathBuf::from).or_else(|| dev.is_dir().then(|| dev.join(format!("book-{stem}.json"))));
    let ocr = open_ocr(cache.as_deref())?;
    let scan_tick = ticker("扫描");
    let plan = plan_book(&src, &ocr, &PlanOptions { toc_pages, on_progress: Some(&scan_tick) });
    ocr.cache.save()?;
    let plan = plan?;
    let names = song_file_names(&plan.songs);
    let rep = check_against_toc(&plan, &names, &|i| src.name(i));
    let mut rec_text = String::new();
    let mut rec_failed: Vec<(String, String)> = Vec::new();
    let mut rec_ok = 0usize;
    if !o.dry_run {
        let out = Path::new(o.out.as_deref().unwrap());
        let write_tick = ticker("写出");
        write_songs(&src, &plan.layouts, &names, out, &WriteOpts { quality: o.quality as u8, dpi: o.dpi, on_progress: Some(&write_tick) })?;
        if o.recognize {
            (rec_ok, rec_failed) = recognize_songs(&src, &plan, &names, out, &ocr, o.format);
            ocr.cache.save()?;
            let mut l = vec![format!("识别（{}，取原书矢量）：成功 {rec_ok} 首{}", o.format.id(), if rec_failed.is_empty() { " ✓".to_string() } else { format!("，失败 {} 首", rec_failed.len()) })];
            l.extend(rec_failed.iter().map(|(n, r)| format!("  {n}：{r}")));
            rec_text = l.join("\n") + "\n";
        }
        let txt = if rec_text.is_empty() { rep.text.clone() } else { format!("{}\n{rec_text}", rep.text) };
        std::fs::write(out.join("切分报告.txt"), txt).map_err(|e| e.to_string())?;
    }
    if let Some(r) = &o.report {
        let mut v = serde_json::to_value(&rep).map_err(|e| e.to_string())?;
        let ext = song_image_ext(&src);
        let songs: Vec<serde_json::Value> = plan
            .songs
            .iter()
            .zip(&names)
            .map(|(s, n)| {
                let mut j = serde_json::to_value(s).unwrap();
                j.as_object_mut().unwrap().insert("file".into(), format!("{n}{ext}").into());
                j
            })
            .collect();
        v["songs"] = songs.into();
        if o.recognize {
            v["recognize"] = serde_json::json!({ "ok": rec_ok, "failed": rec_failed.iter().map(|(n, r)| serde_json::json!({ "name": n, "reason": r })).collect::<Vec<_>>() });
        }
        std::fs::write(r, serde_json::to_string_pretty(&v).unwrap()).map_err(|e| e.to_string())?;
    }
    eprint!("{}", rep.text);
    if !rec_text.is_empty() {
        eprint!("{rec_text}");
    }
    eprintln!("用时 {:.1}s{}", t0.elapsed().as_secs_f64(), if o.dry_run { String::new() } else { format!("，已写入 {}", o.out.unwrap()) });
    Ok(if !rep.missing.is_empty() || !rep.duplicate.is_empty() || !rec_failed.is_empty() { ExitCode::from(1) } else { ExitCode::SUCCESS })
}

/// 逐首识别：各段取那一页的矢量对象裁出那一截（剔页码）当一页，走五线谱 / 混排路线拼整曲，曲名用切分认出的。
fn recognize_songs(src: &BookSource, plan: &BookPlan, names: &[String], out: &Path, ocr: &dolce_omr_core::ocr::cache::CachedOcr, format: TargetFormat) -> (usize, Vec<(String, String)>) {
    let tick = ticker("识别");
    let done = AtomicUsize::new(0);
    let failed = Mutex::new(Vec::new());
    let ok = AtomicUsize::new(0);
    // 排查用：OMR_BOOK_ONLY=子串 只认文件名含它的那几首
    let only = std::env::var("OMR_BOOK_ONLY").ok();
    (0..plan.songs.len()).into_par_iter().filter(|&k| only.as_ref().is_none_or(|s| names[k].contains(s.as_str()))).for_each(|k| {
        let r = (|| -> Result<(), String> {
            let mut pages: Vec<Page> = Vec::new();
            for c in song_clips(plan, k) {
                let pc = src.content(c.page)?.clip(&c.rect, &c.drop);
                if let Some(p) = recognize_source(&PageSource { raster: None, content: Some(pc), rendered: None }, Some(ocr)) {
                    pages.push(p);
                }
            }
            if pages.is_empty() {
                return Err("没认出谱表".into());
            }
            let title = Some(plan.songs[k].title.clone()).filter(|t| !t.is_empty());
            let song = assemble(&pages, title);
            let xml = dolce_omr_core::todoc::staff::score_to_music_xml(&song.score);
            let write = |ext: &str, bytes: &[u8]| std::fs::write(out.join(format!("{}{ext}", names[k])), bytes).map_err(|e| e.to_string());
            match write_music_xml_as(format, &xml) {
                Ok(enc) => write(format.ext(), &enc.bytes),
                // 转不成就把 MusicXML 留下
                Err(e) => {
                    write(TargetFormat::MusicXml.ext(), xml.as_bytes())?;
                    Err(format!("转 {} 失败：{}（MusicXML 留着）", format.id(), message_zh(&e)))
                }
            }
        })();
        match r {
            Ok(()) => {
                ok.fetch_add(1, Ordering::Relaxed);
            }
            Err(e) => failed.lock().unwrap().push((names[k].clone(), e)),
        }
        tick(done.fetch_add(1, Ordering::Relaxed) + 1, plan.songs.len());
    });
    let mut f = failed.into_inner().unwrap();
    f.sort();
    (ok.into_inner(), f)
}
