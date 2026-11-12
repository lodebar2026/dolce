//! 打开图片与 PDF、页数、页尺寸、渲染（语料在私有仓库，没有就跳过）。
use dolce_omr_engine::{staff_binary, Doc};
use std::path::PathBuf;

fn testdata(rel: &str) -> Option<Vec<u8>> {
    std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../dev/testdata").join(rel)).ok()
}

#[test]
fn image_is_one_page() {
    let Some(b) = testdata("五线谱/万口欢唱/万口欢唱.png") else { return };
    let d = Doc::open(b).unwrap();
    assert!(!d.is_pdf());
    assert_eq!(d.page_count(), 1);
    let (w, h) = d.page_size(0).unwrap();
    let r = d.render(0, 0.5).unwrap();
    assert_eq!((r.w, r.h), ((w * 0.5).round() as usize, (h * 0.5).round() as usize));
    assert_eq!(r.rgba.len(), r.w * r.h * 4);
    let (bin, k) = staff_binary(&d, 0).unwrap();
    assert_eq!(k, 1.0);
    assert_eq!((bin.w as f64, bin.h as f64), (w, h));
    assert!(bin.data.iter().any(|&v| v == 1) && bin.data.iter().any(|&v| v == 0));
}

#[test]
fn pdf_pages_and_render() {
    let Some(b) = testdata("合唱谱/破碎扫描/破碎.pdf") else { return };
    let d = Doc::open(b).unwrap();
    assert!(d.is_pdf());
    assert_eq!(d.page_count(), 11);
    let (w, _) = d.page_size(0).unwrap();
    let r = d.render(0, 2.0).unwrap();
    assert_eq!(r.w, (w * 2.0).round() as usize);
    assert_eq!(d.sources(&[0, 3]).unwrap().iter().map(|s| s.0).collect::<Vec<_>>(), vec![0, 3]);
}
