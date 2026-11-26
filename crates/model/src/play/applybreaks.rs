//! 断句之后、交给排版之前的那几步（TS `jianpu/applybreaks.ts` 照搬）：容量补刀、两两并行、收拾行首行尾休止、
//! 并碎行、整首的排版模式阶梯（B 两句一行 → A 一句一行 → C 均匀）、逐行事实与按乐句行分页。
//!
//! 断点集合在 [`PhraseBreaks`] 上**原地改**（同 TS：调用方拿到的就是最终断点）；各集合按插入次序（删掉再加排到末尾，同 JS 的 `Set`）。
//! 和弦一律用拍平下标（`PhrasePart::flat_chords` 的次序）。判据与常数的来历见各函数注释——那些数是拿具体曲子换来的，别照直觉改。

use crate::play::phrase::{head_fp_of, lyric_punct_score, main_lyric_text, CapKey, CutCandidate, FitMetric, PhraseBreaks};
use crate::play::phraseinput::{PhraseChord, PhrasePart};
use crate::base::js;
use serde::Serialize;

// ───────────────────────── 按插入次序的集合（同 JS `Set`） ─────────────────────────

fn has<T: PartialEq>(v: &[T], x: &T) -> bool {
    v.contains(x)
}
fn add<T: PartialEq>(v: &mut Vec<T>, x: T) {
    if !v.contains(&x) {
        v.push(x);
    }
}
fn del<T: PartialEq>(v: &mut Vec<T>, x: &T) {
    v.retain(|y| y != x);
}

/// `Math.max(...xs)`：空回 −∞，有 NaN 回 NaN
fn max_of(xs: impl IntoIterator<Item = f64>) -> f64 {
    xs.into_iter().fold(f64::NEG_INFINITY, js::max)
}
fn min_of(xs: impl IntoIterator<Item = f64>) -> f64 {
    xs.into_iter().fold(f64::INFINITY, js::min)
}

fn dur_of(c: &PhraseChord) -> f64 {
    c.duration.as_ref().map_or(0.0, |d| d.to_float())
}

/// 一个和弦占多少格（一个音符 1 格，长音的每根增时线各占 1 格）：`Math.max(1, Math.floor(c.beats) || 1)`
fn cells_of_chord(c: &PhraseChord) -> f64 {
    let f = c.beats.floor();
    js::max(1.0, if f == 0.0 || f.is_nan() { 1.0 } else { f })
}

// ───────────────────────── 常数 ─────────────────────────

/// 工整性权重：一段的时值偏离目标 20% 约值 5 分（与一个中等强度的断点凭据相当）。
const EVEN_W: f64 = 60.0;
/// 「后带小节线」的加分。与 `phrase.rs::break_cost` 里「行内弱断点 +6」同量级。
const BAR_END_BONUS: f64 = 3.0;
/// **切开之后下一行是平行乐句开头**的加分（`CutCandidate.parallel`，按公共前缀长度折算）。
/// 一行要切两半时两个候选的标点/长音凭据常常一样（144《求圣灵吹我》），「切完两行开头旋律一样」就是决定性的一票。
const PARALLEL_BONUS: f64 = 12.0;
/// 乐句凭据的倍率：补刀这一层比 DP 更该听凭据（凭据量程 0~24 按 DP 代价盘调，直接与工整项同场竞价太轻）。
const EVIDENCE_W: f64 = 4.0;
/// 切出来的两段各自不许短于原行的这个比例（时值）。
const SPLIT_MIN_FRAC: f64 = 0.3;
/// 切出来的每一段也不该短于容量的这个比例（与 D7「中间行不足容量四成」同口径）。
const SPLIT_MIN_CELLS_FRAC: f64 = 0.4;
/// 补刀的容差（版心宽度的比例）。真实坐标下应当是 0：排版器 justify 只加不减，超一点点也一定折行。
const CUT_TOL: f64 = 0.0;
/// 「工整段」的门槛：段内最短行 ÷ 最长行（按时值）到这个比例才要求整段一起断。
const UNIFORM_RATIO: f64 = 0.8;
/// 「本来就一样满」——跨段跟着切那一步的门槛（按行宽比）。
const SAME_WIDTH_RATIO: f64 = 0.97;
/// k 不够就加 k：60 格 / 容量 30 要求切得分毫不差，让 k 往上找两格（224《献上你虔诚的祈祷》）。
const K_SLACK: usize = 2;

// ───────────────────────── 拍平序列与尺子 ─────────────────────────

/// 全曲拍平的和弦序列 + 前缀量（格数/时值）。
struct FlatBook<'a> {
    chords: Vec<&'a PhraseChord>,
    /// 每个和弦是不是所在小节的最后一个
    is_last: Vec<bool>,
    cell_upto: Vec<f64>,
    dur_upto: Vec<f64>,
}

