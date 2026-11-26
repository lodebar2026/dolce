//! 简谱尺子的出厂值（照 `style/jianpudefault.ts`）：样式表折算与成书折算共同的起点。

use crate::style::jianpustyle::*;

/// 数字上下叠层的空 ÷ 数字墨迹高的缺省（`engrave/stack.ts::STACK_GAP_DEFAULT`）。
pub const STACK_GAP_DEFAULT: f64 = 0.17;

/// 系统中文字体栈。
const CJK: &str = "PingFang SC, Microsoft YaHei, sans-serif";

/// 出厂那一份。绝对量（小节线 2、弧厚 6…）是按 fontSize≈28 调出来的 musicpp 口径，**默认值必须原样保持**。
pub fn default_jianpu_style(font_size: f64) -> JianpuStyle {
    JianpuStyle {
        font: JpFonts { note: FaceSpec::plain(CJK), lyric: FaceSpec::plain(CJK), text: FaceSpec::plain(CJK), smufl: FaceSpec::plain("Bravura") },
        header: JpHeader { title: HeaderFace::sized(48.0), subtitle: HeaderFace::sized(36.0), credit: HeaderFace::sized(36.0), scripture: HeaderFace::sized(36.0) },
        size: JpSize {
            note: font_size,
            lyric: font_size,
            chord: 0.0,
            key_meter: font_size,
            verse_num: font_size,
            ending: 0.0,
            section_word: 0.0,
            words: font_size,
            header: font_size,
            grace: 0.59,
            cue: 0.72,
        },
        stroke: JpStroke {
            barline: 2.0,
            final_barline: 3.5,
            beam: 1.5,
            slur: 6.0,
            slur_outline: 0.7,
            slur_flat: 0.0,
            hairpin: 0.0,
            time_sig_rule: 0.0,
            bracket: 0.0,
            double_barline_gap: 5.0,
        },
        dot: JpDot { octave: 0.0, aug: 0.0, repeat: 0.0 },
        vertical: JpVertical {
            stack_gap: STACK_GAP_DEFAULT,
            slur_gap: font_size / 6.0,
            lyric_baseline: 0.0,
            lyric_stack: 0.0,
            system_gap: 0.0,
            system_spread: font_size * 0.75,
            staff_dist: 0.0,
            voice_gap: 0.0,
            chord_gap: 0.0,
            bracket_foot: 0.0,
            staff_top: 0.0,
            staff_bottom: 0.0,
            barline_height: (font_size * 4.0) / 3.0,
        },
        arc: JpArc { height_scale: 1.0, max_height: 18.0, min_height: 10.0, flat_span: 0.0, flat_notes: 0.0, flat_ratio: 0.0 },
        spacing: JpSpacing { lyric_gap: 0.0, max_horizontal_scale: 2.0 },
        look: JpLook {
            note_bold: true,
            pair_pages: false,
            even_justify: None,
            no_intro: false,
            chord_plain: false,
            accidental_side: None,
            accidental_style: "csym".into(),
            accidental_scale: 1.0,
            punct_compress: "halfwidth".into(),
            tuplet_style: "bracket".into(),
            verse_numbers: "always".into(),
            verse_number_auto_min: 3.0,
            time_sig_digit_ratio: 0.0,
            time_sig_rule_len_ratio: 0.0,
        },
        page: JpPage { color: 4278190080.0, margin: Margin { top: font_size * 1.5, right: 50.0, bottom: font_size * 3.0, left: 50.0 } },
    }
}
