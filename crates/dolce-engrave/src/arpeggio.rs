//! 琶音（`engrave/arpeggio.ts`）：竖着的波浪线，`wiggleTrillSlow` 一段段横着拼、整串转 90°。

use dolce_geom::Matrix33;
use dolce_scene::Node;
use dolce_text::Font;

use crate::glyph;
use crate::prims::text_item;
use crate::Env;

/// 简谱：乐谱字体字号取数字墨迹高的 1.2 倍；线在临时记号 / 数字左边再空这么多（÷ 墨迹高）。
pub const JP_ARPEGGIO_SIZE: f64 = 1.2;
pub const JP_ARPEGGIO_LEAD: f64 = 0.6;

/// 琶音线从 `top` 画到 `bottom`，x 是线的位置；`size` 乐谱字体字号；颜色缺省黑。
pub fn arpeggio_group(x: f64, top: f64, bottom: f64, size: f64, color: f64, env: &Env) -> Node {
    let seg = (size / 4.0) * 1.2;
    let cnt = dolce_base::js::max(1.0, ((bottom - top) / seg).ceil());
    let s = glyph("wiggleTrillSlow").repeat(cnt as usize);
    let mut t = text_item(&s, Font::new("Bravura", size), color, 0.0, 0.0, false, env);
    t.add_class("arpeggio");
    // 旋转直接放在字形这一片叶子上：translate(x, top) ∘ rotate(90°)
    t.m = Matrix33::from_affine([0.0, 1.0, -1.0, 0.0, x, top]);
    t
}
