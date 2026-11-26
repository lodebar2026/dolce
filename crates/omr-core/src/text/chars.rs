//! 字的种类。

/// 汉字（含扩展 A）。
pub fn is_han(c: char) -> bool {
    ('\u{3400}'..='\u{9fff}').contains(&c)
}

/// 拉丁字母（含带符号的）。
pub fn is_latin(c: char) -> bool {
    c.is_ascii_alphabetic() || ('\u{00c0}'..='\u{024f}').contains(&c)
}

pub fn han_count(s: &str) -> usize {
    s.chars().filter(|&c| is_han(c)).count()
}

pub fn latin_count(s: &str) -> usize {
    s.chars().filter(|&c| is_latin(c)).count()
}

/// 一串字以哪种文字为主。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Script {
    Han,
    Latin,
    Other,
}

pub fn script_of(s: &str) -> Script {
    let (h, l) = (han_count(s), latin_count(s));
    if h == 0 && l == 0 {
        Script::Other
    } else if h * 2 >= l {
        // 一个汉字顶两个字母
        Script::Han
    } else {
        Script::Latin
    }
}
