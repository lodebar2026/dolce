//! 房号括线（volta）的**画法**（`engrave/ending.ts`）：横线 + 可选的两侧竖脚 + 房号。位置各引擎各算。

use dolce_scene::Node;
use dolce_text::Font;

use crate::Env;

/// 房号墨迹顶与横线下沿之间的空，按房号字号计。
const LABEL_GAP: f64 = 0.3;

#[derive(Clone, Debug, PartialEq)]
pub struct EndingLabel {
    pub text: String,
    pub font: Font,
    pub dx: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EndingBracket {
    pub x0: f64,
    pub x1: f64,
    /// 横线的 y；竖脚从这里往下 `drop`
    pub top: f64,
    pub drop: f64,
    pub left_foot: bool,
    pub right_foot: bool,
    pub line_width: f64,
    pub color: f64,
    pub label: Option<EndingLabel>,
    /// 给下游认的类名（线, 房号）
    pub classes: Option<(String, String)>,
}

/// 房号基线相对横线（线心）的下移量：半个线宽 + 一道空 + 房号**墨迹**的上伸高度。
pub fn label_baseline(font: &Font, text: &str, line_width: f64, env: &Env) -> f64 {
    label_baseline_of(font.char_bound(env.mc, text).top, font.size, line_width)
}

/// 同上，墨迹顶由调用方量好。
pub fn label_baseline_of(ink_top: f64, size: f64, line_width: f64) -> f64 {
    line_width / 2.0 + size * LABEL_GAP - dolce_base::js::min(0.0, ink_top)
}

/// 竖脚长：给了实测短脚就用它，否则与房号字号等长。
pub fn ending_drop(bracket_foot: f64, size: f64) -> f64 {
    if bracket_foot > 0.0 {
        bracket_foot
    } else {
        size
    }
}

/// 房号离左脚的横向距离。
pub fn ending_label_dx(line_width: f64, size: f64, bracket_foot: f64) -> f64 {
    line_width + size * if bracket_foot > 0.0 { 0.28 } else { 0.4 }
}

/// 房号原文规整：只由数字与分隔（逗号 / 顿号 / 中点 / 空格 / 句点）组成时，数字之间统一用半角句点，尾点照原文；
/// 含别的字原样返回。
pub fn norm_ending_text(text: &str) -> String {
    let ok = |c: char| c.is_ascii_digit() || dolce_base::js::is_space(c) || matches!(c, '.' | ',' | '，' | '、' | '·');
    if text.is_empty() || !text.chars().all(ok) || !text.chars().any(|c| c.is_ascii_digit()) {
        return text.to_string();
    }
    let t = dolce_base::js::trim(text);
    let mut groups: Vec<String> = Vec::new();
    let mut cur = String::new();
    for c in t.chars() {
        if c.is_ascii_digit() {
            cur.push(c);
        } else if !cur.is_empty() {
            groups.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        groups.push(cur);
    }
    groups.join(".") + if t.ends_with('.') { "." } else { "" }
}

/// 画进 `g`，返回房号那个文字节点在 `g.k` 里的下标（没有房号时为 None）。
pub fn add_ending_bracket(g: &mut Node, b: &EndingBracket, env: &Env) -> Option<usize> {
    let mut path = Node::path();
    if let Some((line, _)) = &b.classes {
        path.add_class(line);
    }
    let p = path.path_mut();
    p.stroke = true;
    p.fill = false;
    p.stroke_color = b.color;
    p.stroke_width = b.line_width;
    if b.left_foot {
        p.move_to(b.x0, b.top + b.drop);
        p.line_to(b.x0, b.top);
    } else {
        p.move_to(b.x0, b.top);
    }
    p.line_to(b.x1, b.top);
    if b.right_foot {
        p.line_to(b.x1, b.top + b.drop);
    }
    g.push(path);
    let label = b.label.as_ref()?;
    let mut tf = Node::text(label.text.clone(), label.font.clone());
    if let Some((_, lc)) = &b.classes {
        tf.add_class(lc);
    }
    tf.text_mut().color = b.color;
    tf.set_x(b.x0 + label.dx);
    tf.set_y(b.top + label_baseline(&label.font, &label.text, b.line_width, env));
    g.push(tf);
    Some(g.k.len() - 1)
}
