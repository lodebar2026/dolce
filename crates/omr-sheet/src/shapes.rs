//! **字形身份**（计划 §2.7 / §5.5「设计 4」）：音乐字形 → SMuFL 名。文字层的音乐字体字形与转曲对象走同一个入口 [`identify`]。
//!
//! 两条来源，依次查：
//! 1. **轮廓签名字典**：轮廓压成 32×32 位图签名，对 `glyphmap.json`（轮廓聚类 + 人工确认，SMuFL 名；Maestro / Anastasia / Opus 几家）
//!    找同家族、尺寸相当（按 em 归一，差不过 0.05 em）、汉明距离最近的类（不过 [`SIG_MAX`]）。
//! 2. **码位表**：Sonata 一系（Maestro / Opus / Doremi / Petrucci）原始编码同一套；字典没有的家族（Doremi）靠它。
//!    键的次序：私用区剥掉 0xF000 的码点 → 码点原值。
//!
//! 签名算法与字典建库时同一份（扫描线、非零环绕、按外框长边归一、居中留一格边）；字典里的轮廓是字形坐标（y 朝上），
//! 页面上的轮廓 y 朝下，比之前先翻过来。
use serde::Deserialize;
use std::sync::OnceLock;

/// 签名边长。
pub const SIG_N: usize = 32;
/// 签名最近邻的距离上限（1024 位里差几位）。
pub const SIG_MAX: u32 = 40;
/// 尺寸差上限（em）。
const SIZE_TOL: f64 = 0.05;

/// 音乐字体家族。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family {
    Maestro,
    MaestroWide,
    Opus,
    OpusStd,
    OpusSpecial,
    OpusSpecialStd,
    OpusText,
    Petrucci,
    Sonata,
    Doremi,
    Anastasia,
}

impl Family {
    /// 字典里的家族名。
    pub fn dict_name(self) -> &'static str {
        match self {
            Family::Maestro | Family::MaestroWide => "Maestro",
            Family::Opus | Family::OpusStd => "Opus",
            Family::OpusSpecial | Family::OpusSpecialStd => "OpusSpecial",
            Family::OpusText => "OpusText",
            Family::Anastasia => "Anastasia",
            Family::Petrucci => "Petrucci",
            Family::Sonata => "Sonata",
            Family::Doremi => "Doremi",
        }
    }
}

/// 字体名（已去子集前缀）→ 家族；不是音乐字体回 None（`EngraverTextT` 是刻谱文字字体，走文本）。
pub fn music_family(font: &str) -> Option<Family> {
    let f = font;
    Some(if f.starts_with("MaestroWide") {
        Family::MaestroWide
    } else if f.starts_with("Maestro") {
        Family::Maestro
    } else if f.starts_with("OpusSpecialStd") {
        Family::OpusSpecialStd
    } else if f.starts_with("OpusSpecial") {
        Family::OpusSpecial
    } else if f.starts_with("OpusText") {
        Family::OpusText
    } else if f.starts_with("OpusStd") {
        Family::OpusStd
    } else if f.starts_with("OpusChords") {
        return None;
    } else if f.starts_with("Opus") {
        Family::Opus
    } else if f.starts_with("Petrucci") || f.starts_with("EngraverFontSet") {
        Family::Petrucci
    } else if f.starts_with("Sonata") {
        Family::Sonata
    } else if f.starts_with("Anastasia") {
        Family::Anastasia
    } else if f.starts_with("Doremi") {
        Family::Doremi
    } else {
        return None;
    })
}

type Table = &'static [(u32, &'static str)];

/// 各家共用的那半张。
const COMMON: Table = &[
    (0x3f, "fClef"), (0x26, "gClef"), (0x42, "cClef"), (0x63, "timeSigCommon"), (0x43, "timeSigCutCommon"),
    (0x30, "timeSig0"), (0x31, "timeSig1"), (0x32, "timeSig2"), (0x33, "timeSig3"), (0x34, "timeSig4"),
    (0x35, "timeSig5"), (0x36, "timeSig6"), (0x37, "timeSig7"), (0x38, "timeSig8"), (0x39, "timeSig9"),
    (0x153, "noteheadBlack"), (0x2d9, "noteheadHalf"), (0x77, "noteheadWhole"), (0x57, "noteheadDoubleWhole"),
    (0x152, "restQuarter"), (0x2030, "rest8th"), (0xd3, "restHalf"), (0x2211, "restHBar"), (0x2248, "rest16th"),
    (0x6a, "flag8thUp"), (0x4a, "flag8thDown"), (0x72, "flag16thUp"), (0x52, "flag16thDown"),
    (0x2e, "augmentationDot"), (0x62, "accidentalFlat"), (0x6e, "accidentalNatural"), (0x23, "accidentalSharp"),
    (0x55, "fermataAbove"), (0x75, "fermataBelow"), (0x71, "metNoteQuarterUp"),
];

