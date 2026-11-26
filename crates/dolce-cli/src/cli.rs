//! `dolce omr <图片…|PDF…|目录…>`：给人用的识谱——识别后直接写成各格式（文本谱 / 123 / MusicXML …，写出端同编辑器：`dolce-formats::targets`），
//! 简谱可带参照歌词互证（`-l`，`omr-todoc::reflyrics`），并按歌词的段落与唱法切段落、写逐遍演唱顺序（`dolce-view::singfit`，写 123 时）。不要 Node：分发包里只有这一个程序、PDFium 与模型。
//!
//! 批量：多个文件或目录一起给，一个进程跑完（OCR 模型只加载一次）；`-o` 给目录则逐个写文件，否则写 stdout。
use crate::run::{expand, recognize_file, Got};
use dolce_model::formats::capability::TargetFormat;
use dolce_model::formats::targets::{message_zh, write_music_xml_as, Encoded, OUT_FORMATS};
use dolce_model::toxml::{score_doc_to_music_xml, ToXmlOptions};
use dolce_omr_engine::Kind;
use dolce_omr_sheet::jianpu::RecognizedScore;
use dolce_omr_todoc::jianpu::recognized_to_doc;
use dolce_omr_todoc::reflyrics::{apply_ref_lyrics, decode_lyrics_bytes, CheckKind, LyricCheck};
use dolce_session::sing::{fit_sing_doc, projection_request};
use dolce_model::view::singfit::{apply_sing_fit, FitKind, SingFit};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

pub fn usage() -> String {
    let list = OUT_FORMATS.iter().map(|f| format!("{}（{}）", f.id(), f.label())).collect::<Vec<_>>().join("、");
    format!(
        "  dolce omr <图片…|PDF…|目录…> [-f 格式] [-o 输出] [--kind=auto|staff|jianpu] [--profile] [-l 歌词文件 [--lyrics-report 核对.json] [--no-sing]]
      识谱：简谱 / 五线谱的图片（jpg/png/webp/bmp/tif）或 PDF → 各格式
      格式：{list}；缺省 shige
      路线：缺省自动（先按五线谱认，一页谱表都没有再走简谱），--kind 指定
      批量：多个文件或目录一起给，同一进程跑完（一个文件一首；目录取里面的图片与 PDF，不递归）；-o 给目录则逐个写文件
      歌词：-l/--lyrics 给同一首诗歌的歌词文本（.txt/.lrc），只配单张简谱；形近字按歌词选字、补漏字，
            两边不一致处打到 stderr，--lyrics-report 另落 JSON；
            写 123 时还按歌词的段落与唱法在谱上切段落 [P:x]、写逐遍演唱顺序 %%sing
            （歌词与谱面反复对不上时以歌词为准，差异打到 stderr；--no-sing 不生成）
"
    )
}

/// `-f` 的值 → 格式
pub fn parse_format(s: &str) -> Result<TargetFormat, String> {
    TargetFormat::parse(s).ok_or_else(|| format!("未知格式 {s}，可选：{}", OUT_FORMATS.map(|f| f.id()).join(" / ")))
}

/// 简谱识别结果 → 指定格式（一律先直出模型，再走格式表）。`sing`：参照歌词，写 123 时据它生成段落与演唱顺序
fn write_jianpu(score: &RecognizedScore, format: TargetFormat, sing: Option<&str>) -> Result<(Encoded, Option<SingFit>), String> {
    let mut doc = recognized_to_doc(score).doc;
    let fit = match sing {
        Some(text) if format == TargetFormat::J123 && !doc.songs.is_empty() => {
            let fit = with_native_env(|env| fit_sing_doc(&doc, 0, text, &projection_request(None), env));
            if !fit.order.is_empty() {
                apply_sing_fit(&mut doc.songs[0], &fit);
            }
            Some(fit)
        }
        _ => None,
    };
    if format == TargetFormat::MusicXml {
        let xml = score_doc_to_music_xml(&doc, None, &ToXmlOptions::default()).map_err(|e| e.key)?;
        return Ok((format.encode(xml), fit));
    }
    Ok((format.write(&doc, None)?, fit))
}

/// 系统量字的排版环境（投影档算行数用；没有 SMuFL 元数据，只影响记号的紧包围盒、不影响行数）
fn with_native_env<R>(f: impl FnOnce(&dolce_engrave::Env) -> R) -> R {
    let backend = dolce_text::native::webview_measure(None, &[]);
    let mc = dolce_text::MeasureCtx::new(&backend);
    f(&dolce_engrave::Env { mc: &mc, meta: None })
}

