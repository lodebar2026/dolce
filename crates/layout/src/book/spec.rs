//! 原书一页的版面规格（照 `src/pdflayout/spec.ts` 的类型）。由原书 PDF 抽出（`vector.ts` → `inventory.ts` → `buildPageSpec`，
//! 那条读原书的链这期不搬），Rust 这边只读它的 JSON（dev `page-report.mjs` 出的 `out/pdf-layout.json`）。

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

/// `{x, y, w, h}`（`omr/types.ts::Rect`）
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 逐字：位置、尺寸、字符、原字形的形状键
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SChar {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub ch: String,
    pub key: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRun {
    pub text: String,
    #[serde(rename = "box")]
    pub bx: SRect,
    pub baseline_y: f64,
    pub size: f64,
    pub chars: Vec<SChar>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameSpec {
    /// `rule-h` / `rule-v` / `box` / `ornament` / `bracket` / `image` / `shading`
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "box")]
    pub bx: SRect,
    pub line_width: f64,
    pub dash: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tiles: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile_w: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile_h: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StoryBox {
    #[serde(rename = "box")]
    pub bx: SRect,
    pub frame: FrameSpec,
    pub lines: Vec<TextRun>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSpec {
    pub index: f64,
    pub note_top: f64,
    pub note_bottom: f64,
    pub x0: f64,
    pub x1: f64,
    pub barline_xs: Vec<f64>,
    pub notes: Vec<SChar>,
    pub chord_lines: Vec<TextRun>,
    pub lyric_lines: Vec<TextRun>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongPlacement {
    pub id: Option<String>,
    pub gt_title: Option<String>,
    pub starts_here: bool,
    pub y_from: f64,
    pub y_to: f64,
    pub number_run: Option<TextRun>,
    pub title_run: Option<TextRun>,
    pub key_meter_run: Option<TextRun>,
    pub category_run: Option<TextRun>,
    pub credit_runs: Vec<TextRun>,
    pub systems: Vec<SystemSpec>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkSpec {
    pub cls: String,
    #[serde(rename = "box")]
    pub bx: SRect,
    pub line_width: f64,
    pub dash: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub d: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Coverage {
    pub total: f64,
    #[serde(rename = "byClass")]
    pub by_class: IndexMap<String, f64>,
    pub unplaced: f64,
    pub fallback: f64,
    pub unread: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSpec {
    pub page: i64,
    pub size: [f64; 2],
    pub rotation: f64,
    /// `PageKind`
    pub kind: String,
    pub songs: Vec<SongPlacement>,
    pub header: Option<TextRun>,
    pub footer: Option<TextRun>,
    pub text_lines: Vec<TextRun>,
    pub marks: Vec<MarkSpec>,
    pub story_boxes: Vec<StoryBox>,
    pub frames: Vec<FrameSpec>,
    pub has_raw_text: bool,
    pub coverage: Coverage,
}

#[cfg(test)]
mod tests {
    /// 本机有原书版面规格时读一遍（没有就跳过）
    #[test]
    fn reads_page_report() {
        let Ok(t) = std::fs::read_to_string("../../out/pdf-layout.json") else { return };
        let v: serde_json::Value = serde_json::from_str(&t).unwrap();
        let pages: Vec<super::PageSpec> = serde_json::from_value(v["pages"].clone()).unwrap();
        assert!(pages.len() > 600);
    }
}
