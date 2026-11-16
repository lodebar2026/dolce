//! ABC 家族音乐体的词法（同 `abcfamily/lex.ts` 基类 + `dialect123.ts` / `dialectabc.ts` / `dialectjcx.ts`）：一行音乐代码 → token 流。
//!
//! TS 是一个基类加三个子类回答几个钩子（音符、休止、`-`、多连音冒号、不带引号的和弦…）；这里是一个 [`Lexer`] 按 [`Dialect`] 分派，
//! 钩子逐个照搬。只做词法（切 token、记位置），语义归 `parse`。下标一律按 UTF-16 码元（见 [`super::u16s`]）。

use super::token::*;
use super::u16s::*;
use dolce_base::{js, Msg, SourceSpan};
use dolce_model::Accidental;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialect {
    J123,
    Abc,
    Jcx,
}

impl Dialect {
    pub fn id(self) -> &'static str {
        match self {
            Dialect::J123 => "123",
            Dialect::Abc => "abc",
            Dialect::Jcx => "jcx",
        }
    }
}

/// 小节线写法 → 归一名，**按从长到短匹配**。`]` 只在 ABC 那一档认（野外文件的容错）。
const BARLINES: &[(&str, &str)] = &[
    ("[|]", "none"),
    ("||:", "repeat-start"),
    ("|::", "heavy-light:3"),
    ("::|", "light-heavy:3"),
    (":|:", "repeat-both"),
    ("::", "repeat-both"),
    ("|:", "repeat-start"),
    (":|", "repeat-end"),
    ("|]", "final"),
    ("[|", "reverse-final"),
    ("||", "double"),
    (".|", "dotted"),
    ("|", "normal"),
    ("]", "final"),
];

/// 房号列表展开：`1,3` → [1,3]；`1-3` → [1,2,3]；`1,3,5-7` → [1,3,5,6,7]
pub fn expand_ending_numbers(s: &U16) -> Vec<f64> {
    let mut out = vec![];
    for part in s.split(|&u| u == b',' as u16) {
        let d1 = digits(part, 0);
        if d1 > 0 && is(part, d1, '-') {
            let d2 = digits(part, d1 + 1);
            if d2 > 0 && d1 + 1 + d2 == part.len() {
                let a = num(&part[..d1]);
                let b = num(&part[d1 + 1..]);
                let mut k = js::min(a, b);
                let hi = js::max(a, b);
                while k <= hi {
                    out.push(k);
                    k += 1.0;
                }
                continue;
            }
        }
        if d1 > 0 && d1 == part.len() {
            out.push(num(part));
        }
    }
    out
}

/// `heavy-light:3` → ("heavy-light", 3)
fn split_barline_value(v: &str) -> (String, Option<f64>) {
    // `^(.*):(\d+)$`：贪婪 `.*` 取最后一个冒号
    if let Some(k) = v.rfind(':') {
        let tail = &v[k + 1..];
        if !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) {
            return (v[..k].to_string(), Some(js::number(tail)));
        }
    }
    (v.to_string(), None)
}

fn wedge_paren(s: &U16, i: usize) -> Option<&'static str> {
    [("(<", "crescendo start"), ("<)", "crescendo stop"), ("(>", "diminuendo start"), (">)", "diminuendo stop")]
        .iter()
        .find(|(t, _)| starts(s, i, t))
        .map(|(_, v)| *v)
}

fn match_barline(line: &U16, i: usize, stray: bool) -> Option<(&'static str, &'static str)> {
    BARLINES.iter().copied().find(|(t, _)| (*t != "]" || stray) && starts(line, i, t))
}

fn span(line_no: u32, line_offset: u32, column_base: usize, col: usize, len: usize) -> SourceSpan {
    SourceSpan {
        line: line_no,
        column: (column_base + col) as u32,
        offset: line_offset + (column_base + col) as u32,
        length: len as u32,
    }
}

fn msg(key: &str) -> Msg {
    Msg::new(key)
}

