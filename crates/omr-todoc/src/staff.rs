//! 五线谱识别结果（`omr-sheet::score::Score`）→ `ScoreDoc`，外加两份附件：识别 id（[`Rids`]）与符干。
//!
//! 模型与读进识别写出的 MusicXML 所得逐字段相同（口径照 `dolce-model::fromxml`：方向记号挂在前一个元素之后、
//! 和弦记号等下一个音、弧按编号与声部配对、简谱度数按调号补）。识别 id 不进模型，按「对象 + 槽位」记在附件里：
//! 音（`Note`；休止记在 `Chord` 上，和弦同时记第一个音的）、弧的起端（`Mark` 的 `Start`）、歌词、文字记号 / 力度 / 速度（`Direction`）。
//! 要 MusicXML 就交唯一写出端 [`to_music_xml`]，id 与符干照附件写回元素上。
use dolce_base::js;
use dolce_model::doc::*;
use dolce_model::fromxml::split_verse_label;
use dolce_model::helpers::{empty_doc, empty_song, IdGen};
use dolce_model::jianpu::{assign_degrees, c_major};
use dolce_model::toxml::{score_doc_to_music_xml, ToXmlOptions};
use dolce_model::xmlsurface::{EngravedLayout, Slot};
use dolce_omr_sheet::music::{self as om, ClefSign as OClefSign, TimeSymbol};
use dolce_omr_sheet::result::Src;
use dolce_omr_sheet::score::{self as os, Art, Dir, SpanKind, DIVISIONS};
use dolce_omr_text::chords;
use dolce_omr_text::words::Jump;
use std::collections::HashMap;

/// 识别 id 附件：模型对象 + 槽位 → 识别 id（`omr7`、`omrL4`…）。
pub type Rids = HashMap<(Oid, Slot), String>;

pub struct Built {
    pub doc: ScoreDoc,
    pub rids: Rids,
    /// 只填了 `stems`（识别出的符干朝向，按 `Note` 身份）
    pub layout: EngravedLayout,
}

/// 写成 MusicXML（唯一写出端；识别 id、符干照附件写）。
pub fn to_music_xml(b: &Built) -> String {
    score_doc_to_music_xml(&b.doc, None, &ToXmlOptions { rids: Some(&b.rids), layout: Some(&b.layout), ..ToXmlOptions::default() }).unwrap_or_default()
}

/// 识别结果直接写成 MusicXML（建模 + 写出）。
pub fn score_to_music_xml(score: &os::Score) -> String {
    to_music_xml(&score_to_doc(score))
}

fn rid_of(src: &Src) -> Option<String> {
    src.rid.map(|r| r.to_string())
}

fn step_of(s: u8) -> Step {
    Step::parse(&['C', 'D', 'E', 'F', 'G', 'A', 'B'][s as usize % 7].to_string())
}

fn pitch_of(p: &om::Pitch) -> Pitch {
    Pitch { step: Step::parse(&p.step_name().to_string()), alter: p.alter as f64, octave: p.octave as f64 }
}

/// 延音线收端按音高配：`step + alter（不为 0 才有）+ octave`
fn pitch_key(p: &om::Pitch) -> String {
    format!("{}{}{}", p.step_name(), if p.alter != 0 { p.alter.to_string() } else { String::new() }, p.octave)
}

fn clef_of(c: om::Clef, number: Option<u8>) -> Clef {
    let sign = match c.sign {
        OClefSign::G => "G",
        OClefSign::F => "F",
        OClefSign::C => "C",
        OClefSign::Percussion => "percussion",
    };
    Clef {
        sign: ClefSign::parse(sign),
        line: (c.sign != OClefSign::Percussion).then_some(c.line as f64),
        octave_change: (c.octave != 0).then_some(c.octave as f64),
        staff: number.map(f64::from),
    }
}

