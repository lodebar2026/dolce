//! 原样文档布局的定位结构（照 `place/model.ts`）：排版行视图 → 各符号、记号、声部、谱组、页的位置。只有数据。
//!
//! 与 TS 的出入只在身份：TS 按对象引用认元素（`PlacedItem.element`、`PlacedText.el`、`PlacedMark.startEl/endEl`、`idOf` 表），
//! 这里元素是克隆（换了样子的小节线本来也是新对象），身份另存——`PlacedItem.id`（TS `idOf.get(element)`）、
//! `PlacedText.at`（挂在本声部 / 本层 `items` 的第几个）、`PlacedMark.start_id/end_id`。

use std::rc::Rc;

use dolce_geom::Rect;
use dolce_view::ast::{InlineLayerElement, LyricSyllable, Mark, MusicElement, ScoreLine};

use crate::grid::JianpuGrid;
use crate::view::{LGroup, LRow};

/// 挂在符号上的一个歌词音节（连同它的归属音 id，TS `syllableOwner`）
#[derive(Clone, Debug, PartialEq)]
pub struct Syl {
    pub syl: LyricSyllable,
    pub owner: Option<i64>,
}

/// 一个占位的谱面符号（音符 / 增时线 / 小节线）
#[derive(Clone, Debug)]
pub struct PlacedItem {
    /// 占位序号（只数音符/增时线/小节线）
    pub index: usize,
    /// 在 voice.elements 里的下标（补的行首线为 −1）
    pub src_index: i64,
    /// 锚点 x（行坐标系）
    pub x: f64,
    /// 自然宽度
    pub advance: f64,
    pub element: MusicElement,
    /// 元素 id（TS `idOf.get(element)`；换了样子 / 补出来的小节线没有）
    pub id: Option<i64>,
    pub beat: f64,
    pub beats: f64,
    /// 逐段一个（缺段为 None）
    pub syllables: Vec<Option<Syl>>,
    /// `{dsb}` 并排块里主旋律下移
    pub dy: Option<f64>,
    /// 小节线不画（占位照旧）
    pub no_barline: bool,
}

/// 一条跨若干符号的记号，已换算成行内坐标
#[derive(Clone, Debug)]
pub struct PlacedMark {
    pub dy: Option<f64>,
    pub mark: Mark,
    pub x0: f64,
    pub x1: f64,
    /// 纵向落点（相对音符基线，负为上）
    pub y: Option<f64>,
    pub flat: bool,
    pub below: bool,
    pub level: f64,
    pub open_left: bool,
    pub open_right: bool,
    /// 两端落在哪两个符号上（TS `startEl/endEl` 经 `idOf` 认的 id）；`has_ends` 为 TS 有没有设 startEl/endEl
    pub has_ends: bool,
    pub start_id: Option<i64>,
    pub end_id: Option<i64>,
}

/// 临时伴奏 `{bz}` / 临时多声部 `{dsb}`（并排块）
#[derive(Clone, Debug)]
pub struct PlacedLayer {
    /// 内联层在 voice.elements 里的下标
    pub at: usize,
    pub layer: InlineLayerElement,
    pub items: Vec<PlacedItem>,
    pub underlines: Vec<PlacedUnderline>,
    pub split: Option<PlacedSplit>,
    /// `{bz}` 小字号行的数字墨迹中线（相对主旋律基线）
    pub y: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct PlacedSplit {
    pub dy: f64,
    pub line: ScoreLine,
    pub marks: Vec<PlacedMark>,
    pub brace_left_x: Option<f64>,
    pub brace_right_x: Option<f64>,
    pub brace_top: f64,
    pub brace_bottom: f64,
    /// 上行自己的上方带（`at` 指本层 `items`）
    pub band: Option<Vec<PlacedText>>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlacedUnderline {
    pub level: f64,
    pub x0: f64,
    pub x1: f64,
    pub dy: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct PlacedVoice {
    pub voice: Rc<LRow>,
    /// 音符基线 y（页坐标系）
    pub y: f64,
    pub items: Vec<PlacedItem>,
    pub underlines: Vec<PlacedUnderline>,
    pub marks: Vec<PlacedMark>,
    pub layers: Vec<PlacedLayer>,
    /// 各段歌词的基线 y
    pub lyric_y: Vec<f64>,
    /// 上方带（`at` 指本声部 `items`）
    pub band: Vec<PlacedText>,
    pub top: f64,
    pub text_top: Option<f64>,
    pub bottom: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextKind {
    Chord,
    SectionWord,
    KeyLabel,
    Direction,
    Artic,
}

impl TextKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TextKind::Chord => "chord",
            TextKind::SectionWord => "section-word",
            TextKind::KeyLabel => "key-label",
            TextKind::Direction => "direction",
            TextKind::Artic => "artic",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Face {
    Music,
    Text,
    Lyric,
}

impl Face {
    pub fn as_str(self) -> &'static str {
        match self {
            Face::Music => "music",
            Face::Text => "text",
            Face::Lyric => "lyric",
        }
    }
}

/// 上方带里的一件
#[derive(Clone, Debug)]
pub struct PlacedText {
    pub kind: TextKind,
    /// 挂在哪个符号上：所在 `items` 的下标（TS `el`）
    pub at: usize,
    pub text: String,
    pub face: Face,
    pub size: f64,
    pub x: f64,
    pub y: f64,
    pub ink: Rect,
    /// 逐字笔位（段落词）
    pub xs: Option<Vec<f64>>,
    pub boxed: bool,
    pub bold: bool,
}

#[derive(Clone, Debug)]
pub struct PlacedGroup {
    pub group: Rc<LGroup>,
    pub voices: Vec<PlacedVoice>,
    pub text_y: f64,
    pub brace_top: f64,
    pub brace_bottom: f64,
    pub has_brace: bool,
    pub brace_from_x: Option<f64>,
    pub song: usize,
}

#[derive(Clone, Debug, Default)]
pub struct PlacedPage {
    pub groups: Vec<PlacedGroup>,
    pub song: usize,
    pub first_of_song: bool,
    /// 连续长图把多首接成一页时，后面各首的页眉整块下移多少
    pub headers: Option<Vec<(usize, f64)>>,
    pub title_page: bool,
    pub natural: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct PlacedScore {
    pub pages: Vec<PlacedPage>,
    pub metrics: JianpuGrid,
    pub content_bottom: f64,
    pub content_right: f64,
}

/// 一个音节画出来的那串的横向度量
#[derive(Clone, Debug, PartialEq)]
pub struct LyricRun {
    pub text: String,
    pub width: f64,
    pub lead: f64,
    pub body: f64,
    pub head_blank: f64,
    pub tail_blank: f64,
}

/// 上方带里各种字的角色
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum InkTextRole {
    SectionWord,
    Term,
    Jump,
    KeyLabel,
    Ending,
    Words,
}

/// `{advance, ink}`
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct InkBox {
    pub advance: f64,
    pub ink: Rect,
}
