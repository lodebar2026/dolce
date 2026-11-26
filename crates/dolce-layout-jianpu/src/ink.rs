//! 定位用的墨迹量具（TS `InkMeasurer`，由 `compose/index.ts` 注入的那一组闭包）：排版这一层不直接碰字体，一律经它。

use dolce_engrave::chord::{chord_text_segs, harmony_ink, harmony_width};
use dolce_engrave::sectionword::section_word_run;
use dolce_engrave::spacing::AccidentalSide;
use dolce_engrave::Env;
use dolce_model::base::geom::Rect;
use dolce_engrave::text::syllable::syllable_run;
use dolce_engrave::text::{CompressMode, Font};
use dolce_model::view::ast::LyricSyllable;

use crate::grid::{key_label_size, note_font, JianpuGrid};
use crate::model::{InkBox, InkTextRole, LyricRun};

pub struct Ink<'a> {
    pub env: &'a Env<'a>,
    pub digit_font: Font,
    pub lyric_font: Font,
    pub chord_word: Font,
    pub chord_music: Font,
    section_word: Font,
    key_label: Font,
    ending: Font,
    words: Font,
    punct: CompressMode,
    chord_plain: bool,
    side: Option<AccidentalSide>,
    pub lyric_space: f64,
}

fn face(family: &str, size: f64) -> Font {
    Font { family: family.to_string(), size, bold: false, italic: false }
}

impl<'a> Ink<'a> {
    pub fn new(m: &JianpuGrid, env: &'a Env<'a>) -> Ink<'a> {
        let st = &m.style;
        let digit_font = note_font(st, st.size.note);
        let lyric_font = face(&st.font.lyric.family, st.size.lyric);
        let lyric_space = lyric_font.measure_text(env.mc, " ");
        Ink {
            env,
            chord_word: face(&st.font.text.family, st.size.chord),
            chord_music: face("Bravura", st.size.chord),
            section_word: face(&st.font.lyric.family, st.size.section_word),
            key_label: face(&st.font.text.family, key_label_size(m)),
            ending: digit_font.with_size(st.size.ending),
            words: face(&st.font.text.family, st.size.words),
            punct: CompressMode::parse(&st.look.punct_compress),
            chord_plain: st.look.chord_plain,
            side: AccidentalSide::parse(st.look.accidental_side.as_deref()),
            digit_font,
            lyric_font,
            lyric_space,
        }
    }

    pub fn role_font(&self, role: InkTextRole) -> &Font {
        match role {
            InkTextRole::SectionWord => &self.section_word,
            InkTextRole::Term | InkTextRole::Jump => &self.chord_word,
            InkTextRole::KeyLabel => &self.key_label,
            InkTextRole::Ending => &self.ending,
            InkTextRole::Words => &self.words,
        }
    }

    /// 歌词：量的是画出来的那串（字 + 尾随标点，挤压后）
    pub fn lyric(&self, syl: &LyricSyllable) -> LyricRun {
        let text = format!("{}{}", syl.text, syl.trailing_punctuation.as_deref().unwrap_or(""));
        let mc = self.env.mc;
        let f = &self.lyric_font;
        let run = syllable_run(&text, f, mc, self.punct);
        let chars: Vec<String> = text.chars().map(String::from).collect();
        let first = chars.first().cloned().unwrap_or_default();
        let last = chars.last().cloned().unwrap_or_default();
        let pen0 = run.xs.as_ref().and_then(|x| x.first().copied()).unwrap_or(0.0);
        let upto = match &run.xs {
            Some(xs) => xs[chars.len() - 1],
            None => f.measure_text(mc, &chars[..chars.len().saturating_sub(1)].concat()),
        };
        LyricRun {
            width: run.width,
            lead: run.lead,
            body: run.body,
            head_blank: if first.is_empty() { 0.0 } else { dolce_model::base::js::max(0.0, pen0 + f.char_bound(mc, &first).left) },
            tail_blank: if last.is_empty() { 0.0 } else { dolce_model::base::js::max(0.0, run.width - (upto + f.char_bound(mc, &last).right)) },
            text,
        }
    }

    /// 音符数字：字面宽与墨迹盒
    pub fn digit(&self, ch: &str) -> InkBox {
        InkBox { advance: self.digit_font.measure_text(self.env.mc, ch), ink: self.digit_font.char_bound(self.env.mc, ch) }
    }

    /// 和弦：字面宽与墨迹盒（空串墨迹为 None）
    pub fn chord(&self, text: &str) -> (f64, Option<Rect>) {
        let segs = chord_text_segs(text, self.chord_plain, self.side);
        (harmony_width(&segs, &self.chord_word, &self.chord_music, self.env), harmony_ink(&segs, &self.chord_word, &self.chord_music, self.env))
    }

    /// 角色字
    pub fn text(&self, s: &str, role: InkTextRole) -> InkBox {
        let f = self.role_font(role);
        InkBox { advance: f.measure_text(self.env.mc, s), ink: f.char_bound(self.env.mc, s) }
    }

    /// 段落词：量宽、逐字笔位与墨迹盒
    pub fn section_word(&self, s: &str) -> (f64, Option<Vec<f64>>, Rect) {
        let f = &self.section_word;
        let mc = self.env.mc;
        let (width, xs) = section_word_run(f, s, self.punct, self.env);
        let chars: Vec<String> = s.chars().map(String::from).collect();
        let mut ink = Rect::new(f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for (i, ch) in chars.iter().enumerate() {
            let b = f.char_bound(mc, ch);
            let x = match xs.as_ref().and_then(|v| v.get(i).copied()) {
                Some(v) => v,
                None if i == 0 => 0.0,
                None => f.measure_text(mc, &chars[..i].concat()),
            };
            ink.left = dolce_model::base::js::min(ink.left, x + b.left);
            ink.right = dolce_model::base::js::max(ink.right, x + b.right);
            ink.top = dolce_model::base::js::min(ink.top, b.top);
            ink.bottom = dolce_model::base::js::max(ink.bottom, b.bottom);
        }
        (width, xs, if chars.is_empty() { Rect::new(0.0, 0.0, 0.0, 0.0) } else { ink })
    }

    /// 数字 / 歌词字体的字体盒上下缘（相对基线，上为负）
    pub fn font_box(&self, note: bool) -> (f64, f64) {
        let fm = if note { &self.digit_font } else { &self.lyric_font }.metrics(self.env.mc);
        (fm.ascent, fm.descent)
    }

    /// SMuFL 字形的墨迹盒
    pub fn smufl(&self, glyph: &str, size: f64) -> Rect {
        face("Bravura", size).char_bound(self.env.mc, glyph)
    }
}
