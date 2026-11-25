//! 成书这一路排一首（照 `src/pdflayout/browser.ts`）：读谱（只留第一首第一声部、去段落词与段号、规整房号）、
//! 简谱引擎 `book` 档排版、场景树 → DrawList（矩阵展开、逐字笔位实测）、数谱行与最长谱行格数、量自然跨度与一行容量。
//!
//! TS 的 `instanceof`（`SmuflText` / `JpNumber` / `Lyric`）在这里看 [`Shape`] 与 [`Role`]；
//! 回调参数 `roleOf` 是 [`RoleOf`]（缺省 / 成书 / 调用方自己的闭包）。判据、阈值连同 TS 的毛病一起搬。

use std::collections::HashMap;

use dolce_base::js::{self, NumKey};
use dolce_layout_jianpu::compose::{layout_jianpu, JianpuConfig, JianpuLayout};
use dolce_layout_jianpu::grid::GridPage;
use dolce_layout_jianpu::place::reflow::NaturalSpan;
use dolce_model::breaks::clear_song_breaks;
use dolce_model::doc::{Direction, DirectionPart, Element, ScoreDoc};
use dolce_model::helpers::is_section_word;
use dolce_model::melodyonly::keep_first_part;
use dolce_scene::build::{bound, Env, SceneError};
use dolce_scene::{Node, PathOp, PathShape, Role, Shape, TextShape, INVISIBLE};
use dolce_style::cascade::{compute_style, ctx, StyleRule};
use dolce_style::jianpu::jianpu_style_of;
use dolce_style::jianpustyle::JianpuStyle;
use dolce_style::themes::{theme, ThemeId};
use dolce_text::Font;
use serde_json::{json, Value};

use crate::draw::{DrawItem, DrawLine, DrawPage, DrawPath, DrawText, PageMeta};

/// 2D 仿射：[a b c d e f]，与 SVG 的 matrix(a b c d e f) 同序。
type Mat6 = [f64; 6];

/// m 之后再作用 n（即先 n 后 m 的坐标变换 = m ∘ n）。
fn concat(m: &Mat6, n: &Mat6) -> Mat6 {
    [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ]
}

fn apply_x(m: &Mat6, x: f64, y: f64) -> f64 {
    m[0] * x + m[2] * y + m[4]
}
fn apply_y(m: &Mat6, x: f64, y: f64) -> f64 {
    m[1] * x + m[3] * y + m[5]
}

/// `Matrix33.mat` 的排布：[scaleX, skewX, transX, skewY, scaleY, transY, …]
fn mat_of(it: &Node) -> Mat6 {
    let a = &it.m.mat;
    [a[0], a[3], a[1], a[4], a[2], a[5]]
}

/// 等比缩放系数（`Math.hypot(m[0], m[1]) || 1`）
fn scale_of(m: &Mat6) -> f64 {
    let h = m[0].hypot(m[1]);
    if h == 0.0 || h.is_nan() {
        1.0
    } else {
        h
    }
}

/// `argb & 0xffffff`（JS 位运算先转 int32）
fn argb_to_rgb(argb: f64) -> u32 {
    (js::to_int32(argb) & 0xffffff) as u32
}

/// `Math.round(v * 100) / 100` 再 `toString()`
fn round2(v: f64) -> String {
    js::num_to_string(js::round(v * 100.0) / 100.0)
}

/// 增时线要往上挪多少，才能让它的墨迹中心与数字的墨迹中心（＝小节线中点）齐平（按增时线自己的字量）。
fn dash_ink_shift_of(font: &Font, env: &Env) -> f64 {
    let nb = font.char_bound(env.mc, "1");
    let db = font.char_bound(env.mc, "-");
    (nb.top + nb.bottom) / 2.0 - (db.top + db.bottom) / 2.0
}

