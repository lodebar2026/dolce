//! 乐句分析（TS `score/phrase.ts` 照搬）：综合歌词标点 + 音乐信号（延长号/终止线/长音/休止/连线）与「重复旋律」结构，
//! 在小节边界上找乐句断点，并凑成不太稀疏也不太密的行长。
//!
//! 产物 `measure_breaks`（作为「新行起点」的小节下标，与 `Measure.newSystem` 同义）与 `mid_breaks`
//! （弱起谱里乐句尾——休止/长音——被并进下一小节时，改在该「行内」和弦后换行）。
//! 引用和弦一律用**拍平下标**（[`PhrasePart::flat_chords`] 的次序），TS 侧按同样次序认回对象。
//!
//! 判据、常数、算式次序都照 TS 逐字搬（零差异对拍是验收标准），注释里的曲目是病例、不是定阈值的依据。
//! TS 里只在浏览器调试时才开的 `window.__qDebug` / `__phraseDebug` / `__hillDebug` / `__tryPlan` / `__cutsDebug`
//! 钩子不搬（只读、不影响结果）。
// `!(x > 0)` 是有意的（照 TS：NaN 也走否定分支）；下标循环照 TS 的写法便于逐行对照。
#![allow(clippy::neg_cmp_op_on_partial_ord, clippy::needless_range_loop)]

use crate::play::phraseinput::{PhraseChord, PhrasePart};
use crate::base::{js, Fraction};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const INF: f64 = f64::INFINITY;

// ───────────────────────── JS 数值口径的小工具 ─────────────────────────

/// `Math.max(a, b)`：有 NaN 就是 NaN（Rust 的 `f64::max` 会忽略 NaN）。
fn jmax(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if b > a {
        b
    } else {
        a
    }
}

/// `Math.min(a, b)`
fn jmin(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if b < a {
        b
    } else {
        a
    }
}

/// `Math.max(...xs)`（空为 -Infinity）
fn max_all(xs: impl IntoIterator<Item = f64>) -> f64 {
    xs.into_iter().fold(-INF, jmax)
}

/// `Math.min(...xs)`（空为 Infinity）
fn min_all(xs: impl IntoIterator<Item = f64>) -> f64 {
    xs.into_iter().fold(INF, jmin)
}

/// 数的 `a || b`：a 为 0 或 NaN 时取 b。
fn jor(a: f64, b: f64) -> f64 {
    if a != 0.0 && !a.is_nan() {
        a
    } else {
        b
    }
}

/// 按插入次序的 `Set<number>`（删除后再加会排到末尾，同 JS）。
#[derive(Default, Clone)]
struct OSet(Vec<usize>);

impl OSet {
    fn add(&mut self, v: usize) {
        if !self.0.contains(&v) {
            self.0.push(v);
        }
    }
    fn delete(&mut self, v: usize) {
        self.0.retain(|&x| x != v);
    }
}

/// 按插入次序的 `Map<number, V>`（`set` 已有的键原地改值，同 JS）。
struct OMap<K, V>(Vec<(K, V)>);

impl<K: PartialEq + Copy, V: Copy> OMap<K, V> {
    fn new() -> Self {
        OMap(Vec::new())
    }
    fn get(&self, k: K) -> Option<V> {
        self.0.iter().find(|e| e.0 == k).map(|e| e.1)
    }
    fn set(&mut self, k: K, v: V) {
        if let Some(e) = self.0.iter_mut().find(|e| e.0 == k) {
            e.1 = v;
        } else {
            self.0.push((k, v));
        }
    }
}

// ───────────────────────── 对外类型 ─────────────────────────

/// 一个和弦的自然横向区间。`x1b`：后面紧跟小节线时含这条线的右缘——引擎折行量到行末小节线，
/// **只在与版心宽比「放不放得下」时用它**（`fitSpan`），行长匀度、行宽比、过短判据照旧量到音为止（`x1`）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct Span {
    pub x0: f64,
    pub x1: f64,
    #[serde(default)]
    pub x1b: Option<f64>,
}

/// **「一行放不放得下」的真实判据**（`pdflayout/browser.ts::measureChordSpans` 量出来的）。
///
/// 用户口径：**「不要算格数，真实坐标排一遍，放不下再补刀」**。格数是近似——同样 30 格，歌词字多的行、
/// 带八度点与附点的行都更宽；照它判，排版器会在断点之外**又折一刀**，而 `rebuild.mjs` 的容量收敛循环
/// 随后把容量越收越小（064《啊！圣善夜》本来 7 行的方案被一路收成 9 行 13 格）。
/// `spans` 与排版器折行用的是同一把尺子，且**与断点无关**，所以整首量一次，补刀/合并反复试都能用。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct FitMetric {
    /// 版心宽度。
    pub width: f64,
    /// 按拍平下标：每个和弦的自然横向区间（量不到为 None）。
    #[serde(default)]
    pub spans: Vec<Option<Span>>,
}

impl FitMetric {
    /// TS `spans.get(flat[i]?.chord)`：越界（`undefined` 作键）或没量到都是 None。
    pub(crate) fn span(&self, i: i64) -> Option<Span> {
        if i < 0 {
            return None;
        }
        self.spans.get(i as usize).copied().flatten()
    }
}

/// 一个**可落刀的乐句子句断点**（`PhraseBreaks.cuts` 的元素）。断句本身选哪些断点由 DP 做完了，
/// 这张表是给**补刀层**看的：「一行排不下、非得在它内部再切一刀」时，哪些位置有乐句凭据、各值多少分。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CutCandidate {
    /// 在该和弦（拍平下标）**之后**断行。
    pub chord: usize,
    pub mi: usize,
    /// 收在小节线上（写 `measure_breaks`）；否则是行内断点（写 `mid_breaks`）。
    pub is_last: bool,
    /// 断点强度 − 行首罚（`scoreAt` − `headPenalty`），**可以是负的**。
    pub score: f64,
    /// 在这里断，下一行的开头与前面某一行的开头是同一段旋律吗——是的话公共前缀有多长（比到 12 个音封顶）。0 = 不是。
    /// 原书的分行大量是「平行乐句各自成行、对齐着排」，而强度分里平行只值 2 分（144《求圣灵吹我》、168《爱喜乐生命》）。
    pub parallel: f64,
    /// 这里是不是**句末**（`isSentenceEnd` 的口径，不受「短分句减半」影响）。强度分分不出句号与逗号
    /// （168「忧愁不再。」的句号被折成 3，输给了「心底，」的 10 分），补刀那一层要的正是「落在句号上」。
    pub end: bool,
}

/// 断句结果。各集合按插入次序（同 TS 的 `Set`）；`capacityCuts` 由补刀层写，这里不产（TS 胶水建空 Set）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct PhraseBreaks {
    /// 小节边界换行：在该下标小节前起新行
    pub measure_breaks: Vec<usize>,
    /// 行内换行：在该和弦（拍平下标；乐句尾休止/长音）之后换行，不加小节线
    pub mid_breaks: Vec<usize>,
    /// 段落（Intro/Verse/Chorus/Coda…）起点的小节下标：这些小节前不但换行，还**另起一页**。`measure_breaks` 是其超集。
    pub section_starts: Vec<usize>,
    /// 段界落在小节内部（弧闭合处）时的断点和弦：在该和弦后换行**并另起一页**。`mid_breaks` 是其超集。
    pub section_cut_chords: Vec<usize>,
    /// 是否已为「副歌起点」安排了段界（含弱起顺延）。
    pub refrain_cut: bool,
    /// **全部候选断点**（按位置升序，含落在小节中间的那些），给容量补刀用（`applybreaks.ts::pickCuts`）。
    pub cuts: Vec<CutCandidate>,
    /// **不许删的断点**（小节下标）：跳转记号（Fine / D.C. / D.S. / To Coda）所在的小节末、转调与前奏之后。
    pub forced: Vec<usize>,
    /// **容量补刀落下的断点**（`applybreaks::apply_capacity_cuts` 写，两种键按插入次序混排，同 TS 的 `Set<number | PhraseChord>`）：
    /// 小节前（`measure`）或和弦后（`chord`）。断句本身不产，`describe_lines` 据此给 `LineInfo.from_cut` 打记号。
    #[serde(default)]
    pub capacity_cuts: Vec<CapKey>,
}

/// `PhraseBreaks.capacity_cuts` 的键：小节下标（在它之前起新行）或和弦拍平下标（在它之后起新行）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CapKey {
    Measure(usize),
    Chord(usize),
}

/// 行长参数（TS `PhraseOptions`）。默认值是拿具体曲子调出来的，**别随手改默认**；成书排版按需收紧。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase", default)]
pub struct PhraseOptions {
    pub target_meas: Option<f64>,
    pub min_meas: Option<f64>,
    pub max_meas: Option<f64>,
    pub max_sentence_meas: Option<f64>,
    /// 一行最多几格。**成书排版按纸张宽度算**（版心宽 ÷ 音符步距）。
    pub max_cells: Option<f64>,
    pub max_sentence_cells: Option<f64>,
    /// 断点强度的权重。调大 = 更看重「断在乐句真正收尾的地方」。
    pub break_weight: Option<f64>,
    /// 「很短的分句」的字数上限：从上一个标点起唱了这么几个字以内，句末标点的分**减半**（默认 0 = 关；成书传 5）。
    pub short_sentence_words: Option<f64>,
    /// 重复段边界是否**按重复长度加分**（默认 false = 一律 +8；成书打开，015《赞美真神》）。
    pub repeat_len_bonus: Option<bool>,
    /// `maxCells` 的单位是不是**排版器数出来的「个数」**（音符与增时线各算一个；成书那条路，378《主耶稣我爱祢》）。
    pub cells_are_items: Option<bool>,
    /// 「别把一句话的最后一小截甩到下一行开头」的权重（0 = 关；成书打开，419《人生崎岖路》）。
    pub tail_weight: Option<f64>,
    /// **摊匀行长**的权重（0 = 关）。开着时出几种方案再评分选优（成书打开）。
    pub even_weight: Option<f64>,
    /// 多排一行的代价（`evenWeight > 0` 时的方案评分用）。默认 20。
    pub row_cost: Option<f64>,
    /// **「放得下」当平局裁判的容差**（070《天使歌唱》的 0.85 分之差）。默认 0 = 关。
    pub fit_slack: Option<f64>,
    /// **行数多的方案优先**：与最优方案差在这个数以内就选行数最多的那套（0 = 关）。
    pub more_rows_slack: Option<f64>,
    /// **平行乐句开头**在断点强度里值多少分（默认 8：平行句更优先于标点）。
    pub parallel_score: Option<f64>,
    /// **真实坐标**；给了就按真实宽度判放不放得下，没给退回按格数估。
    pub fit: Option<FitMetric>,
    /// 「末两行别一长一短」的权重（125《主名至宝》、404）。默认 1；0 = 关。
    pub last_pair_weight: Option<f64>,
    /// **断句只看内容**（成书那条路开着）：与纸张有关的分都不算，版心宽度只剩「超容量是硬约束」。
    pub content_only: Option<bool>,
    /// 跳转记号（Fine / D.C. / D.S. / To Coda）所在的小节下标：这些地方**要高优先级断开**（096）。
    pub jump_measures: Option<Vec<usize>>,
    /// **平行乐句开头**的加分（0 = 关；成书传 6）。
    pub parallel_weight: Option<f64>,
    /// **行末收在长音上**的加分（0 = 关；成书传 4，061《坚固保障》）。
    pub tail_long_weight: Option<f64>,
    /// 行长代价的权重（默认 1；成书由容量折算目标时调小）。
    pub len_weight: Option<f64>,
    /// **一页排几行**（0 = 不管分页；编辑器/PPT 传 4）：第一遍 DP 之后补一道「把末页排满」（001《圣哉，圣哉，圣哉》）。
    pub page_lines: Option<f64>,
}

// ───────────────────────── 标点与指纹 ─────────────────────────

/// 句末标点（分号并列的是两个完整分句，与句号同级）：TS `PUNCT_END = /[。！？…；]$/`
fn is_punct_end(c: char) -> bool {
    matches!(c, '。' | '！' | '？' | '…' | '；')
}

/// 句中标点：TS `PUNCT_MID = /[，、：]$/`
fn is_punct_mid(c: char) -> bool {
    matches!(c, '，' | '、' | '：')
}

/// 收尾的引号/括号（TS `TRAIL_QUOTE`）。判标点前要先剥掉它们——「再相亲，”」是个收了尾的分句（068《天使报信》）。
fn is_trail_quote(c: char) -> bool {
    matches!(c, '”' | '’' | '＂' | '"' | '』' | '」' | '）' | ')' | '〉' | '》' | '〕' | '】')
}

fn last_char_after_quotes(text: &str) -> Option<char> {
    text.trim_end_matches(is_trail_quote).chars().last()
}

/// 一个和弦上的「主歌词」（第 1 段或副歌那一条）。断句判据与逐行报告共用同一份取法。
pub fn main_lyric_text(c: &PhraseChord) -> &str {
    let Some(nt) = c.notes.first() else { return "" };
    nt.lyrics
        .iter()
        .find(|x| x.number == 1.0 || x.refrain)
        .or(nt.lyrics.first())
        .map(|l| l.text.as_str())
        .unwrap_or("")
}

/// 一行开头拿几个音做「平行乐句」的指纹。
pub const HEAD_FP_LEN: usize = 8;

/// 一个和弦的旋律键（音级+八度，休止记 R）。与 `measureFp` 同一套写法。
pub fn note_key_of(c: &PhraseChord) -> String {
    match c.notes.first() {
        Some(nt) if !c.rest => format!("{}:{}", nt.number, js::num_to_string(nt.jp_octave)),
        _ => "R".to_string(),
    }
}

/// 一行开头的旋律指纹（前 `HEAD_FP_LEN` 个音）。**两行的指纹相同 = 平行乐句开头**（070、077、175）。
/// **跳过行首的休止**：那是弱起的留白（363《倾听我的心》第 1 行 `0_ 5,_`、第 3 行 `5,_`）。不足 8 个音返回空串。
pub fn head_fp_of(chords: &[&PhraseChord]) -> String {
    let mut i = 0;
    while i < chords.len() && chords[i].rest {
        i += 1;
    }
    let notes = &chords[i..(i + HEAD_FP_LEN).min(chords.len())];
    if notes.len() < HEAD_FP_LEN {
        return String::new();
    }
    notes.iter().map(|c| note_key_of(c)).collect::<Vec<_>>().join(",")
}

