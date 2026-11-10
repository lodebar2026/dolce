//! 识别结果模型（整曲）与 MusicXML 写出。现在只有骨架：声部、小节、谱号 / 调号 / 拍号、小节线样式与反复、分行分页；
//! 音与记号、歌词、版面随各模块落地逐步加（见 web 模块页「识别-Rust」）。
use crate::music::{BarStyle, Clef, ClefSign, Key, Pitch, Time, TimeSymbol};
use serde::{Deserialize, Serialize};
use std::fmt::Write;

/// 一处印出来的谱号 / 调号 / 拍号（有哪样写哪样）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attrs {
    pub clef: Option<Clef>,
    pub key: Option<Key>,
    pub time: Option<Time>,
}

impl Attrs {
    pub fn is_empty(&self) -> bool {
        self.clef.is_none() && self.key.is_none() && self.time.is_none()
    }
}

/// 写出用的时值单位：一个四分音符这么多份。
pub const DIVISIONS: u32 = 24;

/// 拍号 `t` 下一小节多少份。
pub fn measure_divisions(t: Time) -> u32 {
    t.beats as u32 * DIVISIONS * 4 / (t.beat_type as u32).max(1)
}

/// 时值的基本型（不含附点）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum NoteType {
    Whole,
    Half,
    Quarter,
    Eighth,
    N16th,
    N32nd,
}

impl NoteType {
    pub fn xml(&self) -> &'static str {
        match self {
            NoteType::Whole => "whole",
            NoteType::Half => "half",
            NoteType::Quarter => "quarter",
            NoteType::Eighth => "eighth",
            NoteType::N16th => "16th",
            NoteType::N32nd => "32nd",
        }
    }
    /// 占多少份（`DIVISIONS` 口径）。
    pub fn divisions(&self) -> u32 {
        match self {
            NoteType::Whole => DIVISIONS * 4,
            NoteType::Half => DIVISIONS * 2,
            NoteType::Quarter => DIVISIONS,
            NoteType::Eighth => DIVISIONS / 2,
            NoteType::N16th => DIVISIONS / 4,
            NoteType::N32nd => DIVISIONS / 8,
        }
    }
    /// 带 `dots` 个附点占多少份。
    pub fn dotted(&self, dots: u8) -> u32 {
        let base = self.divisions();
        (0..dots).fold((base, base), |(sum, last), _| (sum + last / 2, last / 2)).0
    }
}

/// 贴着音的奏法记号。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Art {
    Fermata,
    Staccato,
    Tenuto,
    Accent,
    Arpeggiate,
}

/// 连音：`actual` 个音占 `normal` 个的时值；`start` / `stop` 标这一组的头尾。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tuplet {
    pub actual: u8,
    pub normal: u8,
    pub start: bool,
    pub stop: bool,
}

/// 一个事件：和弦（`pitches` 自低到高；单音也是）或休止（`pitches` 为空）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub pitches: Vec<Pitch>,
    pub ntype: NoteType,
    pub dots: u8,
    /// 符干朝上 / 朝下；没有干（全音符、休止）为 None。
    pub stem_up: Option<bool>,
    /// 在小节里的起拍时刻（份）与声部（1 / 2；一行谱至多两个声部，共用的元素记在声部 1）。
    pub onset: u32,
    pub voice: u8,
    pub arts: Vec<Art>,
    pub tuplet: Option<Tuplet>,
}

impl Event {
    pub fn new(pitches: Vec<Pitch>, ntype: NoteType, dots: u8, stem_up: Option<bool>) -> Self {
        Event { pitches, ntype, dots, stem_up, onset: 0, voice: 1, arts: Vec::new(), tuplet: None }
    }

    pub fn divisions(&self) -> u32 {
        let d = self.ntype.dotted(self.dots);
        self.tuplet.map_or(d, |t| d * t.normal as u32 / (t.actual as u32).max(1))
    }
}

