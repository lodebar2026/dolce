//! jianpu-ly 的 `chords=` 行：LilyPond 和弦语法 ↔ 谱上印的文字（同 `jly/jlychords.ts`）。
//!
//! 两个方向都用同一张表（读写对称），表外的后缀**保留原文**但写出时会报出来。
//! 上游把这行原样塞进 `\new ChordNames { \chordmode { … } }`，token 就是 LilyPond 和弦语法：
//! `<音名><时值?><:修饰?>?`（时值按 LilyPond 的「没写就沿用上一个」，第一个默认四分）。
//! TS 的正则逐条手译（`i` 标志只折 ASCII 大小写，同 JS 非 Unicode 模式）。

use dolce_base::js;
use dolce_model::harmony::chord_suffix_form;

/// 谱上印的修饰 → LilyPond 和弦修饰：（写法, 忽略大小写, 出）。左边没有前导 `:`（大小写敏感的是 `M7`：大七）。
const SUFFIX_TO_LY: &[(&str, bool, &str)] = &[
    ("maj7", true, "maj7"), ("M7", false, "maj7"), ("m7", true, "m7"), ("min7", true, "m7"), ("m7b5", true, "m7.5-"),
    ("dim7", true, "dim7"), ("dim", true, "dim"), ("aug", true, "aug"), ("sus4", true, "sus4"), ("sus2", true, "sus2"),
    ("maj9", true, "maj9"), ("m9", true, "m9"), ("m6", true, "m6"), ("6", true, "6"), ("9", true, "9"),
    ("m", true, "m"), ("min", true, "m"), ("7", true, "7"), ("5", true, "5"), ("add9", true, "9"),
];

/// LilyPond 和弦修饰 → 谱上印的写法（大小写敏感）。
const LY_TO_SUFFIX: &[(&str, &str)] = &[
    ("maj7", "maj7"), ("m7.5-", "m7b5"), ("m7", "m7"), ("m6", "m6"), ("m9", "m9"),
    ("dim7", "dim7"), ("dim", "dim"), ("aug", "aug"), ("sus4", "sus4"), ("sus2", "sus2"),
    ("maj9", "maj9"), ("m", "m"), ("7", "7"), ("6", "6"), ("9", "9"), ("5", "5"),
];

/// 音名后的变音后缀（荷兰语 / 英语两套，正则 `(isis|eses|ses|is|es|ff|ss|s|f)` 的分支次序）
const LY_MODS: &[&str] = &["isis", "eses", "ses", "is", "es", "ff", "ss", "s", "f"];
/// `parseChordToken` 里音名的后缀分支（`(?:isis|eses|is|es|s|f)`）
const TOKEN_MODS: &[&str] = &["isis", "eses", "is", "es", "s", "f"];

fn is_lower_step(c: char) -> bool {
    ('a'..='g').contains(&c.to_ascii_lowercase()) && c.is_ascii()
}

/// LilyPond 音名（`c` `bes` `fis` `ceses`…）→ 谱上写法（`C` `Bb` `F#`…）。
/// `s`/`f`/`es` 都是**降**（`ss` 不在映射里，照 TS 落成无升降）。
pub fn ly_pitch_to_text(ly: &str) -> Option<String> {
    let t: Vec<char> = js::trim(ly).chars().collect();
    let (&c0, rest) = t.split_first()?;
    if !is_lower_step(c0) {
        return None;
    }
    let rest: String = rest.iter().collect();
    let low = rest.to_ascii_lowercase();
    if !rest.is_empty() && !LY_MODS.iter().any(|m| rest.eq_ignore_ascii_case(m)) {
        return None;
    }
    let alter = match low.as_str() {
        "isis" => "##",
        "eses" | "ses" | "ff" => "bb",
        "is" => "#",
        "es" | "s" | "f" => "b",
        _ => "",
    };
    Some(format!("{}{}", c0.to_ascii_uppercase(), alter))
}

/// 谱上写法里音名后的升降号（`([#♯b♭]|##|bb)?`）：单字符分支在前、两字符在后，末尾 `$` 时等价于整串取值
fn text_acc(s: &str) -> bool {
    matches!(s, "" | "#" | "♯" | "b" | "♭" | "##" | "bb")
}

