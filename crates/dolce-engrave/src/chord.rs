//! 和弦符号的富文本分段与绘制（`engrave/chord.ts`）：SMuFL 和弦（缺省）与简单文本两种风格。
//! 根音升降号用 csym 小号字形、后缀上标、`m` 留在基线、低音 `/G` 跟在后面。

use dolce_base::geom::{Matrix33, Rect};
use dolce_model::harmony::chord_step_alter;
use dolce_scene::{IdentityKind, Node};
use dolce_text::Font;

use crate::glyph;
use crate::spacing::AccidentalSide;
use crate::Env;

/// 和弦符号的一段：文字或 SMuFL 字形，可上标（1）/ 下标（-1）。
#[derive(Clone, Debug, PartialEq)]
pub struct HarmonySeg {
    pub text: String,
    pub music: bool,
    pub superscript: i8,
    pub dy: f64,
    /// 就地缩放（不上标、基线不动）
    pub scale: Option<f64>,
}

impl HarmonySeg {
    fn plain(text: impl Into<String>, music: bool, superscript: i8) -> HarmonySeg {
        HarmonySeg { text: text.into(), music, superscript, dy: 0.0, scale: None }
    }
}

/// 一段的缩放：上 / 下标 0.75，否则就地缩放 `scale`（缺省 1）。
fn seg_scale(s: &HarmonySeg) -> f64 {
    if s.superscript == 1 || s.superscript == -1 {
        0.75
    } else {
        s.scale.unwrap_or(1.0)
    }
}

fn seg_dy(s: &HarmonySeg, scl: f64, size: f64) -> f64 {
    if scl != 1.0 {
        match s.superscript {
            1 => -size / 4.0,
            -1 => size / 4.0,
            _ => 0.0,
        }
    } else {
        s.dy
    }
}

/// 分段总宽：各段 advance × 各自缩放。
pub fn harmony_width(segs: &[HarmonySeg], word_font: &Font, music_font: &Font, env: &Env) -> f64 {
    let mut w = 0.0;
    for s in segs {
        w += if s.music { music_font } else { word_font }.measure_text(env.mc, &s.text) * seg_scale(s);
    }
    w
}

/// 分段的墨迹盒（原点在左侧基线）。空串返回 None。
pub fn harmony_ink(segs: &[HarmonySeg], word_font: &Font, music_font: &Font, env: &Env) -> Option<Rect> {
    let mut ink: Option<Rect> = None;
    let mut xpos = 0.0;
    for s in segs {
        let font = if s.music { music_font } else { word_font };
        let scl = seg_scale(s);
        let dy = seg_dy(s, scl, font.size);
        if !dolce_base::js::trim(&s.text).is_empty() {
            let b = font.char_bound(env.mc, &s.text);
            let r = Rect::new(xpos + b.left * scl, dy + b.top * scl, xpos + b.right * scl, dy + b.bottom * scl);
            use dolce_base::js::{max, min};
            ink = Some(match ink {
                Some(i) => Rect::new(min(i.left, r.left), min(i.top, r.top), max(i.right, r.right), max(i.bottom, r.bottom)),
                None => r,
            });
        }
        xpos += font.measure_text(env.mc, &s.text) * scl;
    }
    ink
}

/// 把分段排成一个组（原点在左侧基线）。上标缩到 75% 并上移 1/4 字号。
pub fn layout_harmony_segs(segs: &[HarmonySeg], word_font: &Font, music_font: &Font, color: f64, env: &Env) -> Node {
    let mut grp = Node::group();
    grp.add_class("chord");
    grp.id = Some(dolce_scene::Identity { kind: IdentityKind::Harmony, id: None, pass: None, verse: None, edge: None, measure: None, also: None, end: None });
    let mut xpos = 0.0;
    for s in segs {
        let font = if s.music { music_font } else { word_font };
        let mut t = Node::text(s.text.clone(), font.clone());
        t.add_class(if s.music { "chord-music" } else { "chord" });
        let ts = t.text_mut();
        ts.ink_bound = s.music;
        ts.color = color;
        let scl = seg_scale(s);
        if scl != 1.0 {
            let dy = seg_dy(s, scl, font.size);
            let mut g = Node::group();
            g.m = Matrix33::from_affine([scl, 0.0, 0.0, scl, xpos, dy]);
            g.push(t);
            grp.push(g);
        } else {
            t.set_x(xpos);
            t.set_y(s.dy);
            grp.push(t);
        }
        xpos += font.measure_text(env.mc, &s.text) * scl;
    }
    grp
}

