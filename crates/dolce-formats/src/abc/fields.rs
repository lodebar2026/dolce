//! 123 的字段表、中文别名与 `I:` 指令（同 `abcfamily/fields.ts`），外加 `sing.ts::parseSing`、`jumpmarks.ts::jumpOrnamentName`、
//! `dialectjcx.ts::parseKeyJcx`、`parsedialect.ts::parseKeyAbc`。正则手写成等价判断（有回退的地方照回退次序试）。

use super::u16s::{self, U16};
use dolce_base::{js, Msg, SourceSpan};
use dolce_model::jianpu::clef_from_name;
use dolce_model::keyshift::fifths_of_spelling;
use dolce_model::{Clef, Key, SingItem, SingPass, Time};
use serde::Serialize;

/// 中文别名 → ASCII 规范形的字段名
pub fn cjk_field_alias(name: &str) -> Option<char> {
    Some(match name {
        "曲号" => 'X',
        "标题" | "副标题" => 'T',
        "词曲" | "作者" => 'C',
        "调" => 'K',
        "拍" => 'M',
        "速度" => 'Q',
        "声部" => 'V',
        "歌词" | "段" => 'w',
        "顺序" => 'P',
        "注" => 'N',
        "文字" => 'W',
        _ => return None,
    })
}

/// 中文别名 → `I:` 子指令（`样式：x` 等价 `I:style x`）
pub fn cjk_instruction_alias(name: &str) -> Option<&'static str> {
    match name {
        "样式" => Some("style"),
        "断行" => Some("linebreak"),
        _ => None,
    }
}

/// 一行头部字段
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldLine {
    /// ASCII 规范形（`w` 与 `W` 区分大小写）
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cont: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_verse: Option<String>,
    pub value: String,
    pub source: SourceSpan,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_offset: Option<u32>,
}

#[inline]
fn colon(u: Option<u16>) -> bool {
    u16s::one_of(u, ":：")
}

/// 试着把一行读成头部字段（不是字段行回 `None`，交给音乐体）
pub fn parse_field_line(line: &U16, line_no: u32, offset: u32) -> Option<FieldLine> {
    let source = SourceSpan { line: line_no, column: 0, offset, length: line.len() as u32 };
    let value_of = |pre: usize| -> (String, u32) {
        let rest = &line[pre..];
        (u16s::text(u16s::trim(rest)), offset + (pre + u16s::spaces(rest, 0)) as u32)
    };
    // `+:` 续行
    if u16s::is(line, 0, '+') {
        let k = 1 + u16s::spaces(line, 1);
        if colon(u16s::at(line, k)) {
            let (value, vo) = value_of(k + 1);
            return Some(FieldLine { name: "w".into(), voice: None, cont: Some(true), legacy_verse: None, value, source, value_offset: Some(vo) });
        }
    }
    // 名字 + 可选数字组 + 可选 `-数字` + `\s*` + 冒号；回 (名字, 数字组 1, 数字组 2, 前缀长度)
    let tail = |k: usize| -> Option<(Option<String>, Option<String>, usize)> {
        let d1 = u16s::digits(line, k);
        let g1 = (d1 > 0).then(|| u16s::text(&line[k..k + d1]));
        let k2 = k + d1;
        // 先试带 `-数字` 的
        if u16s::is(line, k2, '-') {
            let d2 = u16s::digits(line, k2 + 1);
            if d2 > 0 {
                let k3 = k2 + 1 + d2;
                let k4 = k3 + u16s::spaces(line, k3);
                if colon(u16s::at(line, k4)) {
                    return Some((g1, Some(u16s::text(&line[k2 + 1..k3])), k4 + 1));
                }
            }
        }
        let k4 = k2 + u16s::spaces(line, k2);
        colon(u16s::at(line, k4)).then_some((g1, None, k4 + 1))
    };
    let (name, g1, g2, pre) = if let Some(c) = u16s::at(line, 0).and_then(u16s::ch).filter(|c| c.is_ascii_alphabetic()) {
        let (g1, g2, pre) = tail(1)?;
        let name = if c == 'w' || c == 'W' { c } else { c.to_ascii_uppercase() };
        (name, g1, g2, pre)
    } else {
        // `^([一-鿿]{1,4})…`：汉字连着 5 个以上时，第 5 个字接不上后面，整体不认
        let mut k = 0;
        while k < line.len() && u16s::within(Some(line[k]), '\u{4e00}', '\u{9fff}') {
            k += 1;
        }
        if k == 0 || k > 4 {
            return None;
        }
        let (g1, g2, pre) = tail(k)?;
        let name = cjk_field_alias(&u16s::text(&line[..k]))?;
        (name, g1, g2, pre)
    };
    let (value, vo) = value_of(pre);
    let mut f = FieldLine { name: name.to_string(), voice: None, cont: None, legacy_verse: None, value, source, value_offset: Some(vo) };
    if let Some(g1) = &g1 {
        if name == 'V' {
            f.voice = Some(js::number(g1));
        } else {
            f.legacy_verse = Some(match &g2 {
                Some(g2) => format!("{g1}-{g2}"),
                None => g1.clone(),
            });
        }
    }
    if name == 'V' && f.voice.is_none() {
        let d = f.value.bytes().take_while(|b| b.is_ascii_digit()).count();
        if d > 0 {
            f.voice = Some(js::number(&f.value[..d]));
        }
    }
    Some(f)
}

