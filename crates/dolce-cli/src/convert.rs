//! `dolce convert <输入…|目录…> -f <格式> [-o <输出>] [选项…]`：
//! 乐谱格式互转（123 / ABC / jpwabc / 文本谱 / jianpu-ly / Muse jcx / MusicXML / MXL / MIDI）、
//! MIDI 导出（按演唱顺序展开、带声部轨名与逐遍歌词）与排版导出（矢量 PDF / 光栅 PNG / 独立 SVG / 矢量 PPTX）。
//! 复用编辑器同一套 Rust crate（模型、格式、播放、排版、导出），自包含、不依赖 Node。

use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

use dolce_engrave::Env;
use dolce_export::fonts::{Face, FontBook};
use dolce_export::pdf::DocInfo;
use dolce_export::pptx::{pptx as build_pptx, FontMetric, PptxInput};
use dolce_export::scene::{scene_pdf, ScenePage};
use dolce_formats::abc::lex::Dialect as AbcDialect;
use dolce_formats::abc::parse::parse_abc_family;
use dolce_formats::capability::TargetFormat;
use dolce_formats::fanqie::dialect::Dialect as FanqieDialect;
use dolce_formats::fanqie::parse::{parse_fanqie, ParseOptions as FanqieParseOptions};
use dolce_formats::jcxcodec::decode_jcx;
use dolce_formats::jly::fromjly::parse_jly;
use dolce_formats::jpw::file::JpwFile;
use dolce_formats::jpw::read::jpw_to_score_doc;
use dolce_formats::midi::import::{midi_to_score_doc, MidiGrid, MidiImportOptions};
use dolce_formats::targets::{message_zh, OUT_FORMATS};
use dolce_model::doc::ScoreDoc;
use dolce_model::fromxml::{load_score_doc, LoadedXml};
use dolce_model::toxml::{score_doc_to_music_xml, ToXmlOptions};
use dolce_model::xmlsurface::Surface;
use dolce_omr_source::pdf::PdfDoc;
use dolce_omr_todoc::reflyrics::decode_lyrics_bytes;
use dolce_play::midi::to_midi;
use dolce_play::timeline::PlayOptions;
use dolce_scene::smufl::MetaData;
use dolce_scene::svg::page_svg;
use dolce_scene::{Node, Page, Shape};
use dolce_session::layout::{
    engraved_music_xml, layout_jianpu_doc, layout_staff_doc, EngraveRequest, JianpuRequest, Laid, StaffRequest,
};
use dolce_style::cascade::{ctx, StyleRule};
use dolce_style::paper::{doc_page_layer, song_page_decl};
use dolce_style::staff::StaffPage;
use dolce_style::themes::{
    compute_style_for_paper, paper_size, staff_long_image_width, theme, ThemeId, LONG_IMAGE, PAGE_RATIOS,
    PAPER_WHITE, STAFF_PAPER_DEFAULT,
};
use dolce_text::native::NativeText;
use dolce_text::{BrowserCompat, Font, FontStyle, MeasureCtx, Weight};
use dolce_view::playsong::{play_source_of, PlaySongOptions};
use serde_json::{json, Value};

use dolce_text::assets::{BRAVURA_METADATA as BRAVURA_META, BRAVURA_OTF};

pub fn usage() -> String {
    let text_list = OUT_FORMATS
        .iter()
        .map(|f| format!("{}（{}）", f.id(), f.label()))
        .collect::<Vec<_>>()
        .join("、");
    format!(
        "  dolce convert <输入…|目录…> [-f 格式] [-o 输出] [选项…]
      格式转换、MIDI 导出与排版导出（支持 .123 / .abc / .jcx / .jpwabc / .jps / .jly / .musicxml / .mxl / .mid）
      格式（-f / --format，未指定时可从 -o 扩展名推断）：
        谱面：{text_list}
        音频：midi / mid（标准 MIDI，按演唱顺序展开、默认带声部名与逐遍歌词）
        排版：pdf（矢量 PDF）、png（光栅图）、svg（独立 SVG）、pptx（投影幻灯片）
      输入：--from=<格式> 手动指定输入格式；目录取里面支持的乐谱文件（不递归）；多文件时 -o 给目录
      排版：--view=auto|jianpu|expanded|staff|mixed（缺省 auto：五线谱/MIDI 走 staff，其余走 jianpu；pptx 固定 expanded）
            --paper=<纸名>（A4 / A5 / B5 / Letter / 150×216mm / 155×240mm / 长图 / long / 16:9 / 4:3）
            --landscape（横向）  --dpi=300 / --scale=N（PNG 分辨率）
            --source-breaks  --hide-bar-number  --jianpu-part=1（混排下方简谱声部，1 起）
            --no-layout（转 musicxml 时不附带五线谱版面坐标）
      MIDI：--song=1（多曲文件取第几首，1 起）  --tempo=BPM  --no-lyrics  --metronome  --midi-grid=16t|16|32
"
    )
}

/// 支持的输入格式
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InFormat {
    J123,
    Abc,
    Jcx,
    Jpwabc,
    FanqieAuto,
    Tomato,
    Shige,
    Jly,
    MusicXml,
    Mxl,
    Midi,
}

impl InFormat {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "123" | "j123" => Some(Self::J123),
            "abc" => Some(Self::Abc),
            "jcx" => Some(Self::Jcx),
            "jpwabc" | "jpw" => Some(Self::Jpwabc),
            "jps" | "fanqie" | "txt" => Some(Self::FanqieAuto),
            "tomato" => Some(Self::Tomato),
            "shige" => Some(Self::Shige),
            "jly" | "jianpu-ly" => Some(Self::Jly),
            "musicxml" | "xml" => Some(Self::MusicXml),
            "mxl" => Some(Self::Mxl),
            "mid" | "midi" => Some(Self::Midi),
            _ => None,
        }
    }

    pub fn from_path(path: &Path) -> Option<Self> {
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        Self::parse(&ext)
    }

    /// 是不是五线谱 / 绝对音高形状的源（决定 `--view=auto` 与 MIDI 展开口径）
    fn is_staff_source(self) -> bool {
        matches!(self, Self::MusicXml | Self::Mxl | Self::Midi)
    }
}

/// 目标输出格式：8 种谱面格式 + MIDI + 4 种排版格式
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutFormat {
    Score(TargetFormat),
    Midi,
    Pdf,
    Png,
    Svg,
    Pptx,
}

impl OutFormat {
    pub fn parse(s: &str) -> Option<Self> {
        let low = s.trim().to_ascii_lowercase();
        if let Some(t) = TargetFormat::parse(&low) {
            return Some(Self::Score(t));
        }
        match low.as_str() {
            "midi" | "mid" => Some(Self::Midi),
            "pdf" => Some(Self::Pdf),
            "png" => Some(Self::Png),
            "svg" => Some(Self::Svg),
            "pptx" => Some(Self::Pptx),
            _ => None,
        }
    }

