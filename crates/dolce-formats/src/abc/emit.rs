//! ABC 家族的写出端（同 `abcfamily/emit.ts` 基类 + `emit123.ts` / `emitabc.ts` / `emitjcx.ts` 三个方言）：`ScoreDoc` → 文本。
//!
//! 三种方言只有音乐体的写法不同，字段头、声部、歌词对位、小节线与房号、Mark 索引、符杠分组、`I:` 扩展共用；
//! 方言的回答（一个音怎么写、休止怎么写、时值怎么写、调号怎么写…）按 `Dialect` 分支，见「方言钩子」一节。
//!
//! 输出风格固定（幂等的前提）：字段用 ASCII 规范形、小节之间一个空格、符杠分组内连写（123 不分组）、一行曲一行词。

use super::abcpitch::{voice_grouped, with_abc_accidentals, with_abc_pitches};
use super::dialect::tuplet_normal_123;
use super::fields::{barline_ornament_name, sing_lines};
use super::lex::{is_bare_chord, Dialect};
use super::lyricline::parse_lyric_line;
use super::lyricpunct::{is_latin_end, is_latin_start, is_lyric_apostrophe, is_lyric_trailing_punct, is_one_cjk_with_punct};
use super::lyricslot::{lyric_slots, LyricSlotRule};
use super::u16s::enc;
use dolce_base::js::{self, num_to_string as ns, repeat_count};
use dolce_base::SourceSpan;
use dolce_model::beatgroup::{beat_group_index, beat_group_size};
use dolce_model::deconames::{chord_notehead, rehearsal_of};
use dolce_model::directionmarks::directions_as_marks;
use dolce_model::emitutil::{arcs_to_next_note, beam_level1, nest_arcs_in_tuplets, own_ids, own_marks, part_ranges, system_ranges, SystemRange};
use dolce_model::harmony::chord_suffix_form;
use dolce_model::helpers::{break_after, lyric_of_verse};
use dolce_model::innervoice::layers_to_voices;
use dolce_model::jianpu::{
    assign_degrees, c_major, clef_name, continues_measure, harmony_text, key_spelling, melody_lane, nominal_quarters, note_height, top_note,
    AccidentalCarry,
};
use dolce_model::jianpuproject::{creators_from_credits, header_from_credits, project_for_jianpu};
use dolce_model::keyshift::{key_fifths, tonic_spelling};
use dolce_model::metakeys::get_meta;
use dolce_model::staves::{fill_empty_measures, split_staves};
use dolce_model::timeaxis::fill_absent_groups;
use dolce_model::xmlproject::{has_tie_syntax, is_xml_shaped, slurs_as_ties, ORNAMENT_TAG};
use dolce_model::{
    BarLocation, BarStyle, Barline, BeamVal, BreakKind, Chord, Clef, Element, ElementId, EndingType, Key, Mark, MarkType, Measure,
    MeasureAttrs, Note, Part, RepeatDir, ScoreDoc, SourceFormat, Spacer, Song, Tempo, Time, WedgeType, SIMPLE_DIVISIONS,
};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

// ───────────────────────── 共用小件 ─────────────────────────

/// MusicXML 的 `<ornaments>` 元素名 → 123 记号名（`ORNAMENT_TAG` 反查，同名取第一个）
fn ornament_name(tag: &str) -> &str {
    ORNAMENT_TAG.iter().find(|(_, t)| *t == tag).map_or(tag, |(n, _)| n)
}

/// MusicXML 的 `<technical>` 元素名 → 123 记号名（ABC 标准名）
fn technical_name(tag: &str) -> &str {
    match tag {
        "up-bow" => "upbow",
        "down-bow" => "downbow",
        _ => tag,
    }
}

struct TupletStart {
    ratios: Vec<(f64, f64)>,
    outer_arcs: usize,
}

struct TupletEnd {
    count: usize,
    outer_arcs: usize,
}

/// Mark 按起止 id 建的索引（在元素前后插 `(` `)` 与 `(N:`）
#[derive(Default)]
pub struct MarkIndex {
    slur_start: HashMap<ElementId, usize>,
    slur_end: HashMap<ElementId, usize>,
    tuplet_start: HashMap<ElementId, TupletStart>,
    tuplet_end: HashMap<ElementId, TupletEnd>,
    arc_next: HashSet<ElementId>,
    wedge_start: HashMap<ElementId, Vec<WedgeType>>,
    wedge_end: HashMap<ElementId, Vec<WedgeType>>,
}

/// 小节线上的记号 → `!segno!` 之类的 token（认不出的名字原样写出）
fn barline_ornaments(b: &Barline) -> Vec<String> {
    b.ornaments.iter().flatten().map(|o| format!("!{}!", barline_ornament_name(&o.name).unwrap_or(&o.name))).collect()
}

/// 小节线归一名 → 文本（与词法表互逆）
fn barline_text(b: &Barline) -> &'static str {
    match b.repeat {
        Some(RepeatDir::Forward) => return if b.repeat_times == Some(3.0) { "|::" } else { "|:" },
        Some(RepeatDir::Backward) => return if b.repeat_times == Some(3.0) { "::|" } else { ":|" },
        _ => {}
    }
    match b.style {
        Some(BarStyle::NoStyle) => "[|]",
        Some(BarStyle::LightLight) => "||",
        Some(BarStyle::LightHeavy) => "|]",
        Some(BarStyle::HeavyLight) => "[|",
        Some(BarStyle::Dotted) => ".|",
        _ => "|",
    }
}

/// 歌词行里印刷段号的写法
#[derive(Clone, Copy, PartialEq)]
pub enum LabelStyle {
    /// 行首 `<1.>`
    Angle,
    /// 不写（Muse）
    Off,
    /// 数字段号写在首字前 `1.~道`（ABC 惯例），别的仍写 `<副歌>`
    Tilde,
}

/// 歌词行的方言写法。缺省是 123 的：多字并一格包 `{}`、段号 `<1.>`、延长 `_`
#[derive(Clone, Copy)]
pub struct LyricStyle {
    /// Muse：一格里读回会拆开的字用 `~` 连（`museJoin`），不包 `{}`
    pub muse_join: bool,
    pub labels: LabelStyle,
    pub extend: &'static str,
}

impl Default for LyricStyle {
    fn default() -> Self {
        LyricStyle { muse_join: false, labels: LabelStyle::Angle, extend: "_" }
    }
}

fn is_cjk_basic(c: char) -> bool {
    ('\u{3400}'..='\u{9fff}').contains(&c)
}

/// 拉丁音节读回会被拆开：中间夹着空白，或收尾标点后面还接着字。这种包 `{}`
fn splits_on_read(text: &str) -> bool {
    if js::trim(text).chars().any(js::is_space) {
        return true;
    }
    let u = enc(text);
    for k in 0..u.len().saturating_sub(1) {
        if is_lyric_trailing_punct(u[k]) && !is_lyric_apostrophe(&u, k) && !is_lyric_trailing_punct(u[k + 1]) {
            return true;
        }
    }
    false
}

/// `/[!"'),.:;?\]}]+$/` 的匹配
fn ascii_tail(text: &str) -> &str {
    let keep = text.trim_end_matches(|c: char| "!\"'),.:;?]}".contains(c));
    &text[keep.len()..]
}

/// Muse：一格里的字按读入端（不开 `join_tilde`）会拆成几格，就在拆开处插 `~`
fn muse_join(text: &str) -> String {
    let span = SourceSpan { line: 0, column: 0, offset: 0, length: 0 };
    let parts = parse_lyric_line(&enc(text), 1.0, span, None, '*', &mut |_, _| {}, false, false).syllables;
    if parts.len() < 2 {
        return text.to_string();
    }
    parts
        .iter()
        .map(|p| format!("{}{}{}", p.leading_punctuation.as_deref().unwrap_or(""), p.text, p.trailing_punctuation.as_deref().unwrap_or("")))
        .collect::<Vec<_>>()
        .join("~")
}

/// 一个系统（第 `from`–`to` 小节）的歌词行（同 `emit.ts::lyricLines`）。**逐个对位格走、空位补跳音符**；
/// 段号由 `w:` 的出现顺序定，中间没词的段写空 `w:` 顶住、尾部没词的不写
pub fn lyric_lines(
    part: &Part,
    sep: &str,
    skip: &str,
    sys: &SystemRange,
    rule: LyricSlotRule,
    style: LyricStyle,
    extra_slots: &dyn Fn(&Element) -> usize,
) -> Vec<String> {
    let ext = style.extend;
    let own = lyric_slots(part, sys.from, Some(sys.to), sys.from_el, sys.to_el, rule);
    let mut slots: Vec<Option<&Element>> = vec![];
    for (mi, ei) in own {
        let el = &part.measures[mi].elements[ei];
        slots.push(Some(el));
        for _ in 0..extra_slots(el) {
            slots.push(None);
        }
    }
    let mut max_verse: f64 = 0.0;
    for el in slots.iter().flatten() {
        for l in el.lyrics().into_iter().flatten() {
            max_verse = js::max(max_verse, l.number_to.unwrap_or(l.number));
        }
    }
    let mut bodies: Vec<String> = vec![];
    let mut verse = 1.0;
    while verse <= max_verse {
        let mut body = String::new();
        let mut label: Option<String> = None;
        let mut label_inline = false;
        // 这一行已写出过字：ABC 的 `1.~` 只在段首（前面只有跳格）读成段号，行中间的段号退回行首 `<…>`
        let mut wrote = false;
        let mut pending_skips = String::new();
        let mut extend_consumes = false;
        let mut prev_syllabic: Option<dolce_model::Syllabic> = None;
        let mut prev_latin = false;
        for el in &slots {
            let Some(el) = el else {
                if extend_consumes {
                    extend_consumes = false;
                } else {
                    if !pending_skips.is_empty() {
                        pending_skips.push_str(sep);
                    }
                    pending_skips.push_str(skip);
                }
                continue;
            };
            let hit = lyric_of_verse(el.lyrics().map(|v| v.as_slice()), verse);
            if let Some(h) = hit {
                if h.verse_label.is_some() && label.is_none() {
                    label = h.verse_label.clone();
                }
            }
            let Some(hit) = hit.filter(|h| !h.text.is_empty()) else {
                if extend_consumes {
                    extend_consumes = false;
                    continue;
                }
                if !pending_skips.is_empty() {
                    pending_skips.push_str(sep);
                }
                pending_skips.push_str(if hit.is_some_and(|h| h.extend == Some(true)) { ext } else { skip });
                continue;
            };
            use dolce_model::Syllabic as Sy;
            let in_word = matches!(prev_syllabic, Some(Sy::Begin) | Some(Sy::Middle));
            let word_sep = if sep.is_empty()
                && prev_latin
                && pending_skips.is_empty()
                && is_latin_start(hit.leading_punctuation.as_deref().unwrap_or(&hit.text))
            {
                " "
            } else {
                sep
            };
            if !body.is_empty() {
                body.push_str(if in_word { "-" } else { word_sep });
            }
            body.push_str(&pending_skips);
            pending_skips.clear();
            let in_word_next = matches!(hit.syllabic, Some(Sy::Begin) | Some(Sy::Middle));
            let need_brace = (hit.text.chars().count() > 1
                && hit.text.chars().any(is_cjk_basic)
                && (in_word_next || !is_one_cjk_with_punct(&hit.text)))
                || splits_on_read(&hit.text);
            let bare: String = if skip == "/" {
                let mut s = String::new();
                for c in hit.text.chars() {
                    if c == '/' || c == '-' {
                        s.push('\\');
                    }
                    s.push(c);
                }
                s
            } else {
                hit.text.clone()
            };
            let joined = if style.muse_join {
                muse_join(&hit.text)
            } else if need_brace {
                format!("{{{}}}", hit.text)
            } else {
                bare.clone()
            };
            if style.labels == LabelStyle::Tilde
                && hit.verse_label.is_some()
                && hit.verse_label == label
                && is_numeric_label(label.as_deref().unwrap())
                && !label_inline
                && !wrote
            {
                body.push_str(label.as_deref().unwrap());
                body.push('~');
                label_inline = true;
            }
            body.push_str(hit.leading_punctuation.as_deref().unwrap_or(""));
            body.push_str(&joined);
            wrote = true;
            body.push_str(hit.trailing_punctuation.as_deref().unwrap_or(""));
            prev_syllabic = hit.syllabic.clone();
            let tail: Option<&str> = match &hit.trailing_punctuation {
                Some(t) => Some(t.as_str()),
                None => Some(ascii_tail(&hit.text)).filter(|t| !t.is_empty()),
            };
            let tail_truthy = tail.is_some_and(|t| !t.is_empty());
            let core: &str = if hit.trailing_punctuation.as_deref().is_some_and(|t| !t.is_empty()) || !tail_truthy {
                &hit.text
            } else {
                &hit.text[..hit.text.len() - tail.unwrap().len()]
            };
            prev_latin = if tail_truthy {
                is_latin_end(core) && tail.unwrap().chars().all(|c| ('!'..='~').contains(&c))
            } else {
                is_latin_end(&hit.text) || (!need_brace && (bare.ends_with('/') || bare.ends_with('-')) && bare != hit.text)
            };
            if hit.extend == Some(true) {
                body.push_str(sep);
                body.push_str(ext);
                extend_consumes = true;
                prev_syllabic = None;
                prev_latin = false;
            }
        }
        if !body.is_empty() && matches!(prev_syllabic, Some(dolce_model::Syllabic::Begin) | Some(dolce_model::Syllabic::Middle)) {
            body.push('-');
        }
        bodies.push(if body.is_empty() {
            String::new()
        } else {
            let lab = match (&label, style.labels != LabelStyle::Off && !label_inline) {
                (Some(l), true) => format!("<{l}>"),
                _ => String::new(),
            };
            lab + &body
        });
        verse += 1.0;
    }
    while bodies.last().is_some_and(|b| b.is_empty()) {
        bodies.pop();
    }
    bodies.into_iter().map(|b| format!("w:{b}")).collect()
}

