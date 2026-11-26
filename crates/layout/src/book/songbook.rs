//! 混排歌本（照 `src/pdflayout/songbook.ts`）：清单里的一串 MusicXML → 整本的 DrawPage。
//!
//! 流程同 TS（移植自原排版程序的歌本链路）：`songFrames`（首帧带标题块、末帧带页脚块）→ `flow`（帧间距、放不下或强制就换页）
//! → `drawPages`（标题块、谱行、页脚块落到页上，页面树 → DrawList）→ `tocPages`（目录，A4 pt 口径、点线填到页码前）。
//! 判据、浮点次序连同 TS 的毛病一起搬。

use std::cell::RefCell;

use dolce_model::base::geom::Matrix33;
use dolce_layout_staff::model::{StaffLayout, SysId};
use dolce_layout_staff::pages::format_mixed_score;
use dolce_layout_staff::read;
use dolce_layout_staff::render::draw_system;
use dolce_model::doc::{ScoreDoc, Song};
use dolce_model::melodyonly::keep_first_part;
use dolce_model::metakeys::meta_flag;
use dolce_model::xmlsurface::Surface;
use dolce_engrave::scene::build::Env;
use dolce_engrave::scene::{Node, TextShape};
use dolce_engrave::style::cascade::{ctx, StyleRule};
use dolce_engrave::style::fonts::{font_of_role, FamilyMap};
use dolce_engrave::style::sheet::StyleSheet;
use dolce_engrave::style::ss::{Expr, Region, Row, SsError};
use dolce_engrave::style::staff::{apply_staff_style, MixedOptions};
use dolce_engrave::style::template::{eval_num, layout_region, song_field, ComponentCall, FieldExtra, FieldValue, FontMetricsLike, Placed, PlacedText, RegionEnv};
use dolce_engrave::style::themes::{compute_style_for_paper, theme, ThemeId};
use dolce_engrave::style::units::{resolve_length, LengthContext};
use dolce_engrave::style::value::js_to_string;
use dolce_engrave::text::cjkpunct::{punct_class, PunctClass};
use dolce_engrave::text::{Font, MeasureCtx};
use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::book::draw::{DrawItem, DrawPage, DrawText, PageMeta};
use crate::book::scenedraw::{page_items_to_draw_page, RoleOf, ToDrawOptions};

pub use crate::book::manifest::ManifestSong;
use crate::book::manifest::apply_manifest_song;

// ───────────────────────── 入口与结果 ─────────────────────────

pub struct SongSource {
    pub xml: String,
    pub entry: ManifestSong,
}