/// 谱上写法（`C` `B♭` `F#`）→ LilyPond 音名（`c` `bes` `fis`）
pub fn text_pitch_to_ly(text: &str) -> Option<String> {
    let t = js::trim(text);
    let c0 = t.chars().next()?;
    if !c0.is_ascii() || !('a'..='g').contains(&c0.to_ascii_lowercase()) {
        return None;
    }
    let acc = &t[1..];
    if !text_acc(acc) {
        return None;
    }
    let alter = match acc {
        "#" | "♯" => "is",
        "##" => "isis",
        "b" | "♭" => "es",
        "bb" => "eses",
        _ => "",
    };
    Some(format!("{}{}", c0.to_ascii_lowercase(), alter))
}

/// LilyPond 和弦后缀（`:m7` 这类，含前导冒号与否）→ 谱上印的写法
pub fn ly_suffix_to_text(suffix: &str) -> String {
    let s = suffix.strip_prefix(':').unwrap_or(suffix);
    if s.is_empty() {
        return String::new();
    }
    for (re, out) in LY_TO_SUFFIX {
        if s == *re {
            return (*out).into();
        }
    }
    s.into() // 表外：原样印（如 `13`、`7.9+`）
}

/// 谱上印的后缀 → LilyPond 后缀（带前导冒号）。认不出来回 `None`（写出端据此报警）。
/// ⚠ 纯数字一条 TS 写的是 `":" + "$1"`（字面，不是替换），照搬。
pub fn text_suffix_to_ly(suffix: &str) -> Option<String> {
    let s = js::trim(suffix);
    if s.is_empty() {
        return Some(String::new());
    }
    for (re, ci, out) in SUFFIX_TO_LY {
        if if *ci { s.eq_ignore_ascii_case(re) } else { s == *re } {
            return Some(format!(":{out}"));
        }
    }
    if s.bytes().all(|b| b.is_ascii_digit()) {
        return Some(":$1".into());
    }
    None
}

/// `chords=` 行里一个 token 拆出来的样子
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct ChordToken {
    pub pitch: String,
    /// 时值（**全音符**为单位，不是拍）；没写为 `None`
    pub whole: Option<f64>,
    pub suffix: String,
    pub bass: Option<String>,
}

/// 字母 + 变音后缀（`[a-g](?:isis|eses|is|es|s|f)?`，忽略大小写），各种可能的结尾位置（按正则回溯的先后）
fn token_pitch_ends(cs: &[char], at: usize) -> Vec<usize> {
    let mut out = vec![];
    if !cs.get(at).is_some_and(|&c| is_lower_step(c)) {
        return out;
    }
    for m in TOKEN_MODS {
        let n = m.len();
        if at + 1 + n <= cs.len() && cs[at + 1..at + 1 + n].iter().zip(m.chars()).all(|(a, b)| a.eq_ignore_ascii_case(&b)) {
            out.push(at + 1 + n);
        }
    }
    out.push(at + 1);
    out
}

/// 音名之后（时值 / 乘数 / 后缀 / 低音 / 结尾）。成功回 (时值, 乘数, 后缀, 低音)
fn token_tail(cs: &[char], mut i: usize) -> Option<(String, String, String, Option<String>)> {
    let digit = |c: &char| c.is_ascii_digit();
    let s = |a: usize, b: usize| cs[a..b].iter().collect::<String>();
    // (\d+(?:\.*)|)
    let d0 = i;
    while i < cs.len() && digit(&cs[i]) {
        i += 1;
    }
    if i > d0 {
        while i < cs.len() && cs[i] == '.' {
            i += 1;
        }
    }
    let dur = s(d0, i);
    // ((?:\*\d+(?:\/\d+)?)?)
    let m0 = i;
    if cs.get(i) == Some(&'*') && cs.get(i + 1).is_some_and(digit) {
        i += 1;
        while i < cs.len() && digit(&cs[i]) {
            i += 1;
        }
        if cs.get(i) == Some(&'/') && cs.get(i + 1).is_some_and(digit) {
            i += 1;
            while i < cs.len() && digit(&cs[i]) {
                i += 1;
            }
        }
    }
    let mult = s(m0, i);
    // ((?::[^/]*)?)
    let s0 = i;
    if cs.get(i) == Some(&':') {
        i += 1;
        while i < cs.len() && cs[i] != '/' {
            i += 1;
        }
    }
    let suffix = s(s0, i);
    if i == cs.len() {
        return Some((dur, mult, suffix, None));
    }
    // (?:\/([a-g](?:isis|eses|is|es|s|f)?))?$
    if cs[i] == '/' {
        for e in token_pitch_ends(cs, i + 1) {
            if e == cs.len() {
                return Some((dur, mult, suffix, Some(s(i + 1, e))));
            }
        }
    }
    None
}

