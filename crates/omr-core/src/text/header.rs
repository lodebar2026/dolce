//! 页眉各行的分类（只看文字与行框）：署名按内容认，其余行里有效字高最大的是标题，居中的是副标题，
//! 靠左的是作词 / 译者、靠右的是作曲；标题上方靠两边的是书眉、成段的文字是序言（照收、不给角色）；版权声明标 `rights`。
use crate::text::chars::{han_count, is_han};
use regex::Regex;
use std::sync::LazyLock;

static CREDIT_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*[作詞词曲編编譯译]{1,2}(?:\s*[、，,/／]\s*[作詞词曲編编譯译]{1,2})*\s*[:：]").unwrap());
static CREDIT_SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*([一-鿿·]{2,4}?(?:\s*[、，,]\s*[一-鿿·]{2,4}?)*)\s*((?:[作編编]?[詞词曲])(?:\s*[、，,/／]?\s*(?:[作編编]?[詞词曲]))*)\s*$").unwrap());
static ROLE_TAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"((?:[作編编]?[詞词曲])(?:\s*[、，,/／]?\s*(?:[作編编]?[詞词曲]))*)\s*$").unwrap());
/// 名单后的职能词（含「译」）
static NAMES_ROLE_TAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*(?:合译|[作編编]?[詞词曲譯译])(?:\s*[、，,/／]?\s*(?:[作編编]?[詞词曲譯译]))*\s*$").unwrap());
static LATIN_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9 .,'’&·()（）\-]*$").unwrap());
static CREDIT_YEAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*[一-鿿·]{2,10}?\s*(?:合译|[作編编]?[詞词曲譯译])\s*\d{4}(?:\s*[-–—]\s*\d{4})?\s*$").unwrap());
static LATIN_PAREN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*[(（][A-Za-z][A-Za-z .'’\-]*[)）]\s*$").unwrap());
static LATIN_CREDIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^\s*(?:words|music|lyrics?|text|tune|arr(?:anged)?|translated|transl?|harmony|harm)\b\.?\s*(?:by\b|:)?").unwrap());
static RIGHTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^\s*(?:copyright\b|©|\(c\)\s*\d|版[权權]所有)").unwrap());
static YEARS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d{4}\s*[-–—]\s*\d{4}").unwrap());
static ROLE_COMPOSER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)[曲編编]|music|tune|arr|harm").unwrap());
static LEAD_NUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d\s?){1,3}\s*[.．、]?\s*").unwrap());
static SPACED_CAPS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z]{1,2}(\s+[A-Z]{1,2}){2,}$").unwrap());
static HAN_THEN_LATIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([㐀-鿿]{2,}[㐀-鿿\s]*)\s*([A-Za-z][A-Za-z\s,'’!.\-]{3,})$").unwrap());

/// 成段的文字：一行有这么多个字（汉字一字、拉丁一词）。
const PROSE_UNITS: usize = 16;

/// 页眉带读出来的一行（所在坐标系随调用方）。
#[derive(Clone, Debug, PartialEq)]
pub struct WordLine {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum CreditType {
    Title,
    Subtitle,
    Composer,
    Lyricist,
    Rights,
}

impl CreditType {
    pub fn xml(&self) -> &'static str {
        match self {
            CreditType::Title => "title",
            CreditType::Subtitle => "subtitle",
            CreditType::Composer => "composer",
            CreditType::Lyricist => "lyricist",
            CreditType::Rights => "rights",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Justify {
    Left,
    Center,
    Right,
}

impl Justify {
    pub fn xml(&self) -> &'static str {
        match self {
            Justify::Left => "left",
            Justify::Center => "center",
            Justify::Right => "right",
        }
    }
}

/// 页眉的一条。
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Credit {
    pub text: String,
    pub kind: Option<CreditType>,
    pub justify: Justify,
    /// 行框 `(x, y, w, h)` 与字号（有效字高），同输入的坐标系。
    pub rect: (f64, f64, f64, f64),
    pub size: f64,
}

/// 页眉里值得留的行：有汉字，或两个以上拉丁字母，或生卒年；页码、噪点、单个字母不要。
pub fn keep_line(text: &str) -> bool {
    text.chars().any(is_han) || text.chars().filter(|c| c.is_ascii_alphabetic()).count() >= 2 || YEARS.is_match(text)
}

/// 一行字的有效字高：只在明显叠排（按字宽算不到框高七成）时才取「框宽 ÷ 字数」。
pub fn effective_h(l: &WordLine) -> f64 {
    let units: f64 = l.text.chars().map(|c| if is_han(c) { 1.0 } else if c.is_ascii_alphanumeric() { 0.6 } else { 0.0 }).sum();
    if units >= 2.0 && l.w / units < l.h * 0.7 {
        l.w / units
    } else {
        l.h
    }
}

/// 候选比现任更像标题：有效字高大出 25% 以上；或差不多（15% 以内）而更宽。
fn better_title(ea: f64, wa: f64, eb: f64, wb: f64) -> bool {
    ea > eb * 1.25 || (ea >= eb * 0.85 && wa > wb)
}

/// 一行是不是署名（只看文字）。`smaller`：这行字比页眉里最大的字小。
pub fn is_credit(text: &str, smaller: bool) -> bool {
    let t = text.trim();
    if CREDIT_PREFIX.is_match(t) {
        return true;
    }
    if smaller && (CREDIT_SUFFIX.is_match(t) || CREDIT_YEAR.is_match(t) || LATIN_PAREN.is_match(t)) {
        return true;
    }
    if smaller {
        if let Some(m) = ROLE_TAIL.find(t) {
            let name = t[..m.start()].trim();
            if LATIN_NAME.is_match(name) && name.chars().filter(|c| c.is_ascii_alphabetic()).count() >= 2 {
                return true;
            }
        }
        // 几个人名用「&」「、」连起来、中英混排，后跟职能词（`Evelyn Kong & Nelson Ng & 赵治德 译`）
        if let Some(m) = NAMES_ROLE_TAIL.find(t) {
            let names: Vec<&str> = t[..m.start()].split(['&', '＆', '、']).map(str::trim).collect();
            let name_like = |n: &str| {
                let hz = n.chars().filter(|&c| is_han(c)).count();
                (hz == 0 && LATIN_NAME.is_match(n) && n.chars().filter(|c| c.is_ascii_alphabetic()).count() >= 2) || ((2..=4).contains(&hz) && n.chars().all(|c| is_han(c) || c == '·'))
            };
            if names.len() >= 2 && names.iter().all(|n| name_like(n)) {
                return true;
            }
        }
    }
    LATIN_CREDIT.is_match(t)
}

/// 页眉一行的字 → 一条或几条：拉开字距的汉字之间的空格不要、行首的诗歌编号不要、拉开字距的小型大写并回一个词、
/// 中文标题与英文标题印在同一行的拆成两条。
pub fn split_text(t: &str) -> Vec<String> {
    let cs: Vec<char> = t.trim().chars().collect();
    let mut text = String::new();
    for (i, &c) in cs.iter().enumerate() {
        if c.is_whitespace() {
            let prev = cs[..i].iter().rev().find(|c| !c.is_whitespace());
            let next = cs[i..].iter().find(|c| !c.is_whitespace());
            if prev.is_some_and(|&p| is_han(p)) && next.is_some_and(|&n| is_han(n)) {
                continue;
            }
        }
        text.push(c);
    }
    if let Some(m) = LEAD_NUM.find(&text) {
        if text[m.end()..].chars().next().is_some_and(is_han) {
            text = text[m.end()..].to_string();
        }
    }
    if SPACED_CAPS.is_match(&text) {
        text = text.split_whitespace().collect();
    }
    match HAN_THEN_LATIN.captures(&text) {
        Some(c) => vec![c[1].trim().to_string(), c[2].trim().to_string()],
        None => vec![text],
    }
}

/// 页眉带读出来的行 → 页眉各条。`band`：页眉带的左缘与宽（定居中用）。
pub fn credits(lines: &[WordLine], band_x: f64, band_w: f64) -> Vec<Credit> {
    // 接续行合成的一条：判字号照单行的高，源框（`rect`）罩住两行
    let joined = join_continued(lines.iter().filter(|l| keep_line(&l.text)).cloned().collect());
    let bottom_of = |l: &WordLine| joined.iter().find(|(j, _)| std::ptr::eq(j, l)).map_or(l.y + l.h, |j| j.1);
    let mut ls: Vec<&WordLine> = joined.iter().map(|j| &j.0).collect();
    ls.sort_by(|a, b| a.y.total_cmp(&b.y).then(a.x.total_cmp(&b.x)));
    if ls.is_empty() {
        return Vec::new();
    }
    let max_h = ls.iter().map(|l| effective_h(l)).fold(0.0, f64::max);
    let credit: Vec<bool> = ls.iter().map(|l| is_credit(&l.text, effective_h(l) < max_h)).collect();
    let mut title: Option<usize> = None;
    for (i, l) in ls.iter().enumerate() {
        if !credit[i] && title.is_none_or(|t| better_title(effective_h(l), l.w, effective_h(ls[t]), ls[t].w)) {
            title = Some(i);
        }
    }
    let h = title.map_or(max_h, |t| effective_h(ls[t]));
    let mid = band_x + band_w / 2.0;
    let justify = |l: &WordLine| {
        let cx = l.x + l.w / 2.0;
        if (cx - mid).abs() <= band_w * 0.15 {
            Justify::Center
        } else if cx < mid {
            Justify::Left
        } else {
            Justify::Right
        }
    };
    let mut out = Vec::new();
    for (i, l) in ls.iter().enumerate() {
        let j = justify(l);
        let running = title.is_some_and(|t| t != i && !credit[i] && l.y + l.h <= ls[t].y && j != Justify::Center);
        let units = han_count(&l.text) + l.text.split(|c: char| !c.is_ascii_alphabetic()).filter(|w| !w.is_empty()).count();
        let prose = title != Some(i) && !credit[i] && units >= PROSE_UNITS;
        let kind = if RIGHTS.is_match(&l.text) {
            Some(CreditType::Rights)
        } else if prose || running {
            None
        } else if credit[i] {
            Some(if ROLE_COMPOSER.is_match(&l.text) { CreditType::Composer } else { CreditType::Lyricist })
        } else if title == Some(i) || (j == Justify::Center && effective_h(l) >= h * 0.8) {
            Some(CreditType::Title)
        } else {
            Some(match j {
                Justify::Center => CreditType::Subtitle,
                Justify::Left => CreditType::Lyricist,
                Justify::Right => CreditType::Composer,
            })
        };
        for text in split_text(&l.text) {
            out.push(Credit { text, kind, justify: j, rect: (l.x, l.y, l.w, bottom_of(l) - l.y), size: effective_h(l) });
        }
    }
    out
}

/// 以「&」收尾的行（`Reuben Morgan &`）没写完（逗号收尾的不算：`REGINALD HEBER,` 下一行是生卒年，另成一条）：接上紧挨在它下面、横向与它交叠的那一行（`Jonas Myrin 词曲`）。
/// 回各行与其底边（合成的一条底边是下一行的底，行高仍是单行的）。
fn join_continued(ls: Vec<WordLine>) -> Vec<(WordLine, f64)> {
    let mut ls: Vec<(WordLine, f64)> = ls.into_iter().map(|l| {
        let b = l.y + l.h;
        (l, b)
    }).collect();
    ls.sort_by(|a, b| a.0.y.total_cmp(&b.0.y).then(a.0.x.total_cmp(&b.0.x)));
    let mut i = 0;
    while i < ls.len() {
        let t = ls[i].0.text.trim_end().to_string();
        let Some(conn) = t.chars().last().filter(|c| "&＆".contains(*c)) else {
            i += 1;
            continue;
        };
        let (a, a_bot) = (&ls[i].0, ls[i].1);
        let next = (0..ls.len()).filter(|&k| k != i).find(|&k| {
            let b = &ls[k].0;
            let gap = b.y - a_bot;
            gap >= -a.h * 0.3 && gap <= a.h.min(b.h) * 0.8 && b.x < a.x + a.w && b.x + b.w > a.x
        });
        let Some(k) = next else {
            i += 1;
            continue;
        };
        let (b, b_bot) = ls.remove(k);
        let (a, a_bot) = &mut ls[if k < i { i - 1 } else { i }];
        *a_bot = a_bot.max(b_bot);
        let head = t[..t.len() - conn.len_utf8()].trim_end();
        a.text = format!("{head} {conn} {}", b.text.trim_start());
        // 合成一行：框取两行的横向并，行高照字高大的那行（字号判据看它）
        let (x0, x1) = (a.x.min(b.x), (a.x + a.w).max(b.x + b.w));
        (a.x, a.w, a.h) = (x0, x1 - x0, a.h.max(b.h));
        i = 0;
    }
    ls
}

/// 版权声明（`Copyright`、`©`、`版權所有` 起头）。
pub fn is_rights(t: &str) -> bool {
    RIGHTS.is_match(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wl(text: &str, x: f64, y: f64, w: f64, h: f64) -> WordLine {
        WordLine { text: text.into(), x, y, w, h }
    }

    #[test]
    fn hymn_header() {
        let ls = [
            wl("萬口歡唱", 400.0, 40.0, 110.0, 28.0),
            wl("107", 780.0, 46.0, 50.0, 30.0),
            wl("O for a Thousand Tongues to Sing", 200.0, 74.0, 500.0, 30.0),
            wl("AZMON", 750.0, 125.0, 60.0, 20.0),
            wl("Charles Wesley", 70.0, 146.0, 100.0, 20.0),
            wl("Carl G. Gläser", 710.0, 145.0, 100.0, 16.0),
        ];
        let c = credits(&ls, 0.0, 900.0);
        let k: Vec<(&str, Option<CreditType>)> = c.iter().map(|c| (c.text.as_str(), c.kind)).collect();
        assert_eq!(k[0], ("萬口歡唱", Some(CreditType::Title)));
        assert_eq!(k[1], ("O for a Thousand Tongues to Sing", Some(CreditType::Title)));
        assert_eq!(k[2], ("AZMON", Some(CreditType::Composer)));
        assert!(k.contains(&("Charles Wesley", Some(CreditType::Lyricist))) && k.contains(&("Carl G. Gläser", Some(CreditType::Composer))));
        assert_eq!(c.len(), 5);
    }

    #[test]
    fn joins_line_ending_with_connector() {
        let ls = [
            wl("基督是我满足", 400.0, 40.0, 200.0, 40.0),
            wl("Reuben Morgan&", 700.0, 100.0, 170.0, 22.0),
            wl("Jonas Myrin 词曲", 710.0, 128.0, 160.0, 22.0),
        ];
        let c = credits(&ls, 0.0, 900.0);
        assert!(c.iter().any(|c| c.text == "Reuben Morgan & Jonas Myrin 词曲" && c.kind == Some(CreditType::Composer)), "{c:?}");
        assert_eq!(c.len(), 2);
    }

    #[test]
    fn credit_text_and_split() {
        assert!(is_credit("作词：某某", false));
        assert!(is_credit("盛晓玫 词曲", true) && !is_credit("盛晓玫 词曲", false));
        assert!(is_credit("John Laudon 词曲", true));
        assert!(is_credit("希伯词 1826", true));
        assert!(is_credit("Words by X", false));
        assert!(is_credit("Evelyn Kong&Nelson Ng&Debbie Wang&Zon Shih&赵治德译", true));
        assert!(!is_credit("约书亚乐团《点燃》（2015）/Hillsong(2013)", true));
        assert_eq!(split_text("望 十 架"), ["望十架"]);
        assert_eq!(split_text("23.有一位神"), ["有一位神"]);
        assert_eq!(split_text("數算主恩 Count Your Blessings"), ["數算主恩", "Count Your Blessings"]);
        assert_eq!(split_text("B RO K E N"), ["BROKEN"]);
    }
}