/// 歌词末尾标点的分量：句末 6 / 句中 4 / 无 0。
pub fn punct_score(text: &str) -> f64 {
    match last_char_after_quotes(text) {
        Some(c) if is_punct_end(c) => 6.0,
        Some(c) if is_punct_mid(c) => 4.0,
        _ => 0.0,
    }
}

/// 一个和弦上**各段歌词**的标点分，取**中位数**（只算这个音符上真有词的段）。
///
/// 最大值会把「五段里只有一段点了句号」判成落点；均值又稀释得太狠（077 从 7 行塌成 5 行）。
/// 中位数：**多数段认同才算数，而认同了就给足分**。分母只数有词的段（一字多音时别的段在这里是空的）。
pub fn lyric_punct_score(c: &PhraseChord) -> f64 {
    let mut ps: Vec<f64> = Vec::new();
    for nt in &c.notes {
        for l in &nt.lyrics {
            if !l.text.is_empty() {
                ps.push(punct_score(&l.text));
            }
        }
    }
    if ps.is_empty() {
        return 0.0;
    }
    js::sort_num(&mut ps);
    ps[ps.len() / 2]
}

/// 一个和弦是不是**句末**（口径同 `lyric_punct_score`：多数段在这里收句才算）。
pub fn lyric_is_sentence_end(c: &PhraseChord) -> bool {
    let mut end = 0;
    let mut n = 0;
    for nt in &c.notes {
        for l in &nt.lyrics {
            if l.text.is_empty() {
                continue;
            }
            if is_sentence_end(&l.text) {
                end += 1;
            }
            n += 1;
        }
    }
    n > 0 && end * 2 > n
}

/// 这个字是不是**句末**（句号/问号/叹号/省略号/分号）。分量会被「很短的分句减半」打对折，
/// 拿 `== 6` 判句末会漏掉（077「难当；」）。**要句末就问这个，别拿分数去比。**
pub fn is_sentence_end(text: &str) -> bool {
    matches!(last_char_after_quotes(text), Some(c) if is_punct_end(c))
}

// 行长以「小节数」计（简谱/圣诗按小节成行）。经验初值，可回归调参。
const DEF_MIN_MEAS: f64 = 3.0;
const DEF_TARGET_MEAS: f64 = 4.0;
const DEF_MAX_MEAS: f64 = 7.0;
// 每行格数上限（流行敬拜谱副歌密集，光按小节数会超出页宽）。格 = 简谱横向占位，增时线按实测比例折算。
const DEF_MAX_CELLS: f64 = 25.0;
// **一整句独占一行**时行长上限放宽（「我們成為一家人」副歌 8 小节 32.5 格）。
const DEF_MAX_SENTENCE_CELLS: f64 = 33.0;
const DEF_MAX_SENTENCE_MEAS: f64 = 8.0;
// 行长下限也认格数：`MIN_MEAS` 与 `MIN_CELLS` 满足其一即可。
const DEF_MIN_CELLS: f64 = 14.0;
// 「乐句收尾」的音乐凭据：够长的长音（≥3 拍）。「耶稣普治」句中逗号落在 4 拍、「我們成為一家人」句中只有 2 拍。
const LONG_NOTE_BEATS: f64 = 3.0;
// 「前奏/间奏」至少这么多个连续的**无词小节**，其后的交界才算乐句起点（按小节而不是按音符）。
const INTRO_MIN_MEAS: usize = 2;
const DASH_W: f64 = 0.7;

fn cells_of(c: &PhraseChord) -> f64 {
    1.0 + jmax(0.0, c.beats.floor() - 1.0) * DASH_W
}

/// `Math.max(1, Math.floor(c.beats) || 1)`
fn cells_int_of(c: &PhraseChord) -> f64 {
    jmax(1.0, jor(c.beats.floor(), 1.0))
}

fn dur_of(c: &PhraseChord) -> f64 {
    c.duration.map(|d| d.to_float()).unwrap_or(0.0)
}

/// 小节旋律指纹：各和弦「音级+八度」（休止记 R），供重复段检测复用。
fn measure_fp(chords: &[&PhraseChord]) -> String {
    chords.iter().map(|c| note_key_of(c)).collect::<Vec<_>>().join(",")
}

/// 一行放得下 `cells` 格时，行长目标该定几小节（「一小节几格」按本曲实测：005 每小节 3.2 格、001 每小节 4 格）。
/// 目标直接按容量定，DP 一次就能挑中最强的断点（377《我宁愿有耶稣》）。
pub fn target_meas_for_cells(part: &PhrasePart, cells: f64) -> f64 {
    let mut tot = 0.0;
    let mut nm = 0.0;
    for m in &part.measures {
        nm += 1.0;
        for c in &m.chords {
            tot += cells_of(c);
        }
    }
    if nm == 0.0 || !(cells > 0.0) {
        return DEF_TARGET_MEAS;
    }
    jmax(3.0, jmin(12.0, js::round(cells / jmax(0.5, tot / nm))))
}

// ───────────────────────── 断句 ─────────────────────────

#[derive(Clone, Copy)]
struct CInfo<'a> {
    chord: &'a PhraseChord,
    mi: usize,
    is_last: bool,
    /// TS `chord === chordsPer[mi][0]`
    is_first: bool,
    pos: f64,
}

struct EndingGroup {
    start_mi: usize,
    end_mi: usize,
    dur: f64,
    cells: f64,
    cells_int: f64,
}

#[derive(Clone, Copy)]
enum CutKey {
    Dur,
    Cells,
    CellsInt,
}

/// 往候选行数表里加一档（去重、不收 < 1 的）。
type AddOption = dyn Fn(&mut Vec<Vec<f64>>, Vec<f64>);

/// 一套方案（TS `{ score, nb, rows }`）。
#[derive(Clone)]
struct Plan {
    score: f64,
    nb: Vec<i64>,
    rows: f64,
}

/// 方案评分里的一行（见 `quality`）。
struct Row {
    keys: Vec<String>,
    dur: f64,
    tonic: bool,
    fits: bool,
    par: f64,
}

/// 平行乐句：比到第几个音为止。
const PARALLEL_MAX: usize = 16;
/// 至少这么多个音一样才算平行。
const PARALLEL_MIN: f64 = 4.0;
/// **够当「乐句在此收尾」的凭据**要重合这么多个音（169《全新的你》的 `m14·` 只重合 7 个音、不够）。
const PARALLEL_STRONG: f64 = 8.0;
const BASE_BREAK: f64 = 8.0;
/// contentOnly 下把断点强度归一化到 `[0, BASE_BREAK]` 的分母（要盖得住最强的断点，实测 24 分上下）。
const CONTENT_BASE_BREAK: f64 = 24.0;
const CROSSED_END_PUNCT_COST: f64 = 4.0;
const SPLIT_SHORT_SENTENCE_COST: f64 = 24.0;
/// 后面剩不下这么多格的不强制断（018、497 的 Fine 临近曲末）。
const FORCED_CUT_TAIL_CELLS: f64 = 8.0;
/// 最长的一行超过版心这么多倍 = 断句层撂挑子了。
const ABDICATE_RATIO: f64 = 1.5;
/// 方案评分里「断点弱度」相对「行长匀度」的权重（contentOnly）。
const BREAK_QUALITY_WEIGHT: f64 = 8.0;
/// 末两行「短的 ÷ 长的」低于此就开始罚（与 line-check 的 D8 同一个 0.6）。
const LAST_PAIR_QUALITY_RATIO: f64 = 0.6;
const LAST_PAIR_QUALITY_WEIGHT: f64 = 60.0;
/// 最短的那一行（末行除外）不到中位数的这个比例就开始罚。
const SHORT_OUTLIER_RATIO: f64 = 0.6;
const OUTLIER_WEIGHT: f64 = 60.0;
/// 逐点爬山：最多爬几轮、爬前几套方案。
const HILL_ROUNDS: usize = 2;
const HILL_PLANS: usize = 8;
/// 爬山至少要赚这么多分才认（355、020 只赚了不到 1 分就被挪坏；171 是 16.7 → 2.0）。
const HILL_MIN_GAIN: f64 = 10.0;
/// 段内最短行 ÷ 最长行的下限，爬山的硬闸（与 line-check 的 D8 同一个 0.5）。
const D8_RATIO: f64 = 0.5;
/// **行末收在主音上**的加分（次要；061《坚固保障》）。
const TAIL_TONIC_WEIGHT: f64 = 2.0;
/// 候选方案那几遍 DP 的行长权重（不是评分，只是「让 DP 真能排出指定的行数」；374《跟随救主》、070《天使歌唱》）。
const RUN_WITH_LEN_WEIGHT: f64 = 2.0;

/// 断句一次运行的全部中间量（TS 里是 `computePhraseBreaks` 的局部变量与闭包）。
struct Ctx<'a> {
    // 选项
    target_meas: f64,
    min_meas: f64,
    max_meas: f64,
    max_sentence_meas: f64,
    max_cells: f64,
    max_sentence_cells: f64,
    len_weight: f64,
    repeat_len_bonus: bool,
    break_weight: f64,
    last_pair_weight: f64,
    even_weight: f64,
    tail_weight: f64,
    cells_are_items: bool,
    content_only: bool,
    jump_meas: Vec<usize>,
    parallel_weight: f64,
    tail_long_weight: f64,
    row_cost: f64,
    parallel_score: f64,
    fit: Option<&'a FitMetric>,
    min_cells: f64,

    measures: &'a [crate::play::phraseinput::PhraseMeasure],
    n: usize,
    k: usize,
    chords_per: Vec<Vec<&'a PhraseChord>>,
    lyr_per: Vec<String>,
    flat: Vec<CInfo<'a>>,
    ok_end: Vec<i64>,
    ok_start: Vec<i64>,
    tie_from: Vec<i64>,
    depth_after: Vec<i64>,
    punct_after: Vec<f64>,
    end_after: Vec<bool>,
    carried_from: Vec<i64>,
    carried_away: Vec<bool>,
    repeat_break_idx: HashMap<usize, f64>,
    in_ending: Vec<bool>,
    ending_last: Vec<bool>,
    ending_groups: Vec<EndingGroup>,
    pickup_std: f64,
    opening_rest: f64,
    parallel_len: Vec<f64>,

    // 候选与 DP
    cand: Vec<usize>,
    m: usize,
    ends: Vec<f64>,
    idx_at: Vec<i64>,
    cells_upto: Vec<f64>,
    cells_int_upto: Vec<f64>,
    dur_upto: Vec<f64>,
    end_punct_upto: Vec<f64>,
    cuts: Vec<usize>,
}

impl<'a> Ctx<'a> {
    /// 重复边界之后若紧跟一个**长音 tie/slur 组**（`…3 5 |(5--- |5) 0…`），那是上一乐句的延音收尾 → 顺延到该弧闭合之后。
    fn advance_past_long_tie(&self, from: usize) -> usize {
        let k = self.k;
        let mut idx = from;
        while idx + 1 < k && self.ok_start[idx + 1] > 0 && self.flat[idx + 1].chord.beats >= 2.0 {
            let mut j = idx + 1;
            while j < k && self.depth_after[j] != 0 {
                j += 1;
            }
            if j >= k || j == idx {
                break;
            }
            idx = j;
        }
        idx
    }

    /// 重复段的起句常是**弱起**（009《荣耀归与至高神》的「天上众军」）：往前找最多两个短音，那里若有句读标点就把边界移过去。
    fn retreat_to_punct(&self, from: usize) -> usize {
        let mut j = from as i64 - 1;
        while j >= 0 && from as i64 - j <= 2 {
            let ju = j as usize;
            if self.depth_after[ju] != 0 {
                break;
            }
            if self.punct_after[ju] > 0.0 {
                return ju;
            }
            if self.flat[ju].chord.beats > 1.0 {
                break;
            }
            j -= 1;
        }
        from
    }

    /// 一行（flat 下标区间 `[i0, i1]`）里要减掉的「后几房」的量（158《一件礼物》末行含两个房）。
    fn ending_cut(&self, i0: i64, i1: i64, key: CutKey) -> f64 {
        if self.ending_groups.is_empty() || i0 > i1 {
            return 0.0;
        }
        let a = self.flat[i0 as usize].mi;
        let b = self.flat[i1 as usize].mi;
        let mut v = 0.0;
        for g in &self.ending_groups {
            if a <= g.start_mi && b >= g.end_mi {
                v += match key {
                    CutKey::Dur => g.dur,
                    CutKey::Cells => g.cells,
                    CutKey::CellsInt => g.cells_int,
                };
            }
        }
        v
    }

    /// 断点之后那一行是不是「照本曲的起唱样式」起头（144《求圣灵吹我》六句全从小节头上的短休止起唱）。
    fn starts_like_song(&self, idx: usize) -> bool {
        if !(self.opening_rest > 0.0) {
            return false;
        }
        let Some(nx) = self.flat.get(idx + 1) else { return false };
        if !nx.chord.rest || !nx.is_first {
            return false;
        }
        (dur_of(nx.chord) - self.opening_rest).abs() < 0.01
    }

    /// 在 idx 之后换行的话，下一行的**行首残小节**有多长（时值）。
    fn head_dur_after(&self, idx: usize) -> f64 {
        let Some(nx) = self.flat.get(idx + 1) else { return 0.0 };
        let mut head = 0.0;
        let mut j = idx + 1;
        while j < self.k && self.flat[j].mi == nx.mi {
            head += dur_of(self.flat[j].chord);
            if self.flat[j].is_last {
                break;
            }
            j += 1;
        }
        head
    }

    /// 往前最近一个有词的和弦（含 idx 本身）；没有为 -1。
    fn prev_word(&self, idx: usize) -> i64 {
        let mut j = idx as i64;
        while j >= 0 && main_lyric_text(self.flat[j as usize].chord).is_empty() {
            j -= 1;
        }
        j
    }

