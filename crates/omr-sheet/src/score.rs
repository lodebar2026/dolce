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

/// 一个拍点上的事件：和弦（`pitches` 自低到高；单音也是）或休止（`pitches` 为空）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub pitches: Vec<Pitch>,
    pub ntype: NoteType,
    pub dots: u8,
    /// 符干朝上 / 朝下；没有干（全音符、休止）为 None。
    pub stem_up: Option<bool>,
}

impl Event {
    pub fn divisions(&self) -> u32 {
        self.ntype.dotted(self.dots)
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
    /// 音与休止，按谱面次序（现只有一个声部）。
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
    let tail = |o: &mut String| {
        let _ = writeln!(o, "        <duration>{dur}</duration>\n        <voice>1</voice>\n        <type>{}</type>", e.ntype.xml());
        for _ in 0..e.dots {
            o.push_str("        <dot/>\n");
        }
        if let Some(up) = e.stem_up {
            let _ = writeln!(o, "        <stem>{}</stem>", if up { "up" } else { "down" });
        }
        o.push_str("      </note>\n");
    };
    if e.pitches.is_empty() {
        o.push_str("      <note>\n        <rest/>\n");
        tail(o);
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
        tail(o);
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
                for e in &m.events {
                    write_event(&mut o, e);
                }
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
        let e = Event { pitches: vec![Pitch { step: 0, octave: 4, alter: 1 }, Pitch { step: 2, octave: 4, alter: 0 }], ntype: NoteType::Quarter, dots: 1, stem_up: Some(true) };
        assert_eq!(e.divisions(), 36);
        let x = Score { title: None, parts: vec![Part { measures: vec![Measure { events: vec![e], ..Default::default() }] }] }.to_musicxml();
        assert!(x.contains("<pitch><step>C</step><alter>1</alter><octave>4</octave></pitch>"));
        assert!(x.contains("<chord/>\n        <pitch><step>E</step><octave>4</octave></pitch>"));
        assert!(x.contains("<duration>36</duration>") && x.contains("<dot/>") && x.contains("<stem>up</stem>"));
    }
}
