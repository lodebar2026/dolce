//! 小节线与 TS 阶段快照对账：TS `context` 阶段每行谱的 `barXs`（建页后投票、验墨过的）↔ 这里逐行的候选（未经系统互证）。
//! 用法：`cargo run --release -p dolce-omr-staff --example vs_ts_bars -- chorus|solo [曲名子串]`
#[path = "common/mod.rs"]
mod common;
use common::*;
use dolce_omr_staff::frame::bars::page_barlines;
use dolce_omr_staff::frame::systems::find_systems;
use dolce_omr_staff::frame::ink::InkLayers;
use dolce_omr_staff::frame::staves::find_staves;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let corpus = a.get(1).cloned().unwrap_or("chorus".into());
    let only = a.get(2).cloned().unwrap_or_default();
    let (mut ts_n, mut rs_n, mut hit, mut staves_n, mut lead) = (0usize, 0usize, 0usize, 0usize, 0usize);
    let (mut weak_n, mut weak_hit) = (0usize, 0usize);
    let mut worst: Vec<(usize, String)> = Vec::new();
    for_pages(&corpus, &only, |key, pn, snap, bin, soft| {
        let Some((unit, staves)) = find_staves(bin) else { return };
        let ts = ts_bar_xs(snap, pn);
        let k = ts_scale(snap, pn, unit.space);
        let ink = InkLayers::new(bin, &staves, &unit);
        let segs = ink.vsegs((unit.space * 3.0) as usize, unit.thick.ceil().max(2.0) as usize);
        let systems = find_systems(bin, soft, &staves, &unit);
        let all = if std::env::var("OMR_NOSYS").is_ok() {
            let one: Vec<_> = (0..staves.len()).map(|i| dolce_omr_staff::frame::systems::System { staves: vec![i], linked: false, braces: Vec::new() }).collect();
            page_barlines(&ink, &segs, &staves, &one, &unit)
        } else {
            page_barlines(&ink, &segs, &staves, &systems, &unit)
        };
        for (i, s) in staves.iter().enumerate() {
            let Some(raw) = ts.iter().find(|(top, _)| (top * k - s.top((s.left + s.right) / 2.0)).abs() < unit.space).map(|t| &t.1) else { continue };
            // TS 把双线、终止线的两笔各记一个 x：相隔一格以内的并成一条（取中点）
            let mut tx: Vec<f64> = Vec::new();
            let mut grp: Vec<f64> = Vec::new();
            for &x in raw {
                if grp.last().is_some_and(|&p| (x - p) * k > unit.space) {
                    tx.push(grp.iter().sum::<f64>() / grp.len() as f64);
                    grp.clear();
                }
                grp.push(x);
            }
            if !grp.is_empty() {
                tx.push(grp.iter().sum::<f64>() / grp.len() as f64);
            }
            let tx = &tx;
            staves_n += 1;
            let bars = &all[i];
            ts_n += tx.len();
            rs_n += bars.len();
            let mut used = vec![false; bars.len()];
            let mut miss = 0;
            for &x in tx {
                if let Some(j) = (0..bars.len()).find(|&j| !used[j] && (bars[j].x - x * k).abs() < unit.space) {
                    used[j] = true;
                    hit += 1;
                    weak_hit += bars[j].weak as usize;
                } else if x * k < s.left + unit.space * 1.5 {
                    // 行首那根（TS 把系统线也记进小节线；这里系统线归系统层）
                    lead += 1;
                } else {
                    miss += 1;
                }
            }
            weak_n += bars.iter().filter(|b| b.weak).count();
            let extra = used.iter().filter(|u| !**u).count();
            if miss + extra > 0 {
                worst.push((miss + extra, format!("{key} p{pn} 行{}: TS {:?} | Rust {:?}", i + 1, tx.iter().map(|x| (x * k).round()).collect::<Vec<_>>(), bars.iter().map(|b| b.x.round()).collect::<Vec<_>>())));
            }
        }
    });
    let real = ts_n - lead;
    println!("{corpus}：{staves_n} 行谱，TS 小节线 {ts_n}（行首 {lead} 根不计），Rust {rs_n}，配上 {hit}（召回 {:.1}%，Rust 多出 {}）；其中存疑 {weak_n}（配上 {weak_hit}）", hit as f64 * 100.0 / real.max(1) as f64, rs_n - hit);
    worst.sort_by_key(|a| std::cmp::Reverse(a.0));
    for (_, w) in worst.iter().take(12) {
        println!("  {w}");
    }
}