pub struct SongbookInput {
    pub songs: Vec<SongSource>,
    /// 歌本 `.ss` 解析出的规则
    pub rules: Vec<StyleRule>,
    /// 覆盖 `@flow song-start`：`new-page` / `continue`
    pub song_start: Option<String>,
    /// `@font-face` 名 → 字体族
    pub families: FamilyMap,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SongError {
    pub title: String,
    pub error: String,
}

/// 逐帧装页事实（tenths）
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameFact {
    pub song: usize,
    pub height: f64,
    pub ypos: f64,
    pub new_page: bool,
    pub head: f64,
    pub foot: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SongbookResult {
    pub pages: Vec<DrawPage>,
    pub toc: Vec<DrawPage>,
    /// 每首的起始页（1 基，不含目录页）
    pub starts: Vec<usize>,
    pub titles: Vec<String>,
    /// 文字角色 → 字体族（混排里角色就是字体族）
    pub families: Vec<String>,
    pub errors: Vec<SongError>,
    pub frames: Vec<FrameFact>,
}

// ───────────────────────── 帧 ─────────────────────────

struct Frame {
    sys: SysId,
    /// 清单里的序号（TS `Frame.song`）
    song: usize,
    /// 在排成功的那些曲子里的序号（TS 的 `frm.sys.score`）
    owner: usize,
    top_y: f64,
    height: f64,
    music_y_offset: f64,
    first: bool,
    last: bool,
    force_new_page: bool,
    bottom_text_y_offset: f64,
    /// TS `frm.head` / `frm.foot`：排过标题块 / 页脚块（空数组也算）
    head: bool,
    foot: bool,
    ypos: f64,
    new_page: bool,
}

const FRAME_MARGIN: f64 = 20.0;
/// 出书纸张（pt）：原程序整本固定 A4
const A4_PT: (f64, f64) = (595.0, 842.0);
/// 书的缺省字体族：角色没写字体时用它，和弦的书级缺省也是它
const BOOK_FALLBACK_FAMILY: &str = "Source Han Sans SC";

fn expr_word(e: Option<&Value>) -> Option<String> {
    let e = e?;
    match e.get("k").and_then(Value::as_str) {
        Some("id") | Some("str") => e.get("v").and_then(Value::as_str).map(str::to_string),
        _ => None,
    }
}

/// 角色 → 字体（`font: 名` 引 `@font-face`，或直接 `family`）；这里只补书的缺省族。
fn font_of(sheet: &StyleSheet, families: &FamilyMap, role: &str, size: f64) -> Font {
    font_of_role(sheet, role, &Font::new(BOOK_FALLBACK_FAMILY, size), Some(size), families)
}

fn region_of(sheet: &StyleSheet, name: &str) -> Result<Option<Region>, String> {
    match sheet.region(name) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => serde_json::from_value(v.clone()).map(Some).map_err(|e| format!("模板区域 {name} 读不进：{e}")),
    }
}

/// 一首歌交给五线谱引擎的文档、表层、样式表与选项（TS `songbookStaffInput`）
pub struct StaffInput {
    pub doc: ScoreDoc,
    pub surface: Surface,
    pub sheet: StyleSheet,
    pub options: MixedOptions,
}

/// TS `songbookStaffInput`
pub fn songbook_staff_input(xml: &str, entry: &ManifestSong, rules: &[StyleRule]) -> Result<StaffInput, String> {
    let loaded = dolce_model::fromxml::load_score_doc(xml).map_err(|m| format!("{m:?}"))?;
    let mut doc = loaded.doc;
    let song = doc.songs.first_mut().ok_or("这份文档里没有曲子")?;
    apply_manifest_song(song, entry);
    let c = ctx(&[("engine", Value::String("staff".into())), ("mode", Value::String("mixed".into()))]);
    let sheet = compute_style_for_paper(&[theme(ThemeId::Staff), rules], &c);
    // 只留旋律第一步：裁到 P1
    let melody_only = meta_flag(song, "layout.melody-only") == Some(true);
    if melody_only {
        keep_first_part(song);
    }
    let mut options = MixedOptions { hide_bar_number: true, text_line_height_by_size: true, jp_key_jianpu_font: true, ..MixedOptions::default() };
    // 歌词标点走半身式
    options.punct_compress = "halfwidth".into();
    // 和弦字体：书的缺省，样式表里 `chord { font: … }` 要盖得住它
    options.word_font = BOOK_FALLBACK_FAMILY.into();
    // 段号照书里原样，不自动补
    options.verse_numbers = "never".into();
    options.verse_label_by_ink = false;
    apply_staff_style(&mut options, &sheet);
    if meta_flag(song, "layout.chinese-hyphen") == Some(true) {
        options.chinese_hyphen = true;
    }
    // 只留旋律第二步：读完整条后删非旋律音
    if melody_only {
        options.melody_only = true;
    }
    Ok(StaffInput { doc, surface: loaded.surface, sheet, options })
}

/// 一首歌的模板环境（TS `songLayout` 里的 `env(dy, pageNo)`）
struct SongEnv<'a> {
    song: &'a Song,
    sheet: &'a StyleSheet,
    families: &'a FamilyMap,
    mc: &'a MeasureCtx<'a>,
    page_w: f64,
    scaling: f64,
    dy: f64,
    page_no: f64,
}

