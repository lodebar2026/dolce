//! `ScoreDoc`——歌谱的**语义模型**（同 `src/model/doc.ts`，逐字段照搬；改结构前先读那份文件开头的说明）。
//!
//! 123 格式（简谱主格式）与 MusicXML（五线谱主格式）共用；各格式的排版、试听、MusicXML 导出、双向定位都直接吃它。
//! MusicXML 独有的表层（版面坐标、符干、字体、读不懂的节点…）**不进本模型**：读入时绑到原节点（`xmlsurface`），
//! 写出端通用回填。
//!
//! Rust 侧的口径：
//! - JSON 形状 = `doc.ts`（字段名 camelCase、可缺省的字段缺省不写），TS 侧 `JSON.parse` 出来就是那份类型。
//! - TS 的 `number` 一律 `f64`（读 XML 用 `Number()`，什么数都可能进来），只有元素 id 是 `u32`。
//! - 字符串字面量联合是 [`str_enum!`](crate::str_enum)：认不得的原样进 `Other`（TS 读 XML 多处 `as` 断言不校验）。
//! - TS 的 `Record` 一律 `IndexMap`（迭代次序 = 插入次序）。

use crate::str_enum;
use dolce_base::{Msg, SourceSpan};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

// ───────────────────────── 基础 ─────────────────────────

str_enum! {
    pub enum DiagnosticSeverity { Warning = "warning", Error = "error" }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Diagnostic {
    pub severity: DiagnosticSeverity,
    /// 机器可读短代码，如 "unknown-field"
    pub code: String,
    /// 给人看的提示：只有键与参数，显示时按界面语言出字（没有原文回退）
    pub msg: Msg,
    pub source: SourceSpan,
}

/// 元素 id。解析期分配、全文档唯一、**不随数组增删变化**。
pub type ElementId = u32;

/// 对象身份（TS 里是对象引用本身）：MusicXML 表层按它把模型对象绑到原节点（`xmlsurface`）。
/// 0 = 没有身份（文本来源、克隆出来的对象——TS 里克隆出的新对象在 WeakMap 里查不到）。
/// JSON 里写作 `_oid`、为 0 时不写；TS 的手写类型里没有它。**复制成新对象的地方要换新号或清零**（`Oid::NONE`）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Oid(pub u32);

impl Oid {
    pub const NONE: Oid = Oid(0);
    pub fn is_none(&self) -> bool {
        self.0 == 0
    }
}

str_enum! {
    /// 水平对齐（`justify` / `halign`）
    pub enum HAlign { Left = "left", Center = "center", Right = "right" }
}

str_enum! {
    /// 上方 / 下方
    pub enum Placement { Above = "above", Below = "below" }
}

str_enum! {
    /// 换行种类（`lineBreakAfter` / `Part.endBreak`）
    pub enum BreakKind { System = "system", Page = "page" }
}

str_enum! {
    /// 起止（wedge / pedal / octave-shift / extend）
    pub enum SpanType { Start = "start", Stop = "stop", Continue = "continue" }
}

str_enum! {
    pub enum WedgeType { Crescendo = "crescendo", Diminuendo = "diminuendo" }
}

// ───────────────────────── 头部与元信息 ─────────────────────────

/// 曲目标识。← 123 的 `X:` / `T:`（第一条主标题，其后为副标题）
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Work {
    /// 曲号原文（可能是 "J07" 这种带字母的）
    #[serde(skip_serializing_if = "Option::is_none")] pub number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub title: Option<String>,
    /// MusicXML 的 `<movement-title>`
    #[serde(skip_serializing_if = "Option::is_none")] pub movement_title: Option<String>,
    pub subtitles: Vec<String>,
    /// 文本谱 `V:` 版本号原文
    #[serde(skip_serializing_if = "Option::is_none")] pub version: Option<String>,
}

/// ← 123 的 `C:` / 文本谱 `Z:` / MusicXML `<identification><creator>`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Creator {
    /// MusicXML 的 `type`：composer / lyricist / arranger / translator / transcriber / words-and-music…
    /// 无 type 的源格式按原文标签定（`metakeys::creator_type_of`），没有标签的记 composer。
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Identification {
    pub creators: Vec<Creator>,
    #[serde(skip_serializing_if = "Option::is_none")] pub rights: Option<String>,
    /// `<encoding><software>`，按出现顺序全留（Sibelius 导出写两条，混排按任一条认编码软件）
    #[serde(skip_serializing_if = "Option::is_none")] pub software: Option<Vec<String>>,
}

str_enum! {
    pub enum VAlign { Top = "top", Middle = "middle", Bottom = "bottom", Baseline = "baseline" }
}

/// `<credit>`：带版式与坐标的标题块文字。导出 MusicXML 时照原样写回
/// （有任何 `<credit>` 就不再用 `<work-title>` 生成标题）。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Credit {
    /// `credit-type`：title / subtitle / composer / lyricist / rights…
    #[serde(skip_serializing_if = "Option::is_none")] #[serde(rename = "type")]
    pub kind: Option<String>,
    /// 全部文字（多个 `<credit-words>` 用换行接起来）
    pub text: String,
    /// 各个 `<credit-words>` 的原文。**`text` 里的换行不等于元素边界时才写**（原文一个元素里自带换行）；
    /// 不写时 `text` 按换行切就是各个元素
    #[serde(skip_serializing_if = "Option::is_none")] pub words: Option<Vec<String>>,
    /// 左下原点坐标系，与 MusicXML 一致
    #[serde(skip_serializing_if = "Option::is_none")] pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub font_size: Option<f64>,
    /// `<credit-words font-family / font-weight>`（首个元素的）。编辑器「跟随文件」的页眉字体读这里
    #[serde(skip_serializing_if = "Option::is_none")] pub font_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub font_weight: Option<String>,
    /// `<credit-words justify>`。与 `halign` 分开存：混排只认 `justify`
    #[serde(skip_serializing_if = "Option::is_none")] pub justify: Option<HAlign>,
    #[serde(skip_serializing_if = "Option::is_none")] pub halign: Option<HAlign>,
    /// `<credit-words valign>`：`default-y` 是字顶、中线、底还是基线（缺省）
    #[serde(skip_serializing_if = "Option::is_none")] pub valign: Option<VAlign>,
    #[serde(skip_serializing_if = "Option::is_none")] pub page: Option<f64>,
    /// 身份放最后：JSON 里排在末尾，TS 镜像摘掉它时对象不退化
    #[serde(rename = "_oid", default, skip_serializing_if = "Oid::is_none")]
    #[cfg_attr(feature = "ts", ts(skip))]
    pub oid: Oid,
}

/// 字体属性（`font-family` / `font-size`（pt）/ `font-weight`）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
#[derive(Default)]
pub struct FontSpec {
    #[serde(skip_serializing_if = "Option::is_none")] pub family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub weight: Option<String>,
    /// `font-style`：italic / normal
    #[serde(skip_serializing_if = "Option::is_none")] pub style: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Scaling {
    pub millimeters: f64,
    pub tenths: f64,
}

