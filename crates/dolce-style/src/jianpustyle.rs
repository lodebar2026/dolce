//! 简谱的尺子（照 `engrave/jianpustyle.ts`）：一份**样式值**（全是 pt，已折算好），简谱引擎从它取。
//!
//! 折算只在一处：[`crate::jianpu::jianpu_style_of`]（样式表 → 这份）；成书走 [`crate::book::book_jianpu_style`]。
//! 值为 0 的几项是「按引擎缺省 / 按字形量」（各字段注释里写明），不是「没有」。
//!
//! 词（枚举值）存成字符串：`@jianpu` 的 `word` 键原样落值（TS 同样不校验），JSON 形状与 TS 一致。

use serde::{Deserialize, Serialize};

/// 一支字：族（CSS font-family 串）+ 粗斜。字号另在 `size` 里。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FaceSpec {
    pub family: String,
    pub bold: bool,
    pub italic: bool,
}

impl FaceSpec {
    pub fn plain(family: &str) -> FaceSpec {
        FaceSpec { family: family.to_string(), bold: false, italic: false }
    }
}

/// 页眉一项：族、粗体不给 = 沿用正文字。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HeaderFace {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    pub size: f64,
}

impl HeaderFace {
    pub fn sized(size: f64) -> HeaderFace {
        HeaderFace { family: None, bold: None, size }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct JpFonts {
    /// 音符数字；和弦、房号、调号拍号那一行也用它的族（不跟 `look.noteBold` 加粗）
    pub note: FaceSpec,
    pub lyric: FaceSpec,
    /// 其余文字（原样文档的歌词、段号、说明行、页眉页脚的底）
    pub text: FaceSpec,
    pub smufl: FaceSpec,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct JpHeader {
    pub title: HeaderFace,
    pub subtitle: HeaderFace,
    pub credit: HeaderFace,
    pub scripture: HeaderFace,
}

impl JpHeader {
    pub fn get_mut(&mut self, role: &str) -> Option<&mut HeaderFace> {
        match role {
            "title" => Some(&mut self.title),
            "subtitle" => Some(&mut self.subtitle),
            "credit" => Some(&mut self.credit),
            "scripture" => Some(&mut self.scripture),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JpSize {
    pub note: f64,
    pub lyric: f64,
    /// 0 = 不排和弦
    pub chord: f64,
    pub key_meter: f64,
    pub verse_num: f64,
    /// 房号字号。0 = 不画房号（投影档）
    pub ending: f64,
    /// 段落词。0 = 不排
    pub section_word: f64,
    /// 说明行 `W:`
    pub words: f64,
    /// 页眉 `TL:`/`TR:` 与页脚
    pub header: f64,
    /// 倚音 ÷ 主音字号
    pub grace: f64,
    /// 临时伴奏层 ÷ 主旋律
    pub cue: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JpStroke {
    pub barline: f64,
    pub final_barline: f64,
    pub beam: f64,
    pub slur: f64,
    /// 弧的描边宽
    pub slur_outline: f64,
    /// 扁平长连音线中段的墨迹厚。0 = 弧厚 × 0.45
    pub slur_flat: f64,
    /// 渐强渐弱。0 = 数字墨迹高 × 0.07
    pub hairpin: f64,
    /// 拍号分数线。0 = 引擎缺省 1.5
    pub time_sig_rule: f64,
    /// 房号 / 三连音括线。0 = 按字号推
    pub bracket: f64,
    /// 双线 / 反复线两根竖线的间距
    pub double_barline_gap: f64,
}

/// 三种点的半径。0 = 按字形量。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct JpDot {
    pub octave: f64,
    pub aug: f64,
    pub repeat: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JpVertical {
    /// 数字上下叠层的空 ÷ 数字墨迹高
    pub stack_gap: f64,
    /// 叠层顶之上到弧 / 上方带的空
    pub slur_gap: f64,
    /// 音符基线 → 歌词基线。0 = 引擎自算
    pub lyric_baseline: f64,
    /// 多段歌词叠在一行谱下的段间行距。0 = 逐段重复整条谱行
    pub lyric_stack: f64,
    /// 末行歌词 → 下一组音符基线（原样文档）
    pub system_gap: f64,
    /// 页内谱行均分的上限
    pub system_spread: f64,
    /// 谱行之间另加的空
    pub staff_dist: f64,
    pub voice_gap: f64,
    /// 和弦基线离音符墨迹顶
    pub chord_gap: f64,
    /// 房号括线的「脚」。0 = 按字号推
    pub bracket_foot: f64,
    /// 小节线上下缘相对数字基线。0 = 按字号推
    pub staff_top: f64,
    pub staff_bottom: f64,
    /// 小节线高（原样文档）
    pub barline_height: f64,
}

/// 弧高的口径是贝塞尔控制点高（弧顶 ≈ 0.75 × 它 × heightScale）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JpArc {
    pub height_scale: f64,
    /// <= 0 = 不封顶
    pub max_height: f64,
    /// <= 0 = 只用公式自带的 1.2
    pub min_height: f64,
    /// 跨度超过它改画扁平长连音线。0 = 按字号自动，<0 = 一律画弧
    pub flat_span: f64,
    pub flat_notes: f64,
    pub flat_ratio: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JpSpacing {
    /// 相邻歌词字之间的最小横向间隙
    pub lyric_gap: f64,
    /// 两端对齐时往空档里加的总量最多是自然宽的这么多倍
    pub max_horizontal_scale: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JpLook {
    pub note_bold: bool,
    pub pair_pages: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub even_justify: Option<bool>,
    pub no_intro: bool,
    pub chord_plain: bool,
    /// `before` / `after`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accidental_side: Option<String>,
    /// `csym` / `classic`
    pub accidental_style: String,
    pub accidental_scale: f64,
    /// 标点挤压档（`cjkpunct` 的 CompressMode）
    pub punct_compress: String,
    /// `bracket` / `arc`
    pub tuplet_style: String,
    /// `always` / `never` / `auto`
    pub verse_numbers: String,
    pub verse_number_auto_min: f64,
    /// 拍号两个比例（÷ 小节线高）。0 = 缺省
    pub time_sig_digit_ratio: f64,
    pub time_sig_rule_len_ratio: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Margin {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct JpPage {
    pub color: f64,
    pub margin: Margin,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct JianpuStyle {
    pub font: JpFonts,
    pub header: JpHeader,
    pub size: JpSize,
    pub stroke: JpStroke,
    pub dot: JpDot,
    pub vertical: JpVertical,
    pub arc: JpArc,
    pub spacing: JpSpacing,
    pub look: JpLook,
    pub page: JpPage,
}