/// 一组 `<attributes>` 的语义：`a` 的调号拍号与各谱表的谱号（`more` 是其余谱表的）；`staves` 给了（首小节）带谱表数。
/// 什么都没有回 None（不写这一组）。
fn attrs_of(a: &os::Attrs, more: &[os::Attrs], divisions: bool, staves: Option<u8>) -> Option<MeasureAttrs> {
    if a.is_empty() && more.iter().all(|m| m.clef.is_none()) && !divisions {
        return None;
    }
    let numbered = staves.is_some() || more.iter().any(|m| m.clef.is_some());
    let clefs: Vec<Clef> = std::iter::once(a).chain(more).filter_map(|x| x.clef.map(|c| clef_of(c, (numbered || x.staff > 1).then_some(x.staff.max(1))))).collect();
    Some(MeasureAttrs {
        divisions: divisions.then_some(DIVISIONS as f64),
        key: a.key.map(|k| Key { fifths: k.fifths as f64, ..c_major() }),
        time: a.time.map(|t| Time {
            beats: t.beats as f64,
            beat_type: t.beat_type as f64,
            symbol: match t.symbol {
                TimeSymbol::Normal => None,
                TimeSymbol::Common => Some("common".into()),
                TimeSymbol::Cut => Some("cut".into()),
            },
            parenthesized: None,
        }),
        clefs: (!clefs.is_empty()).then_some(clefs),
        staves: staves.filter(|&n| n > 1).map(f64::from),
        ..MeasureAttrs::default()
    })
}

/// 后来的一组并进前面的（有的字段覆盖）
fn merge_attrs(base: &mut MeasureAttrs, a: MeasureAttrs) {
    macro_rules! over {
        ($($f:ident),*) => { $( if a.$f.is_some() { base.$f = a.$f; } )* };
    }
    over!(divisions, key, time, clefs, staves, transpose, multi_rest);
}

fn harmony_of(t: &str) -> Option<Harmony> {
    let c = chords::parse(t)?;
    Some(Harmony {
        root: HarmonyStep { step: step_of(c.root).as_str().to_owned(), alter: c.root_alter as f64, alter_left: None },
        kind: chords::kind_xml(&c.kind).to_owned(),
        kind_text: Some(c.kind.clone()),
        bass: c.bass.map(|(b, a)| HarmonyStep { step: step_of(b).as_str().to_owned(), alter: a as f64, alter_left: None }),
        ..Harmony::default()
    })
}

/// 方向记号（和弦记号另走 [`harmony_of`]）；`staff`：多谱表声部里属于第几谱表。
fn direction_of(d: &Dir, staff: Option<u8>) -> Option<Direction> {
    let mut x = Direction { staff: staff.map(f64::from), ..Direction::default() };
    match d {
        Dir::Harmony(_) => return None,
        Dir::Words { text, above, jump } => {
            x.kind = "words".into();
            x.text = Some(text.clone());
            x.placement = Some(if *above { Placement::Above } else { Placement::Below });
            let mut s = Sound::default();
            match jump {
                Some(Jump::DalSegno) => s.dalsegno = Some("segno".into()),
                Some(Jump::DaCapo) => s.dacapo = Some(true),
                Some(Jump::Fine) => s.fine = Some(true),
                Some(Jump::ToCoda) => s.tocoda = Some("coda".into()),
                Some(Jump::Coda) => s.coda = Some("coda".into()),
                None => {}
            }
            x.sound = (s != Sound::default()).then_some(s);
        }
        Dir::Dynamics(t) => {
            x.kind = "dynamics".into();
            x.text = Some(t.clone());
            x.placement = Some(Placement::Below);
        }
        Dir::Wedge(w) => {
            let t = match w {
                os::Wedge::Crescendo => "crescendo",
                os::Wedge::Diminuendo => "diminuendo",
                os::Wedge::Stop => "stop",
            };
            x.kind = "wedge".into();
            x.wedge_type = WedgeType::known(t);
            x.span_type = Some(if t == "stop" { SpanType::Stop } else { SpanType::Start });
            x.placement = Some(Placement::Below);
        }
        Dir::Metronome { per_minute, circa } => {
            x.kind = "metronome".into();
            x.placement = Some(Placement::Above);
            let mut m = Metronome { beat_unit: Some(NoteType::Quarter), ..Metronome::default() };
            if *circa {
                m.per_minute_text = Some(format!("c. {per_minute}"));
            } else {
                m.per_minute = Some(*per_minute as f64);
            }
            x.tempo = Some(m);
            x.sound = Some(Sound { tempo: Some(*per_minute as f64), ..Sound::default() });
        }
    }
    Some(x)
}

/// 跨元素记号的一端（收齐一个小节再配对）。
struct Pending {
    t: f64,
    staff: f64,
    voice: f64,
    start: bool,
    kind: MarkType,
    number: f64,
    id: ElementId,
    note: f64,
    /// 所在音的音高键（延音线按它配；休止 / 无音高为 None）
    pitch: Option<String>,
    placement: Option<Placement>,
    orientation: Option<Orientation>,
    rid: Option<String>,
}