str_enum! {
    pub enum OddEven { Odd = "odd", Even = "even", Both = "both" }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct PageMargins {
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
    #[serde(skip_serializing_if = "Option::is_none")] pub odd_even: Option<OddEven>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
#[derive(Default)]
pub struct PageLayout {
    #[serde(skip_serializing_if = "Option::is_none")] pub page_width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub page_height: Option<f64>,
    /// `<page-margins>`，按出现顺序全留（奇偶页分开写时有两份）
    #[serde(skip_serializing_if = "Option::is_none")] pub margins: Option<Vec<PageMargins>>,
}

/// [五线谱] `<defaults>` 里跨格式有人读写的几项：纸、scaling、歌词字号。
/// `<system-layout>`、`<staff-layout>`、`<music-font>`、`<word-font>` 等是表层。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
#[derive(Default)]
pub struct Defaults {
    #[serde(skip_serializing_if = "Option::is_none")] pub scaling: Option<Scaling>,
    #[serde(skip_serializing_if = "Option::is_none")] pub page_layout: Option<PageLayout>,
    /// `<lyric-font>`：歌词的缺省字体
    #[serde(skip_serializing_if = "Option::is_none")] pub lyric_font: Option<FontSpec>,
}

str_enum! {
    pub enum GroupSymbol { Brace = "brace", Bracket = "bracket", Line = "line", Square = "square", NoSymbol = "none" }
}

/// [五线谱] `<part-group>`：SATB 的括号分组。← 123 的 `%%score {(S A) (T B)}`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct PartGroup {
    pub number: String,
    #[serde(skip_serializing_if = "Option::is_none")] pub symbol: Option<GroupSymbol>,
    #[serde(skip_serializing_if = "Option::is_none")] pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub abbrev: Option<String>,
    /// 组内是否连小节线
    #[serde(skip_serializing_if = "Option::is_none")] pub group_barline: Option<bool>,
    /// 组覆盖的 part id
    pub parts: Vec<String>,
}

// ───────────────────────── 调号 / 拍号 / 谱号 ─────────────────────────

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct ExplicitAccidental {
    pub step: String,
    pub alter: f64,
}

/// 调号。**简谱要首调、五线谱要记谱调，两者并存**：`fifths` 是升降号数（-7..7），`tonic_degree` 是简谱主音唱名。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[derive(Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Key {
    pub fifths: f64,
    /// major / minor / dorian…
    #[serde(skip_serializing_if = "Option::is_none")] pub mode: Option<String>,
    /// 调号**拼写**，如 "bB" / "#F"。不能只存 fifths（`1=#C`/`1=bD`/`1=#F`/`1=bG` 四个调整首排不出来）
    #[serde(skip_serializing_if = "Option::is_none")] pub spelling: Option<String>,
    /// 简谱主音唱名，缺省 "1"
    #[serde(skip_serializing_if = "Option::is_none")] pub tonic_degree: Option<String>,
    /// 调号在谱面上的**原文**（文本谱写 `♭A`，`spelling` 归一成 `bA`）。排版照原文印
    #[serde(skip_serializing_if = "Option::is_none")] pub display: Option<String>,
    /// `<key>` 的显式临时记号（`K:D exp _b _e ^f`）
    #[serde(skip_serializing_if = "Option::is_none")] pub explicit_accidentals: Option<Vec<ExplicitAccidental>>,
    /// [五线谱] `<cancel>`：转调时先印的还原号个数（带号，同 `fifths` 口径）
    #[serde(skip_serializing_if = "Option::is_none")] pub cancel: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Time {
    pub beats: f64,
    pub beat_type: f64,
    /// `<time symbol>`：common / cut / single-number / normal
    #[serde(skip_serializing_if = "Option::is_none")] pub symbol: Option<String>,
    /// 辅助拍号写在括号里（文本谱 `P: 4/4 ( 2/4 )`）
    #[serde(skip_serializing_if = "Option::is_none")] pub parenthesized: Option<bool>,
}

str_enum! {
    pub enum ClefSign { G = "G", F = "F", C = "C", Percussion = "percussion", Tab = "TAB", NoSign = "none" }
}

/// [五线谱] `<clef>`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Clef {
    pub sign: ClefSign,
    #[serde(skip_serializing_if = "Option::is_none")] pub line: Option<f64>,
    /// `<clef-octave-change>`：treble-8 那种
    #[serde(skip_serializing_if = "Option::is_none")] pub octave_change: Option<f64>,
    /// 多谱表时这个谱号属于第几谱表
    #[serde(skip_serializing_if = "Option::is_none")] pub staff: Option<f64>,
}

/// [五线谱] `<transpose>`：移调乐器
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[derive(Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Transpose {
    #[serde(skip_serializing_if = "Option::is_none")] pub diatonic: Option<f64>,
    pub chromatic: f64,
    #[serde(skip_serializing_if = "Option::is_none")] pub octave_change: Option<f64>,
}

// ───────────────────────── 音高与时值 ─────────────────────────

str_enum! {
    pub enum Step { A = "A", B = "B", C = "C", D = "D", E = "E", F = "F", G = "G" }
}

/// 绝对音高（MusicXML 侧）
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Pitch {
    pub step: Step,
    /// 半音升降，-2..2
    pub alter: f64,
    /// MusicXML 八度，中央 C 所在八度为 4
    pub octave: f64,
}

str_enum! {
    pub enum Accidental {
        Sharp = "sharp", Flat = "flat", Natural = "natural", DoubleSharp = "double-sharp", DoubleFlat = "double-flat",
    }
}

/// 简谱度数（123 侧）。与 `Pitch` 并存、可互推。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Degree {
    /// 唱名 0..7，`0` 是休止
    pub number: f64,
    /// 八度点：正为高音点个数、负为低音点个数
    pub octave_shift: f64,
    #[serde(skip_serializing_if = "Option::is_none")] pub accidental: Option<Accidental>,
}

str_enum! {
    /// MusicXML `<type>`
    pub enum NoteType {
        Maxima = "maxima", Long = "long", Breve = "breve", Whole = "whole", Half = "half", Quarter = "quarter",
        Eighth = "eighth", N16th = "16th", N32nd = "32nd", N64th = "64th", N128th = "128th", N256th = "256th",
    }
}

/// 简谱来源（123/ABC/文本谱/`.jpwabc`/识别）的时值单位：一个四分音符 = 48 个 divisions。
pub const SIMPLE_DIVISIONS: f64 = 48.0;

/// `<time-modification>`：三连音等
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct TimeMod {
    pub actual: f64,
    pub normal: f64,
    #[serde(skip_serializing_if = "Option::is_none")] pub normal_type: Option<NoteType>,
}

/// 时值。`divisions` 相对所在小节 `MeasureAttrs.divisions`；简谱来源分母是 `SIMPLE_DIVISIONS`。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Duration {
    pub divisions: f64,
    /// 符号时值。倚音与无时值占位可缺省
    #[serde(skip_serializing_if = "Option::is_none")] #[serde(rename = "type")]
    pub kind: Option<NoteType>,
    pub dots: f64,
    #[serde(skip_serializing_if = "Option::is_none")] pub time_mod: Option<TimeMod>,
}

str_enum! {
    /// 符杠逐层状态。取值同 MusicXML `<beam>`。
    pub enum BeamVal {
        Begin = "begin", Continue = "continue", End = "end", ForwardHook = "forward hook", BackwardHook = "backward hook",
    }
}

// ───────────────────────── 和弦符号 / 歌词 / 记号 ─────────────────────────

