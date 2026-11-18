//! 参照歌词互证（原 `omr/reflyrics.ts`）：拿同一首诗歌的歌词文本（歌本配套的 .txt / .lrc）与识别出的歌词逐字对照——
//! 形近字按参照选字、补回漏读的字；两边对不上的（版本用字、字多字少、一字多音却没认出弧、反复顺序对不上）只报告，不擅改。
//!
//! **参照是按演唱顺序写全的**：反复段、每段后的副歌都照唱写一遍，谱面却只印一遍、多段叠在下面。
//! 所以先把识别结果按演唱顺序展开（与投影档排版、试听同一条路：识别结果 → 模型 → 投影档小节 → 逐遍走），
//! 再与参照整篇对齐；展开不出来或展开后反而对不上时，退回谱面印的顺序（逐段串起各谱行）。
//!
//! 逐字候选取识别时挂在音上的 `lyric_alts`；判据与门槛的来历见 docs/实现/OMR-简谱识别.md「参照歌词互证」。

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use dolce_base::js;
use dolce_omr_core::image::Rect;
use dolce_omr_sheet::jianpu::{JpNum, LyricAlt, RecognizedScore, StaffRow};
use dolce_omr_text::hanvariant::simplified_of;
use dolce_play::walk::{walk_play, Step, WalkItem};
use dolce_view::playsong::{play_data_of_song, song_measures, PlaySongOptions};
use dolce_view::slots::doc_view;
use regex::Regex;
use serde::Serialize;

use crate::jianpu::recognized_to_doc;

// ───────────────────────── 报告 ─────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckKind {
    /// 形近字按参照改了
    Fixed,
    /// 补上漏读的字
    Filled,
    /// 版本用字不同（他 / 祂…，只报）
    Variant,
    /// 字不同且不像（只报）
    Mismatch,
    /// 参照多出字、谱上没有可落的音
    MissingNote,
    /// 识别多出参照没有的字
    ExtraChar,
    /// 一字多音却没认出弧
    SlurSuspect,
    /// 按演唱顺序反而对不上（反复 / 房号 / 跳转可能认错）
    RepeatSuspect,
    /// 整首词对不上题（不做任何改动）
    NoMatch,
}

impl CheckKind {
    fn label(self) -> &'static str {
        match self {
            CheckKind::Fixed => "已改",
            CheckKind::Filled => "已补",
            CheckKind::Variant => "用字不同",
            CheckKind::Mismatch => "不一致",
            CheckKind::MissingNote => "谱上缺位",
            CheckKind::ExtraChar => "参照没有",
            CheckKind::SlurSuspect => "疑漏弧",
            CheckKind::RepeatSuspect => "疑反复",
            CheckKind::NoMatch => "对不上",
        }
    }
}

/// 参照字在 OCR 候选里的名次（0 基）与得分、首选得分：选字门槛看的就是 score / top
#[derive(Clone, Debug, Serialize)]
pub struct Cand {
    pub rank: usize,
    pub score: f64,
    pub top: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricCheckItem {
    pub kind: CheckKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verse: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bar: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bbox: Option<Rect>,
    /// 谱面（识别）字
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ocr: Option<String>,
    /// 参照字
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub ref_: Option<String>,
    /// 参照里所在的那一句，供人对照
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// 该字自己的源图框（补字没有）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub char_box: Option<Rect>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cand: Option<Cand>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// 已改 / 已补但可疑、建议人工复查的原因
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review: Option<String>,
}

impl LyricCheckItem {
    fn new(kind: CheckKind) -> Self {
        LyricCheckItem { kind, verse: None, row: None, note: None, bar: None, bbox: None, ocr: None, ref_: None, context: None, char_box: None, cand: None, detail: None, review: None }
    }

    fn detail(mut self, d: impl Into<String>) -> Self {
        self.detail = Some(d.into());
        self
    }

