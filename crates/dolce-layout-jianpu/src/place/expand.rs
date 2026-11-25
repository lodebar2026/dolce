//! 投影档：反复与多段歌词逐遍展开、逐行装满（照 `place/expand.ts`）。
//!
//! 按演唱顺序（`PlayItem[]`）把行视图里的小节逐遍切出来，每遍接成一长行、只挂这一遍的歌词，再按版心宽逐行装满，
//! 拼成一份「展开后的」行视图交给 `layout_song` 照常排。TS 按对象身份记的几张表在这里按下标平行存：
//! 新行的 `ids` 取源元素的 id（TS `idOf.set(el, id)`）、`owners` 取源音节的归属（`syllableOwner`）、`passes` 是各符号的遍号（`passesOfRow`）。

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;

use dolce_base::fraction::Fraction;
use dolce_base::js::{self, NumKey};
use dolce_model as dm;
use dolce_model::helpers::{is_refrain_word, section_mark_of};
use dolce_model::layouts::{find_layout, LineBreak, PROJECTION};
use dolce_model::{BreakKind, LayoutSpec, ScoreDoc, SourceFormat};
use dolce_play::playorder::PlayItem;
use dolce_play::walk::{walk_play, Step, WalkItem};
use dolce_view::ast::{BarlineElement, BarlineType, LyricLine, LyricSyllable, Mark, MarkType, Meter, MusicElement, ScoreLine, Sound};
use dolce_play::phrase::{FitMetric, Span};
use dolce_view::phraselines::{content_breaks, default_content_options, element_quarters};
use dolce_view::phrasesong::{build_measures, distinct_verses, phrase_part_of};
use dolce_view::slots::RowView;
use dolce_view::playdata::PlayData;

use crate::grid::{content_width, JianpuGrid};
use crate::ink::Ink;
use crate::place::spacing::{natural_columns, Natural, SpacedLine};
use crate::place::voice::{assign_lyrics, layout_voice_line, takes_lyric, tuplet_ratios, BeatCtx, VoiceLine};
use crate::util::{max, max_of, min, min_of};
use crate::view::{LDoc, LGroup, LPage, LRow, LSong};

/// `fillLines` 的选项
#[derive(Clone, Debug, Default)]
pub struct FillOpts {
    pub hard: HashSet<usize>,
    pub jump_in: HashSet<usize>,
    pub soft: HashSet<usize>,
    pub glue: HashSet<usize>,
    /// 强制换行切出的纯休止行（按乐句断出的间奏小节）单独成行，不并进下一行
    pub keep_rest_lines: bool,
}

/// 一行的起点（行内元素下标）与是否在此换页
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LineCut {
    pub start: usize,
    pub page: bool,
}

/// 行视图里的一个符号：（展开声部的行序，行内下标）
type Slot = (usize, usize);

/// 按插入次序的小整数集合（JS `Set<number>`：删掉再加落到末尾）
#[derive(Clone, Debug, Default)]
struct OSet(Vec<usize>);

impl OSet {
    fn has(&self, x: usize) -> bool {
        self.0.contains(&x)
    }
    fn add(&mut self, x: usize) {
        if !self.has(x) {
            self.0.push(x);
        }
    }
    fn delete(&mut self, x: usize) {
        self.0.retain(|&y| y != x);
    }
}

/// 按插入次序的「串 → 数」表（JS `Map<string, number>`）
#[derive(Clone, Debug, Default)]
struct OMap {
    keys: Vec<String>,
    vals: HashMap<String, f64>,
}

impl OMap {
    fn set(&mut self, k: String, v: f64) {
        if !self.vals.contains_key(&k) {
            self.keys.push(k.clone());
        }
        self.vals.insert(k, v);
    }
    fn get(&self, k: &str) -> Option<f64> {
        self.vals.get(k).copied()
    }
    fn entries(&self) -> Vec<(String, f64)> {
        self.keys.iter().map(|k| (k.clone(), self.vals[k])).collect()
    }
}

/// 一遍：按次序的符号、各符号所属的歌词遍号；`breaks`：源里的换行 / 换页落在第几个符号之前（true = 换页）
#[derive(Clone, Debug, Default)]
struct Pass {
    slots: Vec<Slot>,
    verses: Vec<f64>,
    /// 与 `verses` 平行（JS 稀疏数组口径：长度到最后设过的那一格）：`P:` 段落（`PlayData.scopes` 的下标）
    scopes: Option<Vec<Option<usize>>>,
    breaks: HashMap<usize, bool>,
    /// 往回跳（同一段词）处必断的行
    hard: OSet,
    /// 不许在它前面换行的符号
    glue: HashSet<usize>,
    after_repeat: bool,
    mid_verse: bool,
}

/// 一条跨符号的记号（跨行的续接段已连成一条）
#[derive(Clone, Debug)]
struct LogicalMark {
    mark: Mark,
    start: (usize, i64),
    end: (usize, i64),
}

/// 展开声部的源行与由它备好的几张表
struct Src<'a> {
    rows: Vec<Rc<LRow>>,
    song: &'a dm::Song,
    lyrics_of: Vec<Vec<LyricLine>>,
    cursor_of: Vec<Vec<i64>>,
    slices: Vec<Vec<Slot>>,
    marks: Vec<LogicalMark>,
    unrolled: bool,
    /// `PlayData.scopes`
    scopes: &'a [Vec<f64>],
    /// 各段整首最后一个字（`verseEnds` 缓存）
    verse_ends: RefCell<HashMap<NumKey, (i64, i64)>>,
}

impl<'a> Src<'a> {
    fn el(&self, s: Slot) -> &MusicElement {
        &self.rows[s.0].line.elements[s.1]
    }
    fn is_note(&self, s: Slot) -> bool {
        matches!(self.el(s), MusicElement::Note(_))
    }
    /// 符号所在的模型小节（声部下标、小节下标）与小节本身
    fn measure_key(&self, s: Slot) -> Option<(usize, usize)> {
        let row = &self.rows[s.0];
        row.refs.get(s.1).map(|r| (row.part, r.m))
    }
    fn measure(&self, s: Slot) -> Option<&dm::Measure> {
        let (p, m) = self.measure_key(s)?;
        self.song.parts.get(p)?.measures.get(m)
    }
    fn chord_at(&self, row: usize, idx: usize) -> Option<&dm::Chord> {
        let r = &self.rows[row];
        chord_of(self.song, r.part, r.refs.get(idx)?)
    }
    /// `noteOf`：休止为 "rest"，否则首音的唱名与八度
    fn note_of(&self, s: Slot) -> Option<String> {
        if let MusicElement::Note(n) = self.el(s) {
            if n.sound == Sound::Rest {
                return Some("rest".into());
            }
        }
        let d = self.chord_at(s.0, s.1)?.notes.first()?.degree.as_ref()?;
        Some(format!("{}:{}", js::num_to_string(d.number), js::num_to_string(d.octave_shift)))
    }
}

fn chord_of<'s>(song: &'s dm::Song, part: usize, r: &dolce_view::slots::SlotRef) -> Option<&'s dm::Chord> {
    let e = r.e?;
    match song.parts.get(part)?.measures.get(r.m)?.elements.get(e)? {
        dm::Element::Chord(c) => Some(c),
        _ => None,
    }
}

fn is_repeat(t: BarlineType) -> bool {
    matches!(t, BarlineType::RepeatStart | BarlineType::RepeatEnd | BarlineType::RepeatBoth)
}

/// 展开声部的小节切片（切法同 `buildMeasures`）
fn measure_slices(rows: &[Rc<LRow>]) -> Vec<Vec<Slot>> {
    let mut out: Vec<Vec<Slot>> = vec![];
    let mut cur: Option<usize> = None;
    let mut pending: Vec<Slot> = vec![];
    let mut need_new = true;
    for (r, row) in rows.iter().enumerate() {
        for (idx, el) in row.line.elements.iter().enumerate() {
            let s = (r, idx);
            if matches!(el, MusicElement::Note(_)) {
                if need_new || cur.is_none() {
                    out.push(std::mem::take(&mut pending));
                    cur = Some(out.len() - 1);
                }
                need_new = false;
                out[cur.unwrap()].push(s);
                continue;
            }
            if matches!(el, MusicElement::Barline(_)) {
                need_new = true;
            }
            match cur {
                None => pending.push(s),
                Some(c) => out[c].push(s),
            }
        }
    }
    out
}

/// 源里的换行（`sourceBreaks`）：「这个符号之后断」→ 是否换页
fn source_breaks(slices: &[Vec<Slot>], rows: &[Rc<LRow>], page_end_rows: &HashSet<usize>, end_break: bool, exact: &dyn Fn(usize) -> bool) -> HashMap<Slot, bool> {
    let mut measure_of: HashMap<Slot, usize> = HashMap::new();
    for (k, sl) in slices.iter().enumerate() {
        for &s in sl {
            measure_of.insert(s, k);
        }
    }
    let shown = |s: Slot| !matches!(rows[s.0].line.elements[s.1], MusicElement::InlineLayer(_));
    let mut out: HashMap<Slot, bool> = HashMap::new();
    for (r, row) in rows.iter().enumerate() {
        if (r == rows.len() - 1 && !end_break) || row.line.elements.is_empty() {
            continue;
        }
        let Some(tail) = (0..row.line.elements.len()).map(|idx| (r, idx)).rfind(|&s| shown(s)) else { continue };
        let mut key = tail;
        if !exact(r) {
            let last = measure_of.get(&key).and_then(|&k| slices.get(k)).and_then(|sl| sl.iter().copied().rfind(|&s| shown(s)));
            let Some(last) = last else { continue };
            key = last;
        }
        let v = out.get(&key).copied().unwrap_or(false) || page_end_rows.contains(&r);
        out.insert(key, v);
    }
    out
}

