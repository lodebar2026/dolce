//! 简谱记号的字形表（`engrave/jpglyph.ts`）：文本谱 `&xx`、力度、小节线记号、临时记号、连谱号 → Bravura 码位。
//! 名字表（力度名、术语）在 `dolce_model::marknames`。PUA 码位一律按数写（`cp`），源码里不写字面字符。

use crate::articulation::artic_glyph;
use crate::dynamics::dynamic_glyphs;
use crate::cp;

/// 记号在音符的哪一侧。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrnamentPlacement {
    Above,
    Below,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OrnamentGlyph {
    pub glyph: String,
    pub placement: OrnamentPlacement,
    /// 相对数字字号的缩放
    pub scale: f64,
    /// 中文名，提示与诊断用
    pub label: &'static str,
}

/// `&xx` 记号表（名称取符号中文名的拼音首字母）。键序同 TS。
pub const ORNAMENT_NAMES: &[&str] =
    &["yc", "ycy", "bc", "zy", "dy", "hx", "shy", "xhy", "sby", "xby", "cy", "tr", "sg", "xg", "trem1", "trem2", "trem3", "trem4"];

/// `ORNAMENTS[name]`。
pub fn ornament(name: &str) -> Option<OrnamentGlyph> {
    let (g, scale, label) = match name {
        "yc" | "ycy" => (artic_glyph("fermata", true), 1.0, "延长记号"),
        "bc" => (artic_glyph("tenuto", true), 0.9, "保持音"),
        "zy" => (artic_glyph("accent", true), 0.9, "重音"),
        "dy" => (artic_glyph("staccato", true), 1.6, "顿音"),
        "hx" => (cp(0xe4ce), 0.9, "呼吸记号"),
        "shy" => (cp(0xe5d0), 0.9, "上滑音"),
        "xhy" => (cp(0xe5d3), 0.9, "下滑音"),
        "sby" => (cp(0xe56c), 0.9, "上波音"),
        "xby" => (cp(0xe56d), 0.9, "下波音"),
        "cy" | "tr" => (cp(0xe566), 0.9, "颤音"),
        "sg" => (cp(0xe612), 0.9, "上弓"),
        "xg" => (cp(0xe610), 0.9, "下弓"),
        "trem1" => (cp(0xe220), 0.8, "震音"),
        "trem2" => (cp(0xe221), 0.8, "震音"),
        "trem3" => (cp(0xe222), 0.8, "震音"),
        "trem4" => (cp(0xe223), 0.8, "震音"),
        _ => return None,
    };
    Some(OrnamentGlyph { glyph: g, placement: OrnamentPlacement::Above, scale, label })
}

/// 力度名 → 字形（`DYNAMICS[name]`，只收 `DYNAMIC_NAMES` 里的名字）。
pub fn dynamic(name: &str) -> Option<String> {
    dolce_model::marknames::DYNAMIC_NAMES.contains(&name).then(|| dynamic_glyphs(name))
}

/// 小节线上的反复 / 导航记号（`BARLINE_MARKS`）：(文字, 字形, 中文名)。
pub fn barline_mark(name: &str) -> Option<(Option<&'static str>, Option<String>, &'static str)> {
    Some(match name {
        "fine" => (Some("Fine"), None, "曲终"),
        "dc" => (Some("D.C."), None, "从头反复"),
        "ds" => (Some("D.S."), None, "大反复"),
        "ty" => (None, Some(cp(0xe048)), "跳跃记号"),
        "hs" => (None, Some(cp(0xe047)), "花 S 记号"),
        "sbf" => (None, None, "声部括弧起点"),
        _ => return None,
    })
}

/// 临时升降号（`ACCIDENTAL_GLYPH`）：与 `.jpwabc` 谱面同一套 SMuFL 字形。
pub fn accidental_glyph(name: &str) -> Option<String> {
    Some(match name {
        "flat" => cp(0xe260),
        "natural" => cp(0xe261),
        "sharp" => cp(0xe262),
        "double-sharp" => cp(0xe263),
        "double-flat" => cp(0xe264),
        _ => return None,
    })
}

/// 连谱号（`BRACKET`）。
pub mod bracket {
    pub const TOP: u32 = 0xe003;
    pub const BOTTOM: u32 = 0xe004;
    pub const BRACE: u32 = 0xe000;
    pub const BRACE_SMALL: u32 = 0xf400;
}

/// 伴奏括弧 `&zkh` / `&ykh`。
pub fn is_accomp_bracket(name: &str) -> bool {
    matches!(name, "zkh" | "ykh")
}