fn flatten_book(part: &PhrasePart) -> FlatBook<'_> {
    let mut chords = Vec::new();
    let mut is_last = Vec::new();
    for m in &part.measures {
        let n = m.chords.len();
        for (k, c) in m.chords.iter().enumerate() {
            chords.push(c);
            is_last.push(k + 1 == n);
        }
    }
    let mut cell_upto = vec![0.0];
    let mut dur_upto = vec![0.0];
    for (i, c) in chords.iter().enumerate() {
        cell_upto.push(cell_upto[i] + cells_of_chord(c));
        dur_upto.push(dur_upto[i] + dur_of(c));
    }
    FlatBook { chords, is_last, cell_upto, dur_upto }
}

/// 「放不放得下」的两把尺子：有真实坐标就用它，没有就退回按格数估。
struct Fit<'a> {
    metric: Option<&'a FitMetric>,
    cells: f64,
    book: FlatBook<'a>,
}

impl<'a> Fit<'a> {
    fn new(metric: Option<&'a FitMetric>, cells: f64, part: &'a PhrasePart) -> Fit<'a> {
        Fit { metric, cells, book: flatten_book(part) }
    }
    /// 版心「装得下多少」的量纲：真实坐标下是宽度，退化时是格数。
    fn capacity(&self) -> f64 {
        self.metric.map_or(self.cells, |m| m.width)
    }
    fn on(&self) -> bool {
        self.capacity() > 0.0
    }
    fn of_line(&self, l: &LineInfo) -> f64 {
        self.span_of(l.from as i64, l.to as i64, false)
    }
    /// 拍平序列里 `[from, to]`（含端点）有多宽；`with_bar` 量到行末小节线（与 `capacity` 比时用）。
    fn span_of(&self, from: i64, to: i64, with_bar: bool) -> f64 {
        if from > to {
            return 0.0;
        }
        if let Some(m) = self.metric {
            let in_range = |i: i64| i >= 0 && (i as usize) < self.book.chords.len();
            let a = if in_range(from) { m.span(from) } else { None };
            let z = if in_range(to) { m.span(to) } else { None };
            if let (Some(a), Some(z)) = (a, z) {
                return (if with_bar { z.x1b.unwrap_or(z.x1) } else { z.x1 }) - a.x0;
            }
        }
        let at = |i: i64| if i >= 0 { self.book.cell_upto.get(i as usize).copied().unwrap_or(f64::NAN) } else { f64::NAN };
        at(to + 1) - at(from)
    }
    fn fit_of(&self, from: i64, to: i64) -> f64 {
        self.span_of(from, to, true)
    }
    fn fit_line(&self, l: &LineInfo) -> f64 {
        self.fit_of(l.from as i64, l.to as i64)
    }
}

// ───────────────────────── 逐行事实 ─────────────────────────

/// 一行的行首「残小节」：从行首到第一条小节线之间的那点内容。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineHead {
    /// 残小节的时值（整小节起头时就是该小节的全长）
    pub dur: f64,
    /// 行首是不是小节起点
    pub full: bool,
    /// 残小节里有没有音符
    pub has_note: bool,
    /// 残小节占多少格
    pub cells: f64,
    pub rest: bool,
    pub beams: f64,
    pub first_beats: f64,
    pub first_dur: f64,
    /// 行首第一个和弦的歌词标点分（带标点的长音是上一句的收尾，不该出现在行首）
    pub first_punct: f64,
    /// 行首第一个和弦的主歌词
    pub text: String,
}

/// 一行的行末：最后一个和弦的歌词末字与其标点分。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineTail {
    pub text: String,
    pub punct: f64,
    pub beats: f64,
    /// 行末往前最近的那个有词的字
    pub last_word: String,
    pub last_word_punct: f64,
    /// 行末的残小节里只有休止
    pub rest_only_bar: bool,
    /// 行末残小节的时值（`rest_only_bar` 那一截有多少拍；否则 0）
    pub rest_bar_dur: f64,
}

/// 断点把曲子切成的一行。`mi` / `chord` 是这一行末尾那个断点（小节末：在第 mi 小节前换行；行内：和弦拍平下标）；末行两者皆 None。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineInfo {
    pub cells: f64,
    /// 这一行的时值（Σ 和弦时值）
    pub dur: f64,
    pub from_mi: usize,
    pub to_mi: usize,
    /// 整小节数（行内收在小节线上的次数）
    pub bars: usize,
    pub beats: f64,
    pub head: LineHead,
    pub tail: LineTail,
    /// 行首的旋律指纹：两行相同 = 平行乐句开头
    pub head_fp: String,
    pub mi: Option<usize>,
    pub chord: Option<usize>,
    /// 段界（另起一页）不可合并
    pub section: bool,
    /// 拍平序列里的下标区间（含端点）
    pub from: usize,
    pub to: usize,
    /// 行首那个断点是不是容量补刀落的
    pub from_cut: bool,
}