    pub fn from_out_path(path: &Path) -> Option<Self> {
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        match ext.as_str() {
            "123" => Some(Self::Score(TargetFormat::J123)),
            "abc" => Some(Self::Score(TargetFormat::Abc)),
            "jpwabc" => Some(Self::Score(TargetFormat::Jpwabc)),
            "jly" => Some(Self::Score(TargetFormat::Jly)),
            "jcx" => Some(Self::Score(TargetFormat::Jcx)),
            "musicxml" | "xml" => Some(Self::Score(TargetFormat::MusicXml)),
            "mid" | "midi" => Some(Self::Midi),
            "pdf" => Some(Self::Pdf),
            "png" => Some(Self::Png),
            "svg" => Some(Self::Svg),
            "pptx" => Some(Self::Pptx),
            // .jps 有 tomato / shige 两种方言，不猜
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Score(t) => t.id(),
            Self::Midi => "midi",
            Self::Pdf => "pdf",
            Self::Png => "png",
            Self::Svg => "svg",
            Self::Pptx => "pptx",
        }
    }

    pub fn ext(self) -> &'static str {
        match self {
            Self::Score(t) => t.ext(),
            Self::Midi => ".mid",
            Self::Pdf => ".pdf",
            Self::Png => ".png",
            Self::Svg => ".svg",
            Self::Pptx => ".pptx",
        }
    }

    /// 是否必须落盘（二进制或非 UTF-8 编码，不适合直接打到 stdout）
    fn is_binary(self) -> bool {
        matches!(
            self,
            Self::Midi
                | Self::Pdf
                | Self::Png
                | Self::Pptx
                | Self::Score(TargetFormat::Jpwabc | TargetFormat::Jcx)
        )
    }
}

/// 排版档位
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ViewMode {
    Auto,
    Jianpu,
    Expanded,
    Staff,
    Mixed,
}

impl ViewMode {
    fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "auto" => Some(Self::Auto),
            "jianpu" | "original" => Some(Self::Jianpu),
            "expanded" | "projection" | "pptx" => Some(Self::Expanded),
            "staff" => Some(Self::Staff),
            "mixed" => Some(Self::Mixed),
            _ => None,
        }
    }
}

struct Opts {
    inputs: Vec<String>,
    from: Option<InFormat>,
    format: Option<OutFormat>,
    out: Option<PathBuf>,
    view: ViewMode,
    paper: Option<String>,
    landscape: bool,
    dpi: f64,
    scale: Option<f64>,
    song: usize, // 0-based
    tempo: Option<f64>,
    no_lyrics: bool,
    metronome: bool,
    no_layout: bool,
    source_breaks: bool,
    hide_bar_number: bool,
    jianpu_part: usize, // 0-based
    midi_grid: MidiGrid,
}

impl Default for Opts {
    fn default() -> Self {
        Self {
            inputs: Vec::new(),
            from: None,
            format: None,
            out: None,
            view: ViewMode::Auto,
            paper: None,
            landscape: false,
            dpi: 300.0,
            scale: None,
            song: 0,
            tempo: None,
            no_lyrics: false,
            metronome: false,
            no_layout: false,
            source_breaks: false,
            hide_bar_number: false,
            jianpu_part: 0,
            midi_grid: MidiGrid::Mixed,
        }
    }
}

fn parse_pos_f64(flag: &str, v: &str) -> Result<f64, String> {
    let n: f64 = v.parse().map_err(|_| format!("{flag} 需要数字，收到 {v}"))?;
    if !n.is_finite() || n <= 0.0 {
        return Err(format!("{flag} 必须大于 0，收到 {v}"));
    }
    Ok(n)
}

fn parse_one_based(flag: &str, v: &str) -> Result<usize, String> {
    let n: usize = v.parse().map_err(|_| format!("{flag} 需要正整数，收到 {v}"))?;
    if n == 0 {
        return Err(format!("{flag} 从 1 开始计数"));
    }
    Ok(n - 1)
}

fn parse_midi_grid(v: &str) -> Result<MidiGrid, String> {
    match v.trim().to_ascii_lowercase().as_str() {
        "16t" | "mixed" => Ok(MidiGrid::Mixed),
        "16" => Ok(MidiGrid::N16),
        "32" => Ok(MidiGrid::N32),
        _ => Err(format!("未知的 --midi-grid 值 {v}，可选：16t / 16 / 32")),
    }
}

fn parse_args(args: &[String]) -> Result<Option<Opts>, String> {
    let mut o = Opts::default();
    let mut it = args.iter();
    let need = |a: &str, v: Option<&String>| v.cloned().ok_or_else(|| format!("{a} 后面要跟值"));
    while let Some(a) = it.next() {
        match a.as_str() {
            "-h" | "--help" => return Ok(None),
            "-f" | "--format" => {
                let v = need(a, it.next())?;
                o.format = Some(OutFormat::parse(&v).ok_or_else(|| format!("未知目标格式 {v}"))?);
            }
            "-o" | "--out" => o.out = Some(need(a, it.next())?.into()),
            "--from" => {
                let v = need(a, it.next())?;
                o.from = Some(InFormat::parse(&v).ok_or_else(|| format!("未知输入格式 {v}"))?);
            }
            "--view" => {
                let v = need(a, it.next())?;
                o.view = ViewMode::parse(&v).ok_or_else(|| format!("未知档位 {v}，可选：auto / jianpu / expanded / staff / mixed"))?;
            }
            "--paper" => o.paper = Some(need(a, it.next())?),
            "--landscape" => o.landscape = true,
            "--dpi" => o.dpi = parse_pos_f64("--dpi", &need(a, it.next())?)?,
            "--scale" => o.scale = Some(parse_pos_f64("--scale", &need(a, it.next())?)?),
            "--song" => o.song = parse_one_based("--song", &need(a, it.next())?)?,
            "--tempo" => o.tempo = Some(parse_pos_f64("--tempo", &need(a, it.next())?)?),
            "--no-lyrics" => o.no_lyrics = true,
            "--metronome" => o.metronome = true,
            "--no-layout" => o.no_layout = true,
            "--source-breaks" => o.source_breaks = true,
            "--hide-bar-number" => o.hide_bar_number = true,
            "--jianpu-part" => o.jianpu_part = parse_one_based("--jianpu-part", &need(a, it.next())?)?,
            "--midi-grid" => o.midi_grid = parse_midi_grid(&need(a, it.next())?)?,
            _ if a.starts_with("--format=") => {
                let v = &a[9..];
                o.format = Some(OutFormat::parse(v).ok_or_else(|| format!("未知目标格式 {v}"))?);
            }
            _ if a.starts_with("--out=") => o.out = Some(a[6..].into()),
            _ if a.starts_with("--from=") => {
                let v = &a[7..];
                o.from = Some(InFormat::parse(v).ok_or_else(|| format!("未知输入格式 {v}"))?);
            }
            _ if a.starts_with("--view=") => {
                let v = &a[7..];
                o.view = ViewMode::parse(v).ok_or_else(|| format!("未知档位 {v}，可选：auto / jianpu / expanded / staff / mixed"))?;
            }
            _ if a.starts_with("--paper=") => o.paper = Some(a[8..].to_string()),
            _ if a.starts_with("--dpi=") => o.dpi = parse_pos_f64("--dpi", &a[6..])?,
            _ if a.starts_with("--scale=") => o.scale = Some(parse_pos_f64("--scale", &a[8..])?),
            _ if a.starts_with("--song=") => o.song = parse_one_based("--song", &a[7..])?,
            _ if a.starts_with("--tempo=") => o.tempo = Some(parse_pos_f64("--tempo", &a[8..])?),
            _ if a.starts_with("--jianpu-part=") => o.jianpu_part = parse_one_based("--jianpu-part", &a[14..])?,
            _ if a.starts_with("--midi-grid=") => o.midi_grid = parse_midi_grid(&a[12..])?,
            _ if a.starts_with('-') => return Err(format!("未知选项 {a}（dolce convert --help 看用法）")),
            _ => o.inputs.push(a.clone()),
        }
    }
    Ok(Some(o))
}

