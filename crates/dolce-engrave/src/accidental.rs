//! 简谱临时记号（数字左边的 ♭ ♯ ♮，`engrave/accidental.ts`）。两种样子：`csym`（缺省，按**数字墨迹盒**的比例定位，
//! 换字体字号都跟着走）与 `classic`（原先旧简谱引擎那样，成书照原书用它）。位置一律按墨迹。

use dolce_model::base::geom::Rect;
use dolce_scene::Node;
use dolce_text::Font;

use crate::glyph;
use crate::prims::{music_ink, music_text};
use crate::spacing::AccidentalStyleKind;
use crate::Env;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccidentalKind {
    Sharp,
    Flat,
    Natural,
    DoubleSharp,
    DoubleFlat,
}

impl AccidentalKind {
    pub fn parse(s: &str) -> Option<AccidentalKind> {
        Some(match s {
            "sharp" => AccidentalKind::Sharp,
            "flat" => AccidentalKind::Flat,
            "natural" => AccidentalKind::Natural,
            "double-sharp" => AccidentalKind::DoubleSharp,
            "double-flat" => AccidentalKind::DoubleFlat,
            _ => return None,
        })
    }
    pub fn as_str(self) -> &'static str {
        match self {
            AccidentalKind::Sharp => "sharp",
            AccidentalKind::Flat => "flat",
            AccidentalKind::Natural => "natural",
            AccidentalKind::DoubleSharp => "double-sharp",
            AccidentalKind::DoubleFlat => "double-flat",
        }
    }
    /// 名里带 `flat`（降、重降）
    pub fn is_flat(self) -> bool {
        matches!(self, AccidentalKind::Flat | AccidentalKind::DoubleFlat)
    }
    fn csym_glyph(self) -> String {
        glyph(match self {
            AccidentalKind::Sharp => "csymAccidentalSharp",
            AccidentalKind::Flat => "csymAccidentalFlat",
            AccidentalKind::Natural => "csymAccidentalNatural",
            // csym 没有重升重降，用五线谱那两个
            AccidentalKind::DoubleSharp => "accidentalDoubleSharp",
            AccidentalKind::DoubleFlat => "accidentalDoubleFlat",
        })
    }
    fn classic_glyph(self) -> String {
        glyph(match self {
            AccidentalKind::Sharp => "accidentalSharp",
            AccidentalKind::Flat => "accidentalFlat",
            AccidentalKind::Natural => "accidentalNatural",
            AccidentalKind::DoubleSharp => "accidentalDoubleSharp",
            AccidentalKind::DoubleFlat => "accidentalDoubleFlat",
        })
    }
    /// 墨迹宽 ÷ 数字墨迹高（Bravura：字号 1.867 H 时的实测墨迹宽）
    fn ink_width(self) -> f64 {
        match self {
            AccidentalKind::Flat => 8.49 / 16.065,
            AccidentalKind::Sharp => 9.3 / 16.065,
            AccidentalKind::Natural => 5.52 / 16.065,
            AccidentalKind::DoubleSharp => 0.988 * 7.5 / 16.065,
            AccidentalKind::DoubleFlat => 1.644 * 7.5 / 16.065,
        }
    }
    /// 墨迹高 ÷ 数字墨迹高
    fn ink_height(self) -> f64 {
        match self {
            AccidentalKind::Flat => 22.47 / 16.065,
            AccidentalKind::Sharp => 23.25 / 16.065,
            AccidentalKind::Natural => 22.53 / 16.065,
            AccidentalKind::DoubleSharp => 0.988 * 7.5 / 16.065,
            AccidentalKind::DoubleFlat => 1.75 * 7.5 / 16.065,
        }
    }
}

const SIZE_PER_INK: f64 = 30.0 / 16.065;
const BASE_ABOVE_INK_BOTTOM: f64 = 2.5 / 16.065;
const GAP_PER_INK: f64 = 2.3 / 16.065;