/// 按断点把 part 切成行，并把判断版面好坏要用的事实一并算出来（行首残小节、行末歌词标点、格数、小节数）。
pub fn describe_lines(part: &PhrasePart, breaks: &PhraseBreaks, use_mid_breaks: bool) -> Vec<LineInfo> {
    struct Fc<'a> {
        chord: &'a PhraseChord,
        idx: usize,
        mi: usize,
        k: usize,
        is_last: bool,
    }
    let mut flat: Vec<Fc> = Vec::new();
    for (i, m) in part.measures.iter().enumerate() {
        let n = m.chords.len();
        for (k, c) in m.chords.iter().enumerate() {
            flat.push(Fc { chord: c, idx: flat.len(), mi: i, k, is_last: k + 1 == n });
        }
    }
    let mut out: Vec<LineInfo> = Vec::new();
    let mut start = 0usize;
    let mut emit = |end: usize, mi: Option<usize>, chord: Option<usize>, section: bool, start: &mut usize| {
        if end < *start || *start >= flat.len() {
            return;
        }
        let seg = &flat[*start..=end.min(flat.len() - 1)];
        if seg.is_empty() {
            return;
        }
        let from = *start;
        *start = end + 1;
        let head_end = seg.iter().position(|f| f.is_last);
        let head = &seg[..head_end.map_or(seg.len(), |h| h + 1)];
        let last = &seg[seg.len() - 1];
        let first = &seg[0];
        // 行末落在延音／休止上时 `text` 是空的，往前找到最后一个有词的字
        let mut last_word = String::new();
        let mut last_word_punct = 0.0;
        for f in seg.iter().rev() {
            let t = main_lyric_text(f.chord);
            if t.is_empty() {
                continue;
            }
            last_word = t.to_string();
            last_word_punct = lyric_punct_score(f.chord);
            break;
        }
        // 行末残小节（本行内最后一条小节线之后的那一截）里有没有音符
        let mut p = seg.len() as i64 - 1;
        while p >= 0 && !seg[p as usize].is_last {
            p -= 1;
        }
        let tail_bar = &seg[(p + 1) as usize..];
        let rest_only_bar = !tail_bar.is_empty() && tail_bar.iter().all(|f| f.chord.rest);
        let rest_bar_dur = if rest_only_bar { tail_bar.iter().fold(0.0, |n, f| n + dur_of(f.chord)) } else { 0.0 };
        let from_cut = from > 0 && {
            let pf = &flat[from - 1];
            has(&breaks.capacity_cuts, &CapKey::Chord(pf.idx)) || (pf.is_last && has(&breaks.capacity_cuts, &CapKey::Measure(pf.mi + 1)))
        };
        let chords: Vec<&PhraseChord> = seg.iter().map(|f| f.chord).collect();
        out.push(LineInfo {
            cells: seg.iter().fold(0.0, |n, f| n + cells_of_chord(f.chord)),
            dur: seg.iter().fold(0.0, |n, f| n + dur_of(f.chord)),
            from_mi: first.mi,
            to_mi: last.mi,
            bars: seg.iter().filter(|f| f.is_last).count(),
            beats: seg.iter().fold(0.0, |n, f| n + f.chord.beats),
            head: LineHead {
                dur: head.iter().fold(0.0, |n, f| n + dur_of(f.chord)),
                full: first.k == 0,
                has_note: head.iter().any(|f| !f.chord.rest),
                cells: head.iter().fold(0.0, |n, f| n + cells_of_chord(f.chord)),
                rest: first.chord.rest,
                beams: first.chord.beams,
                first_beats: first.chord.beats,
                first_dur: dur_of(first.chord),
                first_punct: lyric_punct_score(first.chord),
                text: main_lyric_text(first.chord).to_string(),
            },
            tail: LineTail {
                text: main_lyric_text(last.chord).to_string(),
                punct: lyric_punct_score(last.chord),
                beats: last.chord.beats,
                last_word,
                last_word_punct,
                rest_only_bar,
                rest_bar_dur,
            },
            head_fp: head_fp_of(&chords),
            mi,
            chord,
            section,
            from,
            to: end,
            from_cut,
        });
    };
    for f in &flat {
        if use_mid_breaks && (has(&breaks.mid_breaks, &f.idx) || has(&breaks.section_cut_chords, &f.idx)) {
            emit(f.idx, None, Some(f.idx), has(&breaks.section_cut_chords, &f.idx), &mut start);
            continue;
        }
        if f.is_last && (has(&breaks.measure_breaks, &(f.mi + 1)) || has(&breaks.section_starts, &(f.mi + 1))) {
            emit(f.idx, Some(f.mi + 1), None, has(&breaks.section_starts, &(f.mi + 1)), &mut start);
        }
    }
    if !flat.is_empty() {
        emit(flat.len() - 1, None, None, false, &mut start);
    }
    out
}

