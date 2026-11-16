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

// ───────────────────────── 和弦文字 → `<harmony>`（同 `score/harmonyxml.ts`）─────────────────────────

/// 和弦后缀 → MusicXML `<kind>`
pub fn kind_of(suffix: &str) -> &'static str {
    let s = suffix.to_lowercase();
    if s.is_empty() {
        return "major";
    }
    if s.starts_with('m') && !s.starts_with("maj") {
        return if s.contains('7') { "minor-seventh" } else { "minor" };
    }
    if s.starts_with("maj7") {
        return "major-seventh";
    }
    if s.starts_with("dim") {
        return "diminished";
    }
    if s.starts_with("aug") || s == "+" {
        return "augmented";
    }
    if s.starts_with("sus") {
        return "suspended-fourth";
    }
    match s.as_str() {
        "7" => "dominant",
        "6" => "major-sixth",
        "9" => "dominant-ninth",
        _ => "other",
    }
}

fn alter_of(acc: &str) -> f64 {
    match acc {
        "#" | "♯" => 1.0,
        "b" | "♭" => -1.0,
        _ => 0.0,
    }
}

/// `chord_step_alter` 认出的那段在 `s` 里的字节长度
fn sa_bytes(s: &str, sa: &ChordStepAlter) -> usize {
    let chars = if sa.left { 2 } else { 1 + usize::from(!sa.acc.is_empty()) };
    s.char_indices().nth(chars).map_or(s.len(), |(i, _)| i)
}

/// `"C♯m"` → `<harmony>` 树（解析不出根音就退回 `<direction><words>`）。`offset` 为本音符时值内的 divisions 数。
pub fn harmony_el(t: &mut dolce_xml::Tree, chord: &str, offset: f64, font_size: Option<f64>) -> dolce_xml::NodeId {
    use dolce_xml::Kid;
    let src = js::trim(chord);
    let fs = font_size.filter(|f| *f != 0.0 && !f.is_nan()).map(js::num_to_string);
    let fs_attr = [("font-size", fs.as_deref())];
    let Some(root) = chord_step_alter(src) else {
        let w = t.h("words", &fs_attr, [chord]);
        let dt = t.h("direction-type", &[], [w]);
        return t.h("direction", &[("placement", Some("above"))], [dt]);
    };
    let mut rest = &src[sa_bytes(src, &root)..];
    let mut bass = "";
    if let Some(slash) = rest.find('/') {
        bass = &rest[slash + 1..];
        rest = &rest[..slash];
    }
    let b = chord_step_alter(bass);
    let alter_el = |t: &mut dolce_xml::Tree, tag: &str, sa: &ChordStepAlter| -> Option<dolce_xml::NodeId> {
        let a = alter_of(&sa.acc);
        (a != 0.0).then(|| t.h(tag, &[("location", sa.left.then_some("left"))], [js::num_to_string(a)]))
    };
    let rs = t.h("root-step", &fs_attr, [root.step.to_string()]);
    let mut root_kids: Vec<Kid> = vec![Kid::Node(rs)];
    if let Some(a) = alter_el(t, "root-alter", &root) {
        root_kids.push(Kid::Node(a));
    }
    let r = t.h("root", &[], root_kids);
    let k = t.h("kind", &[("text", Some(rest))], [kind_of(rest)]);
    let mut kids: Vec<Kid> = vec![Kid::Node(r), Kid::Node(k)];
    if let Some(b) = &b {
        let bs = t.h("bass-step", &[], [b.step.to_string()]);
        let mut bk: Vec<Kid> = vec![Kid::Node(bs)];
        if let Some(a) = alter_el(t, "bass-alter", b) {
            bk.push(Kid::Node(a));
        }
        kids.push(Kid::Node(t.h("bass", &[], bk)));
    }
    if offset > 0.0 {
        kids.push(Kid::Node(t.h("offset", &[], [js::num_to_string(js::round(offset))])));
    }
    t.h("harmony", &[], kids)
}

/// 同 `harmony_el`，序列化成文本
pub fn harmony_xml(chord: &str, offset: f64, font_size: Option<f64>) -> String {
    let mut t = dolce_xml::Tree::new();
    let el = harmony_el(&mut t, chord, offset, font_size);
    t.serialize(el)
}
