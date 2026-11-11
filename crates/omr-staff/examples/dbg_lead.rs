//! 排查：打印各行谱行首区的墨块（相对谱行左端的 x、宽高按线距、上下沿的音级位置）。用法：dbg_lead chorus|solo 键子串 [页]
#[path = "common/mod.rs"]
mod common;
use common::*;
use dolce_omr_staff::attrs::lead::{acc_kind, read_lead};
use dolce_omr_staff::attrs::units::{stems, units_in};
use dolce_omr_staff::page::frame_page;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let dir = std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../public/redist/ocr"));
    let ocr = dolce_omr_ocr::cache::CachedOcr {
        ocr: Some(dolce_omr_ocr::Ocr::new(Box::new(dolce_omr_ocr::native::NativeInfer::new(&dir, 1, 1)), &std::fs::read_to_string(dir.join("ppocrv6_dict.txt")).unwrap())),
        cache: dolce_omr_ocr::OcrCache::memory(),
    };
    let page: usize = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
    for_sources(&a[1], &a[2], |key, pn, _snap, src| {
        if page != 0 && pn != page {
            return;
        }
        let Some(f) = frame_page(src, None) else { return };
        println!("== {key} p{pn} 线距 {:.1} 线宽 {:.1} 放大 {}", f.unit.space, f.unit.thick, f.up);
        for (i, s) in f.staves.iter().enumerate() {
            let sp = s.space();
            println!("行{} 左 {:.0} 顶 {:.0} 小节线 {:?}", i + 1, s.left, s.top(s.left), f.bars[i].iter().map(|b| ((b.x - s.left) / sp * 10.0).round() / 10.0).collect::<Vec<_>>());
            let us = units_in(&f, s, s.left - sp * 0.5, s.left + sp * 18.0, -6.0, 16.0);
            for u in &us {
                println!("   x {:5.1}..{:5.1} 宽 {:4.2} 高 {:4.2} 位 {:5.1}..{:5.1} 块 {} 形 {:?} 竖笔 {}", (u.rect.x - s.left) / sp, (u.rect.right() - s.left) / sp, u.w(sp), u.h(sp), u.top, u.bottom, u.ids.len(), acc_kind(&f, u, sp), stems(&f, u, 0.55).len());
            }
            if let Some(c) = dolce_omr_staff::attrs::lead::read_clef(&f, s, &us) {
                let xm = c.right + sp * 5.0;
                let st = dolce_omr_staff::attrs::units::strokes(&f, c.right as i64, (c.right + sp * 10.0) as i64, s.y_of(xm, -5.0) as i64, s.y_of(xm, 13.0) as i64, (sp * 1.5) as i64, (sp * 3.3) as i64, (sp * 0.5).ceil() as i64);
                println!("   竖笔 {}", st.iter().map(|k| format!("x{:.1} 位{:.1}..{:.1}", (k.cx() - s.left) / sp, s.pos(k.cx(), k.top as f64), s.pos(k.cx(), k.bottom as f64))).collect::<Vec<_>>().join("  "));
            }
            let r = read_lead(&f, i, Some(&ocr));
            println!("   → 谱号 {:?}（把握 {}） 调号 {:?}（把握 {}） 拍号 {:?} 行首止于 {:.1}", r.clef, r.clef_sure, r.key.map(|k| k.fifths), r.key_sure, r.time, (r.lead_end - s.left) / sp);
        }
    });
}
