//! 符头与 TS 阶段快照对账：TS `syms` 阶段的符头框 ↔ 这里挂上干的符头（线索，不当对错）。
//! 用法：`cargo run --release -p dolce-omr-staff --example vs_ts_heads -- chorus|solo [曲名子串] [头型码，缺省 noteheadBlack]`
#[path = "common/mod.rs"]
mod common;
use common::*;
use dolce_omr_staff::notes::heads::{seeds, HeadKind, InkSum};
use dolce_omr_staff::notes::ledgers::ledger_ok;
use dolce_omr_staff::notes::hollow::{hollow_heads_traced, page_holes};
use dolce_omr_staff::notes::stems::find_stem;
use std::collections::BTreeMap;
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
    // 谱表外（加线上的头）单独数：(TS, Rust, 配上)
    let (mut ts_o, mut rs_o, mut hit_o) = (0usize, 0usize, 0usize);
    let only_out = std::env::var("OMR_OUT").is_ok();
    // `OMR_WHY=1`：漏的头卡在哪一关（表内 / 表外分开数）
    let why_on = std::env::var("OMR_WHY").is_ok();
    let mut why: BTreeMap<String, usize> = BTreeMap::new();
    let mut per: Vec<(String, usize, usize, usize)> = Vec::new();
    for_sources(&corpus, &only, |key, pn, snap, src| {
        let Some(page) = recognize_page(src, None) else { return };
        let sp = page.layout.unit.space;
        let k = ts_scale(snap, pn, sp);
        let ts = ts_syms(snap, pn, &code);
        let heads: Vec<(f64, f64, i32, f64)> = page.notes.iter().flat_map(|r| r.chords.iter().flat_map(|c| c.heads.iter().filter(|h| kinds.contains(&h.kind)).map(|h| (h.x, h.y, h.pos, h.score)))).collect();
        let mut used = vec![false; heads.len()];
        let mut miss = Vec::new();
        // 点在谱表外：离它最近的那行谱的首线以上或末线以下半格多
        let outside = |x: f64, y: f64| {
            let st = &page.layout.staves;
            st.iter().min_by(|a, b| (a.y_of(x, 4.0) - y).abs().total_cmp(&(b.y_of(x, 4.0) - y).abs())).is_some_and(|s| {
                let p = s.pos(x, y);
                !(-1.5..=9.5).contains(&p)
            })
        };
        for &(x, y, w, h) in &ts {
            let (cx, cy) = ((x + w / 2.0) * k, (y + h / 2.0) * k);
            let out = outside(cx, cy);
            ts_o += out as usize;
            match (0..heads.len()).find(|&j| !used[j] && (heads[j].0 - cx).abs() < sp * 0.6 && (heads[j].1 - cy).abs() < sp * 0.45) {
                Some(j) => {
                    used[j] = true;
                    hit_o += out as usize;
                }
                None if !only_out || out => miss.push((cx.round(), cy.round())),
                None => {}
            }
        }
        rs_o += heads.iter().filter(|h| !(-1..=9).contains(&h.2)).count();
        if why_on {
            let frame = dolce_omr_staff::page::frame_page(src, None).unwrap();
            let f = &frame;
            let claims = dolce_omr_staff::notes::resolve::Claims::new(f);
            let all_miss: Vec<(f64, f64)> = ts.iter().map(|&(x, y, w, h)| ((x + w / 2.0) * k, (y + h / 2.0) * k)).filter(|&(cx, cy)| !heads.iter().any(|h| (h.0 - cx).abs() < sp * 0.6 && (h.1 - cy).abs() < sp * 0.45)).collect();
            let near = |hx: f64, hy: f64, cx: f64, cy: f64| (hx - cx).abs() < sp * 0.6 && (hy - cy).abs() < sp * 0.45;
            let mut reason: Vec<Option<String>> = vec![None; all_miss.len()];
            if kinds.contains(&HeadKind::Filled) {
                let solid = f.ink.sealed((dolce_omr_staff::notes::hollow::SLIT_AREA * f.unit.space * f.unit.space).round() as usize);
        let sum = InkSum::new(&solid);
                for si in 0..f.staves.len() {
                    let from = page.attrs[si].lead_end.max(f.staves[si].left);
                    for h in seeds(f, &solid, &sum, si, from) {
                        for (i, &(cx, cy)) in all_miss.iter().enumerate() {
                            if !near(h.x, h.y, cx, cy) {
                                continue;
                            }
                            let r = if !ledger_ok(f, &h, 0.65 * f.staves[si].space()) {
                                "加线不成"
                            } else if find_stem(&f.ink, &h, f.staves[si].space(), f.unit.thick, None, &|x| claims.bar_col(si, x)).is_none() {
                                "没有干"
                            } else {
                                "模板或裁决丢"
                            };
                            reason[i] = Some(r.into());
                        }
                    }
                }
            } else {
                let holes = page_holes(f);
        let scale = dolce_omr_staff::notes::head_scale(f, &page.attrs);
                for si in 0..f.staves.len() {
                    let from = page.attrs[si].lead_end.max(f.staves[si].left);
                    hollow_heads_traced(f, &holes, &claims, si, from, scale, &mut |(hx, hy, hw, hh), w| {
                        for (i, &(cx, cy)) in all_miss.iter().enumerate() {
                            if near(hx as f64 + hw as f64 / 2.0, hy as f64 + hh as f64 / 2.0, cx, cy) {
                                // 说明里的数字、括号后面的细节去掉，只留类别
                                let cat: String = w.chars().take_while(|c| !c.is_ascii_digit() && *c != '（' && *c != '-').collect();
                                reason[i] = Some(cat.trim().to_string());
                            }
                        }
                    });
                }
            }
            for (i, &(cx, cy)) in all_miss.iter().enumerate() {
                let zone = if outside(cx, cy) { "表外" } else { "表内" };
                let r = reason[i].clone().unwrap_or("没有候选".into());
                if verbose {
                    println!("    {key} p{pn} ({cx:.0}, {cy:.0}) {zone} {r}");
                }
                *why.entry(format!("{zone} {r}")).or_default() += 1;
            }
        }
        let extra: Vec<(f64, f64, i32, f64)> = heads.iter().zip(&used).filter(|(h, u)| !**u && (!only_out || !(-1..=9).contains(&h.2))).map(|(h, _)| (h.0.round(), h.1.round(), h.2, (h.3 * 100.0).round())).collect();
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
    let mut why: Vec<(String, usize)> = why.into_iter().collect();
    why.sort_by(|a, b| b.1.cmp(&a.1));
    for (k, n) in &why {
        println!("  漏在：{k} {n}");
    }
    println!("  谱表外：TS {ts_o}，Rust {rs_o}，配上 {hit_o}（查全 {:.1}%，查准 {:.1}%）", hit_o as f64 * 100.0 / ts_o.max(1) as f64, hit_o as f64 * 100.0 / rs_o.max(1) as f64);
    println!("{corpus} {code}：TS {ts_n}，Rust {rs_n}，配上 {hit}（查全 {:.1}%，查准 {:.1}%）", hit as f64 * 100.0 / ts_n.max(1) as f64, hit as f64 * 100.0 / rs_n.max(1) as f64);
}
