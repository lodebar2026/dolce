//! 五线谱引擎（混排）的**版面态**（照 `src/mixed/model.ts`，原本从 musicpp model/model.hpp + model.cpp 移植）。
//! 单位：tenths（五线谱高 40，线距 10），y 向下，五线谱顶线 y=0。
//! 水平位置信任 MusicXML 内嵌版面（default-x / measure width），没有时走自动版面（`pass`）。
//!
//! **这里不是模型**：根对象 [`StaffLayout`] 与各版面节点只存引擎自己算出来的东西
//! （坐标、符干、符杠、系统与页、按 tick 查的谱号/调号/拍号索引），语义经各节点的 `src` 从 `ScoreDoc` 取。
//!
//! TS 的对象引用全换成下标（见 crate 文档）：节点放在 [`StaffLayout`] 的各张表里，`sl[id]` 取节点；
//! 节点自己答得了的写成节点方法，要顺着父指针、别的表去查的写成 `StaffLayout::{节点}_{方法}`。

// 照 TS 的写法（先声明后分支赋值、按下标走谱表），便于逐行对照
#![allow(clippy::needless_late_init, clippy::needless_range_loop)]

mod arc;
mod beam;
mod chord;
mod entry;
mod measure;
mod part;
mod sys;
mod text;

pub use arc::*;
pub use beam::*;
pub use chord::*;
pub use entry::*;
pub use measure::*;
pub use part::*;
pub use sys::*;
pub use text::*;

use dolce_base::fraction::Fraction;
use dolce_base::js;
use dolce_model::doc::Song;
use dolce_model::xmlsurface::Surface;
use dolce_scene::build::Env;
use dolce_scene::smufl::{GlyphBBox, MetaData};
use dolce_style::staff::MixedOptions;
use dolce_text::{Font, MeasureCtx};

// ───────────────────────── 字形与小工具 ─────────────────────────

/// SMuFL 字形名 → 码位（`GlyphCodes.xxx`）。名字写错是编程错误，panic。
pub fn gc(name: &str) -> char {
    dolce_scene::smufl::glyph_code(name).unwrap_or_else(|| panic!("没有这个 SMuFL 字形名：{name}"))
}

/// SMuFL 字形名 → 一个字的串。
pub fn gs(name: &str) -> String {
    gc(name).to_string()
}

/// 串是不是恰好这一个字形。
pub fn is_glyph(s: &str, name: &str) -> bool {
    let mut it = s.chars();
    matches!((it.next(), it.next()), (Some(c), None) if c == gc(name))
}

/// `meta.getBBox(glyph)`：串整个当一个码位查（多字、空串 TS 抛错，这里 panic，同一句话）。
pub fn get_bbox<'m>(meta: &'m MetaData, glyph: &str) -> Option<&'m GlyphBBox> {
    let mut it = glyph.chars();
    match (it.next(), it.next()) {
        (Some(c), None) => meta.bbox(c).unwrap_or_else(|e| panic!("{e}")),
        (Some(c), Some(_)) => panic!("{}", dolce_scene::smufl::UnknownGlyph(c)),
        (None, _) => panic!("unknown smufl glyph: NaN"),
    }
}

/// `meta.getAnchor(glyph)`：认不得给 None（TS 不抛）。
pub fn get_anchor<'m>(meta: &'m MetaData, glyph: &str) -> Option<&'m dolce_scene::smufl::GlyphAnchor> {
    let mut it = glyph.chars();
    match (it.next(), it.next()) {
        (Some(c), None) => meta.anchor(c),
        _ => None,
    }
}

/// JS 比较函数的回值 → 排序（`a - b` 一类，NaN 当相等）。
pub fn cmp_num(d: f64) -> std::cmp::Ordering {
    js::ordering(d)
}

/// `Math.max(...xs)`（空 = -Infinity）。
pub fn js_max_of(xs: impl IntoIterator<Item = f64>) -> f64 {
    xs.into_iter().fold(f64::NEG_INFINITY, js::max)
}