/// `V:n clef=treble-8` 的谱号：`(?:^|\s)clef=([A-Za-z]+[+-]?8?)(?=\s|$)`
pub fn parse_voice_clef(value: &str) -> Option<Clef> {
    let cs: Vec<char> = value.chars().collect();
    let end_ok = |k: usize| k == cs.len() || js::is_space(cs[k]);
    for p in 0..cs.len() {
        if !(p == 0 || js::is_space(cs[p - 1])) {
            continue;
        }
        if !cs[p..].starts_with(&['c', 'l', 'e', 'f', '=']) {
            continue;
        }
        let a = p + 5;
        let mut l = a;
        while l < cs.len() && cs[l].is_ascii_alphabetic() {
            l += 1;
        }
        if l == a {
            continue;
        }
        // 字母取满，后面 `[+-]?8?` 照回退次序试
        let sign = l < cs.len() && (cs[l] == '+' || cs[l] == '-');
        let mut tries = vec![];
        if sign {
            if cs.get(l + 1) == Some(&'8') {
                tries.push(l + 2);
            }
            tries.push(l + 1);
        }
        if cs.get(l) == Some(&'8') {
            tries.push(l + 1);
        }
        tries.push(l);
        if let Some(&e) = tries.iter().find(|&&e| end_ok(e)) {
            let name: String = cs[a..e].iter().collect();
            return clef_from_name(&name);
        }
    }
    None
}

// ───────────────────────── K: 调号 ─────────────────────────

fn fifths_123(sp: &str) -> Option<f64> {
    Some(match sp {
        "C" => 0.0,
        "G" => 1.0,
        "D" => 2.0,
        "A" => 3.0,
        "E" => 4.0,
        "B" => 5.0,
        "#F" => 6.0,
        "#C" => 7.0,
        "F" => -1.0,
        "bB" => -2.0,
        "bE" => -3.0,
        "bA" => -4.0,
        "bD" => -5.0,
        "bG" => -6.0,
        "bC" => -7.0,
        _ => return None,
    })
}

/// 调式 → 相对大调的五度偏移（键序同 TS 对象，`find` 按这个次序）
const MODE_OFFSET: &[(&str, f64)] = &[
    ("major", 0.0),
    ("ionian", 0.0),
    ("minor", -3.0),
    ("aeolian", -3.0),
    ("m", -3.0),
    ("mixolydian", -1.0),
    ("dorian", -2.0),
    ("phrygian", -4.0),
    ("lydian", 1.0),
    ("locrian", -5.0),
];

fn mode_tonic_degree(m: &str) -> Option<&'static str> {
    Some(match m {
        "minor" | "aeolian" | "m" => "6",
        "dorian" => "2",
        "phrygian" => "3",
        "lydian" => "4",
        "mixolydian" => "5",
        "locrian" => "7",
        _ => return None,
    })
}

fn is_acc(c: char) -> bool {
    matches!(c, '#' | 'b' | '♯' | '♭')
}

fn is_letter(c: char) -> bool {
    matches!(c, 'A'..='G' | 'a'..='g')
}

/// `^([#b♯♭]?)([A-Ga-g])([#b♯♭]?)`：前置升降号先吃、接不上字母再退。回 (前, 字母, 后, 吃掉的字符数)
fn spell_head(cs: &[char], acc: fn(char) -> bool) -> Option<(Option<char>, char, Option<char>, usize)> {
    let tryat = |pre: usize| -> Option<(Option<char>, char, Option<char>, usize)> {
        let l = *cs.get(pre)?;
        if !is_letter(l) {
            return None;
        }
        let post = cs.get(pre + 1).copied().filter(|&c| acc(c));
        Some(((pre == 1).then(|| cs[0]), l, post, pre + 1 + post.is_some() as usize))
    };
    if cs.first().is_some_and(|&c| acc(c)) {
        if let Some(r) = tryat(1) {
            return Some(r);
        }
    }
    tryat(0)
}

/// 调号拼写归一成**前置 ASCII** 形（`Bb` → `bB`、`F#` → `#F`、`♭A` → `bA`）
pub fn normalize_spelling(s: &str) -> String {
    let t: String = js::trim(s).replace('♯', "#").replace('♭', "b");
    let cs: Vec<char> = t.chars().collect();
    let acc = |c: char| c == '#' || c == 'b';
    // `^([#b]?)([A-Ga-g])([#b]?)$`：前置号先吃，整串对不上再退
    let full = |pre: usize| -> Option<String> {
        let l = *cs.get(pre).filter(|&&c| is_letter(c))?;
        let post = cs.get(pre + 1).copied().filter(|&c| acc(c));
        if pre + 1 + post.is_some() as usize != cs.len() {
            return None;
        }
        let a = if pre == 1 { Some(cs[0]) } else { post };
        Some(a.map(String::from).unwrap_or_default() + &l.to_ascii_uppercase().to_string())
    };
    let first = if cs.first().is_some_and(|&c| acc(c)) { full(1) } else { None };
    first.or_else(|| full(0)).unwrap_or(t)
}

