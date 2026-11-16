//! 简谱数字 ↔ 五线谱音高拼写（同 `src/score/jppitch.ts`）。可动 do：数字 1 = 主音，按调号求该音级的升降。
//! 导出与导入共用这一处（两份漂移就会往返错音）。

use dolce_base::js;

/// C 大调音名表（fifths=0 时 1..7 对应 C D E F G A B）。
pub const STEPS: [&str; 7] = ["C", "D", "E", "F", "G", "A", "B"];

/// 音名在 `STEPS` 里的下标（`STEPS.indexOf(step)`，认不出 -1）
pub fn step_index(step: &str) -> f64 {
    STEPS.iter().position(|s| *s == step).map_or(-1.0, |i| i as f64)
}

/// fifths → 主音音级索引（0=C，CDEFGAB 顺序）：`b=(4f+28)%7`
pub fn tonic_step(fifths: f64) -> f64 {
    (((4.0 * fifths + 28.0) % 7.0) + 7.0) % 7.0
}

// 调号升降：升序 F C G D A E B、降序 B E A D G C F。
const SHARP_ORDER: [f64; 7] = [3.0, 0.0, 4.0, 1.0, 5.0, 2.0, 6.0];
const FLAT_ORDER: [f64; 7] = [6.0, 2.0, 5.0, 1.0, 4.0, 0.0, 3.0];

/// `arr.slice(0, n)` 的长度（n 按 ToIntegerOrInfinity，截到 0..len）
fn slice_len(n: f64, len: usize) -> usize {
    if n.is_nan() || n <= 0.0 {
        0
    } else {
        (n.trunc() as usize).min(len)
    }
}

pub fn key_alter(step_idx: f64, fifths: f64) -> f64 {
    if fifths > 0.0 {
        return if SHARP_ORDER[..slice_len(fifths, 7)].contains(&step_idx) { 1.0 } else { 0.0 };
    }
    if fifths < 0.0 {
        return if FLAT_ORDER[..slice_len(-fifths, 7)].contains(&step_idx) { -1.0 } else { 0.0 };
    }
    0.0
}

/// 无点的「1」落在 B3 … A4 这一个八度里：只有**主音字母是 B** 的调（B / bB）整体降一个八度
/// （《简谱通用规范》第 23-24 页的各调音域对照表）。
pub fn jp_tonic_octave_shift(fifths: f64) -> f64 {
    if tonic_step(fifths) == 6.0 {
        1.0
    } else {
        0.0
    }
}

/// 数字音符 → 拼写（音名字母、调号给的升降、科学记号八度）。digit 1-7，`jp_octave` 为简谱八度点偏移。
/// 音名取不到（digit / fifths 不是整数）时字母为 None（TS 那边是 `undefined`）。
#[derive(Clone, Debug, PartialEq)]
pub struct JpPitch {
    pub step: Option<&'static str>,
    pub alter: f64,
    pub octave: f64,
}

pub fn jp_pitch(digit: f64, jp_octave: f64, fifths: f64) -> JpPitch {
    let tonic = tonic_step(fifths);
    let degree = js::max(1.0, js::min(7.0, digit)) - 1.0;
    let step_idx = (tonic + degree) % 7.0;
    let wrap = ((tonic + degree) / 7.0).floor();
    // 导入器对主音字母 B 的调会把 jpOctave +1，导出端预先 -1 抵消以保往返。
    let octave = 4.0 + jp_octave + wrap - jp_tonic_octave_shift(fifths);
    JpPitch { step: js::index(step_idx).and_then(|i| STEPS.get(i).copied()), alter: key_alter(step_idx, fifths), octave }
}

/// 调名表（fifths + 7 → 拼写）
pub const KEYS: [&str; 15] = ["bC", "bG", "bD", "bA", "bE", "bB", "F", "C", "G", "D", "A", "E", "B", "#F", "#C"];

/// `MusicCommon.keys[fifths + 7]`
pub fn key_name(fifths: f64) -> Option<&'static str> {
    js::index(fifths + 7.0).and_then(|i| KEYS.get(i).copied())
}

/// `MusicCommon.keyNameToFifth`：调名（`bB`、`Bb`、`#F`、`F#`）→ fifths；认不出 -8
pub fn key_name_to_fifth(n: &str) -> f64 {
    let units: Vec<u16> = n.encode_utf16().collect();
    let swapped;
    let nn = if units.len() == 2 && (units[1] == b'b' as u16 || units[1] == b'#' as u16) {
        swapped = String::from_utf16_lossy(&[units[1], units[0]]);
        swapped.as_str()
    } else {
        n
    };
    KEYS.iter().position(|k| *k == nn).map_or(-1.0, |i| i as f64) - 7.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pitches() {
        assert_eq!(jp_pitch(1.0, 0.0, 0.0), JpPitch { step: Some("C"), alter: 0.0, octave: 4.0 });
        // bB 调：1 = B♭3
        assert_eq!(jp_pitch(1.0, 0.0, -2.0), JpPitch { step: Some("B"), alter: -1.0, octave: 3.0 });
        assert_eq!(jp_pitch(7.0, 1.0, 1.0), JpPitch { step: Some("F"), alter: 1.0, octave: 6.0 });
        assert_eq!(key_name_to_fifth("Bb"), -2.0);
        assert_eq!(key_name_to_fifth("#F"), 6.0);
        assert_eq!(key_name_to_fifth("H"), -8.0);
        assert_eq!(tonic_step(-1.0), 3.0);
    }
}