/// 不带引号的和弦名（规范 §8.1，`dialect123.ts::BARE_CHORD_RE`）：
/// `^(?:[#b][A-G]|[A-G][#b]?)[A-Za-z0-9#+\-°ø()]*(?:\/(?:[#b][A-G]|[A-G][#b]?))?$`
pub fn is_bare_chord(s: &U16) -> bool {
    /// 根音（`[#b][A-G]|[A-G][#b]?`）：回吃掉的长度
    fn root(s: &U16, i: usize) -> Option<usize> {
        if one_of(at(s, i), "#b") && within(at(s, i + 1), 'A', 'G') {
            return Some(2);
        }
        if within(at(s, i), 'A', 'G') {
            return Some(if one_of(at(s, i + 1), "#b") { 2 } else { 1 });
        }
        None
    }
    let mid = |u: u16| -> bool {
        ch(u).is_some_and(|c| c.is_ascii_alphanumeric() || "#+-°ø()".contains(c))
    };
    // 根音两种分支都试（`[A-G][#b]?` 的 `?` 可回退，但 `#`/`b` 也在中段字符集里，结果相同）
    let Some(r) = root(s, 0) else { return false };
    let mut k = r;
    while k < s.len() && mid(s[k]) {
        k += 1;
    }
    if k == s.len() {
        return true;
    }
    if !is(s, k, '/') {
        return false;
    }
    let b = k + 1;
    // 低音：`[#b][A-G]` 后到底，或 `[A-G]` 后可跟一个 `[#b]` 到底
    if one_of(at(s, b), "#b") && within(at(s, b + 1), 'A', 'G') && b + 2 == s.len() {
        return true;
    }
    if within(at(s, b), 'A', 'G') {
        if b + 1 == s.len() {
            return true;
        }
        if one_of(at(s, b + 1), "#b") && b + 2 == s.len() {
            return true;
        }
    }
    false
}

pub struct Lexer {
    pub dialect: Dialect,
}

pub const LEXER_123: Lexer = Lexer { dialect: Dialect::J123 };
pub const LEXER_ABC: Lexer = Lexer { dialect: Dialect::Abc };
pub const LEXER_JCX: Lexer = Lexer { dialect: Dialect::Jcx };

/// 多连音起头：`(n:` 等
struct TupletScan {
    len: usize,
    n: f64,
    p: Option<f64>,
    q: Option<f64>,
}

impl Lexer {
    // ────────── 方言钩子 ──────────

    fn hyphen(&self) -> TokenKind {
        if self.dialect == Dialect::J123 { TokenKind::Sustain } else { TokenKind::Tie }
    }
    fn tuplet_needs_colon(&self) -> bool {
        self.dialect == Dialect::J123
    }
    fn voice_overlay(&self) -> bool {
        self.dialect != Dialect::Jcx
    }
    fn rhythm_positions(&self) -> bool {
        self.dialect == Dialect::J123
    }
    fn stray_bracket_is_final(&self) -> bool {
        self.dialect != Dialect::J123
    }
    fn arc_next_tilde(&self) -> bool {
        self.dialect == Dialect::J123
    }
    fn rhythm_letter(&self, u: u16) -> bool {
        match self.dialect {
            Dialect::J123 => u == b'X' as u16,
            Dialect::Abc => false,
            Dialect::Jcx => u == b'X' as u16 || u == b'x' as u16,
        }
    }
    fn invisible_rest(&self) -> u16 {
        if self.dialect == Dialect::Jcx { b'@' as u16 } else { b'x' as u16 }
    }
    fn wedge_parens(&self) -> bool {
        self.dialect == Dialect::Jcx
    }
    fn post_grace_mark(&self) -> Option<u16> {
        if self.dialect == Dialect::Jcx { Some(b'@' as u16) } else { None }
    }