/// 和弦根音 / 低音
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[derive(Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct HarmonyStep {
    pub step: String,
    pub alter: f64,
    /// 升降号印在字母**前面**（`<root-alter location="left">`，中文简谱的 `#Fm`、`bB`）
    #[serde(skip_serializing_if = "Option::is_none")] pub alter_left: Option<bool>,
}

str_enum! {
    pub enum DegreeType { Add = "add", Alter = "alter", Subtract = "subtract" }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct HarmonyDegree {
    pub value: f64,
    pub alter: f64,
    #[serde(rename = "type")]
    pub kind: DegreeType,
}

/// 和弦符号 `<harmony>`。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[derive(Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Harmony {
    pub root: HarmonyStep,
    /// `<kind>`：major / minor / dominant / major-seventh…
    pub kind: String,
    /// 面上要印的原文（`<kind text=>`），如 "m7"、"Δ"
    #[serde(skip_serializing_if = "Option::is_none")] pub kind_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub bass: Option<HarmonyStep>,
    #[serde(skip_serializing_if = "Option::is_none")] pub degrees: Option<Vec<HarmonyDegree>>,
    /// 整段和弦只有文字、解析不出结构时的原文兜底（识别结果常是这种）
    #[serde(skip_serializing_if = "Option::is_none")] pub text: Option<String>,
    /// [五线谱] 字号（pt，`<root-step font-size>`）
    #[serde(skip_serializing_if = "Option::is_none")] pub font_size: Option<f64>,
    /// `<offset>`：相对所修饰音符起点的 divisions
    #[serde(skip_serializing_if = "Option::is_none")] pub offset: Option<f64>,
    /// [五线谱] `<kind use-symbols>` / `<kind parentheses-degrees>`
    #[serde(skip_serializing_if = "Option::is_none")] pub use_symbols: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] pub parentheses_degrees: Option<bool>,
    /// [五线谱] `<harmony staff>`
    #[serde(skip_serializing_if = "Option::is_none")] pub staff: Option<f64>,
    /// [五线谱] 见 `Chord.onset`。缺省 = 所挂元素的起点
    #[serde(skip_serializing_if = "Option::is_none")] pub onset: Option<f64>,
    /// 身份放最后：JSON 里排在末尾，TS 镜像摘掉它时对象不退化
    #[serde(rename = "_oid", default, skip_serializing_if = "Oid::is_none")]
    #[cfg_attr(feature = "ts", ts(skip))]
    pub oid: Oid,
}

str_enum! {
    pub enum Syllabic { Single = "single", Begin = "begin", Middle = "middle", End = "end" }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Lyric {
    /// 段号。MusicXML 的 `number`；123 里由 `w:` 的出现顺序定
    pub number: f64,
    /// 段号区间的上界：`.jpwabc` 的 `W1-6:`、文本谱 `C1-2:` 用；单段时缺省
    #[serde(skip_serializing_if = "Option::is_none")] pub number_to: Option<f64>,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")] pub syllabic: Option<Syllabic>,
    /// `<extend>`：续记号（一字多音），123 的 `_`
    #[serde(skip_serializing_if = "Option::is_none")] pub extend: Option<bool>,
    /// [五线谱] `<extend type>`。有 stop 的谱按起止两两配对，裸 `<extend/>` 不写
    #[serde(skip_serializing_if = "Option::is_none")] pub extend_type: Option<SpanType>,
    /// [五线谱] `<lyric number>` 不是纯数字时的原文
    #[serde(skip_serializing_if = "Option::is_none")] pub number_text: Option<String>,
    /// [五线谱] `<lyric name>`
    #[serde(skip_serializing_if = "Option::is_none")] pub name: Option<String>,
    /// [五线谱] `<lyric placement>`：`above` = 这一行词印在谱表上方
    #[serde(skip_serializing_if = "Option::is_none")] pub placement: Option<Placement>,
    /// `<elision>`：一音多字的连接（123 的 `{多字}` / ABC 的 `~`）
    #[serde(skip_serializing_if = "Option::is_none")] pub elision: Option<String>,
    /// 副歌：这一行词被多遍共用
    #[serde(skip_serializing_if = "Option::is_none")] pub refrain: Option<bool>,
    /// 收尾标点。**并入前一字、不占音符格**
    #[serde(skip_serializing_if = "Option::is_none")] pub trailing_punctuation: Option<String>,
    /// 印刷段号（`<1.>`）：印在该段歌词首字之前、**不占音符格**
    #[serde(skip_serializing_if = "Option::is_none")] pub verse_label: Option<String>,
    /// 字前的标点（行首的 `《`、`（`）。**不能并进 `text`**（会改变音节字数，往返中翻来覆去）
    #[serde(skip_serializing_if = "Option::is_none")] pub leading_punctuation: Option<String>,
    /// 文本谱同一行曲下同一段号出现多行歌词时，这个字属于 `Print.lyricLines` 的第几行。只在有歧义时写
    #[serde(skip_serializing_if = "Option::is_none")] pub line_index: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub source: Option<SourceSpan>,
    /// 身份放最后：JSON 里排在末尾，TS 镜像摘掉它时对象不退化
    #[serde(rename = "_oid", default, skip_serializing_if = "Oid::is_none")]
    #[cfg_attr(feature = "ts", ts(skip))]
    pub oid: Oid,
}

/// 全音符震音斜线的位置（tenths；x 相对符头左缘、y 相对谱表顶线向上为正）
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct XY {
    pub x: f64,
    pub y: f64,
}

/// 音符上的各类记号 `<notations>`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
#[derive(Default)]
pub struct Notations {
    /// accent / staccato / tenuto / marcato…
    #[serde(skip_serializing_if = "Option::is_none")] pub articulations: Option<Vec<String>>,
    /// [五线谱] 奏法记号写明的上下，键是 `articulations` 里的名字
    #[serde(skip_serializing_if = "Option::is_none")] pub artic_placement: Option<IndexMap<String, Placement>>,
    /// trill-mark / mordent / turn…（单音震音不在这里，见 `tremolo`）
    #[serde(skip_serializing_if = "Option::is_none")] pub ornaments: Option<Vec<String>>,
    /// 单音震音的斜线道数 1–4
    #[serde(skip_serializing_if = "Option::is_none")] pub tremolo: Option<f64>,
    /// 全音符震音斜线的位置：`<tremolo default-x default-y>`
    #[serde(skip_serializing_if = "Option::is_none")] pub tremolo_pos: Option<XY>,
    /// [五线谱] `<technical>`
    #[serde(skip_serializing_if = "Option::is_none")] pub technical: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub fermata: Option<bool>,
    /// [五线谱] `<fermata type="inverted">`
    #[serde(skip_serializing_if = "Option::is_none")] pub fermata_inverted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] pub arpeggiate: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] pub glissando: Option<bool>,
}

/// 简谱记号**原名**（文本谱的 `&xx`，`level` = 紧跟的 `+` 个数）。
/// `ornaments` 是排版依据，`notations` / `Measure.directions` 是它的语义投影。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct SourceOrnament {
    pub name: String,
    pub level: f64,
    /// 跳转字写在小节线**下方**（诗歌本 `"ff:Fine"`）；此时 `level` 是往下再偏几层
    #[serde(skip_serializing_if = "Option::is_none")] pub below: Option<bool>,
}

str_enum! {
    pub enum BoundaryBehavior { Join = "join", Split = "split" }
}

str_enum! {
    pub enum LayerRole { Accompaniment = "accompaniment", Voice = "voice" }
}

/// 文本谱里**夹在符号之间**、自己不占时值的东西，挂在紧随其后的那个符号上（行末的挂 `Measure.trailing`）。
// 反序列化手写（`dolce_base::tagged`，各变体经同形的 `*De` 结构体读）：派生的内部标记要先把对象读进缓冲，`Layer` 里整组 `Measure` 会多编一份反序列化代码。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub enum InlineItem {
    /// `~` 强制连进一拍 / `^` 强制切开，只影响减时线连断
    Boundary {
        behavior: BoundaryBehavior,
        #[serde(skip_serializing_if = "Option::is_none")] source: Option<SourceSpan>,
    },
    /// `{bz…}` 临时伴奏 / `{dsb…}` 临时多声部：一段自带小节与记号的独立元素流
    Layer {
        role: LayerRole,
        measures: Vec<Measure>,
        marks: Vec<Mark>,
        #[serde(skip_serializing_if = "Option::is_none")] source: Option<SourceSpan>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BoundaryDe {
    behavior: BoundaryBehavior,
    source: Option<SourceSpan>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LayerDe {
    role: LayerRole,
    measures: Vec<Measure>,
    marks: Vec<Mark>,
    source: Option<SourceSpan>,
}

impl dolce_base::tagged::TaggedDe for InlineItem {
    const TAG: &'static str = "kind";
    const NAME: &'static str = "InlineItem";
    fn fast<'de, D: serde::Deserializer<'de>>(tag: &str, d: D) -> Result<Self, D::Error> {
        match tag {
            "boundary" => BoundaryDe::deserialize(d).map(|b| InlineItem::Boundary { behavior: b.behavior, source: b.source }),
            "layer" => LayerDe::deserialize(d).map(|l| InlineItem::Layer { role: l.role, measures: l.measures, marks: l.marks, source: l.source }),
            _ => Err(serde::de::Error::unknown_variant(tag, &["boundary", "layer"])),
        }
    }
}

impl<'de> Deserialize<'de> for InlineItem {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        dolce_base::tagged::deserialize_tagged(d)
    }
}

str_enum! {
    pub enum AttachedKind { Harmony = "harmony", Deco = "deco", Annotation = "annotation", Dynamic = "dynamic" }
}

/// 挂在元素上的记号**在原文里的位置**。只给编辑用（可视化编辑选中、删除），排版与写出端都不读。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct AttachedSource {
    pub kind: AttachedKind,
    /// 记号名（装饰名、力度名；和弦名与注记为原文）
    pub name: String,
    pub source: SourceSpan,
}

/// 换行/换页符号在原文里的位置。只给编辑用。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct BreakSource {
    pub page: bool,
    /// 符号前面的最后一个元素；声部开头就换行时为 null
    #[cfg_attr(feature = "ts", ts(type = "number | null"))]
    pub after: Option<ElementId>,
    pub source: SourceSpan,
}

