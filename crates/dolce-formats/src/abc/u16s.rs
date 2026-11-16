//! 按 UTF-16 码元扫文字（TS 的 `line[i]`、`slice`、`indexOf` 都是码元下标，源码区间也按码元记）。
//! 语法字符全在 ASCII，判断落在单个码元上；取出的片段经 `from_utf16_lossy` 回 Rust 字符串（孤立代理成 U+FFFD）。

use dolce_base::js::is_space;

pub type U16 = [u16];

pub fn enc(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

pub fn text(s: &U16) -> String {
    String::from_utf16_lossy(s)
}

/// `line[i]`（越界 `None`）
#[inline]
pub fn at(s: &U16, i: usize) -> Option<u16> {
    s.get(i).copied()
}

/// `line[i] === c`
#[inline]
pub fn is(s: &U16, i: usize, c: char) -> bool {
    s.get(i).is_some_and(|&u| u as u32 == c as u32)
}

/// `line.startsWith(p, i)`（`p` 只含 BMP 字符）
pub fn starts(s: &U16, i: usize, p: &str) -> bool {
    let mut k = i;
    for c in p.chars() {
        if !is(s, k, c) {
            return false;
        }
        k += 1;
    }
    true
}

/// `line.indexOf(c, from)`
pub fn find(s: &U16, c: char, from: usize) -> Option<usize> {
    (from..s.len()).find(|&k| is(s, k, c))
}

/// 码元 → 字符（代理码元给 `None`）
#[inline]
pub fn ch(u: u16) -> Option<char> {
    char::from_u32(u as u32)
}

/// 正则 `\s` 对单个码元
#[inline]
pub fn space(u: u16) -> bool {
    ch(u).is_some_and(is_space)
}

#[inline]
pub fn digit(u: u16) -> bool {
    (b'0' as u16..=b'9' as u16).contains(&u)
}

/// `[lo-hi]`（ASCII / BMP 区间）
#[inline]
pub fn within(u: Option<u16>, lo: char, hi: char) -> bool {
    u.is_some_and(|u| u as u32 >= lo as u32 && u as u32 <= hi as u32)
}

/// `[...]` 字符集（只含 BMP 字符）
#[inline]
pub fn one_of(u: Option<u16>, set: &str) -> bool {
    u.is_some_and(|u| set.chars().any(|c| c as u32 == u as u32))
}

/// 从 `i` 起连续的数字个数（`\d*`）
pub fn digits(s: &U16, i: usize) -> usize {
    let mut k = i;
    while k < s.len() && digit(s[k]) {
        k += 1;
    }
    k - i
}

/// `Number("123")`（只给数字串）
pub fn num(s: &U16) -> f64 {
    dolce_base::js::number(&text(s))
}

/// 从 `i` 起连续的 `\s` 个数
pub fn spaces(s: &U16, i: usize) -> usize {
    let mut k = i;
    while k < s.len() && space(s[k]) {
        k += 1;
    }
    k - i
}

/// `s.trim()`（JS 口径的空白）
pub fn trim(s: &U16) -> &U16 {
    let mut a = 0;
    let mut b = s.len();
    while a < b && space(s[a]) {
        a += 1;
    }
    while b > a && space(s[b - 1]) {
        b -= 1;
    }
    &s[a..b]
}
