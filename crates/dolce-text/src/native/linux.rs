//! Linux：没有统一的系统排版 API（各桌面环境、发行版装的字体与排版库都不定），量字走本 crate 的字体文件层
//! [`crate::fontfile`]——fontdb 扫系统字体目录（读 fontconfig 的目录配置）按族名、粗斜匹配，rustybuzz 整形，与导出共用。
//!
//! 口径照 mac.rs：族串按序，逐字回退（族串里第一个有这个字的 → 平台末位回退 → 库里任一有这个字的）；
//! 笔位按 advance 累加（不含 GPOS 的定位偏移），墨迹取字形轮廓的紧包围盒（落在含偏移的画字位置）；
//! 族里没有粗 / 斜字面时用常规体代量（浏览器此时合成粗斜，advance 不变）。

use std::cell::RefCell;
use std::ops::Range;
use std::path::Path;
use std::sync::Arc;

use super::{positions_by, utf8_to_cp, Ink};
use crate::fontfile::{Face, FaceRef, FontBook};
use crate::{Measured, RawFontMetrics as Metrics};

thread_local! {
    /// 系统字体库（第一次用时扫目录）
    static BOOK: RefCell<Option<FontBook>> = const { RefCell::new(None) };
}

fn with_book<R>(f: impl FnOnce(&mut FontBook) -> R) -> R {
    BOOK.with(|b| {
        let mut b = b.borrow_mut();
        f(b.get_or_insert_with(FontBook::system))
    })
}

/// 跟着前一个字走、不单独选字体的码点：组合附加符、零宽连接 / 不连接、变体选择符。
fn sticks_to_prev(ch: char) -> bool {
    matches!(ch as u32,
        0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F
        | 0x200C | 0x200D | 0xFE00..=0xFE0F | 0xE0100..=0xE01EF
        // 天城文等的元音附标、鼻化、半音符（字体整形要与辅音同段）
        | 0x0900..=0x0903 | 0x093A..=0x094F | 0x0951..=0x0957 | 0x0962..=0x0963)
}

/// 这个字用哪个面：族串里第一个有的 → 末位回退 → 库里任一有的；都没有用族串首个（画缺字框）。
fn face_for(book: &FontBook, chain: &[FaceRef], ch: char, bold: bool, italic: bool) -> Option<Arc<Face>> {
    book.pick(chain, ch, bold, italic).or_else(|| book.pick_any(ch)).or_else(|| chain.first().cloned()).map(|f| f.face)
}

/// 按字选面，连续同面的码点成一段（字节区间）。
fn runs(book: &FontBook, chain: &[FaceRef], text: &str, bold: bool, italic: bool) -> Vec<(Range<usize>, Arc<Face>)> {
    let mut out: Vec<(Range<usize>, Arc<Face>)> = Vec::new();
    for (i, ch) in text.char_indices() {
        let end = i + ch.len_utf8();
        if let Some(last) = out.last_mut() {
            if sticks_to_prev(ch) {
                last.0.end = end;
                continue;
            }
        }
        let Some(face) = face_for(book, chain, ch, bold, italic) else { continue };
        match out.last_mut() {
            Some(last) if last.0.end == i && Arc::ptr_eq(&last.1, &face) => last.0.end = end,
            _ => out.push((i..end, face)),
        }
    }
    out
}

/// 一个整形好的字形：所在面、字形号、笔位（px）、画字位置相对笔位的偏移（px，y 向下）。
struct Placed {
    face: Arc<Face>,
    gid: u16,
    byte: usize,
    pen: f64,
    dx: f64,
    dy: f64,
}

/// 整串排好：各字形 + 总宽（px）。
fn layout(text: &str, families: &[String], size: f64, bold: bool, italic: bool, features: &[String]) -> (Vec<Placed>, f64) {
    let (no_kern, features) = crate::split_no_kern(features);
    let mut feats: Vec<&str> = features.iter().map(String::as_str).collect();
    if no_kern {
        feats.push("-kern");
    }
    with_book(|book| {
        let chain = book.chain_of(families, bold, italic);
        let mut out = Vec::new();
        let mut pen = 0.0;
        for (range, face) in runs(book, &chain, text, bold, italic) {
            for g in face.shape(&text[range.clone()], &feats) {
                out.push(Placed { face: face.clone(), gid: g.gid, byte: range.start + g.cluster, pen, dx: g.x_offset * size, dy: -g.y_offset * size });
                pen += g.x_advance * size;
            }
        }
        (out, pen)
    })
}

pub fn measure(text: &str, families: &[String], size: f64, bold: bool, italic: bool, features: &[String]) -> Measured {
    if text.is_empty() {
        return Ink::default().into_measured(0.0, vec![]);
    }
    let (glyphs, width) = layout(text, families, size, bold, italic, features);
    let mut ink = Ink::default();
    let mut glyph_pos = Vec::with_capacity(glyphs.len());
    for g in &glyphs {
        glyph_pos.push((g.byte, g.pen));
        if let Some(b) = g.face.tight_ink(g.gid) {
            let (x, y) = (g.pen + g.dx, g.dy);
            ink.add(x + b.left * size, y + b.top * size, x + b.right * size, y + b.bottom * size);
        }
    }
    let xs = positions_by(&utf8_to_cp(text), text.chars().count(), &glyph_pos);
    ink.into_measured(width, xs)
}

pub fn font_metrics(families: &[String], size: f64, bold: bool, italic: bool) -> Metrics {
    let first = with_book(|book| families.iter().find_map(|f| book.find(f, bold, italic).map(|r| (f.clone(), r.face))));
    match first {
        Some((family, face)) => Metrics { ascent: face.ascent * size, descent: -face.descent * size, family },
        None => Metrics { ascent: size * 0.8, descent: size * 0.2, family: String::new() },
    }
}

pub fn has_family(family: &str) -> bool {
    with_book(|book| book.find(family, false, false).is_some())
}

/// 按文件加字体；同名族解析时与系统里的那份一起参与匹配（fontdb 按加入先后，后加的不一定优先——仓库字体系统里一般没有）。
pub fn register_font(path: &str) -> bool {
    with_book(|book| book.add_file(Path::new(path)).is_ok())
}

pub fn resolve_name(family: &str) -> String {
    with_book(|book| book.find(family, false, false).map(|r| format!("{} / {}", r.face.ps_name, r.face.family)).unwrap_or_default())
}

pub fn outline(text: &str, families: &[String], size: f64, bold: bool, italic: bool, features: &[String]) -> String {
    if text.is_empty() {
        return String::new();
    }
    let (glyphs, _) = layout(text, families, size, bold, italic, features);
    let mut d = String::new();
    for g in &glyphs {
        let (x, y) = (g.pen + g.dx, g.dy);
        for (op, p) in g.face.outline(g.gid, size) {
            d.push(op);
            let pts: Vec<String> = p.chunks(2).map(|q| format!("{:.3} {:.3}", q[0] + x, q[1] + y)).collect();
            d.push_str(&pts.join(" "));
        }
    }
    d
}