    /// ABC 的单字符装饰（§4.14 shorthand）
    fn shorthand_decoration(&self, line: &U16, i: usize) -> Option<&'static str> {
        if self.dialect == Dialect::J123 {
            return None;
        }
        Some(match ch(line[i])? {
            '.' => "staccato",
            '~' => "roll",
            'u' => "upbow",
            'v' => "downbow",
            'H' => "fermata",
            'I' => "I",
            'J' => "slide",
            'K' => "K",
            'L' => "accent",
            'M' => "lowermordent",
            'N' => "N",
            'O' => "coda",
            'P' => "uppermordent",
            'Q' => "Q",
            'R' => "roll",
            'S' => "segno",
            'T' => "trill",
            'U' => "U",
            'V' => "V",
            'W' => "W",
            _ => return None,
        })
    }

    /// 时值修饰
    fn scan_duration(&self, line: &U16, i: usize) -> Option<DurationScan> {
        if self.dialect == Dialect::J123 {
            // `_` 减时线与 `.` 附点，可交替
            let (mut beams, mut dots, mut j) = (0, 0, i);
            while j < line.len() {
                if line[j] == b'_' as u16 {
                    beams += 1;
                } else if line[j] == b'.' as u16 {
                    dots += 1;
                } else {
                    break;
                }
                j += 1;
            }
            if j == i {
                return None;
            }
            return Some(DurationScan { beams, dots, next: j, ..Default::default() });
        }
        // ABC：`^(\d*)(\/+)?(\d*)`
        let d1 = digits(line, i);
        let mut j = i + d1;
        let mut slashes = 0;
        while is(line, j + slashes, '/') {
            slashes += 1;
        }
        j += slashes;
        let d3 = digits(line, j);
        j += d3;
        if j == i {
            return None;
        }
        let n = if d1 > 0 { num(&line[i..i + d1]) } else { 1.0 };
        let mut den = 1.0;
        if slashes > 0 {
            den = if d3 > 0 {
                num(&line[j - d3..j])
            } else {
                // `1 << m[2].length`：JS 32 位移位
                (1i32).wrapping_shl(slashes as u32) as f64
            };
        }
        if den == 0.0 {
            den = 1.0;
        }
        Some(DurationScan { beams: 0, dots: 0, num: Some(n), den: Some(den), next: j, ..Default::default() })
    }

    /// 休止。123 的 `0` 走 `scan_note`，这里只认整小节休止 `Z` / `Zn`
    fn scan_rest(&self, line: &U16, i: usize) -> Option<DurationScan> {
        if self.dialect == Dialect::J123 {
            if !is(line, i, 'Z') {
                return None;
            }
            let d = digits(line, i + 1);
            let bars = if d > 0 { js::max(1.0, num(&line[i + 1..i + 1 + d])) } else { 1.0 };
            return Some(DurationScan { bars: Some(bars), next: i + 1 + d, ..Default::default() });
        }
        let c = at(line, i)?;
        if c != b'z' as u16 && c != b'Z' as u16 {
            return None;
        }
        let dur = self.scan_duration(line, i + 1);
        if c == b'Z' as u16 {
            let n = dur.and_then(|d| d.num).unwrap_or(1.0);
            return Some(DurationScan { bars: Some(js::max(1.0, n)), next: dur.map_or(i + 1, |d| d.next), ..Default::default() });
        }
        Some(DurationScan {
            num: Some(dur.and_then(|d| d.num).unwrap_or(1.0)),
            den: Some(dur.and_then(|d| d.den).unwrap_or(1.0)),
            next: dur.map_or(i + 1, |d| d.next),
            ..Default::default()
        })
    }

    fn scan_note(&self, line: &U16, i: usize) -> Option<NoteScan> {
        if self.dialect == Dialect::J123 {
            return self.scan_note_123(line, i);
        }
        let mut j = i;
        let mut accidental = None;
        let mut alter = None;
        for (t, acc, semi) in [
            ("^^", Accidental::DoubleSharp, 2),
            ("__", Accidental::DoubleFlat, -2),
            ("^", Accidental::Sharp, 1),
            ("_", Accidental::Flat, -1),
            ("=", Accidental::Natural, 0),
        ] {
            if starts(line, j, t) {
                accidental = Some(acc);
                alter = Some(semi);
                j += t.len();
                break;
            }
        }
        let c = ch(at(line, j)?)?;
        if !matches!(c, 'A'..='G' | 'a'..='g') {
            return None;
        }
        let mut octave = if c.is_ascii_lowercase() { 1 } else { 0 };
        let step = c.to_ascii_uppercase().to_string();
        j += 1;
        while j < line.len() {
            if line[j] == b'\'' as u16 {
                octave += 1;
            } else if line[j] == b',' as u16 {
                octave -= 1;
            } else {
                break;
            }
            j += 1;
        }
        let dur = self.scan_duration(line, j);
        Some(NoteScan {
            dur: DurationScan {
                beams: 0,
                dots: 0,
                num: Some(dur.and_then(|d| d.num).unwrap_or(1.0)),
                den: Some(dur.and_then(|d| d.den).unwrap_or(1.0)),
                bars: None,
                next: dur.map_or(j, |d| d.next),
            },
            step: Some(step),
            octave,
            accidental,
            alter,
            degree: None,
        })
    }

    /// 123 音符：`[#b n]数字['`,]*[_.]*`，变音记号前置
    fn scan_note_123(&self, line: &U16, i: usize) -> Option<NoteScan> {
        let mut j = i;
        let mut accidental = None;
        let d07 = |u: Option<u16>| within(u, '0', '7');
        if (starts(line, j, "##") || starts(line, j, "bb")) && d07(at(line, j + 2)) {
            accidental = Some(if is(line, j, '#') { Accidental::DoubleSharp } else { Accidental::DoubleFlat });
            j += 2;
        } else {
            let one = match at(line, j).and_then(ch) {
                Some('#') => Some(Accidental::Sharp),
                Some('b') => Some(Accidental::Flat),
                Some('n') => Some(Accidental::Natural),
                _ => None,
            };
            if one.is_some() && d07(at(line, j + 1)) {
                accidental = one;
                j += 1;
            }
        }
        let d = at(line, j);
        if !d07(d) {
            return None;
        }
        let degree = (d? - b'0' as u16) as u32;
        j += 1;
        let mut octave = 0;
        while j < line.len() {
            if line[j] == b'\'' as u16 {
                octave += 1;
            } else if line[j] == b',' as u16 {
                octave -= 1;
            } else {
                break;
            }
            j += 1;
        }
        let dur = self.scan_duration(line, j);
        Some(NoteScan {
            dur: DurationScan {
                beams: dur.map_or(0, |d| d.beams),
                dots: dur.map_or(0, |d| d.dots),
                next: dur.map_or(j, |d| d.next),
                ..Default::default()
            },
            degree: Some(degree),
            octave,
            accidental,
            step: None,
            alter: None,
        })
    }

    /// 同时发声的和音：`(原文长度, 音, 共用时值)`
    fn scan_chord_group(&self, line: &U16, i: usize) -> Option<(usize, Vec<NoteScan>, Option<DurationScan>)> {
        if !is(line, i, '[') {
            return None;
        }
        match self.dialect {
            Dialect::J123 => {
                // 同时敲的几个节奏音符 `[X@E5X@F5]`
                let mut k = i + 1;
                let mut groups = 0;
                while is(line, k, 'X') {
                    k += 1;
                    if is(line, k, '@') && within(at(line, k + 1), 'A', 'G') && at(line, k + 2).is_some_and(digit) {
                        k += 3;
                    }
                    groups += 1;
                }
                if groups >= 2 && is(line, k, ']') {
                    return Some((k + 1 - i, vec![], self.scan_duration(line, k + 1)));
                }
                let mut notes = vec![];
                let mut k = i + 1;
                while k < line.len() && !is(line, k, ']') {
                    let n = self.scan_note(line, k)?;
                    if n.degree == Some(0) || n.dur.beams > 0 || n.dur.dots > 0 {
                        return None;
                    }
                    k = n.dur.next;
                    notes.push(n);
                    if is(line, k, '~') {
                        k += 1;
                    }
                }
                if !is(line, k, ']') || notes.len() < 2 {
                    return None;
                }
                Some((k + 1 - i, notes, self.scan_duration(line, k + 1)))
            }
            Dialect::Abc | Dialect::Jcx => {
                let close = find(line, ']', i)?;
                let body = &line[i + 1..close];
                if body.is_empty() {
                    return None;
                }
                let mut notes = vec![];
                let mut k = 0;
                while k < body.len() {
                    let n = self.scan_note(body, k)?;
                    k = n.dur.next;
                    notes.push(n);
                    if is(body, k, '-') {
                        k += 1;
                    }
                }
                if notes.is_empty() {
                    return None;
                }
                Some((close + 1 - i, notes, self.scan_duration(line, close + 1)))
            }
        }
    }

    /// 123：`[` 后不留空格一直写到 `]`、又不是合规和音的（`^\[[\d#bnX][^\s[\]|"!]*\]`）
    fn malformed_chord_group(&self, line: &U16, i: usize) -> Option<(Msg, usize)> {
        if self.dialect != Dialect::J123 || !is(line, i, '[') {
            return None;
        }
        let c1 = at(line, i + 1);
        if !(c1.is_some_and(digit) || one_of(c1, "#bnX")) {
            return None;
        }
        let mut k = i + 2;
        while k < line.len() && !space(line[k]) && !one_of(Some(line[k]), "[]|\"!") {
            k += 1;
        }
        if !is(line, k, ']') || self.scan_chord_group(line, i).is_some() {
            return None;
        }
        let t = text(&line[i..k + 1]);
        Some((msg("diag.j123.badChordGroup").arg("text", t), k + 1 - i))
    }

    /// 123 不带引号的和弦：大写 A–G 开头（或 `#`/`b` 紧跟大写 A–G）、读到空白为止
    fn scan_bare_chord(&self, line: &U16, i: usize) -> Option<(usize, Option<Msg>)> {
        if self.dialect != Dialect::J123 {
            return None;
        }
        if !within(at(line, i), 'A', 'G') && !(one_of(at(line, i), "#b") && within(at(line, i + 1), 'A', 'G')) {
            return None;
        }
        let mut j = i + 1;
        while j < line.len() && !is(line, j, ' ') && !is(line, j, '\t') {
            j += 1;
        }
        let body = &line[i..j];
        let error = if j >= line.len() {
            Some(msg("diag.abc.chordSpace").arg("body", text(body)))
        } else if !is_bare_chord(body) {
            Some(msg("diag.abc.badChord").arg("body", text(body)))
        } else {
            None
        };
        Some((j - i, error))
    }

    /// 破碎节奏 `>` / `<`（ABC §4.4）
    fn scan_broken(&self, line: &U16, i: usize) -> Option<(usize, i32)> {
        if self.dialect == Dialect::J123 {
            return None;
        }
        let c = at(line, i)?;
        if c != b'>' as u16 && c != b'<' as u16 {
            return None;
        }
        let mut k = i;
        while at(line, k) == Some(c) {
            k += 1;
        }
        let n = (k - i) as i32;
        Some((k - i, if c == b'>' as u16 { n } else { -n }))
    }

    fn match_tuplet(&self, line: &U16, i: usize) -> Option<TupletScan> {
        if !is(line, i, '(') {
            return None;
        }
        let d1 = digits(line, i + 1);
        if d1 == 0 {
            return None;
        }
        let n = num(&line[i + 1..i + 1 + d1]);
        let mut k = i + 1 + d1;
        if self.tuplet_needs_colon() {
            // `^\((\d+)(?::(\d+))?:`：可选组吃了却接不上冒号时回退
            if is(line, k, ':') {
                let d2 = digits(line, k + 1);
                if d2 > 0 && is(line, k + 1 + d2, ':') {
                    return Some(TupletScan { len: k + 2 + d2 - i, n, p: Some(num(&line[k + 1..k + 1 + d2])), q: None });
                }
                return Some(TupletScan { len: k + 1 - i, n, p: None, q: None });
            }
            return None;
        }
        // `^\((\d+)(?::(\d*)(?::(\d*))?)?`
        let mut p = None;
        let mut q = None;
        if is(line, k, ':') {
            let d2 = digits(line, k + 1);
            if d2 > 0 {
                p = Some(num(&line[k + 1..k + 1 + d2]));
            }
            k += 1 + d2;
            if is(line, k, ':') {
                let d3 = digits(line, k + 1);
                if d3 > 0 {
                    q = Some(num(&line[k + 1..k + 1 + d3]));
                }
                k += 1 + d3;
            }
        }
        Some(TupletScan { len: k - i, n, p, q })
    }

    // ────────── 共用扫描 ──────────

    /// 扫一行音乐体（`line` 不含字段前缀；`line_no` 0 基；`line_offset` 该行在全文的 UTF-16 偏移；`column_base` 行内起始列）
    pub fn lex_line(&self, line: &U16, line_no: u32, line_offset: u32, column_base: usize) -> LexResult {
        let mut tokens: Vec<Token> = vec![];
        let mut errors: Vec<LexError> = vec![];
        let sp = |col: usize, len: usize| span(line_no, line_offset, column_base, col, len);
        let mut i = 0;
        let n = line.len();
        let tok = |kind: TokenKind, a: usize, b: usize| Token::new(kind, text(&line[a..b]), sp(a, b - a));

        while i < n {
            let c = line[i];
            let start = i;
            let cc = ch(c);

            if cc == Some('%') {
                break;
            }
            if cc == Some(' ') || cc == Some('\t') {
                while i < n && (is(line, i, ' ') || is(line, i, '\t')) {
                    i += 1;
                }
                tokens.push(tok(TokenKind::Space, start, i));
                continue;
            }
            if cc == Some('`') {
                i += 1;
                continue;
            }
            if cc == Some('$') {
                let k = if is(line, i + 1, '$') { 2 } else { 1 };
                i += k;
                tokens.push(tok(TokenKind::Break, start, start + k));
                continue;
            }
            if cc == Some('&') && self.voice_overlay() {
                let mut k = i;
                while is(line, k, '&') {
                    k += 1;
                }
                if k - i > 1 {
                    let run = text(&line[i..k]);
                    errors.push(LexError { msg: msg("diag.abc.multiVoice").arg("run", run), source: sp(start, k - i) });
                    i = k;
                    tokens.push(tok(TokenKind::Unknown, start, k));
                    continue;
                }
                i += 1;
                tokens.push(tok(TokenKind::Overlay, start, i));
                continue;
            }
            if cc == Some('~') && self.arc_next_tilde() {
                i += 1;
                tokens.push(tok(TokenKind::ArcNext, start, i));
                continue;
            }
            if self.wedge_parens() {
                if let Some(w) = wedge_paren(line, i) {
                    i += 2;
                    let mut t = tok(TokenKind::Wedge, start, i);
                    t.value = Some(w.into());
                    tokens.push(t);
                    continue;
                }
            }
            if cc == Some('-') {
                i += 1;
                tokens.push(tok(self.hyphen(), start, i));
                continue;
            }
            // 行内字段 `^\[[A-Za-z]\s*[:：]`
            if cc == Some('[') && at(line, i + 1).and_then(ch).is_some_and(|c| c.is_ascii_alphabetic()) && {
                let k = i + 2 + spaces(line, i + 2);
                one_of(at(line, k), ":：")
            } {
                let Some(close) = find(line, ']', i) else {
                    errors.push(LexError { msg: msg("diag.abc.inlineOpen"), source: sp(start, n - start) });
                    i = n;
                    continue;
                };
                let body = text(&line[i + 1..close]);
                i = close + 1;
                let mut t = tok(TokenKind::InlineField, start, i);
                t.value = Some(body);
                tokens.push(t);
                continue;
            }
            if let Some((m, len)) = self.malformed_chord_group(line, i) {
                errors.push(LexError { msg: m, source: sp(start, len) });
                i += len;
                continue;
            }
            // 房号 `[1` `[1,3` `[1-3`（`^\[([\d,\-]+)`）
            if cc == Some('[') && at(line, i + 1).is_some_and(digit) && self.scan_chord_group(line, i).is_none() {
                let mut k = i + 1;
                while k < n && (digit(line[k]) || is(line, k, ',') || is(line, k, '-')) {
                    k += 1;
                }
                let nums = expand_ending_numbers(&line[i + 1..k]);
                i = k;
                let mut t = tok(TokenKind::Ending, start, i);
                t.numbers = Some(nums);
                tokens.push(t);
                continue;
            }
            if let Some((bt, bv)) = match_barline(line, i, self.stray_bracket_is_final()) {
                i += bt.chars().count();
                let (style, times) = split_barline_value(bv);
                let mut t = tok(TokenKind::Barline, start, i);
                t.value = Some(style);
                // `if (times)`：0 不记
                if let Some(x) = times.filter(|&x| x != 0.0) {
                    t.repeat_times = Some(x);
                }
                tokens.push(t);
                // 紧贴小节线的简写房号 `|1` `:|2`（`^(\d[\d,\-]*)`）
                if at(line, i).is_some_and(digit) {
                    let s2 = i;
                    let mut k = i + 1;
                    while k < n && (digit(line[k]) || is(line, k, ',') || is(line, k, '-')) {
                        k += 1;
                    }
                    i = k;
                    let mut t = tok(TokenKind::Ending, s2, k);
                    t.numbers = Some(expand_ending_numbers(&line[s2..k]));
                    tokens.push(t);
                }
                continue;
            }
            if let Some(tp) = self.match_tuplet(line, i) {
                i += tp.len;
                let mut t = tok(TokenKind::Tuplet, start, i);
                t.value = Some(js::num_to_string(tp.n));
                if tp.p.is_some() || tp.q.is_some() {
                    t.numbers = Some(vec![tp.n, tp.p.unwrap_or(0.0), tp.q.unwrap_or(0.0)]);
                }
                tokens.push(t);
                continue;
            }
            if cc == Some('(') {
                i += 1;
                tokens.push(tok(TokenKind::SlurStart, start, i));
                continue;
            }
            if cc == Some(')') {
                i += 1;
                tokens.push(tok(TokenKind::SlurEnd, start, i));
                continue;
            }
            if cc == Some('!') {
                let Some(close) = find(line, '!', i + 1) else {
                    errors.push(LexError { msg: msg("diag.abc.decoOpen"), source: sp(start, n - start) });
                    i = n;
                    continue;
                };
                let body = text(&line[i + 1..close]);
                i = close + 1;
                let mut t = tok(TokenKind::Deco, start, i);
                t.value = Some(body);
                tokens.push(t);
                continue;
            }
            if cc == Some('"') {
                let Some(close) = find(line, '"', i + 1) else {
                    errors.push(LexError { msg: msg("diag.abc.quoteOpen"), source: sp(start, n - start) });
                    i = n;
                    continue;
                };
                let anno = one_of(at(line, i + 1).filter(|_| i + 1 < close), "^_<>@");
                let body = text(&line[i + 1..close]);
                i = close + 1;
                let mut t = tok(if anno { TokenKind::Annotation } else { TokenKind::Chord }, start, i);
                t.value = Some(body);
                tokens.push(t);
                continue;
            }
            if let Some((len, error)) = self.scan_bare_chord(line, i) {
                let body = text(&line[i..i + len]);
                if let Some(e) = error {
                    errors.push(LexError { msg: e, source: sp(start, len) });
                }
                i += len;
                let mut t = tok(TokenKind::Chord, start, i);
                t.value = Some(body);
                tokens.push(t);
                continue;
            }
            if cc == Some('{') {
                let Some(close) = find(line, '}', i) else {
                    errors.push(LexError { msg: msg("diag.abc.graceOpen"), source: sp(start, n - start) });
                    i = n;
                    continue;
                };
                let mut body_at = i + 1;
                let acciaccatura = body_at < close && is(line, body_at, '/');
                if acciaccatura {
                    body_at += 1;
                }
                let after = self.post_grace_mark().is_some_and(|m| body_at < close && line[body_at] == m);
                if after {
                    body_at += 1;
                }
                let inner = self.lex_line(&line[body_at..close], line_no, line_offset, column_base + body_at);
                i = close + 1;
                let mut t = tok(TokenKind::Grace, start, i);
                t.notes = Some(inner.tokens.into_iter().filter(|x| matches!(x.kind, TokenKind::Note | TokenKind::ChordGroup)).collect());
                if acciaccatura {
                    t.acciaccatura = Some(true);
                }
                if after {
                    t.grace_after = Some(true);
                }
                tokens.push(t);
                continue;
            }
            if self.rhythm_letter(c) {
                i += 1;
                let mut value = None;
                if self.rhythm_positions() && is(line, i, '@') && within(at(line, i + 1), 'A', 'G') && at(line, i + 2).is_some_and(digit) {
                    value = Some(text(&line[i + 1..i + 3]));
                    i += 3;
                }
                let m = self.scan_duration(line, i);
                if let Some(m) = m {
                    i = m.next;
                }
                let mut t = tok(TokenKind::Rhythm, start, i);
                // TS 先写 `text: ch`（只那一个字），位置却到时值末尾
                t.text = text(&line[start..start + 1]);
                t.value = value;
                if let Some(m) = m {
                    t.beams = Some(m.beams);
                    t.dots = Some(m.dots);
                    t.num = m.num;
                    t.den = m.den;
                }
                tokens.push(t);
                continue;
            }
            if cc == Some('y') || c == self.invisible_rest() {
                i += 1;
                let y = cc == Some('y');
                let m = if !y { self.scan_duration(line, i) } else { None };
                if let Some(m) = m {
                    i = m.next;
                }
                let mut t = tok(TokenKind::Spacer, start, i);
                t.text = text(&line[start..start + 1]);
                t.value = Some(if y { "y" } else { "x" }.into());
                if let Some(m) = m {
                    t.beams = Some(m.beams);
                    t.dots = Some(m.dots);
                    t.num = m.num;
                    t.den = m.den;
                }
                tokens.push(t);
                continue;
            }
            if let Some((glen, _, dur)) = self.scan_chord_group(line, i) {
                let inner = self.lex_line(&line[i + 1..i + glen - 1], line_no, line_offset, column_base + i + 1);
                i = dur.map_or(i + glen, |d| d.next);
                let rhythms: Vec<Token> = inner.tokens.iter().filter(|x| x.kind == TokenKind::Rhythm).cloned().collect();
                let mut t;
                if rhythms.len() >= 2 {
                    t = tok(TokenKind::Rhythm, start, i);
                    t.notes = Some(rhythms);
                } else {
                    t = tok(TokenKind::ChordGroup, start, i);
                    let mut notes = vec![];
                    for (k, x) in inner.tokens.iter().enumerate() {
                        if x.kind != TokenKind::Note {
                            continue;
                        }
                        let nx = inner.tokens.get(k + 1).map(|y| y.kind);
                        let mut x = x.clone();
                        if matches!(nx, Some(TokenKind::ArcNext | TokenKind::Tie)) {
                            x.tie_next = Some(true);
                        }
                        notes.push(x);
                    }
                    t.notes = Some(notes);
                }
                if let Some(d) = dur {
                    t.num = d.num;
                    t.den = d.den;
                    if d.beams > 0 {
                        t.beams = Some(d.beams);
                    }
                    if d.dots > 0 {
                        t.dots = Some(d.dots);
                    }
                }
                tokens.push(t);
                continue;
            }
            if let Some((len, dir)) = self.scan_broken(line, i) {
                i += len;
                let mut t = tok(TokenKind::Broken, start, i);
                t.broken = Some(dir);
                tokens.push(t);
                continue;
            }
            if let Some(r) = self.scan_rest(line, i) {
                i = r.next;
                let mut t = tok(TokenKind::Rest, start, i);
                t.beams = Some(r.beams);
                t.dots = Some(r.dots);
                t.num = r.num;
                t.den = r.den;
                t.bars = r.bars;
                tokens.push(t);
                continue;
            }
            if let Some(nt) = self.scan_note(line, i) {
                i = nt.dur.next;
                let mut t = tok(TokenKind::Note, start, i);
                t.octave = Some(nt.octave);
                t.beams = Some(nt.dur.beams);
                t.dots = Some(nt.dur.dots);
                t.degree = nt.degree;
                t.step = nt.step;
                t.alter = nt.alter;
                t.accidental = nt.accidental;
                t.num = nt.dur.num;
                t.den = nt.dur.den;
                tokens.push(t);
                continue;
            }
            if let Some(name) = self.shorthand_decoration(line, i) {
                i += 1;
                let mut t = tok(TokenKind::Deco, start, i);
                t.value = Some(name.into());
                tokens.push(t);
                continue;
            }
            i += 1;
            let s = text(&line[start..start + 1]);
            errors.push(LexError { msg: msg("diag.abc.badChar").arg("ch", s), source: sp(start, 1) });
            tokens.push(tok(TokenKind::Unknown, start, i));
        }
        LexResult { tokens, errors }
    }
}