#[derive(Clone, Debug, PartialEq)]
pub struct AccidentalStyle {
    /// SMuFL 字体（只取族名，字号按数字定）
    pub music: Font,
    pub color: f64,
    /// 有元数据就按元数据量墨迹（TS `meta` 给没给）
    pub meta: bool,
    pub kind: AccidentalStyleKind,
    /// `csym` 样子的大小 × 这个（`accidental-scale`，缺省 1）
    pub scale: Option<f64>,
}

/// 升降号挂在哪个数字上：数字的字、笔位与基线，整体缩小的给 `scale`。
#[derive(Clone, Debug, PartialEq)]
pub struct DigitRef {
    pub font: Font,
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub scale: Option<f64>,
}

/// `classic` 按数字字形微调的横向字距（÷ 字号）。
fn classic_kern(c: Option<char>) -> f64 {
    match c {
        Some('4') => 0.1,
        Some('2') | Some('1') => -0.07,
        _ => 0.0,
    }
}

/// 一个临时记号，摆在数字左边。
#[derive(Clone, Debug, PartialEq)]
pub struct AccidentalGlyph {
    pub item: Node,
    /// 墨迹盒，调用方坐标
    pub box_: Rect,
}

impl AccidentalGlyph {
    pub fn new(kind: AccidentalKind, digit: &DigitRef, style: &AccidentalStyle, env: &Env) -> AccidentalGlyph {
        let sc = digit.scale.unwrap_or(1.0);
        let (mut t, ink);
        if style.kind == AccidentalStyleKind::Classic {
            let s = digit.font.size;
            let font = style.music.with_size(s * 0.8 * sc);
            let g = kind.classic_glyph();
            ink = music_ink(&g, &font, style.meta, env);
            t = music_text(&g, font, style.color);
            t.set_x(digit.x + (-0.2 + classic_kern(digit.text.chars().next())) * s * 0.8 * sc);
            let one_top = digit.font.char_bound(env.mc, "1").top;
            t.set_y(digit.y + (one_top + if kind.is_flat() { s * 0.1 } else { 0.0 }) * sc);
        } else {
            let d = digit.font.char_bound(env.mc, &digit.text);
            let left = digit.x + d.left * sc;
            let bottom = digit.y + d.bottom * sc;
            let h = d.height() * sc;
            let font = style.music.with_size(h * SIZE_PER_INK * style.scale.unwrap_or(1.0));
            let g = kind.csym_glyph();
            ink = music_ink(&g, &font, style.meta, env);
            t = music_text(&g, font, style.color);
            t.set_x(left - h * GAP_PER_INK - ink.right);
            t.set_y(bottom - h * BASE_ABOVE_INK_BOTTOM);
        }
        let box_ = ink.offset(t.x(), t.y());
        AccidentalGlyph { item: t, box_ }
    }
}

/// 升降号左缘与前一个音之间要多留的空 ÷ 数字墨迹高。
pub const ACCIDENTAL_CLEARANCE: f64 = 0.3;

/// 临时记号在数字墨迹左边占掉的宽（墨迹宽 + 与数字之间的空），`csym` 样子；纯算术。
pub fn accidental_lead(kind: AccidentalKind, digit_ink_height: f64, scale: f64) -> f64 {
    (kind.ink_width() * scale + GAP_PER_INK) * digit_ink_height
}

/// 临时记号的墨迹顶高出数字墨迹顶多少（≥ 0）；纯算术。
pub fn accidental_rise(kind: AccidentalKind, digit_ink_height: f64, scale: f64) -> f64 {
    dolce_model::base::js::max(0.0, (BASE_ABOVE_INK_BOTTOM + kind.ink_height() * scale - 1.0) * digit_ink_height)
}

/// 简谱记法里的升降号字符（`b` / `#` / `n`）→ 种类。
pub fn accidental_kind_of(alt: &str) -> Option<AccidentalKind> {
    match alt {
        "b" => Some(AccidentalKind::Flat),
        "#" => Some(AccidentalKind::Sharp),
        "n" => Some(AccidentalKind::Natural),
        _ => None,
    }
}