/// 一个小节在这一遍里取哪些符号（`cutSlots`）
fn cut_slots(slots: &[Slot], src: &Src, skip: f64, limit: f64) -> Vec<Slot> {
    let mut out: Vec<Slot> = slots.to_vec();
    if limit >= 0.0 {
        let mut n = 0.0;
        let at = out.iter().position(|&s| {
            if !src.is_note(s) {
                return false;
            }
            let hit = n == limit;
            n += 1.0;
            hit
        });
        if let Some(at) = at {
            out.truncate(at);
        }
    }
    if skip > 0.0 {
        let mut n = 0.0;
        let at = out.iter().position(|&s| {
            if !src.is_note(s) {
                return false;
            }
            let hit = n == skip;
            n += 1.0;
            hit
        });
        out = match at {
            None => vec![],
            Some(at) => out[at..].to_vec(),
        };
    }
    out.into_iter().filter(|&s| !matches!(src.el(s), MusicElement::InlineLayer(_))).collect()
}

/// 前奏（`introSlots`）
fn intro_slots(src: &Src) -> HashSet<Slot> {
    let all: Vec<Slot> = src.slices.iter().flatten().copied().collect();
    let first = all.iter().position(|&s| {
        let c = src.cursor_of[s.0][s.1];
        c >= 0 && src.lyrics_of[s.0].iter().any(|l| l.syllables.get(c as usize).is_some_and(|x| !x.text.is_empty()))
    });
    let mut at: i64 = first.map_or(-1, |v| v as i64);
    while at > 0 {
        let el = src.el(all[(at - 1) as usize]);
        let rest = matches!(el, MusicElement::Note(n) if n.sound == Sound::Rest);
        let start = matches!(el, MusicElement::Barline(b) if b.kind == BarlineType::RepeatStart);
        if !rest && !start {
            break;
        }
        at -= 1;
    }
    let cut: &[Slot] = if at > 0 { &all[..at as usize] } else { &[] };
    let is_intro = cut.iter().any(|&s| matches!(src.el(s), MusicElement::Barline(_)))
        && cut.iter().any(|&s| matches!(src.el(s), MusicElement::Note(n) if n.sound != Sound::Rest));
    if is_intro {
        cut.iter().copied().collect()
    } else {
        HashSet::new()
    }
}

fn walk_items(plan: &[PlayItem]) -> Vec<WalkItem> {
    plan.iter().map(WalkItem::from).collect()
}

/// 最大的键（只取满足 `keep` 的），没有为 0（`Math.max(0, ...keys)`）
fn max_key(breaks: &HashMap<usize, bool>, keep: impl Fn(usize) -> bool) -> usize {
    breaks.keys().copied().filter(|&k| keep(k)).max().unwrap_or(0)
}

fn index_of_slot(list: &[Slot], sl: Slot) -> i64 {
    list.iter().position(|&x| x == sl).map_or(-1, |v| v as i64)
}

/// `:|` 前的弱起（`pickupAt`）：`tail` 里弱起从第几个符号起，`head` 是回到的那个音之前的符号；没有为 −1
fn pickup_at(src: &Src, tail: &[Slot], head_slots: &[Slot]) -> i64 {
    let head: Vec<Slot> = head_slots.iter().copied().filter(|&s| src.is_note(s)).collect();
    let mut bar: Vec<usize> = vec![];
    let mut seen_note = false;
    for k in (0..tail.len()).rev() {
        match src.el(tail[k]) {
            MusicElement::Note(_) => {
                seen_note = true;
                bar.insert(0, k);
            }
            MusicElement::Barline(b) if b.kind != BarlineType::Invisible && seen_note => break,
            _ => {}
        }
    }
    let mut same = 0usize;
    while same < bar.len() && same < head.len() {
        let a = src.note_of(tail[bar[bar.len() - 1 - same]]);
        if a.is_none() || a != src.note_of(head[head.len() - 1 - same]) {
            break;
        }
        same += 1;
    }
    if same == 0 || same == bar.len() {
        return -1;
    }
    let at = &bar[bar.len() - same..];
    if at.iter().any(|&k| src.note_of(tail[k]).as_deref() != Some("rest")) {
        at[0] as i64
    } else {
        -1
    }
}

/// 一行只剩不到一小节的那种（有音、除 `:|` 外没有小节线）
fn short_tail(src: &Src, line: &[Slot]) -> bool {
    line.iter().any(|&s| src.is_note(s)) && !line.iter().any(|&s| matches!(src.el(s), MusicElement::Barline(b) if b.kind != BarlineType::RepeatEnd))
}

/// JS `arr.splice(cut)`（稀疏数组口径）
fn splice_tail<T>(v: &mut Vec<T>, cut: usize) -> Vec<T> {
    if cut >= v.len() {
        vec![]
    } else {
        v.split_off(cut)
    }
}

/// 按演唱顺序逐遍取符号（`passesOf`）
fn passes_of(src: &Src, plan: &[PlayItem], breaks: &HashMap<Slot, bool>, drop: &HashSet<Slot>) -> Vec<Pass> {
    let mut passes: Vec<Pass> = vec![];
    let mut cur: Option<usize> = None;
    let mut ended_on_repeat: Option<Slot> = None;
    let mut repeat_of: Vec<(usize, Slot)> = vec![];
    let mut back_count: HashMap<Slot, usize> = HashMap::new();
    for step in walk_play(&walk_items(plan), true) {
        match step {
            Step::Measure { mid, pass, skip, limit, glue, item, .. } => {
                let slice = src.slices.get(mid as usize).map_or(&[][..], |v| &v[..]);
                let slots: Vec<Slot> = cut_slots(slice, src, skip, limit).into_iter().filter(|s| !drop.contains(s)).collect();
                if slots.is_empty() {
                    continue;
                }
                let c = match cur {
                    Some(c) => c,
                    None => {
                        passes.push(Pass::default());
                        let c = passes.len() - 1;
                        if let Some(k) = ended_on_repeat {
                            repeat_of.push((c, k));
                        }
                        ended_on_repeat = None;
                        cur = Some(c);
                        c
                    }
                };
                let p = &mut passes[c];
                if glue && !p.slots.is_empty() {
                    for k in 0..slots.len() {
                        p.glue.insert(p.slots.len() + k);
                    }
                }
                let scope = plan[item].scope;
                for s in slots {
                    p.slots.push(s);
                    p.verses.push(pass);
                    if let Some(sc) = scope {
                        let at = p.slots.len() - 1;
                        let v = p.scopes.get_or_insert_with(Vec::new);
                        if v.len() <= at {
                            v.resize(at + 1, None);
                        }
                        v[at] = Some(sc);
                    }
                    if let Some(&br) = breaks.get(&s) {
                        p.breaks.insert(p.slots.len(), br);
                    }
                }
            }
            Step::PassEnd => {
                ended_on_repeat = None;
                if let Some(c) = cur {
                    let p = &passes[c];
                    for k in (0..p.slots.len()).rev() {
                        let sl = p.slots[k];
                        match src.el(sl) {
                            MusicElement::Note(_) => break,
                            MusicElement::Barline(b) if b.kind == BarlineType::RepeatEnd => {
                                ended_on_repeat = Some(sl);
                                break;
                            }
                            _ => {}
                        }
                    }
                }
                if let Some(k) = ended_on_repeat {
                    *back_count.entry(k).or_insert(0) += 1;
                }
                cur = None;
            }
            Step::JumpBack => {
                if let Some(c) = cur {
                    let n = passes[c].slots.len();
                    passes[c].hard.add(n);
                }
            }
        }
    }
    // 反复之后紧接着转调的：每遍是完整的一段，各占一页，不并
    let key_changes_after = |key: Slot, pass: &Pass| -> bool {
        let Some(at) = pass.slots.iter().position(|&s| s == key) else { return false };
        let next = pass.slots[at + 1..].iter().copied().find(|&s| src.is_note(s));
        next.is_some_and(|n| src.measure(n).and_then(|m| m.attrs.as_ref()).is_some_and(|a| a.key.is_some()))
    };
    for &(p, key) in &repeat_of {
        if back_count.get(&key) == Some(&1) && !key_changes_after(key, &passes[p]) {
            passes[p].after_repeat = true;
        }
    }
    // 同一段词往回跳（只另起一行）：换行挪到弱起之前
    for pass in passes.iter_mut() {
        for at in pass.hard.0.clone() {
            let line_at = max_key(&pass.breaks, |k| k < at);
            if line_at > 0 && short_tail(src, &pass.slots[line_at..at]) {
                pass.hard.delete(at);
                continue;
            }
            let Some(&target) = pass.slots.get(at) else { continue };
            let head_at = index_of_slot(&pass.slots, target);
            if head_at <= 0 || head_at >= at as i64 {
                continue;
            }
            let cut = pickup_at(src, &pass.slots[..at], &pass.slots[..head_at as usize]);
            if cut <= 0 {
                continue;
            }
            let cut = cut as usize;
            pass.hard.delete(at);
            pass.hard.add(cut);
            pass.breaks.retain(|&k, _| !(k > cut && k < at));
        }
    }
    for &(ni, _) in &repeat_of {
        if ni == 0 {
            continue;
        }
        let (left, right) = passes.split_at_mut(ni);
        let prev = &mut left[ni - 1];
        let next = &mut right[0];
        let Some(next_at) = next.slots.iter().copied().find(|&s| src.is_note(s)) else { continue };
        let head_at = max(0.0, index_of_slot(&prev.slots, next_at) as f64) as usize;
        let mut cut = pickup_at(src, &prev.slots, &prev.slots[..head_at]);
        // 换行换页之后只剩不到一小节就 `:|`：这几个音也归下一遍
        if cut <= 0 {
            let line_at = max_key(&prev.breaks, |_| true);
            if line_at > 0 && short_tail(src, &prev.slots[line_at..]) {
                cut = line_at as i64;
            }
        }
        if cut <= 0 {
            continue;
        }
        let mut cut = cut as usize;
        // 换行之后到弱起之间只有休止：跟着弱起走
        let line_start = max_key(&prev.breaks, |k| k <= cut);
        if line_start > 0 && prev.slots[line_start..cut].iter().all(|&s| src.note_of(s).as_deref() == Some("rest") || !src.is_note(s)) {
            cut = line_start;
        }
        let n = prev.slots.len() - cut;
        let moved = prev.slots.split_off(cut);
        let moved_verses = prev.verses.split_off(cut);
        prev.breaks.retain(|&k, _| k < cut);
        next.slots.splice(0..0, moved);
        next.verses.splice(0..0, moved_verses);
        if prev.scopes.is_some() || next.scopes.is_some() {
            let mut head = match prev.scopes.as_mut() {
                Some(v) => splice_tail(v, cut),
                None => vec![None; n],
            };
            head.extend(next.scopes.take().unwrap_or_default());
            next.scopes = Some(head);
        }
        next.breaks = next.breaks.iter().map(|(&at, &page)| (at + n, page)).collect();
        next.hard = OSet(next.hard.0.iter().map(|&at| at + n).collect());
        next.glue = next.glue.iter().map(|&at| at + n).collect();
    }
    passes
}

