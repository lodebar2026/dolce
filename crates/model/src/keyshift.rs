//! 文本谱曲中转调 `"k:2"`：新调主音在主调里的级数 ↔ 小节调号（同 `src/model/keyshift.ts`）。按五度圈算。

use crate::doc::{Key, Song};
use crate::base::js;
use crate::play::jppitch::{key_name, key_name_to_fifth};

/// 各级（1..7）相对主音的五度数
const DEGREE_FIFTHS: [f64; 7] = [0.0, 2.0, 4.0, -1.0, 1.0, 3.0, 5.0];

fn degree_fifths(n: f64) -> f64 {
    if (1.0..=7.0).contains(&n) {
        // `DEGREE_FIFTHS[n - 1]!`：n 是小数时取不到（undefined），算下来是 NaN
        js::index(n - 1.0).map_or(f64::NAN, |i| DEGREE_FIFTHS[i])
    } else {
        0.0
    }
}

fn wrap(mut f: f64) -> f64 {
    while f > 7.0 {
        f -= 12.0;
    }
    while f < -7.0 {
        f += 12.0;
    }
    f
}

/// `N=X` 的调号：X 大调退回唱名 N 的五度数。拼写认不出返回 None；越过 ±7 的按同音换回。
pub fn fifths_of_spelling(spelling: &str, tonic_degree: Option<&str>) -> Option<f64> {
    let base = key_name_to_fifth(spelling);
    if !(-7.0..=7.0).contains(&base) {
        return None;
    }
    let n = js::number(tonic_degree.unwrap_or("1"));
    Some(wrap(base - degree_fifths(n)))
}

/// 调号的 fifths。只记了拼写的按拼写与主音唱名补算
pub fn key_fifths(k: &Key) -> f64 {
    match &k.spelling {
        Some(s) if k.fifths == 0.0 && !s.is_empty() && s != "none" => fifths_of_spelling(s, k.tonic_degree.as_deref()).unwrap_or(0.0),
        _ => k.fifths,
    }
}

/// 调式 → 主音唱名（MusicXML `<mode>` 全名）
fn mode_degree(mode: &str) -> Option<f64> {
    Some(match mode {
        "major" | "ionian" => 1.0,
        "dorian" => 2.0,
        "phrygian" => 3.0,
        "lydian" => 4.0,
        "mixolydian" => 5.0,
        "minor" | "aeolian" => 6.0,
        "locrian" => 7.0,
        _ => return None,
    })
}

/// 主音的音名（前置升降号形，`bB`）：有拼写用拼写；否则按主音唱名（或调式推出的唱名）在调号里取
pub fn tonic_spelling(k: &Key) -> String {
    if let Some(s) = &k.spelling {
        if !s.is_empty() {
            return s.clone();
        }
    }
    let n = match &k.tonic_degree {
        Some(t) => js::number(t),
        None => mode_degree(k.mode.as_deref().unwrap_or("")).unwrap_or(1.0),
    };
    let f = wrap(k.fifths + degree_fifths(n));
    key_name(f).unwrap_or("undefined").to_owned()
}

/// 首调号的 fifths
pub fn song_fifths(song: &Song) -> f64 {
    song.key.as_ref().map_or(0.0, key_fifths)
}

/// `k:#4` → 新调号（`/^([#b]?)([1-7])$/`）。超出 ±7 的按同音换成 ±7 以内的拼写
pub fn key_of_degree(home: f64, degree: &str) -> Option<Key> {
    let (acc, d) = match degree.as_bytes() {
        [a @ (b'#' | b'b'), d @ b'1'..=b'7'] => (Some(*a), *d),
        [d @ b'1'..=b'7'] => (None, *d),
        _ => return None,
    };
    let f = home + DEGREE_FIFTHS[(d - b'1') as usize] + if acc == Some(b'#') { 7.0 } else if acc == Some(b'b') { -7.0 } else { 0.0 };
    let f = wrap(f);
    let mut k = crate::jianpu::c_major();
    k.fifths = f;
    k.spelling = Some(key_name(f).unwrap_or("undefined").to_owned());
    Some(k)
}

/// `key_of_degree` 的逆：新调号 → 级数写法（`2`、`#4`、`b7`）
pub fn degree_of_key(home: f64, fifths: f64) -> String {
    let mut d = fifths - home;
    while d > 12.0 {
        d -= 12.0;
    }
    while d < -8.0 {
        d += 12.0;
    }
    let acc = if d >= 6.0 {
        "#"
    } else if d <= -2.0 {
        "b"
    } else {
        ""
    };
    let base = if acc == "#" {
        d - 7.0
    } else if acc == "b" {
        d + 7.0
    } else {
        d
    };
    let idx = DEGREE_FIFTHS.iter().position(|x| *x == base).map_or(-1.0, |i| i as f64);
    format!("{acc}{}", js::num_to_string(idx + 1.0))
}

/// 是不是小调：调式写了 minor / aeolian，或没写调式、主音唱名是 6
pub fn is_minor_key(k: &Key) -> bool {
    match &k.mode {
        Some(m) => mode_degree(m) == Some(6.0),
        None => k.tonic_degree.as_deref() == Some("6"),
    }
}

/// 移调乐器的记谱调号 → 实际发声的调号
pub fn sounding_fifths(written: f64, chromatic: f64) -> f64 {
    wrap(written + 7.0 * chromatic)
}
