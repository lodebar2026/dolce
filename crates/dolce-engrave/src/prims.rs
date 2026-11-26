//! 落笔小件（`engrave/prims.ts`）：文字、直线、填充矩形、描边路径、SMuFL 字形文字与它的墨迹盒。

use dolce_model::base::geom::{Point, Rect};
use dolce_scene::Node;
use dolce_text::{CompressMode, Font};

use crate::Env;

/// 一串 SMuFL 字形，挂类名 `smufl`；盒按**墨迹**（`inkBound`）。
pub fn music_text(glyphs: &str, font: Font, color: f64) -> Node {
    let mut n = Node::text(glyphs, font);
    let t = n.text_mut();
    t.color = color;
    t.ink_bound = true;
    n.add_class("smufl");
    n
}

/// 一串 SMuFL 字形的**墨迹盒**（相对笔位、基线，y 向下）。`use_meta` 且每个字形都查得到就按元数据
/// （`字号 = 4 个 staff space`），否则退回量的墨迹（`Font.charBound`）。不用字体盒。
pub fn music_ink(glyphs: &str, font: &Font, use_meta: bool, env: &Env) -> Rect {
    if let Some(meta) = env.meta.filter(|_| use_meta) {
        let boxes: Option<Vec<_>> = glyphs.chars().map(|g| meta.bbox(g).ok().flatten().copied()).collect();
        if let Some(boxes) = boxes {
            let sp = font.size / 4.0;
            let mut x = 0.0;
            let mut r = Rect::default();
            for (g, b) in glyphs.chars().zip(boxes) {
                r = r.union(&Rect::new(x + b.sw[0] * sp, -b.ne[1] * sp, x + b.ne[0] * sp, -b.sw[1] * sp));
                x += font.measure_text(env.mc, g.encode_utf8(&mut [0; 4]));
            }
            return r;
        }
    }
    font.char_bound(env.mc, glyphs)
}

/// 一段文字，笔位 (x, y)（y 是基线）。`compress`：多字时把挤压后的逐字笔位写进 `charXs`（CLREQ）。
pub fn text_item(s: &str, font: Font, color: f64, x: f64, y: f64, compress: bool, env: &Env) -> Node {
    let xs = (compress && s.chars().count() > 1).then(|| font.run(env.mc, s, CompressMode::Clreq).xs);
    let mut n = Node::text(s, font);
    let t = n.text_mut();
    t.color = color;
    t.char_xs = xs;
    n.set_x(x);
    n.set_y(y);
    n
}

/// 一条直线。
pub fn line_item(x1: f64, y1: f64, x2: f64, y2: f64, line_width: f64, color: f64) -> Node {
    let mut n = Node::line();
    let l = n.line_mut();
    l.p0 = Point::new(x1, y1);
    l.p1 = Point::new(x2, y2);
    l.stroke_color = color;
    l.stroke_width = line_width;
    n
}

/// 填充矩形（左上角 x, y）。
pub fn fill_rect(color: f64, x: f64, y: f64, w: f64, h: f64) -> Node {
    let mut n = Node::path();
    let p = n.path_mut();
    p.move_to(x, y);
    p.line_to(x + w, y);
    p.line_to(x + w, y + h);
    p.line_to(x, y + h);
    p.close();
    p.fill = true;
    p.fill_color = color;
    n
}

/// 空的描边路径，调用方自己 moveTo / lineTo。
pub fn stroke_path(color: f64, width: f64) -> Node {
    let mut n = Node::path();
    let p = n.path_mut();
    p.stroke = true;
    p.stroke_color = color;
    p.stroke_width = width;
    n
}