impl RegionEnv for SongEnv<'_> {
    fn field(&self, path: &str) -> Option<Vec<FieldValue>> {
        song_field(Some(self.song), &IndexMap::new(), path)
    }
    fn page_no(&self) -> f64 {
        self.page_no
    }
    fn content(&self) -> (f64, f64) {
        (0.0, self.page_w)
    }
    fn page_width(&self) -> Option<f64> {
        Some(self.page_w)
    }
    fn dy(&self) -> Option<f64> {
        Some(self.dy)
    }
    fn size_of(&self, role: &str) -> f64 {
        match self.sheet.role_prop(role, "size") {
            None => 20.0,
            Some(v) => resolve_length(v, LengthContext { em: 20.0, sp: 10.0, pt: Some(1.0 / self.scaling) }).unwrap_or(20.0),
        }
    }
    fn measure(&self, role: &str, text: &str, size: f64) -> f64 {
        font_of(self.sheet, self.families, role, size).measure_text(self.mc, text)
    }
    fn font_metrics(&self, role: &str, size: f64) -> Option<FontMetricsLike> {
        // 原排版程序的 Font::height() 就是字号，ascent 取字体的 ascent
        Some(FontMetricsLike { ascent: -font_of(self.sheet, self.families, role, size).metrics(self.mc).ascent, height: size })
    }
}

struct SongLayout<'d> {
    title: String,
    sheet: &'d StyleSheet,
    song: &'d Song,
    score: StaffLayout<'d>,
    page_w: f64,
    head: Option<Region>,
    foot: Option<Region>,
    frames: Vec<Frame>,
}

impl<'d> SongLayout<'d> {
    fn env<'a>(&'a self, families: &'a FamilyMap, mc: &'a MeasureCtx<'a>, dy: f64, page_no: f64) -> SongEnv<'a> {
        SongEnv { song: self.song, sheet: self.sheet, families, mc, page_w: self.page_w, scaling: self.score.scaling, dy, page_no }
    }
}

fn ss_err(e: SsError) -> String {
    e.message
}

/// TS `songLayout`：排一首、分帧（首帧带标题块、末帧带页脚块）
fn song_layout<'d>(
    inp: &'d StaffInput,
    song_src: &'d Song,
    index: usize,
    owner: usize,
    families: &FamilyMap,
    env: &'d Env<'d>,
) -> Result<SongLayout<'d>, String> {
    let meta = env.meta.ok_or("没有 SMuFL 元数据")?;
    let song = &inp.doc.songs[0];
    let title = song.work.title.clone().unwrap_or_default();
    let mut score = read::layout_staff(song_src, Some(&inp.surface), inp.options.clone(), meta, env.mc, &mut |_, _| {});
    format_mixed_score(&mut score, 0);
    let page_w = score.defaults.page_width;
    let head = region_of(&inp.sheet, "song-head")?;
    let foot = region_of(&inp.sheet, "song-foot")?;
    let mut s = SongLayout { title, sheet: &inp.sheet, song, score, page_w, head, foot, frames: Vec::new() };

    let mut frames: Vec<Frame> = (0..s.score.systems.len())
        .map(|k| {
            let [top_y, bottom_y] = s.score.sys_get_y_bound(SysId(k));
            Frame {
                sys: SysId(k),
                song: index,
                owner,
                top_y,
                height: top_y - bottom_y,
                music_y_offset: 0.0,
                first: false,
                last: false,
                force_new_page: false,
                bottom_text_y_offset: 0.0,
                head: false,
                foot: false,
                ypos: 0.0,
                new_page: false,
            }
        })
        .collect();
    if !frames.is_empty() {
        let e = s.env(families, env.mc, 0.0, 1.0);
        let head = layout_region(s.head.as_ref(), &e).map_err(ss_err)?;
        let gap_after = eval_num(s.head.as_ref().and_then(|r| r.props.get("gap-after")), &e, None).map_err(ss_err)?.unwrap_or(0.0);
        let f0 = &mut frames[0];
        f0.first = true;
        f0.head = true;
        f0.music_y_offset = head.span + gap_after;
        f0.height += head.span + gap_after;
        let foot = layout_region(s.foot.as_ref(), &e).map_err(ss_err)?;
        let fl = frames.last_mut().expect("非空");
        fl.last = true;
        fl.foot = true;
        fl.bottom_text_y_offset = fl.height;
        fl.height += foot.span;
    }
    s.frames = frames;
    Ok(s)
}