    /// **断点之后那一行的行首长什么样**——不好看就罚（罚而不是禁）：
    ///   (a) 行首残小节里一个音符都没有（020）；(b) 行首残小节与本曲的弱起不一样长（372/402）；
    ///   (c) 行首是「带句读标点的长音」（373《跟随我》）；以及 (b2)(b3)(d)(e)(g)，见各条。
    fn head_penalty(&self, idx: usize) -> f64 {
        let k = self.k;
        let Some(nx) = self.flat.get(idx + 1).copied() else { return 0.0 };
        let head = self.head_dur_after(idx);
        let mut has_note = false;
        let mut j = idx + 1;
        while j < k && self.flat[j].mi == nx.mi {
            if !self.flat[j].chord.rest {
                has_note = true;
            }
            if self.flat[j].is_last {
                break;
            }
            j += 1;
        }
        let partial = !nx.is_first;
        let mut s = 0.0;
        if !has_note && partial {
            s += 12.0;
        }
        // (b) 行首是**半拍及以下的休止**：与本曲的弱起一样长就不罚。凑成整拍的也不罚（403，只在成书那条路）。
        let head_rest = if nx.chord.rest { dur_of(nx.chord) } else { 0.0 };
        let song_open = self.starts_like_song(idx);
        let head_whole = self.content_only && head_rest > 0.0 && head_rest <= 0.5 && (head - js::round(head)).abs() < 0.01;
        if head_rest > 0.0 && head_rest <= 0.5 && (head - self.pickup_std).abs() > 0.01 && !song_open && !head_whole {
            s += 8.0;
        }
        // (b3) **各行的行首残小节要一样长**（363《倾听我的心》）：只罚比标准弱起短的；断点本身是句读落点时挪不动、不罚
        // （459《让我们在主里常喜乐》；拖腔也算挪不动，J29；休止挪得动，363 的 `0_`）。
        let fc = self.flat[idx].chord;
        let tail_stuck = lyric_punct_score(fc) > 0.0 || (self.punct_after[idx] > 0.0 && !fc.rest && main_lyric_text(fc).is_empty());
        if self.content_only && self.pickup_std > 0.0 && head > 0.0 && head < self.pickup_std - 0.01 && !tail_stuck {
            s += 12.0;
        }
        // (b2) **句末标点之后的那个休止是上一句唱完的收气，该留在上一行**（077「历风霜；」）；
        // 正好凑成本曲标准弱起的除外（363）。
        if self.content_only
            && nx.chord.rest
            && lyric_punct_score(fc) > 0.0
            && !(self.pickup_std > 0.0 && (head - self.pickup_std).abs() < 0.01)
            && !song_open
            && !head_whole
        {
            s += 8.0;
        }
        // (g) **断点落在「无词的拖腔」上、而拖腔所属的那个字没有标点收尾** → 词被劈开（077「殷｜勤」）。
        if self.content_only && !nx.chord.rest && main_lyric_text(fc).is_empty() && !fc.rest {
            let j = self.prev_word(idx);
            if j >= 0 && lyric_punct_score(self.flat[j as usize].chord) == 0.0 {
                s += 8.0;
            }
        }
        // (c) **行首那个字带着句读标点**而上一行自己没收尾（077「厌弃难当；」）；长音起头再加重。
        // 断点落在拖腔上时往前追到真正的字（131、142：两个标点之间只有一个字的不罚）。
        let prev_word_punct = {
            let j = self.prev_word(idx);
            if j < 0 {
                0.0
            } else {
                lyric_punct_score(self.flat[j as usize].chord)
            }
        };
        if self.content_only && lyric_punct_score(nx.chord) > 0.0 && prev_word_punct == 0.0 {
            s += 8.0;
        }
        if nx.chord.beats >= 2.0 && lyric_punct_score(nx.chord) > 0.0 && prev_word_punct == 0.0 {
            s += 10.0;
        }
        // (e) **行末别只挂着下一句的头一两个字**（062《神的保护》）。
        if self.tail_weight > 0.0 {
            let mut words = 0;
            let mut j = idx as i64;
            while j >= 0 {
                let ju = j as usize;
                if self.punct_after[ju] == 6.0 {
                    if words >= 1 {
                        s += self.tail_weight * 8.0;
                    }
                    break;
                }
                let c = self.flat[ju].chord;
                // 断点本身落在长音上不算数；再往前遇上长音就停——那是乐句真正的落点。
                if ju < idx && c.beats >= 2.0 {
                    break;
                }
                if !c.rest && !main_lyric_text(c).is_empty() {
                    words += 1;
                }
                if words > 2 {
                    break;
                }
                j -= 1;
            }
        }
        let tail_max = self.max_cells * 0.35;
        // (d) **别把一句话的最后一小截甩到下一行开头**（419「却成了祝福。」）。断点落在「带标点的长音」上不成立
        // （068「兴起！」），断点本身就是句末也不成立（020「啊！」）。距离量到最后那个字为止、不算拖腔（158「机会难留。」）。
        let strong_end = self.punct_after[idx] > 0.0 && fc.beats >= 2.0;
        let sentence_end_here = if self.content_only { self.end_after[idx] } else { self.punct_after[idx] == 6.0 };
        if self.tail_weight > 0.0 && !strong_end && !sentence_end_here {
            let mut run = 0.0;
            let mut run_word = 0.0;
            for j in idx + 1..k {
                run += cells_of(self.flat[j].chord);
                if !main_lyric_text(self.flat[j].chord).is_empty() {
                    run_word = run;
                }
                if run_word > tail_max {
                    break;
                }
                // 「是不是句末」要问 `endAfter`（158 的短句分被折半）
                let is_end = if self.content_only { self.end_after[j] } else { self.punct_after[j] == 6.0 };
                if is_end && j < k - 1 {
                    // 分量跟着 `punctAfter` 走（短呼语句只罚一半，020）
                    let w = if self.content_only { self.punct_after[j] / 6.0 } else { 1.0 };
                    s += self.tail_weight * 10.0 * (1.0 - run_word / tail_max) * w;
                    break;
                }
            }
        }
        s
    }

    /// 从 flat 的第 i 个音起头的旋律键（先跳掉行首的休止，最多取 `PARALLEL_MAX` 个）。
    fn head_keys_from(&self, i: i64) -> Vec<String> {
        let k = self.k as i64;
        let mut j = i;
        while j < k && self.flat[j as usize].chord.rest {
            j += 1;
        }
        let mut keys = Vec::new();
        let mut t = j;
        while t < k && keys.len() < PARALLEL_MAX {
            keys.push(note_key_of(self.flat[t as usize].chord));
            t += 1;
        }
        keys
    }

    /// 在 idx 之后断行的话，下一行的开头与别处重合了几个音（0 = 不平行）。
    /// **要求断点本身先是个像样的乐句收尾**（096「哈利｜路亚」的坑）。
    fn parallel_at(&self, idx: usize) -> f64 {
        if !(self.parallel_weight > 0.0) || idx + 1 >= self.k {
            return 0.0;
        }
        let c = self.flat[idx].chord;
        if !(self.punct_after[idx] > 0.0 || c.beats >= 2.0 || c.rest || c.fermata) {
            return 0.0;
        }
        self.parallel_len[idx + 1]
    }

    fn starts_parallel(&self, idx: usize) -> bool {
        self.parallel_at(idx) >= PARALLEL_MIN
    }

    fn strong_parallel(&self, idx: usize) -> bool {
        self.parallel_at(idx) >= PARALLEL_STRONG
    }

    /// **这里像不像一个乐句落点**（不含平行奖励）。候选池按它收人，见 `score_at`。
    fn score_base(&self, idx: usize) -> f64 {
        let n = self.n;
        let ci = self.flat[idx];
        let c = ci.chord;
        let mut s = self.punct_after[idx]; // 句号 6 / 逗号 4（已顺延到 slur/tie/休止 收尾）
        if c.fermata {
            s += 5.0;
        }
        if c.beats >= 2.0 {
            s += 4.0; // 长音收尾
        }
        // 标点是从前面那个长音顺延过来的（`5--- 0_`）：长音的分要带过来（372《跟随耶稣》第 2/4 行）
        if self.carried_from[idx] >= 0 && self.flat[self.carried_from[idx] as usize].chord.beats >= 2.0 {
            s += 4.0;
        }
        // **休止本身就是乐句的气口**：成书那条路按长短给分、八分休止也算；编辑器那条路维持 +1。
        if c.rest {
            s += if self.content_only {
                if c.beams == 0.0 {
                    4.0
                } else {
                    2.0
                }
            } else if c.beams == 0.0 {
                1.0
            } else {
                0.0
            };
        }
        // **前奏/间奏与唱段的交界**（028《全然向祢》）：无词段够长（≥2 个整小节）
        if ci.is_last && self.lyr_per[ci.mi].is_empty() && ci.mi + 1 < n && !self.lyr_per[ci.mi + 1].is_empty() {
            let mut run = 0;
            let mut j = ci.mi as i64;
            while j >= 0 && self.lyr_per[j as usize].is_empty() && run < INTRO_MIN_MEAS {
                run += 1;
                j -= 1;
            }
            if run >= INTRO_MIN_MEAS {
                s += 6.0;
            }
        }
        // 圆滑线/连音线刚收尾：弱信号；收的是长音就把长音的分带过来。
        if self.ok_end[idx] > 0 {
            s += 1.0;
            let st = self.tie_from[idx];
            if st >= 0 && self.flat[st as usize].chord.beats >= 2.0 {
                s += 4.0;
            }
        }
        // **转调之前断开**（144《求圣灵吹我》）
        if ci.is_last && ci.mi + 1 < n && self.measures[ci.mi + 1].key_change {
            s += 10.0;
        }
        // **反复段的开头也尽量断开**（009《荣耀归与至高神》）
        if ci.is_last && ci.mi + 1 < n && self.measures[ci.mi + 1].repeat_forward {
            s += 8.0;
        }
        if ci.is_last {
            let m = &self.measures[ci.mi];
            let bl = m.barline.as_deref();
            if m.repeat_backward || bl == Some("light-heavy") || bl == Some("light-light") {
                s += 5.0;
            }
            // 房收尾：房整体不可拆，房的末尾就是天然的换行处
            if self.ending_last[ci.mi] {
                s += 6.0;
            }
        }
        // 重复段边界**优先作行首/行末**（封顶 10；成书那条路要求先是个真正的乐句收尾，299）
        let rep = self.repeat_break_idx.get(&idx).copied();
        let rep_is_end = self.punct_after[idx] > 0.0 || c.rest || c.fermata || self.ok_end[idx] > 0;
        if let Some(rep) = rep {
            let full = if self.repeat_len_bonus { jmin(10.0, 6.0 + rep) } else { 8.0 };
            s += if self.content_only && !rep_is_end { 2.0 } else { full };
        }
        // 跳转记号所在小节末**高优先级断开**（+10）
        if ci.is_last && self.jump_meas.contains(&ci.mi) {
            s += 10.0;
        }
        s
    }

    /// **断在这里有多好**（= 乐句凭据 + 平行奖励）。平行分只影响「在几个候选之间挑谁」，不影响「有哪些候选」。
    fn score_at(&self, idx: usize) -> f64 {
        self.score_base(idx) + if self.starts_parallel(idx) { self.parallel_score } else { 0.0 }
    }

    /// 段界断点若落在**八分及更短的休止**上（新段弱起的起拍留白）→ 回退到休止之前。
    fn retreat_past_pickup_rest(&self, at: usize) -> usize {
        // 休止本身就收在小节线上时**不回退**（020《向主歌唱》第 4 行）
        if self.flat[at].is_last {
            return at;
        }
        let mut idx = at as i64;
        while idx >= 0 && self.flat[idx as usize].chord.rest && self.flat[idx as usize].chord.beams > 0.0 {
            idx -= 1;
        }
        if !(idx >= 0 && idx != at as i64 && self.depth_after[idx as usize] == 0) {
            return at;
        }
        let idx = idx as usize;
        // 回退之后的行首残小节要与本曲的弱起一样长，否则不退（337《活着为耶稣》）
        if self.content_only
            && self.pickup_std > 0.0
            && (self.head_dur_after(idx) - self.pickup_std).abs() > 0.01
            && (self.head_dur_after(at) - self.pickup_std).abs() < 0.01
        {
            return at;
        }
        idx
    }

    /// 这个音收了句：句末分记在它身上，或顺延到了紧跟的休止上（446《迦勒看见主》「虑？」）。
    fn ends_sentence_at(&self, i: usize) -> bool {
        self.punct_after[i] == 6.0
            || (self.carried_away[i]
                && self.carried_from.get(i + 1).copied() == Some(i as i64)
                && self.punct_after.get(i + 1).copied() == Some(6.0))
    }

    /// 段界落在句末字上时，同一小节里紧跟的四分及以上休止是这一句的收气，一并留在上一段（446）。
    fn past_breath_rest(&self, idx: usize) -> usize {
        if self.flat[idx].chord.rest || !self.ends_sentence_at(idx) {
            return idx;
        }
        let k = self.k;
        let mut end = idx;
        while end + 1 < k
            && self.flat[end + 1].mi == self.flat[idx].mi
            && self.flat[end + 1].chord.rest
            && self.flat[end + 1].chord.beams == 0.0
            && self.depth_after[end + 1] == 0
        {
            end += 1;
        }
        end
    }

    fn around_section_pickup(&self, at0: usize) -> usize {
        self.past_breath_rest(self.section_pickup_at(at0))
    }