// ───────────────────────── 输入展开与解析 ─────────────────────────

fn expand_inputs(inputs: &[String], forced_from: Option<InFormat>) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    for raw in inputs {
        let p = Path::new(raw);
        if !p.exists() {
            return Err(format!("找不到输入路径：{}", p.display()));
        }
        if p.is_dir() {
            let mut entries: Vec<PathBuf> = std::fs::read_dir(p)
                .map_err(|e| format!("读不了目录 {}：{e}", p.display()))?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|f| {
                    let hidden = f.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with('.'));
                    f.is_file() && !hidden && (forced_from.is_some() || InFormat::from_path(f).is_some())
                })
                .collect();
            entries.sort();
            out.extend(entries);
        } else {
            out.push(p.to_path_buf());
        }
    }
    Ok(out)
}

/// 读入后的一份文档：语义模型 + 可选 MusicXML 表层与原文
struct LoadedDoc {
    format: InFormat,
    doc: ScoreDoc,
    surface: Option<Surface>,
    raw_xml: Option<String>,
}

/// 读字节 → 文本（UTF-8 / UTF-16LE / UTF-16BE / GBK 自动识别，复用歌词解码口径）
fn decode_text(bytes: &[u8]) -> String {
    decode_lyrics_bytes(bytes)
}

/// `.mxl`（压缩 MusicXML）解压取主 XML 文本
fn extract_mxl(bytes: &[u8]) -> Result<String, String> {
    let entries = read_zip_entries(bytes)?;
    // 1. 优先读 META-INF/container.xml 里的 rootfile full-path
    let root_path = entries
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("META-INF/container.xml"))
        .and_then(|(_, data)| parse_mxl_rootfile(&decode_text(data)));
    let xml_bytes = if let Some(rp) = root_path {
        entries
            .iter()
            .find(|(name, _)| name == &rp)
            .map(|(_, data)| data)
            .ok_or_else(|| format!(".mxl 里的 container.xml 指向 {rp}，但压缩包中找不到"))?
    } else {
        entries
            .iter()
            .find(|(name, _)| {
                let low = name.to_ascii_lowercase();
                !low.starts_with("meta-inf/") && (low.ends_with(".musicxml") || low.ends_with(".xml"))
            })
            .map(|(_, data)| data)
            .ok_or_else(|| ".mxl 压缩包里找不到 MusicXML 文件".to_string())?
    };
    Ok(decode_text(xml_bytes))
}

fn parse_mxl_rootfile(container_xml: &str) -> Option<String> {
    let rest = container_xml.split("<rootfile").nth(1)?;
    let tag_end = rest.find('>')?;
    let attrs = &rest[..tag_end];
    for q in ['"', '\''] {
        let pat = format!("full-path={q}");
        if let Some(i) = attrs.find(&pat) {
            let tail = &attrs[i + pat.len()..];
            if let Some(j) = tail.find(q) {
                return Some(tail[..j].to_string());
            }
        }
    }
    None
}

/// 轻量 ZIP 读取（支持 Stored=0 与 Deflate=8，只用于 .mxl）
fn read_zip_entries(data: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let u16le = |off: usize| -> Result<u16, String> {
        let b: [u8; 2] = data.get(off..off + 2).ok_or("ZIP 文件截断")?.try_into().unwrap();
        Ok(u16::from_le_bytes(b))
    };
    let u32le = |off: usize| -> Result<u32, String> {
        let b: [u8; 4] = data.get(off..off + 4).ok_or("ZIP 文件截断")?.try_into().unwrap();
        Ok(u32::from_le_bytes(b))
    };

    if data.len() < 22 {
        return Err("不是有效的 .mxl（ZIP 文件过短）".into());
    }
    let min_eocd = data.len().saturating_sub(22 + 65535);
    let eocd = (min_eocd..=data.len() - 22)
        .rev()
        .find(|&i| data[i..i + 4] == [0x50, 0x4b, 0x05, 0x06])
        .ok_or("不是有效的 .mxl（找不到 ZIP 目录尾）")?;
    let total = u16le(eocd + 10)? as usize;
    let cd_off = u32le(eocd + 16)? as usize;

    let mut pos = cd_off;
    let mut out = Vec::with_capacity(total);
    for _ in 0..total {
        if data.get(pos..pos + 4) != Some(&[0x50, 0x4b, 0x01, 0x02]) {
            return Err("ZIP 中央目录损坏".into());
        }
        let method = u16le(pos + 10)?;
        let comp_size = u32le(pos + 20)? as usize;
        let name_len = u16le(pos + 28)? as usize;
        let extra_len = u16le(pos + 30)? as usize;
        let comment_len = u16le(pos + 32)? as usize;
        let local_off = u32le(pos + 42)? as usize;
        let name_bytes = data.get(pos + 46..pos + 46 + name_len).ok_or("ZIP 文件名越界")?;
        let name = String::from_utf8_lossy(name_bytes).into_owned();
        pos += 46 + name_len + extra_len + comment_len;

        if name.ends_with('/') {
            continue;
        }
        if data.get(local_off..local_off + 4) != Some(&[0x50, 0x4b, 0x03, 0x04]) {
            return Err(format!("ZIP 本地文件头损坏（{name}）"));
        }
        let l_name_len = u16le(local_off + 26)? as usize;
        let l_extra_len = u16le(local_off + 28)? as usize;
        let start = local_off + 30 + l_name_len + l_extra_len;
        let comp = data.get(start..start + comp_size).ok_or("ZIP 数据段越界")?;
        let raw = match method {
            0 => comp.to_vec(),
            8 => {
                let mut dec = flate2::read::DeflateDecoder::new(comp);
                let mut buf = Vec::new();
                dec.read_to_end(&mut buf).map_err(|e| format!("解压 .mxl 里的 {name} 失败：{e}"))?;
                buf
            }
            m => return Err(format!(".mxl 里的 {name} 使用了不支持的压缩方式 {m}")),
        };
        out.push((name, raw));
    }
    Ok(out)
}

fn load_input(path: &Path, forced: Option<InFormat>, midi_grid: MidiGrid) -> Result<LoadedDoc, String> {
    let format = forced
        .or_else(|| InFormat::from_path(path))
        .ok_or_else(|| format!("认不出 {} 的格式，请用 --from 指定", path.display()))?;
    let bytes = std::fs::read(path).map_err(|e| format!("读不了 {}：{e}", path.display()))?;
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    load_bytes(&bytes, format, stem, midi_grid)
}

