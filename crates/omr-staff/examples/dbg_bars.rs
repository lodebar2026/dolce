//! 排查：某页某行谱在某 x 附近的竖段与小节线判据各项。用法：dbg_bars chorus 键子串 页 行 x
#[path = "common/mod.rs"]
mod common;
use common::*;
use dolce_omr_staff::frame::ink::InkLayers;
use dolce_omr_staff::frame::staves::find_staves;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (corpus, key, page, row, x): (&str, &str, usize, usize, f64) = (&a[1], &a[2], a[3].parse().unwrap(), a[4].parse().unwrap(), a[5].parse().unwrap());
    for_pages(corpus, key, |k, pn, _snap, bin| {
        if pn != page {
            return;
        }
        let (unit, staves) = find_staves(bin).unwrap();
        let s = &staves[row - 1];
        println!("{k} p{pn} 行{row}: 首线 {:.1} 末线 {:.1} 线距 {:.1} 左右 {:.0}-{:.0} 线宽 {:?}", s.top(x), s.bottom(x), s.space(), s.left, s.right, s.thick);
        let ink = InkLayers::new(bin, &staves, &unit);
        for v in ink.vsegs((unit.space * 1.0) as usize, unit.thick.ceil().max(2.0) as usize).iter().filter(|v| (v.cx() - x).abs() < unit.space * 2.0) {
            println!("  竖段 x{}-{} y{}-{} 宽{}", v.x0, v.x1, v.y0, v.y1, v.cols);
        }
        let xi = x.round() as i64;
        let col: String = ((s.top(x) - unit.space * 2.0) as i64..(s.bottom(x) + unit.space * 2.0) as i64).map(|y| match ink.at(xi, y) { 0 => '.', 1 => '#', _ => '-' }).collect();
        println!("  x={xi} 一列（上→下，# 墨 - 存疑）：{col}");
    });
}
