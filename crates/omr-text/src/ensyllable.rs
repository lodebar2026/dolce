//! 英文词拆音节：中英对照谱的英文歌词，一个词跨两三个音时多半不印连字符（`myself` `sparing` `thoroughly` 整词印在两个音底下），
//! rec 读出来是一个单元、只占一个音。装配时知道这个词底下罩着几个空着的音，这里只管按英文拼写规则切成那么多段。
//!
//! 切点按优先级取：① 词里小写接大写（`gaveYourself`）；② 常见后缀（-self -ing -ly …）；
//! ③ 元音组之间：中间一个辅音切在它前面（co|no），两个以上切在第一个后面（man|ner），th/sh/ch/ph/wh/ck/ng/gh 不拆开；
//! 撇号连着的「's」跟前面（it's|worth）。每段都要有元音组；词尾辅音后的 e 不算元音组（sume、love 不拆）。凑不够段数回 None。

const SUFFIXES: [&str; 8] = ["selves", "self", "ness", "ment", "less", "ful", "ing", "ly"];
const DIGRAPHS: [&str; 8] = ["th", "sh", "ch", "ph", "wh", "ck", "ng", "gh"];

fn is_vowel_at(w: &[char], i: usize) -> bool {
    let c = w[i].to_ascii_lowercase();
    if "aeiou".contains(c) {
        return true;
    }
    // y：词首不算（you），前面是辅音时算（my）
    c == 'y' && i > 0 && w[i - 1].is_ascii_alphabetic() && !"aeiou".contains(w[i - 1].to_ascii_lowercase())
}

/// 元音组的 [起, 止)；词尾「辅音 + e」的 e 不算（前面还有元音组时）。
fn vowel_groups(w: &[char]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < w.len() {
        if !is_vowel_at(w, i) {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < w.len() && is_vowel_at(w, j) {
            j += 1;
        }
        out.push((i, j));
        i = j;
    }
    if out.len() >= 2 {
        let last = out[out.len() - 1];
        if last.0 == w.len() - 1 && w[last.0].to_ascii_lowercase() == 'e' && last.1 - last.0 == 1 {
            out.pop();
        }
    }
    out
}

/// 把一个词切成 `k` 段；切不出回 None。首尾的标点挂在首段 / 末段上。
pub fn split_english_word(token: &str, k: usize) -> Option<Vec<String>> {
    if k < 2 {
        return None;
    }
    let cs: Vec<char> = token.chars().collect();
    let a = cs.iter().position(|c| c.is_ascii_alphabetic())?;
    let b = cs.iter().rposition(|c| c.is_ascii_alphabetic())? + 1;
    let w = &cs[a..b];
    if !w.iter().all(|c| c.is_ascii_alphabetic() || *c == '\'' || *c == '’') || cs[..a].iter().chain(&cs[b..]).any(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let lower: String = w.iter().collect::<String>().to_lowercase();
    let mut cands: Vec<(usize, u8)> = Vec::new();
    for i in 1..w.len() {
        if w[i - 1].is_ascii_lowercase() && w[i].is_ascii_uppercase() {
            cands.push((i, 0));
        }
    }
    for suf in SUFFIXES {
        if lower.chars().count() >= suf.len() + 2 && lower.ends_with(suf) {
            cands.push((w.len() - suf.len(), 1));
            break;
        }
    }
    let groups = vowel_groups(w);
    for g in 0..groups.len().saturating_sub(1) {
        let (c0, c1) = (groups[g].1, groups[g + 1].0);
        let cl: String = w[c0..c1].iter().collect::<String>().to_lowercase();
        if cl.is_empty() {
            continue;
        }
        let n = cl.chars().count();
        let at = if let Some(apo) = cl.chars().position(|c| c == '\'' || c == '’') {
            c0 + n.min(apo + 2)
        } else if n == 1 {
            c0
        } else if n > 2 && DIGRAPHS.contains(&&cl[..2]) {
            c0 + 2
        } else if DIGRAPHS.contains(&cl.as_str()) {
            c0
        } else {
            c0 + 1
        };
        cands.push((at, 2));
    }
    cands.sort_by_key(|c| (c.1, c.0));
    let parts_of = |cuts: &[usize]| -> Vec<&[char]> {
        let mut out = Vec::new();
        let mut from = 0;
        for &c in cuts {
            out.push(&w[from..c]);
            from = c;
        }
        out.push(&w[from..]);
        out
    };
    let mut cuts: Vec<usize> = Vec::new();
    for (at, _) in cands {
        if cuts.len() == k - 1 {
            break;
        }
        if at == 0 || at >= w.len() || cuts.contains(&at) {
            continue;
        }
        let mut trial = cuts.clone();
        trial.push(at);
        trial.sort_unstable();
        if parts_of(&trial).iter().all(|p| !vowel_groups(p).is_empty()) {
            cuts = trial;
        }
    }
    if cuts.len() != k - 1 {
        return None;
    }
    let mut parts: Vec<String> = parts_of(&cuts).iter().map(|p| p.iter().collect()).collect();
    let lead: String = cs[..a].iter().collect();
    let tail: String = cs[b..].iter().collect();
    parts[0] = lead + &parts[0];
    let last = parts.len() - 1;
    parts[last] += &tail;
    Some(parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits() {
        assert_eq!(split_english_word("myself", 2).unwrap(), ["my", "self"]);
        assert_eq!(split_english_word("manner", 2).unwrap(), ["man", "ner"]);
        assert_eq!(split_english_word("thoroughly,", 2).unwrap(), ["thorough", "ly,"]);
        assert_eq!(split_english_word("love", 2), None);
        assert_eq!(split_english_word("it's", 2), None);
    }
}
