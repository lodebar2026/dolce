//! SMuFL（Bravura）字形码位与元数据，照 `src/smufl/smufl.ts`。
//!
//! 元数据（`bravura_metadata.json`）只读两张表：`glyphBBoxes`（紧包围盒，乐谱坐标、y 向上、单位 staff space）
//! 与 `glyphsWithAnchors`（锚点）。字体盒（ascent / descent）一概不用——Bravura 的全局盒约 4 em，见 CLAUDE.md。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

mod codes;
pub use codes::GLYPHS;

/// 名 → 码位（全部 102 个）。
pub fn glyph_code(name: &str) -> Option<char> {
    GLYPHS.iter().find(|g| g.0 == name).and_then(|g| char::from_u32(g.1))
}

/// 码位 → 名（`glyphCodeName`；只认 TS `codeToName` 收的那 98 个）。
pub fn glyph_code_name(c: char) -> Option<&'static str> {
    let cp = c as u32;
    GLYPHS.iter().find(|g| g.1 == cp && g.2).map(|g| g.0)
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct GlyphBBox {
    #[serde(rename = "bBoxNE")]
    pub ne: [f64; 2],
    #[serde(rename = "bBoxSW")]
    pub sw: [f64; 2],
}

/// 锚点（元数据里有什么记什么，按名取）。
pub type GlyphAnchor = HashMap<String, [f64; 2]>;

#[derive(Debug, Default, Deserialize)]
struct RawMetadata {
    #[serde(rename = "fontName", default)]
    font_name: Option<String>,
    #[serde(rename = "fontVersion", default)]
    font_version: Option<serde_json::Value>,
    #[serde(rename = "glyphBBoxes", default)]
    glyph_bboxes: HashMap<String, GlyphBBox>,
    #[serde(rename = "glyphsWithAnchors", default)]
    glyphs_with_anchors: HashMap<String, GlyphAnchor>,
}

#[derive(Debug, Default, Clone)]
pub struct MetaData {
    pub font_name: String,
    pub font_version: String,
    pub glyph_bboxes: HashMap<String, GlyphBBox>,
    pub glyphs_with_anchors: HashMap<String, GlyphAnchor>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UnknownGlyph(pub char);

impl std::fmt::Display for UnknownGlyph {
    /// 同 TS 的报错文字：`unknown smufl glyph: e0a4`
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // TS 用 `charCodeAt(0)`：非 BMP 字取高代理
        let mut buf = [0u16; 2];
        let unit = self.0.encode_utf16(&mut buf)[0];
        write!(f, "unknown smufl glyph: {unit:x}")
    }
}

impl MetaData {
    pub fn from_json(text: &str) -> Result<MetaData, serde_json::Error> {
        let raw: RawMetadata = serde_json::from_str(text)?;
        Ok(MetaData {
            font_name: raw.font_name.unwrap_or_default(),
            font_version: match raw.font_version {
                Some(serde_json::Value::String(s)) => s,
                Some(v) => v.to_string(),
                None => String::new(),
            },
            glyph_bboxes: raw.glyph_bboxes,
            glyphs_with_anchors: raw.glyphs_with_anchors,
        })
    }

    pub fn bbox_by_name(&self, n: &str) -> Option<&GlyphBBox> {
        self.glyph_bboxes.get(n)
    }

    /// 按码位取紧包围盒；码位不在反查表里报错（同 TS 抛错），在表里但元数据没有给 `Ok(None)`。
    pub fn bbox(&self, c: char) -> Result<Option<&GlyphBBox>, UnknownGlyph> {
        let n = glyph_code_name(c).ok_or(UnknownGlyph(c))?;
        Ok(self.bbox_by_name(n))
    }

    pub fn anchor_by_name(&self, n: &str) -> Option<&GlyphAnchor> {
        self.glyphs_with_anchors.get(n)
    }

    /// 按码位取锚点；不认识的码位给 None（TS 不抛）。
    pub fn anchor(&self, c: char) -> Option<&GlyphAnchor> {
        glyph_code_name(c).and_then(|n| self.anchor_by_name(n))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes() {
        assert_eq!(GLYPHS.len(), 110);
        assert_eq!(glyph_code("noteheadBlack"), char::from_u32(0xE0A4));
        assert_eq!(glyph_code_name(char::from_u32(0xE0A4).unwrap()), Some("noteheadBlack"));
        // 码位表有、反查表没有
        let dim = glyph_code("csymDiminished").unwrap();
        assert_eq!(glyph_code_name(dim), None);
        let md = MetaData::default();
        assert_eq!(md.bbox(dim).unwrap_err().to_string(), "unknown smufl glyph: e870");
    }

    #[test]
    fn bravura_metadata() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../public/redist/bravura_metadata.json");
        let Ok(text) = std::fs::read_to_string(path) else { return };
        let md = MetaData::from_json(&text).unwrap();
        assert_eq!(md.font_name, "Bravura");
        let b = md.bbox(glyph_code("noteheadBlack").unwrap()).unwrap().unwrap();
        assert!(b.ne[0] > 1.0 && b.sw[1] < 0.0);
        assert!(md.anchor(glyph_code("flag8thUp").unwrap()).is_some());
    }
}
