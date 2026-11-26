//! ABC 家族文本 → `ScoreDoc`（同 `abcfamily/parse.ts`）。规范见 `docs/格式/123格式.md`。
//!
//! 分工：词法在 `lex`，字段与指令在 `fields`，**本文件只做组装**——小节切分、时值累计、符杠分组、Mark 配对、歌词对位。
//! 判据照 TS 原文（改之前先读那边的注释）：123 的空白不表示符杠分组、歌词 CJK 连写逐字成音节、`(N:` 的冒号必需、
//! 认不出的东西一律报诊断继续往下。
//!
//! TS 靠对象身份串起来的几处在这里改成按号找：和弦按元素 id 在声部里倒着找（`find`），
//! 换行记在哪一小节按「小节在声部里的下标」记（当前小节的下标就是它将来被推进去的位置），歌词块放在一张表里按下标引用。

use super::abcpitch::resolve_abc_pitches;
use super::dialect::{type_and_dots, DefaultLen};
use super::fields::{
    cjk_instruction_alias, jump_ornament_name, parse_field_line, parse_instruction, parse_layout, layout_base, parse_linebreak, parse_sing, parse_tempo,
    parse_tempo_beat, parse_time, parse_times, parse_voice_clef, FieldLine, Instruction, TempoPart,
};
use super::lex::{Dialect, Lexer};
use super::lyricline::parse_lyric_line;
use super::lyricslot::{is_lyric_slot, lyric_slots, LyricSlotRule};
use super::token::{Token, TokenKind};
use super::u16s::{self, U16};
use crate::base::js::{self, num_to_string, NumKey};
use crate::base::{Msg, SourceSpan};
use crate::helpers::{breaks_after_to_start, empty_doc, empty_song, IdGen, ZERO_SPAN};
use crate::jianpu::clef_from_name;
use crate::metakeys::{add_meta, creator_of, is_meta_key};
use crate::sections::{expand_section_order, looks_like_order};
use crate::tuplets::apply_tuplet_time_mods_default;
use crate::*;
use std::collections::HashMap;

// ───────────────────────── 组装期状态 ─────────────────────────

/// 歌词块：一行曲（到 `$` 换行为止的连续音乐行），紧跟其后的 `w` 行从块的第一个对位格起对位（规范 §5.1）
struct LyricBlock {
    start: usize,
    end: Option<usize>,
    cursor: HashMap<NumKey, usize>,
    verses: f64,
    last_verse: Option<f64>,
    broken: bool,
}

impl LyricBlock {
    fn at(start: usize) -> LyricBlock {
        LyricBlock { start, end: None, cursor: HashMap::new(), verses: 0.0, last_verse: None, broken: false }
    }
}

#[derive(Clone)]
struct OpenMark {
    /// 0 = 还没遇到第一个元素，等 `attach` 回填
    start: ElementId,
    level: f64,
    tuplet_actual: Option<f64>,
    tuplet_normal: Option<f64>,
    remaining: Option<f64>,
    abc_deco: bool,
    open_source: Option<SourceSpan>,
    wedge_type: Option<WedgeType>,
}

impl OpenMark {
    fn new(level: f64, open_source: SourceSpan) -> OpenMark {
        OpenMark {
            start: 0,
            level,
            tuplet_actual: None,
            tuplet_normal: None,
            remaining: None,
            abc_deco: false,
            open_source: Some(open_source),
            wedge_type: None,
        }
    }
    /// `(` 在原文里的位置
    fn offset(&self) -> f64 {
        self.open_source.map_or(-1.0, |s| s.offset as f64)
    }
}

#[derive(Default)]
struct Pending {
    chord: Option<String>,
    annotations: Vec<String>,
    decos: Vec<String>,
    srcs: Vec<AttachedSource>,
}

#[derive(Clone)]
struct InlineBreak {
    host: ElementId,
    sustains: usize,
    kind: BreakKind,
}

#[derive(Clone)]
struct NoteTie {
    from: ElementId,
    note: usize,
    source: SourceSpan,
}

#[derive(Clone)]
struct BranchArcs {
    slurs: Vec<OpenMark>,
    arc_next: Option<(ElementId, SourceSpan)>,
    note_ties: Vec<NoteTie>,
    abc_tie: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MuseStyle {
    Jianpu,
    Staff,
    Skip,
}

/// 一个声部在组装期的累积状态
struct PartBuild {
    part: Part,
    measure: Measure,
    measure_no: f64,
    voice: f64,
    overlay_source: Option<SourceSpan>,
    open_slurs: Vec<OpenMark>,
    open_tuplets: Vec<OpenMark>,
    pending: Pending,
    open_ending: Vec<(Vec<f64>, f64)>,
    /// 当前歌词块（`Parser.blocks` 的下标）
    block: Option<usize>,
    after_lyrics: bool,
    inline_break: Option<InlineBreak>,
    extra_rest_bars: Option<f64>,
    clef: Option<Clef>,
    arc_next: Option<(ElementId, SourceSpan)>,
    note_ties: Vec<NoteTie>,
    abc_tie: bool,
    /// 分支号 → 存下的弧状态（按 TS `Map` 的插入次序）
    branch_arcs: Vec<(f64, BranchArcs)>,
    open_wedges: Vec<OpenMark>,
    wedge_close_next: Vec<(WedgeType, SourceSpan)>,
    len: Option<DefaultLen>,
    muse_style: Option<MuseStyle>,
    /// 换行记在哪一小节**之后**（小节在声部里的下标）
    break_after: HashMap<usize, BreakKind>,
}

impl PartBuild {
    fn new(voice: f64) -> PartBuild {
        PartBuild {
            part: Part { id: format!("P{}", num_to_string(voice)), ..Default::default() },
            measure: Measure { number: "1".into(), ..Default::default() },
            measure_no: 1.0,
            voice: 1.0,
            overlay_source: None,
            open_slurs: vec![],
            open_tuplets: vec![],
            pending: Pending::default(),
            open_ending: vec![],
            block: None,
            after_lyrics: false,
            inline_break: None,
            extra_rest_bars: None,
            clef: None,
            arc_next: None,
            note_ties: vec![],
            abc_tie: false,
            branch_arcs: vec![],
            open_wedges: vec![],
            wedge_close_next: vec![],
            len: None,
            muse_style: None,
            break_after: HashMap::new(),
        }
    }

    /// 当前小节将来在 `part.measures` 里的下标
    fn cur_index(&self) -> usize {
        self.part.measures.len()
    }

    /// 按 id 找和弦（先当前小节，再往前的小节，都倒着找）
    fn chord_mut(&mut self, id: ElementId) -> Option<&mut Chord> {
        let find = |els: &mut Vec<Element>| -> Option<usize> { els.iter().rposition(|e| e.id() == id) };
        if let Some(k) = find(&mut self.measure.elements) {
            return self.measure.elements[k].as_chord_mut();
        }
        for m in self.part.measures.iter_mut().rev() {
            if let Some(k) = find(&mut m.elements) {
                return m.elements[k].as_chord_mut();
            }
        }
        None
    }

    fn chord(&self, id: ElementId) -> Option<&Chord> {
        if let Some(e) = self.measure.elements.iter().rev().find(|e| e.id() == id) {
            return e.as_chord();
        }
        for m in self.part.measures.iter().rev() {
            if let Some(e) = m.elements.iter().rev().find(|e| e.id() == id) {
                return e.as_chord();
            }
        }
        None
    }

    /// 切到第 `to` 个分支：当前分支开着的弧存下，换上 `to` 上回存下的
    fn switch_branch(&mut self, to: f64) {
        if to == self.voice {
            return;
        }
        if !self.open_slurs.is_empty() || self.arc_next.is_some() || !self.note_ties.is_empty() || self.abc_tie {
            let s = BranchArcs {
                slurs: self.open_slurs.clone(),
                arc_next: self.arc_next,
                note_ties: self.note_ties.clone(),
                abc_tie: self.abc_tie,
            };
            if let Some(e) = self.branch_arcs.iter_mut().find(|(k, _)| *k == self.voice) {
                e.1 = s;
            } else {
                self.branch_arcs.push((self.voice, s));
            }
        }
        let s = self.branch_arcs.iter().position(|(k, _)| *k == to).map(|p| self.branch_arcs.remove(p).1);
        self.open_slurs.clear();
        if let Some(s) = &s {
            self.open_slurs.extend(s.slurs.iter().cloned());
        }
        self.arc_next = s.as_ref().and_then(|s| s.arc_next);
        self.note_ties = s.as_ref().map_or(vec![], |s| s.note_ties.clone());
        self.abc_tie = s.as_ref().is_some_and(|s| s.abc_tie);
    }

    /// 见到 `$`（或 ABC 的代码行末）：当前小节已有和弦时先记下
    fn note_inline_break(&mut self, kind: BreakKind) {
        self.inline_break = match self.measure.elements.last() {
            Some(Element::Chord(c)) => Some(InlineBreak { host: c.id, sustains: c.sustains.as_ref().map_or(0, |s| s.len()), kind }),
            _ => None,
        };
    }

    /// 声部里到目前为止的最后一个元素
    fn last_element_id(&self) -> Option<ElementId> {
        if let Some(e) = self.measure.elements.last() {
            return Some(e.id());
        }
        for m in self.part.measures.iter().rev() {
            if let Some(e) = m.elements.last() {
                return Some(e.id());
            }
        }
        None
    }

    /// `$` 的语义是「这一小节之后换行」：当前小节空着时赋给刚收尾的那一个
    fn break_target(&self) -> usize {
        if !self.measure.elements.is_empty() || self.part.measures.is_empty() {
            self.cur_index()
        } else {
            self.part.measures.len() - 1
        }
    }

