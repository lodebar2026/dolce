//! 识别结果建模（`omr-todoc`）：简谱识别结果在编辑器里会改（参照歌词改字），换输出格式时把改过的那份送回来重建模型。

use crate::{json, parse};
use dolce_omr_sheet::jianpu::RecognizedScore;
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JianpuDoc {
    doc: dolce_model::doc::ScoreDoc,
    /// `[元素 id, 拍平后的音符下标]`
    num_of: Vec<(u32, usize)>,
}

/// 简谱识别结果（`RecognizedScore` 的 JSON）→ `{ doc, numOf }`。
#[wasm_bindgen(js_name = omrJianpuDoc)]
pub fn omr_jianpu_doc(score: &str) -> Result<String, JsValue> {
    let score: RecognizedScore = parse("RecognizedScore", score)?;
    let b = dolce_omr_todoc::jianpu::recognized_to_doc(&score);
    Ok(json(&JianpuDoc { doc: b.doc, num_of: b.num_of }))
}

/// 各音符（拍平序）的和弦落点：`"h"` / `"s<k>"` / `"l<k>"`。
#[wasm_bindgen(js_name = omrChordPlaces)]
pub fn omr_chord_places(score: &str) -> Result<String, JsValue> {
    let score: RecognizedScore = parse("RecognizedScore", score)?;
    let places: Vec<Vec<String>> = dolce_omr_todoc::jianpu::chord_places(&score).iter().map(|p| p.iter().map(|c| c.code()).collect()).collect();
    Ok(json(&places))
}