    /// 报告里一条的可读写法（命令行打到 stderr 用）
    pub fn format(&self) -> String {
        let where_ = match self.row {
            Some(r) => format!("第{}行 第{}段 第{}音（小节{}）", r + 1, self.verse.unwrap_or(0) + 1, self.note.unwrap_or(0) + 1, self.bar.map_or("undefined".into(), |b| b.to_string())),
            None => "全曲".into(),
        };
        let what = if self.ocr.is_some() || self.ref_.is_some() {
            format!("：谱面「{}」→ 歌词「{}」", self.ocr.as_deref().unwrap_or(""), self.ref_.as_deref().unwrap_or(""))
        } else {
            String::new()
        };
        let review = if self.review.is_some() { "·待复查" } else { "" };
        let detail = self.detail.as_deref().map(|d| format!("  {d}")).unwrap_or_default();
        let warn = self.review.as_deref().map(|r| format!("  ⚠ {r}")).unwrap_or_default();
        let ctx = self.context.as_deref().map(|c| format!("  〔{c}〕")).unwrap_or_default();
        format!("[{}{review}] {where_}{what}{detail}{warn}{ctx}", self.kind.label())
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct UnmatchedRef {
    pub from: usize,
    pub to: usize,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricCheck {
    /// 按哪种顺序对上的：`expanded` 演唱顺序展开（反复写全）/ `printed` 谱面印的顺序
    pub order: &'static str,
    pub ref_chars: usize,
    pub ocr_chars: usize,
    /// 识别字里与参照同字的个数（按演唱顺序，同一字唱几遍记几遍）
    pub matched: usize,
    pub items: Vec<LyricCheckItem>,
    /// 参照里整段没对上的字区间 [起, 止)（参照多写的段、谱面没印的段）
    pub unmatched_ref: Vec<UnmatchedRef>,
}

// ───────────────────────── 小工具 ─────────────────────────

fn is_hanzi(c: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&c)
}

/// 比较口径：繁简归一（繁体谱对简体词不算不同）
fn norm_ch(c: char) -> char {
    simplified_of(c).unwrap_or(c)
}

/// 候选（一个字串）的归一：单字查表，别的原样
fn norm_str(s: &str) -> String {
    let mut it = s.chars();
    match (it.next(), it.next()) {
        (Some(c), None) => norm_ch(c).to_string(),
        _ => s.to_string(),
    }
}

/// OCR 得分在识别结果里是 f32，按 f64 算比例（与编辑器读识别结果 JSON 得到的数相同）
fn score_f64(x: f32) -> f64 {
    x as f64
}

fn rcx(r: &Rect) -> f64 {
    r.x + r.w / 2.0
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

// ───────────────────────── 参照歌词解析 ─────────────────────────

#[derive(Clone, Debug)]
pub struct RefToken {
    pub ch: char,
    pub norm: char,
    /// 所在那一句（报告里给人对照；太长时只截该字前后一段）
    pub line: String,
}

/// 报告里的参照句：一行太长（整段不分行的歌词）时截该字前后各 12 字
fn context_of(line: &str, pos: usize) -> String {
    let cs: Vec<char> = line.chars().collect();
    if cs.len() <= 30 {
        return line.to_string();
    }
    let a = pos.saturating_sub(12);
    let b = (pos + 13).min(cs.len());
    format!("{}{}{}", if a > 0 { "…" } else { "" }, cs[a..b].iter().collect::<String>(), if b < cs.len() { "…" } else { "" })
}

// 结构标注：`(副歌)`、`【副歌】`、`[Chorus]`、`副歌：`、单独一行的 `1.` / `一、`
const LABEL_WORDS: &str = "副歌|副|和|合|间奏|尾声|结尾|重复|重唱|独唱|齐唱|合唱|领|众|男|女|男声|女声|chorus|refrain|verse|bridge|coda|intro|outro|ending";

fn label_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(&format!(r"(?i)^(?:{LABEL_WORDS}){WS}*[0-9]*$")).expect("正则"))
}

/// 歌词文本 → 逐字 token（只收汉字；标点、段号、结构标注、lrc 时间戳与信息行都去掉）。
/// lrc 一句带几个时间戳 = 这句唱几遍，按时间展开排序（就是演唱顺序）
pub fn parse_ref_lyrics(text: &str) -> Vec<RefToken> {
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
    let meta = re(&META, r"(?i)^(?:歌曲|歌名|曲名|专辑|作词|作曲|词|曲|词曲|演唱|歌手|编曲|原唱|ti|ar|al|by|offset)WS*[:：]");
    let bracket = re(&BRACKET, r"[(（【\[<《]WS*([^)）】\]>》]{1,8}?)WS*[)）】\]>》]");
    let num = re(&NUM, r"^(?:[0-9]+|[一二三四五六七八九十]+)$");
    let head_label = re(&HEAD_LABEL, r"(?i)^[（(]?WS*(?:副歌|副|和|合|chorus|refrain)WS*[:：)）]WS*");
    let head_num = re(&HEAD_NUM, r"^WS*(?:[0-9]{1,2}|[一二三四五六七八九十])WS*[.．、:：)）]WS*");
    let head_num2 = re(&HEAD_NUM2, r"^WS*[0-9]{1,2}WS+");
    let label = label_re();

    let mut out = vec![];
    for raw in &lines {
        let l = js::trim(raw);
        if l.is_empty() || tag.is_match(l) || meta.is_match(l) {
            continue;
        }
        // 括起来的结构标注整个去掉；括号里是词（`(阿们)`）的保留
        let l = bracket.replace_all(l, |c: &regex::Captures| {
            let inner = js::trim(&c[1]);
            if label.is_match(inner) || num.is_match(inner) {
                String::new()
            } else {
                c[0].to_string()
            }
        });
        // 行首的结构标注：`副歌：` `副)` `副）`（只有半边括号，上面那条配不上）
        let l = head_label.replacen(&l, 1, "").into_owned();
        // 行首段号 `1.` `一、`
        let l = head_num.replacen(&l, 1, "").into_owned();
        // `1 我主…`
        let l = match head_num2.find(&l) {
            Some(m) if l[m.end()..].chars().next().is_some_and(is_hanzi) => l[m.end()..].to_string(),
            _ => l,
        };
        let l = js::trim(&l);
        if l.is_empty() || label.is_match(l) {
            continue;
        }
        for (pos, c) in l.chars().enumerate() {
            if is_hanzi(c) {
                out.push(RefToken { ch: c, norm: norm_ch(c), line: context_of(l, pos) });
            }
        }
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

// ───────────────────────── 识别侧序列 ─────────────────────────

/// 音符：(谱行, 行内第几个)
type NoteAt = (usize, usize);

/// 识别侧序列的一项：一个汉字，或一个没有词的音（空位）。同一 (音符, 段) 可因反复出现多次
#[derive(Clone, Debug)]
struct Item {
    n: NoteAt,
    verse: i64,
    /// 该段歌词串里第几个汉字（空位为 -1）
    idx: i64,
    ch: Option<char>,
    norm: Option<char>,
    /// 空位在弧 / 连音线的延续里：本就不该有新字（一字多音）
    held: bool,
    /// 空位所在谱行这一段整行没词（房外只印一行、器乐行……）：不能往上补字
    absent: bool,
}

fn num(score: &RecognizedScore, n: NoteAt) -> &JpNum {
    &score.rows[n.0].nums[n.1]
}

fn lyric_of(nm: &JpNum, v: i64) -> Option<&str> {
    usize::try_from(v).ok().and_then(|v| nm.lyrics.get(v)).map(String::as_str)
}

fn has_hanzi(s: &str) -> bool {
    s.chars().any(is_hanzi)
}

/// 音符 → 小节号（按行内小节线数，跨行小节不细究，只供报告定位）。与 `rows[].nums` 平行
fn locate(rows: &[StaffRow]) -> Vec<Vec<i64>> {
    let mut bar_base: HashMap<u32, i64> = HashMap::new();
    let mut out = vec![];
    for r in rows {
        let voice = r.voice.unwrap_or(0);
        let base = bar_base.get(&voice).copied().unwrap_or(0);
        out.push(r.nums.iter().map(|n| base + 1 + r.barline_xs.iter().filter(|&&x| x < rcx(&n.bbox)).count() as i64).collect());
        let last_x = r.nums.last().map_or(0.0, |n| rcx(&n.bbox));
        let more = r.barline_xs.iter().filter(|&&x| x < last_x).count() as i64 + i64::from(r.barline_xs.iter().any(|&x| x > last_x));
        bar_base.insert(voice, base + more);
    }
    out
}

/// 弧 / 连音线的延续音（不是起音）：在一条还开着的 slur 里，或是 tie 的收尾。与 `rows[].nums` 平行
fn held_notes(rows: &[StaffRow]) -> Vec<Vec<bool>> {
    let mut depth: HashMap<u32, i64> = HashMap::new();
    let mut out = vec![];
    for r in rows {
        let v = r.voice.unwrap_or(0);
        let mut d = depth.get(&v).copied().unwrap_or(0);
        let mut row = vec![];
        for n in &r.nums {
            row.push(d > 0 || n.tie_stop || n.slur_stop > 0);
            d = (d + n.slur_start as i64 - n.slur_stop as i64).max(0);
        }
        out.push(row);
        depth.insert(v, d);
    }
    out
}

struct Builder<'a> {
    score: &'a RecognizedScore,
    held: &'a [Vec<bool>],
    out: Vec<Item>,
}

impl Builder<'_> {
    fn push(&mut self, n: NoteAt, verse: i64, text: Option<&str>, rest: bool) {
        let hz: Vec<char> = text.unwrap_or("").chars().filter(|&c| is_hanzi(c)).collect();
        if !hz.is_empty() {
            for (idx, c) in hz.into_iter().enumerate() {
                self.out.push(Item { n, verse, idx: idx as i64, ch: Some(c), norm: Some(norm_ch(c)), held: false, absent: false });
            }
            return;
        }
        // 英文音节 v1 不参与对齐
        if text.is_some_and(|t| t.chars().any(|c| c.is_ascii_alphabetic())) {
            return;
        }
        let nm = num(self.score, n);
        // 休止不占字
        if rest || nm.digit == 0 {
            return;
        }
        let row = &self.score.rows[n.0];
        let absent = !row.nums.iter().any(|x| lyric_of(x, verse).is_some_and(|t| !t.is_empty()));
        self.out.push(Item { n, verse, idx: -1, ch: None, norm: None, held: self.held[n.0][n.1], absent });
    }
}

/// 按演唱顺序展开（与投影档同口径：第 pass 遍唱第 pass 段、副歌每遍都唱）。展开不出来返回 None
fn expanded_items(score: &RecognizedScore, held: &[Vec<bool>]) -> Option<Vec<Item>> {
    let built = recognized_to_doc(score);
    let flat: Vec<NoteAt> = score.rows.iter().enumerate().flat_map(|(ri, r)| (0..r.nums.len()).map(move |ni| (ri, ni))).collect();
    let num_of: HashMap<u32, NoteAt> = built.num_of.iter().filter_map(|&(id, i)| Some((id, *flat.get(i)?))).collect();
    let doc = &built.doc;
    let view = doc_view(doc, None);
    let opts = PlaySongOptions { for_expanded: true };
    let sm = song_measures(doc, &view, 0, opts, false).ok()??;
    let pd = play_data_of_song(doc, &view, 0, opts).ok()??;
    let measures = sm.parts.first()?;
    if pd.measures.is_empty() {
        return None;
    }
    let items: Vec<WalkItem> = pd.measures.iter().map(WalkItem::from).collect();
    let mut b = Builder { score, held, out: vec![] };
    for step in walk_play(&items, false) {
        let Step::Measure { mid, pass, skip, limit, .. } = step else { continue };
        let Some(m) = js::index(mid).and_then(|i| measures.get(i)) else { continue };
        let mut chords: Vec<_> = m.entries.iter().collect();
        chords.sort_by(|a, b| a.position.compare_to(&b.position).cmp(&0));
        if skip != 0.0 {
            chords = chords.into_iter().skip(skip as usize).collect();
        }
        if limit >= 0.0 {
            chords.truncate(limit as usize);
        }
        let p = js::max(1.0, pass);
        for ch in chords {
            let Some(&n) = ch.id.and_then(|id| num_of.get(&id)) else { continue };
            let nm = num(score, n);
            let ls = ch.notes.first().map_or(&[][..], |x| x.lyrics.as_slice());
            let l = ls.iter().find(|x| x.number == p).or_else(|| ls.iter().find(|x| x.refrain));
            let mut verse = (p - 1.0) as i64;
            if let Some(l) = l {
                let at = if lyric_of(nm, (l.number - 1.0) as i64) == Some(l.text.as_str()) && l.number.fract() == 0.0 {
                    (l.number - 1.0) as i64
                } else {
                    nm.lyrics.iter().position(|t| *t == l.text).map_or(-1, |i| i as i64)
                };
                verse = if at >= 0 { at } else { (l.number - 1.0) as i64 };
            }
            b.push(n, verse, lyric_of(nm, verse), ch.rest);
        }
    }
    Some(b.out)
}

/// 谱面印的顺序：第 1 段从头到尾，再第 2 段……（不展开反复）
fn printed_items(score: &RecognizedScore, held: &[Vec<bool>]) -> Vec<Item> {
    let mut b = Builder { score, held, out: vec![] };
    let nv = score.rows.iter().flat_map(|r| r.nums.iter().map(|n| n.lyrics.len())).max().unwrap_or(0);
    for v in 0..nv as i64 {
        for (ri, r) in score.rows.iter().enumerate() {
            // 这一段整行没词的谱行不进来
            if !r.nums.iter().any(|n| lyric_of(n, v).is_some_and(|t| !t.is_empty())) {
                continue;
            }
            for (ni, n) in r.nums.iter().enumerate() {
                b.push((ri, ni), v, lyric_of(n, v), n.digit == 0);
            }
        }
    }
    b.out
}

// ───────────────────────── 对齐 ─────────────────────────

const SAME: f64 = 2.0;
const SUB: f64 = -1.0;
const FILL: f64 = -1.0;
const GAP_OPEN: f64 = -3.0;
const GAP_EXT: f64 = -0.5;
const NEG: f64 = -1e9;

/// 一对：a = 识别侧下标（-1 = 参照多出的字），b = 参照下标（-1 = 识别侧多出的项）
type Pair = (i64, i64);

/// 全局对齐（Gotoh 仿射缺口）：参照首尾免罚（参照常多写标题、多写谱面没印的段）。
/// 缺口按段计：参照里整段副歌 / 衬词识别侧没有时，一段缺口比逐字硬配便宜，不会把真词拉歪。
/// 识别侧空位（没词的音）跳过不罚，只在参照恰好多出字时拿来补（FILL 比开一个缺口便宜）
fn align(a: &[Item], b: &[RefToken]) -> Vec<Pair> {
    let (m, k) = (a.len(), b.len());
    let w = k + 1;
    let n = (m + 1) * w;
    // 三个状态：0 = 上一步配对，1 = 上一步跳过识别项（↑），2 = 上一步跳过参照字（←）
    let mut s = [vec![NEG; n], vec![NEG; n], vec![NEG; n]];
    let mut t = [vec![0u8; n], vec![0u8; n], vec![0u8; n]];
    s[0][0] = 0.0;
    let best3 = |s: &[Vec<f64>; 3], idx: usize, add: [f64; 3]| -> (f64, u8) {
        let (mut bv, mut bs) = (NEG, 0u8);
        for st in 0..3 {
            let v = s[st][idx] + add[st];
            if v > bv {
                bv = v;
                bs = st as u8;
            }
        }
        (bv, bs)
    };
    for i in 0..=m {
        let it = if i > 0 { Some(&a[i - 1]) } else { None };
        // 参照首尾免罚
        let end_row = i == 0 || i == m;
        for j in 0..=k {
            let c = i * w + j;
            if i == 0 && j == 0 {
                continue;
            }
            if let (Some(it), true) = (it, j > 0) {
                let pair = match it.ch {
                    Some(_) => {
                        if it.norm == Some(b[j - 1].norm) {
                            SAME
                        } else {
                            SUB
                        }
                    }
                    None if it.absent => NEG,
                    None => FILL,
                };
                let (v, st) = best3(&s, (i - 1) * w + j - 1, [pair, pair, pair]);
                s[0][c] = v;
                t[0][c] = st;
            }
            if let Some(it) = it {
                // 空位跳过不罚、也不算开缺口；汉字跳过按段计
                let add = if it.ch.is_none() { [0.0, 0.0, 0.0] } else { [GAP_OPEN, GAP_EXT, GAP_OPEN] };
                let (v, st) = best3(&s, (i - 1) * w + j, add);
                s[1][c] = v;
                t[1][c] = st;
            }
            if j > 0 {
                let add = if end_row { [0.0, 0.0, 0.0] } else { [GAP_OPEN, GAP_OPEN, GAP_EXT] };
                let (v, st) = best3(&s, i * w + j - 1, add);
                s[2][c] = v;
                t[2][c] = st;
            }
        }
    }
    let (_, mut st) = best3(&s, m * w + k, [0.0, 0.0, 0.0]);
    let mut pairs = vec![];
    let (mut i, mut j) = (m, k);
    while i > 0 || j > 0 {
        let prev = t[st as usize][i * w + j];
        match st {
            0 => {
                pairs.push(((i - 1) as i64, (j - 1) as i64));
                i -= 1;
                j -= 1;
            }
            1 => {
                pairs.push(((i - 1) as i64, -1));
                i -= 1;
            }
            _ => {
                pairs.push((-1, (j - 1) as i64));
                j -= 1;
            }
        }
        st = prev;
    }
    pairs.reverse();
    pairs
}

fn matched_of(a: &[Item], b: &[RefToken], pairs: &[Pair]) -> usize {
    pairs.iter().filter(|&&(i, j)| i >= 0 && j >= 0 && a[i as usize].ch.is_some() && a[i as usize].norm == Some(b[j as usize].norm)).count()
}

// ───────────────────────── 判定 ─────────────────────────

/// 版本用字（各歌本编辑取舍不同，不是识别错）：只报、不按参照改
const VARIANT_GROUPS: [&str; 13] = ["他祂她牠它", "你祢妳您", "那哪", "阿啊", "于於与", "像象", "的得地", "惟唯", "藉借", "着著", "么吗嘛", "哦喔噢", "耶爷"];

fn is_variant(x: char, y: char) -> bool {
    VARIANT_GROUPS.iter().any(|g| g.contains(x) && g.contains(y))
}

/// 参照字在该字 OCR 候选里、且得分不低于首选的这个比例，才算「形近」、按参照改。
/// 按歌词库 787 首里 336 处「参照字在候选里」逐个看图定的：0.05 是拐点——往下立刻混进歌词文本自己的错字，往上提到 0.1 白丢 11 处改对
const ALT_SCORE_RATIO: f64 = 0.05;
/// 人称代词组：谱面用不用「祂 / 祢」（称神的特殊字形）以谱面为准，参照的写法常与谱面不同
const PRONOUN_GROUPS: [&str; 2] = ["他祂", "你祢"];
const PRONOUN_SPECIAL: &str = "祂祢";

/// OCR 把「祂 / 祢」读成的形近字。「他 / 你」是常用字、很少被读成这些字，所以识别出它们、参照又作他 / 你 / 祂 / 祢时，
/// 图上几乎一定是「祂 / 祢」——哪怕本页的「祂 / 祢」全被读错、按页计数数不出来
fn special_misreads(special: char) -> &'static str {
    match special {
        '祂' => "池袍袖施社弛祀衪地",
        '祢' => "称袮弥",
        _ => "",
    }
}

/// 本页一字多音的音里印了弧的至少占这么多，才把没弧的报「疑漏弧」
const SLUR_PAGE_RATIO: f64 = 0.8;
/// 整首同字率低于此值：词不对题（选错了歌词文件、版本差太多），不做任何改动
const MIN_MATCH_RATIO: f64 = 0.5;

/// 形近又常被歌词文件写错的几组字，按常见词组定字：「己 / 已 / 巳」「人 / 入」「儆 / 做」「瞎 / 唐」「徬 / 傍」。
/// 歌词库里这几处参照常是错字（「舍已」「自已」「他巳」「出死人生」「进人他的门」「做醒」「唐眼」），只能看上下文。判不出来返回 None。
/// `prev2 prev [本字] next`，`end` = 本字后面紧跟标点或到了行尾
const PHRASE_CHARS: &str = "己已巳人入儆做瞎唐徬傍";

pub fn char_by_phrase(ch: char, prev2: Option<char>, prev: Option<char>, next: Option<char>, end: bool) -> Option<char> {
    let in_ = |set: &str, c: Option<char>| c.is_some_and(|c| set.contains(c));
    if "己已巳".contains(ch) {
        return ji_yi_by_phrase(prev2, prev, next, end).or(if ch == '巳' { Some('已') } else { None });
    }
    if "人入".contains(ch) {
        // 出死入生
        if prev == Some('死') && next == Some('生') {
            return Some('入');
        }
        // 免得入了迷惑
        if prev2 == Some('免') && prev == Some('得') {
            return Some('入');
        }
        // 进入、深入、陷入、投入、加入、归入、流入……
        if in_("进深陷投加侵涌纳渗步归流", prev) {
            return Some('入');
        }
        if in_("世众罪爱敌外穷圣义恶女男别旁凡个每", prev) {
            return Some('人');
        }
        if in_("们类", next) {
            return Some('人');
        }
        return None;
    }
    // 儆醒
    if "儆做".contains(ch) {
        return if next == Some('醒') { Some('儆') } else { None };
    }
    // 瞎眼、瞎子
    if "瞎唐".contains(ch) {
        return if in_("眼子", next) { Some('瞎') } else { None };
    }
    // 徬徨（「傍徨」不成词）
    if "徬傍".contains(ch) {
        return if next == Some('徨') { Some('徬') } else { None };
    }
    None
}

fn ji_yi_by_phrase(prev2: Option<char>, prev: Option<char>, next: Option<char>, end: bool) -> Option<char> {
    let in_ = |set: &str, c: Option<char>| c.is_some_and(|c| set.contains(c));
    // 已经
    if next == Some('经') {
        return Some('已');
    }
    // 不能自已、情不自已；其余自己
    if prev == Some('自') {
        return Some(if (prev2 == Some('能') || prev2 == Some('不')) && end { '已' } else { '己' });
    }
    // 舍己、克己、律己、知己、利己、异己、虚己
    if in_("舍克律知利异虚", prev) {
        return Some('己');
    }
    // 己身、己任、己意（不收「见」：「我已见」也常见）
    if in_("身任意", next) {
        return Some('己');
    }
    // 已然、已往、已久
    if in_("然往久", next) {
        return Some('已');
    }
    // 早已、而已、业已
    if in_("早而业", prev) {
        return Some('已');
    }
    // 不已
    if prev == Some('不') && end {
        return Some('已');
    }
    None
}

/// 在一段歌词串里把第 idx 个汉字换成 ch（开引号前缀、尾随标点原样保留）
fn replace_hanzi(text: &str, idx: i64, ch: &str) -> String {
    let mut k = -1;
    let mut out = String::new();
    for c in text.chars() {
        if is_hanzi(c) {
            k += 1;
            if k == idx {
                out += ch;
                continue;
            }
        }
        out.push(c);
    }
    out
}

/// 某个歌词字的 OCR 候选（识别时挂在音上的 `lyric_alts`）
fn alt_of(score: &RecognizedScore, n: NoteAt, verse: i64, idx: i64) -> Option<&LyricAlt> {
    num(score, n).lyric_alts.iter().find(|a| a.verse as i64 == verse && a.idx as i64 == idx)
}

/// 该字的叠加定位框：与它重叠最多的那个逐字歌词区（改字时一并改它的 text）；一个都不重叠时是候选自己的框（改了也不落到结果里）
enum Region {
    At(usize),
    Own(Rect),
}

fn region_of(score: &RecognizedScore, n: NoteAt, verse: i64, idx: i64) -> Option<Region> {
    let a = alt_of(score, n, verse, idx)?;
    let ov = |x: &Rect, y: &Rect| (x.x + x.w).min(y.x + y.w).sub_max(x.x.max(y.x)) * (x.y + x.h).min(y.y + y.h).sub_max(x.y.max(y.y));
    let (mut best, mut bo) = (None, 0.0);
    for (gi, g) in score.lyric_regions.iter().enumerate() {
        let o = ov(&g.bbox, &a.bbox);
        if o > bo {
            bo = o;
            best = Some(gi);
        }
    }
    Some(best.map_or(Region::Own(a.bbox), Region::At))
}

trait SubMax {
    /// `max(0, self - o)`
    fn sub_max(self, o: f64) -> f64;
}

impl SubMax for f64 {
    fn sub_max(self, o: f64) -> f64 {
        js::max(0.0, self - o)
    }
}

fn region_box(score: &RecognizedScore, r: &Region) -> Rect {
    match r {
        Region::At(i) => score.lyric_regions[*i].bbox,
        Region::Own(b) => *b,
    }
}

/// 改字：歌词串与叠加框一起改
fn rewrite(score: &mut RecognizedScore, n: NoteAt, verse: i64, idx: i64, text: &str, ch: &str) -> Option<Rect> {
    score.rows[n.0].nums[n.1].lyrics[verse as usize] = replace_hanzi(text, idx, ch);
    let region = region_of(score, n, verse, idx)?;
    if let Region::At(i) = region {
        let t = replace_hanzi(&score.lyric_regions[i].text, 0, ch);
        score.lyric_regions[i].text = t;
    }
    Some(region_box(score, &region))
}

/// 参照歌词与识别结果互证：改形近字、补漏字，其余不一致只报告。直接改 `score.rows` 里各音符的 `lyrics`（与叠加框的 text），返回核对结果
pub fn apply_ref_lyrics(score: &mut RecognizedScore, ref_text: &str) -> LyricCheck {
    let rf = parse_ref_lyrics(ref_text);
    let bars = locate(&score.rows);
    let held = held_notes(&score.rows);
    let mut items: Vec<LyricCheckItem> = vec![];
    let at = |n: NoteAt, mut x: LyricCheckItem| -> LyricCheckItem {
        x.row = Some(n.0);
        x.note = Some(n.1);
        x.bar = Some(bars[n.0][n.1]);
        x
    };

    let printed = printed_items(score, &held);
    let expanded = expanded_items(score, &held);
    let p_al = align(&printed, &rf);
    let e_al = expanded.as_ref().map(|e| align(e, &rf));
    let p_m = matched_of(&printed, &rf, &p_al);
    let e_m = match (&expanded, &e_al) {
        (Some(e), Some(al)) => matched_of(e, &rf, al) as i64,
        _ => -1,
    };
    // 两种顺序按 F1 比（同字 ×2 ÷ 两边字数和）：只比同字数不行——展开错了会把同一段唱出好几遍，同字数照样高，多出来的几百个字却对不上任何参照
    let hz = |xs: &[Item]| xs.iter().filter(|x| x.ch.is_some()).count();
    let f1 = |mt: f64, xs: &[Item]| 2.0 * mt / (hz(xs) + rf.len()).max(1) as f64;
    let p_f = f1(p_m as f64, &printed);
    let e_f = expanded.as_ref().map_or(-1.0, |e| f1(e_m as f64, e));
    // 按演唱顺序展开是正路；展开后反而明显对得更差 → 反复 / 房号 / 跳转多半认错，退回谱面顺序并报出来
    let (order, a, pairs, matched) = match (expanded, e_al) {
        (Some(e), Some(al)) if p_f <= e_f + 0.1 => ("expanded", e, al, e_m as usize),
        (e, _) => {
            if let Some(e) = &e {
                items.push(LyricCheckItem::new(CheckKind::RepeatSuspect).detail(format!(
                    "按演唱顺序展开：同字 {e_m}/识别 {} 字；按谱面顺序：同字 {p_m}/识别 {} 字（参照 {} 字）——反复/房号/跳转记号可能认错或漏认",
                    hz(e),
                    hz(&printed),
                    rf.len()
                )));
            }
            ("printed", printed, p_al, p_m)
        }
    };
    let ocr_chars = a.iter().filter(|x| x.ch.is_some()).count();
    let mut result = LyricCheck { order, ref_chars: rf.len(), ocr_chars, matched, items: vec![], unmatched_ref: vec![] };
    if rf.is_empty() || ocr_chars == 0 || (matched as f64) < ocr_chars as f64 * MIN_MATCH_RATIO {
        let d = if ocr_chars == 0 {
            "识别侧没有歌词（谱面无词，或歌词行没认出来），未核对".to_string()
        } else if rf.is_empty() {
            "参照里没有汉字歌词，未核对".to_string()
        } else {
            format!("同字 {matched} / 识别 {ocr_chars} 字 / 参照 {} 字，词不对题，未做改动", rf.len())
        };
        items.push(LyricCheckItem::new(CheckKind::NoMatch).detail(d));
        result.items = items;
        return result;
    }

    // 逐对分类：M 同字 · S 异字 · F 空位对上参照字 · E 空位跳过 · X 识别多出的字 · G 参照多出的字
    #[derive(Clone, Copy, PartialEq)]
    enum K {
        M,
        S,
        F,
        E,
        X,
        G,
    }
    let ai = |i: i64| &a[i as usize];
    let kinds: Vec<K> = pairs
        .iter()
        .map(|&(i, j)| {
            if i < 0 {
                K::G
            } else if ai(i).ch.is_none() {
                if j < 0 {
                    K::E
                } else {
                    K::F
                }
            } else if j < 0 {
                K::X
            } else if ai(i).norm == Some(rf[j as usize].norm) {
                K::M
            } else {
                K::S
            }
        })
        .collect();
    let np = pairs.len();
    // 不一致的「段」= 连续的非同字对（空位夹在中间不断段）。段里至多两处、且两头都贴着同字，才逐字处理（改 / 补 / 报）——
    // 左右都对上了，中间这一两个字才可信地一一对应；否则是整句对不上（版本不同、识别大错），整段合成一条报告、不改
    let mut anchored = vec![false; np];
    // 锚定段编号：一段里改了一个字、却还有别的字对不上，说明歌词在这里本身可能写乱了，改动标「待复查」
    let mut run_of = vec![-1i64; np];
    let mut run_n = 0i64;
    let mut seg_items: Vec<LyricCheckItem> = vec![];
    let mut seg_keys: HashSet<String> = HashSet::new();
    let hanzi_of = |t0: usize, t1: usize| pairs[t0..t1].iter().filter(|p| p.0 >= 0).filter_map(|p| ai(p.0).ch).collect::<String>();
    let ref_of = |t0: usize, t1: usize| pairs[t0..t1].iter().filter(|p| p.1 >= 0).map(|p| rf[p.1 as usize].ch).collect::<String>();
    let clip = |x: String| if x.chars().count() > 40 { x.chars().take(40).collect::<String>() + "…" } else { x };
    let mut seen_m = false;
    let mut t = 0;
    while t < np {
        if kinds[t] == K::M || kinds[t] == K::E {
            if kinds[t] == K::M {
                seen_m = true;
            }
            t += 1;
            continue;
        }
        let mut u = t;
        while u < np && kinds[u] != K::M {
            u += 1;
        }
        let mut end = u;
        while end > t && kinds[end - 1] == K::E {
            end -= 1;
        }
        let ks: Vec<K> = kinds[t..end].iter().copied().filter(|&x| x != K::E).collect();
        if ks.len() <= 2 && seen_m && u < np {
            for q in t..end {
                anchored[q] = true;
                run_of[q] = run_n;
            }
            run_n += 1;
            t = u;
            continue;
        }
        if ks.iter().all(|&x| x == K::G) {
            let js: Vec<i64> = pairs[t..end].iter().map(|p| p.1).collect();
            result.unmatched_ref.push(UnmatchedRef { from: js[0] as usize, to: (js[js.len() - 1] + 1) as usize, text: clip(ref_of(t, end)) });
        } else {
            let first = pairs[t..end].iter().find(|p| p.0 >= 0);
            let it = first.map(|p| ai(p.0));
            let first_ref = pairs[t..end].iter().find(|p| p.1 >= 0);
            let ocr = clip(hanzi_of(t, end));
            let rs = clip(ref_of(t, end));
            let mut x = if ks.iter().all(|&q| q == K::X) {
                let mut x = LyricCheckItem::new(CheckKind::ExtraChar);
                x.ocr = Some(ocr.clone());
                x.detail("识别出参照里没有的一段")
            } else {
                let mut x = LyricCheckItem::new(CheckKind::Mismatch);
                x.ocr = Some(ocr.clone());
                x.ref_ = Some(rs.clone());
                x.context = first_ref.map(|p| rf[p.1 as usize].line.clone());
                x.detail("整句对不上（版本不同或识别错得多），未改")
            };
            if let Some(it) = it {
                x.verse = Some(it.verse);
                x = at(it.n, x);
                x.bbox = Some(num(score, it.n).bbox);
            }
            let key = format!("{:?}|{:?}|{:?}|{:?}|{ocr}|{rs}", x.kind, x.row, x.verse, x.note);
            if seg_keys.insert(key) {
                seg_items.push(x);
            }
        }
        t = u;
    }
    items.extend(seg_items);

    // 同一 (音符, 段, 字) 在展开序列里可出现多次（副歌回唱）：各次对到的参照字汇总后再判；有一次落在整句不对的段里就不逐字处理
    let key_of = |it: &Item| format!("{}:{}:{}:{}", it.n.0, it.n.1, it.verse, it.idx);
    struct Hit {
        it: Item,
        refs: Vec<i64>,
        in_seg: bool,
    }
    let mut hits: Vec<(String, Hit)> = vec![];
    let mut hit_at: HashMap<String, usize> = HashMap::new();

    // 形近又常被歌词写错的几组字先按词组定（见 char_by_phrase）；定下来的不再走下面的逐字判定
    let mut phrase_done: HashSet<String> = HashSet::new();
    // 已改 / 已补的字 → 那一条（`items` 里的下标）
    let mut resolved: HashMap<String, usize> = HashMap::new();
    let mut run_keys: Vec<(i64, HashSet<String>, bool)> = vec![];
    let in_run = |run_keys: &mut Vec<(i64, HashSet<String>, bool)>, t: usize, key: Option<String>| {
        let id = run_of[t];
        if id < 0 {
            return;
        }
        let k = match run_keys.iter().position(|r| r.0 == id) {
            Some(k) => k,
            None => {
                run_keys.push((id, HashSet::new(), false));
                run_keys.len() - 1
            }
        };
        match key {
            None => run_keys[k].2 = true,
            Some(key) => {
                run_keys[k].1.insert(key);
            }
        }
    };
    {
        let mut ref_at: HashMap<i64, i64> = HashMap::new();
        for &(i, j) in &pairs {
            if i >= 0 && j >= 0 {
                ref_at.insert(i, j);
            }
        }
        let hz_idx: Vec<usize> = (0..a.len()).filter(|&i| a[i].ch.is_some()).collect();
        for (q, &ai_) in hz_idx.iter().enumerate() {
            let it = a[ai_].clone();
            let ch = it.ch.unwrap();
            if !PHRASE_CHARS.contains(ch) {
                continue;
            }
            let key = key_of(&it);
            if phrase_done.contains(&key) {
                continue;
            }
            let ch_at = |d: i64| usize::try_from(q as i64 + d).ok().and_then(|x| hz_idx.get(x)).and_then(|&x| a[x].ch);
            let text = lyric_of(num(score, it.n), it.verse).unwrap_or("").to_string();
            let mut k = -1i64;
            let mut after = String::new();
            for c in text.chars() {
                if is_hanzi(c) {
                    k += 1;
                } else if k == it.idx {
                    after.push(c);
                }
            }
            let end = after.chars().any(|c| "，。、；：！？…,;:!?".contains(c)) || q == hz_idx.len() - 1;
            let Some(want) = char_by_phrase(ch, ch_at(-2), ch_at(-1), ch_at(1), end) else { continue };
            phrase_done.insert(key.clone());
            let ref_ch = ref_at.get(&(ai_ as i64)).map(|&j| &rf[j as usize]);
            let opt = |c: Option<char>| c.map(String::from).unwrap_or_default();
            let phrase = format!("{}{want}{}", opt(ch_at(-1)), opt(ch_at(1)));
            if want != ch {
                let char_box = rewrite(score, it.n, it.verse, it.idx, &text, &want.to_string());
                let mut x = LyricCheckItem::new(CheckKind::Fixed);
                x.verse = Some(it.verse);
                x = at(it.n, x);
                x.bbox = Some(num(score, it.n).bbox);
                x.ocr = Some(ch.to_string());
                x.ref_ = Some(want.to_string());
                x.context = ref_ch.map(|r| r.line.clone());
                x.char_box = char_box;
                let note = match ref_ch {
                    Some(r) if r.ch != want => format!("（歌词作「{}」）", r.ch),
                    _ => String::new(),
                };
                items.push(x.detail(format!("按词组「{phrase}」定字{note}")));
                resolved.insert(key, items.len() - 1);
            } else if let Some(r) = ref_ch.filter(|r| r.norm != want) {
                let mut x = LyricCheckItem::new(CheckKind::Mismatch);
                x.verse = Some(it.verse);
                x = at(it.n, x);
                x.bbox = Some(num(score, it.n).bbox);
                x.ocr = Some(ch.to_string());
                x.ref_ = Some(r.ch.to_string());
                x.context = Some(r.line.clone());
                items.push(x.detail(format!("按词组「{phrase}」保留「{want}」，歌词这处多是错字")));
                // 已按词组定了，不算「还有别的字对不上」
                resolved.insert(key, items.len() - 1);
            }
        }
    }
    // 参照多出的一两个字（锚定的 G）：挂到前一个识别项上报「谱上没地方落」
    let mut pend_g: Vec<i64> = vec![];
    let mut last_a: i64 = -1;
    let flush_g = |items: &mut Vec<LyricCheckItem>, pend_g: &mut Vec<i64>, last_a: i64, score: &RecognizedScore| {
        if pend_g.is_empty() {
            return;
        }
        let mut x = LyricCheckItem::new(CheckKind::MissingNote);
        if last_a >= 0 {
            let it = ai(last_a);
            x.verse = Some(it.verse);
            x = at(it.n, x);
            x.bbox = Some(num(score, it.n).bbox);
        }
        x.ref_ = Some(pend_g.iter().map(|&j| rf[j as usize].ch).collect());
        x.context = Some(rf[pend_g[0] as usize].line.clone());
        items.push(x.detail("参照在此多出字，谱上没有空着的音可落（漏音、漏字或版本不同）"));
        pend_g.clear();
    };
    // 一字多音却没认出弧按音符报一次：每一段在这个音上都没字才算（有一段有字就不是一字多音）。
    // 只在本页一字多音大多印了弧时报：不少谱子（流行体、小册子）一字多音本就不印弧，那样的页逐个报只是噪声
    let mut slur_seen: HashSet<NoteAt> = HashSet::new();
    let (mut mel_held, mut mel_free) = (0usize, 0usize);
    let any_hz = |n: &JpNum| n.lyrics.iter().any(|t| has_hanzi(t));
    for (ri, r) in score.rows.iter().enumerate() {
        if !r.nums.iter().any(any_hz) {
            continue;
        }
        for (ni, n) in r.nums.iter().enumerate() {
            if ni == 0 || n.digit == 0 || any_hz(n) {
                continue;
            }
            let prev = &r.nums[ni - 1];
            // 同音延续归 tie，不算
            if prev.digit == n.digit && prev.octave == n.octave && !held[ri][ni] {
                continue;
            }
            if held[ri][ni] {
                mel_held += 1;
            } else {
                mel_free += 1;
            }
        }
    }
    let page_slurs = mel_held + mel_free >= 4 && mel_held as f64 >= (mel_held + mel_free) as f64 * SLUR_PAGE_RATIO;
    for (t, &(i, j)) in pairs.iter().enumerate() {
        let kd = kinds[t];
        if kd == K::G {
            if anchored[t] {
                pend_g.push(j);
                in_run(&mut run_keys, t, None);
            }
            continue;
        }
        flush_g(&mut items, &mut pend_g, last_a, score);
        last_a = i;
        let it = ai(i);
        if kd == K::E {
            // 两头都是同字的空位（不在任何不一致段里）：一直没字、不在弧里、不是同音延续
            if !page_slurs || it.held || it.absent || slur_seen.contains(&it.n) {
                continue;
            }
            let (mut l, mut r) = (t as i64 - 1, t + 1);
            while l >= 0 && kinds[l as usize] == K::E {
                l -= 1;
            }
            while r < np && kinds[r] == K::E {
                r += 1;
            }
            if l < 0 || r >= np || kinds[l as usize] != K::M || kinds[r] != K::M {
                continue;
            }
            let nm = num(score, it.n);
            let prev = if it.n.1 > 0 { score.rows[it.n.0].nums.get(it.n.1 - 1) } else { None };
            let Some(prev) = prev else { continue };
            if prev.digit == 0 || (prev.digit == nm.digit && prev.octave == nm.octave) {
                continue;
            }
            if any_hz(nm) {
                continue;
            }
            slur_seen.insert(it.n);
            let mut x = LyricCheckItem::new(CheckKind::SlurSuspect);
            x.verse = Some(it.verse);
            x = at(it.n, x);
            x.bbox = Some(nm.bbox);
            items.push(x.detail("各段在这个音上都没字、也不在弧里：一字多音的弧可能漏认（谱面本就没印弧的可忽略）"));
            continue;
        }
        let key = key_of(it);
        if kd != K::M {
            in_run(&mut run_keys, t, Some(key.clone()));
        }
        let h = match hit_at.get(&key) {
            Some(&k) => k,
            None => {
                hits.push((key.clone(), Hit { it: it.clone(), refs: vec![], in_seg: false }));
                hit_at.insert(key.clone(), hits.len() - 1);
                hits.len() - 1
            }
        };
        if kd != K::M && !anchored[t] {
            hits[h].1.in_seg = true;
        }
        hits[h].1.refs.push(j);
    }
    flush_g(&mut items, &mut pend_g, last_a, score);

    // 逐字判定
    struct FixReq {
        it: Item,
        r: RefToken,
        key: String,
    }
    let mut fix_reqs: Vec<FixReq> = vec![];
    for (key, Hit { it, refs, in_seg }) in &hits {
        if *in_seg || phrase_done.contains(key) {
            continue;
        }
        let aligned: Vec<usize> = refs.iter().filter(|&&j| j >= 0).map(|&j| j as usize).collect();
        let mut ref_chars: Vec<char> = vec![];
        for &j in &aligned {
            if !ref_chars.contains(&rf[j].norm) {
                ref_chars.push(rf[j].norm);
            }
        }
        let base = |kind: CheckKind| {
            let mut x = LyricCheckItem::new(kind);
            x.verse = Some(it.verse);
            x = at(it.n, x);
            x.bbox = Some(num(score, it.n).bbox);
            x
        };
        if let Some(ch) = it.ch {
            if aligned.is_empty() {
                let mut x = base(CheckKind::ExtraChar);
                x.ocr = Some(ch.to_string());
                items.push(x.detail("识别出参照里没有的字"));
                continue;
            }
            // 对上了
            if ref_chars.len() == 1 && Some(ref_chars[0]) == it.norm && aligned.len() == refs.len() {
                continue;
            }
            if ref_chars.len() > 1 || aligned.len() != refs.len() {
                let mut x = base(CheckKind::Mismatch);
                x.ocr = Some(ch.to_string());
                x.ref_ = Some(ref_chars.iter().map(|c| c.to_string()).collect::<Vec<_>>().join("/"));
                x.context = Some(rf[aligned[0]].line.clone());
                items.push(x.detail("唱几遍对到的参照字不一致"));
                continue;
            }
            let r = &rf[aligned[0]];
            if is_variant(it.norm.unwrap(), r.norm) {
                let mut x = base(CheckKind::Variant);
                x.ocr = Some(ch.to_string());
                x.ref_ = Some(r.ch.to_string());
                x.context = Some(r.line.clone());
                items.push(x);
                continue;
            }
            fix_reqs.push(FixReq { it: it.clone(), r: r.clone(), key: key.clone() });
        } else {
            // 空位：参照在这里有字（各次都对到同一个字）→ 补；弧 / 连音线里的空位不补，报出来
            if aligned.is_empty() || ref_chars.len() != 1 || aligned.len() != refs.len() {
                continue;
            }
            let r = &rf[aligned[0]];
            if it.held {
                let mut x = base(CheckKind::MissingNote);
                x.ref_ = Some(r.ch.to_string());
                x.context = Some(r.line.clone());
                items.push(x.detail("参照在此有字，但这个音在弧/连音线里（弧多认了，或漏读了字）"));
                continue;
            }
            let mut x = base(CheckKind::Filled);
            let v = it.verse as usize;
            let lyr = &mut score.rows[it.n.0].nums[it.n.1].lyrics;
            while lyr.len() < v {
                lyr.push(String::new());
            }
            if lyr.len() == v {
                lyr.push(r.ch.to_string());
            } else {
                lyr[v] = r.ch.to_string();
            }
            x.ref_ = Some(r.ch.to_string());
            x.context = Some(r.line.clone());
            items.push(x);
            resolved.insert(key.clone(), items.len() - 1);
        }
    }

    // 本页识别歌词里各代词字形出现几次（选字前统计，不含参照）
    let mut page_count: HashMap<char, usize> = HashMap::new();
    for r in &score.rows {
        for n in &r.nums {
            for t in &n.lyrics {
                for c in t.chars() {
                    if PRONOUN_GROUPS.iter().any(|g| g.contains(c)) {
                        *page_count.entry(c).or_default() += 1;
                    }
                }
            }
        }
    }
    let count = |c: char| page_count.get(&c).copied().unwrap_or(0);
    // 形近字：参照字要在该字的 OCR 候选里才改
    for FixReq { it, r, key } in fix_reqs {
        let ch = it.ch.unwrap();
        let al = alt_of(score, it.n, it.verse, it.idx).map(|a| (a.alts.clone(), a.scores.iter().map(|&s| score_f64(s)).collect::<Vec<f64>>()));
        // 参照字是人称代词（他 / 祂、你 / 祢）时按谱面取字形：候选里有过门槛的「祂 / 祢」，且参照本身就写它、或本页已用过它两次以上，就取它；否则取参照字。
        // 不按「你 / 他」的出现次数比：「你们」「他们」里的你、他会把计数拉高
        let pro = PRONOUN_GROUPS.iter().find(|g| g.contains(r.norm));
        let top = al.as_ref().and_then(|a| a.1.first().copied()).unwrap_or(0.0);
        let ratio_at = |i: i64| match &al {
            Some((_, sc)) if !sc.is_empty() => usize::try_from(i).ok().and_then(|i| sc.get(i)).copied().unwrap_or(0.0) / top.max(1e-9),
            _ => 1.0,
        };
        let mut k: i64 = -1;
        if let Some((alts, sc)) = &al {
            let idx_of = |c: char| alts.iter().position(|x| norm_str(x) == c.to_string()).map_or(-1, |i| i as i64);
            if let Some(pro) = pro {
                let special = pro.chars().find(|&c| PRONOUN_SPECIAL.contains(c)).unwrap();
                let (ks, kr) = (idx_of(special), idx_of(r.norm));
                let ok_at = |i: i64| i >= 0 && ratio_at(i) >= ALT_SCORE_RATIO;
                let misread = special_misreads(special).contains(ch);
                k = if ks >= 0 && misread {
                    ks
                } else if ok_at(ks) && (r.norm == special || count(special) >= 2) {
                    ks
                } else if ok_at(kr) {
                    kr
                } else {
                    let mut cands: Vec<i64> = pro.chars().map(idx_of).filter(|&i| ok_at(i)).collect();
                    let sc_at = |i: i64| sc.get(i as usize).copied().unwrap_or(0.0);
                    cands.sort_by(|&x, &y| js::ordering(sc_at(y) - sc_at(x)));
                    cands.first().copied().unwrap_or(-1)
                };
            } else {
                k = idx_of(r.norm);
            }
        }
        let alt_k = |al: &(Vec<String>, Vec<f64>)| al.0[k as usize].clone();
        // 形近误读定下来的「祂 / 祢」不看得分比（「池」读得再有把握，图上也不会是「他」）
        let by_misread = pro.is_some()
            && k >= 0
            && al.as_ref().is_some_and(|al| {
                let nk = norm_str(&alt_k(al));
                let mut cs = nk.chars();
                match (cs.next(), cs.next()) {
                    (Some(c), None) => PRONOUN_SPECIAL.contains(c) && special_misreads(c).contains(ch),
                    _ => false,
                }
            });
        let ratio = if k >= 0 {
            if by_misread {
                1.0
            } else {
                ratio_at(k)
            }
        } else {
            1.0
        };
        let it_norm = it.norm.unwrap();
        // 参照多半是歌词文本的错字、不照改的几种：「巳」歌词里几乎用不到，是「已」的错字；「己」→「已」是把「舍己」「自己」写错；
        // 识别出的是本页常用的代词字形（整页的「祢」），参照换成别的字；「入」→「人」同理（歌词库把「入」写成「人」极常见）
        let own_pronoun = PRONOUN_GROUPS.iter().any(|g| g.contains(it_norm)) && count(ch) >= 3 && pro.is_none();
        let ref_typo = r.norm == '巳' || (it_norm == '己' && r.norm == '已') || (it_norm == '入' && r.norm == '人') || own_pronoun;
        let ok = al.is_some() && k >= 0 && !ref_typo && ratio >= ALT_SCORE_RATIO;
        let char_box = region_of(score, it.n, it.verse, it.idx).map(|g| region_box(score, &g));
        let cand = match &al {
            Some((_, sc)) if k >= 0 => Some(Cand { rank: k as usize, score: sc.get(k as usize).copied().unwrap_or(0.0), top }),
            _ => None,
        };
        let mut x = LyricCheckItem::new(if ok { CheckKind::Fixed } else { CheckKind::Mismatch });
        x.verse = Some(it.verse);
        x = at(it.n, x);
        x.bbox = Some(num(score, it.n).bbox);
        x.ocr = Some(ch.to_string());
        x.context = Some(r.line.clone());
        if !ok {
            x.ref_ = Some(r.ch.to_string());
            x.char_box = char_box;
            x.cand = cand;
            let d = match &al {
                None => "取不到识别候选（字来自谱后附段等）".to_string(),
                Some((alts, _)) if k < 0 => format!("参照字不在识别候选里（字形不像；候选 {}）", alts.iter().take(5).cloned().collect::<String>()),
                Some(_) if ref_typo => {
                    if own_pronoun {
                        format!("谱面通篇用「{ch}」，参照这处多是错字，不照改")
                    } else {
                        "参照这个字多是歌词文本的错字（巳/已/己、人/入），不照改".to_string()
                    }
                }
                Some((_, sc)) => format!("参照字在候选第 {} 位但得分太低（{} / 首选 {}）", k + 1, js::to_fixed(sc.get(k as usize).copied().unwrap_or(0.0), 4), js::to_fixed(top, 3)),
            };
            items.push(x.detail(d));
            continue;
        }
        // 用候选里那个字形（谱面是繁体就留繁体、印的是祂就取祂），候选与参照同形时就是参照字
        let al = al.unwrap();
        let new = alt_k(&al);
        let text = lyric_of(num(score, it.n), it.verse).unwrap_or("").to_string();
        let region_box_ = if !text.is_empty() {
            rewrite(score, it.n, it.verse, it.idx, &text, &new)
        } else {
            let region = region_of(score, it.n, it.verse, it.idx);
            if let Some(Region::At(i)) = region {
                let t = replace_hanzi(&score.lyric_regions[i].text, 0, &new);
                score.lyric_regions[i].text = t;
            }
            region.map(|g| region_box(score, &g))
        };
        x.ref_ = Some(new.clone());
        x.char_box = region_box_;
        x.cand = cand;
        let sk = al.1.get(k as usize).copied().unwrap_or(0.0);
        let mut d = format!("候选第 {} 位（得分 {}，首选 {}）", k + 1, js::to_fixed(sk, 3), js::to_fixed(top, 3));
        if norm_str(&new) != r.norm.to_string() {
            d += &format!("；歌词作「{}」，按谱面取「{new}」", r.ch);
        }
        items.push(x.detail(d));
        resolved.insert(key, items.len() - 1);
    }

    // 待复查：改动所在的锚定段里还有没解释掉的不一致（参照多出的字、改不了的异字、识别多出的字）
    for (_, keys, has_g) in &run_keys {
        let open = *has_g || keys.iter().any(|k| !resolved.contains_key(k));
        if !open {
            continue;
        }
        for k in keys {
            if let Some(&xi) = resolved.get(k) {
                let x = &mut items[xi];
                if x.kind == CheckKind::Fixed || x.kind == CheckKind::Filled {
                    x.review = Some("同一处还有别的字对不上，歌词这里可能写乱了".into());
                }
            }
        }
    }

    let order2 = |x: &LyricCheckItem| (x.row.map_or(-1, |r| r as i64), x.verse.unwrap_or(-1), x.note.map_or(-1, |n| n as i64));
    items.sort_by_key(order2);
    result.items = items;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ref_lyrics_parse() {
        let t = "\u{feff}作词：某人\n1. 我主(副歌)耶稣\n【副歌】\n副歌：哈利路亚\n2 我们\n";
        let toks: String = parse_ref_lyrics(t).iter().map(|t| t.ch).collect();
        assert_eq!(toks, "我主耶稣哈利路亚我们");
        let lrc = "[00:02]乙\n[00:01][00:03]甲\n";
        let toks: String = parse_ref_lyrics(lrc).iter().map(|t| t.ch).collect();
        assert_eq!(toks, "甲乙甲");
    }

    #[test]
    fn phrase() {
        assert_eq!(char_by_phrase('已', Some('舍'), Some('自'), None, false), Some('己'));
        assert_eq!(char_by_phrase('人', None, Some('进'), None, false), Some('入'));
        assert_eq!(char_by_phrase('做', None, None, Some('醒'), false), Some('儆'));
    }
}
