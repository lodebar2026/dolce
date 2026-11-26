//! 读入建树（照 `layout.ts`）：`ScoreDoc`（MusicXML 形状）→ `StaffLayout`（版面态）。从 musicpp mxml/parser.cpp 移植，判据原样。
//! 各声部读完之后的版面 pass 在 `pass`（`layoutpass.ts`）。
//!
//! **接口约定**：调用方先 `prepare_song`（多小节休止并成一小节，并过的新对象清掉 oid——TS 里展开出来的新对象查不到表层身份），
//! 留住那份歌，再 `layout_staff`。
//!
//! 与 TS 的对应：`DocPartLoader` 是 [`Loader`]；按对象作键的 `Map` / `Set` 换成按 id（和弦、音、歌词）或
//! 按文档对象地址（`tieAboveOf` 的 `DocNote`）作键；要按插入序走的表用 `Vec` 记次序。

// 照 TS 的写法（先声明后分支赋值、按下标走），便于逐行对照
#![allow(clippy::needless_range_loop, clippy::too_many_arguments)]

use crate::model::*;
use crate::pass::{self, LayoutInput, MeasureLayoutInput, PrintInput, Probe, StaffDetailInput, StaffLayoutInput, SystemLayoutInput};
use dolce_model::base::fraction::Fraction;
use dolce_model::base::js;
use dolce_engrave::articulation::artic_glyph;
use dolce_engrave::dynamics::dynamic_glyphs;
use dolce_engrave::spacing::EQ_PAD_EM;
use dolce_model::deconames::{deco_key, rehearsal_bracketed};
use dolce_model::doc::{
    BarLocation, Barline, Chord as DocChord, Clef as DocClef, ClefSign, Direction, Element, EndingType as DocEndingType, FontSpec,
    GroupSymbol as DocGroupSymbol, HAlign, Harmony, Key as DocKey, Lyric, Mark, MarkType, Measure, MeasureAttrs, Metronome, Note as DocNote,
    OctaveShift, Oid, OddEven, Orientation, Part as DocPart, Placement, Print, RepeatDir, ShiftDir, Song, SpanType, Time as DocTime,
    WedgeType,
};
use dolce_model::jianpu::{melody_chords, top_note};
use dolce_model::metakeys::get_meta;
use dolce_model::multirest::compress_multi_rests;
use dolce_model::xmlsurface::{Position, Surface};
use dolce_scene::smufl::MetaData;
use dolce_style::staff::MixedOptions;
use dolce_text::{CompressMode, Font, MeasureCtx};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

/// 谱表上方的记号：MusicXML 元素名 → SMuFL 字形（`OUTSIDE_GLYPH`）
fn outside_glyph(name: &str) -> Option<String> {
    let g = match name {
        "inverted-mordent" => "ornamentShortTrill",
        "mordent" => "ornamentMordent",
        "trill-mark" => "ornamentTrill",
        "turn" => "ornamentTurn",
        "up-bow" => "stringsUpBow",
        "down-bow" => "stringsDownBow",
        _ => return None,
    };
    Some(gs(g))
}

/// 文字与同一条 direction 里随后的速度记号之间的空（字号的倍数）
const WORDS_TEMPO_GAP_EM: f64 = 0.4;
/// Bravura Text 里 segno/coda 相对 Bravura 同一字形的大小（见 processSegno）
const BRAVURA_TEXT_SCALE: f64 = 0.8;

/// `STEP_DIATONIC[step] ?? 0`
fn step_diatonic(step: &str) -> f64 {
    match step {
        "C" => 0.0,
        "D" => 1.0,
        "E" => 2.0,
        "F" => 3.0,
        "G" => 4.0,
        "A" => 5.0,
        "B" => 6.0,
        _ => 0.0,
    }
}

fn make_clef(c: &DocClef) -> ClefSig {
    let oct_change = c.octave_change.unwrap_or(0.0);
    let sign = match c.sign {
        ClefSign::G => {
            if oct_change == -1.0 {
                gs("gClef8vb")
            } else {
                gs("gClef")
            }
        }
        ClefSign::F => gs("fClef"),
        ClefSign::C => gs("cClef"),
        ClefSign::Percussion => gs("unpitchedPercussionClef1"),
        ClefSign::Tab => gs("sixStringTabClef"),
        _ => gs("gClef"),
    };
    // 没写线位按各谱号的惯常线位：F 第 4 线、C 第 3 线（中音谱号）、其余第 2 线
    let line = c.line.unwrap_or(match c.sign {
        ClefSign::F => 4.0,
        ClefSign::C => 3.0,
        _ => 2.0,
    });
    ClefSig { sign, line }
}

fn make_key(key: &DocKey) -> KeySig {
    let mut k = KeySig { fifths: key.fifths, ..KeySig::default() };
    if let Some(c) = key.cancel {
        k.cancel = c;
    }
    k
}

fn make_time(time: &DocTime) -> TimeSig {
    TimeSig { beats: time.beats, beat_type: time.beat_type, symbol: matches!(time.symbol.as_deref(), Some("common") | Some("cut")) }
}

// ── 元素的公共字段（`Chord` / `Space` 两种都有） ──

fn el_onset(el: &Element) -> Option<f64> {
    match el {
        Element::Chord(c) => c.onset,
        Element::Space(s) => s.onset,
    }
}
fn el_staff(el: &Element) -> f64 {
    match el {
        Element::Chord(c) => c.staff,
        Element::Space(s) => s.staff,
    }
}
fn el_voice(el: &Element) -> f64 {
    match el {
        Element::Chord(c) => c.voice,
        Element::Space(s) => s.voice,
    }
}
fn el_harmony(el: &Element) -> Option<&Harmony> {
    match el {
        Element::Chord(c) => c.harmony.as_ref(),
        Element::Space(s) => s.harmony.as_ref(),
    }
}

/// JS 真值（`if (x)`）：0 与 NaN 为假
fn truthy(v: Option<f64>) -> bool {
    v.is_some_and(|n| n != 0.0 && !n.is_nan())
}

/// 下标（`arr[Math.min(x, len)]`）
fn at_index(x: f64, len: usize) -> usize {
    js::min(x, len as f64) as usize
}

struct Timing {
    onsets: Vec<f64>,
    /// endAfter[k]：前 k 个元素之后的「前一个元素终点」
    end_after: Vec<f64>,
    end: f64,
}

/// 一个元素在小节里的游标（divisions）：`onset` 缺省 = 前一个元素的终点
fn measure_timing(m: &Measure) -> Timing {
    let mut onsets = Vec::with_capacity(m.elements.len());
    let mut end_after = vec![0.0];
    let mut prev_end = 0.0;
    let mut max_end = m.duration.unwrap_or(0.0);
    for el in &m.elements {
        let on = el_onset(el).unwrap_or(prev_end);
        onsets.push(on);
        if let Element::Chord(c) = el {
            prev_end = on + c.duration.divisions;
            if prev_end > max_end {
                max_end = prev_end;
            }
        }
        end_after.push(prev_end);
    }
    Timing { onsets, end_after, end: max_end }
}

/// `Direction` 自己与 `Direction.more` 的各项（TS 里 `d as DirectionPart`）
#[derive(Clone)]
struct PartView<'d> {
    kind: &'d str,
    text: Option<&'d str>,
    tempo: Option<&'d Metronome>,
    span_type: Option<SpanType>,
    wedge_type: Option<WedgeType>,
    line: Option<bool>,
    shift: Option<&'d OctaveShift>,
    oid: Oid,
}

struct TieRef {
    note: NoteId,
    pitch: f64,
    end_tick: Fraction,
    /// 源谱写了的朝向（`<tied orientation>`），起点才有
    above: Option<bool>,
}

struct OctaveSpan {
    staff: f64,
    from: (f64, f64),
    to: (f64, f64),
    steps: f64,
}

struct OctavePt<'d> {
    mif: MeasId,
    tick: Fraction,
    staff: usize,
    stop: bool,
    shift: Option<&'d OctaveShift>,
}

struct LrcExtendPt {
    note: NoteId,
    lrc: LyricId,
    tick: Fraction,
    stop: bool,
}

struct EndingPt {
    mif: MeasId,
    nums: Vec<i64>,
    text: String,
    start: bool,
    stop: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum WedgeKind {
    Crescendo,
    Diminuendo,
    Stop,
}

struct WedgePt {
    mif: MeasId,
    tick: Fraction,
    staff: usize,
    kind: WedgeKind,
    rel_x: Option<f64>,
    def_y: Option<f64>,
    spread: Option<f64>,
}

struct PedalPt {
    mif: MeasId,
    tick: Fraction,
    staff: usize,
    line: bool,
    stop: bool,
    ypos: f64,
}

/// 按插入序的 `Map<string, T[]>`
fn push_keyed<K: PartialEq, T>(m: &mut Vec<(K, Vec<T>)>, k: K, v: T) {
    match m.iter_mut().find(|(e, _)| *e == k) {
        Some((_, arr)) => arr.push(v),
        None => m.push((k, vec![v])),
    }
}

/// `DocPartLoader`
struct Loader<'a, 'd> {
    sl: &'a mut StaffLayout<'d>,
    part: PartId,
    src: &'d DocPart,
    surface: Option<&'d Surface>,
    encoder: Encoder,
    /// 本声部的 slur / tuplet（按收口先后），按收口那个和弦 id 分组
    marks_by_end: HashMap<u32, Vec<&'d Mark>>,
    chord_by_id: HashMap<u32, ChordId>,
    doc_chord_by_id: HashMap<u32, &'d DocChord>,
    /// note → stem default-y
    stem_y_map: HashMap<NoteId, f64>,
    /// 有 <stem> 元素的音符（parser.cpp stemDir）；插入序
    stem_notes: Vec<NoteId>,
    stem_note_set: HashSet<NoteId>,
    /// 方向是猜的（整个和弦都没写 `<stem>`）的和弦
    guessed_stem: HashSet<ChordId>,
    /// 本声部是否出现过 <beam>（无则自动按拍分组符杠，供 OMR 谱用）
    has_beam_el: bool,
    transpose_steps: f64,
    /// 当前小节里同一谱表并存多个声部时，各声部的符干方向（`staff:voice` → 朝上）
    voice_stem: HashMap<String, bool>,
    /// 方向已按声部定好的和弦（`voiceStem`）
    forced_stem: HashSet<ChordId>,
    cur_div: f64,
    octave_spans: Vec<OctaveSpan>,
    octave_steps: f64,
    octave_pts: Vec<OctavePt<'d>>,
    /// 简谱叠层的旋律：和弦（小节内元素下标）→ 印的那个音（和弦内下标；None = 没有音）
    melody: HashMap<usize, Option<usize>>,