/// 逐行的真实宽度（自然坐标，未 justify）与版心宽度（`rebuild.mjs` 的逐行事实用）。
/// `lines` 是各行在拍平序列里的下标区间（含端点，`LineInfo.from` / `to`）。
pub fn measure_lines(part: &PhrasePart, lines: &[(usize, usize)], fit: Option<&FitMetric>) -> (f64, Vec<f64>) {
    let f = Fit::new(fit, 0.0, part);
    (f.capacity(), lines.iter().map(|&(a, b)| f.span_of(a as i64, b as i64, false)).collect())
}

// ───────────────────────── 容量补刀 ─────────────────────────

/// 一个候选断点值多少分：乐句凭据（已减行首罚）+ 收在小节线上 + 平行乐句。「落在句号上」不另加分（试过，全书没有收益）。
fn value(c: &CutCandidate) -> f64 {
    EVIDENCE_W * c.score + (if c.is_last { BAR_END_BONUS } else { 0.0 }) + PARALLEL_BONUS * (c.parallel / 12.0)
}

/// 在第 mi 小节之前断行会不会切断一条圆滑线／连音线／反复房。
fn cuts_through_span(part: &PhrasePart, mi: usize) -> bool {
    let ms = &part.measures;
    if mi == 0 || mi >= ms.len() {
        return false;
    }
    // 反复房：房整体不可拆，只有房的收尾处才能断
    let mut in_ending = false;
    for m in &ms[..mi] {
        if m.ending_left {
            in_ending = true;
        }
        if m.ending_right.is_some() {
            in_ending = false;
        }
    }
    if in_ending {
        return true;
    }
    // 弧线：上一小节最后一个和弦起了弧／连音线，而本小节头一个和弦收它
    let (Some(a), Some(b)) = (ms[mi - 1].chords.last(), ms[mi].chords.first()) else { return false };
    if a.slur_start && b.slur_ends > 0.0 {
        return true;
    }
    matches!((a.notes.first(), b.notes.first()), (Some(x), Some(y)) if x.tie_start && y.tie_end)
}

/// 一行内部的落点选择：把 `[from, to]` 这一行切成 k 段，返回 k−1 个落点（一次 DP 把落点一起挑：工整项与乐句凭据同场竞价；
/// 容量是不可行标记，`allow_soft` 时整条行怎么切都超就退化成软罚，保证总有解）。
#[allow(clippy::too_many_arguments)]
fn pick_cuts(part: &PhrasePart, line: &LineInfo, k: usize, breaks: &PhraseBreaks, f: &Fit, use_mid_breaks: bool, avoid_spans: bool, allow_soft: bool) -> Vec<CutCandidate> {
    if k <= 1 {
        return vec![];
    }
    let dur_upto = &f.book.dur_upto;
    let cells = f.capacity();
    let mut pool: Vec<(&CutCandidate, usize)> = Vec::new();
    for cand in &breaks.cuts {
        let i = cand.chord;
        if i <= line.from || i >= line.to {
            continue;
        }
        if !cand.is_last && !use_mid_breaks {
            continue;
        }
        if cand.is_last && avoid_spans && cuts_through_span(part, cand.mi + 1) {
            continue;
        }
        pool.push((cand, i));
    }
    let du = |i: i64| if i >= 0 { dur_upto.get(i as usize).copied().unwrap_or(f64::NAN) } else { f64::NAN };
    let cells_of_seg = |a: i64, b: i64| f.span_of(a + 1, b, false);
    let dur_of_seg = |a: i64, b: i64| du(b + 1) - du(a + 1);
    let total = dur_of_seg(line.from as i64 - 1, line.to as i64);
    let kf = k as f64;
    let target = total / kf;
    let min_dur = total * SPLIT_MIN_FRAC * (2.0 / kf);
    let min_cells = if cells > 0.0 { cells * SPLIT_MIN_CELLS_FRAC } else { 0.0 };
    if pool.is_empty() {
        return vec![];
    }
    let seg_cost = |a: i64, b: i64, hard: bool| -> f64 {
        let d = dur_of_seg(a, b);
        let c = cells_of_seg(a, b);
        if d < min_dur {
            return f64::INFINITY;
        }
        let mut v = if target > 0.0 {
            let r = (d - target) / target;
            EVEN_W * (r * r)
        } else {
            0.0
        };
        // 「切出来的一半不足版心四成」是硬闸（与 D7 同口径）：试过改成重罚，全书 D7 立刻 0 → 18~38 处——别再试
        if hard && min_cells > 0.0 && c < min_cells {
            return f64::INFINITY;
        }
        let over = f.fit_of(a + 1, b) - cells;
        if cells > 0.0 && over > 0.0 {
            if hard {
                return f64::INFINITY;
            }
            v += 100.0 + over * over * 8.0;
        }
        v
    };
    let run = |hard: bool| -> Option<Vec<CutCandidate>> {
        let n = pool.len();
        let mut dp = vec![vec![f64::INFINITY; n]; k - 1];
        let mut from = vec![vec![-1i64; n]; k - 1];
        for t in 0..n {
            dp[0][t] = seg_cost(line.from as i64 - 1, pool[t].1 as i64, hard) - value(pool[t].0);
        }
        for j in 1..k - 1 {
            for t in 0..n {
                for u in 0..t {
                    if !dp[j - 1][u].is_finite() {
                        continue;
                    }
                    let v = dp[j - 1][u] + seg_cost(pool[u].1 as i64, pool[t].1 as i64, hard) - value(pool[t].0);
                    if v < dp[j][t] {
                        dp[j][t] = v;
                        from[j][t] = u as i64;
                    }
                }
            }
        }
        let mut best = f64::INFINITY;
        let mut best_t: i64 = -1;
        for t in 0..n {
            if !dp[k - 2][t].is_finite() {
                continue;
            }
            let v = dp[k - 2][t] + seg_cost(pool[t].1 as i64, line.to as i64, hard);
            if v < best {
                best = v;
                best_t = t as i64;
            }
        }
        if best_t < 0 || !best.is_finite() {
            return None;
        }
        let mut out: Vec<CutCandidate> = Vec::new();
        let mut j = k as i64 - 2;
        let mut t = best_t;
        while j >= 0 && t >= 0 {
            out.insert(0, pool[t as usize].0.clone());
            t = from[j as usize][t as usize];
            j -= 1;
        }
        Some(out)
    };
    run(true).or_else(|| if allow_soft { run(false) } else { None }).unwrap_or_default()
}

