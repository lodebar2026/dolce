//! 音乐逻辑里两条路线都用的基本量：谱号、调号、拍号、小节线样式。只是数据与换算，不含识别判据。
use serde::{Deserialize, Serialize};

/// 谱号的字形种类。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ClefSign {
    G,
    F,
    C,
    Percussion,
}

/// 谱号：字形、定音的那条线（自下而上 1–5，MusicXML `<line>` 的口径）、八度移位（G 谱号下带 8 是 −1）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Clef {
    pub sign: ClefSign,
    pub line: u8,
    pub octave: i8,
}

impl Clef {
    pub const TREBLE: Clef = Clef { sign: ClefSign::G, line: 2, octave: 0 };
    pub const TREBLE_8VB: Clef = Clef { sign: ClefSign::G, line: 2, octave: -1 };
    pub const BASS: Clef = Clef { sign: ClefSign::F, line: 4, octave: 0 };
    pub const ALTO: Clef = Clef { sign: ClefSign::C, line: 3, octave: 0 };
    pub const TENOR: Clef = Clef { sign: ClefSign::C, line: 4, octave: 0 };
    pub const PERCUSSION: Clef = Clef { sign: ClefSign::Percussion, line: 3, octave: 0 };

    /// 调号第一个升号（F）在谱表上的音级位置（第一线 0、往下每半格 +1）。打击乐谱号没有调号。
    /// 高音谱号在第五线（0），低音谱号在第四线（2），中音谱号在第四间上（1），次中音谱号在第二线（6）。
    pub fn first_sharp_pos(&self) -> Option<i32> {
        match (self.sign, self.line) {
            (ClefSign::G, _) => Some(0),
            (ClefSign::F, _) => Some(2),
            (ClefSign::C, 3) => Some(1),
            (ClefSign::C, 4) => Some(6),
            _ => None,
        }
    }

    /// 调号第 `i` 个（从 0 起）升号 / 降号应在的音级位置。
    /// 升号次序 F C G D A E B，降号次序 B E A D G C F；各谱号下整体平移，次中音谱号的升号另有折回（F、G 写在下方）。
    pub fn key_pos(&self, sharp: bool, i: usize) -> Option<i32> {
        let f = self.first_sharp_pos()?;
        // 高音谱号下的位置表
        const SHARP: [i32; 7] = [0, 3, -1, 2, 5, 1, 4];
        const FLAT: [i32; 7] = [4, 1, 5, 2, 6, 3, 7];
        const TENOR_SHARP: [i32; 7] = [6, 2, 5, 1, 4, 0, 3];
        if i >= 7 {
            return None;
        }
        Some(match (sharp, self.sign, self.line) {
            (true, ClefSign::C, 4) => TENOR_SHARP[i],
            (true, _, _) => SHARP[i] + f,
            (false, ClefSign::C, 4) => FLAT[i] - 1,
            (false, _, _) => FLAT[i] + f,
        })
    }
}

/// 调号：五度圈上的位置（升号为正、降号为负）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Key {
    pub fifths: i8,
}

/// 拍号的印法。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TimeSymbol {
    /// 数字
    Normal,
    /// C
    Common,
    /// ¢
    Cut,
}

/// 拍号。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Time {
    pub beats: u8,
    pub beat_type: u8,
    pub symbol: TimeSymbol,
}

/// 小节线的样式（MusicXML `bar-style` 的口径）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum BarStyle {
    Regular,
    /// 两根细
    LightLight,
    /// 细 + 粗（终止线、反复结束）
    LightHeavy,
    /// 粗 + 细（反复开始）
    HeavyLight,
    Heavy,
    /// 谱面上没有印（行末劈开的半截小节）
    None,
}

impl BarStyle {
    pub fn xml(&self) -> &'static str {
        match self {
            BarStyle::Regular => "regular",
            BarStyle::LightLight => "light-light",
            BarStyle::LightHeavy => "light-heavy",
            BarStyle::HeavyLight => "heavy-light",
            BarStyle::Heavy => "heavy",
            BarStyle::None => "none",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_positions() {
        // 高音谱号：升 F 在第五线、升 C 在第三间；降 B 在第三线
        assert_eq!(Clef::TREBLE.key_pos(true, 0), Some(0));
        assert_eq!(Clef::TREBLE.key_pos(true, 1), Some(3));
        assert_eq!(Clef::TREBLE.key_pos(false, 0), Some(4));
        // 低音谱号整体低一线
        assert_eq!(Clef::BASS.key_pos(true, 0), Some(2));
        assert_eq!(Clef::BASS.key_pos(false, 0), Some(6));
        assert_eq!(Clef::ALTO.key_pos(false, 1), Some(2));
        assert_eq!(Clef::PERCUSSION.key_pos(true, 0), None);
    }
}