/// 一次调号读入的结果（`error` 是诊断）
#[derive(Clone, Debug, Serialize)]
pub struct KeyRead {
    pub key: Key,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Msg>,
}

fn key_of(fifths: f64) -> Key {
    Key { fifths, ..Default::default() }
}

fn is_none_word(v: &str) -> bool {
    v.eq_ignore_ascii_case("none")
}

/// 123 的 `K:`：`1=F` 首调形、`F` / `Em` ABC 形、`none`
pub fn parse_key(value: &str) -> KeyRead {
    let v = js::trim(value);
    if v.is_empty() || is_none_word(v) {
        return KeyRead { key: Key { fifths: 0.0, spelling: Some("none".into()), ..Default::default() }, error: None };
    }
    let vc: Vec<char> = v.chars().collect();
    // `^([1-7])\s*=\s*([#b♯♭]?[A-Ga-g][#b♯♭]?)\s*(.*)$`
    let mut tonic_degree: Option<String> = None;
    let mut body: String = v.to_string();
    if vc.first().is_some_and(|c| ('1'..='7').contains(c)) {
        let mut k = 1;
        while k < vc.len() && js::is_space(vc[k]) {
            k += 1;
        }
        if vc.get(k) == Some(&'=') {
            k += 1;
            while k < vc.len() && js::is_space(vc[k]) {
                k += 1;
            }
            if let Some((_, _, _, n)) = spell_head(&vc[k..], is_acc) {
                let g2: String = vc[k..k + n].iter().collect();
                let mut r = k + n;
                while r < vc.len() && js::is_space(vc[r]) {
                    r += 1;
                }
                let g3: String = vc[r..].iter().collect();
                // `(.*)$`：`.` 不过行终止符
                if !g3.chars().any(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')) {
                    tonic_degree = Some(vc[0].to_string());
                    body = if g3.is_empty() { g2 } else { format!("{g2} {g3}") };
                }
            }
        }
    }
    // `^([#b♯♭]?)([A-Ga-g])([#b♯♭]?)\s*([A-Za-z]*)$`
    let bt = js::trim(&body);
    let bc: Vec<char> = bt.chars().collect();
    let bad = || KeyRead { key: key_of(0.0), error: Some(Msg::new("diag.badKey").arg("v", value)) };
    let try_body = |pre_take: bool| -> Option<(Option<char>, char, Option<char>, String)> {
        let pre = if pre_take { Some(*bc.first().filter(|&&c| is_acc(c))?) } else { None };
        let s = pre.is_some() as usize;
        let l = *bc.get(s).filter(|&&c| is_letter(c))?;
        let post = bc.get(s + 1).copied().filter(|&c| is_acc(c));
        let mut k = s + 1 + post.is_some() as usize;
        while k < bc.len() && js::is_space(bc[k]) {
            k += 1;
        }
        let a = k;
        while k < bc.len() && bc[k].is_ascii_alphabetic() {
            k += 1;
        }
        (k == bc.len()).then(|| (pre, l, post, bc[a..k].iter().collect()))
    };
    let Some((pre, l, post, mode_word)) = try_body(true).or_else(|| try_body(false)) else { return bad() };
    let letter = l.to_ascii_uppercase();
    // `(m[1] || m[3] || "").replace("♯", "#").replace("♭", "b")`
    let acc = pre.or(post).map(|c| match c {
        '♯' => '#',
        '♭' => 'b',
        c => c,
    });
    let spelling = normalize_spelling(&format!("{}{letter}", acc.map(String::from).unwrap_or_default()));
    let Some(base) = fifths_123(&spelling) else {
        let mut key = Key { fifths: 0.0, spelling: Some(spelling.clone()), ..Default::default() };
        if let Some(d) = tonic_degree.filter(|d| d != "1") {
            key.tonic_degree = Some(d);
        }
        return KeyRead { key, error: Some(Msg::new("diag.noSuchKey").arg("v", spelling)) };
    };
    let mode_raw = mode_word.to_ascii_lowercase();
    let mode_key: String = if mode_raw == "m" {
        "m".into()
    } else if !mode_raw.is_empty() {
        let p: String = mode_raw.chars().take(3).collect();
        MODE_OFFSET.iter().find(|(k, _)| k.len() > 1 && k.starts_with(&p)).map(|(k, _)| k.to_string()).unwrap_or_default()
    } else {
        String::new()
    };
    let fifths = if !mode_key.is_empty() {
        base + MODE_OFFSET.iter().find(|(k, _)| *k == mode_key).map_or(0.0, |(_, o)| *o)
    } else {
        fifths_of_spelling(&spelling, tonic_degree.as_deref()).unwrap_or(base)
    };
    let mut key = Key { fifths, spelling: Some(spelling), ..Default::default() };
    if !mode_key.is_empty() {
        key.mode = Some(if mode_key == "m" { "minor".into() } else { mode_key.clone() });
    }
    let degree = tonic_degree.or_else(|| if mode_key.is_empty() { None } else { mode_tonic_degree(&mode_key).map(String::from) });
    if let Some(d) = degree.filter(|d| d != "1") {
        key.tonic_degree = Some(d);
    }
    KeyRead { key, error: None }
}

