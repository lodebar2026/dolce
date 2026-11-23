//! `.Voice` 正文的词法器（同 `jpword/lex.ts`、`jpword/parse.ts`）。
//!
//! 规则沿用原 JP-Word 的词法定义（`docs/格式/jpwabc.md` §4）：在当前位置把各规则都试一遍，**取最长匹配，等长按规则先后**；
//! 哪条都匹配不上的字符跳过 1 个。TS 每条规则是一个带回溯的正则，这里逐条手写成「按 JS 正则会给出的那一个匹配」的扫描：
//! 各规则里可选部分彼此首字符互斥（`{C:` / `{(` / `{DunYin…` / `{音高`），回溯不会换出另一种结果，顺序贪婪即与正则同解。
//! 下标、行列按 UTF-16 码元。

use crate::abc::u16s::{self, U16};
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JpwTok {
    /// `(`：前奏开始
    PreludeBeg,
    /// `)`：前奏结束
    PreludeEnd,
    Note,
    /// 落单的 `[`（正文里出现即解析失败）
    Lbrack,
    /// 落单的 `]`（同上）
    Rbrack,
    Barline,
    /// 落单的 `)`：等长时让给 preludeEnd，实际不会产出
    Rbrace,
    /// `$(...)` 换行
    Return,
    Timesig,
    String,
    Comment,
    Ws,
}

#[derive(Clone, Debug, PartialEq)]
pub struct JpwToken {
    pub kind: JpwTok,
    /// token 原文（UTF-16 码元）
    pub text: Vec<u16>,
    /// 在输入里的 [start, end)（UTF-16 码元）
    pub start: usize,
    pub end: usize,
    /// 起点的 0 基行号与列（行以 `\n` 分）
    pub line: usize,
    pub column: usize,
}

#[inline]
fn is(s: &U16, i: usize, c: char) -> bool {
    u16s::is(s, i, c)
}

/// `\d+`
fn integer(s: &U16, i: usize) -> Option<usize> {
    let d = u16s::digits(s, i);
    (d > 0).then_some(i + d)
}

/// `[-+]?\d*\.\d+`
fn float(s: &U16, i: usize) -> Option<usize> {
    let mut j = i;
    if is(s, j, '-') || is(s, j, '+') {
        j += 1;
    }
    j += u16s::digits(s, j);
    if !is(s, j, '.') {
        return None;
    }
    j += 1;
    let d = u16s::digits(s, j);
    (d > 0).then_some(j + d)
}

/// `(?:FLOAT|INTEGER)`
fn number(s: &U16, i: usize) -> Option<usize> {
    float(s, i).or_else(|| integer(s, i))
}

/// 不分大小写的 ASCII 词
fn word_ci(s: &U16, i: usize, w: &str) -> Option<usize> {
    for (k, c) in w.bytes().enumerate() {
        let u = *s.get(i + k)?;
        if u > 0x7f || !(u as u8).eq_ignore_ascii_case(&c) {
            return None;
        }
    }
    Some(i + w.len())
}

/// `[tT][rR][uU][eE]|[fF][aA][lL][sS][eE]|NUMBER`
fn value(s: &U16, i: usize) -> Option<usize> {
    word_ci(s, i, "true").or_else(|| word_ci(s, i, "false")).or_else(|| number(s, i))
}

/// `\((?:VALUE|,)*\)`
fn paramlist(s: &U16, i: usize) -> Option<usize> {
    if !is(s, i, '(') {
        return None;
    }
    let mut j = i + 1;
    loop {
        if let Some(e) = value(s, j) {
            j = e;
        } else if is(s, j, ',') {
            j += 1;
        } else {
            break;
        }
    }
    is(s, j, ')').then_some(j + 1)
}

fn word(s: &U16, i: usize, w: &str) -> Option<usize> {
    u16s::starts(s, i, w).then(|| i + w.encode_utf16().count())
}

