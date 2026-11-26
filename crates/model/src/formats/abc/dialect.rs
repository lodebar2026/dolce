//! 组装期的方言钩子（同 `abcfamily/parsedialect.ts`）：时值怎么算、note token 成什么 `Note`、`K:` 怎么读、
//! `-` 是增时线还是 tie、空白算不算符杠分组、歌词跳格记号、多连音怎么收尾。组装逻辑本身三种方言共用（`parse`）。

use super::fields::{parse_key, parse_key_abc, parse_key_jcx, KeyRead};
use super::lex::Dialect;
use super::token::Token;
use crate::{Chord, Degree, Duration, Note, NoteType, Pitch, SIMPLE_DIVISIONS};

/// 默认音长（ABC 的 `L:`）
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DefaultLen {
    pub num: f64,
    pub den: f64,
}

const TYPE_BY_BEAMS: [NoteType; 7] = [NoteType::Quarter, NoteType::Eighth, NoteType::N16th, NoteType::N32nd, NoteType::N64th, NoteType::N128th, NoteType::N256th];

/// 123 的默认比例：二连音、四连音占 3，其余占小于 n 的最大 2 的幂
pub fn tuplet_normal_123(n: f64) -> f64 {
    if n == 2.0 || n == 4.0 {
        return 3.0;
    }
    let mut p = 1.0;
    while p * 2.0 < n {
        p *= 2.0;
    }
    f64::max(p, 1.0)
}

/// ABC §4.13 原表；`(5`/`(7`/`(9` 复拍子取 3，否则 2
pub fn tuplet_normal_abc(n: f64, time: Option<(f64, f64)>) -> f64 {
    match n {
        2.0 => 3.0,
        3.0 => 2.0,
        4.0 => 3.0,
        6.0 => 2.0,
        8.0 => 3.0,
        _ => {
            let compound = time.is_some_and(|(b, _)| b % 3.0 == 0.0 && b > 3.0);
            if compound { 3.0 } else { 2.0 }
        }
    }
}

/// 123 的时值：减时线、附点（每个加前一档的一半）、增时线（各加一拍）
pub fn duration_123(beams: u32, dots: u32, sustains: usize) -> Duration {
    let base = (SIMPLE_DIVISIONS as i64 >> beams.min(6)) as f64;
    let mut total = base;
    let mut add = base;
    for _ in 0..dots {
        add = (add / 2.0).floor();
        total += add;
    }
    total += sustains as f64 * SIMPLE_DIVISIONS;
    let kind = TYPE_BY_BEAMS[(beams as usize).min(TYPE_BY_BEAMS.len() - 1)].clone();
    Duration { divisions: total, kind: Some(kind), dots: dots as f64, time_mod: None }
}

const TYPES_BY_POWER: [NoteType; 9] = [
    NoteType::Whole,
    NoteType::Half,
    NoteType::Quarter,
    NoteType::Eighth,
    NoteType::N16th,
    NoteType::N32nd,
    NoteType::N64th,
    NoteType::N128th,
    NoteType::N256th,
];

/// divisions → (type, dots)：不超过它的 2 的幂，再看余数是不是恰好一个 / 两个附点
pub fn type_and_dots(divisions: f64) -> (NoteType, f64) {
    let mut unit = SIMPLE_DIVISIONS * 4.0;
    let mut power = 0;
    while unit > divisions && power < 8 {
        unit /= 2.0;
        power += 1;
    }
    let kind = TYPES_BY_POWER[power.min(TYPES_BY_POWER.len() - 1)].clone();
    let mut dots = 0.0;
    let mut acc = unit;
    let mut add = unit;
    while dots < 2.0 && acc < divisions {
        add /= 2.0;
        if (acc + add - divisions).abs() <= (acc - divisions).abs() {
            acc += add;
            dots += 1.0;
        } else {
            break;
        }
    }
    (kind, dots)
}

/// 分数时值：`L:` × num/den
fn duration_abc(num: f64, den: f64, len: DefaultLen) -> Duration {
    let beats = (num * len.num * 4.0) / (den * len.den);
    let divisions = f64::max(1.0, crate::base::js::round(beats * SIMPLE_DIVISIONS));
    let (kind, dots) = type_and_dots(divisions);
    Duration { divisions, kind: Some(kind), dots, time_mod: None }
}

/// 字母 → 简谱度数（Muse：C=1 … B=7）
pub fn degree_of_letter(s: &str) -> Option<f64> {
    "CDEFGAB".find(s).filter(|_| s.len() == 1).map(|k| (k + 1) as f64)
}