/// `Math.min(...xs)`（空 = Infinity）。
pub fn js_min_of(xs: impl IntoIterator<Item = f64>) -> f64 {
    xs.into_iter().fold(f64::INFINITY, js::min)
}

// ───────────────────────── 时值 ─────────────────────────

/// `STEP_CHROMATIC`
pub fn step_chromatic(step: &str) -> Option<f64> {
    Some(match step {
        "C" => 0.0,
        "D" => 2.0,
        "E" => 4.0,
        "F" => 5.0,
        "G" => 7.0,
        "A" => 9.0,
        "B" => 11.0,
        _ => return None,
    })
}

/// noteType 以四分音符为单位（musicpp parser.cpp:625-665）：quarter=1、whole=4、eighth=1/2…（`NOTE_TYPE_MAP`；认不得 = 1）
pub fn note_type_fraction(type_name: &str) -> Fraction {
    match type_name {
        "1024th" => Fraction::new(1.0, 256.0),
        "512th" => Fraction::new(1.0, 128.0),
        "256th" => Fraction::new(1.0, 64.0),
        "128th" => Fraction::new(1.0, 32.0),
        "64th" => Fraction::new(1.0, 16.0),
        "32nd" => Fraction::new(1.0, 8.0),
        "16th" => Fraction::new(1.0, 4.0),
        "eighth" => Fraction::new(1.0, 2.0),
        "quarter" => Fraction::int(1.0),
        "half" => Fraction::int(2.0),
        "whole" => Fraction::int(4.0),
        "breve" => Fraction::int(8.0),
        "long" => Fraction::int(16.0),
        _ => Fraction::int(1.0),
    }
}

// ---------------- Fraction helpers (boost::rational 比较语义) ----------------

pub fn f_lt(a: &Fraction, b: &Fraction) -> bool {
    a.compare_to(b) < 0
}
pub fn f_le(a: &Fraction, b: &Fraction) -> bool {
    a.compare_to(b) <= 0
}
pub fn f_gt(a: &Fraction, b: &Fraction) -> bool {
    a.compare_to(b) > 0
}
pub fn f_ge(a: &Fraction, b: &Fraction) -> bool {
    a.compare_to(b) >= 0
}
pub fn f_eq(a: &Fraction, b: &Fraction) -> bool {
    a.compare_to(b) == 0
}

/// `Fraction.toString()`（Map 的键）。
pub fn frac_key(f: &Fraction) -> String {
    f.to_string()
}

#[derive(Clone, Debug)]
pub struct TickEntry<T> {
    pub t: Fraction,
    pub v: T,
}

/// map<rational,T>：按 Fraction 排序的 map，getAt = upper_bound 前驱（floor 查找）。
#[derive(Clone, Debug)]
pub struct TickMap<T> {
    pub entries: Vec<TickEntry<T>>,
}

impl<T> Default for TickMap<T> {
    fn default() -> Self {
        TickMap { entries: Vec::new() }
    }
}

