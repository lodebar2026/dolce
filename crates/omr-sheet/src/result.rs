//! 识别结果的公共件（简谱、五线谱两条路线同用）：识别 id、源图框、可疑项、落选候选的外观。
//!
//! - **识别 id**（[`Rid`]）是元素自己的字段，不是外挂表：编辑器按它把手改放回去，将来 ScoreDoc 迁到 Rust 时原样带进模型。
//!   前缀口径同 web `staffomr/review.ts::numberOmrIds`：音 `omrN`，歌词字 `omrLN`、文字指示 `omrWN`、力度 `omrDN`、延音线 `omrTN`、弧 `omrSN`。
//! - **源图框**（[`SrcBox`]）一律是原图像素、`Rect`（x, y, w, h），页码 1 起。
//! - **可疑项**（[`Doubt`]）：定位 + 框 + 原因码 + 说明 + 落选候选；原因码见 [`codes`]，两条路线共一张表。
use dolce_omr_core::image::Rect;
use serde::{Deserialize, Serialize};

/// 识别 id（`omr12`、`omrL3`…）。同一份底本重跑、带约束重跑，没变的元素号码不变。
pub type Rid = String;

/// 识别 id 的种类（前缀）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RidKind {
    Note,
    Lyric,
    Words,
    Dynamics,
    Tie,
    Slur,
}

impl RidKind {
    pub fn prefix(self) -> &'static str {
        match self {
            RidKind::Note => "omr",
            RidKind::Lyric => "omrL",
            RidKind::Words => "omrW",
            RidKind::Dynamics => "omrD",
            RidKind::Tie => "omrT",
            RidKind::Slur => "omrS",
        }
    }
}

/// 按种类各自顺序发号（`omr1`、`omr2`…；`omrL1`…）。编号次序由调用方保证确定（页序 → 系统 → 谱行 → x）。
#[derive(Clone, Debug, Default)]
pub struct RidSeq {
    next: [u32; 6],
}

impl RidSeq {
    pub fn take(&mut self, kind: RidKind) -> Rid {
        let k = kind as usize;
        self.next[k] += 1;
        format!("{}{}", kind.prefix(), self.next[k])
    }
}

/// 源图上的框：第几页（1 起）、原图像素。
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SrcBox {
    pub page: usize,
    pub rect: Rect,
}

/// 可疑项落在哪里。五线谱：页、全曲第几个系统、系统内第几行、全曲第几小节；简谱：`row` 是全曲第几行、`note` 是行内第几个音。
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Locus {
    /// 1 起；简谱整曲一页时为 1。
    pub page: usize,
    #[serde(default)]
    pub system: usize,
    pub row: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub measure: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<usize>,
}

/// 一个落选候选给人看的样子：改成什么、分数（越小越好的代价，或越大越好的把握，由 `what` 的种类定）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AltView {
    pub what: String,
    pub score: f64,
}

/// 一处把握不大的地方（计划 §2.8），随结果交出：核对视图标出来、回归按原因码统计。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Doubt {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<Rid>,
    pub at: Locus,
    pub rect: Rect,
    /// 原因码（[`codes`]）。
    pub code: String,
    /// 给人看的说明（改了什么、差多少）。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alts: Vec<AltView>,
}

impl Doubt {
    pub fn new(at: Locus, rect: Rect, code: &str) -> Self {
        Doubt { rid: None, at, rect, code: code.to_string(), note: String::new(), alts: Vec::new() }
    }

    pub fn with_note(mut self, note: impl Into<String>) -> Self {
        self.note = note.into();
        self
    }
}

/// 原因码（两条路线共用一张表；编辑器的说明文字在 web `i18n` 的 `omr.doubt.<码>`）。
pub mod codes {
    /// 小节不满拍（保持原判）。
    pub const BEAT_SHORT: &str = "beat.short";
    /// 小节超拍（保持原判）。
    pub const BEAT_OVER: &str = "beat.over";
    /// 几组改法都凑得满，没改。
    pub const BEAT_AMBIGUOUS: &str = "beat.ambiguous";
    /// 同系统各行拍位对不齐。
    pub const BEAT_MISALIGNED: &str = "beat.misaligned";
    /// 按满拍改过（改时值、删元素）；简谱另细分 `beat.fix.<什么>`。
    pub const BEAT_FIX: &str = "beat.fix";
    /// 读成「1」的光竖条按满拍改判小节线（简谱）。
    pub const BEAT_FIX_BAR: &str = "beat.fix.bar";
    /// 没读到拍号，按多数小节定的。
    pub const METER_INFERRED: &str = "meter.inferred";
    /// 读到的拍号与多数小节对不上。
    pub const METER_MISMATCH: &str = "meter.mismatch";
}
