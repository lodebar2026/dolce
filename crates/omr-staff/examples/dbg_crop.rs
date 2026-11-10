//! 排查：打印某页一块二值图（ASCII，# 墨）。用法：dbg_crop chorus 键子串 页 x0 y0 x1 y1 [步长]
#[path = "common/mod.rs"]
mod common;
use common::*;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let n = |i: usize| a[i].parse::<i64>().unwrap();
    let (x0, y0, x1, y1) = (n(4), n(5), n(6), n(7));
    let step = a.get(8).map_or(1, |s| s.parse().unwrap());
    let page: usize = a[3].parse().unwrap();
    let soft_view = std::env::var("OMR_SOFT").is_ok();
    for_pages(&a[1], &a[2], |_k, pn, _snap, bin, soft| {
        if pn != page {
            return;
        }
        let img = if soft_view { soft.unwrap_or(bin) } else { bin };
        let mut y = y0;
        while y <= y1 {
            let row: String = (x0..=x1).step_by(step as usize).map(|x| if img.ink(x, y) { '#' } else { '.' }).collect();
            println!("{y:5} {row}");
            y += step;
        }
    });
}