fn load_bytes(bytes: &[u8], format: InFormat, title_hint: &str, midi_grid: MidiGrid) -> Result<LoadedDoc, String> {
    match format {
        InFormat::J123 => {
            let text = decode_text(bytes);
            let doc = parse_abc_family(&text, AbcDialect::J123);
            Ok(LoadedDoc { format, doc, surface: None, raw_xml: None })
        }
        InFormat::Abc => {
            let text = decode_text(bytes);
            let doc = parse_abc_family(&text, AbcDialect::Abc);
            Ok(LoadedDoc { format, doc, surface: None, raw_xml: None })
        }
        InFormat::Jcx => {
            let text = decode_jcx(bytes);
            let doc = parse_abc_family(&text, AbcDialect::Jcx);
            Ok(LoadedDoc { format, doc, surface: None, raw_xml: None })
        }
        InFormat::Jpwabc => {
            let text = decode_text(bytes);
            let f = JpwFile::from_str(&text).ok_or_else(|| "无法解析 .jpwabc 文件".to_string())?;
            let doc = jpw_to_score_doc(&f).map_err(|e| format!("解析 .jpwabc 失败：{e:?}"))?;
            Ok(LoadedDoc { format, doc, surface: None, raw_xml: None })
        }
        InFormat::FanqieAuto | InFormat::Tomato | InFormat::Shige => {
            let text = decode_text(bytes);
            let dialect = match format {
                InFormat::Tomato => Some(FanqieDialect::Tomato),
                InFormat::Shige => Some(FanqieDialect::Shige),
                _ => None,
            };
            let doc = parse_fanqie(&text, FanqieParseOptions { dialect });
            Ok(LoadedDoc { format, doc, surface: None, raw_xml: None })
        }
        InFormat::Jly => {
            let text = decode_text(bytes);
            let doc = parse_jly(&text).doc;
            Ok(LoadedDoc { format, doc, surface: None, raw_xml: None })
        }
        InFormat::MusicXml => {
            let xml = decode_text(bytes);
            let mut loaded = load_score_doc(&xml).map_err(|e| message_zh(&e.key).into_owned())?;
            loaded.doc.source = None;
            Ok(LoadedDoc { format, doc: loaded.doc, surface: Some(loaded.surface), raw_xml: Some(xml) })
        }
        InFormat::Mxl => {
            let xml = extract_mxl(bytes)?;
            let mut loaded = load_score_doc(&xml).map_err(|e| message_zh(&e.key).into_owned())?;
            loaded.doc.source = None;
            Ok(LoadedDoc { format, doc: loaded.doc, surface: Some(loaded.surface), raw_xml: Some(xml) })
        }
        InFormat::Midi => {
            let opts = MidiImportOptions { grid: midi_grid, fifths: None, beats: None, beat_type: None };
            let res = midi_to_score_doc(bytes, title_hint, &opts).map_err(|m| format!("导入 MIDI 失败：{}", message_zh(&m.key)))?;
            Ok(LoadedDoc { format, doc: res.doc, surface: None, raw_xml: None })
        }
    }
}

// ───────────────────────── 排版环境与资源（按需延迟初始化）─────────────────────────

/// 找 Bravura.otf 所在目录（供原生量字器注册）：
/// 1) 可执行文件同目录；2) 可执行文件旁 `fonts/`；3) 开发检出 `public/redist/`
fn find_redist_dir() -> Option<PathBuf> {
    let has_bravura = |d: &Path| d.join("Bravura.otf").is_file();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if has_bravura(dir) {
                return Some(dir.to_path_buf());
            }
            let fonts = dir.join("fonts");
            if has_bravura(&fonts) {
                return Some(fonts);
            }
        }
    }
    let dev = crate::checkout("public/redist");
    if has_bravura(&dev) {
        return Some(dev);
    }
    None
}

struct RenderResources {
    backend: Box<BrowserCompat<NativeText>>,
    meta: MetaData,
    font_book: Option<FontBook>,
    bravura_face: Option<Face>,
}

impl RenderResources {
    fn new() -> Self {
        let redist = find_redist_dir();
        let backend = Box::new(dolce_text::native::webview_measure(redist.as_deref(), &[]));
        let meta = MetaData::from_json(BRAVURA_META).expect("内嵌 bravura_metadata.json 应合法");
        Self { backend, meta, font_book: None, bravura_face: None }
    }