/// ABC 的 `K:`：`C` `F` `Bb` `Em` `Ador` `D bass`
pub fn parse_key_abc(value: &str) -> KeyRead {
    let raw = js::trim(value);
    if raw.is_empty() || is_none_word(raw) {
        return KeyRead { key: key_of(0.0), error: None };
    }
    let bad = || KeyRead { key: key_of(0.0), error: Some(Msg::new("diag.badKey").arg("v", raw)) };
    // `^([A-G])([#b]?)\s*([A-Za-z]*)`
    let cs: Vec<char> = raw.chars().collect();
    let Some(&t) = cs.first().filter(|c| ('A'..='G').contains(c)) else { return bad() };
    let acc = cs.get(1).copied().filter(|&c| c == '#' || c == 'b');
    let mut k = 1 + acc.is_some() as usize;
    while k < cs.len() && js::is_space(cs[k]) {
        k += 1;
    }
    let a = k;
    while k < cs.len() && cs[k].is_ascii_alphabetic() {
        k += 1;
    }
    let tonic = format!("{t}{}", acc.map(String::from).unwrap_or_default());
    let mode_word: String = cs[a..k].iter().collect::<String>().to_ascii_lowercase().chars().take(3).collect();
    let base = match tonic.as_str() {
        "Cb" => -7.0,
        "Gb" => -6.0,
        "Db" => -5.0,
        "Ab" => -4.0,
        "Eb" => -3.0,
        "Bb" => -2.0,
        "F" => -1.0,
        "C" => 0.0,
        "G" => 1.0,
        "D" => 2.0,
        "A" => 3.0,
        "E" => 4.0,
        "B" => 5.0,
        "F#" => 6.0,
        "C#" => 7.0,
        _ => return bad(),
    };
    let shift = if mode_word.is_empty() {
        Some(0.0)
    } else {
        match mode_word.as_str() {
            "maj" | "ion" => Some(0.0),
            "min" | "aeo" | "m" => Some(-3.0),
            "mix" => Some(-1.0),
            "dor" => Some(-2.0),
            "phr" => Some(-4.0),
            "lyd" => Some(1.0),
            "loc" => Some(-5.0),
            _ => None,
        }
    };
    let Some(shift) = shift else {
        return KeyRead { key: Key { fifths: base, spelling: Some(tonic), ..Default::default() }, error: None };
    };
    let mut key = Key { fifths: base + shift, spelling: Some(tonic), ..Default::default() };
    if !mode_word.is_empty() {
        key.mode = Some(
            match mode_word.as_str() {
                "maj" => "major",
                "ion" => "ionian",
                "min" | "m" => "minor",
                "aeo" => "aeolian",
                "mix" => "mixolydian",
                "dor" => "dorian",
                "phr" => "phrygian",
                "lyd" => "lydian",
                _ => "locrian",
            }
            .into(),
        );
    }
    KeyRead { key, error: None }
}

/// Muse 的 `K:`：只取开头的「升降号 + 字母 + 升降号 + 调式词」，拼写按 123 归一
/// （`^([#b♯♭]?[A-Ga-g][#b♯♭]?)(?:\s*(maj|min|ion|aeo|mix|dor|phr|lyd|loc|m)[A-Za-z]*)?(?![A-Za-z])`，不分大小写）
pub fn parse_key_jcx(value: &str) -> KeyRead {
    let v = js::trim(value);
    if v.is_empty() || is_none_word(v) {
        return KeyRead { key: Key { fifths: 0.0, spelling: Some("none".into()), ..Default::default() }, error: None };
    }
    let cs: Vec<char> = v.chars().collect();
    // 不分大小写时 `b` 也认 `B`
    let acc_i = |c: char| matches!(c, '#' | 'b' | 'B' | '♯' | '♭');
    const ALTS: [&str; 10] = ["maj", "min", "ion", "aeo", "mix", "dor", "phr", "lyd", "loc", "m"];
    let letter_at = |k: usize| cs.get(k).is_some_and(|c| c.is_ascii_alphabetic());
    let attempt = |pre: usize| -> Option<String> {
        if !cs.get(pre).is_some_and(|&c| is_letter(c)) {
            return None;
        }
        let mut posts = vec![];
        if cs.get(pre + 1).is_some_and(|&c| acc_i(c)) {
            posts.push(pre + 2);
        }
        posts.push(pre + 1);
        for p in posts {
            let g1: String = cs[..p].iter().collect();
            let mut q = p;
            while q < cs.len() && js::is_space(cs[q]) {
                q += 1;
            }
            let rest: String = cs[q..].iter().collect::<String>().to_ascii_lowercase();
            if let Some(a) = ALTS.iter().find(|a| rest.starts_with(*a)) {
                let g2: String = cs[q..q + a.len()].iter().collect();
                return Some(g1 + &g2);
            }
            if !letter_at(p) {
                return Some(g1);
            }
        }
        None
    };
    let m = if cs.first().is_some_and(|&c| acc_i(c)) { attempt(1).or_else(|| attempt(0)) } else { attempt(0) };
    match m {
        Some(s) => parse_key(&s),
        None => parse_key(v),
    }
}

