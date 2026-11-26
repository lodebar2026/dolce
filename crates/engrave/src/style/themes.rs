//! 内置主题（照 `style/themes.ts`）：级联的最底层。**切主题 = 换一整层**。
//!
//! | 主题        | 谁在用                                  |
//! |-------------|-----------------------------------------|
//! | projection  | 编辑器「投影」档（两种格式）与导出 PPTX |
//! | print       | 编辑器「简谱」档（各格式）              |
//! | book        | 成书重排                                |
//! | staff       | 五线谱 / 混排                           |
//!
//! 数值一律写成它们原来的样子（裸数字 = pt）：改写成比例会有浮点尾差，破几何基线。

use crate::style::cascade::{compute_style, StyleContext, StyleLayer, StyleRule};
use crate::style::sheet::StyleSheet;
use dolce_model::base::js::num_to_string;
use dolce_model::pagemeta::STANDARD_PAPERS;
use serde_json::{json, Map, Value};
use std::sync::OnceLock;

/// 老版投影档的「出厂默认」（投影片 960×540，字号 28/48/36）。
pub struct PptxPage {
    pub w: f64,
    pub h: f64,
    pub font_size: f64,
    pub title_size: f64,
    pub credit_size: f64,
}
pub const PPTX_PAGE: PptxPage = PptxPage { w: 960.0, h: 540.0, font_size: 28.0, title_size: 48.0, credit_size: 36.0 };

/// 「投影」档只有这两种投影片比例。
pub const PAGE_RATIOS: [(&str, (f64, f64)); 2] = [("16:9", (960.0, 540.0)), ("4:3", (720.0, 540.0))];

pub const LONG_IMAGE: &str = "长图";

/// 纸张表（`PAPER_SIZES`）：实际纸张尺寸（pt），外加一档「长图」（`Some(None)`）；不在表里回 None。
pub fn paper_size(name: &str) -> Option<Option<(f64, f64)>> {
    if name == LONG_IMAGE {
        return Some(None);
    }
    STANDARD_PAPERS.iter().find(|(n, _)| *n == name).map(|(_, wh)| Some(*wh))
}

/// 纸张表的名字，顺序同 TS 的 `Object.keys(PAPER_SIZES)`。
pub fn paper_names() -> Vec<&'static str> {
    STANDARD_PAPERS.iter().map(|(n, _)| *n).chain([LONG_IMAGE]).collect()
}

/// 「简谱」档能选的纸（含长图）。
pub const ORIGINAL_PAPERS: [&str; 7] = ["A4", "A5", "B5", "Letter", "150×216mm", "155×240mm", "长图"];

fn std_paper(name: &str) -> (f64, f64) {
    STANDARD_PAPERS.iter().find(|(n, _)| *n == name).map(|(_, wh)| *wh).expect("标准纸")
}

/// 「长图」那一档的纸宽：与 500 首那张纸（`150×216mm`）同宽。
pub fn long_image_width() -> f64 {
    std_paper("150×216mm").0
}

/// 简谱档的出厂音符字号。
pub const ORIGINAL_NOTE_SIZE: f64 = 12.0;

/// 出厂纸。
pub const PAPER_DEFAULT: &str = "长图";

/// 五线谱/混排的出厂纸。
pub const STAFF_PAPER_DEFAULT: &str = "155×240mm";

/// 五线谱/混排选了「长图」时的纸宽。
pub fn staff_long_image_width() -> f64 {
    std_paper(STAFF_PAPER_DEFAULT).0
}

/// 这个纸张名在不在表里。
pub fn is_paper(k: &Value) -> bool {
    k.as_str().is_some_and(|s| paper_size(s).is_some())
}

pub const INK: f64 = 4278190080.0; // 0xff000000
pub const PAPER_WHITE: f64 = 4294967295.0; // 0xffffffff

fn print_roles() -> Value {
    json!({
        "lyric": { "size": "1em" },
        "verseNum": { "size": "1em" },
        "keyMeter": { "size": "1em" },
        "chord": { "size": "0.85em" },
        "title": { "size": "1.8em" },
        "credit": { "size": "0.9em" },
        "tuplet": { "size": "0.6em" },
        "sectionWord": { "size": "0.85em" },
    })
}

fn em(x: f64) -> Value {
    Value::String(format!("{}em", num_to_string(x)))
}