/// `UnderlineOnly|Unconnect|Connect|Other|None|All`
fn controltype(s: &U16, i: usize) -> Option<usize> {
    ["UnderlineOnly", "Unconnect", "Connect", "Other", "None", "All"].iter().find_map(|w| word(s, i, w))
}

/// `\{C:NUMBER(?:PARAMLIST)?(?:,CONTROLTYPE)*\}|\{C:0,,\}`
fn control(s: &U16, i: usize) -> Option<usize> {
    let alt1 = || {
        let mut j = number(s, word(s, i, "{C:")?)?;
        if let Some(e) = paramlist(s, j) {
            j = e;
        }
        while is(s, j, ',') {
            match controltype(s, j + 1) {
                Some(e) => j = e,
                None => break,
            }
        }
        is(s, j, '}').then_some(j + 1)
    };
    alt1().or_else(|| word(s, i, "{C:0,,}"))
}

/// `\(|\{\((?:,(?:FLOAT)?|0:0,FLOAT,INTEGER)\}`
fn slurstart(s: &U16, i: usize) -> Option<usize> {
    if is(s, i, '(') {
        return Some(i + 1);
    }
    let j = word(s, i, "{(")?;
    let j = if is(s, j, ',') {
        float(s, j + 1).filter(|&e| is(s, e, '}')).unwrap_or(j + 1)
    } else {
        let j = float(s, word(s, j, "0:0,")?)?;
        if !is(s, j, ',') {
            return None;
        }
        integer(s, j + 1)?
    };
    is(s, j, '}').then_some(j + 1)
}

/// `\{\([0-9]\}`
fn tuplet(s: &U16, i: usize) -> Option<usize> {
    let j = word(s, i, "{(")?;
    (s.get(j).is_some_and(|&u| u16s::digit(u)) && is(s, j + 1, '}')).then_some(j + 2)
}

/// `DunYin|BoYin|YanYin|ZhongYin`
fn articulation(s: &U16, i: usize) -> Option<usize> {
    ["DunYin", "BoYin", "YanYin", "ZhongYin"].iter().find_map(|w| word(s, i, w))
}

/// `\{ART(?:,ART)*\}`
fn articulations(s: &U16, i: usize) -> Option<usize> {
    if !is(s, i, '{') {
        return None;
    }
    let mut j = articulation(s, i + 1)?;
    while is(s, j, ',') {
        match articulation(s, j + 1) {
            Some(e) => j = e,
            None => break,
        }
    }
    is(s, j, '}').then_some(j + 1)
}

fn hex(u: u16) -> bool {
    u16s::digit(u) || (b'a' as u16..=b'f' as u16).contains(&u) || (b'A' as u16..=b'F' as u16).contains(&u)
}

/// `\\x[a-fA-F0-9]{4}|[Ā-\udbff]`
fn unichar(s: &U16, i: usize) -> Option<usize> {
    if is(s, i, '\\') && is(s, i + 1, 'x') && (2..6).all(|k| s.get(i + k).is_some_and(|&u| hex(u))) {
        return Some(i + 6);
    }
    s.get(i).is_some_and(|&u| (0x0100..=0xdbff).contains(&u)).then_some(i + 1)
}

/// `(?:#b|b|#)?[0-7][,'gd]*|[xX]UNICHAR?`
pub(crate) fn pitch(s: &U16, i: usize) -> Option<usize> {
    let d07 = |k: usize| u16s::within(u16s::at(s, k), '0', '7');
    let starts = [word(s, i, "#b"), word(s, i, "b"), word(s, i, "#"), Some(i)];
    if let Some(j) = starts.into_iter().flatten().find(|&j| d07(j)) {
        let mut k = j + 1;
        while u16s::one_of(u16s::at(s, k), ",'gd") {
            k += 1;
        }
        return Some(k);
    }
    if is(s, i, 'x') || is(s, i, 'X') {
        return Some(unichar(s, i + 1).unwrap_or(i + 1));
    }
    None
}

/// `OPEN PITCH+ CLOSE`
fn pitches_in(s: &U16, i: usize, open: char, close: char) -> Option<usize> {
    if !is(s, i, open) {
        return None;
    }
    let mut j = pitch(s, i + 1)?;
    while let Some(e) = pitch(s, j) {
        j = e;
    }
    is(s, j, close).then_some(j + 1)
}