    tie_starts: Vec<TieRef>,
    tie_stops: Vec<TieRef>,
    /// 起点音（按文档对象地址）→ 源谱写的延音线朝向
    tie_above_of: HashMap<*const DocNote, bool>,
    lrc_by_num: Vec<(String, Vec<LyricId>)>,
    lrc_extend_pts: Vec<LrcExtendPt>,
    ending_pts: Vec<EndingPt>,
    /// 琶音：当前小节内按 offset 聚合的音符（插入序）
    arpeg_notes: Vec<(String, Vec<NoteId>)>,
    wedge_pts: Vec<WedgePt>,
    pedal_pts: Vec<PedalPt>,
}

impl<'a, 'd> Loader<'a, 'd> {
    fn new(sl: &'a mut StaffLayout<'d>, part: PartId, src: &'d DocPart, marks: &'d [Mark]) -> Loader<'a, 'd> {
        let surface = sl.surface;
        let encoder = sl.encoder();
        let auto_layout = sl.auto_layout;
        let mut ld = Loader {
            sl,
            part,
            src,
            surface,
            encoder,
            marks_by_end: HashMap::new(),
            chord_by_id: HashMap::new(),
            doc_chord_by_id: HashMap::new(),
            stem_y_map: HashMap::new(),
            stem_notes: Vec::new(),
            stem_note_set: HashSet::new(),
            guessed_stem: HashSet::new(),
            has_beam_el: false,
            transpose_steps: 0.0,
            voice_stem: HashMap::new(),
            forced_stem: HashSet::new(),
            cur_div: 1.0,
            octave_spans: Vec::new(),
            octave_steps: 0.0,
            octave_pts: Vec::new(),
            melody: HashMap::new(),
            tie_starts: Vec::new(),
            tie_stops: Vec::new(),
            tie_above_of: HashMap::new(),
            lrc_by_num: Vec::new(),
            lrc_extend_pts: Vec::new(),
            ending_pts: Vec::new(),
            arpeg_notes: Vec::new(),
            wedge_pts: Vec::new(),
            pedal_pts: Vec::new(),
        };
        let mut ids: HashSet<u32> = HashSet::new();
        for m in &src.measures {
            for el in &m.elements {
                let Element::Chord(c) = el else { continue };
                ids.insert(c.id);
                ld.doc_chord_by_id.insert(c.id, c);
            }
        }
        for mk in marks {
            // 延音线朝向只在自动铺排时照源谱：带坐标的原文照原 C++ 工程按声部与符干猜
            if mk.kind == MarkType::Tied {
                if !auto_layout {
                    continue;
                }
                let dir = if mk.placement == Some(Placement::Above) || mk.orientation == Some(Orientation::Over) {
                    Some(true)
                } else if mk.placement == Some(Placement::Below) || mk.orientation == Some(Orientation::Under) {
                    Some(false)
                } else {
                    None
                };
                let n = ld.doc_chord_by_id.get(&mk.start).and_then(|c| js::index(mk.start_note.unwrap_or(0.0)).and_then(|i| c.notes.get(i)));
                if let (Some(dir), Some(n)) = (dir, n) {
                    ld.tie_above_of.insert(n as *const DocNote, dir);
                }
                continue;
            }
            if mk.kind != MarkType::Slur && mk.kind != MarkType::Tuplet {
                continue;
            }
            if !ids.contains(&mk.start) || !ids.contains(&mk.end) {
                continue;
            }
            ld.marks_by_end.entry(mk.end).or_default().push(mk);
        }
        ld
    }

    // ── 表层查询（没有表层 / 没有身份 = 查不到） ──

    fn pos(&self, oid: Oid) -> Option<Position> {
        self.surface.and_then(|s| s.xml_pos(oid))
    }
    fn font(&self, oid: Oid) -> Option<FontSpec> {
        self.surface.and_then(|s| s.xml_font(oid))
    }
    fn justify(&self, oid: Oid) -> Option<HAlign> {
        self.surface.and_then(|s| s.xml_align(oid).0)
    }
    fn stem(&self, note: Option<&DocNote>) -> Option<(String, Option<f64>)> {
        note.and_then(|n| self.surface.and_then(|s| s.note_stem(n.oid)))
    }

    fn load(&mut self) {
        let first = self.src.measures.first().and_then(|m| m.attrs.as_ref());
        let stave_count = first.and_then(|a| a.staves).unwrap_or(1.0);
        if let Some(tr) = first.and_then(|a| a.transpose.as_ref()) {
            self.transpose_steps = tr.diatonic.unwrap_or(0.0);
        }
        let mut i = 0usize;
        while (i as f64) < stave_count {
            let ps = PartStaff::new(self.part, i);
            self.sl[self.part].staves.push(ps);
            i += 1;
        }

        // 绝对 tick 必须在 loadMeasure 之前就设到 mif.offset（对齐 musicpp parser.cpp:1291）
        self.scan_octave_spans();
        let mut div = 1.0;
        let mut run_tick = Fraction::int(0.0);
        for mid in 0..self.src.measures.len() {
            let m = &self.src.measures[mid];
            if mid >= self.sl.measures.len() {
                continue;
            }
            let mif = MeasId(mid);
            self.sl[mif].offset = run_tick;
            div = self.load_measure(m, mif, div, mid);
            run_tick = run_tick.plus(&self.sl[mif].dur);
        }

        self.calc_stem_len();
        if !self.has_beam_el {
            self.auto_beam_part();
        }
        self.format_beams();
        self.fit_flag_stems();
        // 符干/符杠就绪后再排记号（musicpp parser.cpp:2914）
        for i in 0..self.sl[self.part].measures.len() {
            let md = self.sl[self.part].measures[i];
            self.sl.pm_layout_notations(md);
        }
        self.process_tied();
        self.process_ending();
        self.pair_wedges();
        self.pair_pedals();
        self.pair_octaves();
        self.process_lrc_extend();
        self.sl.part_guess_tied_placement(self.part);
        // 只留旋律放在**最后**（util/pao.cpp:1003）
        if self.sl.options.melody_only {
            self.remove_none_melody();
        }
    }

    /// Part::removeNoneMelody（model.cpp:2312）
    fn remove_none_melody(&mut self) {
        let sib = self.encoder == Encoder::Sibelius;
        let p = self.part;
        // Sibelius 把两声部的弧都写在和弦首音上：按弧的方向重挂——上方弧挂最高音、下方弧挂最低音
        let slurs = self.sl[p].slurs.clone();
        let mut kept = Vec::new();
        for sl in slurs {
            let above = self.sl[sl].span.above;
            let pick = |s: &StaffLayout, nt: Option<NoteId>| -> Option<NoteId> {
                let nt = nt?;
                if !sib {
                    return Some(nt);
                }
                let ns = &s[s[nt].chord].notes;
                Some(if above { ns[ns.len() - 1] } else { ns[0] })
            };
            let sn = pick(self.sl, self.sl[sl].notes.start_note);
            self.sl[sl].notes.start_note = sn;
            if sn.is_some_and(|n| !self.sl[n].jp_melody) {
                continue;
            }
            let en = pick(self.sl, self.sl[sl].notes.end_note);
            self.sl[sl].notes.end_note = en;
            if en.is_some_and(|n| !self.sl[n].jp_melody) {
                continue;
            }
            kept.push(sl);
        }
        self.sl[p].slurs = kept;
        // 延音线按**原本挂的那个音**判，不重挂
        let tied = self.sl[p].tied.clone();
        let tied: Vec<TiedId> = tied
            .into_iter()
            .filter(|&t| {
                let s = &*self.sl;
                !(s[t].notes.start_note.is_some_and(|n| !s[n].jp_melody)) && !(s[t].notes.end_note.is_some_and(|n| !s[n].jp_melody))
            })
            .collect();
        self.sl[p].tied = tied;
        for i in 0..self.sl[p].measures.len() {
            let md = self.sl[p].measures[i];
            let chords = self.sl[md].chords.clone();
            let mut keep = Vec::new();
            for c in chords {
                let n = self.sl[c].notes.iter().copied().find(|&nn| self.sl[nn].jp_melody);
                let Some(n) = n else { continue };
                self.sl[c].notes = vec![n];
                keep.push(c);
            }
            self.sl[md].chords = keep;
            for j in 0..self.sl[md].note_entries.len() {
                let ent = self.sl[md].note_entries[j];
                let notes: Vec<NoteId> = self.sl[ent].notes.iter().copied().filter(|&n| self.sl[n].jp_melody).collect();
                self.sl[ent].notes = notes;
                self.sl.entry_layout(ent, sib, 0.0);
            }
            // 组里还留着非旋律音的符杠组整组删
            let beams = self.sl[md].beams.clone();
            let beams: Vec<BeamId> = beams
                .into_iter()
                .filter(|&g| {
                    let s = &*self.sl;
                    !s[g].chords.iter().any(|&ch| s[ch].notes.iter().any(|&n| !s[n].jp_melody))
                })
                .collect();
            self.sl[md].beams = beams;
        }
        self.guess_stem_dir();
        self.format_beams();
    }

    /// 八度线（`<octave-shift>`）覆盖哪些音：记谱要挪的度数，起止按谱表配对，止点之前（不含）的音都算在里面。
    fn scan_octave_spans(&mut self) {
        let mut open: Vec<(f64, (f64, f64), f64)> = Vec::new(); // staff → (from, steps)，插入序
        for (mi, m) in self.src.measures.iter().enumerate() {
            let dirs: Vec<&Direction> = m.directions.iter().flatten().filter(|d| d.kind == "octave-shift").collect();
            if dirs.is_empty() {
                continue;
            }
            let tm = measure_timing(m);
            let len = m.elements.len();
            let at = |d: &Direction| -> f64 { d.onset.unwrap_or_else(|| tm.end_after[at_index(d.after_elements.unwrap_or(0.0), len)]) };
            // 同一处先收后起
            let mut sorted = dirs.clone();
            js::sort_by(&mut sorted, |a, b| {
                let d = at(a) - at(b);
                if d != 0.0 && !d.is_nan() {
                    return d;
                }
                let sa = if a.span_type == Some(SpanType::Stop) { -1.0 } else { 0.0 };
                let sb = if b.span_type == Some(SpanType::Stop) { -1.0 } else { 0.0 };
                sa - sb
            });
            for d in sorted {
                let staff = d.staff.unwrap_or(1.0);
                if d.span_type == Some(SpanType::Stop) {
                    if let Some(k) = open.iter().position(|o| o.0 == staff) {
                        let o = open.remove(k);
                        self.octave_spans.push(OctaveSpan { staff, from: o.1, to: (mi as f64, at(d)), steps: o.2 });
                    }
                } else if d.span_type != Some(SpanType::Continue) {
                    let oct = if d.shift.as_ref().map_or(8.0, |s| s.size) >= 15.0 { 14.0 } else { 7.0 };
                    let steps = if d.shift.as_ref().is_some_and(|s| s.dir == ShiftDir::Up) { oct } else { -oct };
                    let v = (staff, (mi as f64, at(d)), steps);
                    match open.iter_mut().find(|o| o.0 == staff) {
                        Some(o) => *o = v,
                        None => open.push(v),
                    }
                }
            }
        }
    }

    fn octave_steps_at(&self, staff: f64, mi: f64, on: f64) -> f64 {
        let le = |a: (f64, f64), b: (f64, f64)| a.0 < b.0 || (a.0 == b.0 && a.1 <= b.1);
        self.octave_spans.iter().find(|x| x.staff == staff && le(x.from, (mi, on)) && !le(x.to, (mi, on))).map_or(0.0, |s| s.steps)
    }