// ───────────────────────── M: 拍号 ─────────────────────────

#[derive(Clone, Debug, Default, Serialize)]
pub struct TimeRead {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<Time>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Msg>,
}

fn time(beats: f64, beat_type: f64) -> Time {
    Time { beats, beat_type, symbol: None, parenthesized: None }
}

/// `\d+\s*\/\s*\d+` 从 `k` 起：回 (分子, 分母, 末尾)
fn frac_at(cs: &[char], k: usize) -> Option<(f64, f64, usize)> {
    let digs = |k: usize| cs[k..].iter().take_while(|c| c.is_ascii_digit()).count();
    let skip = |mut k: usize| {
        while k < cs.len() && js::is_space(cs[k]) {
            k += 1;
        }
        k
    };
    let d1 = digs(k);
    if d1 == 0 {
        return None;
    }
    let mut j = skip(k + d1);
    if cs.get(j) != Some(&'/') {
        return None;
    }
    j = skip(j + 1);
    let d2 = digs(j);
    if d2 == 0 {
        return None;
    }
    let n = |a: usize, b: usize| js::number(&cs[a..b].iter().collect::<String>());
    Some((n(k, k + d1), n(j, j + d2), j + d2))
}

pub fn parse_time(value: &str) -> TimeRead {
    let v = js::trim(value);
    if v.eq_ignore_ascii_case("C|") {
        return TimeRead { time: Some(Time { symbol: Some("cut".into()), ..time(2.0, 2.0) }), error: None };
    }
    if v.eq_ignore_ascii_case("C") {
        return TimeRead { time: Some(Time { symbol: Some("common".into()), ..time(4.0, 4.0) }), error: None };
    }
    if is_none_word(v) {
        return TimeRead::default();
    }
    let cs: Vec<char> = v.chars().collect();
    match frac_at(&cs, 0) {
        Some((b, t, e)) if e == cs.len() => TimeRead { time: Some(time(b, t)), error: None },
        _ => TimeRead { time: None, error: Some(Msg::new("diag.badTime").arg("v", value)) },
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct TimesRead {
    pub times: Vec<Time>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Msg>,
}

/// 头部的 `M:`：并排几个拍号（混合拍）＋可跟一段说明文字
pub fn parse_times(value: &str) -> TimesRead {
    let v = js::trim(value);
    let cs: Vec<char> = v.chars().collect();
    let mut times = vec![];
    let mut in_paren = false;
    let mut k = 0;
    let skip = |mut k: usize| {
        while k < cs.len() && js::is_space(cs[k]) {
            k += 1;
        }
        k
    };
    // `^\s*(\()?\s*(\d+)\s*\/\s*(\d+)\s*(\))?`
    loop {
        let mut j = skip(k);
        let open = cs.get(j) == Some(&'(');
        if open {
            j += 1;
        }
        j = skip(j);
        let Some((b, t, e)) = frac_at(&cs, j) else { break };
        let mut e2 = skip(e);
        let close = cs.get(e2) == Some(&')');
        if close {
            e2 += 1;
        } else {
            e2 = e;
            // `\s*(\))?`：没有右括号时 `\s*` 照样吃掉空白
            e2 = skip(e2);
        }
        if open {
            in_paren = true;
        }
        let mut tm = time(b, t);
        if in_paren {
            tm.parenthesized = Some(true);
        }
        times.push(tm);
        if close {
            in_paren = false;
        }
        k = e2;
    }
    let note: String = js::trim(&cs[k..].iter().collect::<String>()).to_string();
    let note_ok = note.is_empty() || {
        let nc: Vec<char> = note.chars().collect();
        let s = if matches!(nc[0], '(' | '（' | '〔' | '【') { 1 } else { 0 };
        nc.get(s).is_some_and(|c| ('\u{4e00}'..='\u{9fff}').contains(c))
    };
    if times.is_empty() || !note_ok || (times.len() == 1 && note.is_empty()) {
        let one = parse_time(v);
        return TimesRead { times: one.time.into_iter().collect(), note: None, error: one.error };
    }
    TimesRead { times, note: (!note.is_empty()).then_some(note), error: None }
}

// ───────────────────────── Q: 速度 ─────────────────────────

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum TempoPart {
    Num(f64),
    Text(String),
}

/// 去掉 `"…"`（`replace(/"[^"]*"/g, "")`），并收出各段引号里的文字
fn split_quotes(v: &str) -> (Vec<String>, String) {
    let mut texts = vec![];
    let mut bare = String::new();
    let mut rest = v;
    while let Some(a) = rest.find('"') {
        let after = &rest[a + 1..];
        match after.find('"') {
            Some(b) => {
                bare.push_str(&rest[..a]);
                texts.push(after[..b].to_string());
                rest = &after[b + 1..];
            }
            None => break,
        }
    }
    bare.push_str(rest);
    (texts, bare)
}

/// `(?:\d+\s*\/\s*\d+\s*=\s*)?` 从 `k` 起：回 (分子, 分母, `=` 后跳过空白的位置)
fn beat_prefix(cs: &[char], k: usize) -> Option<(f64, f64, usize)> {
    let (n, d, mut e) = frac_at(cs, k)?;
    while e < cs.len() && js::is_space(cs[e]) {
        e += 1;
    }
    if cs.get(e) != Some(&'=') {
        return None;
    }
    e += 1;
    while e < cs.len() && js::is_space(cs[e]) {
        e += 1;
    }
    Some((n, d, e))
}

/// `Q:1/4=76` / `Q:76` / `Q:"欢快地"` / `Q:1/4=76 "欢快地"`
pub fn parse_tempo(value: &str) -> Vec<TempoPart> {
    let v = js::trim(value);
    let (texts, bare) = split_quotes(v);
    let mut out: Vec<TempoPart> = texts.into_iter().map(TempoPart::Text).collect();
    let cs: Vec<char> = bare.chars().collect();
    let digs = |k: usize| cs[k..].iter().take_while(|c| c.is_ascii_digit()).count();
    for i in 0..cs.len() {
        let at = beat_prefix(&cs, i).map(|(_, _, e)| e).filter(|&e| digs(e) > 0).unwrap_or(i);
        let d = digs(at);
        if d > 0 {
            out.insert(0, TempoPart::Num(js::number(&cs[at..at + d].iter().collect::<String>())));
            break;
        }
    }
    out
}

/// `Q:3/8=60` 的拍单位；没写单位或就是 1/4 时 `None`
pub fn parse_tempo_beat(value: &str) -> Option<(f64, f64)> {
    let (_, bare) = split_quotes(value);
    let cs: Vec<char> = bare.chars().collect();
    for i in 0..cs.len() {
        if let Some((n, d, e)) = beat_prefix(&cs, i) {
            if cs.get(e).is_some_and(|c| c.is_ascii_digit()) {
                return (n > 0.0 && d > 0.0 && n * 4.0 != d).then_some((n, d));
            }
        }
    }
    None
}

// ───────────────────────── I: 指令 ─────────────────────────

#[derive(Clone, Debug, Serialize)]
pub struct Instruction {
    pub name: String,
    pub value: String,
}

/// `I:style book.ss` → `{ name: "style", value: "book.ss" }`
pub fn parse_instruction(value: &str) -> Instruction {
    let v = js::trim(value);
    let Some(k) = v.find(js::is_space) else {
        return Instruction { name: v.to_lowercase(), value: String::new() };
    };
    if v.is_empty() {
        return Instruction { name: String::new(), value: String::new() };
    }
    let rest = v[k..].trim_start_matches(js::is_space);
    Instruction { name: v[..k].to_lowercase(), value: rest.to_string() }
}

/// `I:linebreak` 的取值：`<none>` / `!` 是自动断行，其余照写的断
pub fn parse_linebreak(value: &str) -> &'static str {
    let v = js::trim(value).to_lowercase();
    if v == "<none>" || v == "!" { "auto" } else { "explicit" }
}

// ───────────────────────── %%sing ─────────────────────────

/// 段落名能不能用：不能有空白、`@`、`/`、`,`、`*`、方括号（`,` `*` 留给 `%%layout` 的断点引用）
pub fn is_section_name(name: &str) -> bool {
    !name.is_empty() && !name.chars().any(|c| js::is_space(c) || matches!(c, '@' | '/' | ',' | '*' | '[' | ']'))
}

/// 一行 `%%sing` 的正文 → 一遍。写错的项报给 `bad` 并跳过；一项都没有回 `None`
pub fn parse_sing(body: &str, mut bad: impl FnMut(&str)) -> Option<SingPass> {
    let mut page = SingPass { items: vec![] };
    for tok in js::trim(body).split(js::is_space).filter(|t| !t.is_empty()) {
        // `^([^@\s/,*[\]]+)(?:@(\d+))?$`
        let (name, verse) = match tok.split_once('@') {
            Some((n, d)) => (n, Some(d)),
            None => (tok, None),
        };
        let verse_ok = verse.is_none_or(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()) && js::number(d) >= 1.0);
        if !is_section_name(name) || !verse_ok {
            bad(tok);
            continue;
        }
        page.items.push(SingItem { section: name.to_string(), verse: verse.filter(|d| *d != "1").map(js::number) });
    }
    if page.items.is_empty() {
        return None;
    }
    Some(page)
}

