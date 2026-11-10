//! 内嵌图探针：逐页列出图对象的过滤器、位深、原始尺寸、页上矩阵，并试取未重采样的原图（`get_raw_image`）。
use pdfium_render::prelude::*;

fn main() -> Result<(), PdfiumError> {
    let args: Vec<String> = std::env::args().collect();
    let pdfium = Pdfium::new(Pdfium::bind_to_library(std::env::var("PDFIUM_LIB_PATH").unwrap())?);
    let doc = pdfium.load_pdf_from_file(&args[1], None)?;
    let max: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(2);
    for (pi, page) in doc.pages().iter().enumerate().take(max) {
        for o in page.objects().iter() {
            let Some(img) = o.as_image_object() else { continue };
            let filters: Vec<String> = img.filters().iter().map(|f| f.name().to_string()).collect();
            let m = o.matrix()?;
            let t = std::time::Instant::now();
            let raw = img.get_raw_image();
            let dt = t.elapsed().as_millis();
            let desc = match &raw {
                Ok(im) => format!("{}x{} {:?}", im.width(), im.height(), im.color()),
                Err(e) => format!("失败 {e:?}"),
            };
            println!(
                "p{pi}: 过滤器 {:?} bpp {:?} 原始 {}x{} 矩阵 [{:.2} {:.2} {:.2} {:.2} {:.1} {:.1}] → 取图 {desc}（{dt} ms）",
                filters, img.bits_per_pixel(), img.width().unwrap_or(0), img.height().unwrap_or(0), m.a(), m.b(), m.c(), m.d(), m.e(), m.f()
            );
        }
    }
    Ok(())
}