    /// ABC 的 `%%newpage` 用：当前小节有元素就是它，否则上一个收尾的（没有就没有）
    fn line_target(&self) -> Option<usize> {
        if !self.measure.elements.is_empty() {
            Some(self.cur_index())
        } else {
            self.part.measures.len().checked_sub(1)
        }
    }
}

struct Ctx {
    ids: IdGen,
    diagnostics: Vec<Diagnostic>,
    d: Dialect,
    len: DefaultLen,
    saw_l: bool,
    time: Option<Time>,
    /// 曲中换拍号：从声部里第几小节起（`PartBuild::cur_index`）换成什么。各声部一行一行轮流读，
    /// `time` 是最后读到的那次——上一个声部行尾的 `[M:3/4]` 还没轮到本声部；按小节定拍号的（`Z` 的时值）查这张表
    time_changes: Vec<(usize, Time)>,
    pending_sections: Vec<String>,
    section_marks: Vec<SectionMark>,
    blocks: Vec<LyricBlock>,
}

impl Ctx {
    fn report(&mut self, code: &str, msg: Msg, source: SourceSpan) {
        self.diagnostics.push(Diagnostic { severity: DiagnosticSeverity::Warning, code: code.into(), msg, source });
    }
    /// 声部第 `at` 小节的拍号：表里（曲首的 `M:` 记在第 0 小节）在它之前（含）最晚的那次换拍号
    fn time_at(&self, at: usize) -> Option<&Time> {
        if self.time_changes.is_empty() {
            return self.time.as_ref();
        }
        let mut best: Option<&(usize, Time)> = None;
        for c in &self.time_changes {
            if c.0 <= at && best.is_none_or(|b| c.0 >= b.0) {
                best = Some(c);
            }
        }
        best.map(|c| &c.1)
    }
    fn time_pair(&self, at: usize) -> Option<(f64, f64)> {
        self.time_at(at).map(|t| (t.beats, t.beat_type))
    }
    fn slot_rule(&self) -> LyricSlotRule {
        if self.d.lyric_slot_123() { LyricSlotRule::J123 } else { LyricSlotRule::Abc }
    }
    /// 声部里到目前为止的对位格数（含还没收尾的小节）
    fn slot_count(&self, pb: &PartBuild) -> usize {
        let rule = self.slot_rule();
        let mut n = 0;
        for m in pb.part.measures.iter().chain(std::iter::once(&pb.measure)) {
            for el in &m.elements {
                if is_lyric_slot(el, rule, 1.0) {
                    n += 1;
                }
            }
        }
        n
    }
    fn new_block(&mut self, start: usize) -> usize {
        self.blocks.push(LyricBlock::at(start));
        self.blocks.len() - 1
    }
}

/// 123 在这里记一处换行或换页（`$` 与没写 `$` 的 `%%newpage`）
fn mark_break(ctx: &mut Ctx, pb: &mut PartBuild, kind: BreakKind, source: SourceSpan) {
    let t = pb.break_target();
    pb.break_after.insert(t, kind.clone());
    let after = pb.last_element_id();
    pb.part.break_sources.get_or_insert_with(Vec::new).push(BreakSource { page: kind == BreakKind::Page, after, source });
    pb.note_inline_break(kind);
    if let Some(b) = pb.block {
        ctx.blocks[b].broken = true;
    }
}

/// 123 的 `%%newpage`：紧跟 `$`（中间只隔歌词行）就把那处换行升成换页
fn upgrade_break_to_page(pb: &mut PartBuild) -> bool {
    let last = pb.last_element_id();
    let Some(src) = pb.part.break_sources.as_mut().and_then(|v| v.last_mut()) else { return false };
    if src.after != last {
        return false;
    }
    src.page = true;
    let t = pb.break_target();
    pb.break_after.insert(t, BreakKind::Page);
    if let Some(ib) = pb.inline_break.as_mut() {
        ib.kind = BreakKind::Page;
    }
    true
}

/// ABC 的 `%%newpage`：这个声部最近一处换行改成换页
fn break_to_page(pb: &mut PartBuild) {
    if let Some(t) = pb.line_target() {
        if pb.break_after.contains_key(&t) {
            pb.break_after.insert(t, BreakKind::Page);
        }
    }
    if let Some(ib) = pb.inline_break.as_mut() {
        ib.kind = BreakKind::Page;
    }
}

/// 小节线归一名 → MusicXML 的 bar-style + repeat
fn barline_from(value: &str, times: Option<f64>, source: SourceSpan) -> Barline {
    let mut b = Barline::at(BarLocation::Right);
    b.source = Some(source);
    let (style, repeat) = match value {
        "normal" => (BarStyle::Regular, None),
        "double" => (BarStyle::LightLight, None),
        "final" => (BarStyle::LightHeavy, None),
        "reverse-final" => (BarStyle::HeavyLight, None),
        "dotted" => (BarStyle::Dotted, None),
        "none" => (BarStyle::NoStyle, None),
        "repeat-start" => (BarStyle::HeavyLight, Some(RepeatDir::Forward)),
        "repeat-end" => (BarStyle::LightHeavy, Some(RepeatDir::Backward)),
        "repeat-both" => (BarStyle::LightHeavy, Some(RepeatDir::Backward)),
        "heavy-light" => (BarStyle::HeavyLight, Some(RepeatDir::Forward)),
        "light-heavy" => (BarStyle::LightHeavy, Some(RepeatDir::Backward)),
        _ => (BarStyle::Regular, None),
    };
    b.style = Some(style);
    b.repeat = repeat;
    if let Some(t) = times {
        if t != 0.0 && !t.is_nan() {
            b.repeat_times = Some(t);
        }
    }
    b
}

/// 一整小节的时值（`Z` 用）
fn whole_measure(time: Option<&Time>) -> Duration {
    let (beats, beat_type) = time.map_or((4.0, 4.0), |t| (t.beats, t.beat_type));
    let mut d = Duration { divisions: (SIMPLE_DIVISIONS * 4.0 * beats) / beat_type, kind: None, dots: 0.0, time_mod: None };
    if beats == beat_type {
        d.kind = Some(NoteType::Whole);
    }
    d
}

/// 倚音的印刷时值：相对倚音单位（八分）
fn grace_type(g: Option<&Token>) -> Option<NoteType> {
    let mut g = g;
    if let Some(t) = g {
        if t.kind == TokenKind::ChordGroup && t.num.is_none() {
            g = t.notes.as_ref().and_then(|n| n.first());
        }
    }
    let num = g.and_then(|t| t.num).unwrap_or(1.0);
    let den = g.and_then(|t| t.den).unwrap_or(1.0);
    let beams = g.and_then(|t| t.beams).unwrap_or(0);
    let ratio = num / den / 2f64.powi(beams as i32);
    let k = js::round(ratio.log2());
    let idx = js::max(0.0, js::min(5.0, k + 3.0));
    if idx.is_nan() {
        return None;
    }
    Some([NoteType::N64th, NoteType::N32nd, NoteType::N16th, NoteType::Eighth, NoteType::Quarter, NoteType::Half][idx as usize].clone())
}

fn new_chord(id: ElementId, voice: f64, duration: Duration, source: SourceSpan) -> Chord {
    Chord { id, notes: vec![], duration, voice, staff: 1.0, source: Some(source), ..Default::default() }
}

fn harmony_of(text: String) -> Harmony {
    Harmony { root: HarmonyStep { step: "C".into(), alter: 0.0, alter_left: None }, kind: String::new(), text: Some(text), ..Default::default() }
}

fn continue_beams(n: u32) -> Option<Vec<BeamVal>> {
    (n > 0).then(|| (0..n).map(|_| BeamVal::Continue).collect())
}

fn join_nums(nums: &[f64]) -> String {
    nums.iter().map(|&n| num_to_string(n)).collect::<Vec<_>>().join(",")
}

fn is_fermata(d: &str) -> bool {
    d.eq_ignore_ascii_case("fermata")
}

// ───────────────────────── 一行音乐 ─────────────────────────

struct ArcEnd {
    mark: usize,
    host: ElementId,
    su: ElementId,
}

struct Cur {
    last: Option<ElementId>,
    last_grace: Option<ElementId>,
    sustain_host: Option<ElementId>,
    just_closed_tuplet: bool,
    arc_ends: Vec<ArcEnd>,
    pending_broken: i32,
    beam_group: f64,
    saw_space: bool,
}

/// 收一条渐强渐弱：配同类型最近开的那条，收在 `end` 上
fn close_wedge(ctx: &mut Ctx, pb: &mut PartBuild, marks: &mut Vec<Mark>, kind: WedgeType, end: Option<ElementId>, source: SourceSpan, abc: bool) {
    let k = pb.open_wedges.iter().rposition(|o| o.wedge_type.as_ref() == Some(&kind));
    let open = k.map(|k| pb.open_wedges.remove(k));
    match (open, end) {
        (Some(o), Some(end)) if o.start != 0 => {
            let mut mk = Mark::new(MarkType::Wedge, o.start, end);
            mk.wedge_type = Some(kind);
            mk.open_source = o.open_source;
            mk.close_source = Some(source);
            marks.push(mk);
        }
        _ => ctx.report("unmatched-wedge", Msg::new(if abc { "diag.abc.wedge" } else { "diag.jcx.wedge" }), source),
    }
}

/// ABC：结算欠着的 tie 与破碎节奏（123 永远不会触发）
fn apply_tie_and_broken(ctx: &Ctx, pb: &mut PartBuild, cur: &mut Cur, ch: &mut Chord) {
    if pb.abc_tie {
        for n in ch.notes.iter_mut() {
            n.tie.get_or_insert_with(Tie::default).stop = Some(true);
        }
        pb.abc_tie = false;
    }
    if cur.pending_broken != 0 {
        let Some(prev_id) = cur.sustain_host else { return };
        let Some(prev_div) = pb.chord(prev_id).map(|c| c.duration.divisions) else { return };
        let k = cur.pending_broken.unsigned_abs();
        let f = 1.0 / (1i32.wrapping_shl(k) as f64);
        let fwd = cur.pending_broken > 0;
        let (long_div, short_div) = if fwd { (prev_div, ch.duration.divisions) } else { (ch.duration.divisions, prev_div) };
        let lo = js::round(long_div * (2.0 - f));
        let sh = js::round((if ctx.d.broken_from_long() { long_div } else { short_div }) * f);
        let set = |d: &mut Duration, v: f64| {
            let (kind, dots) = type_and_dots(v);
            d.divisions = v;
            d.kind = Some(kind);
            d.dots = dots;
        };
        let (prev_v, ch_v) = if fwd { (lo, sh) } else { (sh, lo) };
        if let Some(p) = pb.chord_mut(prev_id) {
            set(&mut p.duration, prev_v);
        }
        set(&mut ch.duration, ch_v);
        cur.pending_broken = 0;
    }
}

/// 元素落进小节：欠着的和弦记号、注记、装饰挂上去，回填开着的弧与连音的起点
fn attach(ctx: &mut Ctx, pb: &mut PartBuild, cur: &mut Cur, marks: &mut Vec<Mark>, mut el: Element) {
    if let Some(c) = pb.pending.chord.take() {
        let h = Some(harmony_of(c));
        match &mut el {
            Element::Chord(c) => c.harmony = h,
            Element::Space(s) => s.harmony = h,
        }
    }
    if !pb.pending.annotations.is_empty() {
        let text = pb.pending.annotations.join("\n");
        if let Element::Chord(c) = &mut el {
            c.section_word = Some(text);
        }
        pb.pending.annotations.clear();
    }
    if !pb.pending.decos.is_empty() {
        let fermata = pb.pending.decos.iter().any(|d| is_fermata(d));
        let arts: Vec<String> = pb.pending.decos.iter().filter(|d| !is_fermata(d)).cloned().collect();
        let nt = Some(Notations {
            fermata: fermata.then_some(true),
            articulations: (!arts.is_empty()).then_some(arts),
            ..Default::default()
        });
        match &mut el {
            Element::Chord(c) => c.notations = nt,
            Element::Space(s) => s.notations = nt,
        }
        pb.pending.decos.clear();
    }
    if !pb.pending.srcs.is_empty() {
        let srcs: Vec<AttachedSource> = match &el {
            Element::Chord(_) => std::mem::take(&mut pb.pending.srcs),
            Element::Space(_) => pb.pending.srcs.drain(..).filter(|a| a.kind != AttachedKind::Annotation).collect(),
        };
        if !srcs.is_empty() {
            match &mut el {
                Element::Chord(c) => c.attached_sources = Some(srcs),
                Element::Space(s) => s.attached_sources = Some(srcs),
            }
        }
        pb.pending.srcs.clear();
    }
    // 上一个 `$` 后面同一小节里又来了音符：小节中间换行，在原位记一份
    if let Some(ib) = pb.inline_break.take() {
        if let Some(host) = pb.chord_mut(ib.host) {
            let n = host.sustains.as_ref().map_or(0, |s| s.len());
            if n > ib.sustains && ib.sustains > 0 {
                host.sustains.as_mut().unwrap()[ib.sustains - 1].line_break_after = Some(ib.kind);
            } else {
                host.line_break_after = Some(ib.kind);
            }
        }
    }
    // 123：`$` 同时结束这一批歌词
    if ctx.d.break_ends_lyric_block() {
        if let Some(b) = pb.block {
            if ctx.blocks[b].broken {
                let at = ctx.slot_count(pb);
                ctx.blocks[b].end = Some(at);
                pb.block = Some(ctx.new_block(at));
                pb.after_lyrics = false;
            }
        }
    }
    let id = el.id();
    let (is_chord, is_grace) = match &el {
        Element::Chord(c) => (true, c.grace.is_some()),
        Element::Space(_) => (false, false),
    };
    if is_chord && !ctx.pending_sections.is_empty() {
        for name in std::mem::take(&mut ctx.pending_sections) {
            ctx.section_marks.push(SectionMark { name, before: id });
        }
    }
    pb.measure.elements.push(el);
    cur.last = Some(id);
    cur.last_grace = None;
    // 123 的 `~`：弧从前一个音连到这个音（倚音不算「下一个音」）
    if is_chord && !is_grace {
        if let Some((from, src)) = pb.arc_next.take() {
            let mut mk = Mark::new(MarkType::Slur, from, id);
            mk.level = Some(pb.open_slurs.len() as f64);
            mk.open_source = Some(src);
            marks.push(mk);
        }
    }
    if !pb.note_ties.is_empty() && is_chord && !is_grace {
        let ties = std::mem::take(&mut pb.note_ties);
        for nt in ties {
            let Some(a) = pb.chord(nt.from).and_then(|c| c.notes.get(nt.note)).cloned() else { continue };
            let el_notes = &pb.measure.elements.last().unwrap().as_chord().unwrap().notes;
            let j = el_notes.iter().position(|b| match (&a.degree, &b.degree) {
                (Some(ad), Some(bd)) => {
                    ad.number == bd.number && ad.octave_shift == bd.octave_shift && bd.accidental.as_ref().or(ad.accidental.as_ref()) == ad.accidental.as_ref()
                }
                _ => match (&a.pitch, &b.pitch) {
                    (Some(ap), Some(bp)) => ap.step == bp.step && ap.octave == bp.octave,
                    _ => false,
                },
            });
            let Some(j) = j else {
                ctx.report("chord-tie-no-match", Msg::new("diag.j123.chordTieNoMatch"), nt.source);
                continue;
            };
            if let Some(n) = pb.chord_mut(nt.from).and_then(|c| c.notes.get_mut(nt.note)) {
                n.tie.get_or_insert_with(Tie::default).start = Some(true);
            }
            if let Some(Element::Chord(c)) = pb.measure.elements.last_mut() {
                c.notes[j].tie.get_or_insert_with(Tie::default).stop = Some(true);
            }
            if ctx.d == Dialect::J123 {
                let mut mk = Mark::new(MarkType::Tied, nt.from, id);
                mk.start_note = Some(nt.note as f64);
                mk.end_note = Some(j as f64);
                marks.push(mk);
            }
        }
    }
    // 回填还没拿到起点的开弧/开连音
    for o in pb.open_slurs.iter_mut().chain(pb.open_tuplets.iter_mut()).chain(pb.open_wedges.iter_mut()) {
        if o.start == 0 {
            o.start = id;
        }
    }
    if !pb.wedge_close_next.is_empty() && !(is_chord && is_grace) {
        for (kind, src) in std::mem::take(&mut pb.wedge_close_next) {
            close_wedge(ctx, pb, marks, kind, Some(id), src, true);
        }
    }
}

/// 写在第 `voice` 支此刻的东西，在第一支里排在第几个元素之后
fn main_elements_before(m: &Measure, voice: f64) -> f64 {
    let len = |el: &Element| -> f64 {
        match el {
            Element::Chord(c) => {
                if c.grace.is_some() {
                    0.0
                } else {
                    c.duration.divisions
                }
            }
            Element::Space(s) => s.duration.as_ref().map_or(0.0, |d| d.divisions),
        }
    };
    if voice == 1.0 {
        return m.elements.len() as f64;
    }
    let t: f64 = m.elements.iter().filter(|el| el.voice() == voice).fold(0.0, |a, el| a + len(el));
    let (mut k, mut end) = (0.0, 0.0);
    for el in &m.elements {
        if el.voice() != 1.0 || end + len(el) > t {
            break;
        }
        end += len(el);
        k += 1.0;
    }
    k
}

/// 小节收尾：推进到下一小节。空小节（连续两根小节线）不产生
fn close_measure(ctx: &mut Ctx, pb: &mut PartBuild) {
    if pb.measure.elements.is_empty() && pb.measure.barlines.as_ref().is_none_or(|b| b.is_empty()) {
        return;
    }
    if pb.voice > 1.0 {
        if let Some(src) = pb.overlay_source {
            if !pb.measure.elements.iter().any(|el| el.voice() == pb.voice) {
                ctx.report("empty-overlay", Msg::new("diag.j123.overlayAfter"), src);
            }
        }
    }
    pb.overlay_source = None;
    let head_idx = pb.part.measures.len();
    let measure = std::mem::take(&mut pb.measure);
    pb.part.measures.push(measure);
    pb.measure_no += 1.0;
    let extra = pb.extra_rest_bars.take().unwrap_or(0.0);
    if extra > 0.0 {
        let head = &mut pb.part.measures[head_idx];
        let bls = head.barlines.take().unwrap_or_default();
        let right: Vec<Barline> = bls.iter().filter(|b| b.location == BarLocation::Right).cloned().collect();
        let mut kept: Vec<Barline> = bls.into_iter().filter(|b| b.location != BarLocation::Right).collect();
        let mut regular = Barline::at(BarLocation::Right);
        regular.style = Some(BarStyle::Regular);
        kept.push(regular.clone());
        head.barlines = Some(kept);
        let rest_dur = head.elements.iter().find_map(|el| match el {
            Element::Chord(c) if c.rest.as_ref().is_some_and(|r| r.measure == Some(true)) => Some(c.duration.clone()),
            _ => None,
        });
        let mut k = 0.0;
        while k < extra {
            let dur = rest_dur.clone().unwrap_or_else(|| whole_measure(ctx.time.as_ref()));
            let ch = Chord {
                id: ctx.ids.next(),
                rest: Some(RestInfo { measure: Some(true), ..Default::default() }),
                duration: dur,
                voice: 1.0,
                staff: 1.0,
                ..Default::default()
            };
            let last = k == extra - 1.0;
            let m = Measure {
                number: num_to_string(pb.measure_no),
                elements: vec![Element::Chord(ch)],
                barlines: Some(if last && !right.is_empty() { right.clone() } else { vec![regular.clone()] }),
                ..Default::default()
            };
            pb.part.measures.push(m);
            pb.measure_no += 1.0;
            k += 1.0;
        }
    }
    pb.measure = Measure { number: num_to_string(pb.measure_no), ..Default::default() };
    pb.switch_branch(1.0);
    pb.voice = 1.0;
}

/// 把一行音乐体的 token 组装进声部
fn build_music_line(ctx: &mut Ctx, pb: &mut PartBuild, tokens: &[Token], marks: &mut Vec<Mark>) {
    let mut cur = Cur {
        last: None,
        last_grace: None,
        sustain_host: None,
        just_closed_tuplet: false,
        arc_ends: vec![],
        pending_broken: 0,
        beam_group: 0.0,
        saw_space: true,
    };
    let count_close = !ctx.d.tuplet_close_paren();
    for t in tokens {
        match t.kind {
            TokenKind::Space => cur.saw_space = true,

            TokenKind::Note => {
                cur.just_closed_tuplet = false;
                if cur.saw_space {
                    cur.beam_group += 1.0;
                }
                cur.saw_space = false;
                let rest = ctx.d.is_rest(t);
                let mut ch = new_chord(ctx.ids.next(), pb.voice, ctx.d.duration(t, ctx.len, 0), t.source);
                if rest {
                    ch.rest = Some(RestInfo::default());
                } else {
                    ch.notes.push(ctx.d.note(t));
                }
                ch.beams = continue_beams(t.beams.unwrap_or(0));
                if ctx.d.space_beams() && !rest {
                    ch.beam_group = Some(cur.beam_group);
                }
                apply_tie_and_broken(ctx, pb, &mut cur, &mut ch);
                let id = ch.id;
                attach(ctx, pb, &mut cur, marks, Element::Chord(ch));
                cur.sustain_host = Some(id);
                if count_close {
                    let mut k = pb.open_tuplets.len();
                    while k > 0 {
                        k -= 1;
                        let tp = &mut pb.open_tuplets[k];
                        let r = tp.remaining.unwrap_or(0.0) - 1.0;
                        tp.remaining = Some(r);
                        if r <= 0.0 {
                            if tp.start != 0 {
                                let mut mk = Mark::new(MarkType::Tuplet, tp.start, id);
                                mk.level = Some(0.0);
                                mk.tuplet_actual = Some(tp.tuplet_actual.unwrap_or(3.0));
                                mk.tuplet_normal = Some(tp.tuplet_normal.unwrap_or(2.0));
                                marks.push(mk);
                            }
                            pb.open_tuplets.remove(k);
                            cur.just_closed_tuplet = true;
                        }
                    }
                }
            }

            TokenKind::Sustain => {
                let Some(host_id) = cur.sustain_host else {
                    ctx.report("orphan-sustain", Msg::new("diag.j123.orphanSustain"), t.source);
                    continue;
                };
                let mut s = Sustain {
                    id: ctx.ids.next(),
                    harmony: None,
                    notations: None,
                    ornaments: None,
                    section_word: None,
                    lyric_anchor: None,
                    lyrics: None,
                    before: None,
                    line_break_after: None,
                    attached_sources: None,
                    source: Some(t.source),
                };
                if let Some(c) = pb.pending.chord.take() {
                    s.harmony = Some(harmony_of(c));
                    let hs: Vec<AttachedSource> = pb.pending.srcs.iter().filter(|a| a.kind == AttachedKind::Harmony).cloned().collect();
                    if !hs.is_empty() {
                        s.attached_sources = Some(hs);
                    }
                    pb.pending.srcs.retain(|a| a.kind != AttachedKind::Harmony);
                }
                let sid = s.id;
                for a in &cur.arc_ends {
                    if a.host == host_id {
                        marks[a.mark].end = a.su;
                    }
                }
                cur.arc_ends.clear();
                let d = ctx.d;
                if let Some(host) = pb.chord_mut(host_id) {
                    host.sustains.get_or_insert_with(Vec::new).push(s);
                    host.duration = d.reduration(host);
                }
                let _ = sid;
                cur.saw_space = false;
            }

            TokenKind::Rest => {
                let bars = t.bars;
                if let Some(b) = bars {
                    if b > 1.0 {
                        pb.measure.attrs.get_or_insert_with(MeasureAttrs::default).multi_rest = Some(b);
                        pb.extra_rest_bars = Some(b - 1.0);
                    }
                }
                let dur = if bars.is_some() { whole_measure(ctx.time_at(pb.cur_index())) } else { ctx.d.duration(t, ctx.len, 0) };
                let mut ch = new_chord(ctx.ids.next(), pb.voice, dur, t.source);
                ch.rest = Some(RestInfo { measure: bars.map(|_| true), ..Default::default() });
                apply_tie_and_broken(ctx, pb, &mut cur, &mut ch);
                let id = ch.id;
                attach(ctx, pb, &mut cur, marks, Element::Chord(ch));
                cur.sustain_host = Some(id);
            }

            TokenKind::ChordGroup => {
                cur.just_closed_tuplet = false;
                if cur.saw_space {
                    cur.beam_group += 1.0;
                }
                cur.saw_space = false;
                let first = t.notes.as_ref().and_then(|n| n.first());
                let mut dt = t.clone();
                dt.num = Some(t.num.or(first.and_then(|g| g.num)).unwrap_or(1.0));
                dt.den = Some(t.den.or(first.and_then(|g| g.den)).unwrap_or(1.0));
                let id = ctx.ids.next();
                let mut ch = new_chord(id, pb.voice, ctx.d.duration(&dt, ctx.len, 0), t.source);
                ch.notes = t.notes.iter().flatten().map(|g| ctx.d.note(g)).collect();
                ch.beams = continue_beams(t.beams.unwrap_or(0));
                if ctx.d.space_beams() {
                    ch.beam_group = Some(cur.beam_group);
                }
                apply_tie_and_broken(ctx, pb, &mut cur, &mut ch);
                attach(ctx, pb, &mut cur, marks, Element::Chord(ch));
                cur.sustain_host = Some(id);
                for (k, g) in t.notes.iter().flatten().enumerate() {
                    if g.tie_next == Some(true) {
                        pb.note_ties.push(NoteTie { from: id, note: k, source: g.source });
                    }
                }
            }

            TokenKind::ArcNext => {
                if let Some((_, src)) = pb.arc_next {
                    ctx.report("orphan-arc-next", Msg::new("diag.j123.arcNextNoAfter"), src);
                }
                let host = cur.sustain_host.filter(|&h| pb.chord(h).is_some_and(|c| c.grace.is_none()));
                if let Some(h) = host {
                    pb.arc_next = Some((h, t.source));
                } else {
                    pb.arc_next = None;
                    ctx.report("orphan-arc-next", Msg::new("diag.j123.arcNextNoBefore"), t.source);
                }
            }

            TokenKind::Tie => {
                if let Some(h) = cur.sustain_host {
                    if let Some(c) = pb.chord_mut(h) {
                        for n in c.notes.iter_mut() {
                            n.tie.get_or_insert_with(Tie::default).start = Some(true);
                        }
                    }
                    pb.abc_tie = true;
                } else {
                    ctx.report("orphan-tie", Msg::new("diag.j123.orphanTie"), t.source);
                }
            }

            TokenKind::Broken => cur.pending_broken = t.broken.unwrap_or(1),

            TokenKind::Rhythm => {
                let heads: Vec<&Token> = match &t.notes {
                    Some(n) if !n.is_empty() => n.iter().collect(),
                    _ => {
                        if t.value.as_deref().is_some_and(|v| !v.is_empty()) {
                            vec![t]
                        } else {
                            vec![]
                        }
                    }
                };
                let mut ch = new_chord(ctx.ids.next(), pb.voice, ctx.d.duration(t, ctx.len, 0), t.source);
                ch.notes = heads
                    .iter()
                    .map(|h| match h.value.as_deref().filter(|v| !v.is_empty()) {
                        Some(v) => {
                            let us: Vec<u16> = v.encode_utf16().collect();
                            let step = u16s::text(&us[..1]);
                            let oct = us.get(1).map_or(f64::NAN, |&o| js::number(&u16s::text(&[o])));
                            Note { unpitched: Some(Unpitched { step: Some(Step::parse(&step)), octave: Some(oct) }), ..Default::default() }
                        }
                        None => Note::default(),
                    })
                    .collect();
                ch.rhythm = Some(true);
                ch.beams = continue_beams(t.beams.unwrap_or(0));
                let id = ch.id;
                attach(ctx, pb, &mut cur, marks, Element::Chord(ch));
                cur.sustain_host = Some(id);
            }

            TokenKind::Spacer => {
                if t.value.as_deref() == Some("x") {
                    let mut ch = new_chord(ctx.ids.next(), pb.voice, ctx.d.duration(t, ctx.len, 0), t.source);
                    ch.rest = Some(RestInfo::default());
                    ch.print_object = Some(false);
                    ch.beams = continue_beams(t.beams.unwrap_or(0));
                    let id = ch.id;
                    attach(ctx, pb, &mut cur, marks, Element::Chord(ch));
                    cur.sustain_host = Some(id);
                    continue;
                }
                let sp = Space {
                    id: ctx.ids.next(),
                    spacer: Spacer::Y,
                    duration: None,
                    beams: None,
                    voice: pb.voice,
                    staff: 1.0,
                    harmony: None,
                    lyrics: None,
                    notations: None,
                    onset: None,
                    attached_sources: None,
                    source: Some(t.source),
                };
                attach(ctx, pb, &mut cur, marks, Element::Space(sp));
                cur.sustain_host = None;
            }

            TokenKind::Chord => {
                if ctx.d == Dialect::Jcx {
                    if let Some(prev) = pb.pending.chord.take() {
                        pb.pending.annotations.push(prev);
                        for a in pb.pending.srcs.iter_mut() {
                            if a.kind == AttachedKind::Harmony {
                                a.kind = AttachedKind::Annotation;
                            }
                        }
                    }
                }
                let c = t.value.clone().unwrap_or_default();
                pb.pending.chord = Some(c.clone());
                pb.pending.srcs.retain(|a| a.kind != AttachedKind::Harmony);
                pb.pending.srcs.push(AttachedSource { kind: AttachedKind::Harmony, name: c, source: t.source });
            }

            TokenKind::Annotation => {
                let v = t.value.clone().unwrap_or_default();
                let v = match v.chars().next() {
                    Some('^' | '_' | '<' | '>' | '@') => v[1..].to_string(),
                    _ => v,
                };
                pb.pending.annotations.push(v.clone());
                pb.pending.srcs.push(AttachedSource { kind: AttachedKind::Annotation, name: v, source: t.source });
            }

            TokenKind::Deco => {
                let deco = t.value.clone().unwrap_or_default();
                if let Some((kind, open)) = wedge_deco(&deco) {
                    if open {
                        let mut o = OpenMark::new(0.0, t.source);
                        o.wedge_type = Some(kind);
                        o.abc_deco = true;
                        pb.open_wedges.push(o);
                    } else {
                        pb.wedge_close_next.push((kind, t.source));
                    }
                    continue;
                }
                let jump = jump_ornament_name(&deco);
                if let Some(jump) = jump {
                    if pb.measure.elements.is_empty() {
                        let orn = SourceOrnament { name: jump.into(), level: 0.0, below: None };
                        let bls = pb.measure.barlines.get_or_insert_with(Vec::new);
                        if let Some(left) = bls.iter_mut().find(|b| b.location == BarLocation::Left) {
                            left.ornaments.get_or_insert_with(Vec::new).push(orn);
                        } else {
                            let mut b = Barline::at(BarLocation::Left);
                            b.ornaments = Some(vec![orn]);
                            b.source = Some(t.source);
                            bls.push(b);
                        }
                        continue;
                    }
                }
                pb.pending.decos.push(deco.clone());
                pb.pending.srcs.push(AttachedSource { kind: AttachedKind::Deco, name: deco, source: t.source });
            }

            TokenKind::Grace => {
                for g in t.notes.iter().flatten() {
                    let notes = if g.kind == TokenKind::ChordGroup {
                        g.notes.iter().flatten().map(|x| ctx.d.note(x)).collect()
                    } else {
                        vec![ctx.d.note(g)]
                    };
                    let mut ch = new_chord(ctx.ids.next(), pb.voice, Duration { divisions: 0.0, kind: grace_type(Some(g)), dots: 0.0, time_mod: None }, t.source);
                    ch.notes = notes;
                    ch.grace = Some(GraceInfo {
                        slash: (t.acciaccatura == Some(true)).then_some(true),
                        after: (t.grace_after == Some(true)).then_some(true),
                        ..Default::default()
                    });
                    let id = ch.id;
                    pb.measure.elements.push(Element::Chord(ch));
                    cur.last_grace = Some(id);
                    for o in pb.open_slurs.iter_mut() {
                        if o.start == 0 {
                            o.start = id;
                        }
                    }
                }
            }

            TokenKind::SlurStart => {
                let level = pb.open_slurs.len() as f64;
                pb.open_slurs.push(OpenMark::new(level, t.source));
            }

            TokenKind::SlurEnd => slur_end(ctx, pb, &mut cur, marks, t),

            TokenKind::Wedge => {
                let v = t.value.clone().unwrap_or_default();
                let mut it = v.split(' ');
                let kind = WedgeType::parse(it.next().unwrap_or(""));
                let edge = it.next();
                if edge == Some("start") {
                    let mut o = OpenMark::new(0.0, t.source);
                    o.wedge_type = Some(kind);
                    pb.open_wedges.push(o);
                    continue;
                }
                close_wedge(ctx, pb, marks, kind, cur.last, t.source, false);
            }

            TokenKind::Tuplet => {
                let actual = t.value.as_deref().map_or(3.0, js::number);
                let truthy = |x: Option<f64>| x.filter(|v| *v != 0.0 && !v.is_nan());
                let mut o = OpenMark::new(0.0, t.source);
                o.tuplet_actual = Some(actual);
                o.tuplet_normal =
                    Some(truthy(t.numbers.as_ref().and_then(|n| n.get(1).copied())).unwrap_or_else(|| ctx.d.tuplet_normal(actual, ctx.time_pair(pb.cur_index()))));
                o.remaining = Some(truthy(t.numbers.as_ref().and_then(|n| n.get(2).copied())).unwrap_or(actual));
                pb.open_tuplets.push(o);
            }

            TokenKind::Ending => {
                let mut nums = t.numbers.clone().unwrap_or_default();
                let mut text = join_nums(&nums);
                if ctx.d == Dialect::Jcx && nums.len() == 1 && nums[0] == 0.0 {
                    if let Some(c) = pb.pending.chord.take() {
                        text = c;
                        let mut ds: Vec<f64> = vec![];
                        let mut run = String::new();
                        for ch in text.chars().chain(std::iter::once('\0')) {
                            if ch.is_ascii_digit() {
                                run.push(ch);
                            } else if !run.is_empty() {
                                ds.push(js::number(&run));
                                run.clear();
                            }
                        }
                        nums = if ds.is_empty() { vec![1.0] } else { ds };
                        pb.pending.srcs.retain(|a| a.kind != AttachedKind::Harmony);
                    }
                }
                let prev_volta = pb.open_ending.last().cloned();
                let measure_no = pb.measure_no;
                let has_prev_line = pb.part.measures.last().and_then(|m| m.barlines.as_ref()).is_some_and(|b| b.iter().any(|b| b.location == BarLocation::Right));
                if let Some((pnums, pno)) = prev_volta {
                    if pno < measure_no && has_prev_line {
                        pb.open_ending.pop();
                        let line = pb.part.measures.last_mut().unwrap().barlines.as_mut().unwrap().iter_mut().find(|b| b.location == BarLocation::Right).unwrap();
                        let t = join_nums(&pnums);
                        line.ending = Some(Ending::new(pnums, EndingType::Stop, Some(t)));
                    }
                }
                let ending = Ending::new(nums.clone(), EndingType::Start, Some(text));
                let bls = pb.measure.barlines.get_or_insert_with(Vec::new);
                if let Some(left) = bls.iter_mut().find(|b| b.location == BarLocation::Left) {
                    left.ending = Some(ending);
                } else {
                    let mut b = Barline::at(BarLocation::Left);
                    b.ending = Some(ending);
                    b.source = Some(t.source);
                    bls.push(b);
                }
                pb.open_ending.push((nums, measure_no));
            }

            TokenKind::Barline => {
                let mut bl = barline_from(t.value.as_deref().unwrap_or("normal"), t.repeat_times, t.source);
                let has_els = !pb.measure.elements.is_empty();
                let on_line = |d: &str| jump_ornament_name(d).is_some() || has_els;
                let taken: Vec<String> = pb.pending.decos.iter().filter(|d| on_line(d)).cloned().collect();
                if !taken.is_empty() {
                    pb.pending.decos.retain(|d| !on_line(d));
                    pb.pending.srcs.retain(|a| a.kind != AttachedKind::Deco || !on_line(&a.name));
                    bl.ornaments = Some(
                        taken.iter().map(|d| SourceOrnament { name: jump_ornament_name(d).map_or_else(|| d.clone(), String::from), level: 0.0, below: None }).collect(),
                    );
                }
                let closes_empty = !pb.part.measures.is_empty()
                    && pb.measure.barlines.as_ref().is_none_or(|b| b.is_empty())
                    && bl.repeat != Some(RepeatDir::Forward)
                    && matches!(bl.style, Some(BarStyle::LightHeavy | BarStyle::LightLight));
                if !has_els && !closes_empty {
                    bl.location = BarLocation::Left;
                    pb.measure.barlines.get_or_insert_with(Vec::new).push(bl);
                    continue;
                }
                let is_ending_stop = matches!(bl.style, Some(BarStyle::LightLight | BarStyle::LightHeavy | BarStyle::HeavyLight));
                if is_ending_stop && !pb.open_ending.is_empty() {
                    let (nums, _) = pb.open_ending.pop().unwrap();
                    let t = join_nums(&nums);
                    bl.ending = Some(Ending::new(nums, EndingType::Stop, Some(t)));
                } else if let Some((tnums, tno)) = pb.open_ending.last().cloned() {
                    let after_repeat = pb.part.measures.last().and_then(|m| m.barlines.as_ref()).is_some_and(|b| {
                        b.iter().any(|x| x.location == BarLocation::Right && x.repeat == Some(RepeatDir::Backward))
                    });
                    if tno == pb.measure_no && after_repeat {
                        pb.open_ending.pop();
                        let t = join_nums(&tnums);
                        bl.ending = Some(Ending::new(tnums, EndingType::Discontinue, Some(t)));
                    }
                }
                pb.measure.barlines.get_or_insert_with(Vec::new).push(bl);
                pb.inline_break = None;
                close_measure(ctx, pb);
                cur.beam_group = 0.0;
                cur.saw_space = true;
                cur.sustain_host = None;
                if ctx.d.tuplet_close_paren() {
                    let srcs: Vec<SourceSpan> = pb.open_tuplets.iter().map(|tp| tp.open_source.unwrap_or(t.source)).collect();
                    for s in srcs {
                        ctx.report("unclosed-tuplet", Msg::new("diag.j123.tupletOpen"), s);
                    }
                }
                pb.open_tuplets.clear();
            }

            TokenKind::Overlay => {
                if !pb.open_tuplets.is_empty() {
                    ctx.report("overlay-open-tuplet", Msg::new("diag.j123.tupletOverlay"), t.source);
                    pb.open_tuplets.clear();
                }
                if !pb.measure.elements.iter().any(|el| el.voice() == pb.voice) {
                    ctx.report("empty-overlay", Msg::new("diag.j123.overlayBefore"), t.source);
                }
                pb.switch_branch(pb.voice + 1.0);
                pb.voice += 1.0;
                pb.overlay_source = Some(t.source);
                cur.pending_broken = 0;
                cur.sustain_host = None;
                cur.last = None;
                cur.last_grace = None;
                cur.just_closed_tuplet = false;
                cur.beam_group += 1.0;
                cur.saw_space = true;
            }

            TokenKind::Break => {
                if t.text == "$$" {
                    ctx.report("page-break-removed", Msg::new("diag.pageBreakRemoved"), t.source);
                }
                mark_break(ctx, pb, BreakKind::System, t.source);
            }

            TokenKind::InlineField => inline_field(ctx, pb, t),

            _ => {}
        }
    }
}

/// `^(crescendo|<|diminuendo|decrescendo|>)([()])$` → (类型, 是不是起头)
fn wedge_deco(deco: &str) -> Option<(WedgeType, bool)> {
    let open = deco.ends_with('(');
    if !open && !deco.ends_with(')') {
        return None;
    }
    let head = &deco[..deco.len() - 1];
    let kind = match head {
        "crescendo" | "<" => WedgeType::Crescendo,
        "diminuendo" | "decrescendo" | ">" => WedgeType::Diminuendo,
        _ => return None,
    };
    Some((kind, open))
}

fn slur_end(ctx: &mut Ctx, pb: &mut PartBuild, cur: &mut Cur, marks: &mut Vec<Mark>, t: &Token) {
    let paren = ctx.d.tuplet_close_paren();
    // 123：`)` 收最近开的那个括号，圆滑线与多连音同一套嵌套
    if paren {
        let slur_at = pb.open_slurs.last().map(|sl| sl.offset());
        if let Some(tp) = pb.open_tuplets.pop_if(|tp| slur_at.is_none_or(|o| tp.offset() > o)) {
            {
                match cur.last {
                    Some(last) if tp.start != 0 => {
                        let mut mk = Mark::new(MarkType::Tuplet, tp.start, last);
                        mk.level = Some(0.0);
                        mk.tuplet_actual = tp.tuplet_actual;
                        mk.tuplet_normal = tp.tuplet_normal;
                        marks.push(mk);
                    }
                    _ => ctx.report("empty-tuplet", Msg::new("diag.j123.emptyTuplet"), t.source),
                }
                return;
            }
        }
    }
    if pb.open_slurs.is_empty() && !paren {
        if cur.just_closed_tuplet {
            cur.just_closed_tuplet = false;
            return;
        }
        if let Some(tp) = pb.open_tuplets.pop() {
            if let (true, Some(last)) = (tp.start != 0, cur.last) {
                let mut mk = Mark::new(MarkType::Tuplet, tp.start, last);
                mk.level = Some(0.0);
                mk.tuplet_actual = Some(tp.tuplet_actual.unwrap_or(3.0));
                mk.tuplet_normal = Some(tp.tuplet_normal.unwrap_or(2.0));
                marks.push(mk);
            }
        } else {
            ctx.report("unmatched-slur", Msg::new("diag.j123.extraParen"), t.source);
        }
        return;
    }
    if pb.open_slurs.is_empty() {
        ctx.report("unmatched-slur", Msg::new("diag.j123.extraParen"), t.source);
        return;
    }
    let last_id = cur.last_grace.or(cur.last);
    let n = pb.open_slurs.len();
    let top = &pb.open_slurs[n - 1];
    let below = if n >= 2 { Some(&pb.open_slurs[n - 2]) } else { None };
    let inner = pb.open_tuplets.last();
    let chain = top.start != 0
        && Some(top.start) == last_id
        && below.is_some_and(|b| !(paren && inner.is_some_and(|it| it.offset() > b.offset())));
    let open = if chain { pb.open_slurs.remove(n - 2) } else { pb.open_slurs.pop().unwrap() };
    match last_id {
        Some(last) if open.start != 0 => {
            let mut mk = Mark::new(MarkType::Slur, open.start, last);
            mk.level = Some(open.level);
            mk.close_source = Some(t.source);
            mk.open_source = open.open_source;
            marks.push(mk);
            if let Some(host) = cur.sustain_host {
                if Some(host) == cur.last && cur.last_grace.is_none() {
                    if let Some(su) = pb.chord(host).and_then(|c| c.sustains.as_ref()).and_then(|s| s.last()).map(|s| s.id) {
                        cur.arc_ends.push(ArcEnd { mark: marks.len() - 1, host, su });
                    }
                }
            }
        }
        _ => ctx.report("empty-slur", Msg::new("diag.j123.emptySlur"), t.source),
    }
}

/// `[K:…]` `[M:…]` `[L:…]` `[P:…]`
fn inline_field(ctx: &mut Ctx, pb: &mut PartBuild, t: &Token) {
    let v = t.value.clone().unwrap_or_default();
    // `^([A-Za-z])\s*[:：]\s*(.*)$`
    let mut cs = v.chars();
    let Some(n0) = cs.next().filter(|c| c.is_ascii_alphabetic()) else { return };
    let rest = cs.as_str().trim_start_matches(js::is_space);
    let Some(rest) = rest.strip_prefix(':').or_else(|| rest.strip_prefix('：')) else { return };
    let val = rest.trim_start_matches(js::is_space).to_string();
    if val.contains('\n') || val.contains('\r') || val.contains('\u{2028}') || val.contains('\u{2029}') {
        return;
    }
    let name = n0.to_ascii_uppercase();
    if name == 'P' {
        let v = js::trim(&val);
        if ctx.d != Dialect::Jcx && !v.is_empty() {
            ctx.pending_sections.push(v.to_string());
        }
        return;
    }
    let clef_only = if name == 'K' && matches!(ctx.d, Dialect::J123 | Dialect::Abc) { clef_only(&val) } else { None };
    if let Some(cn) = &clef_only {
        if ctx.d == Dialect::Abc && !pb.measure.elements.is_empty() {
            match clef_from_name(cn) {
                Some(c) => {
                    let after = main_elements_before(&pb.measure, pb.voice);
                    pb.measure.later_attrs.get_or_insert_with(Vec::new).push(LaterAttrs {
                        after_elements: after,
                        onset: None,
                        attrs: MeasureAttrs { clefs: Some(vec![c]), ..Default::default() },
                    });
                }
                None => ctx.report("bad-clef", Msg::new("diag.j123.badClef").arg("v", cn.as_str()), t.source),
            }
            return;
        }
    }
    pb.measure.attrs.get_or_insert_with(MeasureAttrs::default);
    if let Some(cn) = clef_only {
        match clef_from_name(&cn) {
            Some(c) => pb.measure.attrs.as_mut().unwrap().clefs = Some(vec![c]),
            None => ctx.report("bad-clef", Msg::new("diag.j123.badClef").arg("v", cn), t.source),
        }
    } else if name == 'K' {
        let r = ctx.d.parse_key(&val);
        if let Some(e) = r.error {
            ctx.report("bad-key", e, t.source);
        }
        pb.measure.attrs.as_mut().unwrap().key = Some(r.key);
    } else if name == 'M' {
        let src = if ctx.d == Dialect::Jcx { jcx_time_head(&val).unwrap_or(val.clone()) } else { val.clone() };
        let r = parse_time(&src);
        if let Some(e) = r.error {
            ctx.report("bad-time", e, t.source);
        } else if let Some(tm) = r.time {
            pb.measure.attrs.as_mut().unwrap().time = Some(tm.clone());
            ctx.time_changes.push((pb.cur_index(), tm.clone()));
            ctx.time = Some(tm);
        }
    } else if name == 'L' {
        match parse_len(js::trim(&val)) {
            Some((a, b)) if b > 0.0 => {
                let l = DefaultLen { num: a, den: b };
                ctx.len = l;
                pb.len = Some(l);
            }
            _ => ctx.report("bad-length", Msg::new("diag.j123.badLength").arg("v", val.as_str()), t.source),
        }
    }
}

/// `^\s*clef\s*=\s*(\S+)\s*$`（不分大小写）
fn clef_only(val: &str) -> Option<String> {
    let s = val.trim_start_matches(js::is_space);
    if !s.get(..4).is_some_and(|h| h.eq_ignore_ascii_case("clef")) {
        return None;
    }
    let s = s[4..].trim_start_matches(js::is_space).strip_prefix('=')?;
    let s = js::trim(s);
    if s.is_empty() || s.chars().any(js::is_space) {
        return None;
    }
    Some(s.to_string())
}

/// `^(\d+)\s*\/\s*(\d+)$`
fn parse_len(s: &str) -> Option<(f64, f64)> {
    let (a, b) = s.split_once('/')?;
    let a = a.trim_end_matches(js::is_space);
    let b = b.trim_start_matches(js::is_space);
    if a.is_empty() || b.is_empty() || !a.bytes().all(|c| c.is_ascii_digit()) || !b.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((js::number(a), js::number(b)))
}

/// Muse `[M:4/4/]` 这类笔误：`^\s*(\d+\s*\/\s*\d+|C\|?)`（不分大小写）只取开头
fn jcx_time_head(val: &str) -> Option<String> {
    let cs: Vec<char> = val.chars().collect();
    let mut i = 0;
    while i < cs.len() && js::is_space(cs[i]) {
        i += 1;
    }
    let st = i;
    let mut k = i;
    while k < cs.len() && cs[k].is_ascii_digit() {
        k += 1;
    }
    if k > st {
        let mut e = k;
        while e < cs.len() && js::is_space(cs[e]) {
            e += 1;
        }
        if cs.get(e) == Some(&'/') {
            e += 1;
            while e < cs.len() && js::is_space(cs[e]) {
                e += 1;
            }
            let d0 = e;
            while e < cs.len() && cs[e].is_ascii_digit() {
                e += 1;
            }
            if e > d0 {
                return Some(cs[st..e].iter().collect());
            }
        }
    }
    if cs.get(st).is_some_and(|c| *c == 'C' || *c == 'c') {
        let e = if cs.get(st + 1) == Some(&'|') { st + 2 } else { st + 1 };
        return Some(cs[st..e].iter().collect());
    }
    None
}

// ───────────────────────── 收尾 ─────────────────────────

/// `:|` 后面的房读的时候只罩了一小节，这里看后文改回来
fn extend_voltas(ms: &mut [Measure]) {
    fn right_of(m: &Measure) -> Option<&Barline> {
        m.barlines.as_ref()?.iter().find(|b| b.location == BarLocation::Right)
    }
    let opens_volta = |m: Option<&Measure>, above: f64| -> bool {
        m.and_then(|m| m.barlines.as_ref()).is_some_and(|bs| {
            bs.iter().any(|b| {
                b.location == BarLocation::Left
                    && b.ending.as_ref().is_some_and(|e| e.kind == EndingType::Start && e.numbers.iter().fold(f64::INFINITY, |a, &x| js::min(a, x)) >= above)
            })
        })
    };
    for i in 0..ms.len() {
        let Some(line) = right_of(&ms[i]) else { continue };
        let Some(ending) = line.ending.clone().filter(|e| e.kind == EndingType::Discontinue) else { continue };
        let top = ending.numbers.iter().fold(f64::NEG_INFINITY, |a, &x| js::max(a, x));
        let mut end: Option<usize> = None;
        for j in i..ms.len() {
            let right = right_of(&ms[j]);
            if j > i
                && ms[j].barlines.as_ref().is_some_and(|bs| bs.iter().any(|b| b.location == BarLocation::Left && (b.ending.is_some() || b.repeat == Some(RepeatDir::Forward))))
            {
                break;
            }
            if j > i && right.is_some_and(|r| r.repeat == Some(RepeatDir::Backward)) {
                end = Some(j);
                break;
            }
            if opens_volta(ms.get(j + 1), top) {
                end = Some(j);
                break;
            }
            if right.and_then(|r| r.style.as_ref()).is_some_and(|s| *s != BarStyle::Regular) {
                break;
            }
        }
        let Some(end) = end else { continue };
        let line = ms[i].barlines.as_mut().unwrap().iter_mut().find(|b| b.location == BarLocation::Right).unwrap();
        line.ending = None;
        let target = ms[end].barlines.as_mut().unwrap().iter_mut().find(|b| b.location == BarLocation::Right).unwrap();
        target.ending = Some(Ending { kind: EndingType::Stop, ..ending });
    }
}

/// 123/ABC 的房号约定：一组房的最后一房不封口（`stop` 后面不再紧跟一房的改 `discontinue`）
fn mark_last_endings(part: &mut Part) {
    let ms = &mut part.measures;
    extend_voltas(ms);
    for i in 0..ms.len() {
        let next_opens = ms.get(i + 1).and_then(|m| m.barlines.as_ref()).is_some_and(|bs| {
            bs.iter().any(|x| x.location == BarLocation::Left && x.ending.as_ref().is_some_and(|e| e.kind == EndingType::Start))
        });
        for b in ms[i].barlines.iter_mut().flatten() {
            if b.location != BarLocation::Right {
                continue;
            }
            let Some(e) = b.ending.as_mut() else { continue };
            if e.kind != EndingType::Stop {
                continue;
            }
            if !next_opens {
                e.kind = EndingType::Discontinue;
            }
        }
    }
}

/// 歌词挂到对位格上：从 `start` 格起、到 `end` 格为止。返回超出块尾、有字的音节数
fn attach_lyrics(part: &mut Part, slots: &[(usize, usize)], syllables: Vec<Lyric>, start: usize, end: usize) -> f64 {
    let mut over = 0.0;
    for (si, syl) in syllables.into_iter().enumerate() {
        let k = start + si;
        if k >= end || k >= slots.len() {
            if !syl.text.is_empty() {
                over += 1.0;
            }
            continue;
        }
        if syl.text.is_empty() && syl.extend != Some(true) {
            continue;
        }
        let (mi, ei) = slots[k];
        match &mut part.measures[mi].elements[ei] {
            Element::Chord(c) => c.lyrics.get_or_insert_with(Vec::new).push(syl),
            Element::Space(s) => s.lyrics.get_or_insert_with(Vec::new).push(syl),
        }
    }
    over
}

/// Muse 的五线谱轨：字母是绝对音名，读进来时按简谱轨记成了度数，这里改回音名
fn muse_staff_pitches(part: &mut Part) {
    const LETTERS: &str = "CDEFGAB";
    for m in part.measures.iter_mut() {
        for el in m.elements.iter_mut() {
            let Element::Chord(c) = el else { continue };
            for n in c.notes.iter_mut() {
                let Some(d) = &n.degree else { continue };
                if d.number < 1.0 {
                    continue;
                }
                let step = LETTERS.chars().nth(d.number as usize - 1).map(|c| c.to_string()).unwrap_or_default();
                let alter = n.accidental.as_ref().and_then(crate::jianpu::offset_by_acc).unwrap_or(0.0);
                n.pitch = Some(Pitch { step: Step::parse(&step), alter, octave: 4.0 + d.octave_shift });
                n.degree = None;
            }
        }
    }
}

// ───────────────────────── Muse `V:` 参数 ─────────────────────────

/// `(?:"([^"]*)"|“([^”]*)”|(\S+))` 从 `k` 起：回 (值, 结束位置)
fn muse_value(cs: &[char], k: usize) -> Option<(String, usize)> {
    let c = *cs.get(k)?;
    if c == '"' {
        if let Some(e) = (k + 1..cs.len()).find(|&j| cs[j] == '"') {
            return Some((cs[k + 1..e].iter().collect(), e + 1));
        }
    }
    if c == '“' {
        if let Some(e) = (k + 1..cs.len()).find(|&j| cs[j] == '”') {
            return Some((cs[k + 1..e].iter().collect(), e + 1));
        }
    }
    if js::is_space(c) {
        return None;
    }
    let e = (k..cs.len()).find(|&j| js::is_space(cs[j])).unwrap_or(cs.len());
    Some((cs[k..e].iter().collect(), e))
}

/// 在 `p`（前面是行首或空白）处认 `名\s*=\s*值`：回 (值, 结束位置)
fn muse_assign(cs: &[char], p: usize, name: &str) -> Option<(String, usize)> {
    let nm: Vec<char> = name.chars().collect();
    if cs.len() < p + nm.len() || cs[p..p + nm.len()] != nm[..] {
        return None;
    }
    let mut k = p + nm.len();
    while k < cs.len() && js::is_space(cs[k]) {
        k += 1;
    }
    if cs.get(k) != Some(&'=') {
        return None;
    }
    k += 1;
    while k < cs.len() && js::is_space(cs[k]) {
        k += 1;
    }
    muse_value(cs, k)
}

/// Muse `V:` 声明的一个参数值：`name="主旋律"`、`nm=“Violin I”`、`snm=女`
fn muse_param(value: &str, names: &[&str]) -> Option<String> {
    let cs: Vec<char> = value.chars().collect();
    for n in names {
        for p in 0..=cs.len() {
            let at = if p == 0 { Some(0) } else if js::is_space(cs[p - 1]) { Some(p) } else { None };
            let Some(at) = at else { continue };
            if let Some((v, _)) = muse_assign(&cs, at, n) {
                return Some(v);
            }
        }
    }
    None
}

/// 去掉 `(?:^|\s)(?:style|name|nm|sname|snm)\s*=\s*(?:"[^"]*"|“[^”]*”|\S+)`（全局）
fn strip_muse_params(rest: &str) -> String {
    let cs: Vec<char> = rest.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    'outer: while i < cs.len() {
        let mut starts = vec![];
        if i == 0 {
            starts.push((i, i));
        }
        if js::is_space(cs[i]) {
            starts.push((i, i + 1));
        }
        for (from, p) in starts {
            for n in ["style", "name", "nm", "sname", "snm"] {
                if let Some((_, e)) = muse_assign(&cs, p, n) {
                    let _ = from;
                    i = e;
                    continue 'outer;
                }
            }
        }
        out.push(cs[i]);
        i += 1;
    }
    out
}

