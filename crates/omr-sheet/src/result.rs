//! 识别结果的公共件（简谱、五线谱两条路线同用）：识别 id、源图框、可疑项、落选候选的外观。
//!
//! - **识别 id**（[`Rid`]）是元素自己的字段，不是外挂表：编辑器按它把手改放回去，将来 ScoreDoc 迁到 Rust 时原样带进模型。
//!   前缀口径同 web `staffomr/review.ts::numberOmrIds`：音 `omrN`，歌词字 `omrLN`、文字指示 `omrWN`、力度 `omrDN`、延音线 `omrTN`、弧 `omrSN`。
//! - **源图框**（[`SrcBox`]）一律是原图像素、`Rect`（x, y, w, h），页码 1 起。
//! - **可疑项**（[`Doubt`]）：定位 + 框 + 原因码 + 说明 + 落选候选；原因码见 [`codes`]，两条路线共一张表。
use dolce_omr_core::image::Rect;
use serde::{Deserialize, Serialize};

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
    pub const ALL: [RidKind; 6] = [RidKind::Note, RidKind::Lyric, RidKind::Words, RidKind::Dynamics, RidKind::Tie, RidKind::Slur];

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

/// 识别 id（写出成 `omr12`、`omrL3`…）。同一份底本重跑、带约束重跑，没变的元素号码不变。
/// 弧在认出时就占号、拼整曲时才定是延音线还是圆滑线：两种共用一个序号，前缀随种类（号码照样不重）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Rid {
    pub kind: RidKind,
    pub n: u32,
}

impl std::fmt::Display for Rid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}{}", self.kind.prefix(), self.n)
    }
}

impl std::str::FromStr for Rid {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, ()> {
        // 长前缀先比（`omrL` 先于 `omr`）
        let mut kinds = RidKind::ALL;
        kinds.sort_by_key(|k| std::cmp::Reverse(k.prefix().len()));
        kinds.iter().find_map(|&kind| s.strip_prefix(kind.prefix()).and_then(|n| n.parse().ok()).map(|n| Rid { kind, n })).ok_or(())
    }
}

impl Serialize for Rid {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Rid {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        s.parse().map_err(|_| serde::de::Error::custom(format!("识别 id 不认得：{s}")))
    }
}

/// 按种类各自顺序发号（`omr1`、`omr2`…；`omrL1`…）。编号次序由调用方保证确定（页序 → 系统 → 谱行 → x）。
#[derive(Clone, Debug, Default)]
pub struct RidSeq {
    next: [u32; 6],
}

impl RidSeq {
    pub fn take(&mut self, kind: RidKind) -> Rid {
        // 延音线与圆滑线共用一个序号
        let k = if kind == RidKind::Tie { RidKind::Slur } else { kind } as usize;
        self.next[k] += 1;
        Rid { kind, n: self.next[k] }
    }
}

/// 一个元素的识别出处：识别 id（不写 id 的元素为 None）与源图框（没量到为 None）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Src {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<Rid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<SrcBox>,
}

impl Src {
    /// ` id="omr3"`（没有 id 时为空串）：写 MusicXML 属性用。
    pub fn id_attr(&self) -> String {
        self.rid.map_or(String::new(), |r| format!(" id=\"{r}\""))
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
    /// 符头的模板分比本页中位低一截（可能不是头）。
    pub const HEAD_WEAK: &str = "head.weak";
    /// 这一行没读出调号，沿用的（调号不是 C 大调时才记）。
    pub const KEY_CARRIED: &str = "key.carried";
    /// 这一行没读出谱号，沿用的。
    pub const CLEF_CARRIED: &str = "clef.carried";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rid_round_trip() {
        let mut seq = RidSeq::default();
        let (a, b, c, d) = (seq.take(RidKind::Note), seq.take(RidKind::Slur), seq.take(RidKind::Tie), seq.take(RidKind::Lyric));
        assert_eq!([a, b, c, d].map(|r| r.to_string()), ["omr1", "omrS1", "omrT2", "omrL1"]);
        for r in [a, b, c, d] {
            assert_eq!(r.to_string().parse::<Rid>(), Ok(r));
        }
        assert_eq!(serde_json::to_string(&c).unwrap(), "\"omrT2\"");
    }
}