/// 容量补刀的选项（TS `applyCapacityCuts` 的 `opt`）。
pub struct CapacityOptions<'a> {
    /// 行长目标（小节数；0 = 不按小节数设闸）
    pub target_meas: f64,
    pub use_mid_breaks: bool,
    /// 不选会切断圆滑线／反复房的小节线（C 档）
    pub avoid_spans: bool,
    pub fit: Option<&'a FitMetric>,
}

/// **容量补刀**：一行放不下就在它内部切开，落点由 `pick_cuts` 按乐句凭据 + 工整性挑。
/// 工整的段落整段一起断（同一个 k）；别的段切了、本来就一样满的行跟着切；其余放不下的行各自补刀。只拆一轮。
pub fn apply_capacity_cuts(part: &PhrasePart, breaks: &mut PhraseBreaks, cells: f64, opt: &CapacityOptions) {
    let use_mid_breaks = opt.use_mid_breaks;
    let avoid_spans = opt.avoid_spans;
    let f = Fit::new(opt.fit, cells, part);
    if part.measures.is_empty() || !f.on() {
        return;
    }
    // 小节数也设一道闸：真实坐标只管宽度，管不到「九小节一行」（006 的主歌）
    let target_meas = opt.target_meas;
    let hard_meas = if target_meas > 0.0 { js::max(target_meas + 1.0, (target_meas * 1.5).ceil()) } else { 0.0 };
    let lines = describe_lines(part, breaks, use_mid_breaks);
    let cap = f.capacity();
    let k_of = |l: &LineInfo| -> f64 {
        let w = f.fit_line(l);
        js::max(
            if w >= cap * (1.0 + CUT_TOL) { js::max(2.0, (w / cap).ceil()) } else { 1.0 },
            if hard_meas > 0.0 { (l.bars as f64 / hard_meas).ceil() } else { 1.0 },
        )
    };
    let write = |breaks: &mut PhraseBreaks, cand: &CutCandidate| {
        if cand.is_last {
            add(&mut breaks.measure_breaks, cand.mi + 1);
            add(&mut breaks.capacity_cuts, CapKey::Measure(cand.mi + 1));
        } else {
            add(&mut breaks.mid_breaks, cand.chord);
            add(&mut breaks.capacity_cuts, CapKey::Chord(cand.chord));
        }
    };
    // 按段分组（段界 = 该行的行末是段界），与 line-check 的 D8 同一口径
    let mut segs: Vec<Vec<usize>> = vec![vec![]];
    for (i, l) in lines.iter().enumerate() {
        segs.last_mut().unwrap().push(i);
        if l.section {
            segs.push(vec![]);
        }
    }
    let cuts_for = |breaks: &PhraseBreaks, l: &LineInfo, k: usize, allow_soft: bool| pick_cuts(part, l, k, breaks, &f, use_mid_breaks, avoid_spans, allow_soft);
    let as_k = |x: f64| if x.is_finite() && x > 0.0 { x as usize } else { 0 };

    let mut done = vec![false; lines.len()];
    let mut cut_as: Vec<(f64, usize)> = Vec::new();
    for seg in &segs {
        if seg.len() < 2 {
            continue;
        }
        if !seg.iter().any(|&i| k_of(&lines[i]) > 1.0) {
            continue;
        }
        let lo = min_of(seg.iter().map(|&i| lines[i].dur));
        let hi = max_of(seg.iter().map(|&i| lines[i].dur));
        if !(hi > 0.0 && lo / hi >= UNIFORM_RATIO) {
            continue;
        }
        let k0 = as_k(js::max(2.0, max_of(seg.iter().map(|&i| k_of(&lines[i])))));
        let mut picks: Option<Vec<Vec<CutCandidate>>> = None;
        let mut used = 0;
        let mut k = k0;
        while k <= k0 + K_SLACK && picks.is_none() {
            let got: Vec<Vec<CutCandidate>> = seg.iter().map(|&i| cuts_for(breaks, &lines[i], k, false)).collect();
            if got.iter().all(|p| p.len() + 1 == k) {
                picks = Some(got);
                used = k;
            }
            k += 1;
        }
        let Some(picks) = picks else { continue };
        for p in &picks {
            for c in p {
                write(breaks, c);
            }
        }
        for &i in seg {
            done[i] = true;
        }
        for &i in seg {
            cut_as.push((f.of_line(&lines[i]), used));
        }
    }
    // 别的段切了，本来就一样满的这一行也得跟着切（446《迦勒看见主》）；按行宽比，门槛比段内严
    if !cut_as.is_empty() {
        for (i, l) in lines.iter().enumerate() {
            if done[i] {
                continue;
            }
            let lw = f.of_line(l);
            let Some(&(_, mk)) = cut_as.iter().find(|&&(w, _)| lw > 0.0 && w > 0.0 && js::min(w, lw) / js::max(w, lw) >= SAME_WIDTH_RATIO) else { continue };
            let p = cuts_for(breaks, l, mk, false);
            if p.len() + 1 != mk {
                continue;
            }
            for c in &p {
                write(breaks, c);
            }
            done[i] = true;
        }
    }
    for (i, l) in lines.iter().enumerate() {
        if done[i] {
            continue;
        }
        let kl = k_of(l);
        if kl <= 1.0 {
            continue;
        }
        // k 不够就加 k；怎么切都放不下（容量给死了）→ 退让，至少切开
        let k0 = as_k(kl);
        let mut best: Option<Vec<CutCandidate>> = None;
        for k in k0..=k0 + K_SLACK {
            let p = cuts_for(breaks, l, k, false);
            if p.len() + 1 == k {
                best = Some(p);
                break;
            }
        }
        let best = best.unwrap_or_else(|| cuts_for(breaks, l, k0, true));
        for c in &best {
            write(breaks, c);
        }
    }
}