/// Muse 的 `V:<标志> style=jianpu name=… ins=… vol=…`：认音轨类型与名字，其余参数原文留给写出端
fn muse_voice_attrs(ctx: &mut Ctx, b: &mut PartBuild, f: &FieldLine) {
    if b.muse_style.is_some() {
        return;
    }
    let v = js::trim(&f.value);
    let rest = match v.find(js::is_space) {
        Some(k) => v[k..].trim_start_matches(js::is_space),
        None => "",
    }
    .to_string();
    let style = {
        let cs: Vec<char> = rest.chars().collect();
        let mut found = None;
        for p in 0..=cs.len() {
            let ok = p == 0 || js::is_space(cs[p - 1]);
            if !ok || cs.len() < p + 5 || cs[p..p + 5].iter().collect::<String>() != "style" {
                continue;
            }
            let mut k = p + 5;
            while k < cs.len() && js::is_space(cs[k]) {
                k += 1;
            }
            if cs.get(k) != Some(&'=') {
                continue;
            }
            k += 1;
            while k < cs.len() && js::is_space(cs[k]) {
                k += 1;
            }
            let e = (k..cs.len()).find(|&j| js::is_space(cs[j])).unwrap_or(cs.len());
            if e > k {
                found = Some(cs[k..e].iter().collect::<String>());
                break;
            }
        }
        found.unwrap_or_else(|| "jianpu".into()).to_lowercase()
    };
    if style == "staff" {
        b.muse_style = Some(MuseStyle::Staff);
    } else if style == "jianpu" {
        b.muse_style = Some(MuseStyle::Jianpu);
    } else {
        b.muse_style = Some(MuseStyle::Skip);
        ctx.report("jcx-track-skipped", Msg::new("diag.jcx.trackSkipped").arg("style", style.as_str()), f.source);
    }
    if let Some(name) = muse_param(&rest, &["name", "nm"]) {
        if b.part.name.is_none() {
            b.part.name = Some(name);
        }
    }
    if let Some(ab) = muse_param(&rest, &["sname", "snm"]) {
        if b.part.abbrev.is_none() {
            b.part.abbrev = Some(ab);
        }
    }
    let extra = strip_muse_params(&rest);
    let extra = js::trim(&extra);
    if !extra.is_empty() {
        b.part.muse_attrs = Some(extra.to_string());
    }
}

