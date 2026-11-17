//! 横向 / 分系统 / 纵向（照 `layoutpass.ts`）。**接口约定**（分身各自实现，签名不改）：
//! 读入（`read`）用 `bar_glyph_from_style` / `met_note_glyph` / `parse_ending_nums` 与输入类型、末尾调 `finish_mixed_score`；
//! 装页（`pages`）用 `auto_staff_distances`。
//!
//! TS 里按对象作键的两张表（`slotCache: WeakMap<StaffLayout, Slot[][]>`、`squeezeOf: WeakMap<MeasureLayout, Squeeze>`）
//! 放进 `StaffLayout::pass_cache`（[`PassCache`]，按小节下标）：节奏槽头一回算时会动音符 x（`entryReach`），
//! 之后都走缓存，缓存得跟着这份谱走，`staff_chord_spans` 在排完之后再问也不重算。

// 照 TS 的写法（按下标走表、先声明后赋值），便于逐行对照
#![allow(clippy::needless_range_loop, clippy::too_many_arguments)]

use std::collections::{BTreeSet, HashMap, HashSet};

use dolce_base::fraction::Fraction;
use dolce_base::js;
use dolce_engrave::syllable::latin_word_break;
use dolce_model::doc::{Oid, Placement};
use dolce_model::xmlsurface::Position;
use dolce_text::Font;

use crate::model::*;

/// `<print>` 里的 `<system-layout>`（`PrintInput.systemLayout`）
#[derive(Clone, Debug, Default)]
pub struct SystemLayoutInput {
    /// `margins`：None = TS 的 null；内层 left / right 各自可缺
    pub margins: Option<(Option<f64>, Option<f64>)>,
    pub top_system_distance: Option<f64>,
    pub system_distance: Option<f64>,
}

/// `<staff-layout>`：`number` 为 1 基谱表号
#[derive(Clone, Debug, Default)]
pub struct StaffLayoutInput {
    pub number: i64,
    pub staff_distance: Option<f64>,
}

#[derive(Clone, Debug, Default)]
pub struct PrintInput {
    pub new_page: bool,
    pub new_system: bool,
    pub system_layout: Option<SystemLayoutInput>,
    pub staff_layouts: Vec<StaffLayoutInput>,
}

/// `<staff-details>`：`number` 为 1 基谱表号，`print_object` 为属性原文（缺省 None）
#[derive(Clone, Debug, Default)]
pub struct StaffDetailInput {
    pub number: i64,
    pub print_object: Option<String>,
}

/// 一个声部的一个小节里，版面那几步要读的东西
#[derive(Clone, Debug, Default)]
pub struct MeasureLayoutInput {
    pub prints: Vec<PrintInput>,
    pub staff_details: Vec<StaffDetailInput>,
}

/// 声部 → 小节 → 版面输入
pub type LayoutInput = Vec<Vec<MeasureLayoutInput>>;

/// 对拍取中间 dump 的探针（`read` / `systems` 两处）
pub type Probe<'p> = &'p mut dyn FnMut(&str, &StaffLayout);

// ---------------- Barline ----------------

pub fn bar_glyph_from_style(style: &str) -> Option<BarGlyph> {
    match style {
        "regular" => Some(BarGlyph::Single),
        "light-light" => Some(BarGlyph::Double),
        "light-heavy" => Some(BarGlyph::Final),
        "heavy-light" => Some(BarGlyph::ReverseFinal),
        "heavy-heavy" => Some(BarGlyph::HeavyHeavy),
        "none" => Some(BarGlyph::None),
        _ => None,
    }
}

/// `<beat-unit>` 音符类型 → 节拍记号字形，对齐 loader.cpp::makeMetronomeStr（仅四分音符）。
pub fn met_note_glyph(note_type: &str) -> String {
    // musicpp 只实现了四分音符；其余暂以四分音符字形兜底（TS 另打一句 console.warn）
    let _ = note_type;
    gs("metNoteQuarterUp")
}

/// TS 回 `Set<number>`（插入序）
pub fn parse_ending_nums(s: &str) -> Vec<i64> {
    let mut res: Vec<i64> = Vec::new();
    for part in s.split(',') {
        let n = js::parse_int(js::trim(part), 10);
        if !n.is_nan() {
            let v = n as i64;
            if !res.contains(&v) {
                res.push(v);
            }
        }
    }
    res
}

// ---------------- Layout pass ----------------

// 每音符按时值给一个"槽宽"（tenths）。时值越长间距越大（近似 Gould 的次线性增长）。
const AUTO_MIN_SLOT: f64 = 22.0;
const AUTO_END_PAD: f64 = 16.0; // 末音符到小节线的余量
const AUTO_LEFT_DATA: f64 = 16.0; // 小节左侧到首音符的名义留白（折行用的自然宽）
const AUTO_NOTE_PAD: f64 = 8.0; // 铺开音符时两端留白
const AUTO_LYRIC_SPACE: f64 = 6.0; // 相邻两个字之间至少留的空
const AUTO_HARMONY_SPACE: f64 = 8.0; // 相邻两个和弦符号之间至少留的空
/// 源谱版面档过满的行压到这么窄为止
const SQUEEZE_MIN_SLOT: f64 = 16.0;
/// 第二档的音符最小格
const HARD_MIN_SLOT: f64 = 13.0;
/// 第二档相邻两个字之间留的空
const HARD_LYRIC_SPACE: f64 = 2.0;
/// 第二档小节两头的留白
const HARD_MEASURE_PAD: f64 = 12.0;
/// 墨迹右缘到下一个音（没有临时记号时）至少留的空
const INK_CLEAR: f64 = 3.0;
/// 自动铺排：符干朝下的和弦，临时记号离那根贴在符头左缘的干再多让这么多
const ACC_DOWNSTEM_CLEAR: f64 = 2.0;
/// 压缩时下一个音的临时记号离本拍位墨迹留的空
const ACC_STEM_CLEAR: f64 = 5.0;
/// 第三档（最紧）
const TIGHT_MIN_SLOT: f64 = 12.0;
const TIGHT_INK_CLEAR: f64 = 1.5;
const TIGHT_ACC_CLEAR: f64 = 3.5;
const TIGHT_MEASURE_PAD: f64 = 4.0;
/// 压紧的行里行首谱号调号右缘到首音的净空
const TIGHT_ATTR_GAP: f64 = 6.0;
const AUTO_GRACE_STEP: f64 = 14.0; // 倚音一个占多宽
const AUTO_GRACE_GAP: f64 = 14.0; // 最靠近主音的那个倚音与主音之间再多留的空

/// 临时记号左缘离前一个音右缘至少留这么多（tenths）
const AUTO_ACC_CLEAR: f64 = 4.0;
/// 一个附点（连同它前面的空）占的宽，tenths
const AUTO_DOT_STEP: f64 = 6.0;
/// 两个不同声部的音挨得再近也要留的距离
const AUTO_CROSS_VOICE_GAP: f64 = 12.0;

// 断行的代价（整体最优，见 autoLayoutWidths）
/// 在简谱没换行的地方断行
const BREAK_OFF_PREFERRED: f64 = 0.4;
/// 跨过一处简谱换行（把两行并成一行）
const BREAK_MERGE: f64 = 0.35;
/// 末行最多拉伸到自然宽的几倍
const LAST_LINE_MAX_STRETCH: f64 = 1.6;
/// 填不到一半的行代价加重
const UNDERFULL: f64 = 3.0;
/// 末行填不到这么多才算代价
const LAST_LINE_MIN_FILL: f64 = 0.5;

const AUTO_WEDGE_GAP: f64 = 8.0; // 谱表下方最低处到松叶上缘的净空

/// 照原位放的记号让开歌词时，离字底的空
const SOURCE_MARK_GAP: f64 = 4.0;
const DYNAMIC_LYRIC_GAP: f64 = 6.0; // 力度记号右缘到歌词字左缘
const DYNAMIC_BELOW_GAP: f64 = 6.0; // 谱表下方最低处到力度记号顶
const DYNAMIC_ASCENT: f64 = 14.0; // 力度字形基线以上的高

const AUTO_TITLE_FS: f64 = 20.0; // pt
const AUTO_CREDIT_FS: f64 = 11.0; // pt
const AUTO_LYRIC_GAP: f64 = 10.0; // 音符/符干/弧最低点到首行歌词字顶的净空
const AUTO_LYRIC_STAFF_GAP: f64 = 20.0; // 谱表底线到首行歌词字顶至少留的距离
const SOURCE_LYRIC_STAFF_GAP: f64 = 10.0; // 源谱版面档
const AUTO_LYRIC_ROW: f64 = 22.0; // 相邻 verse 行距的下限
const AUTO_DIRECTION_Y: f64 = 46.0; // 速度记号默认高度（谱表上方）
const AUTO_STAFF_GAP: f64 = 12.0; // 上一谱表最低处到下一谱表最高处的净空
const AUTO_ATTR_GAP: f64 = 16.0; // 行首小节谱号/调号/拍号右缘到首音符的额外净空

/// 节奏槽（TS `Slot`）。`min`：槽宽里压不掉的那截；`hard` / `tight`：第二、三档的底
#[derive(Clone, Copy, Debug)]
pub struct Slot {
    pub offset: Fraction,
    pub nat: f64,
    pub slot: f64,
    pub min: f64,
    pub hard: f64,
    pub tight: f64,
}

/// 源谱版面档过满的行怎么压：`mode` 1 = 各槽 max(min, s·slot)；2 = 各槽 max(hard, s·slot)、两头留白收；
/// 3 = 各槽 max(tight, s·slot)、两头留白再收；4 = 各槽 tight、整行等比
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Squeeze {
    pub mode: u8,
    pub s: f64,
}

/// `slotCache` 与 `squeezeOf`（TS 两张 WeakMap）：按小节下标
#[derive(Clone, Debug, Default)]
pub struct PassCache {
    slots: Vec<Option<Vec<Slot>>>,
    squeeze: HashMap<usize, Squeeze>,
}

/// `staffChordSpans` 的结果：一行放得下的跨度，和弦源 id → 自然横向区间（插入序）
#[derive(Clone, Debug, Default)]
pub struct ChordSpans {
    pub width: f64,
    pub by_id: Vec<(u32, f64, f64)>,
}

#[derive(Clone, Copy, Debug)]
struct Span {
    s: Fraction,
    e: Fraction,
}

#[derive(Clone, Copy, Debug)]
struct Reach {
    left: f64,
    right: f64,
    ink: f64,
}

#[derive(Clone, Copy, Debug)]
struct InkAt {
    offset: Fraction,
    left: f64,
    ink: f64,
}

#[derive(Clone, Copy, Debug)]
struct LyricPair {
    a: Fraction,
    b: Fraction,
    need: f64,
    hard: f64,
    tight: f64,
}

/// `x || 1`
fn or_one(x: f64) -> f64 {
    if x == 0.0 || x.is_nan() {
        1.0
    } else {
        x
    }
}

/// `xmlPos(src)`：没有表层或查不到身份 = undefined
fn xml_pos(score: &StaffLayout, oid: Oid) -> Option<Position> {
    if oid.is_none() {
        return None;
    }
    score.surface.and_then(|s| s.xml_pos(oid))
}

/// `x ?? 0` 后取真值（`!xmlPos(..)?.relativeX`）
fn truthy(v: Option<f64>) -> bool {
    matches!(v, Some(x) if x != 0.0 && !x.is_nan())
}

/// 声部第 mi 小节（`part.measures[mi]`，可能没有）
fn pm_at(score: &StaffLayout, p: PartId, mi: usize) -> Option<PmId> {
    score[p].measures.get(mi).copied()
}

fn part_ids(score: &StaffLayout) -> Vec<PartId> {
    (0..score.parts.len()).map(PartId).collect()
}

/// `parseInt(num, 10) || 1` 减一、不小于 0（段号 → 第几行）
fn verse_index(num: &str) -> f64 {
    let n = js::parse_int(num, 10);
    let n = if n == 0.0 || n.is_nan() { 1.0 } else { n };
    js::max(0.0, n - 1.0)
}

/// 一个和弦前（`after` = 后）挨着的那串倚音：同声部同谱表、在元素流里紧挨着它的 grace 和弦，按离它由远到近排。
fn graces_of(score: &StaffLayout, md: PmId, ch: ChordId, after: bool) -> Vec<ChordId> {
    let list = &score[md].chords;
    let i: isize = list.iter().position(|&c| c == ch).map_or(-1, |p| p as isize);
    let mut out: Vec<ChordId> = Vec::new();
    let src = score[ch].src;
    let same = |c: ChordId| score[c].src.voice == src.voice && score[c].src.staff == src.staff;
    let is_after = |c: ChordId| score[c].src.grace.as_ref().and_then(|g| g.after) == Some(true);
    if !after {
        let mut k = i - 1;
        while k >= 0 {
            let c = list[k as usize];
            k -= 1;
            if !same(c) {
                continue;
            }
            if !score[c].grace() || is_after(c) {
                break;
            }
            out.insert(0, c);
        }
    } else {
        let mut k = i + 1;
        while (k as usize) < list.len() {
            let c = list[k as usize];
            k += 1;
            if !same(c) {
                continue;
            }
            if !score[c].grace() || !is_after(c) {
                break;
            }
            out.push(c);
        }
    }
    out
}

