//! 逐页取内容并汇总：图（形态、尺寸、页上框）、路径数、字数与字形轮廓取到的比例（按字体）、整页渲染耗时。
//! 用法：`cargo run --release -p dolce-omr-core --features pdf --example content -- 文件.pdf [最多几页]`
use dolce_omr_core::source::{ContentOpts, PdfDoc};
use std::collections::BTreeMap;
use std::time::Instant;

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let doc = PdfDoc::open(std::fs::read(&args[1]).map_err(|e| e.to_string())?)?;
    let max: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(2);
    println!("{} 页", doc.page_count());
    for i in 0..doc.page_count().min(max) {
        let t = Instant::now();
        let pc = doc.content(i, ContentOpts::default())?;
        let dt = t.elapsed().as_millis();
        println!("p{i}: {:.0}×{:.0}pt  图 {} 路径 {} 字 {}（取数 {dt} ms）", pc.width, pc.height, pc.images.len(), pc.paths.len(), pc.chars.len());
        for im in &pc.images {
            println!("    图 {:?} {}×{} bpp {} {:?} 页上 [{:.1},{:.1} {:.1}×{:.1}]", im.kind, im.w, im.h, im.bpp, im.filters, im.rect.x, im.rect.y, im.rect.w, im.rect.h);
        }
        let mut by: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
        for c in pc.chars.iter().filter(|c| !c.generated && c.unicode > 32) {
            let e = by.entry(&c.font).or_default();
            e.0 += 1;
            if c.outline.is_some() {
                e.1 += 1;
            }
        }
        for (f, (n, k)) in by {
            println!("    字体 {f}: {n} 字，轮廓 {k}");
        }
        let t = Instant::now();
        let r = doc.render(i, 2.0)?;
        println!("    渲染 2 倍 {}×{}（{} ms）", r.w, r.h, t.elapsed().as_millis());
    }
    Ok(())
}