// ───────────────────────── 元素 ─────────────────────────

/// 增时线（简谱的 `-`）。时值记在 `Chord.duration` 上，但每条增时线有自己的 id 与挂载位（和弦可挂在增时线上）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Sustain {
    pub id: ElementId,
    #[serde(skip_serializing_if = "Option::is_none")] pub harmony: Option<Harmony>,
    #[serde(skip_serializing_if = "Option::is_none")] pub notations: Option<Notations>,
    #[serde(skip_serializing_if = "Option::is_none")] pub ornaments: Option<Vec<SourceOrnament>>,
    /// 增时线上方的注记（文本谱 `- "…"`）
    #[serde(skip_serializing_if = "Option::is_none")] pub section_word: Option<String>,
    /// 是否跟歌词。缺省不跟；文本谱 `-@` 为 true
    #[serde(skip_serializing_if = "Option::is_none")] pub lyric_anchor: Option<bool>,
    /// `-@` 跟的那个字
    #[serde(skip_serializing_if = "Option::is_none")] pub lyrics: Option<Vec<Lyric>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub before: Option<Vec<InlineItem>>,
    /// **小节中间换行**：原文在这个和弦之后换行（印刷位置的提示）
    #[serde(skip_serializing_if = "Option::is_none")] pub line_break_after: Option<BreakKind>,
    #[serde(skip_serializing_if = "Option::is_none")] pub attached_sources: Option<Vec<AttachedSource>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub source: Option<SourceSpan>,
}

/// 倚音信息 `<grace>`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
#[derive(Default)]
pub struct GraceInfo {
    /// `<grace slash=>`
    #[serde(skip_serializing_if = "Option::is_none")] pub slash: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] pub steal_time_previous: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub steal_time_following: Option<f64>,
    /// 后倚音：排在主音**之后**
    #[serde(skip_serializing_if = "Option::is_none")] pub after: Option<bool>,
}

/// 休止信息。`<rest measure="yes">` 是整小节休止。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
#[derive(Default)]
pub struct RestInfo {
    #[serde(skip_serializing_if = "Option::is_none")] pub measure: Option<bool>,
    /// 休止也可以定在某个音高上（`<rest><display-step>`）
    #[serde(skip_serializing_if = "Option::is_none")] pub display_pitch: Option<Pitch>,
    /// 文本谱里休止符上带的八度点（`0'`）
    #[serde(skip_serializing_if = "Option::is_none")] pub octave_shift: Option<f64>,
}

/// 一个时间位置上的内容：一个音、一组同时发声的音（和弦音）、或一个休止。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Chord {
    pub id: ElementId,
    /// 派生来的模型里，这个和弦在**源模型**里的 id（`<note id="jp…">` 带回来）
    #[serde(skip_serializing_if = "Option::is_none")] pub src_id: Option<ElementId>,
    /// 同时发声的音。休止时为空
    pub notes: Vec<Note>,
    /// 非空即休止
    #[serde(skip_serializing_if = "Option::is_none")] pub rest: Option<RestInfo>,
    /// 非空即倚音（倚音不占 `duration`）
    #[serde(skip_serializing_if = "Option::is_none")] pub grace: Option<GraceInfo>,
    pub duration: Duration,
    /// 增时线，按出现顺序
    #[serde(skip_serializing_if = "Option::is_none")] pub sustains: Option<Vec<Sustain>>,
    pub voice: f64,
    pub staff: f64,
    /// 逐层符杠状态（减时线层数 = 长度）
    #[serde(skip_serializing_if = "Option::is_none")] pub beams: Option<Vec<BeamVal>>,
    /// ABC 的**空白分组**落点：同号者在一条符杠下
    #[serde(skip_serializing_if = "Option::is_none")] pub beam_group: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub harmony: Option<Harmony>,
    /// 同一个音前面连着的**后续**和弦（后面的带 `offset` 落在长音中间）
    #[serde(skip_serializing_if = "Option::is_none")] pub later_harmonies: Option<Vec<Harmony>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub lyrics: Option<Vec<Lyric>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub notations: Option<Notations>,
    /// 段落词（「（副歌）」这类）。同一个音上几条分行印的按换行隔开、先写的在上
    #[serde(skip_serializing_if = "Option::is_none")] pub section_word: Option<String>,
    /// 节奏音符：**有声但无音高**（文本谱的 `X` / 番茄的 `9`）
    #[serde(skip_serializing_if = "Option::is_none")] pub rhythm: Option<bool>,
    /// `print-object="no"`：不可见
    #[serde(skip_serializing_if = "Option::is_none")] pub print_object: Option<bool>,
    /// 多声部文本谱里**不占时值的占位**（隐藏休止 `8`/`9`）
    #[serde(skip_serializing_if = "Option::is_none")] pub placeholder: Option<bool>,
    /// 是否参与歌词对位。**缺省 = 非休止**；只在与缺省不同时写
    #[serde(skip_serializing_if = "Option::is_none")] pub lyric_anchor: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] pub ornaments: Option<Vec<SourceOrnament>>,
    /// **承接前音的延长**：小节线/换行之后开头的增时线（文本谱 `5 - | - -`）
    #[serde(skip_serializing_if = "Option::is_none")] pub continued: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] pub before: Option<Vec<InlineItem>>,
    /// **小节中间换行**（见 `Sustain.line_break_after`）
    #[serde(skip_serializing_if = "Option::is_none")] pub line_break_after: Option<BreakKind>,
    /// [五线谱] `<cue/>`
    #[serde(skip_serializing_if = "Option::is_none")] pub cue: Option<bool>,
    /// [五线谱] `<type size>`：cue / grace-cue / large…
    #[serde(skip_serializing_if = "Option::is_none")] pub type_size: Option<String>,
    /// [五线谱] 小节内起点（divisions）。**缺省 = 前一个元素的终点**；只在与缺省不同时写
    #[serde(skip_serializing_if = "Option::is_none")] pub onset: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub attached_sources: Option<Vec<AttachedSource>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub source: Option<SourceSpan>,
    /// 身份放最后：JSON 里排在末尾，TS 镜像摘掉它时对象不退化
    #[serde(rename = "_oid", default, skip_serializing_if = "Oid::is_none")]
    #[cfg_attr(feature = "ts", ts(skip))]
    pub oid: Oid,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