/// 透到 `DrawText.cls` 的那几个 class（顺序即优先级）。
const CLS_TAGS: [&str; 10] = ["ending", "ending-line", "section-word", "key-change", "chord", "direction", "tuplet-line", "grace", "grace-line", "artic"];

fn cls_of(it: &Node) -> Option<String> {
    CLS_TAGS.iter().find(|c| it.has_class(c)).map(|c| c.to_string())
}

fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| matches!(c, '\u{3400}'..='\u{9fff}' | '\u{f900}'..='\u{faff}'))
}

/// 文字叶子的角色（TS `roleOfItem`）。`it` 是文字或 SMuFL 字节点。
pub fn role_of_item(it: &Node, t: &TextShape) -> String {
    let smufl = matches!(it.shape, Shape::Smufl(_));
    let r = if it.has_class("chord-music") || it.has_class("smufl") {
        "smufl"
    } else if it.has_class("chord") {
        "chord"
    } else if it.has_class("direction") {
        if smufl {
            "smufl"
        } else if has_cjk(&t.text) {
            "lyric"
        } else {
            "chord"
        }
    } else if it.has_class("ending") {
        "verseNum"
    } else if it.has_class("section-word") {
        "sectionWord"
    } else if smufl {
        "smufl"
    } else if matches!(it.role, Some(Role::JpNumber { .. }) | Some(Role::JpOctaveDot { .. })) {
        "note"
    } else {
        // `Lyric` 与其余文字（段号等）都随歌词
        "lyric"
    };
    r.to_string()
}

/// `^\d+\.$`
fn is_verse_label(s: &str) -> bool {
    s.len() >= 2 && s.ends_with('.') && s[..s.len() - 1].bytes().all(|b| b.is_ascii_digit())
}

/// 简谱引擎排的成书页：文字叶子的角色（TS `bookRoleOf`，`page_items_to_draw_page` 的 `roleOf`）。
pub fn book_role_of(it: &Node, t: &TextShape) -> String {
    if it.cls.is_empty() && !matches!(it.role, Some(Role::Lyric { .. })) && is_verse_label(&t.text) {
        "verseNum".into()
    } else {
        role_of_item(it, t)
    }
}

/// 文字叶子该按哪个角色落字（TS `ToDrawOptions.roleOf`）。
pub enum RoleOf<'a> {
    /// 不给：`roleOfItem`
    Item,
    /// `bookRoleOf`
    Book,
    /// 调用方自己的（混排按字体族定角色，见 `songbook`）
    Custom(&'a mut dyn FnMut(&Node, &TextShape) -> String),
}

impl RoleOf<'_> {
    fn call(&mut self, it: &Node, t: &TextShape) -> String {
        match self {
            RoleOf::Item => role_of_item(it, t),
            RoleOf::Book => book_role_of(it, t),
            RoleOf::Custom(f) => f(it, t),
        }
    }
}

/// TS `ToDrawOptions`（`style` 没用到，不搬）
pub struct ToDrawOptions<'a> {
    pub role_of: RoleOf<'a>,
    pub page_no: i64,
    pub meta: PageMeta,
    /// 页面树的坐标单位 → pt 的缩放（缺省 1）
    pub scale: Option<f64>,
    /// 整页平移（pt）
    pub offset: Option<(f64, f64)>,
}

/// GraphicPath 的 segs → 变换后的 SVG path（坐标烘进去，DrawPath 不带 transform）。
fn path_data(p: &PathShape, m: &Mat6) -> String {
    let mut d = String::new();
    for seg in &p.segs {
        if seg.op == PathOp::Z {
            d.push('Z');
            continue;
        }
        let mut pts: Vec<String> = Vec::new();
        let mut i = 0;
        while i + 1 < seg.pts.len() {
            let (x, y) = (seg.pts[i], seg.pts[i + 1]);
            pts.push(format!("{} {}", round2(apply_x(m, x, y)), round2(apply_y(m, x, y))));
            i += 2;
        }
        d.push(match seg.op {
            PathOp::M => 'M',
            PathOp::L => 'L',
            _ => 'C',
        });
        d.push_str(&pts.join(" "));
    }
    d
}