// ───────────────────────── 字段与指令 ─────────────────────────

fn page_text(song: &mut Song) -> &mut PageText {
    song.page_text.get_or_insert_with(PageText::default)
}

fn push_raw(song: &mut Song, key: &str, value: String) {
    song.style.get_or_insert_with(StyleRef::default).raw.get_or_insert_with(Vec::new).push(RawStyle { key: key.into(), value });
}

fn apply_instruction(ctx: &mut Ctx, song: &mut Song, ins: Instruction, source: SourceSpan) {
    let name = cjk_instruction_alias(&ins.name).map_or(ins.name.clone(), String::from);
    match name.as_str() {
        "playorder" => ctx.report("playorder-removed", Msg::new("diag.playOrderRemoved"), source),
        "style" => song.style.get_or_insert_with(StyleRef::default).sheet_ref = Some(js::trim(&ins.value).to_string()),
        "meta" => {
            let v = ins.value.trim_start_matches(js::is_space);
            let key_end = v.find(js::is_space).unwrap_or(v.len());
            let key = &v[..key_end];
            if !key.is_empty() && is_meta_key(key) {
                let rest = js::trim(&v[key_end..]).to_string();
                add_meta(song, key, &rest);
            } else {
                push_raw(song, &name, ins.value.clone());
            }
        }
        "indexleft" => page_text(song).index_left = Some(ins.value),
        "indexright" => page_text(song).index_right = Some(ins.value),
        "topleft" => page_text(song).top_left.push(ins.value),
        "topright" => page_text(song).top_right.push(ins.value),
        "bottomleft" => page_text(song).bottom_left.push(ins.value),
        "bottomcenter" => page_text(song).bottom_center.push(ins.value),
        "bottomright" => page_text(song).bottom_right.push(ins.value),
        "linebreak" => push_raw(song, "linebreak", parse_linebreak(&ins.value).into()),
        _ => push_raw(song, &name, ins.value),
    }
}