#[derive(Default)]
pub struct Tie {
    #[serde(skip_serializing_if = "Option::is_none")] pub start: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] pub stop: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
#[derive(Default)]
pub struct Unpitched {
    #[serde(skip_serializing_if = "Option::is_none")] pub step: Option<Step>,
    #[serde(skip_serializing_if = "Option::is_none")] pub octave: Option<f64>,
}

/// 单个音。音高两侧并存：`pitch` 给五线谱、`degree` 给简谱。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
#[derive(Default)]
pub struct Note {
    #[serde(skip_serializing_if = "Option::is_none")] pub pitch: Option<Pitch>,
    #[serde(skip_serializing_if = "Option::is_none")] pub degree: Option<Degree>,
    /// 面上要印的临时记号（与 `pitch.alter` 不同：这个是**是否画出来**）
    #[serde(skip_serializing_if = "Option::is_none")] pub accidental: Option<Accidental>,
    /// [五线谱] `<accidental parentheses="yes">`
    #[serde(skip_serializing_if = "Option::is_none")] pub accidental_parentheses: Option<bool>,
    /// 延音线。跨小节、跨行都靠它
    #[serde(skip_serializing_if = "Option::is_none")] pub tie: Option<Tie>,
    /// [五线谱] `<notehead>`
    #[serde(skip_serializing_if = "Option::is_none")] pub notehead: Option<String>,
    /// [五线谱] 节奏音符的这个音画在谱表哪个位置（`<unpitched><display-step/octave>`）
    #[serde(skip_serializing_if = "Option::is_none")] pub unpitched: Option<Unpitched>,
    /// [五线谱] 这个音自己的 `<type size>`
    #[serde(skip_serializing_if = "Option::is_none")] pub type_size: Option<String>,
    /// 身份放最后：JSON 里排在末尾，TS 镜像摘掉它时对象不退化
    #[serde(rename = "_oid", default, skip_serializing_if = "Oid::is_none")]
    #[cfg_attr(feature = "ts", ts(skip))]
    pub oid: Oid,
}

str_enum! {
    pub enum Spacer { Y = "y", X = "x" }
}

/// 无时值占位 `y`（不占时间，专供挂和弦与记号）与不可见休止 `x`（占时值）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Space {
    pub id: ElementId,
    pub spacer: Spacer,
    /// `y` 无时值；`x` 有
    #[serde(skip_serializing_if = "Option::is_none")] pub duration: Option<Duration>,
    #[serde(skip_serializing_if = "Option::is_none")] pub beams: Option<Vec<BeamVal>>,
    pub voice: f64,
    pub staff: f64,
    #[serde(skip_serializing_if = "Option::is_none")] pub harmony: Option<Harmony>,
    #[serde(skip_serializing_if = "Option::is_none")] pub lyrics: Option<Vec<Lyric>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub notations: Option<Notations>,
    #[serde(skip_serializing_if = "Option::is_none")] pub onset: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub attached_sources: Option<Vec<AttachedSource>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub source: Option<SourceSpan>,
}

// 反序列化手写（`dolce_base::tagged`）：派生的内部标记要先把对象读进缓冲，整棵 `Chord` 子树会多编一份反序列化代码。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts"))]
pub enum Element {
    Chord(Chord),
    Space(Space),
}

impl dolce_base::tagged::TaggedDe for Element {
    const TAG: &'static str = "kind";
    const NAME: &'static str = "Element";
    fn fast<'de, D: serde::Deserializer<'de>>(tag: &str, d: D) -> Result<Self, D::Error> {
        match tag {
            "chord" => Chord::deserialize(d).map(Element::Chord),
            "space" => Space::deserialize(d).map(Element::Space),
            _ => Err(serde::de::Error::unknown_variant(tag, &["chord", "space"])),
        }
    }
}

impl<'de> Deserialize<'de> for Element {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        dolce_base::tagged::deserialize_tagged(d)
    }
}

// ───────────────────────── 小节 ─────────────────────────

str_enum! {
    /// 小节线样式。取值同 MusicXML `<bar-style>`。
    pub enum BarStyle {
        Regular = "regular", Dotted = "dotted", Dashed = "dashed", Heavy = "heavy",
        LightLight = "light-light", LightHeavy = "light-heavy", HeavyLight = "heavy-light", HeavyHeavy = "heavy-heavy",
        Tick = "tick", Short = "short", NoStyle = "none",
    }
}

str_enum! {
    pub enum EndingType { Start = "start", Stop = "stop", Discontinue = "discontinue" }
}

/// 房号 `<ending>`。**`text` 存原文**（"1, 2"、"1.-3."，排版照原文画）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Ending {
    pub numbers: Vec<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub text: Option<String>,
    #[serde(rename = "type")]
    pub kind: EndingType,
    /// 抬高级别（文本谱 `[+1`），挂在 start 上
    #[serde(skip_serializing_if = "Option::is_none")] pub level: Option<f64>,
    /// 跨行时后续各行那一段的抬高级别，挂在 start 上
    #[serde(skip_serializing_if = "Option::is_none")] pub continuation_levels: Option<Vec<f64>>,
    /// 文本谱把 `[` 写在**上一行行尾**：上一行留一段空的起头。挂在 start 上
    #[serde(skip_serializing_if = "Option::is_none")] pub lead_in_previous_line: Option<bool>,
    /// 文本谱房号起点相对「该小节第一个符号」的偏移（写在前一根小节线上为 -1）。挂在 start 上
    #[serde(skip_serializing_if = "Option::is_none")] pub start_offset: Option<f64>,
    /// 文本谱房号终点相对「该小节最后一个符号（含右小节线）」的偏移。挂在 stop 上
    #[serde(skip_serializing_if = "Option::is_none")] pub end_offset: Option<f64>,
    /// start 与 stop 的配对号
    #[serde(skip_serializing_if = "Option::is_none")] pub pair: Option<f64>,
    /// 行尾起头、但后面**再没有续行**接上的房号
    #[serde(skip_serializing_if = "Option::is_none")] pub dangling_lead: Option<bool>,
    /// 原文没写房号文字（`numbers` 是缺省补的 1），排版不印数字。挂在 start 上
    #[serde(skip_serializing_if = "Option::is_none")] pub captionless: Option<bool>,
    /// 起止倒置的空房号：只有 start，不画线段。挂在 start 上
    #[serde(skip_serializing_if = "Option::is_none")] pub collapsed: Option<bool>,
    /// [五线谱] `<ending print-object="no">`：只记遍次、不画
    #[serde(skip_serializing_if = "Option::is_none")] pub print_object: Option<bool>,
}

str_enum! {
    pub enum BarLocation { Left = "left", Right = "right", Middle = "middle" }
}