    /// 段落标题/反复线与真实歌词段界错开 1~2 个短音：向两侧找最近句号（「脚步」、135、491、446、「立定心志」）。
    fn section_pickup_at(&self, at0: usize) -> usize {
        let k = self.k;
        let at = self.retreat_past_pickup_rest(at0);
        let mut leading = 0;
        let mut idx = at + 1;
        while idx < k && idx <= at + 3 {
            let c = self.flat[idx].chord;
            if !c.rest {
                leading += 1;
            }
            if self.ends_sentence_at(idx) && leading > 0 && leading <= 2 {
                return idx;
            }
            if c.beats > 1.0 || leading > 2 {
                break;
            }
            idx += 1;
        }
        let mut pickup = 0;
        let mut idx = at as i64;
        while idx >= 0 && at as i64 - idx <= 3 {
            let iu = idx as usize;
            if self.punct_after[iu] == 6.0 && pickup > 0 && pickup <= 3 {
                return iu;
            }
            let c = self.flat[iu].chord;
            if c.beats > 1.0 {
                break;
            }
            if !c.rest {
                pickup += 1;
            }
            if pickup > 3 {
                break;
            }
            idx -= 1;
        }
        at
    }

    fn cells_between(&self, a: usize, b: usize) -> f64 {
        let ia = self.idx_at[a];
        let ib = self.idx_at[b];
        self.cells_upto[(ib + 1) as usize] - self.cells_upto[(ia + 1) as usize] - self.ending_cut(ia + 1, ib, CutKey::Cells)
    }

    /// **容量那一档要按「整格」数**（378《主耶稣我爱祢》）。
    fn cells_int_between(&self, a: usize, b: usize) -> f64 {
        if self.cells_are_items {
            let ia = self.idx_at[a];
            let ib = self.idx_at[b];
            self.cells_int_upto[(ib + 1) as usize] - self.cells_int_upto[(ia + 1) as usize] - self.ending_cut(ia + 1, ib, CutKey::CellsInt)
        } else {
            self.cells_between(a, b)
        }
    }

    /// 一行有多长，**按时值算**（Σ `Chord.duration`）。
    fn dur_between(&self, a: usize, b: usize) -> f64 {
        let ia = self.idx_at[a];
        let ib = self.idx_at[b];
        self.dur_upto[(ib + 1) as usize] - self.dur_upto[(ia + 1) as usize] - self.ending_cut(ia + 1, ib, CutKey::Dur)
    }

    /// **「是不是句末」要问 `endAfter`**（成书那条路；374《跟随救主》段 2 的短句）。
    fn is_sentence_end_at(&self, i: usize) -> bool {
        if self.content_only {
            self.end_after[i]
        } else {
            self.punct_after[i] == 6.0
        }
    }

    fn crossed_end_punct(&self, a: usize, b: usize) -> f64 {
        self.end_punct_upto[self.idx_at[b] as usize] - self.end_punct_upto[(self.idx_at[a] + 1) as usize]
    }

    /// 在 b 处断行要付的代价（不含行长）：乐句信号越强越便宜，段末（b == hi）不付；一律非负（068、175、355）。
    fn break_cost(&self, b: usize, hi: usize) -> f64 {
        if b == hi {
            return 0.0;
        }
        let ci = self.cand[b - 1];
        let sc = self.score_at(ci);
        let base = if self.content_only {
            jmax(0.0, BASE_BREAK * (1.0 - sc / CONTENT_BASE_BREAK))
        } else {
            jmax(0.0, BASE_BREAK - sc * self.break_weight)
        };
        // 连一点乐句信号都没有的小节线也不该白拿（355《你已否祷告》）
        let no_evidence = if self.content_only && sc < 1.0 { 3.0 } else { 0.0 };
        base + no_evidence + (if self.flat[ci].is_last || sc >= 4.0 { 0.0 } else { 6.0 }) + self.head_penalty(ci)
    }

    /// 行长代价（软惩罚）。contentOnly 下只剩行长目标那一项（由调用方决定 `len_w`）。
    #[allow(clippy::too_many_arguments)]
    fn len_cost(&self, meas: f64, cells: f64, seg_end: bool, max_cells: f64, max_meas: f64, target: f64, len_w: f64, cells_int: f64) -> f64 {
        let co = self.content_only;
        len_w * (meas - target).powi(2)
            + (if !co && meas > max_meas { (meas - max_meas).powi(2) * 40.0 } else { 0.0 })
            + (if !co && cells_int > max_cells { (cells_int - max_cells).powi(2) * 8.0 } else { 0.0 })
            + (if !co && seg_end && meas < self.min_meas { (self.min_meas - meas).powi(2) * 10.0 } else { 0.0 })
            + (if !co && seg_end && cells < self.min_cells { (self.min_cells - cells).powi(2) } else { 0.0 })
    }

    /// 跑一遍 DP。`target_for(s)` 给第 s 段的行长目标（小节数），`len_w` 是行长代价的权重。回 `nextB`。
    fn run_dp(&self, target_for: &dyn Fn(usize) -> f64, len_w: f64) -> Vec<i64> {
        let m = self.m;
        let cuts = &self.cuts;
        let ends = &self.ends;
        let mut dp = vec![INF; m + 1];
        let mut next_b = vec![-1i64; m + 1];
        dp[m] = 0.0;
        let mut s = cuts.len() - 1;
        while s >= 1 {
            let lo = cuts[s - 1];
            let hi = cuts[s];
            let target = target_for(s);
            let mut a = hi as i64 - 1;
            while a >= lo as i64 {
                let au = a as usize;
                for b in au + 1..=hi {
                    let meas = ends[b] - ends[au];
                    let cells = self.cells_between(au, b);
                    // 扫描上界：放到软限的两倍，超出必然亏本
                    if b > au + 1 && (meas > self.max_meas * 2.0 || cells > self.max_cells * 2.0) {
                        break;
                    }
                    // 只有段末/曲末行可短；contentOnly 下放宽，但不许只剩一小节的碎行
                    if b < hi
                        && (if self.content_only {
                            meas < 2.0 && self.score_at(self.cand[b - 1]) < 4.0
                        } else {
                            meas < self.min_meas && cells < self.min_cells
                        })
                    {
                        continue;
                    }
                    let bc = self.break_cost(b, hi);
                    let crossed = self.crossed_end_punct(au, b);
                    let ends_at_sentence = self.is_sentence_end_at(self.idx_at[b] as usize);
                    // 若从本行起点到下一个句号仍放得下整句，就不要在逗号/弱信号处拆开（169《全新的你》、215《同心合意》）
                    let mut split_sentence = 0.0;
                    if b < hi && !ends_at_sentence {
                        let bi = self.idx_at[b] as usize;
                        let bc_ = self.flat[bi].chord;
                        let soft_cut = bc_.beats < LONG_NOTE_BEATS && !bc_.fermata && !bc_.rest && !self.strong_parallel(bi);
                        let mut p = self.idx_at[b] + 1;
                        while p <= self.idx_at[hi] {
                            let pu = p as usize;
                            if self.punct_after[pu] != 6.0 {
                                p += 1;
                                continue;
                            }
                            let start = (self.idx_at[au] + 1) as usize;
                            let sentence_cells = if self.cells_are_items {
                                self.cells_int_upto[pu + 1] - self.cells_int_upto[start]
                            } else {
                                self.cells_upto[pu + 1] - self.cells_upto[start]
                            };
                            let sentence_meas = self.flat[pu].pos - ends[au];
                            if soft_cut && sentence_cells <= self.max_sentence_cells && sentence_meas <= self.max_sentence_meas {
                                split_sentence = SPLIT_SHORT_SENTENCE_COST;
                            }
                            break;
                        }
                    }
                    // 「整句独占一行」可比普通行宽一些、长一些
                    let whole_sentence = ends_at_sentence && crossed == 0.0 && meas <= self.max_sentence_meas && cells <= self.max_sentence_cells;
                    let line_max_cells = if whole_sentence { self.max_sentence_cells } else { self.max_cells };
                    let line_max_meas = if whole_sentence { self.max_sentence_meas } else { self.max_meas };
                    // **末两行别一长一短**（前瞻：`nextB[b]` 已定；125/404）
                    let last_pair = if b < hi && next_b[b] == hi as i64 {
                        jmin(40.0, self.last_pair_weight * (meas - (ends[hi] - ends[b])).powi(2))
                    } else {
                        0.0
                    };
                    let cost = self.len_cost(meas, cells, b == hi, line_max_cells, line_max_meas, target, len_w, self.cells_int_between(au, b))
                        + bc
                        + split_sentence
                        + last_pair
                        + crossed * CROSSED_END_PUNCT_COST
                        + dp[b];
                    if cost < dp[au] {
                        dp[au] = cost;
                        next_b[au] = b as i64;
                    }
                }
                // 无解 → 退到最近的候选断点，宁可短行也别整段一行
                if dp[au] == INF {
                    let b = (au + 1).min(hi);
                    let cells = self.cells_between(au, b);
                    dp[au] = dp[b] + self.len_cost(ends[b] - ends[au], cells, b == hi, self.max_cells, self.max_meas, target, len_w, cells);
                    next_b[au] = b as i64;
                }
                a -= 1;
            }
            s -= 1;
        }
        next_b
    }

    /// 一段里排了几行（从回溯链上数）。
    fn lines_per_seg(&self, nb: &[i64]) -> Vec<f64> {
        let mut out = vec![0.0; self.cuts.len() - 1];
        let mut a: i64 = 0;
        while a < self.m as i64 {
            let b = nb[a as usize];
            if b <= a {
                break;
            }
            if let Some(s) = self.cuts.iter().position(|&c| c as i64 >= b) {
                if s >= 1 {
                    out[s - 1] += 1.0;
                }
            }
            a = b;
        }
        out
    }

    /// 回溯链上的各条边界 `[0, b1, b2, …]`。
    fn bounds_of(&self, nb: &[i64]) -> Vec<usize> {
        let mut bs = vec![0usize];
        let mut a: i64 = 0;
        while a < self.m as i64 {
            let b = nb[a as usize];
            if b <= a {
                break;
            }
            bs.push(b as usize);
            a = b;
        }
        bs
    }

    fn nb_of(&self, bs: &[usize]) -> Vec<i64> {
        let mut nb = vec![0i64; self.m + 1];
        for i in 0..bs.len().saturating_sub(1) {
            nb[bs[i]] = bs[i + 1] as i64;
        }
        nb
    }

    fn rows_of(&self, nb: &[i64]) -> f64 {
        (self.bounds_of(nb).len() - 1) as f64
    }

    /// 这一行（断点 a→b）按**真实坐标**放得下吗（没有真实坐标时一律当放得下）。
    fn line_fits(&self, a: usize, b: usize) -> bool {
        let Some(fit) = self.fit else { return true };
        let p0 = fit.span(self.idx_at[a] + 1);
        let p1 = fit.span(self.idx_at[b]);
        match (p0, p1) {
            (Some(p0), Some(p1)) => p1.x1b.unwrap_or(p1.x1) - p0.x0 < fit.width,
            _ => true,
        }
    }

    fn paper_cap(&self) -> f64 {
        match self.fit {
            Some(f) => f.width,
            None => self.max_cells,
        }
    }

    /// 一行有多宽：有真实坐标就用真实坐标，没有就退回格数。
    fn line_span(&self, a: usize, b: usize) -> f64 {
        let Some(fit) = self.fit else { return self.cells_int_between(a, b) };
        match (fit.span(self.idx_at[a] + 1), fit.span(self.idx_at[b])) {
            (Some(p0), Some(p1)) => p1.x1 - p0.x0,
            _ => self.cells_int_between(a, b),
        }
    }

    /// 同 `line_span`，但量到行末小节线：与版心宽比「放不放得下」用这把。
    fn fit_span(&self, a: usize, b: usize) -> f64 {
        let Some(fit) = self.fit else { return self.cells_int_between(a, b) };
        match (fit.span(self.idx_at[a] + 1), fit.span(self.idx_at[b])) {
            (Some(p0), Some(p1)) => p1.x1b.unwrap_or(p1.x1) - p0.x0,
            _ => self.cells_int_between(a, b),
        }
    }

    /// 两个行首重合几个音。**允许一个音的出入**（158《一件礼物》），差的那个音不计入长度、前后各至少 2 个音。
    fn common_prefix(ka: &[String], kb: &[String]) -> f64 {
        let mut n = 0;
        while n < ka.len() && n < kb.len() && ka[n] == kb[n] {
            n += 1;
        }
        if n >= 2 && n + 1 < ka.len() && n + 1 < kb.len() {
            let mut m = n + 1;
            while m < ka.len() && m < kb.len() && ka[m] == kb[m] {
                m += 1;
            }
            if m - n > 2 {
                return (m - 1) as f64;
            }
        }
        n as f64
    }

