//! 纸张（照 `style/paper.ts`）：纸名 / 方向 / 边距 → 实际尺寸，以及谱里自带的版面 → 样式规则（曲内层）。

use crate::cascade::StyleRule;
use crate::themes::paper_size;
use dolce_model::doc::Song;
use dolce_model::pagemeta::{song_page, standard_paper_of};
use serde_json::{json, Value};

/// 不在纸张表里的尺寸（谱里自带的非标准纸）记成这个名字，尺寸在 `size`。
pub const CUSTOM_PAPER: &str = "自定义";

/// `resolvePaper` 的结果：实际尺寸（pt，已按方向转好）、长图（null）、没写纸（undefined）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ResolvedPaper {
    Size { w: f64, h: f64 },
    Long,
    Unset,
}

fn num_pair(v: &Value) -> Option<(f64, f64)> {
    let a = v.as_array()?;
    let at = |i: usize| a.get(i).and_then(Value::as_f64).unwrap_or(f64::NAN);
    Some((at(0), at(1)))
}

/// 纸的实际尺寸。`page` 是样式表的 `page`（`PageDecl`）。
pub fn resolve_paper(page: &Value) -> ResolvedPaper {
    let Some(name) = page.get("paper") else { return ResolvedPaper::Unset };
    let wh = match name.as_str().and_then(paper_size) {
        Some(None) => return ResolvedPaper::Long,
        Some(Some(wh)) => Some(wh),
        None => match page.get("size") {
            Some(Value::Null) => return ResolvedPaper::Long,
            Some(s) => num_pair(s),
            None => None,
        },
    };
    let Some((a, b)) = wh else { return ResolvedPaper::Unset };
    let landscape = page.get("orientation").and_then(Value::as_str) == Some("landscape");
    if landscape == (a > b) {
        ResolvedPaper::Size { w: a, h: b }
    } else {
        ResolvedPaper::Size { w: b, h: a }
    }
}

/// 编辑器用的边距 `[上, 右, 下, 左]`（pt）。没写或写得不全回 None。
pub fn page_margins(page: &Value) -> Option<[f64; 4]> {
    match page.get("margin")? {
        Value::Number(n) => Some([n.as_f64()?; 4]),
        Value::Array(a) => {
            if a.len() != 4 {
                return None;
            }
            let mut out = [0.0; 4];
            for (i, v) in a.iter().enumerate() {
                out[i] = v.as_f64().filter(|x| x.is_finite() && *x >= 0.0)?;
            }
            Some(out)
        }
        _ => None,
    }
}

/// 尺寸（pt）→ 纸张声明：标准纸（±2pt，横竖都认）记纸名 + 方向，其余记自定义尺寸。
pub fn page_decl_of_size(w: f64, h: f64) -> Value {
    if let Some((name, landscape)) = standard_paper_of(w, h) {
        return json!({ "paper": name, "orientation": if landscape { "landscape" } else { "portrait" } });
    }
    let (a, b) = if w > h { (h, w) } else { (w, h) };
    json!({ "paper": CUSTOM_PAPER, "size": [a, b], "orientation": if w > h { "landscape" } else { "portrait" } })
}

/// 谱里自带的纸 → 纸张声明。
pub fn song_page_decl(song: &Song) -> Option<Value> {
    let page = song_page(song)?;
    let mut decl = page_decl_of_size(page.w, page.h);
    if let Some(m) = page.margins {
        decl["margin"] = json!(m);
    }
    Some(decl)
}

/// 曲内层：谱里自带的纸作为一条不带限定的规则。
pub fn doc_page_layer(song: Option<&Song>) -> Vec<StyleRule> {
    match song.and_then(song_page_decl) {
        Some(page) => vec![StyleRule { when: None, set: json!({ "page": page }) }],
        None => vec![],
    }
}