/// `Song.singOrder` → `%%sing` 行
pub fn sing_lines(song: &dolce_model::Song) -> Vec<String> {
    song.sing_order
        .iter()
        .flatten()
        .map(|pg| {
            let toks: Vec<String> = pg
                .items
                .iter()
                .map(|it| {
                    let v = it.verse.unwrap_or(1.0);
                    if v != 1.0 { format!("{}@{}", it.section, js::num_to_string(v)) } else { it.section.clone() }
                })
                .collect();
            format!("%%sing {}", toks.join(" "))
        })
        .collect()
}

// ───────────────────────── %%layout ─────────────────────────

pub use dolce_model::layouts::{builtin_layout, layout_base, BUILTIN_LAYOUTS};

/// `linebreak=` 的取值是否合法：`source` / `phrase` / `fill` / `auto` / `bars:N`
pub fn is_linebreak_value(v: &str) -> bool {
    dolce_model::layouts::LineBreak::parse(v).is_some()
}

/// `A` / `A*2` → (段名, 第几次)
fn parse_section_ref(tok: &str) -> Option<(String, Option<f64>)> {
    let (name, nth) = match tok.split_once('*') {
        Some((n, k)) => {
            if k.is_empty() || !k.bytes().all(|b| b.is_ascii_digit()) || js::number(k) < 1.0 {
                return None;
            }
            (n, Some(js::number(k)).filter(|k| *k != 1.0))
        }
        None => (tok, None),
    };
    is_section_name(name).then(|| (name.to_string(), nth))
}

