//! 谱里自带的纸：MusicXML 的 `<page-layout>`（tenths）与 123/ABC 的 `I:meta page …`（pt）互转（`src/model/pagemeta.ts` 是门面，纸张表 `STANDARD_PAPERS` 两边各一份）。
//!
//! meta 键：`page`、`page-orientation`、`page-margin`、`staff-size`、`lyric-size`、`font-title` / `font-subtitle` / `font-scripture` / `font-credit`。

use crate::doc::*;
use crate::metakeys::get_meta;
use crate::xmlsurface::Surface;
use dolce_base::js;
use indexmap::IndexMap;

/// 标准纸（pt，竖放），次序同 TS（`Object.entries`）
pub const STANDARD_PAPERS: &[(&str, (f64, f64))] = &[
    ("A4", (595.0, 842.0)),
    ("A5", (420.0, 595.0)),
    ("B5", (499.0, 709.0)),
    ("Letter", (612.0, 792.0)),
    ("150×216mm", (425.197, 612.283)),
    ("155×240mm", (439.37, 680.315)),
];

/// 实际的纸（pt，已按方向转好）与边距 `[上, 右, 下, 左]`。
#[derive(Clone, Debug, PartialEq)]
pub struct PagePt {
    pub w: f64,
    pub h: f64,
    pub margins: Option<[f64; 4]>,
}

const DEFAULT_SCALING: Scaling = Scaling { millimeters: 7.0, tenths: 40.0 };

fn pt_per_tenth(sc: Option<&Scaling>) -> f64 {
    let s = match sc {
        Some(s) if s.millimeters > 0.0 && s.tenths > 0.0 => s,
        _ => &DEFAULT_SCALING,
    };
    (s.millimeters * 72.0) / 25.4 / s.tenths
}

fn round1(v: f64) -> f64 {
    js::round(v * 10.0) / 10.0
}

fn round2(v: f64) -> f64 {
    js::round(v * 100.0) / 100.0
}

fn truthy(v: Option<f64>) -> Option<f64> {
    v.filter(|&x| x != 0.0 && !x.is_nan())
}

/// `<page-layout>` → pt。边距取非偶数页那组。
pub fn page_of_defaults(song: &Song) -> Option<PagePt> {
    let def = song.defaults.as_ref()?;
    let pl = def.page_layout.as_ref()?;
    let (pw, ph) = (truthy(pl.page_width)?, truthy(pl.page_height)?);
    let k = pt_per_tenth(def.scaling.as_ref());
    let mut out = PagePt { w: round1(pw * k), h: round1(ph * k), margins: None };
    if let Some(mg) = pl.margins.iter().flatten().find(|m| m.odd_even != Some(OddEven::Even)) {
        out.margins = Some([round1(mg.top * k), round1(mg.right * k), round1(mg.bottom * k), round1(mg.left * k)]);
    }
    Some(out)
}

fn split_ws(v: &str) -> Vec<&str> {
    // `v.split(/\s+/)`（v 已 trim）
    v.split(js::is_space).filter(|s| !s.is_empty()).collect()
}

/// `I:meta page …` → pt。认不出的写法返回 None。
pub fn page_of_meta(song: &Song) -> Option<PagePt> {
    let v = js::trim(get_meta(song, "page").first()?);
    if v.is_empty() {
        return None;
    }
    let nums: Vec<f64> = split_ws(v).into_iter().map(js::number).collect();
    let std = STANDARD_PAPERS.iter().find(|(k, _)| k.to_lowercase() == v.to_lowercase()).map(|(_, wh)| *wh);
    let (w, h) = if let Some((w, h)) = std {
        if get_meta(song, "page-orientation").first().map(|s| js::trim(s)) == Some("landscape") {
            (h, w)
        } else {
            (w, h)
        }
    } else if nums.len() == 2 && nums.iter().all(|n| n.is_finite() && *n > 0.0) {
        (nums[0], nums[1])
    } else {
        return None;
    };
    let mut out = PagePt { w, h, margins: None };
    if let Some(mv) = get_meta(song, "page-margin").first() {
        let mg: Vec<f64> = js::trim(mv).split(js::is_space).filter(|s| !s.is_empty()).map(js::number).collect();
        // `"".split(/\s+/)` 得 [""] → [0]；长度不为 4 的都不算
        if mg.len() == 4 && mg.iter().all(|n| n.is_finite() && *n >= 0.0) {
            out.margins = Some([mg[0], mg[1], mg[2], mg[3]]);
        }
    }
    Some(out)
}