    /// 一套方案的分：越小越好（contentOnly 下无量纲、与行数无关；见 TS `quality` 的长注释）。
    fn quality(&self, nb: &[i64]) -> f64 {
        let m = self.m;
        let mut cells: Vec<f64> = Vec::new();
        let mut durs: Vec<f64> = Vec::new();
        let mut by_seg: OMap<i64, usize> = OMap::new();
        let mut seg_vals: Vec<Vec<f64>> = Vec::new();
        let mut weak = 0.0;
        let mut parallel = 0.0;
        let mut tail_long = 0.0;
        let mut tail_tonic = 0.0;
        let mut rows: Vec<Row> = Vec::new();
        let mut a: usize = 0;
        while a < m {
            let bi = nb[a];
            if bi <= a as i64 {
                break;
            }
            let b = bi as usize;
            cells.push(self.cells_between(a, b));
            durs.push(self.dur_between(a, b));
            if self.parallel_weight > 0.0 {
                // **收在主音上吗**（简谱的 `1`）——行末那个音；末行不算
                let tc = if b < m { Some(self.flat[self.cand[b - 1]].chord) } else { None };
                rows.push(Row {
                    keys: self.head_keys_from(self.idx_at[a] + 1),
                    dur: self.dur_between(a, b),
                    tonic: tc.is_some_and(|tc| !tc.rest && tc.notes.first().is_some_and(|n| n.number == "1")),
                    // **放不下的行不给奖励**（139《主爱有多少》）
                    fits: self.fit.is_none() || self.line_fits(a, b),
                    par: 0.0,
                });
            }
            // 按**段**归组（主歌一组、副歌一组）
            let seg_no = self.cuts.iter().position(|&c| c >= b).map(|p| p as i64).unwrap_or(-1);
            let slot = match by_seg.get(seg_no) {
                Some(s) => s,
                None => {
                    seg_vals.push(Vec::new());
                    by_seg.set(seg_no, seg_vals.len() - 1);
                    seg_vals.len() - 1
                }
            };
            seg_vals[slot].push(self.dur_between(a, b));
            let hi = self.cuts.iter().copied().find(|&c| c >= b).unwrap_or(m);
            weak += self.break_cost(b, hi);
            // **容量不卡断句**：非 contentOnly 那条路的老硬伤保留
            if !self.content_only {
                let over = self.cells_int_between(a, b) - self.max_cells;
                if over > 0.0 {
                    weak += 100.0 + over.powi(2) * 8.0;
                }
            }
            if !self.content_only {
                // 短行同样难看（058《耶和华的心》）。末行不算。
                let short = self.min_cells - self.cells_int_between(a, b);
                if short > 0.0 && b < m {
                    weak += short.powi(2);
                }
            }
            // 这一行的**下一行**是不是平行开头（按公共前缀长度给分，12 个音封顶；放不下的行不给，009）
            if b < m && (self.fit.is_none() || self.line_fits(a, b)) && !rows.is_empty() {
                let last = rows.len() - 1;
                rows[last].par = jmin(self.parallel_at(self.cand[b - 1]), 12.0) / 12.0;
            }
            // **这一行收在长音上吗**（标点被顺延走、后面就是收气休止的不给分，139）
            if b < m && (self.fit.is_none() || self.line_fits(a, b)) {
                let ti = self.cand[b - 1];
                let tc = self.flat[ti].chord;
                let carried = if self.carried_from[ti] >= 0 { Some(self.flat[self.carried_from[ti] as usize].chord) } else { None };
                let breath = self.punct_after[ti] > 0.0 && self.flat.get(ti + 1).is_some_and(|f| f.chord.rest);
                let long = if self.carried_away[ti] || breath { false } else { tc.beats >= 2.0 || tc.fermata };
                if long || carried.is_some_and(|c| c.beats >= 2.0) {
                    tail_long += 1.0;
                }
            }
            a = b;
        }
        if cells.is_empty() {
            return INF;
        }
        let len = cells.len() as f64;
        let mean = cells.iter().fold(0.0, |x, y| x + y) / len;
        let variance = cells.iter().fold(0.0, |x, c| x + (c - mean).powi(2)) / len;
        if !self.content_only {
            return variance + weak + self.row_cost * len;
        }
        let seg_cv = |xs: &[f64]| -> f64 {
            if xs.len() < 2 {
                return 0.0;
            }
            let mu = xs.iter().fold(0.0, |x, y| x + y) / xs.len() as f64;
            if !(mu > 0.0) {
                return 0.0;
            }
            (xs.iter().fold(0.0, |x, c| x + (c - mu).powi(2)) / xs.len() as f64).sqrt() / mu
        };
        // 行长匀度**按段各算各的**，再按行数加权平均（070《天使歌唱》）
        let cv = if self.content_only {
            let mut acc = 0.0;
            let mut cnt = 0.0;
            for (_, slot) in &by_seg.0 {
                let xs = &seg_vals[*slot];
                acc += seg_cv(xs) * xs.len() as f64;
                cnt += xs.len() as f64;
            }
            if cnt != 0.0 {
                acc / cnt
            } else {
                0.0
            }
        } else if mean > 0.0 {
            variance.sqrt() / mean
        } else {
            0.0
        };
        let median = |xs: &[f64]| -> f64 {
            let mut s = xs.to_vec();
            js::sort_num(&mut s);
            jor(s[xs.len() / 2], 1.0)
        };
        // **有一行明显比同曲其它行长就罚**（374《跟随救主》），看全曲
        let seg_outlier = |xs: &[f64]| -> f64 {
            if xs.len() < 2 {
                return 0.0;
            }
            let m = median(xs);
            jmax(0.0, max_all(xs.iter().copied()) / m - 1.4)
        };
        let outlier = seg_outlier(&durs);
        // **别有哪一行短到只剩别人一半**（末行不算）
        let seg_short_outlier = |xs: &[f64]| -> f64 {
            if xs.len() < 3 {
                return 0.0;
            }
            let m = median(xs);
            jmax(0.0, SHORT_OUTLIER_RATIO - min_all(xs[..xs.len() - 1].iter().copied()) / m)
        };
        let short_outlier = if self.content_only { seg_short_outlier(&durs) } else { 0.0 };
        // **末两行别一长一短**（方案之间比）
        let last_pair = if durs.len() >= 2 {
            let x = durs[durs.len() - 1];
            let y = durs[durs.len() - 2];
            jmax(0.0, LAST_PAIR_QUALITY_RATIO - jmin(x, y) / jmax(jmax(x, y), 1e-9))
        } else {
            0.0
        };
        // **平行的两行还得一样长**：给 `parallel` 打折（355《你已否祷告》），看下一行
        let even_of = |k: usize| -> f64 {
            let Some(r) = rows.get(k) else { return 1.0 };
            let mut best = 0.0;
            let mut found = false;
            for (j, rj) in rows.iter().enumerate() {
                if j == k || !rj.fits {
                    continue;
                }
                let n = Self::common_prefix(&r.keys, &rj.keys);
                if n < PARALLEL_MIN {
                    continue;
                }
                let lo = jmin(r.dur, rj.dur);
                let hi2 = jmax(r.dur, rj.dur);
                if !(hi2 > 0.0) {
                    continue;
                }
                found = true;
                best = jmax(best, lo / hi2);
            }
            if found {
                best
            } else {
                1.0
            }
        };
        for i in 0..rows.len() {
            parallel += rows[i].par * even_of(i + 1);
        }
        // **平行的一对句子双双收在主音上**（要求成对；125《主名至宝》）
        for k in 0..rows.len() {
            if !rows[k].tonic || !rows[k].fits {
                continue;
            }
            for j in 0..rows.len() {
                if j == k || !rows[j].tonic || !rows[j].fits {
                    continue;
                }
                if Self::common_prefix(&rows[k].keys, &rows[j].keys) >= PARALLEL_MIN {
                    tail_tonic += 1.0;
                    break;
                }
            }
        }
        let break_w = if self.content_only { BREAK_QUALITY_WEIGHT } else { 1.0 };
        self.even_weight * 100.0 * cv + OUTLIER_WEIGHT * (outlier + short_outlier)
            + (if self.content_only { LAST_PAIR_QUALITY_WEIGHT * last_pair } else { 0.0 })
            + break_w * (weak / len)
            - self.parallel_weight * (parallel / len) * 10.0
            - self.tail_long_weight * (tail_long / len) * 10.0
            - (if self.content_only { TAIL_TONIC_WEIGHT } else { 0.0 }) * (tail_tonic / len) * 10.0
    }

    fn run_with(&self, want: &[f64], len_w: f64) -> (Vec<i64>, Vec<f64>) {
        let nb = self.run_dp(
            &|s| {
                let span = self.ends[self.cuts[s]] - self.ends[self.cuts[s - 1]];
                let k = want[s - 1];
                if k > 0.0 {
                    span / k
                } else {
                    self.target_meas
                }
            },
            len_w,
        );
        let lines = self.lines_per_seg(&nb);
        (nb, lines)
    }

    /// 这一套方案里**最长的一行**超出版心多少倍。
    fn over_ratio(&self, nb: &[i64]) -> f64 {
        let cap = self.paper_cap();
        if !(cap > 0.0) {
            return 1.0;
        }
        let bs = self.bounds_of(nb);
        let mut mx = 0.0;
        for w in bs.windows(2) {
            mx = jmax(mx, self.fit_span(w[0], w[1]));
        }
        mx / cap
    }

    /// 每一行（末行除外，`with_last` 时也算）都不短于版心的 `frac`（144 的 40%、355 的 34%）。
    fn not_too_thin(&self, nb: &[i64], frac: f64, with_last: bool) -> bool {
        let cap = self.paper_cap();
        if !(cap > 0.0) {
            return true;
        }
        let floor = cap * frac;
        let bs = self.bounds_of(nb);
        let segs: Vec<f64> = bs.windows(2).map(|w| self.line_span(w[0], w[1])).collect();
        segs.iter().enumerate().all(|(i, &c)| (!with_last && i == segs.len() - 1) || c >= floor)
    }

    /// 既没有超出版心的行，也没有短到不足版心四成的中间行（与 line-check 的 D7 同口径）。
    fn fits_paper(&self, nb: &[i64]) -> bool {
        let cap = self.paper_cap();
        if !(cap > 0.0) {
            return true;
        }
        let floor = cap * 0.4;
        let bs = self.bounds_of(nb);
        let n = bs.len() - 1;
        bs.windows(2).enumerate().all(|(i, w)| self.fit_span(w[0], w[1]) < cap && (i == n - 1 || self.line_span(w[0], w[1]) >= floor))
    }

    /// **挪过去的地方本身得是个像样的乐句落点**（三道闸，照 line-check 的 D4/D6 写）。
    fn decent_cut(&self, b: usize) -> bool {
        if !(b > 0 && b <= self.m) {
            return false;
        }
        let idx = self.cand[b - 1];
        if self.score_at(idx) - self.head_penalty(idx) <= 0.0 {
            return false;
        }
        let ends_here = self.punct_after[idx] > 0.0;
        // D4：行首那个字带标点、上一行又没收尾
        if let Some(head) = self.flat.get(idx + 1) {
            if !ends_here && lyric_punct_score(head.chord) > 0.0 {
                return false;
            }
        }
        // D6：行末落在无词的拖腔上，往前最近的那个字没有标点
        let fc = self.flat[idx].chord;
        if !fc.rest && main_lyric_text(fc).is_empty() {
            let j = self.prev_word(idx);
            if j >= 0 && lyric_punct_score(self.flat[j as usize].chord) == 0.0 {
                return false;
            }
        }
        true
    }

    /// 一套方案里有几行放不下（真实坐标；没有 `fit` 时恒为 0）。
    fn overflows(&self, nb: &[i64]) -> usize {
        if self.fit.is_none() {
            return 0;
        }
        let bs = self.bounds_of(nb);
        bs.windows(2).filter(|w| !self.line_fits(w[0], w[1])).count()
    }

    /// 一套方案里**最差的那个段**的行长比（段内最短 ÷ 最长，按时值；按段界 `sectionCuts` 分组，034、348）。
    fn seg_ratio(&self, nb: &[i64], section_edges: &[usize]) -> f64 {
        let mut by_seg: OMap<usize, usize> = OMap::new();
        let mut vals: Vec<Vec<f64>> = Vec::new();
        let bs = self.bounds_of(nb);
        for w in bs.windows(2) {
            let (a, b) = (w[0], w[1]);
            let s_no = section_edges.iter().filter(|&&c| c < b).count();
            let slot = match by_seg.get(s_no) {
                Some(s) => s,
                None => {
                    vals.push(Vec::new());
                    by_seg.set(s_no, vals.len() - 1);
                    vals.len() - 1
                }
            };
            vals[slot].push(self.dur_between(a, b));
        }
        let mut worst = 1.0;
        for (_, slot) in &by_seg.0 {
            let xs = &vals[*slot];
            if xs.len() < 2 {
                continue;
            }
            let hi = max_all(xs.iter().copied());
            if hi > 0.0 {
                worst = jmin(worst, min_all(xs.iter().copied()) / hi);
            }
        }
        worst
    }

    /// **让平行的两行一样长**（061《坚固保障》）：照平行伙伴补一套候选（行数不变）。
    fn align_parallel(&self, nb: &[i64]) -> Option<Vec<i64>> {
        if !(self.parallel_weight > 0.0) {
            return None;
        }
        let mut bs = self.bounds_of(nb);
        // 至少三行才有得挪：末行的差额没处推。
        if bs.len() < 4 {
            return None;
        }
        let keys_at = |a: usize| self.head_keys_from(self.idx_at[a] + 1);
        let mut changed = false;
        let mut k = 1;
        while k + 2 < bs.len() {
            let keys = keys_at(bs[k]);
            let mut best_n = 0.0;
            let mut best_dur = 0.0;
            for j in 0..k {
                let n = Self::common_prefix(&keys_at(bs[j]), &keys);
                if n >= PARALLEL_MIN && n > best_n {
                    best_n = n;
                    best_dur = self.dur_between(bs[j], bs[j + 1]);
                }
            }
            if best_n == 0.0 || !(best_dur > 0.0) {
                k += 1;
                continue;
            }
            let mut pick = bs[k + 1];
            let diff0 = (self.dur_between(bs[k], pick) - best_dur).abs();
            let mut diff = diff0;
            for b in bs[k] + 1..bs[k + 2] {
                // 挪过去的地方本身得是个像样的乐句落点（403《救主子民还在世间》）
                if self.score_at(self.cand[b - 1]) - self.head_penalty(self.cand[b - 1]) <= 0.0 {
                    continue;
                }
                let d = (self.dur_between(bs[k], b) - best_dur).abs();
                if d < diff {
                    diff = d;
                    pick = b;
                }
            }
            // 差距至少砍掉一半、且至少差着一拍才挪
            if pick != bs[k + 1] && diff <= diff0 / 2.0 && diff0 - diff >= 1.0 {
                bs[k + 1] = pick;
                changed = true;
            }
            k += 1;
        }
        if !changed {
            return None;
        }
        let mut out = nb.to_vec();
        for i in 0..bs.len() - 1 {
            out[bs[i]] = bs[i + 1] as i64;
        }
        Some(out)
    }

