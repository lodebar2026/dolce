//! 排查线性符号：某首某页认出的弧、松叶、房子；给了点就列那附近的细笔画与形状。
//! 用法：`cargo run --release -p dolce-omr-staff --example dbg_spans -- <solo|chorus|xinbian> <曲名子串> [页号] [x y [半径]]`
mod common;
use dolce_omr_staff::page::recognize_page;
use dolce_omr_staff::spans::pieces;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let only_page: Option<usize> = a.get(3).and_then(|s| s.parse().ok());
    let at: Option<(f64, f64)> = a.get(4).zip(a.get(5)).and_then(|(x, y)| Some((x.parse().ok()?, y.parse().ok()?)));
    let r: f64 = a.get(6).and_then(|s| s.parse().ok()).unwrap_or(80.0);
    common::for_sources(&a[1], &a[2], |key, pn, _, src| {
        if only_page.is_some_and(|p| p != pn) {
            return;
        }
        let Some(page) = recognize_page(src, None) else { return };
        let f = &page.frame;
        let sp = f.unit.space;
        println!("== {key} p{pn} {}×{} 放大 {} 线距 {sp:.1}", src.w, src.h, f.up);
        for (i, s) in f.staves.iter().enumerate() {
            println!("  谱行 {i}：y {:.0}~{:.0} x {:.0}~{:.0}，和弦 {}", s.ys[0], s.ys[4], s.left, s.right, page.notes[i].chords.len());
        }
        for c in &page.spans.arcs {
            println!("  弧 行{} ({:.0},{:.0})→({:.0},{:.0}) {} 起 {:?} 止 {:?}", c.staff, c.a.0, c.a.1, c.b.0, c.b.1, if c.above { "上" } else { "下" }, c.start.map(|c| (c.x.round(), c.y.round())), c.end.map(|c| (c.x.round(), c.y.round())));
        }
        for w in &page.spans.wedges {
            println!("  松叶 行{} x {:.0}~{:.0} y {:.0} {}", w.staff, w.x0, w.x1, w.y, if w.cresc { "渐强" } else { "渐弱" });
        }
        for v in &page.spans.voltas {
            println!("  房子 行{} x {:.0}~{:.0} y {:.0} {}", v.staff, v.x0, v.x1, v.y, if v.closed { "收口" } else { "不收口" });
        }
        if let Some((x, y)) = at {
            for p in pieces(f, &page.text) {
                let s = &p.shape;
                let (mx, my) = ((s.a.0 + s.b.0) / 2.0, p.mid_y());
                if (mx - x).abs() > r + p.width() / 2.0 || (my - y).abs() > r {
                    continue;
                }
                let (arch, up) = s.arch();
                println!(
                    "  笔画 ({:.0},{:.0})→({:.0},{:.0}) 宽 {:.1} 格 拱 {:.2} 格{} 背 {:.2} 厚 {:.2} 斜 {:.2} 顶在 {:.2}",
                    s.a.0, s.a.1, s.b.0, s.b.1, p.width() / sp, arch / sp, if up { "↑" } else { "↓" }, s.back() / sp, s.thick / sp, s.slope(), s.peak
                );
            }
            for (i, row) in page.notes.iter().enumerate() {
                for c in row.chords.iter().filter(|c| (c.x - x).abs() <= r * 2.0 && c.heads.iter().any(|h| (h.y - y).abs() <= r * 2.0)) {
                    println!("  和弦 行{i} x {:.0} 头 {:?} 干 {:?}", c.x, c.heads.iter().map(|h| (h.y.round(), h.pos)).collect::<Vec<_>>(), c.stem.map(|s| (s.top, s.bottom)));
                }
            }
        }
    });
}
