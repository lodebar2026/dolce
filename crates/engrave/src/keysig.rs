//! 简谱调号「1=♭B」/ 曲中转调「转1=D」（`engrave/keysig.ts`）。画法照混排：「1=」是文字，升降号是 SMuFL 的 csym 小号字形、抬高；
//! 缺省写在音名**之前**，`accidental-side: after` 写在后。

use dolce_model::base::geom::Rect;
use crate::scene::Node;
use crate::text::Font;

use crate::glyph;
use crate::prims::music_text;
use crate::spacing::{AccidentalSide, EQ_PAD_EM};
use crate::Env;

/// 调名：字母 + 升降（-1 降、0 本位、1 升）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyName {
    pub letter: char,
    pub alter: i8,
}

/// 调号的五度数 → 调名（`MusicCommon.keys`）。
pub fn key_name_of_fifths(fifths: f64) -> KeyName {
    let s = dolce_model::play::jppitch::key_name(fifths).unwrap_or("C");
    key_name_of(s).unwrap_or(KeyName { letter: 'C', alter: 0 })
}

fn is_acc(c: char) -> bool {
    matches!(c, 'b' | '#' | '$' | '♭' | '♯')
}

/// 文字写法的调名（`bE` / `Eb` / `♭E` / `$E` / `#F` / `F`）→ 调名；认不出 None。`$` 是文本谱里降号的写法。
pub fn key_name_of(text: &str) -> Option<KeyName> {
    let cs: Vec<char> = dolce_model::base::js::trim(text).chars().collect();
    let (pre, letter, post) = match cs.as_slice() {
        [l] => (None, *l, None),
        [a, l] if is_acc(*a) && ('A'..='G').contains(l) => (Some(*a), *l, None),
        [l, a] => (None, *l, Some(*a)),
        [a, l, b] => (Some(*a), *l, Some(*b)),
        _ => return None,
    };
    if !('A'..='G').contains(&letter) || pre.is_some_and(|c| !is_acc(c)) || post.is_some_and(|c| !is_acc(c)) {
        return None;
    }
    if pre.is_some() && post.is_some() {
        return None;
    }
    let alter = match pre.or(post) {
        Some('b' | '$' | '♭') => -1,
        Some('#' | '♯') => 1,
        _ => 0,
    };
    Some(KeyName { letter, alter })
}

#[derive(Clone, Debug, PartialEq)]
pub struct KeyLabelStyle {
    /// 「1=」与音名的字
    pub font: Font,
    /// SMuFL 字体（只取族名；字号按 `font` 定）
    pub music: Font,
    pub color: f64,
    /// 前缀：曲中转调写「转」
    pub prefix: Option<String>,
    pub side: Option<AccidentalSide>,
    /// 每个图元都挂上的类名
    pub classes: Vec<String>,
    /// 「=」两侧各让的空 ÷ 字号，缺省 `EQ_PAD_EM`
    pub eq_pad: Option<f64>,
}

/// 升降号的取尺（÷ 字号），照混排实测。
const ACC_GAP_BEFORE: f64 = 7.0 / 30.0;
const ACC_ADVANCE: f64 = 12.0 / 30.0;
const ACC_RAISE: f64 = 10.0 / 30.0;
const ACC_GAP_AFTER: f64 = 2.0 / 30.0;

/// 一个调号标签。图元相对自身原点：x 从 0 起，y = 0 是文字基线。
#[derive(Clone, Debug, PartialEq)]
pub struct KeyLabel {
    pub items: Vec<Node>,
    pub width: f64,
    /// 「=」墨迹右缘、「=」之后第一笔墨迹左缘、整串墨迹右缘（本地 x）
    pub eq_ink_right: f64,
    pub name_ink_left: f64,
    pub ink_right: f64,
    bbox: Rect,
}

impl KeyLabel {
    pub fn new(tonic: &str, name: &KeyName, style: &KeyLabelStyle, env: &Env) -> KeyLabel {
        let font = &style.font;
        let color = style.color;
        let pad = style.eq_pad.unwrap_or(EQ_PAD_EM) * font.size;
        let mut x = 0.0;
        let fm = font.metrics(env.mc);
        let mut bx = Rect::default();
        let mut items = Vec::new();
        let put = |text: &str, x: &mut f64, items: &mut Vec<Node>, bx: &mut Rect| -> Rect {
            let mut tf = Node::text(text, font.clone());
            tf.text_mut().color = color;
            tf.set_x(*x);
            for c in &style.classes {
                tf.add_class(c);
            }
            let w = tf.text_ref().unwrap().measure(env.mc);
            items.push(tf);
            // 一般文字按**字体盒**（笔位 + advance、基线 ± ascent/descent）
            *bx = bx.union(&Rect::new(*x, fm.ascent, *x + w, fm.descent));
            let ink = font.char_bound(env.mc, text).offset(*x, 0.0);
            *x += w;
            ink
        };
        put(&format!("{}{tonic}", style.prefix.as_deref().unwrap_or("")), &mut x, &mut items, &mut bx);
        x += pad;
        let eq_ink_right = put("=", &mut x, &mut items, &mut bx).right;
        x += pad;
        let put_acc = |x: &mut f64, items: &mut Vec<Node>, bx: &mut Rect| -> Rect {
            let g = glyph(if name.alter < 0 { "csymAccidentalFlat" } else { "csymAccidentalSharp" });
            let mf = style.music.with_size(font.size);
            let mut tf = music_text(&g, mf.clone(), color);
            tf.set_x(*x);
            tf.set_y(-ACC_RAISE * font.size);
            for c in &style.classes {
                tf.add_class(c);
            }
            let ty = tf.y();
            items.push(tf);
            // SMuFL 字形按**墨迹盒**
            let ink = mf.char_bound(env.mc, &g).offset(*x, ty);
            *bx = bx.union(&ink);
            *x += ACC_ADVANCE * font.size;
            ink
        };
        let letter = name.letter.to_string();
        let (first_ink, last_ink);
        if name.alter != 0 && style.side != Some(AccidentalSide::After) {
            x += ACC_GAP_BEFORE * font.size;
            first_ink = put_acc(&mut x, &mut items, &mut bx).left;
            last_ink = put(&letter, &mut x, &mut items, &mut bx).right;
        } else {
            let li = put(&letter, &mut x, &mut items, &mut bx);
            first_ink = li.left;
            let mut last = li.right;
            if name.alter != 0 {
                x += ACC_GAP_AFTER * font.size;
                last = put_acc(&mut x, &mut items, &mut bx).right;
            }
            last_ink = last;
        }
        KeyLabel { items, width: x, eq_ink_right, name_ink_left: first_ink, ink_right: last_ink, bbox: bx }
    }

    /// 占位盒：文字部分按字体盒、升降号按 SMuFL 墨迹，本地坐标。
    pub fn box_(&self) -> Rect {
        self.bbox
    }
}
