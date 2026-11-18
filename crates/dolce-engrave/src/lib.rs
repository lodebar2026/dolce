//! 谱面元素，照 `src/engrave/`：**每种谱面元素一份画法与定位判据**，简谱引擎（`dolce-layout-jianpu`）与五线谱 / 混排
//! （`dolce-layout-staff`）都调它。元素的**样子与相对位置**只在这里写；引擎只把自己的尺子折成元素参数、给锚点、做整行级的事。
//! 判据与历史见 `docs/模块/排版-谱面元素.md` 与各文件头注释（TS 原文注释里的曲目病例保留在 TS 那份，迁完随文档迁）。
//!
//! 产出是场景节点（[`dolce_scene::Node`]）。量字一律经 [`Env`]（量字上下文 + SMuFL 元数据），不走全局。
//! 类名、角色、身份与 TS 一字不差：`ScorePainter`、成书扁平化、PPTX、可视化编辑都按它们认。

pub use dolce_scene::build::Env;

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
    dolce_scene::smufl::glyph_code(name).unwrap_or_else(|| panic!("没有这个 SMuFL 字形名：{name}")).to_string()
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
