//! 渲染一页（或一个框，页面点）成 PNG（排查）：`cargo run --release -p dolce-omr-core --features pdf --example render -- 文件.pdf 页号 输出.png [倍率] [x0 y0 x1 y1]`
use dolce_omr_core::source::PdfDoc;

fn main() -> Result<(), String> {
    let a: Vec<String> = std::env::args().collect();
    let doc = PdfDoc::open(std::fs::read(&a[1]).map_err(|e| e.to_string())?)?;
    let page: usize = a[2].parse().map_err(|_| "页号")?;
    let scale: f64 = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(3.0);
    let r = doc.render(page, scale)?;
    let win: Vec<f64> = a.iter().skip(5).filter_map(|s| s.parse().ok()).collect();
    let (x0, y0, x1, y1) = if win.len() == 4 {
        ((win[0] * scale) as usize, (win[1] * scale) as usize, ((win[2] * scale) as usize).min(r.w), ((win[3] * scale) as usize).min(r.h))
    } else {
        (0, 0, r.w, r.h)
    };
    let mut img = image::RgbaImage::new((x1 - x0) as u32, (y1 - y0) as u32);
    for y in y0..y1 {
        for x in x0..x1 {
            let i = (y * r.w + x) * 4;
            img.put_pixel((x - x0) as u32, (y - y0) as u32, image::Rgba([r.rgba[i], r.rgba[i + 1], r.rgba[i + 2], 255]));
        }
    }
    img.save(&a[3]).map_err(|e| e.to_string())
}
