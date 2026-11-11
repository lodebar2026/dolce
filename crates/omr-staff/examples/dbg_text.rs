//! 排查文字：某首某页各条带里切出的行、段与读出的字。
//! 用法：`cargo run --release -p dolce-omr-staff --example dbg_text -- <solo|chorus|xinbian> <曲名子串> [页号]`
mod common;
use dolce_omr_ocr::cache::CachedOcr;
use dolce_omr_ocr::native::NativeInfer;
use dolce_omr_ocr::{Ocr, OcrCache};
use dolce_omr_staff::page::recognize_page;
use dolce_omr_staff::text::lines::page_bands;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let only_page: Option<usize> = a.get(3).and_then(|s| s.parse().ok());
    let dir = std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../public/redist/ocr"));
    let dict = std::fs::read_to_string(dir.join("ppocrv6_dict.txt")).unwrap();
    let ocr = CachedOcr { ocr: Some(Ocr::new(Box::new(NativeInfer::new(&dir, 1, 4)), &dict)), cache: OcrCache::memory() };
    common::for_sources(&a[1], &a[2], |key, pn, _, src| {
        if only_page.is_some_and(|p| p != pn) {
            return;
        }
        let Some(page) = recognize_page(src, Some(&ocr)) else { return };
        let f = &page.frame;
        println!("== {key} p{pn} {}×{} 放大 {} 线距 {:.1}", src.w, src.h, f.up, f.unit.space);
        let t = std::time::Instant::now();
        let (bands, fh) = page_bands(f, src, &page.notes, &ocr);
        println!("  字行里的假符头 {} 个（页识别时已摘 {}）", fh.len(), page.text.false_heads.len());
        for b in &bands {
            let y = |i: Option<usize>| i.map_or("—".to_string(), |i| format!("{:.0}~{:.0}", f.staves[i].ys[0], f.staves[i].ys[4]));
            println!("  带 上 {} 下 {}", y(b.above), y(b.below));
            for l in &b.lines {
                println!("    行 y {:.0}~{:.0}：{}", l.y0, l.y1, l.segs.iter().map(|s| format!("[{:.0} {}]", s.rect.x, s.text())).collect::<Vec<_>>().join(" "));
            }
        }
        for (i, r) in page.text.rows.iter().enumerate() {
            println!("  谱行 {i}（y {:.0}）：歌词 {} 行；记号 {}", f.staves[i].ys[0], r.lyrics.len(), r.marks.iter().map(|m| format!("{:.0}:{:?}", m.x, m.dir)).collect::<Vec<_>>().join(" "));
        }
        println!("  文字 {} ms，OCR {} 条", t.elapsed().as_millis(), ocr.cache.len());
    });
}
