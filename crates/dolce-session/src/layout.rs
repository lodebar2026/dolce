//! 排版入口（H 期）：编辑器的排版请求 → 两条引擎 → 各页场景、SVG 与身份表。
//!
//! 照 TS `layout/painter.ts` 的「请求 → 引擎配置」那一层搬过来：`jianpuCfgOf`（简谱 / 投影档）、
//! `staffOptionsOf` + `_staffCommit`（五线谱 / 混排）、`measureRequestOf`（乐句重排的自然量宽）。
//! 引擎本身不动（`dolce-layout-jianpu` / `dolce-layout-staff`，L3–L5 已对拍到位）。
//!
//! 宿主无关：量字上下文与 SMuFL 元数据由宿主给（[`Env`]）——网页 wasm 接浏览器量字、桌面原生量字、命令行原生或回放。

use dolce_engrave::Env;
use dolce_layout_jianpu::compose::{layout_jianpu, JianpuConfig, JianpuLayout};
use dolce_layout_jianpu::grid::GridPage;
use dolce_layout_jianpu::place::reflow::NaturalSpan;
use dolce_model::doc::{Element, ScoreDoc};
use dolce_model::xmlsurface::Surface;
use dolce_scene::build::freeze;
use dolce_scene::index::{page_hits, Hit};
use dolce_scene::svg::page_svg;
use dolce_scene::{Dialect, Page};
use dolce_style::cascade::ctx;
use dolce_style::jianpu::jianpu_style_of;
use dolce_style::paper::{page_margins, resolve_paper, ResolvedPaper};
use dolce_style::sheet::StyleSheet;
use dolce_style::ss::Region;
use dolce_style::staff::{staff_options_of, StaffPage};
use dolce_style::themes::{compute_style_for_paper, long_image_width, theme, ThemeId};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 简谱 / 投影档的纸（pt）。
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct PaperWH {
    pub w: f64,
    pub h: f64,
}

/// 简谱这一路的请求（TS `JianpuPaintRequest` 去掉 `doc`，文档另给）。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JianpuRequest {
    /// `original` / `expanded`
    pub view: String,
    /// computed 样式表；null = print 主题出厂
    #[serde(default)]
    pub style: Option<Value>,
    #[serde(default)]
    pub no_reflow: bool,
    #[serde(default)]
    pub break_desc: Option<String>,
    #[serde(default)]
    pub page: Option<PaperWH>,
    #[serde(default)]
    pub snippet: bool,
    #[serde(default)]
    pub ink: Option<f64>,
}

/// 五线谱 / 混排的请求（TS `StaffPaintRequest` 去掉 `doc`）。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StaffRequest {
    /// `staff` / `mixed`
    pub view: String,
    #[serde(default)]
    pub style: Option<Value>,
    #[serde(default)]
    pub page: Option<StaffPage>,
    #[serde(default)]
    pub hide_bar_number: bool,
    #[serde(default)]
    pub jianpu_part: usize,
    #[serde(default)]
    pub source_breaks: bool,
}

/// 一页的几何（TS `PageGeometry`：原生坐标宽高 + 一个原生单位合多少 pt）。
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageGeom {
    pub w: f64,
    pub h: f64,
    pub pt_per_unit: f64,
    /// 这页是第几首
    pub song: usize,
}

/// 排好的一份：各页场景与几何，外加两路各自的附带结果（不含页面 SVG 与身份表，那两样按页现取）。
#[derive(Debug)]
pub struct Laid {
    pub renderer: Renderer,
    pub title: String,
    pub pages: Vec<Page>,
    pub geom: Vec<PageGeom>,
    /// 简谱这一路：引擎的整份结果（行首、量宽、演唱顺序、栅格、定位结构）
    pub jianpu: Option<JianpuLayout>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Renderer {
    Jianpu,
    Staff,
}

/// 给 TS 的概要（`LayoutResult` 里不随页的部分）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaidInfo<'a> {
    pub renderer: Renderer,
    pub title: &'a str,
    pub pages: &'a [PageGeom],
    /// 简谱各行首音（行序，投影档可能重复）；五线谱为 null
    pub line_starts: Option<&'a [i64]>,
    /// 投影档各首实际走的演唱顺序
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plans: Option<&'a Vec<Option<Vec<dolce_play::playorder::PlayItem>>>>,
    /// 简谱档栅格的定稿基础字号（面板显示）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digit_font_size: Option<f64>,
    /// 简谱：附点离数字的那道空（尺子的 `vertical.stackGap`，导出 PPTX 重摆附点用）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack_gap: Option<f64>,
}

