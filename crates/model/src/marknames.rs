//! 简谱记号的名字表（同 `src/model/marknames.ts`）：力度名与术语。字形不在这里。

/// 认得的力度名（语法表）。
pub const DYNAMIC_NAMES: &[&str] = &["ppp", "pp", "p", "mp", "mf", "f", "ff", "fff", "sf", "fp", "sfp", "sfz", "sffz", "fz", "rf", "rfz"];

pub fn is_dynamic_name(name: &str) -> bool {
    DYNAMIC_NAMES.contains(&name)
}

/// 术语类记号：直接排文字。
pub const TERMS: &[(&str, &str)] = &[("cresc", "cresc."), ("dim", "dim."), ("rit", "rit."), ("tempo", "a tempo"), ("atempo", "a tempo")];

pub fn term_text(name: &str) -> Option<&'static str> {
    TERMS.iter().find(|(k, _)| *k == name).map(|(_, v)| *v)
}
