//! 简谱来源的 `Song` → **MusicXML 形状**的 `Song`：`toxml` 序列化之前的投影（`src/model/xmlproject.ts` 是门面）。
//!
//! 判据：首小节带 `attrs.divisions` 的是 MusicXML 形状，原样返回；其余在副本上投影。
//! 小节中间换行（源文写明的）拆成两个小节、中间隐藏线。
//!
//! TS 那边按对象身份记的旁表（`continuationOf` / `splitPieces`）这里借 `Measure.oid` 作临时身份：
//! 副本先清掉全部 `Oid`（同 TS `structuredClone` 后表层 / 版面挂不上），投影期间给小节编临时号，投影完再清掉。

use crate::breaks::{apply_breaks, drop_empty_print, ApplyBreaksOptions, LineStart, MidMode, PageMode};
use crate::deconames::{deco_key, notehead_of, rehearsal_of, tremolo_strokes};
use crate::doc::*;
use crate::helpers::{clear_oids, distinct_numbers, inline_break_of};
use crate::innervoice::layers_to_voices;
use crate::jianpu::{c_major, quarter_tempos, AccidentalCarry, StaffAccidentalCarry};
use crate::keyshift::{key_fifths, song_fifths};
use crate::marknames::{is_dynamic_name, term_text};
use crate::pagemeta::apply_page_meta_to_defaults;
use crate::sections::anchor_play_order;
use crate::staves::merge_staff_parts;
use dolce_base::fraction::{lcm, Fraction};
use dolce_base::{js, Msg};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

/// 记号原名 → `<articulations>` 元素名
const ARTICULATION: &[(&str, &str)] =
    &[("bc", "tenuto"), ("zy", "accent"), ("dy", "staccato"), ("hx", "breath-mark"), ("shy", "scoop"), ("xhy", "falloff")];
/// 归一后的短名 → `<technical>` 元素（弓法）
const TECHNICAL: &[(&str, &str)] = &[("sg", "up-bow"), ("xg", "down-bow")];
pub const ORNAMENT_TAG: &[(&str, &str)] =
    &[("sby", "inverted-mordent"), ("xby", "mordent"), ("cy", "trill-mark"), ("tr", "trill-mark")];
/// 本来就是 MusicXML 元素名的，原样保留
const XML_ARTICULATIONS: &[&str] = &[
    "accent", "strong-accent", "staccato", "tenuto", "detached-legato", "staccatissimo", "spiccato", "scoop", "plop", "doit",
    "falloff", "breath-mark", "caesura", "stress", "unstress", "soft-accent",
];
const XML_ORNAMENTS: &[&str] = &["trill-mark", "turn", "delayed-turn", "inverted-turn", "shake", "mordent", "inverted-mordent"];

fn lookup(table: &'static [(&'static str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

fn is_fermata(key: &str) -> bool {
    ["yc", "ycy", "fermata"].iter().any(|k| k.eq_ignore_ascii_case(key))
}

/// 已是 MusicXML 形状（有声部首小节写了 `divisions`）：投影原样返回
pub fn is_xml_shaped(song: &Song) -> bool {
    song.parts.iter().any(|p| p.measures.first().and_then(|m| m.attrs.as_ref()).and_then(|a| a.divisions).is_some())
}

/// 有没有小节内临时多声部（同一小节里两个以上 `voice`）
pub fn has_voice_overlay(song: &Song) -> bool {
    song.parts.iter().any(|p| {
        p.measures.iter().any(|m| {
            let Some(first) = m.elements.first().map(|e| e.voice()) else { return false };
            m.elements.iter().any(|el| el.voice() != first)
        })
    })
}

/// 源格式有自己的延音线写法（ABC、Muse）
pub fn has_tie_syntax(doc: &ScoreDoc) -> bool {
    matches!(doc.source_format, SourceFormat::Abc | SourceFormat::Jcx)
}

#[derive(Clone, Debug, Default)]
pub struct ProjectOptions {
    /// 换行改照这些音起行（简谱视图实际排出的各行首音）。None = 用模型里的换行
    pub line_starts: Option<Vec<ElementId>>,
    /// `line_starts` 落在小节中间的也原位断
    pub mid_line_starts: bool,
    /// 相邻两个同音的弧当延音线（简谱口径）。None = 缺省（是）
    pub slur_ties: Option<bool>,
}

type Ratios = HashMap<ElementId, (f64, f64)>;

/// 投影期间的旁表：拆出来的后半小节 → 前半、被切过的各段
struct Ident {
    next: u32,
    continuation: HashMap<Oid, Oid>,
    pieces: HashSet<Oid>,
}

impl Ident {
    fn fresh(&mut self) -> Oid {
        self.next += 1;
        Oid(self.next)
    }
}

/// `Song` → MusicXML 形状的 `Song`（MusicXML 形状的原样借出）
pub fn project_for_music_xml<'a>(src: &'a Song, options: &ProjectOptions) -> Result<Cow<'a, Song>, Msg> {
    if is_xml_shaped(src) {
        return Ok(Cow::Borrowed(src));
    }
    // 文本谱的 `{dsb…}` 并排块写成同一谱表的第二个 `<voice>`
    let mut song = layers_to_voices(src).into_owned();
    clear_oids(&mut song);
    let mut id = Ident { next: 0, continuation: HashMap::new(), pieces: HashSet::new() };
    for p in &mut song.parts {
        for m in &mut p.measures {
            m.oid = id.fresh();
        }
    }
    // 后面小节会拆会并：演唱顺序趁小节号还对得上定好首尾和弦
    if song.play_order.as_ref().is_some_and(|p| !p.is_empty()) {
        song.play_order = Some(anchor_play_order(&song));
    }
    apply_page_meta_to_defaults(&mut song);
    if let Some(starts) = options.line_starts.as_ref().filter(|s| !s.is_empty()) {
        let ls: Vec<LineStart> = starts.iter().map(|&id| LineStart { id, page: false }).collect();
        let mid = if options.mid_line_starts { MidMode::Inline } else { MidMode::Source };
        apply_breaks(&mut song, &ls, &ApplyBreaksOptions { mid_in_any_part: false, mid, pages: PageMode::Keep });
    }
    let fifths = song_fifths(&song);
    let hosts = sustain_hosts(&song);
    let tuplets = tuplet_ratios(&song);
    let factor = division_factor(&song, &tuplets);
    let divisions = SIMPLE_DIVISIONS * factor;

    ties_to_marks(&mut song);
    normalize_marks(&mut song, &hosts, options.slur_ties.unwrap_or(true));
    let tuplet_inner = tuplet_inner_chords(&song, &tuplets, &hosts);
    let first_system =
        song.parts.iter().fold(f64::INFINITY, |a, p| js::min(a, p.measures.first().and_then(|m| m.print.as_ref()).and_then(|pr| pr.system).unwrap_or(0.0)));
    let voltas = voltas_of_play_order(&song);
    let tempo = tempo_direction(&song);
    let song_key = song.key.clone();
    let song_time = song.time.clone();
    for pi in 0..song.parts.len() {
        let mut xno = 0u32;
        let part = &mut song.parts[pi];
        if pi == 0 {
            apply_voltas(part, &voltas);
        }
        split_inline_breaks(part, &tuplet_inner, &mut xno, &mut id);
        join_open_measures(part, &mut xno, &mut id);
        merge_empty_measures(part);
        move_forward_repeats(part);
        let Some(first) = part.measures.first_mut() else { continue };
        let mut attrs = first.attrs.take().unwrap_or_default();
        let fk = attrs.key.take();
        let mut key = song_key.clone().unwrap_or_else(c_major);
        key.fifths = fk.as_ref().map_or(fifths, |k| k.fifths);
        if let Some(k) = fk {
            key.mode = k.mode.or(key.mode);
            key.spelling = k.spelling.or(key.spelling);
            key.tonic_degree = k.tonic_degree.or(key.tonic_degree);
            key.display = k.display.or(key.display);
            key.explicit_accidentals = k.explicit_accidentals.or(key.explicit_accidentals);
            key.cancel = k.cancel.or(key.cancel);
        }
        attrs.divisions = Some(divisions);
        attrs.key = Some(key);
        if attrs.time.is_none() {
            attrs.time = Some(match &song_time {
                Some(t) => Time {
                    beats: t.beats,
                    beat_type: t.beat_type,
                    symbol: t.symbol.clone().filter(|s| !s.is_empty()),
                    parenthesized: None,
                },
                None => Time { beats: 4.0, beat_type: 4.0, symbol: None, parenthesized: None },
            });
        }
        first.attrs = Some(attrs);
        for (i, m) in part.measures.iter_mut().enumerate() {
            let Some(pr) = &mut m.print else { continue };
            // 声部头一小节在曲首才不另起系统
            if i == 0 && (pr.system.is_none() || pr.system == Some(first_system)) {
                pr.new_system = None;
                pr.new_page = None;
            }
            // 组号留着：写出端按它排共用时间轴，本身不写进 `<print>`
            if pr.new_system != Some(true) && pr.new_page != Some(true) {
                m.print = pr.system.map(|s| Print { system: Some(s), ..Default::default() });
            }
        }
        project_part(part, fifths, factor, &tuplets, &id);
        wedge_directions(&song.marks, &hosts, &mut song.parts[pi]);
        if pi == 0 {
            if let Some(d) = &tempo {
                let first = &mut song.parts[pi].measures[0];
                if !first.directions.iter().flatten().any(|d| d.kind == "metronome") {
                    first.directions.get_or_insert_with(Vec::new).insert(0, d.clone());
                }
            }
        }
    }
    // 123 / ABC 的大谱表（`V:2 part=1`）并回一个声部的几条谱表
    merge_staff_parts(&mut song);
    // wedge 已经全部落成 direction
    song.marks.retain(|m| m.kind != MarkType::Wedge);
    if !song.credits.as_ref().is_some_and(|c| !c.is_empty()) {
        song.credits = Some(credits_of(&song));
    }
    clear_oids(&mut song);
    Ok(Cow::Owned(song))
}