fn auto_slot_width(dur_quarters: f64) -> f64 {
    let d = if dur_quarters > 0.0 { dur_quarters } else { 0.25 };
    // 长音每拍至少一格
    js::max(js::max(AUTO_MIN_SLOT, 30.0 * d.powf(0.6)), d.floor() * AUTO_MIN_SLOT)
}

/// 本小节各拍位上音符墨迹的横向范围，相对符头列的 x（各谱表各声部取并）。
/// 量法：把这一拍位的和弦先放在 x = 0，照 `autoPlaceNotes` 同一套（`applyFlipOffset` + `NoteEntry.layout`）排一遍临时记号。
fn entry_reach(score: &mut StaffLayout, mi: usize, by_staff: &mut Vec<(String, Vec<InkAt>)>) -> HashMap<String, Reach> {
    let meta = score.meta;
    let mut out: HashMap<String, Reach> = HashMap::new();
    for p in part_ids(score) {
        let Some(md) = pm_at(score, p, mi) else { continue };
        let ents = score[md].note_entries.clone();
        for e in ents {
            let mut chords: Vec<ChordId> = Vec::new();
            for &n in &score[e].notes {
                let c = score[n].chord;
                if !chords.contains(&c) {
                    chords.push(c);
                }
            }
            for c in chords {
                for i in 0..score[c].notes.len() {
                    let n = score[c].notes[i];
                    score[n].x = 0.0;
                }
                score.chord_apply_flip_offset(c);
            }
            score.entry_layout(e, true, ACC_DOWNSTEM_CLEAR);
            let mut left = 0.0;
            let mut right = 0.0;
            // 连符尾在内的墨迹右缘（不在杠里、符干朝上的符尾往右伸）：只给压缩的最小宽用
            let mut ink = 0.0;
            for &n in &score[e].notes {
                let c = score[n].chord;
                let ch = &score[c];
                right = js::max(right, score[n].x + smufl_width(meta, &ch.sym()));
                if !ch.rest() {
                    left = js::min(left, score[n].x);
                }
                if ch.dot() > 0.0 {
                    right = js::max(right, score[e].dot.dot_pos + ch.dot() * AUTO_DOT_STEP);
                }
                let flag = if !ch.beams.is_empty() || !ch.stem_up { String::new() } else { ch.tail_sym(true) };
                if !flag.is_empty() {
                    ink = js::max(ink, score.chord_stem_x(c) + smufl_width(meta, &flag));
                }
            }
            for a in &score[e].acc.accidentals {
                if let Some(x) = a.xpos {
                    left = js::min(left, x);
                }
            }
            // 琶音线画在符头、临时记号左边，要让出它的宽
            if score[e].notes.iter().any(|&n| score[n].arpeg.is_some()) {
                left -= ARPEGGIO_RESERVE;
            }
            let offset = score[e].offset;
            let key = frac_key(&offset);
            let cur = out.get(&key).copied();
            out.insert(
                key,
                Reach {
                    left: js::min(cur.map_or(0.0, |c| c.left), left),
                    right: js::max(cur.map_or(0.0, |c| c.right), right),
                    ink: js::max(js::max(cur.map_or(0.0, |c| c.ink), ink), right),
                },
            );
            let sk = format!("{}:{}", score[p].pid, score[e].sub_staff);
            let pos = match by_staff.iter().position(|(k, _)| *k == sk) {
                Some(i) => i,
                None => {
                    by_staff.push((sk, Vec::new()));
                    by_staff.len() - 1
                }
            };
            let list = &mut by_staff[pos].1;
            if let Some(same) = list.iter_mut().find(|x| x.offset.compare_to(&offset) == 0) {
                same.left = js::min(same.left, left);
                same.ink = js::max(js::max(same.ink, ink), right);
            } else {
                list.push(InkAt { offset, left, ink: js::max(ink, right) });
            }
        }
    }
    out
}

fn map_max(m: &mut HashMap<String, f64>, key: &str, w: f64) {
    let v = js::max(m.get(key).copied().unwrap_or(0.0), w);
    m.insert(key.to_owned(), v);
}

/// 某小节内所有声部音符的节奏槽：offset(measure-relative) → 自然累计 x + 该 offset 的槽宽。
fn auto_measure_slots(score: &mut StaffLayout, mi: usize) -> Vec<Slot> {
    if let Some(Some(hit)) = score.pass_cache.slots.get(mi) {
        return hit.clone();
    }
    let mc = score.mc;
    // 同 offset 多声部/和弦取最短时值（插入序：键、拍位、时值）
    let mut dur_at: Vec<(String, Fraction, f64)> = Vec::new();
    let mut grace_lead: HashMap<String, f64> = HashMap::new();
    let mut grace_tail: HashMap<String, f64> = HashMap::new();
    let mut text_at: HashMap<String, f64> = HashMap::new();
    let mut lyric_pairs: Vec<LyricPair> = Vec::new();
    let mut lyric_tail: HashMap<String, f64> = HashMap::new();
    let mut harm_at: HashMap<String, f64> = HashMap::new();
    let mut harms: Vec<(f64, f64)> = Vec::new();
    let harm_font = Font::new(score.options.word_font.clone(), score.options.harmony_size / score.scaling);
    for p in part_ids(score) {
        let Some(md) = pm_at(score, p, mi) else { continue };
        for &c in &score[md].chords {
            let ch = &score[c];
            if ch.grace() {
                continue;
            }
            let key = frac_key(&ch.offset);
            let dq = ch.dur().to_float();
            match dur_at.iter_mut().find(|x| x.0 == key) {
                None => dur_at.push((key.clone(), ch.offset, dq)),
                Some(prev) => {
                    if dq < prev.2 {
                        prev.1 = ch.offset;
                        prev.2 = dq;
                    }
                }
            }
            // 倚音要的地方：前倚音占这个音前面那一截，后倚音占它后面那一截
            let nb = graces_of(score, md, c, false).len() as f64;
            let na = graces_of(score, md, c, true).len() as f64;
            let lead = if nb != 0.0 { nb * AUTO_GRACE_STEP + AUTO_GRACE_GAP } else { 0.0 };
            let tail = if na != 0.0 { na * AUTO_GRACE_STEP + AUTO_GRACE_GAP } else { 0.0 };
            if lead != 0.0 {
                map_max(&mut grace_lead, &key, lead);
            }
            if tail != 0.0 {
                map_max(&mut grace_tail, &key, tail);
            }
        }
        for &l in &score[md].lyrics {
            if !score[l].empty() {
                map_max(&mut text_at, &frac_key(&score[l].offset), score[l].width + AUTO_LYRIC_SPACE);
            }
        }
        // 西文词与词之间留一个空格（latinWordBreak）；同一段里本小节相邻的两个音节
        let mut by_verse: Vec<(String, Vec<LyricId>)> = Vec::new();
        for &l in &score[md].lyrics {
            if score[l].empty() {
                continue;
            }
            let num = score[l].num();
            match by_verse.iter_mut().find(|(k, _)| *k == num) {
                Some((_, v)) => v.push(l),
                None => by_verse.push((num, vec![l])),
            }
        }
        for (_, list) in by_verse.iter_mut() {
            js::sort_by(list, |a, b| score[*a].offset.compare_to(&score[*b].offset) as f64);
            for k in 0..list.len().saturating_sub(1) {
                let l = &score[list[k]];
                let n = &score[list[k + 1]];
                if l.offset.compare_to(&n.offset) == 0 {
                    continue;
                }
                let gap = if l.end() && latin_word_break(&l.text(), &n.text()) {
                    AUTO_LYRIC_SPACE + l.font.measure_text(mc, " ")
                } else {
                    AUTO_LYRIC_SPACE
                };
                if gap > AUTO_LYRIC_SPACE {
                    map_max(&mut text_at, &frac_key(&l.offset), (l.width + n.width) / 2.0 + gap);
                }
                lyric_pairs.push(LyricPair {
                    a: l.offset,
                    b: n.offset,
                    need: (l.width + n.width) / 2.0 + gap,
                    hard: (l.width + n.width) / 2.0 + gap - AUTO_LYRIC_SPACE + HARD_LYRIC_SPACE,
                    tight: (l.width + n.width) / 2.0 + gap - AUTO_LYRIC_SPACE,
                });
            }
            // 本小节最后一个字：右半个字加字距要在小节里放下
            if let Some(&last) = list.last() {
                let lk = frac_key(&score[last].offset);
                map_max(&mut lyric_tail, &lk, score[last].width / 2.0);
            }
        }
        for &h in &score[md].harmonies {
            harms.push((score[h].offset.to_float(), harm_font.measure_text(mc, &score[h].as_plain_text(None))));
        }
    }
    let mut entries = dur_at;
    js::sort_by(&mut entries, |a, b| a.1.compare_to(&b.1) as f64);
    // 和弦符号：相邻两个的中心距至少各自半宽之和
    let onsets: Vec<f64> = entries.iter().map(|e| e.1.to_float()).collect();
    let meas_end = score.measures[mi].dur.to_float();
    js::sort_by(&mut harms, |a, b| a.0 - b.0);
    let min_harm = |text_at: &mut HashMap<String, f64>, harm_at: &mut HashMap<String, f64>, key: &str, w: f64| {
        map_max(text_at, key, w);
        map_max(harm_at, key, w);
    };
    for k in 1..harms.len() {
        let (a, b) = (harms[k - 1], harms[k]);
        let need = (a.1 + b.1) / 2.0 + AUTO_HARMONY_SPACE;
        let mut ia: isize = onsets.len() as isize - 1;
        while ia > 0 && onsets[ia as usize] > a.0 + 1e-9 {
            ia -= 1;
        }
        if ia < 0 {
            continue;
        }
        let ia = ia as usize;
        let c0 = onsets[ia];
        let c1 = onsets.get(ia + 1).copied().unwrap_or(meas_end);
        if b.0 <= c1 + 1e-9 {
            let f = (b.0 - a.0) / or_one(c1 - c0);
            if f > 0.0 {
                min_harm(&mut text_at, &mut harm_at, &entries[ia].0, need / f);
            }
        }
    }
    for h in &harms {
        if let Some(e) = entries.iter().find(|x| (x.1.to_float() - h.0).abs() < 1e-9) {
            min_harm(&mut text_at, &mut harm_at, &e.0, h.1 + AUTO_HARMONY_SPACE);
        }
    }
    let mut slots: Vec<Slot> = Vec::new();
    // 各谱表（声部:谱表）逐拍位的墨迹
    let mut ink_by_staff: Vec<(String, Vec<InkAt>)> = Vec::new();
    let reach = entry_reach(score, mi, &mut ink_by_staff);
    let lead_at = |key: &str| -> f64 {
        let l = -reach.get(key).map_or(0.0, |r| r.left);
        if l > 0.0 {
            l + AUTO_ACC_CLEAR
        } else {
            0.0
        }
    };
    let gl = |key: &str| grace_lead.get(key).copied().unwrap_or(0.0);
    // 首音带前倚音：整串往右让出那截；首音的临时记号也让出来
    let mut nat = if entries.is_empty() { 0.0 } else { gl(&entries[0].0) + lead_at(&entries[0].0) };
    // 后倚音与下一个音的前倚音要的那截
    let graces_after = |k: usize| -> f64 {
        let tail = grace_tail.get(&entries[k].0).copied().unwrap_or(0.0);
        tail + entries.get(k + 1).map_or(0.0, |next| gl(&next.0))
    };
    // 这个槽至少要多宽：本拍位的墨迹右缘 + 下一个音的临时记号那截
    let ink_need = |k: usize| -> f64 {
        let Some(next) = entries.get(k + 1) else { return 0.0 };
        let lead = lead_at(&next.0);
        if lead != 0.0 {
            reach.get(&entries[k].0).map_or(0.0, |r| r.right) + lead
        } else {
            0.0
        }
    };
    let spans = tuplet_spans(score, mi);
    let mut k = 0usize;
    while k < entries.len() {
        let e = &entries[k];
        if let Some(span) = spans.iter().find(|sp| sp.s.compare_to(&e.1) == 0).copied() {
            // 连音组：段内 x 随时间线性走——组内等分，与外部拍位只在组首组尾对齐
            let mut j = k;
            while j + 1 < entries.len() && entries[j + 1].1.compare_to(&span.e) < 0 {
                j += 1;
            }
            let sub_end = (j + 2).min(entries.len());
            let sub: Vec<Fraction> = entries[k..sub_end].iter().map(|x| x.1).collect();
            let ga: Vec<f64> = (0..sub.len()).map(|i| graces_after(k + i)).collect();
            let w = tuplet_span_width(score, mi, span, &sub, &ga, &harm_at);
            let s = span.s.to_float();
            let len = span.e.to_float() - s;
            let x0 = nat;
            for i in k..=j {
                let at = x0 + (w * (entries[i].1.to_float() - s)) / len;
                if i > k {
                    let last = slots.last_mut().expect("前面放过槽");
                    let v = at - last.nat;
                    last.slot = v;
                    last.min = v;
                    last.hard = v;
                    last.tight = v;
                }
                slots.push(Slot { offset: entries[i].1, nat: at, slot: 0.0, min: 0.0, hard: 0.0, tight: 0.0 });
            }
            // 组尾之后
            let tail = js::max(auto_slot_width(entries[j].2), text_at.get(&entries[j].0).copied().unwrap_or(0.0)) + graces_after(j);
            let last = slots.last_mut().expect("刚放过槽");
            nat = js::max(x0 + w, last.nat + tail);
            let v = nat - last.nat;
            last.slot = v;
            last.min = v;
            last.hard = v;
            last.tight = v;
            k = j + 1;
            continue;
        }
        let key = &e.0;
        let text = text_at.get(key).copied().unwrap_or(0.0);
        let ink = ink_need(k);
        let slot = js::max(js::max(auto_slot_width(e.2), text), ink) + graces_after(k);
        let harm = harm_at.get(key).copied().unwrap_or(0.0);
        let tail = lyric_tail.get(key).copied();
        let min = js::min(slot, js::max(js::max(SQUEEZE_MIN_SLOT, harm), tail.map_or(0.0, |t| t + AUTO_LYRIC_SPACE)) + graces_after(k));
        let hard = js::min(min, js::max(js::max(HARD_MIN_SLOT, harm), tail.map_or(0.0, |t| t + HARD_LYRIC_SPACE)) + graces_after(k));
        let tight = js::min(hard, js::max(js::max(TIGHT_MIN_SLOT, harm), tail.unwrap_or(0.0)) + graces_after(k));
        slots.push(Slot { offset: e.1, nat, slot, min, hard, tight });
        nat += slot;
        k += 1;
    }
    // 墨迹按各谱表相邻两个音算，摊到两音之间的各槽上
    for (_, list) in ink_by_staff.iter_mut() {
        js::sort_by(list, |a, b| a.offset.compare_to(&b.offset) as f64);
        for n in 0..list.len() {
            let a = list[n];
            let b = list.get(n + 1).copied();
            let ia = find_slot(&slots, &a.offset);
            let ib = match b {
                Some(b) => find_slot(&slots, &b.offset),
                None => slots.len() as isize,
            };
            if ia < 0 || ib <= ia {
                continue;
            }
            let lead = match b {
                Some(b) if b.left < 0.0 => -b.left + 1.0,
                _ => 0.0,
            };
            let has_lead = lead != 0.0 && !lead.is_nan();
            spread_over(
                &mut slots,
                ia as usize,
                ib as usize,
                a.ink + if has_lead { lead + ACC_STEM_CLEAR } else { INK_CLEAR },
                a.ink + if has_lead { lead + ACC_STEM_CLEAR } else { INK_CLEAR },
                a.ink + if has_lead { lead + TIGHT_ACC_CLEAR } else { TIGHT_INK_CLEAR },
            );
        }
    }
    // 歌词的中心距折到两字之间的各槽上
    for pr in &lyric_pairs {
        let ia = find_slot(&slots, &pr.a);
        let ib = find_slot(&slots, &pr.b);
        if ia < 0 || ib <= ia {
            continue;
        }
        spread_over(&mut slots, ia as usize, ib as usize, pr.need, pr.hard, pr.tight);
    }
    let cache = &mut score.pass_cache.slots;
    if cache.len() <= mi {
        cache.resize(mi + 1, None);
    }
    cache[mi] = Some(slots.clone());
    slots
}

