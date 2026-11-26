//! 简谱尺子的折算（照 `style/jianpu.ts`）：computed [`StyleSheet`] → [`JianpuStyle`]。**全仓只此一处**（成书另由 [`crate::book`] 出同一类型）。
//!
//! 顺序：出厂（[`default_jianpu_style`]）→ 前景色 / 标题 / 词曲字号 → 预设（`jianpu.preset`）→ 角色字体 → `jianpu.overrides`。
//! 预设里的公式**原样保留**（常量改存比例会出浮点尾差）。
//!
//! 认不出 / 不支持 / 值不对的 override 照 TS 忽略（TS 打一条 console.warn，这里不报：`.ss` 解析期已拒收认不出的键）。

use crate::book::book_jianpu_style;
use crate::fonts::{family_of_role, FamilyMap};
use crate::header::header_fonts_of;
use crate::jianpudefault::default_jianpu_style;
use crate::jianpustyle::{JianpuStyle, Margin};
use crate::keys::{lookup, KeyKind, JIANPU_KEYS, ROLE_FONTS};
use crate::paper::page_margins;
use crate::sheet::StyleSheet;
use crate::themes::PPTX_PAGE;
use crate::units::{resolve_length, LengthContext};
use crate::value::{get_path, num};
use dolce_model::base::js;
use dolce_text::MeasureCtx;
use serde_json::Value;

/// 标题/词曲字号 ÷ 音符字号。投影档取投影片出厂那三个数的比；简谱档照 500 首成书实测（标题 22.03、署名 10.98、音符 12.08）。
fn head_ratios(sheet: &StyleSheet) -> (f64, f64) {
    if preset_of(sheet) == Some("original") {
        (22.03 / 12.08, 10.98 / 12.08)
    } else {
        (PPTX_PAGE.title_size / PPTX_PAGE.font_size, PPTX_PAGE.credit_size / PPTX_PAGE.font_size)
    }
}

fn preset_of(sheet: &StyleSheet) -> Option<&str> {
    sheet.jianpu_preset().and_then(Value::as_str)
}

/// 角色字号（pt）。`note` 是 em 的基准、只认 pt；别的角色写 em 就是音符字号的几倍，折出来落到整数或 .5。
fn role_pt(sheet: &StyleSheet, role: &str, note_pt: f64) -> Option<f64> {
    let v = sheet.role_prop(role, "size")?;
    let pt = resolve_length(v, LengthContext { em: note_pt, sp: f64::NAN, pt: None })?;
    if !pt.is_finite() || pt <= 0.0 {
        return None;
    }
    let is_em = v.as_str().is_some_and(|s| s.ends_with("em"));
    Some(if is_em { js::round(pt * 2.0) / 2.0 } else { pt })
}

/// 成书预设的 `sheet.book`（BookStyle）。
fn book_of(sheet: &StyleSheet) -> Option<&Value> {
    sheet.book().filter(|b| crate::sheet::truthy(Some(b)))
}

/// 排版器的构造字号。成书取歌词那一档，其余取音符字号。
pub fn jianpu_font_size(sheet: &StyleSheet) -> f64 {
    if preset_of(sheet) == Some("book") {
        if let Some(b) = book_of(sheet) {
            return get_path(b, &["roles", "lyric", "size"]).and_then(Value::as_f64).unwrap_or(f64::NAN);
        }
    }
    role_pt(sheet, "note", f64::NAN).unwrap_or(PPTX_PAGE.font_size)
}

/// 字号、标题、词曲的实际值（`jianpuSizes`）：给了就用；简谱档没给就按出厂比例派生。
pub fn jianpu_sizes(sheet: &StyleSheet) -> (f64, f64, f64) {
    let font_size = jianpu_font_size(sheet);
    let (rt, rc) = head_ratios(sheet);
    let title = role_pt(sheet, "title", font_size).unwrap_or_else(|| js::round(font_size * rt));
    let credit = role_pt(sheet, "credit", font_size).unwrap_or_else(|| js::round(font_size * rc));
    (font_size, title, credit)
}

