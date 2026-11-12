//! 矢量页某框里的对象（排查）：`cargo run --release -p dolce-omr-staff --example dbg_objs -- 文件.pdf 页号 x0 y0 x1 y1`（工作坐标）
use dolce_omr_sheet::prims::VEC_SCALE;
use dolce_omr_source::vector::VecPage;
use dolce_omr_source::{ContentOpts, PdfDoc};

fn main() -> Result<(), String> {
    let a: Vec<String> = std::env::args().collect();
    let doc = PdfDoc::open(std::fs::read(&a[1]).map_err(|e| e.to_string())?)?;
    let pn: usize = a[2].parse().unwrap();
    let b: Vec<f64> = a[3..7].iter().map(|s| s.parse().unwrap()).collect();
    let pc = doc.content(pn, ContentOpts::default())?;
    let vp = VecPage::build(&pc, VEC_SCALE, (0.0, 0.0));
    for o in &vp.objs {
        let r = o.rect;
        if r.right() < b[0] || r.x > b[2] || r.bottom() < b[1] || r.y > b[3] {
            continue;
        }
        let ls: Vec<String> = vp.lines.iter().filter(|l| l.obj == o.id).map(|l| format!("({:.0},{:.0})-({:.0},{:.0})w{:.1}", l.a.0, l.a.1, l.b.0, l.b.1, l.w)).collect();
        println!("#{} {:?} {:?} 框 {:.0},{:.0} {:.0}×{:.0} 填{} 描{:.1} 曲{} 子{} 环{} 线{:?}", o.id, o.kind, o.src, r.x, r.y, r.w, r.h, o.fill, o.stroke, o.curved, o.subpaths, o.rings.len(), ls);
    }
    Ok(())
}
