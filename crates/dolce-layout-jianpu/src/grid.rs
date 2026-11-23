//! 简谱引擎的栅格与谱面自带的版面指令（照 `layout/jianpu/metrics.ts`）。
//!
//! 样式值只有一把尺子 [`JianpuStyle`]；这里只剩原版（番茄）量来的那套栅格，按音符字号等比缩放（数字字号 25 时：
//! 同拍前后都带减时线 25、其余音符之间 37.5、音符与小节线之间 35、每个附点 +12.5）。

use std::collections::HashMap;

use dolce_engrave::accidental::AccidentalKind;
use dolce_engrave::arc::{arc_height, SlurStyle};
use dolce_engrave::grace::{GraceMetrics, GraceNote};
use dolce_engrave::stack::{high_dot_y, low_dot_y, StackStyle};
use dolce_style::jianpustyle::{JianpuStyle, Margin};
use dolce_text::{Font, MeasureCtx};
use dolce_view::ast::NoteElement;
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq)]
pub struct PageGrid {
    pub width: f64,
    pub height: f64,
    pub margin: Margin,
    /// 连续长图：不按纸张分页，整份谱排成一张，页高随内容增长
    pub long_image: bool,
    /// 版心第一行音符基线相对上边距的偏移
    pub first_system_top: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NoteGrid {
    pub note_step: f64,
    pub beamed_note_step: f64,
    pub barline_space: f64,
    pub aug_dot_step: f64,
    /// 减时线左右各伸出锚点多少
    pub beam_half_span: f64,
    /// 源码里 `+` 抬高级别每级上移多少
    pub level_step: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HeadGrid {
    pub title_baseline: f64,
    pub credit_baseline: f64,
    pub credit_line_height: f64,
    pub key_meter_baseline: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct InkGrid {
    /// 数字「1」的墨迹高：纵向栅格的内部单位
    pub note_height: f64,
    /// 数字上下那一摞的取尺（空已乘好墨迹高）
    pub stack: StackStyle,
}

/// 定稿栅格（TS `JianpuGrid`）：栅格 + 尺子（点半径已按字形量好）+ 按数字字体实测的派生量。
#[derive(Clone, Debug, PartialEq)]
pub struct JianpuGrid {
    pub page: PageGrid,
    pub note: NoteGrid,
    pub head: HeadGrid,
    pub style: JianpuStyle,
    pub ink: InkGrid,
}

/// 纸：宽高（pt；长图的高只是占位）与是不是长图。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GridPage {
    pub width: f64,
    pub height: f64,
    pub continuous: bool,
}

/// 栅格量版时的数字字号
const GRID_NOTE_SIZE: f64 = 25.0;

/// 音符字体（数字）：家族取尺子、粗细取 `look.noteBold`
pub fn note_font(style: &JianpuStyle, size: f64) -> Font {
    Font { family: style.font.note.family.clone(), size, bold: style.look.note_bold, italic: false }
}

/// 尺子 + 纸 → 定稿栅格（`gridOf`）。
pub fn grid_of(src: &JianpuStyle, page: GridPage, mc: &MeasureCtx) -> JianpuGrid {
    let mut style = src.clone();
    let nf = note_font(&style, style.size.note);
    if style.dot.octave.is_nan() || style.dot.octave <= 0.0 {
        let b = nf.char_bound(mc, ".");
        style.dot.octave = (b.bottom - b.top) / 2.0;
    }
    if style.dot.aug.is_nan() || style.dot.aug <= 0.0 {
        style.dot.aug = style.dot.octave;
    }
    if style.dot.repeat.is_nan() || style.dot.repeat <= 0.0 {
        style.dot.repeat = style.dot.octave;
    }
    let k = style.size.note / GRID_NOTE_SIZE;
    let mut head = HeadGrid { title_baseline: 110.0 * k, credit_baseline: 175.0 * k, credit_line_height: 21.0 * k, key_meter_baseline: 176.0 * k };
    head.credit_line_height = dolce_base::js::max(head.credit_line_height, style.header.credit.size * (21.0 / 16.0));
    let one = note_font(&style, 100.0).char_bound(mc, "1");
    let h = (one.bottom - one.top).abs();
    let note_height = style.size.note * ((if h == 0.0 || h.is_nan() { 71.0 } else { h }) / 100.0);
    JianpuGrid {
        page: PageGrid { width: page.width, height: page.height, margin: style.page.margin.clone(), long_image: page.continuous, first_system_top: 156.0 * k },
        note: NoteGrid {
            note_step: 37.5 * k,
            beamed_note_step: 25.0 * k,
            barline_space: 35.0 * k,
            aug_dot_step: 12.5 * k,
            beam_half_span: 6.0 * k,
            level_step: 6.0 * k,
        },
        head,
        ink: InkGrid { note_height, stack: StackStyle { gap: style.vertical.stack_gap * note_height, dot_radius: style.dot.octave, beam_width: style.stroke.beam } },
        style,
    }
}

impl JianpuGrid {
    /// 与 TS `JianpuGrid` 同形的 JSON（对拍用）
    pub fn to_json(&self) -> Value {
        let mg = |m: &Margin| json!({ "top": m.top, "right": m.right, "bottom": m.bottom, "left": m.left });
        json!({
            "page": { "width": self.page.width, "height": self.page.height, "margin": mg(&self.page.margin), "longImage": self.page.long_image, "firstSystemTop": self.page.first_system_top },
            "note": { "noteStep": self.note.note_step, "beamedNoteStep": self.note.beamed_note_step, "barlineSpace": self.note.barline_space,
                      "augDotStep": self.note.aug_dot_step, "beamHalfSpan": self.note.beam_half_span, "levelStep": self.note.level_step },
            "head": { "titleBaseline": self.head.title_baseline, "creditBaseline": self.head.credit_baseline, "creditLineHeight": self.head.credit_line_height, "keyMeterBaseline": self.head.key_meter_baseline },
            "style": serde_json::to_value(&self.style).unwrap_or(Value::Null),
            "ink": { "noteHeight": self.ink.note_height, "stack": { "gap": self.ink.stack.gap, "dotRadius": self.ink.stack.dot_radius, "beamWidth": self.ink.stack.beam_width } },
        })
    }
}

/// 小节线上下缘（相对数字墨迹中线）
pub fn barline_span(m: &JianpuGrid) -> (f64, f64) {
    let base = m.ink.note_height / 2.0;
    let h = m.style.vertical.barline_height;
    (base - h * 0.75, base + h * 0.25)
}

/// 转调标签字号：同和弦；不排和弦的档取歌词字号的 0.6
pub fn key_label_size(m: &JianpuGrid) -> f64 {
    if m.style.size.chord > 0.0 {
        m.style.size.chord
    } else {
        m.style.size.lyric * 0.6
    }
}

/// 括线线宽：尺子给了 `bracket` 就用它，否则同小节线
pub fn bracket_line_width(m: &JianpuGrid) -> f64 {
    if m.style.stroke.bracket > 0.0 {
        m.style.stroke.bracket
    } else {
        m.style.stroke.barline
    }
}

/// 音符堆叠与挂在它上面的记号之间让的空
pub fn note_mark_gap(m: &JianpuGrid) -> f64 {
    m.ink.stack.gap
}

/// 版心宽度
pub fn content_width(m: &JianpuGrid) -> f64 {
    m.page.width - m.page.margin.left - m.page.margin.right
}

// ---------------- 谱面自带的版面指令 ----------------

/// `FontSize: T2=65%;TL=80%` → 键（小写）→ 比例
pub fn parse_font_sizes(lines: &[String]) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    for line in lines {
        for (key, num) in font_size_pairs(line) {
            let pct: f64 = num.parse().unwrap_or(f64::NAN);
            if pct > 0.0 && pct < 1000.0 {
                out.insert(key.to_ascii_lowercase(), pct / 100.0);
            }
        }
    }
    out
}

/// `Margin: left=100;top=30` → pt
pub fn parse_margins(lines: &[String]) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    for line in lines {
        for (key, num) in margin_pairs(line) {
            let v: f64 = num.parse().unwrap_or(f64::NAN);
            if v.is_finite() && (0.0..=400.0).contains(&v) {
                out.insert(key.to_ascii_lowercase(), v);
            }
        }
    }
    out
}

