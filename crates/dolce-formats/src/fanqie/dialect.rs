//! 文本谱的两种方言与自动嗅探（同 `fanqie/dialect.ts`）。
//!
//! - tomato：番茄简谱脚本 v1.0
//! - shige ：诗歌本文本谱，番茄的变种
//!
//! 两家在**同一个字符上给了不同含义**，所以解析器必须先定方言再动手：
//!   高低音   番茄 `'`/`,`     有谱 `g`/`d`
//!   升降还原 番茄 `#`/`$`/`=` 有谱 `#♯`/`b♭`/`♮`（另有重升 `𝄪` 重降 `𝄫`）
//!   数字 9   番茄是**节奏音符 X**；有谱是**隐藏休止（不跟词）**
//!   节奏音符 番茄 `9`；有谱字母 `X`

use super::ast::BarlineType;
use dolce_base::js::is_space;
use dolce_base::Msg;
use dolce_model::Accidental;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialect {
    Tomato,
    Shige,
}

impl Dialect {
    pub fn as_str(self) -> &'static str {
        match self {
            Dialect::Tomato => "tomato",
            Dialect::Shige => "shige",
        }
    }
    pub fn parse(s: &str) -> Option<Dialect> {
        match s {
            "tomato" => Some(Dialect::Tomato),
            "shige" => Some(Dialect::Shige),
            _ => None,
        }
    }
    pub fn spec(self) -> &'static DialectSpec {
        match self {
            Dialect::Tomato => &TOMATO,
            Dialect::Shige => &SHIGE,
        }
    }
}

pub struct DialectSpec {
    pub id: Dialect,
    /// 完整显示名（诊断信息里用）
    pub name: &'static str,
    /// 短显示名
    pub short_name: &'static str,
    /// 升高一个八度的字符
    pub octave_up: char,
    /// 降低一个八度的字符
    pub octave_down: char,
    /// 变音记号字符 → 语义（均写在数字**后方**）；TS 是对象表，键是字符串（重升重降是非 BMP 字）
    pub accidentals: &'static [(&'static str, Accidental)],
    /// 节奏音符的写法
    pub rhythm_token: char,
    /// 数字 9 是不是节奏音符（番茄）——否则是隐藏休止（有谱）
    pub nine_is_rhythm: bool,
    /// 歌词里表示「跳过一个音符」的字符；**第一个是写出去时用的那个**，其余只认不写
    pub lyric_skip: &'static [char],
    /// 小节线写法，按**从长到短**匹配
    pub barlines: &'static [(&'static str, BarlineType)],
    /// 歌词里分隔两个音节的字符（番茄用 `/`，诗歌本用空格）
    pub word_separator: char,
    /// 并字连接号：把本字并到前一个音节
    pub join_token: Option<char>,
    /// 跳转字 Fine / D.C. / D.S. 写成小节线上的文字（诗歌本）；否则写成记号 `&fine`（番茄）
    pub jump_words: bool,
    /// 跳房子不封口只在罩两小节以上时生效（番茄官方）
    pub open_volta_needs_two_measures: bool,
    pub header: HeaderStyle,
    pub emit: EmitStyle,
}