/// 展开声部各行的记号连成整条（房号、渐强渐弱不要）
fn logical_marks(rows: &[Rc<LRow>]) -> Vec<LogicalMark> {
    let mut out: Vec<LogicalMark> = vec![];
    let mut open: Vec<(MarkType, VecDeque<usize>)> = vec![];
    for (r, row) in rows.iter().enumerate() {
        for mk in &row.line.marks {
            if matches!(mk.kind, MarkType::Volta | MarkType::Crescendo | MarkType::Decrescendo) {
                continue;
            }
            let mut lm: Option<usize> = None;
            if mk.continuation_from_previous == Some(true) {
                lm = open.iter_mut().find(|(t, _)| *t == mk.kind).and_then(|(_, q)| q.pop_front());
            }
            let i = match lm {
                Some(i) => {
                    out[i].end = (r, mk.end);
                    i
                }
                None => {
                    out.push(LogicalMark { mark: mk.clone(), start: (r, mk.start), end: (r, mk.end) });
                    out.len() - 1
                }
            };
            if mk.continuation_to_next == Some(true) {
                match open.iter_mut().find(|(t, _)| *t == mk.kind) {
                    Some((_, q)) => q.push_back(i),
                    None => open.push((mk.kind, VecDeque::from([i]))),
                }
            }
        }
    }
    out
}

/// 投影档只要旋律与词（`bare`）：和弦、段落词、奏法（延长、滑音除外）、小节线上的记号去掉；和音只留最高音
fn bare(el: &MusicElement) -> MusicElement {
    match el {
        MusicElement::Note(n) => {
            let ornaments: Vec<_> = n.ornaments.iter().filter(|o| matches!(o.name.as_str(), "yc" | "ycy" | "shy" | "xhy")).cloned().collect();
            if n.chord.is_none() && n.annotation.is_none() && n.stack.as_ref().is_none_or(|s| s.is_empty()) && ornaments.len() == n.ornaments.len() {
                return el.clone();
            }
            let mut out = n.clone();
            if let Some(top) = n.stack.as_ref().and_then(|s| s.last()) {
                out.pitch = top.pitch;
                out.octave = top.octave;
                out.accidental = top.accidental.clone();
                out.stack = None;
            }
            out.ornaments = ornaments;
            out.chord = None;
            out.annotation = None;
            MusicElement::Note(out)
        }
        MusicElement::Sustain(s) => {
            if s.chord.is_none() && s.annotation.is_none() && s.ornaments.is_empty() {
                return el.clone();
            }
            let mut out = s.clone();
            out.ornaments = vec![];
            out.chord = None;
            out.annotation = None;
            MusicElement::Sustain(out)
        }
        MusicElement::Barline(b) if !b.ornaments.is_empty() => {
            let mut out = b.clone();
            out.ornaments = vec![];
            MusicElement::Barline(out)
        }
        _ => el.clone(),
    }
}

/// 字前的印刷段号去掉（`bareSyllable`）
fn bare_syllable(syl: &LyricSyllable) -> LyricSyllable {
    let n = syl.text.bytes().take_while(|b| b.is_ascii_digit() || *b == b'.').count();
    if n == 0 || n == syl.text.len() {
        return syl.clone();
    }
    LyricSyllable { text: syl.text[n..].to_string(), ..syl.clone() }
}

/// 反复确实展开了就不画反复记号（`plainBarline`）
fn plain_barline(b: &mut BarlineElement) {
    let repeat = is_repeat(b.kind);
    if !repeat && b.repeat_forward_after != Some(true) {
        return;
    }
    if repeat {
        b.kind = BarlineType::Normal;
    }
    b.repeat_forward_after = Some(false);
}

fn verse_line(lines: &[LyricLine], v: f64) -> Option<usize> {
    lines.iter().position(|l| l.verse_from <= v && v <= l.verse_to)
}

/// 第 `v` 段在段落 `scope` 里最后一个字之后（`afterVerseEndIn`）
fn after_verse_end_in(src: &Src, scope: &[f64], v: f64, row: usize, k: i64) -> bool {
    let mut end: (i64, i64) = (-1, -1);
    let mut mids = scope.to_vec();
    js::sort_num(&mut mids);
    for mid in mids {
        let Some(sl) = (mid >= 0.0).then(|| src.slices.get(mid as usize)).flatten() else { continue };
        for &s in sl {
            let c = src.cursor_of[s.0][s.1];
            if c < 0 {
                continue;
            }
            let lines = &src.lyrics_of[s.0];
            if verse_line(lines, v).and_then(|j| lines[j].syllables.get(c as usize)).is_some_and(|x| !x.text.is_empty()) {
                end = (s.0 as i64, c);
            }
        }
    }
    row as i64 > end.0 || (row as i64 == end.0 && k > end.1)
}

/// (`row`, `k`) 在第 `v` 段整首最后一个字之后（`afterVerseEnd`）
fn after_verse_end(src: &Src, v: f64, row: usize, k: i64) -> bool {
    let end = *src.verse_ends.borrow_mut().entry(NumKey::new(v)).or_insert_with(|| {
        let mut end = (-1, -1);
        for (r, lines) in src.lyrics_of.iter().enumerate() {
            if let Some(j) = verse_line(lines, v) {
                for (i, x) in lines[j].syllables.iter().enumerate() {
                    if !x.text.is_empty() {
                        end = (r as i64, i as i64);
                    }
                }
            }
        }
        end
    });
    row as i64 > end.0 || (row as i64 == end.0 && k > end.1)
}

/// (`row`, `k`) 在第 `v` 段整首第一个字之前（`beforeVerseStart`）
fn before_verse_start(src: &Src, v: f64, row: usize, k: i64) -> bool {
    for (r, lines) in src.lyrics_of.iter().enumerate().take(row + 1) {
        let at = verse_line(lines, v).and_then(|j| lines[j].syllables.iter().position(|x| !x.text.is_empty())).map_or(-1, |v| v as i64);
        if at >= 0 {
            return r == row && k < at;
        }
    }
    true
}

/// 小节线的画法：`plain` = 一律细线（`.jpwabc`），`final_at` = 整首最后一条（没有为 −1）
#[derive(Clone, Copy)]
struct Bars {
    plain: bool,
    final_at: i64,
}

type PosOf = HashMap<(usize, i64), Vec<usize>>;

fn pos_of(pass: &Pass) -> PosOf {
    let mut out: PosOf = HashMap::new();
    for (i, s) in pass.slots.iter().enumerate() {
        out.entry((s.0, s.1 as i64)).or_default().push(i);
    }
    out
}

/// 一遍里的符号区间 [a, b) 拼成一行（`rowOf`）
fn row_of(src: &Src, pass: &Pass, a: usize, b: usize, pos: &PosOf, bars: Bars) -> Rc<LRow> {
    let first = &src.rows[pass.slots[a].0];
    let mut elements: Vec<MusicElement> = vec![];
    let mut refs = vec![];
    let mut ids = vec![];
    for i in a..b {
        let s = pass.slots[i];
        let row = &src.rows[s.0];
        let mut el = bare(&row.line.elements[s.1]);
        if let MusicElement::Barline(bl) = &mut el {
            if src.unrolled {
                plain_barline(bl);
            }
            let repeat = is_repeat(bl.kind);
            let mut t = bl.kind;
            if bars.plain && !repeat && t != BarlineType::Invisible {
                t = BarlineType::Normal;
            }
            if t == BarlineType::End && i as i64 != bars.final_at {
                t = BarlineType::Normal;
            }
            if i as i64 == bars.final_at && t == BarlineType::Normal {
                t = BarlineType::End;
            }
            if t == BarlineType::Double && (pass.hard.has(i + 1) || (i + 1 == pass.slots.len() && bars.final_at < 0)) {
                t = BarlineType::Normal;
            }
            bl.kind = t;
        }
        elements.push(el);
        refs.push(row.refs[s.1].clone());
        ids.push(row.ids.get(s.1).copied().flatten());
    }
    let mut out_marks: Vec<Mark> = vec![];
    let empty: Vec<usize> = vec![];
    for lm in &src.marks {
        let ends = pos.get(&lm.end).unwrap_or(&empty);
        for &s in pos.get(&lm.start).unwrap_or(&empty) {
            let Some(&e) = ends.iter().find(|&&x| x >= s) else { continue };
            if e < a || s >= b {
                continue;
            }
            out_marks.push(Mark {
                start: (s.max(a) - a) as i64,
                end: (e.min(b - 1) - a) as i64,
                continuation_from_previous: Some(s < a),
                continuation_to_next: Some(e >= b),
                ..lm.mark.clone()
            });
        }
    }
    // 这一遍的歌词：各符号取它那一行里段号区间罩住本遍遍号的那行词
    let mut syllables: Vec<LyricSyllable> = vec![];
    let mut owners: Vec<Option<i64>> = vec![];
    let mut any = false;
    for i in a..b {
        let s = pass.slots[i];
        if !takes_lyric(src.el(s)) {
            continue;
        }
        let v = pass.verses[i];
        let k = src.cursor_of[s.0][s.1];
        let lines = &src.lyrics_of[s.0];
        let own = verse_line(lines, v);
        let scope = pass.scopes.as_ref().and_then(|sc| sc.get(i).copied().flatten());
        let done = match scope {
            Some(sc) => after_verse_end_in(src, src.scopes.get(sc).map_or(&[][..], |x| &x[..]), v, s.0, k),
            None => after_verse_end(src, v, s.0, k),
        };
        let line = if !done && !(pass.mid_verse && before_verse_start(src, v, s.0, k)) {
            own
        } else {
            lines.iter().position(|l| k >= 0 && l.syllables.get(k as usize).is_some_and(|x| !x.text.is_empty())).or(own)
        };
        let syl = line.and_then(|j| (k >= 0).then(|| lines[j].syllables.get(k as usize)).flatten());
        match syl {
            Some(x) => {
                if !x.text.is_empty() {
                    any = true;
                }
                syllables.push(bare_syllable(x));
                let j = line.unwrap();
                owners.push(src.rows[s.0].owners.get(j).and_then(|o| o.get(k as usize).copied().flatten()));
            }
            None => {
                syllables.push(LyricSyllable { text: String::new(), trailing_punctuation: None, source: first.line.source });
                owners.push(None);
            }
        }
    }
    let lyrics = if any {
        vec![LyricLine {
            verse_from: pass.verses[a],
            verse_to: pass.verses[a],
            annotation: None,
            annotation_gap: 20.0,
            syllables,
            join_brace: None,
            source: first.line.source,
        }]
    } else {
        vec![]
    };
    let line = ScoreLine { elements, marks: out_marks, lyrics, ..first.line.clone() };
    let mut row = LRow::new(line, first.part, first.measures.clone(), refs, ids);
    row.owners = if any { vec![owners] } else { vec![] };
    row.passes = Some(pass.verses[a..b].to_vec());
    Rc::new(row)
}