/// `/^\d+[.．、]?$/`
fn is_numeric_label(s: &str) -> bool {
    let d = s.bytes().take_while(|b| b.is_ascii_digit()).count();
    if d == 0 {
        return false;
    }
    let rest = &s[d..];
    rest.is_empty() || rest == "." || rest == "．" || rest == "、"
}

/// `split(/\r\n?|\n/)`
fn split_lines(s: &str) -> Vec<&str> {
    let mut out = vec![];
    let b = s.as_bytes();
    let mut start = 0;
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\n' {
            out.push(&s[start..i]);
            i += 1;
            start = i;
        } else if b[i] == b'\r' {
            out.push(&s[start..i]);
            i += if b.get(i + 1) == Some(&b'\n') { 2 } else { 1 };
            start = i;
        } else {
            i += 1;
        }
    }
    out.push(&s[start..]);
    out
}

/// 字段值里的换行会把后续内容变成裸行：一律按行拆成多条同名字段
fn push_lines(l: &mut Vec<String>, name: &str, value: &str) {
    for line in split_lines(value) {
        let t = js::trim(line);
        if !t.is_empty() {
            l.push(format!("{name}:{t}"));
        }
    }
}

/// `I:score` 的值（ABC §11.1）：大谱表花括号、`<part-group>` 的括号 / 花括号。没有可写的返回 None
pub fn score_directive(song: &Song) -> Option<String> {
    let vno: HashMap<&str, String> = song.parts.iter().enumerate().map(|(i, p)| (p.id.as_str(), (i + 1).to_string())).collect();
    let mut units: Vec<(Vec<&str>, String)> = vec![];
    for p in &song.parts {
        if p.staff_of.as_deref().is_some_and(|s| vno.contains_key(s)) {
            continue;
        }
        let mut ids = vec![p.id.as_str()];
        ids.extend(song.parts.iter().filter(|q| q.staff_of.as_deref() == Some(p.id.as_str())).map(|q| q.id.as_str()));
        let text = ids.iter().map(|id| vno[id].clone()).collect::<Vec<_>>().join(" ");
        units.push((ids, text));
    }
    use dolce_model::GroupSymbol;
    let groups: Vec<&dolce_model::PartGroup> = song
        .part_groups
        .iter()
        .flatten()
        .filter(|g| matches!(g.symbol, Some(GroupSymbol::Bracket) | Some(GroupSymbol::Brace)))
        .collect();
    if groups.is_empty() && units.iter().all(|u| u.0.len() == 1) {
        return None;
    }
    let mut out: Vec<String> = vec![];
    let mut i = 0;
    while i < units.len() {
        let g = groups.iter().find(|x| x.parts.first().is_some_and(|p0| units[i].0.contains(&p0.as_str())));
        if let Some(g) = g {
            let in_g = |u: &(Vec<&str>, String)| u.0.iter().any(|id| g.parts.iter().any(|p| p == id));
            let mut j = i;
            while j < units.len() && in_g(&units[j]) {
                j += 1;
            }
            let (l, r) = if g.symbol == Some(GroupSymbol::Bracket) { ("[", "]") } else { ("{", "}") };
            let inner = units[i..j.max(i)].iter().map(|u| u.1.clone()).collect::<Vec<_>>().join(" ");
            out.push(format!("{l}{inner}{r}"));
            i = j.max(i + 1);
            continue;
        }
        let u = &units[i];
        out.push(if u.0.len() > 1 { format!("{{{}}}", u.1) } else { u.1.clone() });
        i += 1;
    }
    Some(out.join(" "))
}

/// MusicXML 写明的符杠分组（第一层 begin … end，各声部分开）；一个 begin 都没有为 None
pub fn xml_beam_groups(mea: &Measure) -> Option<HashMap<ElementId, f64>> {
    if !mea.elements.iter().any(|e| e.as_chord().is_some_and(|c| beam_level1(c.beams.as_ref()) == Some(BeamVal::Begin))) {
        return None;
    }
    let mut out = HashMap::new();
    let mut open: HashMap<js::NumKey, f64> = HashMap::new();
    let mut next = 0.0;
    for el in &mea.elements {
        let Element::Chord(c) = el else { continue };
        if c.grace.is_some() {
            continue;
        }
        let voice = js::NumKey::new(if c.voice > 1.0 { c.voice } else { 1.0 });
        let b = beam_level1(c.beams.as_ref());
        if b == Some(BeamVal::Begin) {
            next += 1.0;
            open.insert(voice, next);
        }
        if let Some(g) = open.get(&voice) {
            if b.is_some() {
                out.insert(c.id, *g);
            }
        }
        if b == Some(BeamVal::End) || b.is_none() {
            open.remove(&voice);
        }
    }
    Some(out)
}

/// 拍号的写法：`C` / `C|`，其余写分数
pub fn time_text(t: &Time) -> String {
    if t.symbol.as_deref() == Some("common") && t.beats == 4.0 && t.beat_type == 4.0 {
        return "C".into();
    }
    if t.symbol.as_deref() == Some("cut") && t.beats == 2.0 && t.beat_type == 2.0 {
        return "C|".into();
    }
    format!("{}/{}", ns(t.beats), ns(t.beat_type))
}

/// 收一行：换行标记两侧的空格收掉、末尾换行收掉；代码行以「字母（+ 数字）+ 冒号」起头的前面垫一个空格
fn flush_text(s: &str) -> String {
    // `.replace(/ ?\n ?/g, "\n")`
    let cs: Vec<char> = s.chars().collect();
    let mut a = String::with_capacity(s.len());
    let mut i = 0;
    while i < cs.len() {
        if cs[i] == ' ' && cs.get(i + 1) == Some(&'\n') {
            a.push('\n');
            i += 2;
            if cs.get(i) == Some(&' ') {
                i += 1;
            }
        } else if cs[i] == '\n' {
            a.push('\n');
            i += 1;
            if cs.get(i) == Some(&' ') {
                i += 1;
            }
        } else {
            a.push(cs[i]);
            i += 1;
        }
    }
    // `.replace(/\n+$/, "")`
    let a = a.trim_end_matches('\n');
    // `.replace(/^(?=[A-Za-z]\d*(?:-\d+)?\s*[:：])/gm, " ")`
    let cs: Vec<char> = a.chars().collect();
    let looks_field = |p: usize| -> bool {
        let mut k = p;
        if !cs.get(k).is_some_and(|c| c.is_ascii_alphabetic()) {
            return false;
        }
        k += 1;
        while cs.get(k).is_some_and(|c| c.is_ascii_digit()) {
            k += 1;
        }
        if cs.get(k) == Some(&'-') && cs.get(k + 1).is_some_and(|c| c.is_ascii_digit()) {
            k += 1;
            while cs.get(k).is_some_and(|c| c.is_ascii_digit()) {
                k += 1;
            }
        }
        while cs.get(k).is_some_and(|&c| js::is_space(c)) {
            k += 1;
        }
        matches!(cs.get(k), Some(':') | Some('：'))
    };
    let mut out = String::with_capacity(a.len() + 4);
    for (p, &c) in cs.iter().enumerate() {
        let line_start = p == 0 || matches!(cs[p - 1], '\n' | '\r' | '\u{2028}' | '\u{2029}');
        if line_start && looks_field(p) {
            out.push(' ');
        }
        out.push(c);
    }
    out
}

/// 一首歌里这个和弦的音（下标）按什么顺序写
type NoteIdx = Vec<usize>;

// ───────────────────────── 写出器 ─────────────────────────

struct Emitter {
    d: Dialect,
    /// 当前这首：元素 id → 写在它前面的段落标记（Muse 恒空）
    sections_before: HashMap<ElementId, Vec<String>>,
    /// 和音里单连一个音的延音线写在括号里那个音后面（123 `[1~3]`）：（和弦 id，音下标）
    note_tie_after: HashSet<(ElementId, usize)>,
    /// `measure_body` 写出的最后一个小节中间的谱号
    last_mid_clef: Option<String>,
    /// 正在写的小节的拍号（`auto_beam_groups` 按它分拍）
    cur_time: (f64, f64),
    /// 正在写的歌是 MusicXML 来源（ABC 的 `emit_song` 设）
    xml_source: bool,
}

const GRACE_TYPES_123: [&str; 4] = ["eighth", "16th", "32nd", "64th"];

fn grace_len(t: &str) -> &'static str {
    match t {
        "quarter" => "2",
        "eighth" => "",
        "16th" => "/",
        "32nd" => "/4",
        "64th" => "/8",
        _ => "",
    }
}

fn abc_fixed_tuplet(actual: f64) -> Option<f64> {
    Some(match actual {
        x if x == 2.0 => 3.0,
        x if x == 3.0 => 2.0,
        x if x == 4.0 => 3.0,
        x if x == 6.0 => 2.0,
        x if x == 8.0 => 3.0,
        _ => return None,
    })
}

/// 写出端固定的默认音长：八分音符（ABC / Muse）
const UNIT: f64 = SIMPLE_DIVISIONS / 2.0;

fn gcd(a: f64, b: f64) -> f64 {
    if b == 0.0 { a } else { gcd(b, a % b) }
}

/// divisions → 相对 `L:1/8` 的时值后缀：`""`(=1) / `2` / `/2` / `3/2`
fn length_suffix(divisions: f64) -> String {
    if divisions <= 0.0 || divisions.is_nan() {
        return String::new();
    }
    let mut num = divisions;
    let mut den = UNIT;
    let g0 = gcd(num, den);
    let g = if g0 == 0.0 || g0.is_nan() { 1.0 } else { g0 };
    num /= g;
    den /= g;
    if num == 1.0 && den == 1.0 {
        return String::new();
    }
    if num == 1.0 && den == 2.0 {
        return "/".into();
    }
    if den == 1.0 {
        return ns(num);
    }
    format!("{}/{}", ns(num), ns(den))
}

fn acc_text(d: Dialect, a: &dolce_model::Accidental) -> &'static str {
    let s = a.as_str();
    match d {
        Dialect::J123 => match s {
            "sharp" => "#",
            "flat" => "b",
            "natural" => "n",
            "double-sharp" => "##",
            "double-flat" => "bb",
            _ => "",
        },
        _ => match s {
            "sharp" => "^",
            "flat" => "_",
            "natural" => "=",
            "double-sharp" => "^^",
            "double-flat" => "__",
            _ => "",
        },
    }
}