    fn with_env<R>(&self, f: impl FnOnce(&Env<'_>) -> R) -> R {
        let mc = MeasureCtx::new(&*self.backend);
        let env = Env { mc: &mc, meta: Some(&self.meta) };
        f(&env)
    }

    fn font_book(&mut self) -> Result<&FontBook, String> {
        if self.font_book.is_none() {
            let mut book = FontBook::system();
            match find_redist_dir() {
                Some(dir) => book.add_file(&dir.join("Bravura.otf")).map_err(|e| format!("载入 Bravura.otf 失败：{e}"))?,
                None => book.add_bytes("Bravura.otf".into(), BRAVURA_OTF.to_vec()),
            }
            self.font_book = Some(book);
        }
        Ok(self.font_book.as_ref().unwrap())
    }

    fn bravura_face(&mut self) -> Result<&Face, String> {
        if self.bravura_face.is_none() {
            let face = Face::parse(Arc::new(BRAVURA_OTF.to_vec()), 0, "Bravura.otf".into())
                .ok_or_else(|| "解析内嵌 Bravura.otf 失败".to_string())?;
            self.bravura_face = Some(face);
        }
        Ok(self.bravura_face.as_ref().unwrap())
    }
}

// ───────────────────────── 纸张、样式与排版 ─────────────────────────

fn normalize_paper_name(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    if t.eq_ignore_ascii_case("long") || t == LONG_IMAGE {
        return Ok(LONG_IMAGE.to_string());
    }
    if let Some((k, _)) = PAGE_RATIOS.iter().find(|(k, _)| k.eq_ignore_ascii_case(t)) {
        return Ok((*k).to_string());
    }
    // 标准纸名不区分大小写，并兼容 x / ×
    let canonical = t.replace(['x', 'X'], "×");
    for name in dolce_style::themes::paper_names() {
        if name.eq_ignore_ascii_case(&canonical) {
            return Ok(name.to_string());
        }
    }
    Err(format!(
        "不认识的纸张 {raw}，可选：{} / 16:9 / 4:3 / long",
        dolce_style::themes::paper_names().join(" / ")
    ))
}

fn page_rule_for(paper: &str, landscape: bool) -> Result<StyleRule, String> {
    let norm = normalize_paper_name(paper)?;
    if let Some((_, (w, h))) = PAGE_RATIOS.iter().find(|(k, _)| *k == norm) {
        return Ok(StyleRule { when: None, set: json!({ "page": { "size": [w, h] } }) });
    }
    let mut page = json!({ "paper": norm });
    if norm != LONG_IMAGE {
        page["orientation"] = Value::String(if landscape { "landscape" } else { "portrait" }.into());
    }
    Ok(StyleRule { when: None, set: json!({ "page": page }) })
}

fn staff_page_for(paper: &str, landscape: bool) -> Result<StaffPage, String> {
    let norm = normalize_paper_name(paper)?;
    if norm == LONG_IMAGE {
        return Ok(StaffPage {
            width_pt: staff_long_image_width(),
            height_pt: None,
            margins_pt: None,
            r#override: Some(true),
        });
    }
    if let Some((_, (w, h))) = PAGE_RATIOS.iter().find(|(k, _)| *k == norm) {
        return Ok(StaffPage { width_pt: *w, height_pt: Some(*h), margins_pt: None, r#override: Some(true) });
    }
    match paper_size(&norm) {
        Some(Some((a, b))) => {
            let (w, h) = if landscape == (a > b) { (a, b) } else { (b, a) };
            Ok(StaffPage { width_pt: w, height_pt: Some(h), margins_pt: None, r#override: Some(true) })
        }
        _ => Err(format!("五线谱不支持纸张 {paper}")),
    }
}

fn effective_view(requested: ViewMode, out_fmt: OutFormat, in_fmt: InFormat) -> ViewMode {
    if out_fmt == OutFormat::Pptx {
        return ViewMode::Expanded;
    }
    match requested {
        ViewMode::Auto => {
            if in_fmt.is_staff_source() {
                ViewMode::Staff
            } else {
                ViewMode::Jianpu
            }
        }
        other => other,
    }
}

fn layout_for_export(
    loaded: &LoadedDoc,
    out_fmt: OutFormat,
    o: &Opts,
    res: &RenderResources,
) -> Result<Laid, String> {
    let view = effective_view(o.view, out_fmt, loaded.format);
    match view {
        ViewMode::Jianpu | ViewMode::Expanded => {
            let expanded = view == ViewMode::Expanded;
            let base = theme(if expanded { ThemeId::Projection } else { ThemeId::Print });
            let mut extra_layers: Vec<Vec<StyleRule>> = Vec::new();
            if !expanded {
                let doc_rules = doc_page_layer(loaded.doc.songs.first());
                if !doc_rules.is_empty() {
                    extra_layers.push(doc_rules);
                }
            }
            if let Some(p) = &o.paper {
                extra_layers.push(vec![page_rule_for(p, o.landscape)?]);
            } else if !expanded && out_fmt == OutFormat::Pdf && loaded.doc.songs.first().and_then(song_page_decl).is_none() {
                // PDF 分页阅读：简谱未指定纸张且谱内无纸张声明时默认用 A4（长图可用 --paper=长图）
                extra_layers.push(vec![page_rule_for("A4", o.landscape)?]);
            } else if o.landscape && !expanded {
                extra_layers.push(vec![StyleRule {
                    when: None,
                    set: json!({ "page": { "orientation": "landscape" } }),
                }]);
            }
            let mut layer_refs: Vec<&[StyleRule]> = Vec::with_capacity(1 + extra_layers.len());
            layer_refs.push(base);
            for l in &extra_layers {
                layer_refs.push(l.as_slice());
            }
            let mode = if expanded { "expanded" } else { "original" };
            let sheet = compute_style_for_paper(&layer_refs, &ctx(&[("mode", Value::String(mode.into())), ("engine", Value::String("jianpu".into()))]));
            let req = JianpuRequest {
                view: mode.into(),
                style: Some(sheet.0),
                no_reflow: false,
                break_desc: None,
                page: None,
                snippet: false,
                ink: None,
                layout: None,
            };
            res.with_env(|env| layout_jianpu_doc(&loaded.doc, &req, env))
        }
        ViewMode::Staff | ViewMode::Mixed => {
            let mode = if view == ViewMode::Mixed { "mixed" } else { "staff" };
            let page = match &o.paper {
                Some(p) => Some(staff_page_for(p, o.landscape)?),
                None if o.landscape => Some(staff_page_for(STAFF_PAPER_DEFAULT, true)?),
                None => None,
            };
            let req = StaffRequest {
                view: mode.into(),
                style: None,
                page,
                hide_bar_number: o.hide_bar_number,
                jianpu_part: o.jianpu_part,
                source_breaks: o.source_breaks,
            };
            if loaded.format.is_staff_source() {
                res.with_env(|env| layout_staff_doc(&loaded.doc, loaded.surface.as_ref(), &req, env))
            } else {
                let proj = project_to_staff(&loaded.doc)?;
                res.with_env(|env| layout_staff_doc(&proj.doc, Some(&proj.surface), &req, env))
            }
        }
        ViewMode::Auto => unreachable!(),
    }
}

/// 非 MusicXML 形状（123 / 文本谱 / jpwabc / jly / abc / jcx）先投成 MusicXML 再读回，五线谱引擎与版面坐标都吃这份
/// （同编辑器 `_ensureMixedDoc` / `sourceMusicXml`）
fn project_to_staff(doc: &ScoreDoc) -> Result<LoadedXml, String> {
    let xml = score_doc_to_music_xml(doc, None, &ToXmlOptions::default()).map_err(|e| message_zh(&e.key).into_owned())?;
    let mut proj = load_score_doc(&xml).map_err(|e| message_zh(&e.key).into_owned())?;
    proj.doc.source = None;
    Ok(proj)
}

// ───────────────────────── 各类导出实现 ─────────────────────────

/// 导出 MIDI（与编辑器 `App::playable` + `exportMidi` 同口径）
fn export_midi(loaded: &LoadedDoc, o: &Opts) -> Result<Vec<u8>, String> {
    if loaded.doc.songs.is_empty() {
        return Err("这份文档里没有曲子".into());
    }
    let n = loaded.doc.songs.len();
    if o.song >= n {
        return Err(format!("--song={} 超出范围：这份文档只有 {n} 首", o.song + 1));
    }
    let song = o.song;
    let for_expanded = !loaded.format.is_staff_source() && loaded.format != InFormat::Jpwabc;
    let Some((mut src, _pd)) = play_source_of(&loaded.doc, song, PlaySongOptions { for_expanded }).map_err(|e| e.0)? else {
        return Err("没有可导出的曲行".into());
    };
    if let Some(bpm) = o.tempo {
        src.play_data.tempo = bpm;
    }
    if o.no_lyrics {
        for p in &mut src.parts {
            for m in p.measures.iter_mut().flatten() {
                for c in &mut m.chords {
                    for n in &mut c.notes {
                        n.lyrics.clear();
                    }
                }
            }
        }
    }
    let opts = if o.metronome {
        Some(PlayOptions { part_volumes: None, metronome: Some(true), speed: None })
    } else {
        None
    };
    // 注意：`to_midi` 第三参 `click` 为 true 时不写歌词；只在显式要求 --metronome 时传 true
    Ok(to_midi(&src, opts.as_ref(), o.metronome))
}

/// 排版结果 → 矢量 PDF 字节
fn laid_to_pdf(laid: &Laid, res: &mut RenderResources) -> Result<Vec<u8>, String> {
    let pages: Vec<ScenePage> = laid
        .pages
        .iter()
        .zip(&laid.geom)
        .map(|(scene, g)| ScenePage {
            scene: scene.clone(),
            w_pt: g.w * g.pt_per_unit,
            h_pt: g.h * g.pt_per_unit,
        })
        .collect();
    if pages.is_empty() {
        return Err("排版结果为空（没有可导出的页面）".into());
    }
    let title = (!laid.title.trim().is_empty()).then(|| laid.title.clone());
    let info = DocInfo { title, outline: Vec::new() };
    let book = res.font_book()?;
    let (bytes, _report) = scene_pdf(book, &pages, None, &info)?;
    Ok(bytes)
}

/// 矢量 PDF 字节 → 各页 PNG 字节（PDFium 光栅化 + PNG 编码）
fn pdf_to_pngs(pdf_bytes: Vec<u8>, scale: f64) -> Result<Vec<Vec<u8>>, String> {
    let doc = PdfDoc::open(pdf_bytes)?;
    let n = doc.page_count();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let r = doc.render(i, scale)?;
        let img = image::RgbaImage::from_raw(r.w as u32, r.h as u32, r.rgba)
            .ok_or_else(|| format!("第 {} 页渲染缓冲尺寸不匹配", i + 1))?;
        let mut buf = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .map_err(|e| format!("编码第 {} 页 PNG 失败：{e}", i + 1))?;
        out.push(buf);
    }
    Ok(out)
}

/// 排版结果 → 各页独立 SVG 字符串（补齐 xmlns 与 pt 宽高）
fn laid_to_svgs(laid: &Laid) -> Result<Vec<String>, String> {
    if laid.pages.is_empty() {
        return Err("排版结果为空（没有可导出的页面）".into());
    }
    Ok(laid
        .pages
        .iter()
        .zip(&laid.geom)
        .map(|(p, g)| {
            let raw = page_svg(p);
            let w = g.w * g.pt_per_unit;
            let h = g.h * g.pt_per_unit;
            raw.replacen("<svg ", &format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{h}\" "), 1)
        })
        .collect())
}

/// 收集场景中所有文字节点用到的字体度量（供 PPTX 文本框高度计算，与 `src/editor/pptxexport.ts` 同口径）
fn collect_font_metrics(pages: &[Page], mc: &MeasureCtx<'_>) -> Vec<FontMetric> {
    let mut seen: HashSet<(String, u64, bool, bool)> = HashSet::new();
    let mut metrics = Vec::new();
    fn walk(n: &Node, seen: &mut HashSet<(String, u64, bool, bool)>, mc: &MeasureCtx<'_>, out: &mut Vec<FontMetric>) {
        if let Shape::Text(t) = &n.shape {
            let key = (t.font.family.clone(), t.font.size.to_bits(), t.font.bold, t.font.italic);
            if seen.insert(key) {
                let w = if t.font.bold { Weight::Bold } else { Weight::Normal };
                let s = if t.font.italic { FontStyle::Italic } else { FontStyle::Normal };
                let fm = mc.font_metrics(&t.font.family, t.font.size, w, s);
                out.push(FontMetric {
                    font: Font {
                        family: t.font.family.clone(),
                        size: t.font.size,
                        bold: t.font.bold,
                        italic: t.font.italic,
                    },
                    ascent: fm.ascent,
                    descent: fm.descent,
                });
            }
        }
        for c in &n.k {
            walk(c, seen, mc, out);
        }
    }
    for p in pages {
        if let Some(root) = &p.root {
            walk(root, &mut seen, mc, &mut metrics);
        }
    }
    metrics
}

/// 投影档排版结果 → `.pptx` 字节
fn laid_to_pptx(laid: &Laid, res: &mut RenderResources) -> Result<Vec<u8>, String> {
    if laid.pages.is_empty() {
        return Err("排版结果为空（没有可导出的幻灯片）".into());
    }
    let g0 = laid.geom[0];
    let stack_gap = laid.jianpu.as_ref().map_or(0.17, |j| j.metrics.style.vertical.stack_gap);
    let metrics = res.with_env(|env| collect_font_metrics(&laid.pages, env.mc));
    let input = PptxInput {
        pages: laid.pages.clone(),
        stack_gap,
        page_width: g0.w * g0.pt_per_unit,
        page_height: g0.h * g0.pt_per_unit,
        bg: PAPER_WHITE,
        metrics,
    };
    let face = res.bravura_face()?;
    Ok(build_pptx(&input, face))
}

/// 写谱面文本格式（转 MusicXML 时默认附带五线谱版面坐标）
fn export_score_format(
    loaded: &LoadedDoc,
    target: TargetFormat,
    o: &Opts,
    res: &mut Option<RenderResources>,
) -> Result<(String, Vec<u8>), String> {
    if target == TargetFormat::MusicXml {
        // 原文件就是 MusicXML：原文直出，保留全部表层细节
        if matches!(loaded.format, InFormat::MusicXml | InFormat::Mxl) {
            if let Some(raw) = &loaded.raw_xml {
                let enc = target.encode(raw.clone());
                return Ok((enc.text, enc.bytes));
            }
        }
        if !o.no_layout {
            let r = res.get_or_insert_with(RenderResources::new);
            let page = match &o.paper {
                Some(p) => Some(staff_page_for(p, o.landscape)?),
                None => None,
            };
            let req = EngraveRequest { page, source_breaks: o.source_breaks };
            let xml = if loaded.format.is_staff_source() {
                r.with_env(|env| engraved_music_xml(&loaded.doc, loaded.surface.as_ref(), &req, env))
            } else {
                let proj = project_to_staff(&loaded.doc)?;
                r.with_env(|env| engraved_music_xml(&proj.doc, Some(&proj.surface), &req, env))
            }
            .map_err(|e| message_zh(&e).into_owned())?;
            let enc = target.encode(xml);
            return Ok((enc.text, enc.bytes));
        }
    }
    let enc = target
        .write(&loaded.doc, loaded.surface.as_ref())
        .map_err(|e| message_zh(&e).into_owned())?;
    Ok((enc.text, enc.bytes))
}

// ───────────────────────── 落盘路径与主入口 ─────────────────────────

/// 多页产物路径：单页直接 `base`，多页加 `-1` / `-2` … 后缀
fn paged_path(base: &Path, page_index: usize, total: usize) -> PathBuf {
    if total <= 1 {
        return base.to_path_buf();
    }
    let stem = base.file_stem().and_then(|s| s.to_str()).unwrap_or("page");
    let ext = base.extension().and_then(|s| s.to_str()).unwrap_or("");
    let file_name = if ext.is_empty() {
        format!("{stem}-{}", page_index + 1)
    } else {
        format!("{stem}-{}.{ext}", page_index + 1)
    };
    match base.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.join(file_name),
        _ => PathBuf::from(file_name),
    }
}

/// 写一个产物并报到 stderr
fn write_out(dst: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(dst, bytes).map_err(|e| format!("写不了 {}：{e}", dst.display()))?;
    eprintln!("已写入 {}", dst.display());
    Ok(())
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(p) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(p).map_err(|e| format!("建不了目录 {}：{e}", p.display()))?;
    }
    Ok(())
}

pub fn run(args: &[String]) -> Result<ExitCode, String> {
    let Some(o) = parse_args(args)? else {
        eprintln!("用法：\n{}", usage());
        return Ok(ExitCode::SUCCESS);
    };
    if o.inputs.is_empty() {
        eprintln!("用法：\n{}", usage());
        return Ok(ExitCode::from(1));
    }

    let out_fmt = o
        .format
        .or_else(|| o.out.as_deref().and_then(OutFormat::from_out_path))
        .ok_or_else(|| "请用 -f 指定目标格式（或通过 -o 的扩展名指定）".to_string())?;

    let any_dir = o.inputs.iter().any(|p| Path::new(p).is_dir());
    let files = expand_inputs(&o.inputs, o.from)?;
    if files.is_empty() {
        return Err("没有找到可转换的乐谱文件".into());
    }
    let multi = o.inputs.len() > 1 || any_dir || files.len() > 1;
    // 以 / 或 \ 结尾的 -o 即使还不存在也当目录
    let out_is_dir = o.out.as_ref().is_some_and(|out| {
        let s = out.as_os_str().to_string_lossy();
        multi || out.is_dir() || s.ends_with('/') || s.ends_with('\\')
    });

    if out_fmt.is_binary() && o.out.is_none() {
        return Err(format!("导出 {} 需要用 -o 指定输出{}", out_fmt.id(), if multi { "目录" } else { "文件" }));
    }
    if let Some(out) = &o.out {
        if out_is_dir {
            std::fs::create_dir_all(out).map_err(|e| format!("建不了目录 {}：{e}", out.display()))?;
        } else {
            ensure_parent(out)?;
        }
    }

    let mut res: Option<RenderResources> = None;
    let stdout = std::io::stdout();
    let mut failed = 0usize;
    // 出目录里已占用的产物名（a.123 与 a.abc 都会写成 a.<ext>，后一个不覆盖前一个）
    let mut taken: HashSet<PathBuf> = HashSet::new();

    for f in &files {
        let name = f.file_name().map_or_else(|| f.display().to_string(), |s| s.to_string_lossy().into_owned());
        let loaded = match load_input(f, o.from, o.midi_grid) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("✗ {name}: {e}");
                failed += 1;
                continue;
            }
        };
        let stem = f.file_stem().map_or_else(|| name.clone(), |s| s.to_string_lossy().into_owned());
        let target_base = o.out.as_ref().map(|out| {
            if out_is_dir {
                out.join(format!("{stem}{}", out_fmt.ext()))
            } else {
                out.clone()
            }
        });
        if let Some(dst) = target_base.as_ref().filter(|_| out_is_dir) {
            if !taken.insert(dst.clone()) {
                eprintln!("✗ {name}: 产物 {} 与前面的输入同名，跳过（分开放目录或改名再转）", dst.display());
                failed += 1;
                continue;
            }
        }

