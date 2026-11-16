//! `ScoreDoc` 的遍历、查询与构造（同 `src/model/helpers.ts`）。
//!
//! 音高 ↔ 度数、临时记号延续这些简谱语义在 `jianpu`，不在这里。

use crate::doc::*;
use dolce_base::js;
use std::collections::HashMap;

// ───────────────────────── id 分配 ─────────────────────────

/// 元素 id 分配器。**全文档唯一、不随数组增删变化**。
#[derive(Clone, Debug)]
pub struct IdGen {
    next: ElementId,
}

impl Default for IdGen {
    fn default() -> Self {
        IdGen { next: 1 }
    }
}

impl IdGen {
    pub fn new() -> IdGen {
        IdGen::default()
    }
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> ElementId {
        let id = self.next;
        self.next += 1;
        id
    }
    /// 已分配到哪
    pub fn watermark(&self) -> ElementId {
        self.next
    }
    /// 合并两份文档时把分配器推到安全位置
    pub fn bump(&mut self, to: ElementId) {
        if to >= self.next {
            self.next = to + 1;
        }
    }
}

// ───────────────────────── 元素的公共字段 ─────────────────────────

impl Element {
    pub fn id(&self) -> ElementId {
        match self {
            Element::Chord(c) => c.id,
            Element::Space(s) => s.id,
        }
    }
    pub fn voice(&self) -> f64 {
        match self {
            Element::Chord(c) => c.voice,
            Element::Space(s) => s.voice,
        }
    }
    pub fn staff(&self) -> f64 {
        match self {
            Element::Chord(c) => c.staff,
            Element::Space(s) => s.staff,
        }
    }
    pub fn onset(&self) -> Option<f64> {
        match self {
            Element::Chord(c) => c.onset,
            Element::Space(s) => s.onset,
        }
    }
    pub fn duration(&self) -> Option<&Duration> {
        match self {
            Element::Chord(c) => Some(&c.duration),
            Element::Space(s) => s.duration.as_ref(),
        }
    }
    pub fn harmony(&self) -> Option<&Harmony> {
        match self {
            Element::Chord(c) => c.harmony.as_ref(),
            Element::Space(s) => s.harmony.as_ref(),
        }
    }
    pub fn lyrics(&self) -> Option<&Vec<Lyric>> {
        match self {
            Element::Chord(c) => c.lyrics.as_ref(),
            Element::Space(s) => s.lyrics.as_ref(),
        }
    }
    pub fn beams(&self) -> Option<&Vec<BeamVal>> {
        match self {
            Element::Chord(c) => c.beams.as_ref(),
            Element::Space(s) => s.beams.as_ref(),
        }
    }
    pub fn source(&self) -> Option<SourceSpan> {
        match self {
            Element::Chord(c) => c.source,
            Element::Space(s) => s.source,
        }
    }
    pub fn as_chord(&self) -> Option<&Chord> {
        match self {
            Element::Chord(c) => Some(c),
            Element::Space(_) => None,
        }
    }
    pub fn as_chord_mut(&mut self) -> Option<&mut Chord> {
        match self {
            Element::Chord(c) => Some(c),
            Element::Space(_) => None,
        }
    }
    pub fn as_space(&self) -> Option<&Space> {
        match self {
            Element::Space(s) => Some(s),
            Element::Chord(_) => None,
        }
    }
}

use dolce_base::SourceSpan;

// ───────────────────────── 遍历 ─────────────────────────

/// 逐小节（声部序、小节序）：`(声部, 小节, 小节下标)`
pub fn each_measure(song: &Song) -> impl Iterator<Item = (&Part, &Measure, usize)> {
    song.parts.iter().flat_map(|p| p.measures.iter().enumerate().map(move |(i, m)| (p, m, i)))
}

pub fn each_element(song: &Song) -> impl Iterator<Item = (&Part, &Measure, &Element)> {
    each_measure(song).flat_map(|(p, m, _)| m.elements.iter().map(move |e| (p, m, e)))
}