// ───────────────────────── 头部 ─────────────────────────

/// 页眉的 credit：标题、副标题、署名；页面文字的左上、右上写成靠左、靠右的无类型 credit。
fn credits_of(song: &Song) -> Vec<Credit> {
    let mut out = vec![];
    let credit = |kind: Option<&str>, text: &str, justify: Option<HAlign>| Credit {
        kind: kind.map(str::to_owned),
        text: text.to_owned(),
        page: Some(1.0),
        justify,
        ..Default::default()
    };
    if let Some(t) = song.work.title.as_deref().filter(|t| !t.is_empty()) {
        out.push(credit(Some("title"), t, None));
    }
    for t in &song.work.subtitles {
        if !t.is_empty() {
            out.push(credit(Some("subtitle"), t, None));
        }
    }
    for c in song.identification.iter().flat_map(|i| &i.creators) {
        if !c.text.is_empty() {
            out.push(credit(Some(&c.kind), &c.text, None));
        }
    }
    if let Some(pt) = &song.page_text {
        for t in &pt.top_right {
            if !t.is_empty() {
                out.push(credit(None, t, Some(HAlign::Right)));
            }
        }
        for t in &pt.top_left {
            if !t.is_empty() {
                out.push(credit(None, t, Some(HAlign::Left)));
            }
        }
    }
    out
}

/// 速度拍单位的分母 → MusicXML `beat-unit`
fn unit_of_den(d: f64) -> Option<NoteType> {
    Some(match d {
        1.0 => NoteType::Whole,
        2.0 => NoteType::Half,
        4.0 => NoteType::Quarter,
        8.0 => NoteType::Eighth,
        16.0 => NoteType::N16th,
        _ => return None,
    })
}

/// 曲首的速度 direction（首小节已有 metronome 的不加，调用方判）
fn tempo_direction(song: &Song) -> Option<Direction> {
    let tempos = song.tempos.as_ref()?;
    let i = tempos.iter().position(|t| matches!(t, Tempo::Bpm(n) if *n >= 20.0 && *n <= 400.0))?;
    let Tempo::Bpm(bpm) = tempos[i] else { unreachable!() };
    let qpm = match quarter_tempos(song).get(i) {
        Some(Tempo::Bpm(n)) => *n,
        _ => f64::NAN,
    };
    // 拍单位：附点四分（3/8）→ quarter + beat-unit-dot；其余只认单纯音符，认不出的按四分
    let b = song.tempo_beat.as_ref();
    let dotted = b.is_some_and(|b| b.num == 3.0);
    let unit = b.and_then(|b| unit_of_den(if dotted { b.den / 2.0 } else { b.den / b.num }));
    let mut d = Direction::of("metronome");
    d.placement = Some(Placement::Above);
    d.tempo = Some(Metronome {
        beat_unit: Some(unit.clone().unwrap_or(NoteType::Quarter)),
        beat_unit_dot: if dotted && unit.is_some() { Some(true) } else { None },
        per_minute: Some(if unit.is_some() { bpm } else { qpm }),
        ..Default::default()
    });
    d.sound = Some(Sound { tempo: Some(qpm), ..Default::default() });
    Some(d)
}

// ───────────────────────── 房号（由演唱顺序反推） ─────────────────────────

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Volta {
    /// 本小节是某一房的开头，值为该房辖的遍数（"1,2,3"）
    pub start: Option<String>,
    /// 本小节是某一房的结尾
    pub stop: bool,
    /// 本小节末尾要补一个反复回头
    pub repeat_back: bool,
}

/// 遍次集合（升序、去重）
fn set_key(s: &[f64]) -> String {
    s.iter().map(|x| js::num_to_string(*x)).collect::<Vec<_>>().join(",")
}

fn add_pass(s: &mut Vec<f64>, v: f64) {
    if !s.iter().any(|x| js::NumKey::new(*x) == js::NumKey::new(v)) {
        s.push(v);
        js::sort_num(s);
    }
}

/// 从文档自带的演唱顺序（`.jpwabc` 的 `.Repeat`）反推房号（小节序号是第一声部 `measures` 的下标）。
pub fn voltas_of_play_order(song: &Song) -> Vec<(f64, Volta)> {
    let mut out: Vec<(f64, Volta)> = vec![];
    let Some(part) = song.parts.first() else { return out };
    let items: &[PlayPass] = song.play_order.as_deref().unwrap_or(&[]);
    if items.is_empty() {
        return out;
    }
    if part.measures.iter().any(|m| m.barlines.iter().flatten().any(|b| b.ending.is_some())) {
        return out;
    }
    let mut passes_of: Vec<(f64, Vec<f64>)> = vec![];
    let mut all: Vec<f64> = vec![];
    for it in items {
        let pass = it.verse.unwrap_or(0.0);
        add_pass(&mut all, pass);
        let mut mid = it.from_measure - 1.0;
        while mid < it.to_measure {
            match passes_of.iter_mut().find(|(m, _)| js::NumKey::new(*m) == js::NumKey::new(mid)) {
                Some(e) => add_pass(&mut e.1, pass),
                None => passes_of.push((mid, vec![pass])),
            }
            mid += 1.0;
        }
    }
    if all.len() < 2 {
        return out;
    }
    js::sort_by(&mut passes_of, |a, b| a.0 - b.0);
    struct Seg {
        from: f64,
        to: f64,
        passes: Vec<f64>,
    }
    let mut segs: Vec<Seg> = vec![];
    for (mid, p) in passes_of {
        if let Some(last) = segs.last_mut() {
            if last.to + 1.0 == mid && set_key(&last.passes) == set_key(&p) {
                last.to = mid;
                continue;
            }
        }
        segs.push(Seg { from: mid, to: mid, passes: p });
    }
    let is_subset = |a: &[f64], b: &[f64]| a.len() < b.len() && a.iter().all(|v| b.contains(v));
    let entry = |out: &mut Vec<(f64, Volta)>, at: f64| -> usize {
        match out.iter().position(|(m, _)| js::NumKey::new(*m) == js::NumKey::new(at)) {
            Some(i) => i,
            None => {
                out.push((at, Volta::default()));
                out.len() - 1
            }
        }
    };
    let mut i = 0usize;
    while i + 1 < segs.len() {
        if !is_subset(&segs[i + 1].passes, &segs[i].passes) {
            i += 1;
            continue;
        }
        let target = segs[i].passes.clone();
        let mut group: Vec<usize> = vec![];
        let mut acc: Vec<f64> = vec![];
        for (j, seg) in segs.iter().enumerate().skip(i + 1) {
            if seg.passes.iter().any(|v| acc.contains(v)) {
                break; // 遍次重叠：不是并列的房
            }
            for v in &seg.passes {
                add_pass(&mut acc, *v);
            }
            group.push(j);
            if set_key(&acc) == set_key(&target) {
                break;
            }
        }
        if group.len() < 2 || set_key(&acc) != set_key(&target) {
            i += 1;
            continue;
        }
        for (k, &g) in group.iter().enumerate() {
            let h = entry(&mut out, segs[g].from);
            out[h].1.start = Some(set_key(&segs[g].passes));
            let t = entry(&mut out, segs[g].to);
            out[t].1.stop = true;
            if k < group.len() - 1 {
                out[t].1.repeat_back = true;
            }
        }
        i = *group.last().unwrap() + 1;
    }
    out
}

fn ending_numbers(s: &str) -> Vec<f64> {
    s.split(',').map(js::number).collect()
}

/// 反推出的房号落到小节上：起点挂左线、终点挂右线（非最后一房补反复回头）。
fn apply_voltas(part: &mut Part, voltas: &[(f64, Volta)]) {
    for (mid, v) in voltas {
        let Some(m) = js::index(*mid).and_then(|i| part.measures.get_mut(i)) else { continue };
        if let Some(start) = &v.start {
            let ending = Ending::new(ending_numbers(start), EndingType::Start, Some(start.clone()));
            let bars = m.barlines.get_or_insert_with(Vec::new);
            match bars.iter_mut().find(|b| b.location == BarLocation::Left) {
                Some(left) => left.ending = Some(ending),
                None => {
                    let mut b = Barline::at(BarLocation::Left);
                    b.ending = Some(ending);
                    bars.insert(0, b);
                }
            }
        }
        if v.stop {
            let bars = m.barlines.get_or_insert_with(Vec::new);
            let ri = match bars.iter().position(|b| b.location == BarLocation::Right) {
                Some(i) => i,
                None => {
                    bars.push(Barline::at(BarLocation::Right));
                    bars.len() - 1
                }
            };
            let right = &mut bars[ri];
            let nums = v.start.clone().unwrap_or_default();
            let numbers = if nums.is_empty() { vec![] } else { ending_numbers(&nums) };
            right.ending = Some(Ending::new(numbers, EndingType::Stop, Some(nums)));
            if v.repeat_back {
                right.repeat = Some(RepeatDir::Backward);
                if right.style.is_none() {
                    right.style = Some(BarStyle::LightHeavy);
                }
            }
        }
    }
}