/// `(?:^|\s)<key>="([^"]*)"`
fn quoted_param(value: &str, key: &str) -> Option<String> {
    let pat = format!("{key}=\"");
    let mut from = 0;
    while let Some(k) = value[from..].find(&pat) {
        let p = from + k;
        let ok = p == 0 || value[..p].chars().last().is_some_and(js::is_space);
        let vs = p + pat.len();
        if ok {
            if let Some(e) = value[vs..].find('"') {
                return Some(value[vs..vs + e].to_string());
            }
        }
        from = p + 1;
        while !value.is_char_boundary(from) {
            from += 1;
        }
    }
    None
}

/// `(?:^|\s)part=(\d+)(?=\s|$)`
fn part_param(value: &str) -> Option<String> {
    let mut from = 0;
    while let Some(k) = value[from..].find("part=") {
        let p = from + k;
        let ok = p == 0 || value[..p].chars().last().is_some_and(js::is_space);
        let ds = p + 5;
        let de = ds + value[ds..].bytes().take_while(|b| b.is_ascii_digit()).count();
        if ok && de > ds && value[de..].chars().next().is_none_or(js::is_space) {
            return Some(value[ds..de].to_string());
        }
        from = p + 1;
    }
    None
}

// ───────────────────────── 主循环 ─────────────────────────