    fn load_measure(&mut self, m: &'d Measure, mif: MeasId, prev_div: f64, mid: usize) -> f64 {
        let mut div = prev_div;
        if let Some(dv) = m.attrs.as_ref().and_then(|a| a.divisions) {
            if dv > 0.0 {
                div = dv;
            }
        }

        let Timing { onsets, end_after, end } = measure_timing(m);
        let dur = Fraction::new(end, div);
        if dur.compare_to(&self.sl[mif].dur) > 0 {
            self.sl[mif].dur = dur;
        }
        self.sl[mif].number = m.number.clone();
        if let Some(n) = m.attrs.as_ref().and_then(|a| a.multi_rest) {
            if truthy(Some(n)) {
                self.sl[mif].multi_rest = n;
            }
        }
        if m.implicit == Some(true) {
            self.sl[mif].implicit = true;
        }
        if let Some(width) = self.surface.and_then(|s| s.measure_width(m.oid)) {
            self.sl[mif].width = width;
        }

        let md = self.sl.part_new_measure(self.part, mif);
        self.cur_div = div;
        // 简谱叠层印的那一路：语义层的旋律取音（第一谱表最小 voice 的和弦，和弦取最高音）
        self.melody = melody_chords(m, Some(1.0))
            .into_iter()
            .map(|i| {
                let Element::Chord(c) = &m.elements[i] else { unreachable!("melody_chords 只回和弦") };
                (i, top_note(c))
            })
            .collect();

        self.arpeg_notes.clear();
        self.load_voice_stems(m);

        if let Some(a) = &m.attrs {
            let t = self.sl[mif].offset;
            self.process_attributes(a, t);
        }

        let tick_of = |divs: f64| Fraction::new(divs, div);
        // `<harmony><offset>`：musicpp 只认 MuseScore 写的；本应用自己写出的也认
        let enc = self.encoder;
        let harmony_delta = |h: &Harmony| -> Fraction {
            match h.offset {
                Some(o) if enc == Encoder::MuseScore || enc == Encoder::Dolce => Fraction::new(js::round(o), div),
                _ => Fraction::int(0.0),
            }
        };
        let len = m.elements.len();

        for (i, el) in m.elements.iter().enumerate() {
            if i > 0 {
                self.later_attrs_at(m, mif, i, &end_after, div);
            }
            let on = onsets[i];
            match el {
                Element::Chord(c) => {
                    for h in c.harmony.iter().chain(c.later_harmonies.iter().flatten()) {
                        self.process_harmony(h, md, tick_of(h.onset.unwrap_or(on)).plus(&harmony_delta(h)));
                    }
                    let tick = tick_of(on);
                    self.octave_steps = if self.octave_spans.is_empty() { 0.0 } else { self.octave_steps_at(c.staff, mid as f64, on) };
                    let mut ch: Option<ChordId> = None;
                    if c.notes.is_empty() {
                        ch = Some(self.process_note(c, i, None, 0, md, tick, ch));
                    }
                    for (k, n) in c.notes.iter().enumerate() {
                        ch = Some(self.process_note(c, i, Some(n), k, md, tick, ch));
                    }
                }
                Element::Space(_) => {
                    if let Some(h) = el_harmony(el) {
                        self.process_harmony(h, md, tick_of(h.onset.unwrap_or(on)).plus(&harmony_delta(h)));
                    }
                }
            }
        }
        for d in m.directions.iter().flatten() {
            if d.kind == "sound" {
                continue;
            }
            let at = d.onset.unwrap_or_else(|| end_after[at_index(d.after_elements.unwrap_or(0.0), len)]);
            let delta = match d.offset {
                Some(o) => Fraction::new(js::round(o), div),
                None => Fraction::int(0.0),
            };
            self.process_direction(d, md, tick_of(at).plus(&delta));
        }
        self.later_attrs_at(m, mif, len, &end_after, div);
        for b in m.barlines.iter().flatten() {
            self.process_barline(b, mif);
        }

        // 整小节休止照 parser.cpp:1304：拿**当前拍号**折算的小节长 tsDur 比
        {
            let ts = self.sl[self.part].staves.first().and_then(|s| s.time.last()).map(|e| e.v.clone());
            if let Some(ts) = ts {
                let ts_dur = Fraction::new(ts.beats * 4.0, ts.beat_type);
                for j in 0..self.sl[md].chords.len() {
                    let c = self.sl[md].chords[j];
                    if self.sl[c].rest() && f_eq(&self.sl[c].dur(), &ts_dur) {
                        self.sl[c].measure_rest = true;
                    }
                }
            }
        }

        self.sl.pm_sort_chords(md);
        // 符杠组先整组定方向，再建 NoteEntry、算符干长
        for j in 0..self.sl[md].beams.len() {
            let g = self.sl[md].beams[j];
            if self.sl[g].chords.iter().all(|&c| self.sl[c].rest() || self.guessed_stem.contains(&c)) {
                self.sl.beam_unify_stem_dir(g);
            }
        }
        self.sl.pm_layout_notes(md, self.encoder == Encoder::Sibelius);

        // 琶音成组（parser.cpp:1972）：同 offset 一组，按 staff、line 排序后回填 nt.arpeg。
        let groups = std::mem::take(&mut self.arpeg_notes);
        for (_, mut notes) in groups {
            let arp = self.sl.new_arpeggiate();
            {
                let s = &*self.sl;
                js::sort_by(&mut notes, |a, b| {
                    let (sa, sb) = (s.note_staff(*a) as f64, s.note_staff(*b) as f64);
                    if sa != sb {
                        sa - sb
                    } else {
                        s.note_line(*a) - s.note_line(*b)
                    }
                });
            }
            for &n in &notes {
                self.sl[n].arpeg = Some(arp);
            }
            self.sl[arp].notes = notes;
            self.sl[md].arpegs.push(arp);
        }
        div
    }

    /// 小节中间的 <attributes> 要在读到那个位置时就设上
    fn later_attrs_at(&mut self, m: &'d Measure, mif: MeasId, i: usize, end_after: &[f64], div: f64) {
        for la in m.later_attrs.iter().flatten() {
            if js::min(la.after_elements, m.elements.len() as f64) != i as f64 {
                continue;
            }
            let t = self.sl[mif].offset.plus(&Fraction::new(la.onset.unwrap_or(end_after[i]), div));
            self.process_attributes(&la.attrs, t);
        }
    }

    fn process_attributes(&mut self, a: &MeasureAttrs, tick: Fraction) {
        let p = self.part;
        for c in a.clefs.iter().flatten() {
            let num = c.staff.unwrap_or(1.0) - 1.0;
            // TS 谱表号为 0 时取到 staves[-1] 抛错；这里跳过
            if num >= 0.0 && num < self.sl[p].staves.len() as f64 {
                self.sl[p].staves[num as usize].clef.set(tick, make_clef(c));
            }
        }
        if let Some(k) = &a.key {
            let ks = make_key(k);
            for stf in &mut self.sl[p].staves {
                stf.key.set(tick, ks.clone());
            }
        }
        if let Some(t) = &a.time {
            let ts = make_time(t);
            for stf in &mut self.sl[p].staves {
                stf.time.set(tick, ts.clone());
            }
        }
    }

    /// 一个 `<note>`：`k` 是它在和弦里的下标（首音建 `ChordLayout`，其余并进去）。`note` 为 None 是没有音高的休止/节奏音符。
    /// `ei`：和弦在小节里的元素下标（查旋律用）
    fn process_note(
        &mut self,
        src: &'d DocChord,
        ei: usize,
        note: Option<&'d DocNote>,
        k: usize,
        md: PmId,
        tick: Fraction,
        prev_chord: Option<ChordId>,
    ) -> ChordId {
        let ch = match prev_chord {
            None => {
                let ch = self.sl.pm_new_chord(md, src, self.cur_div);
                self.sl[ch].offset = tick;
                self.process_beam(ch, md);
                self.chord_by_id.insert(src.id, ch);
                ch
            }
            Some(c) => c,
        };

        let nt = self.sl.new_note(ch);
        self.sl[nt].src = note;
        let top = self.melody.get(&ei);
        self.sl[nt].jp_melody = match top {
            None => false,
            Some(t) => note.is_none() || *t == Some(k),
        };

        let rest = self.sl[ch].rest();
        let pitch = note.and_then(|n| n.pitch.as_ref());
        if let (false, Some(p)) = (rest, pitch) {
            self.sl[nt].written_pitch = p.octave * 7.0 + step_diatonic(p.step.as_str()) + self.transpose_steps + self.octave_steps;
        } else if let (false, Some(u)) = (rest, note.and_then(|n| n.unpitched.as_ref()).filter(|u| u.step.is_some())) {
            // 节奏音符照 `<unpitched>` 的显示位置画，不跟移调
            self.sl[nt].written_pitch = u.octave.unwrap_or(4.0) * 7.0 + step_diatonic(u.step.as_ref().map_or("", |s| s.as_str()));
        }
        let pos_oid = note.map_or(src.oid, |n| n.oid);
        self.sl[nt].x = self.pos(pos_oid).and_then(|p| p.default_x).unwrap_or(-1.0);

        let stem = self.stem(note);
        let below_whole = || self.sl[ch].note_type().compare_to(&Fraction::int(4.0)) < 0;
        let vkey = format!("{}:{}", js::num_to_string(src.staff), js::num_to_string(src.voice));
        if let Some((dir, y)) = stem {
            self.sl[ch].stem_up = dir == "up";
            self.add_stem_note(nt);
            if let Some(y) = y {
                self.stem_y_map.insert(nt, y);
            }
        } else if !self.voice_stem.is_empty() && k == 0 && !rest && below_whole() && self.voice_stem.contains_key(&vkey) {
            // 同一谱表并存两个声部（ABC `&` 的临时多声部）：按声部定方向，不按音高猜。**不登记进 `guessedStem`**
            self.sl[ch].stem_up = self.voice_stem[&vkey];
            self.add_stem_note(nt);
            self.forced_stem.insert(ch);
        } else if k == 0 && !rest && below_whole() && !src.notes.iter().any(|n| self.stem(Some(n)).is_some()) {
            // 整个和弦都没有 <stem> 且需符干的谱：按首音相对中线位置定默认方向。和弦里只有部分音写了 <stem> 时不猜
            self.sl[ch].stem_up = self.sl.note_line(nt) < -4.0;
            self.add_stem_note(nt);
            self.guessed_stem.insert(ch);
        }

        let t = self.sl.chord_tick(ch);
        self.process_tie(note, nt, t);
        let arp = self.process_notations(src, k, ch);
        if arp {
            let key = frac_key(&self.sl[ch].offset);
            push_keyed(&mut self.arpeg_notes, key, nt);
        }
        if !rest && k == 0 {
            self.process_lrc(src.lyrics.as_deref().unwrap_or(&[]), md, ch, nt);
        }
        ch
    }

    fn add_stem_note(&mut self, nt: NoteId) {
        if self.stem_note_set.insert(nt) {
            self.stem_notes.push(nt);
        }
    }

    fn process_beam(&mut self, ch: ChordId, md: PmId) {
        let src = self.sl[ch].src;
        let Some(beams) = src.beams.as_ref().filter(|b| !b.is_empty()) else { return };
        self.has_beam_el = true;
        // beamMap：下标 → 值（认不得的不进表；最大下标之前缺的补 continue）
        let mut map: Vec<Option<BeamVal>> = Vec::new();
        for b in beams {
            map.push(match js::trim(b.as_str()) {
                "begin" => Some(BeamVal::Begin),
                "continue" => Some(BeamVal::Continue),
                "end" => Some(BeamVal::End),
                "forward hook" => Some(BeamVal::Forward),
                "backward hook" => Some(BeamVal::Backward),
                _ => None,
            });
        }
        let Some(max_idx) = map.iter().rposition(|v| v.is_some()) else { return };
        let vals: Vec<BeamVal> = (0..=max_idx).map(|i| map[i].unwrap_or(BeamVal::Continue)).collect();
        self.sl[ch].beams = vals;

        let grace = self.sl[ch].grace();
        if self.sl[ch].beams[0] == BeamVal::Begin {
            let g = self.sl.new_beam(BeamGroup { chords: vec![ch], ..BeamGroup::default() });
            if grace {
                self.sl[md].grace_beams.push(g);
            } else {
                self.sl[md].beams.push(g);
            }
        } else {
            let last = if grace { self.sl[md].grace_beams.last().copied() } else { self.sl[md].beams.last().copied() };
            if let Some(g) = last {
                self.sl[g].chords.push(ch);
            }
        }
    }

    fn process_lrc(&mut self, lyrics: &'d [Lyric], md: PmId, ch: ChordId, nt: NoteId) {
        for l in lyrics {
            let lrc = self.sl.pm_new_lyric(md, l, ch);
            self.sl[lrc].offset = self.sl[ch].offset;
            self.sl[lrc].x = self.sl[nt].x;

            let pos = self.pos(l.oid);
            let mut y = pos.and_then(|p| p.default_y).unwrap_or(-1.0);
            if let Some(ry) = pos.and_then(|p| p.relative_y) {
                y += ry;
            }
            self.sl[lrc].y = y;
            if pos.and_then(|p| p.default_y).is_some() {
                self.sl[lrc].src_y = Some(y);
            }
            let lf = self.font(l.oid);
            let lyric_font = self.sl.defaults.lyric_font.clone();
            self.sl[lrc].font = match &lf {
                Some(f) if f.family.as_deref().is_some_and(|s| !s.is_empty()) || truthy(f.size) => Font::new(
                    f.family.clone().unwrap_or(lyric_font.family.clone()),
                    if truthy(f.size) { f.size.unwrap_or(0.0) / self.sl.scaling } else { lyric_font.size },
                ),
                _ => lyric_font,
            };
            // 挤压档照样式
            self.sl[lrc].compress = CompressMode::parse(&self.sl.options.punct_compress);

            self.sl.lyric_update_width(lrc);

            // register for prev/next linking
            let num = self.sl[lrc].num();
            push_keyed(&mut self.lrc_by_num, num, lrc);

            // lyric extend (melisma): collect points, paired later
            if l.extend == Some(true) {
                let tick = self.sl.chord_tick(ch);
                self.lrc_extend_pts.push(LrcExtendPt { note: nt, lrc, tick, stop: l.extend_type == Some(SpanType::Stop) });
            }
        }
    }