#[derive(Clone)]
struct Open {
    id: ElementId,
    note: f64,
    staff: f64,
    voice: f64,
    pitch: Option<String>,
    placement: Option<Placement>,
    orientation: Option<Orientation>,
    rid: Option<String>,
}

/// 写记号时的位置：小节里已有几个元素、游标、上一个音的收尾、属于第几谱表（多谱表声部）。
struct Cursor {
    len: usize,
    cursor: f64,
    end: f64,
    staff: Option<u8>,
}

struct Builder {
    ids: IdGen,
    next_oid: u32,
    rids: Rids,
    stems: HashMap<Oid, String>,
    marks: Vec<Mark>,
    open: HashMap<String, Vec<Open>>,
    pending: Vec<Pending>,
}

impl Builder {
    fn oid(&mut self) -> Oid {
        let o = Oid(self.next_oid);
        self.next_oid += 1;
        o
    }

    fn rid(&mut self, oid: Oid, slot: Slot, src: &Src) {
        if let Some(r) = rid_of(src) {
            self.rids.insert((oid, slot), r);
        }
    }

    /// 小节收尾：tied / tuplet 按出现次序，slur 按时刻（同一时刻保持出现次序）
    fn flush_marks(&mut self) {
        let pending = std::mem::take(&mut self.pending);
        let (mut evs, mut slurs): (Vec<Pending>, Vec<Pending>) = pending.into_iter().partition(|e| e.kind != MarkType::Slur);
        // 稳定排序：同一时刻保持出现次序
        slurs.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
        evs.extend(slurs);
        for e in evs {
            if e.start {
                self.open_mark(e);
            } else {
                self.close_mark(e);
            }
        }
    }

    fn open_mark(&mut self, e: Pending) {
        let k = format!("{}#{}", e.kind.as_str(), js::num_to_string(e.number));
        let mut list = match e.kind {
            MarkType::Tied => self.open.get(&k).cloned().unwrap_or_default(),
            MarkType::Slur => self.open.get(&k).cloned().unwrap_or_default().into_iter().filter(|o| o.staff != e.staff || o.voice != e.voice).collect(),
            _ => vec![],
        };
        list.push(Open { id: e.id, note: e.note, staff: e.staff, voice: e.voice, pitch: e.pitch, placement: e.placement, orientation: e.orientation, rid: e.rid });
        self.open.insert(k, list);
    }

    fn close_mark(&mut self, e: Pending) {
        let k = format!("{}#{}", e.kind.as_str(), js::num_to_string(e.number));
        let Some(list) = self.open.get_mut(&k) else { return };
        let Some(mut at) = list.len().checked_sub(1) else { return };
        if e.kind == MarkType::Tied && list.len() > 1 {
            if let Some(p) = &e.pitch {
                if let Some(i) = list.iter().rposition(|o| o.pitch.as_ref() == Some(p)) {
                    at = i;
                }
            }
        }
        if e.kind == MarkType::Slur {
            if let Some(i) = list.iter().rposition(|o| o.staff == e.staff && o.voice == e.voice).or_else(|| list.iter().rposition(|o| o.staff == e.staff)) {
                at = i;
            }
        }
        let started = list.remove(at);
        let mut m = Mark::new(e.kind, started.id, e.id);
        m.number = Some(e.number);
        m.start_note = (started.note != 0.0).then_some(started.note);
        m.end_note = (e.note != 0.0).then_some(e.note);
        m.placement = started.placement;
        m.orientation = started.orientation;
        m.oid = self.oid();
        if let Some(r) = started.rid {
            self.rids.insert((m.oid, Slot::Start), r);
        }
        self.marks.push(m);
    }

    fn lyrics_of(&mut self, e: &os::Event) -> Vec<Lyric> {
        let mut out: Vec<Lyric> = vec![];
        for l in &e.lyrics {
            // 软连字符是词内分音节，不当字
            let shy = l.text.ends_with('\u{ad}');
            let text = l.text.replace('\u{ad}', "");
            let syl = l.syllabic.xml();
            let lm = if matches!(syl, "single" | "begin") { split_verse_label(&text) } else { None };
            let mut lr = Lyric {
                number: if l.number == 0 { 1.0 } else { l.number as f64 },
                text: lm.as_ref().map_or_else(|| text.clone(), |(_, r)| r.clone()),
                syllabic: Some(Syllabic::parse(syl)),
                verse_label: lm.map(|(lab, _)| lab),
                ..Lyric::default()
            };
            if shy {
                lr.syllabic = Some(if matches!(syl, "middle" | "end") { Syllabic::Middle } else { Syllabic::Begin });
            }
            lr.oid = self.oid();
            self.rid(lr.oid, Slot::Default, &l.src);
            // 同一个音上段号重复：按出现次序往后排
            while out.iter().any(|x| x.number == lr.number) {
                lr.number += 1.0;
            }
            out.push(lr);
        }
        out
    }