fn sing_summary(fit: &SingFit) {
    if fit.order.is_empty() {
        eprintln!("[演唱顺序] 参照歌词与谱面歌词对不上（同字 {}/{}），没有生成", fit.matched, fit.ref_chars);
        return;
    }
    let off = fit.notes.iter().filter(|n| n.kind == FitKind::OffScore).count();
    eprintln!(
        "[演唱顺序] 同字 {}/{}，切 {} 段、{} 遍{}：",
        fit.matched,
        fit.ref_chars,
        fit.marks.len(),
        fit.order.len(),
        if off > 0 { format!("，{off} 处不照谱面反复") } else { String::new() }
    );
    for l in fit.sing_text().lines() {
        eprintln!("  {l}");
    }
    for n in &fit.notes {
        eprintln!("  {}", n.format());
    }
}

struct Opts {
    format: TargetFormat,
    out: Option<PathBuf>,
    profile: bool,
    kind: Kind,
    inputs: Vec<String>,
    lyrics: Option<PathBuf>,
    lyrics_report: Option<PathBuf>,
    no_sing: bool,
}

fn parse_args(args: &[String]) -> Result<Option<Opts>, String> {
    let mut o = Opts { format: TargetFormat::Shige, out: None, profile: false, kind: Kind::Auto, inputs: vec![], lyrics: None, lyrics_report: None, no_sing: false };
    let mut it = args.iter();
    let need = |a: &str, v: Option<&String>| v.cloned().ok_or_else(|| format!("{a} 后面要跟值"));
    while let Some(a) = it.next() {
        match a.as_str() {
            "-f" | "--format" => o.format = parse_format(&need(a, it.next())?)?,
            "-o" | "--out" => o.out = Some(need(a, it.next())?.into()),
            "--profile" => o.profile = true,
            "-l" | "--lyrics" => o.lyrics = Some(need(a, it.next())?.into()),
            "--lyrics-report" => o.lyrics_report = Some(need(a, it.next())?.into()),
            "--no-sing" => o.no_sing = true,
            "-h" | "--help" => return Ok(None),
            _ if a.starts_with("--kind=") => {
                o.kind = match &a[7..] {
                    "auto" => Kind::Auto,
                    "staff" => Kind::Staff,
                    "jianpu" => Kind::Jianpu,
                    _ => return Err("--kind 只有 auto / staff / jianpu".into()),
                }
            }
            _ if a.starts_with("--threads=") || a.starts_with("--thread-mode=") => {
                eprintln!("{} 已不用（推理线程由识别程序自己定），忽略", a.split('=').next().unwrap_or(a));
            }
            _ => o.inputs.push(a.clone()),
        }
    }
    Ok(Some(o))
}

fn summary(lc: &LyricCheck) {
    let cnt = |k: CheckKind| lc.items.iter().filter(|x| x.kind == k).count();
    let review = lc.items.iter().filter(|x| x.review.is_some()).count();
    let (fixed, filled) = (cnt(CheckKind::Fixed), cnt(CheckKind::Filled));
    eprintln!(
        "[歌词核对] 按{}对齐：同字 {}/{}（参照 {} 字） ｜ 已改 {fixed}、已补 {filled}{}、待核 {}",
        if lc.order == "expanded" { "演唱顺序" } else { "谱面顺序" },
        lc.matched,
        lc.ocr_chars,
        lc.ref_chars,
        if review > 0 { format!("（其中待复查 {review}）") } else { String::new() },
        lc.items.len() - fixed - filled
    );
    for x in &lc.items {
        eprintln!("  {}", x.format());
    }
    for u in &lc.unmatched_ref {
        eprintln!("  [参照未对上] 第 {}–{} 字「{}」", u.from + 1, u.to, u.text);
    }
}

