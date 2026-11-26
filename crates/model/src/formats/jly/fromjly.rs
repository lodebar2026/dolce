//! jianpu-ly 的**词法与装配**（同 `jly/fromjly.ts`，判据、注释里的实测结论都在那边）。
//!
//! 目标语法 = 上游 jianpu-ly README（v1.890）。与 123 的关键差异：词内顺序无关（`#1`=`1#`、`s1`=`1s`）、
//! 时值是字母（`s` `q` `d` `h`，或 `\` `\\`）、连音 `3[ … ]`。本版不收的写法一律进 [`JlyLosses`] → 诊断，不静默丢。
//!
//! 位置一律按 UTF-16 码元（行、列、全文偏移），同 TS。行内按码元切词，词本身转成 Rust 字符串判断
//! （语法字符都在 ASCII；孤立代理经 `from_utf16_lossy` 成 U+FFFD，已知出入）。
//! TS 靠对象引用串起来的「上一个和弦」「歌词位置」改记位置（声部、小节、元素下标）：小节与元素在读的过程中只往后追加，
//! 下标稳定；小节反复的展开在歌词对位之后才做。

use crate::formats::abc::u16s;
use crate::base::js;
use crate::base::msg::Msg;
use crate::base::text::SourceSpan;
use crate::helpers::{empty_doc, empty_song, IdGen, ZERO_SPAN};
use crate::marknames::DYNAMIC_NAMES;
use crate::*;
use serde::Serialize;

use super::chords::{ly_pitch_to_text, ly_suffix_to_text, parse_chord_token};

// ───────────────────────── 词法 ─────────────────────────

/// 多音和弦里第 2…n 个音（字段同 [`JlyGraceNote`]）
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct JlyChordNote {
    pub degree: f64,
    pub alter: String,
    pub octave: f64,
    pub dots: f64,
    pub beams: f64,
}

pub type JlyGraceNote = JlyChordNote;

/// 一个音符 token。`beams` 是减时线条数（0 = 四分）
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct JlyNote {
    /// 1–7；`0` 是休止
    pub degree: f64,
    pub alter: String,
    pub octave: f64,
    pub beams: f64,
    pub dots: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chord: Option<Vec<JlyChordNote>>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum JlyToken {
    Note(JlyNote),
    Sustain,
    Bar,
    Tie,
    SlurOpen { melisma: bool },
    SlurClose { melisma: bool },
    TupletOpen { n: f64 },
    TupletClose,
    Text { above: bool, value: String },
    Jump { text: String },
    Dynamic { name: String },
    Fermata,
    Grace { notes: Vec<JlyGraceNote> },
    RepeatOpen,
    AltOpen,
    RepeatClose,
    PercentOpen { times: f64 },
    Multirest { n: f64 },
    Break { page: bool },
    Barstyle { style: String },
    /// 认出来但本版不收（`what` 是提示键，或 `grace` / `backslash`）
    Loss { what: String },
}

/// 一个 token 在本行里的列号与长度（0 基，UTF-16）
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct JlyPos {
    pub col: usize,
    pub len: usize,
}

fn letter_beams(c: char) -> Option<f64> {
    match c {
        'q' => Some(1.0),
        's' => Some(2.0),
        'd' => Some(3.0),
        'h' => Some(4.0),
        _ => None,
    }
}

/// 变音写法 → 模型临时记号（`#` `b` `n` `##` `bb`）
fn acc_of(s: &str) -> Option<Accidental> {
    match s {
        "#" => Some(Accidental::Sharp),
        "b" => Some(Accidental::Flat),
        "n" => Some(Accidental::Natural),
        "##" => Some(Accidental::DoubleSharp),
        "bb" => Some(Accidental::DoubleFlat),
        _ => None,
    }
}

/// 跳转记号裸词（`tojly.ts::BARE_DIRECTION`：`/^(Fine|D\.?C\.?|Segno|ToCoda|D\.?S\.?)$/i`）。写出端迁过来时共用
pub fn is_bare_direction(word: &str) -> bool {
    let w = word.to_ascii_lowercase();
    matches!(w.as_str(), "fine" | "segno" | "tocoda") || {
        let b = w.as_bytes();
        b.first() == Some(&b'd') && {
            let mut i = 1;
            if b.get(i) == Some(&b'.') {
                i += 1;
            }
            if matches!(b.get(i), Some(b'c') | Some(b's')) {
                i += 1;
                if b.get(i) == Some(&b'.') {
                    i += 1;
                }
                i == b.len()
            } else {
                false
            }
        }
    }
}

/// 跳转记号写成规范形（`dc` → `D.C.`）；表里没有的原样
fn canonical_jump(word: &str) -> String {
    match word.to_ascii_lowercase().as_str() {
        "fine" => "Fine".into(),
        "dc" | "d.c." => "D.C.".into(),
        "ds" | "d.s." => "D.S.".into(),
        "segno" => "Segno".into(),
        "tocoda" => "ToCoda".into(),
        _ => word.into(),
    }
}

/// 规范词 → 小节线记号短名（`Barline.ornaments`）；不在表里的（如 `D.C` 少一个点）TS 落成 `fine`，照搬
fn jump_short(text: &str) -> &'static str {
    match text {
        "Fine" => "fine",
        "D.C." => "dc",
        "D.S." => "ds",
        "Segno" => "hs",
        "ToCoda" => "ty",
        _ => "fine",
    }
}

/// 报告册：同一条提示只记一次（附原文例子与首个落点）
#[derive(Clone, Debug, Default)]
pub struct JlyLosses {
    seen: Vec<(Msg, String, Option<SourceSpan>)>,
}

impl JlyLosses {
    pub fn new() -> JlyLosses {
        JlyLosses::default()
    }
    pub fn add(&mut self, what: Msg, raw: &str, span: Option<SourceSpan>) {
        if !self.seen.iter().any(|(m, _, _)| *m == what) {
            self.seen.push((what, raw.into(), span));
        }
    }
    /// 给人看的清单：每条是 `diag.jly.example { what, raw }`（TS `list()` 当场出字，这里只给键，门面按界面语言出字）
    pub fn list(&self) -> Vec<Msg> {
        self.seen.iter().map(|(what, raw, _)| Msg::new("diag.jly.example").arg("what", what.clone()).arg("raw", raw.as_str())).collect()
    }
    /// → 模型诊断（拿不到落点的给零区间）
    pub fn diagnostics(&self) -> Vec<Diagnostic> {
        self.seen
            .iter()
            .map(|(what, _, span)| Diagnostic {
                severity: DiagnosticSeverity::Warning,
                code: "jly-unsupported".into(),
                msg: Msg::new("diag.jly.skipped").arg("what", what.clone()),
                source: span.unwrap_or(ZERO_SPAN),
            })
            .collect()
    }
}

/// 本版不收的写法（`NOT_YET` 表，按次序）
fn not_yet(word: &str) -> Option<&'static str> {
    const LAYOUT: &[&str] = &[
        "KeepLength", "ChordsRoman", "NoBarNums", "NoIndent", "OnePage", "RaggedLast", "SeparateTimesig", "angka", "WithStaff", "PartMidi",
        "RepeatAccidentals", "NormalAccidentals",
    ];
    let rest_alnum = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
    if word == "x" {
        Some("diag.jly.nyPercussion")
    } else if matches!(word, "LP:" | ":LP" | "LPH:" | ":LPH") {
        Some("diag.jly.nyLp")
    } else if LAYOUT.contains(&word) {
        Some("diag.jly.nyLayout")
    } else if ["chords=", "frets=", "instrument="].iter().any(|p| word.starts_with(p)) {
        Some("diag.jly.nyChords")
    } else if matches!(word, "arp" | "arpUp" | "arpDown") {
        Some("diag.jly.nyArp")
    } else if ["Fr=", "slide", "souyin", "harmonic", "bend"].iter().any(|p| word.starts_with(p)) {
        Some("diag.jly.nyErhu")
    } else if word.strip_prefix("letter").is_some_and(rest_alnum) || matches!(word, "glis" | "Harm:") {
        Some("diag.jly.nyMisc")
    } else if matches!(word, "<" | ">") {
        Some("diag.jly.nyOctaveShift")
    } else if matches!(word, "8" | "9") {
        Some("diag.jly.nyOctaveKey")
    } else if word.starts_with('\\') {
        Some("diag.jly.nyCommand")
    } else {
        None
    }
}

/// 从 `cs[i]` 起认一个变音（先两字符 `##` / `bb`，再单字符）；回 (写法, 占几个字符)
fn take_acc(cs: &[char], i: usize) -> Option<(String, usize)> {
    if i + 1 < cs.len() {
        let two: String = cs[i..i + 2].iter().collect();
        if acc_of(&two).is_some() {
            return Some((two, 2));
        }
    }
    let one = cs.get(i)?.to_string();
    acc_of(&one).map(|_| (one, 1))
}

