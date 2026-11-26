//! 排查：把工作图（二值）的一块写成 BMP（墨黑底白，放大 `倍数`）。用法：dbg_crop 图片|PDF x0 y0 x1 y1 出图.bmp [倍数]
//! PDF 取各页的路径与文字层，看矢量证据（`vector::VecJpInk`）的墨。
use dolce_omr_jianpu::prep::{JpInk, RasterInk};
use dolce_omr_source::raster::image_file;
use dolce_omr_source::{ContentOpts, PdfDoc};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let n = |i: usize| a[i].parse::<i64>().unwrap();
    let (x0, y0, x1, y1) = (n(2), n(3), n(4), n(5));
    let k = a.get(7).map_or(1, |s| s.parse::<i64>().unwrap());
    let bytes = std::fs::read(&a[1]).unwrap();
    let ink: Box<dyn JpInk> = if a[1].to_lowercase().ends_with(".pdf") {
        let doc = PdfDoc::open(bytes).unwrap();
        let pcs: Vec<_> = (0..doc.page_count()).map(|i| doc.content(i, ContentOpts::default()).unwrap()).collect();
        Box::new(dolce_omr_jianpu::vector::VecJpInk::new(&pcs).unwrap())
    } else {
        Box::new(RasterInk::load(&[image_file(&bytes).unwrap()]).unwrap())
    };
    eprintln!("工作图 {}x{}", ink.w(), ink.h());
    let (w, h) = ((x1 - x0) * k, (y1 - y0) * k);
    let stride = ((w * 3 + 3) / 4) * 4;
    let mut out: Vec<u8> = Vec::with_capacity((54 + stride * h) as usize);
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&((54 + stride * h) as u32).to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&54u32.to_le_bytes());
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&(w as i32).to_le_bytes());
    out.extend_from_slice(&(-(h as i32)).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&24u16.to_le_bytes());
    out.extend_from_slice(&[0; 24]);
    for y in 0..h {
        for x in 0..w {
            let v = if ink.at(x0 + x / k, y0 + y / k) { 0 } else { 255 };
            out.extend_from_slice(&[v, v, v]);
        }
        out.extend(std::iter::repeat_n(0, (stride - w * 3) as usize));
    }
    std::fs::write(&a[6], out).unwrap();
}