    /// 一条拍点上的记号：和弦记号等下一个音（记下当时的游标），其余成方向记号挂在前一个元素之后。
    fn place(&mut self, d: &os::Placed, at: &Cursor, harmonies: &mut Vec<(Harmony, f64)>, directions: &mut Vec<Direction>) {
        if let Dir::Harmony(t) = &d.dir {
            if let Some(mut h) = harmony_of(t) {
                h.oid = self.oid();
                harmonies.push((h, at.cursor));
            }
        } else if let Some(mut x) = direction_of(&d.dir, at.staff) {
            x.after_elements = (at.len > 0).then_some(at.len as f64);
            x.onset = (at.cursor != at.end).then_some(at.cursor);
            x.oid = self.oid();
            self.rid(x.oid, Slot::Default, &d.src);
            directions.push(x);
        }
    }

    /// 一个事件 → 和弦（音、歌词、奏法），弧的各端记进待配对池。
    fn chord_of(&mut self, e: &os::Event, perc: bool, multi: bool, at: f64) -> Chord {
        let id = self.ids.next();
        let staff = if multi { e.staff.max(1) as f64 } else { 1.0 };
        let voice = e.voice.max(1) as f64;
        let mut ch = Chord {
            id,
            duration: Duration {
                divisions: e.divisions() as f64,
                kind: Some(NoteType::parse(e.ntype.xml())),
                dots: e.dots as f64,
                time_mod: e.tuplet.map(|t| TimeMod { actual: t.actual as f64, normal: t.normal as f64, normal_type: None }),
            },
            voice,
            staff,
            ..Chord::default()
        };
        ch.oid = self.oid();
        let stem = e.stem_up.map(|up| if up { "up" } else { "down" });
        let push = |b: &mut Builder, start: bool, kind: MarkType, number: f64, note: f64, pitch: Option<String>, sm: Option<&os::SpanMark>| {
            let placement = sm.filter(|s| s.start && s.kind == SpanKind::Slur).map(|s| if s.above { Placement::Above } else { Placement::Below });
            let orientation = sm.filter(|s| s.start && s.kind == SpanKind::Tied).map(|s| if s.above { Orientation::Over } else { Orientation::Under });
            let rid = sm.filter(|s| s.start).and_then(|s| rid_of(&s.src));
            b.pending.push(Pending { t: at, staff, voice, start, kind, number, id, note, pitch, placement, orientation, rid });
        };
        if e.pitches.is_empty() {
            ch.rest = Some(RestInfo::default());
            self.rid(ch.oid, Slot::Default, &e.src_of(None));
        }
        let slurs: Vec<&os::SpanMark> = e.spans.iter().filter(|s| s.kind == SpanKind::Slur).collect();
        let heads: Vec<Option<&om::Pitch>> = if e.pitches.is_empty() { vec![None] } else { e.pitches.iter().map(Some).collect() };
        for (i, p) in heads.into_iter().enumerate() {
            let first = i == 0;
            let ties: Vec<&os::SpanMark> = e.spans.iter().filter(|s| s.kind == SpanKind::Tied && (s.pitch.as_ref() == p || (first && s.pitch.is_none()))).collect();
            if let Some(p) = p {
                let mut n = Note::default();
                if perc {
                    n.unpitched = Some(Unpitched { step: Some(Step::parse(&p.step_name().to_string())), octave: Some(p.octave as f64) });
                } else {
                    n.pitch = Some(pitch_of(p));
                }
                if let Some(&(_, a)) = e.shown.iter().find(|(q, _)| q == p) {
                    n.accidental = Some(Accidental::parse(match a {
                        2 => "double-sharp",
                        1 => "sharp",
                        -1 => "flat",
                        -2 => "flat-flat",
                        _ => "natural",
                    }));
                }
                if !ties.is_empty() {
                    n.tie = Some(Tie { start: ties.iter().any(|t| t.start).then_some(true), stop: ties.iter().any(|t| !t.start).then_some(true) });
                }
                n.oid = self.oid();
                let src = e.src_of(Some(p));
                self.rid(n.oid, Slot::Default, &src);
                if first {
                    self.rid(ch.oid, Slot::Default, &src);
                }
                if let Some(s) = stem {
                    self.stems.insert(n.oid, s.into());
                }
                ch.notes.push(n);
            }
            // 弧的各端，次序同 MusicXML 读入：slur（先收后起）、tied（先收后起）、tuplet（先起后收）
            let note = i as f64;
            let key = if perc { None } else { p.map(pitch_key) };
            for stop in [true, false] {
                for s in slurs.iter().filter(|s| first && s.start != stop) {
                    push(self, s.start, MarkType::Slur, s.number as f64, note, key.clone(), Some(s));
                }
            }
            for stop in [true, false] {
                for s in ties.iter().filter(|s| s.start != stop) {
                    push(self, s.start, MarkType::Tied, 1.0, note, key.clone(), Some(s));
                }
            }
            if let Some(t) = e.tuplet.filter(|_| first) {
                if t.start {
                    push(self, true, MarkType::Tuplet, 1.0, note, key.clone(), None);
                }
                if t.stop {
                    push(self, false, MarkType::Tuplet, 1.0, note, key.clone(), None);
                }
            }
        }
        if perc && !e.pitches.is_empty() {
            ch.rhythm = Some(true);
        }
        let lyr = self.lyrics_of(e);
        if !lyr.is_empty() {
            ch.lyrics = Some(lyr);
        }
        let arts: Vec<String> = e
            .arts
            .iter()
            .filter_map(|a| match a {
                Art::Staccato => Some("staccato"),
                Art::Tenuto => Some("tenuto"),
                Art::Staccatissimo => Some("staccatissimo"),
                Art::Accent => Some("accent"),
                _ => None,
            })
            .map(str::to_owned)
            .collect();
        let n = Notations {
            articulations: (!arts.is_empty()).then_some(arts),
            fermata: e.arts.contains(&Art::Fermata).then_some(true),
            arpeggiate: e.arts.contains(&Art::Arpeggiate).then_some(true),
            ..Notations::default()
        };
        ch.notations = (n != Notations::default()).then_some(n);
        ch
    }

