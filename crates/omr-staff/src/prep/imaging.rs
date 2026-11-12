//! **成像**（M0.2）：原图 → 识别用的二值图。阈值、放大、补笔按本页量到的谱表定，所以放在五线谱路线里、要先找一遍谱表。
//!
//! 1 位原图直接取位；灰度 / 彩色走 Sauvola，再按谱表情况：
//! - 线距小、线又细：放大一倍再二值化（低分辨率细线页的调号、谱号碎成三五像素的小块，放大后在阈值那一步就成形）；
//! - 一行谱都找不出：逐档放松阈值重来（谱线印得淡的页），到找得出为止；
//! - 细线扫描件：松阈值图里的纵向长游程（小节线、符干）并回原图——整页换松阈值会让谱线变粗、谱号糊掉；
//! - 个别谱行淡：松阈值图里细而长的横向游程（谱线、加线）只补原图的断口，补完多找出谱行、或那一行沿线有墨的列明显变多才留；
//! - 网点 / 网纹 / 水印：见 [`super::texture`]。
//!
//! 不做几何变换（不推平、不纠斜）：弯、斜的谱线由谱表曲线处理，交出的坐标对得回原页面。
use super::texture::clean_texture;
use crate::frame::staves::find_staves;
use dolce_omr_core::image::Binary;
use dolce_omr_core::pixel::texture::merge_horizontal;
use dolce_omr_sheet::{Staff, Unit};
use dolce_omr_source::raster::{fix_polarity, Binarizer, SourceImage};
use dolce_omr_source::ImageKind;

/// 标准阈值档。
const K: f64 = 0.5;
/// 标准档找不出谱行时依次再试的几档。
const K_RETRY: [f64; 3] = [0.35, 0.2, 0.1];
/// 松阈值档（补竖笔、补淡谱线共用一张）：页白 250 时阈值约 208（标准档约 144）。
const K_FAINT: f64 = 0.2;
/// 线距（像素）小于这个数、且线宽 / 线距低于 `UPSCALE_THIN` 的，放大一倍再二值化。
const UPSCALE_SPACE: f64 = 14.0;
/// 线宽本来就粗（墨粗）的放大反倒把谱号、符头糊成一片，只放细线的。
const UPSCALE_THIN: f64 = 0.22;
/// 原分辨率量的线宽不准（浅灰底上淡线两侧的灰边也算成墨），放大一倍再量一次，过这道更严的闸也放大。
const UPSCALE_RECHECK: f64 = 0.16;
/// 线宽 / 线距低于这个数算细线扫描件（补竖笔）。
const FAINT_RATIO: f64 = 0.06;
/// 从松阈值图里取回的竖笔，纵向游程至少几格（小节线 4 格、符干 3 格；谱线、字的竖笔短得多）。
const VERT_RUN: f64 = 1.5;
/// 补淡谱线取的横向游程至少几格。
const LINE_RUN: f64 = 3.0;
/// 补线后一行谱沿线有墨的列占比至少涨这么多，才把这一行的谱表带换成补过线的像素。
const FAINT_GAIN: f64 = 0.15;

/// 一页成像的结果。
pub struct Imaged {
    /// 识别用的二值图（1 = 墨）。
    pub bin: Binary,
    /// 相对原图的放大倍数。
    pub up: usize,
    /// 松阈值档（只灰度 / 彩色页有；与 `bin` 同尺寸）。
    pub soft: Option<Binary>,
    /// 补过竖笔（细线扫描件）。
    pub faint: bool,
    /// 网点率（没有谱表时 0）。
    pub halftone: f64,
    /// 在 `bin` 上找到的谱表。
    pub staves: Option<(Unit, Vec<Staff>)>,
}

fn count(f: &Option<(Unit, Vec<Staff>)>) -> usize {
    f.as_ref().map_or(0, |(_, s)| s.len())
}