/// 压到底后还允许超版心多少（相对版心宽）
const SQUEEZE_OVERHANG: f64 = 0.03;

/// 逐行装满（`fillLines`）：返回各行在这一行里的起点（元素下标）
/// 一行不折、按自然间距排（`fill_lines` 与 `%%sing` 逐遍断句的尺子共用）
fn laid_natural(row: &ScoreLine, m: &JianpuGrid, ink: &Ink, meter: Option<&Meter>) -> (VoiceLine, Natural) {
    let mut laid = layout_voice_line(row, &[], m, &BeatCtx { meter: meter.cloned(), ..Default::default() });
    for it in laid.items.iter_mut() {
        it.syllables = vec![None; row.lyrics.len()];
    }
    assign_lyrics(&mut laid.items, &row.lyrics, &[]);
    let nat = natural_columns(&[SpacedLine::main(&laid.items, &laid.pad)], m, ink, 0.0);
    (laid, nat)
}

pub fn fill_lines(row: &ScoreLine, forced: &HashMap<usize, bool>, m: &JianpuGrid, ink: &Ink, width: f64, meter: Option<&Meter>, opts: &FillOpts) -> Vec<LineCut> {
    let (laid, nat) = laid_natural(row, m, ink, meter);
    let lines = [SpacedLine::main(&laid.items, &laid.pad)];
    let mut tight: Option<crate::place::spacing::Natural> = None;
    let items = &laid.items;
    let n_items = items.len();
    let left_of = |nat: &crate::place::spacing::Natural, k: usize| nat.left[0][k];
    let right_of = |nat: &crate::place::spacing::Natural, k: usize| nat.right[0][k];
    let first_at = |at: usize| items.iter().position(|it| it.src_index >= at as i64);
    let mut forced_at: HashMap<usize, bool> = HashMap::new();
    for (&at, &page) in forced {
        if let Some(k) = first_at(at).filter(|&k| k > 0) {
            let v = forced_at.get(&k).copied().unwrap_or(false) || page;
            forced_at.insert(k, v);
        }
    }
    let mut hard_at: HashSet<usize> = HashSet::new();
    for &at in &opts.hard {
        if let Some(k) = first_at(at).filter(|&k| k > 0) {
            hard_at.insert(k);
        }
    }
    let mut glue_at: HashSet<usize> = HashSet::new();
    for &at in &opts.glue {
        if let Some(k) = first_at(at).filter(|&k| k > 0) {
            glue_at.insert(k);
        }
    }
    let mut jump_in_at: HashSet<usize> = HashSet::new();
    for &at in &opts.jump_in {
        jump_in_at.insert(first_at(at).unwrap_or(0));
    }
    let mut soft_at: HashSet<usize> = HashSet::new();
    for &at in &opts.soft {
        if let Some(k) = first_at(at).filter(|&k| k > 0) {
            soft_at.insert(k);
        }
    }
    let mut starts: Vec<usize> = vec![0];
    let mut page_at: HashSet<usize> = HashSet::new();
    let mut i = 0usize;
    while i < n_items {
        let left = left_of(&nat, i);
        let mut last = i;
        let mut keep_to = 0usize;
        while last < n_items {
            if last > i && hard_at.contains(&last) {
                if forced_at.get(&last) == Some(&true) {
                    page_at.insert(last);
                }
                break;
            }
            if last > i && forced_at.contains_key(&last) && !glue_at.contains(&last) {
                let page = forced_at[&last];
                let short = right_of(&nat, last - 1) - left < width / 3.0;
                let next_at = if soft_at.contains(&last) { forced_at.keys().copied().filter(|&k| k > last && !soft_at.contains(&k)).min() } else { None };
                let short_after = next_at.is_some_and(|na| right_of(&nat, na - 1) - left_of(&nat, last) < width / 3.0);
                let keep = if soft_at.contains(&last) { short || short_after } else { short && jump_in_at.contains(&i) };
                if page || !keep {
                    if page {
                        page_at.insert(last);
                    }
                    break;
                }
            }
            let r = right_of(&nat, last);
            if r - left < width || last == i || last < keep_to {
                last += 1;
                continue;
            }
            // 源里写明的一行超了宽：压字距放得下就不折
            let mut end = last + 1;
            while end < n_items && !forced_at.contains_key(&end) && !hard_at.contains(&end) {
                end += 1;
            }
            let t = tight.get_or_insert_with(|| natural_columns(&lines, m, ink, 1.0));
            if right_of(t, end - 1) - left_of(t, i) < width * (1.0 + SQUEEZE_OVERHANG) {
                keep_to = end;
                last += 1;
                continue;
            }
            let mut k = last;
            while k > i + 1 {
                let is_bar = matches!(items[k - 1].element, MusicElement::Barline(_));
                if !is_bar || !items[i..k - 1].iter().any(|it| matches!(it.element, MusicElement::Note(_))) {
                    k -= 1;
                    continue;
                }
                let brk = match &items[k - 1].element {
                    MusicElement::Barline(b) if b.kind == BarlineType::RepeatStart => k - 1,
                    _ => k,
                };
                if glue_at.contains(&brk) {
                    k -= 1;
                    continue;
                }
                last = brk;
                break;
            }
            break;
        }
        if last < n_items {
            starts.push(last);
        }
        i = last;
    }
    // 行首按符号算的下标 → 元素下标
    let at: Vec<LineCut> = starts
        .iter()
        .enumerate()
        .map(|(n, &k)| {
            if n == 0 {
                return LineCut { start: 0, page: page_at.contains(&k) };
            }
            let mut start = (items[k - 1].src_index + 1) as usize;
            if matches!(items[k - 1].element, MusicElement::Barline(_)) {
                while (start as i64) < items[k].src_index && matches!(row.elements[start], MusicElement::Barline(_)) {
                    start += 1;
                }
            }
            LineCut { start, page: page_at.contains(&k) }
        })
        .collect();
    // 只剩小节线的行并回上一行；只有休止的行并到下一行（`keep_rest_lines` 时强制换行切出的除外）
    let forced_start = |start: usize| forced.contains_key(&start);
    let mut out: Vec<LineCut> = vec![];
    let mut carry: Option<LineCut> = None;
    for (n, s) in at.iter().enumerate() {
        let e = at.get(n + 1).map_or(row.elements.len(), |x| x.start);
        let els = &row.elements[s.start.min(e)..e];
        let has_note = els.iter().any(|el| matches!(el, MusicElement::Note(_)));
        let sung = els.iter().any(|el| matches!(el, MusicElement::Note(x) if x.sound != Sound::Rest));
        if n > 0 && !has_note {
            continue;
        }
        let kept = opts.keep_rest_lines && at.get(n + 1).is_some_and(|x| forced_start(x.start));
        if has_note && !sung && n < at.len() - 1 && !kept {
            if carry.is_none() {
                carry = Some(*s);
            }
            continue;
        }
        out.push(match carry {
            Some(c) => LineCut { start: c.start, page: c.page || s.page },
            None => *s,
        });
        carry = None;
    }
    out
}

/// 投影档每页最多几行（没有 `.Layout` 时）
const MAX_ROWS: f64 = 4.0;

/// 把一遍的各行按页分（`pageByRows`），就地改 `page`
fn page_by_rows(lines: &mut [LineCut], refrain_at: &dyn Fn(usize) -> bool, max_rows: f64) {
    let mut s = 0usize;
    while s < lines.len() {
        let mut e = s + 1;
        while e < lines.len() && !lines[e].page {
            e += 1;
        }
        let mut a = s;
        while (e - a) as f64 > max_rows {
            let mut b: i64 = -1;
            let mut k = min(a as f64 + max_rows, e as f64 - 2.0);
            while k >= (a + 2) as f64 {
                if refrain_at(k as usize) {
                    b = k as i64;
                    break;
                }
                k -= 1.0;
            }
            if b < 0 {
                let pages = ((e - a) as f64 / max_rows).ceil();
                b = a as i64 + ((e - a) as f64 / pages).ceil() as i64;
            }
            lines[b as usize].page = true;
            a = b as usize;
        }
        s = e;
    }
}