impl Laid {
    pub fn info(&self) -> LaidInfo<'_> {
        let j = self.jianpu.as_ref();
        LaidInfo {
            renderer: self.renderer,
            title: &self.title,
            pages: &self.geom,
            line_starts: j.map(|j| j.line_starts.as_slice()),
            plans: j.and_then(|j| j.plans.as_ref()),
            digit_font_size: j.map(|j| j.digit_font_size),
            stack_gap: j.map(|j| j.metrics.style.vertical.stack_gap),
        }
    }

    /// 第 `i` 页的 SVG（与 TS `renderPageSvg(...).outerHTML` 逐字节相同）。
    pub fn svg(&self, i: usize) -> Option<String> {
        self.pages.get(i).map(page_svg)
    }

    /// 第 `i` 页的身份表。
    pub fn hits(&self, i: usize) -> Option<Vec<Hit>> {
        self.pages.get(i).map(page_hits)
    }
}

/// 出厂的简谱样式表（print 主题，`mode: original`、`engine: jianpu`）。
fn default_jianpu_sheet() -> StyleSheet {
    compute_style_for_paper(
        &[theme(ThemeId::Print)],
        &ctx(&[("mode", Value::String("original".into())), ("engine", Value::String("jianpu".into()))]),
    )
}

fn sheet_of(v: &Option<Value>) -> StyleSheet {
    match v {
        Some(v) if !v.is_null() => StyleSheet(v.clone()),
        _ => default_jianpu_sheet(),
    }
}

fn foot_region(sheet: &StyleSheet) -> Result<Option<Region>, String> {
    match sheet.template().and_then(|t| t.get("regions")).and_then(|r| r.get("song-foot")) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => serde_json::from_value(v.clone()).map(Some).map_err(|e| format!("页脚模板读不进：{e}")),
    }
}

/// `jianpuCfgOf`：简谱这一路的请求 → 简谱引擎的外部配置（纸、尺子、页脚模板）。
pub fn jianpu_config(req: &JianpuRequest, env: &Env) -> Result<JianpuConfig, String> {
    let sheet = sheet_of(&req.style);
    let page_decl = sheet.page();
    let expanded = req.view == "expanded";
    // 投影档：投影片纸（投影档样式的 `page.size`）
    let size_at = |i: usize| page_decl.get("size").and_then(|s| s.get(i)).and_then(Value::as_f64);
    let page = if expanded {
        GridPage { width: size_at(0).unwrap_or(960.0), height: size_at(1).unwrap_or(540.0), continuous: false }
    } else if let Some(p) = req.page {
        GridPage { width: p.w, height: if req.snippet { p.w } else { p.h }, continuous: req.snippet }
    } else {
        match resolve_paper(page_decl) {
            ResolvedPaper::Size { w, h } => GridPage { width: w, height: h, continuous: false },
            // 长图：宽与旧简谱引擎的长图同一张，高由内容定
            _ => GridPage { width: long_image_width(), height: long_image_width(), continuous: true },
        }
    };
    Ok(JianpuConfig {
        style: jianpu_style_of(&sheet, env.mc)?,
        page,
        user_margins: page_margins(page_decl).is_some(),
        foot: foot_region(&sheet)?,
        no_reflow: req.no_reflow,
        expanded,
        break_desc: req.break_desc.clone(),
        book: false,
        measure: false,
        snippet: req.snippet,
        ink: req.ink,
    })
}

/// 简谱 / 投影档整份排好。
pub fn layout_jianpu_doc(doc: &ScoreDoc, req: &JianpuRequest, env: &Env) -> Result<Laid, String> {
    let cfg = jianpu_config(req, env)?;
    let r = layout_jianpu(doc, &cfg, env);
    let title = r.view.songs.first().and_then(|s| s.metadata.titles.first()).cloned().unwrap_or_default();
    let geom = (0..r.pages.len())
        .map(|i| PageGeom { w: r.width, h: r.height, pt_per_unit: 1.0, song: r.placed.pages.get(i).map_or(0, |p| p.song) })
        .collect();
    let mut r = r;
    let pages = std::mem::take(&mut r.pages)
        .into_iter()
        .map(|mut root| {
            freeze(&mut root, env);
            Page { dialect: Dialect::Jianpu, cls: "score-page".into(), w: r.width, h: r.height, root: Some(root) }
        })
        .collect();
    Ok(Laid { renderer: Renderer::Jianpu, title, pages, geom, jianpu: Some(r) })
}

