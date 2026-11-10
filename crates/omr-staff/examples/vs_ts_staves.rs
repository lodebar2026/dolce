//! 找谱表与 TS 位图路的阶段快照（私有仓库 `data/<语料>/snap/<键>.json.gz` 里每页的 `staves`）对账：
//! 逐页按首线 y 配对，报两边各多出几行、配上的首线 / 左右端差多少。TS 不是标准答案，只当线索。
//! 用法：`cargo run --release -p dolce-omr-staff --example vs_ts_staves -- chorus|solo [曲名子串]`（`SHOWEND=1` 列端点差大的行）
#[path = "common/mod.rs"]
mod common;
use common::*;
use dolce_omr_staff::frame::staves::find_staves;

/// TS 快照里一页的谱表：每行 (首线 y, 左, 右)。
fn ts_staves(snap: &serde_json::Value, page: usize) -> Vec<(f64, f64, f64)> {
    let Some(s) = stage(snap, page, "staves") else { return vec![] };
    s.lines()
        .filter_map(|line| {
            let line = line.trim();
            if !line.starts_with('[') {
                return None;
            }
            let v: serde_json::Value = serde_json::from_str(line).ok()?;
            let l0 = &v[0];
            Some((l0["y"].as_f64()?, l0["left"].as_f64()?, l0["right"].as_f64()?))
        })
        .collect()
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let corpus = a.get(1).cloned().unwrap_or("chorus".into());
    let only = a.get(2).cloned().unwrap_or_default();
    let (mut pages, mut ts_n, mut rs_n, mut matched, mut d_top, mut d_lr) = (0, 0, 0, 0, 0.0, 0.0);
    let (mut sl, mut sr, mut big) = (0.0, 0.0, 0usize);
    let mut odd: Vec<String> = Vec::new();
    for_pages(&corpus, &only, |key, pn, snap, bin, _soft| {
        let ts = ts_staves(snap, pn);
        pages += 1;
        let found = find_staves(bin);
        let rs: Vec<(f64, f64, f64)> = found.as_ref().map(|(_, s)| s.iter().map(|s| (s.top((s.left + s.right) / 2.0), s.left, s.right)).collect()).unwrap_or_default();
        let rs_space = found.as_ref().map(|(u, _)| u.space).unwrap_or(10.0);
        let k = ts_scale(snap, pn, rs_space);
        ts_n += ts.len();
        rs_n += rs.len();
        let mut used = vec![false; rs.len()];
        let mut lost = Vec::new();
        for &(y, l, r) in &ts {
            let (y, l, r) = (y * k, l * k, r * k);
            match (0..rs.len()).filter(|&j| !used[j] && (rs[j].0 - y).abs() < rs_space).min_by(|&p, &q| (rs[p].0 - y).abs().total_cmp(&(rs[q].0 - y).abs())) {
                Some(j) => {
                    used[j] = true;
                    matched += 1;
                    d_top += (rs[j].0 - y).abs();
                    d_lr += (rs[j].1 - l).abs() + (rs[j].2 - r).abs();
                    sl += rs[j].1 - l;
                    sr += rs[j].2 - r;
                    if (rs[j].1 - l).abs() > rs_space * 2.0 || (rs[j].2 - r).abs() > rs_space * 2.0 {
                        big += 1;
                        if std::env::var("SHOWEND").is_ok() {
                            println!("  端点差大 {key} p{pn} y{y:.0}: 左 {:.0}/{l:.0} 右 {:.0}/{r:.0}", rs[j].1, rs[j].2);
                        }
                    }
                }
                None => lost.push(format!("y{y:.0} x{l:.0}-{r:.0}")),
            }
        }
        let extra: Vec<String> = (0..rs.len()).filter(|&j| !used[j]).map(|j| format!("y{:.0} x{:.0}-{:.0}", rs[j].0, rs[j].1, rs[j].2)).collect();
        if !extra.is_empty() || !lost.is_empty() {
            odd.push(format!("{key} p{pn}: TS {} 行，Rust {} 行；Rust 多 [{}]，少 [{}]", ts.len(), rs.len(), extra.join(" "), lost.join(" ")));
        }
    });
    println!("{corpus}：{pages} 页，TS {ts_n} 行谱，Rust {rs_n} 行，配上 {matched}；首线平均差 {:.2} 像素，左右端平均差 {:.1} 像素", d_top / matched.max(1) as f64, d_lr / (2 * matched.max(1)) as f64);
    println!("左端平均（Rust − TS）{:.1}，右端 {:.1}；差过两格的 {big} 行", sl / matched.max(1) as f64, sr / matched.max(1) as f64);
    for o in odd.iter().take(40) {
        println!("  {o}");
    }
    if odd.len() > 40 {
        println!("  …另有 {} 页", odd.len() - 40);
    }
}