fn print_jianpu() -> Value {
    json!({
        "barline": em(1.0 / 14.0),
        "final-barline": em(1.0 / 8.0),
        "beam-width": "0.05em",
        "slur-thickness": "0.2em",
        "slur-outline": "0.025em",
        "slur-max-arc": "0.45em",
        "slur-min-arc": "0.28em",
        "hairpin-width": "0.05em",
        "repeat-dot-diameter": "0.16em",
        "time-sig-rule": em(1.0 / 14.0),
        "slur-gap": "0.15em",
        "lyric-stack": "1.25em",
        "chord-gap": "0.4em",
        "chord-plain": true,
        "system-gap": "1.6em",
        "voice-gap": "1.5em",
        "lrc-punct-compress": "halfwidth",
        "grace-scale": 0.6,
        "accidental-scale": 0.75,
    })
}

const PRINT_FOOT_SS: &str = r#"
@template song-foot {
  flow: block;
  align-x: content;
  line-height: 1.35em;
  row { left: "{pageText.bottomLeft | dash-empty | lines-trim}" as header; }
  row(gap-before: 4) { center: "{pageText.bottomCenter | dash-empty | lines-trim}" as header; }
  row(gap-before: 4) { right: "{pageText.bottomRight | dash-empty | lines-trim}" as header; }
}
"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThemeId {
    Projection,
    Print,
    Book,
    Staff,
}

impl ThemeId {
    pub fn parse(s: &str) -> Option<ThemeId> {
        Some(match s {
            "projection" => ThemeId::Projection,
            "print" => ThemeId::Print,
            "book" => ThemeId::Book,
            "staff" => ThemeId::Staff,
            _ => return None,
        })
    }
}

fn rule(set: Value) -> StyleRule {
    StyleRule { when: None, set }
}

fn build(id: ThemeId) -> StyleLayer {
    match id {
        ThemeId::Projection => vec![rule(json!({
            "roles": { "note": { "size": PPTX_PAGE.font_size }, "title": { "size": PPTX_PAGE.title_size }, "credit": { "size": PPTX_PAGE.credit_size } },
            "page": { "size": [PPTX_PAGE.w, PPTX_PAGE.h], "ink": INK, "background": PAPER_WHITE },
            "jianpu": { "preset": "pptx" },
        }))],
        ThemeId::Print => {
            let mut roles = Map::new();
            roles.insert("note".into(), json!({ "size": ORIGINAL_NOTE_SIZE }));
            if let Value::Object(r) = print_roles() {
                roles.extend(r);
            }
            let mut out = vec![rule(json!({
                "page": { "paper": PAPER_DEFAULT, "ink": INK, "background": PAPER_WHITE },
                "roles": Value::Object(roles),
                "jianpu": { "preset": "original", "overrides": print_jianpu() },
            }))];
            out.extend(crate::style::ss::parse_ss(PRINT_FOOT_SS).expect("内置页脚模板可解析"));
            out
        }
        ThemeId::Book => vec![rule(json!({ "jianpu": { "preset": "book" } }))],
        ThemeId::Staff => vec![rule(json!({ "page": { "paper": STAFF_PAPER_DEFAULT }, "staff": { "preset": "musicpp" } }))],
    }
}

/// 内置主题的一层（`THEMES[id]`）。
pub fn theme(id: ThemeId) -> &'static [StyleRule] {
    static CELLS: [OnceLock<StyleLayer>; 4] = [OnceLock::new(), OnceLock::new(), OnceLock::new(), OnceLock::new()];
    CELLS[id as usize].get_or_init(|| build(id))
}

/// 编辑器排版模式 → 主题。
pub fn theme_of_mode(mode: &str) -> ThemeId {
    if mode == "expanded" {
        ThemeId::Projection
    } else {
        ThemeId::Print
    }
}

/// 这份样式表算出来的是分页还是长图。长图 = 纸张表里值为 null 的那一档；没写纸一律算分页。
pub fn is_paged_sheet(sheet: &StyleSheet) -> bool {
    match sheet.page().get("paper") {
        Some(Value::String(p)) => paper_size(p) != Some(None),
        _ => true,
    }
}

/// 级联两趟：先算出纸，再把 `paged` 填进上下文重算。
pub fn compute_style_for_paper(layers: &[&[StyleRule]], ctx: &StyleContext) -> StyleSheet {
    let paged = is_paged_sheet(&compute_style(layers, ctx));
    let mut c = ctx.clone();
    c.insert("paged".into(), Value::Bool(paged));
    compute_style(layers, &c)
}