    /// **逐点爬山**（171《回家吧》）：逐个断点在左右两条边界之间试遍候选，`quality` 变好就挪（段界与强制断点不动）。
    fn improve(&self, nb0: &[i64], section_edges: &[usize]) -> Option<Vec<i64>> {
        let mut bs = self.bounds_of(nb0);
        if bs.len() < 3 {
            return None; // 一行到底，没有可挪的断点
        }
        let q0 = self.quality(nb0);
        let mut cur_q = q0;
        let mut moved = false;
        for _ in 0..HILL_ROUNDS {
            let mut changed = false;
            let mut k = 1;
            while k + 1 < bs.len() {
                if self.cuts.contains(&bs[k]) {
                    k += 1;
                    continue;
                }
                let lo = bs[k - 1] + 1;
                let hi = bs[k + 1] - 1;
                let from = bs[k];
                let mut best_b = from;
                let mut best_q = cur_q;
                for b in lo..=hi {
                    if b == from || !self.decent_cut(b) {
                        continue;
                    }
                    bs[k] = b;
                    let q = self.quality(&self.nb_of(&bs));
                    if q < best_q - 1e-9 {
                        best_q = q;
                        best_b = b;
                    }
                }
                bs[k] = best_b;
                if best_b != from {
                    cur_q = best_q;
                    changed = true;
                    moved = true;
                }
                k += 1;
            }
            if !changed {
                break;
            }
        }
        // **爬得值才认**（355、020）；出发那套有放不下的行就不卡这道门槛（169）
        if !moved || (q0 - cur_q < HILL_MIN_GAIN && self.overflows(nb0) == 0) {
            return None;
        }
        let out = self.nb_of(&bs);
        // 两道**绝对**门槛：段内行长比 ≥ 0.5（D8）、每行都放得下（034《用我一生》、348）
        if self.seg_ratio(&out, section_edges) >= D8_RATIO && self.overflows(&out) == 0 {
            Some(out)
        } else {
            None
        }
    }

    /// **收气休止被甩到行首**（line-check 的 D5，019《拥戴祂为王》）的判据。
    fn breath_thrown(&self, idx: usize) -> bool {
        let Some(nx) = self.flat.get(idx + 1) else { return false };
        if !nx.chord.rest || nx.is_first {
            return false;
        }
        if !(self.punct_after[idx] > 0.0 || lyric_punct_score(self.flat[idx].chord) > 0.0) {
            return false;
        }
        let head = self.head_dur_after(idx);
        if self.pickup_std > 0.0 && (head - self.pickup_std).abs() < 0.01 {
            return false;
        }
        let head_rest = dur_of(nx.chord);
        !(head_rest <= 0.5 && (head - js::round(head)).abs() < 0.01)
    }
}

