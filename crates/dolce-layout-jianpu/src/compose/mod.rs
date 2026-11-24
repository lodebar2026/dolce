//! 构图（照 `layout/jianpu/compose/`）：定位结构 → 场景节点，另含驱动 [`layout_jianpu`]（`compose/index.ts`）。
//!
//! 与 TS 的出入只在驱动：TS `layoutJianpu` 遇到「窄纸重断行」「连谱号伸进左边距要缩进」就带着新配置递归调自己，
//! 这里改成显式循环（[`JianpuLayout::passes`] 记实际排了几遍），每遍的触发判据与递归时带的配置同 TS。

pub mod barline;
pub mod brace;
pub mod ctx;
pub mod footer;
pub mod header;
pub mod lyric;
pub mod marks;
pub mod note;
pub mod page;

use std::borrow::Cow;
use std::collections::HashMap;

use dolce_engrave::Env;
use dolce_model::breaks::{apply_breaks, ApplyBreaksOptions, LineStart, MidMode, PageMode};
use dolce_model::ScoreDoc;
use dolce_play::playorder::PlayItem;
use dolce_scene::build::update;
use dolce_scene::Node;
use dolce_style::jianpustyle::JianpuStyle;
use dolce_style::ss::Region;
use dolce_view::playdata::PlayData;
use dolce_view::playsong::{play_data_of_song, PlaySongOptions};
use dolce_view::slots::doc_view;

use crate::grid::{apply_doc_options, content_width, grid_of, note_font, GridPage, JianpuGrid};
use crate::ink::Ink;
use crate::model::{PlacedPage, PlacedScore};
use crate::place::expand::expand_view;
use crate::place::header::{place_header, place_slide_footer, place_title_page, PlacedHeader};
use crate::place::reflow::{fold_line_starts, natural_spans, reflow_line_starts, NaturalSpan};
use crate::place::song::layout_document;
use crate::util::{max, min};
use crate::view::{input_of, LDoc};

use ctx::Ctx;
use footer::{footer_span, layout_footers, FootCtx};
use header::{paint_slide_lines, HeaderInk};
use page::{paint_page, system_left};

/// 原样文档排版的外部配置（TS `JianpuLayoutConfig`，去掉只供递归用的 `leftIndent` / `reflowSource`）
#[derive(Clone, Debug)]
pub struct JianpuConfig {
    pub style: JianpuStyle,
    pub page: GridPage,
    /// 面板上给了边距：谱面自带的 `Margin:` 不再生效
    pub user_margins: bool,
    pub foot: Option<Region>,
    /// 已经按窄纸重新断过行，不再断第二次
    pub no_reflow: bool,
    /// 投影档
    pub expanded: bool,
    /// 投影档：`.jpwabc` 的 `.Layout` 分页描述
    pub break_desc: Option<String>,
    /// 成书
    pub book: bool,
    /// 成书量宽：不折行，另给第一首的自然横向区间
    pub measure: bool,
    /// 只排谱行：不放页眉、页脚
    pub snippet: bool,
    /// 覆盖墨色，缺省取尺子的 `page.color`
    pub ink: Option<f64>,
    /// 投影档：写了 `%%sing` 的逐遍按乐句断行（`expand.rs::sing_song`）
    pub sing_phrase: bool,
}

/// 一份文档排好的原样页面与定位结构（TS `JianpuLayout`）
#[derive(Debug)]
pub struct JianpuLayout {
    pub pages: Vec<Node>,
    pub width: f64,
    pub height: f64,
    pub metrics: JianpuGrid,
    pub digit_font_size: f64,
    pub view: LDoc,
    pub placed: PlacedScore,
    /// 投影档各首实际走的演唱顺序；简谱档为 None
    pub plans: Option<Vec<Option<Vec<PlayItem>>>>,
    /// 各行（每组第一个声部）首个音符的元素 id
    pub line_starts: Vec<i64>,
    /// `measure` 时：版心宽与第一首各音（元素 id）的自然横向区间
    pub spans: Option<(f64, Vec<(i64, NaturalSpan)>)>,
    /// 实际排了几遍（TS 递归了几层 + 1）
    pub passes: u32,
}

enum PassOut {
    Done(Box<JianpuLayout>),
    /// 重断过行的那份文档
    Reflow(ScoreDoc),
    /// 版心左缘要让出的量
    Indent(f64),
}

