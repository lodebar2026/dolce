//! 页眉定位（照 `place/header.ts`）：标题、副标题、经文、词曲、TL/TR、XL/XR、调号拍号行、`J:` 速度文字；
//! 投影档的标题页与页脚。`compose/header.rs` 只照它画。

use dolce_model::base::js::trim;
use dolce_model::base::geom::Rect;
use dolce_model::Tempo;
use dolce_model::view::ast::{Metadata, Meter};

use crate::grid::JianpuGrid;
use crate::util::max;

/// 页眉各行的角色（字体与字号由绘制端定，`compose/header.rs::header_role_font`）
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HeaderTextRole {
    Title,
    Subtitle,
    Scripture,
    Credit,
    Top,
    Index,
    Tempo,
    SlideTitle,
    SlideSubtitle,
    SlideScripture,
    SlideCredit,
    SlideFooter,
}

impl HeaderTextRole {
    pub fn as_str(self) -> &'static str {
        match self {
            HeaderTextRole::Title => "title",
            HeaderTextRole::Subtitle => "subtitle",
            HeaderTextRole::Scripture => "scripture",
            HeaderTextRole::Credit => "credit",
            HeaderTextRole::Top => "top",
            HeaderTextRole::Index => "index",
            HeaderTextRole::Tempo => "tempo",
            HeaderTextRole::SlideTitle => "slide-title",
            HeaderTextRole::SlideSubtitle => "slide-subtitle",
            HeaderTextRole::SlideScripture => "slide-scripture",
            HeaderTextRole::SlideCredit => "slide-credit",
            HeaderTextRole::SlideFooter => "slide-footer",
        }
    }
}

/// 调号拍号行相对其基线的墨迹上下缘；`eq_mid` 是「=」墨迹的竖直中心
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KeyLineInk {
    pub top: f64,
    pub bottom: f64,
    pub eq_mid: f64,
}