pub fn run(args: &[String]) -> Result<ExitCode, String> {
    let t0 = Instant::now();
    let Some(o) = parse_args(args)? else {
        eprintln!("用法：\n{}", usage());
        return Ok(ExitCode::SUCCESS);
    };
    if o.inputs.is_empty() {
        eprintln!("用法：\n{}", usage());
        return Ok(ExitCode::from(1));
    }
    if o.lyrics_report.is_some() && o.lyrics.is_none() {
        return Err("--lyrics-report 要和 --lyrics 一起给".into());
    }
    let any_dir = o.inputs.iter().any(|p| Path::new(p).is_dir());
    let ref_lyrics = match &o.lyrics {
        None => None,
        Some(p) => {
            if o.inputs.len() != 1 || any_dir {
                return Err("--lyrics 只配单张图（一份歌词对一首歌），批量请逐张跑".into());
            }
            let b = std::fs::read(p).map_err(|e| format!("读不了歌词文件 {}：{e}", p.display()))?;
            Some(decode_lyrics_bytes(&b))
        }
    };
    // -o 是目录（多个输入、给了目录，或路径本身就是已存在的目录）时逐个写文件，否则当单个输出文件
    let out_is_dir = o.out.as_ref().is_some_and(|out| o.inputs.len() > 1 || any_dir || out.is_dir());
    // 输出目录（或单个输出文件的上级目录）不存在就建
    if let Some(out) = &o.out {
        let dir = if out_is_dir { Some(out.as_path()) } else { out.parent().filter(|p| !p.as_os_str().is_empty()) };
        if let Some(d) = dir {
            std::fs::create_dir_all(d).map_err(|e| format!("建不了目录 {}：{e}", d.display()))?;
        }
    }
    let multi = o.inputs.len() > 1 || any_dir;
    let files = expand(&o.inputs);
    if files.is_empty() {
        return Err("没有可识别的文件".into());
    }
    let ocr = crate::recognize::open_ocr(None)?;
    let (mut n, mut failed) = (0usize, 0usize);
    let mut t_prev = t0;
    let stdout = std::io::stdout();
    for f in &files {
        let name = f.file_name().map_or_else(|| f.display().to_string(), |s| s.to_string_lossy().into_owned());
        let got = recognize_file(f, o.kind, &ocr, false);
        let ms = t_prev.elapsed().as_millis();
        t_prev = Instant::now();
        n += 1;
        let got = match got {
            Ok(g) => g,
            Err(e) => {
                eprintln!("✗ {name}: {e}");
                failed += 1;
                continue;
            }
        };
        // 参照歌词互证：改字、补字要在写出之前
        let mut lc = None;
        let mut fit = None;
        let staff = matches!(got, Got::Staff(_));
        let enc = match got {
            Got::Staff(xml) => {
                if ref_lyrics.is_some() {
                    eprintln!("[歌词核对] 参照歌词只用于简谱，五线谱未核对");
                }
                write_music_xml_as(o.format, &xml)
            }
            Got::Jianpu(mut score) => {
                if let Some(r) = &ref_lyrics {
                    lc = Some(apply_ref_lyrics(&mut score, r));
                }
                let sing = if o.no_sing { None } else { ref_lyrics.as_deref() };
                write_jianpu(&score, o.format, sing).map(|(e, f)| {
                    fit = f;
                    e
                })
            }
        };
        let enc = match enc {
            Ok(e) => e,
            Err(e) => {
                eprintln!("✗ {name}: 转 {} 失败：{}", o.format.id(), message_zh(&e));
                failed += 1;
                continue;
            }
        };
        let write = |dst: &Path| std::fs::write(dst, &enc.bytes).map_err(|e| format!("写不了 {}：{e}", dst.display()));
        match &o.out {
            Some(out) if out_is_dir => {
                let stem = f.file_stem().map_or_else(|| name.clone(), |s| s.to_string_lossy().into_owned());
                let dst = out.join(stem + o.format.ext());
                write(&dst)?;
                eprintln!("已写入 {}", dst.display());
            }
            Some(out) => {
                write(out)?;
                eprintln!("已写入 {}", out.display());
            }
            None => {
                let mut s = stdout.lock();
                if multi {
                    writeln!(s, "# ===== {name} =====").map_err(|e| e.to_string())?;
                }
                s.write_all(enc.text.as_bytes()).map_err(|e| e.to_string())?;
                if !enc.text.ends_with('\n') {
                    s.write_all(b"\n").map_err(|e| e.to_string())?;
                }
                s.flush().map_err(|e| e.to_string())?;
            }
        }
        if let Some(lc) = &lc {
            if lc.ocr_chars == 0 {
                eprintln!("[歌词核对] 没有识别到歌词，未核对");
            } else {
                summary(lc);
            }
            if let Some(p) = &o.lyrics_report {
                let j = serde_json::to_string_pretty(lc).map_err(|e| e.to_string())?;
                std::fs::write(p, j).map_err(|e| format!("写不了 {}：{e}", p.display()))?;
                eprintln!("已写入 {}", p.display());
            }
        }
        if let Some(f) = &fit {
            sing_summary(f);
        } else if ref_lyrics.is_some() && !staff && !o.no_sing && o.format != TargetFormat::J123 {
            eprintln!("[演唱顺序] 段落与 %%sing 只写进 123（-f 123）");
        }
        if o.profile {
            eprintln!("[OMR] {name} {} {ms}ms", if staff { "五线谱" } else { "简谱" });
        }
    }
    if n > 1 {
        let total = t0.elapsed().as_secs_f64();
        eprintln!("\n共 {n} 首，成功 {}，合计 {total:.1}s，平均 {:.0}ms/首（第一首含模型加载）", n - failed, total * 1000.0 / n as f64);
    }
    Ok(if failed > 0 { ExitCode::from(1) } else { ExitCode::SUCCESS })
}