    fn process_tie(&mut self, note: Option<&'d DocNote>, nt: NoteId, tick: Fraction) {
        let Some(note) = note else { return };
        let tie = note.tie.as_ref();
        if tie.and_then(|t| t.start) == Some(true) {
            self.sl[nt].tie_begin = true;
            let dur = self.sl[self.sl[nt].chord].dur();
            self.tie_starts.push(TieRef {
                note: nt,
                pitch: self.sl[nt].written_pitch,
                end_tick: tick.plus(&dur),
                above: self.tie_above_of.get(&(note as *const DocNote)).copied(),
            });
        }
        if tie.and_then(|t| t.stop) == Some(true) {
            self.sl[nt].tie_end = true;
            self.tie_stops.push(TieRef { note: nt, pitch: self.sl[nt].written_pitch, end_tick: tick, above: None });
        }
    }

    /// 第 `k` 个音上的记号。和弦级的（fermata/articulations/arpeggiate）挂首音；slur/tuplet 在收口那个音上建。
    fn process_notations(&mut self, src: &'d DocChord, k: usize, ch: ChordId) -> bool {
        let n = if k == 0 { src.notations.as_ref() } else { None };
        // fermata（parser.cpp:1446 processNotations）。type=inverted → 下方。
        if n.is_some_and(|n| n.fermata == Some(true)) {
            let above = n.and_then(|n| n.fermata_inverted) != Some(true);
            let item = NotationItem { above, symbol: gs(if above { "fermataAbove" } else { "fermataBelow" }), ..NotationItem::default() };
            self.sl[ch].notations.push(item);
        }
        // arpeggiate（parser.cpp:1461）—— 实际上下竖波浪线在 loadMeasure 末尾成组。
        let arp = src.notations.as_ref().and_then(|n| n.arpeggiate) == Some(true);
        // articulations（parser.cpp:1463）
        for a in n.and_then(|n| n.articulations.as_ref()).into_iter().flatten() {
            // 换气（`breath-mark`）不是挂在符头上下的记号，单记一笔
            if deco_key(a) == Some("hx") {
                self.sl[ch].breath = true;
                continue;
            }
            let symbol = artic_glyph(a, false);
            if symbol.is_empty() {
                continue;
            }
            let mut item = NotationItem::default();
            if a == "strong-accent" {
                item.above = true;
            }
            item.symbol = symbol;
            if let Some(pl) = n.and_then(|n| n.artic_placement.as_ref()).and_then(|m| m.get(a.as_str())) {
                item.placed = Some(*pl == Placement::Above);
            }
            self.sl[ch].notations.push(item);
        }
        // 波音、颤音（`<ornaments>`）与弓法（`<technical>`）：印在谱表上方
        let names = n.and_then(|n| n.ornaments.as_ref()).into_iter().flatten().chain(n.and_then(|n| n.technical.as_ref()).into_iter().flatten());
        for name in names {
            let Some(symbol) = outside_glyph(name) else { continue };
            let item = NotationItem { symbol, outside: true, ..NotationItem::default() };
            self.sl[ch].notations.push(item);
        }
        let marks = self.marks_by_end.get(&src.id).cloned().unwrap_or_default();
        for mk in marks {
            if mk.end_note.unwrap_or(0.0) != k as f64 {
                continue;
            }
            let Some(&start) = self.chord_by_id.get(&mk.start) else { continue };
            if mk.kind == MarkType::Slur {
                // parser.cpp::processSlur —— placement 优先，缺省时退回 orientation
                let above = match (&mk.placement, &mk.orientation) {
                    (Some(Placement::Above), _) => Some(true),
                    (Some(Placement::Below), _) => Some(false),
                    (_, Some(Orientation::Over)) => Some(true),
                    (_, Some(Orientation::Under)) => Some(false),
                    _ => None,
                };
                let sl = self.sl.part_new_slur(self.part);
                let st = self.sl.chord_tick(start);
                let et = self.sl.chord_tick(ch);
                let sn = *self.sl[start].notes.last().expect("和弦至少一个音");
                let en = *self.sl[ch].notes.last().expect("和弦至少一个音");
                let s = &mut self.sl[sl];
                s.span.start_tick = st;
                s.span.end_tick = et;
                s.notes.start_note = Some(sn);
                s.notes.end_note = Some(en);
                s.mark = Some(mk);
                match above {
                    Some(a) => s.span.above = a,
                    None => s.auto_dir = true,
                }
            } else {
                let tm = self.doc_chord_by_id.get(&mk.start).and_then(|c| c.duration.time_mod.as_ref());
                let tup = self.sl.part_new_tuplet(self.part);
                let st = self.sl.chord_tick(start);
                let et = self.sl.chord_tick(ch).plus(&self.sl[ch].dur());
                let sn = self.sl[start].notes[0];
                let en = self.sl[ch].notes[0];
                let t = &mut self.sl[tup];
                t.span.start_tick = st;
                t.span.end_tick = et;
                t.notes.start_note = Some(sn);
                t.notes.end_note = Some(en);
                t.time_modification = Fraction::new(tm.map_or(2.0, |t| t.normal), tm.map_or(3.0, |t| t.actual));
            }
        }
        arp
    }

    /// 撤掉刚建的那条 melisma 线（TS `lrcExtends.pop()`）
    fn pop_lrc_extend(&mut self) {
        if let Some(id) = self.sl[self.part].lrc_extends.pop() {
            if id.0 + 1 == self.sl.lrc_extends.len() {
                self.sl.lrc_extends.pop();
            }
        }
    }

    /// Pair lyric extend points 2-by-2 (musicpp parser.cpp:753 processLrcExtend)。
    fn process_lrc_extend(&mut self) {
        let mut pts: Vec<usize> = (0..self.lrc_extend_pts.len()).collect();
        let num_of = |s: &str| {
            let n = js::parse_int(s, 10);
            if n.is_nan() {
                0.0
            } else {
                n
            }
        };
        // 仅当存在显式 <extend type="stop"> 时才按 start/stop 两两配对
        let has_stop = self.lrc_extend_pts.iter().any(|p| p.stop);
        if has_stop {
            {
                let s = &*self.sl;
                let all = &self.lrc_extend_pts;
                js::sort_by(&mut pts, |&a, &b| {
                    let (pa, pb) = (&all[a], &all[b]);
                    let na = num_of(&s[pa.lrc].num());
                    let nb = num_of(&s[pb.lrc].num());
                    if na != nb {
                        return na - nb;
                    }
                    let c = pa.tick.compare_to(&pb.tick);
                    if c != 0 {
                        return c as f64;
                    }
                    f64::from(u8::from(pa.stop)) - f64::from(u8::from(pb.stop))
                });
            }
            let mut i = 0;
            while i + 1 < pts.len() {
                let (pa_note, pa_lrc) = (self.lrc_extend_pts[pts[i]].note, self.lrc_extend_pts[pts[i]].lrc);
                let (pb_note, pb_lrc) = (self.lrc_extend_pts[pts[i + 1]].note, self.lrc_extend_pts[pts[i + 1]].lrc);
                let ext = self.sl.part_new_lrc_extend(self.part);
                let st = self.sl.chord_tick(self.sl[pa_note].chord);
                let et = self.sl.chord_tick(self.sl[pb_note].chord);
                let e = &mut self.sl[ext];
                e.notes.start_note = Some(pa_note);
                e.notes.end_note = Some(pb_note);
                e.span.start_tick = st;
                e.span.end_tick = et;
                e.start = Some(pa_lrc);
                e.stop = Some(pb_lrc);
                i += 2;
            }
            return;
        }

        // 裸 extend：melisma 终点 = 同一 verse 的下一个音节起点；中途遇到休止符即结束
        let mut seq_by_staff: Vec<(usize, Vec<ChordId>)> = Vec::new();
        for i in 0..self.sl[self.part].measures.len() {
            let md = self.sl[self.part].measures[i];
            for &ch in &self.sl[md].chords {
                let staff = self.sl[ch].notes.first().map_or(0, |&n| self.sl.note_staff(n));
                push_keyed(&mut seq_by_staff, staff, ch);
            }
        }
        {
            let s = &*self.sl;
            for (_, arr) in &mut seq_by_staff {
                js::sort_by(arr, |a, b| s.chord_tick(*a).compare_to(&s.chord_tick(*b)) as f64);
            }
        }

        for pi in 0..self.lrc_extend_pts.len() {
            let (pt_note, pt_lrc) = (self.lrc_extend_pts[pi].note, self.lrc_extend_pts[pi].lrc);
            let num = self.sl[pt_lrc].num();
            let list: &[LyricId] = self.lrc_by_num.iter().find(|(k, _)| *k == num).map_or(&[], |(_, v)| v.as_slice());
            let next_lrc = list.iter().position(|&l| l == pt_lrc).and_then(|idx| list.get(idx + 1).copied());
            let start_tick = self.sl.chord_tick(self.sl[pt_note].chord);
            let next_tick = next_lrc.map(|l| self.sl.chord_tick(self.sl[l].chord));

            // 扫描本声部（同谱表）起始音之后、下一个音节之前，寻首个休止符。
            let staff = self.sl.note_staff(pt_note);
            let seq: &[ChordId] = seq_by_staff.iter().find(|(k, _)| *k == staff).map_or(&[], |(_, v)| v.as_slice());
            let mut last_melisma: Option<NoteId> = None;
            let mut rest_before = false;
            for &ch in seq {
                let t = self.sl.chord_tick(ch);
                if t.compare_to(&start_tick) <= 0 {
                    continue;
                }
                if next_tick.is_some_and(|nt| t.compare_to(&nt) >= 0) {
                    break;
                }
                if self.sl[ch].rest() {
                    rest_before = true;
                    break;
                }
                last_melisma = self.sl[ch].notes.first().copied().or(last_melisma);
            }

            let ext = self.sl.part_new_lrc_extend(self.part);
            {
                let e = &mut self.sl[ext];
                e.notes.start_note = Some(pt_note);
                e.start = Some(pt_lrc);
                e.span.start_tick = start_tick;
            }
            if rest_before {
                // 被休止打断：止于休止前最后一个续腔音；若休止紧跟在带 extend 的音之后（无续腔音），则不画。
                let Some(lm) = last_melisma else {
                    self.pop_lrc_extend();
                    continue;
                };
                let et = self.sl.chord_tick(self.sl[lm].chord);
                let e = &mut self.sl[ext];
                e.notes.end_note = Some(lm);
                e.stop = None;
                e.span.end_tick = et;
            } else if let Some(nl) = next_lrc {
                let en = self.sl[self.sl[nl].chord].notes[0];
                let e = &mut self.sl[ext];
                e.notes.end_note = Some(en);
                e.stop = Some(nl);
                e.span.end_tick = next_tick.expect("有下一音节");
            } else {
                // 无续腔音也无下一音节 → 撤销
                self.pop_lrc_extend();
            }
        }
    }

    fn link_lyrics(&mut self) {
        for (_, arr) in &self.lrc_by_num {
            for i in 1..arr.len() {
                let prev = arr[i - 1];
                let cur = arr[i];
                if self.sl[prev].end() {
                    continue;
                }
                if self.sl[cur].begin() {
                    continue;
                }
                self.sl[prev].next = Some(cur);
                self.sl[cur].prev = Some(prev);
            }
        }
    }