// ───────────────────────── 小节结构 ─────────────────────────

/// 连音内部（不是连音最后一个）的和弦：在它后面换行会把连音劈开，不拆。
fn tuplet_inner_chords(song: &Song, tuplets: &Ratios, hosts: &HashMap<ElementId, ElementId>) -> HashSet<ElementId> {
    let ends: HashSet<ElementId> =
        song.marks.iter().filter(|m| m.kind == MarkType::Tuplet).map(|m| *hosts.get(&m.end).unwrap_or(&m.end)).collect();
    tuplets.keys().filter(|id| !ends.contains(id)).copied().collect()
}

fn timed(el: &Element) -> bool {
    match el {
        Element::Chord(c) => c.grace.is_none(),
        Element::Space(s) => s.spacer == Spacer::X,
    }
}

fn hidden_bar_right() -> Barline {
    let mut b = Barline::at(BarLocation::Right);
    b.style = Some(BarStyle::NoStyle);
    b
}

/// **小节中间换行**（`Chord.lineBreakAfter`）拆成两个小节：前半的右线是隐藏线，后半 `implicit`（编号 `X1`…）并起新行。
fn split_inline_breaks(part: &mut Part, tuplet_inner: &HashSet<ElementId>, xno: &mut u32, id: &mut Ident) {
    let mut out: Vec<Measure> = vec![];
    let mut drop_print = false;
    for mut m in std::mem::take(&mut part.measures) {
        if drop_print {
            if let Some(pr) = &mut m.print {
                pr.new_system = None;
                pr.new_page = None;
                drop_empty_print(&mut m);
            }
        }
        drop_print = false;
        let mut cuts: Vec<(usize, BreakKind)> = vec![];
        let n = m.elements.len();
        for k in 0..n {
            let Some(kind) = inline_break_of(&m.elements[k]) else { continue };
            let Element::Chord(el) = &mut m.elements[k] else { continue };
            el.line_break_after = None;
            for su in el.sustains.iter_mut().flatten() {
                su.line_break_after = None;
            }
            let eid = el.id;
            let rest = &m.elements[k + 1..];
            if rest.is_empty() || rest.iter().all(|e| !timed(e) && matches!(e, Element::Space(_))) {
                continue; // 在小节末：就是小节级换行
            }
            if tuplet_inner.contains(&eid) {
                continue;
            }
            cuts.push((k + 1, kind));
        }
        if cuts.is_empty() {
            out.push(m);
            continue;
        }
        drop_print = true;
        out.extend(split_measure(m, &cuts, xno, id));
    }
    part.measures = out;
}

/// 带 `afterElements` / `offset` / `onset` 的附属物换基准
trait Rebase {
    fn rebase(&mut self, from: f64, time: f64);
}

impl Rebase for Direction {
    fn rebase(&mut self, from: f64, time: f64) {
        if let Some(a) = &mut self.after_elements {
            *a -= from;
        }
        if let Some(o) = &mut self.offset {
            *o = js::max(0.0, *o - time);
        }
        if let Some(o) = &mut self.onset {
            *o = js::max(0.0, *o - time);
        }
    }
}

impl Rebase for LaterAttrs {
    fn rebase(&mut self, from: f64, time: f64) {
        self.after_elements -= from;
        if let Some(o) = &mut self.onset {
            *o = js::max(0.0, *o - time);
        }
    }
}

/// 把一个小节在 `cuts` 各处切开。元素级的附属物（小节中间的线、direction、小节中间的 attributes）按位置分过去。
fn split_measure(m: Measure, cuts: &[(usize, BreakKind)], xno: &mut u32, id: &mut Ident) -> Vec<Measure> {
    let mut bounds = vec![0usize];
    bounds.extend(cuts.iter().map(|c| c.0));
    bounds.push(m.elements.len());
    let np = bounds.len() - 1;
    // 各段起点的时值（源口径的 divisions）
    let mut start_time = vec![0.0; np];
    let mut t = 0.0;
    for (k, el) in m.elements.iter().enumerate() {
        if let Some(b) = bounds.iter().position(|&x| x == k) {
            if b < np {
                start_time[b] = t;
            }
        }
        if timed(el) {
            t += js::round(el.duration().map_or(0.0, |d| d.divisions));
        }
    }
    let piece_of = |after: Option<f64>| -> usize {
        let a = after.unwrap_or(0.0);
        let mut p = 0;
        while p + 1 < np && a >= bounds[p + 1] as f64 {
            p += 1;
        }
        p
    };
    let mut pieces: Vec<Measure> = vec![];
    for p in 0..np {
        let first = p == 0;
        let last = p == np - 1;
        let from = bounds[p];
        let elements = m.elements[from..bounds[p + 1]].to_vec();
        let mut piece = if first {
            Measure {
                oid: id.fresh(),
                elements,
                barlines: None,
                directions: None,
                later_attrs: None,
                trailing: None,
                ..m.clone()
            }
        } else {
            *xno += 1;
            Measure { oid: id.fresh(), number: format!("X{}", xno), implicit: Some(true), elements, ..Default::default() }
        };
        if !first {
            let pr = if cuts[p - 1].1 == BreakKind::Page {
                Print { new_page: Some(true), ..Default::default() }
            } else {
                Print { new_system: Some(true), ..Default::default() }
            };
            piece.print = Some(pr);
            id.continuation.insert(piece.oid, pieces[p - 1].oid);
        }
        let mut bars: Vec<Barline> = vec![];
        for b in m.barlines.iter().flatten() {
            let take = match b.location {
                BarLocation::Left => first,
                BarLocation::Right => last,
                _ => piece_of(b.after_elements) == p,
            };
            if take {
                if b.location == BarLocation::Middle {
                    bars.push(Barline { after_elements: Some(b.after_elements.unwrap_or(0.0) - from as f64), ..b.clone() });
                } else {
                    bars.push(b.clone());
                }
            }
        }
        if !last {
            bars.push(hidden_bar_right());
        }
        if !bars.is_empty() {
            piece.barlines = Some(bars);
        }
        let dirs: Vec<Direction> = m
            .directions
            .iter()
            .flatten()
            .filter(|d| piece_of(d.after_elements) == p)
            .map(|d| {
                let mut d = d.clone();
                if from != 0 {
                    d.rebase(from as f64, start_time[p]);
                }
                d
            })
            .collect();
        if !dirs.is_empty() {
            piece.directions = Some(dirs);
        }
        let later: Vec<LaterAttrs> = m
            .later_attrs
            .iter()
            .flatten()
            .filter(|a| piece_of(Some(a.after_elements)) == p)
            .map(|a| {
                let mut a = a.clone();
                if from != 0 {
                    a.rebase(from as f64, start_time[p]);
                }
                a
            })
            .collect();
        if !later.is_empty() {
            piece.later_attrs = Some(later);
        }
        if last && m.trailing.is_some() {
            piece.trailing = m.trailing.clone();
        }
        id.pieces.insert(piece.oid);
        pieces.push(piece);
    }
    pieces
}

fn has_bar(m: &Measure, loc: BarLocation) -> bool {
    m.barlines.iter().flatten().any(|b| b.location == loc)
}

/// 行尾没有小节线的小节：下一段起新行就前半隐藏右线、后半 `implicit`；不换行的与下一小节并成一个。
fn join_open_measures(part: &mut Part, xno: &mut u32, id: &mut Ident) {
    let mut out: Vec<Measure> = vec![];
    for mut m in std::mem::take(&mut part.measures) {
        if let Some(prev) = out.last_mut() {
            let prev_open = !prev.elements.is_empty() && !has_bar(prev, BarLocation::Right);
            if prev_open && !m.elements.is_empty() && m.attrs.is_none() && !has_bar(&m, BarLocation::Left) {
                let pr = m.print.as_ref();
                if pr.and_then(|p| p.new_system) == Some(true) || pr.and_then(|p| p.new_page) == Some(true) {
                    prev.barlines.get_or_insert_with(Vec::new).push(hidden_bar_right());
                    *xno += 1;
                    m.number = format!("X{}", xno);
                    m.implicit = Some(true);
                    id.continuation.insert(m.oid, prev.oid);
                    id.pieces.insert(prev.oid);
                    id.pieces.insert(m.oid);
                    out.push(m);
                    continue;
                }
                prev.elements.append(&mut m.elements);
                if let Some(b) = m.barlines {
                    prev.barlines.get_or_insert_with(Vec::new).extend(b);
                }
                if let Some(t) = m.trailing {
                    prev.trailing.get_or_insert_with(Vec::new).extend(t);
                }
                continue;
            }
        }
        out.push(m);
    }
    part.measures = out;
}

fn merge_print(base: &Print, over: Option<&Print>) -> Print {
    let Some(o) = over else { return base.clone() };
    Print {
        oid: o.oid,
        new_system: o.new_system.or(base.new_system),
        new_page: o.new_page.or(base.new_page),
        system: o.system.or(base.system),
        texts: o.texts.clone().or_else(|| base.texts.clone()),
        caption: o.caption.clone().or_else(|| base.caption.clone()),
        variant: o.variant.clone().or_else(|| base.variant.clone()),
        lyric_lines: o.lyric_lines.clone().or_else(|| base.lyric_lines.clone()),
        source: o.source.or(base.source),
        text_sources: o.text_sources.clone().or_else(|| base.text_sources.clone()),
    }
}