/// 连音段里一行的一格：拍位、要的宽、终点
type RowCell = (f64, f64, f64);

/// `slots.findIndex((sl) => !sl.offset.compareTo(t))`
fn find_slot(slots: &[Slot], t: &Fraction) -> isize {
    slots.iter().position(|sl| sl.offset.compare_to(t) == 0).map_or(-1, |p| p as isize)
}

/// 差额按各槽自然宽的比例摊到 [ia, ib) 的每个槽上（`spreadOver`）
fn spread_over(slots: &mut [Slot], ia: usize, ib: usize, need_min: f64, need_hard: f64, need_tight: f64) {
    let span = &mut slots[ia..ib];
    if span.is_empty() {
        return;
    }
    let nat_sum = or_one(span.iter().fold(0.0, |x, sl| x + sl.slot));
    fn raise(span: &mut [Slot], nat_sum: f64, want: f64, get: fn(&Slot) -> f64, set: fn(&mut Slot, f64), cap: fn(&Slot) -> f64) {
        let have = span.iter().fold(0.0, |x, sl| x + get(sl));
        if have >= want {
            return;
        }
        for sl in span.iter_mut() {
            let v = js::min(cap(sl), get(sl) + ((want - have) * sl.slot) / nat_sum);
            set(sl, v);
        }
    }
    raise(span, nat_sum, need_min, |s| s.min, |s, v| s.min = v, |s| s.slot);
    raise(span, nat_sum, need_hard, |s| s.hard, |s, v| s.hard = v, |s| s.min);
    raise(span, nat_sum, need_tight, |s| s.tight, |s, v| s.tight = v, |s| s.hard);
}

/// 本小节里的连音组跨度 [组首, 组尾音的终点)，各声部重叠的并成一段；跨小节、零长的不算。
fn tuplet_spans(score: &StaffLayout, mi: usize) -> Vec<Span> {
    let mut raw: Vec<Span> = Vec::new();
    for p in part_ids(score) {
        let Some(md) = pm_at(score, p, mi) else { continue };
        for &t in &score[p].tuplets {
            if score[t].notes.start_note.is_none() || score[t].notes.end_note.is_none() {
                continue;
            }
            let a = score.tuplet_start_chord(t);
            let b = score.tuplet_end_chord(t);
            if score[a].measure != md || score[b].measure != md || score[a].grace() || score[b].grace() {
                continue;
            }
            let e = score[b].offset.plus(&score[b].dur());
            if e.compare_to(&score[a].offset) > 0 {
                raw.push(Span { s: score[a].offset, e });
            }
        }
    }
    js::sort_by(&mut raw, |x, y| x.s.compare_to(&y.s) as f64);
    let mut out: Vec<Span> = Vec::new();
    for r in raw {
        match out.last_mut() {
            Some(prev) if r.s.compare_to(&prev.e) < 0 => {
                if r.e.compare_to(&prev.e) > 0 {
                    prev.e = r.e;
                }
            }
            _ => out.push(r),
        }
    }
    out
}

/// 连音段要多宽：段内 x 随时间线性走（`tupletSpanWidth`）。`ga[i]` = `gracesAfter(i)`
fn tuplet_span_width(score: &StaffLayout, mi: usize, span: Span, onsets: &[Fraction], ga: &[f64], harm_at: &HashMap<String, f64>) -> f64 {
    let s = span.s.to_float();
    let e = span.e.to_float();
    let len = e - s;
    let in_span = |t: f64| t >= s - 1e-9 && t < e - 1e-9;
    let mut w = 0.0;
    let mut need = |a: f64, b: f64, width: f64| {
        if b > a + 1e-9 {
            w = js::max(w, (width * len) / (b - a));
        }
    };
    // 拍位 → 这一拍要的宽与它的终点（行按插入序）
    let mut rows: Vec<(String, Vec<RowCell>)> = Vec::new();
    let mut put = |key: String, t: f64, width: f64, end: f64| {
        if !in_span(t) {
            return;
        }
        let ri = match rows.iter().position(|(k, _)| *k == key) {
            Some(i) => i,
            None => {
                rows.push((key, Vec::new()));
                rows.len() - 1
            }
        };
        let m = &mut rows[ri].1;
        match m.iter_mut().find(|x| x.0 == t) {
            Some(cur) => {
                cur.1 = js::max(cur.1, width);
                cur.2 = js::max(cur.2, end);
            }
            None => m.push((t, js::max(0.0, width), js::max(0.0, end))),
        }
    };
    let pids = part_ids(score);
    for (pi, &p) in pids.iter().enumerate() {
        let Some(md) = pm_at(score, p, mi) else { continue };
        let end_of = |c: ChordId| score[c].offset.plus(&score[c].dur()).to_float();
        for &c in &score[md].chords {
            let ch = &score[c];
            if !ch.grace() {
                put(
                    format!("n{pi}/{}/{}", js::num_to_string(ch.src.staff), js::num_to_string(ch.voice())),
                    ch.offset.to_float(),
                    auto_slot_width(ch.dur().to_float()),
                    end_of(c),
                );
            }
        }
        for &l in &score[md].lyrics {
            let ly = &score[l];
            if !ly.empty() {
                put(format!("l{pi}/{}", ly.num()), ly.offset.to_float(), ly.width + AUTO_LYRIC_SPACE, end_of(ly.chord));
            }
        }
    }
    // 行内下一件也在本小节的就到它为止，最后一件到它那个音的终点
    let mut after: HashMap<String, f64> = HashMap::new();
    let mut near = |key: String, t: f64| {
        if t >= e - 1e-9 {
            let v = js::min(after.get(&key).copied().unwrap_or(f64::INFINITY), t);
            after.insert(key, v);
        }
    };
    for (pi, &p) in pids.iter().enumerate() {
        let Some(md) = pm_at(score, p, mi) else { continue };
        for &c in &score[md].chords {
            let ch = &score[c];
            if !ch.grace() {
                near(format!("n{pi}/{}/{}", js::num_to_string(ch.src.staff), js::num_to_string(ch.voice())), ch.offset.to_float());
            }
        }
        for &l in &score[md].lyrics {
            let ly = &score[l];
            if !ly.empty() {
                near(format!("l{pi}/{}", ly.num()), ly.offset.to_float());
            }
        }
    }
    for (key, m) in &rows {
        let mut ts: Vec<f64> = m.iter().map(|x| x.0).collect();
        js::sort_by(&mut ts, |a, b| a - b);
        for (i, &t) in ts.iter().enumerate() {
            let cur = m.iter().find(|x| x.0 == t).expect("同一张表");
            let b = ts.get(i + 1).copied().or_else(|| after.get(key).copied()).unwrap_or(cur.2);
            need(t, b, cur.1);
        }
    }
    // 全体相邻拍位：不同声部的音不叠在一起，和弦符号、倚音的地方照留
    let ts: Vec<f64> = onsets.iter().map(|o| o.to_float()).collect();
    for (i, &t) in ts.iter().enumerate() {
        if in_span(t) {
            let b = js::min(ts.get(i + 1).copied().unwrap_or(e), e);
            need(t, b, js::max(AUTO_CROSS_VOICE_GAP, harm_at.get(&frac_key(&onsets[i])).copied().unwrap_or(0.0)) + ga[i]);
        }
    }
    w
}

fn print_sets(score: &StaffLayout, input: &LayoutInput) -> (HashSet<usize>, HashSet<usize>, HashSet<usize>) {
    let mut preferred = HashSet::new();
    let mut hard = HashSet::new();
    // 小节中间换行拆出的后半（`implicit` 且起新行）
    let mut forced = HashSet::new();
    for pt in input {
        for (i, mea) in pt.iter().enumerate() {
            for pr in &mea.prints {
                if pr.new_page {
                    hard.insert(i);
                } else if pr.new_system {
                    if score.measures.get(i).is_some_and(|m| m.implicit) {
                        forced.insert(i);
                    } else {
                        preferred.insert(i);
                    }
                }
            }
        }
    }
    (preferred, hard, forced)
}