/// Maestro 专有（`p` 是 p 不是 mf：宣主荣耀的 'p' 宽 0.5 em，与 'F'（mf）不是一个字形）。
const MAESTRO: Table = &[
    (0xf0ee, "restHalf"), (0x2248, "rest16th"), (0xd3, "restHalf"), (0x152, "restQuarter"), (0x153, "noteheadBlack"),
    (0x2d9, "noteheadHalf"), (0x56, "gClef8vb"), (0xf7, "unpitchedPercussionClef2"), (0x3e, "articAccentAbove"),
    (0x2030, "rest8th"), (0x221a, "ottavaAlta"), (0x2211, "restHBar"), (0x25ca, "ottavaBassaVb"), (0x3c0, "dynamicPP"),
    (0x67, "wiggleTrill"), (0xdf, "dynamicSforzando"), (0x50, "dynamicMP"), (0x70, "dynamicPiano"), (0x46, "dynamicMF"),
    (0x66, "dynamicForte"), (0x192, "dynamicFF"), (0x2c, "breathMarkComma"), (0x76, "articMarcatoBelow"),
    (0xfb02, "articAccentStaccatoBelow"), (0xfb01, "segno"), (0x3c, "articTenutoStaccatoBelow"), (0x65, "metNote8thUp"),
    (0x2d, "articTenutoBelow"), (0xf0b7, "restHBar"), (0xf0fa, "restHalf"), (0x6f, "csymDiminished"),
    (0x28, "csymParensLeftTall"), (0x29, "csymParensRightTall"), (0x2b, "csymAugmented"), (0x25, "segno"),
    (0xdb, "noteheadSlashVerticalEnds"), (0x7c, "noteheadSlashDiamondWhite"), (0xc7, "noteheadHalf"), (0x87, "restHBar"),
    (0xbb, "restHalf"), (0x2039, "accidentalDoubleSharp"), (0x4e, "accidentalNaturalParens"),
    (0x2019, "noteheadSlashHorizontalEnds"), (0x82, "stringsUpBow"), (0x83, "stringsDownBow"),
];
const MAESTRO_WIDE: Table = &[(0x21, "restHBar")];
const OPUS: Table = &[
    (0xcf, "noteheadBlack"), (0xfa, "noteheadHalf"), (0xce, "restQuarter"), (0xe4, "rest8th"), (0xc5, "rest16th"),
    (0xee, "restHalf"), (0xb7, "restHBar"), (0xd9, "ornamentTrill"),
];
const OPUS_STD: Table = &[(0x25, "segno"), (0x2211, "restHBar"), (0xbf, "noteheadXBlack"), (0x178, "ornamentTrill"), (0x2f, "unpitchedPercussionClef1")];
const OPUS_SPECIAL: Table = &[(0xa1, "bracketTop"), (0xa2, "bracketBottom"), (0x7b, "brace"), (0xdc, "clef8"), (0xaa, "augmentationDot")];
const OPUS_SPECIAL_STD: Table = &[
    (0xb0, "bracketTop"), (0xa2, "bracketBottom"), (0x2122, "augmentationDot"), (0x220f, "wiggleTrill"), (0x2039, "clef8"),
    (0x7b, "brace"), (0xe6, "tremolo1"),
];
const OPUS_TEXT: Table = &[(0x71, "metNoteQuarterUp"), (0x70, "dynamicPiano"), (0x66, "dynamicForte"), (0x6d, "dynamicMezzo"), (0x33, "tuplet3")];
const SONATA: Table = &[(0x6b, "flag16thUp")];
/// Doremi（Overture 一系）：码位大体照 Sonata；谱号是 'G' / 'F'，八分休止在 0xAB，力度字母与音符同一个字体。
const DOREMI: Table = &[
    (0x47, "gClef"), (0x46, "fClef"), (0xab, "rest8th"), (0x3b, "fermataAbove"), (0x27, "articStaccatoAbove"),
    (0x3e, "articAccentAbove"), (0x25, "segno"), (0xde, "coda"), (0x66, "dynamicForte"), (0x6d, "dynamicMezzo"), (0x70, "dynamicPiano"),
];