/// 放大后有谱行比原分辨率那行短出 `UPSCALE_SHORTER` 格以上（淡线放大后断得更碎，左端退过谱号、调号、拍号到第一个音；
/// 只差两三格的是首行左端读法不同，不算）。两边谱行数一样才比，按次序配。
const UPSCALE_SHORTER: f64 = 6.0;
fn shorter(one: &Option<(Unit, Vec<Staff>)>, big: &Option<(Unit, Vec<Staff>)>) -> bool {
    let (Some((u, a)), Some((_, b))) = (one, big) else { return false };
    a.len() == b.len() && a.iter().zip(b).any(|(p, q)| (q.left / 2.0 - p.left).max(p.right - q.right / 2.0) > u.space * UPSCALE_SHORTER)
}

/// 一页原图成像。
pub fn image_page(src: &SourceImage) -> Imaged {
    let mut bz = Binarizer::new(src);
    if src.kind == ImageKind::Mask {
        let mut bin = bz.binarize(&[K], 1).remove(0);
        fix_polarity(&mut bin);
        let mut found = find_staves(&bin);
        let mut halftone = None;
        if let Some((_, s)) = &found {
            halftone = clean_texture(&mut bin, s, true);
            found = find_staves(&bin);
        }
        return Imaged { bin, up: 1, soft: None, faint: false, halftone: halftone.unwrap_or(0.0), staves: found };
    }
    // 某档阈值的 (二值图, 松档, 放大倍数, 谱表)
    let mut build = |k: f64| -> (Binary, Binary, usize, Option<(Unit, Vec<Staff>)>) {
        let pair = |bz: &mut Binarizer, up: usize| {
            let mut v = bz.binarize(&[k, K_FAINT], up);
            let mut soft = v.pop().unwrap();
            let mut bin = v.pop().unwrap();
            if fix_polarity(&mut bin) {
                fix_polarity(&mut soft);
            }
            let f = find_staves(&bin);
            (bin, soft, up, f)
        };
        let one = pair(&mut bz, 1);
        let Some((u, _)) = &one.3 else { return one };
        if u.space >= UPSCALE_SPACE {
            return one;
        }
        let thin = u.thick / u.space < UPSCALE_THIN;
        let space1 = u.space;
        let big = pair(&mut bz, 2);
        if std::env::var("OMR_STAFF_DEBUG").is_ok() {
            let ext = |f: &Option<(Unit, Vec<Staff>)>| f.as_ref().map(|(_, s)| s.iter().map(|s| (s.left as i64, s.right as i64)).collect::<Vec<_>>());
            eprintln!("放大前 {:?}\n放大后 {:?}", ext(&one.3), ext(&big.3));
        }
        // 放大后找到的谱行比原分辨率少的不放大（扫描件淡线放大后有一行断成几截凑不够列，整行丢）
        let ok = count(&big.3) >= count(&one.3) && !shorter(&one.3, &big.3) && big.3.as_ref().is_some_and(|(u2, _)| thin || u2.thick / (space1 * 2.0) < UPSCALE_RECHECK);
        if ok {
            big
        } else {
            one
        }
    };
    let mut got = build(K);
    // 一行谱都找不出来的，逐档放松阈值重来；只在一行都找不出时才换（松一档能多找出谱行就换，会在歌词带、底纹里多出假谱行）
    if count(&got.3) == 0 {
        for k2 in K_RETRY {
            let g2 = build(k2);
            if count(&g2.3) > 0 {
                got = g2;
                break;
            }
        }
    }
    let (mut bin, soft, up, mut found) = got;
    let mut faint = false;
    if let Some((u, _)) = &found {
        if u.thick / u.space < FAINT_RATIO {
            merge_vertical(&mut bin, &soft, (u.space * VERT_RUN).round() as usize);
            faint = true;
            found = find_staves(&bin);
        }
    }
    let mut halftone = None;
    if let Some((_, s)) = &found {
        halftone = clean_texture(&mut bin, s, true);
        found = find_staves(&bin);
    }
    // 淡谱线补回
    if let Some((u, staves)) = &found {
        let mut trial = bin.clone();
        merge_horizontal(&mut trial.data, &soft.data, bin.w, bin.h, (u.space * LINE_RUN).round() as usize, ((u.thick * 2.0).round() as usize).max(2), (u.thick.round() as i64).max(1));
        let tf = find_staves(&trial);
        if std::env::var("OMR_STAFF_DEBUG").is_ok() {
            eprintln!("补线前左端 {:?}", staves.iter().map(|s| s.left as i64).collect::<Vec<_>>());
            eprintln!("补线后左端 {:?}", tf.as_ref().map(|(_, s)| s.iter().map(|s| s.left as i64).collect::<Vec<_>>()));
        }
        if count(&tf) > staves.len() {
            bin = trial;
            found = tf;
        } else if merge_faint_staves(&mut bin, &trial, staves, u) {
            found = find_staves(&bin);
        }
    }
    // 头一回没找着谱表的，补完淡谱线再试一次——只补针孔，不去网（低分辨率细线页的谱线断成点，会虚抬网点率）
    if halftone.is_none() {
        if let Some((_, s)) = &found {
            halftone = clean_texture(&mut bin, s, false);
            found = find_staves(&bin);
        }
    }
    Imaged { bin, up, soft: Some(soft), faint, halftone: halftone.unwrap_or(0.0), staves: found }
}

