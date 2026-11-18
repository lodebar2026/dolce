//! 排版入口（H 期）：编辑器的排版请求 → 两条引擎 → 各页场景、SVG 与身份表。
//!
//! 照 TS `layout/painter.ts` 的「请求 → 引擎配置」那一层搬过来：`jianpuCfgOf`（简谱 / 投影档）、
//! `staffOptionsOf` + `_staffCommit`（五线谱 / 混排）、`measureRequestOf`（乐句重排的自然量宽）。
//! 引擎本身不动（`dolce-layout-jianpu` / `dolce-layout-staff`，L3–L5 已对拍到位）。
//!
//! 宿主无关：量字上下文与 SMuFL 元数据由宿主给（[`Env`]）——网页 wasm 接浏览器量字、桌面原生量字、命令行原生或回放。

use dolce_engrave::Env;
use dolce_base::geom::Rect;
use dolce_layout_jianpu::compose::{layout_jianpu, JianpuConfig, JianpuLayout};
use dolce_layout_jianpu::grid::GridPage;
use dolce_layout_jianpu::place::reflow::NaturalSpan;
use dolce_model::doc::{Element, ScoreDoc};
use dolce_model::xmlsurface::Surface;
use dolce_scene::build::freeze;
use dolce_scene::index::{page_hits_geom, Hit};
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
    /// 整页画出来的墨迹盒（页面坐标；帮助页谱例按它裁）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ink: Option<Rect>,
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
    /// 各页身份表（带页面几何，排完时一并算好：要量字环境）
    pub hits: Vec<Vec<Hit>>,
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
    pub fn hits(&self, i: usize) -> Option<&[Hit]> {
        self.hits.get(i).map(Vec::as_slice)
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

/// 各页身份表（带几何），顺手把整页墨迹记进页几何
fn with_ink(pages: &[Page], geom: &mut [PageGeom], env: &Env) -> Vec<Vec<Hit>> {
    pages
        .iter()
        .zip(geom.iter_mut())
        .map(|(p, g)| {
            let (hits, ink) = page_hits_geom(p, env);
            g.ink = ink;
            hits
        })
        .collect()
}

/// 简谱 / 投影档整份排好。
pub fn layout_jianpu_doc(doc: &ScoreDoc, req: &JianpuRequest, env: &Env) -> Result<Laid, String> {
    let cfg = jianpu_config(req, env)?;
    let r = layout_jianpu(doc, &cfg, env);
    let title = r.view.songs.first().and_then(|s| s.metadata.titles.first()).cloned().unwrap_or_default();
    let mut geom: Vec<PageGeom> = (0..r.pages.len())
        .map(|i| PageGeom { w: r.width, h: r.height, pt_per_unit: 1.0, song: r.placed.pages.get(i).map_or(0, |p| p.song), ink: None })
        .collect();
    let mut r = r;
    let pages = std::mem::take(&mut r.pages)
        .into_iter()
        .map(|mut root| {
            freeze(&mut root, env);
            Page { dialect: Dialect::Jianpu, cls: "score-page".into(), w: r.width, h: r.height, root: Some(root) }
        })
        .collect::<Vec<_>>();
    let hits = with_ink(&pages, &mut geom, env);
    Ok(Laid { renderer: Renderer::Jianpu, title, pages, geom, jianpu: Some(r), hits })
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
    let mut geom: Vec<PageGeom> = roots.iter().map(|_| PageGeom { w, h, pt_per_unit: scaling, song: 0, ink: None }).collect();
    let pages = roots
        .into_iter()
        .map(|mut root| {
            freeze(&mut root, env);
            Page { dialect: Dialect::Mixed, cls: "score-page mixed-page".into(), w, h, root: Some(root) }
        })
        .collect::<Vec<_>>();
    let hits = with_ink(&pages, &mut geom, env);
    Ok(Laid { renderer: Renderer::Staff, title, pages, geom, jianpu: None, hits })
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

// ---------------------------------------------------------------- 导出 MusicXML 的版面

/// 导出版面请求（TS `sourceMusicXml` → `engraveScoreDoc`）：纸同屏幕上的五线谱；`sourceBreaks` 同 `StaffRequest`。
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct EngraveRequest {
    pub page: Option<StaffPage>,
    pub source_breaks: bool,
}

/// 导出版面给没有身份的对象现发的号（与表层的号错开，同 TS `rustdoc.ts::freshOid`）
const FRESH_OID: u32 = 0x4000_0000;

/// `doc` 第一首经唯一写出端投成 MusicXML，带上五线谱引擎排出来的版面（与屏幕上的五线谱同一套分行、坐标）：
/// 纸、标题块、换行、弧朝向写回（拷贝的）模型，坐标、小节宽、系统间距、符干交给写出端（`EngravedLayout`）。
/// 谱里已带版面（`<defaults>`）、或排出来不是自动铺排的，不加版面原样写。
pub fn engraved_music_xml(doc: &ScoreDoc, surface: Option<&Surface>, req: &EngraveRequest, env: &Env) -> Result<String, String> {
    use dolce_model::toxml::{score_doc_to_music_xml, ToXmlOptions};
    let mut doc = doc.clone();
    let mut layout = None;
    if let Some(song) = doc.songs.first_mut().filter(|s| s.defaults.is_none()) {
        dolce_model::helpers::stamp_oids(song, FRESH_OID);
        if let Some((patch, lay)) = engrave_song(song, surface, req, env)? {
            patch.apply(song);
            layout = Some(lay);
        }
    }
    let o = ToXmlOptions { project: Default::default(), song: 0, source_ids: false, layout: layout.as_ref(), rids: None };
    score_doc_to_music_xml(&doc, surface, &o).map_err(|m| m.key)
}

/// 要写回模型的那几样（排版借着模型，排完才能改）。
struct SongPatch {
    defaults: dolce_model::doc::Defaults,
    credits: Vec<dolce_model::doc::Credit>,
    /// 各系统首小节（全曲下标）与换不换页（`None` = 第一个系统）
    breaks: Vec<(usize, Option<bool>)>,
    /// 没写朝向的圆滑线（`song.marks` 下标）排在上方没有
    slurs: Vec<(usize, bool)>,
}

impl SongPatch {
    fn apply(self, song: &mut dolce_model::doc::Song) {
        use dolce_model::doc::{Placement, Print};
        song.defaults = Some(self.defaults);
        song.credits = Some(self.credits);
        // 换行一律按排出来的，源文带来的换行先清掉
        for m in song.parts.iter_mut().flat_map(|p| p.measures.iter_mut()) {
            if let Some(pr) = &mut m.print {
                pr.new_system = None;
                pr.new_page = None;
                if *pr == (Print { oid: pr.oid, ..Print::default() }) {
                    m.print = None;
                }
            }
        }
        for (mi, new_page) in self.breaks {
            for part in &mut song.parts {
                let Some(m) = part.measures.get_mut(mi) else { continue };
                let pr = m.print.get_or_insert_with(Print::default);
                match new_page {
                    Some(true) => pr.new_page = Some(true),
                    Some(false) => pr.new_system = Some(true),
                    None => {}
                }
            }
        }
        for (i, above) in self.slurs {
            song.marks[i].placement = Some(if above { Placement::Above } else { Placement::Below });
        }
    }
}

fn r1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// 排一遍、读出导出版面（TS `xmllayout.ts::writeLayout`）。排出来不是自动铺排、或多小节休止并过（排的不是这份模型）时回 None。
fn engrave_song(
    song: &dolce_model::doc::Song,
    surface: Option<&Surface>,
    req: &EngraveRequest,
    env: &Env,
) -> Result<Option<(SongPatch, dolce_model::xmlsurface::EngravedLayout)>, String> {
    use dolce_layout_staff::model::Lcr;
    use dolce_layout_staff::{pages, read};
    use dolce_model::doc::{Credit, Defaults, HAlign, MarkType, PageLayout, PageMargins, OddEven, Scaling};
    use dolce_model::xmlsurface::{EngravedLayout, Position, PrintLayout, StaffLayout as StaffSpacing, SystemLayout};
    use std::collections::HashMap;

    let std::borrow::Cow::Borrowed(song) = read::prepare_song(song) else { return Ok(None) };
    let meta = env.meta.ok_or("没有 SMuFL 元数据")?;
    let mut options = staff_options_of(None);
    options.hide_bar_number = false;
    options.page = req.page.clone();
    options.source_breaks = req.source_breaks;
    let mut score = read::layout_staff(song, surface, options, meta, env.mc, &mut |_, _| {});
    let (_, placed) = pages::layout_staff_pages(&mut score, false, 0);
    if !score.auto_layout {
        return Ok(None);
    }

    let mut out = EngravedLayout::default();
    fn at(out: &mut EngravedLayout, oid: dolce_model::doc::Oid, set: Position) {
        let p = out.pos.entry(oid).or_default();
        if set.default_x.is_some() {
            p.default_x = set.default_x;
        }
        if set.default_y.is_some() {
            p.default_y = set.default_y;
        }
    }
    let d = &score.defaults;
    let defaults = Defaults {
        scaling: Some(Scaling { millimeters: 7.0, tenths: 40.0 }), // = DEFAULT_SCALING：自动铺排的谱都按它排
        page_layout: Some(PageLayout {
            page_width: Some(r1(d.page_width)),
            page_height: Some(r1(d.page_height)),
            margins: Some(vec![PageMargins { left: d.left_margin, right: d.right_margin, top: d.top_margin, bottom: d.bottom_margin, odd_even: Some(OddEven::Both) }]),
        }),
        ..Defaults::default()
    };
    out.system_layout = Some(SystemLayout { left_margin: Some(0.0), right_margin: Some(0.0), ..SystemLayout::default() });
    // 标题块：`autoLayoutHeader` 排的，已含标题那条（MuseScore 只要有 <credit> 就不再看 <work-title>）
    let credits = score
        .credits
        .iter()
        .map(|c| Credit {
            kind: c.r#type.clone(),
            text: c.text.clone(),
            x: Some(r1(c.x)),
            y: Some(r1(c.y)),
            font_size: (c.font_size > 0.0).then_some(c.font_size),
            justify: Some(match c.justify {
                Lcr::Center => HAlign::Center,
                Lcr::Right => HAlign::Right,
                Lcr::Left => HAlign::Left,
            }),
            page: Some(c.page + 1.0),
            ..Credit::default()
        })
        .collect();

    // 分行分页与系统间距
    let mut breaks = Vec::new();
    for (i, pl) in placed.iter().enumerate() {
        let sys = &score[pl.sys];
        let prev = i.checked_sub(1).map(|j| &placed[j]);
        let new_page = i > 0 && prev.is_some_and(|p| p.page != pl.page);
        breaks.push((sys.first_measure, if i == 0 { None } else { Some(new_page) }));
        let mut staff = 0;
        for (pi, part) in song.parts.iter().enumerate() {
            let Some(m) = part.measures.get(sys.first_measure) else { continue };
            let layout = &score.parts[pi];
            let staff_layouts: Vec<StaffSpacing> = (0..layout.staves.len())
                .filter_map(|k| {
                    let st = sys.staves.get(staff + k)?;
                    (staff + k > 0 && st.distance > 0.0).then(|| StaffSpacing { staff: Some((k + 1) as f64), staff_distance: Some(r1(st.distance)) })
                })
                .collect();
            staff += layout.staves.len();
            let mut pr = PrintLayout::default();
            if pi == 0 {
                pr.system_layout = Some(match prev {
                    Some(p) if !new_page => SystemLayout { system_distance: Some(r1(pl.top - (p.top + score[p.sys].height()))), ..SystemLayout::default() },
                    _ => SystemLayout { top_system_distance: Some(r1(pl.top - d.top_margin)), ..SystemLayout::default() },
                });
            }
            if !staff_layouts.is_empty() {
                pr.staff_layouts = Some(staff_layouts);
            }
            if pr != PrintLayout::default() {
                out.prints.insert(m.oid, pr);
            }
        }
    }

    // 没写朝向的圆滑线按排出来的方向写明（`arcsAbove`），第三方软件不另猜；没对上排版的仍写上方
    let key = |m: &dolce_model::doc::Mark| (m.start, m.end, m.start_note.unwrap_or(0.0).to_bits(), m.end_note.unwrap_or(0.0).to_bits());
    let mut slur_above = HashMap::new();
    for pl in &score.parts {
        for &sl in &pl.slurs {
            if let Some(mk) = score[sl].mark {
                slur_above.insert(key(mk), score[sl].span.above);
            }
        }
    }
    let slurs = song
        .marks
        .iter()
        .enumerate()
        .filter(|(_, m)| m.kind == MarkType::Slur && m.placement.is_none() && m.orientation.is_none())
        .map(|(i, m)| (i, slur_above.get(&key(m)).copied().unwrap_or(true)))
        .collect();

    // 小节宽、音符横向位置与符干方向、歌词与和弦与文字的高度
    let text_pt = r1(score.defaults.lyric_font.size * score.scaling);
    for (pi, part) in song.parts.iter().enumerate() {
        let layout = &score.parts[pi];
        for (mi, m) in part.measures.iter().enumerate() {
            if let Some(mif) = score.measures.get(mi) {
                out.widths.insert(m.oid, r1(mif.width));
            }
            let Some(&md) = layout.measures.get(mi) else { continue };
            let md = &score[md];
            for &c in &md.chords {
                let ch = &score[c];
                for &n in &ch.notes {
                    let nt = &score[n];
                    if nt.x < 0.0 {
                        continue;
                    }
                    at(&mut out, nt.src.map_or(ch.src.oid, |s| s.oid), Position { default_x: Some(r1(nt.x)), ..Position::default() });
                    // 统一过的符杠组方向写明，第三方软件不另猜（原文写了 `<stem>` 的由表层回填）
                    if let Some(src) = nt.src {
                        if !ch.rest() && ch.note_type().to_float() < 4.0 && surface.and_then(|s| s.note_stem(src.oid)).is_none() {
                            out.stems.insert(src.oid, (if ch.stem_up { "up" } else { "down" }).into());
                        }
                    }
                }
            }
            for &l in &md.lyrics {
                at(&mut out, score[l].src.oid, Position { default_y: Some(r1(score[l].y)), ..Position::default() });
            }
            for &h in &md.harmonies {
                at(&mut out, score[h].src.oid, Position { default_y: Some(r1(score[h].y)), ..Position::default() });
            }
            // 自动放置的速度/文字记号：高度，连同自动铺排统一过的字号（歌词字号，pt）
            for &t in &md.text_blocks {
                let t = &score[t];
                let Some(src) = t.src.filter(|_| t.auto_y) else { continue };
                let y = Position { default_y: Some(r1(t.block.y)), ..Position::default() };
                let items = std::iter::once((src.kind.as_str(), src.oid)).chain(src.more.iter().flatten().map(|x| (x.kind.as_str(), x.oid)));
                for (kind, oid) in items {
                    if kind != "words" && kind != "metronome" {
                        continue;
                    }
                    at(&mut out, oid, y);
                    out.font_size.insert(oid, text_pt);
                }
            }
        }
    }
    Ok(Some((SongPatch { defaults, credits, breaks, slurs }, out)))
}

/// 五线谱的断句尺子请求（TS `MixedSession.staffPhraseLineStarts`）：屏幕上五线谱的纸与样式。
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct StaffSpansRequest {
    pub style: Option<Value>,
    pub page: Option<StaffPage>,
}

/// 不带换行投出来的那份（`doc`）按五线谱引擎排一遍，量各和弦的自然跨度（`staff_chord_spans`）：版心宽与 `[源元素 id, x0, x1]`。
pub fn staff_chord_spans(doc: &ScoreDoc, surface: Option<&Surface>, req: &StaffSpansRequest, env: &Env) -> Result<dolce_layout_staff::pass::ChordSpans, String> {
    use dolce_layout_staff::{pass, read};
    let sheet = req.style.as_ref().filter(|v| !v.is_null()).map(|v| StyleSheet(v.clone()));
    let mut options = staff_options_of(sheet.as_ref());
    options.page = req.page.clone();
    let song0 = doc.songs.first().ok_or("这份文档里没有曲子")?;
    let song = read::prepare_song(song0);
    let meta = env.meta.ok_or("没有 SMuFL 元数据")?;
    let mut score = read::layout_staff(&song, surface, options, meta, env.mc, &mut |_, _| {});
    Ok(pass::staff_chord_spans(&mut score))
}
