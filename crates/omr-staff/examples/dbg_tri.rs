//! 排查：打印某页一块墨层（# 墨、- 存疑、. 空白），连同框里的墨块、休止、和弦（头、干、杠尾数）；不给框时列出 TS 快照该页某类码的框。
//! 用法：dbg_tri chorus 键子串 页 x0 y0 x1 y1 ｜ dbg_tri chorus 键子串 页 码前缀
#[path = "common/mod.rs"]
mod common;
use common::*;
use dolce_omr_staff::frame::ink::{INK, LINE};
use dolce_omr_staff::page::recognize_page;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let page: usize = a[3].parse().unwrap();
    for_sources(&a[1], &a[2], |_k, pn, snap, src| {
        if pn != page {
            return;
        }
        let Some(page) = recognize_page(src, None) else { return };
        let f = &page.frame;
        if a.len() < 8 {
            let k = ts_scale(snap, pn, f.unit.space);
            println!("线距 {:.1}，折算 {k}", f.unit.space);
            for l in stage(snap, pn, "syms").unwrap_or("").lines() {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(l) else { continue };
                if v["code"].as_str().is_some_and(|c| c.starts_with(a[4].as_str())) {
                    let b = &v["box"];
                    let g = |n: &str| b[n].as_f64().unwrap_or(0.0) * k;
                    println!("{} x {:.0} y {:.0} w {:.0} h {:.0}", v["code"].as_str().unwrap(), g("x"), g("y"), g("w"), g("h"));
                }
            }
            return;
        }
        let n = |i: usize| a[i].parse::<i64>().unwrap();
        for y in n(5)..=n(7) {
            let row: String = (n(4)..=n(6)).map(|x| match f.ink.at(x, y) { INK => '#', LINE => '-', _ => '.' }).collect();
            println!("{y:5} {row}");
        }
        // 框里的墨块与认出的休止
        let (bx0, by0, bx1, by1) = (n(4) as f64, n(5) as f64, n(6) as f64, n(7) as f64);
        let sp = f.unit.space;
        for b in f.blobs.iter().filter(|b| b.cx >= bx0 && b.cx <= bx1 && b.cy >= by0 && b.cy <= by1) {
            println!("块 {}：x {:.0} y {:.0} 宽 {:.2} 高 {:.2}（格） 面积 {}", b.id, b.rect.x, b.rect.y, b.rect.w / sp, b.rect.h / sp, b.area);
        }
        for si in 0..f.staves.len() {
            for r in dolce_omr_staff::notes::rests::rests(f, si, 0.0).iter().filter(|r| r.x >= bx0 && r.x <= bx1 && r.y >= by0 && r.y <= by1) {
                println!("休止 行 {si}：{:?} x {:.0} y {:.0} 音级 {:.1}", r.ntype, r.x, r.y, f.staves[si].pos(r.x, r.y));
            }
            for c in page.notes[si].chords.iter().filter(|c| c.x >= bx0 && c.x <= bx1 && c.heads.iter().any(|h| h.y >= by0 && h.y <= by1)) {
                let hs: Vec<(i64, i64, i32)> = c.heads.iter().map(|h| (h.x as i64, h.y as i64, h.pos)).collect();
                println!("和弦 行 {si}：头 {hs:?} {:?} 干 {:?} {} {}", c.kind(), c.stem.map(|s| (s.x, s.top, s.bottom, s.up)), if c.beamed { "杠" } else { "尾" }, c.tails);
            }
        }
    });
}