fn staff1(a: Option<&MeasureAttrs>) -> Option<&Clef> {
    a?.clefs.as_ref()?.iter().find(|x| x.staff.unwrap_or(1.0) == 1.0)
}

/// 元素的实际时值（倚音 0；多连音按比例折）
fn real_len(el: &Element) -> f64 {
    let (dur, grace) = match el {
        Element::Chord(c) => (Some(&c.duration), c.grace.is_some()),
        Element::Space(s) => (s.duration.as_ref(), false),
    };
    if grace {
        return 0.0;
    }
    let tm = dur.and_then(|d| d.time_mod.as_ref());
    dur.map_or(0.0, |d| d.divisions) * tm.map_or(1.0, |t| t.normal / t.actual)
}

impl Emitter {
    fn new(d: Dialect) -> Emitter {
        Emitter { d, sections_before: HashMap::new(), note_tie_after: HashSet::new(), last_mid_clef: None, cur_time: (4.0, 4.0), xml_source: false }
    }

    // ────────── 方言钩子 ──────────

    fn version_line(&self) -> &'static str {
        match self.d {
            Dialect::J123 => "%123-1.0",
            Dialect::Abc => "%abc-2.1",
            Dialect::Jcx => "%MUSE2",
        }
    }

    fn note_text(&self, n: &Note) -> String {
        match self.d {
            Dialect::J123 => {
                let Some(d) = &n.degree else { return if n.pitch.is_some() { "0".into() } else { String::new() } };
                let mut s = String::new();
                if let Some(a) = &d.accidental {
                    s.push_str(acc_text(self.d, a));
                }
                s.push_str(&ns(d.number));
                if d.octave_shift > 0.0 {
                    s.push_str(&"'".repeat(repeat_count(d.octave_shift)));
                } else {
                    s.push_str(&",".repeat(repeat_count(-d.octave_shift)));
                }
                s
            }
            Dialect::Abc => {
                let Some(p) = &n.pitch else { return String::new() };
                let mut s = n.accidental.as_ref().map_or("", |a| acc_text(self.d, a)).to_string();
                let oct = p.octave;
                let step = p.step.as_str();
                s.push_str(&if oct >= 5.0 { step.to_lowercase() } else { step.to_string() });
                if oct > 5.0 {
                    s.push_str(&"'".repeat(repeat_count(oct - 5.0)));
                } else if oct < 4.0 {
                    s.push_str(&",".repeat(repeat_count(4.0 - oct)));
                }
                s
            }
            Dialect::Jcx => {
                let Some(d) = &n.degree else { return String::new() };
                if d.number < 1.0 || d.number.is_nan() {
                    return String::new();
                }
                let idx = d.number - 1.0;
                let letter = if idx.fract() == 0.0 && idx < 7.0 { &"CDEFGAB"[idx as usize..idx as usize + 1] } else { "C" };
                let mut s = d.accidental.as_ref().map_or("", |a| acc_text(self.d, a)).to_string();
                let oct = d.octave_shift;
                if oct >= 1.0 {
                    s.push_str(&letter.to_lowercase());
                    s.push_str(&"'".repeat(repeat_count(oct - 1.0)));
                } else {
                    s.push_str(letter);
                    s.push_str(&",".repeat(repeat_count(-oct)));
                }
                s
            }
        }
    }

    fn rest_text(&self, ch: &Chord) -> &'static str {
        let hidden = ch.print_object == Some(false);
        match self.d {
            Dialect::J123 => if hidden { "x" } else { "0" },
            Dialect::Abc => if hidden { "x" } else { "z" },
            Dialect::Jcx => if hidden { "@" } else { "z" },
        }
    }

    fn duration_text(&self, el: &Element) -> String {
        match self.d {
            Dialect::J123 => {
                let beams = el.beams().map_or(0, |b| b.len());
                let dots = match el {
                    Element::Chord(c) => c.duration.dots,
                    Element::Space(s) => s.duration.as_ref().map_or(0.0, |d| d.dots),
                };
                "_".repeat(beams) + &".".repeat(repeat_count(dots))
            }
            _ => el.duration().map_or(String::new(), |d| length_suffix(d.divisions)),
        }
    }

    fn key_value(&self, k: &Key) -> String {
        let mode3 = |m: &str| -> String { m.chars().take(3).collect() };
        let real_mode = k.mode.as_deref().filter(|m| !m.is_empty() && *m != "major" && *m != "ionian");
        match self.d {
            Dialect::J123 => {
                if k.spelling.as_deref() == Some("none") {
                    return "none".into();
                }
                let sp = tonic_spelling(k);
                if let Some(m) = real_mode {
                    return sp + &if m == "minor" { "m".to_string() } else { mode3(m) };
                }
                format!("{}={}", k.tonic_degree.as_deref().unwrap_or("1"), sp)
            }
            Dialect::Abc => {
                if k.spelling.as_deref() == Some("none") {
                    return "none".into();
                }
                let mut sp = tonic_spelling(k);
                // `^([#b])([A-G])$` → `$2$1`
                let b = sp.as_bytes();
                if b.len() == 2 && (b[0] == b'#' || b[0] == b'b') && (b'A'..=b'G').contains(&b[1]) {
                    sp = format!("{}{}", b[1] as char, b[0] as char);
                }
                let mode = if let Some(m) = real_mode {
                    mode3(m)
                } else if k.mode.as_deref().is_none_or(|m| m.is_empty()) {
                    match k.tonic_degree.as_deref().unwrap_or("1") {
                        "2" => "dor",
                        "3" => "phr",
                        "4" => "lyd",
                        "5" => "mix",
                        "6" => "min",
                        "7" => "loc",
                        _ => "",
                    }
                    .to_string()
                } else {
                    String::new()
                };
                sp + if mode == "min" { "m" } else { &mode }
            }
            Dialect::Jcx => {
                if k.spelling.as_deref() == Some("none") {
                    return "C".into();
                }
                let mode = real_mode.map(mode3).unwrap_or_default();
                if !mode.is_empty() {
                    return tonic_spelling(k) + if mode == "min" || mode == "aeo" { "m" } else { &mode };
                }
                if k.tonic_degree.as_deref().is_some_and(|t| !t.is_empty() && t != "1") {
                    return key_spelling(&Key { fifths: k.fifths, ..Default::default() }, false);
                }
                key_spelling(k, false)
            }
        }
    }

    fn time_value(&self, song: &Song) -> Option<String> {
        let t0 = song.time.as_ref()?;
        if self.d != Dialect::J123 {
            return Some(time_text(t0));
        }
        let single = song.extra_times.as_ref().is_none_or(|v| v.is_empty()) && song.time_note.is_none();
        let mut parts: Vec<String> = vec![];
        let mut in_paren = false;
        for t in std::iter::once(t0).chain(song.extra_times.iter().flatten()) {
            let paren = t.parenthesized == Some(true);
            if !paren && in_paren {
                parts.last_mut().unwrap().push(')');
            }
            let body = if single { time_text(t) } else { format!("{}/{}", ns(t.beats), ns(t.beat_type)) };
            parts.push(format!("{}{}", if paren && !in_paren { "(" } else { "" }, body));
            in_paren = paren;
        }
        if in_paren {
            parts.last_mut().unwrap().push(')');
        }
        Some(parts.join(" ") + &song.time_note.as_ref().map_or(String::new(), |n| format!(" {n}")))
    }

    fn voice_attrs(&self, part: &Part, multi: bool) -> String {
        let base = if !multi {
            String::new()
        } else {
            let q = |s: &str| s.replace('"', "'");
            let mut a: Vec<String> = vec![];
            if let Some(n) = part.name.as_deref().filter(|n| !n.is_empty()) {
                a.push(format!("name=\"{}\"", q(n)));
            }
            if let Some(n) = part.abbrev.as_deref().filter(|n| !n.is_empty()) {
                a.push(format!("subname=\"{}\"", q(n)));
            }
            a.join(" ")
        };
        if self.d == Dialect::Jcx {
            return base;
        }
        let found = staff1(part.measures.first().and_then(|m| m.attrs.as_ref())).cloned();
        let c = match (self.d, found) {
            (Dialect::Abc, Some(f)) if !self.xml_source && f.octave_change.is_some_and(|o| o != 0.0 && !o.is_nan()) => {
                Some(Clef { octave_change: Some(0.0), ..f })
            }
            (_, f) => f,
        };
        let treble = c.as_ref().is_none_or(|c| c.sign == dolce_model::ClefSign::G && c.line.unwrap_or(2.0) == 2.0);
        let name = c
            .as_ref()
            .filter(|c| c.octave_change.is_some_and(|o| o != 0.0 && !o.is_nan()) || !treble)
            .and_then(clef_name)
            .filter(|n| !n.is_empty());
        [base, name.map_or(String::new(), |n| format!("clef={n}"))].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
    }

    fn ties_as_slurs(&self) -> bool {
        self.d == Dialect::J123
    }
    fn rehearsal_marks(&self) -> bool {
        self.d == Dialect::J123
    }
    fn bow_and_tremolo(&self) -> bool {
        self.d != Dialect::Jcx
    }
    fn multi_rests(&self) -> bool {
        self.d == Dialect::J123
    }
    fn inline_clefs(&self) -> bool {
        self.d != Dialect::Jcx
    }
    fn mid_clefs(&self) -> bool {
        self.d == Dialect::Abc
    }
    fn writes_chord_groups(&self) -> bool {
        self.d == Dialect::Abc
    }
    fn tuplet_closes(&self) -> bool {
        self.d == Dialect::J123
    }
    fn lyric_separator(&self) -> &'static str {
        if self.d == Dialect::Abc { " " } else { "" }
    }
    fn lyric_skip(&self) -> &'static str {
        if self.d == Dialect::J123 { "/" } else { "*" }
    }
    fn lyric_slot_rule(&self) -> LyricSlotRule {
        if self.d == Dialect::J123 { LyricSlotRule::J123 } else { LyricSlotRule::Abc }
    }
    fn space_beams(&self) -> bool {
        self.d != Dialect::J123
    }
    fn overlay_text(&self) -> Option<&'static str> {
        if self.d == Dialect::Jcx { None } else { Some("&") }
    }
    fn break_text(&self) -> &'static str {
        if self.d == Dialect::J123 { "$\n" } else { "\n" }
    }
    fn trailing_break(&self) -> bool {
        self.d == Dialect::J123
    }
    fn page_break_line(&self) -> Option<&'static str> {
        if self.d == Dialect::Jcx { None } else { Some("%%newpage") }
    }
    fn wedge_stop_before(&self) -> bool {
        self.d != Dialect::Jcx
    }
    fn annotation_before_chord(&self) -> bool {
        self.d == Dialect::Jcx
    }
    fn lyric_style(&self) -> LyricStyle {
        match self.d {
            Dialect::J123 => LyricStyle::default(),
            Dialect::Abc => LyricStyle { labels: LabelStyle::Tilde, ..LyricStyle::default() },
            Dialect::Jcx => LyricStyle { muse_join: true, labels: LabelStyle::Off, extend: "*" },
        }
    }

    /// 这个元素写出时另拆出几个音（ABC：中途换和弦的长音拆成几段）
    fn extra_slots(&self, el: &Element) -> usize {
        if self.d != Dialect::Abc {
            return 0;
        }
        match el {
            Element::Chord(c) => sustain_segments(c).map_or(1, |s| s.len()).saturating_sub(1),
            _ => 0,
        }
    }

    /// 增时线（123 专有，各自可带弧的起止）
    fn sustains_text(&self, ch: &Chord, mi: Option<&MarkIndex>) -> String {
        if self.d != Dialect::J123 {
            return String::new();
        }
        let mut s = String::new();
        for su in ch.sustains.iter().flatten() {
            s.push_str(&"(".repeat(mi.and_then(|m| m.slur_start.get(&su.id)).copied().unwrap_or(0)));
            match &su.harmony {
                Some(h) => s.push_str(&format!(" {}-", self.chord_symbol_text(&harmony_text(h)))),
                None => s.push('-'),
            }
            s.push_str(&")".repeat(mi.and_then(|m| m.slur_end.get(&su.id)).copied().unwrap_or(0)));
        }
        s
    }

    fn note_tie_text(&self, ch: &Chord, ni: usize, notes: &[usize]) -> &'static str {
        match self.d {
            Dialect::J123 | Dialect::Jcx => {
                if notes.len() > 1 && self.note_tie_after.contains(&(ch.id, ni)) { "~" } else { "" }
            }
            Dialect::Abc => {
                let started = |i: usize| ch.notes[i].tie.as_ref().and_then(|t| t.start) == Some(true);
                if notes.len() > 1 && started(ni) && !notes.iter().all(|&i| started(i)) { "-" } else { "" }
            }
        }
    }

    fn tie_text(&self, ch: &Chord) -> &'static str {
        let started = |n: &Note| n.tie.as_ref().and_then(|t| t.start) == Some(true);
        match self.d {
            Dialect::J123 => "",
            Dialect::Abc => {
                let notes = self.chord_notes(ch);
                if !notes.is_empty() && notes.iter().all(|&i| started(&ch.notes[i])) { "-" } else { "" }
            }
            Dialect::Jcx => {
                if ch.notes.iter().any(started) { "-" } else { "" }
            }
        }
    }

    fn rhythm_text(&self, ch: &Chord) -> String {
        match self.d {
            Dialect::J123 => {
                let one = |n: Option<&Note>| -> String {
                    let at = n.and_then(|n| n.unpitched.as_ref()).and_then(|u| u.step.as_ref().map(|s| (s, u.octave)));
                    match at {
                        Some((s, o)) => format!("X@{}{}", s.as_str(), ns(o.unwrap_or(4.0))),
                        None => "X".into(),
                    }
                };
                if ch.notes.len() > 1 {
                    format!("[{}]", ch.notes.iter().map(|n| one(Some(n))).collect::<String>())
                } else {
                    one(ch.notes.first())
                }
            }
            Dialect::Abc => "x".into(),
            Dialect::Jcx => "X".into(),
        }
    }

    /// 这个元素写不写：123 只写简谱印的那条谱表，Muse 只写那一路
    fn emits(&self, el: &Element, mea: &Measure) -> bool {
        let Element::Chord(c) = el else { return true };
        match self.d {
            Dialect::J123 => melody_lane(mea).is_none_or(|(s, _)| c.staff == s),
            Dialect::Abc => true,
            Dialect::Jcx => melody_lane(mea).is_none_or(|(s, v)| c.staff == s && c.voice == v),
        }
    }

    /// 一个和弦写哪几个音（下标）。123 自下而上、画小的音不算
    fn chord_notes(&self, ch: &Chord) -> NoteIdx {
        if self.d != Dialect::J123 {
            return (0..ch.notes.len()).collect();
        }
        let normal: Vec<usize> = (0..ch.notes.len()).filter(|&i| ch.notes[i].type_size.as_deref() != Some("cue")).collect();
        let mut pool = if normal.is_empty() { (0..ch.notes.len()).collect() } else { normal };
        if pool.len() < 2 {
            return top_note(ch).into_iter().collect();
        }
        js::sort_by(&mut pool, |a, b| note_height(&ch.notes[*a]) - note_height(&ch.notes[*b]));
        pool
    }

    fn chord_group_text(&self, inner: String, count: usize) -> String {
        if count > 1 { format!("[{inner}]") } else { inner }
    }

    fn tuplet_text(&self, actual: f64, normal: f64) -> String {
        match self.d {
            Dialect::J123 => {
                if normal == tuplet_normal_123(actual) {
                    format!("({}:", ns(actual))
                } else {
                    format!("({}:{}:", ns(actual), ns(normal))
                }
            }
            _ => {
                if abc_fixed_tuplet(actual) == Some(normal) {
                    format!("({}", ns(actual))
                } else {
                    format!("({}:{}:{}", ns(actual), ns(normal), ns(actual))
                }
            }
        }
    }

    /// 临时声部起点晚于小节起点时，占住前面那段时间的不可见休止
    fn overlay_pad(&self, divisions: f64) -> String {
        match self.d {
            Dialect::J123 => {
                let mut out: Vec<String> = vec![];
                let mut q = divisions / SIMPLE_DIVISIONS;
                while q >= 1.0 - 1e-9 {
                    out.push("x".into());
                    q -= 1.0;
                }
                let mut k = 1;
                while k <= 6 && q > 1e-9 {
                    let len = 2f64.powi(-k);
                    if q >= len - 1e-9 {
                        out.push(format!("x{}", "_".repeat(k as usize)));
                        q -= len;
                    }
                    k += 1;
                }
                out.join(" ")
            }
            Dialect::Abc => {
                if divisions > 0.0 { format!("x{}", length_suffix(divisions)) } else { String::new() }
            }
            Dialect::Jcx => String::new(),
        }
    }

    fn chord_symbol_text(&self, text: &str) -> String {
        if self.d == Dialect::J123 {
            return if is_bare_chord(&enc(text)) { format!("{text} ") } else { format!("\"{text}\"") };
        }
        format!("\"{}\"", chord_suffix_form(text))
    }

    fn wedge_text(&self, t: &WedgeType, start: bool) -> String {
        if self.d == Dialect::Jcx {
            let c = if *t == WedgeType::Crescendo { "<" } else { ">" };
            return if start { format!("({c}") } else { format!("{c})") };
        }
        format!("!{}{}!", t.as_str(), if start { "(" } else { ")" })
    }

    fn annotation_text(&self, word: &str) -> String {
        let lines = word.split('\n').filter(|l| !l.is_empty());
        if self.d == Dialect::Jcx {
            lines.map(|l| format!("\"{}\"", l.replace('"', "'"))).collect()
        } else {
            lines.map(|l| format!("\"^{l}\"")).collect()
        }
    }

    fn grace_slash_text(&self, ch: &Chord) -> &'static str {
        let g = ch.grace.as_ref();
        match self.d {
            Dialect::J123 => "",
            Dialect::Abc => if g.and_then(|g| g.slash) == Some(true) { "/" } else { "" },
            Dialect::Jcx => if g.and_then(|g| g.after) == Some(true) { "@" } else { "" },
        }
    }

    fn grace_duration_text(&self, ch: &Chord) -> String {
        let t = ch.duration.kind.as_ref().map_or("eighth", |k| k.as_str());
        match self.d {
            Dialect::J123 => "_".repeat(GRACE_TYPES_123.iter().position(|x| *x == t).unwrap_or(0)),
            _ => grace_len(t).to_string(),
        }
    }

    // ────────── 共用组装 ──────────

    /// 一个和弦/占位符 → 音乐体文本（不含前置的和弦符号与装饰）
    fn element_text(&self, el: &Element, mi: Option<&MarkIndex>) -> String {
        if self.d == Dialect::Abc {
            if let Element::Chord(c) = el {
                if let Some(segs) = sustain_segments(c) {
                    let notes = self.chord_notes(c);
                    let body = self.chord_group_text(notes.iter().map(|&i| self.note_text(&c.notes[i])).collect(), notes.len());
                    let s = segs
                        .iter()
                        .enumerate()
                        .map(|(i, g)| {
                            let h = match (&g.0, i > 0) {
                                (Some(h), true) => self.chord_symbol_text(&harmony_text(h)),
                                _ => String::new(),
                            };
                            format!("{h}{body}{}", length_suffix(g.1))
                        })
                        .collect::<Vec<_>>()
                        .join("-");
                    return s + self.tie_text(c);
                }
            }
        }
        let ch = match el {
            Element::Space(sp) => {
                let mut s = sp.spacer.as_str().to_string();
                if sp.spacer == Spacer::X && sp.duration.is_some() {
                    s.push_str(&self.duration_text(el));
                }
                return s;
            }
            Element::Chord(c) => c,
        };
        let mut s = if ch.rhythm == Some(true) {
            self.rhythm_text(ch)
        } else if ch.rest.is_some() {
            self.rest_text(ch).to_string()
        } else {
            let notes = self.chord_notes(ch);
            let inner: String = notes.iter().map(|&i| self.note_text(&ch.notes[i]) + self.note_tie_text(ch, i, &notes)).collect();
            self.chord_group_text(inner, notes.len())
        };
        s.push_str(&self.duration_text(el));
        s.push_str(self.tie_text(ch));
        s.push_str(&self.sustains_text(ch, mi));
        s
    }

    /// 倚音 `{6,}` / `{ab}`
    fn grace_text(&self, ch: &Chord) -> String {
        let dur = self.grace_duration_text(ch);
        let body = if ch.notes.len() > 1 && self.writes_chord_groups() {
            self.chord_group_text(ch.notes.iter().map(|n| self.note_text(n)).collect(), ch.notes.len()) + &dur
        } else {
            ch.notes.iter().map(|n| self.note_text(n) + &dur).collect()
        };
        format!("{{{}{}}}", self.grace_slash_text(ch), body)
    }

    /// 同一对相邻和弦之间的延音线先归并再当弧写；只连其中几个音的从弧里拿掉、记进 `note_tie_after`
    fn chord_ties(&mut self, part: &Part, marks: Vec<Mark>) -> Vec<Mark> {
        self.note_tie_after.clear();
        let mut chord_of: HashMap<ElementId, &Chord> = HashMap::new();
        for m in &part.measures {
            for el in &m.elements {
                if let Element::Chord(c) = el {
                    chord_of.insert(c.id, c);
                }
            }
        }
        let mut groups: Vec<((ElementId, ElementId), Vec<usize>)> = vec![];
        for (k, m) in marks.iter().enumerate() {
            if m.kind != MarkType::Tied {
                continue;
            }
            let key = (m.start, m.end);
            match groups.iter_mut().find(|g| g.0 == key) {
                Some(g) => g.1.push(k),
                None => groups.push((key, vec![k])),
            }
        }
        let mut drop: HashSet<usize> = HashSet::new();
        for (_, g) in &groups {
            let Some(ch) = chord_of.get(&marks[g[0]].start) else { continue };
            let written = self.chord_notes(ch);
            let mut tied: Vec<usize> = vec![];
            for &k in g {
                let sn = marks[k].start_note.unwrap_or(0.0);
                let Some(i) = js::index(sn).filter(|&i| i < ch.notes.len()) else { continue };
                if written.contains(&i) && !tied.contains(&i) {
                    tied.push(i);
                }
            }
            if written.len() > 1 && !tied.is_empty() && tied.len() < written.len() {
                for i in tied {
                    self.note_tie_after.insert((ch.id, i));
                }
                drop.extend(g.iter().copied());
            } else {
                drop.extend(g.iter().skip(1).copied());
            }
        }
        if drop.is_empty() {
            return marks;
        }
        marks.into_iter().enumerate().filter(|(k, _)| !drop.contains(k)).map(|(_, m)| m).collect()
    }

    /// 第 `i` 小节头上换成的谱号名（第一行谱表）；小节中间的换谱号过了半小节的算下一小节的
    fn clef_at(&self, part: &Part, i: usize) -> Option<String> {
        let m = part.measures.get(i);
        if self.mid_clefs() {
            return staff1(m.and_then(|m| m.attrs.as_ref())).and_then(clef_name);
        }
        let mid = |m: Option<&Measure>, late: bool| -> Option<Clef> {
            let m = m?;
            let hits: Vec<&dolce_model::LaterAttrs> = m
                .later_attrs
                .iter()
                .flatten()
                .filter(|la| (la.after_elements * 2.0 >= m.elements.len() as f64) == late && staff1(Some(&la.attrs)).is_some())
                .collect();
            hits.last().and_then(|la| staff1(Some(&la.attrs))).cloned()
        };
        let c = mid(m, false)
            .or_else(|| staff1(m.and_then(|m| m.attrs.as_ref())).cloned())
            .or_else(|| if i > 0 { mid(part.measures.get(i - 1), true) } else { None });
        c.as_ref().and_then(clef_name)
    }

    /// 第 `i` 小节起的多小节休止能写成 `Zn` 就返回 n，否则 0
    fn multi_rest_run(&self, part: &Part, i: usize, to: usize) -> usize {
        if !self.multi_rests() {
            return 0;
        }
        let Some(head) = part.measures.get(i) else { return 0 };
        let lone = head.elements.iter().any(|el| el.as_chord().is_some_and(|c| c.rest.as_ref().is_some_and(|r| r.measure == Some(true))))
            && head.elements.iter().all(|el| {
                el.as_chord().is_some_and(|c| c.rest.is_some() && c.print_object != Some(false) && c.voice == head.elements[0].voice())
            });
        let multi = head.attrs.as_ref().and_then(|a| a.multi_rest).unwrap_or(0.0);
        let n = if multi >= 2.0 {
            multi as usize
        } else if lone {
            1
        } else {
            0
        };
        if n == 0 || (i + n - 1) as u128 > to as u128 || i + n - 1 >= part.measures.len() {
            return 0;
        }
        for j in i..i + n {
            let m = &part.measures[j];
            let plain_notations = |c: &Chord| -> bool {
                match &c.notations {
                    None => true,
                    Some(nt) => {
                        j == i
                            && dolce_model::Notations { articulations: None, ..nt.clone() } == dolce_model::Notations::default()
                    }
                }
            };
            let clean = !m.elements.is_empty()
                && m.elements.iter().all(|el| {
                    let Element::Chord(c) = el else { return false };
                    c.rest.is_some()
                        && c.grace.is_none()
                        && plain_notations(c)
                        && c.ornaments.as_ref().is_none_or(|o| o.is_empty())
                        && (j == i
                            || (c.section_word.as_deref().is_none_or(|w| w.is_empty()) && !self.sections_before.contains_key(&c.id)))
                        && c.harmony.is_none()
                        && c.lyrics.as_ref().is_none_or(|l| l.is_empty())
                });
            if !clean || m.directions.as_ref().is_some_and(|d| !d.is_empty()) || m.later_attrs.as_ref().is_some_and(|d| !d.is_empty()) {
                return 0;
            }
            if j > i && (m.attrs.is_some() || m.barlines.iter().flatten().any(|b| b.location == BarLocation::Left)) {
                return 0;
            }
            if j < i + n - 1
                && (break_after(part, j).is_some()
                    || m.barlines.iter().flatten().any(|b| {
                        b.location == BarLocation::Right
                            && (b.style != Some(BarStyle::Regular)
                                || b.repeat.is_some()
                                || b.ending.is_some()
                                || b.ornaments.as_ref().is_some_and(|o| !o.is_empty()))
                    }))
            {
                return 0;
            }
        }
        n
    }

    /// `Zn` 连同头一个小节休止上挂的段落标记、记号与文字
    fn multi_rest_text(&self, mea: &Measure, n: usize) -> String {
        let mut s = String::new();
        for el in &mea.elements {
            let Element::Chord(c) = el else { continue };
            for name in self.sections_before.get(&c.id).into_iter().flatten() {
                s.push_str(&format!("[P:{name}]"));
            }
            if let Some(w) = c.section_word.as_deref().filter(|w| !w.is_empty()) {
                s.push_str(&self.annotation_text(w));
            }
            for a in c.notations.as_ref().and_then(|n| n.articulations.as_ref()).into_iter().flatten() {
                if self.rehearsal_marks() || rehearsal_of(a).is_none() {
                    s.push_str(&format!("!{a}!"));
                }
            }
        }
        format!("{s}Z{}", if n > 1 { n.to_string() } else { String::new() })
    }

    /// 这一小节中间第一行谱表换谱号的时刻与谱号名，按时刻排
    fn mid_clef_changes(&self, mea: &Measure) -> Vec<(f64, String)> {
        let later: Vec<&dolce_model::LaterAttrs> = mea
            .later_attrs
            .iter()
            .flatten()
            .filter(|la| la.attrs.clefs.iter().flatten().any(|c| c.staff.unwrap_or(1.0) == 1.0))
            .collect();
        if later.is_empty() {
            return vec![];
        }
        let mut ends: Vec<f64> = vec![];
        let mut end = 0.0;
        for el in &mea.elements {
            end = el.onset().unwrap_or(end) + real_len(el);
            ends.push(end);
        }
        let mut out: Vec<(f64, String)> = vec![];
        for la in later {
            let Some(name) = staff1(Some(&la.attrs)).and_then(clef_name).filter(|n| !n.is_empty()) else { continue };
            let t = la.onset.unwrap_or_else(|| {
                if la.after_elements > 0.0 {
                    let k = js::min(la.after_elements, ends.len() as f64) - 1.0;
                    js::index(k).and_then(|k| ends.get(k)).copied().unwrap_or(f64::NAN)
                } else {
                    0.0
                }
            });
            out.push((t, name));
        }
        js::sort_by(&mut out, |a, b| a.0 - b.0);
        out
    }

    /// 源里没有空白分组时**按拍自动分组**（与简谱减时线同一份拍位判据）
    fn auto_beam_groups(&self, mea: &Measure, mi: &MarkIndex) -> HashMap<ElementId, f64> {
        let mut out = HashMap::new();
        let size = beat_group_size(self.cur_time.0, self.cur_time.1);
        let mut pos: HashMap<js::NumKey, f64> = HashMap::new();
        // (ratio, group, left)
        let mut tuplet: Option<(f64, f64, f64)> = None;
        for el in &mea.elements {
            let voice = js::NumKey::new(if el.voice() > 1.0 { el.voice() } else { 1.0 });
            let at = pos.get(&voice).copied().unwrap_or(0.0);
            let Element::Chord(c) = el else {
                if let Some(d) = el.duration() {
                    pos.insert(voice, at + d.divisions / SIMPLE_DIVISIONS);
                }
                continue;
            };
            if c.grace.is_some() {
                continue;
            }
            let tp = mi.tuplet_start.get(&c.id).and_then(|t| t.ratios.first());
            if let (Some(&(actual, normal)), None) = (tp, tuplet) {
                tuplet = Some((normal / actual, beat_group_index(at, 0.0, size), actual));
            }
            let tm = c.duration.time_mod.as_ref();
            let ratio = match tm {
                Some(t) => t.normal / t.actual,
                None => tuplet.map_or(1.0, |t| t.0),
            };
            let q = (c.duration.divisions / SIMPLE_DIVISIONS) * ratio;
            let g = match tuplet {
                Some(t) => t.1,
                None => beat_group_index(at, 0.0, size),
            };
            if c.rest.is_none() && c.beams.as_ref().is_some_and(|b| !b.is_empty()) && q <= size + 1e-9 {
                out.insert(c.id, voice.get() * 1000.0 + g);
            }
            pos.insert(voice, at + q);
            if let Some(t) = tuplet.as_mut() {
                t.2 -= 1.0;
                if t.2 <= 0.0 || mi.tuplet_end.contains_key(&c.id) {
                    tuplet = None;
                }
            }
        }
        out
    }

    /// 小节里元素的写出顺序（下标）。多声部按声部首次出现的先后归并；切片时不重排
    fn voice_order(&self, mea: &Measure, from: usize, to: usize) -> Vec<usize> {
        let all: Vec<usize> = (0..mea.elements.len()).filter(|&j| j >= from && j < to).collect();
        if self.overlay_text().is_none() || from > 0 || to < mea.elements.len() {
            return all;
        }
        let mut groups: Vec<(f64, Vec<usize>)> = vec![];
        for j in all.iter().copied() {
            let v = mea.elements[j].voice();
            let v = if v > 1.0 { v } else { 1.0 };
            match groups.iter_mut().find(|g| g.0 == v) {
                Some(g) => g.1.push(j),
                None => groups.push((v, vec![j])),
            }
        }
        if groups.len() < 2 {
            return all;
        }
        groups.into_iter().flat_map(|g| g.1).collect()
    }

    /// 一个声部的音乐体，按 `ranges` 切成几行。`inline_cuts`：照 `ranges` 在小节中间切
    fn part_systems(&mut self, part: &Part, song: &Song, ranges: &[SystemRange], inline_cuts: bool) -> Vec<String> {
        let mut out: Vec<String> = vec![];
        let mut texts: Vec<String> = vec![];
        let mut ri = 0usize;
        let own = own_ids(part, |el, mi| self.emits(el, &part.measures[mi]));
        let mut mi_idx = MarkIndex::default();
        let mut tuplet_end_order: HashMap<ElementId, usize> = HashMap::new();
        for mea in &part.measures {
            for el in &mea.elements {
                let sz = tuplet_end_order.len();
                tuplet_end_order.insert(el.id(), sz);
            }
        }
        let mut nested: Vec<Mark> = own_marks(song, &own).into_iter().filter(|m| m.kind == MarkType::Tuplet).collect();
        js::sort_by(&mut nested, |a, b| {
            tuplet_end_order.get(&b.end).copied().unwrap_or(0) as f64 - tuplet_end_order.get(&a.end).copied().unwrap_or(0) as f64
        });
        let ties_as_slurs = self.ties_as_slurs();
        let is_arc = move |m: &Mark| m.kind == MarkType::Slur || (m.kind == MarkType::Tied && ties_as_slurs);
        let mut marks = own_marks(song, &own);
        if ties_as_slurs {
            marks = self.chord_ties(part, marks);
        }
        if self.tuplet_closes() {
            let to_next = arcs_to_next_note(part, &marks, is_arc, Some(&own));
            for &k in &to_next {
                mi_idx.arc_next.insert(marks[k].start);
            }
            if !to_next.is_empty() {
                marks = marks.into_iter().enumerate().filter(|(k, _)| !to_next.contains(k)).map(|(_, m)| m).collect();
            }
        }
        let nest = if self.tuplet_closes() { Some(nest_arcs_in_tuplets(part, &marks, is_arc)) } else { None };
        let marks = match &nest {
            Some(n) => n.marks.clone(),
            None => marks,
        };
        for m in &marks {
            if is_arc(m) {
                *mi_idx.slur_start.entry(m.start).or_insert(0) += 1;
                *mi_idx.slur_end.entry(m.end).or_insert(0) += 1;
            } else if m.kind == MarkType::Tuplet && self.tuplet_closes() {
                match mi_idx.tuplet_end.get_mut(&m.end) {
                    Some(te) => te.count += 1,
                    None => {
                        let outer = nest.as_ref().and_then(|n| n.outer_close.get(&m.end)).copied().unwrap_or(0);
                        mi_idx.tuplet_end.insert(m.end, TupletEnd { count: 1, outer_arcs: outer });
                    }
                }
            }
        }
        for m in &marks {
            if m.kind != MarkType::Wedge {
                continue;
            }
            let Some(w) = &m.wedge_type else { continue };
            mi_idx.wedge_start.entry(m.start).or_default().push(w.clone());
            mi_idx.wedge_end.entry(m.end).or_default().push(w.clone());
        }
        for m in &nested {
            let ts = mi_idx.tuplet_start.entry(m.start).or_insert_with(|| TupletStart {
                ratios: vec![],
                outer_arcs: nest.as_ref().and_then(|n| n.outer_open.get(&m.start)).copied().unwrap_or(0),
            });
            ts.ratios.push((m.tuplet_actual.unwrap_or(3.0), m.tuplet_normal.unwrap_or(2.0)));
        }

        let mut key = song.key.as_ref().map_or(String::new(), |k| self.key_value(k));
        let time_of = |t: Option<&Time>| t.map_or(String::new(), time_text);
        let mut time = time_of(song.time.as_ref());
        let mut clef = "treble".to_string();
        self.cur_time = song.time.as_ref().map_or((4.0, 4.0), |t| (t.beats, t.beat_type));
        let flush = |out: &mut Vec<String>, texts: &mut Vec<String>| {
            let joined = out.iter().filter(|x| !x.is_empty()).cloned().collect::<Vec<_>>().join(" ");
            texts.push(flush_text(&joined));
            out.clear();
        };
        let nm = part.measures.len();
        let mut i = 0usize;
        while i < nm {
            while ri + 1 < ranges.len() && i > ranges[ri].to {
                flush(&mut out, &mut texts);
                ri += 1;
            }
            let mea = &part.measures[i];
            let mut cuts: Vec<usize> = vec![];
            if inline_cuts {
                let mut r = ri;
                while r + 1 < ranges.len() && ranges[r].to == i {
                    if ranges[r].inline.is_some() {
                        cuts.push(ranges[r].to_el);
                    }
                    r += 1;
                }
            }
            let lefts: Vec<&Barline> = mea.barlines.iter().flatten().filter(|b| b.location == BarLocation::Left).collect();
            let last_ending = lefts.iter().rposition(|b| b.ending.as_ref().is_some_and(|e| e.kind == EndingType::Start));
            for (li, left) in lefts.iter().enumerate() {
                if left.style.is_some() || left.repeat.is_some() {
                    // 反复起的左线（MusicXML 形状里带 `heavy-light`）并进前一小节的右线写：`| |:` → `|:`
                    if left.repeat == Some(RepeatDir::Forward)
                        && matches!(left.style, None | Some(BarStyle::HeavyLight))
                        && out.last().is_some_and(|x| x == "|")
                    {
                        out.pop();
                    }
                    out.push(barline_text(left).into());
                }
                out.extend(barline_ornaments(left));
                if Some(li) == last_ending {
                    let nums = left.ending.as_ref().unwrap().numbers.iter().map(|n| ns(*n)).collect::<Vec<_>>().join(",");
                    out.push(format!("[{nums}"));
                }
            }
            let attrs = mea.attrs.as_ref();
            let k = match attrs.and_then(|a| a.key.as_ref()) {
                Some(kk) => self.key_value(kk),
                None => key.clone(),
            };
            if k != key {
                out.push(format!("[K:{k}]"));
            }
            key = k;
            let t = match attrs.and_then(|a| a.time.as_ref()) {
                Some(tt) => time_of(Some(tt)),
                None => time.clone(),
            };
            if t != time {
                out.push(format!("[M:{t}]"));
            }
            let cn = self.clef_at(part, i).filter(|c| !c.is_empty());
            if let Some(c) = &cn {
                if self.inline_clefs() && i > 0 && *c != clef {
                    out.push(format!("[K:clef={c}]"));
                }
                clef = c.clone();
            }
            self.last_mid_clef = None;
            time = t;
            if let Some(tt) = attrs.and_then(|a| a.time.as_ref()) {
                self.cur_time = (tt.beats, tt.beat_type);
            }
            let mut el0 = 0usize;
            for &at in &cuts {
                let b = self.measure_body(mea, &mi_idx, el0, at);
                out.push(b);
                out.push(self.break_text().into());
                flush(&mut out, &mut texts);
                ri += 1;
                el0 = at;
            }
            let run = if !cuts.is_empty() { 0 } else { self.multi_rest_run(part, i, ranges[ri].to) };
            let body = if run > 0 { self.multi_rest_text(mea, run) } else { self.measure_body(mea, &mi_idx, el0, usize::MAX) };
            let body_empty = body.is_empty();
            out.push(body);
            if run > 0 {
                i += run - 1;
            }
            if let Some(c) = &self.last_mid_clef {
                clef = c.clone();
            }
            let right = part.measures[i].barlines.iter().flatten().find(|b| b.location == BarLocation::Right);
            let last = i == nm - 1;
            if let Some(r) = right {
                out.extend(barline_ornaments(r));
            }
            let bare = i > 0
                && body_empty
                && lefts.is_empty()
                && mea.attrs.is_none()
                && right.is_none_or(|r| {
                    matches!(r.style, Some(BarStyle::Regular) | Some(BarStyle::NoStyle))
                        && r.repeat.is_none()
                        && r.ending.is_none()
                        && r.ornaments.as_ref().is_none_or(|o| o.is_empty())
                });
            if !bare {
                out.push(right.map_or("|", barline_text).into());
            }
            let brk = if !cuts.is_empty() { None } else { break_after(part, i) };
            if brk.is_some() && (!last || self.trailing_break()) {
                out.push(self.break_text().into());
            }
            i += 1;
        }
        flush(&mut out, &mut texts);
        while texts.len() < ranges.len() {
            texts.push(String::new());
        }
        texts
    }

    /// 一小节的音乐体；`from` / `to`：只写这一段元素（小节中间换行时一小节分两段写）
    #[allow(unused_assignments)]
    fn measure_body(&mut self, mea: &Measure, mi: &MarkIndex, from: usize, to: usize) -> String {
        let n_el = mea.elements.len();
        let mut pieces: Vec<String> = vec![];
        let mut prev_group: Option<f64> = None;
        let mut prev_grace: Option<String> = None;
        let mid: Vec<&Barline> = mea.barlines.iter().flatten().filter(|b| b.location == BarLocation::Middle).collect();
        let mut mid_idx = 0usize;
        let order = self.voice_order(mea, from, to);
        let auto = if self.space_beams() && !mea.elements.iter().any(|e| e.as_chord().is_some_and(|c| c.beam_group.is_some())) {
            Some(xml_beam_groups(mea).unwrap_or_else(|| self.auto_beam_groups(mea, mi)))
        } else {
            None
        };
        let mut prev_voice: Option<f64> = None;
        let mut branch_len: HashMap<js::NumKey, f64> = HashMap::new();
        let mut main_voice: Option<f64> = None;
        let whole = from == 0 && to >= n_el;
        let clefs = if self.mid_clefs() { self.mid_clef_changes(mea) } else { vec![] };
        let mut clef_idx = 0usize;
        let mut main_at: HashMap<usize, f64> = HashMap::new();
        if !clefs.is_empty() {
            let mut end = 0.0;
            for (j, el) in mea.elements.iter().enumerate() {
                let s = el.onset().unwrap_or(end);
                main_at.insert(j, s);
                end = s + real_len(el);
            }
        }
        let overlay = self.overlay_text();
        let nk = js::NumKey::new;

        macro_rules! push_clefs {
            ($until:expr) => {{
                let until: f64 = $until;
                while clef_idx < clefs.len() && clefs[clef_idx].0 <= until + 1e-6 {
                    pieces.push(format!("[K:clef={}]", clefs[clef_idx].1));
                    self.last_mid_clef = Some(clefs[clef_idx].1.clone());
                    prev_group = None;
                    clef_idx += 1;
                }
            }};
        }
        macro_rules! pad_branch {
            ($v:expr) => {{
                if let Some(v) = $v {
                    if !(from > 0 || to < n_el) {
                        let main_len = if Some(v) == main_voice { 0.0 } else { branch_len.get(&nk(main_voice.unwrap())).copied().unwrap_or(0.0) };
                        let target = js::max(main_len, mea.duration.unwrap_or(0.0));
                        let lack = target - branch_len.get(&nk(v)).copied().unwrap_or(0.0);
                        let pad = if lack > 1e-6 { self.overlay_pad(lack) } else { String::new() };
                        if !pad.is_empty() {
                            pieces.push(pad);
                            branch_len.insert(nk(v), target);
                        }
                    }
                }
            }};
        }

        for j in order {
            let el = &mea.elements[j];
            if !self.emits(el, mea) {
                continue;
            }
            let ch = el.as_chord();
            if ch.is_some_and(|c| c.continued == Some(true)) {
                continue;
            }
            let voice = if el.voice() > 1.0 { el.voice() } else { 1.0 };
            if main_voice.is_none() {
                main_voice = Some(voice);
            }
            if let (Some(ov), Some(pv)) = (overlay, prev_voice) {
                if voice != pv {
                    pad_branch!(prev_voice);
                    if Some(pv) == main_voice && to >= n_el {
                        push_clefs!(f64::INFINITY);
                    }
                    pieces.push(ov.into());
                    prev_group = None;
                }
            }
            if !clefs.is_empty() && Some(voice) == main_voice {
                push_clefs!(main_at[&j]);
            }
            let at = branch_len.get(&nk(voice)).copied().unwrap_or(0.0);
            if let Some(on) = el.onset() {
                if on > at + 1e-6 && whole {
                    let pad = self.overlay_pad(on - at);
                    if !pad.is_empty() {
                        pieces.push(pad);
                        prev_group = None;
                        branch_len.insert(nk(voice), on);
                    }
                }
            }
            if !ch.is_some_and(|c| c.grace.is_some()) {
                if let Some(d) = el.duration() {
                    let ratio = d.time_mod.as_ref().map_or(1.0, |t| t.normal / t.actual);
                    let cur = branch_len.get(&nk(voice)).copied().unwrap_or(0.0);
                    branch_len.insert(nk(voice), cur + d.divisions * ratio);
                }
            }
            prev_voice = Some(voice);
            if let Some(c) = ch.filter(|c| c.grace.is_some()) {
                let prev = if j > 0 { mea.elements.get(j - 1) } else { None };
                let opens = mi.slur_start.get(&c.id).copied().unwrap_or(0);
                let closes = mi.slur_end.get(&c.id).copied().unwrap_or(0);
                let g = "(".repeat(opens) + &self.grace_text(c) + &")".repeat(closes);
                let pg = prev.and_then(|p| p.as_chord()).filter(|p| p.grace.is_some());
                let can_merge = opens == 0
                    && prev_grace.as_ref().is_some_and(|pgt| pieces.last() == Some(pgt) && !pgt.ends_with(')'))
                    && pg.is_some_and(|p| {
                        let (a, b) = (p.grace.as_ref().unwrap(), c.grace.as_ref().unwrap());
                        (a.slash == Some(true)) == (b.slash == Some(true)) && (a.after == Some(true)) == (b.after == Some(true))
                    });
                if can_merge {
                    let pgt = prev_grace.as_ref().unwrap();
                    let merged = format!("{}{}", &pgt[..pgt.len() - 1], &g[1 + self.grace_slash_text(c).len()..]);
                    *pieces.last_mut().unwrap() = merged.clone();
                    prev_grace = Some(merged);
                } else {
                    pieces.push(g.clone());
                    prev_grace = Some(g);
                }
                prev_group = None;
                continue;
            }
            prev_grace = None;
            let mut s = String::new();
            for name in self.sections_before.get(&el.id()).into_iter().flatten() {
                s.push_str(&format!("[P:{name}]"));
            }
            let chord_text = el.harmony().map_or(String::new(), harmony_text);
            let word: Option<&str> = ch.and_then(|c| {
                c.section_word.as_deref().or_else(|| c.sustains.iter().flatten().find_map(|su| su.section_word.as_deref()))
            });
            let word = word.filter(|w| !w.is_empty());
            if let Some(w) = word.filter(|_| self.annotation_before_chord()) {
                s.push_str(&self.annotation_text(w));
            }
            if !chord_text.is_empty() {
                s.push_str(&self.chord_symbol_text(&chord_text));
            }
            if let Some(w) = word.filter(|_| !self.annotation_before_chord()) {
                s.push_str(&self.annotation_text(w));
            }
            let nt = match el {
                Element::Chord(c) => c.notations.as_ref(),
                Element::Space(sp) => sp.notations.as_ref(),
            };
            if nt.and_then(|n| n.fermata) == Some(true) {
                s.push_str("!fermata!");
            }
            for a in nt.and_then(|n| n.articulations.as_ref()).into_iter().flatten() {
                if self.rehearsal_marks() || rehearsal_of(a).is_none() {
                    s.push_str(&format!("!{a}!"));
                }
            }
            for o in nt.and_then(|n| n.ornaments.as_ref()).into_iter().flatten() {
                s.push_str(&format!("!{}!", ornament_name(o)));
            }
            if self.bow_and_tremolo() {
                for tk in nt.and_then(|n| n.technical.as_ref()).into_iter().flatten() {
                    s.push_str(&format!("!{}!", technical_name(tk)));
                }
                if let Some(tr) = nt.and_then(|n| n.tremolo).filter(|t| *t != 0.0 && !t.is_nan()) {
                    s.push_str(&format!("!{}!", "/".repeat(repeat_count(tr))));
                }
                if nt.and_then(|n| n.arpeggiate) == Some(true) {
                    s.push_str("!arpeggio!");
                }
                if let Some(c) = ch {
                    if let Some(head) = chord_notehead(c.notes.iter().map(|n| n.notehead.as_deref())) {
                        s.push_str(&format!("!head-{head}!"));
                    }
                }
            }
            let id = el.id();
            let tp = mi.tuplet_start.get(&id);
            let opens = mi.slur_start.get(&id).copied().unwrap_or(0);
            if self.wedge_stop_before() {
                for w in mi.wedge_end.get(&id).into_iter().flatten() {
                    s.push_str(&self.wedge_text(w, false));
                }
            }
            for w in mi.wedge_start.get(&id).into_iter().flatten() {
                s.push_str(&self.wedge_text(w, true));
            }
            let outer = tp.map_or(0, |t| t.outer_arcs);
            s.push_str(&"(".repeat(outer));
            if let Some(tp) = tp {
                let ratios: &[(f64, f64)] = if self.tuplet_closes() { &tp.ratios } else { &tp.ratios[..tp.ratios.len().min(1)] };
                for &(a, n) in ratios {
                    s.push_str(&self.tuplet_text(a, n));
                }
            }
            s.push_str(&"(".repeat(opens.saturating_sub(outer)));
            s.push_str(&self.element_text(el, Some(mi)));
            if mi.arc_next.contains(&id) {
                s.push('~');
            }
            let te = mi.tuplet_end.get(&id);
            let closes = mi.slur_end.get(&id).copied().unwrap_or(0);
            s.push_str(&")".repeat(closes.saturating_sub(te.map_or(0, |t| t.outer_arcs))));
            if let Some(te) = te {
                s.push_str(&")".repeat(te.count + te.outer_arcs));
            }
            if !self.wedge_stop_before() {
                for w in mi.wedge_end.get(&id).into_iter().flatten() {
                    s.push_str(&self.wedge_text(w, false));
                }
            }
            while mid_idx < mid.len() && mid[mid_idx].after_elements.is_some_and(|a| a <= pieces.len() as f64) {
                pieces.push(barline_text(mid[mid_idx]).into());
                mid_idx += 1;
                prev_group = None;
            }
            let group = ch.and_then(|c| c.beam_group.or_else(|| auto.as_ref().and_then(|a| a.get(&c.id).copied())));
            let same_group = self.space_beams() && group.is_some() && group == prev_group;
            if !pieces.is_empty() && same_group {
                pieces.last_mut().unwrap().push_str(&s);
            } else {
                pieces.push(s);
            }
            prev_group = group;
        }
        if overlay.is_some() {
            pad_branch!(prev_voice);
        }
        if !clefs.is_empty() && prev_voice.is_some() && prev_voice == main_voice && to >= n_el {
            push_clefs!(f64::INFINITY);
        }
        if to >= n_el {
            while mid_idx < mid.len() {
                pieces.push(barline_text(mid[mid_idx]).into());
                mid_idx += 1;
            }
        }
        pieces.join(" ")
    }

    /// 一首歌 → 文本（基类那一份；方言的预处理在 `emit_song` 里）
    fn emit_song_base(&mut self, song: &Song, fallback_number: Option<usize>) -> String {
        let mut l: Vec<String> = vec![];
        match song.work.number.as_deref().filter(|n| !n.is_empty()) {
            Some(n) => l.push(format!("X:{n}")),
            None => {
                if let Some(f) = fallback_number {
                    l.push(format!("X:{f}"));
                }
            }
        }
        if let Some(t) = &song.work.title {
            push_lines(&mut l, "T", t);
        }
        for st in &song.work.subtitles {
            push_lines(&mut l, "T", st);
        }
        for c in song.identification.iter().flat_map(|i| i.creators.iter()) {
            push_lines(&mut l, "C", &c.text);
        }
        if let Some(so) = &song.section_order {
            l.push(format!("P:{}", so.text));
        }
        self.sections_before = HashMap::new();
        for m in song.section_marks.iter().flatten() {
            self.sections_before.entry(m.before).or_default().push(m.name.clone());
        }
        if let Some(k) = song.key.as_ref().map(|k| self.key_value(k)).filter(|k| !k.is_empty()) {
            l.push(format!("K:{k}"));
        }
        if let Some(mt) = self.time_value(song).filter(|m| !m.is_empty()) {
            l.push(format!("M:{mt}"));
        }
        if self.d == Dialect::Abc {
            l.push("L:1/8".into());
        }
        for t in song.tempos.iter().flatten() {
            let beat = song.tempo_beat.as_ref().map_or("1/4".to_string(), |b| format!("{}/{}", ns(b.num), ns(b.den)));
            l.push(match t {
                Tempo::Bpm(n) => format!("Q:{beat}={}", ns(*n)),
                Tempo::Text(s) => format!("Q:\"{s}\""),
            });
        }
        if let Some(pt) = &song.page_text {
            if let Some(v) = &pt.index_left {
                l.push(format!("I:indexleft {v}"));
            }
            if let Some(v) = &pt.index_right {
                l.push(format!("I:indexright {v}"));
            }
            for (key, arr) in [
                ("topleft", &pt.top_left),
                ("topright", &pt.top_right),
                ("bottomleft", &pt.bottom_left),
                ("bottomcenter", &pt.bottom_center),
                ("bottomright", &pt.bottom_right),
            ] {
                for t in arr {
                    for line in split_lines(t) {
                        if !js::trim(line).is_empty() {
                            l.push(format!("I:{key} {}", js::trim(line)));
                        }
                    }
                }
            }
        }
        for (key, vals) in song.meta.iter().flatten() {
            for v in vals {
                for line in split_lines(v) {
                    let s = format!("I:meta {key} {line}");
                    l.push(s.trim_end_matches(js::is_space).to_string());
                }
            }
        }
        if let Some(r) = song.style.as_ref().and_then(|s| s.sheet_ref.as_ref()) {
            l.push(format!("I:style {r}"));
        }
        let raw = song.style.as_ref().and_then(|s| s.raw.as_ref());
        for r in raw.into_iter().flatten() {
            l.push(format!("I:{} {}", r.key.to_lowercase(), split_lines(&r.value).join(" ")));
        }
        if !raw.is_some_and(|raw| raw.iter().any(|r| r.key.to_lowercase() == "score")) {
            if let Some(sc) = score_directive(song) {
                l.push(format!("I:score {sc}"));
            }
        }
        for r in song.remarks.iter().flatten() {
            if r.starts_with("P:") {
                l.push(r.clone());
            } else {
                push_lines(&mut l, "N", r);
            }
        }
        let mut texts: Vec<(f64, String)> = vec![];
        for part in &song.parts {
            for mea in &part.measures {
                if let Some(p) = &mea.print {
                    for t in p.texts.iter().flatten() {
                        texts.push((p.system.unwrap_or(0.0), js::trim(t).to_string()));
                    }
                }
            }
        }
        js::sort_by(&mut texts, |a, b| a.0 - b.0);
        for (_, t) in &texts {
            if !t.is_empty() {
                push_lines(&mut l, "N", t);
            }
        }
        let body = self.body_lines(song);
        l.extend(body);
        if self.d == Dialect::J123 {
            l.extend(sing_lines(song));
        }
        l.join("\n")
    }

    /// 声部切换行（缺省 ABC 的 `V:n`，属性只在首次出现时写）
    fn voice_line(&self, song: &Song, i: usize, first: bool) -> Option<String> {
        let part = &song.parts[i];
        let host = if first {
            part.staff_of.as_deref().and_then(|so| song.parts.iter().position(|p| p.id == so))
        } else {
            None
        };
        let attrs = if first {
            [self.voice_attrs(part, song.parts.len() > 1), host.map_or(String::new(), |h| format!("part={}", h + 1))]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            String::new()
        };
        if song.parts.len() > 1 || !attrs.is_empty() {
            Some(format!("V:{}{}", i + 1, if attrs.is_empty() { String::new() } else { format!(" {attrs}") }))
        } else {
            None
        }
    }

    /// 曲体：一行曲一行词，按第一个声部的换行切系统，每个系统依次写各声部的音乐行与它的 `w` 行
    fn body_lines(&mut self, song: &Song) -> Vec<String> {
        if self.d == Dialect::Jcx {
            return self.body_lines_jcx(song);
        }
        let mut l: Vec<String> = vec![];
        let ranges = system_ranges(song.parts.first());
        let pranges: Vec<Vec<SystemRange>> =
            song.parts.iter().enumerate().map(|(pi, part)| part_ranges(&ranges, &song.parts[0], part, pi == 0)).collect();
        let bodies: Vec<Vec<String>> =
            song.parts.iter().enumerate().map(|(pi, part)| self.part_systems(part, song, &pranges[pi], true)).collect();
        let mut declared: HashSet<usize> = HashSet::new();
        let style = self.lyric_style();
        for r in 0..ranges.len() {
            if r > 0 {
                let prev = &ranges[r - 1];
                if let Some(pbl) = self.page_break_line() {
                    let kind = prev.inline.clone().or_else(|| break_after(&song.parts[0], prev.to));
                    if kind == Some(BreakKind::Page) {
                        l.push(pbl.into());
                    }
                }
            }
            for i in 0..song.parts.len() {
                let text = bodies[i].get(r).cloned().unwrap_or_default();
                if text.is_empty() {
                    continue;
                }
                let v = self.voice_line(song, i, !declared.contains(&i));
                declared.insert(i);
                if let Some(v) = v {
                    l.push(v);
                }
                l.push(text);
                let sys = &pranges[i][r];
                let extra = |el: &Element| self.extra_slots(el);
                l.extend(lyric_lines(&song.parts[i], self.lyric_separator(), self.lyric_skip(), sys, self.lyric_slot_rule(), style, &extra));
            }
        }
        if let Some(end) = ranges.last() {
            let cut_in_last = end.from_el > 0 && end.from == song.parts[0].measures.len().wrapping_sub(1);
            if let Some(pbl) = self.page_break_line() {
                if self.trailing_break() && !cut_in_last && break_after(&song.parts[0], end.to) == Some(BreakKind::Page) {
                    l.push(pbl.into());
                }
            }
        }
        l
    }

    /// Muse：正文**按声部分块**写，`[V: n]` 一行，随后这个声部的各行音乐，各跟各的 `w:`
    fn body_lines_jcx(&mut self, song: &Song) -> Vec<String> {
        let mut l: Vec<String> = vec![];
        let style = self.lyric_style();
        for (i, part) in song.parts.iter().enumerate() {
            let ranges = system_ranges(Some(part));
            let texts = self.part_systems(part, song, &ranges, true);
            l.push(format!("[V: {}]", i + 1));
            for (r, sys) in ranges.iter().enumerate() {
                let Some(t) = texts.get(r).filter(|t| !t.is_empty()) else { continue };
                l.push(t.clone());
                l.extend(lyric_lines(part, self.lyric_separator(), self.lyric_skip(), sys, self.lyric_slot_rule(), style, &|_| 0));
            }
        }
        l
    }

    // ────────── 方言入口 ──────────

    fn emit_song(&mut self, song: &Song, fallback_number: Option<usize>) -> String {
        match self.d {
            Dialect::J123 => {
                let s = chain(song, &[&fill_absent_groups, &fill_empty_measures, &split_staves]);
                let s = whole_bar_rests(s);
                let s = chain_owned(s, &[&layers_to_voices, &directions_as_marks, &project_for_jianpu]);
                let s = self.with_readback_accidentals(s);
                self.emit_song_base(&s, fallback_number)
            }
            Dialect::Abc => {
                let own = chain_owned(chain(song, &[&fill_absent_groups, &fill_empty_measures, &split_staves]), &[&directions_as_marks]);
                self.xml_source = is_xml_shaped(&own);
                if !self.xml_source {
                    let p = with_abc_pitches(&own);
                    return self.emit_song_base(&p, fallback_number);
                }
                let mut xml = with_abc_accidentals(&with_abc_divisions(&own));
                creators_from_credits(&mut xml);
                header_from_credits(&mut xml);
                self.emit_song_base(&xml, fallback_number)
            }
            Dialect::Jcx => self.emit_song_jcx(song),
        }
    }

    /// 123：带绝对音高的音按 123 读回的次序核对面上的记号，读回会偏的改印
    fn with_readback_accidentals(&self, src: Song) -> Song {
        let any = src.parts.iter().any(|p| {
            p.measures.iter().any(|m| {
                m.elements.iter().any(|el| el.as_chord().is_some_and(|c| c.notes.iter().any(|n| n.pitch.is_some() && n.degree.is_some())))
            })
        });
        if !any {
            return src;
        }
        let mut song = src;
        let song_key = song.key.clone().unwrap_or_else(c_major);
        for pi in 0..song.parts.len() {
            let mut key = song_key.clone();
            let mut carry = AccidentalCarry::default();
            for mi in 0..song.parts[pi].measures.len() {
                let part = &song.parts[pi];
                if let Some(k) = part.measures[mi].attrs.as_ref().and_then(|a| a.key.clone()) {
                    key = k;
                }
                let k = Key { fifths: key_fifths(&key), ..key.clone() };
                if !continues_measure(if mi > 0 { Some(&part.measures[mi - 1]) } else { None }, &part.measures[mi]) {
                    carry = AccidentalCarry::default();
                }
                let order = voice_grouped(&part.measures[mi]);
                for j in order {
                    let m = &song.parts[pi].measures[mi];
                    let el = &m.elements[j];
                    let Element::Chord(c) = el else { continue };
                    if c.rest.is_some() || c.rhythm == Some(true) || !self.emits(el, m) {
                        continue;
                    }
                    let idx = self.chord_notes(c);
                    let Element::Chord(c) = &mut song.parts[pi].measures[mi].elements[j] else { unreachable!() };
                    for ni in idx {
                        let n = &mut c.notes[ni];
                        let (Some(p), Some(d)) = (&n.pitch, &n.degree) else { continue };
                        if d.number <= 0.0 {
                            continue;
                        }
                        if let Some(acc) = carry.repair(d, p, &k) {
                            n.degree = Some(dolce_model::Degree { accidental: Some(acc), ..d.clone() });
                        }
                    }
                }
            }
        }
        song
    }

    fn emit_song_jcx(&mut self, src: &Song) -> String {
        let own = directions_as_marks(src);
        let projected = if is_xml_shaped(&own) { Cow::Owned(project_for_jianpu(&own).into_owned()) } else { own };
        let song = marks_off_sustains(with_degrees(projected.into_owned()));
        let one_line = |s: &str| split_lines(s).into_iter().map(js::trim).filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" ");
        let mut l: Vec<String> = vec![];
        for d in song.muse_directives.iter().flatten() {
            l.push(format!("%%{}", one_line(d)));
        }
        l.push(format!("T:{}", one_line(song.work.title.as_deref().unwrap_or(""))));
        for st in &song.work.subtitles {
            l.push(format!("T:{}", one_line(st)));
        }
        for c in song.identification.iter().flat_map(|i| i.creators.iter()) {
            let t = one_line(&c.text);
            if !t.is_empty() {
                l.push(format!("C:{t}"));
            }
        }
        for t in song.page_text.iter().flat_map(|p| p.top_right.iter()) {
            let t = one_line(t);
            if !t.is_empty() {
                l.push(format!("C:{t}"));
            }
        }
        for s in get_meta(&song, "source") {
            l.push(format!("S:{}", one_line(s)));
        }
        for t in song.page_text.iter().flat_map(|p| p.top_left.iter()) {
            let t = one_line(t);
            if !t.is_empty() {
                l.push(format!("I:{t}"));
            }
        }
        if let Some(t) = &song.time {
            l.push(format!("M:{}/{}", ns(t.beats), ns(t.beat_type)));
        }
        l.push("L:1/8".into());
        for t in song.tempos.iter().flatten() {
            let Tempo::Bpm(n) = t else { continue };
            let beat = song.tempo_beat.as_ref().map_or("1/4".to_string(), |b| format!("{}/{}", ns(b.num), ns(b.den)));
            l.push(format!("Q:{beat}={}", ns(*n)));
        }
        l.push(format!("K:{}", song.key.as_ref().map_or("C".to_string(), |k| self.key_value(k))));
        for (i, part) in song.parts.iter().enumerate() {
            let mut a = vec!["style=jianpu".to_string()];
            if let Some(n) = part.name.as_deref().filter(|n| !n.is_empty()) {
                a.push(format!("name=\"{}\"", n.replace('"', "'")));
            }
            if let Some(n) = part.abbrev.as_deref().filter(|n| !n.is_empty()) {
                a.push(format!("sname=\"{}\"", n.replace('"', "'")));
            }
            if let Some(m) = part.muse_attrs.as_deref().filter(|n| !n.is_empty()) {
                a.push(m.to_string());
            }
            l.push(format!("V:{} {}", i + 1, a.join(" ")));
        }
        for r in song.remarks.iter().flatten() {
            if r.starts_with("P:") {
                continue;
            }
            l.push("%%begintext".into());
            l.extend(split_lines(r).into_iter().map(String::from));
            l.push("%%endtext".into());
        }
        let body = self.body_lines(&song);
        l.extend(body);
        l.join("\n")
    }

    fn emit_doc(&mut self, doc: &ScoreDoc) -> String {
        match self.d {
            Dialect::Jcx => {
                let version = if doc.source_format == SourceFormat::Jcx
                    && doc.source.as_deref().unwrap_or("").trim_start_matches(js::is_space).starts_with("%MUSE3")
                {
                    "%MUSE3"
                } else {
                    self.version_line()
                };
                let body = match doc.songs.first() {
                    Some(first) => {
                        if has_tie_syntax(doc) {
                            self.emit_song(first, None)
                        } else {
                            let s = slurs_as_ties(first).into_owned();
                            self.emit_song(&s, None)
                        }
                    }
                    None => "T:\nK:C".into(),
                };
                format!("{version}\n{body}\n")
            }
            _ => {
                let tie_ok = self.d != Dialect::Abc || has_tie_syntax(doc);
                let multi = doc.songs.len() > 1;
                let mut parts = vec![self.version_line().to_string()];
                for (i, s) in doc.songs.iter().enumerate() {
                    let fb = if multi { Some(i + 1) } else { None };
                    let text = if tie_ok {
                        self.emit_song(s, fb)
                    } else {
                        let t = slurs_as_ties(s).into_owned();
                        self.emit_song(&t, fb)
                    };
                    parts.push(text);
                }
                parts.join("\n\n") + "\n"
            }
        }
    }
}