/// 只过和弦（含休止），跳过占位符。
pub fn each_chord(song: &Song) -> impl Iterator<Item = (&Part, &Measure, &Chord)> {
    each_element(song).filter_map(|(p, m, e)| e.as_chord().map(|c| (p, m, c)))
}

/// 逐音符。休止没有 `notes`，自然跳过。
pub fn each_note(song: &Song) -> impl Iterator<Item = (&Part, &Measure, &Chord, &Note)> {
    each_chord(song).flat_map(|(p, m, c)| c.notes.iter().map(move |n| (p, m, c, n)))
}

/// 对每个和弦（可改）调 `f`。
pub fn for_each_chord_mut(song: &mut Song, mut f: impl FnMut(&mut Chord)) {
    for p in &mut song.parts {
        for m in &mut p.measures {
            for e in &mut m.elements {
                if let Element::Chord(c) = e {
                    f(c);
                }
            }
        }
    }
}

// ───────────────────────── 查询 ─────────────────────────

/// 按 id 找元素（线性扫）。
pub fn find_element(song: &Song, id: ElementId) -> Option<&Element> {
    each_element(song).map(|(_, _, e)| e).find(|e| e.id() == id)
}

/// 元素在文档里的位置：声部、小节、元素各自的下标。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ElemLoc {
    pub part: usize,
    pub measure: usize,
    pub elem: usize,
}

impl ElemLoc {
    pub fn part<'a>(&self, song: &'a Song) -> &'a Part {
        &song.parts[self.part]
    }
    pub fn measure<'a>(&self, song: &'a Song) -> &'a Measure {
        &song.parts[self.part].measures[self.measure]
    }
    pub fn element<'a>(&self, song: &'a Song) -> &'a Element {
        &song.parts[self.part].measures[self.measure].elements[self.elem]
    }
}

/// 建 id → 元素位置的索引。增时线的 id 也收进来，指向它所属的和弦（和弦可以挂在增时线上）。
pub fn element_index(song: &Song) -> HashMap<ElementId, ElemLoc> {
    let mut m = HashMap::new();
    for (pi, p) in song.parts.iter().enumerate() {
        for (mi, ms) in p.measures.iter().enumerate() {
            for (ei, e) in ms.elements.iter().enumerate() {
                m.insert(e.id(), ElemLoc { part: pi, measure: mi, elem: ei });
            }
        }
    }
    for (pi, p) in song.parts.iter().enumerate() {
        for (mi, ms) in p.measures.iter().enumerate() {
            for (ei, e) in ms.elements.iter().enumerate() {
                if let Element::Chord(c) = e {
                    for s in c.sustains.iter().flatten() {
                        m.insert(s.id, ElemLoc { part: pi, measure: mi, elem: ei });
                    }
                }
            }
        }
    }
    m
}

/// 这首歌有几段歌词：所有 `Lyric.number` 与 `numberTo` 的最大值。
pub fn verse_count(song: &Song) -> f64 {
    let mut max = 0.0f64;
    for (_, _, c) in each_chord(song) {
        for l in c.lyrics.iter().flatten() {
            max = js_max(max, l.number_to.unwrap_or(l.number));
        }
    }
    max
}

/// `Math.max(a, b)`（有 NaN 回 NaN）。
#[inline]
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `Math.min(a, b)`（有 NaN 回 NaN）。
#[inline]
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// 取某一段的歌词。副歌（`refrain`）对所有段都算命中。
pub fn lyric_of_verse(lyrics: Option<&[Lyric]>, verse: f64) -> Option<&Lyric> {
    for l in lyrics.unwrap_or(&[]) {
        if l.refrain == Some(true) {
            return Some(l);
        }
        let from = l.number;
        let to = l.number_to.unwrap_or(l.number);
        if verse >= from && verse <= to {
            return Some(l);
        }
    }
    None
}