    /// <direction> 文本（words / dynamics / metronome），对应 musicpp loader.cpp::processDirection。
    fn process_direction(&mut self, d: &'d Direction, md: PmId, tick: Fraction) {
        let blk = self.sl.pm_new_text(md);
        let staff = (d.staff.unwrap_or(1.0) - 1.0) as usize;
        {
            let b = &mut self.sl[blk];
            b.src = Some(d);
            b.offset = tick;
            b.staff = staff;
        }
        let mif = self.sl[md].measure_info;
        let mut has_text = false;
        let mut items = vec![PartView {
            kind: &d.kind,
            text: d.text.as_deref(),
            tempo: d.tempo.as_ref(),
            span_type: d.span_type.clone(),
            wedge_type: d.wedge_type.clone(),
            line: d.line,
            shift: d.shift.as_ref(),
            oid: d.oid,
        }];
        for m in d.more.iter().flatten() {
            items.push(PartView {
                kind: &m.kind,
                text: m.text.as_deref(),
                tempo: m.tempo.as_ref(),
                span_type: m.span_type.clone(),
                wedge_type: m.wedge_type.clone(),
                line: m.line,
                shift: m.shift.as_ref(),
                oid: m.oid,
            });
        }
        for item in items {
            match item.kind {
                "words" => {
                    if self.process_words(blk, &item) {
                        has_text = true;
                    }
                }
                "dynamics" => {
                    if self.process_dynamic(blk, &item) {
                        has_text = true;
                    }
                }
                "metronome" => {
                    if self.process_metronome(blk, &item) {
                        has_text = true;
                    }
                }
                "rehearsal" => {
                    // 排练号：照文字排，字加粗放大一号、外面套方框（自带【】的不套）。
                    // TS 拿展开出来的新对象 `{ ...item, type: "words" }` 去读，表层查不到身份
                    let w = PartView { kind: "words", oid: Oid::NONE, ..item.clone() };
                    if self.process_words(blk, &w) {
                        let b = &mut self.sl[blk];
                        b.boxed = true;
                        b.frameless = rehearsal_bracketed(item.text.unwrap_or(""));
                        for it in &mut b.block.data {
                            if it.text != "\n" {
                                it.font = Font { family: it.font.family.clone(), size: it.font.size * 1.15, bold: true, italic: it.font.italic };
                            }
                        }
                        has_text = true;
                    }
                }
                "segno" => {
                    let pos = self.pos(item.oid);
                    self.process_segno(blk, false, pos);
                    has_text = true;
                }
                "coda" => {
                    let pos = self.pos(item.oid);
                    self.process_segno(blk, true, pos);
                    has_text = true;
                }
                "wedge" => self.collect_wedge(&item, mif, tick, staff),
                "pedal" => self.collect_pedal(&item, mif, tick, staff),
                "octave-shift" if item.span_type == Some(SpanType::Stop) || item.span_type == Some(SpanType::Start) => {
                    let t = self.sl[mif].offset.plus(&tick);
                    self.octave_pts.push(OctavePt { mif, tick: t, staff, stop: item.span_type == Some(SpanType::Stop), shift: item.shift });
                }
                _ => {}
            }
        }
        // Sibelius 右对齐文本以右边缘为锚点（parser.cpp::parse 尾部 isSib 分支）。
        if self.encoder == Encoder::Sibelius && self.sl[blk].justify == Lcr::Right {
            let w = self.sl[blk].width(self.sl.mc);
            self.sl[blk].x -= w;
        }
        if !has_text {
            if let Some(id) = self.sl[md].text_blocks.pop() {
                if id.0 + 1 == self.sl.texts.len() {
                    self.sl.texts.pop();
                }
            }
        }
    }

    /// <wedge>（渐强/渐弱松叶）端点收集，配对在 pairWedges（parser.cpp:1069 processWedge）。
    fn collect_wedge(&mut self, el: &PartView<'d>, mif: MeasId, tick: Fraction, staff: usize) {
        let kind = match el.span_type {
            Some(SpanType::Stop) => Some(WedgeKind::Stop),
            Some(SpanType::Start) => match el.wedge_type {
                Some(WedgeType::Crescendo) => Some(WedgeKind::Crescendo),
                Some(WedgeType::Diminuendo) => Some(WedgeKind::Diminuendo),
                _ => None,
            },
            _ => None,
        };
        let Some(kind) = kind else { return };
        let pos = self.pos(el.oid);
        self.wedge_pts.push(WedgePt {
            mif,
            tick: self.sl[mif].offset.plus(&tick),
            staff,
            kind,
            rel_x: pos.and_then(|p| p.relative_x),
            def_y: pos.and_then(|p| p.default_y),
            spread: self.surface.and_then(|s| s.wedge_spread(el.oid)),
        });
    }

    /// <pedal>（踏板线）端点收集，配对在 pairPedals（parser.cpp:1150 processPedal）。
    fn collect_pedal(&mut self, el: &PartView<'d>, mif: MeasId, tick: Fraction, staff: usize) {
        // 仅处理 start/stop 配对（sostenuto/change 等不绘制）。
        if el.span_type != Some(SpanType::Start) && el.span_type != Some(SpanType::Stop) {
            return;
        }
        let dy = self.pos(el.oid).and_then(|p| p.default_y);
        self.pedal_pts.push(PedalPt {
            mif,
            tick: self.sl[mif].offset.plus(&tick),
            staff,
            line: el.line == Some(true),
            stop: el.span_type == Some(SpanType::Stop),
            ypos: dy.map_or(0.0, |d| -d),
        });
    }

    /// wedge 端点按 staff 配对成 Wedge（parser.cpp:1069）。
    fn pair_wedges(&mut self) {
        let staves = self.sl[self.part].staves.len();
        let keep_breaks = self.sl.keep_breaks;
        for s in 0..staves {
            let pts: Vec<usize> = (0..self.wedge_pts.len()).filter(|&i| self.wedge_pts[i].staff == s).collect();
            let mut start: Option<usize> = None;
            for pi in pts {
                let p = &self.wedge_pts[pi];
                if p.kind == WedgeKind::Stop {
                    let Some(si) = start else { continue };
                    let st = &self.wedge_pts[si];
                    let w = self.sl.part_new_wedge(self.part);
                    let p = &self.wedge_pts[pi];
                    let wd = &mut self.sl[w];
                    wd.staff = s;
                    wd.crescendo = st.kind == WedgeKind::Crescendo;
                    wd.span.start_tick = st.tick;
                    wd.span.end_tick = p.tick;
                    wd.start_measure = st.mif;
                    wd.end_measure = p.mif;
                    if let Some(x) = st.rel_x {
                        wd.dx_left = x;
                    }
                    if let Some(x) = p.rel_x {
                        wd.dx_right = x;
                    }
                    // `spread` 写在开口那一端：渐强在止点、渐弱在起点；两头都没写取缺省。只在源谱版面档认
                    let spread = if wd.crescendo { p.spread.or(st.spread) } else { st.spread.or(p.spread) };
                    if let Some(sp) = spread {
                        if keep_breaks && sp > 0.0 {
                            wd.spread = sp;
                        }
                    }
                    match st.def_y {
                        Some(y) => wd.ypos = -y,
                        None => wd.auto_y = true,
                    }
                    start = None;
                } else {
                    start = Some(pi);
                }
            }
        }
    }

    /// 八度线端点按谱表、先后配对成 OctaveLine。
    fn pair_octaves(&mut self) {
        let mut pts: Vec<usize> = (0..self.octave_pts.len()).collect();
        {
            let all = &self.octave_pts;
            js::sort_by(&mut pts, |&a, &b| {
                let (a, b) = (&all[a], &all[b]);
                let d = a.staff as f64 - b.staff as f64;
                if d != 0.0 {
                    return d;
                }
                let c = a.tick.compare_to(&b.tick);
                if c != 0 {
                    return c as f64;
                }
                (if a.stop { -1.0 } else { 0.0 }) - (if b.stop { -1.0 } else { 0.0 })
            });
        }
        let mut start: Option<usize> = None;
        for pi in pts {
            let p = &self.octave_pts[pi];
            if !p.stop {
                start = Some(pi);
                continue;
            }
            let Some(si) = start else { continue };
            if self.octave_pts[si].staff != p.staff {
                continue;
            }
            let ln = self.sl.part_new_octave_line(self.part);
            let (st, p) = (&self.octave_pts[si], &self.octave_pts[pi]);
            let l = &mut self.sl[ln];
            l.staff = p.staff;
            l.span.above = !st.shift.is_some_and(|s| s.dir == ShiftDir::Up);
            l.size = st.shift.map_or(8.0, |s| s.size);
            l.span.start_tick = st.tick;
            l.span.end_tick = p.tick;
            l.start_measure = st.mif;
            l.end_measure = p.mif;
            start = None;
        }
    }

    /// pedal 端点排序后两两配对成 PedalLine（parser.cpp:1150）。
    fn pair_pedals(&mut self) {
        let mut pts: Vec<usize> = (0..self.pedal_pts.len()).collect();
        {
            let all = &self.pedal_pts;
            js::sort_by(&mut pts, |&a, &b| {
                let (a, b) = (&all[a], &all[b]);
                if a.staff != b.staff {
                    return a.staff as f64 - b.staff as f64;
                }
                if a.line != b.line {
                    return f64::from(u8::from(a.line)) - f64::from(u8::from(b.line));
                }
                let c = a.tick.compare_to(&b.tick);
                if c != 0 {
                    return c as f64;
                }
                f64::from(u8::from(a.stop)) - f64::from(u8::from(b.stop))
            });
        }
        let mut i = 1;
        while i < pts.len() {
            let (prev, cur) = (&self.pedal_pts[pts[i - 1]], &self.pedal_pts[pts[i]]);
            if prev.stop || !cur.stop || prev.line != cur.line {
                i += 1;
                continue;
            }
            let ln = self.sl.part_new_pedal_line(self.part);
            let (prev, cur) = (&self.pedal_pts[pts[i - 1]], &self.pedal_pts[pts[i]]);
            let l = &mut self.sl[ln];
            l.sign = false;
            l.line = prev.line;
            l.span.start_tick = prev.tick;
            l.start_measure = prev.mif;
            l.end_measure = cur.mif;
            l.span.end_tick = cur.tick;
            l.ypos = prev.ypos;
            l.staff = prev.staff;
            i += 2;
        }
    }

    /// <segno> / <coda> 记号（parser.cpp::processSegno / processCoda）。
    fn process_segno(&mut self, blk: TextId, coda: bool, pos: Option<Position>) {
        let size = self.sl.defaults.music_text_font.size / self.sl.scaling;
        let b = &mut self.sl[blk];
        b.y = 45.0; // todo: parser.cpp 同样硬编码
        if pos.is_some_and(|p| p.default_x.is_some() || p.default_y.is_some()) {
            b.sign_placed = true;
        }
        let dx = pos.and_then(|p| p.default_x);
        let rx = pos.and_then(|p| p.relative_x);
        if let (Some(dx), true) = (dx, b.data.is_empty()) {
            b.x = dx + rx.unwrap_or(0.0);
            b.relative = false;
        } else if let Some(rx) = rx {
            b.x = rx;
        }
        b.x += 15.0;
        b.add(&gs(if coda { "coda" } else { "segno" }), &Font::new("Bravura", BRAVURA_TEXT_SCALE * size), true, Some(size), None);
    }

    /// <words> 文本（如「(副歌)」），对应 loader.cpp::processWords。
    fn process_words(&mut self, blk: TextId, w: &PartView<'d>) -> bool {
        let pos = self.pos(w.oid);
        let font_spec = self.font(w.oid);
        let justify = self.justify(w.oid);
        let auto_layout = self.sl.auto_layout;
        let words_font = self.make_words_font(font_spec.as_ref());
        let b = &mut self.sl[blk];
        let dy = pos.and_then(|p| p.default_y);
        if let Some(dy) = dy {
            b.y = dy;
        }
        // 自动铺排时写了 default-y 的文字是识别稿照原图写的：照原位、照原字号
        if dy.is_some() && auto_layout {
            b.source_y = true;
            if font_spec.as_ref().and_then(|f| f.size).unwrap_or(0.0) > 0.0 {
                b.source_size = true;
            }
        }
        if let Some(ry) = pos.and_then(|p| p.relative_y) {
            b.y += ry;
        }
        // x 口径同 parser.cpp::processTextPos：有 relative-x 就相对拍位；只有 default-x 就是小节内坐标、不加拍位。
        let rx = pos.and_then(|p| p.relative_x);
        let dx = pos.and_then(|p| p.default_x);
        if let Some(rx) = rx {
            b.x = rx;
        } else if let (Some(dx), true) = (dx, b.data.is_empty()) {
            b.x = dx;
            b.relative = false;
        }
        if justify == Some(HAlign::Right) {
            b.justify = Lcr::Right;
        } else if justify == Some(HAlign::Center) {
            b.justify = Lcr::Center;
        }
        let text = w.text.unwrap_or("");
        if text.is_empty() {
            return false;
        }
        b.add(text, &words_font, false, None, None);
        true
    }