// ───────────────────────── 方言的预处理 ─────────────────────────

type SongStep<'f> = &'f dyn for<'a> Fn(&'a Song) -> Cow<'a, Song>;

/// 一串「不改就借用」的变换，第一步从借用起
fn chain(song: &Song, steps: &[SongStep]) -> Song {
    let first = steps[0](song).into_owned();
    chain_owned(first, &steps[1..])
}

fn chain_owned(mut s: Song, steps: &[SongStep]) -> Song {
    for f in steps {
        let next = match f(&s) {
            Cow::Owned(o) => Some(o),
            Cow::Borrowed(_) => None,
        };
        if let Some(o) = next {
            s = o;
        }
    }
    s
}

/// 一小节只有一个全休止的标成整小节休止（写回 `Z`）
fn whole_bar_rests(mut song: Song) -> Song {
    for p in song.parts.iter_mut() {
        for m in p.measures.iter_mut() {
            if m.elements.len() != 1 {
                continue;
            }
            let Element::Chord(c) = &mut m.elements[0] else { continue };
            let Some(r) = c.rest.as_mut() else { continue };
            if r.measure == Some(true)
                || c.grace.is_some()
                || c.print_object == Some(false)
                || c.duration.kind.as_ref().map(|k| k.as_str()) != Some("whole")
            {
                continue;
            }
            r.measure = Some(true);
        }
    }
    song
}