fn tables(f: Family) -> &'static [Table] {
    match f {
        Family::Maestro => &[MAESTRO, COMMON],
        Family::MaestroWide => &[MAESTRO_WIDE, MAESTRO, COMMON],
        Family::Opus => &[OPUS, COMMON],
        Family::OpusStd => &[OPUS_STD, COMMON],
        Family::OpusSpecial => &[OPUS_SPECIAL],
        Family::OpusSpecialStd => &[OPUS_SPECIAL_STD],
        Family::OpusText => &[OPUS_TEXT],
        Family::Petrucci => &[OPUS, COMMON],
        Family::Sonata => &[SONATA, OPUS, COMMON],
        Family::Doremi => &[DOREMI, OPUS, COMMON],
        Family::Anastasia => &[],
    }
}

/// 按码位表猜（字典查不到时的兜底）。
pub fn guess_by_code(f: Family, unicode: u32) -> Option<&'static str> {
    let mut keys = Vec::with_capacity(2);
    if unicode > 0xf000 {
        keys.push(unicode - 0xf000);
    }
    keys.push(unicode);
    for k in keys {
        for t in tables(f) {
            if let Some(&(_, v)) = t.iter().find(|e| e.0 == k) {
                return Some(v);
            }
        }
    }
    None
}

pub use dolce_omr_core::geom::fill_rings;

/// 32×32 签名（逐位，按行）。
pub type Sig = [u64; SIG_N * SIG_N / 64];

/// 轮廓（压平的闭合环）→ 签名。`flip`：y 朝下的轮廓翻成字形坐标（y 朝上）再算，才与字典对得上。
/// `bounds`：归一用的外框 (x0, y0, x1, y1)（字典建库时按路径的全部坐标取、含曲线控制点；不给按环上的点取）。
pub fn sig(rings: &[Vec<(f64, f64)>], bounds: Option<(f64, f64, f64, f64)>, flip: bool) -> Sig {
    let mut out: Sig = [0; SIG_N * SIG_N / 64];
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    let mut take = |x: f64, y: f64| {
        let y = if flip { -y } else { y };
        x0 = x0.min(x);
        x1 = x1.max(x);
        y0 = y0.min(y);
        y1 = y1.max(y);
    };
    match bounds {
        Some((a, b, c, d)) => {
            take(a, b);
            take(c, d);
        }
        None => rings.iter().flatten().for_each(|&(x, y)| take(x, y)),
    }
    if x0 > x1 {
        return out;
    }
    let n = SIG_N as f64;
    let (w, h) = ((x1 - x0).max(1e-9), (y1 - y0).max(1e-9));
    let (w, h) = (if x1 > x0 { w } else { 1.0 }, if y1 > y0 { h } else { 1.0 });
    let sc = (n - 2.0) / w.max(h);
    let (ox, oy) = ((n - w * sc) / 2.0, (n - h * sc) / 2.0);
    let rs: Vec<Vec<(f64, f64)>> = rings.iter().map(|r| r.iter().map(|&(x, y)| ((x - x0) * sc + ox, ((if flip { -y } else { y }) - y0) * sc + oy)).collect()).collect();
    fill_rings(&rs, SIG_N, SIG_N, &mut |px, py| {
        let bit = py * SIG_N + px;
        out[bit / 64] |= 1 << (bit % 64);
    });
    out
}

pub fn sig_distance(a: &Sig, b: &Sig) -> u32 {
    a.iter().zip(b).map(|(x, y)| (x ^ y).count_ones()).sum()
}

/// 签名里墨占的比例。
pub fn sig_fill(s: &Sig) -> f64 {
    s.iter().map(|x| x.count_ones()).sum::<u32>() as f64 / (SIG_N * SIG_N) as f64
}

#[derive(Deserialize)]
struct RawDict {
    classes: Vec<RawClass>,
}

#[derive(Deserialize)]
struct RawClass {
    family: String,
    smufl: Option<String>,
    w: f64,
    h: f64,
    sig: String,
}