/// 小节的总时值（divisions）。取各 voice 的最大值——和弦音与多声部不能累加。
pub fn measure_duration(measure: &Measure) -> f64 {
    // 声部按首次出现的次序（Map 插入序），与 TS 逐个取 max 结果相同
    let mut per_voice: Vec<(f64, f64)> = Vec::new();
    for el in &measure.elements {
        let d = match el {
            Element::Chord(c) => c.duration.divisions,
            Element::Space(s) => s.duration.as_ref().map_or(0.0, |d| d.divisions),
        };
        let v = el.voice();
        match per_voice.iter_mut().find(|(k, _)| same_key(*k, v)) {
            Some(e) => e.1 += d,
            None => per_voice.push((v, d)),
        }
    }
    per_voice.iter().fold(0.0, |m, &(_, d)| js_max(m, d))
}

/// JS `Map` 的键相等（SameValueZero：NaN 等于 NaN，+0 等于 -0）。
#[inline]
pub fn same_key(a: f64, b: f64) -> bool {
    a == b || (a.is_nan() && b.is_nan())
}

// ───────────────────────── 段落标记 ─────────────────────────

const SECTION_WORDS: &[&str] = &[
    "intro", "verse", "chorus", "prechorus", "pre-chorus", "bridge", "coda", "outro", "ending", "interlude", "solo", "refrain", "tag",
    "前奏", "主歌", "副歌", "间奏", "尾奏", "尾声", "桥段", "插曲",
];

/// `SECTION_WORD_RE`：`^(词)\s*\d*$`，不分大小写
pub fn is_section_word(t: &str) -> bool {
    let lower = t.to_ascii_lowercase();
    // 取最长的词头（正则按候选顺序回溯，结果只看整串能否匹配；逐个试即可）
    SECTION_WORDS.iter().any(|w| {
        lower.strip_prefix(w).is_some_and(|rest| {
            let rest = rest.trim_start_matches(js::is_space);
            rest.chars().all(|c| c.is_ascii_digit())
        })
    })
}

/// `REFRAIN_WORD_RE`：段落词里标副歌起头的那几个（`^(chorus|refrain|副歌)`，不分大小写）
pub fn is_refrain_word(t: &str) -> bool {
    let lower = t.to_ascii_lowercase();
    ["chorus", "refrain", "副歌"].iter().any(|w| lower.starts_with(w))
}

/// 一段文字是不是段落词：去掉谱面常见的括号再认。是就返回去掉括号的词。
pub fn section_word_of(text: Option<&str>) -> Option<String> {
    let t = js::trim(text.unwrap_or(""));
    let t = match t.strip_prefix(['【', '[', '（', '(']) {
        Some(r) => r.trim_start_matches(js::is_space),
        None => t,
    };
    let t = match t.strip_suffix(['】', ']', '）', ')']) {
        Some(r) => r.trim_end_matches(js::is_space),
        None => t,
    };
    (!t.is_empty() && is_section_word(t)).then(|| t.to_owned())
}

/// 这一小节的段落标记（Intro/Verse/Chorus…），没有返回 None。各格式同一个判据。
///
/// `prev`：`None` = 不给（TS 的 `undefined`）；`Some(None)` = 给了但是没有上一小节（TS 的 `null`）。
/// 给了时，**写在小节所有音之后**的 `<direction>` 标的是下一小节。
pub fn section_mark_of(m: &Measure, prev: Option<Option<&Measure>>) -> Option<String> {
    let at_end = |x: &Measure, d: &Direction| -> bool {
        matches!(d.after_elements, Some(a) if !x.elements.is_empty() && a >= x.elements.len() as f64)
    };
    let from_directions = |x: &Measure, keep: &dyn Fn(&Direction) -> bool| -> Option<String> {
        for d in x.directions.iter().flatten() {
            let t = js::trim(d.text.as_deref().unwrap_or(""));
            if t.is_empty() || !keep(d) {
                continue;
            }
            if d.kind == "rehearsal" {
                return Some(t.to_owned());
            }
            let w = if d.kind == "words" { section_word_of(Some(t)) } else { None };
            if w.is_some() {
                return w;
            }
        }
        None
    };
    if let Some(prev) = prev {
        let carried = prev.and_then(|p| from_directions(p, &|d| at_end(p, d)));
        if carried.is_some() {
            return carried;
        }
    }
    let own = from_directions(m, &|d| prev.is_none() || !at_end(m, d));
    if own.is_some() {
        return own;
    }
    for el in &m.elements {
        let Element::Chord(c) = el else { continue };
        let hosts = std::iter::once(c.section_word.as_deref()).chain(c.sustains.iter().flatten().map(|s| s.section_word.as_deref()));
        for sw in hosts {
            // 分行的几条逐条认
            for line in sw.unwrap_or("").split('\n') {
                let w = section_word_of(if line.is_empty() { None } else { Some(line) });
                if w.is_some() {
                    return w;
                }
            }
        }
    }
    None
}

