//! 音符记号的别名表（同 `src/model/deconames.ts`）。123 的 `!xx!` 几种记法都认：文本谱的拼音短名、ABC 名、
//! MusicXML 元素名、中文名、Muse `.jcx` 的大写名。模型里原名照存，用的地方先归一到文本谱的 `&xx` 短名。

/// 短名 → 别名。别名里的拉丁字母不分大小写。
const ALIASES: &[(&str, &[&str])] = &[
    ("yc", &["fermata", "invertedfermata", "延长", "延长记号", "hold"]),
    ("ycy", &[]),
    ("bc", &["tenuto", "保持音"]),
    ("zy", &["accent", ">", "emphasis", "strong-accent", "重音", "att", "hat"]),
    ("dy", &["staccato", "staccatissimo", "顿音", "stacc"]),
    ("hx", &["breath", "breath-mark", "呼吸", "呼吸记号", "huanqi"]),
    ("shy", &["scoop", "上滑音"]),
    ("xhy", &["falloff", "下滑音"]),
    ("sby", &["uppermordent", "pralltriller", "inverted-mordent", "上波音", "danboyin"]),
    ("xby", &["lowermordent", "mordent", "下波音"]),
    ("cy", &[]),
    ("tr", &["trill", "trill-mark", "颤音"]),
    // 弓法
    ("sg", &["upbow", "up-bow", "上弓"]),
    ("xg", &["downbow", "down-bow", "下弓"]),
    // 琶音
    ("arp", &["arpeggio", "arpeggiate", "琶音"]),
    // 小节线上的跳转记号
    ("hs", &["segno"]),
    ("ty", &["coda"]),
    ("fine", &[]),
    ("dc", &["d.c."]),
    ("ds", &["d.s."]),
];

fn lookup(name: &str) -> Option<&'static str> {
    // 与 TS 建表次序相同：同一个键后写的覆盖先写的（表里没有重名，次序不影响结果）
    let mut hit = None;
    for (key, names) in ALIASES {
        if *key == name || names.iter().any(|n| n.to_lowercase() == name) {
            hit = Some(*key);
        }
    }
    hit
}

/// 记号名（任一种记法）→ 短名；认不出返回 None。
pub fn deco_key(name: &str) -> Option<&'static str> {
    lookup(name).or_else(|| lookup(&name.to_lowercase()))
}

/// 单音震音的道数：`!/!` … `!////!`、中文名 `!震音!`（三道）；不是震音返回 None。
pub fn tremolo_strokes(name: &str) -> Option<u32> {
    if (1..=4).contains(&name.len()) && name.bytes().all(|b| b == b'/') {
        return Some(name.len() as u32);
    }
    (name == "震音").then_some(3)
}

/// 换符头的装饰 `!head-x!` `!head-circle-x!` → 符头名（`/^head-([a-z][a-z-]*)$/i`）
pub fn notehead_of(name: &str) -> Option<String> {
    let rest = name.get(..5).filter(|p| p.eq_ignore_ascii_case("head-")).map(|_| &name[5..])?;
    let mut cs = rest.chars();
    let ok = cs.next().is_some_and(|c| c.is_ascii_alphabetic()) && cs.all(|c| c.is_ascii_alphabetic() || c == '-');
    ok.then(|| rest.to_ascii_lowercase())
}

/// 整个和弦共用的非常规符头（各音不一样或是普通符头返回 None）
pub fn chord_notehead<'a>(noteheads: impl IntoIterator<Item = Option<&'a str>>) -> Option<String> {
    let all: Vec<Option<&str>> = noteheads.into_iter().collect();
    let h = dolce_base::js::trim(all.first().copied().flatten()?);
    (!h.is_empty() && h != "normal" && all.iter().all(|n| n.map(dolce_base::js::trim) == Some(h))).then(|| h.to_owned())
}

/// 排练号：`!rehearsal=A!`（也认 `!排练号=A!`）→ `A`（`/^(?:rehearsal|排练号)\s*=\s*(.+)$/i`）
pub fn rehearsal_of(name: &str) -> Option<String> {
    let rest = if name.len() >= 9 && name.is_char_boundary(9) && name[..9].eq_ignore_ascii_case("rehearsal") {
        &name[9..]
    } else {
        name.strip_prefix("排练号")?
    };
    let rest = rest.trim_start_matches(dolce_base::js::is_space).strip_prefix('=')?;
    let v = rest.trim_start_matches(dolce_base::js::is_space);
    // `.+` 不跨行终止符、至少一个字
    if v.is_empty() || v.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        // \s* 可以吞掉行终止符再让 .+ 从后面起：只在值整体不含行终止符时成立（前导空白已去掉）
        return None;
    }
    Some(dolce_base::js::trim(v).to_owned())
}

/// 排练号自带方头括号（谱面印「【A】」）：照原样排字、不再套方框
pub fn rehearsal_bracketed(text: &str) -> bool {
    let t = dolce_base::js::trim(text);
    t.strip_prefix('【').and_then(|r| r.strip_suffix('】')).is_some_and(|m| !m.is_empty() && !m.contains(['\n', '\r', '\u{2028}', '\u{2029}']))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(deco_key("Staccato"), Some("dy"));
        assert_eq!(deco_key("HOLD"), Some("yc"));
        assert_eq!(deco_key("dy"), Some("dy"));
        assert_eq!(deco_key("D.C."), Some("dc"));
        assert_eq!(deco_key("xx"), None);
        assert_eq!(tremolo_strokes("///"), Some(3));
        assert_eq!(tremolo_strokes("/////"), None);
        assert_eq!(notehead_of("Head-Circle-X").as_deref(), Some("circle-x"));
        assert_eq!(notehead_of("head-"), None);
        assert_eq!(rehearsal_of("Rehearsal = A ").as_deref(), Some("A"));
        assert_eq!(rehearsal_of("排练号=【B】").as_deref(), Some("【B】"));
        assert!(rehearsal_bracketed(" 【A】"));
    }
}