fn merge_attrs(base: &MeasureAttrs, over: Option<&MeasureAttrs>) -> MeasureAttrs {
    let Some(o) = over else { return base.clone() };
    MeasureAttrs {
        oid: o.oid,
        divisions: o.divisions.or(base.divisions),
        key: o.key.clone().or_else(|| base.key.clone()),
        time: o.time.clone().or_else(|| base.time.clone()),
        clefs: o.clefs.clone().or_else(|| base.clefs.clone()),
        staves: o.staves.or(base.staves),
        transpose: o.transpose.clone().or_else(|| base.transpose.clone()),
        multi_rest: o.multi_rest.or(base.multi_rest),
    }
}

fn left_forward() -> Barline {
    let mut b = Barline::at(BarLocation::Left);
    b.repeat = Some(RepeatDir::Forward);
    b.style = Some(BarStyle::HeavyLight);
    b
}

/// 没有元素的小节在 MusicXML 里不成小节：房号、左反复、行结构、拍号顺延到下一小节；是最后一个就把右线并回前一小节。
fn merge_empty_measures(part: &mut Part) {
    let mut out: Vec<Measure> = vec![];
    let mut carry: Option<Measure> = None;
    for mut m in std::mem::take(&mut part.measures) {
        if m.elements.is_empty() {
            carry = Some(match carry {
                Some(a) => {
                    let mut bars = a.barlines.clone().unwrap_or_default();
                    bars.extend(m.barlines.clone().unwrap_or_default());
                    let print = match (&a.print, &m.print) {
                        (None, None) => None,
                        (pa, pb) => Some(merge_print(&pa.clone().unwrap_or_default(), pb.as_ref())),
                    };
                    Measure { barlines: Some(bars), print, ..a }
                }
                None => m,
            });
            continue;
        }
        if let Some(c) = carry.take() {
            let mut lefts: Vec<Barline> = vec![];
            for b in c.barlines.iter().flatten() {
                if b.ending.as_ref().is_some_and(|e| e.kind == EndingType::Start) {
                    let mut l = Barline::at(BarLocation::Left);
                    l.ending = b.ending.clone();
                    lefts.push(l);
                }
                if b.repeat == Some(RepeatDir::Forward) || b.also_forward == Some(true) {
                    lefts.push(left_forward());
                }
                // 线上的记号（行首 `|:&hs`）落到下一小节起点
                if b.ornaments.as_ref().is_some_and(|o| !o.is_empty()) {
                    let mut l = Barline::at(BarLocation::Left);
                    l.ornaments = b.ornaments.clone();
                    lefts.push(l);
                }
                if let Some(t) = &b.time {
                    let a = m.attrs.get_or_insert_with(MeasureAttrs::default);
                    if a.time.is_none() {
                        a.time = Some(t.clone());
                    }
                }
            }
            if !lefts.is_empty() {
                lefts.extend(m.barlines.take().unwrap_or_default());
                m.barlines = Some(lefts);
            }
            if let Some(cp) = &c.print {
                m.print = Some(merge_print(cp, m.print.as_ref()));
            }
            if let Some(ca) = &c.attrs {
                m.attrs = Some(merge_attrs(ca, m.attrs.as_ref()));
            }
        }
        out.push(m);
    }
    if let (Some(c), Some(last)) = (carry, out.last_mut()) {
        for b in c.barlines.into_iter().flatten() {
            if b.location != BarLocation::Right || b.ending.as_ref().is_some_and(|e| e.kind == EndingType::Start) {
                continue;
            }
            let bars = last.barlines.get_or_insert_with(Vec::new);
            match bars.iter_mut().find(|x| x.location == BarLocation::Right) {
                None => bars.push(b),
                Some(right) => {
                    if right.ending.is_none() {
                        right.ending = b.ending;
                    }
                    if right.repeat.is_none() {
                        right.repeat = b.repeat;
                    }
                }
            }
        }
    }
    part.measures = out;
}

/// 右线上的 `|:`（与 `:|:` 的 forward 半边）是**下一小节**的左反复；右线上起头的房号同理。普通小节线不写 `<barline>`。
fn move_forward_repeats(part: &mut Part) {
    let n = part.measures.len();
    for i in 0..n {
        let (head, tail) = part.measures.split_at_mut(i + 1);
        let m = &mut head[i];
        let mut next = tail.first_mut();
        let mut lefts: Vec<Barline> = vec![];
        let bars = m.barlines.take().unwrap_or_default();
        let mut kept: Vec<Barline> = vec![];
        for mut b in bars {
            if b.location != BarLocation::Right {
                kept.push(b);
                continue;
            }
            if b.repeat == Some(RepeatDir::Forward) || b.also_forward == Some(true) {
                // heavy-light 是左反复那一侧的线型，跟着挪过去；`:|:` 的右线留 light-heavy
                if b.repeat == Some(RepeatDir::Forward) {
                    b.repeat = None;
                    if b.style == Some(BarStyle::HeavyLight) {
                        b.style = None;
                    }
                }
                b.also_forward = None;
                lefts.push(left_forward());
            }
            if b.ending.as_ref().is_some_and(|e| e.kind == EndingType::Start) {
                let mut l = Barline::at(BarLocation::Left);
                l.ending = b.ending.take();
                lefts.push(l);
            }
            if let (Some(t), Some(nx)) = (&b.time, next.as_deref_mut()) {
                let a = nx.attrs.get_or_insert_with(MeasureAttrs::default);
                if a.time.is_none() {
                    a.time = Some(t.clone());
                }
            }
            if b.style == Some(BarStyle::Regular) {
                b.style = None;
            }
            if b.style.is_some() || b.repeat.is_some() || b.ending.is_some() || b.ornaments.as_ref().is_some_and(|o| !o.is_empty()) {
                kept.push(b);
            }
        }
        if !lefts.is_empty() {
            if let Some(nx) = next {
                let key = |b: &Barline| (b.repeat.is_some(), b.ending.is_some());
                let existing: HashSet<(bool, bool)> =
                    nx.barlines.iter().flatten().filter(|b| b.location == BarLocation::Left).map(key).collect();
                let mut add: Vec<Barline> = lefts.into_iter().filter(|b| !existing.contains(&key(b))).collect();
                add.extend(nx.barlines.take().unwrap_or_default());
                nx.barlines = Some(add);
            }
        }
        for b in &mut kept {
            if b.location == BarLocation::Left && b.style == Some(BarStyle::Regular) {
                b.style = None;
            }
        }
        m.barlines = if kept.is_empty() { None } else { Some(kept) };
    }
}

// ───────────────────────── 跨元素记号 ─────────────────────────

/// 增时线 id → 宿主和弦 id。
fn sustain_hosts(song: &Song) -> HashMap<ElementId, ElementId> {
    let mut out = HashMap::new();
    for p in &song.parts {
        for m in &p.measures {
            for el in &m.elements {
                if let Element::Chord(c) = el {
                    for su in c.sustains.iter().flatten() {
                        out.insert(su.id, c.id);
                    }
                }
            }
        }
    }
    out
}

/// 多连音：n 个位置（增时线各占一个）占 n−1 个基本时值。
fn tuplet_ratios(song: &Song) -> Ratios {
    let mut out = HashMap::new();
    for p in &song.parts {
        let mut tokens: Vec<ElementId> = vec![];
        let mut chord_of_token: Vec<ElementId> = vec![];
        for m in &p.measures {
            for el in &m.elements {
                let Element::Chord(c) = el else { continue };
                if c.grace.is_some() {
                    continue;
                }
                tokens.push(c.id);
                chord_of_token.push(c.id);
                for su in c.sustains.iter().flatten() {
                    tokens.push(su.id);
                    chord_of_token.push(c.id);
                }
            }
        }
        let at: HashMap<ElementId, usize> = tokens.iter().enumerate().map(|(i, id)| (*id, i)).collect();
        for mk in &song.marks {
            if mk.kind != MarkType::Tuplet {
                continue;
            }
            let (Some(&a), Some(&b)) = (at.get(&mk.start), at.get(&mk.end)) else { continue };
            if b <= a {
                continue;
            }
            let n = (b - a + 1) as f64;
            for c in &chord_of_token[a..=b] {
                out.insert(*c, (n, n - 1.0));
            }
        }
    }
    out
}

/// 连音缩放后时值不再是 48 的整数倍时，divisions 要整体放大多少倍。
fn division_factor(song: &Song, tuplets: &Ratios) -> f64 {
    let mut f = 1.0;
    for p in &song.parts {
        for m in &p.measures {
            for el in &m.elements {
                let Element::Chord(c) = el else { continue };
                let r = c.duration.time_mod.as_ref().map(|t| (t.actual, t.normal)).or_else(|| tuplets.get(&c.id).copied());
                let Some((actual, normal)) = r else { continue };
                let q = Fraction::new(js::round(c.duration.divisions) * normal, actual);
                f = lcm(f, q.denominator);
            }
        }
    }
    f
}

fn same_degree(a: &Note, b: &Note) -> bool {
    match (&a.degree, &b.degree) {
        (Some(x), Some(y)) => x.number == y.number && x.octave_shift == y.octave_shift,
        _ => false,
    }
}

