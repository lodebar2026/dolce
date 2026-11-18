//! 混排渲染的落笔小工具（线、SMuFL 字形、平移组）（照 `prims.ts`）。五线谱层（`render`）与简谱叠层（`overlay`）共用。

use dolce_engrave::prims::{line_item, text_item};
use dolce_base::geom::Matrix33;
use dolce_scene::build::Env;
use dolce_scene::{ElementId, Identity, IdentityKind, Node};
use dolce_text::Font;

/// 一个和弦画出来的那一组的类名（`.selected` 描蓝挂在它上面）。身份走标签（`note` + 元素 id）。
pub const STAFF_CHORD: &str = "staff-chord";
/// 一行系统的组的类名。身份标签 `system`；`data` 是谱表带（混排连同简谱层）的上下沿 `top/bottom`，系统坐标（tenths）。
pub const STAFF_SYSTEM: &str = "staff-system";

const BLACK: f64 = 0xff000000u32 as f64;

/// 和弦 `id` 的组（见 [`STAFF_CHORD`]）。
pub fn chord_group(id: ElementId) -> Node {
    let mut g = Node::group();
    g.add_class(STAFF_CHORD);
    g.id = Some(Identity { kind: IdentityKind::Note, id: Some(id), pass: None, verse: None, edge: None, measure: None, also: None, end: None });
    g
}

/// 加一条线，返回它在 `g` 子节点里的下标（TS 返回对象引用）。
pub fn add_line(g: &mut Node, x1: f64, y1: f64, x2: f64, y2: f64, lw: f64) -> usize {
    g.push(line_item(x1, y1, x2, y2, lw, BLACK));
    g.k.len() - 1
}

/// SMuFL glyph via TextFrame with Bravura family.
pub fn add_smufl(g: &mut Node, glyph: &str, x: f64, y: f64, size: f64, env: &Env) {
    g.push(text_item(glyph, Font::new("Bravura", size), BLACK, x, y, false, env));
}

/// SMuFL glyph with scale transform.
#[allow(clippy::too_many_arguments)]
pub fn add_smufl_scaled(g: &mut Node, glyph: &str, x: f64, y: f64, size: f64, scx: f64, scy: f64, env: &Env) {
    let mut grp = Node::group();
    grp.m = Matrix33::from_affine([scx, 0.0, 0.0, scy, x, y]);
    add_smufl(&mut grp, glyph, 0.0, 0.0, size, env);
    g.push(grp);
}

pub fn translated(x: f64, y: f64) -> Node {
    let mut g = Node::group();
    g.m = Matrix33::from_affine([1.0, 0.0, 0.0, 1.0, x, y]);
    g
}