/// 计算每小节自然宽度 + 按页宽断行，返回起行的小节序号（含 0）。
fn auto_layout_widths(score: &mut StaffLayout, input: &LayoutInput) -> BTreeSet<usize> {
    let n = score.measures.len();
    let mut w: Vec<f64> = vec![0.0; n];
    for i in 0..n {
        let nw = auto_natural_width(score, i);
        score.measures[i].width = nw;
        w[i] = score.measures[i].width + mid_attr_width(score, i); // 折行按带转调转拍号的宽量
    }
    let (preferred, hard, forced) = print_sets(score, input);

    let d = &score.defaults;
    let avail = d.page_width - d.left_margin - d.right_margin;
    let mut best: Vec<f64> = vec![0.0; n + 1];
    let mut from: Vec<usize> = vec![0; n + 1];
    let lead: Vec<f64> = (0..n).map(|i| auto_lead(score, i)).collect();
    for j in 1..=n {
        best[j] = f64::INFINITY;
        from[j] = j - 1;
        let mut sum = 0.0;
        let mut merged = 0.0;
        for i in (0..j).rev() {
            sum += w[i];
            let width = lead[i] + sum;
            if width > avail && i < j - 1 {
                break; // 单小节超宽也得放
            }
            let fill = width / avail;
            let slack = if j == n { js::max(0.0, LAST_LINE_MIN_FILL - fill) * 3.0 } else { 1.0 - js::min(fill, 1.0) };
            let mut cost = best[i] + slack * slack * (if j < n && fill < 0.5 { UNDERFULL } else { 1.0 }) + merged * BREAK_MERGE;
            if i > 0 && !preferred.contains(&i) && !hard.contains(&i) && !forced.contains(&i) {
                cost += BREAK_OFF_PREFERRED;
            }
            if cost < best[j] {
                best[j] = cost;
                from[j] = i;
            }
            if hard.contains(&i) || forced.contains(&i) {
                break; // 不能跨过换页、拆开的半小节
            }
            if preferred.contains(&i) {
                merged += 1.0;
            }
        }
    }
    let mut breaks = BTreeSet::new();
    let mut j = n;
    while j > 0 {
        breaks.insert(from[j]);
        j = from[j];
    }
    breaks.insert(0);
    breaks
}

/// 小节的自然宽（折行与断句量宽同一把尺子）。
fn auto_natural_width(score: &mut StaffLayout, mi: usize) -> f64 {
    let slots = auto_measure_slots(score, mi);
    let span = match slots.last() {
        Some(l) => l.nat + l.slot,
        None => AUTO_MIN_SLOT,
    };
    AUTO_LEFT_DATA + span + AUTO_END_PAD
}

/// 硬断点（源谱版面档、源文写明的换行）：起行照谱里的 `new-system` / `new-page`，各小节宽仍按自然宽给。
fn source_breaks(score: &mut StaffLayout, input: &LayoutInput) -> BTreeSet<usize> {
    let mut breaks = BTreeSet::from([0usize]);
    for i in 0..score.measures.len() {
        score.measures[i].width = auto_natural_width(score, i);
    }
    for pt in input {
        for (i, mea) in pt.iter().enumerate() {
            if mea.prints.iter().any(|pr| pr.new_page || pr.new_system) {
                breaks.insert(i);
            }
        }
    }
    breaks
}

/// 源文写明的换行（ABC，`hardBreaks`）：起行照 `sourceBreaks`，连最紧一档都压不下的行才在行内按自然宽均分成几行。
fn written_breaks(score: &mut StaffLayout, input: &LayoutInput) -> BTreeSet<usize> {
    let mut breaks = source_breaks(score, input);
    let n = score.measures.len();
    let d = &score.defaults;
    let avail = d.page_width - d.left_margin - d.right_margin;
    let tight = Squeeze { mode: 3, s: 0.0 };
    let starts: Vec<usize> = breaks.iter().copied().collect();
    for (k, &from) in starts.iter().enumerate() {
        let to = starts.get(k + 1).copied().unwrap_or(n);
        let w = |score: &StaffLayout, i: usize| score.measures[i].width + if i > from { mid_attr_width(score, i) } else { 0.0 };
        let mut min = auto_lead(score, from) - AUTO_ATTR_GAP + TIGHT_ATTR_GAP;
        let mut nat = auto_lead(score, from);
        for i in from..to {
            min += squeezed_width(score, i, tight) + if i > from { mid_attr_width(score, i) } else { 0.0 };
            nat += w(score, i);
        }
        if min <= avail {
            continue;
        }
        let pieces = (nat / avail).ceil();
        let mut acc = auto_lead(score, from);
        let mut m = 1.0;
        let mut i = from;
        while (i as isize) < to as isize - 1 && m < pieces {
            acc += w(score, i);
            if acc >= (nat * m) / pieces {
                breaks.insert(i + 1);
                m += 1.0;
            }
            i += 1;
        }
    }
    breaks
}

/// **五线谱的断句尺子**：各和弦在整首连排时的自然横向区间，键是源元素 id。要在自动铺排之后调。
pub fn staff_chord_spans(score: &mut StaffLayout) -> ChordSpans {
    let mut by_id: Vec<(u32, f64, f64)> = Vec::new();
    let mut x = 0.0;
    for mi in 0..score.measures.len() {
        let slots = auto_measure_slots(score, mi);
        let md = score.parts.first().and_then(|p| p.measures.get(mi)).copied();
        if let Some(md) = md {
            for &c in &score[md].chords {
                let ch = &score[c];
                let key = frac_key(&ch.offset);
                // `new Map(...)`：同键后来的盖前面的
                let s = slots.iter().rev().find(|s| frac_key(&s.offset) == key);
                let Some(id) = ch.src.src_id else { continue };
                let Some(s) = s else { continue };
                if ch.grace() || by_id.iter().any(|x| x.0 == id) {
                    continue;
                }
                let x0 = x + AUTO_LEFT_DATA + s.nat;
                by_id.push((id, x0, x0 + s.slot));
            }
        }
        x += auto_natural_width(score, mi);
    }
    let d = &score.defaults;
    let width = d.page_width - d.left_margin - d.right_margin - auto_lead(score, 0) - AUTO_LEFT_DATA - AUTO_END_PAD;
    ChordSpans { width, by_id }
}

/// 行首小节谱号、调号（拍号变了连拍号）占的宽，与 `layoutAttr` 同一套量法，再加首音前的净空。
fn auto_lead(score: &StaffLayout, mi: usize) -> f64 {
    let off = score.measures[mi].offset;
    let mut key = 0.0;
    let mut time = 0.0;
    for part in &score.parts {
        for ps in &part.staves {
            let ks = ps.get_key(&off);
            key = js::max(key, key_change_width_calc(ks.cancel, ks.fifths));
            if mi == 0 || ps.time_change(&off) {
                time = js::max(time, time_sig_width_calc(&ps.get_time(&off), score));
            }
        }
    }
    5.0 + 32.0 + key + time + AUTO_ATTR_GAP
}

/// 行中（不在行首）的转调、转拍号要占的宽。
fn mid_attr_width(score: &StaffLayout, mi: usize) -> f64 {
    if mi == 0 {
        return 0.0;
    }
    let off = score.measures[mi].offset;
    let mut key = 0.0;
    let mut time = 0.0;
    for part in &score.parts {
        for ps in &part.staves {
            if ps.key_change(&off) {
                let ks = ps.get_key(&off);
                key = js::max(key, key_change_width_calc(ks.cancel, ks.fifths));
            }
            if ps.time_change(&off) {
                time = js::max(time, time_sig_width_calc(&ps.get_time(&off), score));
            }
        }
    }
    key + time
}

/// 折行后拉伸每个 system 的小节宽度以铺满页宽（末行最多拉到 `LAST_LINE_MAX_STRETCH` 倍）。
fn auto_justify_systems(score: &mut StaffLayout) {
    let n_sys = score.systems.len();
    for si in 0..n_sys {
        let sys = SysId(si);
        if score[sys].measures.is_empty() {
            continue;
        }
        let avail = score.defaults.page_width - score.defaults.left_margin - score.defaults.right_margin - score[sys].left_margin - score[sys].right_margin;
        // 行首小节预留谱号/调号/拍号占位
        let m0 = score[sys].measures[0];
        let lead = auto_lead(score, score[sys].first_measure);
        score[m0].width += lead;
        // 行中转调转拍号那一截不拉伸
        let ms = score[sys].measures.clone();
        let attr: Vec<f64> = ms.iter().enumerate().map(|(k, &m)| if k == 0 { 0.0 } else { mid_attr_width(score, score[m].index) }).collect();
        let mut sum = 0.0;
        for &m in &ms {
            sum += score[m].width;
        }
        if sum <= 0.0 {
            continue;
        }
        let attr_sum = attr.iter().fold(0.0, |a, b| a + b);
        let mut scale = js::max(0.0, avail - attr_sum) / sum;
        // 源文写明的硬断点（`hardBreaks`）过满的行也照源谱版面档压
        if score.keep_breaks || (score.hard_breaks && scale < 1.0) {
            justify_source_system(score, sys, avail, &attr);
            continue;
        }
        let is_last = si == n_sys - 1;
        if is_last && scale > LAST_LINE_MAX_STRETCH {
            scale = LAST_LINE_MAX_STRETCH;
        }
        for (k, &m) in ms.iter().enumerate() {
            score[m].width = score[m].width * scale + attr[k];
        }
    }
}

