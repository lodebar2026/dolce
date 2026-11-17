//! 角色 → 一支字（照 `style/fonts.ts`）。四把尺子与模板排版共用这一份解析。
//!
//! 取值顺序：`font: 名` 经 `families` 映射 → `family: "…"` → `@font-face 名` 的 `family` → 调用方给的 `base`。
//! 字重：角色的 `weight: bold` 或 `@font-face` 的 `bold: true`。

use crate::sheet::{truthy, StyleSheet};
use crate::value::js_to_string;
use dolce_text::Font;
use indexmap::IndexMap;
use serde_json::Value;

/// `@font-face` 名 → 页面里已注册的 CSS 族。
pub type FamilyMap = IndexMap<String, String>;

fn defined(v: Option<&Value>) -> Option<&Value> {
    v.filter(|x| !x.is_null())
}

/// 角色给的族与字重；角色没写字体就回 None（调用方保留自己的默认）。族为空串 = 只给了粗体。
pub fn family_of_role(sheet: &StyleSheet, role: &str, families: &FamilyMap) -> Option<(String, bool)> {
    let decl = sheet.role(role).filter(|d| truthy(Some(d)))?;
    let font_key = decl.get("font").filter(|f| truthy(Some(f))).map(js_to_string);
    let face = font_key.as_deref().and_then(|k| sheet.template_font(k));
    let family = font_key
        .as_deref()
        .and_then(|k| families.get(k).cloned())
        .or_else(|| defined(decl.get("family")).map(js_to_string))
        .or_else(|| defined(face.and_then(|f| f.get("family"))).map(js_to_string));
    let bold_weight = decl.get("weight").and_then(Value::as_str) == Some("bold");
    let bold = bold_weight || face.and_then(|f| f.get("bold")) == Some(&Value::Bool(true));
    match family {
        None => bold_weight.then(|| (String::new(), bold)),
        Some(f) => Some((f, bold)),
    }
}

/// 角色 → `Font`：族与字重按角色，字号用 `size`（不给就沿用 `base` 的）。
pub fn font_of_role(sheet: &StyleSheet, role: &str, base: &Font, size: Option<f64>, families: &FamilyMap) -> Font {
    let size = size.unwrap_or(base.size);
    match family_of_role(sheet, role, families) {
        None => Font { size, ..base.clone() },
        Some((family, bold)) => Font {
            family: if family.is_empty() { base.family.clone() } else { family },
            size,
            bold: bold || base.bold,
            italic: base.italic,
        },
    }
}

/// 设置面板「音符字体」能选的：id、字体族串、要不要加粗。
pub const NOTE_FONTS: [(&str, &str, bool); 3] = [
    ("pingfang", "PingFang SC, Microsoft YaHei, sans-serif", true),
    ("helvetica", "Helvetica Neue, Helvetica, Arial, PingFang SC, sans-serif", true),
    ("times", "Times New Roman, Times, serif", false),
];
