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
    // 认不出的字形块：签名最近的几类
    if let Some(f) = dolce_omr_staff::vector::frame_vector(&vp) {
        let sp = f.layout.unit.space;
        let mut pieces = dolce_omr_staff::vector::glyphs::path_pieces(&vp);
        for o in vp.objs.iter().filter(|o| o.kind == dolce_omr_source::vector::VKind::Curve) {
            pieces.push(dolce_omr_staff::vector::glyphs::GlyphPiece { obj: o.id, rings: o.rings.clone(), rect: o.rect, curved: true });
        }
        let syms = dolce_omr_staff::vector::glyphs::path_glyphs(&pieces, sp, &vp, &pc);
        for (p, s) in pieces.iter().zip(&syms) {
            let r = p.rect;
            if r.right() < b[0] || r.x > b[2] || r.bottom() < b[1] || r.y > b[3] {
                continue;
            }
            let em = 4.0 * sp;
            let near = dolce_omr_sheet::shapes::nearest_outline(&p.rings, (r.w / em, r.h / em), 3);
            println!("块 obj#{} {:.0},{:.0} {:.0}×{:.0}（{:.2}×{:.2}em）环{} 认{:?} 近{:?}", p.obj, r.x, r.y, r.w, r.h, r.w / em, r.h / em, p.rings.len(), s.name, near.iter().map(|(n, d, dw, dh)| format!("{n}:{d} Δ{dw:.2},{dh:.2}")).collect::<Vec<_>>());
        }
    }
    Ok(())
}