    /// <dynamics>（如 <mf/>、<sfz/>），对应 loader.cpp::processDynamic。
    fn process_dynamic(&mut self, blk: TextId, dyn_: &PartView<'d>) -> bool {
        let pos = self.pos(dyn_.oid);
        let pt = self.font(dyn_.oid).and_then(|f| f.size);
        let scaling = self.sl.scaling;
        let b = &mut self.sl[blk];
        if let Some(dy) = pos.and_then(|p| p.default_y) {
            b.y = dy;
            b.source_y = true;
        }
        if let Some(rx) = pos.and_then(|p| p.relative_x) {
            b.x = rx;
        }
        // 原文写了字号（识别稿照原图墨迹高折的）就照它；没写取 16pt
        let pt_ok = pt.filter(|&p| p > 0.0);
        if pt_ok.is_some() {
            b.source_size = true;
        }
        let font = Font::new("Bravura", pt_ok.unwrap_or(16.0) / scaling);
        let glyphs = match dyn_.text {
            Some(t) if !t.is_empty() => dynamic_glyphs(t),
            _ => String::new(),
        };
        if glyphs.is_empty() {
            return false;
        }
        b.add(&glyphs, &font, true, None, None);
        true
    }

    /// <metronome>（<beat-unit> + <per-minute>），对应 loader.cpp::processMetronome。
    fn process_metronome(&mut self, blk: TextId, met: &PartView<'d>) -> bool {
        let dy = self.pos(met.oid).and_then(|p| p.default_y);
        let word_font = self.make_words_font(self.font(met.oid).as_ref());
        let b = &mut self.sl[blk];
        if let Some(dy) = dy {
            b.y = dy;
        }
        // webview 只注册了 "Bravura"；Bravura 含同一套 metNote 字形
        let note_font = Font::new("Bravura", word_font.size);
        let mut any = false;
        let tempo = met.tempo;
        // `parentheses="yes"`：整个节拍器套一对圆括号「(♩ = 82)」
        let paren = tempo.and_then(|t| t.parentheses) == Some(true);
        // 同一条 direction 里前面已有文字：隔开一个字宽的四成
        let mut lead = 0.0;
        if let Some(last) = b.data.last_mut() {
            if last.text != "\n" && !last.music {
                last.text = last.text.trim_end_matches(js::is_space).to_owned();
                lead = word_font.size * WORDS_TEMPO_GAP_EM;
            }
        }
        if paren {
            b.add("(", &word_font, false, None, Some(lead));
            lead = 0.0;
        }
        if let Some(bu) = tempo.and_then(|t| t.beat_unit.as_ref()) {
            let mut s = pass::met_note_glyph(bu.as_str());
            if tempo.and_then(|t| t.beat_unit_dot) == Some(true) {
                s.push_str(&gs("metAugmentationDot"));
            }
            b.add(&s, &note_font, true, None, Some(lead));
            any = true;
        }
        let pm: Option<String> = match tempo.and_then(|t| t.per_minute_text.as_deref()) {
            Some(t) => Some(js::trim(t).to_owned()),
            None => tempo.and_then(|t| t.per_minute).map(js::num_to_string),
        };
        if let Some(pm) = pm {
            // 「=」两侧的空与调号「1 = F」同一个（engrave/spacing.ts::EQ_PAD_EM），按字号算
            let pad = word_font.size * EQ_PAD_EM;
            b.add("=", &word_font, false, None, Some(if any { pad } else { lead }));
            b.add(&pm, &word_font, false, None, Some(pad));
            any = true;
        }
        if paren && any {
            b.add(")", &word_font, false, None, None);
        }
        any
    }

    /// MusicXML <words> 字体 → tenths 空间字号（pt / scaling，对齐 loader.cpp::makeFont）。
    fn make_words_font(&self, f: Option<&FontSpec>) -> Font {
        let fam = f.and_then(|f| f.family.clone()).unwrap_or_else(|| "Times New Roman".into());
        let bold = f.and_then(|f| f.weight.as_deref()) == Some("bold");
        // 没写字号：照 `<word-font>`
        let d = &self.sl.defaults;
        let tenths = match f.and_then(|f| f.size) {
            Some(sz) => sz / self.sl.scaling,
            None => {
                if d.word_font_given {
                    d.word_font.size
                } else {
                    16.0 / self.sl.scaling
                }
            }
        };
        Font { family: fam, size: tenths, bold, italic: f.and_then(|f| f.style.as_deref()) == Some("italic") }
    }

    fn process_harmony(&mut self, src: &'d Harmony, md: PmId, tick: Fraction) {
        let h = self.sl.pm_new_harmony(md, src);
        self.sl[h].offset = tick;
        self.sl[h].y = self.pos(src.oid).and_then(|p| p.default_y).unwrap_or(-1.0);
    }

    fn process_barline(&mut self, b: &'d Barline, mif: MeasId) {
        let loc = &b.location;
        if let Some(style) = &b.style {
            if let Some(g) = pass::bar_glyph_from_style(style.as_str()) {
                if *loc == BarLocation::Left {
                    self.sl[mif].left_barline = Some(g);
                } else {
                    self.sl[mif].right_barline = Some(g);
                }
            }
        }
        if let Some(r) = &b.repeat {
            if *r == RepeatDir::Backward {
                self.sl[mif].backward = true;
            } else {
                self.sl[mif].forward = true;
            }
        }
        // print-object="no" 的 ending 不参与绘制（parser.cpp::processEnding 1232）；ending 端点按本声部收集
        let Some(ending) = b.ending.as_ref().filter(|e| e.print_object != Some(false)) else { return };
        // 房号以元素文本为准、属性兜底：文本才是给人看的那串「1.2.3.」
        let text = ending.text.clone().unwrap_or_default();
        let digits = ascii_digit_runs(&text);
        let joined = if digits.is_empty() {
            ending.numbers.iter().map(|n| js::num_to_string(*n)).collect::<Vec<_>>().join(",")
        } else {
            digits.join(",")
        };
        let nums = pass::parse_ending_nums(&joined);
        if nums.is_empty() {
            return;
        }
        let ty = &ending.kind;
        if *loc == BarLocation::Left {
            if *ty == DocEndingType::Start {
                self.ending_pts.push(EndingPt { mif, nums, text, start: true, stop: false });
            }
        } else if *ty == DocEndingType::Stop {
            self.ending_pts.push(EndingPt { mif, nums, text, start: false, stop: true });
        } else if *ty == DocEndingType::Discontinue {
            self.ending_pts.push(EndingPt { mif, nums, text, start: false, stop: false });
        }
    }

    /// 本小节各谱表上并存的声部 → 符干方向。同一谱表只有一个声部时不登记（照旧按音高猜）。
    fn load_voice_stems(&mut self, m: &Measure) {
        self.voice_stem.clear();
        let mut by_staff: Vec<(f64, Vec<f64>)> = Vec::new();
        let or1 = |v: f64| if v == 0.0 || v.is_nan() { 1.0 } else { v };
        for el in &m.elements {
            if let Element::Chord(c) = el {
                if c.grace.is_some() {
                    continue;
                }
            }
            let staff = or1(el_staff(el));
            let voice = or1(el_voice(el));
            match by_staff.iter_mut().find(|(s, _)| *s == staff) {
                Some((_, set)) => {
                    if !set.contains(&voice) {
                        set.push(voice);
                    }
                }
                None => by_staff.push((staff, vec![voice])),
            }
        }
        for (staff, voices) in by_staff {
            if voices.len() < 2 {
                continue;
            }
            let mut sorted = voices;
            js::sort_by(&mut sorted, |a, b| a - b);
            for &v in &sorted {
                self.voice_stem.insert(format!("{}:{}", js::num_to_string(staff), js::num_to_string(v)), v == sorted[0]);
            }
        }
    }

    /// 无 <beam> 的谱（OMR 生成）：按拍自动把同一声部相邻的短音符（八分及更短）分组成符杠。
    fn auto_beam_part(&mut self) {
        let one = Fraction::int(1.0);
        let levels_of = |s: &StaffLayout, ch: ChordId| js::max(0.0, js::round(-s[ch].note_type().to_float().log2()));
        for mi in 0..self.sl[self.part].measures.len() {
            let md = self.sl[self.part].measures[mi];
            if !self.sl[md].beams.is_empty() {
                continue;
            }
            let mif = MeasId(mi);
            let ts = self.sl[self.part].staves.first().map(|s| s.get_time(&self.sl[mif].offset));
            // 每拍时值（四分音符单位）：复拍(x/8 且 beats 为 3 的倍数)按附点四分成组，否则按分母音符。
            let mut beat_len = 1.0;
            if let Some(ts) = ts {
                beat_len = if ts.beat_type == 8.0 && ts.beats % 3.0 == 0.0 { 1.5 } else { 4.0 / ts.beat_type };
            }
            // 逐声部分组：多声部共用一个谱表时，同一时刻的两个声部的音不能连成一组
            let mut voices: Vec<(String, Vec<ChordId>)> = Vec::new();
            for &c in &self.sl[md].chords {
                if self.sl[c].grace() {
                    continue;
                }
                let src = self.sl[c].src;
                let key = format!("{}:{}", js::num_to_string(src.staff), js::num_to_string(src.voice));
                push_keyed(&mut voices, key, c);
            }
            let mut run: Vec<ChordId> = Vec::new();
            for (_, mut chords) in voices {
                self.sl.sort_by_offset(&mut chords);
                let mut cur_beat = -1.0;
                for ch in chords {
                    if self.sl[ch].rest() || self.sl[ch].note_type().compare_to(&one) >= 0 {
                        self.flush_auto_beam(md, &mut run, levels_of);
                        cur_beat = -1.0;
                        continue;
                    }
                    let beat = (self.sl[ch].offset.to_float() / beat_len + 1e-6).floor();
                    if !run.is_empty() && beat != cur_beat {
                        self.flush_auto_beam(md, &mut run, levels_of);
                    }
                    run.push(ch);
                    cur_beat = beat;
                }
                self.flush_auto_beam(md, &mut run, levels_of);
            }
        }
    }

    /// `autoBeamPart` 里的 `flush`
    fn flush_auto_beam(&mut self, md: PmId, run: &mut Vec<ChordId>, levels_of: impl Fn(&StaffLayout, ChordId) -> f64) {
        if run.len() >= 2 {
            for i in 0..run.len() {
                let ch = run[i];
                let lv = levels_of(self.sl, ch);
                let mut beams = Vec::new();
                let mut l = 0.0;
                while l < lv {
                    let prev_has = i > 0 && levels_of(self.sl, run[i - 1]) > l;
                    let next_has = i < run.len() - 1 && levels_of(self.sl, run[i + 1]) > l;
                    beams.push(if prev_has && next_has {
                        BeamVal::Continue
                    } else if !prev_has && next_has {
                        BeamVal::Begin
                    } else if prev_has && !next_has {
                        BeamVal::End
                    } else if i == 0 {
                        BeamVal::Forward
                    } else {
                        BeamVal::Backward
                    });
                    l += 1.0;
                }
                self.sl[ch].beams = beams;
            }
            let g = self.sl.new_beam(BeamGroup { chords: run.clone(), ..BeamGroup::default() });
            // 组是在 layoutNotes 之后才建的：定完方向把二度错位按新方向重排。方向已按声部定好的不再按音高统一
            if !run.iter().all(|c| self.forced_stem.contains(c)) {
                self.sl.beam_unify_stem_dir(g);
            }
            for &ch in run.iter() {
                for j in 0..self.sl[ch].notes.len() {
                    let nt = self.sl[ch].notes[j];
                    self.sl[nt].flipped = false;
                }
                self.sl[ch].double_side = false;
                self.sl.chord_auto_flip(ch);
            }
            self.sl[md].beams.push(g);
        }
        run.clear();
    }