/// 五线谱 / 混排整份排好（`staffOptionsOf` + `_staffCommit`）。`surface`：MusicXML 读来的那份表层（按 `_oid` 问原文属性）。
pub fn layout_staff_doc(doc: &ScoreDoc, surface: Option<&Surface>, req: &StaffRequest, env: &Env) -> Result<Laid, String> {
    use dolce_layout_staff::{pages, read};
    let sheet = req.style.as_ref().filter(|v| !v.is_null()).map(|v| StyleSheet(v.clone()));
    let mut options = staff_options_of(sheet.as_ref());
    options.hide_bar_number = req.hide_bar_number;
    options.page = req.page.clone();
    options.source_breaks = req.source_breaks;
    let song0 = doc.songs.first().ok_or("这份文档里没有曲子")?;
    let song = read::prepare_song(song0);
    let meta = env.meta.ok_or("没有 SMuFL 元数据")?;
    let mut score = read::layout_staff(&song, surface, options, meta, env.mc, &mut |_, _| {});
    let (roots, _placed) = pages::layout_staff_pages(&mut score, req.view == "mixed", req.jianpu_part);
    let (w, h, scaling) = (score.defaults.page_width, score.defaults.page_height, score.scaling);
    let title = score.title();
    let geom = roots.iter().map(|_| PageGeom { w, h, pt_per_unit: scaling, song: 0 }).collect();
    let pages = roots
        .into_iter()
        .map(|mut root| {
            freeze(&mut root, env);
            Page { dialect: Dialect::Mixed, cls: "score-page mixed-page".into(), w, h, root: Some(root) }
        })
        .collect();
    Ok(Laid { renderer: Renderer::Staff, title, pages, geom, jianpu: None })
}

/// 自然量宽的结果（TS `measureDocument`）：版心宽与按插入序的 `[元素 id, 区间]`。
pub type Spans = (f64, Vec<(i64, NaturalSpan)>);

/// `measureRequestOf` + `measureDocument`：清掉换行、整首不折，量第 `song` 首旋律声部（带歌词的那个，没有取第一个）
/// 每个音的自然横向区间与版心宽。`slide`：按投影档的画法量。没有可量的回 `(0, [])`。
pub fn measure_document(doc: &ScoreDoc, style: &Option<Value>, width: f64, slide: bool, song: usize, env: &Env) -> Result<Spans, String> {
    let Some(one) = doc.songs.get(song) else { return Ok((0.0, Vec::new())) };
    let has_lyrics = |p: &&dolce_model::doc::Part| {
        p.measures.iter().any(|m| m.elements.iter().any(|e| matches!(e, Element::Chord(c) if c.lyrics.as_ref().is_some_and(|l| !l.is_empty()))))
    };
    let Some(lead) = one.parts.iter().find(has_lyrics).or(one.parts.first()) else { return Ok((0.0, Vec::new())) };
    let mut s = one.clone();
    s.parts = vec![lead.clone()];
    let mut clone = doc.clone();
    clone.songs = vec![s];
    // 文本谱不清换行（歌词挂在每行源头，并成一行就丢了），逐行接着量
    if clone.source_format != dolce_model::doc::SourceFormat::Fanqie {
        for s in &mut clone.songs {
            dolce_model::breaks::clear_song_breaks(s);
        }
    }
    let sheet = sheet_of(style);
    let cfg = JianpuConfig {
        style: jianpu_style_of(&sheet, env.mc)?,
        page: GridPage { width, height: width, continuous: true },
        user_margins: page_margins(sheet.page()).is_some(),
        foot: None,
        no_reflow: false,
        expanded: false,
        break_desc: None,
        book: slide,
        measure: true,
        snippet: false,
        ink: None,
    };
    let r = layout_jianpu(&clone, &cfg, env);
    Ok(r.spans.unwrap_or((0.0, Vec::new())))
}