/// 延音线：简谱来源只在音上标了起止（`Note.tie`），`<tied>` 要按 id 配成对。配不上的两头都去掉。按谱表·声部各配各的。
pub fn ties_to_marks(song: &mut Song) {
    if song.marks.iter().any(|m| m.kind == MarkType::Tied) {
        return;
    }
    // (小节, 元素, 音) 的位置与和弦 id
    type Open = Vec<(usize, usize, usize, ElementId)>;
    let mut new_marks: Vec<Mark> = vec![];
    for p in &mut song.parts {
        let mut by_voice: HashMap<(js::NumKey, js::NumKey), Open> = HashMap::new();
        let mut clear_start: Vec<(usize, usize, usize)> = vec![];
        for mi in 0..p.measures.len() {
            for ei in 0..p.measures[mi].elements.len() {
                let Element::Chord(el) = &p.measures[mi].elements[ei] else { continue };
                if el.grace.is_some() {
                    continue;
                }
                let key = (js::NumKey::new(el.staff), js::NumKey::new(el.voice));
                let mut open = by_voice.remove(&key).unwrap_or_default();
                let mut next: Open = vec![];
                let eid = el.id;
                for ni in 0..el.notes.len() {
                    let stop = p.measures[mi].elements[ei].as_chord().unwrap().notes[ni].tie.as_ref().is_some_and(|t| t.stop == Some(true));
                    if stop {
                        let note = p.measures[mi].elements[ei].as_chord().unwrap().notes[ni].clone();
                        let k = open.iter().position(|o| {
                            let Element::Chord(oc) = &p.measures[o.0].elements[o.1] else { return false };
                            same_degree(&oc.notes[o.2], &note)
                        });
                        match k {
                            Some(k) => {
                                new_marks.push(Mark::new(MarkType::Tied, open[k].3, eid));
                                open.remove(k);
                            }
                            None => {
                                let Element::Chord(c) = &mut p.measures[mi].elements[ei] else { unreachable!() };
                                c.notes[ni].tie.as_mut().unwrap().stop = None;
                            }
                        }
                    }
                    let Element::Chord(c) = &p.measures[mi].elements[ei] else { unreachable!() };
                    if c.notes[ni].tie.as_ref().is_some_and(|t| t.start == Some(true)) {
                        next.push((mi, ei, ni, eid));
                    }
                }
                for o in open {
                    clear_start.push((o.0, o.1, o.2));
                }
                by_voice.insert(key, next);
            }
        }
        for open in by_voice.into_values() {
            for o in open {
                clear_start.push((o.0, o.1, o.2));
            }
        }
        for (mi, ei, ni) in clear_start {
            if let Element::Chord(c) = &mut p.measures[mi].elements[ei] {
                if let Some(t) = &mut c.notes[ni].tie {
                    t.start = None;
                }
            }
        }
    }
    song.marks.extend(new_marks);
}

/// 延音线两端算不算同音：唱名音看度数与八度（后一个没写变音算沿用），带谱表位置的节奏音符看位置
fn same_tied_note(x: &Note, y: &Note) -> bool {
    if x.unpitched.is_some() || y.unpitched.is_some() {
        return match (&x.unpitched, &y.unpitched) {
            (Some(a), Some(b)) => a.step == b.step && a.octave == b.octave,
            _ => false,
        };
    }
    same_degree(x, y) && !(y.degree.as_ref().unwrap().accidental.is_some() && y.degree.as_ref().unwrap().accidental != x.degree.as_ref().unwrap().accidental)
}

/// 括住相邻两个同音的弧就是延音线：补上两端的 `Note.tie`。返回连上的 `[起, 止]` 下标
fn tie_slur(a: &mut Chord, b: &mut Chord) -> Vec<(usize, usize)> {
    if a.rest.is_some() || b.rest.is_some() || a.grace.is_some() || b.grace.is_some() {
        return vec![];
    }
    let ra = a.rhythm == Some(true);
    let rb = b.rhythm == Some(true);
    if ra && rb && (a.notes.is_empty() || b.notes.is_empty()) {
        return vec![(0, 0)];
    }
    if ra != rb {
        return vec![];
    }
    let mut out = vec![];
    let mut used: HashSet<usize> = HashSet::new();
    for (i, x) in a.notes.iter().enumerate() {
        let Some(j) = b.notes.iter().enumerate().position(|(k, y)| !used.contains(&k) && same_tied_note(x, y)) else { continue };
        used.insert(j);
        out.push((i, j));
    }
    // 和音只有每个音都连得上才算延音线
    if out.len() < a.notes.len() {
        return vec![];
    }
    for &(i, j) in &out {
        a.notes[i].tie.get_or_insert_with(Tie::default).start = Some(true);
        b.notes[j].tie.get_or_insert_with(Tie::default).stop = Some(true);
    }
    out
}

/// 同一路 = 声部 + 谱表 + voice
type Lane = (usize, js::NumKey, js::NumKey);

/// 位置索引：和弦 id → (声部, 小节, 元素, 路, 路内第几个)
struct SlurTie {
    at: HashMap<ElementId, (usize, usize, usize, Lane, usize)>,
}

impl SlurTie {
    fn new(song: &Song) -> SlurTie {
        let mut at = HashMap::new();
        let mut lane_next: HashMap<Lane, usize> = HashMap::new();
        for (pi, p) in song.parts.iter().enumerate() {
            for (mi, m) in p.measures.iter().enumerate() {
                for (ei, el) in m.elements.iter().enumerate() {
                    let Element::Chord(c) = el else { continue };
                    let lane = (pi, js::NumKey::new(c.staff), js::NumKey::new(c.voice));
                    let k = *lane_next.get(&lane).unwrap_or(&0);
                    lane_next.insert(lane, k + 1);
                    at.insert(c.id, (pi, mi, ei, lane, k));
                }
            }
        }
        SlurTie { at }
    }

    /// 弧的两端是不是同一路里相邻的两个同音：是就补上两端的 `Note.tie`、返回音下标对
    fn test(&self, song: &mut Song, start: ElementId, end: ElementId) -> Vec<(usize, usize)> {
        let (Some(a), Some(b)) = (self.at.get(&start), self.at.get(&end)) else { return vec![] };
        if a.3 != b.3 || b.4 != a.4 + 1 {
            return vec![];
        }
        // 同一路相邻：两者是不同元素
        let (pa, ma, ea) = (a.0, a.1, a.2);
        let (pb, mb, eb) = (b.0, b.1, b.2);
        let mut ca = match &song.parts[pa].measures[ma].elements[ea] {
            Element::Chord(c) => c.clone(),
            _ => unreachable!(),
        };
        let mut cb = match &song.parts[pb].measures[mb].elements[eb] {
            Element::Chord(c) => c.clone(),
            _ => unreachable!(),
        };
        let out = tie_slur(&mut ca, &mut cb);
        if !out.is_empty() {
            song.parts[pa].measures[ma].elements[ea] = Element::Chord(ca);
            song.parts[pb].measures[mb].elements[eb] = Element::Chord(cb);
        }
        out
    }
}

fn tied_mark(start: ElementId, end: ElementId, i: usize, j: usize) -> Mark {
    let mut m = Mark::new(MarkType::Tied, start, end);
    if i != 0 {
        m.start_note = Some(i as f64);
    }
    if j != 0 {
        m.end_note = Some(j as f64);
    }
    m
}

/// 简谱口径的歌写进有 `-` 的格式（ABC、Muse）之前：相邻同音的弧换成延音线。MusicXML 形状的原样返回
pub fn slurs_as_ties(src: &Song) -> Cow<'_, Song> {
    if is_xml_shaped(src) || !src.marks.iter().any(|m| m.kind == MarkType::Slur) {
        return Cow::Borrowed(src);
    }
    let mut song = src.clone();
    let hosts = sustain_hosts(&song);
    let tester = SlurTie::new(&song);
    let mut marks = vec![];
    for mk in std::mem::take(&mut song.marks) {
        let start = *hosts.get(&mk.start).unwrap_or(&mk.start);
        let end = *hosts.get(&mk.end).unwrap_or(&mk.end);
        let pairs = if mk.kind == MarkType::Slur && mk.collapsed != Some(true) { tester.test(&mut song, start, end) } else { vec![] };
        if pairs.is_empty() {
            marks.push(mk);
            continue;
        }
        for (i, j) in pairs {
            marks.push(tied_mark(start, end, i, j));
        }
    }
    song.marks = marks;
    Cow::Owned(song)
}

/// 记号端点归到写得出来的音符上；没收口、倒置、端点不在谱面元素上的丢掉；弧线补 number。
fn normalize_marks(song: &mut Song, hosts: &HashMap<ElementId, ElementId>, slur_ties: bool) {
    let mut written: HashSet<ElementId> = HashSet::new();
    let mut order: HashMap<ElementId, usize> = HashMap::new();
    for p in &song.parts {
        for m in &p.measures {
            for el in &m.elements {
                let Element::Chord(c) = el else { continue };
                written.insert(c.id);
                let n = order.len();
                order.insert(c.id, n);
            }
        }
    }
    let tester = SlurTie::new(song);
    let mut marks: Vec<Mark> = vec![];
    for mk in std::mem::take(&mut song.marks) {
        if mk.kind == MarkType::Wedge {
            marks.push(mk);
            continue;
        }
        if mk.collapsed == Some(true) {
            continue;
        }
        let start = *hosts.get(&mk.start).unwrap_or(&mk.start);
        let end = *hosts.get(&mk.end).unwrap_or(&mk.end);
        if !written.contains(&start) || !written.contains(&end) {
            continue;
        }
        if matches!(mk.kind, MarkType::Slur | MarkType::Tuplet) && order[&start] >= order[&end] {
            continue;
        }
        let pairs = if mk.kind == MarkType::Slur && slur_ties { tester.test(song, start, end) } else { vec![] };
        if !pairs.is_empty() {
            for (i, j) in pairs {
                marks.push(tied_mark(start, end, i, j));
            }
            continue;
        }
        marks.push(Mark { start, end, ..mk });
    }
    // 多连音不能交叠，后来的那条丢掉
    let mut tup: Vec<usize> = (0..marks.len()).filter(|&i| marks[i].kind == MarkType::Tuplet).collect();
    js::sort_by(&mut tup, |a, b| order[&marks[*a].start] as f64 - order[&marks[*b].start] as f64);
    let mut drop: HashSet<usize> = HashSet::new();
    let mut tuplet_end: isize = -1;
    for i in tup {
        if order[&marks[i].start] as isize <= tuplet_end {
            drop.insert(i);
            continue;
        }
        tuplet_end = order[&marks[i].end] as isize;
    }
    // 重叠的弧线靠 number 配对
    let mut active: Vec<usize> = vec![];
    let mut slurs: Vec<usize> =
        (0..marks.len()).filter(|&i| !drop.contains(&i) && marks[i].kind == MarkType::Slur && marks[i].number.is_none()).collect();
    js::sort_by(&mut slurs, |a, b| order[&marks[*a].start] as f64 - order[&marks[*b].start] as f64);
    for i in slurs {
        let s = order[&marks[i].start];
        let slot = active.iter().position(|&e| e < s).unwrap_or(active.len());
        let e = order[&marks[i].end];
        if slot == active.len() {
            active.push(e);
        } else {
            active[slot] = e;
        }
        marks[i].number = Some((slot + 1) as f64);
    }
    let mut k = 0;
    marks.retain(|_| {
        let keep = !drop.contains(&k);
        k += 1;
        keep
    });
    song.marks = marks;
}