/// `sheet.page.size ?? [1322, 1870]`、`margin` 是数才用（缺省 75）
fn page_size(sheet: &StyleSheet) -> (f64, f64, f64) {
    let p = sheet.page();
    let (w, h) = match p.get("size").and_then(Value::as_array) {
        Some(a) if a.len() >= 2 => (a[0].as_f64().unwrap_or(f64::NAN), a[1].as_f64().unwrap_or(f64::NAN)),
        _ => (1322.0, 1870.0),
    };
    let margin = p.get("margin").and_then(Value::as_f64).unwrap_or(75.0);
    (w, h, margin)
}

/// flowLayout（util/layout.cpp:6）。
fn flow(frames: &mut [Frame], content_height: f64) {
    let mut ypos = content_height * 2.0;
    let mut last_mrg = 0.0;
    for frm in frames {
        let mrg = dolce_model::base::js::max(last_mrg, FRAME_MARGIN);
        let mut np = frm.force_new_page;
        if ypos + frm.height + mrg > content_height {
            np = true;
        }
        frm.new_page = np;
        // 原式换页时还把 lastMrg 清零，但随即被下面覆盖成 FRAME_MARGIN，等于没有
        if np {
            ypos = 0.0;
        } else {
            ypos += mrg;
        }
        frm.ypos = ypos;
        ypos += frm.height;
        last_mrg = FRAME_MARGIN;
    }
}

/// `/\bhwid\b/`（ASCII 词界）
fn has_hwid(s: &str) -> bool {
    let b = s.as_bytes();
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    s.match_indices("hwid").any(|(i, _)| (i == 0 || !word(b[i - 1])) && (i + 4 >= b.len() || !word(b[i + 4])))
}

/// 模板排出的文字 → 文字节点（逐字笔位自己算，见 TS 注释：标点不挤压、开 hwid 的标点排半格、西文段整段量保字距）
fn placed_to_text_frames(page: &mut Node, placed: &[Placed], sheet: &StyleSheet, families: &FamilyMap, mc: &MeasureCtx) {
    for p in placed {
        let Placed::Text(p) = p else { continue };
        let font = font_of(sheet, families, &p.role, p.size);
        let features = sheet.role_prop(&p.role, "features").filter(|v| !v.is_null()).map(js_to_string).unwrap_or_default();
        let hwid = has_hwid(&features);
        let pad = font.measure_text(mc, "一一");
        let bar = font.measure_text(mc, "|");
        let chars: Vec<char> = p.text.chars().collect();
        let half_cell = |i: usize| -> bool {
            if !hwid {
                return false;
            }
            let mut buf = [0u8; 4];
            matches!(punct_class(chars[i].encode_utf8(&mut buf)), PunctClass::Open | PunctClass::Close | PunctClass::Stop)
        };
        let latin = |i: usize| (chars[i] as u32) < 0x2000;
        let mut xs: Vec<f64> = Vec::new();
        let mut w = 0.0;
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if latin(i) {
                let mut j = i;
                while j < chars.len() && latin(j) {
                    j += 1;
                }
                let seg: String = chars[i..j].iter().collect();
                for k in 0..j - i {
                    let pre: String = chars[i..i + k].iter().collect();
                    xs.push(w + if k > 0 { font.measure_text(mc, &format!("|{pre}|")) - 2.0 * bar } else { 0.0 });
                }
                w += font.measure_text(mc, &format!("|{seg}|")) - 2.0 * bar;
                i = j;
            } else if half_cell(i) {
                let cell = font.size * 0.5;
                let ink = font.char_bound(mc, &c.to_string());
                xs.push(w + (cell - (ink.right - ink.left)) / 2.0 - ink.left);
                w += cell;
                i += 1;
            } else {
                xs.push(w);
                w += font.measure_text(mc, &format!("一{c}一")) - pad;
                i += 1;
            }
        }
        let x = match p.align.as_str() {
            "center" => p.x - w / 2.0,
            "right" => p.x - w,
            _ => p.x,
        };
        let mut tf = Node::text(p.text.clone(), font);
        tf.text_mut().char_xs = Some(xs);
        tf.m = Matrix33::from_affine([1.0, 0.0, 0.0, 1.0, x, p.y]);
        page.push(tf);
    }
}

