//! 参照歌词文本（歌本配套的 .txt / .lrc、歌词网站抄下来的整篇词）→ 一行一行的干净歌词。
//!
//! 两处共用：识别的参照歌词互证（`omr-todoc::reflyrics`，逐字核对识别出的字）与按参照歌词排演唱顺序（[`crate::singfit`]，
//! 切段落、写 `%%sing`）。这里只管文本：解码、lrc 按时间展开、去掉信息行 / 段号 / 结构标注，留下歌词行，
//! 并记下每行属于第几段（空行分段）、这一段前写的结构标注（`副歌` `Chorus` `Verse 2`…，排演唱顺序时当角色提示）。

use std::sync::OnceLock;

use dolce_base::js;
use regex::Regex;

/// 一行歌词（已去掉段号、结构标注、行首信息）
#[derive(Clone, Debug, PartialEq)]
pub struct RefLine {
    /// 去掉标注后的这一行（仍带标点与空格）
    pub text: String,
    /// 第几段（0 基）：空行、单独一行的结构标注都另起一段；lrc 里空的时间行也算
    pub para: usize,
    /// 这一段开头写的结构标注（原文，如 `副歌`、`Chorus`、`Verse 2`）
    pub label: Option<String>,
}

/// 汉字（基本区）
pub fn is_hanzi(c: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&c)
}

/// JS 正则 `\s`
const WS: &str = r"[\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]";

fn re(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(&pat.replace("WS", WS)).expect("正则"))
}

/// 歌词文件字节 → 文本。歌本配套的歌词编码混杂：带 BOM 的 UTF-16LE / BE、UTF-8，否则先按 UTF-8 严格解码、解不了退 GBK（老 .txt / .lrc 多是 GBK）
pub fn decode_lyrics_bytes(b: &[u8]) -> String {
    use encoding_rs::{GBK, UTF_16BE, UTF_16LE};
    if b.starts_with(&[0xff, 0xfe]) {
        return UTF_16LE.decode_without_bom_handling(&b[2..]).0.into_owned();
    }
    if b.starts_with(&[0xfe, 0xff]) {
        return UTF_16BE.decode_without_bom_handling(&b[2..]).0.into_owned();
    }
    if b.starts_with(&[0xef, 0xbb, 0xbf]) {
        return String::from_utf8_lossy(&b[3..]).into_owned();
    }
    match std::str::from_utf8(b) {
        Ok(s) => s.to_string(),
        Err(_) => GBK.decode_without_bom_handling(b).0.into_owned(),
    }
}

// 结构标注：`(副歌)`、`【副歌】`、`[Chorus]`、`副歌：`、单独一行的 `1.` / `一、`
const LABEL_WORDS: &str = "副歌|副|和|合|间奏|尾声|结尾|重复|重唱|独唱|齐唱|合唱|领|众|男|女|男声|女声|主歌|桥段|前副歌|导歌|chorus|refrain|verse|bridge|coda|intro|outro|ending|pre-chorus|tag";

fn label_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(&format!(r"(?i)^(?:{LABEL_WORDS}){WS}*[0-9]*$").replace("WS", WS)).expect("正则"))
}

/// 信息行的字段名（`词曲：` `编曲/混音：` `演唱、和声：`）：几个字段名用 `/` `、` `&` 连写也算
const META_WORDS: &str = "歌曲|歌名|曲名|专辑|作词|作曲|词|曲|词曲|演唱|歌手|编曲|原唱|混音|录音|制作|制作人|监制|和声|翻译|译配|译|出品|发行|吉他|贝斯|鼓|键盘|母带|配唱|ti|ar|al|by|offset";

