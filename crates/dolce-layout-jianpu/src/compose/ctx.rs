//! 一次排版的绘制上下文与几样共用的小画法（照 `compose/ctx.ts`）。
//!
//! TS 的上方带按元素对象分组（`bandOf`）、画的时候按元素查；这里按「哪一串 items + 第几个」查：
//! [`Ctx::band`] 记着当前那份带来自哪串 items（`items.as_ptr()` 当记号），查的人报上自己那串的记号与下标，
//! 对不上就查不到——TS 里拿别的声部的元素去查当前声部的带也是查不到（多声部贯穿小节线那一处就是这样）。

use std::collections::HashMap;

use dolce_engrave::dot::jp_dot;
use dolce_engrave::jpnumber::{jp_number, jp_octave_dot};
use dolce_engrave::prims::{fill_rect, stroke_path, text_item};
use dolce_engrave::Env;
use dolce_geom::Rect;
use dolce_scene::{Identity, IdentityKind, Node};
use dolce_style::ss::Region;
use dolce_text::Font;

use crate::grid::JianpuGrid;
use crate::model::{PlacedScore, PlacedText};
use crate::place::header::PlacedHeader;
use crate::view::LDoc;

/// 一串 items 的记号（上方带按它认是不是同一串）
pub type ItemsKey = usize;

pub fn items_key<T>(items: &[T]) -> ItemsKey {
    items.as_ptr() as usize
}

/// 一次原样文档排版的上下文（TS `OriginalCtx`）
pub struct Ctx<'a> {
    pub m: &'a JianpuGrid,
    pub env: &'a Env<'a>,
    pub doc: &'a LDoc,
    pub placed: &'a PlacedScore,
    pub digit_font: Font,
    /// 正在画的这一行的上方带（按挂在第几个符号上分好）与它来自哪串 items
    pub band: Option<(ItemsKey, HashMap<usize, Vec<PlacedText>>)>,
    pub band_origin: (f64, f64),
    pub page_width: f64,
    pub page_height: f64,
    /// 连续长图裁紧后整页平移多少
    pub page_shift_x: f64,
    pub ink: f64,
    pub lyric_ink: f64,
    /// 投影档 / 成书
    pub slide: bool,
    /// 投影档：正在画的符号所在那一遍的遍号
    pub pass: Option<f64>,
    pub heads: &'a [PlacedHeader],
    pub foot: Option<&'a Region>,
}

/// `bandOf`：按挂在第几个符号上分组（组内保持原序）
pub fn band_of(band: &[PlacedText]) -> HashMap<usize, Vec<PlacedText>> {
    let mut out: HashMap<usize, Vec<PlacedText>> = HashMap::new();
    for t in band {
        out.entry(t.at).or_default().push(t.clone());
    }
    out
}

pub fn font(family: &str, size: f64, bold: bool) -> Font {
    Font { family: family.to_string(), size, bold, italic: false }
}

/// 身份标签（只给种类，其余空）
pub fn ident(kind: IdentityKind) -> Identity {
    Identity { kind, id: None, pass: None, verse: None, edge: None, measure: None, also: None, end: None }
}

pub fn eid(id: i64) -> u32 {
    id as u32
}

/// 实心圆（`jpDot`）
pub fn dot(color: f64, cx: f64, cy: f64, r: f64) -> Node {
    jp_dot(cx, cy, r, color)
}

pub fn rect(color: f64, x: f64, y: f64, w: f64, h: f64) -> Node {
    fill_rect(color, x, y, w, h)
}

pub fn stroke(color: f64, width: f64) -> Node {
    stroke_path(color, width)
}

/// 一个音节一个 `<text>`，挤压在这里就压掉了（`textItem(…, true)`）
pub fn text(s: &str, x: f64, y: f64, f: Font, color: f64, env: &Env) -> Node {
    text_item(s, f, color, x, y, true, env)
}

/// 音符数字（`JpNumber`）
pub fn digit_item(ch: &str, x: f64, y: f64, f: Font, color: f64) -> Node {
    let mut t = jp_number(ch, f);
    t.text_mut().color = color;
    t.set_x(x);
    t.set_y(y);
    t
}

/// 八度点 / 附点：圆心 (cx, cy)、半径 r
pub fn octave_dot(color: f64, cx: f64, cy: f64, r: f64) -> Node {
    let mut d = jp_octave_dot(r, color);
    d.set_x(cx - r);
    d.set_y(cy - r);
    d
}

/// 数字按墨迹居中于锚点：落笔偏移与墨迹盒
pub fn digit_origin(c: &Ctx, ch: &str) -> (f64, f64, Rect) {
    let b = c.digit_font.char_bound(c.env.mc, ch);
    let v = if c.slide { c.digit_font.char_bound(c.env.mc, "1") } else { b };
    (-(b.left + b.right) / 2.0, -(v.top + v.bottom) / 2.0, b)
}

/// `addBarlineOwner`
pub fn add_barline_owner(item: &mut Node, id: i64, edge: dolce_scene::Edge) {
    let id = eid(id);
    match &mut item.id {
        Some(cur) if cur.kind == IdentityKind::Barline && cur.id.is_some() => {
            if cur.id == Some(id) {
                return;
            }
            let also = cur.also.get_or_insert_with(Vec::new);
            if !also.contains(&id) {
                also.push(id);
            }
        }
        _ => {
            item.id = Some(Identity { id: Some(id), edge: Some(edge), ..ident(IdentityKind::Barline) });
        }
    }
}