/// 多段两两并页（`pairPages`）
fn pair_pages(pages: &[LPage], pass_starts: &HashSet<usize>, max_rows: f64) -> Vec<LPage> {
    let mut merged: Vec<LPage> = vec![];
    let mut paired = false;
    let mut i = 0usize;
    while i < pages.len() {
        let a = &pages[i];
        if a.groups.len() > 2 {
            merged.push(LPage { index: merged.len(), groups: a.groups.clone() });
            i += 1;
            continue;
        }
        let Some(b) = pages.get(i + 1) else { return pages.to_vec() };
        if !pass_starts.contains(&(i + 1)) || (a.groups.len() + b.groups.len()) as f64 > max_rows {
            return pages.to_vec();
        }
        let mut groups = a.groups.clone();
        for (k, g) in b.groups.iter().enumerate() {
            groups.push(Rc::new(LGroup { index: a.groups.len() + k, ..(**g).clone() }));
        }
        merged.push(LPage { index: merged.len(), groups });
        paired = true;
        i += 2;
    }
    if paired {
        merged
    } else {
        pages.to_vec()
    }
}

/// `parseInt(x, 10)`
fn parse_int(s: &str) -> f64 {
    js::parse_int(s, 10)
}

/// `.Layout` 的 `BreakPoints = …`（`parseBreakDur`）
fn parse_break_dur(s: &str) -> OMap {
    let mut res = OMap::default();
    let mut last = Fraction::int(0.0);
    let s = s.replace('|', "\n").replace('.', " ");
    for pg in s.split('\n') {
        if pg.is_empty() {
            continue;
        }
        for it in pg.split(' ') {
            let mut str_ = js::trim(it).to_string();
            if str_.is_empty() {
                continue;
            }
            let mut v = 1.0;
            if str_.contains('{') {
                v = 0.0;
                str_ = str_.replace(['{', '}'], "");
            }
            last = last.plus(&Fraction::from_string(&str_));
            res.set(last.to_string(), v);
        }
        res.set(last.to_string(), 2.0);
    }
    res
}

/// `.Layout` 描述 → 断点表（`durationInfo`）
fn duration_info(desc: &str, total: &Fraction, passes: Option<usize>) -> OMap {
    let mut info = OMap::default();
    let body = js::trim(match desc.find('=') {
        None => desc,
        Some(at) => &desc[at + 1..],
    });
    if desc.contains("LinesPerPage") {
        let arr: Vec<f64> = body.split('|').map(parse_int).collect();
        let dur = total.div_int(arr.iter().fold(0.0, |a, b| a + b));
        let mut pos = Fraction::int(0.0);
        for &n in &arr {
            let mut i = 0.0;
            while i < n {
                pos = pos.plus(&dur);
                info.set(pos.to_string(), if i == n - 1.0 { 2.0 } else { 1.0 });
                i += 1.0;
            }
        }
    } else {
        for (k, v) in parse_break_dur(body).entries() {
            info.set(k, v);
        }
    }
    if let Some(passes) = passes {
        let keys = info.keys.clone();
        for i in 1..passes {
            for k in &keys {
                let v = info.get(k).unwrap();
                info.set(Fraction::from_string(k).plus(&total.times_int(i as f64)).to_string(), v);
            }
        }
    }
    info
}

/// `.Layout` 分页描述（`passesByDur`）：整个演唱顺序接成一长串，按时值插换行 / 换页、丢掉 `{}` 那几段
fn passes_by_dur(src: &Src, plan: &[PlayItem], desc: &str, simple: bool) -> Vec<Pass> {
    let mut all = Pass::default();
    for step in walk_play(&walk_items(plan), false) {
        if let Step::Measure { mid, pass, skip, limit, .. } = step {
            let slice = src.slices.get(mid as usize).map_or(&[][..], |v| &v[..]);
            for s in cut_slots(slice, src, skip, limit) {
                all.slots.push(s);
                all.verses.push(pass);
            }
        }
    }
    let ratios: Vec<Vec<Option<(f64, f64)>>> = src.rows.iter().map(|r| tuplet_ratios(&r.line)).collect();
    let dur = |s: Slot| -> Fraction {
        let q = element_quarters(src.el(s));
        match ratios[s.0].get(s.1).copied().flatten() {
            Some((num, den)) => q.times_int(num).div_int(den),
            None => q,
        }
    };
    let mut total = Fraction::int(0.0);
    for sl in &src.slices {
        for &s in sl {
            total = total.plus(&dur(s));
        }
    }
    let info0 = duration_info(desc, &total, if simple { Some(plan.len()) } else { None });
    let mut src_breaks: Vec<Fraction> = vec![];
    {
        let mut t = Fraction::int(0.0);
        for (i, &s) in all.slots.iter().enumerate() {
            if i > 0 && s.0 != all.slots[i - 1].0 {
                src_breaks.push(t);
            }
            t = t.plus(&dur(s));
        }
    }
    let one = Fraction::int(1.0);
    let mut info: HashMap<String, f64> = HashMap::new();
    for (k, v) in info0.entries() {
        let at = Fraction::from_string(&k);
        let snap = src_breaks.iter().find(|b| b.compare_to(&at) > 0 && b.minus(&at).compare_to(&one) <= 0);
        let key = snap.unwrap_or(&at).to_string();
        let old = info.get(&key).copied().unwrap_or(0.0);
        info.insert(key, max(old, v));
    }
    let mut out = Pass::default();
    let mut tick = Fraction::int(0.0);
    let mut line_beg = 0usize;
    let mut last_tick: Option<String> = None;
    for (i, &s) in all.slots.iter().enumerate() {
        let key = tick.to_string();
        if matches!(src.el(s), MusicElement::Note(_)) && last_tick.as_deref() != Some(&key) {
            if let Some(&v) = info.get(&key) {
                if v == 0.0 {
                    out.slots.truncate(line_beg);
                    out.verses.truncate(line_beg);
                } else {
                    out.breaks.insert(out.slots.len(), v == 2.0);
                    line_beg = out.slots.len();
                }
                last_tick = Some(key);
            }
        }
        out.slots.push(s);
        out.verses.push(all.verses[i]);
        tick = tick.plus(&dur(s));
    }
    if out.slots.is_empty() {
        vec![]
    } else {
        vec![out]
    }
}

fn key_text(key: Option<&dm::Key>) -> String {
    match key {
        Some(k) => format!("{}:{}:{}", js::num_to_string(k.fifths), k.mode.as_deref().unwrap_or(""), k.tonic_degree.as_deref().unwrap_or("")),
        None => String::new(),
    }
}

/// 一首里出现过的声部号（同 `phrasesong::voice_numbers`，按 `LSong` 取）
fn voice_numbers(song: &LSong) -> Vec<f64> {
    let mut seen: Vec<f64> = vec![];
    for v in song.pages.iter().flat_map(|p| p.groups.iter()).flat_map(|g| g.voices.iter()) {
        if !seen.contains(&v.line.voice) {
            seen.push(v.line.voice);
        }
    }
    if seen.is_empty() {
        vec![1.0]
    } else {
        seen
    }
}

/// 各源符号属于哪一段（`[P:x]`，按谱面先后；第一个标记之前是空串），与各符号在谱面上的先后序号（认往回跳）
struct SecTags {
    name: HashMap<Slot, Rc<str>>,
    ord: HashMap<Slot, usize>,
}

/// 段落标记落到源符号上（切法同 `dolce-play::sections_of`：标记音之前的非音符号仍归上一段；标记在小节第一个音上的整小节归新段）。
/// 写在主旋律以外声部的标记贴到那一小节头。没有段落标记回 None
fn section_tags(src: &Src) -> Option<SecTags> {
    let marks = src.song.section_marks.as_ref().filter(|m| !m.is_empty())?;
    let mut by_id: HashMap<dm::ElementId, Rc<str>> = marks.iter().map(|m| (m.before, Rc::from(m.name.as_str()))).collect();
    let mut on_lead: HashMap<dm::ElementId, Rc<str>> = HashMap::new();
    for sl in src.slices.iter().flatten() {
        if let Some(c) = src.chord_at(sl.0, sl.1) {
            if let Some(n) = by_id.remove(&c.id) {
                on_lead.insert(c.id, n);
            }
        }
    }
    let mut at_measure: HashMap<usize, Rc<str>> = HashMap::new();
    for p in &src.song.parts {
        for (mi, mm) in p.measures.iter().enumerate() {
            for el in &mm.elements {
                if let Some(n) = by_id.get(&el.id()) {
                    at_measure.entry(mi).or_insert_with(|| n.clone());
                }
            }
        }
    }
    let mut tags = SecTags { name: HashMap::new(), ord: HashMap::new() };
    let mut cur: Rc<str> = Rc::from("");
    let mut started: HashSet<usize> = HashSet::new();
    let mut ord = 0usize;
    for sl in &src.slices {
        let mut starts: Vec<(usize, Rc<str>)> = vec![];
        if let Some(m) = sl.first().and_then(|&s| src.measure_key(s)).map(|k| k.1) {
            if let Some(n) = at_measure.get(&m).filter(|_| started.insert(m)) {
                starts.push((0, n.clone()));
            }
        }
        let mut first_note = true;
        for (j, &s) in sl.iter().enumerate() {
            if !src.is_note(s) {
                continue;
            }
            if let Some(n) = src.chord_at(s.0, s.1).and_then(|c| on_lead.get(&c.id)) {
                starts.push((if first_note { 0 } else { j }, n.clone()));
            }
            first_note = false;
        }
        for (j, &s) in sl.iter().enumerate() {
            if let Some((_, n)) = starts.iter().rev().find(|(at, _)| *at == j) {
                cur = n.clone();
            }
            tags.name.insert(s, cur.clone());
            tags.ord.insert(s, ord);
            ord += 1;
        }
    }
    Some(tags)
}