struct PendingLyric {
    source: SourceSpan,
    verse: f64,
    syl: Vec<Lyric>,
    build: usize,
    block: usize,
    start: usize,
}

struct Parser {
    ctx: Ctx,
    doc: ScoreDoc,
    song: Option<Song>,
    /// 本曲各声部：(声部号, 状态)，按首次出现的顺序
    builds: Vec<(f64, PartBuild)>,
    pb: Option<usize>,
    marks: Vec<Mark>,
    pending_lyrics: Vec<PendingLyric>,
    music_seen: bool,
    saw_key: bool,
    head_section: Option<FieldLine>,
    order_source: Option<SourceSpan>,
    sing_rows: Vec<(String, SourceSpan)>,
    /// `%%layout` / `I:layout` 的正文：段落标记落位后才解析（要查段名）
    layout_rows: Vec<(String, SourceSpan)>,
    voice_ids: Vec<String>,
}

impl Parser {
    fn ensure_song(&mut self) -> &mut Song {
        self.song.get_or_insert_with(empty_song)
    }

    fn start_part(&mut self, voice: f64) -> usize {
        self.ensure_song();
        let k = match self.builds.iter().position(|(v, _)| *v == voice) {
            Some(k) => k,
            None => {
                self.builds.push((voice, PartBuild::new(voice)));
                self.builds.len() - 1
            }
        };
        self.pb = Some(k);
        k
    }

    fn ensure_part(&mut self) -> usize {
        match self.pb {
            Some(k) => k,
            None => self.start_part(1.0),
        }
    }

    fn muse_voice(&mut self, label: &str) -> f64 {
        match self.voice_ids.iter().position(|l| l == label) {
            Some(k) => (k + 1) as f64,
            None => {
                self.voice_ids.push(label.to_string());
                self.voice_ids.len() as f64
            }
        }
    }

    fn settle_head_section(&mut self, last_before_music: bool) {
        let Some(f) = self.head_section.take() else { return };
        if (last_before_music || (self.ctx.d == Dialect::Abc && self.saw_key)) && !looks_like_order(&f.value) {
            self.ctx.pending_sections.push(f.value);
            return;
        }
        let seq = expand_section_order(&f.value);
        if seq.is_none() {
            self.ctx.report("bad-section-order", Msg::new("diag.part.badOrder").arg("v", f.value.as_str()), f.source);
        }
        self.ensure_song().section_order = Some(SectionOrder { text: f.value.clone(), seq: seq.unwrap_or_default() });
        self.order_source = Some(f.source);
    }

    /// 行首的 `[V:x]`：切声部，返回这一行剩下的音乐从第几列起（码元）；不是这种行返回 0
    fn inline_voice(&mut self, raw: &U16) -> usize {
        // `^\s*\[V\s*[:：]\s*([^\]]*)\]`
        let mut i = u16s::spaces(raw, 0);
        if !u16s::is(raw, i, '[') || !u16s::is(raw, i + 1, 'V') {
            return 0;
        }
        i += 2;
        i += u16s::spaces(raw, i);
        if !(u16s::is(raw, i, ':') || u16s::is(raw, i, '：')) {
            return 0;
        }
        i += 1;
        let Some(close) = u16s::find(raw, ']', i) else { return 0 };
        let inner = u16s::text(&raw[i..close]);
        let label = js::trim(&inner).split(js::is_space).next().unwrap_or("").to_string();
        if self.ctx.d == Dialect::Jcx {
            let v = self.muse_voice(&label);
            self.start_part(v);
        } else if !label.is_empty() && label.bytes().all(|b| b.is_ascii_digit()) {
            self.start_part(js::number(&label));
        } else {
            return 0;
        }
        close + 1
    }

    fn add_lyric_line(&mut self, k: usize, f: &FieldLine) {
        if let Some(lv) = &f.legacy_verse {
            self.ctx.report("lyric-verse-number", Msg::new("diag.j123.verseNumber").arg("n", lv.as_str()), f.source);
            return;
        }
        let ctx = &mut self.ctx;
        let pb = &mut self.builds[k].1;
        let block = match pb.block {
            Some(b) => b,
            None => {
                let at = ctx.slot_count(pb);
                let b = ctx.new_block(at);
                pb.block = Some(b);
                b
            }
        };
        pb.after_lyrics = true;
        let blk = &mut ctx.blocks[block];
        let from = if f.cont == Some(true) {
            match blk.last_verse {
                Some(v) => v,
                None => {
                    blk.verses += 1.0;
                    blk.verses
                }
            }
        } else {
            blk.verses += 1.0;
            blk.verses
        };
        blk.last_verse = Some(from);
        let body = u16s::enc(&f.value);
        let skip = ctx.d.lyric_skip();
        let d = ctx.d;
        let mut warns: Vec<(String, Msg)> = vec![];
        let line = parse_lyric_line(
            &body,
            from,
            f.source,
            f.value_offset,
            skip,
            &mut |code: &str, m: Msg| warns.push((code.to_string(), m)),
            d == Dialect::Jcx,
            d == Dialect::Abc,
        );
        for (code, m) in warns {
            ctx.report(&code, m, f.source);
        }
        let mut syllables = line.syllables;
        if let Some(label) = line.label {
            if let Some(first) = syllables.iter_mut().find(|x| !x.text.is_empty()) {
                first.verse_label = Some(label);
            }
        }
        let blk = &mut ctx.blocks[block];
        let start = blk.cursor.get(&NumKey::new(from)).copied().unwrap_or(blk.start);
        blk.cursor.insert(NumKey::new(from), start + syllables.len());
        self.pending_lyrics.push(PendingLyric { source: f.source, verse: from, syl: syllables, build: k, block, start });
    }

    fn apply_field(&mut self, f: &FieldLine) {
        match f.name.as_str() {
            "T" => {
                let s = self.ensure_song();
                if s.work.title.is_none() {
                    s.work.title = Some(f.value.clone());
                } else {
                    s.work.subtitles.push(f.value.clone());
                }
            }
            "C" => {
                let c = creator_of(&f.value);
                self.ensure_song().identification.get_or_insert_with(|| Identification { creators: vec![], rights: None, software: None }).creators.push(c);
            }
            "K" => {
                let r = self.ctx.d.parse_key(&f.value);
                if let Some(e) = r.error {
                    self.ctx.report("bad-key", e, f.source);
                }
                self.ensure_song().key = Some(r.key);
            }
            "M" => {
                let r = parse_times(&f.value);
                if let Some(e) = r.error {
                    self.ctx.report("bad-time", e, f.source);
                }
                let mut times = r.times.into_iter();
                if let Some(first) = times.next() {
                    let rest: Vec<Time> = times.collect();
                    self.ctx.time = Some(first.clone());
                    self.ctx.time_changes.push((0, first.clone()));
                    if !self.ctx.saw_l {
                        self.ctx.len = self.ctx.d.default_len(first.beats, first.beat_type);
                    }
                    let s = self.ensure_song();
                    s.time = Some(first);
                    if !rest.is_empty() {
                        s.extra_times = Some(rest);
                    }
                    if let Some(n) = r.note {
                        s.time_note = Some(n);
                    }
                }
            }
            "L" => match parse_len(js::trim(&f.value)) {
                Some((a, b)) => {
                    self.ctx.len = DefaultLen { num: a, den: b };
                    self.ctx.saw_l = true;
                }
                None => self.ctx.report("bad-length", Msg::new("diag.j123.badLength").arg("v", f.value.as_str()), f.source),
            },
            "Q" => {
                let add: Vec<Tempo> = parse_tempo(&f.value)
                    .into_iter()
                    .map(|p| match p {
                        TempoPart::Num(n) => Tempo::Bpm(n),
                        TempoPart::Text(t) => Tempo::Text(t),
                    })
                    .collect();
                let tb = parse_tempo_beat(&f.value);
                let s = self.ensure_song();
                s.tempos.get_or_insert_with(Vec::new).extend(add);
                if let Some((num, den)) = tb {
                    s.tempo_beat = Some(Ratio { num, den });
                }
            }
            "V" => {
                let voice = f.voice.unwrap_or(1.0);
                let k = self.start_part(voice);
                let d = self.ctx.d;
                let clef = if matches!(d, Dialect::J123 | Dialect::Abc) { parse_voice_clef(&f.value) } else { None };
                let b = &mut self.builds[k].1;
                if let Some(c) = clef {
                    b.clef = Some(c);
                }
                if d != Dialect::Jcx {
                    if let Some(h) = part_param(&f.value) {
                        if js::number(&h) != voice {
                            b.part.staff_of = Some(format!("P{h}"));
                        }
                    }
                }
                if d == Dialect::Jcx {
                    muse_voice_attrs(&mut self.ctx, b, f);
                    return;
                }
                if let Some(nm) = quoted_param(&f.value, "name") {
                    if b.part.name.is_none() {
                        b.part.name = Some(nm);
                    }
                }
                if let Some(sn) = quoted_param(&f.value, "subname") {
                    if b.part.abbrev.is_none() {
                        b.part.abbrev = Some(sn);
                    }
                }
            }
            "W" | "N" => self.ensure_song().remarks.get_or_insert_with(Vec::new).push(f.value.clone()),
            "I" => {
                if self.ctx.d == Dialect::Jcx {
                    let v = f.value.clone();
                    page_text(self.ensure_song()).top_left.push(v);
                } else if matches!(self.ctx.d, Dialect::J123 | Dialect::Abc) && parse_instruction(&f.value).name == "layout" {
                    self.ensure_song();
                    let body = parse_instruction(&f.value).value;
                    self.layout_rows.push((body, f.source));
                } else {
                    let ins = parse_instruction(&f.value);
                    let mut song = self.song.take().unwrap_or_else(empty_song);
                    apply_instruction(&mut self.ctx, &mut song, ins, f.source);
                    self.song = Some(song);
                }
            }
            "S" => {
                if self.ctx.d == Dialect::Jcx && !f.value.is_empty() {
                    let v = f.value.clone();
                    add_meta(self.ensure_song(), "source", &v);
                }
            }
            "P" => {
                let v = format!("P:{}", f.value);
                self.ensure_song().remarks.get_or_insert_with(Vec::new).push(v);
            }
            _ => {}
        }
    }

