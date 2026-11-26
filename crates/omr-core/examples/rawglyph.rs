//! 绕过 pdfium-render 的字形计数（符号字体按 0 号试探得 0，`glyphs().get` 全失败），直接调原生接口：
//! 每个字按它的 Unicode 值取轮廓，统计各字体取到几个。
use pdfium_render::prelude::*;
use std::collections::BTreeMap;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let b = Pdfium::bind_to_library(std::env::var("PDFIUM_LIB_PATH").unwrap()).unwrap();
    unsafe {
        b.FPDF_InitLibrary();
        let doc = b.FPDF_LoadDocument(&args[1], None);
        assert!(!doc.is_null(), "打不开");
        let page = b.FPDF_LoadPage(doc, args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0));
        let tp = b.FPDFText_LoadPage(page);
        let n = b.FPDFText_CountChars(tp);
        let mut stat: BTreeMap<String, (usize, usize)> = BTreeMap::new();
        let mut shown = 0;
        for i in 0..n {
            let obj = b.FPDFText_GetTextObject(tp, i);
            if obj.is_null() {
                continue;
            }
            let font = b.FPDFTextObj_GetFont(obj);
            let mut buf = vec![0i8; 256];
            let len = b.FPDFFont_GetBaseFontName(font, buf.as_mut_ptr(), buf.len());
            let name: String = buf[..len.saturating_sub(1)].iter().map(|&c| c as u8 as char).collect();
            let u = b.FPDFText_GetUnicode(tp, i);
            let gp = b.FPDFFont_GetGlyphPath(font, u, 10.0);
            let segs = if gp.is_null() { 0 } else { b.FPDFGlyphPath_CountGlyphSegments(gp) };
            let e = stat.entry(name.clone()).or_default();
            e.0 += 1;
            if segs > 0 {
                e.1 += 1;
            } else if name.contains("Maestro") && shown < 8 {
                shown += 1;
                println!("取不到 {name} U+{u:04X}");
            }
        }
        for (k, (a, c)) in stat {
            println!("{k}: {a} 字 / 取到轮廓 {c}");
        }
    }
}