    /// model.cpp::guessStemDir：每个和弦按首音定方向（中线 line=-4 及以上朝下），再把每个符杠组统一。
    fn guess_stem_dir(&mut self) {
        for i in 0..self.sl[self.part].measures.len() {
            let md = self.sl[self.part].measures[i];
            for j in 0..self.sl[md].chords.len() {
                let ch = self.sl[md].chords[j];
                if self.sl[ch].rest() || self.sl[ch].notes.is_empty() {
                    continue;
                }
                let first = self.sl[ch].notes[0];
                self.sl[ch].stem_up = self.sl.note_line(first) <= -4.0;
                self.add_stem_note(first);
            }
            for j in 0..self.sl[md].beams.len() {
                let g = self.sl[md].beams[j];
                let mut vals: Vec<bool> = Vec::new();
                for &ch in &self.sl[g].chords {
                    if self.sl[ch].rest() || self.sl[ch].notes.is_empty() {
                        continue;
                    }
                    if self.sl.note_line(self.sl[ch].notes[0]) == -4.0 {
                        continue;
                    }
                    let v = self.sl[ch].stem_up;
                    if !vals.contains(&v) {
                        vals.push(v);
                    }
                }
                let up = if vals.len() == 1 { vals[0] } else { true };
                for k in 0..self.sl[g].chords.len() {
                    let ch = self.sl[g].chords[k];
                    self.sl[ch].stem_up = up;
                }
            }
        }
    }

    fn calc_stem_len(&mut self) {
        // parser.cpp::calcStemLen —— 仅有 <stem> 的音符算符干长；有 default-y 用之（长度量到**和弦尾音**），
        // 否则回退 35（grace 乘 graceSize）。
        let grace_size = self.sl.options.grace_size;
        let keep_breaks = self.sl.keep_breaks;
        for i in 0..self.stem_notes.len() {
            let nt = self.stem_notes[i];
            let ch = self.sl[nt].chord;
            let sy = self.stem_y_map.get(&nt).copied();
            let len = match sy {
                Some(sy) => (-self.sl.note_cy(self.sl[ch].tail_note()) - sy).abs(),
                None => f64::NAN,
            };
            // 量不出数按没写处理
            self.sl[ch].stem_len = if len.is_finite() {
                len
            } else if self.sl[ch].grace() {
                35.0 * grace_size
            } else {
                35.0
            };
            // 源谱版面档（识别稿）记下原图的符干端点
            if let Some(sy) = sy {
                if keep_breaks && sy.is_finite() {
                    self.sl[ch].src_tip_y = Some(-sy);
                }
            }
        }
    }

    /// 不连符杠、带符尾的符干**至少要比符尾长出 1/4 格**（按这个音的大小缩放）
    fn fit_flag_stems(&mut self) {
        let meta = self.sl.meta;
        let cue_size = self.sl.options.cue_size;
        let grace_size = self.sl.options.grace_size;
        for i in 0..self.sl[self.part].measures.len() {
            let md = self.sl[self.part].measures[i];
            for j in 0..self.sl[md].chords.len() {
                let ch = self.sl[md].chords[j];
                let c = &self.sl[ch];
                if c.rest() || !c.beams.is_empty() || c.stem_len <= 0.0 {
                    continue;
                }
                let flag = c.tail_sym(c.stem_up);
                if flag.is_empty() {
                    continue;
                }
                let Some(bb) = get_bbox(meta, &flag) else { continue };
                let scale = if c.grace() {
                    grace_size
                } else if c.cue() || c.notes.iter().any(|&n| self.sl.note_size(n) == 1.0) {
                    cue_size
                } else {
                    1.0
                };
                let flag_len = (bb.ne[1] - bb.sw[1]) * 10.0 * scale; // 1 格 = 10 tenths
                let v = js::max(c.stem_len, flag_len + 2.5 * scale);
                self.sl[ch].stem_len = v;
            }
        }
    }

    /// 符杠组符干长度/斜率（styler.cpp BeamGroup::format）
    fn format_beams(&mut self) {
        for i in 0..self.sl[self.part].measures.len() {
            let md = self.sl[self.part].measures[i];
            for j in 0..self.sl[md].beams.len() {
                let g = self.sl[md].beams[j];
                self.sl.beam_refresh(g);
            }
        }
    }

    fn process_tied(&mut self) {
        // 只记「已被吃掉的 stop」：一个 stop 只配一次
        let mut used_stops: HashSet<NoteId> = HashSet::new();
        for si in 0..self.tie_starts.len() {
            for ei in 0..self.tie_stops.len() {
                let (start, stop) = (&self.tie_starts[si], &self.tie_stops[ei]);
                if used_stops.contains(&stop.note) {
                    continue;
                }
                if !f_eq(&stop.end_tick, &start.end_tick) {
                    continue;
                }
                if stop.pitch != start.pitch {
                    continue;
                }
                used_stops.insert(stop.note);
                let (sn, en, et, above) = (start.note, stop.note, start.end_tick, start.above);
                let tied = self.sl.part_new_tied(self.part);
                let st = self.sl.chord_tick(self.sl[sn].chord);
                let t = &mut self.sl[tied];
                t.notes.start_note = Some(sn);
                t.notes.end_note = Some(en);
                t.span.start_tick = st;
                t.span.end_tick = et;
                if let Some(a) = above {
                    t.span.above = a;
                    t.src_dir = true;
                }
                break;
            }
        }
    }

    /// 对齐 musicpp parser.cpp::processEnding：收集所有反复记号端点（按绝对 tick），排序后相邻两两配对。
    fn process_ending(&mut self) {
        let mut pts: Vec<(Fraction, usize)> = self
            .ending_pts
            .iter()
            .enumerate()
            .map(|(i, p)| (if p.start { self.sl[p.mif].offset } else { self.sl[p.mif].end_tick() }, i))
            .collect();
        js::sort_by(&mut pts, |a, b| a.0.compare_to(&b.0) as f64);
        let mut i = 0;
        while i + 1 < pts.len() {
            let (at, ai) = pts[i];
            let (bt, bi) = pts[i + 1];
            let (a, b) = (&self.ending_pts[ai], &self.ending_pts[bi]);
            let number = if a.text.is_empty() {
                let mut ns = a.nums.clone();
                js::sort_by(&mut ns, |x, y| (*x - *y) as f64);
                ns.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(",")
            } else {
                a.text.clone()
            };
            let (am, bm, has_stop) = (a.mif, b.mif, b.stop);
            let end = self.sl.part_new_ending(self.part);
            let e = &mut self.sl[end];
            e.span.start_tick = at;
            e.span.end_tick = bt;
            e.start_measure = am;
            e.end_measure = bm;
            e.number = number;
            e.has_stop = has_stop;
            i += 2;
        }
    }
}

/// `text.match(/\d+/g)`（无 u 标志的 `\d` 只认 ASCII 数字）
fn ascii_digit_runs(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_digit() {
            let st = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            out.push(&s[st..i]);
        } else {
            i += 1;
        }
    }
    out
}

// ---------------- 版面输入与声部分组（ScoreDoc → layoutpass） ----------------

fn print_input(surface: Option<&Surface>, p: &Print) -> PrintInput {
    let lay = surface.and_then(|s| s.print_layout(Some(p.oid)));
    let sl = lay.as_ref().and_then(|l| l.system_layout);
    PrintInput {
        new_page: p.new_page == Some(true),
        new_system: p.new_system == Some(true),
        system_layout: sl.map(|sl| SystemLayoutInput {
            margins: if sl.left_margin.is_some() || sl.right_margin.is_some() { Some((sl.left_margin, sl.right_margin)) } else { None },
            top_system_distance: sl.top_system_distance,
            system_distance: sl.system_distance,
        }),
        staff_layouts: lay
            .as_ref()
            .and_then(|l| l.staff_layouts.as_ref())
            .into_iter()
            .flatten()
            .map(|s| StaffLayoutInput { number: s.staff.unwrap_or(1.0) as i64, staff_distance: s.staff_distance })
            .collect(),
    }
}

/// 谱里有源谱真实排出的行：第一声部有带 `<system-layout>` 的 `new-system` / `new-page`（识别结果照原谱写的）。
fn has_source_breaks(surface: Option<&Surface>, song: &Song) -> bool {
    song.parts.first().is_some_and(|p| {
        p.measures.iter().any(|m| {
            m.print.as_ref().is_some_and(|pr| {
                (pr.new_system == Some(true) || pr.new_page == Some(true))
                    && surface.and_then(|s| s.print_layout(Some(pr.oid))).is_some_and(|l| l.system_layout.is_some())
            })
        })
    })
}

fn layout_input_of(surface: Option<&Surface>, song: &Song) -> LayoutInput {
    song.parts
        .iter()
        .map(|part| {
            part.measures
                .iter()
                .map(|m| {
                    let attrs = std::iter::once(m.attrs.as_ref()).chain(m.later_attrs.iter().flatten().map(|la| Some(&la.attrs)));
                    let staff_details = attrs
                        .flat_map(|a| surface.map_or_else(Vec::new, |s| s.staff_details_of(a.map(|a| a.oid))))
                        .map(|(n, po)| StaffDetailInput {
                            number: n.unwrap_or(1.0) as i64,
                            print_object: po.map(|p| if p { "yes".to_owned() } else { "no".to_owned() }),
                        })
                        .collect();
                    MeasureLayoutInput { prints: m.print.as_ref().map(|p| vec![print_input(surface, p)]).unwrap_or_default(), staff_details }
                })
                .collect()
        })
        .collect()
}

/// 声部分组。DOM 那条路按 `<part-list>` 子元素次序建：组在它的 `start` 处建、组外的声部各自成一组；
/// `ScoreDoc` 只存组与组内声部，这里按「组在它的首个声部之前」还原那个次序。
fn part_groups_of(score: &StaffLayout, song: &Song) -> Vec<PartGroup> {
    let doc_groups: &[dolce_model::doc::PartGroup] = song.part_groups.as_deref().unwrap_or(&[]);
    // made：文档组下标 → 建好的组在 groups 里的下标
    let mut made: Vec<Option<usize>> = vec![None; doc_groups.len()];
    let mut groups: Vec<PartGroup> = Vec::new();
    let make = |gi: usize, made: &mut Vec<Option<usize>>, groups: &mut Vec<PartGroup>| -> usize {
        let g = &doc_groups[gi];
        let mut pg = PartGroup { number: g.number.clone(), ..PartGroup::default() };
        if g.symbol == Some(DocGroupSymbol::Brace) {
            pg.symbol = GroupSymbol::Brace;
        } else if g.symbol == Some(DocGroupSymbol::Bracket) {
            pg.symbol = GroupSymbol::Bracket;
        }
        pg.barline = g.group_barline == Some(true);
        groups.push(pg);
        made[gi] = Some(groups.len() - 1);
        groups.len() - 1
    };
    for (i, part) in song.parts.iter().enumerate() {
        let pp = PartId(i);
        for gi in 0..doc_groups.len() {
            if made[gi].is_none() && doc_groups[gi].parts.first() == Some(&part.id) {
                make(gi, &mut made, &mut groups);
            }
        }
        let active: Vec<usize> = (0..doc_groups.len()).filter(|&gi| doc_groups[gi].parts.contains(&part.id)).collect();
        if active.is_empty() {
            groups.push(PartGroup { parts: vec![pp], ..PartGroup::default() });
        } else {
            for gi in active {
                let k = match made[gi] {
                    Some(k) => k,
                    None => make(gi, &mut made, &mut groups),
                };
                groups[k].parts.push(pp);
            }
        }
    }
    for gi in 0..doc_groups.len() {
        if made[gi].is_none() {
            make(gi, &mut made, &mut groups);
        }
    }
    for g in &mut groups {
        if g.parts.len() == 1 && score[g.parts[0]].staves.len() > 1 {
            g.barline = true;
            // 多谱表声部自己的符号（`<part-symbol>`）：没写按规范缺省 brace。分组本身写了符号的照分组的
            if g.symbol == GroupSymbol::None {
                let idx = g.parts[0].0;
                let attrs = song.parts.get(idx).and_then(|p| p.measures.first()).and_then(|m| m.attrs.as_ref());
                let ps = score.surface.and_then(|s| s.part_symbol_of(attrs.map(|a| a.oid)));
                let sym = ps.as_ref().map_or("brace", |p| p.0.as_str());
                g.symbol = if sym == "brace" {
                    GroupSymbol::Brace
                } else if sym == "bracket" || sym == "square" {
                    GroupSymbol::Bracket
                } else {
                    GroupSymbol::None
                };
                if let Some((_, top, bottom)) = &ps {
                    if top.is_some() || bottom.is_some() {
                        let n = score[g.parts[0]].staves.len() as f64;
                        g.staff_range = Some(((top.unwrap_or(1.0) - 1.0) as usize, (bottom.unwrap_or(n) - 1.0) as usize));
                    }
                }
            }
        }
    }
    groups
}

