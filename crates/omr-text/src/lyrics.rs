//! 歌词：一行字切成音节（段号、标点归属、连字符）、音节对到音上。纯文本与纯几何。
use crate::chars::{is_han, is_latin};
use crate::Ch;

/// 贴在字尾的标点。
fn is_tail_punct(c: char) -> bool {
    "，。、；：！？…—,;:!?.”’)）".contains(c)
}

/// 领起后一字的开引号、开括号。
fn is_open(c: char) -> bool {
    "“‘\"'(（".contains(c)
}

/// 半角句读折全角（贴在汉字后）。
fn full(c: char) -> char {
    match c {
        ',' => '，',
        ';' => '；',
        ':' => '：',
        '!' => '！',
        '?' => '？',
        c => c,
    }
}

/// 全角折半角（贴在拉丁音节后）。
fn half(c: char) -> char {
    match c {
        '，' => ',',
        '；' => ';',
        '：' => ':',
        '！' => '!',
        '？' => '?',
        '。' => '.',
        '（' => '(',
        '）' => ')',
        c => c,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Syllabic {
    Single,
    Begin,
    Middle,
    End,
}

impl Syllabic {
    pub fn xml(&self) -> &'static str {
        match self {
            Syllabic::Single => "single",
            Syllabic::Begin => "begin",
            Syllabic::Middle => "middle",
            Syllabic::End => "end",
        }
    }
}

/// 一个音节：字、横向中心、词内位置。
#[derive(Clone, Debug, PartialEq)]
pub struct Syl {
    pub text: String,
    pub x: f64,
    pub syllabic: Syllabic,
}

/// 一行歌词切出来的：行首印的段号（照谱面：`1.`、不带点的 `1`）与各音节。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LyricRow {
    pub label: Option<String>,
    pub syls: Vec<Syl>,
}

/// 行首段号：一两位数字 + 可选的点；后面要跟着字。回 (段号, 吃掉几个字)。
fn verse_label(cs: &[Ch]) -> Option<(String, usize)> {
    let n = cs.iter().take_while(|c| c.ch.is_ascii_digit()).count();
    if n == 0 || n > 2 {
        return None;
    }
    let num: String = cs[..n].iter().map(|c| c.ch).collect();
    let mut i = n;
    let dot = cs.get(i).is_some_and(|c| ".．、".contains(c.ch));
    if dot {
        i += 1;
    }
    while cs.get(i).is_some_and(|c| c.ch == ' ') {
        i += 1;
    }
    let next = cs.get(i)?.ch;
    if is_han(next) {
        // 汉字段号一律带点（点常读丢）
        Some((format!("{num}."), i))
    } else if is_latin(next) || is_open(next) {
        Some((if dot { format!("{num}.") } else { num }, i))
    } else {
        None
    }
}

