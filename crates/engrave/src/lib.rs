//! 悦谱 Dolce 的**排版底座**：谱面元素、量字、页面场景与样式表，简谱引擎（`dolce-layout-jianpu`）与五线谱 / 混排引擎
//! （`dolce-layout-staff`）都调它。不开 `native` / `fontfile-system` 时没有平台依赖，能编到 `wasm32`。
//!
//! ## 模块
//!
//! - **谱面元素（根模块）**：数字、八度点、减时线、弧、小节线、房子、力度、和弦……每种只有一份画法与定位判据，产出场景节点
//!   （[`crate::scene::Node`]）。元素的样子与相对位置只在这里写；引擎只把自己的尺子折成元素参数、给锚点、做整行级的事。
//!   量字与 SMuFL 元数据一律经 [`Env`] 给，不走全局。
//! - **[`text`]**：量字——量字 trait、缓存、标点挤压、浏览器口径层、录放后端；`text::assets` 带 Bravura 与 SMuFL 元数据。
//! - **[`scene`]**：页面场景节点树、交互身份表、SVG 出口（[`scene::svg::page_svg`]）、SMuFL 码位与紧包围盒（[`scene::smufl`]）。
//! - **[`style`]**：`.ss` 样式表解析、级联求值、主题与纸张、折成引擎的尺子。
//!
//! ## 特性
//!
//! - `fontfile`：字体文件层（`text::fontfile`，`fontdb` + `rustybuzz`），导出 PDF 嵌字用。
//! - `fontfile-system`：再扫系统字体目录（Linux 问 fontconfig）。
//! - `native`：系统文字引擎量字（`text::native`；macOS 是 CoreText、Windows 是 DirectWrite，Linux 走 `fontfile-system`）。
//!
//! ## 维护
//!
//! 类名、角色、身份与 TS 原版一字不差：`ScorePainter`、成书扁平化、PPTX、可视化编辑都按它们认，别改名。
//! 判据与历史见仓库 `docs/模块/排版-谱面元素.md` 与各文件头注释。

#![cfg_attr(docsrs, feature(doc_cfg))]

pub use crate::scene::build::Env;

// 并入的排版底座（原各自一个 crate）：量字、页面场景、样式
pub mod scene;
pub mod style;
pub mod text;

pub mod accidental;
pub mod arc;
pub mod arpeggio;
pub mod articulation;
pub mod augdot;
pub mod barline;
pub mod beatgroup;
pub mod breath;
pub mod chord;
pub mod dash;
pub mod dot;
pub mod dynamics;
pub mod ending;
pub mod grace;
pub mod hairpin;
pub mod header;
pub mod jpglyph;
pub mod jpnumber;
pub mod jpslide;
pub mod jptremolo;
pub mod keysig;
pub mod prims;
pub mod sectionword;
pub mod spacing;
pub mod stack;
pub mod syllable;
pub mod timesig;
pub mod tuplet;
pub mod upperband;

/// SMuFL 字形名 → 一个字的串（`GlyphCodes.xxx`）。名字写错是编程错误，直接 panic。
pub fn glyph(name: &str) -> String {
    crate::scene::smufl::glyph_code(name).unwrap_or_else(|| panic!("没有这个 SMuFL 字形名：{name}")).to_string()
}

/// 码位 → 一个字的串（`String.fromCharCode`，PUA 码位不在源码里写字面字符）。
pub(crate) fn cp(n: u32) -> String {
    char::from_u32(n).map(String::from).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    #[test]
    fn glyph_names() {
        for n in [
            "csymAccidentalSharp", "csymAccidentalFlat", "csymAccidentalNatural", "accidentalDoubleSharp", "accidentalDoubleFlat",
            "accidentalSharp", "accidentalFlat", "accidentalNatural", "tuplet0", "fermataAbove", "articAccentAbove",
            "articMarcatoAbove", "articTenutoAbove", "articStaccatissimoAbove", "articStaccatoAbove", "dynamicPiano",
            "dynamicMezzo", "dynamicForte", "dynamicRinforzando", "dynamicSforzando", "dynamicZ", "dynamicNiente",
            "csymHalfDiminished", "csymAugmented", "csymDiminished", "wiggleTrillSlow",
        ] {
            super::glyph(n);
        }
    }
}