// ---------------- 入口 ----------------

/// 多小节休止在谱面上并成一小节（模型不动，见 `dolce_model::multirest`）。并过时整份是拷贝：TS 里展开出来的
/// 新对象（歌、各声部、改写过的小节与它的 attrs）查不到表层身份，这里把它们的 oid 清掉；和弦、音、小节线是原对象，号留着。
pub fn prepare_song(song: &Song) -> Cow<'_, Song> {
    match compress_multi_rests(song) {
        Cow::Borrowed(s) => Cow::Borrowed(s),
        Cow::Owned(mut out) => {
            // 源里 `attrs.multiRest` 为真的小节（含并过的首小节）都是 TS 里展开出来的新对象
            let mut meas: HashSet<Oid> = HashSet::new();
            let mut attrs: HashSet<Oid> = HashSet::new();
            for m in song.parts.iter().flat_map(|p| p.measures.iter()) {
                if let Some(a) = &m.attrs {
                    if truthy(a.multi_rest) {
                        if !m.oid.is_none() {
                            meas.insert(m.oid);
                        }
                        if !a.oid.is_none() {
                            attrs.insert(a.oid);
                        }
                    }
                }
            }
            out.oid = Oid::NONE;
            for p in &mut out.parts {
                p.oid = Oid::NONE;
                for m in &mut p.measures {
                    let hit = meas.contains(&m.oid) || m.attrs.as_ref().is_some_and(|a| attrs.contains(&a.oid));
                    if hit {
                        m.oid = Oid::NONE;
                        if let Some(a) = &mut m.attrs {
                            a.oid = Oid::NONE;
                        }
                    }
                }
            }
            Cow::Owned(out)
        }
    }
}

/// `ScoreDoc` 的一首（MusicXML 形状，已经 [`prepare_song`]）→ `StaffLayout`（TS `layoutStaff`）。
pub fn layout_staff<'d>(
    song: &'d Song,
    surface: Option<&'d Surface>,
    options: MixedOptions,
    meta: &'d MetaData,
    mc: &'d MeasureCtx<'d>,
    probe: Probe,
) -> StaffLayout<'d> {
    let mut score = StaffLayout::new(options, song, surface, meta, mc);

    let def = song.defaults.as_ref();
    if let Some(sc) = def.and_then(|d| d.scaling.as_ref()) {
        if sc.millimeters > 0.0 && sc.tenths > 0.0 {
            score.scaling = (sc.millimeters * 72.0) / 25.4 / sc.tenths;
        }
    }
    if let Some(def) = def {
        if let Some(pl) = &def.page_layout {
            if let Some(w) = pl.page_width {
                score.defaults.page_width = w;
            }
            if let Some(h) = pl.page_height {
                score.defaults.page_height = h;
            }
            for mg in pl.margins.iter().flatten() {
                if mg.odd_even == Some(OddEven::Even) {
                    continue;
                }
                score.defaults.left_margin = mg.left;
                score.defaults.right_margin = mg.right;
                score.defaults.top_margin = mg.top;
                score.defaults.bottom_margin = mg.bottom;
            }
        }
        let scaling = score.scaling;
        let pt_to_tenths = |pt: f64| pt / scaling;
        if let Some(lf) = &def.lyric_font {
            let family = lf.family.clone().unwrap_or_else(|| score.defaults.lyric_font.family.clone());
            let sz = if truthy(lf.size) { lf.size.unwrap_or(0.0) } else { score.defaults.lyric_font.size };
            score.defaults.lyric_font = Font::new(family, pt_to_tenths(sz));
        }
        // parser.cpp 取 <music-font font-size> 当 musicTextFont 的字号（pt，不按 scaling 折算——用时再除）
        let (music_font, word_font) = surface.map_or((None, None), |s| s.defaults_fonts(song.oid));
        if let Some(sz) = music_font.as_ref().and_then(|f| f.size).filter(|&s| truthy(Some(s))) {
            score.defaults.music_text_font = Font::new(score.defaults.music_text_font.family.clone(), sz);
        }
        if let Some(wf) = &word_font {
            let family = wf.family.clone().unwrap_or_else(|| score.defaults.word_font.family.clone());
            let sz = if truthy(wf.size) { wf.size.unwrap_or(0.0) } else { score.defaults.word_font.size };
            score.defaults.word_font = Font::new(family, pt_to_tenths(sz));
            score.defaults.word_font_given = truthy(wf.size);
        }
    }
    // 用户给了谱表大小：换 scaling，纸与边距按 pt 不变（tenths 跟着换算）
    let mut resized = false;
    if let Some(mm) = score.options.staff_size_mm.filter(|&v| v > 0.0) {
        let k = (mm * 72.0) / 25.4 / 40.0;
        if (k - score.scaling).abs() > 1e-9 {
            let f = score.scaling / k;
            let dd = &mut score.defaults;
            dd.page_width *= f;
            dd.page_height *= f;
            dd.left_margin *= f;
            dd.right_margin *= f;
            dd.top_margin *= f;
            dd.bottom_margin *= f;
            // 字号是 tenths（按旧 scaling 折的），保持 pt 不变
            dd.lyric_font = dd.lyric_font.with_size(dd.lyric_font.size * f);
            dd.word_font = dd.word_font.with_size(dd.word_font.size * f);
            score.scaling = k;
            resized = true;
        }
    }
    // 谱里给了和弦字号（识别结果照原谱量的）：取中位数，压过样式缺省
    let mut harm_pt: Vec<f64> = Vec::new();
    for p in &song.parts {
        for m in &p.measures {
            for e in &m.elements {
                let Some(h) = el_harmony(e) else { continue };
                harm_pt.push(h.font_size.unwrap_or(0.0));
                if let Element::Chord(c) = e {
                    for lh in c.later_harmonies.iter().flatten() {
                        harm_pt.push(lh.font_size.unwrap_or(0.0));
                    }
                }
            }
        }
    }
    harm_pt.retain(|&v| truthy(Some(v)));
    js::sort_by(&mut harm_pt, |a, b| a - b);
    if !harm_pt.is_empty() {
        score.options.harmony_size = harm_pt[harm_pt.len() >> 1];
    }
    if let Some(lp) = score.options.lyric_pt.filter(|&v| v > 0.0) {
        score.defaults.lyric_font = score.defaults.lyric_font.with_size(lp / score.scaling);
    }

    // 谱里没写纸，或用户在设置里明确换了纸：用编辑器设置那张（长图不分页，页高由内容定）
    let page = score.options.page.clone();
    let has_page_layout = def.is_some_and(|d| d.page_layout.is_some());
    let override_page = page.as_ref().is_some_and(|p| p.r#override == Some(true)) && has_page_layout;
    if let Some(page) = page.as_ref().filter(|_| !has_page_layout || override_page) {
        score.defaults.page_width = page.width_pt / score.scaling;
        // 长图先按 √2 比例给个名义页高，装页后由 painter 换成内容高
        score.defaults.page_height = page.height_pt.unwrap_or(page.width_pt * std::f64::consts::SQRT_2) / score.scaling;
        score.long_image = page.height_pt.is_none();
        if let Some(mg) = page.margins_pt.as_ref().filter(|m| m.len() == 4) {
            let v: Vec<f64> = mg.iter().map(|v| v / score.scaling).collect();
            score.defaults.top_margin = v[0];
            score.defaults.right_margin = v[1];
            score.defaults.bottom_margin = v[2];
            score.defaults.left_margin = v[3];
        }
    }

    for c in song.credits.iter().flatten() {
        score.credits.push(ScoreCredit {
            page: c.page.unwrap_or(1.0) - 1.0,
            text: js::trim(&c.text).to_owned(),
            r#type: c.kind.as_deref().map(|t| js::trim(t).to_owned()),
            x: c.x.unwrap_or(0.0),
            y: c.y.unwrap_or(0.0),
            justify: match c.justify {
                Some(HAlign::Right) => Lcr::Right,
                Some(HAlign::Center) => Lcr::Center,
                _ => Lcr::Left,
            },
            font_size: if truthy(c.font_size) { c.font_size.unwrap_or(0.0) } else { 0.0 },
            family: c.font_family.clone().filter(|f| !f.is_empty()),
            bold: (c.font_weight.as_deref() == Some("bold")).then_some(true),
            valign: c.valign.as_ref().map(|v| v.as_str().to_owned()).filter(|v| v != "baseline"),
        });
    }
    // 题下经文（123/ABC `I:meta scripture`、MusicXML `<miscellaneous-field name="scripture">`）：自动铺排时排在标题下
    score.scripture = get_meta(song, "scripture").iter().chain(get_meta(song, "scripture-ref")).filter(|t| !js::trim(t).is_empty()).cloned().collect();

    // 换了纸，谱里按原纸算好的版面坐标就对不上了：整份按新纸自动铺排
    score.auto_layout = override_page || resized || !surface.is_some_and(|s| s.has_embedded_layout(song));
    score.keep_breaks = score.auto_layout && !override_page && !resized && has_source_breaks(surface, song);
    score.hard_breaks = score.keep_breaks || (score.auto_layout && score.options.source_breaks);

    let num_measures = song.parts.first().map_or(0, |p| p.measures.len());
    for _ in 0..num_measures {
        score.new_measure();
    }

    for src in &song.parts {
        let p = score.new_part();
        let part = &mut score[p];
        part.pid = src.id.clone();
        part.name = src.name.clone().unwrap_or_default();
        part.abbrev = src.abbrev.clone().unwrap_or_default();
        part.name_size = src.name_size.unwrap_or(0.0);
    }

    for (i, src) in song.parts.iter().enumerate() {
        let mut pl = Loader::new(&mut score, PartId(i), src, &song.marks);
        pl.load();
        pl.link_lyrics();
    }
    auto_verse_numbers(&mut score);

    probe("read", &score);
    let input = layout_input_of(surface, song);
    let groups = part_groups_of(&score, song);
    pass::finish_mixed_score(&mut score, &input, groups, probe);
    score
}

/// **自动段号**（同简谱 `place/song.ts::autoVerseNumbers` 的口径，样式键 `verse-numbers`）：一个声部唱两段以上
/// （`auto` 多于 `verseNumberAutoMin` 段）时，每段第一个字前印「1.」「2.」…（`LyricLayout.autoPrefix`）。
/// 源里任一段首字带了段号的声部整个不补；副歌与非数字段号不标。
fn auto_verse_numbers(score: &mut StaffLayout) {
    let mode = score.options.verse_numbers.as_str();
    if mode == "never" {
        return;
    }
    let min = if mode == "auto" { score.options.verse_number_auto_min + 1.0 } else { 2.0 };
    for p in 0..score.parts.len() {
        let mut firsts: Vec<(f64, LyricId)> = Vec::new();
        let mut printed = false;
        for mi in 0..score.parts[p].measures.len() {
            let md = score.parts[p].measures[mi];
            let mut ls = score[md].lyrics.clone();
            {
                let s = &*score;
                js::sort_by(&mut ls, |a, b| s[*a].offset.compare_to(&s[*b].offset) as f64);
            }
            for l in ls {
                let ly = &score[l];
                if !ly.prefix().is_empty() {
                    printed = true;
                }
                if ly.empty() || ly.src.number_text.is_some() || ly.src.refrain == Some(true) {
                    continue;
                }
                let n = ly.src.number;
                if !firsts.iter().any(|(k, _)| *k == n) {
                    firsts.push((n, l));
                }
            }
        }
        if printed || (firsts.len() as f64) < min {
            continue;
        }
        js::sort_by(&mut firsts, |a, b| a.0 - b.0);
        for (k, (_, l)) in firsts.into_iter().enumerate() {
            score[l].auto_prefix = format!("{}.", k + 1);
        }
    }
}