str_enum! {
    pub enum RepeatDir { Forward = "forward", Backward = "backward" }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Barline {
    pub location: BarLocation,
    #[serde(skip_serializing_if = "Option::is_none")] pub style: Option<BarStyle>,
    /// `|:` / `:|`
    #[serde(skip_serializing_if = "Option::is_none")] pub repeat: Option<RepeatDir>,
    /// 反复次数（`|::` 唱三遍）
    #[serde(skip_serializing_if = "Option::is_none")] pub repeat_times: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub ending: Option<Ending>,
    /// 小节线上的跳转记号：segno / coda / fine / D.C. / D.S.
    #[serde(skip_serializing_if = "Option::is_none")] pub jump: Option<String>,
    /// 文本谱 `:|:`：`repeat` 记 backward，这一位补上 forward
    #[serde(skip_serializing_if = "Option::is_none")] pub also_forward: Option<bool>,
    /// 不显形**也不占宽**（文本谱 `|/`）
    #[serde(skip_serializing_if = "Option::is_none")] pub no_width: Option<bool>,
    /// 小节线上的记号原名（`&fine` `&dc` `&ds` `&sbf`…）
    #[serde(skip_serializing_if = "Option::is_none")] pub ornaments: Option<Vec<SourceOrnament>>,
    /// 小节线上标注的临时拍号（文本谱 `"p:3/4"`），自下一小节起生效
    #[serde(skip_serializing_if = "Option::is_none")] pub time: Option<Time>,
    /// 小节线上的注记文字
    #[serde(skip_serializing_if = "Option::is_none")] pub annotation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub before: Option<Vec<InlineItem>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub line_break_after: Option<BreakKind>,
    /// `location === "middle"` 时：它排在本小节第几个元素之后
    #[serde(skip_serializing_if = "Option::is_none")] pub after_elements: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub source: Option<SourceSpan>,
    /// 身份放最后：JSON 里排在末尾，TS 镜像摘掉它时对象不退化
    #[serde(rename = "_oid", default, skip_serializing_if = "Oid::is_none")]
    #[cfg_attr(feature = "ts", ts(skip))]
    pub oid: Oid,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
#[derive(Default)]
pub struct MeasureAttrs {
    #[serde(skip_serializing_if = "Option::is_none")] pub divisions: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub key: Option<Key>,
    #[serde(skip_serializing_if = "Option::is_none")] pub time: Option<Time>,
    /// [五线谱]
    #[serde(skip_serializing_if = "Option::is_none")] pub clefs: Option<Vec<Clef>>,
    /// [五线谱] 本小节起的谱表数
    #[serde(skip_serializing_if = "Option::is_none")] pub staves: Option<f64>,
    /// [五线谱]
    #[serde(skip_serializing_if = "Option::is_none")] pub transpose: Option<Transpose>,
    /// 多小节休止：从本小节起 n 个整小节休止合成一个印（`<multiple-rest>`，123 的 `Zn`）
    #[serde(skip_serializing_if = "Option::is_none")] pub multi_rest: Option<f64>,
    /// 身份放最后：JSON 里排在末尾，TS 镜像摘掉它时对象不退化
    #[serde(rename = "_oid", default, skip_serializing_if = "Oid::is_none")]
    #[cfg_attr(feature = "ts", ts(skip))]
    pub oid: Oid,
}

/// `<metronome>`：♩=76
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
#[derive(Default)]
pub struct Metronome {
    #[serde(skip_serializing_if = "Option::is_none")] pub beat_unit: Option<NoteType>,
    #[serde(skip_serializing_if = "Option::is_none")] pub beat_unit_dot: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] pub per_minute: Option<f64>,
    /// `<per-minute>` 不是纯数字时的原文
    #[serde(skip_serializing_if = "Option::is_none")] pub per_minute_text: Option<String>,
    /// `<metronome parentheses="yes">`
    #[serde(skip_serializing_if = "Option::is_none")] pub parentheses: Option<bool>,
}

str_enum! {
    pub enum ShiftDir { Up = "up", Down = "down" }
}

/// `<octave-shift>` 起点：down = 8va（印在谱上方）、up = 8vb；size 8 / 15
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct OctaveShift {
    pub dir: ShiftDir,
    pub size: f64,
}

/// `<sound>` 的播放语义
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
#[derive(Default)]
pub struct Sound {
    #[serde(skip_serializing_if = "Option::is_none")] pub dacapo: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] pub dalsegno: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub fine: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] pub segno: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub coda: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub tocoda: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub tempo: Option<f64>,
}

/// `<direction>`：挂在小节某个时间点上的指示。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Direction {
    /// 相对小节起点的 divisions 偏移
    #[serde(skip_serializing_if = "Option::is_none")] pub offset: Option<f64>,
    /// 它排在本小节第几个元素之后。缺省 = 小节开头
    #[serde(skip_serializing_if = "Option::is_none")] pub after_elements: Option<f64>,
    /// dynamics / wedge / words / metronome / segno / coda / pedal / octave-shift / rehearsal；`sound` 是小节级的 `<sound>`
    #[serde(rename = "type")]
    pub kind: String,
    /// 力度名（`f` / `mf`…）或文字内容
    #[serde(skip_serializing_if = "Option::is_none")] pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub tempo: Option<Metronome>,
    /// wedge / pedal / octave-shift 的起止
    #[serde(skip_serializing_if = "Option::is_none")] pub span_type: Option<SpanType>,
    #[serde(skip_serializing_if = "Option::is_none")] pub wedge_type: Option<WedgeType>,
    #[serde(skip_serializing_if = "Option::is_none")] pub shift: Option<OctaveShift>,
    #[serde(skip_serializing_if = "Option::is_none")] pub placement: Option<Placement>,
    #[serde(skip_serializing_if = "Option::is_none")] pub sound: Option<Sound>,
    #[serde(skip_serializing_if = "Option::is_none")] pub voice: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub staff: Option<f64>,
    /// [五线谱] `<pedal line>`
    #[serde(skip_serializing_if = "Option::is_none")] pub line: Option<bool>,
    /// [五线谱] 同一 `<direction>` 里其余的子元素（多行诗文写成几个 `<words>`）
    #[serde(skip_serializing_if = "Option::is_none")] pub more: Option<Vec<DirectionPart>>,
    /// [五线谱] 见 `Chord.onset`
    #[serde(skip_serializing_if = "Option::is_none")] pub onset: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub source: Option<SourceSpan>,
    /// 身份放最后：JSON 里排在末尾，TS 镜像摘掉它时对象不退化
    #[serde(rename = "_oid", default, skip_serializing_if = "Oid::is_none")]
    #[cfg_attr(feature = "ts", ts(skip))]
    pub oid: Oid,
}

/// `Direction.more` 的一项：`<direction-type>` 下的一个子元素。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct DirectionPart {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")] pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub tempo: Option<Metronome>,
    #[serde(skip_serializing_if = "Option::is_none")] pub span_type: Option<SpanType>,
    #[serde(skip_serializing_if = "Option::is_none")] pub wedge_type: Option<WedgeType>,
    #[serde(skip_serializing_if = "Option::is_none")] pub line: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] pub shift: Option<OctaveShift>,
    /// 身份放最后：JSON 里排在末尾，TS 镜像摘掉它时对象不退化
    #[serde(rename = "_oid", default, skip_serializing_if = "Oid::is_none")]
    #[cfg_attr(feature = "ts", ts(skip))]
    pub oid: Oid,
}

str_enum! {
    pub enum PrintVariant { Bang = "!", Minus = "-", Plus = "+" }
}

/// `<print>`：版面指示。**`new_system`/`new_page` 表示「本小节起新系统/新页」**（口径同 MusicXML）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
#[derive(Default)]
pub struct Print {
    #[serde(skip_serializing_if = "Option::is_none")] pub new_system: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] pub new_page: Option<bool>,
    /// 本系统是全曲第几个系统（0 基），多声部文本谱靠它把各声部的行对回同一组
    #[serde(skip_serializing_if = "Option::is_none")] pub system: Option<f64>,
    /// 印在本系统上方的说明文字行（文本谱 `W:`）
    #[serde(skip_serializing_if = "Option::is_none")] pub texts: Option<Vec<String>>,
    /// 本行的声部名（文本谱每行都可以写 `Q1<女高>`）
    #[serde(skip_serializing_if = "Option::is_none")] pub caption: Option<String>,
    /// 文本谱 `Q!:` / `Q-:` / `Q+:` 的后缀原文
    #[serde(skip_serializing_if = "Option::is_none")] pub variant: Option<PrintVariant>,
    /// 本行挂的歌词行版式
    #[serde(skip_serializing_if = "Option::is_none")] pub lyric_lines: Option<Vec<LyricLineInfo>>,
    /// 文本谱 `Q` 行本身在原文的区间（乐句重排用）
    #[serde(skip_serializing_if = "Option::is_none")] pub source: Option<SourceSpan>,
    /// 与 `texts` 平行：各条 `W:` 行的原文区间
    #[serde(skip_serializing_if = "Option::is_none")] pub text_sources: Option<Vec<SourceSpan>>,
    /// 身份放最后：JSON 里排在末尾，TS 镜像摘掉它时对象不退化
    #[serde(rename = "_oid", default, skip_serializing_if = "Oid::is_none")]
    #[cfg_attr(feature = "ts", ts(skip))]
    pub oid: Oid,
}