/// 一处把握不大的地方（随结果交出，核对视图标出来）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Doubt {
    /// 页码（1 起）、系统顶（原图像素）、系统内第几行、全曲第几小节（0 起）。
    pub page: usize,
    pub sys_top: f64,
    pub row: usize,
    pub measure: usize,
    /// 源图框 `(x0, y0, x1, y1)`（原图像素）。
    pub rect: (f64, f64, f64, f64),
    pub kind: DoubtKind,
    /// 给人看的说明（改了什么、差多少）。
    pub note: String,
}

/// 可疑的原因码。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DoubtKind {
    /// 小节不满拍 / 超拍（保持原判）。
    Underfull,
    Overfull,
    /// 同系统各行拍位对不齐。
    Misaligned,
    /// 按满拍改过的（改时值、删元素）。
    Inferred,
}

impl DoubtKind {
    pub fn code(&self) -> &'static str {
        match self {
            DoubtKind::Underfull => "underfull",
            DoubtKind::Overfull => "overfull",
            DoubtKind::Misaligned => "misaligned",
            DoubtKind::Inferred => "inferred",
        }
    }
}

/// 一个小节（一个声部的）。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Measure {
    /// 小节起头印的。
    pub attrs: Attrs,
    /// 小节中途换的（按谱面次序；现都排在小节内容之前）。
    pub mid: Vec<Attrs>,
    /// 音与休止（各带起拍时刻与声部）。
    pub events: Vec<Event>,
    /// 右小节线；`None` 即普通单线。
    pub right: Option<BarStyle>,
    /// 右线左侧有反复点（反复结束）。
    pub repeat_end: bool,
    /// 左线右侧有反复点（反复开始）。
    pub repeat_start: bool,
    pub new_system: bool,
    pub new_page: bool,
    /// 上一行行末没印右线、这一小节是跨行劈开的后半截（MusicXML `implicit`；判分时上一行行末那条线不计）。
    pub implicit: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Part {
    pub measures: Vec<Measure>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Score {
    pub title: Option<String>,
    pub parts: Vec<Part>,
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn write_event(o: &mut String, e: &Event) {
    let dur = e.divisions();
    let tail = |o: &mut String, first: bool| {
        let _ = writeln!(o, "        <duration>{dur}</duration>\n        <voice>{}</voice>\n        <type>{}</type>", e.voice.max(1), e.ntype.xml());
        for _ in 0..e.dots {
            o.push_str("        <dot/>\n");
        }
        if let Some(t) = e.tuplet {
            let _ = writeln!(o, "        <time-modification><actual-notes>{}</actual-notes><normal-notes>{}</normal-notes></time-modification>", t.actual, t.normal);
        }
        if let Some(up) = e.stem_up {
            let _ = writeln!(o, "        <stem>{}</stem>", if up { "up" } else { "down" });
        }
        // 记号只写在和弦的第一个音上
        let tup = e.tuplet.filter(|t| first && (t.start || t.stop));
        if first && (!e.arts.is_empty() || tup.is_some()) {
            o.push_str("        <notations>\n");
            if let Some(t) = tup {
                if t.start {
                    o.push_str("          <tuplet type=\"start\" number=\"1\"/>\n");
                }
                if t.stop {
                    o.push_str("          <tuplet type=\"stop\" number=\"1\"/>\n");
                }
            }
            let inner: Vec<&str> = e
                .arts
                .iter()
                .filter_map(|a| match a {
                    Art::Staccato => Some("staccato"),
                    Art::Tenuto => Some("tenuto"),
                    Art::Accent => Some("accent"),
                    _ => None,
                })
                .collect();
            if !inner.is_empty() {
                o.push_str("          <articulations>");
                for a in inner {
                    let _ = write!(o, "<{a}/>");
                }
                o.push_str("</articulations>\n");
            }
            if e.arts.contains(&Art::Fermata) {
                o.push_str("          <fermata/>\n");
            }
            if e.arts.contains(&Art::Arpeggiate) {
                o.push_str("          <arpeggiate/>\n");
            }
            o.push_str("        </notations>\n");
        }
        o.push_str("      </note>\n");
    };
    if e.pitches.is_empty() {
        o.push_str("      <note>\n        <rest/>\n");
        tail(o, true);
        return;
    }
    for (i, p) in e.pitches.iter().enumerate() {
        o.push_str("      <note>\n");
        if i > 0 {
            o.push_str("        <chord/>\n");
        }
        let _ = write!(o, "        <pitch><step>{}</step>", p.step_name());
        if p.alter != 0 {
            let _ = write!(o, "<alter>{}</alter>", p.alter);
        }
        let _ = writeln!(o, "<octave>{}</octave></pitch>", p.octave);
        tail(o, i == 0);
    }
}

/// 一个小节的事件按声部写：声部 1 写完 `<backup>` 回小节头再写声部 2；起拍时刻与游标不一致的用 `<forward>` / `<backup>` 挪。
fn write_events(o: &mut String, events: &[Event]) {
    let mut cur = 0u32;
    for v in [1u8, 2] {
        let mut es: Vec<&Event> = events.iter().filter(|e| e.voice.clamp(1, 2) == v).collect();
        es.sort_by_key(|e| e.onset);
        for e in es {
            if e.onset > cur {
                let _ = writeln!(o, "      <forward>\n        <duration>{}</duration>\n      </forward>", e.onset - cur);
            } else if e.onset < cur {
                let _ = writeln!(o, "      <backup>\n        <duration>{}</duration>\n      </backup>", cur - e.onset);
            }
            write_event(o, e);
            cur = e.onset + e.divisions();
        }
    }
}

fn write_attrs(o: &mut String, a: &Attrs, divisions: bool) {
    if a.is_empty() && !divisions {
        return;
    }
    o.push_str("      <attributes>\n");
    if divisions {
        let _ = writeln!(o, "        <divisions>{DIVISIONS}</divisions>");
    }
    if let Some(k) = a.key {
        let _ = writeln!(o, "        <key><fifths>{}</fifths></key>", k.fifths);
    }
    if let Some(t) = a.time {
        let sym = match t.symbol {
            TimeSymbol::Normal => "",
            TimeSymbol::Common => " symbol=\"common\"",
            TimeSymbol::Cut => " symbol=\"cut\"",
        };
        let _ = writeln!(o, "        <time{sym}><beats>{}</beats><beat-type>{}</beat-type></time>", t.beats, t.beat_type);
    }
    if let Some(c) = a.clef {
        let sign = match c.sign {
            ClefSign::G => "G",
            ClefSign::F => "F",
            ClefSign::C => "C",
            ClefSign::Percussion => "percussion",
        };
        o.push_str("        <clef>");
        let _ = write!(o, "<sign>{sign}</sign>");
        if c.sign != ClefSign::Percussion {
            let _ = write!(o, "<line>{}</line>", c.line);
        }
        if c.octave != 0 {
            let _ = write!(o, "<clef-octave-change>{}</clef-octave-change>", c.octave);
        }
        o.push_str("</clef>\n");
    }
    o.push_str("      </attributes>\n");
}

impl Score {
    /// 写成 MusicXML（partwise 3.1）。
    pub fn to_musicxml(&self) -> String {
        let mut o = String::new();
        o.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE score-partwise PUBLIC \"-//Recordare//DTD MusicXML 3.1 Partwise//EN\" \"http://www.musicxml.org/dtds/partwise.dtd\">\n<score-partwise version=\"3.1\">\n");
        if let Some(t) = &self.title {
            let _ = writeln!(o, "  <work>\n    <work-title>{}</work-title>\n  </work>", esc(t));
        }
        o.push_str("  <part-list>\n");
        for i in 0..self.parts.len().max(1) {
            let _ = writeln!(o, "    <score-part id=\"P{}\">\n      <part-name print-object=\"no\"/>\n    </score-part>", i + 1);
        }
        o.push_str("  </part-list>\n");
        let empty = Part { measures: vec![Measure::default()] };
        let parts: Vec<&Part> = if self.parts.is_empty() { vec![&empty] } else { self.parts.iter().collect() };
        for (pi, p) in parts.iter().enumerate() {
            let _ = writeln!(o, "  <part id=\"P{}\">", pi + 1);
            for (mi, m) in p.measures.iter().enumerate() {
                let _ = writeln!(o, "    <measure number=\"{}\"{}>", mi + 1, if m.implicit { " implicit=\"yes\"" } else { "" });
                if mi > 0 && (m.new_system || m.new_page) {
                    let _ = writeln!(o, "      <print {}=\"yes\"/>", if m.new_page { "new-page" } else { "new-system" });
                }
                if m.repeat_start {
                    o.push_str("      <barline location=\"left\">\n        <bar-style>heavy-light</bar-style>\n        <repeat direction=\"forward\"/>\n      </barline>\n");
                }
                write_attrs(&mut o, &m.attrs, mi == 0);
                for a in &m.mid {
                    write_attrs(&mut o, a, false);
                }
                write_events(&mut o, &m.events);
                if m.right.is_some() || m.repeat_end {
                    let style = m.right.unwrap_or(BarStyle::LightHeavy);
                    o.push_str("      <barline location=\"right\">\n");
                    let _ = writeln!(o, "        <bar-style>{}</bar-style>", style.xml());
                    if m.repeat_end {
                        o.push_str("        <repeat direction=\"backward\"/>\n");
                    }
                    o.push_str("      </barline>\n");
                }
                o.push_str("    </measure>\n");
            }
            o.push_str("  </part>\n");
        }
        o.push_str("</score-partwise>\n");
        o
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skeleton_xml() {
        let mut m1 = Measure { attrs: Attrs { clef: Some(Clef::TREBLE_8VB), key: Some(Key { fifths: -2 }), time: Some(Time { beats: 4, beat_type: 4, symbol: TimeSymbol::Common }) }, ..Default::default() };
        m1.right = Some(BarStyle::LightLight);
        let m2 = Measure { repeat_end: true, new_system: true, ..Default::default() };
        let x = Score { title: Some("a<b".into()), parts: vec![Part { measures: vec![m1, m2] }] }.to_musicxml();
        assert!(x.contains("<work-title>a&lt;b</work-title>"));
        assert!(x.contains("<key><fifths>-2</fifths></key>"));
        assert!(x.contains("<time symbol=\"common\"><beats>4</beats><beat-type>4</beat-type></time>"));
        assert!(x.contains("<clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>"));
        assert!(x.contains("<bar-style>light-light</bar-style>"));
        assert!(x.contains("<print new-system=\"yes\"/>"));
        assert!(x.contains("<repeat direction=\"backward\"/>"));
    }

    #[test]
    fn notes_xml() {
        let e = Event::new(vec![Pitch { step: 0, octave: 4, alter: 1 }, Pitch { step: 2, octave: 4, alter: 0 }], NoteType::Quarter, 1, Some(true));
        assert_eq!(e.divisions(), 36);
        // 第二声部：二分音符从小节头起
        let mut low = Event::new(vec![Pitch { step: 0, octave: 3, alter: 0 }], NoteType::Half, 0, Some(false));
        low.voice = 2;
        low.arts.push(Art::Fermata);
        let mut tri = Event::new(vec![], NoteType::Eighth, 0, None);
        tri.onset = 36;
        tri.tuplet = Some(Tuplet { actual: 3, normal: 2, start: true, stop: false });
        assert_eq!(tri.divisions(), 8);
        let x = Score { title: None, parts: vec![Part { measures: vec![Measure { events: vec![e, low, tri], ..Default::default() }] }] }.to_musicxml();
        assert!(x.contains("<backup>\n        <duration>44</duration>") && x.contains("<voice>2</voice>") && x.contains("<fermata/>"));
        assert!(x.contains("<actual-notes>3</actual-notes>") && x.contains("<tuplet type=\"start\" number=\"1\"/>"));
        assert!(x.contains("<pitch><step>C</step><alter>1</alter><octave>4</octave></pitch>"));
        assert!(x.contains("<chord/>\n        <pitch><step>E</step><octave>4</octave></pitch>"));
        assert!(x.contains("<duration>36</duration>") && x.contains("<dot/>") && x.contains("<stem>up</stem>"));
    }
}