fn expr_flag(s: &SongLayout, families: &FamilyMap, mc: &MeasureCtx, key: &str) -> bool {
    let env = s.env(families, mc, 0.0, 1.0);
    match env.field(&format!("meta.{key}")).and_then(|v| v.into_iter().next()) {
        None => true,
        Some(v) => v.text == "true",
    }
}

/// 混排歌本（TS `layoutMixedSongbook`）
pub fn layout_mixed_songbook(input: &SongbookInput, env: &Env) -> Result<SongbookResult, String> {
    let mc = env.mc;
    let families = &input.families;
    // （清单序号, 错误）：读谱与排版分两趟，最后按清单序排回 TS 逐首 try 的次序
    let mut errors: Vec<(usize, SongError)> = Vec::new();
    let err_title = |e: &ManifestSong| e.title.clone().unwrap_or_else(|| e.file.clone());

    // 读谱（各曲的文档、表层、样式表要活过整本排版，先全部读好再排）
    let mut inputs: Vec<Option<StaffInput>> = Vec::new();
    for (i, src) in input.songs.iter().enumerate() {
        match catch(|| songbook_staff_input(&src.xml, &src.entry, &input.rules)) {
            Ok(v) => inputs.push(Some(v)),
            Err(e) => {
                errors.push((i, SongError { title: err_title(&src.entry), error: e }));
                inputs.push(None);
            }
        }
    }
    let prepared: Vec<Option<std::borrow::Cow<Song>>> = inputs.iter().map(|i| i.as_ref().map(|i| read::prepare_song(&i.doc.songs[0]))).collect();
    let mut songs: Vec<SongLayout> = Vec::new();
    for (i, (inp, sg)) in inputs.iter().zip(&prepared).enumerate() {
        let (Some(inp), Some(sg)) = (inp, sg) else { continue };
        let owner = songs.len();
        match catch(|| song_layout(inp, sg, i, owner, families, env)) {
            Ok(s) => songs.push(s),
            Err(e) => errors.push((i, SongError { title: err_title(&input.songs[i].entry), error: e })),
        }
    }
    errors.sort_by_key(|e| e.0);
    let errors: Vec<SongError> = errors.into_iter().map(|e| e.1).collect();
    if songs.is_empty() {
        return Ok(SongbookResult { pages: vec![], toc: vec![], starts: vec![], titles: vec![], families: vec![], errors, frames: vec![] });
    }

    let c = ctx(&[("engine", Value::String("staff".into())), ("mode", Value::String("mixed".into()))]);
    let book = compute_style_for_paper(&[theme(ThemeId::Staff), &input.rules], &c);
    let (page_w, page_h, margin) = page_size(&book);
    let song_start = input
        .song_start
        .clone()
        .or_else(|| expr_word(book.template().and_then(|t| t.get("flow")).and_then(|f| f.get("song-start"))))
        .unwrap_or_else(|| "new-page".into());

    let mut frames: Vec<Frame> = Vec::new();
    for s in &mut songs {
        if s.frames.is_empty() {
            continue;
        }
        // 单曲版：每首强制换页；接排版：按清单的 layout.new-page
        let np = song_start == "new-page" || expr_flag(s, families, mc, "layout.new-page");
        s.frames[0].force_new_page = np;
        frames.append(&mut s.frames);
    }
    flow(&mut frames, page_h - margin * 2.0);

    // SongBook::drawFrame
    let mut page_groups: Vec<Node> = Vec::new();
    let mut page_scaling: Vec<f64> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    for frm in &frames {
        // TS `songs[frm.song]`：按清单序号取已排成的曲子（前面有曲子出错时会错位，照搬）
        let s = songs.get(frm.song).ok_or_else(|| format!("第 {} 首的帧找不到曲子", frm.song + 1))?;
        let own = &songs[frm.owner];
        if frm.new_page || page_groups.is_empty() {
            page_groups.push(Node::group());
            page_scaling.push(own.score.scaling);
        }
        if frm.first {
            starts.push(page_groups.len());
        }
        let page_no = page_groups.len() as f64;
        let page = page_groups.last_mut().expect("刚建");
        if frm.head {
            let e = s.env(families, mc, margin + frm.ypos, page_no);
            let head = layout_region(s.head.as_ref(), &e).map_err(ss_err)?;
            placed_to_text_frames(page, &head.items, s.sheet, families, mc);
        }
        let mut sys_grp = draw_system(&own.score, frm.sys);
        sys_grp.m = Matrix33::from_affine([1.0, 0.0, 0.0, 1.0, margin + own.score[frm.sys].left_margin, margin + frm.ypos + frm.top_y + frm.music_y_offset]);
        page.push(sys_grp);
        if frm.foot {
            let e = s.env(families, mc, margin + frm.ypos + frm.bottom_text_y_offset, page_no);
            let foot = layout_region(s.foot.as_ref(), &e).map_err(ss_err)?;
            placed_to_text_frames(page, &foot.items, s.sheet, families, mc);
        }
    }

    // 出 PDF 按角色（= 字体族）挑字体文件；粗体、斜体各是另一份字体文件，角色名带「 Bold」「 Italic」
    let used: RefCell<IndexSet<String>> = RefCell::new(IndexSet::new());
    let mut role_of = |_: &Node, t: &TextShape| -> String {
        let fam = format!("{}{}{}", t.font.family, if t.font.bold { " Bold" } else { "" }, if t.font.italic { " Italic" } else { "" });
        used.borrow_mut().insert(fam.clone());
        fam
    };
    let mut pages = Vec::new();
    for (i, g) in page_groups.iter().enumerate() {
        let o = ToDrawOptions {
            role_of: RoleOf::Custom(&mut role_of),
            page_no: i as i64 + 1,
            meta: PageMeta { kind: "score".into(), songs: vec![], page_label: None },
            scale: Some(page_scaling[i]),
            offset: None,
        };
        let mut p = page_items_to_draw_page(Some(g), page_w, page_h, o, env).map_err(|e| e.0)?;
        // 纸张一律 A4，谱面按各曲 scaling 缩放后贴左上角
        p.w = A4_PT.0;
        p.h = A4_PT.1;
        pages.push(p);
    }
    let titles: Vec<String> = songs.iter().map(|s| s.title.clone()).collect();
    let toc = toc_pages(&book, &titles, &starts, families, &used, mc).map_err(ss_err)?;
    let frame_facts = frames
        .iter()
        .map(|f| FrameFact {
            song: f.song,
            height: f.height,
            ypos: f.ypos,
            new_page: f.new_page,
            head: if f.first { f.music_y_offset } else { 0.0 },
            foot: if f.last { f.height - f.bottom_text_y_offset } else { 0.0 },
        })
        .collect();
    let families = used.into_inner().into_iter().collect();
    let _ = page_w;
    Ok(SongbookResult { pages, toc, starts, titles, families, errors, frames: frame_facts })
}

