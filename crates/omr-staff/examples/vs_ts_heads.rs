//! 符头与 TS 阶段快照对账：TS `syms` 阶段的符头框 ↔ 这里挂上干的符头（线索，不当对错）。
//! 用法：`cargo run --release -p dolce-omr-staff --example vs_ts_heads -- chorus|solo [曲名子串] [头型码，缺省 noteheadBlack]`
#[path = "common/mod.rs"]
mod common;
use common::*;
use dolce_omr_staff::notes::heads::HeadKind;
use dolce_omr_staff::page::recognize_page;

/// TS `syms` 阶段某种码的框 (x, y, w, h)。
fn ts_syms(snap: &serde_json::Value, page: usize, code: &str) -> Vec<(f64, f64, f64, f64)> {
    let Some(s) = stage(snap, page, "syms") else { return vec![] };
    s.lines()
        .filter_map(|l| {
            let v: serde_json::Value = serde_json::from_str(l).ok()?;
            let c = v["code"].as_str()?;
            // `hollow`：二分与全音符合起来比（TS 的头型码在挂干之前定，全音符有的记成 noteheadHalf）
            if !(c == code || (code == "hollow" && (c == "noteheadHalf" || c == "noteheadWhole"))) {
                return None;
            }
            let b = &v["box"];
            Some((b["x"].as_f64()?, b["y"].as_f64()?, b["w"].as_f64()?, b["h"].as_f64()?))
        })
        .collect()
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let corpus = a.get(1).cloned().unwrap_or("chorus".into());
    let only = a.get(2).cloned().unwrap_or_default();
    let code = a.get(3).cloned().unwrap_or("noteheadBlack".into());
    let kinds: &[HeadKind] = match code.as_str() {
        "noteheadHalf" => &[HeadKind::Half],
        "noteheadWhole" => &[HeadKind::Whole],
        "hollow" => &[HeadKind::Half, HeadKind::Whole],
        _ => &[HeadKind::Filled],
    };
    let verbose = std::env::var("OMR_V").is_ok();
    let (mut ts_n, mut rs_n, mut hit) = (0usize, 0usize, 0usize);
    let mut per: Vec<(String, usize, usize, usize)> = Vec::new();
    for_sources(&corpus, &only, |key, pn, snap, src| {
        let Some(page) = recognize_page(src, None) else { return };
        let sp = page.frame.unit.space;
        let k = ts_scale(snap, pn, sp);
        let ts = ts_syms(snap, pn, &code);
        let heads: Vec<(f64, f64, i32, f64)> = page.notes.iter().flat_map(|r| r.chords.iter().flat_map(|c| c.heads.iter().filter(|h| kinds.contains(&h.kind)).map(|h| (h.x, h.y, h.pos, h.score)))).collect();
        let mut used = vec![false; heads.len()];
        let mut miss = Vec::new();
        for &(x, y, w, h) in &ts {
            let (cx, cy) = ((x + w / 2.0) * k, (y + h / 2.0) * k);
            match (0..heads.len()).find(|&j| !used[j] && (heads[j].0 - cx).abs() < sp * 0.6 && (heads[j].1 - cy).abs() < sp * 0.45) {
                Some(j) => used[j] = true,
                None => miss.push((cx.round(), cy.round())),
            }
        }
        let extra: Vec<(f64, f64, i32, f64)> = heads.iter().zip(&used).filter(|(_, u)| !**u).map(|(h, _)| (h.0.round(), h.1.round(), h.2, (h.3 * 100.0).round())).collect();
        ts_n += ts.len();
        rs_n += heads.len();
        hit += ts.len() - miss.len();
        if verbose && (!miss.is_empty() || !extra.is_empty()) {
            println!("{key} p{pn}（线距 {sp:.1}）：漏 {miss:?}\n    多 {extra:?}");
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
    per.sort_by(|a, b| (b.2 + b.3).cmp(&(a.2 + a.3)));
    for (k, n, m, e) in per.iter().take(70) {
        println!("  {k}：TS {n}，漏 {m}，多 {e}");
    }
    println!("{corpus} {code}：TS {ts_n}，Rust {rs_n}，配上 {hit}（查全 {:.1}%，查准 {:.1}%）", hit as f64 * 100.0 / ts_n.max(1) as f64, hit as f64 * 100.0 / rs_n.max(1) as f64);
}