/// `jianpuStyleOf`。`book` 预设要量字（附点大小），故带量字上下文；别的预设不量。
pub fn jianpu_style_of(sheet: &StyleSheet, mc: &MeasureCtx) -> Result<JianpuStyle, String> {
    let preset = preset_of(sheet).unwrap_or("default");
    let mut st;
    if preset == "book" {
        let book = book_of(sheet).ok_or("book 预设缺 BookStyle")?;
        st = book_jianpu_style(book, mc);
    } else {
        st = default_jianpu_style(jianpu_font_size(sheet));
        if let Some(ink) = sheet.page().get("ink").and_then(Value::as_f64) {
            st.page.color = ink;
        }
        if preset != "default" {
            let (_, title, credit) = jianpu_sizes(sheet);
            st.header.title.size = title;
            st.header.credit.size = credit;
        }
        // 副标题与经文没单独给字号的跟词曲走
        st.header.subtitle.size = st.header.credit.size;
        st.header.scripture.size = st.header.credit.size;
        let hf = header_fonts_of(sheet);
        for role in ["title", "subtitle", "credit", "scripture"] {
            let Some(f) = hf.get(role) else { continue };
            let h = st.header.get_mut(role).expect("页眉四项");
            if let Some(fam) = &f.family {
                h.family = Some(fam.clone());
            }
            if let Some(b) = f.bold {
                h.bold = Some(b);
            }
            // 标题与词曲的字号以上面那两个为准；副标题与经文的字号给了才用
            if let Some(sz) = f.size {
                if role == "subtitle" || role == "scripture" {
                    h.size = sz;
                }
            }
        }
        if preset == "original" {
            // 简谱档的出厂值都在样式表里（print 主题，照 500 首、em 口径）：这里只把角色字号落进尺子。
            if let Some(mg) = page_margins(sheet.page()) {
                st.page.margin = Margin { top: mg[0], right: mg[1], bottom: mg[2], left: mg[3] };
            }
            let em = st.size.note;
            let role = |r: &str, fallback: f64| role_pt(sheet, r, em).unwrap_or(fallback);
            st.size.lyric = role("lyric", st.size.lyric);
            st.size.verse_num = role("verseNum", st.size.verse_num);
            st.size.key_meter = role("keyMeter", st.size.key_meter);
            st.size.chord = role("chord", em * 0.6);
            // 房号字号同三连音数字（`tuplet` 角色）
            st.size.ending = role("tuplet", em * 0.65);
            st.size.section_word = role("sectionWord", st.size.chord);
            st.size.header = role("header", st.size.header);
        } else if preset == "pptx" {
            apply_pptx_preset(&mut st);
            // 投影档的歌词缺省同音符字号；样式表写了 `lyric { size }` 就用它
            if sheet.role_prop("lyric", "size").is_some() {
                st.size.lyric = role_pt(sheet, "lyric", st.size.note).unwrap_or(st.size.lyric);
            }
        }
    }
    apply_fonts(&mut st, sheet);
    apply_overrides(&mut st, sheet);
    Ok(st)
}

/// 角色 → 字体族与字重（`note` → 数字、`lyric` → 歌词、`smufl` → 记号）。**字号不动**。
fn apply_fonts(st: &mut JianpuStyle, sheet: &StyleSheet) {
    for def in &ROLE_FONTS {
        let Some(field) = def.jianpu else { continue };
        let Some((family, bold)) = family_of_role(sheet, def.role, &FamilyMap::new()) else { continue };
        let base = match field {
            "note" => &mut st.font.note,
            "lyric" => &mut st.font.lyric,
            "text" => &mut st.font.text,
            _ => &mut st.font.smufl,
        };
        if !family.is_empty() {
            base.family = family;
        }
        base.bold = bold || base.bold;
    }
}

/// `@jianpu` 的逻辑键 → `JianpuStyle` 的路径（键表的 `jianpu` 一列）。em = 音符字号，sp = 名义谱高 / 3。
/// 按路径落值走 JSON（字段名同 TS），值的种类由键表保证。
fn apply_overrides(st: &mut JianpuStyle, sheet: &StyleSheet) {
    let Some(ov) = sheet.jianpu_overrides() else { return };
    let em = st.size.note;
    let ctx = LengthContext { em, sp: em / 3.0, pt: None };
    let mut doc = serde_json::to_value(&*st).expect("JianpuStyle 可序列化");
    for (k, v) in ov {
        let Some(def) = lookup(JIANPU_KEYS, k) else { continue };
        let Some(path) = def.jianpu else { continue };
        let (group, field) = path.split_once('.').expect("键表路径是 组.字段");
        let val = match def.kind {
            KeyKind::Bool => match v {
                Value::Bool(_) => v.clone(),
                _ => continue,
            },
            KeyKind::Word => match v {
                Value::String(_) => v.clone(),
                _ => continue,
            },
            KeyKind::Len | KeyKind::Num => match resolve_length(v, ctx) {
                Some(n) => num(n * def.jianpu_scale.unwrap_or(1.0)),
                None => continue,
            },
        };
        if let Some(rec) = doc.get_mut(group).and_then(Value::as_object_mut) {
            rec.insert(field.to_string(), val);
        }
    }
    *st = serde_json::from_value(doc).expect("override 值的种类由键表保证");
}