/// 逐首 try：错误与 panic 都记成出错（TS 的异常）
fn catch<T>(f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(r) => r,
        Err(p) => Err(p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_else(|| "panic".into())),
    }
}

// ───────────────────────── 目录（genTOC） ─────────────────────────

/// 目录页的模板环境（TS `tocPages` 里的 `env(fields)`）
struct TocEnv<'a> {
    fields: IndexMap<String, Option<FieldExtra>>,
    sheet: &'a StyleSheet,
    families: &'a FamilyMap,
    used: &'a RefCell<IndexSet<String>>,
    mc: &'a MeasureCtx<'a>,
}

impl TocEnv<'_> {
    fn measure_text(&self, role: &str, t: &str, size: f64) -> f64 {
        font_of(self.sheet, self.families, role, size).measure_text(self.mc, t)
    }
    /// 一段字逐字落笔位
    fn text(&self, t: &str, role: &str, x: f64, y: f64, size: f64) -> DrawItem {
        let font = font_of(self.sheet, self.families, role, size);
        self.used.borrow_mut().insert(font.family.clone());
        let mut xs = Vec::new();
        let mut acc = x;
        for ch in t.chars() {
            xs.push(acc);
            acc += font.measure_text(self.mc, &ch.to_string());
        }
        DrawItem::Text(DrawText {
            y,
            dy: None,
            text: t.to_string(),
            size,
            role: font.family,
            align: "pen".into(),
            xs,
            ws: None,
            ink_box: None,
            color: None,
            song_id: None,
            cls: None,
            ink_top: None,
        })
    }
    fn with(&self, fields: IndexMap<String, Option<FieldExtra>>) -> TocEnv<'_> {
        TocEnv { fields, sheet: self.sheet, families: self.families, used: self.used, mc: self.mc }
    }
    /// `leader(dots, 到)`：能塞多少个「.」就塞多少，右端贴 `到`，比基线高 0.3 个字号
    fn leader(&self, call: &ComponentCall) -> Result<Vec<Value>, SsError> {
        let ok = matches!(call.args.first(), Some(Expr::Id { v }) if v == "dots") && call.args.len() > 1;
        if !ok {
            return Err(SsError { message: "目录点线写 leader(dots, 右端 x)".into() });
        }
        let e0 = self.with(IndexMap::new());
        let to = eval_num(call.args.get(1), &e0, None)?.expect("有表达式");
        let (role, size, y) = (call.role, call.size, call.y);
        // 贴着左边最靠右的那段字；减法顺序照原式
        let space = call.row.iter().filter(|p| p.x < to).map(|p| to - self.measure_text(&p.role, &p.text, p.size) - p.x).fold(to, dolce_model::base::js::min);
        let mut dots = String::new();
        let mut j = 0.0;
        while j < (space * 5.0) / size {
            if self.measure_text(role, &format!("{dots}."), size) > space {
                break;
            }
            dots.push('.');
            j += 1.0;
        }
        let item = self.text(&dots, role, to - self.measure_text(role, &dots, size), y - size * 0.3, size);
        Ok(vec![serde_json::to_value(item).expect("图元写得出")])
    }
}