/// 页眉量具（`compose/header.rs` 实现）
pub trait HeaderMeasurer {
    /// 角色字的字面宽与墨迹盒（相对落笔原点、基线 y = 0）
    fn header_text(&self, s: &str, role: HeaderTextRole) -> (f64, Rect);
    fn key_line(&self, meter: Option<&Meter>) -> KeyLineInk;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Anchor {
    Left,
    Center,
    Right,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlacedHeaderLine {
    pub role: HeaderTextRole,
    pub text: String,
    /// `left` = system 左缘，`center` = 页面中线，`right` = 版心右缘
    pub anchor: Anchor,
    /// 相对锚点的落笔 x
    pub dx: f64,
    pub baseline: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlacedHeader {
    pub lines: Vec<PlacedHeaderLine>,
    /// 标题、副标题、经文、署名的字号倍率（窄纸缩排）
    pub scale: f64,
    pub key_baseline: f64,
    /// 拍号分数线相对 key_baseline 的偏移
    pub meter_dy: f64,
    /// 页首的墨迹底
    pub bottom: f64,
}

/// 拍号分数线粗细（`time-sig-rule`；0 = 与减时线同粗）
pub fn time_sig_rule(m: &JianpuGrid) -> f64 {
    let r = m.style.stroke.time_sig_rule;
    if r != 0.0 && !r.is_nan() {
        r
    } else {
        m.style.stroke.beam
    }
}

/// `TL:` / `TR:` 去掉开头的空行
fn top_lines(lines: &[String]) -> &[String] {
    let mut i = 0;
    while i < lines.len() && trim(&lines[i]).is_empty() {
        i += 1;
    }
    &lines[i..]
}

/// 词曲署名逐行（一条里换了行照原样分行）
fn author_lines(meta: &Metadata) -> Vec<String> {
    let mut out = vec![];
    for a in &meta.authors {
        for l in a.split('\n') {
            let l = l.strip_suffix('\r').unwrap_or(l);
            let t = trim(l);
            if !t.is_empty() {
                out.push(t.to_string());
            }
        }
    }
    out
}

pub fn place_header(meta: &Metadata, m: &JianpuGrid, ink: &dyn HeaderMeasurer) -> PlacedHeader {
    let hs = &m.style.header;
    let lh = m.head.credit_line_height;
    let mut lines: Vec<PlacedHeaderLine> = vec![];
    let authors = author_lines(meta);
    let empty: Vec<String> = vec![];
    let scripture = meta.scripture.as_ref().unwrap_or(&empty);

    let avail = max(1.0, m.page.width - m.page.margin.left - m.page.margin.right);
    let mut need: f64 = 0.0;
    for (i, t) in meta.titles.iter().enumerate() {
        need = max(need, ink.header_text(t, if i == 0 { HeaderTextRole::Title } else { HeaderTextRole::Subtitle }).0);
    }
    for t in scripture {
        need = max(need, ink.header_text(t, HeaderTextRole::Scripture).0);
    }
    for t in &authors {
        need = max(need, ink.header_text(t, HeaderTextRole::Credit).0);
    }
    let k = if need > avail { avail / need } else { 1.0 };
    let measure = |s: &str, role: HeaderTextRole| -> (f64, f64, f64) {
        let (adv, r) = ink.header_text(s, role);
        let sc = if matches!(role, HeaderTextRole::Title | HeaderTextRole::Subtitle | HeaderTextRole::Scripture | HeaderTextRole::Credit) { k } else { 1.0 };
        (adv * sc, r.top * sc, r.bottom * sc)
    };

    let title_size = hs.title.size * k;
    let sub_size = hs.subtitle.size * k;
    let mut title_ink_bottom: f64 = 0.0;
    let mut centred = |text: &str, role: HeaderTextRole, baseline: f64, lines: &mut Vec<PlacedHeaderLine>| {
        let (adv, _, bottom) = measure(text, role);
        lines.push(PlacedHeaderLine { role, text: text.to_string(), anchor: Anchor::Center, dx: -adv / 2.0, baseline });
        title_ink_bottom = max(title_ink_bottom, baseline + bottom);
    };
    let mut y = m.head.title_baseline;
    for (i, t) in meta.titles.iter().enumerate() {
        y = m.head.title_baseline + if i == 0 { 0.0 } else { title_size * 0.2 + i as f64 * (sub_size * 1.35) };
        centred(t, if i == 0 { HeaderTextRole::Title } else { HeaderTextRole::Subtitle }, y, &mut lines);
    }
    let scr_size = hs.scripture.size * k;
    if meta.titles.len() == 1 {
        y += title_size * 0.2;
    } else if meta.titles.is_empty() {
        y = m.head.title_baseline - scr_size * 1.35;
    }
    for t in scripture {
        y += scr_size * 1.35;
        centred(t, HeaderTextRole::Scripture, y, &mut lines);
    }
    let has_title_block = meta.titles.len() + scripture.len() > 0;

    let block_top = if has_title_block { y + lh } else { m.head.credit_baseline };
    let tl = top_lines(&meta.top_left);
    let tr = top_lines(&meta.top_right);
    let right: Vec<(&str, HeaderTextRole)> =
        tr.iter().map(|t| (t.as_str(), HeaderTextRole::Top)).chain(authors.iter().map(|t| (t.as_str(), HeaderTextRole::Credit))).collect();
    let mut block_bottom: f64 = 0.0;
    for (i, (t, role)) in right.iter().enumerate() {
        if t.is_empty() {
            continue;
        }
        let (adv, _, bottom) = measure(t, *role);
        let bl = block_top + i as f64 * lh;
        lines.push(PlacedHeaderLine { role: *role, text: t.to_string(), anchor: Anchor::Right, dx: -adv, baseline: bl });
        block_bottom = max(block_bottom, bl + bottom);
    }
    for (i, t) in tl.iter().enumerate() {
        if t.is_empty() {
            continue;
        }
        let bl = block_top + i as f64 * lh;
        lines.push(PlacedHeaderLine { role: HeaderTextRole::Top, text: t.clone(), anchor: Anchor::Left, dx: 0.0, baseline: bl });
        block_bottom = max(block_bottom, bl + measure(t, HeaderTextRole::Top).2);
    }

    let key = ink.key_line(meta.meters.first());
    let key_y = if !right.is_empty() || !tl.is_empty() {
        let mut ky = f64::NEG_INFINITY;
        if !right.is_empty() {
            ky = block_top + (right.len() - 1) as f64 * lh;
        }
        if !tl.is_empty() {
            ky = max(ky, block_top + tl.len() as f64 * lh + m.style.size.key_meter * 0.6);
        }
        if has_title_block {
            ky = max(ky, title_ink_bottom + m.style.size.lyric * 0.5 - key.top);
        }
        ky
    } else if has_title_block {
        title_ink_bottom + m.style.size.lyric - key.top
    } else {
        m.head.key_meter_baseline
    };
    let mut key_bottom = key_y + key.bottom;

    let mut tempo_words: Vec<&str> = vec![];
    if let Some(tm) = meta.tempo_mark.as_deref().filter(|s| !s.is_empty()) {
        tempo_words.push(tm);
    }
    for t in &meta.tempos {
        if let Tempo::Text(s) = t {
            if !s.is_empty() {
                tempo_words.push(s);
            }
        }
    }
    if !tempo_words.is_empty() {
        let text = tempo_words.join(" ");
        let baseline = key_y + m.style.size.key_meter * 1.55;
        lines.push(PlacedHeaderLine { role: HeaderTextRole::Tempo, text, anchor: Anchor::Left, dx: 0.0, baseline });
        key_bottom = baseline + m.style.size.key_meter * 0.85 * 0.15;
    }

    if let Some(s) = meta.index_left.as_deref().filter(|s| !s.is_empty()) {
        lines.push(PlacedHeaderLine { role: HeaderTextRole::Index, text: s.to_string(), anchor: Anchor::Left, dx: 0.0, baseline: m.head.title_baseline });
    }
    if let Some(s) = meta.index_right.as_deref().filter(|s| !s.is_empty()) {
        let (adv, _, _) = measure(s, HeaderTextRole::Index);
        lines.push(PlacedHeaderLine { role: HeaderTextRole::Index, text: s.to_string(), anchor: Anchor::Right, dx: -adv, baseline: m.head.title_baseline });
    }

    PlacedHeader {
        lines,
        scale: k,
        key_baseline: key_y,
        meter_dy: key.eq_mid + time_sig_rule(m) / 2.0,
        bottom: max(max(title_ink_bottom, block_bottom), key_bottom),
    }
}

/// 投影档的标题页：标题 → 副标题 → 经文 → 词曲逐行居中，首行基线在页高 0.3 处，往下每行下移本行的字号
pub fn place_title_page(meta: &Metadata, m: &JianpuGrid, ink: &dyn HeaderMeasurer) -> Vec<PlacedHeaderLine> {
    let hs = &m.style.header;
    let mut items: Vec<(String, HeaderTextRole, f64)> = vec![];
    for (i, t) in meta.titles.iter().enumerate() {
        items.push(if i == 0 { (t.clone(), HeaderTextRole::SlideTitle, hs.title.size) } else { (t.clone(), HeaderTextRole::SlideSubtitle, hs.subtitle.size) });
    }
    for t in meta.scripture.iter().flatten() {
        items.push((t.clone(), HeaderTextRole::SlideScripture, hs.scripture.size));
    }
    for t in author_lines(meta) {
        items.push((t, HeaderTextRole::SlideCredit, hs.credit.size));
    }
    let mut y = m.page.height * 0.3;
    items
        .into_iter()
        .map(|(text, role, size)| {
            let dx = -ink.header_text(&text, role).0 / 2.0;
            let line = PlacedHeaderLine { role, text, anchor: Anchor::Center, dx, baseline: y };
            y += size;
            line
        })
        .collect()
}

/// 投影档每个谱页的页脚：曲名居中、「i/n」页码；基线在下边距的一半处。`dx` 以页面左缘为原点
pub fn place_slide_footer(title: &str, page: i64, pages: i64, m: &JianpuGrid, ink: &dyn HeaderMeasurer) -> Vec<PlacedHeaderLine> {
    let (width, height, margin) = (m.page.width, m.page.height, &m.page.margin);
    let y = height - margin.bottom * 0.5;
    let mut out = vec![];
    if !title.is_empty() {
        let w = ink.header_text(title, HeaderTextRole::SlideFooter).0;
        out.push(PlacedHeaderLine {
            role: HeaderTextRole::SlideFooter,
            text: title.to_string(),
            anchor: Anchor::Left,
            dx: margin.left + (width - margin.left - margin.right - w) / 2.0,
            baseline: y,
        });
    }
    let no = format!("{page}/{pages}");
    let w = ink.header_text(&no, HeaderTextRole::SlideFooter).0;
    out.push(PlacedHeaderLine {
        role: HeaderTextRole::SlideFooter,
        text: no,
        anchor: Anchor::Left,
        dx: crate::util::min(margin.left + 0.8 * width, width - margin.right - w),
        baseline: y,
    });
    out
}