/// 谱里自带的纸：MusicXML 的优先，其次 meta。
pub fn song_page(song: &Song) -> Option<PagePt> {
    page_of_defaults(song).or_else(|| page_of_meta(song))
}

/// 标准纸名（±2pt，横竖都认）。
pub fn standard_paper_of(w: f64, h: f64) -> Option<(&'static str, bool)> {
    let (a, b) = if w > h { (h, w) } else { (w, h) };
    STANDARD_PAPERS.iter().find(|(_, (pw, ph))| (pw - a).abs() <= 2.0 && (ph - b).abs() <= 2.0).map(|(name, _)| (*name, w > h))
}

/// 纸 → meta 键值。
pub fn page_meta(page: &PagePt) -> IndexMap<String, Vec<String>> {
    let std = standard_paper_of(page.w, page.h);
    let mut out = IndexMap::new();
    out.insert(
        "page".into(),
        vec![match std {
            Some((name, _)) => name.to_owned(),
            None => format!("{} {}", js::num_to_string(page.w), js::num_to_string(page.h)),
        }],
    );
    if std.is_some_and(|(_, l)| l) {
        out.insert("page-orientation".into(), vec!["landscape".into()]);
    }
    if let Some(m) = &page.margins {
        out.insert("page-margin".into(), vec![m.iter().map(|x| js::num_to_string(*x)).collect::<Vec<_>>().join(" ")]);
    }
    out
}

fn positive_meta(song: &Song, key: &str) -> Option<f64> {
    // `Number(getMeta(...)[0])`：没有值是 Number(undefined) = NaN
    let v = get_meta(song, key).first().map_or(f64::NAN, |s| js::number(s));
    (v.is_finite() && v > 0.0).then_some(v)
}

/// 谱表高（mm）：MusicXML `<scaling>` 优先，其次 `I:meta staff-size`。
pub fn song_staff_size(song: &Song) -> Option<f64> {
    if let Some(sc) = song.defaults.as_ref().and_then(|d| d.scaling.as_ref()) {
        if sc.millimeters > 0.0 && sc.tenths > 0.0 {
            return Some(round2((sc.millimeters * 40.0) / sc.tenths));
        }
    }
    positive_meta(song, "staff-size")
}

/// 歌词字号（pt）：MusicXML `<lyric-font font-size>` 优先，其次 `I:meta lyric-size`。
pub fn song_lyric_size(song: &Song) -> Option<f64> {
    if let Some(fs) = song.defaults.as_ref().and_then(|d| d.lyric_font.as_ref()).and_then(|f| f.size) {
        if fs > 0.0 {
            return Some(fs);
        }
    }
    positive_meta(song, "lyric-size")
}

/// 转成 123/ABC 之前：MusicXML 的纸、谱表大小、歌词字号、页眉字体写进 meta（meta 里已有的不动）。
pub fn with_page_meta<'a>(doc: &'a ScoreDoc, surface: Option<&Surface>) -> std::borrow::Cow<'a, ScoreDoc> {
    let extra = |s: &Song| -> IndexMap<String, Vec<String>> {
        let mut out = IndexMap::new();
        if let Some(page) = page_of_defaults(s) {
            if get_meta(s, "page").is_empty() {
                out.extend(page_meta(&page));
            }
        }
        if let Some(sc) = s.defaults.as_ref().and_then(|d| d.scaling.as_ref()) {
            if sc.millimeters > 0.0 && sc.tenths > 0.0 && get_meta(s, "staff-size").is_empty() {
                let v = song_staff_size(s).map_or("null".to_owned(), js::num_to_string);
                out.insert("staff-size".into(), vec![v]);
            }
        }
        if let Some(ly) = truthy(s.defaults.as_ref().and_then(|d| d.lyric_font.as_ref()).and_then(|f| f.size)) {
            if get_meta(s, "lyric-size").is_empty() {
                out.insert("lyric-size".into(), vec![js::num_to_string(ly)]);
            }
        }
        out.extend(header_font_meta(s, surface));
        out
    };
    if !doc.songs.iter().any(|s| !extra(s).is_empty()) {
        return std::borrow::Cow::Borrowed(doc);
    }
    let mut out = doc.clone();
    for s in &mut out.songs {
        let add = extra(s);
        if add.is_empty() {
            continue;
        }
        let mut meta = s.meta.clone().unwrap_or_default();
        for (k, v) in add {
            meta.insert(k, v);
        }
        s.meta = Some(meta);
    }
    std::borrow::Cow::Owned(out)
}

