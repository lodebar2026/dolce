//! 与 TS 位图路取的二值图逐页比（私有仓库 `data/<语料>/raster/` 里 `staffraster.ts` 落的缓存）。
//! 1 位原图（干净位图）应逐像素相同；彩色 / 灰度页 TS 另做了放大、补线、去网，只报差多少像素。
//! 用法：`cargo run --release -p dolce-omr-source --example vs_ts_raster -- 文件.pdf 缓存目录`
use dolce_omr_core::image::Binary;
use dolce_omr_source::raster::{fix_polarity, page_image, Binarizer};
use dolce_omr_source::{ContentOpts, ImageKind, PdfDoc};
use sha2::{Digest, Sha256};
use std::io::Read;

fn main() -> Result<(), String> {
    let a: Vec<String> = std::env::args().collect();
    let bytes = std::fs::read(&a[1]).map_err(|e| e.to_string())?;
    let fp: String = Sha256::digest(&bytes).iter().take(8).map(|b| format!("{b:02x}")).collect();
    let doc = PdfDoc::open(bytes)?;
    let files: Vec<String> = std::fs::read_dir(&a[2]).map_err(|e| e.to_string())?.filter_map(|e| e.ok()?.file_name().into_string().ok()).filter(|f| f.starts_with(&fp)).collect();
    for i in 0..doc.page_count() {
        let Some(f) = files.iter().find(|f| f.ends_with(&format!(".p{}.gz", i + 1))) else { continue };
        let ts = load_ts(&format!("{}/{f}", a[2]))?;
        let pc = doc.content(i, ContentOpts { images: true, paths: false, text: false, outlines: false })?;
        let Some(src) = page_image(&pc) else {
            println!("p{}: Rust 没取到图，TS {:?}", i + 1, ts.as_ref().map(|t| (t.0.w, t.0.h)));
            continue;
        };
        let Some((tb, kind)) = ts else {
            println!("p{}: TS 没有图", i + 1);
            continue;
        };
        // TS 把细线彩色页放大一倍再二值化（那是五线谱路线按线距定的，这里照尺寸跟上）
        let up = if tb.w == src.w * 2 { 2 } else { 1 };
        let mut b = Binarizer::new(&src).binarize(&[0.5], up).remove(0);
        fix_polarity(&mut b);
        if (b.w, b.h) != (tb.w, tb.h) {
            println!("p{}: 尺寸不同 Rust {}×{}（{:?}） TS {}×{}（{kind}）", i + 1, b.w, b.h, src.kind, tb.w, tb.h);
            continue;
        }
        let diff = b.data.iter().zip(&tb.data).filter(|(x, y)| x != y).count();
        let ink = tb.data.iter().filter(|&&v| v == 1).count();
        let tag = if src.kind == ImageKind::Mask { "1 位" } else { "灰度/彩色" };
        println!("p{}: {}×{} {tag}（TS {kind}） 差 {diff} 像素（TS 墨 {ink}，{:.3}%）", i + 1, b.w, b.h, diff as f64 * 100.0 / ink.max(1) as f64);
    }
    Ok(())
}

/// `staffraster.ts` 的格式：gzip（JSON 头一行 + 按位打包的二值图，低位在前 + 灰度数组若干）。
fn load_ts(path: &str) -> Result<Option<(Binary, String)>, String> {
    let mut raw = Vec::new();
    flate2::read::GzDecoder::new(std::fs::File::open(path).map_err(|e| e.to_string())?).read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let nl = raw.iter().position(|&c| c == b'\n').ok_or("没有头")?;
    let meta: serde_json::Value = serde_json::from_slice(&raw[..nl]).map_err(|e| e.to_string())?;
    if meta["none"].as_bool() == Some(true) {
        return Ok(None);
    }
    let (w, h) = (meta["binW"].as_u64().unwrap() as usize, meta["binH"].as_u64().unwrap() as usize);
    Ok(Some((Binary::from_packed(w, h, &raw[nl + 1..]), meta["kind"].as_str().unwrap_or("?").to_string())))
}