        let result: Result<(), String> = match out_fmt {
            OutFormat::Score(tf) => {
                export_score_format(&loaded, tf, &o, &mut res).and_then(|(text, bytes)| match &target_base {
                    Some(dst) => write_out(dst, &bytes),
                    None => {
                        let mut s = stdout.lock();
                        if multi {
                            writeln!(s, "# ===== {name} =====").map_err(|e| e.to_string())?;
                        }
                        s.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
                        if !text.ends_with('\n') {
                            s.write_all(b"\n").map_err(|e| e.to_string())?;
                        }
                        s.flush().map_err(|e| e.to_string())
                    }
                })
            }
            OutFormat::Midi => export_midi(&loaded, &o).and_then(|bytes| write_out(target_base.as_ref().unwrap(), &bytes)),
            OutFormat::Pdf => {
                let r = res.get_or_insert_with(RenderResources::new);
                layout_for_export(&loaded, out_fmt, &o, r)
                    .and_then(|laid| laid_to_pdf(&laid, r))
                    .and_then(|bytes| write_out(target_base.as_ref().unwrap(), &bytes))
            }
            OutFormat::Png => {
                let r = res.get_or_insert_with(RenderResources::new);
                let scale = o.scale.unwrap_or(o.dpi / 72.0);
                layout_for_export(&loaded, out_fmt, &o, r)
                    .and_then(|laid| laid_to_pdf(&laid, r))
                    .and_then(|pdf| pdf_to_pngs(pdf, scale))
                    .and_then(|pngs| {
                        let base = target_base.as_ref().unwrap();
                        let total = pngs.len();
                        pngs.iter().enumerate().try_for_each(|(i, bytes)| write_out(&paged_path(base, i, total), bytes))
                    })
            }
            OutFormat::Svg => {
                let r = res.get_or_insert_with(RenderResources::new);
                layout_for_export(&loaded, out_fmt, &o, r)
                    .and_then(|laid| laid_to_svgs(&laid))
                    .and_then(|svgs| match &target_base {
                        Some(base) => {
                            let total = svgs.len();
                            svgs.iter().enumerate().try_for_each(|(i, svg)| write_out(&paged_path(base, i, total), svg.as_bytes()))
                        }
                        None => {
                            let mut s = stdout.lock();
                            for (i, svg) in svgs.iter().enumerate() {
                                if multi || svgs.len() > 1 {
                                    writeln!(s, "<!-- ===== {name} 第 {} 页 ===== -->", i + 1).map_err(|e| e.to_string())?;
                                }
                                s.write_all(svg.as_bytes()).map_err(|e| e.to_string())?;
                                s.write_all(b"\n").map_err(|e| e.to_string())?;
                            }
                            s.flush().map_err(|e| e.to_string())
                        }
                    })
            }
            OutFormat::Pptx => {
                let r = res.get_or_insert_with(RenderResources::new);
                layout_for_export(&loaded, out_fmt, &o, r)
                    .and_then(|laid| laid_to_pptx(&laid, r))
                    .and_then(|bytes| write_out(target_base.as_ref().unwrap(), &bytes))
            }
        };