/// 「PPT 版面」档：投影 / 导出 .pptx 用的那一档（编辑器的默认档）。只固定那些本来就没有 UI 的**笔画类**常量；
/// 几处刻意背离老档的取舍见 TS 原文注释（小节线上下缘用简谱档那一份、三种点同大……）。
fn apply_pptx_preset(st: &mut JianpuStyle) {
    let em = st.size.note;
    // 音符数字不加粗：投影那一档的观感是既有的，简谱档才照印刷谱加粗
    st.look.note_bold = false;
    // 小节线细线 1.5；终止线的粗线 3.5
    st.stroke.barline = 1.5;
    st.stroke.final_barline = 3.5;
    // 减时线：线宽 em/20（量自 2019 年那批成品 .pptx）
    st.stroke.beam = em / 20.0;
    // 临时记号小一号（用户口径：「投影档的升号偏大」）
    st.look.accidental_scale = 0.75;
    // 拍号只留分数线粗细
    st.stroke.time_sig_rule = 1.5;
    // 附点 / 高音点 / 低音点三者同大（用户口径）：⌀2r = em/7.5
    st.dot.octave = em / 15.0;
    st.dot.aug = em / 15.0;
    // 弧线：旧版厚 4、无描边，没有高度上下限、没有扁平长连音线
    st.stroke.slur = 4.0;
    st.stroke.slur_outline = 0.0;
    st.arc.max_height = 0.0;
    st.arc.min_height = 0.0;
    st.arc.flat_span = -1.0;
    st.arc.flat_notes = 0.0;
    st.arc.flat_ratio = 0.0;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cascade::ctx;
    use crate::themes::{compute_style_for_paper, theme, ThemeId};

    struct NoMeasure;
    impl dolce_text::TextMeasurer for NoMeasure {
        fn glyph(&self, _: &str, _: &str, _: f64, _: dolce_text::Weight, _: &[String], _: dolce_text::FontStyle) -> dolce_text::TextMetrics {
            unreachable!("非成书预设不量字")
        }
        fn positions(&self, _: &str, _: &str, _: f64, _: dolce_text::Weight, _: &[String]) -> dolce_text::Positions {
            unreachable!()
        }
        fn font_metrics(&self, _: &str, _: f64, _: dolce_text::Weight, _: dolce_text::FontStyle) -> dolce_text::FontMetrics {
            unreachable!()
        }
        fn path_bounds(&self, _: &str) -> dolce_model::base::geom::Rect {
            unreachable!()
        }
    }

    fn sheet(id: ThemeId, mode: &str) -> StyleSheet {
        compute_style_for_paper(&[theme(id)], &ctx(&[("mode", Value::String(mode.into()))]))
    }

    #[test]
    fn presets() {
        let m = NoMeasure;
        let mc = MeasureCtx::new(&m);
        // 投影档：数字不加粗、三种点同大、弧退回裸公式
        let p = jianpu_style_of(&sheet(ThemeId::Projection, "expanded"), &mc).unwrap();
        assert!(!p.look.note_bold);
        assert_eq!(p.dot.octave, p.size.note / 15.0);
        assert_eq!(p.arc.flat_span, -1.0);
        // 简谱档：音符 12pt，和弦等按 em 折到 .5
        let o = jianpu_style_of(&sheet(ThemeId::Print, "original"), &mc).unwrap();
        assert_eq!(o.size.note, 12.0);
        assert!(o.look.note_bold);
        assert_eq!((o.size.chord * 2.0).fract(), 0.0);
        // 认不出 / 不支持的键照忽略，值不对的也忽略
        let mut s = sheet(ThemeId::Print, "original");
        s.0["jianpu"]["overrides"] = serde_json::json!({ "nope": 1.0, "note-bold": "x", "beam-width": "0.1em" });
        let b = jianpu_style_of(&s, &mc).unwrap();
        assert!(b.look.note_bold);
        assert_eq!(b.stroke.beam, 0.1 * b.size.note);
    }
}