/// `-+|_+\.*|\.*_+|\.+`（第一种成立的写法）
fn duration(s: &U16, i: usize) -> Option<usize> {
    let run = |c: char, from: usize| {
        let mut k = from;
        while is(s, k, c) {
            k += 1;
        }
        k
    };
    let e = run('-', i);
    if e > i {
        return Some(e);
    }
    let e = run('_', i);
    if e > i {
        return Some(run('.', e));
    }
    let d = run('.', i);
    let e = run('_', d);
    if e > d {
        return Some(e);
    }
    (d > i).then_some(d)
}

fn note(s: &U16, i: usize) -> Option<usize> {
    let mut j = i;
    while let Some(e) = slurstart(s, j) {
        j = e;
    }
    for opt in [control, tuplet, articulations] {
        if let Some(e) = opt(s, j) {
            j = e;
        }
    }
    if let Some(e) = pitches_in(s, j, '{', '}') {
        j = e;
    }
    j = pitch(s, j).or_else(|| pitches_in(s, j, '[', ']'))?;
    if let Some(e) = duration(s, j) {
        j = e;
    }
    if let Some(e) = control(s, j) {
        j = e;
    }
    while is(s, j, ')') {
        j += 1;
    }
    Some(j)
}

/// `[|]|:|:|\|\||\|]|\|:|:\||::|\|`（第一种成立的写法）后跟 `CONTROL?` 与房号 `HOUSE?`
fn barline(s: &U16, i: usize) -> Option<usize> {
    let mut j = ["[|]", ":|:", "||", "|]", "|:", ":|", "::", "|"].iter().find_map(|w| word(s, i, w))?;
    if let Some(e) = control(s, j) {
        j = e;
    }
    // HOUSE：`\[(?:结束句|\d+\.)`
    if is(s, j, '[') {
        if let Some(e) = word(s, j + 1, "结束句") {
            return Some(e);
        }
        let d = u16s::digits(s, j + 1);
        if d > 0 && is(s, j + 1 + d, '.') {
            return Some(j + 2 + d);
        }
    }
    Some(j)
}

fn timesig(s: &U16, i: usize) -> Option<usize> {
    let j = integer(s, i)?;
    if !is(s, j, '/') {
        return None;
    }
    let j = integer(s, j + 1)?;
    Some(control(s, j).unwrap_or(j))
}

/// `"(?:ESCAPE|[^"\\])*?"`，`ESCAPE = \\[sbtnfr"'\\]|\\x HEX4|\\0\d{4}`
fn string(s: &U16, i: usize) -> Option<usize> {
    if !is(s, i, '"') {
        return None;
    }
    let mut j = i + 1;
    loop {
        let u = *s.get(j)?;
        if u == b'"' as u16 {
            return Some(j + 1);
        }
        if u != b'\\' as u16 {
            j += 1;
            continue;
        }
        let n = u16s::at(s, j + 1);
        if u16s::one_of(n, "sbtnfr\"'\\") {
            j += 2;
        } else if (n == Some(b'x' as u16) && (2..6).all(|k| s.get(j + k).is_some_and(|&u| hex(u)))) || (n == Some(b'0' as u16) && (2..6).all(|k| s.get(j + k).is_some_and(|&u| u16s::digit(u)))) {
            j += 6;
        } else {
            return None;
        }
    }
}

fn comment(s: &U16, i: usize) -> Option<usize> {
    let mut j = word(s, i, "//")?;
    while s.get(j).is_some_and(|&u| u != b'\r' as u16 && u != b'\n' as u16) {
        j += 1;
    }
    Some(j)
}

fn ws(s: &U16, i: usize) -> Option<usize> {
    let mut j = i;
    while u16s::one_of(u16s::at(s, j), " \t\r\n") {
        j += 1;
    }
    (j > i).then_some(j)
}