/// 写出端在两家之间不同的那几处
pub struct EmitStyle {
    pub token_gap: &'static str,
    pub blank_between_groups: bool,
    pub volta_close_after_barline: bool,
    pub volta_lead_barline: bool,
    pub label_wrap: (&'static str, &'static str),
    pub hidden_rest_no_lyric: Option<&'static str>,
    pub page_fields: bool,
    pub bare_translation_verses: bool,
    /// 不自动补减时线连断 `~` / `^`（诗歌本：识别结果里不要这两个记号，用户反馈）
    pub no_auto_boundary: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum KeyMeter {
    Split,
    Combined,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum KeyStyle {
    Prefix,
    Suffix,
}

/// 头部字段怎么写
pub struct HeaderStyle {
    pub version_line: Option<&'static str>,
    pub title_field: &'static str,
    pub index_fields: Option<(&'static str, &'static str)>,
    pub credit_field: &'static str,
    pub tempo_field: &'static str,
    pub key_meter: KeyMeter,
    pub key_field: Option<&'static str>,
    pub meter_field: Option<&'static str>,
    pub key_style: KeyStyle,
}

impl DialectSpec {
    /// `accidentals[ch]`（`ch` 是一个码元或一对代理拼成的字）
    pub fn accidental(&self, ch: &str) -> Option<Accidental> {
        self.accidentals.iter().find(|(k, _)| *k == ch).map(|(_, a)| a.clone())
    }
}

pub static TOMATO: DialectSpec = DialectSpec {
    id: Dialect::Tomato,
    name: "番茄简谱",
    short_name: "番茄",
    octave_up: '\'',
    octave_down: ',',
    accidentals: &[("#", Accidental::Sharp), ("$", Accidental::Flat), ("=", Accidental::Natural)],
    rhythm_token: '9',
    nine_is_rhythm: true,
    lyric_skip: &['@'],
    // `||/` 必须排在 `||` 之前，否则永远匹配不到两边细双线。
    barlines: &[
        (":|:", BarlineType::RepeatBoth),
        (":||", BarlineType::RepeatEnd),
        ("||:", BarlineType::RepeatStart),
        ("||/", BarlineType::Double),
        ("|:", BarlineType::RepeatStart),
        (":|", BarlineType::RepeatEnd),
        ("||", BarlineType::End),
        ("|/", BarlineType::Hidden),
        ("|*", BarlineType::Invisible),
        ("|", BarlineType::Normal),
    ],
    word_separator: '/',
    join_token: Some('~'),
    jump_words: false,
    open_volta_needs_two_measures: true,
    header: HeaderStyle {
        version_line: Some("V:1.0"),
        title_field: "B",
        index_fields: None,
        credit_field: "Z",
        tempo_field: "J",
        key_meter: KeyMeter::Split,
        key_field: Some("D"),
        meter_field: Some("P"),
        key_style: KeyStyle::Prefix,
    },
    emit: EmitStyle {
        token_gap: " ",
        blank_between_groups: true,
        volta_close_after_barline: false,
        volta_lead_barline: false,
        label_wrap: ("\"", "\""),
        hidden_rest_no_lyric: None,
        page_fields: false,
        bare_translation_verses: false,
        no_auto_boundary: false,
    },
};

pub static SHIGE: DialectSpec = DialectSpec {
    id: Dialect::Shige,
    name: "诗歌本文本谱",
    short_name: "诗歌本",
    octave_up: 'g',
    octave_down: 'd',
    accidentals: &[
        ("#", Accidental::Sharp),
        ("\u{266F}", Accidental::Sharp),
        ("b", Accidental::Flat),
        ("\u{266D}", Accidental::Flat),
        ("\u{266E}", Accidental::Natural),
        ("\u{1D12A}", Accidental::DoubleSharp),
        ("\u{1D12B}", Accidental::DoubleFlat),
    ],
    rhythm_token: 'X',
    nine_is_rhythm: false,
    // 规范里的占位符是 `/`（写出去用它）；`@` 是实际谱面里也见得到的写法，只认不写。
    lyric_skip: &['/', '@'],
    barlines: &[
        (":|:", BarlineType::RepeatBoth),
        (":||", BarlineType::RepeatEnd),
        ("||:", BarlineType::RepeatStart),
        ("|||", BarlineType::End),
        ("||/", BarlineType::Double),
        ("|:", BarlineType::RepeatStart),
        (":|", BarlineType::RepeatEnd),
        ("||", BarlineType::Double),
        ("|/", BarlineType::Hidden),
        ("|*", BarlineType::Invisible),
        ("|", BarlineType::Normal),
    ],
    word_separator: ' ',
    join_token: None,
    jump_words: true,
    open_volta_needs_two_measures: false,
    header: HeaderStyle {
        version_line: None,
        title_field: "T",
        index_fields: Some(("XL", "XR")),
        credit_field: "Z",
        tempo_field: "J",
        key_meter: KeyMeter::Combined,
        key_field: None,
        meter_field: None,
        key_style: KeyStyle::Suffix,
    },
    emit: EmitStyle {
        token_gap: "",
        blank_between_groups: false,
        volta_close_after_barline: true,
        volta_lead_barline: true,
        label_wrap: ("<", ">"),
        hidden_rest_no_lyric: Some("9"),
        page_fields: true,
        bare_translation_verses: true,
        no_auto_boundary: true,
    },
};

pub struct SniffResult {
    pub dialect: Option<Dialect>,
    /// 判据说明，认不出时用于报错
    pub reason: Msg,
}

/// `^\s*(KEYS)\s*:`（`keys` 区分大小写与否由 `ci` 定）
fn field_head(line: &[char], keys: &[&str], ci: bool) -> bool {
    let mut i = 0;
    while i < line.len() && is_space(line[i]) {
        i += 1;
    }
    for k in keys {
        let kc: Vec<char> = k.chars().collect();
        if i + kc.len() > line.len() {
            continue;
        }
        let ok = kc.iter().zip(&line[i..i + kc.len()]).all(|(a, b)| if ci { a.eq_ignore_ascii_case(b) } else { a == b });
        if !ok {
            continue;
        }
        let mut j = i + kc.len();
        while j < line.len() && is_space(line[j]) {
            j += 1;
        }
        if j < line.len() && line[j] == ':' {
            return true;
        }
    }
    false
}

/// `/^\s*[QCW]\d*\s*[<"]?/` 且 `/^\s*[QCW]\d*(?:"[^"]*"|<[^>]*>)?\s*:/`
fn body_line(line: &[char]) -> bool {
    let mut i = 0;
    while i < line.len() && is_space(line[i]) {
        i += 1;
    }
    if !matches!(line.get(i), Some('Q' | 'C' | 'W')) {
        return false;
    }
    i += 1;
    while i < line.len() && line[i].is_ascii_digit() {
        i += 1;
    }
    let after_digits = i;
    // 第二式：可选 `"…"` 或 `<…>`（回溯：不成立时当没有）
    let try_at = |mut j: usize| -> bool {
        while j < line.len() && is_space(line[j]) {
            j += 1;
        }
        j < line.len() && line[j] == ':'
    };
    if let Some(&q) = line.get(after_digits) {
        if q == '"' || q == '<' {
            let close = if q == '"' { '"' } else { '>' };
            if let Some(k) = line[after_digits + 1..].iter().position(|&c| c == close) {
                if try_at(after_digits + 1 + k + 1) {
                    return true;
                }
            }
        }
    }
    try_at(after_digits)
}

/// 按头部字段判方言。看不出（既没有任一方独有字段、也没有 Q:/C: 行）就返回 `None`。
pub fn sniff_dialect(text: &str) -> SniffResult {
    let mut tomato = 0;
    let mut shige = 0;
    let mut has_body = false;
    for raw in split_lines(text) {
        let line: Vec<char> = dolce_base::js::trim(raw).chars().collect();
        if line.is_empty() || line[0] == '#' {
            continue;
        }
        if field_head(&line, &["V", "B", "D", "P"], false) {
            tomato += 1;
        }
        if field_head(&line, &["T", "XL", "XR", "TL", "TR", "BL", "BC", "BR", "FontSize", "Margin"], true) {
            shige += 1;
        }
        // `/^\s*1\s*=/`
        {
            let mut i = 0;
            while i < line.len() && is_space(line[i]) {
                i += 1;
            }
            if line.get(i) == Some(&'1') {
                i += 1;
                while i < line.len() && is_space(line[i]) {
                    i += 1;
                }
                if line.get(i) == Some(&'=') {
                    shige += 2;
                }
            }
        }
        if body_line(&line) {
            has_body = true;
        }
    }
    if tomato == 0 && shige == 0 {
        return SniffResult { dialect: None, reason: Msg::new(if has_body { "sniff.noHeader" } else { "sniff.notFanqie" }) };
    }
    if tomato > shige {
        return SniffResult { dialect: Some(Dialect::Tomato), reason: Msg::new("sniff.tomato").arg("n", tomato as f64) };
    }
    if shige > tomato {
        return SniffResult { dialect: Some(Dialect::Shige), reason: Msg::new("sniff.shige").arg("n", shige as f64) };
    }
    // 打平时偏番茄：它是原始规范，有谱是其变种。
    SniffResult { dialect: Some(Dialect::Tomato), reason: Msg::new("sniff.tie") }
}

/// `text.split(/\r?\n/)`
pub fn split_lines(text: &str) -> Vec<&str> {
    text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect()
}