        if let Err(e) = result {
            eprintln!("✗ {name}: 转 {} 失败：{e}", out_fmt.id());
            failed += 1;
        }
    }

    if files.len() > 1 {
        eprintln!("\n共 {} 首，成功 {}，失败 {failed}", files.len(), files.len() - failed);
    }
    Ok(if failed > 0 { ExitCode::from(1) } else { ExitCode::SUCCESS })
}

#[cfg(test)]
mod tests {
    use super::*;
    use dolce_formats::midi::smf::parse_smf;

    const SAMPLE_123: &str = "T:小星星\nK:1=C\nM:4/4\nQ:1/4=100\n1 1 5 5 | 6 6 5 - | 4 4 3 3 | 2 2 1 - |\nw:一 闪 一 闪 亮 晶 晶 满 天 都 是 小 星 星\n";

    #[test]
    fn parse_format_and_infer() {
        assert_eq!(OutFormat::parse("midi"), Some(OutFormat::Midi));
        assert_eq!(OutFormat::parse("mid"), Some(OutFormat::Midi));
        assert_eq!(OutFormat::parse("PDF"), Some(OutFormat::Pdf));
        assert_eq!(OutFormat::parse("pptx"), Some(OutFormat::Pptx));
        assert_eq!(OutFormat::parse("123"), Some(OutFormat::Score(TargetFormat::J123)));
        assert_eq!(OutFormat::from_out_path(Path::new("a/b.pdf")), Some(OutFormat::Pdf));
        assert_eq!(OutFormat::from_out_path(Path::new("a/b.mid")), Some(OutFormat::Midi));
        assert_eq!(OutFormat::from_out_path(Path::new("a/b.jps")), None);
        assert_eq!(paged_path(Path::new("/tmp/a.png"), 0, 1), PathBuf::from("/tmp/a.png"));
        assert_eq!(paged_path(Path::new("/tmp/a.png"), 1, 3), PathBuf::from("/tmp/a-2.png"));
    }