/// 渐强渐弱：起点、终点各一个 `<wedge>` direction。
fn wedge_directions(marks: &[Mark], hosts: &HashMap<ElementId, ElementId>, part: &mut Part) {
    let mut where_: HashMap<ElementId, (usize, f64, f64)> = HashMap::new();
    for (mi, m) in part.measures.iter().enumerate() {
        let mut pos = 0.0;
        for el in &m.elements {
            let d = if timed(el) { js::round(el.duration().map_or(0.0, |d| d.divisions)) } else { 0.0 };
            where_.insert(el.id(), (mi, pos, pos + d));
            pos += d;
        }
    }
    for mk in marks {
        if mk.kind != MarkType::Wedge || mk.collapsed == Some(true) {
            continue;
        }
        let (Some(&s), Some(&e)) = (where_.get(hosts.get(&mk.start).unwrap_or(&mk.start)), where_.get(hosts.get(&mk.end).unwrap_or(&mk.end)))
        else {
            continue;
        };
        let mut at = |mi: usize, offset: f64, mut d: Direction| {
            if offset > 0.0 {
                d.offset = Some(offset);
            }
            part.measures[mi].directions.get_or_insert_with(Vec::new).push(d);
        };
        let mut ds = Direction::of("wedge");
        ds.placement = Some(Placement::Below);
        ds.span_type = Some(SpanType::Start);
        ds.wedge_type = Some(mk.wedge_type.clone().unwrap_or(WedgeType::Crescendo));
        at(s.0, s.1, ds);
        let mut de = Direction::of("wedge");
        de.placement = Some(Placement::Below);
        de.span_type = Some(SpanType::Stop);
        at(e.0, e.2, de);
    }
}

// ───────────────────────── 元素 ─────────────────────────

/// 音符类型 → 符杠层数（倚音成杠、没写减时线条数的 ABC 音符用）。
fn grace_beam_levels(t: &str) -> Option<f64> {
    match t {
        "eighth" => Some(1.0),
        "16th" => Some(2.0),
        "32nd" => Some(3.0),
        "64th" => Some(4.0),
        _ => None,
    }
}

const BASES: [(NoteType, f64); 7] = [
    (NoteType::Whole, 4.0),
    (NoteType::Half, 2.0),
    (NoteType::Quarter, 1.0),
    (NoteType::Eighth, 0.5),
    (NoteType::N16th, 0.25),
    (NoteType::N32nd, 0.125),
    (NoteType::N64th, 0.0625),
];

/// 由总时值（四分音符为 1）反推 `<type>` + 附点数，Fraction 精确比较。
pub fn type_of_duration(q: &Fraction) -> (NoteType, f64) {
    let frac = |v: f64| Fraction::new(js::round(v * 16.0), 16.0);
    for (t, v) in BASES.iter() {
        let b = frac(*v);
        if q.equals(&b) {
            return (t.clone(), 0.0);
        }
        if q.equals(&b.times(&Fraction::new(3.0, 2.0))) {
            return (t.clone(), 1.0);
        }
        if q.equals(&b.times(&Fraction::new(7.0, 4.0))) {
            return (t.clone(), 2.0);
        }
    }
    for (t, v) in BASES.iter() {
        if q.compare_to(&frac(*v)) >= 0 {
            return (t.clone(), 0.0);
        }
    }
    (NoteType::N64th, 0.0)
}

fn push_dir(dirs: &mut Vec<Direction>, offset: f64, mut d: Direction) {
    if offset > 0.0 {
        d.offset = Some(offset);
    }
    dirs.push(d);
}

