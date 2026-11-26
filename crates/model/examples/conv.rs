//! 对拍用：每行一个 JSON 字符串进，按 `s2t` / `t2s`（第一个参数）转了每行一个 JSON 字符串出。
use std::io::{BufRead, Write};

fn main() {
    let dir = std::env::args().nth(1).unwrap_or_default();
    let c = if dir == "t2s" { dolce_model::hanconv_dict::t2s() } else { dolce_model::hanconv_dict::s2t() };
    let out = std::io::stdout();
    let mut out = std::io::BufWriter::new(out.lock());
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("读");
        let s: String = line.strip_prefix('"').and_then(|x| x.strip_suffix('"')).map(unescape).unwrap_or_default();
        writeln!(out, "{}", escape(&c.convert(&s))).expect("写");
    }
}

/// 只处理 JSON.stringify 会写出的转义
fn unescape(s: &str) -> String {
    let mut out = String::new();
    let mut it = s.chars().peekable();
    let mut pending: Option<u16> = None;
    while let Some(c) = it.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match it.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('b') => out.push('\u{8}'),
            Some('f') => out.push('\u{c}'),
            Some('u') => {
                let h: String = (0..4).filter_map(|_| it.next()).collect();
                let u = u16::from_str_radix(&h, 16).unwrap_or(0xfffd);
                if let Some(hi) = pending.take() {
                    out.push_str(&String::from_utf16_lossy(&[hi, u]));
                } else if (0xd800..0xdc00).contains(&u) {
                    pending = Some(u);
                } else {
                    out.push_str(&String::from_utf16_lossy(&[u]));
                }
            }
            Some(x) => out.push(x),
            None => {}
        }
    }
    out
}

fn escape(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