/// ABC：长音中途换和弦（和弦挂在增时线上）拆成连音线相连的几段：（和弦，时值）
fn sustain_segments(ch: &Chord) -> Option<Vec<(Option<dolce_model::Harmony>, f64)>> {
    let su = ch.sustains.as_ref()?;
    if !su.iter().any(|s| s.harmony.is_some()) || ch.rest.is_some() || ch.grace.is_some() || ch.rhythm == Some(true) {
        return None;
    }
    let mut segs: Vec<(Option<dolce_model::Harmony>, f64)> = vec![(None, ch.duration.divisions - su.len() as f64 * SIMPLE_DIVISIONS)];
    for s in su {
        if let Some(h) = &s.harmony {
            segs.push((Some(h.clone()), SIMPLE_DIVISIONS));
        } else {
            segs.last_mut().unwrap().1 += SIMPLE_DIVISIONS;
        }
    }
    if segs[0].1 > 0.0 { Some(segs) } else { None }
}

/// ABC：MusicXML 来源的 divisions 换成写出端口径（四分 = `SIMPLE_DIVISIONS`），多连音取名义时值
fn with_abc_divisions(src: &Song) -> Song {
    let mut song = src.clone();
    for part in song.parts.iter_mut() {
        let mut divisions = 1.0;
        for m in part.measures.iter_mut() {
            if let Some(d) = m.attrs.as_ref().and_then(|a| a.divisions) {
                divisions = d;
            }
            if let Some(d) = m.duration.filter(|d| *d != 0.0 && !d.is_nan()) {
                m.duration = Some(js::round((d / divisions) * SIMPLE_DIVISIONS));
            }
            for la in m.later_attrs.iter_mut().flatten() {
                if let Some(o) = la.onset.filter(|o| *o != 0.0 && !o.is_nan()) {
                    la.onset = Some(js::round((o / divisions) * SIMPLE_DIVISIONS));
                }
            }
            for el in m.elements.iter_mut() {
                if el.as_chord().is_some_and(|c| c.grace.is_some()) {
                    continue;
                }
                if el.duration().is_some() {
                    let q = js::round(nominal_quarters(el, divisions) * SIMPLE_DIVISIONS);
                    match el {
                        Element::Chord(c) => c.duration.divisions = q,
                        Element::Space(s) => s.duration.as_mut().unwrap().divisions = q,
                    }
                }
                let on = match el {
                    Element::Chord(c) => &mut c.onset,
                    Element::Space(s) => &mut s.onset,
                };
                if let Some(o) = on.filter(|o| *o != 0.0 && !o.is_nan()) {
                    *on = Some(js::round((o / divisions) * SIMPLE_DIVISIONS));
                }
            }
        }
    }
    song
}