fn project_part(part: &mut Part, song_fifths: f64, factor: f64, tuplets: &Ratios, id: &Ident) {
    let mut fifths = part.measures.first().and_then(|m| m.attrs.as_ref()).and_then(|a| a.key.as_ref()).map_or(song_fifths, |k| k.fifths);
    // 八度谱号：简谱按高八度记，音高要落回实际八度
    let mut octave = 0.0;
    // 文本谱/123 的 `beams` 是减时线层数的占位（全是 continue），一个 begin 都没有就按拍自动分组
    let real_beams = part.measures.iter().any(|m| {
        m.elements.iter().any(|el| matches!(el, Element::Chord(c) if c.beams.as_ref().is_some_and(|b| b.contains(&BeamVal::Begin))))
    });
    let quarter = SIMPLE_DIVISIONS * factor;
    let mut time = part
        .measures
        .first()
        .and_then(|m| m.attrs.as_ref())
        .and_then(|a| a.time.clone())
        .unwrap_or(Time { beats: 4.0, beat_type: 4.0, symbol: None, parenthesized: None });
    let mut ends: HashMap<Oid, f64> = HashMap::new();
    let mut carries: HashMap<Oid, AccidentalCarry> = HashMap::new();
    let mut staff_carries: HashMap<Oid, StaffAccidentalCarry> = HashMap::new();
    let second_cont = part.measures.get(1).and_then(|m| id.continuation.get(&m.oid).copied());
    for mi in 0..part.measures.len() {
        let m = &mut part.measures[mi];
        let cont = id.continuation.get(&m.oid).copied();
        let onset = cont.map_or(0.0, |c| *ends.get(&c).unwrap_or(&0.0));
        if let Some(t) = m.attrs.as_ref().and_then(|a| a.time.clone()) {
            time = t;
        }
        // 各元素的减时线条数（投影前的占位），自动分组用
        let levels: Vec<f64> = m
            .elements
            .iter()
            .map(|el| match el.beams() {
                Some(b) => b.len() as f64,
                None => match el {
                    Element::Chord(c) if c.grace.is_none() => {
                        grace_beam_levels(c.duration.kind.as_ref().map_or("", |t| t.as_str())).unwrap_or(0.0)
                    }
                    _ => 0.0,
                },
            })
            .collect();
        if let Some(k) = m.attrs.as_mut().and_then(|a| a.key.as_mut()) {
            k.fifths = key_fifths(k);
            fifths = k.fifths;
        }
        if let Some(clef) = m.attrs.as_ref().and_then(|a| a.clefs.as_ref()).and_then(|cs| cs.iter().find(|c| c.staff.unwrap_or(1.0) == 1.0)) {
            octave = clef.octave_change.unwrap_or(0.0);
        }
        let mut carry = cont.and_then(|c| carries.remove(&c)).unwrap_or_default();
        let mut staff_carry = cont.and_then(|c| staff_carries.remove(&c)).unwrap_or_else(|| StaffAccidentalCarry::new(fifths));
        let mut key = c_major();
        key.fifths = fifths;
        let mut dirs: Vec<Direction> = vec![];
        // 小节内各声部的时间游标（ABC `&` 的临时多声部各分支从小节起点重新计时）
        let mut cursors: Vec<(f64, f64)> = vec![];
        let get_cursor = |cursors: &Vec<(f64, f64)>, v: f64| cursors.iter().find(|(k, _)| *k == v).map(|(_, p)| *p);
        let set_cursor = |cursors: &mut Vec<(f64, f64)>, v: f64, p: f64| match cursors.iter_mut().find(|(k, _)| *k == v) {
            Some(e) => e.1 = p,
            None => cursors.push((v, p)),
        };
        let overlay = {
            let mut vs: Vec<js::NumKey> = vec![];
            for el in &m.elements {
                let v = js::NumKey::new(if el.voice() == 0.0 || el.voice().is_nan() { 1.0 } else { el.voice() });
                if !vs.contains(&v) {
                    vs.push(v);
                }
            }
            vs.len() > 1
        };
        let mut staff_marks: Vec<(f64, usize, usize)> = vec![];
        for (ei, el) in m.elements.iter_mut().enumerate() {
            let voice = if el.voice() > 1.0 { el.voice() } else { 1.0 };
            let mut pos = get_cursor(&cursors, voice).unwrap_or(0.0);
            match el {
                Element::Space(sp) => {
                    sp.voice = voice;
                    if overlay {
                        sp.onset = Some(pos);
                    }
                    if let Some(d) = &mut sp.duration {
                        d.divisions = js::round(d.divisions) * factor;
                        pos += d.divisions;
                    }
                    set_cursor(&mut cursors, voice, pos);
                    sp.beams = None;
                    continue;
                }
                Element::Chord(ch) => {
                    ch.voice = voice;
                    if overlay {
                        ch.onset = Some(pos);
                    }
                    for (ni, n) in ch.notes.iter_mut().enumerate() {
                        if n.pitch.is_none() {
                            if let Some(dg) = n.degree.as_ref().filter(|d| d.number > 0.0) {
                                let mut p = carry.pitch(dg, &key);
                                p.octave += octave;
                                n.pitch = Some(p);
                                staff_marks.push((pos, ei, ni));
                            }
                        }
                    }
                    if ch.grace.is_some() {
                        ch.duration.divisions = 0.0;
                        ch.beams = None;
                        if overlay {
                            ch.onset = None;
                        }
                        continue;
                    }
                    // 时值：48 分 → 放大后的 divisions；type/dots 按含增时线的名义时值重算；连音补比例
                    let nominal = js::round(ch.duration.divisions);
                    let r = ch.duration.time_mod.clone().or_else(|| {
                        tuplets.get(&ch.id).map(|&(actual, normal)| TimeMod { actual, normal, normal_type: None })
                    });
                    let (t, dots) = type_of_duration(&Fraction::new(nominal, SIMPLE_DIVISIONS));
                    let scaled = match &r {
                        Some(r) => (nominal * factor * r.normal) / r.actual,
                        None => nominal * factor,
                    };
                    ch.duration.divisions = js::round(scaled);
                    ch.duration.kind = Some(t);
                    ch.duration.dots = dots;
                    if let Some(r) = &r {
                        ch.duration.time_mod = Some(r.clone());
                    }
                    if !real_beams {
                        ch.beams = None;
                    }
                    // 增时线上的和弦：搬成 MusicXML 形状的 `laterHarmonies`（带 offset）
                    let n_sus = ch.sustains.as_ref().map_or(0, |s| s.len()) as f64;
                    let body_quarters = (nominal - n_sus * SIMPLE_DIVISIONS) / SIMPLE_DIVISIONS;
                    let ratio = r.as_ref().map_or(1.0, |r| r.normal / r.actual);
                    let mut later: Vec<Harmony> = vec![];
                    for (k, su) in ch.sustains.iter_mut().flatten().enumerate() {
                        let Some(mut h) = su.harmony.take() else { continue };
                        let off = (body_quarters + k as f64) * SIMPLE_DIVISIONS * factor * ratio;
                        h.offset = Some(js::round(off));
                        later.push(h);
                    }
                    if !later.is_empty() {
                        ch.later_harmonies.get_or_insert_with(Vec::new).extend(later);
                    }
                    project_ornaments(ch, &mut dirs, pos);
                    // 分行的几条各成一条 `<words>`，先写的在上
                    if let Some(sw) = &ch.section_word {
                        for line in sw.split('\n') {
                            if !line.is_empty() {
                                let mut d = Direction::of("words");
                                d.placement = Some(Placement::Above);
                                d.text = Some(line.to_owned());
                                push_dir(&mut dirs, pos, d);
                            }
                        }
                    }
                    let ly = lyrics_of(ch.lyrics.as_deref().unwrap_or(&[]));
                    ch.lyrics = if ly.is_empty() { None } else { Some(ly) };
                    pos += ch.duration.divisions;
                    set_cursor(&mut cursors, voice, pos);
                }
            }
        }
        js::sort_by(&mut staff_marks, |a, b| a.0 - b.0);
        for (_, ei, ni) in staff_marks {
            let Element::Chord(ch) = &mut m.elements[ei] else { continue };
            let n = &mut ch.notes[ni];
            let tied = n.tie.as_ref().is_some_and(|t| t.stop == Some(true));
            match staff_carry.mark(n.pitch.as_ref().unwrap(), tied) {
                Some(acc) => n.accidental = Some(acc),
                None => {
                    n.accidental = None;
                    n.accidental_parentheses = None;
                }
            }
        }
        // 小节长度取各分支最远的终点
        let pos = cursors.iter().fold(0.0, |a, (_, p)| js::max(a, *p));
        for b in m.barlines.iter().flatten() {
            for o in b.ornaments.iter().flatten() {
                if let Some(d) = direction_of(&o.name, o.below == Some(true)) {
                    push_dir(&mut dirs, if b.location == BarLocation::Left { 0.0 } else { pos }, d);
                }
            }
        }
        // 只挂记号的小节线在 MusicXML 里没有可写的内容
        if let Some(bars) = &mut m.barlines {
            bars.retain(|b| b.style.is_some() || b.repeat.is_some() || b.ending.is_some());
            if bars.is_empty() {
                m.barlines = None;
            }
        }
        if !dirs.is_empty() {
            m.directions.get_or_insert_with(Vec::new).extend(dirs);
        }
        ends.insert(m.oid, onset + pos);
        if !real_beams {
            let first = mi == 0 && second_cont != Some(m.oid);
            auto_beams(m, &levels, quarter, &time, first, onset);
        } else if id.pieces.contains(&m.oid) {
            close_beams(m);
        }
        let oid = m.oid;
        carries.insert(oid, carry);
        staff_carries.insert(oid, staff_carry);
    }
}

#[derive(Clone)]
struct BeamItem {
    el: usize,
    start: f64,
    dur: f64,
    level: f64,
    solid: bool,
    voice: f64,
}

/// 按拍自动写符杠：简谱的减时线就是五线谱的符杠（判据见 TS 同名函数）。
fn auto_beams(m: &mut Measure, levels: &[f64], quarter: f64, time: &Time, first: bool, onset: f64) {
    let beat = if time.beat_type >= 8.0 && time.beats % 3.0 == 0.0 {
        (quarter * 4.0 / time.beat_type) * 3.0
    } else {
        js::max(quarter * 4.0 / time.beat_type, quarter)
    };
    let mut items: Vec<BeamItem> = vec![];
    let mut cursors: Vec<(f64, f64)> = vec![];
    let mut pos = onset;
    for (i, el) in m.elements.iter().enumerate() {
        if !timed(el) {
            continue;
        }
        let voice = if el.voice() > 1.0 { el.voice() } else { 1.0 };
        let start = cursors.iter().find(|(v, _)| *v == voice).map_or(onset, |(_, p)| *p);
        let dur = el.duration().map_or(0.0, |d| d.divisions);
        let solid = matches!(el, Element::Chord(c) if c.rest.is_none() && c.print_object != Some(false));
        items.push(BeamItem { el: i, start, dur, level: levels[i], solid, voice });
        match cursors.iter_mut().find(|(v, _)| *v == voice) {
            Some(e) => e.1 = start + dur,
            None => cursors.push((voice, start + dur)),
        }
        pos = js::max(pos, start + dur);
    }
    let full = time.beats * quarter * 4.0 / time.beat_type;
    let shift = if first && pos > 0.0 && pos < full { full - pos } else { 0.0 };

    let mut groups: Vec<Vec<BeamItem>> = vec![];
    let mut cur_beat = -1.0;
    let mut cur_voice = 0.0;
    for it in &items {
        // ABC 的空白分组（`Chord.beamGroup`）说了算
        let bg = match &m.elements[it.el] {
            Element::Chord(c) => c.beam_group,
            _ => None,
        };
        let b = match bg {
            Some(g) => 1e6 + g,
            None => ((it.start + shift) / beat + 1e-9).floor(),
        };
        if it.level > 0.0 && it.dur <= beat {
            if b != cur_beat || it.voice != cur_voice || groups.is_empty() {
                groups.push(vec![]);
            }
            groups.last_mut().unwrap().push(it.clone());
            cur_beat = b;
            cur_voice = it.voice;
        } else {
            cur_beat = -1.0;
            cur_voice = 0.0;
        }
    }

    let mut out: HashMap<usize, Vec<BeamVal>> = HashMap::new();
    for g in &groups {
        let max_level = g.iter().fold(f64::NEG_INFINITY, |a, it| js::max(a, it.level));
        let mut level = 1.0;
        while level <= max_level {
            let mut i = 0;
            while i < g.len() {
                if g[i].level < level {
                    i += 1;
                    continue;
                }
                let mut j = i;
                while j + 1 < g.len() && g[j + 1].level >= level {
                    j += 1;
                }
                // 只有上一层连上了的实音才能往下一层连
                let solid: Vec<usize> = g[i..=j]
                    .iter()
                    .filter(|it| it.solid && (level == 1.0 || out.get(&it.el).map(|v| v.len() as f64) == Some(level - 1.0)))
                    .map(|it| it.el)
                    .collect();
                if solid.len() >= 2 {
                    let n = solid.len();
                    for (k, &e) in solid.iter().enumerate() {
                        let v = if k == 0 {
                            BeamVal::Begin
                        } else if k == n - 1 {
                            BeamVal::End
                        } else {
                            BeamVal::Continue
                        };
                        out.entry(e).or_default().push(v);
                    }
                } else if solid.len() == 1 && level > 1.0 {
                    let e = solid[0];
                    let upper = out[&e][(level - 2.0) as usize].clone();
                    let v = if upper == BeamVal::Begin || upper == BeamVal::ForwardHook { BeamVal::ForwardHook } else { BeamVal::BackwardHook };
                    out.entry(e).or_default().push(v);
                }
                i = j + 1;
            }
            level += 1.0;
        }
    }
    // **倚音另成一组**：同一声部里紧挨着的几颗倚音连一条符杠
    let grace_level = |el: &Element| -> f64 {
        match el {
            Element::Chord(c) => grace_beam_levels(c.duration.kind.as_ref().map_or("eighth", |t| t.as_str())).unwrap_or(0.0),
            _ => 0.0,
        }
    };
    let mut run: Vec<usize> = vec![];
    let flush = |run: &mut Vec<usize>, out: &mut HashMap<usize, Vec<BeamVal>>, els: &[Element]| {
        if run.len() >= 2 {
            let lv: Vec<f64> = run.iter().map(|&i| grace_level(&els[i])).collect();
            let max_level = lv.iter().fold(f64::NEG_INFINITY, |a, b| js::max(a, *b));
            let mut level = 1.0;
            while level <= max_level {
                for (k, &ch) in run.iter().enumerate() {
                    if lv[k] < level {
                        continue;
                    }
                    let prev_on = k > 0 && lv[k - 1] >= level;
                    let next_on = k + 1 < run.len() && lv[k + 1] >= level;
                    let v = if prev_on && next_on {
                        BeamVal::Continue
                    } else if prev_on {
                        BeamVal::End
                    } else if next_on {
                        BeamVal::Begin
                    } else if k > 0 {
                        BeamVal::BackwardHook
                    } else {
                        BeamVal::ForwardHook
                    };
                    out.entry(ch).or_default().push(v);
                }
                level += 1.0;
            }
        }
        run.clear();
    };
    for (i, el) in m.elements.iter().enumerate() {
        let is_grace = matches!(el, Element::Chord(c) if c.grace.is_some() && c.rest.is_none()) && grace_level(el) > 0.0;
        if is_grace {
            if let Some(&last) = run.last() {
                let v = |e: &Element| if e.voice() == 0.0 || e.voice().is_nan() { 1.0 } else { e.voice() };
                if v(&m.elements[last]) != v(el) {
                    flush(&mut run, &mut out, &m.elements);
                }
            }
            run.push(i);
        } else {
            flush(&mut run, &mut out, &m.elements);
        }
    }
    flush(&mut run, &mut out, &m.elements);
    for (i, el) in m.elements.iter_mut().enumerate() {
        let b = out.remove(&i);
        match el {
            Element::Chord(c) => c.beams = b,
            Element::Space(s) => s.beams = b,
        }
    }
}