/// 见 `Print.lyric_lines`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct LyricLineInfo {
    pub verse_from: f64,
    pub verse_to: f64,
    #[serde(skip_serializing_if = "Option::is_none")] pub annotation: Option<String>,
    /// 段号与歌词之间的间隙（字宽百分比，文本谱 `%50`）
    pub annotation_gap: f64,
    #[serde(skip_serializing_if = "Option::is_none")] pub join_brace: Option<bool>,
    /// 原文里这一行有几个音节（含空音节）
    pub count: f64,
    #[serde(skip_serializing_if = "Option::is_none")] pub source: Option<SourceSpan>,
    /// 与原文音节平行（`count` 个）：各音节的原文区间
    #[serde(skip_serializing_if = "Option::is_none")] pub sources: Option<Vec<SourceSpan>>,
}

/// 小节中间的 `<attributes>`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct LaterAttrs {
    pub after_elements: f64,
    #[serde(skip_serializing_if = "Option::is_none")] pub onset: Option<f64>,
    pub attrs: MeasureAttrs,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Measure {
    /// 小节号**原文**——可能是 "12a"
    pub number: String,
    /// [五线谱] `<measure implicit="yes">`
    #[serde(skip_serializing_if = "Option::is_none")] pub implicit: Option<bool>,
    /// [五线谱] 小节时长（divisions）。**只在比元素的最远终点更长时写**
    #[serde(skip_serializing_if = "Option::is_none")] pub duration: Option<f64>,
    /// 本小节**第一个元素之前**的属性（多个 `<attributes>` 合并）
    #[serde(skip_serializing_if = "Option::is_none")] pub attrs: Option<MeasureAttrs>,
    /// [五线谱] 小节中间的 `<attributes>`。**简谱侧只看 `attrs`**
    #[serde(skip_serializing_if = "Option::is_none")] pub later_attrs: Option<Vec<LaterAttrs>>,
    /// 按时间序
    pub elements: Vec<Element>,
    /// 左右小节线都在这里，按 `location` 区分
    #[serde(skip_serializing_if = "Option::is_none")] pub barlines: Option<Vec<Barline>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub directions: Option<Vec<Direction>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub print: Option<Print>,
    /// 行末（最后一个符号之后）的 `InlineItem`
    #[serde(skip_serializing_if = "Option::is_none")] pub trailing: Option<Vec<InlineItem>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub source: Option<SourceSpan>,
    /// 身份放最后：JSON 里排在末尾，TS 镜像摘掉它时对象不退化
    #[serde(rename = "_oid", default, skip_serializing_if = "Oid::is_none")]
    #[cfg_attr(feature = "ts", ts(skip))]
    pub oid: Oid,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Part {
    /// `<score-part id>`
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")] pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub abbrev: Option<String>,
    /// 声部名的字号（pt）
    #[serde(skip_serializing_if = "Option::is_none")] pub name_size: Option<f64>,
    /// [五线谱] 多谱表（钢琴谱）
    #[serde(skip_serializing_if = "Option::is_none")] pub staff_count: Option<f64>,
    /// 123 / ABC 的 `V:n part=m`：这个声部其实是声部 `m` 的下一条谱表。值是那个声部的 id
    #[serde(skip_serializing_if = "Option::is_none")] pub staff_of: Option<String>,
    pub measures: Vec<Measure>,
    /// 最后一小节**之后**的换行/换页
    #[serde(skip_serializing_if = "Option::is_none")] pub end_break: Option<BreakKind>,
    /// 按原文顺序
    #[serde(skip_serializing_if = "Option::is_none")] pub break_sources: Option<Vec<BreakSource>>,
    /// Muse `.jcx` 的 `V:` 声明里 style 与名字以外的参数原文，只为写回 `.jcx` 时照写
    #[serde(skip_serializing_if = "Option::is_none")] pub muse_attrs: Option<String>,
    /// 身份放最后：JSON 里排在末尾，TS 镜像摘掉它时对象不退化
    #[serde(rename = "_oid", default, skip_serializing_if = "Oid::is_none")]
    #[cfg_attr(feature = "ts", ts(skip))]
    pub oid: Oid,
}

// ───────────────────────── 跨元素的东西 ─────────────────────────

str_enum! {
    pub enum MarkType {
        Slur = "slur", Tied = "tied", Tuplet = "tuplet", Wedge = "wedge", Pedal = "pedal",
        OctaveShift = "octaveShift", LyricExtend = "lyricExtend",
    }
}

str_enum! {
    pub enum Orientation { Over = "over", Under = "under" }
}

/// 跨元素的记号。**用元素 id 配对**。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Mark {
    #[serde(rename = "type")]
    pub kind: MarkType,
    /// MusicXML 的 `number` 属性：同类记号重叠时靠它配对
    #[serde(skip_serializing_if = "Option::is_none")] pub number: Option<f64>,
    pub start: ElementId,
    pub end: ElementId,
    /// [五线谱] 起止写在和弦的第几个音上（缺省 0）
    #[serde(skip_serializing_if = "Option::is_none")] pub start_note: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub end_note: Option<f64>,
    /// 嵌套层级（简谱的双弧 / 房号抬高）
    #[serde(skip_serializing_if = "Option::is_none")] pub level: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub placement: Option<Placement>,
    /// [五线谱] `<slur orientation>` / `<tied orientation>`
    #[serde(skip_serializing_if = "Option::is_none")] pub orientation: Option<Orientation>,
    /// [五线谱] `<tuplet bracket>`
    #[serde(skip_serializing_if = "Option::is_none")] pub bracket: Option<bool>,
    /// 虚线弧（ABC 的 `.(cde)`）
    #[serde(skip_serializing_if = "Option::is_none")] pub dashed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] pub wedge_type: Option<WedgeType>,
    /// 跨行时后续各行那一段的 level
    #[serde(skip_serializing_if = "Option::is_none")] pub continuation_levels: Option<Vec<f64>>,
    /// 文本谱记号起点写在小节线/`~`/夹层上：原起点在 `start` 那个符号之前第几个位置
    #[serde(skip_serializing_if = "Option::is_none")] pub start_lead: Option<f64>,
    /// 同上，终点写在 `end` 那个符号之后第几个位置
    #[serde(skip_serializing_if = "Option::is_none")] pub end_trail: Option<f64>,
    /// 起止倒置的空记号：`start`=`end`=那个符号，排版不画
    #[serde(skip_serializing_if = "Option::is_none")] pub collapsed: Option<bool>,
    /// 起点写在**上一行行尾**
    #[serde(skip_serializing_if = "Option::is_none")] pub lead_in_previous_line: Option<bool>,
    /// `lead_in_previous_line` 时，上一行那段起头离行尾差几个位置
    #[serde(skip_serializing_if = "Option::is_none")] pub lead_back: Option<f64>,
    /// 三连音等的显示数字
    #[serde(skip_serializing_if = "Option::is_none")] pub tuplet_actual: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub tuplet_normal: Option<f64>,
    /// 跨行时的续接标记
    #[serde(skip_serializing_if = "Option::is_none")] pub continues_to_next: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] pub continues_from_previous: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] pub source: Option<SourceSpan>,
    /// 起止符号各自在原文里的位置（`(` 与 `)`）。只给编辑用
    #[serde(skip_serializing_if = "Option::is_none")] pub open_source: Option<SourceSpan>,
    #[serde(skip_serializing_if = "Option::is_none")] pub close_source: Option<SourceSpan>,
    /// 身份放最后：JSON 里排在末尾，TS 镜像摘掉它时对象不退化
    #[serde(rename = "_oid", default, skip_serializing_if = "Oid::is_none")]
    #[cfg_attr(feature = "ts", ts(skip))]
    pub oid: Oid,
}