    fn finish_song(&mut self) {
        if self.song.is_none() {
            return;
        }
        self.settle_head_section(false);
        let mut song = self.song.take().unwrap();
        let ctx = &mut self.ctx;
        // 换拍号表按声部小节下标记，下一首从头数（`time` 照旧沿用到下一首）
        ctx.time_changes.clear();
        if !ctx.section_marks.is_empty() {
            song.section_marks = Some(ctx.section_marks.clone());
        }
        {
            let known: Vec<&str> = ctx.section_marks.iter().map(|m| m.name.as_str()).collect();
            let mut seen: Vec<String> = vec![];
            let missing: Vec<String> = song
                .section_order
                .iter()
                .flat_map(|o| o.seq.iter())
                .filter(|n| {
                    if seen.contains(n) {
                        return false;
                    }
                    seen.push((*n).clone());
                    !known.contains(&n.as_str())
                })
                .cloned()
                .collect();
            for name in missing {
                ctx.report("missing-section", Msg::new("diag.part.missing").arg("v", name), self.order_source.unwrap_or(ZERO_SPAN));
            }
        }
        ctx.pending_sections.clear();
        ctx.section_marks.clear();
        self.music_seen = false;
        self.saw_key = false;
        self.order_source = None;
        let paren = ctx.d.tuplet_close_paren();
        for (_, b) in self.builds.iter_mut() {
            if paren {
                for tp in &b.open_tuplets {
                    ctx.report("unclosed-tuplet", Msg::new("diag.j123.tupletOpen"), tp.open_source.unwrap_or(ZERO_SPAN));
                }
                b.open_tuplets.clear();
            }
            let states = std::iter::once((&b.note_ties, b.arc_next)).chain(b.branch_arcs.iter().map(|(_, s)| (&s.note_ties, s.arc_next)));
            for (ties, an) in states {
                for nt in ties {
                    ctx.report("chord-tie-no-match", Msg::new("diag.j123.chordTieNoMatch"), nt.source);
                }
                if let Some((_, src)) = an {
                    ctx.report("orphan-arc-next", Msg::new("diag.j123.arcNextNoAfter"), src);
                }
            }
            b.note_ties.clear();
            b.arc_next = None;
            b.branch_arcs.clear();
            for w in std::mem::take(&mut b.open_wedges) {
                ctx.report("unmatched-wedge", Msg::new(if w.abc_deco { "diag.abc.wedge" } else { "diag.jcx.wedge" }), w.open_source.unwrap_or(ZERO_SPAN));
            }
            for (_, src) in std::mem::take(&mut b.wedge_close_next) {
                ctx.report("unmatched-wedge", Msg::new("diag.abc.wedge"), src);
            }
            close_measure(ctx, b);
            mark_last_endings(&mut b.part);
            if let Some(bk) = b.block {
                if ctx.blocks[bk].end.is_none() {
                    ctx.blocks[bk].end = Some(ctx.slot_count(b));
                }
            }
            if let (Some(c), Some(first)) = (b.clef.clone(), b.part.measures.first_mut()) {
                first.attrs.get_or_insert_with(MeasureAttrs::default).clefs = Some(vec![c]);
            }
            if b.muse_style == Some(MuseStyle::Staff) {
                muse_staff_pitches(&mut b.part);
            }
        }
        // 歌词挂在它紧跟的那个声部上
        let rule = ctx.slot_rule();
        let mut slots_of: HashMap<usize, Vec<(usize, usize)>> = HashMap::new();
        for pl in std::mem::take(&mut self.pending_lyrics) {
            let part = &mut self.builds[pl.build].1.part;
            let slots = slots_of.entry(pl.build).or_insert_with(|| lyric_slots(part, 0, None, 0, usize::MAX, rule));
            let end = ctx.blocks[pl.block].end.unwrap_or(slots.len());
            let left = attach_lyrics(part, slots, pl.syl, pl.start, end);
            if left > 0.0 {
                ctx.report("lyric-overflow", Msg::new("diag.j123.lyricOverflow").arg("verse", pl.verse).arg("left", left), pl.source);
            }
        }
        // 声部落进曲子（Muse 不读的音轨、没有小节的不要）
        let any_staff = self.builds.iter().any(|(_, b)| b.muse_style == Some(MuseStyle::Staff));
        let mut break_maps: Vec<HashMap<usize, BreakKind>> = vec![];
        for (_, b) in self.builds.drain(..) {
            if !b.part.measures.is_empty() && b.muse_style != Some(MuseStyle::Skip) {
                break_maps.push(b.break_after);
                song.parts.push(b.part);
            }
        }
        if !self.sing_rows.is_empty() {
            let known: Vec<String> = song.section_marks.iter().flatten().map(|m| m.name.clone()).collect();
            let mut pages = vec![];
            for (body, src) in std::mem::take(&mut self.sing_rows) {
                let mut bad: Vec<String> = vec![];
                let pg = parse_sing(&body, |v: &str| bad.push(v.to_string()));
                for v in bad {
                    ctx.report("bad-sing", Msg::new("diag.j123.badSing").arg("v", v), src);
                }
                let Some(pg) = pg else { continue };
                for it in &pg.items {
                    if !known.contains(&it.section) {
                        ctx.report("missing-section", Msg::new("diag.j123.singMissing").arg("v", it.section.as_str()), src);
                    }
                }
                pages.push(pg);
            }
            if !pages.is_empty() {
                song.sing_order = Some(pages);
            }
        }
        if !self.layout_rows.is_empty() {
            let known: Vec<String> = song.section_marks.iter().flatten().map(|m| m.name.clone()).collect();
            let mut layouts = vec![];
            let mut first_src: Vec<SourceSpan> = vec![];
            for (body, src) in std::mem::take(&mut self.layout_rows) {
                let mut bad: Vec<String> = vec![];
                let before: Vec<usize> = layouts.iter().map(|l: &crate::LayoutSpec| l.breaks.as_ref().map_or(0, Vec::len)).collect();
                parse_layout(&body, &mut layouts, |v: &str| bad.push(v.to_string()));
                // 这一行新加的断点：段名要有标记，`*n` 不超过那一遍的出现次数
                for (li, l) in layouts.iter_mut().enumerate() {
                    let from = before.get(li).copied().unwrap_or(0);
                    let Some(bs) = l.breaks.as_mut() else { continue };
                    let mut k = from;
                    while k < bs.len() {
                        let b = &bs[k];
                        let nth = b.nth.unwrap_or(1.0) as usize;
                        let over = b.pass.zip(song.sing_order.as_ref()).is_some_and(|(p, order)| {
                            order.get(p as usize - 1).is_none_or(|pg| pg.items.iter().filter(|it| it.section == b.section).count() < nth)
                        });
                        if !known.contains(&b.section) || over {
                            bad.push(b.section.clone());
                            bs.remove(k);
                        } else {
                            k += 1;
                        }
                    }
                    if bs.is_empty() {
                        l.breaks = None;
                    }
                }
                for v in bad {
                    ctx.report("bad-layout", Msg::new("diag.j123.badLayout").arg("v", v), src);
                }
                first_src.resize(layouts.len(), src);
            }
            // 缺 `base=` 的自定义版面不出现
            let mut kept = vec![];
            for (l, src) in layouts.into_iter().zip(first_src) {
                if layout_base(&l).is_none() {
                    ctx.report("bad-layout", Msg::new("diag.j123.layoutNoBase").arg("v", l.name.as_str()), src);
                } else {
                    kept.push(l);
                }
            }
            let layouts = kept;
            if !layouts.is_empty() {
                song.layouts = Some(layouts);
            }
        }
        if ctx.d == Dialect::Abc || any_staff {
            resolve_abc_pitches(&mut song);
        }
        for (part, after) in song.parts.iter_mut().zip(break_maps.iter()) {
            breaks_after_to_start(part, after);
        }
        song.marks = std::mem::take(&mut self.marks);
        for part in song.parts.iter_mut() {
            let mut seq: Vec<&mut Element> = part.measures.iter_mut().flat_map(|m| m.elements.iter_mut()).collect();
            apply_tuplet_time_mods_default(&song.marks, &mut seq);
        }
        // `%%score [1 2]` / `{1 2}`：声部分组的括号
        let sc = song.style.as_ref().and_then(|s| s.raw.as_ref()).and_then(|r| r.iter().find(|r| r.key == "score")).map(|r| r.value.clone());
        if let Some(sc) = sc {
            let voice_ids = &self.voice_ids;
            let parts = &song.parts;
            let groups = score_part_groups(&sc, |id| {
                let n = voice_ids.iter().position(|l| l == id).map(|k| (k + 1) as f64).or_else(|| {
                    (!id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())).then(|| js::number(id))
                })?;
                let pid = format!("P{}", num_to_string(n));
                parts.iter().any(|p| p.id == pid).then_some(pid)
            });
            if !groups.is_empty() {
                song.part_groups = Some(groups);
            }
        }
        self.doc.songs.push(song);
        self.pb = None;
        self.voice_ids.clear();
    }
}

/// `%%score` 的值 → 声部分组：只认最外层的 `[…]`（bracket）与 `{…}`（brace）
fn score_part_groups(value: &str, part_of: impl Fn(&str) -> Option<String>) -> Vec<PartGroup> {
    let mut out = vec![];
    let cs: Vec<char> = value.chars().collect();
    let mut i = 0;
    while i < cs.len() {
        if cs[i] != '[' && cs[i] != '{' {
            i += 1;
            continue;
        }
        let Some(close) = (i + 1..cs.len()).find(|&j| cs[j] == ']' || cs[j] == '}') else { break };
        let inner: String = cs[i + 1..close].iter().collect();
        let parts: Vec<String> = inner
            .split(|c: char| js::is_space(c) || c == '(' || c == ')' || c == '|')
            .filter(|s| !s.is_empty())
            .filter_map(&part_of)
            .collect();
        let sym = cs[i];
        i = close + 1;
        if parts.len() < 2 {
            continue;
        }
        out.push(PartGroup {
            number: (out.len() + 1).to_string(),
            symbol: Some(if sym == '{' { GroupSymbol::Brace } else { GroupSymbol::Bracket }),
            name: None,
            abbrev: None,
            group_barline: None,
            parts,
        });
    }
    out
}

/// `%%<name>\b`（不分大小写），回指令名后面的位置
fn directive(line: &str, name: &str) -> Option<usize> {
    let rest = line.strip_prefix("%%")?;
    let t = rest.trim_start_matches(js::is_space);
    let at = line.len() - t.len();
    if t.len() < name.len() || !t.is_char_boundary(name.len()) || !t[..name.len()].eq_ignore_ascii_case(name) {
        return None;
    }
    Some(at + name.len())
}

fn word_boundary_after(line: &str, at: usize) -> bool {
    line[at..].chars().next().is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'))
}

fn is_directive(line: &str, name: &str) -> bool {
    directive(line, name).is_some_and(|at| word_boundary_after(line, at))
}