/// 拆开的小节：符杠不能跨过切点。
fn close_beams(m: &mut Measure) {
    let beamed: Vec<usize> = (0..m.elements.len())
        .filter(|&i| matches!(&m.elements[i], Element::Chord(c) if c.beams.as_ref().is_some_and(|b| !b.is_empty())))
        .collect();
    let (Some(&head), Some(&tail)) = (beamed.first(), beamed.last()) else { return };
    if let Element::Chord(c) = &mut m.elements[head] {
        if let Some(b) = &c.beams {
            if b[0] != BeamVal::Begin {
                if b[0] == BeamVal::End {
                    c.beams = None;
                } else {
                    c.beams = Some(
                        b.iter()
                            .map(|v| match v {
                                BeamVal::Continue => BeamVal::Begin,
                                BeamVal::End => BeamVal::ForwardHook,
                                x => x.clone(),
                            })
                            .collect(),
                    );
                }
            }
        }
    }
    if let Element::Chord(c) = &mut m.elements[tail] {
        if let Some(b) = c.beams.as_ref().filter(|b| !b.is_empty()) {
            if b[0] != BeamVal::End {
                if b[0] == BeamVal::Begin {
                    c.beams = None;
                } else {
                    c.beams = Some(
                        b.iter()
                            .map(|v| match v {
                                BeamVal::Continue => BeamVal::End,
                                BeamVal::Begin => BeamVal::BackwardHook,
                                x => x.clone(),
                            })
                            .collect(),
                    );
                }
            }
        }
    }
}

/// 记号原名 → `<notations>` 与 `<direction>`；已经是 MusicXML 元素名的原样留下。
fn project_ornaments(ch: &mut Chord, dirs: &mut Vec<Direction>, pos: f64) {
    let names: Vec<String> = match ch.ornaments.as_ref().filter(|o| !o.is_empty()) {
        Some(o) => o.iter().map(|x| x.name.clone()).collect(),
        None => ch.notations.as_ref().and_then(|n| n.articulations.clone()).unwrap_or_default(),
    };
    let old = ch.notations.take().unwrap_or_default();
    let mut n = Notations::default();
    if old.fermata == Some(true) {
        n.fermata = Some(true);
    }
    if old.arpeggiate == Some(true) {
        n.arpeggiate = Some(true);
    }
    let mut artic: Vec<String> = vec![];
    let mut orn: Vec<String> = old.ornaments.clone().unwrap_or_default();
    let mut tech: Vec<String> = old.technical.clone().unwrap_or_default();
    if let Some(t) = old.tremolo.filter(|&t| t != 0.0 && !t.is_nan()) {
        n.tremolo = Some(t);
    }
    let push_uniq = |v: &mut Vec<String>, s: &str| {
        if !v.iter().any(|x| x == s) {
            v.push(s.to_owned());
        }
    };
    for name in &names {
        if let Some(s) = tremolo_strokes(name).filter(|&s| s > 0) {
            n.tremolo = Some(s as f64);
            continue;
        }
        if let Some(head) = notehead_of(name) {
            for nt in &mut ch.notes {
                nt.notehead = Some(head.clone());
            }
            continue;
        }
        if let Some(mark) = rehearsal_of(name) {
            let mut d = Direction::of("rehearsal");
            d.placement = Some(Placement::Above);
            d.text = Some(mark);
            push_dir(dirs, pos, d);
            continue;
        }
        let key: String = if XML_ARTICULATIONS.contains(&name.as_str()) || XML_ORNAMENTS.contains(&name.as_str()) {
            name.clone()
        } else {
            deco_key(name).map_or_else(|| name.clone(), str::to_owned)
        };
        if is_fermata(&key) {
            n.fermata = Some(true);
            continue;
        }
        if key == "arp" {
            n.arpeggiate = Some(true);
            continue;
        }
        if let Some(a) = lookup(ARTICULATION, &key).or_else(|| XML_ARTICULATIONS.iter().find(|x| **x == key).copied()) {
            push_uniq(&mut artic, a);
            continue;
        }
        if let Some(o) = lookup(ORNAMENT_TAG, &key).or_else(|| XML_ORNAMENTS.iter().find(|x| **x == key).copied()) {
            push_uniq(&mut orn, o);
            continue;
        }
        if let Some(tk) = lookup(TECHNICAL, &key) {
            push_uniq(&mut tech, tk);
            continue;
        }
        // 归一后再查：123 的 `!coda!` `!segno!` 挂在音符上时是 ABC 名
        if let Some(d) = direction_of(&key, false) {
            push_dir(dirs, pos, d);
        }
    }
    if !artic.is_empty() {
        n.articulations = Some(artic);
    }
    if !orn.is_empty() {
        n.ornaments = Some(orn);
    }
    if !tech.is_empty() {
        n.technical = Some(tech);
    }
    if n.fermata.is_some() || n.arpeggiate.is_some() || n.articulations.is_some() || n.ornaments.is_some() || n.technical.is_some() || n.tremolo.is_some() {
        ch.notations = Some(n);
    }
}

/// 力度、术语、伴奏括弧、跳转记号 → `<direction>`。
fn direction_of(name: &str, below: bool) -> Option<Direction> {
    let mk = |kind: &str, placement: Placement, text: Option<&str>| {
        let mut d = Direction::of(kind);
        d.placement = Some(placement);
        d.text = text.map(str::to_owned);
        d
    };
    let side = if below { Placement::Below } else { Placement::Above };
    if is_dynamic_name(name) {
        return Some(mk("dynamics", Placement::Below, Some(name)));
    }
    if let Some(t) = term_text(name) {
        return Some(mk("words", Placement::Above, Some(t)));
    }
    if name == "zkh" || name == "ykh" {
        let mut d = mk("bracket", Placement::Above, None);
        d.span_type = Some(if name == "zkh" { SpanType::Start } else { SpanType::Stop });
        return Some(d);
    }
    if name == "fine" {
        let mut d = mk("words", side, Some("Fine"));
        d.sound = Some(Sound { fine: Some(true), ..Default::default() });
        return Some(d);
    }
    if name == "dc" {
        let mut d = mk("words", side, Some("D.C."));
        d.sound = Some(Sound { dacapo: Some(true), ..Default::default() });
        return Some(d);
    }
    if name == "ds" {
        let mut d = mk("words", side, Some("D.S."));
        d.sound = Some(Sound { dalsegno: Some("1".into()), ..Default::default() });
        return Some(d);
    }
    if name == "ty" {
        return Some(mk("coda", Placement::Above, None));
    }
    if name == "hs" {
        return Some(mk("segno", Placement::Above, None));
    }
    None
}

/// 段号区间展开成逐段的 `<lyric>`；空字不写。副歌行写一条。
fn lyrics_of(lyrics: &[Lyric]) -> Vec<Lyric> {
    let mut out = vec![];
    for l in distinct_numbers(lyrics) {
        if l.text.is_empty() {
            continue;
        }
        match l.number_to {
            Some(to) if l.refrain != Some(true) => {
                let mut v = l.number;
                while v <= to {
                    out.push(Lyric { number: v, number_to: None, ..l.clone() });
                    v += 1.0;
                }
            }
            _ => out.push(l),
        }
    }
    out
}