    fn measure(&mut self, p: &os::Part, mi: usize, perc: &mut bool) -> Measure {
        let m = &p.measures[mi];
        let multi = p.staves > 1;
        let mut out = Measure { number: (mi + 1).to_string(), implicit: m.implicit.then_some(true), ..Measure::default() };
        if mi > 0 && (m.new_system || m.new_page) {
            out.print = Some(if m.new_page { Print { new_page: Some(true), ..Print::default() } } else { Print { new_system: Some(true), ..Print::default() } });
        }
        let mut barlines = vec![];
        if m.repeat_start || m.ending_start.is_some() {
            let mut b = Barline::at(BarLocation::Left);
            if m.repeat_start {
                b.style = Some(BarStyle::HeavyLight);
                b.repeat = Some(RepeatDir::Forward);
            }
            if let Some(e) = m.ending_start {
                b.ending = Some(Ending::new(numbers(e.number), EndingType::Start, Some(format!("{}.", e.number))));
            }
            barlines.push(b);
        }
        for a in attrs_of(&m.attrs, &m.staff_attrs, mi == 0, (mi == 0 && multi).then_some(p.staves)).into_iter().chain(m.mid.iter().filter_map(|a| attrs_of(a, &[], false, None))) {
            merge_attrs(out.attrs.get_or_insert_with(MeasureAttrs::default), a);
        }
        if let Some(c) = std::iter::once(&m.attrs).chain(&m.mid).filter_map(|a| a.clef).next_back() {
            *perc = c.sign == OClefSign::Percussion;
        }

        // 小节内的游标：同 MusicXML 读入（`<forward>` / `<backup>` 挪游标，`end` 是上一个音的收尾）
        let (mut cursor, mut end, mut reach, mut max_end) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
        let mut harmonies: Vec<(Harmony, f64)> = vec![];
        let mut directions: Vec<Direction> = vec![];
        let mut voices: Vec<u8> = m.events.iter().map(|e| e.voice.max(1)).collect();
        voices.sort_unstable();
        voices.dedup();
        for v in voices {
            let mut es: Vec<&os::Event> = m.events.iter().filter(|e| e.voice.max(1) == v).collect();
            es.sort_by_key(|e| e.onset);
            for e in es {
                let onset = e.onset as f64;
                if onset > cursor {
                    cursor = onset;
                    reach = reach.max(cursor);
                } else {
                    cursor = onset;
                }
                let staff = multi.then_some(e.staff.max(1));
                let at = Cursor { len: out.elements.len(), cursor, end, staff };
                for d in &e.pre {
                    self.place(d, &at, &mut harmonies, &mut directions);
                }
                let mut ch = self.chord_of(e, *perc, multi, cursor);
                if cursor != end {
                    ch.onset = Some(cursor);
                }
                if !harmonies.is_empty() {
                    let mut hs = std::mem::take(&mut harmonies).into_iter().map(|(mut h, o)| {
                        if o != cursor {
                            h.onset = Some(o);
                        }
                        h
                    });
                    ch.harmony = hs.next();
                    let later: Vec<Harmony> = hs.collect();
                    ch.later_harmonies = (!later.is_empty()).then_some(later);
                }
                cursor += ch.duration.divisions;
                end = cursor;
                reach = reach.max(cursor);
                max_end = max_end.max(cursor);
                out.elements.push(Element::Chord(ch));
                let at = Cursor { len: out.elements.len(), cursor, end, staff };
                for d in &e.post {
                    self.place(d, &at, &mut harmonies, &mut directions);
                }
            }
        }
        // 小节末尾还欠着的和弦记号：挂在 `y` 占位符上
        for (harmony, o) in harmonies {
            let id = self.ids.next();
            out.elements.push(Element::Space(Space {
                id,
                spacer: Spacer::Y,
                duration: None,
                beams: None,
                voice: 1.0,
                staff: 1.0,
                harmony: Some(harmony),
                lyrics: None,
                notations: None,
                onset: (o != end).then_some(o),
                attached_sources: None,
                source: None,
            }));
        }
        if reach > max_end {
            out.duration = Some(reach);
        }
        if m.right.is_some() || m.repeat_end || m.ending_stop.is_some() {
            let mut b = Barline::at(BarLocation::Right);
            if m.right.is_some() || m.repeat_end {
                b.style = BarStyle::known(m.right.unwrap_or(om::BarStyle::LightHeavy).xml());
            }
            if let Some(e) = m.ending_stop {
                b.ending = Some(Ending::new(numbers(e.number), if e.closed { EndingType::Stop } else { EndingType::Discontinue }, None));
            }
            if m.repeat_end {
                b.repeat = Some(RepeatDir::Backward);
            }
            barlines.push(b);
        }
        out.barlines = (!barlines.is_empty()).then_some(barlines);
        out.directions = (!directions.is_empty()).then_some(directions);
        self.flush_marks();
        out
    }
}