struct Class {
    family: String,
    smufl: &'static str,
    w: f64,
    h: f64,
    sig: Sig,
}

fn decode_sig(b64: &str) -> Sig {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut bytes = Vec::new();
    let mut acc = 0u32;
    let mut bits = 0;
    for c in b64.bytes().filter(|&c| c != b'=') {
        let Some(v) = T.iter().position(|&t| t == c) else { continue };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    let mut out: Sig = [0; SIG_N * SIG_N / 64];
    for (i, &b) in bytes.iter().enumerate().take(SIG_N * SIG_N / 8) {
        for k in 0..8 {
            if b >> k & 1 == 1 {
                let bit = i * 8 + k;
                out[bit / 64] |= 1 << (bit % 64);
            }
        }
    }
    out
}

fn dict() -> &'static [Class] {
    static D: OnceLock<Vec<Class>> = OnceLock::new();
    D.get_or_init(|| {
        let raw: RawDict = serde_json::from_str(include_str!("../data/glyphmap.json")).expect("glyphmap.json");
        raw.classes
            .into_iter()
            .filter_map(|c| {
                let name: &'static str = Box::leak(c.smufl?.into_boxed_str());
                Some(Class { family: c.family, smufl: name, w: c.w, h: c.h, sig: decode_sig(&c.sig) })
            })
            .collect()
    })
}

/// 一个音乐字形的身份。`rings` / `bounds`：页面上的轮廓（y 朝下）与归一外框（见 [`sig`]）；`size`：墨迹框宽高按字号归一（em）；
/// `unicode`：码点（转曲对象没有，给 0）；`family`：字体家族（转曲对象给 None：跨家族找最近）。回 SMuFL 名与距离（码位表命中记 [`SIG_MAX`]）。
pub fn identify(rings: &[Vec<(f64, f64)>], bounds: Option<(f64, f64, f64, f64)>, size: Option<(f64, f64)>, unicode: u32, family: Option<Family>) -> Option<(&'static str, u32)> {
    if let (false, Some((w, h))) = (rings.is_empty(), size) {
        let s = sig(rings, bounds, true);
        let fam = family.map(|f| f.dict_name());
        let best = dict()
            .iter()
            .filter(|c| fam.is_none_or(|f| c.family == f))
            .filter(|c| (c.w - w).abs() <= SIZE_TOL && (c.h - h).abs() <= SIZE_TOL)
            .map(|c| (c.smufl, sig_distance(&s, &c.sig)))
            .min_by_key(|&(_, d)| d);
        if let Some(b) = best.filter(|b| b.1 <= SIG_MAX) {
            return Some(b);
        }
    }
    family.and_then(|f| guess_by_code(f, unicode)).map(|n| (n, SIG_MAX))
}

/// 跨字体（转曲对象，没有字体与码位）：尺寸差 [`OUTLINE_SIZE_TOL`] em 内取签名最近、距离不过 [`OUTLINE_SIG_MAX`]；
/// 几乎同形（不过 [`SIG_SAME`]）时尺寸放到 [`SIZE_LOOSE`]（别的字体同一符号比例不同：调号的升号矮三成）；
/// 小圆点（近圆、不过 [`DOT_MAX_EM`] em）签名抖得厉害，附点放到 [`DOT_SIG_MAX`]。门槛照 TS 转曲那一路（祢話如甘霖：符头 15~28、谱号 26、拍号数字 ~50，文字 90 开外）。
const OUTLINE_SIZE_TOL: f64 = 0.08;
const OUTLINE_SIG_MAX: u32 = 60;
const SIG_SAME: u32 = 20;
const SIZE_LOOSE: f64 = 0.25;
const DOT_SIG_MAX: u32 = 100;
const DOT_MAX_EM: f64 = 0.175;
/// 尺寸差 [`OUTLINE_CLEAR_SIZE`] em 内签名最近的过了 [`OUTLINE_SIG_MAX`] 但不过 [`OUTLINE_SIG_CLEAR`]、且同一尺寸窗里次近的另一种字形
/// 远出 [`OUTLINE_CLEAR_RATIO`] 倍的，也收：形状与尺寸都只像这一种，只是字体画法差得多些
/// （裴克经文诗歌 CorelDRAW 转曲的八分休止离 rest8th 72~75、高差 0.09 em；窗里次近的要到 180）。
const OUTLINE_SIG_CLEAR: u32 = 75;
const OUTLINE_CLEAR_RATIO: f64 = 1.25;
const OUTLINE_CLEAR_SIZE: f64 = 0.12;