/// 一遍里各段的每一次出现：(段名, 这一遍里第几次, 末符号在这一遍的下标)。段名变了或往回跳就是新的一次
fn section_runs(slots: &[Slot], tags: &SecTags) -> Vec<(Rc<str>, usize, usize)> {
    let mut out: Vec<(Rc<str>, usize, usize)> = vec![];
    let mut count: HashMap<Rc<str>, usize> = HashMap::new();
    for (i, s) in slots.iter().enumerate() {
        let name = tags.name.get(s).cloned().unwrap_or_else(|| Rc::from(""));
        let back = i > 0 && matches!((tags.ord.get(s), tags.ord.get(&slots[i - 1])), (Some(a), Some(b)) if a <= b);
        match out.last_mut() {
            Some(last) if !back && last.0 == name => last.2 = i,
            _ => {
                let n = count.entry(name.clone()).or_insert(0);
                *n += 1;
                out.push((name, *n, i));
            }
        }
    }
    out
}

/// 版面里管第 `pass` 遍的断点（`break=` / `newpage=`）落成「在第几个符号之前换行 → 是否换页」；断在这一遍末尾的不算
fn layout_cuts(spec: Option<&LayoutSpec>, pass: usize, slots: &[Slot], tags: Option<&SecTags>) -> HashMap<usize, bool> {
    let mut out: HashMap<usize, bool> = HashMap::new();
    let (Some(spec), Some(tags)) = (spec, tags) else { return out };
    if spec.breaks.as_ref().is_none_or(|b| b.is_empty()) {
        return out;
    }
    let runs = section_runs(slots, tags);
    for b in spec.breaks_for(pass) {
        let nth = b.nth.map_or(1, |n| n as usize);
        let Some(run) = runs.iter().find(|r| &*r.0 == b.section.as_str() && r.1 == nth) else { continue };
        let at = run.2 + 1;
        if at < slots.len() {
            let page = out.entry(at).or_insert(false);
            *page |= b.page == Some(true);
        }
    }
    out
}

/// 每行 N 小节：每数满 N 条（前面有音的）小节线，在它之后换行
fn bar_cuts(line: &ScoreLine, n: usize) -> HashMap<usize, bool> {
    let mut out = HashMap::new();
    let els = &line.elements;
    let mut count = 0usize;
    let mut notes = false;
    for (i, el) in els.iter().enumerate() {
        match el {
            MusicElement::Note(_) => notes = true,
            MusicElement::Barline(_) if notes => {
                notes = false;
                count += 1;
                if count % n == 0 && i + 1 < els.len() {
                    out.insert(i + 1, false);
                }
            }
            _ => {}
        }
    }
    out
}

/// `expandSong` 的选项
struct SongOpts<'a> {
    layout: Option<(&'a str, bool)>,
    exact_breaks: bool,
    row_is_line: bool,
    end_break: Option<BreakKind>,
    sing: bool,
    /// 活动的投影系版面（`%%layout`；没写为 None）
    spec: Option<&'a LayoutSpec>,
}