/// 纯文本风格里升降号相对字母的字号比例。
const PLAIN_ACCIDENTAL_SCALE: f64 = 0.6;

fn is_sharp(c: &str) -> bool {
    !c.is_empty() && "#♯".contains(c)
}
fn is_flat(c: &str) -> bool {
    !c.is_empty() && "b♭".contains(c)
}

fn push_step_alter(segs: &mut Vec<HarmonySeg>, letter: char, accidental: &str, left: bool) {
    let g = if accidental.is_empty() {
        String::new()
    } else if is_sharp(accidental) {
        glyph("csymAccidentalSharp")
    } else if is_flat(accidental) {
        glyph("csymAccidentalFlat")
    } else {
        String::new()
    };
    if !g.is_empty() && left {
        segs.push(HarmonySeg::plain(g.clone(), true, 0));
    }
    segs.push(HarmonySeg::plain(letter, false, 0));
    if !g.is_empty() && !left {
        segs.push(HarmonySeg::plain(g, true, 0));
    }
}

/// UTF-16 下标 → 字节下标（`str.slice(n)`）。
fn byte_at16(s: &str, n16: usize) -> usize {
    let mut at = 0;
    for (i, c) in s.char_indices() {
        if at >= n16 {
            return i;
        }
        at += c.len_utf16();
    }
    s.len()
}