/// 演唱顺序的一遍。← `.jpwabc` 的 `.Repeat` 段（只读的旧扩展）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct PlayPass {
    /// 起止小节（1 基）
    pub from_measure: f64,
    pub to_measure: f64,
    /// skip：从该小节第 n 个音符接入
    #[serde(skip_serializing_if = "Option::is_none")] pub from_element: Option<ElementId>,
    /// limit：只唱到该小节第 n 个音符
    #[serde(skip_serializing_if = "Option::is_none")] pub to_element: Option<ElementId>,
    /// 这一遍配第几段歌词（可以不等于遍序）
    #[serde(skip_serializing_if = "Option::is_none")] pub verse: Option<f64>,
    /// 这一遍唱完换页
    #[serde(skip_serializing_if = "Option::is_none")] pub page_break_after: Option<bool>,
    /// 这一项第一个、最后一个和弦
    #[serde(skip_serializing_if = "Option::is_none")] pub from_anchor: Option<ElementId>,
    #[serde(skip_serializing_if = "Option::is_none")] pub to_anchor: Option<ElementId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct SingItem {
    pub section: String,
    /// 配第几条 `w:`（段内计，同 `P:`），缺省 1
    #[serde(skip_serializing_if = "Option::is_none")] pub verse: Option<f64>,
    /// 这一项之后换行（`/`）
    #[serde(skip_serializing_if = "Option::is_none")] pub line_after: Option<bool>,
}

/// 逐遍演唱顺序的一遍（123 `%%sing`）
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct SingPass {
    pub items: Vec<SingItem>,
    /// 投影这一遍一页最多几行（缺省 4）
    #[serde(skip_serializing_if = "Option::is_none")] pub rows: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct InlineStyle {
    #[serde(skip_serializing_if = "Option::is_none")] pub role: Option<String>,
    pub props: IndexMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub scope: Option<ElementId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct RawStyle {
    pub key: String,
    pub value: String,
}

/// 样式引用。← 123 的 `I:style` 与 inline `[I:style …]`。样式**本体**在独立样式表里。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
#[derive(Default)]
pub struct StyleRef {
    /// 样式表文件名
    #[serde(skip_serializing_if = "Option::is_none")] pub sheet_ref: Option<String>,
    /// 曲内局部覆盖
    #[serde(skip_serializing_if = "Option::is_none")] pub inline: Option<Vec<InlineStyle>>,
    /// 文档内的版面指令原文（文本谱的 `FontSize:` …），交样式层解释
    #[serde(skip_serializing_if = "Option::is_none")] pub raw: Option<Vec<RawStyle>>,
}

/// 扩展 meta：键 → 值列表。键见 `metakeys`。
pub type SongMeta = IndexMap<String, Vec<String>>;

/// 页眉页脚文字（文本谱的 `XL/XR/TL/TR/BL/BC/BR`）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
#[derive(Default)]
pub struct PageText {
    #[serde(skip_serializing_if = "Option::is_none")] pub index_left: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub index_right: Option<String>,
    pub top_left: Vec<String>,
    pub top_right: Vec<String>,
    pub bottom_left: Vec<String>,
    pub bottom_center: Vec<String>,
    pub bottom_right: Vec<String>,
}

/// `Song.tempos` 的一项：数字为 BPM，字符串为文字术语
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts"))]
pub enum Tempo {
    Bpm(f64),
    Text(String),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Ratio {
    pub num: f64,
    pub den: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct SectionOrder {
    pub text: String,
    pub seq: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct SectionMark {
    pub name: String,
    pub before: ElementId,
}

/// 一首歌。多曲文件是 `ScoreDoc.songs` 多项。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct Song {
    pub work: Work,
    #[serde(skip_serializing_if = "Option::is_none")] pub identification: Option<Identification>,
    #[serde(skip_serializing_if = "Option::is_none")] pub credits: Option<Vec<Credit>>,
    /// 首调号与拍号的初值（曲中变更走 `Measure.attrs`）
    #[serde(skip_serializing_if = "Option::is_none")] pub key: Option<Key>,
    #[serde(skip_serializing_if = "Option::is_none")] pub time: Option<Time>,
    /// 头部的其余拍号（文本谱 `P: 4/4 3/4`，第一个在 `time`）
    #[serde(skip_serializing_if = "Option::is_none")] pub extra_times: Option<Vec<Time>>,
    /// 拍号后面印着的说明文字（「混合拍」）
    #[serde(skip_serializing_if = "Option::is_none")] pub time_note: Option<String>,
    /// 速度：数字为 BPM，字符串为文字术语。两者可并存
    #[serde(skip_serializing_if = "Option::is_none")] pub tempos: Option<Vec<Tempo>>,
    /// `tempos` 里数字速度的拍单位（缺省四分 1/4）
    #[serde(skip_serializing_if = "Option::is_none")] pub tempo_beat: Option<Ratio>,
    /// [五线谱]
    #[serde(skip_serializing_if = "Option::is_none")] pub defaults: Option<Defaults>,
    /// [五线谱]
    #[serde(skip_serializing_if = "Option::is_none")] pub part_groups: Option<Vec<PartGroup>>,
    pub parts: Vec<Part>,
    pub marks: Vec<Mark>,
    #[serde(skip_serializing_if = "Option::is_none")] pub play_order: Option<Vec<PlayPass>>,
    /// 逐遍演唱顺序（123 `%%sing`）
    #[serde(skip_serializing_if = "Option::is_none")] pub sing_order: Option<Vec<SingPass>>,
    /// 头部 `P:` 的段落顺序：`text` 原文照写回，`seq` 展开后的段落名
    #[serde(skip_serializing_if = "Option::is_none")] pub section_order: Option<SectionOrder>,
    /// 曲内 `P:A` / `[P:A]` 的段落标记
    #[serde(skip_serializing_if = "Option::is_none")] pub section_marks: Option<Vec<SectionMark>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub style: Option<StyleRef>,
    #[serde(skip_serializing_if = "Option::is_none")] pub page_text: Option<PageText>,
    /// 无前缀的自由文字行（注记、勘误、版权说明）
    #[serde(skip_serializing_if = "Option::is_none")] pub remarks: Option<Vec<String>>,
    /// Muse `.jcx` 自己的排版参数行，只为写回 `.jcx` 时照写
    #[serde(skip_serializing_if = "Option::is_none")] pub muse_directives: Option<Vec<String>>,
    /// 扩展 meta（英文标题、经文、标签、分类…）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<SongMeta>,
    #[serde(skip_serializing_if = "Option::is_none")] pub source: Option<SourceSpan>,
    /// 身份放最后：JSON 里排在末尾，TS 镜像摘掉它时对象不退化
    #[serde(rename = "_oid", default, skip_serializing_if = "Oid::is_none")]
    #[cfg_attr(feature = "ts", ts(skip))]
    pub oid: Oid,
}

str_enum! {
    pub enum SourceFormat {
        S123 = "123", Abc = "abc", MusicXml = "musicxml", Jpwabc = "jpwabc", Fanqie = "fanqie", Omr = "omr", Jly = "jly", Jcx = "jcx",
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "doc.gen.ts", optional_fields))]
pub struct ScoreDoc {
    /// 产出它的源格式
    pub source_format: SourceFormat,
    /// 文本谱方言。排版取度量用
    #[serde(skip_serializing_if = "Option::is_none")] pub fanqie_dialect: Option<String>,
    /// 源文本（有的话）。点选定位要回指原文
    #[serde(skip_serializing_if = "Option::is_none")] pub source: Option<String>,
    pub songs: Vec<Song>,
    pub diagnostics: Vec<Diagnostic>,
}