/// 前缀以空格结尾时 SVG 量宽会把尾部空格去掉：尾部空白单独量了补上
fn prefix_x(font: &Font, chars: &[char], i: usize, env: &Env) -> f64 {
    let prefix: String = chars[..i].iter().collect();
    let trail_start = prefix.char_indices().rev().take_while(|(_, c)| js::is_space(*c)).last().map(|(k, _)| k);
    match trail_start {
        Some(k) if k > 0 => font.measure_text(env.mc, &prefix) + font.measure_text(env.mc, &prefix[k..]),
        _ => font.measure_text(env.mc, &prefix),
    }
}

struct Walker<'r, 'a, 'e> {
    items: Vec<DrawItem>,
    role_of: RoleOf<'r>,
    env: &'a Env<'e>,
}

impl Walker<'_, '_, '_> {
    fn walk(&mut self, it: &Node, parent: &Mat6) -> Result<(), SceneError> {
        // 只占位、不印的图元：排版照常量它，出口一律不画
        if it.cls.iter().any(|c| c == INVISIBLE) {
            return Ok(());
        }
        let m = concat(parent, &mat_of(it));
        match &it.shape {
            Shape::Path(p) => {
                let d = path_data(p, &m);
                if !d.is_empty() {
                    self.items.push(DrawItem::Path(DrawPath {
                        d,
                        fill: p.fill.then(|| argb_to_rgb(p.fill_color)),
                        stroke: p.stroke.then(|| argb_to_rgb(p.stroke_color)),
                        sw: Some(if p.stroke { p.stroke_width * scale_of(&m) } else { 0.0 }),
                        dash: None,
                        cls: cls_of(it),
                    }));
                }
            }
            Shape::Line(l) => {
                self.items.push(DrawItem::Line(DrawLine {
                    x1: apply_x(&m, l.p0.x, l.p0.y),
                    y1: apply_y(&m, l.p0.x, l.p0.y),
                    x2: apply_x(&m, l.p1.x, l.p1.y),
                    y2: apply_y(&m, l.p1.x, l.p1.y),
                    sw: l.stroke_width * scale_of(&m),
                    color: Some(argb_to_rgb(l.stroke_color)),
                    cls: cls_of(it),
                }));
            }
            Shape::Text(t) => self.text(it, t, &m)?,
            Shape::Smufl(s) => self.text(it, &s.text, &m)?,
            Shape::Group | Shape::Item => {}
        }
        for ch in &it.k {
            self.walk(ch, &m)?;
        }
        Ok(())
    }

    fn text(&mut self, it: &Node, t: &TextShape, m: &Mat6) -> Result<(), SceneError> {
        if t.text.is_empty() {
            return Ok(());
        }
        let env = self.env;
        let chars: Vec<char> = t.text.chars().collect();
        // 逐字笔位用实测的 advance 前缀和；带标点挤压（`charXs`）时用排版期量好的那串坐标
        let xs: Vec<f64> = match &t.char_xs {
            Some(cx) if cx.len() == chars.len() => cx.iter().map(|&c| apply_x(m, c, 0.0)).collect(),
            _ => (0..chars.len()).map(|i| apply_x(m, prefix_x(&t.font, &chars, i, env), 0.0)).collect(),
        };
        let role0 = self.role_of.call(it, t);
        // 增时线按墨迹与数字对齐：只在画的时候补这一下
        let dash = role0 == "note" && (t.text == "-" || t.text == "\u{2013}");
        let cls = cls_of(it);
        let dy = if dash { dash_ink_shift_of(&t.font, env) } else { 0.0 };
        let y = apply_y(m, 0.0, 0.0);
        let ink_top = match &it.shape {
            Shape::Smufl(_) => {
                let b = bound(it, env).ok_or_else(|| SceneError("no smufl bbox".into()))?;
                Some(b.top * scale_of(m))
            }
            _ => None,
        };
        self.items.push(DrawItem::Text(DrawText {
            y,
            // `...(dy ? { dy } : {})`：0 与 NaN 都不写
            dy: (dy != 0.0 && !dy.is_nan()).then_some(dy),
            text: t.text.clone(),
            size: t.font.size * scale_of(m),
            role: role0,
            // 表情/跳转记号整段自然排（`left`），不逐字按笔位落
            align: if cls.as_deref() == Some("direction") { "left" } else { "pen" }.into(),
            xs,
            ws: None,
            ink_box: None,
            color: Some(argb_to_rgb(t.color)),
            song_id: None,
            cls,
            ink_top,
        }));
        Ok(())
    }
}