/// `g[#45]` / `g[d4d5s6]` 里的音。倚音和弦（`g[1&3&5]`）本版不收
fn parse_grace(inner: &str, loss: &mut JlyLosses, span: Option<SourceSpan>) -> Option<Vec<JlyGraceNote>> {
    if inner.contains('&') {
        loss.add(Msg::new("diag.jly.graceChord"), inner, span);
        return None;
    }
    let cs: Vec<char> = inner.chars().collect();
    let mut out = vec![];
    let mut i = 0;
    while i < cs.len() {
        let mut beams = 1.0; // 未记时值 = 八分
        if let Some(b) = letter_beams(cs[i]) {
            beams = b;
            i += 1;
        }
        let mut alter = String::new();
        if let Some((a, n)) = take_acc(&cs, i) {
            alter = a;
            i += n;
        }
        if !cs.get(i).is_some_and(|c| ('0'..='7').contains(c)) {
            loss.add(Msg::new("diag.jly.graceBad"), inner, span);
            return None;
        }
        let degree = (cs[i] as u32 - '0' as u32) as f64;
        i += 1;
        let mut octave = 0.0;
        let mut dots = 0.0;
        while i < cs.len() && matches!(cs[i], '\'' | ',' | '.') {
            match cs[i] {
                '\'' => octave += 1.0,
                ',' => octave -= 1.0,
                _ => dots += 1.0,
            }
            i += 1;
        }
        out.push(JlyChordNote { degree, alter, octave, dots, beams });
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// 一个词（空格分隔）→ token。顺序无关：先把词里所有记号认出来，再判断合不合法。`span` 只用于把「本版不收」的落点记进报告册
pub fn scan_word(word: &str, loss: &mut JlyLosses, span: Option<SourceSpan>) -> Option<JlyToken> {
    use JlyToken as T;
    match word {
        "-" => return Some(T::Sustain),
        "~" => return Some(T::Tie),
        "(" => return Some(T::SlurOpen { melisma: true }),
        ")" => return Some(T::SlurClose { melisma: true }),
        "\\(" => return Some(T::SlurOpen { melisma: false }),
        "\\)" => return Some(T::SlurClose { melisma: false }),
        "]" => return Some(T::TupletClose),
        _ => {}
    }
    if !word.is_empty() && word.bytes().all(|b| b == b'|') {
        return Some(T::Bar);
    }
    if let Some(d) = word.strip_suffix('[').filter(|d| all_digits(d)) {
        return Some(T::TupletOpen { n: js::number(d) });
    }
    {
        let cs: Vec<char> = word.chars().collect();
        if cs.len() >= 3 && matches!(cs[0], '^' | '_') && cs[1] == '"' && cs[cs.len() - 1] == '"' {
            return Some(T::Text { above: cs[0] == '^', value: cs[2..cs.len() - 1].iter().collect() });
        }
    }
    if is_bare_direction(word) {
        return Some(T::Jump { text: canonical_jump(word) });
    }
    if let Some(name) = word.strip_prefix('\\').filter(|n| DYNAMIC_NAMES.contains(n)) {
        return Some(T::Dynamic { name: name.into() });
    }
    match word {
        "\\fermata" => return Some(T::Fermata),
        "\\break" => return Some(T::Break { page: false }),
        "\\pageBreak" => return Some(T::Break { page: true }),
        _ => {}
    }
    if let Some(d) = word.strip_prefix("R*").filter(|d| all_digits(d)) {
        return Some(T::Multirest { n: js::number(d) });
    }
    if word == "R{" {
        return Some(T::RepeatOpen);
    }
    if let Some(d) = word.strip_prefix('R').and_then(|w| w.strip_suffix('{')) {
        if all_digits(d) && !d.starts_with('0') {
            return Some(T::PercentOpen { times: js::number(d) });
        }
    }
    if word == "A{" {
        return Some(T::AltOpen);
    }
    if word == "}" {
        return Some(T::RepeatClose);
    }
    if let Some(inner) = word.strip_prefix("g[").and_then(|w| w.strip_suffix(']')) {
        return Some(match parse_grace(inner, loss, span) {
            Some(notes) => T::Grace { notes },
            None => T::Loss { what: "grace".into() },
        });
    }
    if let Some(what) = not_yet(word) {
        loss.add(Msg::new(what), word, span);
        return Some(T::Loss { what: what.into() });
    }
    // 多音和弦必须在单音解析之前（单音那条路碰到第二个数字就回 None）
    if word.chars().filter(|c| ('0'..='7').contains(c)).count() >= 2 {
        if let Some(chord) = scan_chord_word(word) {
            return Some(T::Note(chord));
        }
    }
    let cs: Vec<char> = word.chars().collect();
    let mut i = 0;
    let mut alter = String::new();
    let mut degree: Option<f64> = None;
    let mut octave = 0.0;
    let mut beams = 0.0;
    let mut dots = 0.0;
    let mut backslashes = 0;
    while i < cs.len() {
        let c = cs[i];
        if matches!(c, '#' | 'b' | 'n') {
            if alter.is_empty() {
                if let Some((a, n)) = take_acc(&cs, i) {
                    alter = a;
                    i += n;
                    continue;
                }
            }
            return None;
        }
        match c {
            '\'' => octave += 1.0,
            ',' => octave -= 1.0,
            '.' => dots += 1.0,
            '\\' => backslashes += 1,
            '0'..='7' => {
                if degree.is_some() {
                    return None;
                }
                degree = Some((c as u32 - '0' as u32) as f64);
            }
            _ => beams = letter_beams(c)?,
        }
        i += 1;
    }
    let Some(degree) = degree else {
        if backslashes > 0 {
            loss.add(Msg::new("diag.jly.backslash"), word, span);
            return Some(T::Loss { what: "backslash".into() });
        }
        return None;
    };
    if backslashes > 0 {
        beams = if backslashes == 1 { 1.0 } else { 2.0 };
    }
    Some(T::Note(JlyNote { degree, alter, octave, beams, dots, chord: None }))
}

/// 多音和弦词（`,135'`、`q,135`）→ 一个音符（首音在外层，其余进 `chord`）；认不出回 `None`
fn scan_chord_word(word: &str) -> Option<JlyNote> {
    let cs: Vec<char> = word.chars().collect();
    let mut i = 0;
    let mut beams = 0.0f64;
    while i < cs.len() && (letter_beams(cs[i]).is_some() || cs[i] == '\\') {
        if cs[i] == '\\' {
            beams = (beams + 1.0).min(2.0);
        } else {
            beams = letter_beams(cs[i]).unwrap();
        }
        i += 1;
    }
    let mut j = cs.len();
    let mut dots = 0.0;
    while j > i && cs[j - 1] == '.' {
        dots += 1.0;
        j -= 1;
    }
    let body = &cs[i..j];
    let mut notes: Vec<JlyChordNote> = vec![];
    let mut k = 0;
    while k < body.len() {
        let mut octave = 0.0;
        let mut alter = String::new();
        while k < body.len() && matches!(body[k], '\'' | ',') {
            octave += if body[k] == '\'' { 1.0 } else { -1.0 };
            k += 1;
        }
        if let Some((a, n)) = take_acc(body, k) {
            alter = a;
            k += n;
        }
        let c = *body.get(k)?;
        if !('1'..='7').contains(&c) {
            return None;
        }
        k += 1;
        while k < body.len() && matches!(body[k], '\'' | ',') {
            octave += if body[k] == '\'' { 1.0 } else { -1.0 };
            k += 1;
        }
        notes.push(JlyChordNote { degree: (c as u32 - '0' as u32) as f64, alter, octave, dots: 0.0, beams });
    }
    if notes.len() < 2 {
        return None;
    }
    let first = notes.remove(0);
    Some(JlyNote { degree: first.degree, alter: first.alter, octave: first.octave, beams, dots, chord: Some(notes) })
}

// ───────────────────────── 行的分类 ─────────────────────────

/// `\d+` 起头的一段（ASCII 数字），回结束位置
fn digits_end(b: &[u8], i: usize) -> usize {
    let mut k = i;
    while k < b.len() && b[k].is_ascii_digit() {
        k += 1;
    }
    k
}

/// `^\d+\/\d+(,\d+)?$`：拍号行（回分子、分母、有没有弱起后缀）
fn time_line(t: &str) -> Option<(f64, f64, bool)> {
    let b = t.as_bytes();
    let e1 = digits_end(b, 0);
    if e1 == 0 || b.get(e1) != Some(&b'/') {
        return None;
    }
    let e2 = digits_end(b, e1 + 1);
    if e2 == e1 + 1 {
        return None;
    }
    let mut anac = false;
    if e2 < b.len() {
        if b[e2] != b',' {
            return None;
        }
        let e3 = digits_end(b, e2 + 1);
        if e3 == e2 + 1 || e3 != b.len() {
            return None;
        }
        anac = true;
    }
    Some((js::number(&t[..e1]), js::number(&t[e1 + 1..e2]), anac))
}

/// `^([1-7])=([A-Ga-g][#b]?)$`：调号行（回主音名）
fn key_line(t: &str) -> Option<&str> {
    let b = t.as_bytes();
    if b.len() < 3 || !(b'1'..=b'7').contains(&b[0]) || b[1] != b'=' {
        return None;
    }
    let tonic = &t[2..];
    let tb = tonic.as_bytes();
    let ok = (b'A'..=b'G').contains(&tb[0].to_ascii_uppercase()) && tb[0].is_ascii_alphabetic() && (tb.len() == 1 || (tb.len() == 2 && matches!(tb[1], b'#' | b'b')));
    ok.then_some(tonic)
}

/// `^\d+(?:\.\d+)?=(\d+)$`：速度行（回 `=` 后的数字串）
fn tempo_line(t: &str) -> Option<&str> {
    let b = t.as_bytes();
    let mut k = digits_end(b, 0);
    if k == 0 {
        return None;
    }
    if b.get(k) == Some(&b'.') {
        let e = digits_end(b, k + 1);
        if e == k + 1 {
            return None;
        }
        k = e;
    }
    if b.get(k) != Some(&b'=') {
        return None;
    }
    let e = digits_end(b, k + 1);
    (e > k + 1 && e == b.len()).then(|| &t[k + 1..])
}

/// `^[A-Za-z][A-Za-z0-9]*=`：页头 / `chords=` 这类 `key=value` 行；回 (键, `=` 之后)
fn head_field(t: &str) -> Option<(&str, &str)> {
    let b = t.as_bytes();
    if !b.first()?.is_ascii_alphabetic() {
        return None;
    }
    let mut k = 1;
    while k < b.len() && b[k].is_ascii_alphanumeric() {
        k += 1;
    }
    (b.get(k) == Some(&b'=')).then(|| (&t[..k], &t[k + 1..]))
}

/// 正则 `.*$`：剩下的部分不含行终止符
fn no_lt(s: &str) -> bool {
    !s.chars().any(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
}

/// 去掉开头的空白（`\s*`）
fn skip_space(s: &str) -> &str {
    s.trim_start_matches(js::is_space)
}

/// `^chords\s*=\s*(.*)$`（忽略大小写）的 `(.*)`；`None` = 不是这种行（`Some(None)` = 前缀对但后面有行终止符）
fn chords_row(t: &str) -> Option<Option<&str>> {
    let head = t.get(..6)?;
    if !head.eq_ignore_ascii_case("chords") {
        return None;
    }
    let rest = skip_space(&t[6..]).strip_prefix('=')?;
    let body = skip_space(rest);
    Some(no_lt(body).then_some(body))
}

/// 这一行是不是**曲行**（有音符 / 小节线那些）。分类与 [`parse_jly`] 的派发次序同一套
pub fn is_jly_music_line(line: &str) -> bool {
    let t = js::trim(line);
    if t.is_empty() || t.starts_with('%') {
        return false;
    }
    if t.starts_with("L:") || t.starts_with("H:") {
        return false;
    }
    if head_field(t).is_some() {
        return false;
    }
    if time_line(t).is_some() || key_line(t).is_some() || tempo_line(t).is_some() {
        return false;
    }
    if t == "NextScore" || t == "NextPart" {
        return false;
    }
    !scan_music_line(&u16s::enc(t), &mut JlyLosses::new(), None).tokens.is_empty()
}

// ───────────────────────── 重排 ─────────────────────────

/// 一行原文与它后面的分隔符
#[derive(Clone, Debug)]
struct Row {
    raw: Vec<u16>,
    sep: &'static str,
}

/// `[...text.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)]`，去掉末尾那个空匹配
fn split_rows(text: &[u16]) -> Vec<Row> {
    let mut rows = vec![];
    let mut pos = 0;
    loop {
        let mut j = pos;
        while j < text.len() && text[j] != b'\r' as u16 && text[j] != b'\n' as u16 {
            j += 1;
        }
        let raw = text[pos..j].to_vec();
        if j == text.len() {
            if !raw.is_empty() {
                rows.push(Row { raw, sep: "" });
            }
            break;
        }
        let sep = if text[j] == b'\r' as u16 && text.get(j + 1) == Some(&(b'\n' as u16)) {
            "\r\n"
        } else if text[j] == b'\r' as u16 {
            "\r"
        } else {
            "\n"
        };
        rows.push(Row { raw, sep });
        pos = j + sep.len();
    }
    rows
}

/// 把曲行按**每 N 小节一行**重新断行，别的一个字不动（词行、页头、注释都留在原处）。
/// 按 `NextScore` / `NextPart` / 曲中拍号调号速度行分段，逐段重排。`skip_pickup`：不满的第一小节不计数、并进首行
pub fn rewrap_jly_text(text: &str, measures_per_line: f64, skip_pickup: bool) -> String {
    let rows = split_rows(&u16s::enc(text));
    let is_sep = |raw: &[u16]| {
        let r = u16s::text(raw);
        let t = js::trim(&r);
        if t.is_empty() || t.starts_with('%') {
            return false;
        }
        if t == "NextScore" || t == "NextPart" {
            return true;
        }
        time_line(t).is_some() || key_line(t).is_some() || tempo_line(t).is_some()
    };
    let mut segs: Vec<Vec<Row>> = vec![];
    let mut acc: Vec<Row> = vec![];
    for r in &rows {
        if is_sep(&r.raw) {
            segs.push(std::mem::take(&mut acc));
            segs.push(vec![r.clone()]);
            continue;
        }
        acc.push(r.clone());
    }
    segs.push(acc);
    if segs.len() == 1 {
        return rewrap_jly_rows(&rows, measures_per_line, skip_pickup);
    }
    segs.iter()
        .map(|s| {
            if s.len() == 1 && is_sep(&s[0].raw) {
                format!("{}{}", u16s::text(&s[0].raw), s[0].sep)
            } else {
                rewrap_jly_rows(s, measures_per_line, skip_pickup)
            }
        })
        .collect()
}

/// 一个小节（token 串）的时值，四分音符为 1：音符按减时线与附点折算、`-` 一拍，连音不折
fn jly_measure_beats(words: &[String]) -> f64 {
    let mut beats = 0.0;
    for tk in scan_music_line(&u16s::enc(&words.join(" ")), &mut JlyLosses::new(), None).tokens {
        match tk {
            JlyToken::Sustain => beats += 1.0,
            JlyToken::Note(n) => beats += (2.0 - 1.0 / 2f64.powf(n.dots)) / 2f64.powf(n.beams),
            _ => {}
        }
    }
    beats
}

fn is_bar_word(w: &str) -> bool {
    !w.is_empty() && w.bytes().all(|b| b == b'|')
}

/// `s.split(/\s+/).filter(Boolean)`
fn split_ws(s: &str) -> Vec<String> {
    s.split(js::is_space).filter(|w| !w.is_empty()).map(String::from).collect()
}

/// 单段的重排（分隔行已在 [`rewrap_jly_text`] 里切开）
fn rewrap_jly_rows(rows: &[Row], measures_per_line: f64, skip_pickup: bool) -> String {
    let strs: Vec<String> = rows.iter().map(|r| u16s::text(&r.raw)).collect();
    let is_music: Vec<bool> = strs.iter().map(|r| is_jly_music_line(r)).collect();
    if !is_music.iter().any(|&b| b) {
        return rows.iter().zip(&strs).map(|(r, s)| format!("{s}{}", r.sep)).collect();
    }
    let mut tokens: Vec<String> = vec![];
    let mut comments: Vec<String> = vec![];
    for (i, raw) in strs.iter().enumerate() {
        if !is_music[i] {
            continue;
        }
        let body = match raw.find('%') {
            Some(at) => {
                comments.push(js::trim(&raw[at..]).into());
                &raw[..at]
            }
            None => raw.as_str(),
        };
        tokens.extend(split_ws(body));
    }

    let mut lines: Vec<String> = vec![];
    let mut cur: Vec<String> = vec![];
    let mut in_measure: Vec<String> = vec![];
    let mut count = 0.0;
    let mut closed = 0;
    let mut pickup = false;
    if skip_pickup {
        let mut heads: Vec<Vec<String>> = vec![];
        let mut acc: Vec<String> = vec![];
        for tk in &tokens {
            if is_bar_word(tk) && !acc.is_empty() {
                heads.push(std::mem::take(&mut acc));
                if heads.len() == 2 {
                    break;
                }
                continue;
            }
            acc.push(tk.clone());
        }
        pickup = heads.len() == 2 && jly_measure_beats(&heads[0]) < jly_measure_beats(&heads[1]);
    }
    for tk in &tokens {
        if is_bar_word(tk) && !in_measure.is_empty() {
            in_measure.push(tk.clone());
            cur.append(&mut in_measure);
            let was = closed;
            closed += 1;
            if was == 0 && pickup {
                continue;
            }
            count += 1.0;
            if count >= measures_per_line {
                lines.push(cur.join(" "));
                cur.clear();
                count = 0.0;
            }
            continue;
        }
        in_measure.push(tk.clone());
    }
    if !in_measure.is_empty() {
        cur.append(&mut in_measure);
    }
    if !cur.is_empty() {
        lines.push(cur.join(" "));
    }
    if !comments.is_empty() {
        if let Some(last) = lines.last_mut() {
            *last += "  ";
            *last += &comments.join(" ");
        }
    }

    let mut out: Vec<String> = vec![];
    let mut slot = 0;
    for (i, s) in strs.iter().enumerate() {
        if !is_music[i] {
            out.push(s.clone());
            continue;
        }
        if slot == 0 {
            out.extend(lines.iter().cloned());
        }
        slot += 1;
    }
    let tail = rows.last().map_or("", |r| r.sep);
    out.join("\n") + tail
}

// ───────────────────────── 曲行扫描 ─────────────────────────

/// 一行曲行扫出来的东西
#[derive(Clone, Debug, Default, Serialize)]
pub struct MusicLine {
    pub tokens: Vec<JlyToken>,
    pub pos: Vec<JlyPos>,
    pub unknown: Vec<String>,
}

fn is_lt(u: u16) -> bool {
    matches!(u, 0x0a | 0x0d | 0x2028 | 0x2029)
}

/// 一整行音乐 → token 与各自的位置（按空白切；`%` 起头是注释）。`span_at(列, 长)` 给落点（UTF-16）
pub fn scan_music_line(line: &[u16], loss: &mut JlyLosses, span_at: Option<&dyn Fn(usize, usize) -> SourceSpan>) -> MusicLine {
    let mut out = MusicLine::default();
    // `line.replace(/%.*$/, "")`：第一个其后再没有行终止符的 `%` 起截掉
    let last_lt = line.iter().rposition(|&u| is_lt(u));
    let from = last_lt.map_or(0, |p| p + 1);
    let cut = (from..line.len()).find(|&k| line[k] == b'%' as u16).unwrap_or(line.len());
    let body = &line[..cut];
    let next_word = |from: usize| -> Option<(usize, usize)> {
        let s = (from..body.len()).find(|&k| !u16s::space(body[k]))?;
        let e = (s..body.len()).find(|&k| u16s::space(body[k])).unwrap_or(body.len());
        Some((s, e))
    };
    let span = |c: usize, l: usize| span_at.map(|f| f(c, l));
    let mut at = 0;
    while let Some((s, e)) = next_word(at) {
        at = e;
        let word = u16s::text(&body[s..e]);
        if word == "\\bar" {
            if let Some((s2, e2)) = next_word(e) {
                let w2 = &body[s2..e2];
                if w2.len() >= 2 && w2[0] == b'"' as u16 && w2[w2.len() - 1] == b'"' as u16 && !w2[1..w2.len() - 1].contains(&(b'"' as u16)) {
                    out.tokens.push(JlyToken::Barstyle { style: u16s::text(&w2[1..w2.len() - 1]) });
                    out.pos.push(JlyPos { col: s, len: (e - s) + (e2 - s2) });
                    at = e2;
                    continue;
                }
            }
        }
        match scan_word(&word, loss, span(s, e - s)) {
            Some(t) => {
                out.tokens.push(t);
                out.pos.push(JlyPos { col: s, len: e - s });
            }
            None => {
                loss.add(Msg::new("diag.jly.unknownWord"), &word, span(s, e - s));
                out.unknown.push(word);
            }
        }
    }
    out
}

// ───────────────────────── 歌词 ─────────────────────────

/// 歌词里的一个音节（`None` 是占位：这个音上没词）
#[derive(Clone, Debug, PartialEq)]
struct JlySyllable {
    text: String,
    begin: bool,
}

/// `/"(?:[^"\\]|\\.)*"|\S+/g`：引号串整对当一格，其余按空白切
fn lyric_words(body: &str) -> Vec<String> {
    let cs: Vec<char> = body.chars().collect();
    let mut out = vec![];
    let mut i = 0;
    while i < cs.len() {
        if js::is_space(cs[i]) {
            i += 1;
            continue;
        }
        if cs[i] == '"' {
            let mut k = i + 1;
            let mut closed = None;
            while k < cs.len() {
                match cs[k] {
                    '"' => {
                        closed = Some(k + 1);
                        break;
                    }
                    '\\' => {
                        if k + 1 < cs.len() && !matches!(cs[k + 1], '\n' | '\r' | '\u{2028}' | '\u{2029}') {
                            k += 2;
                        } else {
                            break;
                        }
                    }
                    _ => k += 1,
                }
            }
            if let Some(e) = closed {
                out.push(cs[i..e].iter().collect());
                i = e;
                continue;
            }
        }
        let s = i;
        while i < cs.len() && !js::is_space(cs[i]) {
            i += 1;
        }
        out.push(cs[s..i].iter().collect());
    }
    out
}

fn is_quoted(w: &str) -> bool {
    w.chars().count() >= 2 && w.starts_with('"') && w.ends_with('"')
}

/// 一行歌词正文 → 音节列表。`""`、孤立的 `_`（拉丁行）、`\skip 1` 都是占位；汉字行一个汉字一格、`_` 连写；行尾 `-` 是词内断音节
fn syllables_of(body: &str, han: bool) -> Vec<Option<JlySyllable>> {
    let mut out: Vec<Option<JlySyllable>> = vec![];
    let unquote = |w: &str| -> Option<String> {
        if !is_quoted(w) {
            return Some(w.into());
        }
        let cs: Vec<char> = w.chars().collect();
        let inner: String = cs[1..cs.len() - 1].iter().collect();
        let inner = inner.replace("\\\"", "\"").replace("\\\\", "\\");
        if inner.is_empty() {
            None
        } else {
            Some(inner)
        }
    };
    let push = |raw: &str, out: &mut Vec<Option<JlySyllable>>| {
        let Some(text) = unquote(raw) else {
            if raw.is_empty() {
                return;
            }
            out.push(None);
            return;
        };
        if text.is_empty() {
            return;
        }
        if let Some(t) = text.strip_suffix('-') {
            out.push(Some(JlySyllable { text: t.into(), begin: true }));
        } else {
            out.push(Some(JlySyllable { text, begin: false }));
        }
    };
    let words = lyric_words(body);
    if han {
        for w in &words {
            if is_quoted(w) {
                push(w, &mut out);
                continue;
            }
            if w.contains('_') {
                let text = w.split('_').collect::<String>();
                if !text.is_empty() {
                    push(&text, &mut out);
                }
                continue;
            }
            for ch in w.chars() {
                if !js::is_space(ch) {
                    push(&ch.to_string(), &mut out);
                }
            }
        }
        return out;
    }
    let mut i = 0;
    while i < words.len() {
        let w = &words[i];
        if w == "_" {
            out.push(None);
            i += 1;
            continue;
        }
        if let Some(d) = w.strip_prefix("\\skip") {
            if d.bytes().all(|b| b.is_ascii_digit()) {
                out.push(None);
                if w == "\\skip" && words.get(i + 1).is_some_and(|n| all_digits(n)) {
                    i += 1;
                }
                i += 1;
                continue;
            }
        }
        push(w, &mut out);
        i += 1;
    }
    out
}

// ───────────────────────── 装配：token → ScoreDoc ─────────────────────────

/// 读 jly 的结果
#[derive(Clone, Debug, Serialize)]
pub struct JlyParse {
    pub doc: ScoreDoc,
    /// 本版不收的东西，每条 `diag.jly.example { what, raw }`（TS 是当场出好的文字）
    pub losses: Vec<Msg>,
    pub unknown: Vec<String>,
}

/// 大调主音名 → `fifths`
fn fifths_of(tonic: &str) -> Option<f64> {
    Some(match tonic {
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
        _ => return None,
    })
}

const CREDIT_KEYS: &[&str] = &["composer", "poet", "lyricist", "arranger", "copyright", "opus"];

fn dot_factor(dots: f64) -> f64 {
    if dots == 0.0 {
        1.0
    } else {
        2.0 - 2f64.powf(-dots)
    }
}

/// 倚音的减时线条数 → 符号时值
fn grace_type_of(beams: f64) -> NoteType {
    match js::round(beams).clamp(0.0, 4.0) as usize {
        0 => NoteType::Quarter,
        1 => NoteType::Eighth,
        2 => NoteType::N16th,
        3 => NoteType::N32nd,
        _ => NoteType::N64th,
    }
}

/// `n[ … ]` 里 n 个音占几个（3→2、5/6/7→4，其余取小于 n 的最大 2 的幂）
fn tuplet_normal(n: f64) -> f64 {
    let mut p = 1.0;
    while p * 2.0 < n {
        p *= 2.0;
    }
    p
}

/// `Object.prototype` 上的名字（TS 拿对象字面量当表查 `map[st]`，碰到这些名字算「查到了、什么都不设」）
fn is_proto_key(s: &str) -> bool {
    matches!(
        s,
        "constructor" | "__defineGetter__" | "__defineSetter__" | "hasOwnProperty" | "__lookupGetter__" | "__lookupSetter__" | "isPrototypeOf"
            | "propertyIsEnumerable" | "toString" | "valueOf" | "__proto__" | "toLocaleString"
    )
}

/// 和弦位置：（声部, 小节, 元素）下标，都在当前曲里
type Loc = (usize, usize, usize);

fn barline(location: BarLocation, style: Option<BarStyle>, source: Option<SourceSpan>) -> Barline {
    Barline { style, source, ..Barline::at(location) }
}

fn chord_at(song: &mut Song, (p, m, e): Loc) -> &mut Chord {
    match &mut song.parts[p].measures[m].elements[e] {
        Element::Chord(c) => c,
        _ => unreachable!("jly 只出和弦"),
    }
}

struct Repeat {
    r_end: i64,
    a_start: i64,
    a_end: i64,
}

struct Percent {
    from: usize,
    to: usize,
    times: f64,
}

struct OpenSlur {
    start: Option<ElementId>,
    melisma: bool,
    source: SourceSpan,
}

struct VerseSlot {
    syllables: Vec<Option<JlySyllable>>,
    span: SourceSpan,
}

struct ChordTok {
    song: usize,
    text: String,
    whole: Option<f64>,
}

/// 读的过程中的状态（TS 的闭包变量）
struct St {
    loss: JlyLosses,
    unknown: Vec<String>,
    doc: ScoreDoc,
    ids: IdGen,
    /// 当前小节开着（= 当前声部最后一个小节）
    cur: bool,
    prev_chord: Option<Loc>,
    open_tuplet: Option<f64>,
    pending_tie: bool,
    auto_verse: f64,
    percent_stack: Vec<(usize, f64)>,
    percent_ranges: Vec<Percent>,
    pending_break: Option<BreakKind>,
    chord_tokens: Vec<ChordTok>,
    repeats: Vec<Repeat>,
    slots: Vec<Loc>,
    melisma_open: i64,
    pending_melisma: i64,
    open_slurs: Vec<OpenSlur>,
    /// 段号＋H/L → 那一段的音节（按出现次序）
    verses: Vec<(String, VerseSlot)>,
}

impl St {
    fn song(&mut self) -> &mut Song {
        self.doc.songs.last_mut().expect("至少一首")
    }
    fn part(&mut self) -> &mut Part {
        self.song().parts.last_mut().expect("至少一个声部")
    }
    fn pi(&self) -> usize {
        self.doc.songs.last().unwrap().parts.len() - 1
    }
    fn last_measure(&mut self) -> Option<&mut Measure> {
        self.part().measures.last_mut()
    }
    fn n_measures(&self) -> usize {
        self.doc.songs.last().unwrap().parts.last().unwrap().measures.len()
    }

    /// 开一小节；换行 / 换页先记成 `pending_break`，等真开下一小节时挂到它的 `print` 上
    fn open_measure(&mut self, source: SourceSpan) {
        let n = self.n_measures();
        let mut m = Measure { number: js::num_to_string((n + 1) as f64), source: Some(source), ..Default::default() };
        if let Some(b) = self.pending_break.take() {
            let mut p = m.print.take().unwrap_or_default();
            if b == BreakKind::Page {
                p.new_page = Some(true);
            } else {
                p.new_system = Some(true);
            }
            m.print = Some(p);
        }
        self.part().measures.push(m);
        self.cur = true;
    }

    fn ensure_cur(&mut self, source: SourceSpan) {
        if !self.cur {
            self.open_measure(source);
        }
    }

    fn cur_nonempty(&self) -> bool {
        self.cur && !self.doc.songs.last().unwrap().parts.last().unwrap().measures.last().unwrap().elements.is_empty()
    }

    /// 当前声部最后一个小节的最后一个和弦（记号落在前一个音上）
    fn last_chord(&mut self) -> Option<&mut Chord> {
        match self.last_measure()?.elements.last_mut()? {
            Element::Chord(c) => Some(c),
            _ => None,
        }
    }

    fn drop_open_slurs(&mut self) {
        for s in std::mem::take(&mut self.open_slurs) {
            let (m, raw) = if s.melisma { ("diag.jly.slurUnpaired", "(") } else { ("diag.jly.phraseUnpaired", "\\(") };
            self.loss.add(Msg::new(m), raw, Some(s.source));
        }
    }

    /// 一首曲子的收尾：反复跳跃落房号 → 歌词对位 → `R4{}` 展开 → 和弦符号时间线
    fn finish_song(&mut self) {
        let repeats = std::mem::take(&mut self.repeats);
        let part = self.part();
        let len = part.measures.len();
        let at = |i: i64| if i >= 0 && (i as usize) < len { Some(i as usize) } else { None };
        for r in &repeats {
            if r.r_end < 0 {
                continue;
            }
            if let Some(i) = at(r.r_end) {
                let lines = part.measures[i].barlines.get_or_insert_with(Vec::new);
                if let Some(right) = lines.iter_mut().find(|b| b.location == BarLocation::Right) {
                    right.repeat = Some(RepeatDir::Backward);
                    right.style = Some(BarStyle::LightHeavy);
                } else {
                    lines.push(Barline { repeat: Some(RepeatDir::Backward), ..barline(BarLocation::Right, Some(BarStyle::LightHeavy), None) });
                }
            }
            if r.a_start >= 0 {
                if let Some(i) = at(r.a_start) {
                    let lines = part.measures[i].barlines.get_or_insert_with(Vec::new);
                    let ending = Ending::new(vec![2.0], EndingType::Start, Some("2".into()));
                    if let Some(left) = lines.iter_mut().find(|b| b.location == BarLocation::Left) {
                        left.ending = Some(ending);
                    } else {
                        lines.insert(0, Barline { ending: Some(ending), ..Barline::at(BarLocation::Left) });
                    }
                }
                let tail = if r.a_end >= 0 { at(r.a_end) } else { len.checked_sub(1) };
                if let Some(i) = tail {
                    let lines = part.measures[i].barlines.get_or_insert_with(Vec::new);
                    let ending = Ending::new(vec![2.0], EndingType::Discontinue, Some("2".into()));
                    if let Some(right) = lines.iter_mut().find(|b| b.location == BarLocation::Right) {
                        right.ending = Some(ending);
                    } else {
                        lines.push(Barline { ending: Some(ending), ..barline(BarLocation::Right, Some(BarStyle::LightHeavy), None) });
                    }
                }
            }
        }
        // 歌词逐位置推进：这一格没字（占位）也往下走一格
        let verses = std::mem::take(&mut self.verses);
        let slots = std::mem::take(&mut self.slots);
        for (key, slot) in &verses {
            let verse = js::number(key.strip_suffix(['H', 'L']).unwrap_or(key));
            for (i, &loc) in slots.iter().enumerate() {
                if i >= slot.syllables.len() {
                    break;
                }
                let Some(syl) = &slot.syllables[i] else { continue };
                let lyric = Lyric {
                    number: verse,
                    text: syl.text.clone(),
                    syllabic: syl.begin.then_some(Syllabic::Begin),
                    source: Some(slot.span),
                    ..Default::default()
                };
                chord_at(self.song(), loc).lyrics.get_or_insert_with(Vec::new).push(lyric);
            }
            if slot.syllables.len() > slots.len() {
                let raw: Vec<String> = slot.syllables[slots.len()..]
                    .iter()
                    .map(|s| s.as_ref().map_or_else(|| "\"\"".to_string(), |s| s.text.clone()))
                    .take(3)
                    .collect();
                self.loss.add(
                    Msg::new("diag.jly.extraSyl").arg("verse", verse).arg("n", (slot.syllables.len() - slots.len()) as f64),
                    &raw.join(" "),
                    Some(slot.span),
                );
            }
        }
        // 小节反复展开成真实小节（在歌词对位之后：副本跟着原件有词）；副本里的 id 一律换新号
        let mut ranges = std::mem::take(&mut self.percent_ranges);
        ranges.sort_by_key(|r| std::cmp::Reverse(r.from));
        for r in &ranges {
            let len = self.n_measures();
            let (from, to) = (r.from.min(len), r.to.min(len));
            let base: Vec<Measure> = self.part().measures[from.min(to)..to].to_vec();
            if base.is_empty() || r.times < 2.0 {
                continue;
            }
            let mut copies: Vec<Measure> = vec![];
            let mut k = 1.0;
            while k < r.times {
                for m in &base {
                    let mut c = m.clone();
                    for el in &mut c.elements {
                        if let Element::Chord(ch) = el {
                            ch.id = self.ids.next();
                            for su in ch.sustains.iter_mut().flatten() {
                                su.id = self.ids.next();
                            }
                        }
                    }
                    copies.push(c);
                }
                k += 1.0;
            }
            self.part().measures.splice(to..to, copies);
        }
        // 和弦符号行：一条时间线（整音符为单位、从本乐章曲首起），落到「起点 ≤ 该时刻」的最后一个音上
        let song_idx = self.doc.songs.len() - 1;
        let mut at_list: Vec<(Loc, f64)> = vec![];
        let mut acc = 0.0;
        for (pi, p) in self.doc.songs[song_idx].parts.iter().enumerate() {
            for (mi, m) in p.measures.iter().enumerate() {
                for (ei, el) in m.elements.iter().enumerate() {
                    let Element::Chord(c) = el else { continue };
                    at_list.push(((pi, mi, ei), acc / (SIMPLE_DIVISIONS * 4.0)));
                    acc += match &c.duration.time_mod {
                        Some(tm) => (c.duration.divisions * tm.normal) / tm.actual,
                        None => c.duration.divisions,
                    };
                }
            }
        }
        if !at_list.is_empty() {
            let total = acc / (SIMPLE_DIVISIONS * 4.0);
            let mut t = 0.0;
            let mut carried = 0.25;
            let toks: Vec<(String, Option<f64>)> = self.chord_tokens.iter().filter(|c| c.song == song_idx).map(|c| (c.text.clone(), c.whole)).collect();
            for (text, whole) in &toks {
                let whole = whole.unwrap_or(carried);
                carried = whole;
                let mut pick = at_list[0].0;
                for &(loc, w) in &at_list {
                    if w <= t + 1e-6 {
                        pick = loc;
                    } else {
                        break;
                    }
                }
                chord_at(self.song(), pick).harmony =
                    Some(Harmony { root: HarmonyStep { step: "C".into(), alter: 0.0, alter_left: None }, kind: String::new(), text: Some(text.clone()), ..Default::default() });
                t += whole;
            }
            if t > total + 1e-6 {
                let last = toks.last().map(|t| t.0.clone()).unwrap_or_default();
                self.loss.add(Msg::new("diag.jly.chordsTooLong").arg("n", js::to_fixed(t - total, 2)), &last, None);
            }
        }
    }
}

/// jianpu-ly 文本 → `ScoreDoc`（带位置信息与诊断）
pub fn parse_jly(text: &str) -> JlyParse {
    let mut doc = empty_doc(SourceFormat::Jly);
    doc.songs.push(empty_song());
    doc.songs[0].parts.push(Part { id: "P1".into(), ..Default::default() });
    let mut st = St {
        loss: JlyLosses::new(),
        unknown: vec![],
        doc,
        ids: IdGen::new(),
        cur: false,
        prev_chord: None,
        open_tuplet: None,
        pending_tie: false,
        auto_verse: 0.0,
        percent_stack: vec![],
        percent_ranges: vec![],
        pending_break: None,
        chord_tokens: vec![],
        repeats: vec![],
        slots: vec![],
        melisma_open: 0,
        pending_melisma: 0,
        open_slurs: vec![],
        verses: vec![],
    };

    let mut line_no: u32 = 0;
    let mut line_offset: u32 = 0;
    let rows = split_rows(&u16s::enc(text));
    let mut li = 0;
    while li < rows.len() {
        let Row { raw, sep } = &rows[li];
        let lead = raw.iter().take_while(|&&u| u16s::space(u)).count();
        let trail = raw[lead..].iter().rev().take_while(|&&u| u16s::space(u)).count();
        let indent = lead as u32;
        let line16 = &raw[lead..raw.len() - trail];
        let (ln, lo) = (line_no, line_offset);
        let span_of = move |col: usize, len: usize| SourceSpan { line: ln, column: indent + col as u32, offset: lo + indent + col as u32, length: len as u32 };
        let advance_by = (raw.len() + sep.len()) as u32;
        let line = u16s::text(line16);

        if line.is_empty() || line.starts_with('%') {
            line_no += 1;
            line_offset += advance_by;
            li += 1;
            continue;
        }

        // 歌词行（`^([LH]):\s*(.*)$`）。正文可以 `L:` 之后换行分几行写、以空行结束
        let lyric = (line.starts_with("L:") || line.starts_with("H:")).then(|| skip_space(&line[2..])).filter(|b| no_lt(b));
        if let Some(body0) = lyric {
            let han = line.starts_with('H');
            let head = span_of(indent as usize, line16.len());
            let mut body = body0.to_string();
            if body.is_empty() {
                let mut parts: Vec<String> = vec![];
                while li + 1 < rows.len() {
                    let nxt = &rows[li + 1];
                    let s = u16s::text(&nxt.raw);
                    let t = js::trim(&s);
                    if t.is_empty() || t.starts_with('%') {
                        break;
                    }
                    parts.push(t.into());
                    li += 1;
                    line_no += 1;
                    line_offset += (nxt.raw.len() + nxt.sep.len()) as u32;
                }
                body = parts.join(" ");
            }
            // `^(\d+)\.\s*(.*)$`：写了段号
            let verse_head = {
                let b = body.as_bytes();
                let e = digits_end(b, 0);
                (e > 0 && b.get(e) == Some(&b'.')).then(|| (body[..e].to_string(), skip_space(&body[e + 1..]).to_string())).filter(|(_, rest)| no_lt(rest))
            };
            let verse = match verse_head {
                Some((v, rest)) => {
                    body = rest;
                    st.auto_verse = js::max(st.auto_verse, js::number(&v));
                    v
                }
                None => {
                    st.auto_verse += 1.0;
                    js::num_to_string(st.auto_verse)
                }
            };
            let key = format!("{verse}{}", if han { "H" } else { "L" });
            let syls = syllables_of(&body, han);
            if !han && syls.iter().flatten().any(|s| s.text.chars().filter(|c| ('\u{3400}'..='\u{9fff}').contains(c)).count() > 1) {
                st.loss.add(Msg::new("diag.jly.hanInL"), &body, Some(head));
            }
            match st.verses.iter_mut().find(|(k, _)| *k == key) {
                Some((_, v)) => v.syllables.extend(syls),
                None => st.verses.push((key, VerseSlot { syllables: syls, span: head })),
            }
            line_no += 1;
            line_offset += advance_by;
            li += 1;
            continue;
        }

        // 页头字段（`chords=` 长得也像，先排除）
        let is_chord_row = line.get(..6).is_some_and(|h| h.eq_ignore_ascii_case("chords")) && skip_space(&line[6..]).starts_with('=');
        let head = if is_chord_row { None } else { head_field(&line).filter(|(_, v)| no_lt(v)) };
        if let Some((k, v)) = head {
            let key = k.to_ascii_lowercase();
            let value = js::trim(v).to_string();
            let song = st.song();
            if key == "title" || key == "movement-title" {
                song.work.title = Some(value);
            } else if key == "subtitle" {
                song.work.subtitles.push(value);
            } else if CREDIT_KEYS.contains(&key.as_str()) {
                song.credits.get_or_insert_with(Vec::new).push(Credit { kind: Some(key), text: value, ..Default::default() });
            } else {
                st.loss.add(Msg::new("diag.jly.header").arg("key", key.as_str()), &line, Some(span_of(0, line16.len())));
            }
            line_no += 1;
            line_offset += advance_by;
            li += 1;
            continue;
        }
        if let Some((beats, beat_type, anac)) = time_line(&line) {
            st.song().time = Some(Time { beats, beat_type, symbol: None, parenthesized: None });
            if anac {
                st.loss.add(Msg::new("diag.jly.anacrusis"), &line, Some(span_of(0, line16.len())));
            }
            line_no += 1;
            line_offset += advance_by;
            li += 1;
            continue;
        }
        if let Some(tonic) = key_line(&line) {
            let mut up = tonic.to_string();
            up.replace_range(..1, &tonic[..1].to_ascii_uppercase());
            match fifths_of(tonic).or_else(|| fifths_of(&up)) {
                None => st.loss.add(Msg::new("diag.jly.key").arg("v", line.as_str()), &line, Some(span_of(0, line16.len()))),
                Some(fifths) => {
                    st.song().key = Some(Key { fifths, spelling: Some(tonic.into()), mode: None, tonic_degree: None, display: None, explicit_accidentals: None, cancel: None })
                }
            }
            line_no += 1;
            line_offset += advance_by;
            li += 1;
            continue;
        }
        if let Some(bpm) = tempo_line(&line) {
            st.song().tempos = Some(vec![Tempo::Bpm(js::number(bpm))]);
            line_no += 1;
            line_offset += advance_by;
            li += 1;
            continue;
        }

        // 和弦符号行 `chords=c2. g:7 c`（LilyPond 和弦语法）
        if let Some(Some(body0)) = chords_row(&line) {
            let head = span_of(indent as usize, line16.len());
            let mut body = body0.to_string();
            if body.is_empty() {
                let mut parts: Vec<String> = vec![];
                while li + 1 < rows.len() {
                    let nxt = &rows[li + 1];
                    let s = u16s::text(&nxt.raw);
                    let t = js::trim(&s);
                    if t.is_empty() || t.starts_with('%') {
                        break;
                    }
                    parts.push(t.into());
                    li += 1;
                    line_no += 1;
                    line_offset += (nxt.raw.len() + nxt.sep.len()) as u32;
                }
                body = parts.join(" ");
            }
            for tok in split_ws(&body) {
                let Some(parsed) = parse_chord_token(&tok) else {
                    st.loss.add(Msg::new("diag.jly.chordToken"), &tok, Some(head));
                    continue;
                };
                let Some(root) = ly_pitch_to_text(&parsed.pitch) else {
                    st.loss.add(Msg::new("diag.jly.chordPitch"), &tok, Some(head));
                    continue;
                };
                let bass = parsed.bass.as_deref().and_then(ly_pitch_to_text);
                let song = st.doc.songs.len() - 1;
                st.chord_tokens.push(ChordTok {
                    song,
                    text: format!("{root}{}{}", ly_suffix_to_text(&parsed.suffix), bass.map(|b| format!("/{b}")).unwrap_or_default()),
                    whole: parsed.whole,
                });
            }
            line_no += 1;
            line_offset += advance_by;
            li += 1;
            continue;
        }

        if line == "NextScore" {
            st.finish_song();
            st.doc.songs.push(empty_song());
            st.song().parts.push(Part { id: "P1".into(), ..Default::default() });
            st.cur = false;
            st.prev_chord = None;
            st.slots.clear();
            st.melisma_open = 0;
            st.pending_melisma = 0;
            st.auto_verse = 0.0;
            st.drop_open_slurs();
            line_no += 1;
            line_offset += advance_by;
            li += 1;
            continue;
        }
        if line == "NextPart" {
            let n = st.song().parts.len();
            st.song().parts.push(Part { id: format!("P{}", n + 1), ..Default::default() });
            st.cur = false;
            st.prev_chord = None;
            st.drop_open_slurs();
            line_no += 1;
            line_offset += advance_by;
            li += 1;
            continue;
        }

        // 曲行
        let ml = scan_music_line(line16, &mut st.loss, Some(&span_of));
        st.unknown.extend(ml.unknown.iter().cloned());
        let span_at = |i: usize| span_of(ml.pos.get(i).map_or(0, |p| p.col), ml.pos.get(i).map_or(0, |p| p.len));
        for (i, tk) in ml.tokens.iter().enumerate() {
            match tk {
                JlyToken::Loss { .. } => {}
                JlyToken::Text { value, .. } => match st.last_chord() {
                    Some(host) => {
                        host.section_word = Some(match &host.section_word {
                            Some(w) if !w.is_empty() => format!("{w} {value}"),
                            _ => value.clone(),
                        })
                    }
                    None => st.loss.add(Msg::new("diag.jly.textNoNote"), value, Some(span_at(i))),
                },
                JlyToken::Dynamic { name } => match st.last_chord() {
                    Some(host) => host.notations.get_or_insert_with(Default::default).articulations.get_or_insert_with(Vec::new).push(name.clone()),
                    None => st.loss.add(Msg::new("diag.jly.dynNoNote"), name, Some(span_at(i))),
                },
                JlyToken::Fermata => match st.last_chord() {
                    Some(host) => host.notations.get_or_insert_with(Default::default).fermata = Some(true),
                    None => st.loss.add(Msg::new("diag.jly.fermataNoNote"), "\\fermata", Some(span_at(i))),
                },
                JlyToken::Jump { text } => {
                    let short = jump_short(text);
                    let src = span_at(i);
                    match st.last_measure() {
                        None => st.loss.add(Msg::new("diag.jly.jumpNoBar"), short, Some(src)),
                        Some(host) => {
                            let lines = host.barlines.get_or_insert_with(Vec::new);
                            let orn = SourceOrnament { name: short.into(), level: 0.0, below: None };
                            if let Some(right) = lines.iter_mut().find(|b| b.location == BarLocation::Right) {
                                right.ornaments.get_or_insert_with(Vec::new).push(orn);
                            } else {
                                lines.push(Barline { ornaments: Some(vec![orn]), ..barline(BarLocation::Right, None, Some(src)) });
                            }
                        }
                    }
                }
                JlyToken::Break { page } => {
                    let kind = if *page { BreakKind::Page } else { BreakKind::System };
                    if st.last_measure().is_none() {
                        st.loss.add(Msg::new("diag.jly.breakNoBar"), if *page { "\\pageBreak" } else { "\\break" }, Some(span_at(i)));
                    } else if st.cur_nonempty() {
                        st.last_chord().unwrap().line_break_after = Some(kind);
                    } else {
                        st.pending_break = Some(kind);
                    }
                }
                JlyToken::Barstyle { style } => {
                    let s = js::trim(style).to_string();
                    let left = s.starts_with('.') && s.contains(':');
                    let src = span_at(i);
                    if left {
                        st.ensure_cur(src);
                    }
                    let loc = if left { BarLocation::Left } else { BarLocation::Right };
                    let Some(host) = st.last_measure() else {
                        st.loss.add(Msg::new("diag.jly.barStyleNoBar"), &s, Some(src));
                        continue;
                    };
                    let lines = host.barlines.get_or_insert_with(Vec::new);
                    let k = match lines.iter().position(|b| b.location == loc) {
                        Some(k) => k,
                        None => {
                            lines.push(barline(loc, None, Some(src)));
                            lines.len() - 1
                        }
                    };
                    let hit: Option<(Option<BarStyle>, Option<RepeatDir>)> = match s.as_str() {
                        ".|:" => Some((Some(BarStyle::HeavyLight), Some(RepeatDir::Forward))),
                        ".|" => Some((Some(BarStyle::HeavyLight), None)),
                        ":|." | ":|" => Some((Some(BarStyle::LightHeavy), Some(RepeatDir::Backward))),
                        ":|:" => Some((Some(BarStyle::LightLight), Some(RepeatDir::Backward))),
                        "|." => Some((Some(BarStyle::LightHeavy), None)),
                        "||" => Some((Some(BarStyle::LightLight), None)),
                        "|" => Some((Some(BarStyle::Regular), None)),
                        _ if is_proto_key(&s) => Some((None, None)),
                        _ => None,
                    };
                    let Some((style, repeat)) = hit else {
                        st.loss.add(Msg::new("diag.jly.barStyle"), &s, Some(src));
                        continue;
                    };
                    let bl = &mut lines[k];
                    if style.is_some() {
                        bl.style = style;
                    }
                    if repeat.is_some() {
                        bl.repeat = repeat;
                    }
                    if s == ":|:" {
                        bl.also_forward = Some(true);
                    }
                }
                JlyToken::Multirest { n } => {
                    let song = st.doc.songs.last().unwrap();
                    let beats = song.time.as_ref().map_or(4.0, |t| t.beats) * (SIMPLE_DIVISIONS * 4.0 / song.time.as_ref().map_or(4.0, |t| t.beat_type));
                    let src = span_at(i);
                    let mut k = 0.0;
                    while k < *n {
                        st.open_measure(src);
                        let id = st.ids.next();
                        let m = st.last_measure().unwrap();
                        m.barlines.get_or_insert_with(Vec::new).push(barline(BarLocation::Right, Some(BarStyle::Regular), Some(src)));
                        m.elements.push(Element::Chord(Chord {
                            id,
                            duration: Duration { divisions: js::round(beats), kind: Some(NoteType::Whole), dots: 0.0, time_mod: None },
                            rest: Some(RestInfo { measure: Some(true), ..Default::default() }),
                            voice: 1.0,
                            staff: 1.0,
                            source: Some(src),
                            ..Default::default()
                        }));
                        st.cur = false;
                        k += 1.0;
                    }
                }
                JlyToken::RepeatOpen => {
                    let src = span_at(i);
                    st.ensure_cur(src);
                    let m = st.last_measure().unwrap();
                    let lines = m.barlines.get_or_insert_with(Vec::new);
                    if let Some(left) = lines.iter_mut().find(|b| b.location == BarLocation::Left) {
                        left.repeat = Some(RepeatDir::Forward);
                    } else {
                        lines.insert(0, Barline { repeat: Some(RepeatDir::Forward), ..barline(BarLocation::Left, Some(BarStyle::HeavyLight), Some(src)) });
                    }
                    st.repeats.push(Repeat { r_end: -1, a_start: -1, a_end: -1 });
                }
                JlyToken::AltOpen => {
                    if st.repeats.last().is_none_or(|r| r.r_end < 0) {
                        st.loss.add(Msg::new("diag.jly.altNoClose"), "A{", Some(span_at(i)));
                        continue;
                    }
                    st.ensure_cur(span_at(i));
                    let n = st.n_measures() as i64;
                    st.repeats.last_mut().unwrap().a_start = n - 1;
                }
                JlyToken::PercentOpen { times } => {
                    let n = st.n_measures();
                    st.percent_stack.push((n, *times));
                }
                JlyToken::RepeatClose => {
                    if let Some((from, times)) = st.percent_stack.pop() {
                        if st.cur_nonempty() {
                            let src = span_at(i);
                            st.last_measure().unwrap().barlines.get_or_insert_with(Vec::new).push(barline(BarLocation::Right, Some(BarStyle::Regular), Some(src)));
                            st.cur = false;
                        }
                        let to = st.n_measures();
                        st.percent_ranges.push(Percent { from, to, times });
                        continue;
                    }
                    if st.repeats.is_empty() {
                        st.loss.add(Msg::new("diag.jly.closeNoOpen"), "}", Some(span_at(i)));
                        continue;
                    }
                    if st.cur_nonempty() {
                        let src = span_at(i);
                        st.last_measure().unwrap().barlines.get_or_insert_with(Vec::new).push(barline(BarLocation::Right, Some(BarStyle::Regular), Some(src)));
                        st.cur = false;
                    }
                    let n = st.n_measures() as i64;
                    let open = st.repeats.last_mut().unwrap();
                    if open.a_start >= 0 && open.a_end < 0 {
                        open.a_end = n - 1;
                    } else if open.r_end < 0 {
                        open.r_end = n - 1;
                    } else {
                        st.loss.add(Msg::new("diag.jly.closeExtra"), "}", Some(span_at(i)));
                    }
                }
                JlyToken::Grace { notes } => {
                    let src = span_at(i);
                    st.ensure_cur(src);
                    for g in notes {
                        let mut note = Note { degree: Some(Degree { number: g.degree, octave_shift: g.octave, accidental: None }), ..Default::default() };
                        if let Some(a) = acc_of(&g.alter) {
                            note.accidental = Some(a.clone());
                            note.degree.as_mut().unwrap().accidental = Some(a);
                        }
                        let id = st.ids.next();
                        st.last_measure().unwrap().elements.push(Element::Chord(Chord {
                            id,
                            notes: vec![note],
                            duration: Duration { divisions: 0.0, kind: Some(grace_type_of(g.beams)), dots: g.dots, time_mod: None },
                            grace: Some(GraceInfo::default()),
                            voice: 1.0,
                            staff: 1.0,
                            source: Some(src),
                            ..Default::default()
                        }));
                    }
                }
                JlyToken::Bar => {
                    let src = span_at(i);
                    if st.cur_nonempty() {
                        st.last_measure().unwrap().barlines.get_or_insert_with(Vec::new).push(barline(BarLocation::Right, Some(BarStyle::Regular), Some(src)));
                        st.cur = false;
                    } else {
                        st.ensure_cur(src);
                        st.last_measure().unwrap().barlines.get_or_insert_with(Vec::new).push(barline(BarLocation::Left, Some(BarStyle::Regular), Some(src)));
                    }
                }
                JlyToken::SlurOpen { melisma } => {
                    let after_note = i > 0 && matches!(ml.tokens[i - 1], JlyToken::Note(_)) && st.prev_chord.is_some();
                    if *melisma {
                        if after_note {
                            st.melisma_open += 1;
                        } else {
                            st.pending_melisma += 1;
                        }
                    }
                    let start = if after_note { st.prev_chord.map(|l| chord_at(st.doc.songs.last_mut().unwrap(), l).id) } else { None };
                    st.open_slurs.push(OpenSlur { start, melisma: *melisma, source: span_at(i) });
                }
                JlyToken::SlurClose { melisma } => {
                    if *melisma {
                        st.melisma_open = (st.melisma_open - 1).max(0);
                    }
                    let open = st.open_slurs.iter().rposition(|s| s.melisma == *melisma).map(|k| st.open_slurs.remove(k));
                    let end = st.prev_chord.map(|l| chord_at(st.doc.songs.last_mut().unwrap(), l).id);
                    let ok = match (&open, end) {
                        (Some(OpenSlur { start: Some(s), .. }), Some(e)) => *s != e,
                        _ => false,
                    };
                    if !ok {
                        let (m, raw) = if *melisma { ("diag.jly.slurUnpaired", ")") } else { ("diag.jly.phraseUnpaired", "\\)") };
                        st.loss.add(Msg::new(m), raw, Some(span_at(i)));
                        continue;
                    }
                    let open = open.unwrap();
                    let level = st.open_slurs.len() as f64;
                    let mut mark = Mark::new(MarkType::Slur, open.start.unwrap(), end.unwrap());
                    mark.level = Some(level);
                    mark.open_source = Some(open.source);
                    mark.close_source = Some(span_at(i));
                    st.song().marks.push(mark);
                }
                JlyToken::TupletOpen { n } => st.open_tuplet = Some(*n),
                JlyToken::TupletClose => st.open_tuplet = None,
                JlyToken::Tie => st.pending_tie = true,
                JlyToken::Sustain => {
                    if st.cur_nonempty() {
                        let id = st.ids.next();
                        let src = span_at(i);
                        let host = st.last_chord().unwrap();
                        host.duration.divisions += SIMPLE_DIVISIONS;
                        host.sustains.get_or_insert_with(Vec::new).push(Sustain {
                            id,
                            harmony: None,
                            notations: None,
                            ornaments: None,
                            section_word: None,
                            lyric_anchor: None,
                            lyrics: None,
                            before: None,
                            line_break_after: None,
                            attached_sources: None,
                            source: Some(src),
                        });
                    } else {
                        st.unknown.push("-".into());
                    }
                }
                JlyToken::Note(tk) => {
                    let src = span_at(i);
                    st.ensure_cur(src);
                    let divisions = js::round(SIMPLE_DIVISIONS * 2f64.powf(-tk.beams) * dot_factor(tk.dots));
                    let id = st.ids.next();
                    let mut ch = Chord { id, duration: Duration { divisions, kind: None, dots: tk.dots, time_mod: None }, voice: 1.0, staff: 1.0, source: Some(src), ..Default::default() };
                    if let Some(n) = st.open_tuplet {
                        ch.duration.time_mod = Some(TimeMod { actual: n, normal: tuplet_normal(n), normal_type: None });
                    }
                    if tk.beams > 0.0 {
                        ch.beams = Some((0..js::repeat_count(tk.beams)).map(|_| BeamVal::Continue).collect());
                    }
                    let mut tie_stop = false;
                    if tk.degree == 0.0 {
                        ch.rest = Some(RestInfo::default());
                    } else {
                        let mut note = Note { degree: Some(Degree { number: tk.degree, octave_shift: tk.octave, accidental: None }), ..Default::default() };
                        if let Some(a) = acc_of(&tk.alter) {
                            note.accidental = Some(a.clone());
                            note.degree.as_mut().unwrap().accidental = Some(a);
                        }
                        if st.pending_tie {
                            if let Some(loc) = st.prev_chord {
                                let song = st.doc.songs.last_mut().unwrap();
                                let prev = chord_at(song, loc);
                                let prev_id = prev.id;
                                if let Some(pn) = prev.notes.first_mut() {
                                    pn.tie.get_or_insert_with(Default::default).start = Some(true);
                                    let mut m = Mark::new(MarkType::Tied, prev_id, id);
                                    m.number = Some(1.0);
                                    song.marks.push(m);
                                }
                            }
                            note.tie.get_or_insert_with(Default::default).stop = Some(true);
                            tie_stop = true;
                            st.pending_tie = false;
                        }
                        ch.notes.push(note);
                        for extra in tk.chord.iter().flatten() {
                            let mut n2 = Note { degree: Some(Degree { number: extra.degree, octave_shift: extra.octave, accidental: None }), ..Default::default() };
                            if let Some(a) = acc_of(&extra.alter) {
                                n2.accidental = Some(a.clone());
                                n2.degree.as_mut().unwrap().accidental = Some(a);
                            }
                            ch.notes.push(n2);
                        }
                    }
                    let grace = ch.grace.is_some();
                    let pi = st.pi();
                    let m = st.part();
                    let mi = m.measures.len() - 1;
                    let ei = m.measures[mi].elements.len();
                    m.measures[mi].elements.push(Element::Chord(ch));
                    st.prev_chord = Some((pi, mi, ei));
                    for s in &mut st.open_slurs {
                        if s.start.is_none() {
                            s.start = Some(id);
                        }
                    }
                    if tk.degree != 0.0 && !grace && st.melisma_open == 0 && !tie_stop {
                        st.slots.push((pi, mi, ei));
                    }
                    st.melisma_open += st.pending_melisma;
                    st.pending_melisma = 0;
                }
            }
        }
        line_no += 1;
        line_offset += advance_by;
        li += 1;
    }

    // 换行 / 换页写在最后一个音之后：挂到最后一个音上
    if let Some(b) = st.pending_break.take() {
        match st.last_chord() {
            Some(c) => c.line_break_after = Some(b),
            None => st.loss.add(Msg::new("diag.jly.breakNoNote"), if b == BreakKind::Page { "\\pageBreak" } else { "\\break" }, None),
        }
    }
    st.drop_open_slurs();
    st.finish_song();

    st.doc.diagnostics = st.loss.diagnostics();
    let mut unknown: Vec<String> = vec![];
    for u in st.unknown {
        if !unknown.contains(&u) {
            unknown.push(u);
        }
    }
    JlyParse { doc: st.doc, losses: st.loss.list(), unknown }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words() {
        let mut l = JlyLosses::new();
        assert_eq!(scan_word("s1.", &mut l, None), Some(JlyToken::Note(JlyNote { degree: 1.0, alter: "".into(), octave: 0.0, beams: 2.0, dots: 1.0, chord: None })));
        assert_eq!(scan_word("1s.", &mut l, None), scan_word("s1.", &mut l, None));
        assert!(matches!(scan_word(",135'", &mut l, None), Some(JlyToken::Note(JlyNote { chord: Some(_), .. }))));
        assert_eq!(scan_word("D.C.", &mut l, None), Some(JlyToken::Jump { text: "D.C.".into() }));
        assert_eq!(scan_word("\\mf", &mut l, None), Some(JlyToken::Dynamic { name: "mf".into() }));
        assert_eq!(scan_word("R0{", &mut l, None), None);
        assert_eq!(scan_word("x", &mut l, None), Some(JlyToken::Loss { what: "diag.jly.nyPercussion".into() }));
    }

    #[test]
    fn parse_basic() {
        let r = parse_jly("title=测试\n1=D\n3/4\n1 ( 2 3 ) 4 - | 5 ~ | 5 0 |\nL: A B C D\n");
        let song = &r.doc.songs[0];
        assert_eq!(song.work.title.as_deref(), Some("测试"));
        assert_eq!(song.parts[0].measures.len(), 3);
        assert_eq!(song.marks.len(), 2);
        let lyr: Vec<_> = song.parts[0].measures.iter().flat_map(|m| m.elements.iter()).filter_map(|e| e.as_chord()?.lyrics.as_ref()?.first().map(|l| l.text.clone())).collect();
        assert_eq!(lyr, ["A", "B", "C"]); // 弧内的 2 3 不吃字、延音线接来的 5 不吃字，D 多出来
        assert_eq!(r.losses.len(), 1);
    }

    #[test]
    fn rewrap() {
        let t = "title=x\n1 2 | 3 4 | 5 6 | 7 1 | 2 3 |\nL: a b\n";
        assert_eq!(rewrap_jly_text(t, 2.0, false), "title=x\n1 2 | 3 4 |\n5 6 | 7 1 |\n2 3 |\nL: a b\n");
        assert!(is_jly_music_line(" 1 2 |"));
        assert!(!is_jly_music_line("4/4"));
    }
}
