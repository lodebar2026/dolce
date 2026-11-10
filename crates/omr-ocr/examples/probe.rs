//! OCR 冒烟：整页图分块检测文字框，读前几行。
//! 用法：`cargo run --release -p dolce-omr-ocr --example probe -- 图.png [模型目录]`
use dolce_omr_core::image::Rect;
use dolce_omr_ocr::native::NativeInfer;
use dolce_omr_ocr::surface::{blit, Gray};
use dolce_omr_ocr::Ocr;
use std::path::PathBuf;
use std::time::Instant;

fn main() -> Result<(), String> {
    let a: Vec<String> = std::env::args().collect();
    let dir = PathBuf::from(a.get(2).cloned().unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/../../public/redist/ocr").into()));
    let ocr = Ocr::new(Box::new(NativeInfer::new(&dir, 1, 1)), &std::fs::read_to_string(dir.join("ppocrv6_dict.txt")).map_err(|e| e.to_string())?);
    let img = image::open(&a[1]).map_err(|e| e.to_string())?.to_luma8();
    let g = Gray { w: img.width() as usize, h: img.height() as usize, data: img.into_raw() };
    let t = Instant::now();
    let boxes = ocr.detect_tiled(&g, Rect::new(0.0, 0.0, g.w as f64, g.h as f64), 0.5)?;
    println!("检测 {} 框（{} ms）", boxes.len(), t.elapsed().as_millis());
    let strips: Vec<Gray> = boxes
        .iter()
        .take(12)
        .map(|b| {
            let mut s = Gray::new(b.w.round() as usize, b.h.round() as usize, 255);
            blit(&mut s, &g, *b, Rect::new(0.0, 0.0, b.w.round(), b.h.round()));
            s
        })
        .collect();
    let t = Instant::now();
    for (b, line) in boxes.iter().zip(ocr.read_lines(&strips)?) {
        println!("  [{:.0},{:.0} {:.0}×{:.0}] {}", b.x, b.y, b.w, b.h, line.iter().map(|c| c.ch.as_str()).collect::<String>());
    }
    println!("识别 {} 条（{} ms）", strips.len(), t.elapsed().as_millis());
    Ok(())
}
