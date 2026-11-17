//! 五线谱 / 混排那把尺子（照 `style/staff.ts` 与 `mixed/model.ts::MixedOptions`）：computed [`StyleSheet`] → [`MixedOptions`]（tenths）。
//!
//! `musicpp` 预设就是 [`MixedOptions::default`] 那套 Engraver 常量。MusicXML 自带的 `<scaling>` / `<defaults>` 字体是
//! **曲内覆盖层**，由五线谱引擎读、优先于主题。
//!
//! 吃两个块：`@staff`（五线谱内容）与 `@jianpu`（简谱内容——混排的简谱层也在这把尺子上）。
//! 顺序要紧：**先落字体，再取 em**——`em` 就是 `musicFont` 的字号。单位只收 em / sp（pt 要等 `<scaling>` 读进来才知道折多少 tenths）。
//!
//! 只搬了 `MixedOptions` 的数据字段（SMuFL 元数据 `meta` 由引擎另持）；`mixFont` 是派生量（[`MixedOptions::mix_font`]）。

use crate::cascade::ctx;
use crate::fonts::{family_of_role, font_of_role, FamilyMap};
use crate::header::{header_fonts_of, HeaderFonts};
use crate::jianpudefault::STACK_GAP_DEFAULT;
use crate::keys::{lookup, KeyDef, KeyKind, JIANPU_KEYS, ROLE_FONTS, STAFF_KEYS};
use crate::sheet::{truthy, StyleSheet};
use crate::themes::{compute_style_for_paper, theme, ThemeId};
use crate::units::{resolve_length, LengthContext};
use crate::value::num;
use dolce_text::Font;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// 简谱/混排数字字体栈（musicpp 用 Source Han Sans SC，找不到时回退系统中文黑体）。
pub const JP_FONT_FAMILY: &str = "Source Han Sans SC, PingFang SC, Microsoft YaHei, sans-serif";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineWidths {
    pub staff: f64,
    pub jp_beam: f64,
    pub leger: f64,
    pub stem: f64,
    pub beam: f64,
    pub heavy_barline: f64,
    pub light_barline: f64,
}

/// 谱里没写 `<page-layout>` 时用的纸（pt）；`height_pt` 为 None 是长图。`margins_pt`：`[上, 右, 下, 左]`。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaffPage {
    pub width_pt: f64,
    pub height_pt: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margins_pt: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#override: Option<bool>,
}

/// 五线谱 / 混排引擎的选项（字段序同 TS 的声明序，各字段的说法见 `mixed/model.ts`）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixedOptions {
    pub mix_staff_height: f64,
    pub mix_staff_dist: f64,
    pub harmony_y_pos: f64,
    pub hide_bar_number: bool,
    pub initial_key_time: bool,
    pub show_key_change_jp: bool,
    pub jp_key_jianpu_font: bool,
    pub musicpp_jp_time_sig: bool,
    pub musicpp_hwid_glyphs: bool,
    pub line_widths: LineWidths,
    pub barline_dist: f64,
    pub slur_stem_dy: f64,
    /// 歌词标点挤压档（样式键 `lrc-punct-compress`）
    pub punct_compress: String,
    pub chinese_hyphen: bool,
    pub melody_only: bool,
    pub text_line_height_by_size: bool,
    pub harmony_size: f64,
    pub chord_plain: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accidental_side: Option<String>,
    pub accidental_style: String,
    pub accidental_scale: f64,
    pub page: Option<StaffPage>,
    pub header_fonts: HeaderFonts,
    pub staff_size_mm: Option<f64>,
    pub lyric_pt: Option<f64>,
    pub verse_numbers: String,
    pub verse_number_auto_min: f64,
    pub verse_label_by_ink: bool,
    pub source_breaks: bool,
    pub stack_gap: f64,
    pub jp_grace_scale: f64,
    pub cue_size: f64,
    pub grace_size: f64,
    pub music_font: Font,
    pub jianpu_font: Font,
    pub word_font: String,
}

impl Default for MixedOptions {
    fn default() -> Self {
        MixedOptions {
            mix_staff_height: 30.0,
            mix_staff_dist: 5.0,
            harmony_y_pos: -60.0,
            hide_bar_number: false,
            initial_key_time: true,
            show_key_change_jp: true,
            jp_key_jianpu_font: false,
            musicpp_jp_time_sig: false,
            musicpp_hwid_glyphs: false,
            line_widths: LineWidths { staff: 1.0, jp_beam: 1.0, leger: 1.5, stem: 1.0, beam: 5.0, heavy_barline: 5.0, light_barline: 1.5 },
            barline_dist: 5.0,
            slur_stem_dy: 15.0,
            punct_compress: "clreq".into(),
            chinese_hyphen: false,
            melody_only: false,
            text_line_height_by_size: false,
            harmony_size: 9.0,
            chord_plain: false,
            accidental_side: None,
            accidental_style: "csym".into(),
            accidental_scale: 0.75,
            page: None,
            header_fonts: HeaderFonts::new(),
            staff_size_mm: None,
            lyric_pt: None,
            verse_numbers: "always".into(),
            verse_number_auto_min: 3.0,
            verse_label_by_ink: true,
            source_breaks: false,
            stack_gap: STACK_GAP_DEFAULT,
            jp_grace_scale: 0.6,
            cue_size: 0.8,
            grace_size: 0.65,
            music_font: Font::new("Bravura", 40.0),
            jianpu_font: Font::new(JP_FONT_FAMILY, 30.0),
            word_font: "Times New Roman".into(),
        }
    }
}