/// 房号（0 不算）
fn numbers(n: u8) -> Vec<f64> {
    if n > 0 {
        vec![n as f64]
    } else {
        vec![]
    }
}

/// 识别结果 → 模型 + 识别 id / 符干附件。
pub fn score_to_doc(score: &os::Score) -> Built {
    let mut b = Builder { ids: IdGen::new(), next_oid: 1, rids: Rids::new(), stems: HashMap::new(), marks: vec![], open: HashMap::new(), pending: vec![] };
    let mut doc = empty_doc(SourceFormat::MusicXml);
    let mut song = empty_song();
    song.work.title = score.title.clone().filter(|t| !t.is_empty());
    let credits: Vec<Credit> = score
        .credits
        .iter()
        .map(|c| Credit {
            kind: c.kind.map(|k| k.xml().to_owned()),
            text: c.text.clone(),
            words: c.text.contains('\n').then(|| vec![c.text.clone()]),
            font_size: Some((c.size * 2.0).round() / 2.0),
            justify: HAlign::known(c.justify.xml()),
            valign: VAlign::known("bottom"),
            page: Some(1.0),
            ..Credit::default()
        })
        .collect();
    song.credits = (!credits.is_empty()).then_some(credits);
    let empty = os::Part { measures: vec![os::Measure::default()], staves: 1 };
    let parts: Vec<&os::Part> = if score.parts.is_empty() { vec![&empty] } else { score.parts.iter().collect() };
    for (pi, p) in parts.iter().enumerate() {
        b.open.clear();
        let mut perc = false;
        let mut part = Part { id: format!("P{}", pi + 1), ..Part::default() };
        for mi in 0..p.measures.len() {
            let m = b.measure(p, mi, &mut perc);
            if let Some(s) = m.attrs.as_ref().and_then(|a| a.staves) {
                part.staff_count = Some(s);
            }
            part.measures.push(m);
        }
        song.parts.push(part);
    }
    // 全曲共用的调号/拍号：取第一个声部第一次出现的那个
    if let Some(a) = song.parts.first().and_then(|p| p.measures.iter().filter_map(|m| m.attrs.as_ref()).find(|a| a.key.is_some() || a.time.is_some())) {
        song.key = a.key.clone();
        song.time = a.time.clone();
    }
    let key = song.key.clone().unwrap_or_else(c_major);
    for part in &mut song.parts {
        assign_degrees(part, &key);
    }
    song.marks = std::mem::take(&mut b.marks);
    doc.songs.push(song);
    Built { doc, rids: b.rids, layout: EngravedLayout { stems: b.stems, ..EngravedLayout::default() } }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dolce_omr_sheet::music::{BarStyle as OBar, Clef as OClef, Key as OKey, Pitch as OPitch, Time as OTime};
    use dolce_omr_sheet::result::{Rid, RidKind};
    use dolce_omr_sheet::score::{Attrs, Ending as OEnding, Event, HeadSrc, Lyric as OLyric, Measure as OMeasure, NoteType as ONoteType, Part as OPart, Placed, Score, SpanMark, Tuplet, Wedge};
    use dolce_omr_text::lyrics::Syllabic as OSyllabic;

    fn src(kind: RidKind, n: u32) -> Src {
        Src { rid: Some(Rid { kind, n }), at: None }
    }

    fn one(measures: Vec<OMeasure>) -> Score {
        Score { title: None, credits: vec![], parts: vec![OPart { measures, staves: 1 }] }
    }

    #[test]
    fn skeleton() {
        let mut m1 = OMeasure { attrs: Attrs { clef: Some(OClef::TREBLE_8VB), key: Some(OKey { fifths: -2 }), time: Some(OTime { beats: 4, beat_type: 4, symbol: TimeSymbol::Common }), staff: 0 }, ..Default::default() };
        m1.right = Some(OBar::LightLight);
        let m2 = OMeasure { repeat_end: true, new_system: true, ..Default::default() };
        let s = Score { title: Some("a<b".into()), ..one(vec![m1, m2]) };
        let b = score_to_doc(&s);
        let song = &b.doc.songs[0];
        assert_eq!(song.work.title.as_deref(), Some("a<b"));
        assert_eq!(song.key.as_ref().map(|k| k.fifths), Some(-2.0));
        let x = to_music_xml(&b);
        assert!(x.contains("<work-title>a&lt;b</work-title>"));
        assert!(x.contains("<fifths>-2</fifths>"));
        assert!(x.contains("<time symbol=\"common\">"));
        assert!(x.contains("<clef-octave-change>-1</clef-octave-change>"));
        assert!(x.contains("<bar-style>light-light</bar-style>"));
        assert!(x.contains("<print new-system=\"yes\"/>"));
        assert!(x.contains("<repeat direction=\"backward\"/>"));
    }

    #[test]
    fn notes_and_ids() {
        let e = Event::new(vec![OPitch { step: 0, octave: 4, alter: 1 }, OPitch { step: 2, octave: 4, alter: 0 }], ONoteType::Quarter, 1, Some(true));
        // 第二声部：二分音符从小节头起
        let mut low = Event::new(vec![OPitch { step: 0, octave: 3, alter: 0 }], ONoteType::Half, 0, Some(false));
        low.voice = 2;
        low.arts.push(Art::Fermata);
        low.lyrics.push(OLyric { number: 2, text: "1.道".into(), syllabic: OSyllabic::Single, src: src(RidKind::Lyric, 4) });
        low.src.push(HeadSrc { pitch: Some(OPitch { step: 0, octave: 3, alter: 0 }), src: src(RidKind::Note, 7) });
        low.pre.push(Dir::Harmony("F#m7/C#".into()).into());
        low.pre.push(Placed { dir: Dir::Dynamics("mf".into()), src: src(RidKind::Dynamics, 1) });
        let mut tri = Event::new(vec![], ONoteType::Eighth, 0, None);
        tri.onset = 36;
        tri.tuplet = Some(Tuplet { actual: 3, normal: 2, start: true, stop: false });
        let b = score_to_doc(&one(vec![OMeasure { events: vec![e, low, tri], ..Default::default() }]));
        let m = &b.doc.songs[0].parts[0].measures[0];
        // 元素按声部写：声部 1 的两个在前
        let Element::Chord(c) = &m.elements[2] else { panic!() };
        assert_eq!((c.voice, c.onset, c.duration.divisions), (2.0, Some(0.0), 48.0));
        assert_eq!(c.lyrics.as_ref().unwrap()[0].verse_label.as_deref(), Some("1."));
        assert_eq!(c.harmony.as_ref().map(|h| (h.kind.as_str(), h.bass.as_ref().map(|x| x.alter))), Some(("minor-seventh", Some(1.0))));
        let x = to_music_xml(&b);
        assert!(x.contains("<backup>") && x.contains("<voice>2</voice>") && x.contains("<fermata/>"));
        assert!(x.contains("<note id=\"omr7\">") && x.contains("<direction placement=\"below\" id=\"omrD1\">"));
        assert!(x.contains("<lyric number=\"2\" id=\"omrL4\">") && x.contains("<text>1.道</text>") && x.contains("<kind text=\"m7\">minor-seventh</kind>") && x.contains("<mf/>"));
        // 只有起端的连音配不上对，不成记号（读 MusicXML 同样丢掉），时值改变照写
        assert!(x.contains("<actual-notes>3</actual-notes>") && !x.contains("<tuplet "));
        assert!(x.contains("<duration>36</duration>") && x.contains("<dot/>") && x.contains("<stem>up</stem>") && x.contains("<stem>down</stem>"));
    }

    #[test]
    fn spans() {
        let (c, e4) = (OPitch { step: 0, octave: 4, alter: 0 }, OPitch { step: 2, octave: 4, alter: 0 });
        let mut a = Event::new(vec![c, e4], ONoteType::Quarter, 0, Some(true));
        a.spans.push(SpanMark { kind: SpanKind::Tied, start: true, number: 1, above: true, pitch: Some(e4), src: src(RidKind::Tie, 1) });
        a.spans.push(SpanMark { kind: SpanKind::Slur, start: true, number: 2, above: false, pitch: None, src: src(RidKind::Slur, 2) });
        a.pre.push(Dir::Wedge(Wedge::Crescendo).into());
        let mut b2 = Event::new(vec![e4], ONoteType::Quarter, 0, Some(true));
        b2.onset = 24;
        b2.spans.push(SpanMark { kind: SpanKind::Tied, start: false, number: 1, above: true, pitch: Some(e4), src: Src::default() });
        b2.spans.push(SpanMark { kind: SpanKind::Slur, start: false, number: 2, above: false, pitch: None, src: Src::default() });
        b2.post.push(Dir::Wedge(Wedge::Stop).into());
        let m = OMeasure { events: vec![a, b2], ending_start: Some(OEnding { number: 1, closed: true }), ending_stop: Some(OEnding { number: 1, closed: true }), repeat_end: true, ..Default::default() };
        let b = score_to_doc(&one(vec![m]));
        let song = &b.doc.songs[0];
        // 延音线连的是和弦里的 E（第二个音），圆滑线挂首音
        let tie = song.marks.iter().find(|m| m.kind == MarkType::Tied).unwrap();
        assert_eq!((tie.start_note, tie.end_note, tie.orientation.clone()), (Some(1.0), None, Some(Orientation::Over)));
        let slur = song.marks.iter().find(|m| m.kind == MarkType::Slur).unwrap();
        assert_eq!((slur.number, slur.placement.clone()), (Some(2.0), Some(Placement::Below)));
        assert_eq!(b.rids.get(&(tie.oid, Slot::Start)).map(String::as_str), Some("omrT1"));
        let x = to_music_xml(&b);
        let first = &x[x.find("<step>C</step>").unwrap()..x.find("<step>E</step>").unwrap()];
        assert!(!first.contains("<tie ") && first.contains("<slur type=\"start\" number=\"2\" placement=\"below\" id=\"omrS2\"/>"));
        assert!(x.contains("<tied type=\"start\" number=\"1\" orientation=\"over\" id=\"omrT1\"/>") && x.contains("<tied type=\"stop\" number=\"1\"/>"));
        assert!(x.contains("<wedge type=\"crescendo\"/>") && x.find("<wedge type=\"stop\"/>").unwrap() > x.rfind("</note>").unwrap());
        assert!(x.contains("<ending number=\"1\" type=\"start\">1.</ending>") && x.contains("<repeat direction=\"backward\"/>"));
    }
}