    #[test]
    fn convert_123_to_all_text_formats() {
        let loaded = load_bytes(SAMPLE_123.as_bytes(), InFormat::J123, "star", MidiGrid::Mixed).unwrap();
        let o = Opts { no_layout: true, ..Opts::default() };
        let mut res = None;
        for tf in OUT_FORMATS {
            let (text, bytes) = export_score_format(&loaded, tf, &o, &mut res)
                .unwrap_or_else(|e| panic!("导出 {} 失败：{e}", tf.id()));
            assert!(!text.trim().is_empty(), "{} 文本为空", tf.id());
            assert!(!bytes.is_empty(), "{} 字节为空", tf.id());
        }
    }

    #[test]
    fn convert_123_to_midi_and_roundtrip() {
        let loaded = load_bytes(SAMPLE_123.as_bytes(), InFormat::J123, "star", MidiGrid::Mixed).unwrap();
        let o = Opts::default();
        let midi = export_midi(&loaded, &o).unwrap();
        assert_eq!(&midi[..4], b"MThd");
        // 回读验证合法 SMF
        let smf = parse_smf(&midi).unwrap();
        assert!(smf.tracks.len() >= 2);
        // 含歌词事件（FF 05）
        assert!(midi.windows(2).any(|w| w == [0xff, 0x05]));

        // --no-lyrics 不写歌词事件
        let o_no_ly = Opts { no_lyrics: true, tempo: Some(120.0), ..Opts::default() };
        let midi2 = export_midi(&loaded, &o_no_ly).unwrap();
        assert!(!midi2.windows(2).any(|w| w == [0xff, 0x05]));

        // --song 超出范围报错，不悄悄换成最后一首
        let o_song = Opts { song: 1, ..Opts::default() };
        assert!(export_midi(&loaded, &o_song).unwrap_err().contains("--song=2"));
    }

    #[test]
    fn dir_inputs_skip_hidden_files() {
        let dir = std::env::temp_dir().join(format!("dolce-convert-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.123"), SAMPLE_123).unwrap();
        std::fs::write(dir.join(".DS_Store"), b"\0").unwrap();
        let d = dir.to_string_lossy().into_owned();
        let got = expand_inputs(&[d], Some(InFormat::J123)).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(got, vec![dir.join("a.123")]);
    }

    #[test]
    fn mxl_extract_and_parse() {
        // 用 flate2 构造最小 .mxl ZIP
        let loaded = load_bytes(SAMPLE_123.as_bytes(), InFormat::J123, "star", MidiGrid::Mixed).unwrap();
        let xml = score_doc_to_music_xml(&loaded.doc, None, &ToXmlOptions::default()).unwrap();
        let container = r#"<?xml version="1.0"?><container><rootfiles><rootfile full-path="score.musicxml"/></rootfiles></container>"#;
        let zip = make_test_zip(&[
            ("META-INF/container.xml", container.as_bytes()),
            ("score.musicxml", xml.as_bytes()),
        ]);
        let mxl_doc = load_bytes(&zip, InFormat::Mxl, "star", MidiGrid::Mixed).unwrap();
        assert_eq!(mxl_doc.doc.songs.len(), 1);
    }

    #[test]
    fn layout_export_svg_pdf_pptx() {
        let loaded = load_bytes(SAMPLE_123.as_bytes(), InFormat::J123, "star", MidiGrid::Mixed).unwrap();
        let mut res = RenderResources::new();
        let o = Opts::default();

        let laid_svg = layout_for_export(&loaded, OutFormat::Svg, &o, &res).unwrap();
        let svgs = laid_to_svgs(&laid_svg).unwrap();
        assert!(!svgs.is_empty());
        assert!(svgs[0].contains("xmlns=\"http://www.w3.org/2000/svg\""));

        let laid_pdf = layout_for_export(&loaded, OutFormat::Pdf, &o, &res).unwrap();
        let pdf = laid_to_pdf(&laid_pdf, &mut res).unwrap();
        assert!(pdf.starts_with(b"%PDF-"));

        let laid_pptx = layout_for_export(&loaded, OutFormat::Pptx, &o, &res).unwrap();
        let pptx = laid_to_pptx(&laid_pptx, &mut res).unwrap();
        assert_eq!(&pptx[..4], b"PK\x03\x04");
        let entries = read_zip_entries(&pptx).unwrap();
        assert!(entries.iter().any(|(n, _)| n == "ppt/slides/slide1.xml"));

        // 五线谱与混排视图（从 123 经 MusicXML 投影再排版）
        let o_mixed = Opts { view: ViewMode::Mixed, ..Opts::default() };
        let laid_mixed = layout_for_export(&loaded, OutFormat::Pdf, &o_mixed, &res).unwrap();
        let mixed_pdf = laid_to_pdf(&laid_mixed, &mut res).unwrap();
        assert!(mixed_pdf.starts_with(b"%PDF-"));

        // PNG 渲染（若本机有 PDFium）
        if let Ok(pngs) = pdf_to_pngs(pdf, 1.0) {
            assert!(!pngs.is_empty());
            assert_eq!(&pngs[0][..8], b"\x89PNG\r\n\x1a\n");
        }
    }

    fn make_test_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut cd = Vec::new();
        for (name, data) in files {
            let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
            enc.write_all(data).unwrap();
            let comp = enc.finish().unwrap();
            let off = out.len() as u32;
            // Local file header (30 bytes + name)
            out.extend_from_slice(&0x04034b50u32.to_le_bytes());
            out.extend_from_slice(&20u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&8u16.to_le_bytes()); // deflate
            out.extend_from_slice(&[0; 8]); // time(2) + date(2) + crc(4)
            out.extend_from_slice(&(comp.len() as u32).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&comp);
            // Central directory header (46 bytes + name)
            cd.extend_from_slice(&0x02014b50u32.to_le_bytes());
            cd.extend_from_slice(&20u16.to_le_bytes());
            cd.extend_from_slice(&20u16.to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&8u16.to_le_bytes());
            cd.extend_from_slice(&[0; 8]); // time(2) + date(2) + crc(4)
            cd.extend_from_slice(&(comp.len() as u32).to_le_bytes());
            cd.extend_from_slice(&(data.len() as u32).to_le_bytes());
            cd.extend_from_slice(&(name.len() as u16).to_le_bytes());
            cd.extend_from_slice(&[0; 12]); // extra(2) + comment(2) + disk(2) + internal(2) + external(4)
            cd.extend_from_slice(&off.to_le_bytes());
            cd.extend_from_slice(name.as_bytes());
        }
        let cd_off = out.len() as u32;
        let cd_len = cd.len() as u32;
        out.extend_from_slice(&cd);
        out.extend_from_slice(&0x06054b50u32.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&cd_len.to_le_bytes());
        out.extend_from_slice(&cd_off.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }
}