/// 把 `soft` 里纵向游程不短于 `min_run` 的像素并进 `bin`。
fn merge_vertical(bin: &mut Binary, soft: &Binary, min_run: usize) {
    let (w, h) = (bin.w, bin.h);
    for x in 0..w {
        let mut y = 0;
        while y < h {
            if soft.data[y * w + x] == 0 {
                y += 1;
                continue;
            }
            let mut e = y;
            while e + 1 < h && soft.data[(e + 1) * w + x] != 0 {
                e += 1;
            }
            if e - y + 1 >= min_run {
                for k in y..=e {
                    bin.data[k * w + x] = 1;
                }
            }
            y = e + 1;
        }
    }
}

/// 只有个别谱行淡：补线前后谱行数一样，可那一行的线是残的。逐行量补线前后沿线有墨的列占比（隔列量，五条线合算），
/// 涨过 `FAINT_GAIN` 的那几行只换它的谱表带（上下各让一格）。回有没有换。
fn merge_faint_staves(bin: &mut Binary, trial: &Binary, staves: &[Staff], u: &Unit) -> bool {
    let tol = ((u.thick / 2.0).round() as i64).max(1);
    let cover = |img: &Binary, s: &Staff| {
        let (mut hit, mut all) = (0usize, 0usize);
        for k in 0..5 {
            let mut x = s.left.max(0.0) as usize;
            while x <= (s.right as usize).min(img.w - 1) {
                let y0 = s.line_y(k, x as f64).round() as i64;
                all += 1;
                if (y0 - tol..=y0 + tol).any(|y| img.ink(x as i64, y)) {
                    hit += 1;
                }
                x += 2;
            }
        }
        if all > 0 {
            hit as f64 / all as f64
        } else {
            1.0
        }
    };
    let mut changed = false;
    for s in staves.iter().filter(|s| !s.one_line) {
        if cover(trial, s) - cover(bin, s) < FAINT_GAIN {
            continue;
        }
        changed = true;
        let sp = s.space();
        let x0 = (s.left - sp).round().max(0.0) as usize;
        let x1 = ((s.right + sp).round() as usize).min(bin.w - 1);
        for x in x0..=x1 {
            let y0 = (s.top(x as f64) - sp).round().max(0.0) as usize;
            let y1 = ((s.bottom(x as f64) + sp).round() as usize).min(bin.h - 1);
            for y in y0..=y1 {
                bin.data[y * bin.w + x] = trial.data[y * bin.w + x];
            }
        }
    }
    changed
}
