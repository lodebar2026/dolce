//! 识别结果模型（整曲）与 MusicXML 写出。现在只有骨架：声部、小节、谱号 / 调号 / 拍号、小节线样式与反复、分行分页；
//! 音与记号、歌词、版面随各模块落地逐步加（见 web 模块页「识别-Rust」）。
use crate::music::{BarStyle, Clef, ClefSign, Key, Time, TimeSymbol};
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

/// 一个小节（一个声部的）。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Measure {
    /// 小节起头印的。
    pub attrs: Attrs,
    /// 小节中途换的（按谱面次序；音符落地前先都排在小节内容之前）。
    pub mid: Vec<Attrs>,
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

fn write_attrs(o: &mut String, a: &Attrs, divisions: bool) {
    if a.is_empty() && !divisions {
        return;
    }
    o.push_str("      <attributes>\n");
    if divisions {
        o.push_str("        <divisions>24</divisions>\n");
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
}
