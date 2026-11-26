//! 扩展 meta 的键注册表与读写（同 `src/model/metakeys.ts`）。扩一个数据项只在这里加一行。

use crate::doc::{Creator, Song, SongMeta};
use crate::base::js;

pub struct MetaKeyDef {
    pub key: &'static str,
    /// 编辑器表单、报表用的名字
    pub label: &'static str,
    /// 默认排版角色（`style/sheet.ts::StyleRole`）
    pub role: Option<&'static str>,
    /// 录入一整串时按 `;` / `；` 切成多项（标签）
    pub split: bool,
    /// 值是布尔开关（"true"/"false"）
    pub flag: bool,
}

const fn k(key: &'static str, label: &'static str, role: Option<&'static str>) -> MetaKeyDef {
    MetaKeyDef { key, label, role, split: false, flag: false }
}
const fn f(key: &'static str, label: &'static str) -> MetaKeyDef {
    MetaKeyDef { key, label, role: None, split: false, flag: true }
}

pub const META_KEYS: &[MetaKeyDef] = &[
    k("title-alt", "英文标题", Some("titleAlt")),
    k("scripture", "题下经文", Some("scripture")),
    k("scripture-ref", "题下经文出处", Some("scriptureRef")),
    k("related-scriptures", "经文参考", Some("relatedScriptures")),
    MetaKeyDef { key: "tags", label: "标签", role: Some("tags"), split: true, flag: false },
    k("category", "分类", Some("header")),
    k("tune", "曲调名", Some("note")),
    k("ccli", "CCLI 编号", Some("note")),
    k("rights-extra", "译配权", Some("rights")),
    k("note-bl", "页脚注释（左）", Some("note")),
    k("note-bc", "页脚注释（中）", Some("note")),
    k("note-br", "页脚注释（右）", Some("note")),
    f("layout.new-page", "另起一页"),
    // 纸张：MusicXML 的 `<page-layout>` 转成 123/ABC 时落在这里
    k("page", "纸张（A4 或「宽 高」pt）", None),
    k("page-orientation", "纸张方向（portrait/landscape）", None),
    k("page-margin", "页边距（上 右 下 左，pt）", None),
    k("staff-size", "五线谱谱表高（mm）", None),
    k("lyric-size", "五线谱歌词字号（pt）", None),
    k("font-title", "标题字体（字号 [bold] 字体族）", None),
    k("font-subtitle", "副标题字体", None),
    k("font-scripture", "经文字体", None),
    k("font-credit", "词曲作者字体", None),
    f("layout.melody-only", "只留旋律声部"),
    f("layout.chinese-hyphen", "歌词连字符用「—」"),
];

pub fn meta_key_def(key: &str) -> Option<&'static MetaKeyDef> {
    META_KEYS.iter().find(|d| d.key == key)
}

/// 键名是否合法：小写字母/数字开头，其后字母、数字、`-`、`.`。
pub fn is_meta_key(key: &str) -> bool {
    let mut cs = key.chars();
    matches!(cs.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && cs.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
}

pub fn get_meta<'a>(song: &'a Song, key: &str) -> &'a [String] {
    song.meta.as_ref().and_then(|m| m.get(key)).map_or(&[], |v| v.as_slice())
}

/// 多项合成一段文字。
pub fn meta_text(song: &Song, key: &str, joiner: &str) -> String {
    get_meta(song, key).join(joiner)
}

pub fn meta_flag(song: &Song, key: &str) -> Option<bool> {
    let v = get_meta(song, key).first()?;
    let v = js::trim(v).to_lowercase();
    if v.is_empty() {
        return None;
    }
    Some(v == "true" || v == "1" || v == "yes")
}

/// 写一项（整键替换）。空列表 = 删键；删到空时 `meta` 本身也删掉。
pub fn set_meta(song: &mut Song, key: &str, values: &[String]) {
    if values.is_empty() {
        let Some(m) = song.meta.as_mut() else { return };
        // `delete obj[k]`：其余键次序不变
        m.shift_remove(key);
        if m.is_empty() {
            song.meta = None;
        }
        return;
    }
    song.meta.get_or_insert_with(SongMeta::new).insert(key.to_owned(), values.to_vec());
}

/// 追加一项。
pub fn add_meta(song: &mut Song, key: &str, value: &str) {
    song.meta.get_or_insert_with(SongMeta::new).entry(key.to_owned()).or_default().push(value.to_owned());
}

/// 按键浅覆盖（书清单优先于谱文件）。
pub fn overlay_meta(base: Option<&SongMeta>, over: Option<&SongMeta>) -> Option<SongMeta> {
    match over {
        Some(o) if !o.is_empty() => {
            let mut m = base.cloned().unwrap_or_default();
            for (k, v) in o {
                m.insert(k.clone(), v.clone());
            }
            Some(m)
        }
        _ => base.cloned(),
    }
}