/// 容量保险（成书老路）：放不下的行按乐句子句断点切开。
pub fn enforce_line_capacity(part: &PhrasePart, breaks: &mut PhraseBreaks, cells: f64, target_meas: f64, use_mid_breaks: bool, fit: Option<&FitMetric>) {
    apply_capacity_cuts(part, breaks, cells, &CapacityOptions { target_meas, use_mid_breaks, avoid_spans: false, fit });
}

// ───────────────────────── 收拾行首行尾、并行 ─────────────────────────

/// **行首不留半个小节的休止**：一行从「休止 + 小节线」起头时，把那点休止并到上一行去（并过去放不下就不并）。回挪了几行。
pub fn tidy_line_heads(part: &PhrasePart, breaks: &mut PhraseBreaks, use_mid_breaks: bool, cells: f64, fit: Option<&FitMetric>) -> usize {
    let f = Fit::new(fit, cells, part);
    let lines = describe_lines(part, breaks, use_mid_breaks);
    let mut moved = 0;
    for i in 1..lines.len() {
        let prev = &lines[i - 1];
        let cur = &lines[i];
        if cur.head.has_note || prev.section {
            continue;
        }
        if cur.from_mi == cur.to_mi && cur.bars == 0 {
            continue;
        }
        // 并过去的只是行首那个残小节，不是整行（282《我的灯需要油》）
        let mut head_end = cur.from;
        while head_end < cur.to && !f.book.is_last[head_end] {
            head_end += 1;
        }
        if f.on() && f.fit_of(prev.from as i64, head_end as i64) >= f.capacity() {
            continue;
        }
        if let Some(mi) = prev.mi {
            del(&mut breaks.measure_breaks, &mi);
        }
        if let Some(c) = prev.chord {
            del(&mut breaks.mid_breaks, &c);
        }
        add(&mut breaks.measure_breaks, cur.from_mi + 1);
        moved += 1;
    }
    moved
}

