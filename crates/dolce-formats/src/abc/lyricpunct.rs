//! 123 歌词行的切分口径（同 `common/cjkpunct.ts` 的歌词那几个判据）：读入（`parse::parse_lyric_line`）与写出共用。
//! TS 是对单个 UTF-16 码元判的（`body[i]`），这里同样按码元：增补平面的字（代理对）一律不算 CJK、不算字母。

use unicode_general_category::{get_general_category, GeneralCategory as G};

/// `fanqie/parse.ts` 的歌词标点
pub const FANQIE_LYRIC_PUNCTUATION: &str = "，。！？、；：,.!?;:…—～~《》()（）";
/// 左引号领起下一个字，右引号贴前一个字
pub const FANQIE_LYRIC_QUOTES: &str = "“”‘’\"";

fn in_set(u: u16, set: &str) -> bool {
    set.encode_utf16().any(|c| c == u)
}

/// CJK 字：歌词里一字一音节（对单个码元判，增补平面的区间永远到不了）
pub fn is_lyric_cjk(u: u16) -> bool {
    let c = u as u32;
    (0x3400..=0x4dbf).contains(&c) || (0x4e00..=0x9fff).contains(&c) || (0xf900..=0xfaff).contains(&c)
}

/// 收尾标点：并入前一字、不占音符格
pub fn is_lyric_trailing_punct(u: u16) -> bool {
    !is_lyric_open_quote(u) && (in_set(u, FANQIE_LYRIC_PUNCTUATION) || in_set(u, "”’｡、\""))
}

/// 领起后一个字的左引号与开括号
pub fn is_lyric_open_quote(u: u16) -> bool {
    in_set(u, "“‘（《(「『【〈")
}

/// `text[i]` 是撇号而不是右引号：`’` 后面紧跟字母（`\p{L}`，对单个码元）
pub fn is_lyric_apostrophe(text: &[u16], i: usize) -> bool {
    text.get(i) == Some(&0x2019)
        && text.get(i + 1).and_then(|&u| char::from_u32(u as u32)).is_some_and(|c| {
            matches!(get_general_category(c), G::UppercaseLetter | G::LowercaseLetter | G::TitlecaseLetter | G::ModifierLetter | G::OtherLetter)
        })
}

/// CJK 字（按码位，含增补平面 2 万–2EBEF；`isLyricCjk` 对整个字 `codePointAt(0)` 判的那几处用）
pub fn is_lyric_cjk_cp(c: char) -> bool {
    let c = c as u32;
    (0x3400..=0x4dbf).contains(&c) || (0x4e00..=0x9fff).contains(&c) || (0xf900..=0xfaff).contains(&c) || (0x20000..=0x2ebef).contains(&c)
}

fn bmp(c: char) -> Option<u16> {
    u16::try_from(c as u32).ok()
}

/// `/[\p{L}\p{N}']/u`
fn latin_ch(c: char) -> bool {
    c == '\'' || is_letter(c) || is_number(c)
}

fn is_letter(c: char) -> bool {
    matches!(get_general_category(c), G::UppercaseLetter | G::LowercaseLetter | G::TitlecaseLetter | G::ModifierLetter | G::OtherLetter)
}

fn is_number(c: char) -> bool {
    matches!(get_general_category(c), G::DecimalNumber | G::LetterNumber | G::OtherNumber)
}

/// 拉丁音节（非 CJK 的字母/数字）起头——歌词读入端的拉丁分支会把它和前面的拉丁词粘在一起（`emitutil.ts::isLatinStart`）
pub fn is_latin_start(text: &str) -> bool {
    let first = text.chars().next();
    first.is_some_and(|c| latin_ch(c) && !is_lyric_cjk_cp(c)) || is_lyric_apostrophe(&text.encode_utf16().collect::<Vec<_>>(), 0)
}

pub fn is_latin_end(text: &str) -> bool {
    text.chars().last().is_some_and(|c| latin_ch(c) && !is_lyric_cjk_cp(c))
}

/// 「至多一个左引号 + 一个 CJK 字 + 若干收尾标点」——不包 `{}` 也读成**一个**音节的形状
pub fn is_one_cjk_with_punct(text: &str) -> bool {
    let cs: Vec<char> = text.chars().collect();
    let mut k = 0;
    if cs.len() > 1 && bmp(cs[0]).is_some_and(is_lyric_open_quote) {
        k = 1;
    }
    if !cs.get(k).is_some_and(|&c| is_lyric_cjk_cp(c)) {
        return false;
    }
    cs[k + 1..].iter().all(|&c| bmp(c).is_some_and(is_lyric_trailing_punct))
}