/// 一行字（空格用 `' '` 标出）切成音节。汉字一字一个音节；拉丁字母按空格断词、按连字符断音节；
/// 句读与闭引号贴前一个音节，开引号领起后一个；其余的字（数字、符号）不要。
pub fn syllables(chars: &[Ch]) -> LyricRow {
    let mut row = LyricRow::default();
    let mut cs = chars;
    let mut lead = String::new();
    if let Some((l, n)) = verse_label(cs) {
        // 英文第一段常以「O」起头：`1 O for` 读成 `10 for`
        if l.len() == 2 && l.ends_with('0') && cs.get(n).is_some_and(|c| c.ch.is_ascii_lowercase()) {
            row.label = Some(l[..1].to_string());
            row.syls.push(Syl { text: "O".into(), x: cs[1].cx(), syllabic: Syllabic::Single });
        } else {
            row.label = Some(l);
        }
        cs = &cs[n..];
    }
    // 正在攒的拉丁音节：(字, 左缘, 右缘)；`cont` = 前一个音节以连字符收尾
    let mut cur: Option<(String, f64, f64)> = None;
    let mut cont = false;
    let flush = |row: &mut LyricRow, cur: &mut Option<(String, f64, f64)>, cont: &mut bool, hyphen: bool| {
        if let Some((t, a, b)) = cur.take() {
            let syllabic = match (*cont, hyphen) {
                (false, false) => Syllabic::Single,
                (false, true) => Syllabic::Begin,
                (true, true) => Syllabic::Middle,
                (true, false) => Syllabic::End,
            };
            row.syls.push(Syl { text: t, x: (a + b) / 2.0, syllabic });
            *cont = hyphen;
        } else if !hyphen {
            *cont = false;
        }
    };
    for c in cs {
        let ch = c.ch;
        if is_han(ch) {
            flush(&mut row, &mut cur, &mut cont, false);
            row.syls.push(Syl { text: format!("{}{ch}", std::mem::take(&mut lead)), x: c.cx(), syllabic: Syllabic::Single });
        } else if is_latin(ch) || ((ch == '\'' || ch == '’') && cur.is_some()) {
            match cur.as_mut() {
                Some((t, _, b)) => {
                    t.push(ch);
                    *b = c.x1;
                }
                None => cur = Some((format!("{}{ch}", std::mem::take(&mut lead)), c.x0, c.x1)),
            }
        } else if "-–—".contains(ch) && cur.is_some() {
            flush(&mut row, &mut cur, &mut cont, true);
        } else if ch == ' ' || ch == '_' {
            flush(&mut row, &mut cur, &mut cont, false);
        } else if is_tail_punct(ch) {
            if let Some((t, _, _)) = cur.as_mut() {
                // 句读收住这个词（`King,The` 读丢了空格）
                t.push(half(ch));
                flush(&mut row, &mut cur, &mut cont, false);
            } else if let Some(s) = row.syls.last_mut() {
                let latin = s.text.chars().last().is_some_and(|l| is_latin(l) || l == '\'');
                s.text.push(if latin { half(ch) } else { full(ch) });
            }
        } else if is_open(ch) {
            flush(&mut row, &mut cur, &mut cont, false);
            lead.push(ch);
        }
    }
    flush(&mut row, &mut cur, &mut cont, false);
    row
}

/// 音节对到音上：保序，每个音节取它后面还空着的音里横向最近的；后面没有音了的并进前一个音。
/// 回每个音节挂的音的下标（一个音都没有时为空）。
pub fn align(syl_xs: &[f64], note_xs: &[f64]) -> Vec<usize> {
    if note_xs.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(syl_xs.len());
    let mut next = 0usize;
    for (k, &sx) in syl_xs.iter().enumerate() {
        if next >= note_xs.len() {
            out.push(note_xs.len() - 1);
            continue;
        }
        // 后面还有多少音节：给它们各留一个音（留不够就不留）
        let rest = syl_xs.len() - k - 1;
        let hi = note_xs.len().saturating_sub(rest).max(next + 1);
        let j = (next..hi).min_by(|&a, &b| (note_xs[a] - sx).abs().total_cmp(&(note_xs[b] - sx).abs())).unwrap();
        out.push(j);
        next = j + 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(s: &str) -> Vec<Ch> {
        s.chars().enumerate().map(|(i, ch)| Ch { ch, x0: i as f64 * 10.0, x1: i as f64 * 10.0 + 8.0 }).collect()
    }

    #[test]
    fn han_with_label_and_punct() {
        let r = syllables(&line("1.哦,千“万”"));
        assert_eq!(r.label.as_deref(), Some("1."));
        let t: Vec<&str> = r.syls.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(t, ["哦，", "千", "“万”"]);
    }

    #[test]
    fn latin_syllables() {
        let r = syllables(&line("3 Je-sus! the name"));
        assert_eq!(r.label.as_deref(), Some("3"));
        let t: Vec<(&str, Syllabic)> = r.syls.iter().map(|s| (s.text.as_str(), s.syllabic)).collect();
        assert_eq!(t, [("Je", Syllabic::Begin), ("sus!", Syllabic::End), ("the", Syllabic::Single), ("name", Syllabic::Single)]);
        let r = syllables(&line("10 for King,The 'Tis"));
        assert_eq!(r.label.as_deref(), Some("1"));
        let t: Vec<&str> = r.syls.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(t, ["O", "for", "King,", "The", "'Tis"]);
    }

    #[test]
    fn align_keeps_order_and_skips_melisma() {
        assert_eq!(align(&[10.0, 52.0, 60.0], &[10.0, 30.0, 50.0, 70.0]), vec![0, 2, 3]);
        // 音不够：多出来的并到最后一个
        assert_eq!(align(&[10.0, 20.0, 30.0], &[10.0, 20.0]), vec![0, 1, 1]);
    }
}