/// **行末不留半个小节的休止**：一行收在「小节线 + 只有休止」的残小节上时，把那点休止推到下一行去（与 `tidy_line_heads` 对称）。回推了几行。
pub fn tidy_line_tails(part: &PhrasePart, breaks: &mut PhraseBreaks, use_mid_breaks: bool, cells: f64, fit: Option<&FitMetric>) -> usize {
    let f = Fit::new(fit, cells, part);
    let lines = describe_lines(part, breaks, use_mid_breaks);
    let mut moved = 0;
    for i in 0..lines.len().saturating_sub(1) {
        let cur = &lines[i];
        let next = &lines[i + 1];
        if !cur.tail.rest_only_bar || cur.section || next.section {
            continue;
        }
        let mut bar_start = cur.to;
        while bar_start > cur.from && !f.book.is_last[bar_start - 1] {
            bar_start -= 1;
        }
        if bar_start <= cur.from {
            continue;
        }
        if f.on() && f.fit_of(bar_start as i64, next.to as i64) >= f.capacity() {
            continue;
        }
        if let Some(mi) = cur.mi {
            del(&mut breaks.measure_breaks, &mi);
        }
        if let Some(c) = cur.chord {
            del(&mut breaks.mid_breaks, &c);
        }
        // 新断点落在那个残小节之前
        add(&mut breaks.measure_breaks, cur.to_mi);
        moved += 1;
    }
    moved
}

/// **每两句并一行**（B 档）：全首一个口径，段内从头起两两并；并出来的行末必须仍是乐句边界（标点或长音），
/// 有一对并不成就整档放弃（回 0）。回并掉的断点数。
pub fn merge_pairs_uniform(part: &PhrasePart, breaks: &mut PhraseBreaks, use_mid_breaks: bool) -> usize {
    let lines = describe_lines(part, breaks, use_mid_breaks);
    let can_pair_at = |i: usize| -> bool {
        let a = &lines[i];
        let Some(b) = lines.get(i + 1) else { return false };
        if a.section {
            return false;
        }
        if let Some(mi) = a.mi {
            if has(&breaks.forced, &mi) {
                return false;
            }
        }
        if a.mi.is_none() && a.chord.is_none() {
            return false;
        }
        let b_is_last = i + 1 == lines.len() - 1;
        b_is_last || b.tail.punct > 0.0 || b.tail.beats >= 2.0 || b.tail.last_word_punct > 0.0
    };
    let mut i = 0;
    while i + 1 < lines.len() {
        if !can_pair_at(i) {
            return 0;
        }
        i += 2;
    }
    let mut merged = 0;
    let mut i = 0;
    while i + 1 < lines.len() {
        let a = &lines[i];
        if let Some(mi) = a.mi {
            del(&mut breaks.measure_breaks, &mi);
        }
        if let Some(c) = a.chord {
            del(&mut breaks.mid_breaks, &c);
        }
        merged += 1;
        i += 2;
    }
    merged
}

/// 每行放得下、中间没有碎行——`choose_line_layout` 判「这一档可不可行」的两条。
fn lines_are_ok(lines: &[LineInfo], f: &Fit) -> bool {
    for (i, l) in lines.iter().enumerate() {
        if f.on() && f.fit_line(l) >= f.capacity() {
            return false;
        }
        if i + 1 < lines.len() && !l.section && l.bars <= 1 && l.beats < (if l.head.full { 4.0 } else { 8.0 }) {
            return false;
        }
    }
    true
}

/// **碎行并回上一行**：只剩一小节、又唱不满一句的行。段界与 `forced` 不动，并过去放不下就维持原判。回并掉的断点数。
pub fn merge_sliver_lines(part: &PhrasePart, breaks: &mut PhraseBreaks, use_mid_breaks: bool, cells: f64, fit: Option<&FitMetric>) -> usize {
    let lines = describe_lines(part, breaks, use_mid_breaks);
    let f = Fit::new(fit, cells, part);
    let mut merged = 0;
    for i in 1..lines.len() {
        let prev = &lines[i - 1];
        let cur = &lines[i];
        if prev.section {
            continue;
        }
        if cur.bars > 1 || cur.beats >= (if cur.head.full { 4.0 } else { 8.0 }) {
            continue;
        }
        if let Some(mi) = prev.mi {
            if has(&breaks.forced, &mi) {
                continue;
            }
        }
        if f.on() && f.fit_of(prev.from as i64, cur.to as i64) >= f.capacity() {
            continue;
        }
        if let Some(mi) = prev.mi {
            del(&mut breaks.measure_breaks, &mi);
        } else if let Some(c) = prev.chord {
            del(&mut breaks.mid_breaks, &c);
        } else {
            continue;
        }
        merged += 1;
    }
    merged
}

/// **均匀排版**（C 档）：在乐句断点的基础上，放不下的行在内部补刀（不切圆滑线／反复房），补出来的碎行并回上一行。
fn even_layout(part: &PhrasePart, breaks: &PhraseBreaks, cells: f64, fit: Option<&FitMetric>) -> PhraseBreaks {
    let mut out = breaks.clone();
    if !Fit::new(fit, cells, part).on() || part.measures.is_empty() {
        return out;
    }
    apply_capacity_cuts(part, &mut out, cells, &CapacityOptions { target_meas: 0.0, use_mid_breaks: true, avoid_spans: true, fit });
    merge_sliver_lines(part, &mut out, true, cells, fit);
    out
}