fn section_ref_text(b: &dolce_model::LayoutBreak) -> String {
    match b.nth.filter(|k| *k != 1.0) {
        Some(k) => format!("{}*{}", b.section, js::num_to_string(k)),
        None => b.section.clone(),
    }
}

fn positive_int(v: &str) -> Option<f64> {
    (!v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()) && js::number(v) >= 1.0).then(|| js::number(v))
}

/// 一行 `%%layout` 的正文并进 `layouts`（同名版面写几行按序合并）。写错的项报给 `bad`（原文片段）并跳过
pub fn parse_layout(body: &str, layouts: &mut Vec<dolce_model::LayoutSpec>, mut bad: impl FnMut(&str)) {
    use dolce_model::{LayoutBreak, LayoutPass, LayoutSpec};
    let mut toks = js::trim(body).split(js::is_space).filter(|t| !t.is_empty());
    let Some(raw_name) = toks.next() else {
        bad(body);
        return;
    };
    if raw_name.contains('=') {
        bad(raw_name);
        return;
    }
    let name = builtin_layout(raw_name).map(str::to_string).unwrap_or_else(|| raw_name.to_string());
    let opts: Vec<(&str, &str)> = toks
        .filter_map(|t| match t.split_once('=') {
            Some((k, v)) if !k.is_empty() => Some((k, v)),
            _ => {
                bad(t);
                None
            }
        })
        .collect();
    let idx = match layouts.iter().position(|l| l.name == name) {
        Some(i) => i,
        None => {
            layouts.push(LayoutSpec { name: name.clone(), ..Default::default() });
            layouts.len() - 1
        }
    };
    let spec = &mut layouts[idx];
    // `base=` 先看，选项适用表要按它定档
    for (k, v) in &opts {
        if k.eq_ignore_ascii_case("base") {
            match builtin_layout(v) {
                Some(b) if builtin_layout(&name).is_none_or(|own| own == b) => spec.base = builtin_layout(&name).is_none().then(|| b.to_string()),
                _ => bad(&format!("{k}={v}")),
            }
        }
    }
    let projection = layout_base(spec) == Some("投影") || (builtin_layout(&name).is_none() && spec.base.is_none());
    let mut pass: Option<f64> = None;
    for (k, v) in &opts {
        if k.eq_ignore_ascii_case("pass") {
            match positive_int(v) {
                Some(n) if projection => pass = Some(n),
                _ => bad(&format!("{k}={v}")),
            }
        }
    }
    for (k, v) in opts {
        let key = k.to_ascii_lowercase();
        let ok = match key.as_str() {
            "base" | "pass" => true,
            "linebreak" if pass.is_none() && is_linebreak_value(v) => {
                spec.linebreak = Some(v.to_string());
                true
            }
            "rows" if projection => match positive_int(v) {
                Some(n) => {
                    match pass {
                        Some(p) => {
                            let ps = spec.passes.get_or_insert_with(Vec::new);
                            match ps.iter_mut().find(|x| x.pass == p) {
                                Some(x) => x.rows = Some(n),
                                None => ps.push(LayoutPass { pass: p, rows: Some(n) }),
                            }
                        }
                        None => spec.rows = Some(n),
                    }
                    true
                }
                None => false,
            },
            "pair-pages" | "no-intro" if projection && pass.is_none() && (v == "on" || v == "off") => {
                let on = Some(v == "on");
                if key == "pair-pages" { spec.pair_pages = on } else { spec.no_intro = on }
                true
            }
            "paper" if pass.is_none() && !v.is_empty() => {
                spec.paper = Some(v.to_string());
                true
            }
            "page-orientation" if pass.is_none() && !v.is_empty() => {
                spec.page_orientation = Some(v.to_string());
                true
            }
            "note-size" if pass.is_none() => match v.parse::<f64>() {
                Ok(n) if n > 0.0 => {
                    spec.note_size = Some(n);
                    true
                }
                _ => false,
            },
            "style" if pass.is_none() && !v.is_empty() => {
                spec.style = Some(v.to_string());
                true
            }
            "break" | "newpage" => {
                let refs: Vec<_> = v.split(',').map(parse_section_ref).collect();
                if refs.is_empty() || refs.iter().any(Option::is_none) {
                    false
                } else {
                    let page = (key == "newpage").then_some(true);
                    let bs = spec.breaks.get_or_insert_with(Vec::new);
                    for (section, nth) in refs.into_iter().flatten() {
                        let b = LayoutBreak { pass, section, nth, page };
                        if !bs.contains(&b) {
                            bs.push(b);
                        }
                    }
                    true
                }
            }
            _ => false,
        };
        if !ok {
            bad(&format!("{k}={v}"));
        }
    }
    if let Some(ps) = spec.passes.as_mut() {
        ps.sort_by(|a, b| a.pass.total_cmp(&b.pass));
    }
}

