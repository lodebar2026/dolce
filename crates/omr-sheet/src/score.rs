//! 识别结果模型（整曲）与 MusicXML 写出。现在只有骨架：声部、小节、谱号 / 调号 / 拍号、小节线样式与反复、分行分页；
//! 音与记号、歌词、版面随各模块落地逐步加（见 web 模块页「识别-Rust」）。
use crate::music::{BarStyle, Clef, ClefSign, Key, Pitch, Time, TimeSymbol};
use crate::result::Src;
use dolce_omr_text::chords;
use dolce_omr_text::header::Credit;
use dolce_omr_text::lyrics::Syllabic;
use dolce_omr_text::words::Jump;
use serde::{Deserialize, Serialize};
use std::fmt::Write;

/// 一处印出来的谱号 / 调号 / 拍号（有哪样写哪样）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attrs {
    pub clef: Option<Clef>,
    pub key: Option<Key>,
    pub time: Option<Time>,
    /// 谱号属于第几谱表（多谱表的声部；0 / 1 都是第一谱表）。
    #[serde(default)]
    pub staff: u8,
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
    /// 断奏楔（▼）。
    Staccatissimo,
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

/// 弧的种类。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SpanKind {
    Slur,
    Tied,
}

/// 弧在这个音上的一端：圆滑线按 `number` 配对（同时开着的几条各用一个号）；延音线记在 `pitch` 那个音上（和弦里连的是哪个音）。
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpanMark {
    pub kind: SpanKind,
    pub start: bool,
    pub number: u8,
    /// 画在音的上方（朝上拱）。
    pub above: bool,
    pub pitch: Option<Pitch>,
    /// 识别 id 与源框（两端同一个；id 只写在起端）。
    #[serde(default)]
    pub src: Src,
}

/// 松叶的一端。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Wedge {
    Crescendo,
    Diminuendo,
    Stop,
}

/// 房子的一端：第几房；止端 `closed` 即右端有收口的钩。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ending {
    pub number: u8,
    pub closed: bool,
}

/// 挂在音上的一个歌词音节：第几行词（1 起，自上而下）、字（行首的印刷段号并在字前：`1.道`、`1 Be`）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Lyric {
    pub number: u8,
    pub text: String,
    pub syllabic: Syllabic,
    #[serde(default)]
    pub src: Src,
}

/// 写在音前面的记号与文字（挂在这个拍点上）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Dir {
    /// 和弦记号（归一后的写法，如 `F#m7/C#`）。
    Harmony(String),
    /// 文字指示；跳转记号另带播放语义。
    Words { text: String, above: bool, jump: Option<Jump> },
    /// 力度（`mf`）。
    Dynamics(String),
    /// 节拍器：四分音符每分钟多少拍；`circa` 即印着 `c.`。
    Metronome { per_minute: u32, circa: bool },
    /// 松叶的起端 / 止端。
    Wedge(Wedge),
}

/// 挂在拍点上的一条记号 / 文字，带识别出处（文字指示、节拍器、力度有识别 id；和弦记号、松叶只有框或什么都没有）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Placed {
    pub dir: Dir,
    #[serde(default)]
    pub src: Src,
}

impl From<Dir> for Placed {
    fn from(dir: Dir) -> Self {
        Placed { dir, src: Src::default() }
    }
}