/// JS `str.split(/([…])/).filter(Boolean)`：按单字分隔符切开、分隔符本身也留下，去掉空段。
fn split_keep(s: &str, sep: impl Fn(char) -> bool) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in s.chars() {
        if sep(c) {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            out.push(c.to_string());
        } else {
            cur.push(c);
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// 后缀开头能直接用 SMuFL 记号表示的质量：返回 (字形名, 吃掉的 UTF-16 长度)。
fn quality_symbol(rest: &str) -> Option<(&'static str, usize)> {
    let lower = rest.to_lowercase();
    // /^(?:ø|m7b5|min7b5|halfdim)/i
    for p in ["ø", "m7b5", "min7b5", "halfdim"] {
        if lower.starts_with(p) && rest.chars().count() >= p.chars().count() {
            return Some(("csymHalfDiminished", p.encode_utf16().count()));
        }
    }
    // /^(?:aug|\+)/（区分大小写）
    if rest.starts_with("aug") {
        return Some(("csymAugmented", 3));
    }
    if rest.starts_with('+') {
        return Some(("csymAugmented", 1));
    }
    // /^(?:dim|°|o)(?![a-z])/i
    for p in ["dim", "°", "o"] {
        if lower.starts_with(p) {
            let n = p.chars().count();
            let next = rest.chars().nth(n);
            if !next.is_some_and(|c| c.is_ascii_alphabetic()) {
                return Some(("csymDiminished", p.encode_utf16().count()));
            }
        }
    }
    None
}

/// 把和弦**文字**解析成分段。`plain` 为真排成简单文本；`side` 根音 / 低音的升降号写在字母前还是后（不给照原文）。
pub fn chord_text_segs(text: &str, plain: bool, side: Option<AccidentalSide>) -> Vec<HarmonySeg> {
    let src = dolce_base::js::trim(text);
    if plain {
        let mut segs: Vec<HarmonySeg> = Vec::new();
        let emit = |segs: &mut Vec<HarmonySeg>, t: &str, acc: bool| {
            segs.push(HarmonySeg { text: t.to_string(), music: false, superscript: 0, dy: 0.0, scale: acc.then_some(PLAIN_ACCIDENTAL_SCALE) });
        };
        let emit_root = |segs: &mut Vec<HarmonySeg>, s: &str| -> String {
            let Some(m) = chord_step_alter(s) else {
                emit(segs, s, false);
                return String::new();
            };
            let acc = if m.acc.is_empty() {
                ""
            } else if is_sharp(&m.acc) {
                "#"
            } else {
                "b"
            };
            let before = match side {
                Some(sd) => sd == AccidentalSide::Before,
                None => m.left,
            };
            if !acc.is_empty() && before {
                emit(segs, acc, true);
            }
            emit(segs, &m.step.to_string(), false);
            if !acc.is_empty() && !before {
                emit(segs, acc, true);
            }
            s[byte_at16(s, m.len)..].to_string()
        };
        let mut rest = emit_root(&mut segs, src);
        let mut bass = String::new();
        if let Some(at) = rest.find('/') {
            bass = rest[at + 1..].to_string();
            rest.truncate(at);
        }
        for part in split_keep(&rest, |c| matches!(c, '#' | '♯' | '♭')) {
            match part.as_str() {
                "#" | "♯" => emit(&mut segs, "#", true),
                "♭" => emit(&mut segs, "b", true),
                _ => emit(&mut segs, &part, false),
            }
        }
        if !bass.is_empty() {
            emit(&mut segs, "/", false);
            emit_root(&mut segs, &bass);
        }
        return if segs.is_empty() { vec![HarmonySeg::plain(src, false, 0)] } else { segs };
    }

    let mut segs = Vec::new();
    let Some(root) = chord_step_alter(src) else {
        return vec![HarmonySeg::plain(src, false, 0)];
    };
    let left = match side {
        Some(sd) => sd == AccidentalSide::Before,
        None => root.left,
    };
    push_step_alter(&mut segs, root.step, &root.acc, left);
    let mut rest = src[byte_at16(src, root.len)..].to_string();
    let mut bass = String::new();
    if let Some(at) = rest.find('/') {
        bass = rest[at + 1..].to_string();
        rest.truncate(at);
    }
    // 前导 m 留在基线：/^m(?!aj)/i
    let lower = rest.to_lowercase();
    if lower.starts_with('m') && !lower.starts_with("maj") {
        segs.push(HarmonySeg::plain("m", false, 0));
        rest = rest[1..].to_string();
    }
    if !rest.is_empty() {
        let mut matched = false;
        if let Some((sym, n16)) = quality_symbol(&rest) {
            segs.push(HarmonySeg::plain(glyph(sym), true, 1));
            rest = rest[byte_at16(&rest, n16)..].to_string();
            matched = true;
        }
        if !rest.is_empty() {
            for part in split_keep(&rest, |c| matches!(c, '#' | '♯' | 'b' | '♭')) {
                if is_sharp(&part) && part.chars().count() == 1 {
                    segs.push(HarmonySeg::plain(glyph("csymAccidentalSharp"), true, 1));
                } else if is_flat(&part) && part.chars().count() == 1 && matched {
                    segs.push(HarmonySeg::plain(glyph("csymAccidentalFlat"), true, 1));
                } else {
                    segs.push(HarmonySeg::plain(part, false, 1));
                }
            }
        }
    }
    if !bass.is_empty() {
        segs.push(HarmonySeg::plain("/", false, 0));
        match chord_step_alter(&bass) {
            Some(b) => {
                let left = match side {
                    Some(sd) => sd == AccidentalSide::Before,
                    None => b.left,
                };
                push_step_alter(&mut segs, b.step, &b.acc, left);
            }
            None => segs.push(HarmonySeg::plain(bass, false, 0)),
        }
    }
    segs
}