/// 计算乐句断点（TS `computePhraseBreaks`）。
pub fn compute_phrase_breaks(part: &PhrasePart, opts: &PhraseOptions) -> PhraseBreaks {
    let target_meas = opts.target_meas.unwrap_or(DEF_TARGET_MEAS);
    let min_meas = opts.min_meas.unwrap_or(DEF_MIN_MEAS);
    // 目标行长由容量折算过来时，上限跟着目标走
    let scaled = matches!(opts.target_meas, Some(t) if t > DEF_TARGET_MEAS);
    let max_meas = opts.max_meas.unwrap_or(if scaled { js::round(target_meas * 1.3) } else { DEF_MAX_MEAS });
    let max_sentence_meas = opts.max_sentence_meas.unwrap_or(if scaled { js::round(target_meas * 1.4) } else { DEF_MAX_SENTENCE_MEAS });
    let max_cells = opts.max_cells.unwrap_or(DEF_MAX_CELLS);
    let max_sentence_cells = opts.max_sentence_cells.unwrap_or(jmax(DEF_MAX_SENTENCE_CELLS, max_cells));
    let len_weight = opts.len_weight.unwrap_or(1.0);
    let short_words = opts.short_sentence_words.unwrap_or(0.0);
    let content_only = opts.content_only.unwrap_or(false);
    let page_lines = opts.page_lines.unwrap_or(0.0);
    let even_weight = opts.even_weight.unwrap_or(0.0);
    let fit_slack = opts.fit_slack.unwrap_or(0.0);
    let more_rows_slack = opts.more_rows_slack.unwrap_or(0.0);
    // 行长下限跟着上限走：版心窄时 14 格的下限会把断点全顶掉
    let min_cells = jmin(DEF_MIN_CELLS, js::round(max_cells * 0.6));

    let measures = &part.measures[..];
    let n = measures.len();
    let mut out = PhraseBreaks::default();
    if n <= 1 {
        return out;
    }
    let mut measure_breaks = OSet::default();
    let mut mid_breaks = OSet::default();
    let mut section_starts = OSet::default();
    let mut section_cut_chords = OSet::default();
    let mut forced = OSet::default();
    let mut refrain_cut = false;

    let chords_per: Vec<Vec<&PhraseChord>> = measures.iter().map(|m| m.chords.iter().collect()).collect();
    let fp_per: Vec<String> = chords_per.iter().map(|cs| measure_fp(cs)).collect();
    // 每小节的歌词指纹（第 1 段/副歌词）：**重复的歌词**同样是段落信号
    let lyr_per: Vec<String> = chords_per.iter().map(|cs| cs.iter().map(|c| main_lyric_text(c)).collect::<String>()).collect();

    // 重复旋律/歌词：按位移 d 扫出**极大**重复连续段（长度 ≥2 小节），其两端加为断点边界；值是该重复段的长度（015）。
    let mut repeat_edges: OMap<i64, f64> = OMap::new();
    let mut mark_repeats = |fp: &[String]| {
        let mut mark = |i: i64, len: f64| {
            let v = jmax(repeat_edges.get(i).unwrap_or(0.0), len);
            repeat_edges.set(i, v);
        };
        for d in 1..n {
            let mut i = 0;
            while i + d < n {
                if fp[i].is_empty() || fp[i] != fp[i + d] {
                    i += 1;
                    continue;
                }
                let mut j = i;
                while j + d < n && !fp[j].is_empty() && fp[j] == fp[j + d] {
                    j += 1; // [i,j) 与 [i+d,j+d) 逐节相同
                }
                if j - i >= 2 {
                    let len = (j - i) as f64;
                    mark(i as i64 - 1, len);
                    mark(j as i64 - 1, len);
                    mark((i + d) as i64 - 1, len);
                    mark((j + d) as i64 - 1, len);
                }
                i = j;
            }
        }
    };
    mark_repeats(&fp_per);
    mark_repeats(&lyr_per);

    // 每小节实际时值（各和弦时值之和）；用于把绝对位置换算成「小节数」。
    let measure_dur: Vec<f64> = chords_per.iter().map(|cs| jor(cs.iter().fold(0.0, |s, c| s + dur_of(c)), 1.0)).collect();

    let mut flat: Vec<CInfo> = Vec::new();
    for i in 0..n {
        let cs = &chords_per[i];
        for (k, c) in cs.iter().enumerate() {
            let within = c.position.plus(&c.duration.unwrap_or(Fraction::int(0.0))).to_float() / measure_dur[i];
            flat.push(CInfo { chord: c, mi: i, is_last: k == cs.len() - 1, is_first: k == 0, pos: i as f64 + jmin(1.0, within) });
        }
    }
    let k_len = flat.len();
    if k_len == 0 {
        return out;
    }

    // slur/tie 括号**先做栈式配对**：不成对的一端不计深度（「主祢真伟大」）。同一和弦先收尾后起始。
    let mut ok_start = vec![0i64; k_len];
    let mut ok_end = vec![0i64; k_len];
    let mut tie_from = vec![-1i64; k_len];
    {
        let mut stack: Vec<usize> = Vec::new();
        for idx in 0..k_len {
            let c = flat[idx].chord;
            let nt = c.notes.first();
            let n_e = (if nt.is_some_and(|x| x.tie_end) { 1.0 } else { 0.0 }) + c.slur_ends;
            let n_s = (if nt.is_some_and(|x| x.tie_start) { 1.0 } else { 0.0 }) + (if c.slur_start { 1.0 } else { 0.0 });
            let mut kk = 0.0;
            while kk < n_e {
                let Some(s) = stack.pop() else { break }; // 孤立收尾：无视
                ok_start[s] += 1;
                ok_end[idx] += 1;
                if tie_from[idx] < 0 || flat[s].chord.beats > flat[tie_from[idx] as usize].chord.beats {
                    tie_from[idx] = s as i64;
                }
                kk += 1.0;
            }
            let mut kk = 0.0;
            while kk < n_s {
                stack.push(idx);
                kk += 1.0;
            }
        }
    }

    // 逐和弦：括号深度（>0 不可断）；歌词标点分「顺延」到其所在 slur/tie 组收尾、并越过紧随的休止（基督更美的 `1 0`）。
    let mut depth_after = vec![0i64; k_len];
    let mut punct_after = vec![0.0f64; k_len];
    let mut end_after = vec![false; k_len];
    let mut carried_from = vec![-1i64; k_len];
    let mut carried_away = vec![false; k_len];
    {
        let mut depth = 0i64;
        let mut pending = 0.0;
        let mut pending_from: i64 = -1;
        let mut pending_end = false;
        let mut since_last_punct = 0.0;
        for idx in 0..k_len {
            let c = flat[idx].chord;
            depth += ok_start[idx];
            let txt = main_lyric_text(c);
            if !txt.is_empty() {
                since_last_punct += 1.0;
            }
            // 多段歌词一起看**只在成书那条路**（编辑器 15 首基线按「只看第 1 段」调出来）
            let mut p = if content_only { lyric_punct_score(c) } else { punct_score(txt) };
            let p_is_end = if content_only { lyric_is_sentence_end(c) } else { is_sentence_end(txt) };
            // **很短的分句减半**（015「哈利路亚！」）
            if p > 0.0 && since_last_punct <= short_words {
                p = js::round(p / 2.0);
            }
            if !txt.is_empty() && p > 0.0 {
                since_last_punct = 0.0;
            }
            if p > pending {
                pending = p;
                pending_from = idx as i64;
                pending_end = p_is_end;
            }
            depth -= ok_end[idx];
            depth_after[idx] = depth;
            // 顺延规则：本音符其后紧跟本小节内的休止时继续顺延（八分休止也顺延，372《跟随耶稣》）
            let next = flat.get(idx + 1);
            let carry_on = !c.rest && next.is_some_and(|nx| nx.chord.rest && nx.mi == flat[idx].mi);
            if depth == 0 && !carry_on {
                punct_after[idx] = pending;
                end_after[idx] = pending_end;
                if pending > 0.0 && pending_from >= 0 && pending_from != idx as i64 {
                    carried_from[idx] = pending_from;
                    carried_away[pending_from as usize] = true;
                }
                pending = 0.0;
                pending_from = -1;
                pending_end = false;
            }
        }
    }

    // 反复房（ending / volta）**整体不可拆**（010《愿祢崇高》）；没闭合的、长得离谱的不算房。
    let mut in_ending = vec![false; n];
    let mut ending_last = vec![false; n];
    {
        let mut i = 0;
        while i < n {
            if !measures[i].ending_left {
                i += 1;
                continue;
            }
            let mut j = i;
            while j < n && measures[j].ending_right.is_none() && (j == i || !measures[j].ending_left) {
                j += 1;
            }
            if j >= n || measures[j].ending_right.is_none() {
                i += 1;
                continue;
            }
            if (j - i) as f64 > max_meas {
                i += 1;
                continue;
            }
            for e in in_ending.iter_mut().take(j + 1).skip(i) {
                *e = true;
            }
            ending_last[j] = true;
            i = j + 1;
        }
    }

    // **行长要认识反复房**（158《一件礼物》）：一行完整包含一组房时，把第一房之后那几房的量减掉。
    let mut ending_groups: Vec<EndingGroup> = Vec::new();
    {
        let mut i = 0;
        while i < n {
            if !in_ending[i] {
                i += 1;
                continue;
            }
            let start_mi = i;
            let mut first = true;
            let (mut dur, mut cells, mut cells_int) = (0.0, 0.0, 0.0);
            let mut end_mi = i;
            while i < n && in_ending[i] {
                let from = i;
                while i < n && in_ending[i] && !ending_last[i] {
                    i += 1;
                }
                let to = i.min(n - 1);
                i = to + 1;
                end_mi = to;
                if !first {
                    for cs in chords_per.iter().take(to + 1).skip(from) {
                        for c in cs {
                            dur += dur_of(c);
                            cells += cells_of(c);
                            cells_int += cells_int_of(c);
                        }
                    }
                }
                first = false;
            }
            if dur > 0.0 {
                ending_groups.push(EndingGroup { start_mi, end_mi, dur, cells, cells_int });
            }
        }
    }

    // 「本曲的弱起有多长」：首小节不完整时就是它的时值（372《跟随耶稣》）
    let full_measure = max_all(measure_dur.iter().copied());
    let pickup_std = if measure_dur[0] < full_measure - 1e-6 { measure_dur[0] } else { 0.0 };
    // **本曲的起唱样式**：没有弱起、整首却从小节头上的一个短休止起唱（144《求圣灵吹我》）
    let opening_rest = if pickup_std == 0.0 && flat[0].chord.rest { dur_of(flat[0].chord) } else { 0.0 };

    let mut cx = Ctx {
        target_meas,
        min_meas,
        max_meas,
        max_sentence_meas,
        max_cells,
        max_sentence_cells,
        len_weight,
        repeat_len_bonus: opts.repeat_len_bonus.unwrap_or(false),
        break_weight: opts.break_weight.unwrap_or(1.0),
        last_pair_weight: opts.last_pair_weight.unwrap_or(1.0),
        even_weight,
        tail_weight: opts.tail_weight.unwrap_or(0.0),
        cells_are_items: opts.cells_are_items.unwrap_or(false),
        content_only,
        jump_meas: opts.jump_measures.clone().unwrap_or_default(),
        parallel_weight: opts.parallel_weight.unwrap_or(0.0),
        tail_long_weight: opts.tail_long_weight.unwrap_or(0.0),
        row_cost: opts.row_cost.unwrap_or(20.0),
        parallel_score: opts.parallel_score.unwrap_or(8.0),
        fit: opts.fit.as_ref(),
        min_cells,
        measures,
        n,
        k: k_len,
        chords_per,
        lyr_per,
        flat,
        ok_end,
        ok_start,
        tie_from,
        depth_after,
        punct_after,
        end_after,
        carried_from,
        carried_away,
        repeat_break_idx: HashMap::new(),
        in_ending,
        ending_last,
        ending_groups,
        pickup_std,
        opening_rest,
        parallel_len: vec![0.0; k_len],
        cand: Vec::new(),
        m: 0,
        ends: Vec::new(),
        idx_at: Vec::new(),
        cells_upto: Vec::new(),
        cells_int_upto: Vec::new(),
        dur_upto: Vec::new(),
        end_punct_upto: Vec::new(),
        cuts: Vec::new(),
    };
    let k = k_len;

    // 重复边界（小节下标）→ 实际断点的 flat 下标
    {
        let mut rbi: HashMap<usize, f64> = HashMap::new();
        for &(mi, len) in &repeat_edges.0 {
            let Some(idx) = cx.flat.iter().position(|f| f.is_last && f.mi as i64 == mi) else { continue };
            let at = cx.retreat_to_punct(cx.advance_past_long_tie(idx));
            let v = jmax(rbi.get(&at).copied().unwrap_or(0.0), len);
            rbi.insert(at, v);
        }
        cx.repeat_break_idx = rbi;
    }

    // **平行乐句开头**：潜在行首 = 上一个音符是个乐句落点的那些位置（363）；两两比最长公共前缀（072）。
    if cx.parallel_weight > 0.0 {
        let mut heads: Vec<(usize, Vec<String>)> = Vec::new();
        for i in 0..k {
            if i > 0 {
                let pv = cx.flat[i - 1];
                if !(pv.is_last || cx.punct_after[i - 1] > 0.0 || pv.chord.beats >= 2.0 || pv.chord.rest) {
                    continue;
                }
            }
            let keys = cx.head_keys_from(i as i64);
            if keys.len() as f64 >= PARALLEL_MIN {
                heads.push((i, keys));
            }
        }
        let mut pl = vec![0.0; k];
        for a in 0..heads.len() {
            for b in a + 1..heads.len() {
                let nn = Ctx::common_prefix(&heads[a].1, &heads[b].1);
                if nn < PARALLEL_MIN {
                    continue;
                }
                pl[heads[a].0] = jmax(pl[heads[a].0], nn);
                pl[heads[b].0] = jmax(pl[heads[b].0], nn);
            }
        }
        cx.parallel_len = pl;
    }

    // 候选断点：括号闭合（depth 0）且「小节末」或「带乐句信号」的和弦；末音强制入选（曲末）。
    let mut cand: Vec<usize> = Vec::new();
    for idx in 0..k {
        if cx.depth_after[idx] != 0 {
            continue;
        }
        let mi = cx.flat[idx].mi;
        if cx.in_ending[mi] && !(cx.flat[idx].is_last && cx.ending_last[mi]) {
            continue;
        }
        if cx.flat[idx].is_last || cx.score_base(idx) > 0.0 {
            cand.push(idx);
        }
    }
    if cand.last() != Some(&(k - 1)) {
        cand.push(k - 1);
    }

    // 段落标记：段首必起新行，且**每段独立排行长**
    let section_mi: Vec<usize> = (0..n).filter(|&mi| mi > 0 && measures[mi].section_mark.as_deref().is_some_and(|s| !s.is_empty())).collect();
    // 段首小节 → 断点的 flat 下标（在其后换行）；按插入次序
    let mut section_cut_idx: OMap<usize, usize> = OMap::new();
    for &mi in &section_mi {
        let Some(at) = cx.flat.iter().position(|f| f.is_last && f.mi + 1 == mi) else { continue };
        let mut idx = at;
        while idx < k && cx.depth_after[idx] != 0 {
            idx += 1;
        }
        // 段首小节的头一个音若是上一乐句的**长音收尾**（「立定心志」），顺延到弧闭合之后
        idx = cx.advance_past_long_tie(idx);
        idx = cx.around_section_pickup(idx);
        if idx < k {
            section_cut_idx.set(mi, idx);
        }
    }
    // 副歌（refrain）起点同样是段界（「从前所珍爱」）
    {
        let mut saw_verse = false;
        let mut refrain_idx: i64 = -1;
        'outer: for idx in 0..k {
            for nt in &cx.flat[idx].chord.notes {
                for lrc in &nt.lyrics {
                    if lrc.text.is_empty() {
                        continue;
                    }
                    if !lrc.refrain {
                        saw_verse = true;
                        continue;
                    }
                    if !saw_verse {
                        continue; // ① 须在主歌之后
                    }
                    if (k - idx) as f64 >= jmax(8.0, k as f64 / 8.0) {
                        refrain_idx = idx as i64; // ② 副歌须有份量
                    }
                    break 'outer;
                }
            }
        }
        if refrain_idx > 0 {
            let ri = refrain_idx as usize;
            section_cut_idx.set(cx.flat[ri].mi, cx.around_section_pickup(ri - 1));
            refrain_cut = true;
        }
    }

    // 顺延后的位置不一定在候选里 → 补进去（只对段界破例）
    {
        let mut seen: Vec<usize> = Vec::new();
        for &(_, idx) in &section_cut_idx.0 {
            if seen.contains(&idx) {
                continue;
            }
            seen.push(idx);
            if cand.contains(&idx) {
                continue;
            }
            let at = cand.iter().position(|&c| c > idx).unwrap_or(cand.len());
            cand.insert(at, idx);
        }
    }
    let m = cand.len();

    let mut section_cuts: Vec<usize> = Vec::new();
    for &(_, idx) in &section_cut_idx.0 {
        let Some(b) = cand.iter().position(|&c| c == idx) else { continue };
        section_cuts.push(b + 1); // dp 下标 = cand 下标 + 1
        if cx.flat[idx].is_last {
            section_starts.add(cx.flat[idx].mi + 1);
        } else {
            section_cut_chords.add(idx);
        }
    }

    // 全局 DP（类 Knuth-Plass）的前缀量
    let mut ends = vec![0.0];
    ends.extend(cand.iter().map(|&i| cx.flat[i].pos));
    let mut idx_at = vec![-1i64];
    idx_at.extend(cand.iter().map(|&i| i as i64));
    let mut cells_upto = vec![0.0; k + 1];
    let mut cells_int_upto = vec![0.0; k + 1];
    let mut dur_upto = vec![0.0; k + 1];
    let mut end_punct_upto = vec![0.0; k + 1];
    for i in 0..k {
        let c = cx.flat[i].chord;
        cells_upto[i + 1] = cells_upto[i] + cells_of(c);
        cells_int_upto[i + 1] = cells_int_upto[i] + cells_int_of(c);
        dur_upto[i + 1] = dur_upto[i] + dur_of(c);
        let e = if content_only { cx.end_after[i] } else { cx.punct_after[i] == 6.0 };
        end_punct_upto[i + 1] = end_punct_upto[i] + if e { 1.0 } else { 0.0 };
    }
    cx.cand = cand;
    cx.m = m;
    cx.ends = ends;
    cx.idx_at = idx_at;
    cx.cells_upto = cells_upto;
    cx.cells_int_upto = cells_int_upto;
    cx.dur_upto = dur_upto;
    cx.end_punct_upto = end_punct_upto;

    // **跳转记号、转调、前奏之后强制断行**（096、144、028）；后面剩不下半行内容的不强制（018、497）。
    let mut forced_cuts: Vec<usize> = Vec::new();
    {
        let mut key_change_meas: Vec<usize> = Vec::new();
        let add_kc = |v: &mut Vec<usize>, x: usize| {
            if !v.contains(&x) {
                v.push(x);
            }
        };
        if content_only {
            for mi in 1..n {
                if measures[mi].key_change {
                    add_kc(&mut key_change_meas, mi - 1);
                }
            }
            let mut mi = INTRO_MIN_MEAS - 1;
            while mi + 1 < n {
                if cx.lyr_per[mi].is_empty() && !cx.lyr_per[mi + 1].is_empty() {
                    let mut run = 0;
                    let mut j = mi as i64;
                    while j >= 0 && cx.lyr_per[j as usize].is_empty() && run < INTRO_MIN_MEAS {
                        run += 1;
                        j -= 1;
                    }
                    if run >= INTRO_MIN_MEAS {
                        add_kc(&mut key_change_meas, mi);
                    }
                }
                mi += 1;
            }
        }
        for i in 0..m {
            let idx = cx.cand[i];
            if idx == k - 1 || !cx.flat[idx].is_last {
                continue;
            }
            let fmi = cx.flat[idx].mi;
            let is_jump = cx.jump_meas.contains(&fmi);
            if !is_jump && !key_change_meas.contains(&fmi) {
                continue;
            }
            if cx.cells_upto[k] - cx.cells_upto[idx + 1] < FORCED_CUT_TAIL_CELLS {
                continue;
            }
            // **前奏的收尾长音留在前奏那一行**（028）：挪到「第一个有词的音」之前
            let mut at = i;
            if !is_jump {
                let mut sung = idx + 1;
                while sung < k && main_lyric_text(cx.flat[sung].chord).is_empty() {
                    sung += 1;
                }
                let mut j = i + 1;
                while j < m && cx.cand[j] < sung {
                    at = j;
                    j += 1;
                }
            }
            forced_cuts.push(at + 1);
            let fi = cx.flat[cx.cand[at]];
            if fi.is_last {
                forced.add(fi.mi + 1);
            }
        }
    }

    // 按段界把 [0,M] 切成若干闭区间，逐段跑同一套 DP
    {
        let mut cs: Vec<usize> = Vec::new();
        for &c in section_cuts.iter().chain(forced_cuts.iter()) {
            if !cs.contains(&c) {
                cs.push(c);
            }
        }
        let mut cuts_f: Vec<f64> = std::iter::once(0.0).chain(cs.iter().map(|&c| c as f64)).collect();
        js::sort_num(&mut cuts_f);
        let mut cuts: Vec<usize> = cuts_f.into_iter().map(|c| c as usize).collect();
        if cuts.last() != Some(&m) {
            cuts.push(m);
        }
        cx.cuts = cuts;
    }
    let cx = cx; // 往下只读

    // 第一遍：contentOnly 下 `lenW = 0`，纯按内容断
    let mut next_b = cx.run_dp(&|_| cx.target_meas, if content_only { 0.0 } else { cx.len_weight });

    // **把末页排满**（`pageLines > 0`，001《圣哉，圣哉，圣哉》）：要么排满，要么不动
    if page_lines > 0.0 {
        let base = cx.lines_per_seg(&next_b);
        let total = base.iter().fold(0.0, |x, y| x + y);
        let want = (total / page_lines).ceil() * page_lines;
        if total > 0.0 && want > total {
            // 缺的行加给「平均行最长」的那一段
            let mut plan = base.clone();
            let span_of = |i: usize| cx.ends[cx.cuts[i + 1]] - cx.ends[cx.cuts[i]];
            let mut d = want - total;
            while d > 0.0 {
                let mut bi = 0;
                for i in 1..plan.len() {
                    if span_of(i) / plan[i] > span_of(bi) / plan[bi] {
                        bi = i;
                    }
                }
                plan[bi] += 1.0;
                d -= 1.0;
            }
            let alt = cx.run_dp(
                &|s| {
                    let span = cx.ends[cx.cuts[s]] - cx.ends[cx.cuts[s - 1]];
                    let kk = plan[s - 1];
                    if kk > 0.0 {
                        span / kk
                    } else {
                        cx.target_meas
                    }
                },
                cx.len_weight * 4.0,
            );
            let got = cx.lines_per_seg(&alt);
            let mut ok = got.iter().fold(0.0, |x, y| x + y) == want;
            let mut a: i64 = 0;
            while ok && a < m as i64 {
                let b = alt[a as usize];
                if b <= a {
                    ok = false;
                    break;
                }
                let (au, bu) = (a as usize, b as usize);
                if cx.ends[bu] - cx.ends[au] < cx.min_meas && cx.cells_between(au, bu) < cx.min_cells {
                    ok = false;
                }
                a = b;
            }
            if ok {
                next_b = alt;
            }
        }
    }

    // **出几种方案再评分选优**（`evenWeight > 0`；051、378）
    if even_weight > 0.0 {
        let segs = cx.cuts.len() - 1;
        let base = cx.lines_per_seg(&next_b);
        let section_edges: Vec<usize> = {
            let mut v: Vec<f64> = section_cuts.iter().map(|&c| c as f64).collect();
            js::sort_num(&mut v);
            v.into_iter().map(|c| c as usize).collect()
        };
        let quality = |nb: &[i64]| cx.quality(nb);

        let deltas: &[f64] = if content_only { &[-3.0, -2.0, -1.0, 0.0, 1.0, 2.0, 3.0] } else { &[0.0, 1.0, 2.0] };
        let mut options: Vec<Vec<f64>> = Vec::new();
        let add = |options: &mut Vec<Vec<f64>>, w: Vec<f64>| {
            if w.iter().any(|&v| v < 1.0) {
                return;
            }
            if !options.iter().any(|o| o.iter().enumerate().all(|(i, v)| *v == w[i])) {
                options.push(w);
            }
        };
        add(&mut options, base.clone());
        // 另加两档倍数：「一行一句」与「一行两句」（169《全新的你》）
        add(&mut options, base.iter().map(|v| (v * 1.5).ceil()).collect());
        add(&mut options, base.iter().map(|v| v * 2.0).collect());
        // base 很小时两倍也够不着（139《主爱有多少》）
        if content_only {
            add(&mut options, base.iter().map(|v| v * 3.0).collect());
            add(&mut options, base.iter().map(|v| v * 4.0).collect());
        }
        if segs <= 3 {
            fn grid(i: usize, acc: &mut Vec<f64>, segs: usize, base: &[f64], deltas: &[f64], out: &mut Vec<Vec<f64>>, add: &AddOption) {
                if i == segs {
                    add(out, acc.clone());
                    return;
                }
                for &d in deltas {
                    acc.push(base[i] + d);
                    grid(i + 1, acc, segs, base, deltas, out, add);
                    acc.pop();
                }
            }
            grid(0, &mut Vec::new(), segs, &base, deltas, &mut options, &add);
        } else {
            for i in 0..segs {
                for &d in deltas {
                    if d == 0.0 {
                        continue;
                    }
                    let mut w = base.clone();
                    w[i] += d;
                    add(&mut options, w);
                }
            }
        }

        let mut best = Plan { score: INF, nb: next_b.clone(), rows: 0.0 };
        let mut fits: Vec<Plan> = Vec::new();
        let mut all: Vec<Plan> = Vec::new();
        let consider = |sc: f64, nb: Vec<i64>, best: &mut Plan, all: &mut Vec<Plan>, fits: &mut Vec<Plan>| {
            if sc < best.score {
                *best = Plan { score: sc, nb: nb.clone(), rows: 0.0 };
            }
            let rows = cx.rows_of(&nb);
            if cx.fits_paper(&nb) {
                fits.push(Plan { score: sc, nb: nb.clone(), rows });
            }
            all.push(Plan { score: sc, nb, rows });
        };
        let try_want = |want: &[f64], best: &mut Plan, all: &mut Vec<Plan>, fits: &mut Vec<Plan>| {
            let (got_nb, got_lines) = cx.run_with(want, RUN_WITH_LEN_WEIGHT);
            // **要几行就真排出几行**（144《求圣灵吹我》）：排不出就加重行长项再排一遍，硬排的不许细成一条线（355）
            if content_only && !got_lines.iter().enumerate().all(|(i, v)| *v == want[i]) {
                let (hard_nb, _) = cx.run_with(want, RUN_WITH_LEN_WEIGHT * 4.0);
                if cx.not_too_thin(&hard_nb, 1.0 / 3.0, false) {
                    let q = quality(&hard_nb);
                    consider(q, hard_nb, best, all, fits);
                }
            }
            // **排不出想要的行数也照样评分**（169《全新的你》）
            let q = quality(&got_nb);
            consider(q, got_nb, best, all, fits);
        };
        for want in &options {
            try_want(want, &mut best, &mut all, &mut fits);
        }
        // **一套放得下的都没有 → 往行数多的方向再找**（139《主爱有多少》）
        if fit_slack > 0.0 && fits.is_empty() && cx.max_cells > 0.0 {
            let cap = cx.paper_cap();
            let need: Vec<f64> = (0..base.len())
                .map(|i| {
                    let lo = cx.cuts[i];
                    let hi = cx.cuts.get(i + 1).copied().unwrap_or(m);
                    jmax(1.0, (cx.fit_span(lo, hi) / cap).ceil())
                })
                .collect();
            for d in 0..=2 {
                let w: Vec<f64> = need.iter().enumerate().map(|(i, &v)| jmax(base[i], v) + d as f64).collect();
                try_want(&w, &mut best, &mut all, &mut fits);
            }
        }
        // 第一遍那套也要参与评分
        if quality(&next_b) <= best.score {
            best = Plan { score: quality(&next_b), nb: next_b.clone(), rows: 0.0 };
        }
        consider(quality(&next_b), next_b.clone(), &mut best, &mut all, &mut fits);
        // **让平行的两行一样长**（061《坚固保障》）
        let snapshot = all.clone();
        for o in &snapshot {
            if let Some(v) = cx.align_parallel(&o.nb) {
                // 补出来的那套不许有碎行（403）
                if cx.not_too_thin(&v, 1.0 / 3.0, false) {
                    let q = quality(&v);
                    consider(q, v, &mut best, &mut all, &mut fits);
                }
            }
        }
        // **只爬有希望的那些**
        let mut sorted = all.clone();
        js::sort_by(&mut sorted, |a, b| a.score - b.score);
        for o in sorted.iter().take(HILL_PLANS) {
            if let Some(v) = cx.improve(&o.nb, &section_edges) {
                if cx.not_too_thin(&v, 1.0 / 3.0, false) {
                    let q = quality(&v);
                    consider(q, v, &mut best, &mut all, &mut fits);
                }
            }
        }
        // **行数多的方案优先**（066《普世欢腾》）；多出来的那一行得是一整行（355、096、103）
        if more_rows_slack > 0.0 {
            let mut ok: Vec<Plan> = all.iter().filter(|f| f.score <= best.score + more_rows_slack && cx.not_too_thin(&f.nb, 0.35, true)).cloned().collect();
            js::sort_by(&mut ok, |a, b| jor(b.rows - a.rows, a.score - b.score));
            if let Some(o) = ok.first() {
                best = Plan { score: o.score, nb: o.nb.clone(), rows: 0.0 };
            }
        }
        // **纸张只当平局的裁判**（070《天使歌唱》）；「撂挑子」那一档与 `FIT_SLACK` 无关（297、066、459、034）
        let abdicated = content_only && cx.over_ratio(&best.nb) >= ABDICATE_RATIO;
        if fit_slack > 0.0 || abdicated {
            let slack = if abdicated { INF } else { fit_slack };
            let mut ok: Vec<Plan> = fits.iter().filter(|f| f.score <= best.score + slack).cloned().collect();
            if abdicated {
                js::sort_by(&mut ok, |a, b| jor(a.score - b.score, b.rows - a.rows));
            } else {
                js::sort_by(&mut ok, |a, b| jor(b.rows - a.rows, a.score - b.score));
            }
            if let Some(o) = ok.first() {
                best = Plan { score: o.score, nb: o.nb.clone(), rows: 0.0 };
            } else if abdicated {
                // 一套放得下的都没有 → 在不碎的方案里挑超得最少的那一套（034《用我一生》）
                let mut near: Vec<Plan> = all.iter().filter(|f| cx.not_too_thin(&f.nb, 0.35, false)).cloned().collect();
                js::sort_by(&mut near, |a, b| jor(cx.over_ratio(&a.nb) - cx.over_ratio(&b.nb), a.score - b.score));
                if let Some(o) = near.first() {
                    if cx.over_ratio(&o.nb) < cx.over_ratio(&best.nb) {
                        best = Plan { score: o.score, nb: o.nb.clone(), rows: 0.0 };
                    }
                }
            }
        }
        // **收气休止留在上一行**（D5，019《拥戴祂为王》）：试着挪到那串休止之后
        if content_only {
            let mut bs = cx.bounds_of(&best.nb);
            let mut q = quality(&best.nb);
            let mut kk = 1;
            while kk + 1 < bs.len() {
                if cx.cuts.contains(&bs[kk]) {
                    kk += 1;
                    continue;
                }
                let idx = cx.cand[bs[kk] - 1];
                if !cx.breath_thrown(idx) {
                    kk += 1;
                    continue;
                }
                let from = bs[kk];
                let mut pick: i64 = -1;
                let mut pick_q = q + HILL_MIN_GAIN;
                let mut j = idx + 1;
                while j < k && cx.flat[j].mi == cx.flat[idx].mi && cx.flat[j].chord.rest {
                    let b = cx.cand.iter().position(|&c| c == j).map(|p| p + 1).unwrap_or(0);
                    if b <= from || b >= bs[kk + 1] || cx.breath_thrown(j) || !cx.decent_cut(b) {
                        j += 1;
                        continue;
                    }
                    bs[kk] = b;
                    let nb = cx.nb_of(&bs);
                    let qb = quality(&nb);
                    if qb < pick_q
                        && cx.seg_ratio(&nb, &section_edges) >= jmin(D8_RATIO, cx.seg_ratio(&best.nb, &section_edges))
                        && cx.overflows(&nb) <= cx.overflows(&best.nb)
                    {
                        pick = b as i64;
                        pick_q = qb;
                    }
                    bs[kk] = from;
                    j += 1;
                }
                if pick > 0 {
                    bs[kk] = pick as usize;
                    best = Plan { score: pick_q, nb: cx.nb_of(&bs), rows: 0.0 };
                    q = pick_q;
                }
                kk += 1;
            }
        }
        next_b = best.nb;
    }

    // 全部候选断点连同凭据分带出去（见 `PhraseBreaks.cuts`）
    for &idx in &cx.cand {
        out.cuts.push(CutCandidate {
            chord: idx,
            mi: cx.flat[idx].mi,
            is_last: cx.flat[idx].is_last,
            score: cx.score_at(idx) - cx.head_penalty(idx),
            end: cx.end_after[idx],
            parallel: jmin(cx.parallel_at(idx), 12.0),
        });
    }

    // 回溯：小节末→小节边界换行，否则→行内换行
    {
        let mut a: i64 = 0;
        while a < m as i64 {
            let b = next_b[a as usize];
            if b <= a {
                break;
            }
            if (b as usize) < m {
                let ci = cx.flat[cx.cand[b as usize - 1]];
                if ci.is_last {
                    measure_breaks.add(ci.mi + 1);
                } else {
                    mid_breaks.add(cx.cand[b as usize - 1]);
                }
            }
            a = b;
        }
    }
    // 行首不留一个孤零零的休止（193《主恩更多》）：并到上一行去；整小节都是休止的同理
    for c in mid_breaks.0.clone() {
        let Some(nx) = cx.flat.get(c + 1) else { continue };
        if !nx.chord.rest || !nx.is_last {
            continue;
        }
        mid_breaks.delete(c);
        if nx.is_last {
            measure_breaks.add(nx.mi + 1);
        } else {
            mid_breaks.add(c + 1);
        }
    }
    for mi in measure_breaks.0.clone() {
        if mi >= n || cx.chords_per[mi].is_empty() {
            continue;
        }
        if !cx.chords_per[mi].iter().all(|c| c.rest) {
            continue;
        }
        measure_breaks.delete(mi);
        if mi + 1 < n {
            measure_breaks.add(mi + 1);
        }
    }

    out.measure_breaks = measure_breaks.0;
    out.mid_breaks = mid_breaks.0;
    out.section_starts = section_starts.0;
    out.section_cut_chords = section_cut_chords.0;
    out.refrain_cut = refrain_cut;
    out.forced = forced.0;
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::play::phraseinput::{PhraseLyric, PhraseMeasure, PhraseNote};

    fn chord(num: &str, beats: f64, dur: f64, pos: f64, lyric: &str) -> PhraseChord {
        let rest = num == "0";
        PhraseChord {
            notes: vec![PhraseNote {
                number: num.into(),
                jp_octave: 0.0,
                tie_start: false,
                tie_end: false,
                lyrics: if lyric.is_empty() { vec![] } else { vec![PhraseLyric { text: lyric.into(), number: 1.0, refrain: false }] },
            }],
            rest,
            beats,
            beams: 0.0,
            dot: 0.0,
            duration: Some(Fraction::new(dur, 1.0)),
            position: Fraction::new(pos, 1.0),
            fermata: false,
            slur_start: false,
            slur_ends: 0.0,
        }
    }

    fn measure(chords: Vec<PhraseChord>) -> PhraseMeasure {
        PhraseMeasure {
            chords,
            barline: None,
            repeat_backward: false,
            repeat_forward: false,
            key_change: false,
            ending_left: false,
            ending_right: None,
            section_mark: None,
        }
    }

    #[test]
    fn punct() {
        assert_eq!(punct_score("主。"), 6.0);
        assert_eq!(punct_score("亲，”"), 4.0);
        assert_eq!(punct_score("主"), 0.0);
        assert_eq!(punct_score(""), 0.0);
        assert!(is_sentence_end("哈利路亚！」"));
        assert!(!is_sentence_end("恩，"));
    }

    #[test]
    fn head_fp() {
        let cs: Vec<PhraseChord> = ["0", "1", "2", "3", "4", "5", "6", "7", "1"].iter().map(|n| chord(n, 1.0, 1.0, 0.0, "")).collect();
        let refs: Vec<&PhraseChord> = cs.iter().collect();
        assert_eq!(head_fp_of(&refs), "1:0,2:0,3:0,4:0,5:0,6:0,7:0,1:0");
        assert_eq!(head_fp_of(&refs[..5]), "");
        assert_eq!(note_key_of(&cs[0]), "R");
    }

    #[test]
    fn lyric_median() {
        let mut c = chord("1", 1.0, 1.0, 0.0, "主。");
        c.notes[0].lyrics.push(PhraseLyric { text: "神，".into(), number: 2.0, refrain: false });
        c.notes[0].lyrics.push(PhraseLyric { text: "爱".into(), number: 3.0, refrain: false });
        assert_eq!(lyric_punct_score(&c), 4.0);
        assert!(!lyric_is_sentence_end(&c));
        assert_eq!(main_lyric_text(&c), "主。");
    }

    fn song() -> PhrasePart {
        let words = ["耶", "稣", "爱", "我，", "我", "知", "道，", "因", "为", "圣", "经", "告", "诉", "我。", "小", "孩", "虽", "软", "弱，", "主", "大", "力", "量。", "啊"];
        let mut ms = Vec::new();
        for (mi, w) in words.chunks(4).enumerate() {
            let cs = w.iter().enumerate().map(|(k, t)| chord(["1", "2", "3", "5"][k], 1.0, 1.0, k as f64, t)).collect();
            let mut m = measure(cs);
            if mi == 5 {
                m.barline = Some("light-heavy".into());
            }
            ms.push(m);
        }
        PhrasePart { measures: ms }
    }

    #[test]
    fn breaks_small_song() {
        let part = song();
        let b = compute_phrase_breaks(&part, &PhraseOptions::default());
        assert!(!b.cuts.is_empty());
        assert!(b.measure_breaks.iter().all(|&mi| mi > 0 && mi <= part.measures.len()));
        let book = PhraseOptions {
            content_only: Some(true),
            even_weight: Some(1.0),
            parallel_weight: Some(6.0),
            tail_weight: Some(1.0),
            short_sentence_words: Some(5.0),
            more_rows_slack: Some(3.0),
            page_lines: Some(4.0),
            fit: Some(FitMetric { width: 100.0, spans: (0..24).map(|i| Some(Span { x0: i as f64 * 10.0, x1: i as f64 * 10.0 + 8.0, x1b: None })).collect() }),
            ..Default::default()
        };
        let b2 = compute_phrase_breaks(&part, &book);
        assert_eq!(b2.cuts.len(), b.cuts.len());
        assert_eq!(target_meas_for_cells(&part, 16.0), 4.0);
        // 单小节、空谱不断
        assert_eq!(compute_phrase_breaks(&PhrasePart { measures: vec![] }, &PhraseOptions::default()), PhraseBreaks::default());
    }

    #[test]
    fn fit_span_lookup() {
        let fit = FitMetric { width: 300.0, spans: vec![None, Some(Span { x0: 1.0, x1: 2.0, x1b: None })] };
        assert!(fit.span(-1).is_none() && fit.span(0).is_none() && fit.span(5).is_none());
        assert_eq!(fit.span(1).unwrap().x1, 2.0);
    }
}
