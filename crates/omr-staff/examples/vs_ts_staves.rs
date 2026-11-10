//! 找谱表与 TS 位图路的阶段快照（私有仓库 `data/<语料>/snap/<键>.json.gz` 里每页的 `staves`）对账：
//! 逐页按首线 y 配对，报两边各多出几行、配上的首线 / 左右端差多少。TS 不是标准答案，只当线索。
//! 用法：`cargo run --release -p dolce-omr-staff --example vs_ts_staves -- chorus|solo [曲名子串]`
use dolce_omr_core::image::Binary;
use dolce_omr_source::raster::{fix_polarity, image_file, page_image, Binarizer, SourceImage};
use dolce_omr_source::{ContentOpts, PdfDoc};
use dolce_omr_staff::frame::staves::find_staves;
use std::io::Read;
use std::path::{Path, PathBuf};

fn dev() -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../dev"))
}

/// TS 快照里一页的谱表：每行 (首线 y, 左, 右)，与线距。
fn ts_staves(snap: &serde_json::Value, page: usize) -> Option<(f64, Vec<(f64, f64, f64)>)> {
    let s = snap.get(format!("p{page}/staves"))?.as_str()?;
    let mut space = 0.0;
    let mut rows = Vec::new();
    for line in s.lines() {
        let line = line.trim();
        if let Some(u) = line.strip_prefix("unit: ") {
            space = serde_json::from_str::<serde_json::Value>(u).ok()?["space"].as_f64()?;
        } else if line.starts_with('[') {
            let v: serde_json::Value = serde_json::from_str(line).ok()?;
            let l0 = &v[0];
            rows.push((l0["y"].as_f64()?, l0["left"].as_f64()?, l0["right"].as_f64()?));
        }
    }
    Some((space, rows))
}

fn bin_of(src: &SourceImage) -> Binary {
    let mut b = Binarizer::new(src).binarize(&[0.5], 1).remove(0);
    fix_polarity(&mut b);
    b
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let corpus = a.get(1).map(String::as_str).unwrap_or("chorus");
    let only = a.get(2).cloned().unwrap_or_default();
    let (snapdir, root) = match corpus {
        "solo" => (dev().join("data/五线谱/snap"), dev().join("testdata/五线谱")),
        _ => (dev().join("data/合唱谱/snap"), dev().join("testdata/合唱谱")),
    };
    let (mut pages, mut ts_n, mut rs_n, mut matched, mut d_top, mut d_lr) = (0, 0, 0, 0, 0.0, 0.0);
    let mut odd: Vec<String> = Vec::new();
    let mut names: Vec<PathBuf> = std::fs::read_dir(&snapdir).unwrap().filter_map(|e| Some(e.ok()?.path())).collect();
    names.sort();
    for snapf in names {
        let fname = snapf.file_name().unwrap().to_string_lossy().trim_end_matches(".json.gz").to_string();
        if !fname.contains(&only) {
            continue;
        }
        let mut raw = String::new();
        if flate2::read::GzDecoder::new(std::fs::File::open(&snapf).unwrap()).read_to_string(&mut raw).is_err() {
            continue;
        }
        let snap: serde_json::Value = serde_json::from_str(&raw).unwrap();
        // 底本：合唱谱「曲名_文件名」，独唱谱「曲名」目录里的图（多张按名字排）或 PDF
        let srcs: Vec<SourceImage> = match corpus {
            "solo" => {
                let dir = root.join(&fname);
                let mut fs: Vec<PathBuf> = std::fs::read_dir(&dir).map(|d| d.filter_map(|e| Some(e.ok()?.path())).collect()).unwrap_or_default();
                fs.sort();
                fs.iter().flat_map(|p| sources(p)).collect()
            }
            _ => {
                let Some((song, file)) = split_key(&root, &fname) else { continue };
                sources(&root.join(song).join(file))
            }
        };
        for (i, src) in srcs.iter().enumerate() {
            let Some((ts_space, ts)) = ts_staves(&snap, i + 1) else { continue };
            pages += 1;
            let bin = bin_of(src);
            let found = find_staves(&bin);
            let rs: Vec<(f64, f64, f64)> = found.as_ref().map(|(_, s)| s.iter().map(|s| (s.top((s.left + s.right) / 2.0), s.left, s.right)).collect()).unwrap_or_default();
            // TS 把细线彩色页放大过一倍：按线距比折回来
            let rs_space = found.as_ref().map(|(u, _)| u.space).unwrap_or(ts_space);
            let k = if ts_space > rs_space * 1.6 { 0.5 } else { 1.0 };
            ts_n += ts.len();
            rs_n += rs.len();
            let mut used = vec![false; rs.len()];
            for &(y, l, r) in &ts {
                let (y, l, r) = (y * k, l * k, r * k);
                if let Some(j) = (0..rs.len()).filter(|&j| !used[j] && (rs[j].0 - y).abs() < rs_space).min_by(|&p, &q| (rs[p].0 - y).abs().total_cmp(&(rs[q].0 - y).abs())) {
                    used[j] = true;
                    matched += 1;
                    d_top += (rs[j].0 - y).abs();
                    d_lr += (rs[j].1 - l).abs() + (rs[j].2 - r).abs();
                }
            }
            if rs.len() != ts.len() {
                let extra: Vec<String> = (0..rs.len()).filter(|&j| !used[j]).map(|j| format!("y{:.0} x{:.0}-{:.0}", rs[j].0, rs[j].1, rs[j].2)).collect();
                odd.push(format!("{fname} p{}: TS {} 行，Rust {} 行；Rust 多出 {}", i + 1, ts.len(), rs.len(), extra.join(" ")));
            }
        }
    }
    println!("{corpus}：{pages} 页，TS {ts_n} 行谱，Rust {rs_n} 行，配上 {matched}；首线平均差 {:.2} 像素，左右端平均差 {:.1} 像素", d_top / matched.max(1) as f64, d_lr / (2 * matched.max(1)) as f64);
    for o in odd.iter().take(30) {
        println!("  {o}");
    }
    if odd.len() > 30 {
        println!("  …另有 {} 页", odd.len() - 30);
    }
}

fn split_key<'a>(root: &Path, key: &'a str) -> Option<(&'a str, &'a str)> {
    // 曲名本身可能带下划线：从左往右试，目录存在且文件存在就是它
    key.match_indices('_').map(|(i, _)| (&key[..i], &key[i + 1..])).find(|(s, f)| root.join(s).join(f).exists())
}

fn sources(p: &Path) -> Vec<SourceImage> {
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