/// 规则次序即等长时的优先级
/// 从某位置起试读一种词元，读得到回结束位置
type Rule = fn(&U16, usize) -> Option<usize>;
const RULES: [(JpwTok, Rule); 12] = [
    (JpwTok::PreludeBeg, |s, i| word(s, i, "(").map(|j| control(s, j).unwrap_or(j))),
    (JpwTok::PreludeEnd, |s, i| word(s, i, ")").map(|j| control(s, j).unwrap_or(j))),
    (JpwTok::Note, note),
    (JpwTok::Lbrack, |s, i| word(s, i, "[")),
    (JpwTok::Rbrack, |s, i| word(s, i, "]")),
    (JpwTok::Barline, barline),
    (JpwTok::Rbrace, |s, i| word(s, i, ")")),
    (JpwTok::Return, |s, i| word(s, i, "$").map(|j| paramlist(s, j).unwrap_or(j))),
    (JpwTok::Timesig, timesig),
    (JpwTok::String, string),
    (JpwTok::Comment, comment),
    (JpwTok::Ws, ws),
];

/// 把 `.Voice` 正文切成 token（含 ws / comment）。认不出的字符静默跳过（`lexVoice`）。
pub fn lex_voice(text: &U16) -> Vec<JpwToken> {
    let mut out = vec![];
    let (mut pos, mut line, mut line_start, mut k) = (0usize, 0usize, 0usize, 0usize);
    while pos < text.len() {
        let mut best = None;
        let mut best_len = 0;
        for (kind, rule) in RULES {
            if let Some(e) = rule(text, pos) {
                if e - pos > best_len {
                    best = Some(kind);
                    best_len = e - pos;
                }
            }
        }
        let Some(kind) = best else {
            pos += 1;
            continue;
        };
        // 行列：数到起点为止的换行
        while k < pos {
            if text[k] == b'\n' as u16 {
                line += 1;
                line_start = k + 1;
            }
            k += 1;
        }
        out.push(JpwToken { kind, text: text[pos..pos + best_len].to_vec(), start: pos, end: pos + best_len, line, column: pos - line_start });
        pos += best_len;
    }
    out
}

/// `.Voice` 正文 → token 序列（去掉空白与注释）；出现落单的 `[` / `]` / `)` 时 `None`（`parseVoiceText`）
pub fn parse_voice_text(text: &U16) -> Option<Vec<JpwToken>> {
    let mut out = vec![];
    for t in lex_voice(text) {
        match t.kind {
            JpwTok::Ws | JpwTok::Comment => continue,
            JpwTok::Lbrack | JpwTok::Rbrack | JpwTok::Rbrace => return None,
            _ => out.push(t),
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(s: &str) -> Vec<(JpwTok, String)> {
        lex_voice(&u16s::enc(s)).into_iter().map(|t| (t.kind, String::from_utf16_lossy(&t.text))).collect()
    }

    #[test]
    fn basic() {
        let k = kinds("((1_. {C:1.5}2-- |: 4/4 \"1=D\" $(true,0,0,true) // x\n:|[1.");
        let names: Vec<_> = k.iter().map(|(t, s)| format!("{t:?}:{s}")).collect();
        assert_eq!(
            names,
            [
                "Note:((1_.", "Ws: ", "Note:{C:1.5}2--", "Ws: ", "Barline:|:", "Ws: ", "Timesig:4/4", "Ws: ", "String:\"1=D\"", "Ws: ",
                "Return:$(true,0,0,true)", "Ws: ", "Comment:// x", "Ws:\n", "Barline::|[1."
            ]
        );
        // 等长按规则先后：`)` 是 preludeEnd 不是 rbrace
        assert_eq!(kinds(")")[0].0, JpwTok::PreludeEnd);
        // 时值写法取第一种成立的：`_._` 只吃 `_.`
        assert_eq!(kinds("1_._")[0].1, "1_.");
        assert_eq!(kinds("1._")[0].1, "1._");
        assert!(parse_voice_text(&u16s::enc("1 [ 2")).is_none());
    }
}