/// 页面树 → 扁平 DrawList（TS `pageItemsToDrawPage`）。展开矩阵、逐字实测笔位、颜色照抄。
/// SMuFL 字取不到盒时同 TS 抛错。
pub fn page_items_to_draw_page(root: Option<&Node>, w: f64, h: f64, o: ToDrawOptions, env: &Env) -> Result<DrawPage, SceneError> {
    let k = o.scale.unwrap_or(1.0);
    let (ox, oy) = o.offset.unwrap_or((0.0, 0.0));
    let base: Mat6 = [k, 0.0, 0.0, k, ox, oy];
    let mut wk = Walker { items: Vec::new(), role_of: o.role_of, env };
    if let Some(r) = root {
        wk.walk(r, &base)?;
    }
    let mut p = DrawPage::new(o.page_no, w * k, h * k, o.meta);
    p.items = wk.items;
    Ok(p)
}

// ───────────────── 数谱行 ─────────────────

/// 占一格的音符：数字（含带附点的 `5·`、休止 `0`）与增时线。
fn is_cell_note(t: &str) -> bool {
    t.as_bytes().first().is_some_and(u8::is_ascii_digit) || t == "-" || t == "\u{2013}"
}

/// 占一格的音符的基线（四舍五入）；倚音不占格
fn cell_rows(p: &DrawPage) -> impl Iterator<Item = NumKey> + '_ {
    p.items.iter().filter_map(|it| match it {
        DrawItem::Text(t) if t.role == "note" && t.cls.as_deref() != Some("grace") && is_cell_note(&t.text) => Some(NumKey::new(js::round(t.y))),
        _ => None,
    })
}

/// 数一份 DrawList 里有几条谱行（按页分组、按音符的基线分组；只数占一格的数字与增时线）。
pub fn count_staff_rows(pages: &[DrawPage]) -> usize {
    pages.iter().map(|p| cell_rows(p).collect::<std::collections::HashSet<_>>().len()).sum()
}

/// 一份 DrawList 里最长的那条谱行有几格。
pub fn max_staff_row_cells(pages: &[DrawPage]) -> usize {
    let mut mx = 0;
    for p in pages {
        let mut per: HashMap<NumKey, usize> = HashMap::new();
        for k in cell_rows(p) {
            *per.entry(k).or_insert(0) += 1;
        }
        mx = per.values().copied().fold(mx, usize::max);
    }
    mx
}

// ───────────────── 成书 ─────────────────

