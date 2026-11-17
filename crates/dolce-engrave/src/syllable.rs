//! 歌词音节的量宽与落笔（`engrave/syllable.ts`）：前标点 / 主体 / 后标点三段、**按主体居中**；量宽与笔位同一串挤压坐标。
//! 量宽本身在 `dolce_text::syllable`（场景层歌词节点的 `update` 也用它）。

use dolce_scene::{Node, Role};
use dolce_text::{CompressMode, Font};

pub use dolce_text::syllable::{lyric_edge_punct, syllable_run, SyllableRun};

use crate::Env;

fn is_latin(c: char) -> bool {
    c.is_ascii_alphabetic() || ('\u{C0}'..='\u{24F}').contains(&c)
}

/// 相邻两个音节之间要不要补一个西文词间空格：交界任一侧是西文就补；前一个以 `-` 收尾的不补。
pub fn latin_word_break(prev: &str, next: &str) -> bool {
    if prev.is_empty() || next.is_empty() || prev.ends_with('-') {
        return false;
    }
    if next.chars().next().is_some_and(is_latin) {
        return true;
    }
    // /[A-Za-zÀ-ɏ0-9][,.;:!?'")]*$/
    let body = prev.trim_end_matches([',', '.', ';', ':', '!', '?', '\'', '"', ')']);
    body.chars().last().is_some_and(|c| is_latin(c) || c.is_ascii_digit())
}

/// 歌词一条（`new Lyric()` 再设字、字体、挤压档、段号），调用方再 `update`。
pub fn lyric(text: &str, font: Font, compress: CompressMode, verse: f64) -> Node {
    let mut n = Node::text(text, font);
    n.sel = true;
    n.add_class("lyric");
    n.role = Some(Role::Lyric { widths: [0.0; 3], compress: compress.as_str().to_string(), verse });
    n
}

fn widths(n: &Node) -> [f64; 3] {
    match &n.role {
        Some(Role::Lyric { widths, .. }) => *widths,
        _ => [0.0; 3],
    }
}

/// 开头那串标点的宽度。
pub fn lyric_lead_width(n: &Node) -> f64 {
    widths(n)[0]
}
pub fn lyric_left(n: &Node) -> f64 {
    let w = widths(n);
    w[0] + w[1] / 2.0
}
pub fn lyric_right(n: &Node) -> f64 {
    let w = widths(n);
    w[1] / 2.0 + w[2]
}

/// 末字右侧的留白（advance 减墨迹），按挤压后的笔位算。
pub fn lyric_tail_blank(n: &Node, env: &Env) -> f64 {
    let t = n.text_ref().expect("歌词是文字节点");
    let Some(last) = t.text.chars().last() else { return 0.0 };
    let count = t.text.chars().count();
    let upto = match &t.char_xs {
        Some(xs) => xs.get(count - 1).copied().unwrap_or(f64::NAN),
        None => t.font.measure_text(env.mc, &t.text[..t.text.len() - last.len_utf8()]),
    };
    let lb = t.font.char_bound(env.mc, last.encode_utf8(&mut [0; 4]));
    dolce_base::js::max(0.0, n.w - (upto + lb.right))
}

/// 首字左侧的留白，从挤压后的笔位起算。
pub fn lyric_head_blank(n: &Node, env: &Env) -> f64 {
    let t = n.text_ref().expect("歌词是文字节点");
    let Some(first) = t.text.chars().next() else { return 0.0 };
    let pen = t.char_xs.as_ref().and_then(|x| x.first().copied()).unwrap_or(0.0);
    dolce_base::js::max(0.0, pen + t.font.char_bound(env.mc, first.encode_utf8(&mut [0; 4])).left)
}