/// ABC 家族的通用解析：组装逻辑三种方言共用，差异全在 `Dialect` 的钩子里
pub fn parse_abc_family(text: &str, d: Dialect) -> ScoreDoc {
    let mut doc = empty_doc(match d {
        Dialect::J123 => SourceFormat::S123,
        Dialect::Abc => SourceFormat::Abc,
        Dialect::Jcx => SourceFormat::Jcx,
    });
    doc.source = Some(text.to_string());
    let mut p = Parser {
        ctx: Ctx {
            ids: IdGen::new(),
            diagnostics: vec![],
            d,
            len: d.default_len(4.0, 4.0),
            saw_l: false,
            time: None,
            time_changes: vec![],
            pending_sections: vec![],
            section_marks: vec![],
            blocks: vec![],
        },
        doc,
        song: None,
        builds: vec![],
        pb: None,
        marks: vec![],
        pending_lyrics: vec![],
        music_seen: false,
        saw_key: false,
        head_section: None,
        order_source: None,
        sing_rows: vec![],
        layout_rows: vec![],
        voice_ids: vec![],
    };
    let lexer = Lexer { dialect: d };
    let all = u16s::enc(text);
    // `text.split(/\r?\n/)` 与各行起点
    let mut lines: Vec<(&U16, u32)> = vec![];
    {
        let mut st = 0usize;
        for k in 0..=all.len() {
            if k == all.len() || all[k] == b'\n' as u16 {
                let e = if k > st && all[k - 1] == b'\r' as u16 && k < all.len() { k - 1 } else { k };
                lines.push((&all[st..e], st as u32));
                st = k + 1;
            }
        }
    }
    let mut text_block: Option<(Vec<String>, SourceSpan)> = None;
    let mut last_field: Option<String> = None;
    for (ln, &(raw, line_offset)) in lines.iter().enumerate() {
        let ln32 = ln as u32;
        let whole = SourceSpan { line: ln32, column: 0, offset: line_offset, length: raw.len() as u32 };
        let line = u16s::text(u16s::trim(raw));
        if let Some((lines_acc, _)) = text_block.as_mut() {
            if is_directive(&line, "endtext") {
                let (ls, _) = text_block.take().unwrap();
                p.ensure_song().remarks.get_or_insert_with(Vec::new).push(ls.join("\n"));
            } else {
                lines_acc.push(line);
            }
            continue;
        }
        if line.is_empty() {
            continue;
        }
        if line.starts_with('%') {
            if d == Dialect::Jcx && line.starts_with("%%") {
                if is_directive(&line, "begintext") {
                    text_block = Some((vec![], whole));
                } else if !is_directive(&line, "endtext") {
                    let v = js::trim(&line[2..]).to_string();
                    p.ensure_song().muse_directives.get_or_insert_with(Vec::new).push(v);
                }
                continue;
            }
            if d == Dialect::Abc && is_directive(&line, "newpage") {
                for (_, b) in p.builds.iter_mut() {
                    break_to_page(b);
                }
                continue;
            }
            if d == Dialect::J123 && is_directive(&line, "newpage") {
                for k in 0..p.builds.len() {
                    let is_cur = p.pb == Some(k);
                    let b = &mut p.builds[k].1;
                    if upgrade_break_to_page(b) || !is_cur || b.last_element_id().is_none() {
                        continue;
                    }
                    mark_break(&mut p.ctx, b, BreakKind::Page, whole);
                }
                continue;
            }
            if d == Dialect::J123 {
                if let Some(at) = directive(&line, "sing").filter(|&at| word_boundary_after(&line, at)) {
                    p.ensure_song();
                    p.sing_rows.push((line[at..].to_string(), whole));
                    continue;
                }
            }
            if matches!(d, Dialect::J123 | Dialect::Abc) {
                if let Some(at) = directive(&line, "layout").filter(|&at| word_boundary_after(&line, at)) {
                    p.ensure_song();
                    p.layout_rows.push((line[at..].to_string(), whole));
                    continue;
                }
            }
            if let Some(body) = line.strip_prefix("%%") {
                let ins = parse_instruction(body);
                let mut song = p.song.take().unwrap_or_else(empty_song);
                apply_instruction(&mut p.ctx, &mut song, ins, whole);
                p.song = Some(song);
            }
            continue;
        }

        // 行首 `[V:x]`：切声部，同一行后面接着的是这个声部的音乐
        let music_from = if d == Dialect::J123 { 0 } else { p.inline_voice(raw) };
        if music_from > 0 && u16s::trim(&raw[music_from..]).is_empty() {
            continue;
        }
        let mut f = if music_from > 0 { None } else { parse_field_line(raw, ln32, line_offset) };
        if let (Some(f), true) = (f.as_mut(), d == Dialect::Jcx) {
            if f.name == "W" {
                f.name = "w".into();
            }
            if f.name == "V" {
                let label = f.value.split(js::is_space).next().unwrap_or("").to_string();
                f.voice = Some(p.muse_voice(&label));
            }
        }
        if let Some(f) = f {
            if f.cont == Some(true) {
                if last_field.as_deref() == Some("w") {
                    let k = p.ensure_part();
                    p.add_lyric_line(k, &f);
                } else {
                    p.ctx.report("cont-unsupported", Msg::new("diag.j123.contUnsupported"), f.source);
                }
                continue;
            }
            last_field = Some(f.name.clone());
            if f.name == "X" {
                p.finish_song();
                p.ensure_song().work.number = Some(f.value.clone());
                continue;
            }
            if f.name == "P" && d != Dialect::Jcx {
                if f.value.is_empty() {
                    continue;
                }
                if p.music_seen {
                    p.ctx.pending_sections.push(f.value.clone());
                } else {
                    p.settle_head_section(false);
                    p.head_section = Some(f);
                }
                continue;
            }
            if f.name != "V" {
                p.settle_head_section(false);
            }
            if f.name == "K" {
                p.saw_key = true;
            }
            if f.name == "w" {
                let k = p.ensure_part();
                if p.builds[k].1.muse_style != Some(MuseStyle::Skip) {
                    p.add_lyric_line(k, &f);
                }
                continue;
            }
            p.ensure_song();
            p.apply_field(&f);
            continue;
        }

        // 音乐体
        last_field = None;
        p.ensure_song();
        p.settle_head_section(true);
        p.music_seen = true;
        let k = p.ensure_part();
        let ctx = &mut p.ctx;
        let pbk = &mut p.builds[k].1;
        if pbk.muse_style == Some(MuseStyle::Skip) {
            continue;
        }
        let need_block = match pbk.block {
            None => true,
            Some(b) => pbk.after_lyrics || ctx.blocks[b].broken,
        };
        if need_block {
            let at = ctx.slot_count(pbk);
            if let Some(b) = pbk.block {
                ctx.blocks[b].end = Some(at);
            }
            pbk.block = Some(ctx.new_block(at));
            pbk.after_lyrics = false;
        }
        let lex = lexer.lex_line(&raw[music_from..], ln32, line_offset, music_from);
        for e in lex.errors {
            ctx.report("lex", e.msg, e.source);
        }
        let header_len = ctx.len;
        if let Some(l) = pbk.len {
            ctx.len = l;
        }
        build_music_line(ctx, pbk, &lex.tokens, &mut p.marks);
        ctx.len = header_len;
        // ABC §6.1：代码里的换行就是谱面换行（123 用显式 `$`）
        if d.line_end_is_break() {
            let target = pbk.line_target();
            if let Some(t) = target {
                if let std::collections::hash_map::Entry::Vacant(e) = pbk.break_after.entry(t) {
                    e.insert(BreakKind::System);
                    pbk.note_inline_break(BreakKind::System);
                } else if t == pbk.cur_index() && pbk.inline_break.as_ref().map(|ib| ib.host) != pbk.measure.elements.last().map(|e| e.id()) {
                    pbk.note_inline_break(BreakKind::System);
                }
            }
            if let Some(b) = pbk.block {
                ctx.blocks[b].broken = true;
            }
        }
    }
    if let Some((ls, src)) = text_block.take() {
        p.ctx.report("jcx-text-open", Msg::new("diag.jcx.textOpen"), src);
        p.ensure_song().remarks.get_or_insert_with(Vec::new).push(ls.join("\n"));
    }
    p.finish_song();
    p.doc.diagnostics = std::mem::take(&mut p.ctx.diagnostics);
    p.doc
}

pub fn parse_123(text: &str) -> ScoreDoc {
    parse_abc_family(text, Dialect::J123)
}
pub fn parse_abc(text: &str) -> ScoreDoc {
    parse_abc_family(text, Dialect::Abc)
}
pub fn parse_jcx(text: &str) -> ScoreDoc {
    parse_abc_family(text, Dialect::Jcx)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 各声部一行一行轮流读：上一个声部行尾换了拍号，本声部行首的 `Z` 还在换之前的小节里
    #[test]
    fn measure_rest_takes_its_own_bars_meter() {
        let doc = parse_123("X:1\nK:1=C\nM:4/4\nV:1\n1 2 3 4 | [M:3/4] 1 2 3 |\nV:2\nZ | [M:3/4] Z |\n");
        let bass = &doc.songs[0].parts[1];
        let rest = |mi: usize| bass.measures[mi].elements[0].as_chord().unwrap().duration.divisions;
        assert_eq!(rest(0), SIMPLE_DIVISIONS * 4.0);
        assert_eq!(rest(1), SIMPLE_DIVISIONS * 3.0);
    }

    const LAYOUT_SONG: &str = "X:1\nT:例\nK:1=C\nM:4/4\n[P:A]1 2 3 4 | 5 6 [P:A2]7 1' | [P:B]5 5 6 6 | 1 - - - |]\n";

    fn layout_text(doc: &ScoreDoc) -> Vec<String> {
        crate::formats::abc::emit::emit_123(doc).lines().filter(|l| l.starts_with("%%layout") || l.starts_with("%%sing")).map(String::from).collect()
    }

    fn codes(doc: &ScoreDoc) -> Vec<String> {
        doc.diagnostics.iter().map(|d| d.code.clone()).collect()
    }

    /// 规范 §9.1 的例子：读→写→读逐字不变，同名几行合并、ASCII 名写回中文名
    #[test]
    fn layout_roundtrip() {
        let src = format!(
            "{LAYOUT_SONG}%%sing A A2 B\n%%sing A A2 B B@2\n%%layout jianpu linebreak=phrase\n%%layout 投影 linebreak=fill rows=4\n\
             %%layout projection pass=1 newpage=A\n%%layout 投影 pass=2 rows=5 break=A2,B\n%%layout 大字版 base=简谱 paper=A4 note-size=24 linebreak=bars:4\n"
        );
        let doc = parse_123(&src);
        assert!(codes(&doc).is_empty(), "{:?}", doc.diagnostics);
        let out = layout_text(&doc);
        assert_eq!(
            out,
            vec![
                "%%sing A A2 B",
                "%%sing A A2 B B@2",
                "%%layout 简谱 linebreak=phrase",
                "%%layout 投影 linebreak=fill rows=4",
                "%%layout 投影 pass=1 newpage=A",
                "%%layout 投影 pass=2 rows=5 break=A2,B",
                "%%layout 大字版 base=简谱 linebreak=bars:4 paper=A4 note-size=24",
            ]
        );
        let again = parse_123(&crate::formats::abc::emit::emit_123(&doc));
        assert_eq!(again.songs[0].layouts, doc.songs[0].layouts);
        // 不写成头部的 `I:layout`
        assert!(!crate::formats::abc::emit::emit_123(&doc).contains("I:layout"));
    }

    /// 写错的：不认识的键、投影专用键写给简谱、引用不存在的段、`*n` 超出、自定义版面缺 base
    #[test]
    fn layout_bad_items() {
        let src = format!(
            "{LAYOUT_SONG}%%sing A A2 B\n%%layout 简谱 rows=3 foo=1\n%%layout 投影 break=C\n%%layout 投影 pass=1 break=B*2\n%%layout 大字版 paper=A4\n%%layout 投影 linebreak=bars:0\n"
        );
        let doc = parse_123(&src);
        let bad = codes(&doc).iter().filter(|c| *c == "bad-layout").count();
        assert_eq!(bad, 6, "{:?}", doc.diagnostics);
        let names: Vec<&str> = doc.songs[0].layouts.iter().flatten().map(|l| l.name.as_str()).collect();
        assert!(!names.contains(&"大字版"), "{names:?}");
        assert!(doc.songs[0].layouts.iter().flatten().all(|l| l.breaks.is_none()), "{:?}", doc.songs[0].layouts);
    }

    /// 旧写法 `/` 与 `[rows=]` 不再认：报 `bad-sing`、不迁移
    #[test]
    fn old_sing_layout_is_bad_item() {
        let doc = parse_123(&format!("{LAYOUT_SONG}%%sing [rows=3] A / B\n"));
        assert!(codes(&doc).iter().any(|c| c == "bad-sing"), "{:?}", doc.diagnostics);
        assert_eq!(layout_text(&doc), vec!["%%sing A B"]);
    }

    /// ABC 同样截住 `%%layout`、写回原样
    #[test]
    fn layout_abc_roundtrip() {
        let doc = parse_abc("X:1\nT:t\nM:4/4\nL:1/4\nK:C\nP:A\n[P:A]CDEF|[P:B]GABc|]\n%%layout staff break=A\n");
        assert!(codes(&doc).iter().all(|c| c != "bad-layout"), "{:?}", doc.diagnostics);
        let out = crate::formats::abc::emit::emit_abc(&doc);
        assert!(out.contains("%%layout 五线谱 break=A"), "{out}");
        assert!(!out.contains("I:layout"), "{out}");
    }
}