// 下面两个手写扫描与正则同义（开机那份 wasm 不带正则引擎），`\s` 同正则按 Unicode 空白。

/// 跳过空白，回下一个非空白的位置。
fn skip_ws(s: &str, i: usize) -> usize {
    s[i..].char_indices().find(|(_, c)| !c.is_whitespace()).map_or(s.len(), |(k, _)| i + k)
}

/// 从 `i` 起的 `-?[0-9]+(?:\.[0-9]+)?`（`neg` 允许负号）到哪。
fn decimal_end(b: &[u8], i: usize, neg: bool) -> Option<usize> {
    let digits = |mut j: usize| {
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        j
    };
    let j = if neg && b.get(i) == Some(&b'-') { i + 1 } else { i };
    let mut e = digits(j);
    if e == j {
        return None;
    }
    if b.get(e) == Some(&b'.') && b.get(e + 1).is_some_and(u8::is_ascii_digit) {
        e = digits(e + 1);
    }
    Some(e)
}

/// 同正则 `([A-Za-z][A-Za-z0-9]*)\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*%` 逐个匹配的两个分组。
fn font_size_pairs(s: &str) -> Vec<(&str, &str)> {
    let b = s.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        let hit = (|| {
            if !b[i].is_ascii_alphabetic() {
                return None;
            }
            let mut k = i + 1;
            while k < b.len() && b[k].is_ascii_alphanumeric() {
                k += 1;
            }
            let eq = skip_ws(s, k);
            if b.get(eq) != Some(&b'=') {
                return None;
            }
            let n0 = skip_ws(s, eq + 1);
            let n1 = decimal_end(b, n0, false)?;
            let pct = skip_ws(s, n1);
            (b.get(pct) == Some(&b'%')).then(|| ((&s[i..k], &s[n0..n1]), pct + 1))
        })();
        match hit {
            Some((pair, end)) => {
                out.push(pair);
                i = end;
            }
            None => i += s[i..].chars().next().map_or(1, char::len_utf8),
        }
    }
    out
}