/// 转曲对象（一个字形块）的身份。`rings`：页面上的轮廓（y 朝下）；`size`：外框宽高（em，1 em = 4 线距）。认不出（多半是文字）回 None。
pub fn identify_outline(rings: &[Vec<(f64, f64)>], size: (f64, f64)) -> Option<(&'static str, u32)> {
    identify_outline_in(rings, size, None)
}

/// 同 [`identify_outline`]，签名的归一外框由调用方给（页面坐标、y 朝下；见 [`sig`] 的 `bounds`）。
pub fn identify_outline_in(rings: &[Vec<(f64, f64)>], size: (f64, f64), bounds: Option<(f64, f64, f64, f64)>) -> Option<(&'static str, u32)> {
    if rings.is_empty() {
        return None;
    }
    let (w, h) = size;
    let s = sig(rings, bounds, true);
    let (mut best, mut loose): (Option<(&'static str, u32)>, Option<(&'static str, u32)>) = (None, None);
    let mut near: Vec<(&'static str, u32)> = Vec::new();
    for c in dict() {
        let (dw, dh) = ((c.w - w).abs(), (c.h - h).abs());
        if dw > SIZE_LOOSE || dh > SIZE_LOOSE {
            continue;
        }
        let d = sig_distance(&s, &c.sig);
        if dw <= OUTLINE_CLEAR_SIZE && dh <= OUTLINE_CLEAR_SIZE {
            near.push((c.smufl, d));
        }
        if dw <= OUTLINE_SIZE_TOL && dh <= OUTLINE_SIZE_TOL && best.is_none_or(|b| d < b.1) {
            best = Some((c.smufl, d));
        }
        if loose.is_none_or(|l| d < l.1) {
            loose = Some((c.smufl, d));
        }
    }
    if let Some(l) = loose.filter(|l| l.1 <= SIG_SAME) {
        return Some(l);
    }
    if let Some(b) = best.filter(|b| b.1 <= OUTLINE_SIG_MAX) {
        return Some(b);
    }
    if let Some(&c) = near.iter().min_by_key(|c| c.1).filter(|c| c.1 <= OUTLINE_SIG_CLEAR) {
        let second = near.iter().filter(|o| o.0 != c.0).map(|o| o.1).min().unwrap_or(u32::MAX);
        if second as f64 >= c.1 as f64 * OUTLINE_CLEAR_RATIO {
            return Some(c);
        }
    }
    let b = best?;
    let round = (w - h).abs() <= w.max(h) * 0.25 && w <= DOT_MAX_EM;
    (b.0 == "augmentationDot" && b.1 <= DOT_SIG_MAX && round).then_some(b)
}

/// 排查用：跨字体签名最近的前 `k` 类（名、距离、宽高差 em），不卡尺寸。
pub fn nearest_outline(rings: &[Vec<(f64, f64)>], size: (f64, f64), k: usize) -> Vec<(&'static str, u32, f64, f64)> {
    let s = sig(rings, None, true);
    let mut v: Vec<_> = dict().iter().map(|c| (c.smufl, sig_distance(&s, &c.sig), c.w - size.0, c.h - size.1)).collect();
    v.sort_by_key(|x| x.1);
    v.truncate(k);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn families_and_codes() {
        assert_eq!(music_family("Maestro"), Some(Family::Maestro));
        assert_eq!(music_family("EngraverTextT"), None);
        assert_eq!(guess_by_code(Family::Maestro, 0xf0ee), Some("restHalf"));
        assert_eq!(guess_by_code(Family::Doremi, 0x47), Some("gClef"));
        assert_eq!(guess_by_code(Family::Doremi, 0xf0cf), Some("noteheadBlack"));
    }

    #[test]
    fn sig_of_square_is_filled_box() {
        let sq = vec![vec![(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]];
        let s = sig(&sq, None, false);
        assert!((sig_fill(&s) - 900.0 / 1024.0).abs() < 0.01, "{}", sig_fill(&s));
        assert!(!dict().is_empty());
    }
}