impl<T> TickMap<T> {
    pub fn set(&mut self, t: Fraction, v: T) {
        let (mut lo, mut hi) = (0usize, self.entries.len());
        while lo < hi {
            let mid = (lo + hi) >> 1;
            if self.entries[mid].t.compare_to(&t) < 0 {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo < self.entries.len() && f_eq(&self.entries[lo].t, &t) {
            self.entries[lo].v = v;
        } else {
            self.entries.insert(lo, TickEntry { t, v });
        }
    }

    /// 最后一个 key<=t 的值（map::upper_bound 后 --it）。空表/全大于 t 时返回 None。
    pub fn get_at(&self, t: &Fraction) -> Option<&T> {
        let mut res = None;
        for e in &self.entries {
            if e.t.compare_to(t) > 0 {
                break;
            }
            res = Some(&e.v);
        }
        res
    }

    /// 是否存在恰好等于 t 的 key（Staff::keyChange 等）。
    pub fn change_at(&self, t: &Fraction) -> bool {
        self.entries.iter().any(|e| f_eq(&e.t, t))
    }

    pub fn size(&self) -> usize {
        self.entries.len()
    }
    pub fn last(&self) -> Option<&TickEntry<T>> {
        self.entries.last()
    }
}

// ---------------- 谱号/调号/拍号/记谱法 ----------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Notation {
    #[default]
    Normal,
    Shape,
    JianPu,
    Mixed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClefSig {
    /// SMuFL 字形（一个字）
    pub sign: String,
    /// 谱号落在第几线（下起）。缺省是高音谱号的第二线——没写谱号的谱（`.jpwabc`、文本谱转来的）
    /// 落到 `getClef` 的缺省值上，原先给 0，谱号整个往下掉两格（061《坚固保障》混排）。
    pub line: f64,
}

impl Default for ClefSig {
    fn default() -> Self {
        ClefSig { sign: gs("gClef"), line: 2.0 }
    }
}

impl ClefSig {
    /// 顶线（第五线）的 writtenPitch（octave*7+step 序数）。G 谱号顶线 F5=38。
    pub fn top_pitch(&self) -> f64 {
        let s = self.sign.as_str();
        if is_glyph(s, "unpitchedPercussionClef1") || is_glyph(s, "gClef") {
            38.0
        } else if is_glyph(s, "gClef8vb") {
            31.0
        } else if is_glyph(s, "fClef") {
            26.0
        } else if is_glyph(s, "cClef") {
            32.0
        } else if is_glyph(s, "sixStringTabClef") {
            38.0
        } else {
            // TS console.error("unknown clef sign")
            38.0
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct KeySig {
    pub fifths: f64,
    pub cancel: f64,
}

/// model.cpp::accidentalSym — acc 取 -1/0/1，csym 时用小号字形。
pub fn accidental_sym(acc: f64, csym: bool) -> String {
    if csym {
        if acc == 1.0 {
            return gs("csymAccidentalSharp");
        }
        if acc == -1.0 {
            return gs("csymAccidentalFlat");
        }
        return gs("csymAccidentalNatural");
    }
    if acc == 1.0 {
        return gs("accidentalSharp");
    }
    if acc == -1.0 {
        return gs("accidentalFlat");
    }
    gs("accidentalNatural")
}

#[derive(Clone, Debug, PartialEq)]
pub struct TimeSig {
    pub beats: f64,
    pub beat_type: f64,
    pub symbol: bool,
}

impl Default for TimeSig {
    fn default() -> Self {
        TimeSig { beats: 4.0, beat_type: 4.0, symbol: false }
    }
}

/// `String(t)` 的每个数字换成从 `zero` 起的字形（`TimeSig.makeNumber` / `Tuplet.makeNumber`）。
/// 非数字字符（`-`、`.`）照 TS 的 `zero + code − 48` 算（落到别的码位上）。
pub fn glyph_digits(zero: char, t: f64) -> String {
    let z = zero as u32 as i64;
    js::num_to_string(t)
        .chars()
        .map(|c| {
            let cp = z + c as u32 as i64 - 48;
            // String.fromCharCode：按 16 位截
            let u = (cp as u32) & 0xffff;
            char::from_u32(u).unwrap_or('\u{fffd}')
        })
        .collect()
}

impl TimeSig {
    pub fn make_number(t: f64) -> String {
        glyph_digits(gc("timeSig0"), t)
    }
    pub fn width(fm: &MetaData, t: f64) -> f64 {
        let mut res = 0.0;
        for g in TimeSig::make_number(t).chars() {
            res += smufl_width(fm, &g.to_string());
        }
        res
    }
}

// ---------------- SMuFL 度量（FontMeta，metadata 单位×10 转 tenths） ----------------

pub fn smufl_width(fm: &MetaData, glyph: &str) -> f64 {
    match get_bbox(fm, glyph) {
        None => 0.0,
        Some(b) => (b.ne[0] - b.sw[0]) * 10.0,
    }
}
pub fn smufl_top(fm: &MetaData, glyph: &str) -> f64 {
    get_bbox(fm, glyph).map_or(0.0, |b| b.ne[1] * 10.0)
}
pub fn smufl_bottom(fm: &MetaData, glyph: &str) -> f64 {
    get_bbox(fm, glyph).map_or(0.0, |b| b.sw[1] * 10.0)
}

/// 各行视觉高度（用于 getYBound 的垂直延伸估算）：音乐字形按真实包围盒
/// （smuflTop/Bottom 以 em=musicEm 为基准，再按字号缩放），文本按字体 ascent/descent。
/// 修正 TextBlock.height() 用 Bravura 字体度量导致力度/节拍记号虚高、撑大谱表间距的问题。
pub fn tight_line_heights(t: &TextBlock, meta: &MetaData, mc: &MeasureCtx, music_em: f64, text_by_size: bool) -> Vec<f64> {
    let mut h = Vec::new();
    let mut line_h = 0.0;
    for it in &t.data {
        if it.text == "\n" {
            h.push(line_h);
            line_h = 0.0;
            continue;
        }
        let ih;
        if text_by_size {
            // 歌本口径：行高按字号（原排版程序 Font::height() 就是字号，model.cpp TextBlock::height），记号也一样。
            // 字体 ascent−descent 约 1.45 个字号，按它算多行文字块会虚高
            ih = it.nominal_size.unwrap_or(it.font.size);
        } else if it.music {
            let mut gh: f64 = 0.0;
            for ch in it.text.chars() {
                let s = ch.to_string();
                gh = js::max(gh, smufl_top(meta, &s) - smufl_bottom(meta, &s));
            }
            ih = gh * if music_em > 0.0 { it.font.size / music_em } else { 1.0 };
        } else {
            let fm = it.font.metrics(mc);
            ih = fm.descent - fm.ascent;
        }
        if ih > line_h {
            line_h = ih;
        }
    }
    if line_h > 0.0 {
        h.push(line_h);
    }
    h
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct XY {
    pub x: f64,
    pub y: f64,
}

/// 挖角锚点（`cutOutNE` / `cutOutNW` / `cutOutSE` / `cutOutSW`），×10 转 tenths。
pub fn smufl_cut_out(fm: &MetaData, glyph: &str, which: &str) -> Option<XY> {
    let an = get_anchor(fm, glyph)?;
    let pt = an.get(which)?;
    Some(XY { x: pt[0] * 10.0, y: pt[1] * 10.0 })
}

// ---------------- Staff（per-staff 谱号/调号/拍号/记谱法时间线） ----------------

#[derive(Clone, Debug)]
pub struct PartStaff {
    pub part: PartId,
    pub sub_index: usize,
    pub order: usize,
    pub key: TickMap<KeySig>,
    pub clef: TickMap<ClefSig>,
    pub time: TickMap<TimeSig>,
    pub notation: TickMap<Notation>,
}

impl PartStaff {
    pub fn new(part: PartId, sub_index: usize) -> PartStaff {
        let mut notation = TickMap::default();
        notation.set(Fraction::int(0.0), Notation::Normal);
        PartStaff { part, sub_index, order: 0, key: TickMap::default(), clef: TickMap::default(), time: TickMap::default(), notation }
    }
    pub fn get_top_pitch(&self, t: &Fraction) -> f64 {
        self.get_clef(t).top_pitch()
    }
    pub fn get_clef(&self, t: &Fraction) -> ClefSig {
        self.clef.get_at(t).cloned().unwrap_or_default()
    }
    pub fn get_key(&self, t: &Fraction) -> KeySig {
        self.key.get_at(t).cloned().unwrap_or_default()
    }
    pub fn get_time(&self, t: &Fraction) -> TimeSig {
        self.time.get_at(t).cloned().unwrap_or_default()
    }
    pub fn get_notation(&self, t: &Fraction) -> Notation {
        self.notation.get_at(t).copied().unwrap_or(Notation::Normal)
    }
    pub fn clef_change(&self, t: &Fraction) -> bool {
        self.clef.change_at(t)
    }
    pub fn key_change(&self, t: &Fraction) -> bool {
        self.key.change_at(t)
    }
    pub fn time_change(&self, t: &Fraction) -> bool {
        self.time.change_at(t)
    }
}

/// 谱表的身份（TS 里直接拿 `PartStaff` 对象）：所属声部与声部内第几行谱。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct PsRef {
    pub part: PartId,
    pub sub: usize,
}

// ───────────────────────── 下标 ─────────────────────────

macro_rules! ids {
    ($($(#[$m:meta])* $name:ident => $field:ident : $ty:ty;)*) => {
        $(
            $(#[$m])*
            #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
            pub struct $name(pub usize);

            impl<'d> std::ops::Index<$name> for StaffLayout<'d> {
                type Output = $ty;
                fn index(&self, i: $name) -> &Self::Output {
                    &self.$field[i.0]
                }
            }
            impl<'d> std::ops::IndexMut<$name> for StaffLayout<'d> {
                fn index_mut(&mut self, i: $name) -> &mut Self::Output {
                    &mut self.$field[i.0]
                }
            }
        )*
    };
}

ids! {
    /// 声部（`PartLayout`）
    PartId => parts: PartLayout;
    /// 全局小节（`MeasureLayout`）
    MeasId => measures: MeasureLayout;
    /// 声部内一小节（`PartMeasureLayout`）
    PmId => part_measures: PartMeasureLayout;
    ChordId => chords: ChordLayout<'d>;
    NoteId => notes: NoteLayout<'d>;
    EntryId => entries: NoteEntry;
    LyricId => lyrics: LyricLayout<'d>;
    HarmId => harmonies: HarmonyLayout<'d>;
    /// 小节文字块（`MeasureText`）
    TextId => texts: MeasureText<'d>;
    BeamId => beams: BeamGroup;
    SysId => systems: Sys;
    PageId => pages: MPage;
    SlurId => slurs: Slur<'d>;
    TiedId => tieds: Tied;
    TupletId => tuplets: Tuplet;
    EndingId => endings: Ending;
    WedgeId => wedges: Wedge;
    PedalId => pedal_lines: PedalLine;
    OctaveId => octave_lines: OctaveLine;
    ArpegId => arpeggiates: Arpeggiate;
    LrcExtId => lrc_extends: LrcExtend;
}

// ---------------- 选项 / Defaults / Score ----------------

/// MusicXML 生态惯用的 `<scaling>`：7mm 对 40 tenths，折成 pt / tenths。
pub const DEFAULT_SCALING: f64 = (7.0 * 72.0) / 25.4 / 40.0;

pub use dolce_style::staff::JP_FONT_FAMILY;

#[derive(Clone, Debug, PartialEq)]
pub struct MixedDefaults {
    pub page_width: f64,
    pub page_height: f64,
    pub left_margin: f64,
    pub right_margin: f64,
    pub top_margin: f64,
    pub bottom_margin: f64,
    pub word_font: Font,
    /// 谱里给了 `<defaults><word-font font-size>`：没写字号的 `<words>` 照它（不然按 16pt）
    pub word_font_given: bool,
    pub lyric_font: Font,
    pub music_text_font: Font,
}

impl Default for MixedDefaults {
    fn default() -> Self {
        MixedDefaults {
            page_width: 1200.0,
            page_height: 1697.0,
            left_margin: 85.0,
            right_margin: 85.0,
            top_margin: 85.0,
            bottom_margin: 85.0,
            word_font: Font::new("Times New Roman", 20.0),
            word_font_given: false,
            lyric_font: Font::new("Times New Roman", 20.0),
            music_text_font: Font::new("Bravura Text", 20.0),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoder {
    Unknown,
    Sibelius,
    Finale,
    MuseScore,
    /// 本应用的写出端（`model/toxml.ts`，文本格式派生与导出的 MusicXML）
    Dolce,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ScoreCredit {
    pub page: f64,
    pub text: String,
    pub r#type: Option<String>,
    pub x: f64,
    pub y: f64,
    pub justify: Lcr,
    pub font_size: f64,
    /// `<credit-words font-family / font-weight>`；没写就是歌词字体
    pub family: Option<String>,
    pub bold: Option<bool>,
    /// `default-y` 是字顶 / 中线 / 底（缺省是基线）：`top` / `middle` / `bottom`
    pub valign: Option<String>,
}

/// 页面文字（`PageText extends TextBlock`）。
pub type PageText = TextBlock;

#[derive(Clone, Debug, Default)]
pub struct MPage {
    pub width: f64,
    pub height: f64,
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
    pub systems: Vec<SysId>,
    pub texts: Vec<PageText>,
}

impl MPage {
    pub fn new_text(&mut self) -> &mut PageText {
        self.texts.push(TextBlock::default());
        self.texts.last_mut().expect("刚放进去")
    }
}

/// 根对象（TS `StaffLayout`）。各张表见 `ids!`；`parts` / `measures` / `systems` 的次序就是谱面次序。
pub struct StaffLayout<'d> {
    /// `ScoreDoc` 里对应的曲子
    pub song: &'d Song,
    /// MusicXML 表层（读 MusicXML 来的谱才有）：按 `oid` 问原文属性
    pub surface: Option<&'d Surface>,
    /// SMuFL 元数据（TS `options.meta`）
    pub meta: &'d MetaData,
    /// 量字
    pub mc: &'d MeasureCtx<'d>,
    /// 题下经文（及出处），自动铺排的页眉排在标题下（`autoLayoutHeader`）
    pub scripture: Vec<String>,
    /// 版面单位换算：pt / tenths（`<scaling>` 算出）。没写 `<scaling>` 取 MusicXML 惯用的 7mm/40tenths
    pub scaling: f64,

    pub parts: Vec<PartLayout>,
    pub measures: Vec<MeasureLayout>,
    pub part_measures: Vec<PartMeasureLayout>,
    pub chords: Vec<ChordLayout<'d>>,
    pub notes: Vec<NoteLayout<'d>>,
    pub entries: Vec<NoteEntry>,
    pub lyrics: Vec<LyricLayout<'d>>,
    pub harmonies: Vec<HarmonyLayout<'d>>,
    pub texts: Vec<MeasureText<'d>>,
    pub beams: Vec<BeamGroup>,
    pub systems: Vec<Sys>,
    pub pages: Vec<MPage>,
    pub slurs: Vec<Slur<'d>>,
    pub tieds: Vec<Tied>,
    pub tuplets: Vec<Tuplet>,
    pub endings: Vec<Ending>,
    pub wedges: Vec<Wedge>,
    pub pedal_lines: Vec<PedalLine>,
    pub octave_lines: Vec<OctaveLine>,
    pub arpeggiates: Vec<Arpeggiate>,
    pub lrc_extends: Vec<LrcExtend>,
    pub part_groups: Vec<PartGroup>,

    pub options: MixedOptions,
    /// 页面与字体缺省值（tenths）
    pub defaults: MixedDefaults,
    /// 排好的标题块（原谱没有坐标时由 `autoLayoutHeader` 重排）
    pub credits: Vec<ScoreCredit>,
    /// 原谱不带版面坐标、由 `pass` 自动铺排（文本格式派生、识别出的）。纵向避让那几条只对它开
    pub auto_layout: bool,
    /// 自动铺排但**照原谱分行分页**（识别结果）。横向、纵向间距仍自动算，只是行与页不重排
    pub keep_breaks: bool,
    /// 自动铺排时 `new-system` / `new-page` 是硬断点：源谱版面档（`keepBreaks`），或源文写明的换行（`sourceBreaks`）
    pub hard_breaks: bool,
    /// `updateDataXPos` 跑过了（文字块的 x 已加上拍位）
    pub data_x_placed: bool,
    /// 长图：不分页，页高由内容定
    pub long_image: bool,
    /// 版面 pass 的节奏槽缓存与压缩档（TS `layoutpass.ts` 里按对象作键的 `slotCache` / `squeezeOf`）
    pub pass_cache: crate::pass::PassCache,
}

impl<'d> StaffLayout<'d> {
    pub fn new(options: MixedOptions, song: &'d Song, surface: Option<&'d Surface>, meta: &'d MetaData, mc: &'d MeasureCtx<'d>) -> StaffLayout<'d> {
        StaffLayout {
            song,
            surface,
            meta,
            mc,
            scripture: Vec::new(),
            scaling: DEFAULT_SCALING,
            parts: Vec::new(),
            measures: Vec::new(),
            part_measures: Vec::new(),
            chords: Vec::new(),
            notes: Vec::new(),
            entries: Vec::new(),
            lyrics: Vec::new(),
            harmonies: Vec::new(),
            texts: Vec::new(),
            beams: Vec::new(),
            systems: Vec::new(),
            pages: Vec::new(),
            slurs: Vec::new(),
            tieds: Vec::new(),
            tuplets: Vec::new(),
            endings: Vec::new(),
            wedges: Vec::new(),
            pedal_lines: Vec::new(),
            octave_lines: Vec::new(),
            arpeggiates: Vec::new(),
            lrc_extends: Vec::new(),
            part_groups: Vec::new(),
            options,
            defaults: MixedDefaults::default(),
            credits: Vec::new(),
            auto_layout: false,
            keep_breaks: false,
            hard_breaks: false,
            data_x_placed: false,
            long_image: false,
            pass_cache: crate::pass::PassCache::default(),
        }
    }

    /// 量字与 SMuFL 元数据合起来（画图元用）。
    pub fn env(&self) -> Env<'d> {
        Env { mc: self.mc, meta: Some(self.meta) }
    }

    /// 谱表上那层简谱用的字（`options.mixFont`）。
    pub fn mix_font(&self) -> Font {
        self.options.mix_font()
    }

    /// 没写朝向的圆滑线、没有多声部/和弦可依的延音线一律画在音符上方（让开下面的歌词）：自动铺排的谱，以及本应用导出的谱
    /// （读回来要与导出前一样）。别的谱照 musicpp：圆滑线缺省在下、延音线与符干反向。
    pub fn arcs_above(&self) -> bool {
        self.auto_layout || self.encoder() == Encoder::Dolce
    }

    /// 导出这份谱的软件（Sibelius / MuseScore 各有几处照 musicpp 的修正），任一条 `<software>` 认得就算
    pub fn encoder(&self) -> Encoder {
        let mut e = Encoder::Unknown;
        if let Some(sws) = self.song.identification.as_ref().and_then(|i| i.software.as_ref()) {
            for sw in sws {
                if sw.contains("Sibelius") {
                    e = Encoder::Sibelius;
                } else if sw.contains("MuseScore") {
                    e = Encoder::MuseScore;
                } else if sw == "Dolce" {
                    e = Encoder::Dolce; // 本应用写出的
                }
            }
        }
        e
    }

    /// 标题：`credit-type` 为 title 的首条，没有取 `<work-title>` / `<movement-title>`
    pub fn title(&self) -> String {
        if let Some(c) = self.song.credits.as_ref().and_then(|cs| {
            cs.iter().find(|c| c.kind.as_deref().map(js::trim) == Some("title") && !js::trim(&c.text).is_empty())
        }) {
            return js::trim(&c.text).to_owned();
        }
        let w = &self.song.work;
        let t = w.title.as_deref().map(js::trim).unwrap_or("");
        if !t.is_empty() {
            return t.to_owned();
        }
        w.movement_title.as_deref().map(js::trim).unwrap_or("").to_owned()
    }

    pub fn new_part(&mut self) -> PartId {
        let id = PartId(self.parts.len());
        self.parts.push(PartLayout::default());
        id
    }

    pub fn new_measure(&mut self) -> MeasId {
        let id = MeasId(self.measures.len());
        let m = MeasureLayout { index: self.measures.len(), ..MeasureLayout::default() };
        self.measures.push(m);
        id
    }

    pub fn num_measures(&self) -> usize {
        self.measures.len()
    }

    /// 谱表对象（TS 里直接持 `PartStaff`）。
    pub fn part_staff(&self, r: PsRef) -> &PartStaff {
        &self.parts[r.part.0].staves[r.sub]
    }
}
