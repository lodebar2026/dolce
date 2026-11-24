//! 五线谱识别结果模型（整曲）：声部、小节、谱号 / 调号 / 拍号、小节线样式与反复、分行分页、音与记号、歌词、弧。
//! 建 `ScoreDoc`、写 MusicXML 在 `omr-todoc::staff`（经唯一写出端 `dolce-model::toxml`）。
use crate::music::{BarStyle, Clef, Key, Pitch, Time};
use crate::result::Src;
use dolce_omr_text::header::Credit;
use dolce_omr_text::lyrics::Syllabic;
use dolce_omr_text::words::Jump;
use serde::{Deserialize, Serialize};

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
    /// 挂在前面的倚音（自左而右；写出成带斜杠的小音符）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub graces: Vec<Pitch>,
}

impl Event {
    pub fn new(pitches: Vec<Pitch>, ntype: NoteType, dots: u8, stem_up: Option<bool>) -> Self {
        Event { pitches, ntype, dots, stem_up, onset: 0, voice: 1, staff: 1, arts: Vec::new(), tuplet: None, lyrics: Vec::new(), pre: Vec::new(), post: Vec::new(), spans: Vec::new(), shown: Vec::new(), src: Vec::new(), alts: Vec::new(), graces: Vec::new() }
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