/// 同正则 `(?i)(?-u:\b)(left|right|top|bottom)\s*=\s*(-?[0-9]+(?:\.[0-9]+)?)` 逐个匹配的两个分组（词界按 ASCII）。
fn margin_pairs(s: &str) -> Vec<(&str, &str)> {
    let b = s.as_bytes();
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        let hit = (|| {
            if i > 0 && word(b[i - 1]) {
                return None;
            }
            let kw = ["left", "right", "top", "bottom"].into_iter().find(|w| b.len() >= i + w.len() && b[i..i + w.len()].eq_ignore_ascii_case(w.as_bytes()))?;
            let k = i + kw.len();
            let eq = skip_ws(s, k);
            if b.get(eq) != Some(&b'=') {
                return None;
            }
            let n0 = skip_ws(s, eq + 1);
            let n1 = decimal_end(b, n0, true)?;
            Some(((&s[i..k], &s[n0..n1]), n1))
        })();
        match hit {
            Some((pair, end)) => {
                out.push(pair);
                i = end;
            }
            None => i += s[i..].chars().next().map_or(1, char::len_utf8),
        }
    }
    out
}

/// 谱面自带的 `FontSize:` / `Margin:` 叠在尺子上（`applyDocOptions`）。
pub fn apply_doc_options(base: &JianpuStyle, font_sizes: &[String], margins: &[String], keep_margins: bool) -> JianpuStyle {
    let fs = parse_font_sizes(font_sizes);
    let mg = if keep_margins { HashMap::new() } else { parse_margins(margins) };
    let mut st = base.clone();
    if fs.is_empty() && mg.is_empty() {
        return st;
    }
    let all = fs.get("all").copied().unwrap_or(1.0);
    let k = |key: &str| fs.get(key).copied().unwrap_or(1.0) * all;
    st.header.title.size *= k("t");
    st.header.subtitle.size *= k("t2");
    st.header.scripture.size *= k("t2");
    st.header.credit.size *= k("z");
    st.size.header *= fs.get("tl").or(fs.get("tr")).copied().unwrap_or(1.0) * all;
    st.size.key_meter *= all;
    st.size.chord *= all;
    st.size.ending *= all;
    st.size.section_word *= all;
    st.size.words *= all;
    st.size.verse_num *= k("zs");
    let lyric_k = k("c");
    st.size.lyric *= lyric_k;
    st.vertical.lyric_baseline *= lyric_k;
    st.vertical.lyric_stack *= lyric_k;
    let note_k = fs.get("q").copied().unwrap_or(1.0);
    if note_k != 1.0 {
        st.size.note *= note_k;
        st.dot.octave *= note_k;
        st.dot.aug *= note_k;
        st.dot.repeat *= note_k;
        st.stroke.beam *= note_k;
        st.vertical.barline_height *= note_k;
        st.vertical.slur_gap *= note_k;
        st.arc.max_height *= note_k;
        st.arc.min_height *= note_k;
        if st.arc.flat_span > 0.0 {
            st.arc.flat_span *= note_k;
        }
    }
    if let Some(v) = mg.get("left") {
        st.page.margin.left = *v;
    }
    if let Some(v) = mg.get("right") {
        st.page.margin.right = *v;
    }
    if let Some(v) = mg.get("top") {
        st.page.margin.top = *v;
    }
    if let Some(v) = mg.get("bottom") {
        st.page.margin.bottom = *v;
    }
    st
}

