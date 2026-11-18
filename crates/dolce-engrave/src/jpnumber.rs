//! 简谱数字与挂在数字上的图元（`engrave/jpnumber.ts`）：数字 `JpNumber`、八度点 / 附点 `JpOctaveDot`、减时线 `BeamLine`。
//! 在场景里是带角色的叶子；TS 记的「附点挂在哪个数字上」「减时线两端接哪两个数字」只给 PPTX 用，到导出期（L7）再定怎么带。

use dolce_geom::{Point, Rect};
use dolce_scene::{Node, Role};
use dolce_text::Font;

use crate::dot::jp_dot;
use crate::Env;

/// 八度点：一个实心矢量圆，局部盒恒为 (0,0)–(2r,2r)；`update` / `bound` 按解析式给。
pub fn jp_octave_dot(r: f64, color: f64) -> Node {
    let mut n = Node::path();
    let segs = jp_dot(r, r, r, color).path_ref().unwrap().segs.clone();
    let p = n.path_mut();
    p.segs = segs;
    p.fill = true;
    p.stroke = false;
    p.fill_color = color;
    n.sel = true;
    n.role = Some(Role::JpOctaveDot { radius: r, aug: None });
    n.w = 2.0 * r;
    n.h = 2.0 * r;
    n
}

/// 简谱数字（`new JpNumber()` 再设字与字体；颜色缺省黑）。
pub fn jp_number(text: &str, font: Font) -> Node {
    let mut n = Node::text(text, font);
    n.sel = true;
    n.role = Some(Role::JpNumber { aug_dot_advance: 0.0, cx: 0.0 });
    n
}

/// 减时线：第 `level` 层（1 起），从 `x0` 到 `x1`、中线在 `y`。
pub fn beam_line(level: f64, x0: f64, x1: f64, y: f64, width: f64, color: f64) -> Node {
    let mut n = Node::line();
    n.sel = true;
    n.role = Some(Role::BeamLine { level, ends: None });
    n.set_x(x0);
    let l = n.line_mut();
    l.p0 = Point::new(0.0, y);
    l.p1 = Point::new(x1 - x0, y);
    l.stroke_width = width;
    l.stroke_color = color;
    n
}

/// UTF-16 下标的子串（TS `substring`；落在代理对中间时按整字算）。
fn substring16(s: &str, beg: usize, end: Option<usize>) -> &str {
    let mut at = 0usize;
    let (mut b, mut e) = (s.len(), s.len());
    for (i, c) in s.char_indices() {
        if at >= beg && b == s.len() {
            b = i;
        }
        if let Some(end) = end {
            if at >= end {
                e = i;
                break;
            }
        }
        at += c.len_utf16();
    }
    if b > e {
        return "";
    }
    &s[b..e]
}

fn measure16(n: &Node, env: &Env, beg: usize, len: Option<usize>) -> f64 {
    let t = n.text_ref().expect("数字是文字节点");
    t.font.measure_text(env.mc, substring16(&t.text, beg, len.map(|l| beg + l)))
}

fn aug_adv(n: &Node) -> f64 {
    match n.role {
        Some(Role::JpNumber { aug_dot_advance, .. }) => aug_dot_advance,
        _ => 0.0,
    }
}

/// `JpNumber.left`：首字半个 advance。
pub fn jp_number_left(n: &Node, env: &Env) -> f64 {
    measure16(n, env, 0, Some(1)) / 2.0
}

/// `JpNumber.right`。
pub fn jp_number_right(n: &Node, env: &Env) -> f64 {
    measure16(n, env, 0, Some(1)) / 2.0 + measure16(n, env, 1, None) + aug_adv(n)
}

/// `JpNumber.cx`：首字**墨迹**中心（八度点、弧端、连音括线按它居中）。
pub fn jp_number_cx(n: &Node, env: &Env) -> f64 {
    let t = n.text_ref().expect("数字是文字节点");
    let first: String = t.text.chars().take(1).collect();
    t.font.ink_center(env.mc, &first)
}

/// `JpNumber.numberPos`：去掉尾附点字符后的 advance。
pub fn jp_number_pos(n: &Node, env: &Env) -> f64 {
    let t = n.text_ref().expect("数字是文字节点");
    let mut end = t.text.encode_utf16().count();
    if t.text.ends_with('·') {
        end -= 1;
    }
    measure16(n, env, 0, Some(end))
}

/// 数字墨迹盒（`JpNumber.bound` 的上下沿 + 宽）。
pub fn jp_number_bound(n: &Node, env: &Env) -> Rect {
    dolce_scene::build::bound(n, env).unwrap_or_default()
}

/// 给整棵树里的数字记上 `cx`（场景角色里带着，导出 PPTX 用；排版本身随用随量）。排完、`update` 之后调。
pub fn fill_number_cx(n: &mut Node, env: &Env) {
    if matches!(n.role, Some(Role::JpNumber { .. })) {
        let v = jp_number_cx(n, env);
        if let Some(Role::JpNumber { cx, .. }) = &mut n.role {
            *cx = v;
        }
    }
    for k in &mut n.k {
        fill_number_cx(k, env);
    }
}