/// 排一份文档并生成全部页面（TS `layoutJianpu`）
pub fn layout_jianpu<'e>(source: &ScoreDoc, cfg: &JianpuConfig, env: &'e Env<'e>) -> JianpuLayout {
    let mut cur: Cow<ScoreDoc> = Cow::Borrowed(source);
    // TS `cfg.reflowSource`：重断行之前的那份
    let mut reflow_source: Option<Cow<ScoreDoc>> = None;
    let mut no_reflow = cfg.no_reflow;
    let mut left_indent: Option<f64> = None;
    let mut passes = 0u32;
    loop {
        passes += 1;
        match one_pass(&cur, cfg, no_reflow, left_indent, env) {
            PassOut::Done(mut l) => {
                l.passes = passes;
                return *l;
            }
            PassOut::Reflow(clone) => {
                let prev = std::mem::replace(&mut cur, Cow::Owned(clone));
                if reflow_source.is_none() {
                    reflow_source = Some(prev);
                }
                no_reflow = true;
            }
            PassOut::Indent(indent) => {
                if let Some(src) = reflow_source.take() {
                    cur = src;
                    no_reflow = false;
                }
                left_indent = Some(indent);
            }
        }
    }
}

fn one_pass<'e>(source: &ScoreDoc, cfg: &JianpuConfig, no_reflow: bool, left_indent: Option<f64>, env: &'e Env<'e>) -> PassOut {
    let input = input_of(source);
    let (fs, mg): (&[String], &[String]) = match input.songs.first() {
        Some(s) => (&s.metadata.font_sizes, &s.metadata.margins),
        None => (&[], &[]),
    };
    let style = apply_doc_options(&cfg.style, fs, mg, cfg.user_margins);
    let mut m = grid_of(&style, cfg.page, env.mc);
    if let Some(li) = left_indent.filter(|v| *v != 0.0 && !v.is_nan()) {
        m.page.margin.left += li;
    }
    let slide = cfg.expanded || cfg.book;
    if slide || cfg.snippet {
        m.page.first_system_top = 0.0;
    }
    let plays: Option<Vec<Option<PlayData>>> = cfg.expanded.then(|| {
        let view = doc_view(source, None);
        (0..source.songs.len())
            .map(|i| play_data_of_song(source, &view, i, PlaySongOptions { for_expanded: true }).unwrap_or_else(|e| panic!("演唱顺序推不出：{}", e.0)))
            .collect()
    });
    let plans: Option<Vec<Option<Vec<PlayItem>>>> = plays.as_ref().map(|p| p.iter().map(|pd| pd.as_ref().map(|d| d.measures.clone())).collect());
    let ink_color = cfg.ink.unwrap_or(style.page.color);
    let hm = HeaderInk { m: &m, env };
    let heads: Vec<PlacedHeader> = if slide || cfg.snippet { vec![] } else { input.songs.iter().map(|s| place_header(&s.metadata, &m, &hm)).collect() };
    let header_bottoms: Vec<f64> = heads.iter().map(|h| h.bottom).collect();
    let ink = Ink::new(&m, env);
    let doc = match &plays {
        Some(p) => expand_view(&input, source, p, &m, &ink, cfg.break_desc.as_deref(), cfg.sing_phrase),
        None => input,
    };

    // 源里的行放不下就整首重新断行（成书只折放不下的那几行）
    if !no_reflow && !cfg.measure && plans.is_none() {
        let starts = if cfg.book { fold_line_starts(&doc.songs, &m, &ink) } else { reflow_line_starts(&doc.songs, &m, &ink) };
        if let Some(starts) = starts {
            let mut clone = source.clone();
            let mut changed = false;
            let opt = ApplyBreaksOptions { mid_in_any_part: false, mid: if cfg.book { MidMode::Inline } else { MidMode::Source }, pages: PageMode::Keep };
            for (i, song) in clone.songs.iter_mut().enumerate() {
                if let Some(ls) = starts.get(i) {
                    let ls: Vec<LineStart> = ls.iter().map(|&id| LineStart { id: id as u32, page: false }).collect();
                    if apply_breaks(song, &ls, &opt) {
                        changed = true;
                    }
                }
            }
            if changed {
                return PassOut::Reflow(clone);
            }
        }
    }

    let foot = if cfg.snippet { None } else { cfg.foot.as_ref() };
    let foot_ctx = |page_width: f64, page_height: f64| FootCtx { m: &m, env, doc: &doc, foot, page_width, page_height, ink: ink_color };
    let spans_foot: Vec<f64> = (0..doc.songs.len()).map(|i| footer_span(&foot_ctx(m.page.width, m.page.height), i)).collect();
    let mut placed = layout_document(&doc.songs, &m, &header_bottoms, &ink, &spans_foot, slide);
    // 投影档：每首前面一页标题页
    if plans.is_some() {
        let mut with_titles = Vec::with_capacity(placed.pages.len());
        for pg in std::mem::take(&mut placed.pages) {
            if pg.first_of_song {
                with_titles.push(PlacedPage { groups: vec![], song: pg.song, first_of_song: false, headers: None, title_page: true, natural: None });
            }
            with_titles.push(pg);
        }
        placed.pages = with_titles;
    }

    let mut c = Ctx {
        m: &m,
        env,
        doc: &doc,
        placed: &placed,
        digit_font: note_font(&m.style, m.style.size.note),
        band: None,
        band_origin: (0.0, 0.0),
        page_width: m.page.width,
        page_height: m.page.height,
        page_shift_x: 0.0,
        ink: ink_color,
        lyric_ink: ink_color,
        slide,
        pass: None,
        heads: &heads,
        foot,
    };

    // 连谱号、段号也在版心里：量出最靠左的系统左缘，版心左缘让出这一截、整份再排一遍
    if left_indent.is_none() && !placed.pages.is_empty() {
        let thick = m.ink.note_height * 2.2 * 0.115;
        let mut ink_left = f64::INFINITY;
        for p in &placed.pages {
            let brace = if p.groups.iter().any(|g| g.has_brace) { thick / 2.0 } else { 0.0 };
            ink_left = min(ink_left, system_left(&c, p) - brace);
        }
        let indent = m.page.margin.left - ink_left;
        if indent > 0.01 {
            return PassOut::Indent(indent);
        }
    }

    // 页脚：先排一遍拿到占高，连续长图的页高要把它算进去
    let footers = layout_footers(&foot_ctx(c.page_width, c.page_height), &placed, 0.0);
    let mut footer_bottom: f64 = 0.0;
    for f in &footers {
        footer_bottom = max(footer_bottom, f.bottom);
    }
    if m.page.long_image {
        c.page_height = max(
            max(m.page.margin.top + m.page.first_system_top, placed.content_bottom + m.ink.note_height + m.page.margin.bottom),
            if footer_bottom > 0.0 { footer_bottom + m.page.margin.bottom } else { 0.0 },
        );
        let mut ink_left = f64::INFINITY;
        for p in &placed.pages {
            ink_left = min(ink_left, system_left(&c, p));
        }
        let ink_right = m.page.margin.left + placed.content_right + m.ink.note_height * 0.6;
        let span = ink_right - ink_left;
        c.page_width = max(m.page.width, span);
        c.page_shift_x = (c.page_width - span) / 2.0 - ink_left;
    }
    let mut footer_items: HashMap<usize, Vec<Node>> = HashMap::new();
    for f in layout_footers(&foot_ctx(c.page_width, c.page_height), &placed, c.page_shift_x) {
        footer_items.entry(f.page).or_default().extend(f.items);
    }
    // 投影档各首的标题页在第几页、谱页共几页
    let mut title_at: HashMap<usize, i64> = HashMap::new();
    let mut pages_of: HashMap<usize, i64> = HashMap::new();
    for (i, pg) in placed.pages.iter().enumerate() {
        if pg.title_page {
            title_at.insert(pg.song, i as i64);
        } else {
            *pages_of.entry(pg.song).or_insert(0) += 1;
        }
    }
    let placed_ref: &PlacedScore = &placed;
    let mut pages = Vec::with_capacity(placed_ref.pages.len());
    for (i, pg) in placed_ref.pages.iter().enumerate() {
        let meta = doc.songs.get(pg.song).map(|s| &s.metadata);
        if pg.title_page {
            let mut g = Node::group();
            if let Some(meta) = meta {
                paint_slide_lines(&c, &mut g, &place_title_page(meta, &m, &hm), true);
            }
            pages.push(g);
            continue;
        }
        let mut g = paint_page(&mut c, pg, i);
        if let Some(items) = footer_items.remove(&i) {
            for it in items {
                g.push(it);
            }
        }
        if plans.is_some() {
            let title = meta.and_then(|mt| mt.titles.first()).map_or("", |t| t.split('\n').next().unwrap_or(""));
            let no = i as i64 - title_at.get(&pg.song).copied().unwrap_or(-1);
            let total = pages_of.get(&pg.song).copied().unwrap_or(0);
            paint_slide_lines(&c, &mut g, &place_slide_footer(title, no, total, &m, &hm), false);
        }
        g.shift(c.page_shift_x, 0.0);
        pages.push(g);
    }
    for p in &mut pages {
        update(p, env).unwrap_or_else(|e| panic!("{}", e.0));
        dolce_engrave::jpnumber::fill_number_cx(p, env);
    }
    let (width, height) = (c.page_width, c.page_height);
    let digit_font_size = c.digit_font.size;
    let line_starts = line_starts_of(&placed);
    let spans = if cfg.measure { doc.songs.first().map(|s| (content_width(&m), natural_spans(s, &m, &ink))) } else { None };
    PassOut::Done(Box::new(JianpuLayout { pages, width, height, metrics: m, digit_font_size, view: doc, placed, plans, line_starts, spans, passes: 0 }))
}

/// 各行首个音符的元素 id（每组取第一个声部）
fn line_starts_of(placed: &PlacedScore) -> Vec<i64> {
    let mut out = vec![];
    for page in &placed.pages {
        for g in &page.groups {
            let Some(v) = g.voices.first() else { continue };
            if let Some(id) = v.items.iter().find(|x| matches!(x.element, dolce_view::ast::MusicElement::Note(_)) && x.id.is_some()).and_then(|x| x.id) {
                out.push(id);
            }
        }
    }
    out
}
