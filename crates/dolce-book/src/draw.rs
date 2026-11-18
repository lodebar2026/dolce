//! DrawList（照 `src/pdflayout/drawlist.ts` 的类型与 `shiftDrawPageX` / `drawPageStats`）：**两条重排路与 PDF 输出之间的唯一契约**。
//!
//! A 路 relayout：`PageSpec` + BookStyle → `relayout::spec_to_draw_page`；B 路 rebuild：场景树 → `scenedraw::page_items_to_draw_page`；
//! 两路汇合交 PDF 写出端。坐标一律 SVG 系（左上原点、y 向下、单位 pt）。
//!
//! JSON 形状与 TS 相同（`t` 作标签、可选字段缺省不写），对拍按 JSON 逐字段比；缺键与 `null` 视同。

use serde::{Deserialize, Serialize};

/// 页面上一个图元（TS `DrawItem`，按 `t` 分派）
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum DrawItem {
    Text(DrawText),
    Path(DrawPath),
    Rect(DrawRect),
    Line(DrawLine),
}

/// 墨迹包络（`DrawText.box`）
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct InkSpan {
    pub x: f64,
    pub w: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawText {
    /// 基线 y
    pub y: f64,
    /// 画的时候在基线上再挪这么多（正数向下）；只影响绘制，不进任何度量
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dy: Option<f64>,
    pub text: String,
    pub size: f64,
    pub role: String,
    /// `AlignMode`：`pen` / `left` / `center` / `right` / …
    pub align: String,
    /// 逐字 x：`pen` 时是笔位，其余是墨迹左缘（A 路）
    pub xs: Vec<f64>,
    /// 逐字墨迹宽（A 路才有）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ws: Option<Vec<f64>>,
    /// 整 run 的墨迹包络
    #[serde(default, rename = "box", skip_serializing_if = "Option::is_none")]
    pub ink_box: Option<InkSpan>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<u32>,
    /// TS 里 `songId: null` 与缺键并存；对拍时缺键与 `null` 视同，这里一律缺省不写
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub song_id: Option<String>,
    /// 语义标记（只给检查脚本用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cls: Option<String>,
    /// SMuFL 字形墨迹上缘
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ink_top: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DrawPath {
    pub d: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sw: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dash: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cls: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DrawRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sw: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DrawLine {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
    pub sw: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cls: Option<String>,
}

/// 本页上的一首（一页可能两首：半页起排）
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSong {
    pub id: Option<String>,
    pub title: Option<String>,
    pub first: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y_from: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y_to: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMeta {
    /// `PageKind`：`cover` / `front-matter` / `toc` / `index` / `score` / `blank` / `unknown`
    pub kind: String,
    pub songs: Vec<PageSong>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_label: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawPage {
    pub page_no: i64,
    pub w: f64,
    pub h: f64,
    pub meta: PageMeta,
    pub items: Vec<DrawItem>,
    /// rebuild 装订时挂上的印刷页码（`dp.label`）；TS 里是动态加的属性，写 drawlist.json 时带出
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// rebuild 装箱时挂上的分类名（`dp.cat`，页眉用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cat: Option<String>,
    /// rebuild 装箱时挂上的各角色字号（`dp.sizes`，页眉页脚用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sizes: Option<serde_json::Map<String, serde_json::Value>>,
}

impl DrawPage {
    pub fn new(page_no: i64, w: f64, h: f64, meta: PageMeta) -> DrawPage {
        DrawPage { page_no, w, h, meta, items: Vec::new(), label: None, cat: None, sizes: None }
    }
}

/// `Math.round(v * 100) / 100` 再按 JS 口径转串
fn round2_str(v: f64) -> String {
    dolce_base::js::num_to_string((v * 100.0 + 0.5).floor() / 100.0)
}

/// 整页横向平移（对开页镜像；照 `shiftDrawPageX`）：路径 `d` 里的数按下标奇偶加（x/y 交替）。
pub fn shift_draw_page_x(page: &mut DrawPage, dx: f64) {
    if dx == 0.0 {
        return;
    }
    for it in &mut page.items {
        match it {
            DrawItem::Text(t) => {
                for x in &mut t.xs {
                    *x += dx;
                }
                if let Some(b) = &mut t.ink_box {
                    b.x += dx;
                }
            }
            DrawItem::Rect(r) => r.x += dx,
            DrawItem::Line(l) => {
                l.x1 += dx;
                l.x2 += dx;
            }
            DrawItem::Path(p) => {
                // /-?\d*\.?\d+/g
                let mut i = 0usize;
                p.d = replace_numbers(&p.d, |m| {
                    let out = if i.is_multiple_of(2) { round2_str(dolce_base::js::number(m) + dx) } else { m.to_string() };
                    i += 1;
                    out
                });
            }
        }
    }
}

/// 照 JS `/-?\d*\.?\d+/g` 逐个替换数（不引正则：这一式子的匹配规则很简单）
pub fn replace_numbers(s: &str, mut f: impl FnMut(&str) -> String) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    let mut last = 0usize;
    while i < b.len() {
        if let Some(end) = match_number(b, i) {
            out.push_str(&s[last..i]);
            out.push_str(&f(&s[i..end]));
            i = end;
            last = end;
        } else {
            i += 1;
        }
    }
    out.push_str(&s[last..]);
    out
}

/// 在 `i` 处试匹配 `-?\d*\.?\d+`（贪婪、回溯同 JS），返回终点
pub(crate) fn match_number(b: &[u8], i: usize) -> Option<usize> {
    let try_from = |start: usize| -> Option<usize> {
        let mut j = start;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        let int_end = j;
        // 先试 `\d*\.\d+`
        if j < b.len() && b[j] == b'.' {
            let mut k = j + 1;
            while k < b.len() && b[k].is_ascii_digit() {
                k += 1;
            }
            if k > j + 1 {
                return Some(k);
            }
        }
        // 回溯：不带小数点，`\d*` 让出最后一位给 `\d+`
        (int_end > start).then_some(int_end)
    };
    if b[i] == b'-' {
        if let Some(e) = try_from(i + 1) {
            return Some(e);
        }
        return None;
    }
    if b[i].is_ascii_digit() || b[i] == b'.' {
        return try_from(i);
    }
    None
}

/// 每个角色各画了多少字（照 `drawPageStats`；文字按码点计）。键序同 JS 对象的插入序。
pub fn draw_page_stats(p: &DrawPage) -> indexmap::IndexMap<String, usize> {
    let mut out = indexmap::IndexMap::new();
    for it in &p.items {
        let (k, n) = match it {
            DrawItem::Text(t) => (t.role.clone(), t.text.chars().count()),
            DrawItem::Path(_) => ("path".into(), 1),
            DrawItem::Rect(_) => ("rect".into(), 1),
            DrawItem::Line(_) => ("line".into(), 1),
        };
        *out.entry(k).or_insert(0) += n;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_like_js_regex() {
        let mut got = Vec::new();
        replace_numbers("M1.5 -2L.5 3.C-.25 7", |m| {
            got.push(m.to_string());
            m.to_string()
        });
        assert_eq!(got, ["1.5", "-2", ".5", "3", "-.25", "7"]);
    }

    #[test]
    fn shift_path() {
        let mut p = DrawPage::new(1, 10.0, 10.0, PageMeta { kind: "score".into(), songs: vec![], page_label: None });
        p.items.push(DrawItem::Path(DrawPath { d: "M1 2L3.333 4Z".into(), fill: None, stroke: None, sw: None, dash: None, cls: None }));
        shift_draw_page_x(&mut p, 1.0);
        let DrawItem::Path(q) = &p.items[0] else { unreachable!() };
        assert_eq!(q.d, "M2 2L4.33 4Z");
    }
}