/// 整首选中的排版档。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LayoutMode {
    /// 每 2 句一行
    Pairs,
    /// 按乐句排版（断点原样用）
    Phrase,
    /// 均匀排版
    Even,
}

/// **整首的排版模式阶梯**：B（两句一行，只在一句一行明显太稀时考虑）→ A（一句一行）→ C（均匀）取第一个可行的，
/// 选中的那一档写回 `breaks`。
pub fn choose_line_layout(part: &PhrasePart, breaks: &mut PhraseBreaks, cells: f64, use_mid_breaks: bool, allow_pairs: bool, fit: Option<&FitMetric>) -> LayoutMode {
    let f = Fit::new(fit, cells, part);
    let write = |breaks: &mut PhraseBreaks, from: &PhraseBreaks| {
        breaks.measure_breaks = from.measure_breaks.clone();
        breaks.mid_breaks = from.mid_breaks.clone();
        // 补刀记号也要写回：不带回来的话 `LineInfo.from_cut` 全是 false，line-check 的 D2 豁免就用不上
        breaks.capacity_cuts = from.capacity_cuts.clone();
    };
    let phrase = breaks.clone();
    let phrase_lines = describe_lines(part, &phrase, use_mid_breaks);
    // 只在一句一行明显太稀时才考虑两句一行（中位行长不到版心六成）
    let mut cs: Vec<f64> = phrase_lines.iter().map(|l| f.of_line(l)).collect();
    js::sort_num(&mut cs);
    let med_cells = if cs.is_empty() { 0.0 } else { cs[cs.len() / 2] };
    let sparse = f.on() && med_cells > 0.0 && med_cells < f.capacity() * 0.6;
    if allow_pairs && sparse {
        let mut pairs = breaks.clone();
        let merged = merge_pairs_uniform(part, &mut pairs, use_mid_breaks);
        // 并完也要真实排一遍：放不下就保持原版
        if merged > 0 && lines_are_ok(&describe_lines(part, &pairs, use_mid_breaks), &f) {
            write(breaks, &pairs);
            return LayoutMode::Pairs;
        }
    }
    if lines_are_ok(&phrase_lines, &f) {
        return LayoutMode::Phrase;
    }
    let even = even_layout(part, &phrase, cells, fit);
    write(breaks, &even);
    LayoutMode::Even
}

// ───────────────────────── 分页 ─────────────────────────

/// **乐句行 → 换页行号**（`.jpwabc` 与文本谱共用同一套口径）：段内按每页至多 `page_lines` 行分；只有 1 行的段并入下一段；
/// 段界换页是「放不下才换」；末页仅剩 1 行的 4+1 改成 3+2。回 1 基行号（该行行尾换页，末行必定在内），按插入次序。
pub fn page_break_lines(lines: usize, section_ends: &[usize], page_lines: usize) -> Vec<usize> {
    let mut page_at: Vec<usize> = Vec::new();
    if lines == 0 {
        return page_at;
    }
    let mut ends: Vec<usize> = section_ends.iter().copied().filter(|&n| n > 0 && n < lines).collect();
    ends.sort_unstable();
    let mut raw_bounds = vec![0];
    raw_bounds.extend(ends);
    raw_bounds.push(lines);
    let mut merged = vec![raw_bounds[0]];
    for i in 1..raw_bounds.len() {
        if i < raw_bounds.len() - 1 && raw_bounds[i] < 2 + merged[merged.len() - 1] {
            continue;
        }
        merged.push(raw_bounds[i]);
    }
    let mut bounds = vec![merged[0]];
    for i in 1..merged.len() {
        let start = bounds[bounds.len() - 1];
        if merged[i] - start > page_lines && merged[i - 1] > start {
            bounds.push(merged[i - 1]);
        }
    }
    let last = merged[merged.len() - 1];
    if bounds[bounds.len() - 1] != last {
        bounds.push(last);
    }
    for s in 0..bounds.len() - 1 {
        let beg = bounds[s];
        let len = bounds[s + 1] - beg;
        if page_lines > 0 {
            let mut p = page_lines;
            while p < len {
                add(&mut page_at, beg + p);
                p += page_lines;
            }
        }
        add(&mut page_at, beg + len);
        if page_lines > 0 && len % page_lines == 1 && len > page_lines {
            del(&mut page_at, &(beg + len - 1));
            add(&mut page_at, beg + len - 2);
        }
    }
    page_at
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_lines_four_plus_one() {
        // 5 行一段：4+1 → 3+2
        assert_eq!(page_break_lines(5, &[], 4), vec![5, 3]);
        // 主歌 2 + 副歌 2 正好一页：段界不换页
        assert_eq!(page_break_lines(4, &[2], 4), vec![4]);
        // 主歌 4 + 副歌 4 放不下：段界换页
        assert_eq!(page_break_lines(8, &[4], 4), vec![4, 8]);
    }
}