/// 一个落选候选（换候选用）：改成什么、花费（越小越像；与满拍裁决同一把尺子）。
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct EventAlt {
    pub choice: Choice,
    pub cost: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Choice {
    /// 改成这个时值（音符种类 + 附点数；实心 / 空心随种类走）。
    Duration { ntype: NoteType, dots: u8 },
    /// 删掉（不是音 / 不是休止）。
    Drop,
}

/// 和弦里一个音（或休止）的识别出处：哪个音高（休止为 None）、识别 id、源框。
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct HeadSrc {
    pub pitch: Option<Pitch>,
    pub src: Src,
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
    /// 第几谱表（1 起；钢琴大谱表的左手是 2）。
    #[serde(default)]
    pub staff: u8,
    pub arts: Vec<Art>,
    pub tuplet: Option<Tuplet>,
    #[serde(default)]
    pub lyrics: Vec<Lyric>,
    #[serde(default)]
    pub pre: Vec<Placed>,
    /// 写在音后面的记号（松叶收在小节末、后面没有音可挂的止端）。
    #[serde(default)]
    pub post: Vec<Placed>,
    /// 弧的各端（圆滑线、延音线）。
    #[serde(default)]
    pub spans: Vec<SpanMark>,
    /// 谱面上明印的临时记号（哪个音、升 1 / 降 −1 / 还原 0），写成 `<accidental>`。
    #[serde(default)]
    pub shown: Vec<(Pitch, i8)>,
    /// 各音（休止一条）的识别 id 与源框；写出时 `<note id>` 按音高从这里取。
    #[serde(default)]
    pub src: Vec<HeadSrc>,
    /// 落选候选（花费从小到大）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alts: Vec<EventAlt>,
}

impl Event {
    pub fn new(pitches: Vec<Pitch>, ntype: NoteType, dots: u8, stem_up: Option<bool>) -> Self {
        Event { pitches, ntype, dots, stem_up, onset: 0, voice: 1, staff: 1, arts: Vec::new(), tuplet: None, lyrics: Vec::new(), pre: Vec::new(), post: Vec::new(), spans: Vec::new(), shown: Vec::new(), src: Vec::new(), alts: Vec::new() }
    }

    /// 这个音（休止为 None）的识别出处。
    pub fn src_of(&self, pitch: Option<&Pitch>) -> Src {
        self.src.iter().find(|h| h.pitch.as_ref() == pitch).or_else(|| self.src.first().filter(|_| pitch.is_none())).map_or(Src::default(), |h| h.src)
    }

    pub fn divisions(&self) -> u32 {
        let d = self.ntype.dotted(self.dots);
        self.tuplet.map_or(d, |t| d * t.normal as u32 / (t.actual as u32).max(1))
    }
}

/// 一个小节（一个声部的）。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Measure {
    /// 小节起头印的。
    pub attrs: Attrs,
    /// 其余谱表在小节起头印的谱号（多谱表的声部；`staff` 记第几谱表）。
    #[serde(default)]
    pub staff_attrs: Vec<Attrs>,
    /// 小节中途换的（按谱面次序；现都排在小节内容之前；`staff` 记第几谱表）。
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
    /// 房子从这一小节的左线起 / 到这一小节的右线止。
    #[serde(default)]
    pub ending_start: Option<Ending>,
    #[serde(default)]
    pub ending_stop: Option<Ending>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Part {
    pub measures: Vec<Measure>,
    /// 谱表数（钢琴大谱表 2；0 / 1 都是单谱表）。
    #[serde(default)]
    pub staves: u8,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Score {
    pub title: Option<String>,
    /// 第一页的页眉各条（字号是点）。
    #[serde(default)]
    pub credits: Vec<Credit>,
    pub parts: Vec<Part>,
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// `perc`：现行谱号是打击乐谱号——音写 `<unpitched>`（显示位置），不写 `<pitch>`。
fn write_event(o: &mut String, e: &Event, perc: bool, multi: bool) {
    let dur = e.divisions();
    // `pitch`：和弦里的这一个音（休止为 None）；`first`：和弦的第一个音（记号、歌词只写在它上面，延音线写在连着的那个音上）
    let tail = |o: &mut String, first: bool, pitch: Option<&Pitch>| {
        let ties: Vec<&SpanMark> = e.spans.iter().filter(|s| s.kind == SpanKind::Tied && (s.pitch.as_ref() == pitch || (first && s.pitch.is_none()))).collect();
        let slurs: Vec<&SpanMark> = e.spans.iter().filter(|s| first && s.kind == SpanKind::Slur).collect();
        let _ = writeln!(o, "        <duration>{dur}</duration>");
        // 一个音上先收后起
        for stop in [true, false] {
            for t in ties.iter().filter(|t| t.start != stop) {
                let _ = writeln!(o, "        <tie type=\"{}\"/>", if t.start { "start" } else { "stop" });
            }
        }
        let _ = writeln!(o, "        <voice>{}</voice>\n        <type>{}</type>", e.voice.max(1), e.ntype.xml());
        for _ in 0..e.dots {
            o.push_str("        <dot/>\n");
        }
        if let Some(&(_, a)) = pitch.and_then(|p| e.shown.iter().find(|(q, _)| q == p)) {
            let _ = writeln!(o, "        <accidental>{}</accidental>", match a {
                2 => "double-sharp",
                1 => "sharp",
                -1 => "flat",
                -2 => "flat-flat",
                _ => "natural",
            });
        }
        if let Some(t) = e.tuplet {
            let _ = writeln!(o, "        <time-modification><actual-notes>{}</actual-notes><normal-notes>{}</normal-notes></time-modification>", t.actual, t.normal);
        }
        if let Some(up) = e.stem_up {
            let _ = writeln!(o, "        <stem>{}</stem>", if up { "up" } else { "down" });
        }
        if multi {
            let _ = writeln!(o, "        <staff>{}</staff>", e.staff.max(1));
        }
        let tup = e.tuplet.filter(|t| first && (t.start || t.stop));
        if (first && (!e.arts.is_empty() || tup.is_some())) || !ties.is_empty() || !slurs.is_empty() {
            o.push_str("        <notations>\n");
            for stop in [true, false] {
                for t in ties.iter().filter(|t| t.start != stop) {
                    let _ = writeln!(o, "          <tied type=\"{}\"{}{}/>", if t.start { "start" } else { "stop" }, if t.start { t.src.id_attr() } else { String::new() }, if t.start { if t.above { " orientation=\"over\"" } else { " orientation=\"under\"" } } else { "" });
                }
                for t in slurs.iter().filter(|t| t.start != stop) {
                    let _ = writeln!(o, "          <slur type=\"{}\" number=\"{}\"{}{}/>", if t.start { "start" } else { "stop" }, t.number, if t.start { t.src.id_attr() } else { String::new() }, if t.start { if t.above { " placement=\"above\"" } else { " placement=\"below\"" } } else { "" });
                }
            }
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
                .filter(|_| first)
                .filter_map(|a| match a {
                    Art::Staccato => Some("staccato"),
                    Art::Tenuto => Some("tenuto"),
                    Art::Staccatissimo => Some("staccatissimo"),
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
            if first && e.arts.contains(&Art::Fermata) {
                o.push_str("          <fermata/>\n");
            }
            if first && e.arts.contains(&Art::Arpeggiate) {
                o.push_str("          <arpeggiate/>\n");
            }
            o.push_str("        </notations>\n");
        }
        if first {
            for l in &e.lyrics {
                let _ = writeln!(o, "        <lyric number=\"{}\"{}>\n          <syllabic>{}</syllabic>\n          <text>{}</text>\n        </lyric>", l.number, l.src.id_attr(), l.syllabic.xml(), esc(&l.text));
            }
        }
        o.push_str("      </note>\n");
    };
    if e.pitches.is_empty() {
        let _ = writeln!(o, "      <note{}>\n        <rest/>", e.src_of(None).id_attr());
        tail(o, true, None);
        return;
    }
    for (i, p) in e.pitches.iter().enumerate() {
        let _ = writeln!(o, "      <note{}>", e.src_of(Some(p)).id_attr());
        if i > 0 {
            o.push_str("        <chord/>\n");
        }
        if perc {
            let _ = writeln!(o, "        <unpitched><display-step>{}</display-step><display-octave>{}</display-octave></unpitched>", p.step_name(), p.octave);
            tail(o, i == 0, Some(p));
            continue;
        }
        let _ = write!(o, "        <pitch><step>{}</step>", p.step_name());
        if p.alter != 0 {
            let _ = write!(o, "<alter>{}</alter>", p.alter);
        }
        let _ = writeln!(o, "<octave>{}</octave></pitch>", p.octave);
        tail(o, i == 0, Some(p));
    }
}

/// `staff`：多谱表声部里这条记号属于第几谱表（写 `<staff>`；松叶按谱表编号，两行各开一条时不配串）。
fn write_dir(o: &mut String, pd: &Placed, staff: Option<u8>) {
    let (d, id) = (&pd.dir, pd.src.id_attr());
    let st = staff.map_or(String::new(), |n| format!("        <staff>{n}</staff>\n"));
    let alter = |o: &mut String, tag: &str, a: i8| {
        if a != 0 {
            let _ = write!(o, "<{tag}>{a}</{tag}>");
        }
    };
    let step = |s: u8| ['C', 'D', 'E', 'F', 'G', 'A', 'B'][s as usize % 7];
    match d {
        Dir::Harmony(t) => {
            let Some(c) = chords::parse(t) else { return };
            let _ = write!(o, "      <harmony>\n        <root><root-step>{}</root-step>", step(c.root));
            alter(o, "root-alter", c.root_alter);
            let _ = write!(o, "</root>\n        <kind text=\"{}\">{}</kind>\n", esc(&c.kind), chords::kind_xml(&c.kind));
            if let Some((b, a)) = c.bass {
                let _ = write!(o, "        <bass><bass-step>{}</bass-step>", step(b));
                alter(o, "bass-alter", a);
                o.push_str("</bass>\n");
            }
            o.push_str(&st);
            o.push_str("      </harmony>\n");
        }
        Dir::Words { text, above, jump } => {
            let _ = write!(o, "      <direction placement=\"{}\"{id}>\n        <direction-type>\n          <words>{}</words>\n        </direction-type>\n{st}", if *above { "above" } else { "below" }, esc(text));
            match jump {
                Some(Jump::DalSegno) => o.push_str("        <sound dalsegno=\"segno\"/>\n"),
                Some(Jump::DaCapo) => o.push_str("        <sound dacapo=\"yes\"/>\n"),
                Some(Jump::Fine) => o.push_str("        <sound fine=\"yes\"/>\n"),
                Some(Jump::ToCoda) => o.push_str("        <sound tocoda=\"coda\"/>\n"),
                Some(Jump::Coda) => o.push_str("        <sound coda=\"coda\"/>\n"),
                None => {}
            }
            o.push_str("      </direction>\n");
        }
        Dir::Dynamics(t) => {
            let _ = writeln!(o, "      <direction placement=\"below\"{id}>\n        <direction-type>\n          <dynamics><{t}/></dynamics>\n        </direction-type>\n{st}      </direction>");
        }
        Dir::Wedge(w) => {
            let t = match w {
                Wedge::Crescendo => "crescendo",
                Wedge::Diminuendo => "diminuendo",
                Wedge::Stop => "stop",
            };
            let num = staff.map_or(String::new(), |n| format!(" number=\"{n}\""));
            let _ = writeln!(o, "      <direction placement=\"below\">\n        <direction-type>\n          <wedge type=\"{t}\"{num}/>\n        </direction-type>\n{st}      </direction>");
        }
        Dir::Metronome { per_minute, circa } => {
            let pm = if *circa { format!("c. {per_minute}") } else { per_minute.to_string() };
            let _ = writeln!(o, "      <direction placement=\"above\"{id}>\n        <direction-type>\n          <metronome>\n            <beat-unit>quarter</beat-unit>\n            <per-minute>{pm}</per-minute>\n          </metronome>\n        </direction-type>\n{st}        <sound tempo=\"{per_minute}\"/>\n      </direction>");
        }
    }
}

/// 一个小节的事件按声部写：声部 1 写完 `<backup>` 回小节头再写声部 2；起拍时刻与游标不一致的用 `<forward>` / `<backup>` 挪。
fn write_events(o: &mut String, events: &[Event], perc: bool, multi: bool) {
    let mut cur = 0u32;
    let mut voices: Vec<u8> = events.iter().map(|e| e.voice.max(1)).collect();
    voices.sort_unstable();
    voices.dedup();
    for v in voices {
        let mut es: Vec<&Event> = events.iter().filter(|e| e.voice.max(1) == v).collect();
        es.sort_by_key(|e| e.onset);
        for e in es {
            if e.onset > cur {
                let _ = writeln!(o, "      <forward>\n        <duration>{}</duration>\n      </forward>", e.onset - cur);
            } else if e.onset < cur {
                let _ = writeln!(o, "      <backup>\n        <duration>{}</duration>\n      </backup>", cur - e.onset);
            }
            let staff = multi.then_some(e.staff.max(1));
            for d in &e.pre {
                write_dir(o, d, staff);
            }
            write_event(o, e, perc, multi);
            for d in &e.post {
                write_dir(o, d, staff);
            }
            cur = e.onset + e.divisions();
        }
    }
}

/// 一组 `<attributes>`：`a` 的调号拍号与各谱表的谱号（`more` 是其余谱表的）；`staves` 给了（首小节）写谱表数与花括号。
fn write_attrs(o: &mut String, a: &Attrs, more: &[Attrs], divisions: bool, staves: Option<u8>) {
    if a.is_empty() && more.iter().all(|m| m.clef.is_none()) && !divisions {
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
    if let Some(n) = staves.filter(|&n| n > 1) {
        let _ = writeln!(o, "        <staves>{n}</staves>\n        <part-symbol>brace</part-symbol>");
    }
    for (c, staff) in std::iter::once(a).chain(more).filter_map(|a| a.clef.map(|c| (c, a.staff))) {
        write_clef(o, c, if staves.is_some() || staff > 1 || more.iter().any(|m| m.clef.is_some()) { Some(staff.max(1)) } else { None });
    }
    o.push_str("      </attributes>\n");
}

/// `<clef>`；`number` 给了（多谱表的声部）写 `number`。
fn write_clef(o: &mut String, c: Clef, number: Option<u8>) {
    let sign = match c.sign {
        ClefSign::G => "G",
        ClefSign::F => "F",
        ClefSign::C => "C",
        ClefSign::Percussion => "percussion",
    };
    match number {
        Some(n) => {
            let _ = write!(o, "        <clef number=\"{n}\">");
        }
        None => o.push_str("        <clef>"),
    }
    let _ = write!(o, "<sign>{sign}</sign>");
    if c.sign != ClefSign::Percussion {
        let _ = write!(o, "<line>{}</line>", c.line);
    }
    if c.octave != 0 {
        let _ = write!(o, "<clef-octave-change>{}</clef-octave-change>", c.octave);
    }
    o.push_str("</clef>\n");
}

impl Score {
    /// 写成 MusicXML（partwise 3.1）。
    pub fn to_musicxml(&self) -> String {
        let mut o = String::new();
        o.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE score-partwise PUBLIC \"-//Recordare//DTD MusicXML 3.1 Partwise//EN\" \"http://www.musicxml.org/dtds/partwise.dtd\">\n<score-partwise version=\"3.1\">\n");
        if let Some(t) = &self.title {
            let _ = writeln!(o, "  <work>\n    <work-title>{}</work-title>\n  </work>", esc(t));
        }
        for c in &self.credits {
            let _ = write!(o, "  <credit page=\"1\">\n");
            if let Some(k) = c.kind {
                let _ = writeln!(o, "    <credit-type>{}</credit-type>", k.xml());
            }
            let _ = writeln!(o, "    <credit-words justify=\"{}\" valign=\"bottom\" font-size=\"{}\">{}</credit-words>\n  </credit>", c.justify.xml(), (c.size * 2.0).round() / 2.0, esc(&c.text));
        }
        o.push_str("  <part-list>\n");
        for i in 0..self.parts.len().max(1) {
            let _ = writeln!(o, "    <score-part id=\"P{}\">\n      <part-name print-object=\"no\"/>\n    </score-part>", i + 1);
        }
        o.push_str("  </part-list>\n");
        let empty = Part { measures: vec![Measure::default()], staves: 1 };
        let parts: Vec<&Part> = if self.parts.is_empty() { vec![&empty] } else { self.parts.iter().collect() };
        for (pi, p) in parts.iter().enumerate() {
            let _ = writeln!(o, "  <part id=\"P{}\">", pi + 1);
            let mut perc = false;
            for (mi, m) in p.measures.iter().enumerate() {
                let _ = writeln!(o, "    <measure number=\"{}\"{}>", mi + 1, if m.implicit { " implicit=\"yes\"" } else { "" });
                if mi > 0 && (m.new_system || m.new_page) {
                    let _ = writeln!(o, "      <print {}=\"yes\"/>", if m.new_page { "new-page" } else { "new-system" });
                }
                if m.repeat_start || m.ending_start.is_some() {
                    o.push_str("      <barline location=\"left\">\n");
                    if m.repeat_start {
                        o.push_str("        <bar-style>heavy-light</bar-style>\n");
                    }
                    if let Some(e) = m.ending_start {
                        let _ = writeln!(o, "        <ending number=\"{0}\" type=\"start\">{0}.</ending>", e.number);
                    }
                    if m.repeat_start {
                        o.push_str("        <repeat direction=\"forward\"/>\n");
                    }
                    o.push_str("      </barline>\n");
                }
                let multi = p.staves > 1;
                write_attrs(&mut o, &m.attrs, &m.staff_attrs, mi == 0, (mi == 0 && multi).then_some(p.staves));
                for a in &m.mid {
                    write_attrs(&mut o, a, &[], false, None);
                }
                if let Some(c) = std::iter::once(&m.attrs).chain(&m.mid).filter_map(|a| a.clef).last() {
                    perc = c.sign == ClefSign::Percussion;
                }
                write_events(&mut o, &m.events, perc, multi);
                if m.right.is_some() || m.repeat_end || m.ending_stop.is_some() {
                    o.push_str("      <barline location=\"right\">\n");
                    if m.right.is_some() || m.repeat_end {
                        let _ = writeln!(o, "        <bar-style>{}</bar-style>", m.right.unwrap_or(BarStyle::LightHeavy).xml());
                    }
                    if let Some(e) = m.ending_stop {
                        let _ = writeln!(o, "        <ending number=\"{}\" type=\"{}\"/>", e.number, if e.closed { "stop" } else { "discontinue" });
                    }
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
    use crate::result::{Rid, RidKind, Src};

    #[test]
    fn skeleton_xml() {
        let mut m1 = Measure { attrs: Attrs { clef: Some(Clef::TREBLE_8VB), key: Some(Key { fifths: -2 }), time: Some(Time { beats: 4, beat_type: 4, symbol: TimeSymbol::Common }), staff: 0 }, ..Default::default() };
        m1.right = Some(BarStyle::LightLight);
        let m2 = Measure { repeat_end: true, new_system: true, ..Default::default() };
        let x = Score { title: Some("a<b".into()), credits: vec![], parts: vec![Part { measures: vec![m1, m2], staves: 1 }] }.to_musicxml();
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
        low.lyrics.push(Lyric { number: 2, text: "1.道".into(), syllabic: Syllabic::Single, src: Src { rid: Some(Rid { kind: RidKind::Lyric, n: 4 }), at: None } });
        low.src.push(HeadSrc { pitch: Some(Pitch { step: 0, octave: 3, alter: 0 }), src: Src { rid: Some(Rid { kind: RidKind::Note, n: 7 }), at: None } });
        low.pre.push(Dir::Harmony("F#m7/C#".into()).into());
        low.pre.push(Placed { dir: Dir::Dynamics("mf".into()), src: Src { rid: Some(Rid { kind: RidKind::Dynamics, n: 1 }), at: None } });
        let mut tri = Event::new(vec![], NoteType::Eighth, 0, None);
        tri.onset = 36;
        tri.tuplet = Some(Tuplet { actual: 3, normal: 2, start: true, stop: false });
        assert_eq!(tri.divisions(), 8);
        let x = Score { title: None, credits: vec![], parts: vec![Part { measures: vec![Measure { events: vec![e, low, tri], ..Default::default() }], staves: 1 }] }.to_musicxml();
        assert!(x.contains("<backup>\n        <duration>44</duration>") && x.contains("<voice>2</voice>") && x.contains("<fermata/>"));
        assert!(x.contains("<note id=\"omr7\">") && x.contains("<direction placement=\"below\" id=\"omrD1\">"));
        assert!(x.contains("<lyric number=\"2\" id=\"omrL4\">") && x.contains("<text>1.道</text>") && x.contains("<kind text=\"m7\">minor-seventh</kind>") && x.contains("<bass-alter>1</bass-alter>") && x.contains("<dynamics><mf/></dynamics>"));
        assert!(x.contains("<actual-notes>3</actual-notes>") && x.contains("<tuplet type=\"start\" number=\"1\"/>"));
        assert!(x.contains("<pitch><step>C</step><alter>1</alter><octave>4</octave></pitch>"));
        assert!(x.contains("<chord/>\n        <pitch><step>E</step><octave>4</octave></pitch>"));
        assert!(x.contains("<duration>36</duration>") && x.contains("<dot/>") && x.contains("<stem>up</stem>"));
    }

    #[test]
    fn spans_xml() {
        let (c, e4) = (Pitch { step: 0, octave: 4, alter: 0 }, Pitch { step: 2, octave: 4, alter: 0 });
        let mut a = Event::new(vec![c, e4], NoteType::Quarter, 0, Some(true));
        a.spans.push(SpanMark { kind: SpanKind::Tied, start: true, number: 1, above: true, pitch: Some(e4), src: Src::default() });
        a.spans.push(SpanMark { kind: SpanKind::Slur, start: true, number: 2, above: false, pitch: None, src: Src::default() });
        a.pre.push(Dir::Wedge(Wedge::Crescendo).into());
        let mut b = Event::new(vec![e4], NoteType::Quarter, 0, Some(true));
        b.onset = 24;
        b.spans.push(SpanMark { kind: SpanKind::Tied, start: false, number: 1, above: true, pitch: Some(e4), src: Src::default() });
        b.spans.push(SpanMark { kind: SpanKind::Slur, start: false, number: 2, above: false, pitch: None, src: Src::default() });
        b.post.push(Dir::Wedge(Wedge::Stop).into());
        let m = Measure { events: vec![a, b], ending_start: Some(Ending { number: 1, closed: true }), ending_stop: Some(Ending { number: 1, closed: true }), repeat_end: true, ..Default::default() };
        let x = Score { title: None, credits: vec![], parts: vec![Part { measures: vec![m], staves: 1 }] }.to_musicxml();
        // 延音线记在 E 上、不在和弦的第一个音上；圆滑线记在第一个音上
        let first = &x[x.find("<step>C</step>").unwrap()..x.find("<step>E</step>").unwrap()];
        assert!(!first.contains("<tie ") && first.contains("<slur type=\"start\" number=\"2\" placement=\"below\"/>"));
        assert!(x.contains("<tie type=\"start\"/>") && x.contains("<tied type=\"start\" orientation=\"over\"/>") && x.contains("<tied type=\"stop\"/>") && x.contains("<slur type=\"stop\" number=\"2\"/>"));
        assert!(x.contains("<wedge type=\"crescendo\"/>") && x.find("<wedge type=\"stop\"/>").unwrap() > x.rfind("</note>").unwrap());
        assert!(x.contains("<ending number=\"1\" type=\"start\">1.</ending>") && x.contains("<ending number=\"1\" type=\"stop\"/>") && x.contains("<repeat direction=\"backward\"/>"));
    }
}