/// 把 `chords=` 行里的一个 token（`c2.:m7/bes`、`c4*31:m7`）拆成音名 / 时值 / 后缀 / 低音。
/// ⚠ 时值单位是**全音符**（不是拍）：`c2.` = 1/2 + 1/4 = 0.75 全音符 = 3 拍。
pub fn parse_chord_token(tok: &str) -> Option<ChordToken> {
    let cs: Vec<char> = js::trim(tok).chars().collect();
    for end in token_pitch_ends(&cs, 0) {
        let Some((dur, mult, suffix, bass)) = token_tail(&cs, end) else { continue };
        let pitch: String = cs[..end].iter().collect();
        let mut whole = None;
        if !dur.is_empty() {
            let digits: String = dur.chars().take_while(|c| c.is_ascii_digit()).collect();
            let denom = js::number(&digits);
            if denom != 0.0 {
                let dots = dur.chars().filter(|&c| c == '.').count();
                let mut w = 1.0 / denom;
                let mut add = w / 2.0;
                for _ in 0..dots {
                    w += add;
                    add /= 2.0;
                }
                whole = Some(w);
            }
        }
        if let (Some(w), false) = (whole, mult.is_empty()) {
            // `^\*(\d+)(?:\/(\d+))?$`：token_tail 只收这种形状
            let body = &mult[1..];
            let (a, b) = body.split_once('/').unwrap_or((body, "1"));
            whole = Some(w * (js::number(a) / js::number(b)));
        }
        return Some(ChordToken { pitch, whole, suffix, bass });
    }
    None
}

/// `chords=` 行里一个 token 的**谱上写法**（读入端与编辑端共用一套转换）
pub fn chord_token_to_text(tok: &str) -> Option<String> {
    let p = parse_chord_token(tok)?;
    let root = ly_pitch_to_text(&p.pitch)?;
    let bass = p.bass.as_deref().and_then(ly_pitch_to_text);
    Some(format!("{root}{}{}", ly_suffix_to_text(&p.suffix), bass.map(|b| format!("/{b}")).unwrap_or_default()))
}

/// 整音符分数 → (LilyPond 时值串, 是否精确)。与上游 `xmlDuration` 同一套：分母 + 附点取最接近的
pub fn whole_to_duration(whole: f64) -> (String, bool) {
    let mut best: Option<(f64, String)> = None;
    for denom in [1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0] {
        let mut v = 1.0 / denom;
        let mut add = v;
        for dots in 0..4 {
            let text = format!("{}{}", js::num_to_string(denom), ".".repeat(dots));
            let err = (v - whole).abs();
            if err < 1e-9 {
                return (text, true);
            }
            if best.as_ref().is_none_or(|b| err < b.0) {
                best = Some((err, text));
            }
            add /= 2.0;
            v += add;
        }
    }
    (best.map(|b| b.1).unwrap_or_else(|| "4".into()), false)
}

/// 和弦文字里音名的写法（`[A-Ga-g](?:[#♯b♭]|##|bb)?`）在 `at` 起的各种结尾（按回溯先后）
fn text_pitch_ends(cs: &[char], at: usize) -> Vec<usize> {
    let mut out = vec![];
    if !cs.get(at).is_some_and(|&c| is_lower_step(c)) {
        return out;
    }
    let i = at + 1;
    if cs.get(i).is_some_and(|c| matches!(c, '#' | '♯' | 'b' | '♭')) {
        out.push(i + 1);
    }
    for two in [['#', '#'], ['b', 'b']] {
        if cs.get(i) == Some(&two[0]) && cs.get(i + 1) == Some(&two[1]) {
            out.push(i + 2);
        }
    }
    out.push(i);
    out
}

