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