/// `Song.layouts` → `%%layout` 行：每个版面一行整体选项（含不限遍的断点），再每遍一行
pub fn layout_lines(song: &dolce_model::Song) -> Vec<String> {
    let mut out = vec![];
    for spec in song.layouts.iter().flatten() {
        let breaks = spec.breaks.as_deref().unwrap_or_default();
        let refs = |pass: Option<f64>, page: bool| -> Option<String> {
            let v: Vec<String> = breaks.iter().filter(|b| b.pass == pass && b.page.unwrap_or(false) == page).map(section_ref_text).collect();
            (!v.is_empty()).then(|| v.join(","))
        };
        let mut head = vec![format!("%%layout {}", spec.name)];
        let mut push = |k: &str, v: Option<String>| {
            if let Some(v) = v {
                head.push(format!("{k}={v}"));
            }
        };
        push("base", spec.base.clone());
        push("linebreak", spec.linebreak.clone());
        push("rows", spec.rows.map(js::num_to_string));
        push("pair-pages", spec.pair_pages.map(|b| if b { "on" } else { "off" }.to_string()));
        push("no-intro", spec.no_intro.map(|b| if b { "on" } else { "off" }.to_string()));
        push("paper", spec.paper.clone());
        push("page-orientation", spec.page_orientation.clone());
        push("note-size", spec.note_size.map(js::num_to_string));
        push("style", spec.style.clone());
        push("break", refs(None, false));
        push("newpage", refs(None, true));
        let mut passes: Vec<f64> = breaks.iter().filter_map(|b| b.pass).chain(spec.passes.iter().flatten().map(|p| p.pass)).collect();
        passes.sort_by(f64::total_cmp);
        passes.dedup();
        if head.len() > 1 || passes.is_empty() {
            out.push(head.join(" "));
        }
        for p in passes {
            let mut line = vec![format!("%%layout {} pass={}", spec.name, js::num_to_string(p))];
            if let Some(r) = spec.passes.iter().flatten().find(|x| x.pass == p).and_then(|x| x.rows) {
                line.push(format!("rows={}", js::num_to_string(r)));
            }
            if let Some(v) = refs(Some(p), false) {
                line.push(format!("break={v}"));
            }
            if let Some(v) = refs(Some(p), true) {
                line.push(format!("newpage={v}"));
            }
            out.push(line.join(" "));
        }
    }
    out
}

/// 内部短名 → 123 记号名（`jumpmarks.ts::BARLINE_ORNAMENT_NAME`）
pub fn barline_ornament_name(name: &str) -> Option<&'static str> {
    Some(match name {
        "hs" => "segno",
        "ty" => "coda",
        "ds" => "D.S.",
        "dc" => "D.C.",
        "fine" => "fine",
        _ => return None,
    })
}

/// 123 的 `!xx!` 是不是小节线上的跳转记号；是则给出内部短名（`jumpmarks.ts`）
pub fn jump_ornament_name(deco: &str) -> Option<&'static str> {
    let k: String = js::trim(deco).to_lowercase().chars().filter(|&c| c != '.' && !js::is_space(c)).collect();
    Some(match k.as_str() {
        "segno" => "hs",
        "coda" | "dacoda" | "tocoda" => "ty",
        "ds" | "dalsegno" => "ds",
        "dc" | "dacapo" => "dc",
        "fine" => "fine",
        _ => return None,
    })
}