/// 歌词文本 → 歌词行（标点、空格留着；段号、结构标注、lrc 时间戳与信息行都去掉）。
/// lrc 一句带几个时间戳 = 这句唱几遍，按时间展开排序（就是演唱顺序）。
pub fn ref_lines(text: &str) -> Vec<RefLine> {
    static LRC_LINE: OnceLock<Regex> = OnceLock::new();
    static LRC_TS: OnceLock<Regex> = OnceLock::new();
    static TAG: OnceLock<Regex> = OnceLock::new();
    static META: OnceLock<Regex> = OnceLock::new();
    static BRACKET: OnceLock<Regex> = OnceLock::new();
    static NUM: OnceLock<Regex> = OnceLock::new();
    static HEAD_LABEL: OnceLock<Regex> = OnceLock::new();
    static HEAD_NUM: OnceLock<Regex> = OnceLock::new();
    static HEAD_NUM2: OnceLock<Regex> = OnceLock::new();
    let lrc_ts = re(&LRC_TS, r"\[([0-9]+):([0-9]+(?:\.[0-9]+)?)\]");

    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines: Vec<String> = split_lines(text);
    let lrc_line = re(&LRC_LINE, r"^WS*\[[0-9]+:[0-9]");
    if lines.iter().any(|l| lrc_line.is_match(l)) {
        let mut timed: Vec<(f64, String)> = vec![];
        for l in &lines {
            let s = lrc_ts.replace_all(l, "").into_owned();
            for m in lrc_ts.captures_iter(l) {
                timed.push((js::number(&m[1]) * 60.0 + js::number(&m[2]), s.clone()));
            }
        }
        timed.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        lines = timed.into_iter().map(|x| x.1).collect();
    }
    let tag = re(&TAG, r"^\[[a-zA-Z]+:.*\]$");
    let meta = re(&META, &format!(r"(?i)^(?:{META_WORDS})(?:WS*[/、&]WS*(?:{META_WORDS}))*WS*[:：]"));
    let bracket = re(&BRACKET, r"[(（【\[<《]WS*([^)）】\]>》]{1,12}?)WS*[)）】\]>》]");
    let num = re(&NUM, r"^(?:[0-9]+|[一二三四五六七八九十]+)$");
    let head_label = re(&HEAD_LABEL, r"(?i)^[（(]?WS*(副歌|副|和|合|chorus|refrain|verse|bridge|主歌|桥段)WS*[0-9]*WS*[:：)）]WS*");
    let head_num = re(&HEAD_NUM, r"^WS*(?:[0-9]{1,2}|[一二三四五六七八九十])WS*[.．、:：)）]WS*");
    let head_num2 = re(&HEAD_NUM2, r"^WS*[0-9]{1,2}WS+");
    let label = label_re();

    let mut out: Vec<RefLine> = vec![];
    let mut para = 0usize;
    // 上一行之后有没有分段（空行 / 单独的标注行）
    let mut brk = false;
    let mut pending_label: Option<String> = None;
    for raw in &lines {
        let l = js::trim(raw);
        if l.is_empty() {
            brk = true;
            continue;
        }
        if tag.is_match(l) || meta.is_match(l) {
            continue;
        }
        let mut found: Option<String> = None;
        // 括起来的结构标注整个去掉；括号里是词（`(阿们)`）的保留
        let l = bracket.replace_all(l, |c: &regex::Captures| {
            let inner = js::trim(&c[1]);
            if label.is_match(inner) {
                found.get_or_insert_with(|| inner.to_string());
                String::new()
            } else if num.is_match(inner) {
                String::new()
            } else {
                c[0].to_string()
            }
        });
        // 行首的结构标注：`副歌：` `副)` `副）`（只有半边括号，上面那条配不上）
        let l = match head_label.captures(&l) {
            Some(c) => {
                found.get_or_insert_with(|| js::trim(&c[1]).to_string());
                l[c.get(0).map_or(0, |m| m.end())..].to_string()
            }
            None => l.into_owned(),
        };
        // 行首段号 `1.` `一、`：也是新的一段
        let numbered = head_num.find(&l).is_some();
        let l = head_num.replacen(&l, 1, "").into_owned();
        // `1 我主…`
        let l = match head_num2.find(&l) {
            Some(m) if l[m.end()..].chars().next().is_some_and(is_hanzi) => l[m.end()..].to_string(),
            _ => l,
        };
        let l = js::trim(&l);
        if l.is_empty() || label.is_match(l) {
            // 单独一行的标注：下一段的角色
            if label.is_match(l) && !l.is_empty() {
                found.get_or_insert_with(|| l.to_string());
            }
            if found.is_some() {
                pending_label = found;
            }
            brk = true;
            continue;
        }
        if found.is_some() || numbered {
            brk = true;
        }
        if brk && !out.is_empty() {
            para += 1;
        }
        let lab = if brk || out.is_empty() { found.or_else(|| pending_label.take()) } else { None };
        out.push(RefLine { text: l.to_string(), para, label: lab });
        brk = false;
    }
    out
}

/// `split(/\r\n|\r|\n/)`
fn split_lines(text: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut it = text.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '\r' => {
                if it.peek() == Some(&'\n') {
                    it.next();
                }
                out.push(std::mem::take(&mut cur));
            }
            '\n' => out.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paragraphs_labels_and_meta() {
        let t = "词曲 ：A & B\n编曲/混音：某某\n\n你是我奖赏\n是我唯一\n\n【副歌】\n基督是我满足\n\n2. 基督全所有\n副歌：一切在于你";
        let ls = ref_lines(t);
        let got: Vec<(&str, usize, Option<&str>)> = ls.iter().map(|l| (l.text.as_str(), l.para, l.label.as_deref())).collect();
        assert_eq!(
            got,
            vec![("你是我奖赏", 0, None), ("是我唯一", 0, None), ("基督是我满足", 1, Some("副歌")), ("基督全所有", 2, None), ("一切在于你", 3, Some("副歌"))]
        );
    }

    #[test]
    fn lrc_sorted_and_blank_breaks() {
        let t = "[ti:x]\n[00:01.00]甲乙\n[00:03.00]\n[00:04.00][00:02.00]丙丁";
        let ls = ref_lines(t);
        let got: Vec<(&str, usize)> = ls.iter().map(|l| (l.text.as_str(), l.para)).collect();
        assert_eq!(got, vec![("甲乙", 0), ("丙丁", 0), ("丙丁", 1)]);
    }
}