/// 投影档：一首曲子 → 逐遍展开、逐行装满的行视图（`expandSong`）
fn expand_song(song: &LSong, pd: &PlayData, m: &JianpuGrid, ink: &Ink, o: &SongOpts) -> LSong {
    let plan = &pd.measures[..];
    let voices = voice_numbers(song);
    let rows_of_voice = |v: f64| -> Vec<Rc<LRow>> {
        song.pages.iter().flat_map(|p| p.groups.iter()).flat_map(|g| g.voices.iter()).filter(|r| r.line.voice == v).cloned().collect()
    };
    let lead = voices.iter().copied().find(|&v| rows_of_voice(v).iter().any(|r| !r.line.lyrics.is_empty())).unwrap_or(voices[0]);
    let rows = rows_of_voice(lead);
    let lyrics_of: Vec<Vec<LyricLine>> = rows.iter().map(|r| distinct_verses(&r.line.lyrics)).collect();
    let cursor_of: Vec<Vec<i64>> = rows
        .iter()
        .map(|r| {
            let mut n = 0i64;
            r.line
                .elements
                .iter()
                .map(|el| {
                    if takes_lyric(el) {
                        n += 1;
                        n - 1
                    } else {
                        -1
                    }
                })
                .collect()
        })
        .collect();
    let slices = measure_slices(&rows);
    let marks = logical_marks(&rows);
    let mut seen: HashSet<NumKey> = HashSet::new();
    let mut unrolled = false;
    for it in plan {
        let mut mid = it.mid;
        while mid < it.end {
            if !seen.insert(NumKey::new(mid)) {
                unrolled = true;
            }
            mid += 1.0;
        }
    }
    let src = Src {
        rows,
        song: &song.song,
        lyrics_of,
        cursor_of,
        slices,
        marks,
        unrolled,
        scopes: &pd.scopes,
        verse_ends: RefCell::new(HashMap::new()),
    };
    let rows = &src.rows;
    let slices = &src.slices;
    // 源里一页的末行：该处的换行写成换页
    let mut page_end_rows: HashSet<usize> = HashSet::new();
    {
        let mut r = 0usize;
        for (pi, pg) in song.pages.iter().enumerate() {
            for g in &pg.groups {
                for v in &g.voices {
                    if v.line.voice == lead {
                        r += 1;
                    }
                }
            }
            if pi + 1 < song.pages.len() && r > 0 {
                page_end_rows.insert(r - 1);
            }
        }
    }
    let last_chord = |r: usize| -> Option<&dm::Chord> {
        let row = &rows[r];
        row.refs.iter().rev().find_map(|rf| chord_of(&song.song, row.part, rf))
    };
    for r in 0..rows.len() {
        let Some(next) = rows.get(r + 1) else { continue };
        let row = &rows[r];
        let inline = last_chord(r).is_some_and(|c| {
            c.line_break_after == Some(BreakKind::Page) || c.sustains.iter().flatten().any(|su| su.line_break_after == Some(BreakKind::Page))
        });
        let at_measure = o.exact_breaks
            && next.measures.first().is_some_and(|&head| {
                let tail = row.refs.last().map(|rf| (row.part, rf.m));
                tail != Some((next.part, head))
                    && song.song.parts.get(next.part).and_then(|p| p.measures.get(head)).and_then(|mm| mm.print.as_ref()).and_then(|p| p.new_page) == Some(true)
            });
        if inline || at_measure {
            page_end_rows.insert(r);
        }
    }
    let inline_end = |r: usize| -> bool {
        last_chord(r).is_some_and(|c| c.line_break_after.is_some() || c.sustains.iter().flatten().any(|su| su.line_break_after.is_some()))
    };
    if o.end_break == Some(BreakKind::Page) && !rows.is_empty() {
        page_end_rows.insert(rows.len() - 1);
    }
    let breaks = source_breaks(slices, rows, &page_end_rows, o.end_break.is_some(), &|r| o.exact_breaks || o.row_is_line || inline_end(r));
    let width = content_width(m);
    let meter = song.metadata.meters.first();
    let tags = section_tags(&src);
    // `.jpwabc` 的 `.Layout` 分页描述照它自己的，不看 `%%layout`
    let spec = if o.layout.is_none() { o.spec } else { None };
    if o.sing {
        return sing_song(song, plan, &src, m, ink, width, meter, spec, tags.as_ref());
    }
    let lb = spec.and_then(|s| s.line_break()).unwrap_or(LineBreak::Auto);
    // 副歌换行换页、弱起挪页等投影推断只在 `auto`（缺省）
    let infer = o.layout.is_none() && lb == LineBreak::Auto;
    let rows_of = |pass: usize| spec.and_then(|s| s.rows_for(pass)).unwrap_or(MAX_ROWS);
    let pair = spec.and_then(|s| s.pair_pages).unwrap_or(m.style.look.pair_pages);
    let no_intro = spec.and_then(|s| s.no_intro).unwrap_or(m.style.look.no_intro);
    let mut measure_of: HashMap<Slot, usize> = HashMap::new();
    for (k, sl) in slices.iter().enumerate() {
        for &x in sl {
            measure_of.insert(x, k);
        }
    }
    let measure_at = |s: Slot| -> i64 { measure_of.get(&s).map_or(-1, |&k| k as i64) };
    let mut refrain_start: HashSet<i64> = HashSet::new();
    let mut refrain_mark: Vec<usize> = vec![];
    // 中段词
    let mut mid_verses: Vec<f64> = vec![];
    {
        let mut span: Vec<(f64, (usize, usize))> = vec![];
        for (k, sl) in slices.iter().enumerate() {
            for &x in sl {
                let c = src.cursor_of[x.0][x.1];
                if c < 0 {
                    continue;
                }
                for l in &src.lyrics_of[x.0] {
                    if !l.syllables.get(c as usize).is_some_and(|y| !y.text.is_empty()) {
                        continue;
                    }
                    match span.iter_mut().find(|(v, _)| *v == l.verse_from) {
                        Some((_, sp)) => sp.1 = k,
                        None => span.push((l.verse_from, (k, k))),
                    }
                }
            }
        }
        let head = min_of(span.iter().map(|(_, sp)| sp.0 as f64));
        let tail = max_of(span.iter().map(|(_, sp)| sp.1 as f64));
        for &(v, (a, b)) in &span {
            if a as f64 > head && (b as f64) < tail {
                mid_verses.push(v);
            }
        }
    }
    {
        let mut row_start_measures: HashSet<usize> = HashSet::new();
        let mut seen_row: HashSet<usize> = HashSet::new();
        for (k, sl) in slices.iter().enumerate() {
            for x in sl {
                if seen_row.insert(x.0) {
                    row_start_measures.insert(k);
                }
            }
        }
        let mut prev_lines = 0usize;
        let mut seen_measure: HashSet<(usize, usize)> = HashSet::new();
        for (k, sl) in slices.iter().enumerate() {
            let mut with_text: HashSet<(usize, usize)> = HashSet::new();
            let mut marked = false;
            for &x in sl {
                if let Some(key) = src.measure_key(x) {
                    if seen_measure.insert(key) {
                        let mark = src.measure(x).and_then(|mm| section_mark_of(mm, None)).unwrap_or_default();
                        if is_refrain_word(&mark) {
                            if row_start_measures.contains(&k) || row_start_measures.contains(&(k + 1)) {
                                if !refrain_mark.contains(&k) {
                                    refrain_mark.push(k);
                                }
                            } else {
                                marked = true;
                            }
                        }
                    }
                }
                let c = src.cursor_of[x.0][x.1];
                if c >= 0 {
                    for (j, l) in src.lyrics_of[x.0].iter().enumerate() {
                        if l.syllables.get(c as usize).is_some_and(|y| !y.text.is_empty()) && !mid_verses.contains(&l.verse_from) {
                            with_text.insert((x.0, j));
                        }
                    }
                }
            }
            if marked || (with_text.len() == 1 && prev_lines > 1) {
                refrain_start.insert(k as i64);
            }
            if !with_text.is_empty() {
                prev_lines = with_text.len();
            }
        }
    }
    let mut pages: Vec<LPage> = vec![];
    let mut pass_starts: HashSet<usize> = HashSet::new();
    let mut system = 0.0;
    let mut groups: Vec<Rc<LGroup>> = vec![];
    let intro = if o.layout.is_none() && no_intro { intro_slots(&src) } else { HashSet::new() };
    let mut passes = match o.layout {
        Some((desc, simple)) => passes_by_dur(&src, plan, desc, simple),
        None => passes_of(&src, plan, &breaks, &intro),
    };
    // 装满、按乐句、每行 N 小节：源里的换行不算（往回跳必断的照旧）
    if matches!(lb, LineBreak::Fill | LineBreak::Phrase | LineBreak::Bars(_)) {
        for p in passes.iter_mut() {
            p.breaks.clear();
        }
    }
    // 曲中转调另起一页；临时离调不换
    if o.layout.is_none() {
        let mut key_at: Vec<String> = vec![];
        let mut cur = key_text(song.song.key.as_ref());
        for sl in slices.iter() {
            let key = sl.iter().find_map(|&x| src.measure(x).and_then(|mm| mm.attrs.as_ref()).and_then(|a| a.key.as_ref()));
            if let Some(k) = key {
                cur = key_text(Some(k));
            }
            key_at.push(cur.clone());
        }
        for pass in passes.iter_mut() {
            let key_of = |i: usize| -> String {
                let k = measure_at(pass.slots[i]);
                if k < 0 {
                    String::new()
                } else {
                    key_at.get(k as usize).cloned().unwrap_or_default()
                }
            };
            struct Change {
                i: usize,
                from: String,
                to: String,
                after_section: bool,
            }
            let mut changes: Vec<Change> = vec![];
            for (i, &sl) in pass.slots.iter().enumerate() {
                let MusicElement::Note(n) = src.el(sl) else { continue };
                if i == 0 || n.key_label.as_deref().is_none_or(str::is_empty) {
                    continue;
                }
                let mut k = i - 1;
                while k > 0 && !matches!(src.el(pass.slots[k]), MusicElement::Note(_) | MusicElement::Barline(_)) {
                    k -= 1;
                }
                let after_section = matches!(src.el(pass.slots[k]), MusicElement::Barline(b) if matches!(b.kind, BarlineType::Double | BarlineType::End | BarlineType::RepeatEnd | BarlineType::RepeatBoth));
                changes.push(Change { i, from: key_of(i - 1), to: key_of(i), after_section });
            }
            let mut passing: HashSet<usize> = HashSet::new();
            for (n, c) in changes.iter().enumerate() {
                let Some(back) = changes.iter().enumerate().position(|(mm, d)| mm > n && d.to == c.from) else { continue };
                for mm in n..=back {
                    passing.insert(mm);
                }
            }
            for (n, c) in changes.iter().enumerate() {
                if c.after_section || !passing.contains(&n) {
                    pass.breaks.insert(c.i, true);
                }
            }
        }
    }
    // 整首最后一条小节线：画终止线
    let last_pass = passes.len().checked_sub(1);
    let bars_of = |pi: usize, pass: &Pass| -> Bars {
        let end = pass.slots.len() as i64 - 1;
        let tail = if Some(pi) == last_pass && end >= 0 { Some(pass.slots[end as usize]) } else { None };
        Bars { plain: o.exact_breaks, final_at: if tail.is_some_and(|t| matches!(src.el(t), MusicElement::Barline(_))) { end } else { -1 } }
    };
    for pi in 0..passes.len() {
        let max_rows = rows_of(pi + 1);
        if o.layout.is_none() && mid_verses.contains(&passes[pi].verses[0]) {
            if pair {
                passes[pi].after_repeat = true;
            }
            passes[pi].mid_verse = true;
        }
        let pos = pos_of(&passes[pi]);
        // 副歌起头也换行（短行照样不断）
        let mut soft: HashSet<usize> = HashSet::new();
        if infer && rows.len() == 1 {
            let pass = &mut passes[pi];
            let mut prev = -1i64;
            for i in 0..pass.slots.len() {
                let k = measure_at(pass.slots[i]);
                if i > 0 && k != prev && refrain_start.contains(&k) && !pass.breaks.contains_key(&i) {
                    pass.breaks.insert(i, false);
                    soft.insert(i);
                }
                prev = k;
            }
        }
        // 版面写明的断点
        for (at, page) in layout_cuts(spec, pi + 1, &passes[pi].slots, tags.as_ref()) {
            let pass = &mut passes[pi];
            let v = pass.breaks.entry(at).or_insert(false);
            *v |= page;
            pass.hard.add(at);
        }
        let pass = &passes[pi];
        let bars = bars_of(pi, pass);
        let whole = row_of(&src, pass, 0, pass.slots.len(), &pos, bars);
        // 这一遍从哪些符号跳进了源行中间
        let mut jump_in: HashSet<usize> = HashSet::new();
        if o.layout.is_none() {
            for at in std::iter::once(0).chain(pass.hard.0.iter().copied()) {
                let Some(&s) = pass.slots.get(at) else { continue };
                if rows[s.0].line.elements[..s.1].iter().enumerate().any(|(k, el)| matches!(el, MusicElement::Note(_)) && !intro.contains(&(s.0, k))) {
                    jump_in.insert(at);
                }
            }
        }
        let opts = FillOpts { hard: pass.hard.0.iter().copied().collect(), jump_in, soft, glue: pass.glue.clone(), keep_rest_lines: lb == LineBreak::Phrase };
        let mut forced = match lb {
            LineBreak::Phrase if o.layout.is_none() => phrase_cuts_of(&whole, &song.song, &opts.hard, m, ink, width, meter),
            LineBreak::Bars(n) if o.layout.is_none() => bar_cuts(&whole.line, n),
            _ => HashMap::new(),
        };
        for (&at, &page) in &pass.breaks {
            let v = forced.entry(at).or_insert(false);
            *v |= page;
        }
        let mut lines = fill_lines(&whole.line, &forced, m, ink, width, meter, &opts);
        if o.layout.is_none() && !infer {
            page_by_rows(&mut lines, &|_| false, max_rows);
        }
        if infer {
            let starts: Vec<usize> = lines.iter().map(|l| l.start).collect();
            let start_measure = |n: usize| -> i64 { pass.slots.get(starts[n]).map_or(-1, |&s| measure_at(s)) };
            let mut mark_heads: HashSet<usize> = HashSet::new();
            for &k in &refrain_mark {
                let n = (0..starts.len()).find(|&n| start_measure(n) >= k as i64);
                if let Some(n) = n {
                    if n > 0 && start_measure(n) <= k as i64 + 1 {
                        mark_heads.insert(n);
                    }
                }
            }
            let back_head = |n: usize| -> bool {
                if n == 0 || starts[n] == 0 {
                    return false;
                }
                pass.slots.get(starts[n] - 1).is_some_and(|&p| measure_at(p) > start_measure(n))
            };
            page_by_rows(&mut lines, &|n| mark_heads.contains(&n) || refrain_start.contains(&start_measure(n)) || back_head(n), max_rows);
        }
        // 一遍一页起头；只回头一次的这一遍首页放得下就接在上一遍那页
        let first_page_rows = lines.iter().enumerate().position(|(n, l)| n > 0 && l.page);
        let page_written = pi > 0 && {
            let prev = &passes[pi - 1];
            let prev_tail = prev.slots.last().copied();
            prev.breaks.get(&prev.slots.len()) == Some(&true) && !pass.slots.iter().any(|&s| Some(s) == prev_tail)
        };
        let joinable = pass.after_repeat && !page_written && (groups.len() + first_page_rows.unwrap_or(lines.len())) as f64 <= max_rows;
        if !joinable && !groups.is_empty() {
            pages.push(LPage { index: pages.len(), groups: std::mem::take(&mut groups) });
            pass_starts.insert(pages.len());
        }
        for (n, l) in lines.iter().enumerate() {
            if l.page && !groups.is_empty() {
                pages.push(LPage { index: pages.len(), groups: std::mem::take(&mut groups) });
            }
            let end = lines.get(n + 1).map_or(pass.slots.len(), |x| x.start);
            let voice = row_of(&src, pass, l.start, end, &pos, bars);
            groups.push(Rc::new(LGroup { index: groups.len(), texts: vec![], system, voices: vec![voice] }));
            system += 1.0;
        }
    }
    if !groups.is_empty() {
        pages.push(LPage { index: pages.len(), groups });
    }
    let pages = if o.layout.is_none() && pair { pair_pages(&pages, &pass_starts, rows_of(1)) } else { pages };
    LSong { pages, ..song.clone() }
}