impl MixedOptions {
    /// 谱表上那层简谱用的字：`jianpuFont` 按 `mixStaffHeight / 40` 缩小（派生量，样式表不单独设它）。
    pub fn mix_font(&self) -> Font {
        self.jianpu_font.with_size((self.jianpu_font.size * self.mix_staff_height) / 40.0)
    }
}

/// 缺省的五线谱样式表：staff 主题、`engine: staff`。
pub fn default_staff_style() -> StyleSheet {
    compute_style_for_paper(&[theme(ThemeId::Staff)], &ctx(&[("engine", Value::String("staff".into()))]))
}

/// `staffOptionsOf`：出厂选项再落样式表（不给 = 缺省五线谱样式表）。
pub fn staff_options_of(style: Option<&StyleSheet>) -> MixedOptions {
    let mut o = MixedOptions::default();
    match style {
        Some(s) => apply_staff_style(&mut o, s),
        None => apply_staff_style(&mut o, &default_staff_style()),
    }
    o
}

pub fn apply_staff_style(o: &mut MixedOptions, sheet: &StyleSheet) {
    apply_fonts(o, sheet);
    o.header_fonts = header_fonts_of(sheet);
    let staff = |k: &str| sheet.staff().and_then(|s| s.get(k)).and_then(Value::as_f64);
    o.staff_size_mm = staff("size");
    o.lyric_pt = staff("lyricSize");
    let em = o.music_font.size;
    let lc = LengthContext { em, sp: em / 4.0, pt: Some(f64::NAN) };
    let mut doc = serde_json::to_value(&*o).expect("MixedOptions 可序列化");
    apply_overrides(&mut doc, sheet.staff_overrides(), STAFF_KEYS, lc);
    apply_overrides(&mut doc, sheet.jianpu_overrides(), JIANPU_KEYS, lc);
    *o = serde_json::from_value(doc).expect("override 值的种类由键表保证");
}

/// 角色 → 字体字段：`smufl` → `musicFont`、`note` → `jianpuFont`、`chord` → `wordFont`（只要族名）。
fn apply_fonts(o: &mut MixedOptions, sheet: &StyleSheet) {
    let fam = FamilyMap::new();
    for def in &ROLE_FONTS {
        let Some(field) = def.mixed else { continue };
        if !truthy(sheet.role(def.role)) {
            continue;
        }
        if def.mixed_family_only {
            if let Some((family, _)) = family_of_role(sheet, def.role, &fam) {
                if !family.is_empty() {
                    o.word_font = family;
                }
            }
            continue;
        }
        let size = size_of(sheet, def.role);
        let slot = match field {
            "musicFont" => &mut o.music_font,
            _ => &mut o.jianpu_font,
        };
        *slot = font_of_role(sheet, def.role, slot, size, &fam);
    }
}

/// 角色字号。五线谱这一路的字号是 tenths，只收裸数字与 em/sp（em 按 40 的出厂基准折）。
fn size_of(sheet: &StyleSheet, role: &str) -> Option<f64> {
    let v = sheet.role_prop(role, "size")?;
    let n = match v {
        Value::Number(n) => n.as_f64(),
        _ => resolve_length(v, LengthContext { em: 40.0, sp: 10.0, pt: Some(f64::NAN) }),
    }?;
    (n.is_finite() && n > 0.0).then_some(n)
}

/// 逻辑键 → `MixedOptions` 字段（可带一级子路径）。按 JSON 落值，字段名同 TS。值不对的照 TS 忽略。
fn apply_overrides(doc: &mut Value, ov: Option<&Map<String, Value>>, table: &'static [(&'static str, KeyDef)], lc: LengthContext) {
    let Some(ov) = ov else { return };
    for (k, v) in ov {
        let Some(def) = lookup(table, k) else { continue };
        let Some(path) = def.mixed else { continue };
        let (head, sub) = match path.split_once('.') {
            Some((h, s)) => (h, Some(s)),
            None => (path, None),
        };
        let val = match def.kind {
            KeyKind::Bool if v.is_boolean() => v.clone(),
            KeyKind::Word if v.is_string() => v.clone(),
            KeyKind::Bool | KeyKind::Word => continue,
            // 裸数字就是 tenths（原样落值）；带单位只收 em / sp
            KeyKind::Len | KeyKind::Num => match v {
                Value::Number(_) => v.clone(),
                _ => match resolve_length(v, lc) {
                    Some(n) => num(n),
                    None => continue,
                },
            },
        };
        let root = doc.as_object_mut().expect("MixedOptions 是对象");
        match sub {
            Some(sub) => {
                if let Some(t) = root.get_mut(head).and_then(Value::as_object_mut) {
                    t.insert(sub.to_string(), val);
                }
            }
            None => {
                root.insert(head.to_string(), val);
            }
        }
    }
}
