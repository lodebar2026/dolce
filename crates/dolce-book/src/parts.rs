//! 书级内容 → DrawList（照 `src/pdflayout/bookparts.ts`）：调号拍号、花边框、折行、注解块、目录、索引、扉页 / 前言。
//!
//! 位置一律来自 BookStyle（原书实测），几处比例照 TS 原文（实测出处的注释留在 TS 那份）。
//! 书级量字由调用方注入（[`BookMeasure`]，与 PDF 写出端同一份字体、含标点挤压）。
//! 浮点口径：加减乘除的结合顺序照 TS 原式（`a += b + c` 是 `a + (b + c)`），对拍要逐位一致。

use crate::draw::{match_number, DrawItem, DrawPage, DrawPath, DrawRect, DrawText, InkSpan, PageMeta};
use crate::measure::BookMeasure;
use dolce_base::js;
use dolce_style::bookstyle::page_margins;
use dolce_style::value::get_path;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 样式里的一个数（缺了是 NaN，同 TS 的 `undefined` 进算术）
pub(crate) fn sn(style: &Value, path: &[&str]) -> f64 {
    get_path(style, path).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// `style.roles[role].size`
pub(crate) fn role_size(style: &Value, role: &str) -> f64 {
    sn(style, &["roles", role, "size"])
}

/// 一段字（`textItem`）：align 为 left 时 x 是左缘，right / center 时是参考点。
pub fn text_item(text: impl Into<String>, role: &str, size: f64, x: f64, y: f64, align: &str) -> DrawText {
    DrawText {
        y,
        dy: None,
        text: text.into(),
        size,
        role: role.into(),
        align: align.into(),
        xs: vec![x],
        ws: None,
        ink_box: Some(InkSpan { x, w: 0.0 }),
        color: None,
        song_id: None,
        cls: None,
        ink_top: None,
    }
}

// ─────────────────────────────── 调号拍号（拍号上下叠排）

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyMeterSpec {
    pub tonic: String,
    pub beats: Option<f64>,
    pub beat_type: Option<f64>,
    pub alt_tonic: Option<String>,
}

/// 调号里升降号的字号比（÷ 音名字号）与基线抬升量（× 音名字号），推导见 TS 原文
const KEY_ACC_SIZE: f64 = 0.72;
const KEY_ACC_RISE: f64 = 0.466;
/// 「=」两侧各让的空（`engrave/spacing.ts::EQ_PAD_EM`）
const EQ_PAD_EM: f64 = 0.2;

/// JS 真值（`x && …`：0 与 NaN 为假）
fn truthy_num(v: Option<f64>) -> bool {
    matches!(v, Some(x) if x != 0.0 && !x.is_nan())
}

/// `/^([♭♯])(.+)$/`：`.` 不认行终止符
fn split_acc(tonic: &str) -> Option<(char, &str)> {
    let mut it = tonic.chars();
    let c = it.next()?;
    if c != '♭' && c != '♯' {
        return None;
    }
    let rest = it.as_str();
    let line_term = |c: char| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    (!rest.is_empty() && !rest.chars().any(line_term)).then_some((c, rest))
}

/// `1=♭B  4/4  (1=A)`：拍号上下叠排，中间一条细横线（`keyMeterItems`）
pub fn key_meter_items(style: &Value, km: &KeyMeterSpec, x: f64, baseline: f64, measure: &dyn BookMeasure, size: Option<f64>) -> Vec<DrawItem> {
    let em = role_size(style, "keyMeter");
    let sz = size.unwrap_or(em);
    let mut items: Vec<DrawItem> = vec![];
    // 画一段带调号的文字，返回宽
    let put_tonic = |items: &mut Vec<DrawItem>, prefix: &str, tonic: &str, suffix: &str, x0: f64| -> f64 {
        let acc = split_acc(tonic);
        let mut cur = x0;
        let pad = sz * EQ_PAD_EM;
        let put = |items: &mut Vec<DrawItem>, cur: f64, t: &str, s: f64, y: f64| -> f64 {
            items.push(DrawItem::Text(text_item(t, "keyMeter", s, cur, y, "left")));
            measure.advance("keyMeter", t, s)
        };
        if let Some(eq) = prefix.find('=') {
            cur += put(items, cur, &prefix[..eq], sz, baseline) + pad;
            cur += put(items, cur, "=", sz, baseline) + pad;
        } else if !prefix.is_empty() {
            cur += put(items, cur, prefix, sz, baseline);
        }
        let Some((a, rest)) = acc else {
            cur += put(items, cur, &format!("{tonic}{suffix}"), sz, baseline);
            return cur - x0;
        };
        let acc_sz = sz * KEY_ACC_SIZE;
        let acc_ch = if a == '♯' { "#" } else { "b" };
        cur += put(items, cur, acc_ch, acc_sz, baseline - em * KEY_ACC_RISE) * 1.05;
        cur += put(items, cur, &format!("{rest}{suffix}"), sz, baseline);
        cur - x0
    };
    let mut cx = x + put_tonic(&mut items, "1=", &km.tonic, "", x) + em * 0.25;
    if truthy_num(km.beats) && truthy_num(km.beat_type) {
        let rule_w = em * 1.02;
        let top = js::num_to_string(km.beats.unwrap());
        let bot = js::num_to_string(km.beat_type.unwrap());
        let mid = cx + rule_w / 2.0;
        items.push(DrawItem::Text(text_item(&*top, "keyMeter", sz, mid - measure.advance("keyMeter", &top, sz) / 2.0, baseline - em * 0.439, "left")));
        items.push(DrawItem::Text(text_item(&*bot, "keyMeter", sz, mid - measure.advance("keyMeter", &bot, sz) / 2.0, baseline + em * 0.662, "left")));
        items.push(DrawItem::Rect(DrawRect { x: cx, y: baseline - em * 0.23, w: rule_w, h: 0.3, fill: Some(0), stroke: None, sw: None }));
        cx += rule_w + em * 0.216;
    }
    if let Some(alt) = km.alt_tonic.as_deref().filter(|s| !s.is_empty()) {
        put_tonic(&mut items, "(1=", alt, ")", cx);
    }
    items
}

// ─────────────────────────────── 花边框

/// 画一片花边要知道的东西（`OrnamentTileSpec`：提取侧 `OrnamentTile` 去掉 `style`）
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OrnamentTileSpec {
    /// `top` / `bottom` / `left` / `right` / `tl` / `tr` / `bl` / `br`
    pub slot: String,
    pub w: f64,
    pub h: f64,
    pub pitch: f64,
    pub ox: f64,
    pub oy: f64,
    pub path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct BoxRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 绝对坐标路径平移（`bookmeta.ts::translatePath`）：只认 M/L/C/Z（不分大小写），数一律 `toFixed(2)`。
/// 照 TS 的读法：命令字母后读不出数就整段作罢，命令外的字符（含空格）跳过。
pub fn translate_path(d: &str, dx: f64, dy: f64) -> String {
    let b = d.as_bytes();
    let mut i = 0usize;
    let mut out = String::new();
    // /-?\d*\.?\d+(?:e[-+]?\d+)?/y
    let num_at = |i: usize| -> Option<usize> {
        if i >= b.len() {
            return None;
        }
        let mut e = match_number(b, i)?;
        if e < b.len() && b[e] == b'e' {
            let mut k = e + 1;
            if k < b.len() && (b[k] == b'-' || b[k] == b'+') {
                k += 1;
            }
            let s = k;
            while k < b.len() && b[k].is_ascii_digit() {
                k += 1;
            }
            if k > s {
                e = k;
            }
        }
        Some(e)
    };
    while i < b.len() {
        let c = b[i];
        if matches!(c.to_ascii_uppercase(), b'M' | b'L' | b'C' | b'Z') {
            out.push(c as char);
            i += 1;
            let u = c.to_ascii_uppercase();
            if u == b'Z' {
                continue;
            }
            let n = if u == b'C' { 6 } else { 2 };
            let mut vals: Vec<f64> = vec![];
            for _ in 0..n {
                let Some(e) = num_at(i) else { break };
                vals.push(js::number(&d[i..e]));
                i = e;
                while i < b.len() && (b[i] == b' ' || b[i] == b',') {
                    i += 1;
                }
            }
            let parts: Vec<String> = vals.iter().enumerate().map(|(k, v)| js::to_fixed(if k % 2 == 0 { v + dx } else { v + dy }, 2)).collect();
            out.push_str(&parts.join(" "));
        } else {
            i += 1;
        }
    }
    out
}

/// 花边框：四条边各按自己的母题平铺、四角各摆一片，拼成一条 path（`ornamentFramePath`）。`edges` 缺省 `"TBLR"`。
pub fn ornament_frame_path(tiles: &[OrnamentTileSpec], bx: BoxRect, edges: &str) -> String {
    let at = |s: &str| tiles.iter().find(|t| t.slot == s);
    let mut parts: Vec<String> = vec![];
    let x1 = bx.x + bx.w;
    let y1 = bx.y + bx.h;
    let mut corner = |s: &str, cx: f64, cy: f64| -> Option<&OrnamentTileSpec> {
        let t = at(s)?;
        parts.push(translate_path(&t.path, cx + t.ox, cy + t.oy));
        Some(t)
    };
    let tl = corner("tl", bx.x, bx.y);
    let tr = corner("tr", x1 - at("tr").map_or(0.0, |t| t.w), bx.y);
    let bl = corner("bl", bx.x, y1 - at("bl").map_or(0.0, |t| t.h));
    let br = corner("br", x1 - at("br").map_or(0.0, |t| t.w), y1 - at("br").map_or(0.0, |t| t.h));

    // 一条边：在 [from, to] 之间铺 t，铺满且首末贴边；返回各片落点
    let run = |t: Option<&OrnamentTileSpec>, from: f64, to: f64| -> Vec<f64> {
        let Some(t) = t else { return vec![] };
        let size = if t.slot == "top" || t.slot == "bottom" { t.w } else { t.h };
        let span = to - from - size;
        if span <= 0.0 {
            return vec![from];
        }
        let pitch = if t.pitch > 0.01 { t.pitch } else { size };
        let n = js::max(1.0, js::round(span / pitch));
        let step = span / n;
        let mut out = vec![];
        let mut i = 0.0;
        while i <= n {
            out.push(from + i * step);
            i += 1.0;
        }
        out
    };

    let lx = bx.x + tl.or(bl).map_or(0.0, |t| t.w);
    let rx = x1 - tr.or(br).map_or(0.0, |t| t.w);
    let ty = bx.y + tl.or(tr).map_or(0.0, |t| t.h);
    let by = y1 - bl.or(br).map_or(0.0, |t| t.h);

    if edges.contains('T') {
        for p in run(at("top"), lx, rx) {
            parts.push(translate_path(&at("top").unwrap().path, p, bx.y));
        }
    }
    if edges.contains('B') {
        for p in run(at("bottom"), lx, rx) {
            let t = at("bottom").unwrap();
            parts.push(translate_path(&t.path, p, y1 - t.h));
        }
    }
    if edges.contains('L') {
        for p in run(at("left"), ty, by) {
            parts.push(translate_path(&at("left").unwrap().path, bx.x, p));
        }
    }
    if edges.contains('R') {
        for p in run(at("right"), ty, by) {
            let t = at("right").unwrap();
            parts.push(translate_path(&t.path, x1 - t.w, p));
        }
    }
    parts.concat()
}

// ─────────────────────────────── 折行

/// 行首禁则：收尾标点（`common/cjkpunct.ts::NO_LINE_START`）
fn no_line_start(c: char) -> bool {
    "，。、；：！？」』）〉》…·%,.;:!?)]}".contains(c)
}

/// 中日文折行：按字宽贪心，行首不许出现收尾标点（`wrapText`）。宽度含标点挤压（由 `measure` 量）。
pub fn wrap_text(text: &str, role: &str, size: f64, width: f64, measure: &dyn BookMeasure) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut line = String::new();
    let mut w = 0.0;
    // text.replace(/\s+/g, " ")
    let mut flat = String::with_capacity(text.len());
    let mut in_sp = false;
    for c in text.chars() {
        if js::is_space(c) {
            if !in_sp {
                flat.push(' ');
            }
            in_sp = true;
        } else {
            flat.push(c);
            in_sp = false;
        }
    }
    let mut buf = [0u8; 4];
    for ch in flat.chars() {
        let s: &str = ch.encode_utf8(&mut buf);
        let cw = measure.advance(role, s, size);
        if w + cw > width && !line.is_empty() {
            if no_line_start(ch) {
                line.push(ch);
                out.push(std::mem::take(&mut line));
                w = 0.0;
                continue;
            }
            out.push(std::mem::take(&mut line));
            w = 0.0;
        }
        line.push(ch);
        w += cw;
    }
    if !line.is_empty() {
        out.push(line);
    }
    out
}

// ─────────────────────────────── 注解块

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AnnotationBlock {
    pub items: Vec<DrawItem>,
    /// 整块占的高度（含花边框的上下边）
    pub height: f64,
}

/// `AnnotationOptions`（`measure` 另传）
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationOptions {
    pub text: String,
    pub framed: bool,
    /// `tile` / `line` / `none`
    #[serde(default)]
    pub frame: Option<String>,
    #[serde(default)]
    pub frame_outer: Option<f64>,
    #[serde(default)]
    pub frame_inner: Option<f64>,
    #[serde(default)]
    pub frame_gap: Option<f64>,
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub line_gap: f64,
    pub tiles: Vec<OrnamentTileSpec>,
    #[serde(default)]
    pub frame_edges: Option<String>,
    #[serde(default)]
    pub size: Option<f64>,
}

/// 路径坐标保留两位
fn r2(v: f64) -> String {
    js::to_fixed(v, 2)
}

/// 抹平软换行（`/(.)\r?\n(.)/gs` 两侧都是西文字母 / 数字就补空格），再去掉剩下的换行。
/// 照 JS 全局替换：一处匹配吃掉两侧各一个字，下一处从其后接着找。
fn flatten_soft_breaks(text: &str) -> String {
    let cs: Vec<char> = text.chars().collect();
    let alnum = |c: char| c.is_ascii_alphanumeric();
    let mut s = String::with_capacity(text.len());
    let mut p = 0usize;
    while p < cs.len() {
        // (.) 在 p，接 \r?\n，再接 (.)
        let a = cs[p];
        let mut q = p + 1;
        if q < cs.len() && cs[q] == '\r' && q + 1 < cs.len() && cs[q + 1] == '\n' {
            q += 1;
        }
        if q < cs.len() && cs[q] == '\n' && q + 1 < cs.len() {
            let b = cs[q + 1];
            s.push(a);
            if alnum(a) && alnum(b) {
                s.push(' ');
            }
            s.push(b);
            p = q + 2;
        } else {
            s.push(a);
            p += 1;
        }
    }
    // .replace(/\r?\n/g, "")
    let cs: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < cs.len() {
        if cs[i] == '\r' && i + 1 < cs.len() && cs[i + 1] == '\n' {
            i += 2;
        } else if cs[i] == '\n' {
            i += 1;
        } else {
            out.push(cs[i]);
            i += 1;
        }
    }
    out
}

/// 注解块（`annotationBlock`）：重新折行，花边框 / 双细线框 / 无框三种。
pub fn annotation_block(style: &Value, o: &AnnotationOptions, measure: &dyn BookMeasure) -> AnnotationBlock {
    let size = o.size.unwrap_or_else(|| role_size(style, "story"));
    let dim = |s: &str, h: bool| o.tiles.iter().find(|t| t.slot == s).map_or(0.0, |t| if h { t.h } else { t.w });
    let thick = |a: &str, b: &str, h: bool| js::max(dim(a, h), dim(b, h));
    let tile_y = thick("top", "bottom", true);
    let tile_x = thick("left", "right", false);
    let is_line = o.frame.as_deref() == Some("line");
    let line_edge = if is_line { o.frame_outer.unwrap_or(1.5) + o.frame_gap.unwrap_or(1.7) + o.frame_inner.unwrap_or(0.4) } else { 0.0 };
    let pad_x = if is_line {
        line_edge + size * 0.6
    } else if o.framed {
        tile_x + size * 0.6
    } else {
        0.0
    };
    let pad_y = if is_line {
        line_edge + size * 0.5
    } else if o.framed {
        tile_y + size * 0.5
    } else {
        0.0
    };
    let inner_w = o.right - o.left - pad_x * 2.0;
    let flat = flatten_soft_breaks(&o.text);
    let lines: Vec<String> = wrap_text(&flat, "story", size, inner_w, measure).into_iter().filter(|l| !js::trim(l).is_empty()).collect();
    let mut items: Vec<DrawItem> = vec![];
    let text_top = o.top + pad_y;
    for (i, l) in lines.iter().enumerate() {
        items.push(DrawItem::Text(text_item(l.as_str(), "story", size, o.left + pad_x, text_top + size + i as f64 * o.line_gap, "left")));
    }
    let n = lines.len() as f64;
    let height = pad_y * 2.0 + size + js::max(0.0, n - 1.0) * o.line_gap + if pad_y > 0.0 { 0.0 } else { size * 0.25 };
    if o.framed && !o.tiles.is_empty() {
        let bx = BoxRect { x: o.left, y: o.top, w: o.right - o.left, h: height };
        let d = ornament_frame_path(&o.tiles, bx, o.frame_edges.as_deref().unwrap_or("TBLR"));
        if !d.is_empty() {
            items.insert(0, DrawItem::Path(DrawPath { d, fill: Some(0), stroke: None, sw: None, dash: None, cls: None }));
        }
    } else if is_line {
        let ow = o.frame_outer.unwrap_or(1.5);
        let iw = o.frame_inner.unwrap_or(0.4);
        let gap = o.frame_gap.unwrap_or(1.7);
        let rect = |x: f64, y: f64, w: f64, h: f64, lw: f64| {
            format!(
                "M{} {}h{}v{}h{}ZM{} {}v{}h{}v{}Z",
                r2(x),
                r2(y),
                r2(w),
                r2(h),
                r2(-w),
                r2(x + lw),
                r2(y + lw),
                r2(h - lw * 2.0),
                r2(w - lw * 2.0),
                r2(-(h - lw * 2.0))
            )
        };
        let w = o.right - o.left;
        let outer = rect(o.left, o.top, w, height, ow);
        let inset = ow + gap;
        let inner = rect(o.left + inset, o.top + inset, w - inset * 2.0, height - inset * 2.0, iw);
        items.insert(0, DrawItem::Path(DrawPath { d: format!("{outer} {inner}"), fill: Some(0), stroke: None, sw: None, dash: None, cls: None }));
    }
    AnnotationBlock { items, height }
}

// ─────────────────────────────── 目录

/// 目录的一项（`TocItem`）：条目或分类标题
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TocItem {
    #[serde(rename_all = "camelCase")]
    Entry { song_no: String, title: String, page: f64 },
    Category { text: String },
    Subcategory { text: String },
}

/// `PageFrameOptions`（`measure` 另传）
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageFrameOptions {
    /// 第一页的物理页号（决定对开镜像的左右）
    pub start_page_no: i64,
    /// 页题（只印在第一页）
    #[serde(default)]
    pub title: Option<String>,
    /// 各角色的字号覆盖；没给的取 `roles[*].size`
    #[serde(default)]
    pub sizes: IndexMap<String, f64>,
}

impl PageFrameOptions {
    fn size_of(&self, style: &Value, role: &str) -> f64 {
        self.sizes.get(role).copied().unwrap_or_else(|| role_size(style, role))
    }
}

fn page_of(style: &Value, page_no: i64, kind: &str, items: Vec<DrawItem>) -> DrawPage {
    let mut p = DrawPage::new(page_no, sn(style, &["page", "w"]), sn(style, &["page", "h"]), PageMeta { kind: kind.into(), songs: vec![], page_label: None });
    p.items = items;
    p
}

/// `${Number(no.replace(/^0+/, "")) || no}`
fn strip_song_no(no: &str) -> String {
    let n = js::number(no.trim_start_matches('0'));
    if n != 0.0 && !n.is_nan() {
        js::num_to_string(n)
    } else {
        no.to_string()
    }
}

/// 版心下界：页脚基线上方 1.1 个页脚字号
fn bottom_limit(style: &Value) -> f64 {
    sn(style, &["titleBlock", "footerBaseline"]) - role_size(style, "footer") * 1.1
}

/// 目录页（`tocPages`）：「曲号．曲名 …… 页码」，引导点按量出来的空档填。
pub fn toc_pages(style: &Value, items: &[TocItem], o: &PageFrameOptions, measure: &dyn BookMeasure) -> Vec<DrawPage> {
    let t = |k: &str| sn(style, &["toc", k]);
    let size = o.size_of(style, "toc");
    let (left, right, line_gap) = (t("left"), t("right"), t("lineGap"));
    let leader = get_path(style, &["toc", "leader"]).and_then(Value::as_str).unwrap_or("").to_string();
    let mut pages: Vec<DrawPage> = vec![];
    let mut cur: Option<Vec<DrawItem>> = None;
    let mut y = 0.0;
    let mut page_no = o.start_page_no;
    let bottom = bottom_limit(style);
    let start = |cur: &mut Option<Vec<DrawItem>>, y: &mut f64, with_title: bool| {
        let mut v = vec![];
        *y = t("firstBaseline");
        if let Some(title) = o.title.as_deref().filter(|s| with_title && !s.is_empty()) {
            v.push(DrawItem::Text(text_item(title, "frontTitle", role_size(style, "frontTitle"), (left + right) / 2.0, t("titleBaseline"), "center")));
        }
        *cur = Some(v);
    };
    let flush = |cur: &mut Option<Vec<DrawItem>>, pages: &mut Vec<DrawPage>, page_no: &mut i64| {
        match cur {
            Some(v) if !v.is_empty() => {}
            _ => return,
        }
        pages.push(page_of(style, *page_no, "toc", cur.take().unwrap()));
        *page_no += 1;
    };
    let room = |y: f64, need: f64| y + need <= bottom;
    start(&mut cur, &mut y, true);
    for it in items {
        let (role, text) = match it {
            TocItem::Category { text } => ("tocHeading", text),
            TocItem::Subcategory { text } => ("tocSub", text),
            TocItem::Entry { song_no, title, page } => {
                if !room(y, line_gap) {
                    flush(&mut cur, &mut pages, &mut page_no);
                    start(&mut cur, &mut y, false);
                }
                let no = format!("{}.", strip_song_no(song_no));
                let page = format!("({})", js::num_to_string(*page));
                let head_text = format!("{no}{title}");
                let head_w = measure.advance("toc", &head_text, size);
                let page_w = measure.advance("toc", &page, size);
                let c = cur.as_mut().unwrap();
                c.push(DrawItem::Text(text_item(head_text, "toc", size, left, y, "left")));
                c.push(DrawItem::Text(text_item(page, "toc", size, right, y, "right")));
                let gap = right - page_w - (left + head_w) - size;
                let dw = measure.advance("toc", &leader, size);
                let dot_w = if dw != 0.0 && !dw.is_nan() { dw } else { size };
                let n = (gap / dot_w).floor();
                if n > 0.0 {
                    c.push(DrawItem::Text(text_item(leader.repeat(js::repeat_count(n)), "toc", size, left + head_w + size * 0.5, y, "left")));
                }
                y += line_gap;
                continue;
            }
        };
        let hs = o.size_of(style, role);
        let (ga, gb) = (t("headingGapAbove"), t("headingGapBelow"));
        let above = if ga != 0.0 && ga > 0.0 { ga } else { line_gap * 0.6 + hs };
        let below = if gb != 0.0 && gb > 0.0 { gb } else { hs + line_gap * 0.5 };
        if !room(y, above + below) {
            flush(&mut cur, &mut pages, &mut page_no);
            start(&mut cur, &mut y, false);
        } else {
            y += above - line_gap - hs;
        }
        cur.as_mut().unwrap().push(DrawItem::Text(text_item(text.as_str(), role, hs, (left + right) / 2.0, y + hs, "center")));
        y += hs + below;
    }
    flush(&mut cur, &mut pages, &mut page_no);
    pages
}

// ─────────────────────────────── 索引（两栏）

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexItem {
    /// `heading` / `entry`
    pub kind: String,
    pub text: String,
    pub song_no: Option<String>,
}

/// 索引页（`indexPages`）：两栏，条目是「首句 / 诗题 + 曲号」，曲号贴栏右缘。
/// 截断照 TS 按字退（TS 是按 UTF-16 码元 `slice(0, -1)`，扩展区字会被切半——见报告）。
pub fn index_pages(style: &Value, items: &[IndexItem], o: &PageFrameOptions, measure: &dyn BookMeasure) -> Vec<DrawPage> {
    let t = |k: &str| sn(style, &["toc", k]);
    let size = o.size_of(style, "toc");
    let (left, right) = (t("left"), t("right"));
    let cols = js::max(1.0, t("indexColumns"));
    let col_w = (right - left) / cols;
    let bottom = bottom_limit(style);
    let (first, gap) = (t("indexFirstBaseline"), t("indexLineGap"));
    let rows_per_col = js::max(1.0, ((bottom - first) / gap).floor() + 1.0);
    let per_page = (rows_per_col * cols) as usize;
    let mut pages = vec![];
    let mut page_no = o.start_page_no;
    let mut i = 0usize;
    while i < items.len() {
        let chunk = &items[i..(i + per_page).min(items.len())];
        let mut draw: Vec<DrawItem> = vec![];
        if let Some(title) = o.title.as_deref().filter(|s| i == 0 && !s.is_empty()) {
            draw.push(DrawItem::Text(text_item(title, "frontTitle", o.size_of(style, "frontTitle"), (left + right) / 2.0, t("titleBaseline"), "center")));
        }
        for (k, it) in chunk.iter().enumerate() {
            let k = k as f64;
            let col = (k / rows_per_col).floor();
            let row = k % rows_per_col;
            let x = left + col * col_w;
            let y = first + row * gap;
            if it.kind == "heading" {
                draw.push(DrawItem::Text(text_item(it.text.as_str(), "tocSub", size * 1.15, x + col_w / 2.0, y, "center")));
                continue;
            }
            let no = match it.song_no.as_deref() {
                Some(s) if !s.is_empty() => strip_song_no(s),
                _ => String::new(),
            };
            let no_w = measure.advance("toc", &no, size);
            let mut text: Vec<char> = it.text.chars().collect();
            loop {
                let s: String = text.iter().collect();
                if !(text.len() > 1 && measure.advance("toc", &s, size) > col_w - no_w - size * 0.8) {
                    break;
                }
                text.pop();
            }
            draw.push(DrawItem::Text(text_item(text.iter().collect::<String>(), "toc", size, x, y, "left")));
            if !no.is_empty() {
                draw.push(DrawItem::Text(text_item(no, "toc", size, x + col_w - size * 0.3, y, "right")));
            }
        }
        pages.push(page_of(style, page_no, "index", draw));
        page_no += 1;
        i += per_page.max(1);
    }
    pages
}

// ─────────────────────────────── 扉页 / 前言

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FrontPageSpec {
    /// `divider` / `prose`
    pub kind: String,
    pub title: String,
    pub body: String,
}

/// 扉页（几个大字居中）与前言（页题 + 正文）（`frontPages`）
pub fn front_pages(style: &Value, specs: &[FrontPageSpec], o: &PageFrameOptions, measure: &dyn BookMeasure) -> Vec<DrawPage> {
    let t = |k: &str| sn(style, &["toc", k]);
    let (pw, ph) = (sn(style, &["page", "w"]), sn(style, &["page", "h"]));
    let mut pages = vec![];
    for (page_no, f) in (o.start_page_no..).zip(specs) {
        let mut items: Vec<DrawItem> = vec![];
        let (ml, mr, _, _) = page_margins(style, page_no);
        let left = ml;
        let right = pw - mr;
        if f.kind == "divider" {
            let size = role_size(style, "frontTitle") * 2.4;
            items.push(DrawItem::Text(text_item(f.title.as_str(), "frontTitle", size, (left + right) / 2.0, ph * 0.42, "center")));
        } else {
            items.push(DrawItem::Text(text_item(f.title.as_str(), "frontTitle", role_size(style, "frontTitle"), (left + right) / 2.0, t("titleBaseline"), "center")));
            let size = role_size(style, "story") * 1.2;
            let gap = size * 1.6;
            let mut y = t("firstBaseline") + gap;
            for para in f.body.split('\n') {
                for line in wrap_text(para, "story", size, right - left, measure) {
                    items.push(DrawItem::Text(text_item(line, "story", size, left, y, "left")));
                    y += gap;
                }
            }
        }
        pages.push(page_of(style, page_no, "front-matter", items));
    }
    pages
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translate_like_ts() {
        assert_eq!(translate_path("M1 2L3,4C1 2 3 4 5 6Z", 1.0, 10.0), "M2.00 12.00L4.00 14.00C2.00 12.00 4.00 14.00 6.00 16.00Z");
        // 命令字母后有空格：TS 读不出数就作罢，空格与数一并跳过
        assert_eq!(translate_path("M 1 2", 0.0, 0.0), "M");
        assert_eq!(translate_path("m1e2 -.5", 0.0, 0.0), "m100.00 -0.50");
    }

    #[test]
    fn soft_breaks() {
        assert_eq!(flatten_soft_breaks("Horatius\nBonar"), "Horatius Bonar");
        assert_eq!(flatten_soft_breaks("甲\n乙"), "甲乙");
        // 一处匹配吃掉两侧的字：隔行的那一处补不上空格（TS 原样）
        assert_eq!(flatten_soft_breaks("a\nb\nc"), "a bc");
        assert_eq!(flatten_soft_breaks("a\r\nb\n"), "a b");
    }
}