/// 一整串按注册表的 `split` 切成多项（没登记 split 的键原样一项）。
pub fn split_meta_value(key: &str, text: &str) -> Vec<String> {
    if !meta_key_def(key).is_some_and(|d| d.split) {
        return vec![text.to_owned()];
    }
    text.split([';', '；']).map(js::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect()
}

// ───────────────────────── 词曲署名的类型 ─────────────────────────

/// `t` 是 `a`、若干空白、`b`（`/^a\s*b$/`）
fn spaced(t: &str, a: char, b: char) -> bool {
    t.strip_prefix(a).and_then(|r| r.strip_suffix(b)).is_some_and(|mid| mid.chars().all(js::is_space))
}

fn type_of_label(label: &str) -> Option<&'static str> {
    let t = js::trim(label);
    // /^词\s*[、/&和]?\s*曲$/
    if let Some(mid) = t.strip_prefix('词').and_then(|r| r.strip_suffix('曲')) {
        let m = js::trim(mid);
        let sep_ok = m.is_empty() || (m.chars().count() == 1 && matches!(m.chars().next(), Some('、' | '/' | '&' | '和')));
        if sep_ok && mid.chars().filter(|c| !js::is_space(*c)).count() <= 1 {
            return Some("words-and-music");
        }
    }
    if spaced(t, '作', '词') || spaced(t, '填', '词') || t == "词" {
        return Some("lyricist");
    }
    if spaced(t, '作', '曲') || t == "曲" {
        return Some("composer");
    }
    if spaced(t, '编', '曲') || spaced(t, '改', '编') || t == "编" {
        return Some("arranger");
    }
    if spaced(t, '译', '词') || spaced(t, '译', '配') || spaced(t, '配', '译') || spaced(t, '中', '译') || spaced(t, '翻', '译') || t == "译" {
        return Some("translator");
    }
    if spaced(t, '制', '谱') || spaced(t, '打', '谱') {
        return Some("transcriber");
    }
    None
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `.`（非 u 模式）不认的行终止符
fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// 后缀式署名的词尾（`(词\s*曲|作词|作曲|编曲|词|曲)$`）：整串是不是其中之一
fn suffix_alt(rest: &str) -> Option<&str> {
    if let Some(mid) = rest.strip_prefix('词').and_then(|r| r.strip_suffix('曲')) {
        if mid.chars().all(js::is_space) {
            return Some(rest);
        }
    }
    matches!(rest, "作词" | "作曲" | "编曲" | "词" | "曲").then_some(rest)
}

/// 按原文里的标签定署名类型：前缀式「作词：X」或后缀式「X 词」。**只认明写的标签**，认不出返回 None。
pub fn creator_type_of(text: &str) -> Option<&'static str> {
    let t = js::trim(text);
    // /^([^：:]{1,8}?)\s*[：:]/
    if let Some(ci) = t.find([':', '：']) {
        let prefix = &t[..ci];
        if !prefix.is_empty() {
            let g = prefix.trim_end_matches(js::is_space);
            // 全是空白时惰性组取一个字（标签全空白，认不出）
            let g = if g.is_empty() { &prefix[..prefix.chars().next().unwrap().len_utf8()] } else { g };
            if utf16_len(g) <= 8 {
                return type_of_label(g);
            }
        }
    }
    // /^(.{2,}?)\s*(词\s*曲|作词|作曲|编曲|词|曲)$/：组 1 取最短
    for (bi, _) in t.char_indices().chain(std::iter::once((t.len(), ' '))) {
        let head = &t[..bi];
        if utf16_len(head) < 2 {
            continue;
        }
        if head.chars().any(is_line_terminator) {
            break;
        }
        let rest = t[bi..].trim_start_matches(js::is_space);
        if let Some(alt) = suffix_alt(rest) {
            if head.ends_with(['（', '(']) {
                return None;
            }
            return type_of_label(alt);
        }
    }
    None
}

/// 无 type 源格式的一条署名。
pub fn creator_of(text: &str) -> Creator {
    Creator { kind: creator_type_of(text).unwrap_or("composer").to_owned(), text: text.to_owned() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creators() {
        assert_eq!(creator_type_of("作词：张三"), Some("lyricist"));
        assert_eq!(creator_type_of("词曲: 李四"), Some("words-and-music"));
        assert_eq!(creator_type_of("词 / 曲：王五"), Some("words-and-music"));
        assert_eq!(creator_type_of("张三 词"), Some("lyricist"));
        assert_eq!(creator_type_of("张三 词曲"), Some("words-and-music"));
        assert_eq!(creator_type_of("张三 编曲"), Some("arranger"));
        assert_eq!(creator_type_of("曲"), None);
        assert_eq!(creator_type_of("Words: X"), None);
        assert_eq!(creator_type_of("王(词"), None);
        assert_eq!(creator_type_of("译配：某"), Some("translator"));
        assert!(is_meta_key("layout.new-page") && !is_meta_key("Tag"));
        assert_eq!(split_meta_value("tags", " a；b;;c "), vec!["a", "b", "c"]);
    }
}