/// 逐遍演唱顺序（123 `%%sing`，`singSong`）
/// 投影一遍展开后的那一行按乐句断（`%%layout 投影 linebreak=phrase`）：与简谱档按乐句断行同一套（`phraselines::content_breaks`，断句只看内容、
/// 行长按这一行自然排开的真实宽度选档与收拾），歌词取这一遍配上的那行词。回「在第几个元素之前换行」，交 `fill_lines` 当强制换行
/// （一句还放不下仍按版宽折）。必断处（`hard`：版面写明的断点、往回跳）隔开的一段一行放得下的照写的不动，只在放不下要折的段里按乐句切——
/// 照片子逐行写了断点的因此不变。
fn phrase_cuts_of(row: &LRow, song: &dm::Song, hard: &HashSet<usize>, m: &JianpuGrid, ink: &Ink, width: f64, meter: Option<&Meter>) -> HashMap<usize, bool> {
    let rv = RowView { part: row.part, measures: row.measures.clone(), refs: row.refs.clone(), line: row.line.clone() };
    let Ok((measures, _)) = build_measures(song, &[&rv], true, None) else { return HashMap::new() };
    let (part, _) = phrase_part_of(&measures);
    let els = &row.line.elements;
    // 断句输入的和弦与行里的音一一对应（`build_measures` 每个音一个和弦、次序不变）
    let notes: Vec<usize> = els.iter().enumerate().filter(|(_, e)| matches!(e, MusicElement::Note(_))).map(|(i, _)| i).collect();
    if notes.is_empty() || notes.len() != part.flat_chords().count() {
        return HashMap::new();
    }
    // 尺子：各音的自然横向区间，跟着的增时线算进 `x1b`
    let (laid, nat) = laid_natural(&row.line, m, ink, meter);
    let item_of: HashMap<i64, usize> = laid.items.iter().enumerate().map(|(k, it)| (it.src_index, k)).collect();
    let spans = notes
        .iter()
        .map(|&i| {
            let &k = item_of.get(&(i as i64))?;
            let mut last = k;
            while last + 1 < laid.items.len() && matches!(laid.items[last + 1].element, MusicElement::Sustain(_)) {
                last += 1;
            }
            Some(Span { x0: nat.left[0][k], x1: nat.right[0][k], x1b: (last > k).then(|| nat.right[0][last]) })
        })
        .collect();
    let (content, mid) = default_content_options();
    let (breaks, _) = content_breaks(&part, &FitMetric { width, spans }, vec![], &content, mid);
    // 按自然间距一行放得下的 `/` 段：(起, 止) 元素区间。只靠压字距才塞得下的不算——那正是挤的那种
    let mut bounds: Vec<usize> = hard.iter().copied().filter(|&h| h > 0 && h < els.len()).collect();
    bounds.sort_unstable();
    bounds.insert(0, 0);
    bounds.push(els.len());
    let one_line: Vec<(usize, usize)> = bounds
        .windows(2)
        .filter(|w| {
            let ks: Vec<usize> = laid.items.iter().enumerate().filter(|(_, it)| it.src_index >= w[0] as i64 && it.src_index < w[1] as i64).map(|(k, _)| k).collect();
            match (ks.first(), ks.last()) {
                (Some(&a), Some(&b)) => nat.right[0][b] - nat.left[0][a] <= width,
                _ => true,
            }
        })
        .map(|w| (w[0], w[1]))
        .collect();
    let mut out = HashMap::new();
    let mut put = |at: usize| {
        if !one_line.iter().any(|&(a, b)| at > a && at < b) {
            out.insert(at, false);
        }
    };
    let mut flat = 0;
    for (mi, mea) in part.measures.iter().enumerate() {
        if mi > 0 && breaks.measure_breaks.contains(&mi) {
            if let Some(&first) = notes.get(flat) {
                // 小节线留在上一行行尾：退到它后面
                let mut at = first;
                while at > 0 && !matches!(els[at - 1], MusicElement::Barline(_) | MusicElement::Note(_) | MusicElement::Sustain(_)) {
                    at -= 1;
                }
                put(at);
            }
        }
        flat += mea.chords.len();
    }
    if mid {
        for &k in &breaks.mid_breaks {
            let Some(&i) = notes.get(k) else { continue };
            // 在这个音之后换行；跟着的增时线属于它
            let mut at = i + 1;
            while at < els.len() && matches!(els[at], MusicElement::Sustain(_)) {
                at += 1;
            }
            if at < els.len() {
                put(at);
            }
        }
    }
    out
}

/// `%%sing` 逐遍排：一遍一页起头，按活动版面断行（缺省装满）、落 `break=` / `newpage=`、每页 `rows` 行
#[allow(clippy::too_many_arguments)]
fn sing_song(song: &LSong, plan: &[PlayItem], src: &Src, m: &JianpuGrid, ink: &Ink, width: f64, meter: Option<&Meter>, spec: Option<&LayoutSpec>, tags: Option<&SecTags>) -> LSong {
    let rows = &src.rows;
    let lb = spec.and_then(|s| s.line_break()).unwrap_or(LineBreak::Auto);
    let phrase = lb == LineBreak::Phrase;
    // 前奏、两两并页：样式表的缺省不管 `%%sing`（逐遍写定的），版面写明了才照办
    let intro = if spec.and_then(|s| s.no_intro) == Some(true) { intro_slots(src) } else { HashSet::new() };
    let pair = spec.and_then(|s| s.pair_pages) == Some(true);
    // (这一遍, 第几遍)
    let mut pages: Vec<(Pass, usize)> = vec![];
    let mut cur: Option<Pass> = None;
    let mut pass_no = 1usize;
    for (n, it) in plan.iter().enumerate() {
        let c = cur.get_or_insert_with(Pass::default);
        let mut mid = it.mid;
        while mid < it.end {
            let slice = (mid >= 0.0).then(|| src.slices.get(mid as usize)).flatten().map_or(&[][..], |v| &v[..]);
            let skip = if mid == it.mid { it.skip } else { 0.0 };
            let limit = if mid == it.end - 1.0 { it.limit } else { -1.0 };
            for sl in cut_slots(slice, src, skip, limit) {
                if !intro.contains(&sl) {
                    c.slots.push(sl);
                    c.verses.push(it.pass);
                }
            }
            mid += 1.0;
        }
        if it.end_of_pass || n == plan.len() - 1 {
            let c = cur.take().unwrap();
            if !c.slots.is_empty() {
                pages.push((c, pass_no));
            }
            pass_no += 1;
        }
    }
    let last = pages.len().checked_sub(1);
    let mut out: Vec<LPage> = vec![];
    let mut pass_starts: HashSet<usize> = HashSet::new();
    let mut system = 0.0;
    for (pi, (pass, no)) in pages.iter_mut().enumerate() {
        let max_rows = spec.and_then(|s| s.rows_for(*no)).unwrap_or(MAX_ROWS);
        // 版面写明的断点必断（也记进这一遍：断点前的双纵线照样画）
        let cuts = layout_cuts(spec, *no, &pass.slots, tags);
        for &at in cuts.keys() {
            pass.hard.add(at);
        }
        let pass = &*pass;
        let pos = pos_of(pass);
        let end = pass.slots.len() - 1;
        let tail = if Some(pi) == last { Some(pass.slots[end]) } else { None };
        let bars = Bars { plain: false, final_at: if tail.is_some_and(|t| matches!(rows[t.0].line.elements[t.1], MusicElement::Barline(_))) { end as i64 } else { -1 } };
        let whole = row_of(src, pass, 0, pass.slots.len(), &pos, bars);
        // 按乐句 / 每行 N 小节给强制换行，其余照版心宽装满
        let opts = FillOpts { hard: pass.hard.0.iter().copied().collect(), keep_rest_lines: phrase, ..Default::default() };
        let mut forced = match lb {
            LineBreak::Phrase => phrase_cuts_of(&whole, &song.song, &opts.hard, m, ink, width, meter),
            LineBreak::Bars(n) => bar_cuts(&whole.line, n),
            _ => HashMap::new(),
        };
        for (&at, &page) in &cuts {
            let v = forced.entry(at).or_insert(false);
            *v |= page;
        }
        let mut lines = fill_lines(&whole.line, &forced, m, ink, width, meter, &opts);
        page_by_rows(&mut lines, &|_| false, max_rows);
        if pi > 0 {
            pass_starts.insert(out.len());
        }
        let mut groups: Vec<Rc<LGroup>> = vec![];
        for (n, l) in lines.iter().enumerate() {
            if l.page && !groups.is_empty() {
                out.push(LPage { index: out.len(), groups: std::mem::take(&mut groups) });
            }
            let end = lines.get(n + 1).map_or(pass.slots.len(), |x| x.start);
            let voice = row_of(src, pass, l.start, end, &pos, bars);
            groups.push(Rc::new(LGroup { index: groups.len(), texts: vec![], system, voices: vec![voice] }));
            system += 1.0;
        }
        if !groups.is_empty() {
            out.push(LPage { index: out.len(), groups });
        }
    }
    let out = if pair { pair_pages(&out, &pass_starts, spec.and_then(|s| s.rows).unwrap_or(MAX_ROWS)) } else { out };
    LSong { pages: out, ..song.clone() }
}

/// 投影档：按演唱顺序逐遍切出、逐行装满（`expandView`）。`plays` 与 `view.songs` 平行；推不出演唱顺序的那首照原样
/// `layout_name`：活动的投影系版面名（`%%layout`；None = 内置「投影」）
pub fn expand_view(view: &LDoc, doc: &ScoreDoc, plays: &[Option<PlayData>], m: &JianpuGrid, ink: &Ink, break_desc: Option<&str>, layout_name: Option<&str>) -> LDoc {
    let songs = view
        .songs
        .iter()
        .enumerate()
        .map(|(i, song)| {
            let Some(pd) = plays.get(i).and_then(|p| p.as_ref()) else { return song.clone() };
            let layout = break_desc.filter(|d| !d.is_empty() && i == 0).map(|d| (d, pd.is_simple));
            let opts = SongOpts {
                layout,
                exact_breaks: doc.source_format == SourceFormat::Jpwabc,
                row_is_line: doc.source_format == SourceFormat::Fanqie,
                end_break: doc.songs.get(i).and_then(|s| s.parts.first()).and_then(|p| p.end_break.clone()),
                sing: pd.from_sing,
                spec: doc.songs.get(i).and_then(|s| find_layout(s, layout_name.unwrap_or(PROJECTION))),
            };
            expand_song(song, pd, m, ink, &opts)
        })
        .collect();
    LDoc { songs }
}