impl RegionEnv for TocEnv<'_> {
    fn field(&self, path: &str) -> Option<Vec<FieldValue>> {
        song_field(None, &self.fields, path)
    }
    fn page_no(&self) -> f64 {
        1.0
    }
    fn content(&self) -> (f64, f64) {
        (0.0, A4_PT.0)
    }
    fn page_width(&self) -> Option<f64> {
        Some(A4_PT.0)
    }
    fn size_of(&self, role: &str) -> f64 {
        let v = self.sheet.role_prop(role, "size").cloned().unwrap_or(Value::Null);
        resolve_length(&v, LengthContext { em: 12.0, sp: 6.0, pt: Some(1.0) }).unwrap_or(12.0)
    }
    fn measure(&self, role: &str, text: &str, size: f64) -> f64 {
        self.measure_text(role, text, size)
    }
    fn component(&self, name: &str, call: &ComponentCall) -> Option<Result<Vec<Value>, SsError>> {
        (name == "leader").then(|| self.leader(call))
    }
}

/// 目录页（A4 pt 口径，`@template toc`；TS `tocPages`）。
fn toc_pages(sheet: &StyleSheet, titles: &[String], starts: &[usize], families: &FamilyMap, used: &RefCell<IndexSet<String>>, mc: &MeasureCtx) -> Result<Vec<DrawPage>, SsError> {
    let region: Region = match sheet.region("toc") {
        None | Some(Value::Null) => return Ok(vec![]),
        Some(v) => serde_json::from_value(v.clone()).map_err(|e| SsError { message: format!("目录模板读不进：{e}") })?,
    };
    let (w, h) = A4_PT;
    let e0 = TocEnv { fields: IndexMap::new(), sheet, families, used, mc };
    let to_items = |placed: Vec<Placed>| -> Vec<DrawItem> {
        placed
            .into_iter()
            .map(|p| match p {
                Placed::Raw { item } => serde_json::from_value(item).expect("组件产出的是图元"),
                Placed::Text(PlacedText { text, role, size, x, y, align }) => {
                    let x = match align.as_str() {
                        "center" => x - e0.measure_text(&role, &text, size) / 2.0,
                        "right" => x - e0.measure_text(&role, &text, size),
                        _ => x,
                    };
                    e0.text(&text, &role, x, y, size)
                }
            })
            .collect()
    };
    let new_page = |pages: &mut Vec<DrawPage>| {
        let n = pages.len() as i64 + 1;
        pages.push(DrawPage::new(n, w, h, PageMeta { kind: "toc".into(), songs: vec![], page_label: None }));
    };
    let mut pages: Vec<DrawPage> = Vec::new();
    new_page(&mut pages);
    let is_repeat = |r: &Row| r.props.contains_key("repeat");
    let plain = Region { props: region.props.clone(), rows: region.rows.iter().filter(|r| !is_repeat(r)).cloned().collect() };
    let items = to_items(layout_region(Some(&plain), &e0)?.items);
    pages.last_mut().expect("有页").items.extend(items);
    for row in region.rows.iter().filter(|r| is_repeat(r)) {
        let rep = serde_json::to_value(row.props.get("repeat")).ok();
        if expr_word(rep.as_ref()).as_deref() != Some("toc") {
            return Err(SsError { message: "目录区域的重复行只认 repeat: toc".into() });
        }
        let role = row.cells.iter().flat_map(|c| c.lines.iter()).find(|l| matches!(l.content, dolce_engrave::style::ss::Content::Text { .. })).and_then(|l| l.role.clone()).unwrap_or_else(|| "toc".into());
        let first = eval_num(row.props.get("baseline"), &e0, None)?;
        let step = eval_num(row.props.get("step"), &e0, Some(&role))?;
        let (Some(first), Some(step)) = (first, step) else {
            return Err(SsError { message: "目录的重复行要写 baseline 与 step".into() });
        };
        let mut y = first;
        for (i, title) in titles.iter().enumerate() {
            if y > h - 40.0 {
                new_page(&mut pages);
                y = first;
            }
            let mut f: IndexMap<String, Option<FieldExtra>> = IndexMap::new();
            f.insert("toc.seq".into(), Some(FieldExtra::Str((i + 1).to_string())));
            f.insert("toc.pad".into(), Some(FieldExtra::Str(if i < 9 { " " } else { "" }.into())));
            f.insert("work.title".into(), Some(FieldExtra::Str(title.clone())));
            f.insert("toc.page".into(), Some(FieldExtra::Str(starts.get(i).map(|s| s.to_string()).unwrap_or_default())));
            let fe = e0.with(f);
            let mut props = row.props.clone();
            props.insert("baseline".into(), Expr::Num { v: y, unit: None });
            let one = Region { props: region.props.clone(), rows: vec![Row { props, cells: row.cells.clone() }] };
            let items = to_items(layout_region(Some(&one), &fe)?.items);
            pages.last_mut().expect("有页").items.extend(items);
            y += step;
        }
    }
    Ok(pages)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hwid_word() {
        assert!(has_hwid("hwid"));
        assert!(has_hwid("halt,hwid"));
        assert!(!has_hwid("xhwid"));
        assert!(!has_hwid("hwid2"));
    }
}
