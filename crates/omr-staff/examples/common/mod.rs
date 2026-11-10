//! 对账工具的公共件：逐页取底本二值图、读 TS 阶段快照。
#![allow(dead_code)]
use dolce_omr_core::image::Binary;
use dolce_omr_source::raster::{fix_polarity, image_file, page_image, Binarizer, SourceImage};
use dolce_omr_source::{ContentOpts, PdfDoc};
use std::io::Read;
use std::path::{Path, PathBuf};

pub fn dev() -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../dev"))
}

/// 只取标准档（不按谱表调整）：对比成像策略用。
pub fn plain_bin(src: &SourceImage) -> Binary {
    let mut b = Binarizer::new(src).binarize(&[0.5], 1).remove(0);
    fix_polarity(&mut b);
    b
}

/// 成像（按谱表调整阈值、放大、补笔），回 (二值图, 松阈值图)。环境变量 `OMR_PLAIN=1` 时只取标准档。
pub fn bin_of(src: &SourceImage) -> (Binary, Option<Binary>) {
    if std::env::var("OMR_PLAIN").is_ok() {
        return (plain_bin(src), None);
    }
    let im = dolce_omr_staff::prep::imaging::image_page(src);
    (im.bin, im.soft)
}

/// TS 快照里一页某阶段的文本。
pub fn stage<'a>(snap: &'a serde_json::Value, page: usize, name: &str) -> Option<&'a str> {
    snap.get(format!("p{page}/{name}"))?.as_str()
}

/// TS 那页的线距（`staves` 阶段的 unit）。
pub fn ts_space(snap: &serde_json::Value, page: usize) -> Option<f64> {
    let s = stage(snap, page, "staves")?;
    let u = s.lines().find_map(|l| l.trim().strip_prefix("unit: "))?;
    serde_json::from_str::<serde_json::Value>(u).ok()?["space"].as_f64()
}

/// 两边放大与否不同（细线彩色页放大一倍）：按线距比把 TS 坐标折成 Rust 的。
pub fn ts_scale(snap: &serde_json::Value, page: usize, rs_space: f64) -> f64 {
    match ts_space(snap, page) {
        Some(t) if t > rs_space * 1.6 => 0.5,
        Some(t) if t < rs_space / 1.6 => 2.0,
        _ => 1.0,
    }
}

/// TS `context` 阶段每行谱的 (首线 y, 小节线 x 升序)。
pub fn ts_bar_xs(snap: &serde_json::Value, page: usize) -> Vec<(f64, Vec<f64>)> {
    let Some(s) = stage(snap, page, "context") else { return vec![] };
    s.lines()
        .filter_map(|l| {
            let i = l.find("> {")?;
            let tag = &l[..i];
            let top: f64 = tag.split(' ').nth(2)?.split(',').nth(1)?.parse().ok()?;
            let v: serde_json::Value = serde_json::from_str(&l[i + 2..]).ok()?;
            let mut xs: Vec<f64> = v["barXs"].as_array()?.iter().filter_map(|x| x.as_f64()).collect();
            xs.sort_by(f64::total_cmp);
            Some((top, xs))
        })
        .collect()
}

/// 逐页：(快照键, 页号, 快照, 二值图, 松阈值图)。
pub fn for_pages(corpus: &str, only: &str, mut f: impl FnMut(&str, usize, &serde_json::Value, &Binary, Option<&Binary>)) {
    for_sources(corpus, only, |key, pn, snap, src| {
        let (bin, soft) = bin_of(src);
        f(key, pn, snap, &bin, soft.as_ref());
    });
}

/// 逐页：(快照键, 页号, 快照, 原图)。只走 TS 快照里有谱表的页。
pub fn for_sources(corpus: &str, only: &str, mut f: impl FnMut(&str, usize, &serde_json::Value, &SourceImage)) {
    let (snapdir, root) = match corpus {
        "solo" => (dev().join("data/五线谱/snap"), dev().join("testdata/五线谱")),
        _ => (dev().join("data/合唱谱/snap"), dev().join("testdata/合唱谱")),
    };
    let mut names: Vec<PathBuf> = std::fs::read_dir(&snapdir).unwrap().filter_map(|e| Some(e.ok()?.path())).collect();
    names.sort();
    for snapf in names {
        let key = snapf.file_name().unwrap().to_string_lossy().trim_end_matches(".json.gz").to_string();
        if !key.contains(only) {
            continue;
        }
        let mut raw = String::new();
        if flate2::read::GzDecoder::new(std::fs::File::open(&snapf).unwrap()).read_to_string(&mut raw).is_err() {
            continue;
        }
        let snap: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let srcs: Vec<SourceImage> = match corpus {
            "solo" => {
                let dir = root.join(&key);
                let mut fs: Vec<PathBuf> = std::fs::read_dir(&dir).map(|d| d.filter_map(|e| Some(e.ok()?.path())).collect()).unwrap_or_default();
                fs.sort();
                fs.iter().flat_map(|p| sources(p)).collect()
            }
            _ => {
                let Some((song, file)) = split_key(&root, &key) else { continue };
                sources(&root.join(song).join(file))
            }
        };
        for (i, src) in srcs.iter().enumerate() {
            if stage(&snap, i + 1, "staves").is_none() {
                continue;
            }
            f(&key, i + 1, &snap, src);
        }
    }
}

fn split_key<'a>(root: &Path, key: &'a str) -> Option<(&'a str, &'a str)> {
    key.match_indices('_').map(|(i, _)| (&key[..i], &key[i + 1..])).find(|(s, f)| root.join(s).join(f).exists())
}

pub fn sources(p: &Path) -> Vec<SourceImage> {
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let Ok(bytes) = std::fs::read(p) else { return vec![] };
    if ext == "pdf" {
        let Ok(doc) = PdfDoc::open(bytes) else { return vec![] };
        (0..doc.page_count()).filter_map(|i| page_image(&doc.content(i, ContentOpts { images: true, paths: false, text: false, outlines: false }).ok()?)).collect()
    } else if ["jpg", "jpeg", "png"].contains(&ext.as_str()) {
        image_file(&bytes).map(|s| vec![s]).unwrap_or_default()
    } else {
        vec![]
    }
}