/// Muse：只有音高没有度数的音按简谱口径补度数
fn with_degrees(src: Song) -> Song {
    let missing = src.parts.iter().any(|p| {
        p.measures.iter().any(|m| m.elements.iter().any(|el| el.as_chord().is_some_and(|c| c.notes.iter().any(|n| n.pitch.is_some() && n.degree.is_none()))))
    });
    if !missing {
        return src;
    }
    let mut song = src;
    let key = song.key.clone().unwrap_or_else(c_major);
    for part in song.parts.iter_mut() {
        assign_degrees(part, &key);
    }
    song
}

/// Muse：起止落在增时线上的弧改挂到它的宿主音上
fn marks_off_sustains(mut song: Song) -> Song {
    let mut host: HashMap<ElementId, ElementId> = HashMap::new();
    for p in &song.parts {
        for m in &p.measures {
            for el in &m.elements {
                if let Element::Chord(c) = el {
                    for su in c.sustains.iter().flatten() {
                        host.insert(su.id, c.id);
                    }
                }
            }
        }
    }
    if !song.marks.iter().any(|mk| host.contains_key(&mk.start) || host.contains_key(&mk.end)) {
        return song;
    }
    for mk in song.marks.iter_mut() {
        if let Some(h) = host.get(&mk.start) {
            mk.start = *h;
        }
        if let Some(h) = host.get(&mk.end) {
            mk.end = *h;
        }
    }
    song
}

// ───────────────────────── 入口 ─────────────────────────

/// 整份文档 → `.123` 文本（多曲每首都带 `X:`）
pub fn emit_123(doc: &ScoreDoc) -> String {
    Emitter::new(Dialect::J123).emit_doc(doc)
}

/// 一首歌 → `.123` 文本（`fallback_number`：没有曲号时补的 `X:`）
pub fn emit_song_123(song: &Song, fallback_number: Option<usize>) -> String {
    Emitter::new(Dialect::J123).emit_song(song, fallback_number)
}

/// 整份文档 → `.abc` 文本
pub fn emit_abc(doc: &ScoreDoc) -> String {
    Emitter::new(Dialect::Abc).emit_doc(doc)
}

/// 整份文档 → Muse `.jcx` 文本（未编码；多曲只写第一首）
pub fn emit_jcx(doc: &ScoreDoc) -> String {
    Emitter::new(Dialect::Jcx).emit_doc(doc)
}
