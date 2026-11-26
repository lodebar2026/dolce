//! 版面（123 `%%layout`，规范 123格式 §9.1）：内置四档的名字、自定义版面照哪一档排、按名取这一首的版面、断行方式。
//! 读写在 `dolce-model::formats` 的 `abc/fields.rs`，排版各档在这里取值。

use crate::doc::{LayoutBreak, LayoutSpec, Song};

/// 内置版面：(中文规范名, ASCII 别名)，就是编辑器的四档
pub const BUILTIN_LAYOUTS: [(&str, &str); 4] = [("投影", "projection"), ("简谱", "jianpu"), ("五线谱", "staff"), ("混排", "mixed")];

/// 投影档的版面名
pub const PROJECTION: &str = "投影";

/// 内置版面名（中文或 ASCII，ASCII 不分大小写）→ 中文规范名
pub fn builtin_layout(name: &str) -> Option<&'static str> {
    BUILTIN_LAYOUTS.iter().find(|(zh, en)| *zh == name || en.eq_ignore_ascii_case(name)).map(|(zh, _)| *zh)
}

/// 这个版面照哪一档排（内置版面就是它自己；自定义版面看 `base`，没写或写错回 `None`）
pub fn layout_base(spec: &LayoutSpec) -> Option<&'static str> {
    builtin_layout(&spec.name).or_else(|| spec.base.as_deref().and_then(builtin_layout))
}

/// 这一首叫这个名字的版面（内置名认 ASCII 别名）。自定义版面缺 `base` 的不算
pub fn find_layout<'s>(song: &'s Song, name: &str) -> Option<&'s LayoutSpec> {
    let key = builtin_layout(name).unwrap_or(name);
    song.layouts.iter().flatten().find(|s| s.name == key && layout_base(s).is_some())
}

/// 断行方式（`linebreak=`）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineBreak {
    /// 照音乐体的 `$` 断
    Source,
    /// 按乐句断
    Phrase,
    /// 每行 N 小节
    Bars(usize),
    /// 按版心宽逐行装满
    Fill,
    /// 投影缺省：有 `%%sing` 时同 `Fill`，没有时照源换行加投影推断
    Auto,
}

impl LineBreak {
    pub fn parse(v: &str) -> Option<LineBreak> {
        match v {
            "source" => Some(LineBreak::Source),
            "phrase" => Some(LineBreak::Phrase),
            "fill" => Some(LineBreak::Fill),
            "auto" => Some(LineBreak::Auto),
            _ => {
                let n = v.strip_prefix("bars:")?;
                if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
                n.parse::<usize>().ok().filter(|&n| n >= 1).map(LineBreak::Bars)
            }
        }
    }

    pub fn text(self) -> String {
        match self {
            LineBreak::Source => "source".into(),
            LineBreak::Phrase => "phrase".into(),
            LineBreak::Fill => "fill".into(),
            LineBreak::Auto => "auto".into(),
            LineBreak::Bars(n) => format!("bars:{n}"),
        }
    }
}

impl LayoutSpec {
    /// 写了的断行方式（没写或写错回 `None`，由各档取缺省）
    pub fn line_break(&self) -> Option<LineBreak> {
        self.linebreak.as_deref().and_then(LineBreak::parse)
    }

    /// 管第 `pass` 遍（从 1 起）的断点：不带 `pass=` 的与 `pass=` 这一遍的
    pub fn breaks_for(&self, pass: usize) -> impl Iterator<Item = &LayoutBreak> {
        self.breaks.iter().flatten().filter(move |b| b.pass.is_none_or(|p| p == pass as f64))
    }

    /// 第 `pass` 遍各页最多几行：`pass=` 这一遍单写的，否则整个版面的
    pub fn rows_for(&self, pass: usize) -> Option<f64> {
        self.passes.iter().flatten().find(|p| p.pass == pass as f64).and_then(|p| p.rows).or(self.rows).filter(|r| *r >= 1.0)
    }
}
