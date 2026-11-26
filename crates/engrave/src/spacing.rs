//! 元素类共用的纯数值口径（`engrave/spacing.ts`）。

/// 「=」两侧各让的空 ÷ 字号：调号、转调、速度标记一律这么空。
pub const EQ_PAD_EM: f64 = 0.2;

/// 调名与和弦根音 / 低音的升降号写在字母前（`♭B`、`#Fm`）还是后（`B♭`、`F#m`）。样式键 `accidental-side`。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccidentalSide {
    Before,
    After,
}

impl AccidentalSide {
    /// 样式值 → 枚举；没给或认不出为 None（各自照原来的写法）。
    pub fn parse(s: Option<&str>) -> Option<AccidentalSide> {
        match s {
            Some("before") => Some(AccidentalSide::Before),
            Some("after") => Some(AccidentalSide::After),
            _ => None,
        }
    }
}

/// 临时记号的样子：`csym`（缺省）/ `classic`（成书）。样式键 `accidental-style`。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum AccidentalStyleKind {
    #[default]
    Csym,
    Classic,
}

impl AccidentalStyleKind {
    pub fn parse(s: &str) -> AccidentalStyleKind {
        if s == "classic" {
            AccidentalStyleKind::Classic
        } else {
            AccidentalStyleKind::Csym
        }
    }
}
