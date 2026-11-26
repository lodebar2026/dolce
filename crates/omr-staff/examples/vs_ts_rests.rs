//! 休止与 TS 阶段快照对账：TS `syms` 阶段的休止框 ↔ 这里认出的休止（线索，不当对错）。
//! 用法：`cargo run --release -p dolce-omr-staff --example vs_ts_rests -- chorus|solo [曲名子串]`（`OMR_V=1` 列漏与多）
#[path = "common/mod.rs"]
mod common;
use common::*;
use dolce_omr_core::sheet::score::NoteType;
use dolce_omr_staff::page::recognize_page;

const KINDS: [(&str, NoteType); 5] = [("restHBar", NoteType::Whole), ("restHalf", NoteType::Half), ("restQuarter", NoteType::Quarter), ("rest8th", NoteType::Eighth), ("rest16th", NoteType::N16th)];

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let corpus = a.get(1).cloned().unwrap_or("chorus".into());
    let only = a.get(2).cloned().unwrap_or_default();
    let verbose = std::env::var("OMR_V").is_ok();
    // 每种：TS 数、Rust 数、配上（同种）
    let mut tally = [(0usize, 0usize, 0usize); 5];
    let mut wrong_kind = 0usize;
    let mut per: Vec<(String, usize, usize, usize)> = Vec::new();
    for_sources(&corpus, &only, |key, pn, snap, src| {
        let Some(page) = recognize_page(src, None) else { return };
        let sp = page.layout.unit.space;
        let k = ts_scale(snap, pn, sp);
        let mut ts: Vec<(usize, f64, f64)> = Vec::new();
        for l in stage(snap, pn, "syms").unwrap_or("").lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(l) else { continue };
            let Some(ki) = KINDS.iter().position(|(c, _)| v["code"].as_str() == Some(c)) else { continue };
            let b = &v["box"];
            let g = |n: &str| b[n].as_f64().unwrap_or(0.0) * k;
            ts.push((ki, g("x") + g("w") / 2.0, g("y") + g("h") / 2.0));
        }
        let rs: Vec<(usize, f64, f64)> = page.notes.iter().flat_map(|r| r.rests.iter()).filter_map(|r| Some((KINDS.iter().position(|(_, t)| *t == r.ntype)?, r.x, r.y))).collect();
        let mut used = vec![false; rs.len()];
        let (mut miss, mut diff) = (Vec::new(), Vec::new());
        for &(ki, x, y) in &ts {
            tally[ki].0 += 1;
            match (0..rs.len()).find(|&j| !used[j] && (rs[j].1 - x).abs() < sp * 0.8 && (rs[j].2 - y).abs() < sp * 1.0) {
                Some(j) => {
                    used[j] = true;
                    if rs[j].0 == ki {
                        tally[ki].2 += 1;
                    } else {
                        wrong_kind += 1;
                        diff.push((KINDS[ki].0, KINDS[rs[j].0].0, x.round(), y.round()));
                    }
                }
                None => miss.push((KINDS[ki].0, x.round(), y.round())),
            }
        }
        for r in &rs {
            tally[r.0].1 += 1;
        }
        let extra: Vec<(&str, f64, f64)> = rs.iter().zip(&used).filter(|(_, u)| !**u).map(|(r, _)| (KINDS[r.0].0, r.1.round(), r.2.round())).collect();
        if verbose && (!miss.is_empty() || !extra.is_empty() || !diff.is_empty()) {
            println!("{key} p{pn}（线距 {sp:.1}）：漏 {miss:?}\n    多 {extra:?}\n    种类不同 {diff:?}");
        }
        match per.iter_mut().find(|p| p.0 == key) {
            Some(p) => {
                p.1 += ts.len();
                p.2 += miss.len();
                p.3 += extra.len();
            }
            None => per.push((key.to_string(), ts.len(), miss.len(), extra.len())),
        }
    });
    per.sort_by_key(|a| std::cmp::Reverse(a.2 + a.3));
    for (k, n, m, e) in per.iter().take(70) {
        println!("  {k}：TS {n}，漏 {m}，多 {e}");
    }
    for (i, (c, _)) in KINDS.iter().enumerate() {
        let (t, r, h) = tally[i];
        println!("{corpus} {c}：TS {t}，Rust {r}，配上 {h}（查全 {:.1}%，查准 {:.1}%）", h as f64 * 100.0 / t.max(1) as f64, h as f64 * 100.0 / r.max(1) as f64);
    }
    println!("位置配上但种类不同 {wrong_kind}");
}