/// 成书读谱：MusicXML → 文档，只留第一首、第一个声部（主旋律）（TS `bookDocOf`）。
pub fn book_doc_of(xml: &str) -> Result<ScoreDoc, String> {
    let mut doc = dolce_model::fromxml::load_score_doc(xml).map_err(|m| format!("{m:?}"))?.doc;
    doc.songs.truncate(1);
    for song in &mut doc.songs {
        keep_first_part(song);
        for part in &mut song.parts {
            for m in &mut part.measures {
                // 谱里自带的段落词文字（「（副歌）」）不印：成书的段落词只认书级元数据
                if let Some(ds) = m.directions.take() {
                    m.directions = Some(ds.into_iter().flat_map(drop_section_words).collect());
                }
                // 歌词字前印的段号（MusicXML 把「1.」写进首字）去掉
                for el in &mut m.elements {
                    let Element::Chord(c) = el else { continue };
                    for l in c.lyrics.iter_mut().flatten() {
                        if let Some((at, _)) = l.text.char_indices().find(|(_, ch)| !(ch.is_ascii_digit() || *ch == '.')) {
                            if at > 0 {
                                l.text = l.text[at..].to_string();
                            }
                        }
                    }
                }
                // 房号规整成 `1.2`（原书口径）
                for b in m.barlines.iter_mut().flatten() {
                    if let Some(e) = b.ending.as_mut() {
                        if let Some(t) = e.text.as_mut().filter(|t| !t.is_empty()) {
                            *t = dolce_engrave::ending::norm_ending_text(t);
                        }
                    }
                }
            }
        }
    }
    Ok(doc)
}

/// `\p{L}` / `\p{N}`
fn has_word_char(t: &str) -> bool {
    t.chars().any(|c| c.is_alphabetic() || c.is_numeric())
}

/// 是不是段落词文字（或只有标点）的 `<words>`
fn is_word(kind: &str, text: Option<&str>) -> bool {
    if kind != "words" {
        return false;
    }
    let t = js::trim(text.unwrap_or(""));
    let bare = strip_paren(t);
    is_section_word(t) || is_section_word(bare) || !has_word_char(t)
}

/// `.replace(/^[（(]\s*/, "").replace(/\s*[）)]$/, "")`
fn strip_paren(t: &str) -> &str {
    let mut s = t;
    if let Some(r) = s.strip_prefix('（').or_else(|| s.strip_prefix('(')) {
        s = r.trim_start_matches(js::is_space);
    }
    if let Some(r) = s.strip_suffix('）').or_else(|| s.strip_suffix(')')) {
        s = r.trim_end_matches(js::is_space);
    }
    s
}

/// 一条 `<direction>` 去掉段落词文字（与只有标点的文字）之后剩下的（没剩就整条不要）
fn drop_section_words(d: Direction) -> Vec<Direction> {
    let mut more: Vec<DirectionPart> = d.more.clone().unwrap_or_default().into_iter().filter(|p| !is_word(&p.kind, p.text.as_deref())).collect();
    // `{ ...d }` 是新对象：TS 里查不到身份
    let mut out = if !is_word(&d.kind, d.text.as_deref()) {
        Direction { oid: Default::default(), ..d }
    } else {
        if more.is_empty() {
            return vec![];
        }
        let head = more.remove(0);
        // 头一项换成剩下的第一项：子元素那几个字段整套换掉，再 `Object.assign(out, head)`
        let mut o = Direction { oid: Default::default(), kind: head.kind, text: None, tempo: None, span_type: None, wedge_type: None, line: None, ..d };
        o.text = head.text;
        o.tempo = head.tempo;
        o.span_type = head.span_type;
        o.wedge_type = head.wedge_type;
        o.line = head.line;
        if head.shift.is_some() {
            o.shift = head.shift;
        }
        o
    };
    out.more = (!more.is_empty()).then_some(more);
    vec![out]
}

/// 成书这一路排一首的结果（TS `JianpuLayout & { naturalH }`）
pub struct BookLayout {
    pub layout: JianpuLayout,
    /// 首页谱行自然叠起来的高（半页起排、紧排用）
    pub natural_h: f64,
}

