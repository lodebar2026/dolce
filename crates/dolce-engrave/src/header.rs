//! 页眉文字（标题、副标题、经文、词曲）的字体（`engrave/header.ts`）。

use dolce_style::header::HeaderFont;
use dolce_text::Font;

/// 某一角色的页眉字：给了族或粗体就用，没给的沿用 `base`。字号由调用方定。
pub fn header_role_font(hf: Option<&HeaderFont>, size: f64, base: &Font) -> Font {
    let fam = hf.and_then(|h| h.family.as_deref()).filter(|f| !f.is_empty());
    let bold = hf.and_then(|h| h.bold);
    if fam.is_none() && bold.is_none() {
        return base.with_size(size);
    }
    Font {
        family: hf.and_then(|h| h.family.clone()).unwrap_or_else(|| base.family.clone()),
        size,
        bold: bold.unwrap_or(base.bold),
        italic: base.italic,
    }
}
