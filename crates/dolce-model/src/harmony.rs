//! 结构化和弦符号 → 和弦文本（同 `src/score/harmonyparse.ts`）。与 `harmonyxml.ts::kindOf` 互逆。

use crate::doc::{DegreeType, Harmony, HarmonyStep};
use dolce_base::js;

/// kind 值 → 后缀。
fn kind_suffix(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "major" => "",
        "minor" => "m",
        "dominant" => "7",
        "major-seventh" => "maj7",
        "minor-seventh" => "m7",
        "diminished" => "dim",
        "diminished-seventh" => "dim7",
        "augmented" => "aug",
        "suspended-fourth" => "sus4",
        "suspended-second" => "sus2",
        "major-sixth" => "6",
        "minor-sixth" => "m6",
        "dominant-ninth" => "9",
        "major-ninth" => "maj9",
        "minor-ninth" => "m9",
        "half-diminished" => "m7-5",
        "power" => "5",
        "none" => "",
        "other" => "",
        _ => return None,
    })
}

fn sign(v: f64, unicode: bool) -> String {
    let (up, down) = if unicode { ("♯", "♭") } else { ("#", "b") };
    if v > 0.0 {
        up.repeat(js::repeat_count(v))
    } else if v < 0.0 {
        down.repeat(js::repeat_count(-v))
    } else {
        String::new()
    }
}

fn step_alter(sa: &HarmonyStep, unicode: bool) -> String {
    if sa.alter_left == Some(true) {
        sign(sa.alter, unicode) + &sa.step
    } else {
        sa.step.clone() + &sign(sa.alter, unicode)
    }
}

/// `Harmony` → 文本。升降号缺省写 ASCII（`#`/`b`，123/ABC 的和弦串认它）；`unicode` 印 `♯♭`。有原文 `text` 时直接用原文。
pub fn harmony_to_text(h: &Harmony, unicode: bool) -> String {
    if let Some(t) = &h.text {
        return t.clone();
    }
    let mut out = step_alter(&h.root, unicode);
    let kt = h.kind_text.as_deref().map(js::trim).unwrap_or("");
    out += if !kt.is_empty() { kt } else { kind_suffix(&h.kind).unwrap_or("") };
    for d in h.degrees.iter().flatten() {
        let v = js::num_to_string(d.value);
        match d.kind {
            DegreeType::Subtract => out += &format!("omit{v}"),
            DegreeType::Alter => out += &format!("{}{v}", sign(d.alter, unicode)),
            _ => out += &format!("add{}{v}", sign(d.alter, unicode)),
        }
    }
    if let Some(b) = &h.bass {
        out += "/";
        out += &step_alter(b, unicode);
    }
    out
}

/// 前置升降号（`#Fm`、`D/#F`）折成后置（`F#m`、`D/F#`）。
pub fn chord_suffix_form(text: &str) -> String {
    let t = js::trim(text);
    let is_acc = |c: char| matches!(c, '#' | '♯' | 'b' | '♭');
    let is_step = |c: char| ('A'..='G').contains(&c);
    let mut cs: Vec<char> = t.chars().collect();
    if cs.len() >= 2 && is_acc(cs[0]) && is_step(cs[1]) {
        cs.swap(0, 1);
    }
    // 第一处 `/` + 前置升降号
    if let Some(i) = (0..cs.len()).find(|&i| cs[i] == '/' && i + 2 < cs.len() && is_acc(cs[i + 1]) && is_step(cs[i + 2])) {
        cs.swap(i + 1, i + 2);
    }
    cs.into_iter().collect()
}

/// 和弦文字开头的「字母 + 升降号」，前置后置都认。`left` = 升降号写在字母前面；`len` 是 UTF-16 长度。
#[derive(Clone, Debug, PartialEq)]
pub struct ChordStepAlter {
    pub step: char,
    pub acc: String,
    pub left: bool,
    pub len: usize,
}

pub fn chord_step_alter(s: &str) -> Option<ChordStepAlter> {
    let mut cs = s.chars();
    let c0 = cs.next()?;
    let c1 = cs.next();
    let is_acc = |c: char| matches!(c, '#' | '♯' | 'b' | '♭');
    let is_step = |c: char| ('A'..='G').contains(&c);
    if is_acc(c0) && c1.is_some_and(is_step) {
        return Some(ChordStepAlter { step: c1.unwrap(), acc: c0.to_string(), left: true, len: 2 });
    }
    if is_step(c0) {
        let acc = c1.filter(|c| is_acc(*c)).map(|c| c.to_string()).unwrap_or_default();
        let len = 1 + acc.encode_utf16().count();
        return Some(ChordStepAlter { step: c0, acc, left: false, len });
    }
    None
}
