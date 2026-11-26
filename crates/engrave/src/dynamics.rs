//! 力度记号 → Bravura 字形串（`engrave/dynamics.ts`）：逐字母拼单字母字形，`sffz`、`rfz` 也画得出。

use crate::glyph;

/// 力度字形的字号 ÷ 简谱数字字号。
pub const DYNAMIC_SIZE: f64 = 1.4;

fn letter(c: char) -> Option<&'static str> {
    Some(match c {
        'p' => "dynamicPiano",
        'm' => "dynamicMezzo",
        'f' => "dynamicForte",
        'r' => "dynamicRinforzando",
        's' => "dynamicSforzando",
        'z' => "dynamicZ",
        'n' => "dynamicNiente",
        _ => return None,
    })
}

/// 力度名 → 字形串；有认不出的字母返回 ""。
pub fn dynamic_glyphs(name: &str) -> String {
    let mut res = String::new();
    for c in name.chars() {
        match letter(c) {
            Some(g) => res.push_str(&glyph(g)),
            None => return String::new(),
        }
    }
    res
}