/// `.`：除行终止符外的任意字符
fn not_lt(c: char) -> bool {
    !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `^([A-Ga-g](?:[#♯b♭]|##|bb)?)(.*?)(?:\/([A-Ga-g](?:[#♯b♭]|##|bb)?))?$`
fn split_chord_text(t: &str) -> Option<(String, String, Option<String>)> {
    let cs: Vec<char> = t.chars().collect();
    let s = |a: usize, b: usize| cs[a..b].iter().collect::<String>();
    for p in text_pitch_ends(&cs, 0) {
        let mut q = p;
        loop {
            // 先试低音（贪婪的 `?`），再试不带低音直接到尾
            if cs.get(q) == Some(&'/') {
                for e in text_pitch_ends(&cs, q + 1) {
                    if e == cs.len() {
                        return Some((s(0, p), s(p, q), Some(s(q + 1, e))));
                    }
                }
            }
            if q == cs.len() {
                return Some((s(0, p), s(p, q), None));
            }
            if !not_lt(cs[q]) {
                break;
            }
            q += 1;
        }
    }
    None
}

/// 谱上印的和弦文字 → `chords=` 的 token（`Am7/G` + 时值）。后缀认不出来回 `None`（调用方报警）
pub fn harmony_to_chord_token(text: &str, whole: f64) -> Option<String> {
    let (p, suf, bass) = split_chord_text(&chord_suffix_form(text))?;
    let pitch = text_pitch_to_ly(&p)?;
    let suffix = text_suffix_to_ly(&suf)?;
    let bass = bass.and_then(|b| text_pitch_to_ly(&b));
    Some(format!("{pitch}{}{suffix}{}", duration_text(whole), bass.map(|b| format!("/{b}")).unwrap_or_default()))
}

/// 时值串：精确写法；不精确就配乘数（`c4*31`）；再不行退回最接近的写法
pub fn duration_text(whole: f64) -> String {
    let (text, exact) = whole_to_duration(whole);
    if exact {
        return text;
    }
    for base in [1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0] {
        for dots in 0..4 {
            let v = 1.0 / base + (1.0 / base) * (1.0 - 2f64.powi(-dots));
            let k = whole / v;
            let r = js::round(k);
            if (k - r).abs() < 1e-6 && (2.0..=64.0).contains(&r) {
                return format!("{}{}*{}", js::num_to_string(base), ".".repeat(dots as usize), js::num_to_string(r));
            }
        }
    }
    text
}

/// 和弦时间线上的一项
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct TimelineChord {
    pub text: String,
    pub whole: Option<f64>,
    pub at: f64,
}

/// 一条 `chords=` 行的 **token 序列 + 各自的时间线**（整音符为单位）：读入端、写出端、编辑端共用。
/// 时值没写就沿用上一个，第一个缺省 `fallback_whole`（TS 缺省 0.25）；认不出的 token 跳过、不占时间
pub fn chord_timeline(tokens: &[String], fallback_whole: f64) -> Vec<TimelineChord> {
    let mut out = vec![];
    let mut at = 0.0;
    let mut carried = fallback_whole;
    for tok in tokens {
        let p = parse_chord_token(tok);
        let text = if p.is_some() { chord_token_to_text(tok) } else { None };
        let whole = p.and_then(|p| p.whole);
        let Some(text) = text else { continue };
        out.push(TimelineChord { text, whole, at });
        carried = whole.unwrap_or(carried);
        at += carried;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pitches() {
        assert_eq!(ly_pitch_to_text("bes").as_deref(), Some("Bb"));
        assert_eq!(ly_pitch_to_text("bf").as_deref(), Some("Bb"));
        assert_eq!(ly_pitch_to_text("Fis").as_deref(), Some("F#"));
        assert_eq!(ly_pitch_to_text("css").as_deref(), Some("C")); // `ss` 不在映射里
        assert_eq!(ly_pitch_to_text("h"), None);
        assert_eq!(text_pitch_to_ly("B♭").as_deref(), Some("bes"));
        assert_eq!(text_pitch_to_ly("F##").as_deref(), Some("fisis"));
        assert_eq!(text_pitch_to_ly("F♯♯"), None);
    }

    #[test]
    fn tokens() {
        let p = parse_chord_token("c2.:m7/bes").unwrap();
        assert_eq!((p.pitch.as_str(), p.whole, p.suffix.as_str(), p.bass.as_deref()), ("c", Some(0.75), ":m7", Some("bes")));
        assert_eq!(parse_chord_token("c4*31").unwrap().whole, Some(0.25 * 31.0));
        assert_eq!(parse_chord_token("ces").unwrap().pitch, "ces");
        assert!(parse_chord_token("c.").is_none());
        assert_eq!(chord_token_to_text("a:m7.5-/g").as_deref(), Some("Am7b5/G"));
        assert_eq!(text_suffix_to_ly("13").as_deref(), Some(":$1"));
        assert_eq!(text_suffix_to_ly("M7").as_deref(), Some(":maj7"));
    }

    #[test]
    fn durations() {
        assert_eq!(whole_to_duration(0.75), ("2.".into(), true));
        assert_eq!(duration_text(2.0), "1*2");
        assert_eq!(harmony_to_chord_token("#Fm7/C#", 0.5).as_deref(), Some("fis2:m7/cis"));
        assert_eq!(harmony_to_chord_token("Cxyz", 0.25), None);
    }
}
