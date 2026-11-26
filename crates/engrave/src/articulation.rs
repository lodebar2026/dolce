//! 奏法记号与延长记号 → SMuFL 字形（朝上那一个，`engrave/articulation.ts`）。
//! **简谱的断奏是实心倒三角 ▼**（数字正上方的圆点已经是高音点），五线谱是圆点。

use crate::{cp, glyph};

/// 记号名 → 朝上的字形；不认得返回 ""。`jianpu` 为真时按简谱的印法（断奏 → 倒三角 U+E0C7）。
pub fn artic_glyph(name: &str, jianpu: bool) -> String {
    match name {
        "fermata" => glyph("fermataAbove"),
        "accent" => glyph("articAccentAbove"),
        "strong-accent" => glyph("articMarcatoAbove"),
        "tenuto" => glyph("articTenutoAbove"),
        "staccatissimo" => {
            if jianpu {
                cp(0xe0c7)
            } else {
                glyph("articStaccatissimoAbove")
            }
        }
        "staccato" => {
            if jianpu {
                cp(0xe0c7)
            } else {
                glyph("articStaccatoAbove")
            }
        }
        _ => String::new(),
    }
}