impl Dialect {
    /// token → 时值（`sustains` 只有 123 用）
    pub fn duration(self, t: &Token, len: DefaultLen, sustains: usize) -> Duration {
        match self {
            Dialect::J123 => duration_123(t.beams.unwrap_or(0), t.dots.unwrap_or(0), sustains),
            _ => duration_abc(t.num.unwrap_or(1.0), t.den.unwrap_or(1.0), len),
        }
    }

    /// 重算宿主音符的时值（123 的增时线挂上去之后）
    pub fn reduration(self, host: &Chord) -> Duration {
        match self {
            Dialect::J123 => duration_123(
                host.beams.as_ref().map_or(0, |b| b.len() as u32),
                host.duration.dots as u32,
                host.sustains.as_ref().map_or(0, |s| s.len()),
            ),
            _ => host.duration.clone(),
        }
    }

    /// note token → `Note`
    pub fn note(self, t: &Token) -> Note {
        let mut n = Note::default();
        match self {
            Dialect::J123 | Dialect::Jcx => {
                let number = match self {
                    Dialect::J123 => t.degree.unwrap_or(0) as f64,
                    _ => degree_of_letter(t.step.as_deref().unwrap_or("C")).unwrap_or(1.0),
                };
                let mut d = Degree { number, octave_shift: t.octave.unwrap_or(0) as f64, accidental: None };
                if let Some(a) = &t.accidental {
                    d.accidental = Some(a.clone());
                    n.accidental = Some(a.clone());
                }
                n.degree = Some(d);
            }
            Dialect::Abc => {
                n.pitch = Some(Pitch {
                    step: crate::Step::parse(t.step.as_deref().unwrap_or("C")),
                    alter: t.alter.unwrap_or(0) as f64,
                    octave: 4.0 + t.octave.unwrap_or(0) as f64,
                });
                if let Some(a) = &t.accidental {
                    n.accidental = Some(a.clone());
                }
            }
        }
        n
    }

    /// 这个 token 是不是休止
    pub fn is_rest(self, t: &Token) -> bool {
        match self {
            Dialect::J123 => t.degree == Some(0),
            _ => t.kind == super::token::TokenKind::Rest,
        }
    }

    pub fn parse_key(self, value: &str) -> KeyRead {
        match self {
            Dialect::J123 => parse_key(value),
            Dialect::Abc => parse_key_abc(value),
            Dialect::Jcx => parse_key_jcx(value),
        }
    }

    /// `-` 是增时线（123）还是 tie
    pub fn hyphen_sustains(self) -> bool {
        self == Dialect::J123
    }

    /// 出厂默认音长：ABC §3.1.7 按 `M:` 推（≥ 0.75 用 1/8，否则 1/16）；123 恒 1/4
    pub fn default_len(self, num: f64, den: f64) -> DefaultLen {
        match self {
            Dialect::J123 => DefaultLen { num: 1.0, den: 4.0 },
            _ => {
                if den > 0.0 && num / den >= 0.75 {
                    DefaultLen { num: 1.0, den: 8.0 }
                } else {
                    DefaultLen { num: 1.0, den: 16.0 }
                }
            }
        }
    }

    /// 代码里的换行是不是谱面换行（ABC 是，123 用显式 `$`）
    pub fn line_end_is_break(self) -> bool {
        self != Dialect::J123
    }
    /// 空白是不是符杠分组（ABC 是，123 按拍自动）
    pub fn space_beams(self) -> bool {
        self != Dialect::J123
    }
    /// 歌词里「跳过一个音符」的记号
    pub fn lyric_skip(self) -> char {
        if self == Dialect::J123 { '/' } else { '*' }
    }
    /// 休止占不占歌词对位格（`lyricslot`）：123 口径 / ABC 口径
    pub fn lyric_slot_123(self) -> bool {
        self == Dialect::J123
    }
    /// 破碎节奏短的那个音按附点那个音的原长算（Muse）
    pub fn broken_from_long(self) -> bool {
        self == Dialect::Jcx
    }
    /// `$` 同时结束一批歌词（123）
    pub fn break_ends_lyric_block(self) -> bool {
        self == Dialect::J123
    }
    /// 多连音由 `)` 收（123），否则按个数
    pub fn tuplet_close_paren(self) -> bool {
        self == Dialect::J123
    }
    /// `(n:` 没写「占几个」时的默认值
    pub fn tuplet_normal(self, n: f64, time: Option<(f64, f64)>) -> f64 {
        if self == Dialect::J123 { tuplet_normal_123(n) } else { tuplet_normal_abc(n, time) }
    }
}