/// 原样文档布局的弧线样式（绘制与纵向预留共用）
pub fn jianpu_slur_style(m: &JianpuGrid, color: f64) -> SlurStyle {
    let st = &m.style;
    SlurStyle {
        thickness: st.stroke.slur,
        color,
        height_scale: Some(st.arc.height_scale),
        outline_width: Some(st.stroke.slur_outline),
        max_height: Some(st.arc.max_height),
        min_height: Some(st.arc.min_height),
        flat_span: Some(if st.arc.flat_span < 0.0 {
            0.0
        } else if st.arc.flat_span == 0.0 || st.arc.flat_span.is_nan() {
            st.size.note * 5.0
        } else {
            st.arc.flat_span
        }),
        flat_ratio: Some(st.arc.flat_ratio),
        flat_line_width: Some(st.stroke.slur_flat),
        ..SlurStyle::default()
    }
}

/// 弧线实际占的头顶高度（纵向预留用）
pub fn jianpu_slur_rise(m: &JianpuGrid) -> f64 {
    arc_height(f64::INFINITY, &jianpu_slur_style(m, 0.0)) * 0.75
}

/// 公共倚音几何的度量
pub fn jianpu_grace_metrics(m: &JianpuGrid) -> GraceMetrics {
    let st = &m.style;
    GraceMetrics {
        ink: m.ink.note_height,
        scale: st.size.grace,
        octave_up_y: high_dot_y(-m.ink.note_height / 2.0, 0.0, &m.ink.stack),
        octave_down_y: low_dot_y(m.ink.note_height / 2.0, 0.0, 0.0, &m.ink.stack),
        octave_dot_gap: m.ink.stack.gap + 2.0 * st.dot.octave,
        octave_dot_radius: st.dot.octave,
        underline_gap: m.ink.stack.gap + st.stroke.beam,
        stack_gap: st.vertical.stack_gap,
    }
}

/// 音符元素 → 公共倚音几何要的那几个字段
pub fn jianpu_grace_notes(els: &[NoteElement]) -> Vec<GraceNote> {
    els.iter()
        .map(|gn| GraceNote {
            digit: gn.pitch.to_string(),
            octave: gn.octave as f64,
            duration: Some(gn.duration as f64),
            alter: gn.accidental.as_ref().and_then(|a| AccidentalKind::parse(a.as_str())),
        })
        .collect()
}

#[cfg(test)]
mod doc_option_tests {
    use super::*;

    fn cases(alpha: &[&str], seed: u64) -> Vec<String> {
        let mut x = seed;
        (0..4000)
            .map(|_| {
                let mut t = String::new();
                for _ in 0..(x % 16) {
                    x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                    t.push_str(alpha[((x >> 33) % alpha.len() as u64) as usize]);
                }
                t
            })
            .collect()
    }

    /// 与原正则逐个比（正则只留在 dev-dependencies）
    #[test]
    fn same_as_regex() {
        let fs = regex::Regex::new(r"([A-Za-z][A-Za-z0-9]*)\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*%").unwrap();
        let mg = regex::Regex::new(r"(?i)(?-u:\b)(left|right|top|bottom)\s*=\s*(-?[0-9]+(?:\.[0-9]+)?)").unwrap();
        let mut fs_cases = cases(&["T", "2", "L", "=", "6", "5", ".", "%", " ", "\u{3000}", ";", "汉", "_", "-"], 7);
        fs_cases.extend(["FontSize: T2=65%;TL=80%", "T2 = 65.5 %", "9ab=5%", "a=5.%", "x=1.2.3%", "名T=50%"].map(String::from));
        let mut mg_cases = cases(&["left", "Right", "TOP", "bottom", "x", "_", "=", "-", "1", ".", "0", " ", "\u{3000}", "汉", ";"], 11);
        mg_cases.extend(["Margin: left=100;top=30", "xleft=5", "_top=5", "汉top=5", "LEFT = -3.5", "lefty=5", "leftright=5", "top=1.", "bottom=-"].map(String::from));
        for c in &fs_cases {
            let want: Vec<(&str, &str)> = fs.captures_iter(c).map(|m| (m.get(1).unwrap().as_str(), m.get(2).unwrap().as_str())).collect();
            assert_eq!(font_size_pairs(c), want, "{c:?}");
        }
        for c in &mg_cases {
            let want: Vec<(&str, &str)> = mg.captures_iter(c).map(|m| (m.get(1).unwrap().as_str(), m.get(2).unwrap().as_str())).collect();
            assert_eq!(margin_pairs(c), want, "{c:?}");
        }
    }
}