fn style_num(style: &Value, path: &[&str]) -> f64 {
    dolce_style::value::get_path(style, path).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// 成书这一路的尺子（TS `bookStyleOf`：简谱引擎吃的那份 `JianpuStyle`）。
pub fn book_style_of(style: &Value, env: &Env) -> Result<JianpuStyle, String> {
    let layer = vec![StyleRule { when: None, set: json!({ "book": style }) }];
    let sheet = compute_style(&[theme(ThemeId::Book), &layer], &ctx(&[("engine", Value::String("book".into()))]));
    jianpu_style_of(&sheet, env.mc)
}

/// 成书这一路交给简谱引擎的配置（TS `bookCfgOf`）。
pub fn book_cfg_of(style: &Value, page_h: f64, measure: bool, env: &Env) -> Result<JianpuConfig, String> {
    Ok(JianpuConfig {
        style: book_style_of(style, env)?,
        page: GridPage { width: style_num(style, &["page", "w"]), height: page_h, continuous: false },
        user_margins: false,
        foot: None,
        no_reflow: false,
        expanded: false,
        break_desc: None,
        book: true,
        measure,
        snippet: false,
        ink: None,
        layout: None,
    })
}

/// 成书这一路排一首（TS `layoutBookDoc`）：按 BookStyle 排到宽 `style.page.w`、高 `pageH` 的纸上，没有标题页。
pub fn layout_book_doc(doc: &ScoreDoc, style: &Value, page_h: f64, measure: bool, env: &Env) -> Result<BookLayout, String> {
    let cfg = book_cfg_of(style, page_h, measure, env)?;
    let layout = layout_jianpu(doc, &cfg, env);
    let natural_h = layout.placed.pages.first().map_or(0.0, |p| p.natural.unwrap_or(0.0));
    Ok(BookLayout { layout, natural_h })
}

/// 版心宽与各音（元素 id）的自然横向区间（按插入序）
pub type BookSpans = (f64, Vec<(i64, NaturalSpan)>);

/// 真实坐标量一遍（TS `measureBookSpans`）：清掉原谱的换行、整首不折，量每个音的自然横向区间与版心宽。
pub fn measure_book_spans(doc: &mut ScoreDoc, style: &Value, env: &Env) -> Result<BookSpans, String> {
    for song in &mut doc.songs {
        clear_song_breaks(song);
    }
    let r = layout_book_doc(doc, style, style_num(style, &["page", "h"]), true, env)?;
    Ok(r.layout.spans.unwrap_or((0.0, Vec::new())))
}

/// 空排一遍量「一行放得下几格」（TS `bookCellsPerLine`）。
pub fn book_cells_per_line(doc: &mut ScoreDoc, style: &Value, env: &Env) -> Result<f64, String> {
    for song in &mut doc.songs {
        clear_song_breaks(song);
    }
    let (pw, ph) = (style_num(style, &["page", "w"]), style_num(style, &["page", "h"]));
    let r = layout_book_doc(doc, style, ph, false, env)?.layout;
    let mut dps = Vec::new();
    for (i, g) in r.pages.iter().enumerate() {
        let o = ToDrawOptions {
            role_of: RoleOf::Book,
            page_no: i as i64 + 1,
            meta: PageMeta { kind: "score".into(), songs: vec![], page_label: None },
            scale: None,
            offset: None,
        };
        dps.push(page_items_to_draw_page(Some(g), pw, ph, o, env).map_err(|e| e.0)?);
    }
    let cells = max_staff_row_cells(&dps);
    let m = &r.metrics;
    let cw = m.page.width - m.page.margin.left - m.page.margin.right;
    let alt = || (cw / Font::new(m.style.font.lyric.family.clone(), m.style.size.lyric).measure_text(env.mc, "国")).floor();
    Ok(js::max(6.0, if cells > 0 { cells as f64 } else { alt() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        assert!(is_verse_label("12."));
        assert!(!is_verse_label("."));
        assert!(!is_verse_label("1.2"));
        assert_eq!(strip_paren("（ 副歌 ）"), "副歌");
        assert_eq!(round2(1.005), "1");
        assert_eq!(round2(-0.001), "0");
        assert_eq!(argb_to_rgb(4278190080.0 + 0x123456 as f64), 0x123456);
        assert!(is_cell_note("5·") && is_cell_note("-") && !is_cell_note("."));
    }
}