/// 源谱版面档的一行：放得下就照常按自然宽等比拉；放不下只压时值撑出来的那截，连这些都放不下才整体等比压。
fn justify_source_system(score: &mut StaffLayout, sys: SysId, avail: f64, attr: &[f64]) {
    let lead = auto_lead(score, score[sys].first_measure);
    let ms = score[sys].measures.clone();
    let nat: Vec<f64> = ms.iter().enumerate().map(|(k, &m)| score[m].width - if k == 0 { lead } else { 0.0 }).collect();
    let sum_nat = nat.iter().fold(0.0, |a, b| a + b);
    let room = avail - lead - attr.iter().fold(0.0, |a, b| a + b);
    let set = |score: &mut StaffLayout, k: usize, w: f64| {
        score[ms[k]].width = w + if k == 0 { lead } else { 0.0 } + attr[k];
    };
    if sum_nat <= 0.0 {
        return;
    }
    if room >= sum_nat {
        for (k, &w) in nat.iter().enumerate() {
            set(score, k, (w * room) / sum_nat);
        }
        return;
    }
    // 行首谱号调号之后那截净空也跟着各档收
    let lead_of = |sq: Squeeze| lead - AUTO_ATTR_GAP + squeezed_attr_gap(sq);
    let idx: Vec<usize> = ms.iter().map(|&m| score[m].index).collect();
    let total = |score: &mut StaffLayout, sq: Squeeze| {
        let mut a = 0.0;
        for &mi in &idx {
            a += squeezed_width(score, mi, sq);
        }
        a + lead_of(sq) - lead
    };
    // 整行共用一个间距系数 `s`，二分到正好铺满
    let solve = |score: &mut StaffLayout, mode: u8| -> Squeeze {
        let mut lo = 0.0;
        let mut hi = 1.0;
        for _ in 0..40 {
            let mid = (lo + hi) / 2.0;
            if total(score, Squeeze { mode, s: mid }) > room {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        Squeeze { mode, s: lo }
    };
    let sq = if total(score, Squeeze { mode: 1, s: 0.0 }) <= room {
        solve(score, 1)
    } else if total(score, Squeeze { mode: 2, s: 0.0 }) <= room {
        solve(score, 2)
    } else if total(score, Squeeze { mode: 3, s: 0.0 }) <= room {
        solve(score, 3)
    } else {
        Squeeze { mode: 4, s: 0.0 }
    };
    let ws: Vec<f64> = idx.iter().map(|&mi| squeezed_width(score, mi, sq)).collect();
    let sum_w = ws.iter().fold(0.0, |a, b| a + b);
    let shrink = lead - lead_of(sq);
    for (k, &w) in ws.iter().enumerate() {
        score.pass_cache.squeeze.insert(idx[k], sq);
        let v = if sq.mode == 4 { (w * js::max(0.0, room + shrink)) / or_one(sum_w) } else { w };
        set(score, k, v - if k == 0 { shrink } else { 0.0 });
    }
}

/// 压过之后一个槽占多宽
fn squeezed_slot(sl: &Slot, sq: Squeeze) -> f64 {
    match sq.mode {
        1 => js::max(sl.min, sq.s * sl.slot),
        2 => js::max(sl.hard, sq.s * sl.slot),
        3 => js::max(sl.tight, sq.s * sl.slot),
        _ => sl.tight,
    }
}

/// 压过之后行首谱号调号右缘到首音的净空
fn squeezed_attr_gap(sq: Squeeze) -> f64 {
    match sq.mode {
        1 => AUTO_ATTR_GAP,
        2 => TIGHT_ATTR_GAP + (AUTO_ATTR_GAP - TIGHT_ATTR_GAP) * sq.s,
        _ => TIGHT_ATTR_GAP,
    }
}

/// 压过之后小节两头的留白
fn squeezed_pad(sq: Squeeze) -> f64 {
    let full = AUTO_LEFT_DATA + AUTO_END_PAD;
    match sq.mode {
        1 => full,
        2 => HARD_MEASURE_PAD + (full - HARD_MEASURE_PAD) * sq.s,
        3 => TIGHT_MEASURE_PAD + (HARD_MEASURE_PAD - TIGHT_MEASURE_PAD) * sq.s,
        _ => TIGHT_MEASURE_PAD,
    }
}

/// 压过之后的小节宽（不含行首谱号调号那截与行中转调）
fn squeezed_width(score: &mut StaffLayout, mi: usize, sq: Squeeze) -> f64 {
    let slots = auto_measure_slots(score, mi);
    if slots.is_empty() {
        return js::min(auto_natural_width(score, mi), squeezed_pad(sq) + TIGHT_MIN_SLOT);
    }
    let sum = slots.iter().fold(0.0, |a, sl| a + squeezed_slot(sl, sq));
    js::min(auto_natural_width(score, mi), squeezed_pad(sq) + slots[0].nat + sum)
}

/// layoutAttr 之后：把每小节音符横向铺到 [dataPos, dataEnd] 内（按节奏槽比例）。
fn auto_place_notes(score: &mut StaffLayout) {
    for i in 0..score.measures.len() {
        let slots = auto_measure_slots(score, i);
        if slots.is_empty() {
            continue;
        }
        let mif = MeasId(i);
        // 过满被压的小节：各槽按 `squeezedSlot` 压过的宽，按累计位置比例铺
        let sq = score.pass_cache.squeeze.get(&i).copied();
        let mut pos: Vec<f64> = Vec::with_capacity(slots.len());
        let mut acc = slots[0].nat;
        for sl in &slots {
            pos.push(if sq.is_none() { sl.nat } else { acc });
            acc += match sq {
                None => sl.slot,
                Some(sq) => squeezed_slot(sl, sq),
            };
        }
        let last = slots[slots.len() - 1];
        let nat_total = if sq.is_none() { last.nat + last.slot } else { acc };
        let m = &score[mif];
        let has_attr = m.clef_pos.is_some() || m.key_pos.is_some() || m.time_pos.is_some();
        let pad = match sq {
            None => AUTO_NOTE_PAD,
            Some(sq) => (AUTO_NOTE_PAD * squeezed_pad(sq)) / (AUTO_LEFT_DATA + AUTO_END_PAD),
        };
        let left = m.data_pos
            + pad
            + if has_attr {
                match sq {
                    None => AUTO_ATTR_GAP,
                    Some(sq) => squeezed_attr_gap(sq),
                }
            } else {
                0.0
            };
        let right = m.data_end - pad;
        let inner = js::max(right - left, AUTO_MIN_SLOT);
        let mut x_of: HashMap<String, f64> = HashMap::new();
        for (k, s) in slots.iter().enumerate() {
            x_of.insert(frac_key(&s.offset), left + if nat_total > 0.0 { (pos[k] / nat_total) * inner } else { 0.0 });
        }
        let lyr_size = score.defaults.lyric_font.size;
        for p in part_ids(score) {
            let Some(md) = pm_at(score, p, i) else { continue };
            let chords = score[md].chords.clone();
            for c in chords {
                if score[c].grace() {
                    continue;
                }
                let Some(&x) = x_of.get(&frac_key(&score[c].offset)) else { continue };
                for k in 0..score[c].notes.len() {
                    let n = score[c].notes[k];
                    score[n].x = x;
                }
                // 和弦里的二度：翻到另一侧的那个头错开一个头宽
                score.chord_apply_flip_offset(c);
                // 倚音挨着主音排：前倚音在左、由近到远一个一个往左数，后倚音在右
                let before = graces_of(score, md, c, false);
                let nb = before.len() as f64;
                for (k, &g) in before.iter().enumerate() {
                    for q in 0..score[g].notes.len() {
                        let n = score[g].notes[q];
                        score[n].x = x - AUTO_GRACE_GAP - (nb - k as f64) * AUTO_GRACE_STEP;
                    }
                }
                for (k, g) in graces_of(score, md, c, true).into_iter().enumerate() {
                    for q in 0..score[g].notes.len() {
                        let n = score[g].notes[q];
                        score[n].x = x + AUTO_GRACE_GAP + (k as f64 + 1.0) * AUTO_GRACE_STEP;
                    }
                }
            }
            // NoteEntry（加线/附点/临时记号）按最终位置重排
            for k in 0..score[md].note_entries.len() {
                let e = score[md].note_entries[k];
                score.entry_layout(e, true, ACC_DOWNSTEM_CLEAR);
            }
            // 符杠斜率/端点依赖音符 x → 重排
            for k in 0..score[md].beams.len() {
                let g = score[md].beams[k];
                score.beam_refresh(g);
            }
            // 杠中间的休止让开杠（要在符干长定了之后）
            for k in 0..score[md].beams.len() {
                let g = score[md].beams[k];
                score.beam_clear_rests(g);
            }
            // 歌词：按音符最终位置补正 x
            for k in 0..score[md].lyrics.len() {
                let l = score[md].lyrics[k];
                if let Some(&x) = x_of.get(&frac_key(&score[l].offset)) {
                    score[l].x = x;
                }
            }
            // 速度/文字记号：无 default-y 时抬到谱表上方；字号统一到歌词字号
            for k in 0..score[md].text_blocks.len() {
                let t = score[md].text_blocks[k];
                let tb = &mut score[t];
                if tb.y <= 0.0 && !tb.source_y {
                    tb.y = AUTO_DIRECTION_Y;
                    tb.auto_y = true;
                }
                if tb.source_size {
                    continue;
                }
                // 力度字形照它自己的缺省字号
                if let Some(src) = tb.src {
                    if src.kind == "dynamics" || src.more.as_ref().is_some_and(|m| m.iter().any(|d| d.kind == "dynamics")) {
                        continue;
                    }
                }
                for it in tb.block.data.iter_mut() {
                    if it.font.size > 0.0 {
                        it.font = it.font.scaled(lyr_size / it.font.size);
                    }
                }
            }
        }
    }
}

/// 没给 default-y 的松叶：照五线谱的惯例放在谱表下方，起头那一行最低处之下一道空。只管第一谱表。
fn auto_place_wedges(score: &mut StaffLayout) {
    for p in part_ids(score) {
        for k in 0..score[p].wedges.len() {
            let w = score[p].wedges[k];
            if !score[w].auto_y || score[w].staff != 0 {
                continue;
            }
            let st = score[w].span.start_tick;
            let Some(si) = (0..score.systems.len()).find(|&s| score.sys_contains(SysId(s), &st)) else { continue };
            // 只看本声部
            let low = system_lowest(score, SysId(si), false, &[p], 0.0);
            score[w].ypos = low + AUTO_WEDGE_GAP + score[w].spread / 2.0;
        }
    }
}

/// 歌词 y：逐 system、逐声部逐谱表取那一谱表往下伸的最低点，各 verse 行整齐地排在它下面。
fn auto_place_lyrics_y(score: &mut StaffLayout) {
    let font = score.defaults.lyric_font.clone();
    let fm = font.metrics(score.mc);
    let ascent = -fm.ascent;
    let row = js::max(AUTO_LYRIC_ROW, font.size * 1.1);
    let staff_gap = if score.keep_breaks { SOURCE_LYRIC_STAFF_GAP } else { AUTO_LYRIC_STAFF_GAP };
    for si in 0..score.systems.len() {
        let sys = SysId(si);
        for p in part_ids(score) {
            let mut by_staff: Vec<(f64, Vec<LyricId>)> = Vec::new();
            for l in system_lyrics(score, sys, &[p]) {
                let st = score.lyric_staff(l);
                match by_staff.iter_mut().find(|(k, _)| *k == st) {
                    Some((_, v)) => v.push(l),
                    None => by_staff.push((st, vec![l])),
                }
            }
            for (staff, all) in by_staff {
                let lyrics: Vec<LyricId> = all.iter().copied().filter(|&l| !score[l].above()).collect();
                let above: Vec<LyricId> = all.iter().copied().filter(|&l| score[l].above()).collect();
                let nums = |score: &StaffLayout, ls: &[LyricId]| -> Vec<f64> {
                    let mut v: Vec<f64> = Vec::new();
                    for &l in ls {
                        let x = verse_index(&score[l].num());
                        if !v.contains(&x) {
                            v.push(x);
                        }
                    }
                    js::sort_by(&mut v, |a, b| a - b);
                    v
                };
                let skip = if !above.is_empty() { nums(score, &lyrics).first().copied().unwrap_or(0.0) } else { 0.0 };
                let base = js::max(system_lowest(score, sys, true, &[p], staff) + AUTO_LYRIC_GAP, 40.0 + staff_gap) + ascent;
                // 源谱版面档：原图量了这一段的基线就照它（中位数），只是不高过让开音符的那条线
                let mut src_of: HashMap<String, f64> = HashMap::new();
                if score.keep_breaks {
                    let mut by_num: Vec<(String, Vec<f64>)> = Vec::new();
                    for &l in &lyrics {
                        if let Some(y) = score[l].src_y {
                            if y < 0.0 {
                                let num = score[l].num();
                                match by_num.iter_mut().find(|(k, _)| *k == num) {
                                    Some((_, v)) => v.push(y),
                                    None => by_num.push((num, vec![y])),
                                }
                            }
                        }
                    }
                    for (num, ys) in by_num {
                        let mut s = ys.clone();
                        js::sort_by(&mut s, |a, b| a - b);
                        src_of.insert(num, s[ys.len() >> 1]);
                    }
                }
                for &l in &lyrics {
                    let num = score[l].num();
                    let verse = verse_index(&num) - skip;
                    score[l].y = js::min(-(base + verse * row), src_of.get(&num).copied().unwrap_or(f64::INFINITY));
                }
                if above.is_empty() {
                    continue;
                }
                // 上方各段：段号小的在上，最大的那段贴着谱表最高处
                let k = score[sys].staves.iter().position(|s| s.part() == p && s.part_staff.sub as f64 == staff);
                let top = js::min(k.map_or(0.0, |k| score.sys_staff_auto_extent(sys, k)[0]), -staff_gap);
                let order = nums(score, &above);
                let descent = fm.descent;
                for &l in &above {
                    let vi = verse_index(&score[l].num());
                    let idx = order.iter().position(|&x| x == vi).map_or(-1.0, |i| i as f64);
                    let kk = order.len() as f64 - 1.0 - idx;
                    score[l].y = -top + AUTO_LYRIC_GAP + descent + kk * row;
                }
            }
        }
    }
}

/// 带版面坐标的谱：歌词照谱里给的 y 排，但只许往下让、不许往上提。
fn clear_lyrics_below_notes(score: &mut StaffLayout) {
    let ascent = -score.defaults.lyric_font.metrics(score.mc).ascent;
    for si in 0..score.systems.len() {
        let sys = SysId(si);
        for p in part_ids(score) {
            let lyrics: Vec<LyricId> =
                system_lyrics(score, sys, &[p]).into_iter().filter(|&l| score.lyric_staff(l) == 0.0 && score[l].y <= 0.0).collect();
            if lyrics.is_empty() {
                continue;
            }
            // 首行歌词字顶
            let mut top = f64::INFINITY;
            for &l in &lyrics {
                top = js::min(top, -score[l].y - ascent);
            }
            let need = system_lowest(score, sys, true, &[p], 0.0) + AUTO_LYRIC_GAP;
            if top >= need {
                continue;
            }
            let dy = need - top;
            for &l in &lyrics {
                score[l].y -= dy;
            }
        }
    }
}

/// 这一行的歌词（`parts` 缺省 = 所有声部）。
fn system_lyrics(score: &StaffLayout, sys: SysId, parts: &[PartId]) -> Vec<LyricId> {
    let mut out = Vec::new();
    for &mif in &score[sys].measures {
        for &p in parts {
            if let Some(md) = pm_at(score, p, score[mif].index) {
                out.extend(score[md].lyrics.iter().copied());
            }
        }
    }
    out
}

/// 这一行第 `staff` 谱表往下伸到哪（cy 向下为正，谱表底线 = 40）：符头、朝下符干、下方记号、下方连音数字、下方 slur/tie。
fn system_lowest(score: &StaffLayout, sys: SysId, with_wedges: bool, parts: &[PartId], staff: f64) -> f64 {
    let four = Fraction::int(4.0);
    let chord_low = |c: ChordId| -> f64 {
        let ch = &score[c];
        let mut low: f64 = 0.0;
        for &nt in &ch.notes {
            low = js::max(low, score.note_cy(nt) + 6.0);
        }
        if !ch.stem_up && ch.note_type().compare_to(&four) < 0 {
            low = js::max(low, score.chord_tail_y(c, false));
        }
        if ch.has_notation(false) {
            low += 20.0;
        }
        low
    };
    let mut max_down = 40.0; // 谱表底线
    for &mif in &score[sys].measures {
        for &p in parts {
            let Some(md) = pm_at(score, p, score[mif].index) else { continue };
            // 倚音也算
            for &c in &score[md].chords {
                let ch = &score[c];
                if ch.rest() || ch.notes.first().map(|&n| score.note_staff(n) as f64) != Some(staff) {
                    continue;
                }
                max_down = js::max(max_down, chord_low(c));
            }
        }
    }
    for &p in parts {
        let mut arcs: Vec<Option<ArcEnds>> = Vec::new();
        for &sl in &score[p].slurs {
            if score[sl].notes.start_note.map(|n| score.note_staff(n) as f64) == Some(staff) {
                arcs.push(score.slur_ends(sys, sl, Some(Notation::Normal)));
            }
        }
        for &t in &score[p].tied {
            if score[t].notes.start_note.map(|n| score.note_staff(n) as f64) == Some(staff) {
                arcs.push(score.tied_ends(sys, t, Some(Notation::Normal)));
            }
        }
        // 弧按声部第一谱表量，第二谱表起折回本谱表
        let off = if staff != 0.0 && !staff.is_nan() {
            pm_at(score, p, score[sys].first_measure).map_or(0.0, |md| score.pm_staff_y(md, staff as usize))
        } else {
            0.0
        };
        for e in arcs.into_iter().flatten() {
            if !e.above {
                max_down = js::max(max_down, arc_extent(&e)[1] - off + 2.0);
            }
        }
        // 自动放到谱表下方的松叶
        if with_wedges {
            for &w in &score[p].wedges {
                let wd = &score[w];
                if !wd.auto_y || wd.staff as f64 != staff {
                    continue;
                }
                if !score.sys_contains(sys, &wd.span.start_tick) && !score.sys_contains(sys, &wd.span.end_tick) {
                    continue;
                }
                max_down = js::max(max_down, wd.ypos + wd.spread / 2.0 + 2.0);
            }
        }
        let fs_scale = score.options.music_font.size / 40.0;
        for &t in &score[p].tuplets {
            let tp = &score[t];
            let Some(sn) = tp.notes.start_note else { continue };
            if tp.span.above || score.note_staff(sn) as f64 != staff {
                continue;
            }
            if !score.sys_contains(sys, &tp.span.start_tick) || !score.sys_contains(sys, &tp.span.end_tick) {
                continue;
            }
            let [ly, ry] = score.tuplet_staff_ends(t);
            let g0: String = Tuplet::make_number(tp.time_modification.denominator).chars().next().map(String::from).unwrap_or_default();
            let num_h = (smufl_top(score.meta, &g0) - smufl_bottom(score.meta, &g0)) * fs_scale;
            max_down = js::max(max_down, (ly + ry) / 2.0 + num_h / 2.0 + 2.0);
        }
    }
    max_down
}

/// 多谱表的谱：上一谱表往下伸的与本谱表往上伸的之间留够净空。只撑大、不缩小。
pub fn auto_staff_distances(score: &mut StaffLayout) {
    for si in 0..score.systems.len() {
        let sys = SysId(si);
        let mut prev: Option<usize> = None;
        for k in 0..score[sys].staves.len() {
            if !score[sys].staves[k].staff_visible {
                continue;
            }
            if let Some(pk) = prev {
                let [_, bot] = score.sys_staff_get_y_bound(sys, pk);
                let [top, _] = score.sys_staff_get_y_bound(sys, k);
                let min_distance =
                    if score.keep_breaks { skyline_gap(score, pk, k, sys) } else { -bot - score[sys].staves[pk].height() + top + AUTO_STAFF_GAP };
                let st = &mut score.systems[si].staves[k];
                st.min_distance = min_distance;
                if st.src_distance.is_none() {
                    st.src_distance = Some(st.distance);
                }
                st.distance = js::max(st.distance, st.min_distance);
            }
            prev = Some(k);
        }
    }
}

/// 源谱版面档：写着 `placement="below"` 的力度记号放回下方。
fn place_dynamics_below(score: &mut StaffLayout) {
    let mc = score.mc;
    for si in 0..score.systems.len() {
        let sys = SysId(si);
        for p in part_ids(score) {
            let ms = score[sys].measures.clone();
            for mif in ms {
                let Some(md) = pm_at(score, p, score[mif].index) else { continue };
                for ti in 0..score[md].text_blocks.len() {
                    let t = score[md].text_blocks[ti];
                    let Some(src) = score[t].src else { continue };
                    if !score[t].auto_y || src.placement != Some(Placement::Below) {
                        continue;
                    }
                    let t_staff = score[t].staff as f64;
                    if src.kind == "words" {
                        // 文字记号：放在这一谱表下方最低处之下，有歌词就在末行歌词之下
                        let h = tight_line_heights(&score[t].block, score.meta, mc, score.options.music_font.size, score.options.text_line_height_by_size);
                        if h.is_empty() {
                            continue;
                        }
                        let lyr: Vec<LyricId> = system_lyrics(score, sys, &[p])
                            .into_iter()
                            .filter(|&l| score.lyric_staff(l) == t_staff && score[l].y < 0.0 && !score[l].empty())
                            .collect();
                        let mut low = js::max(f64::NEG_INFINITY, system_lowest(score, sys, true, &[p], t_staff));
                        for &l in &lyr {
                            low = js::max(low, -score[l].y + score[l].font.metrics(mc).descent);
                        }
                        score[t].y = -(low + DYNAMIC_BELOW_GAP) - h[0];
                        continue;
                    }
                    if src.kind != "dynamics" {
                        continue;
                    }
                    // 同一谱表、这个拍位起最近的那个字
                    let t_off = score[t].offset;
                    let mut cand: Vec<LyricId> = score[md]
                        .lyrics
                        .iter()
                        .copied()
                        .filter(|&l| score.lyric_staff(l) == t_staff && !score[l].empty() && score[l].offset.compare_to(&t_off) >= 0)
                        .collect();
                    js::sort_by(&mut cand, |a, b| {
                        let c = score[*a].offset.compare_to(&score[*b].offset) as f64;
                        if c != 0.0 {
                            c
                        } else {
                            score[*a].y - score[*b].y
                        }
                    });
                    let lrc = cand.first().copied();
                    match lrc {
                        Some(lrc) if score[lrc].y < 0.0 => {
                            let abs = |l: LyricId| score.pm_xpos(score[l].measure) + score[l].x + score[l].x_offset;
                            let at = abs(lrc);
                            let tw = score[t].width(mc);
                            let left = at - DYNAMIC_LYRIC_GAP - tw;
                            let lrc_staff = score.lyric_staff(lrc);
                            let lrc_num = score[lrc].num();
                            let mut prev_right = f64::NEG_INFINITY;
                            for l in system_lyrics(score, sys, &[p]) {
                                if l != lrc && score.lyric_staff(l) == lrc_staff && score[l].num() == lrc_num && !score[l].empty() && abs(l) < at {
                                    prev_right = js::max(prev_right, abs(l) + score[l].width);
                                }
                            }
                            if left < prev_right + DYNAMIC_LYRIC_GAP {
                                continue;
                            }
                            let ent = score.measure_get_ent_pos(mif, &t_off);
                            let ly = &score[lrc];
                            let (ny, nx) = (ly.y, ly.x + ly.x_offset - DYNAMIC_LYRIC_GAP - tw - ent);
                            score[t].y = ny;
                            score[t].x = nx;
                        }
                        _ => {
                            // 不算松叶：力度与松叶同排一行
                            score[t].y = -(system_lowest(score, sys, false, &[p], t_staff) + DYNAMIC_BELOW_GAP + DYNAMIC_ASCENT);
                        }
                    }
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Ink {
    staff: f64,
    x0: f64,
    x1: f64,
    top: f64,
    bottom: f64,
}

/// 与 [x0, x1] × [bottom, top]（向上为正）相交的歌词里最低的字底；没有相交的返回 None
fn lowest_hit(ink: &[Ink], staff: f64, x0: f64, x1: f64, bottom: f64, top: f64) -> Option<f64> {
    let mut low: Option<f64> = None;
    for k in ink {
        if k.staff != staff || k.x1 <= x0 || k.x0 >= x1 || k.top <= bottom || k.bottom >= top {
            continue;
        }
        // 挪下去之后可能又碰上更低一行：把同一横向范围里这一行以下的都算上
        let mut v = low.unwrap_or(f64::INFINITY);
        for q in ink {
            if q.staff == staff && q.x1 > x0 && q.x0 < x1 && q.top <= k.top {
                v = js::min(v, q.bottom);
            }
        }
        low = Some(v);
    }
    low
}

/// 源谱版面档：照原图位置放的、在谱表下方的力度与松叶，压上歌词的挪到下面。
fn settle_source_marks(score: &mut StaffLayout) {
    let mc = score.mc;
    // 小节内某拍位的横坐标（相对小节）：取落在这一拍上的和弦的符头 x，没有就退回 `getEntPos`
    let ent_x = |score: &StaffLayout, mif: MeasId, t: &Fraction| -> f64 {
        let mut x = f64::INFINITY;
        for p in part_ids(score) {
            let Some(md) = pm_at(score, p, score[mif].index) else { continue };
            for &c in &score[md].chords {
                let ch = &score[c];
                if !ch.grace() && ch.offset.compare_to(t) == 0 {
                    if let Some(&n0) = ch.notes.first() {
                        x = js::min(x, score[n0].x);
                    }
                }
            }
        }
        if x < f64::INFINITY {
            x
        } else {
            score.measure_get_ent_pos(mif, t)
        }
    };
    for si in 0..score.systems.len() {
        let sys = SysId(si);
        for p in part_ids(score) {
            let lyr: Vec<LyricId> = system_lyrics(score, sys, &[p]).into_iter().filter(|&l| !score[l].empty() && score[l].y < 0.0).collect();
            if lyr.is_empty() {
                continue;
            }
            let ink: Vec<Ink> = lyr
                .iter()
                .map(|&l| {
                    let ly = &score[l];
                    let x0 = score.pm_xpos(ly.measure) + ly.x + ly.x_offset;
                    Ink {
                        staff: score.lyric_staff(l),
                        x0,
                        x1: x0 + ly.width,
                        top: ly.y + ly.font.size * 0.8,
                        bottom: ly.y - ly.font.metrics(mc).descent,
                    }
                })
                .collect();
            let ms = score[sys].measures.clone();
            for &mif in &ms {
                let Some(md) = pm_at(score, p, score[mif].index) else { continue };
                for ti in 0..score[md].text_blocks.len() {
                    let t = score[md].text_blocks[ti];
                    if !score[t].source_y || score[t].y >= 0.0 {
                        continue;
                    }
                    let size = score[t].data.iter().map(|it| it.font.size).fold(0.0, js::max);
                    let t_off = score[t].offset;
                    let x0 = score.measure_xpos(mif) + ent_x(score, mif, &t_off) + score[t].x;
                    // Bravura 力度字母的墨迹约在基线下 0.15 em、上 0.45 em
                    let w = score[t].width(mc);
                    let ty = score[t].y;
                    let t_staff = score[t].staff as f64;
                    let Some(low) = lowest_hit(&ink, t_staff, x0, x0 + w, ty - size * 0.15, ty + size * 0.45) else { continue };
                    // 撞上的是同一行的字：先往左挪到贴着它，那里放得下才挪；不行再挪到歌词下面
                    let mut same: Vec<Ink> = ink
                        .iter()
                        .copied()
                        .filter(|k| k.staff == t_staff && k.x1 > x0 && k.x0 < x0 + w && (k.bottom + (k.top - k.bottom) * 0.2 - ty).abs() < size * 0.5)
                        .collect();
                    js::sort_by(&mut same, |a, b| a.x0 - b.x0);
                    if let Some(same) = same.first() {
                        let nx = same.x0 - DYNAMIC_LYRIC_GAP - w;
                        let m0 = ms[0];
                        let sys_left = score.measure_xpos(m0) + score[m0].data_pos;
                        if nx >= sys_left && lowest_hit(&ink, t_staff, nx, nx + w, ty - size * 0.15, ty + size * 0.45).is_none() {
                            score[t].x += nx - x0;
                            continue;
                        }
                    }
                    score[t].y = low - SOURCE_MARK_GAP - size * 0.45;
                }
            }
            for wi in 0..score[p].wedges.len() {
                let w = score[p].wedges[wi];
                let wd = score[w].clone();
                if wd.auto_y || wd.ypos <= 40.0 {
                    continue;
                }
                let (ml, mr) = (wd.start_measure, wd.end_measure);
                if score[ml].system != Some(sys) || score[mr].system != Some(sys) {
                    continue;
                }
                // 拍位的横坐标取那一拍上和弦的实际 x
                let x0 = score.measure_xpos(ml) + ent_x(score, ml, &wd.span.start_tick.minus(&score[ml].offset)) + wd.dx_left;
                let x1 = js::min(
                    score.measure_xpos(mr) + ent_x(score, mr, &wd.span.end_tick.minus(&score[mr].offset)) + wd.dx_right,
                    score.measure_xpos(mr) + score[mr].width,
                );
                let low = lowest_hit(&ink, wd.staff as f64, x0, x1, -wd.ypos - wd.spread / 2.0, -wd.ypos + wd.spread / 2.0);
                if let Some(low) = low {
                    score[w].ypos = -low + SOURCE_MARK_GAP + wd.spread / 2.0;
                }
            }
        }
    }
}


/// 源谱版面档：两行谱按横向轮廓（`SysStaff.skyline`）算不相碰的距离，再留 `AUTO_STAFF_GAP`。
fn skyline_gap(score: &StaffLayout, upper: usize, lower: usize, sys: SysId) -> f64 {
    let a = score.sys_staff_skyline(sys, upper, false);
    let b = score.sys_staff_skyline(sys, lower, false);
    let uh = score[sys].staves[upper].height();
    let mut need = 0.0;
    for k in 0..a.below.len() {
        // 两边段数不一样时 TS 读到 undefined，算出 NaN
        need = js::max(need, a.below[k] - uh + b.above.get(k).copied().unwrap_or(f64::NAN));
    }
    need + AUTO_STAFF_GAP
}

/// 标题/词曲信息按页面重排：标题居中大字，作词/作曲逐行靠右小字，堆叠在标题下方。
fn auto_layout_header(score: &mut StaffLayout) {
    let d = &score.defaults;
    let (page_width, page_height, right_margin) = (d.page_width, d.page_height, d.right_margin);
    let cx = page_width / 2.0;
    // credit 字号是 pt（画时除 scaling），纵向累积在 tenths 里，得换算
    let scaling = score.scaling;
    let tenths = |pt: f64| pt / scaling;
    // 页眉字号：设置面板「页眉」一组给了就用，没给按出厂 20 / 11
    let hf = &score.options.header_fonts;
    let size_of = |k: &str| hf.get(k).and_then(|f| f.size);
    let title_fs = size_of("title").unwrap_or(AUTO_TITLE_FS);
    let credit_fs = size_of("credit").unwrap_or(AUTO_CREDIT_FS);
    let subtitle_fs = size_of("subtitle").unwrap_or(credit_fs);
    let scripture_fs = size_of("scripture").unwrap_or(credit_fs);
    let mut creds: Vec<ScoreCredit> = Vec::new();
    let mut y_top = d.top_margin + 8.0; // 自上边距向下累积基线
    let title = score.title();
    let credit = |text: &str, ty: Option<String>, x: f64, y: f64, justify: Lcr, font_size: f64| ScoreCredit {
        page: 0.0,
        text: text.to_owned(),
        r#type: ty,
        x,
        y,
        justify,
        font_size,
        family: None,
        bold: None,
        valign: None,
    };
    if !title.is_empty() {
        y_top += tenths(title_fs);
        creds.push(credit(&title, Some("title".into()), cx, page_height - y_top, Lcr::Center, title_fs));
        y_top += tenths(title_fs) * 0.4;
    }
    // 标题下依次：副标题 → 题下经文（居中小字）→ 其余 credit（靠右），各自按原顺序
    let mut push = |creds: &mut Vec<ScoreCredit>, text: &str, ty: Option<String>, fs: f64, right: bool| {
        y_top += tenths(fs) * 1.3;
        creds.push(credit(
            text,
            ty,
            if right { page_width - right_margin } else { cx },
            page_height - y_top,
            if right { Lcr::Right } else { Lcr::Center },
            fs,
        ));
    };
    // 标题已按 `score.title` 排了：credit 里的标题那条不再排第二遍
    let norm = |t: &str| -> String { t.chars().filter(|&c| !js::is_space(c)).collect() };
    let rest: Vec<ScoreCredit> = score
        .credits
        .iter()
        .filter(|c| !c.text.is_empty() && !(!title.is_empty() && (c.r#type.as_deref() == Some("title") || norm(&c.text) == norm(&title))))
        .cloned()
        .collect();
    for c in &rest {
        if c.r#type.as_deref() == Some("subtitle") {
            push(&mut creds, &c.text, c.r#type.clone(), subtitle_fs, false);
        }
    }
    for t in &score.scripture {
        push(&mut creds, t, Some("scripture".into()), scripture_fs, false);
    }
    for c in &rest {
        if c.r#type.as_deref() != Some("subtitle") {
            push(&mut creds, &c.text, c.r#type.clone(), credit_fs, true);
        }
    }
    score.credits = creds;
}

/// 自动铺排的谱：连音的音符全在同一组符杠下、符干同向时，数字放到符杠那一端、不画方括号。
fn auto_place_tuplets(score: &mut StaffLayout) {
    for p in part_ids(score) {
        let groups: Vec<BeamId> = score[p].measures.iter().flat_map(|&md| score[md].beams.iter().copied()).collect();
        for k in 0..score[p].tuplets.len() {
            let t = score[p].tuplets[k];
            let tp = &score[t];
            if tp.notes.start_note.is_none() || tp.notes.end_note.is_none() || tp.bracket.is_some() {
                continue;
            }
            let chl = score.tuplet_start_chord(t);
            let chr = score.tuplet_end_chord(t);
            let Some(&g) = groups.iter().find(|&&bg| score[bg].chords.contains(&chl) && score[bg].chords.contains(&chr)) else { continue };
            if score[g].double_dir {
                continue;
            }
            let cs = &score[g].chords;
            let il = cs.iter().position(|&c| c == chl).expect("在组里");
            let ir = cs.iter().position(|&c| c == chr).expect("在组里") + 1;
            let span: &[ChordId] = if ir > il { &cs[il..ir] } else { &[] };
            let up = score[chl].stem_up;
            if span.iter().any(|&c| !score[c].rest() && score[c].stem_up != up) {
                continue;
            }
            score[t].span.above = up;
            score[t].bracket = Some(false);
        }
    }
}

fn layout_attr(score: &mut StaffLayout) {
    let zero = Fraction::int(0.0);
    for mi in 0..score.measures.len() {
        let sys = score.measures[mi].system.expect("小节已分到系统里");
        let nsys = score[sys].first_measure == score.measures[mi].index;
        let off = score.measures[mi].offset;

        let has_clef = nsys;
        let has_key = nsys;
        let mut key_change = false;
        let mut time_change = false;
        let mut key_width = 0.0;
        let mut time_width = 0.0;

        for k in 0..score[sys].staves.len() {
            let st = &score[sys].staves[k];
            if !st.staff_visible {
                continue;
            }
            let ps = st.part_staff;
            if score.part_staff(ps).key_change(&off) {
                if nsys && score.measures[mi].index > 0 {
                    let prev = &score.measures[score.measures[mi].index - 1];
                    let psys = prev.system.expect("小节已分到系统里");
                    let prev_stf = score[psys].staves.iter().find(|s| s.part_staff == ps);
                    if prev_stf.is_some_and(|s| s.staff_visible) {
                        key_change = true;
                    }
                } else {
                    key_change = true;
                }
            }
            if score.part_staff(ps).time_change(&off) {
                time_change = true;
            }

            if has_key || key_change {
                let ks = score.part_staff(ps).get_key(&off);
                let w = key_change_width_calc(ks.cancel, ks.fifths);
                if w > key_width {
                    key_width = w;
                }
                let mut jp = false;
                for part in &score.parts {
                    if let Some(&md) = part.measures.get(mi) {
                        for &h in &score[md].harmonies {
                            if f_eq(&score[h].offset, &zero) {
                                jp = true;
                            }
                        }
                    }
                }
                if jp {
                    score.measures[mi].key_offest_jp = Some(-20.0);
                }
            }
            if time_change {
                let ts = score.part_staff(ps).get_time(&off);
                let w = time_sig_width_calc(&ts, score);
                if w > time_width {
                    time_width = w;
                }
            }
        }

        // parser.cpp::layoutAttr 里 `auto xpos = 5` 是 int，累加拍号宽（字形 bbox，带小数）时逐次截断
        let mif = &mut score.measures[mi];
        let mut xpos = 5.0;
        if has_clef {
            mif.clef_pos = Some(xpos);
            xpos += 32.0;
        }
        if has_key || key_change {
            mif.key_pos = Some(xpos);
            xpos = (xpos + key_width).trunc();
        }
        if time_change {
            mif.time_pos = Some(xpos);
            xpos = (xpos + time_width).trunc();
        }
        if mif.forward && nsys {
            mif.left_barline_pos = xpos + 20.0;
            xpos += 30.0;
        }
        mif.data_pos = xpos;
        mif.data_end = mif.width;

        if nsys && mif.index > 0 {
            let pi = mif.index - 1;
            let psys = score.measures[pi].system.expect("小节已分到系统里");
            if key_change {
                score[psys].key_change_width = key_width;
                score.measures[pi].data_end -= key_width + 5.0;
            }
            if time_change {
                score[psys].time_change_width = time_width;
                score.measures[pi].data_end -= time_width + 5.0;
                if let Some(&last) = score[psys].measures.last() {
                    score[last].width += time_width + 5.0;
                }
            }
        }

        // 宽右小节线（终止线/双线等）占的横向宽度从 dataEnd 扣除
        if let Some(rb) = score.measures[mi].right_barline {
            let lws = &score.options.line_widths;
            let dist = score.options.barline_dist;
            let blw = match rb {
                BarGlyph::Final => lws.heavy_barline + lws.light_barline + dist,
                BarGlyph::Double => lws.light_barline * 2.0 + dist,
                BarGlyph::HeavyHeavy => lws.heavy_barline * 2.0 + dist,
                _ => 0.0,
            };
            score.measures[mi].data_end -= blw;
        }
    }
}

/// `Math.sign`
fn js_sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

fn key_change_width_calc(cancel: f64, key: f64) -> f64 {
    let mut res = 5.0;
    if cancel * key < 0.0 {
        res += (cancel.abs() + key.abs()) * 10.0;
    } else {
        res += js::max(key.abs(), cancel.abs()) * 10.0;
        if cancel.abs() > 0.0 && key.abs() > 0.0 && js_sign(cancel) != js_sign(key) {
            res += js::min(key.abs(), cancel.abs()) * 10.0;
        }
    }
    res
}

/// parser.cpp::timeChangeWidth：分子、分母各自逐位累加 timeSigN 字形 bbox 宽，取大者。
fn time_sig_width_calc(ts: &TimeSig, score: &StaffLayout) -> f64 {
    if ts.symbol {
        return 30.0;
    }
    let width = |n: f64| {
        let mut w = 0.0;
        for c in js::num_to_string(n).chars() {
            w += match score.meta.bbox_by_name(&format!("timeSig{c}")) {
                Some(b) => (b.ne[0] - b.sw[0]) * 10.0,
                None => 10.0,
            };
        }
        w
    };
    js::max(width(ts.beats), width(ts.beat_type))
}

fn update_ent_pos(score: &mut StaffLayout) {
    for i in 0..score.measures.len() {
        for p in part_ids(score) {
            let Some(md) = pm_at(score, p, i) else { continue };
            for k in 0..score[md].chords.len() {
                let c = score[md].chords[k];
                if score[c].rest() && f_eq(&score[c].dur(), &score.measures[i].dur) {
                    continue;
                }
                let (t, x) = (score[c].offset, score.chord_ent_x(c));
                score.measures[i].ent_pos.set(t, x);
            }
        }
    }
}

/// 写在小节末的跳转字（`/^\s*(Fine|D\.\s*[CS]\..*|To\s*Coda.*)\s*$/i`）
fn is_jump_word(s: &str) -> bool {
    let t = js::trim(s);
    // `.` 不吃行终止符
    let no_lt = |r: &str| !r.chars().any(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'));
    let skip_sp = |r: &str| -> usize { r.char_indices().find(|&(_, c)| !js::is_space(c)).map_or(r.len(), |(i, _)| i) };
    let strip_ci = |r: &str, p: &str| -> Option<usize> {
        let head = r.get(..p.len())?;
        head.eq_ignore_ascii_case(p).then_some(p.len())
    };
    if t.eq_ignore_ascii_case("fine") {
        return true;
    }
    if let Some(n) = strip_ci(t, "d.") {
        let r = &t[n..];
        let r = &r[skip_sp(r)..];
        let mut it = r.chars();
        if matches!(it.next(), Some('c' | 'C' | 's' | 'S')) && it.next() == Some('.') {
            return no_lt(&r[2..]);
        }
        return false;
    }
    if let Some(n) = strip_ci(t, "to") {
        let r = &t[n..];
        let r = &r[skip_sp(r)..];
        if let Some(m) = strip_ci(r, "coda") {
            return no_lt(&r[m..]);
        }
    }
    false
}

fn update_data_x_pos(score: &mut StaffLayout) {
    score.data_x_placed = true;
    let mc = score.mc;
    for p in part_ids(score) {
        for i in 0..score.measures.len() {
            let mif = MeasId(i);
            let Some(md) = pm_at(score, p, i) else { continue };
            // `<harmony relative-x>`：和弦相对拍位的横向微调
            for k in 0..score[md].harmonies.len() {
                let h = score[md].harmonies[k];
                let rx = xml_pos(score, score[h].src.oid).and_then(|q| q.relative_x).unwrap_or(0.0);
                score[h].x = score.measure_get_ent_pos(mif, &score[h].offset) + rx;
            }
            for k in 0..score[md].text_blocks.len() {
                let t = score[md].text_blocks[k];
                let tb = &score[t];
                // 右对齐的跳转字（Fine、D.S.、D.C.、To Coda）右缘贴本小节的右小节线
                if !tb.data.is_empty() && tb.justify == Lcr::Right && is_jump_word(&tb.data.iter().map(|d| d.text.as_str()).collect::<String>()) {
                    let x = score.measures[i].width - tb.width(mc);
                    score[t].x = x;
                    score[t].justify = Lcr::Left;
                    continue;
                }
                if tb.data.is_empty() || !tb.relative {
                    continue;
                }
                // 写在小节末尾的（`D.S.` / `Fine`）与小节线右对齐：只管自动铺排、原文没写横坐标的
                if score.auto_layout
                    && f_eq(&tb.offset, &score.measures[i].dur)
                    && tb.justify != Lcr::Center
                    && tb.x == 0.0
                    && tb.src.is_some_and(|src| {
                        let pos = xml_pos(score, src.oid);
                        !truthy(pos.and_then(|q| q.relative_x)) && !truthy(pos.and_then(|q| q.default_x))
                    })
                {
                    let x = score.measures[i].width - tb.width(mc);
                    score[t].x = x;
                    score[t].justify = Lcr::Left;
                    continue;
                }
                let ent = score.measure_get_ent_pos(mif, &tb.offset);
                score[t].x += ent;
            }
        }
    }
}

/// 分行分页。`autoBreaks` 给了就只认它与 `new-page`（`new-system` 已被它当优选断点吸收）；带版面的谱逐字认 `<print>`。
fn build_systems_and_pages(score: &mut StaffLayout, input: &LayoutInput, auto_breaks: Option<&BTreeSet<usize>>) {
    let mut new_system: HashSet<usize> = auto_breaks.map(|b| b.iter().copied().collect()).unwrap_or_default();
    let mut new_page: HashSet<usize> = HashSet::new();

    for pt in input {
        for (mid, mea) in pt.iter().enumerate() {
            for pr in &mea.prints {
                if pr.new_page {
                    new_page.insert(mid);
                    new_system.insert(mid);
                } else if pr.new_system && auto_breaks.is_none() {
                    new_system.insert(mid);
                }
            }
        }
    }
    for &i in &new_system {
        // TS：越界的小节号读 undefined.implicit 抛错，这里同样 panic
        if i > 0 && !score.measures[i].implicit {
            score.measures[i].show_bar_number = true;
        }
    }
    for i in 0..score.measures.len() {
        let mif = MeasId(i);
        let need_new_sys = score.systems.is_empty() || new_system.contains(&i);
        if !need_new_sys {
            let sys = SysId(score.systems.len() - 1);
            score[sys].measures.push(mif);
            score[mif].system = Some(sys);
        } else {
            let mut staves = Vec::new();
            for (pi, part) in score.parts.iter().enumerate() {
                for k in 0..part.staves.len() {
                    staves.push(SysStaff::new(PsRef { part: PartId(pi), sub: k }));
                }
            }
            let sys = score.new_system(Sys { first_measure: i, measures: vec![mif], index: score.systems.len(), staves, ..Sys::default() });
            score[mif].system = Some(sys);
        }
    }

    for si in 0..score.systems.len() {
        let need_new_page = score.pages.is_empty() || new_page.contains(&score.systems[si].first_measure);
        if need_new_page {
            score.pages.push(MPage { systems: vec![SysId(si)], ..MPage::default() });
        } else {
            score.pages.last_mut().expect("有页").systems.push(SysId(si));
        }
    }
}

/// 空谱表隐藏：`<staff-details print-object>` 切换某谱表可见性，状态跨系统延续，在每个 system 的 firstMeasure 处应用。
fn apply_staff_visibility(score: &mut StaffLayout, input: &LayoutInput) {
    // measureIdx → (全局谱表序号 → 可见)
    let mut changes: HashMap<usize, Vec<(i64, bool)>> = HashMap::new();
    let mut stf_off: i64 = 0;
    for (pid, pt) in input.iter().enumerate() {
        let n_staves = score.parts[pid].staves.len() as i64;
        for (mid, mea) in pt.iter().enumerate() {
            for det in &mea.staff_details {
                let Some(po) = &det.print_object else { continue };
                let g = stf_off + det.number - 1;
                let m = changes.entry(mid).or_default();
                match m.iter_mut().find(|x| x.0 == g) {
                    Some(x) => x.1 = po != "no",
                    None => m.push((g, po != "no")),
                }
            }
        }
        stf_off += n_staves;
    }
    if changes.is_empty() {
        return;
    }

    let total = stf_off.max(0) as usize;
    let mut sys_by_first: HashMap<usize, SysId> = HashMap::new();
    for (si, sys) in score.systems.iter().enumerate() {
        sys_by_first.insert(sys.first_measure, SysId(si));
    }

    let mut vis_prev = vec![true; total];
    for mid in 0..score.measures.len() {
        if let Some(ch) = changes.get(&mid) {
            for &(g, v) in ch {
                // 负下标、越界下标在 TS 里落到数组属性上，下面读不到
                if g >= 0 && (g as usize) < total {
                    vis_prev[g as usize] = v;
                }
            }
        }
        if let Some(&sys) = sys_by_first.get(&mid) {
            let n = score[sys].staves.len();
            let mut i = 0;
            while i < n && i < total {
                score[sys].staves[i].staff_visible = vis_prev[i];
                i += 1;
            }
        }
    }
}

fn update_layout_by_print(score: &mut StaffLayout, input: &LayoutInput) {
    for si in 0..score.systems.len() {
        let sys = SysId(si);
        let mut stf_off: i64 = 0;
        for (pid, pt) in input.iter().enumerate() {
            let n_staves = score.parts[pid].staves.len() as i64;
            let Some(mea) = pt.get(score[sys].first_measure) else {
                stf_off += n_staves;
                continue;
            };
            for pr in &mea.prints {
                if let Some(sl) = &pr.system_layout {
                    if let Some((left, right)) = sl.margins {
                        let s = &mut score[sys];
                        s.left_margin = left.unwrap_or(s.left_margin);
                        s.right_margin = right.unwrap_or(s.right_margin);
                    }
                    if let Some(dist) = sl.top_system_distance.or(sl.system_distance) {
                        score[sys].distance = dist;
                    }
                }
                for stf_lay in &pr.staff_layouts {
                    let stf_idx = stf_off + stf_lay.number - 1;
                    if let Some(dist) = stf_lay.staff_distance {
                        if stf_idx < score[sys].staves.len() as i64 {
                            // TS：负下标读 undefined.distance 抛错，这里同样 panic
                            let k = usize::try_from(stf_idx).expect("谱表号从 1 起");
                            score[sys].staves[k].distance = dist;
                        }
                    }
                }
            }
            stf_off += n_staves;
        }
    }
    // Default distances
    for sys in score.systems.iter_mut() {
        let mut first_visible = true;
        for st in sys.staves.iter_mut() {
            if !st.staff_visible {
                st.distance = 0.0;
                continue;
            }
            if first_visible {
                st.distance = 0.0;
                first_visible = false;
            } else if st.distance == 0.0 {
                st.distance = 80.0;
            }
        }
        if sys.distance == 0.0 {
            sys.distance = 80.0;
        }
    }

    // 系统距离换成页内绝对 y：每页首个系统的 top-system-distance 是绝对的，其余是离上一系统底的距离
    for pi in 0..score.pages.len() {
        let mut abs_y = 0.0;
        let mut prev_height = 0.0;
        for si in 0..score.pages[pi].systems.len() {
            let sys = score.pages[pi].systems[si];
            if si == 0 {
                abs_y = score[sys].distance; // already absolute
            } else {
                abs_y = abs_y + prev_height + score[sys].distance;
                score[sys].distance = abs_y;
            }
            prev_height = score[sys].height();
        }
    }
}

/// 各声部读完之后的收尾：全局 tick、跨小节对象的绝对 tick、简谱符杠、整个版面 pass、声部分组、Sibelius 修正。
pub fn finish_mixed_score(score: &mut StaffLayout, input: &LayoutInput, part_groups: Vec<PartGroup>, probe: Probe) {
    // Staff order
    let mut ord = 0;
    for part in score.parts.iter_mut() {
        for st in part.staves.iter_mut() {
            st.order = ord;
            ord += 1;
        }
    }

    // Global measure offsets
    let mut tick = Fraction::int(0.0);
    for mif in score.measures.iter_mut() {
        mif.offset = tick;
        tick = tick.plus(&mif.dur);
    }

    // 跨小节对象的 startTick/endTick 必须在 mif.offset 赋值后再算
    for p in part_ids(score) {
        for k in 0..score[p].slurs.len() {
            let sl = score[p].slurs[k];
            let (a, b) = (score.chord_tick(score.slur_start_chord(sl)), score.chord_tick(score.slur_end_chord(sl)));
            score[sl].span.start_tick = a;
            score[sl].span.end_tick = b;
        }
        for k in 0..score[p].tied.len() {
            let t = score[p].tied[k];
            let (a, b) = (score.chord_tick(score.tied_start_chord(t)), score.chord_tick(score.tied_end_chord(t)));
            score[t].span.start_tick = a;
            score[t].span.end_tick = b;
        }
        // ending 同理：左反复 tick = 起始小节 offset，右反复 tick = 结束小节末端
        for k in 0..score[p].endings.len() {
            let e = score[p].endings[k];
            let (a, b) = (score[score[e].start_measure].offset, score[score[e].end_measure].end_tick());
            score[e].span.start_tick = a;
            score[e].span.end_tick = b;
        }
    }

    // processJpBeam
    for p in part_ids(score) {
        for k in 0..score[p].measures.len() {
            let md = score[p].measures[k];
            score.pm_process_jp_beam(md);
        }
    }

    // Layout pass。无内嵌版面坐标（OMR 生成谱）时自动计算小节宽度/折行/音符横向位置。
    let auto_layout = score.auto_layout;
    // 源谱版面档的页眉带着原图的位置与字号：照原样排，不重排
    let placed_header =
        score.keep_breaks && score.credits.iter().any(|c| c.r#type.as_deref() == Some("title")) && score.credits.iter().all(|c| c.y > 0.0);
    if auto_layout && !placed_header {
        auto_layout_header(score);
    }
    let auto_breaks = if !auto_layout {
        None
    } else if score.keep_breaks {
        Some(source_breaks(score, input))
    } else if score.hard_breaks {
        Some(written_breaks(score, input))
    } else {
        Some(auto_layout_widths(score, input))
    };
    build_systems_and_pages(score, input, auto_breaks.as_ref());
    apply_staff_visibility(score, input);
    update_layout_by_print(score, input);
    if auto_layout {
        auto_justify_systems(score);
    }
    layout_attr(score);
    probe("systems", &*score);
    if auto_layout {
        auto_place_notes(score);
        auto_place_tuplets(score);
        auto_place_wedges(score);
        auto_place_lyrics_y(score);
    } else {
        clear_lyrics_below_notes(score);
    }
    if score.keep_breaks {
        place_dynamics_below(score);
        settle_source_marks(score);
    }
    if auto_layout {
        auto_staff_distances(score);
    }
    update_ent_pos(score);
    update_data_x_pos(score);

    // Part groups
    score.part_groups = part_groups;

    // Sibelius fixes（parser.cpp:2890-2895，行首调号变更偏移须在 layoutAttr/updateDataXPos 之后）
    if score.encoder() == Encoder::Sibelius {
        for si in 0..score.systems.len() {
            score.sys_fix_sib_key_change(SysId(si));
        }
        for p in part_ids(score) {
            score.part_fix_tie_for_sib(p);
        }
    }
}
