//! 速度与节拍器、跳转、表情术语、力度的词表与判据。纯文本。
use regex::Regex;
use std::sync::LazyLock;

/// 节拍器记号（`♩ = 72`、`J=c.78`：音符字形读成一两个字母）。
static METRO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[=＝]\s*(c(?:a|irca)?\s*\.?\s*)?(\d ?\d ?\d?)").unwrap());
/// 表情与速度术语。
static TERM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(rit|rall|riten|ritard|accel|tempo|cresc|decresc|dim|poco|molto|dolce|legato|unis|unison|solo|tutti|div|sim|sub|piu|meno|mosso|espress|cantabile|sost|marc|stacc|fine|coda|segno|slower|faster|broadly|andante|allegro|allegretto|moderato|adagio|largo|lento|maestoso|vivace|presto|pizz|arco)\b|\bd\. ?[sc]\b").unwrap()
});
/// 五线谱谱面上另有的表情词：缩写（`espr.`、`Ped.`）与英文副词（诗歌本、合唱谱的「Gently」「Freely」）。
/// 英文副词也是常见的歌词词，只在五线谱路线（文字带分得出谱表上下的记号行）连同 [`TERM`] 一起用（[`has_staff_term`]）。
static EXPR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(espr|expr|pedal|ped|delicately|freely|harmonically|gently|smoothly|quietly|tenderly|prayerfully|reverently|majestically|expressively|gradually)\b").unwrap()
});
static DYNAMIC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(ppp|pp|p|mp|mf|fff|ff|f|sfz|sf|fz|fp)$").unwrap());
static JUMP_MARK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(?:D\.?\s*[SC]\b.*|fine\.?|to\s*coda.*|coda)$").unwrap());

/// 节拍器：每分钟多少拍、带不带 `c.`。
pub fn metronome(text: &str) -> Option<(u32, bool)> {
    if text.chars().any(crate::text::chars::is_han) {
        return None;
    }
    let c = METRO.captures(text)?;
    let n: u32 = c[2].replace(' ', "").parse().ok()?;
    (30..=260).contains(&n).then_some((n, c.get(1).is_some()))
}

/// 含表情 / 速度术语。
pub fn has_term(text: &str) -> bool {
    TERM.is_match(text)
}

/// 含表情 / 速度术语，连同五线谱谱面上的表情缩写与英文表情副词（`EXPR`）。
pub fn has_staff_term(text: &str) -> bool {
    TERM.is_match(text) || EXPR.is_match(text)
}

/// 整串是力度记号（小写比）。
pub fn dynamic(text: &str) -> Option<&'static str> {
    let t: String = text.chars().filter(|c| !c.is_whitespace() && *c != '.').collect::<String>().to_lowercase();
    const ALL: [&str; 12] = ["ppp", "pp", "p", "mp", "mf", "fff", "ff", "f", "sfz", "sf", "fz", "fp"];
    DYNAMIC.is_match(&t).then(|| ALL.into_iter().find(|d| *d == t)).flatten()
}

/// 跳转记号的种类。
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Jump {
    DalSegno,
    DaCapo,
    Fine,
    ToCoda,
    Coda,
}

/// 整串是跳转记号（`D.S. al Fine`、`D.C.`、`Fine`、`To Coda`）。
pub fn jump(text: &str) -> Option<Jump> {
    let t = text.trim();
    if !JUMP_MARK.is_match(t) {
        return None;
    }
    let l = t.to_lowercase();
    Some(if l.starts_with("fine") {
        Jump::Fine
    } else if l.starts_with("to") {
        Jump::ToCoda
    } else if l.starts_with("coda") {
        Jump::Coda
    } else if l.replace(['.', ' '], "").starts_with("ds") {
        Jump::DalSegno
    } else {
        Jump::DaCapo
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tables() {
        assert_eq!(metronome("J=c.78"), Some((78, true)));
        assert_eq!(metronome("♩ = 110"), Some((110, false)));
        assert_eq!(metronome("1=C"), None);
        assert_eq!(dynamic("mf"), Some("mf"));
        assert_eq!(dynamic("me"), None);
        assert_eq!(jump("D.S. al Fine"), Some(Jump::DalSegno));
        assert_eq!(jump("D.C."), Some(Jump::DaCapo));
        assert_eq!(jump("Fine"), Some(Jump::Fine));
        assert_eq!(jump("Finely"), None);
        assert!(has_term("poco rit.") && has_term("D.S.") && !has_term("praise") && !has_term("divine"));
    }
}
