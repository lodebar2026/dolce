//! 排查：某页某点附近的符头种子为什么留 / 丢。用法：dbg_heads chorus 键子串 页 x y [半径格数]
#[path = "common/mod.rs"]
mod common;
use common::*;
use dolce_omr_staff::notes::heads::{seeds, InkSum};
use dolce_omr_staff::notes::ledgers::ledger_ok;
use dolce_omr_staff::notes::hollow::{hollow_heads_traced, page_holes};
use dolce_omr_staff::notes::stems::find_stem;
use dolce_omr_staff::page::recognize_page;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let page_no: usize = a[3].parse().unwrap();
    let (x, y): (f64, f64) = (a[4].parse().unwrap(), a[5].parse().unwrap());
    let r: f64 = a.get(6).map_or(2.0, |s| s.parse().unwrap());
    for_sources(&a[1], &a[2], |_k, pn, _snap, src| {
        if pn != page_no {
            return;
        }
        let Some(page) = recognize_page(src, None) else { return };
        let f = &page.frame;
        let solid = f.ink.sealed((dolce_omr_staff::notes::hollow::SLIT_AREA * f.unit.space * f.unit.space).round() as usize);
        let sum = InkSum::new(&solid);
        let holes = page_holes(f);
        let scale = dolce_omr_staff::notes::head_scale(f, &page.attrs);
        let claims = dolce_omr_staff::notes::resolve::Claims::new(f);
        for si in 0..f.staves.len() {
            let s = &f.staves[si];
            let sp = s.space();
            let from = page.attrs[si].lead_end.max(s.left);
            println!("行 {si}：首线 {:.0} 末线 {:.0} 线距 {sp:.1} 行首区到 {from:.0}", s.top(x), s.bottom(x));
            if std::env::var("OMR_CURVE").is_ok() {
                println!("  线位 {:?} 曲线 {:?}", s.ys, s.curve.as_ref().map(|c| (c.step, c.d.iter().map(|v| (v * 10.0).round() / 10.0).collect::<Vec<_>>())));
            }
            for h in seeds(f, &solid, &sum, si, from) {
                if (h.x - x).abs() > r * sp || (h.y - y).abs() > r * sp {
                    continue;
                }
                let st = find_stem(&f.ink, &h, sp, f.unit.thick, None, &|x| claims.bar_col(si, x));
                let kept = page.notes[si].chords.iter().any(|c| c.heads.iter().any(|k| (k.x - h.x).abs() < 3.0 && k.pos == h.pos));
                println!("  种子 ({:.0}, {:.0}) 位 {} 满 {:.2} 加线 {} 干 {:?} → {}", h.x, h.y, h.pos, h.fill, ledger_ok(f, &h, 0.65 * sp), st, if kept { "留" } else { "丢" });
            }
            hollow_heads_traced(f, &holes, &claims, si, from, scale, &mut |(hx, hy, hw, hh), why| {
                if (hx as f64 + hw as f64 / 2.0 - x).abs() <= r * sp && (hy as f64 + hh as f64 / 2.0 - y).abs() <= r * sp {
                    println!("  孔 {hx},{hy} {hw}×{hh}：{why}");
                }
            });
        }
    });
}