/// 写 MusicXML 之前：没有 `<page-layout>`、但 meta 里写了纸的，还原成 `<page-layout>`。就地改。
pub fn apply_page_meta_to_defaults(song: &mut Song) {
    // 谱表大小与歌词字号：`<scaling>` / `<lyric-font>` 没写才补
    let mm = get_meta(song, "staff-size").first().map_or(f64::NAN, |s| js::number(s));
    if song.defaults.as_ref().and_then(|d| d.scaling.as_ref()).is_none() && mm.is_finite() && mm > 0.0 {
        song.defaults.get_or_insert_with(Defaults::default).scaling = Some(Scaling { millimeters: mm, tenths: 40.0 });
    }
    let ly = get_meta(song, "lyric-size").first().map_or(f64::NAN, |s| js::number(s));
    if truthy(song.defaults.as_ref().and_then(|d| d.lyric_font.as_ref()).and_then(|f| f.size)).is_none() && ly.is_finite() && ly > 0.0 {
        song.defaults.get_or_insert_with(Defaults::default).lyric_font.get_or_insert_with(FontSpec::default).size = Some(ly);
    }
    if truthy(song.defaults.as_ref().and_then(|d| d.page_layout.as_ref()).and_then(|p| p.page_width)).is_some() {
        return;
    }
    let Some(page) = page_of_meta(song) else { return };
    let scaling = song.defaults.as_ref().and_then(|d| d.scaling.clone()).unwrap_or(DEFAULT_SCALING);
    let k = pt_per_tenth(Some(&scaling));
    let t = |pt: f64| round1(pt / k);
    let def = song.defaults.get_or_insert_with(Defaults::default);
    def.page_layout = Some(PageLayout {
        page_width: Some(t(page.w)),
        page_height: Some(t(page.h)),
        margins: page.margins.map(|m| {
            vec![PageMargins { top: t(m[0]), right: t(m[1]), bottom: t(m[2]), left: t(m[3]), odd_even: Some(OddEven::Both) }]
        }),
    });
    def.scaling = Some(scaling);
}

// ───────────────────────── 页眉字体 ─────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HeaderRole {
    Title,
    Subtitle,
    Scripture,
    Credit,
}

impl HeaderRole {
    pub fn as_str(self) -> &'static str {
        match self {
            HeaderRole::Title => "title",
            HeaderRole::Subtitle => "subtitle",
            HeaderRole::Scripture => "scripture",
            HeaderRole::Credit => "credit",
        }
    }
}

pub const HEADER_ROLES: [HeaderRole; 4] = [HeaderRole::Title, HeaderRole::Subtitle, HeaderRole::Scripture, HeaderRole::Credit];

/// 页眉一项的字体：族、字号（pt）、粗体。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HeaderFontSpec {
    pub family: Option<String>,
    pub size: Option<f64>,
    pub bold: bool,
}

impl HeaderFontSpec {
    fn is_empty(&self) -> bool {
        self.family.is_none() && self.size.is_none() && !self.bold
    }
}

/// MusicXML 的 `<credit>` 按类型归到页眉角色（没写类型的按版面：页首最大号且不靠右的是标题，靠右的是词曲）。
pub fn header_role_of_credit(kind: Option<&str>, justify: Option<&str>, biggest: bool) -> Option<HeaderRole> {
    match kind.map(js::trim) {
        Some("title") => return Some(HeaderRole::Title),
        Some("subtitle") => return Some(HeaderRole::Subtitle),
        Some("scripture") => return Some(HeaderRole::Scripture),
        Some("composer" | "lyricist" | "arranger" | "poet" | "words" | "translator") => return Some(HeaderRole::Credit),
        None | Some("") => {}
        Some(_) => return None,
    }
    if biggest && justify != Some("right") {
        return Some(HeaderRole::Title);
    }
    if justify == Some("right") {
        return Some(HeaderRole::Credit);
    }
    None
}