// ───────────────────────── 换行口径 ─────────────────────────

/// 源码里「这一小节**之后**换行」→ 模型口径「下一小节**起**新系统」。
/// `after[i]` 是第 `i` 小节之后的换行。同一小节既有换行又有换页时换页为准。
pub fn breaks_after_to_start(part: &mut Part, after: &HashMap<usize, BreakKind>) {
    let n = part.measures.len();
    for i in 0..n {
        let Some(kind) = after.get(&i) else { continue };
        if i + 1 >= n {
            if part.end_break != Some(BreakKind::Page) {
                part.end_break = Some(kind.clone());
            }
            continue;
        }
        let next = &mut part.measures[i + 1];
        let mut p = next.print.clone().unwrap_or_default();
        if *kind == BreakKind::Page {
            p.new_page = Some(true);
            p.new_system = None;
        } else if p.new_page != Some(true) {
            p.new_system = Some(true);
        }
        next.print = Some(p);
    }
}

/// `breaks_after_to_start` 的反向：第 `i` 小节**之后**要不要换行（写出端用）。
pub fn break_after(part: &Part, i: usize) -> Option<BreakKind> {
    let Some(next) = part.measures.get(i + 1) else { return part.end_break.clone() };
    let p = next.print.as_ref();
    if p.and_then(|p| p.new_page) == Some(true) {
        return Some(BreakKind::Page);
    }
    if p.and_then(|p| p.new_system) == Some(true) {
        return Some(BreakKind::System);
    }
    None
}

// ───────────────────────── 构造 ─────────────────────────

pub const ZERO_SPAN: SourceSpan = SourceSpan { line: 0, column: 0, offset: 0, length: 0 };

pub fn empty_song() -> Song {
    Song {
        work: Work { number: None, title: None, movement_title: None, subtitles: vec![], version: None },
        identification: None,
        credits: None,
        key: None,
        time: None,
        extra_times: None,
        time_note: None,
        tempos: None,
        tempo_beat: None,
        defaults: None,
        part_groups: None,
        parts: vec![],
        marks: vec![],
        play_order: None,
        sing_order: None,
        section_order: None,
        section_marks: None,
        style: None,
        page_text: None,
        remarks: None,
        muse_directives: None,
        meta: None,
        source: None,
    }
}

pub fn empty_doc(source_format: SourceFormat) -> ScoreDoc {
    ScoreDoc { source_format, fanqie_dialect: None, source: None, songs: vec![], diagnostics: vec![] }
}

/// 第一首。
pub fn primary_song(doc: &ScoreDoc) -> Option<&Song> {
    doc.songs.first()
}

/// 派生五线谱时 `<note>` 上的源 id 前缀（`toxml` 写、`fromxml` 认）。
pub const SOURCE_ID_PREFIX: &str = "jp";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn section_words() {
        assert_eq!(section_word_of(Some("【Chorus】")).as_deref(), Some("Chorus"));
        assert_eq!(section_word_of(Some(" ( Verse 2 ) ")).as_deref(), Some("Verse 2"));
        assert_eq!(section_word_of(Some("副歌")).as_deref(), Some("副歌"));
        assert_eq!(section_word_of(Some("Pre-Chorus")).as_deref(), Some("Pre-Chorus"));
        assert_eq!(section_word_of(Some("dolce")), None);
        assert_eq!(section_word_of(Some("Verse2a")), None);
        assert!(is_refrain_word("Chorus 1"));
    }
}
