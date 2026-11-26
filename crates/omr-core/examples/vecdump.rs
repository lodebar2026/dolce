//! 矢量页的对象清单（排查）：路径逐个列（段数、有无曲线、填 / 描、线宽、外框），字按字体列码位与框。
//! 用法：`cargo run --release -p dolce-omr-core --features pdf --example vecdump -- 文件.pdf 页号 [paths|chars|gen|all]（gen：连 PDFium 补出的空格、换行一起列） [x0 y0 x1 y1]`
use dolce_omr_core::source::model::Seg;
use dolce_omr_core::source::{ContentOpts, PdfDoc};

fn main() -> Result<(), String> {
    let a: Vec<String> = std::env::args().collect();
    let doc = PdfDoc::open(std::fs::read(&a[1]).map_err(|e| e.to_string())?)?;
    let page: usize = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let what = a.get(3).map(String::as_str).unwrap_or("all");
    let win: Vec<f64> = a.iter().skip(4).filter_map(|s| s.parse().ok()).collect();
    let inside = |x: f64, y: f64| win.len() < 4 || (x >= win[0] && x <= win[2] && y >= win[1] && y <= win[3]);
    let pc = doc.content(page, ContentOpts::default())?;
    println!("{:.1}×{:.1}pt 路径 {} 字 {}", pc.width, pc.height, pc.paths.len(), pc.chars.len());
    if what != "chars" {
        for (i, p) in pc.paths.iter().enumerate() {
            let b = p.bbox;
            if !inside(b.x + b.w / 2.0, b.y + b.h / 2.0) {
                continue;
            }
            let cub = p.segs.iter().filter(|s| matches!(s, Seg::Cubic(..))).count();
            let mv = p.segs.iter().filter(|s| matches!(s, Seg::Move(..))).count();
            println!(
                "P{i} [{:.2},{:.2} {:.2}×{:.2}] 段{} 曲{} 子路径{} {}{} lw{:.2}{}",
                b.x, b.y, b.w, b.h, p.segs.len(), cub, mv,
                p.fill.map_or(String::new(), |c| format!("填{c:?}")),
                p.stroke.map_or(String::new(), |c| format!("描{c:?}")),
                p.line_width,
                if p.dashed { " 虚" } else { "" }
            );
        }
    }
    if what != "paths" {
        for (i, c) in pc.chars.iter().enumerate() {
            if (c.generated && what != "gen") || !inside(c.bbox.x + c.bbox.w / 2.0, c.bbox.y + c.bbox.h / 2.0) {
                continue;
            }
            println!(
                "C{i}{} {} U+{:04X} {:?} 字号{:.1} 原点({:.2},{:.2}) 框[{:.2},{:.2} {:.2}×{:.2}]{}",
                if c.generated { "(补)" } else { "" }, c.font, c.unicode, char::from_u32(c.unicode).unwrap_or('?'), c.size_scaled, c.origin.0, c.origin.1, c.bbox.x, c.bbox.y, c.bbox.w, c.bbox.h,
                if c.outline.is_none() { " 无轮廓" } else { "" }
            );
        }
    }
    Ok(())
}
