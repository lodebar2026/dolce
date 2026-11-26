//! 分数式简谱拍号（`engrave/timesig.ts`）。一切长度都是小节线高 H 的比例；两个数字各离分数线一格（墨迹到墨迹）。

use dolce_model::base::geom::{Point, Rect};
use crate::scene::Node;
use crate::text::Font;

use crate::Env;

#[derive(Clone, Debug, PartialEq)]
pub struct TimeSigStyle {
    /// 小节线高 H
    pub height: f64,
    /// 分数线的 y（相对基线）
    pub center_y: f64,
    pub rule_width: f64,
    pub color: f64,
    /// 数字字体（字号由 `digit_ratio × H` 定）
    pub font: Font,
    pub digit_ratio: Option<f64>,
    /// 分数线长度 ÷ H，按每一位数字算
    pub rule_length_ratio: Option<f64>,
}

/// 数字墨迹与分数线墨迹之间的净距 ÷ 拍值字号。
pub const TIME_SIG_GAP_EM: f64 = 1.0 / 9.0;
pub const TIME_SIG_DIGIT_RATIO: f64 = 0.5625;
pub const TIME_SIG_RULE_LENGTH_RATIO: f64 = 0.28125;

fn digits(n: f64) -> usize {
    dolce_model::base::js::num_to_string(n).encode_utf16().count()
}

/// 拍号占的宽（即分数线长）：只由 H 与位数定。
pub fn time_sig_width(beats: f64, beat_type: f64, h: f64, digit_ratio: Option<f64>, rule_length_ratio: Option<f64>) -> f64 {
    let d = digits(beats).max(digits(beat_type)) as f64;
    d * match rule_length_ratio {
        Some(r) => h * r,
        None => h * digit_ratio.unwrap_or(TIME_SIG_DIGIT_RATIO) * 0.5,
    }
}

/// 分数式拍号：图元相对自身原点，x 从 0 起，宽度即分数线长度。`items` = [分子, 分母, 分数线]。
#[derive(Clone, Debug, PartialEq)]
pub struct TimeSigGlyph {
    pub items: Vec<Node>,
    pub width: f64,
    ink: Rect,
}

impl TimeSigGlyph {
    pub fn new(beats: f64, beat_type: f64, style: &TimeSigStyle, env: &Env) -> TimeSigGlyph {
        let h = style.height;
        let font = style.font.with_size(h * style.digit_ratio.unwrap_or(TIME_SIG_DIGIT_RATIO));
        let y = style.center_y - style.rule_width / 2.0;
        let mk = |s: String| -> (Node, f64, Rect) {
            let mut tf = Node::text(s.clone(), font.clone());
            tf.text_mut().color = style.color;
            let w = tf.text_ref().unwrap().measure(env.mc);
            (tf, w, font.char_bound(env.mc, &s))
        };
        let (mut up, up_w, up_ink) = mk(dolce_model::base::js::num_to_string(beats));
        let (mut lo, lo_w, lo_ink) = mk(dolce_model::base::js::num_to_string(beat_type));
        let width = time_sig_width(beats, beat_type, h, style.digit_ratio, style.rule_length_ratio);
        let gap = font.size * TIME_SIG_GAP_EM;
        up.set_y(y - style.rule_width / 2.0 - gap - up_ink.bottom);
        up.set_x((width - up_w) / 2.0);
        lo.set_y(y + style.rule_width / 2.0 + gap - lo_ink.top);
        lo.set_x((width - lo_w) / 2.0);
        let mut rule = Node::line();
        let l = rule.line_mut();
        l.stroke_width = style.rule_width;
        l.stroke_color = style.color;
        l.p0 = Point::new(0.0, y);
        l.p1 = Point::new(width, y);
        let ink = up_ink
            .offset(up.x(), up.y())
            .union(&lo_ink.offset(lo.x(), lo.y()))
            .union(&Rect::new(0.0, y - style.rule_width / 2.0, width, y + style.rule_width / 2.0));
        TimeSigGlyph { items: vec![up, lo, rule], width, ink }
    }

    /// 分数线（`items[2]`）
    pub fn rule(&self) -> &Node {
        &self.items[2]
    }

    /// 墨迹盒（本地坐标）
    pub fn box_(&self) -> Rect {
        self.ink
    }
}