/// `<credit-words>` 的字体（同一角色取第一条；没写族退到 `<defaults><word-font>`）。
pub fn header_fonts_of_credits(song: &Song, surface: Option<&Surface>) -> IndexMap<HeaderRole, HeaderFontSpec> {
    let credits: &[Credit] = song.credits.as_deref().unwrap_or(&[]);
    let max_size = credits.iter().fold(0.0, |a, c| js::max(a, c.font_size.unwrap_or(0.0)));
    let mut out = IndexMap::new();
    for c in credits {
        let role = header_role_of_credit(
            c.kind.as_deref(),
            c.justify.as_ref().map(|j| j.as_str()),
            max_size > 0.0 && c.font_size == Some(max_size),
        );
        let Some(role) = role else { continue };
        if out.contains_key(&role) {
            continue;
        }
        let mut f = HeaderFontSpec::default();
        let family = c
            .font_family
            .clone()
            .or_else(|| surface.and_then(|s| s.defaults_fonts(song.oid).1).and_then(|w| w.family));
        if let Some(fam) = family.filter(|x| !x.is_empty()) {
            f.family = Some(fam);
        }
        if let Some(sz) = truthy(c.font_size) {
            f.size = Some(sz);
        }
        if c.font_weight.as_deref() == Some("bold") {
            f.bold = true;
        }
        if !f.is_empty() {
            out.insert(role, f);
        }
    }
    out
}

/// `^(\S+)\s*(bold\s+)?(.*)$`（i）
fn parse_font_meta(v: &str) -> Option<(&str, bool, &str)> {
    let size_end = v.find(js::is_space).unwrap_or(v.len());
    if size_end == 0 {
        return None;
    }
    let size = &v[..size_end];
    let rest = v[size_end..].trim_start_matches(js::is_space);
    let mut bold = false;
    let mut tail = rest;
    if rest.len() >= 4 && rest.is_char_boundary(4) && rest[..4].eq_ignore_ascii_case("bold") {
        let after = &rest[4..];
        let trimmed = after.trim_start_matches(js::is_space);
        if trimmed.len() < after.len() {
            bold = true;
            tail = trimmed;
        }
    }
    // `.` 不配行终止符
    if tail.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    Some((size, bold, tail))
}

/// `I:meta font-<角色> 字号 [bold] 字体族`。
pub fn header_fonts_of_meta(song: &Song) -> IndexMap<HeaderRole, HeaderFontSpec> {
    let mut out = IndexMap::new();
    for role in HEADER_ROLES {
        let Some(v) = get_meta(song, &format!("font-{}", role.as_str())).first().map(|s| js::trim(s)) else { continue };
        if v.is_empty() {
            continue;
        }
        let Some((size, bold, family)) = parse_font_meta(v) else { continue };
        let mut f = HeaderFontSpec::default();
        let n = js::number(size);
        if n.is_finite() && n > 0.0 {
            f.size = Some(n);
        }
        if bold {
            f.bold = true;
        }
        let fam = js::trim(family);
        if !fam.is_empty() {
            f.family = Some(fam.to_owned());
        }
        if !f.is_empty() {
            out.insert(role, f);
        }
    }
    out
}

/// 谱里写的页眉字体：MusicXML 的 credit 优先，其次 meta。
pub fn song_header_fonts(song: &Song, surface: Option<&Surface>) -> IndexMap<HeaderRole, HeaderFontSpec> {
    if song.credits.as_ref().is_some_and(|c| !c.is_empty()) {
        header_fonts_of_credits(song, surface)
    } else {
        header_fonts_of_meta(song)
    }
}

fn header_font_meta(song: &Song, surface: Option<&Surface>) -> IndexMap<String, Vec<String>> {
    let mut out = IndexMap::new();
    if !song.credits.as_ref().is_some_and(|c| !c.is_empty()) {
        return out;
    }
    for (role, f) in header_fonts_of_credits(song, surface) {
        let key = format!("font-{}", role.as_str());
        if !get_meta(song, &key).is_empty() {
            continue;
        }
        let parts = [
            f.size.map_or("-".to_owned(), js::num_to_string),
            if f.bold { "bold".to_owned() } else { String::new() },
            f.family.clone().unwrap_or_default(),
        ];
        out.insert(key, vec![parts.into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" ")]);
    }
    out
}
