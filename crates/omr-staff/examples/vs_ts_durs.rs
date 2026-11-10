//! 时值与 TS 阶段快照对账：TS `notes` 阶段每个音的基本时值 ↔ 这里同位置符头所在和弦的基本时值（线索，不当对错）。
//! 用法：`cargo run --release -p dolce-omr-staff --example vs_ts_durs -- chorus|solo [曲名子串]`（`OMR_V=1` 列不同的）
#[path = "common/mod.rs"]
mod common;
use common::*;
use dolce_omr_sheet::score::NoteType;
use dolce_omr_staff::page::recognize_page;
use std::collections::BTreeMap;

fn base_of(t: NoteType) -> f64 {
    match t {
        NoteType::Whole => 1.0,
        NoteType::Half => 0.5,
        NoteType::Quarter => 0.25,
        NoteType::Eighth => 0.125,
        NoteType::N16th => 0.0625,
        NoteType::N32nd => 0.03125,
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let corpus = a.get(1).cloned().unwrap_or("chorus".into());
    let only = a.get(2).cloned().unwrap_or_default();
    let verbose = std::env::var("OMR_V").is_ok();
    // (TS 基本时值, Rust 基本时值) → 个数，以 1/32 为单位取整作键
    let mut table: BTreeMap<(i64, i64), usize> = BTreeMap::new();
    let (mut both, mut same) = (0usize, 0usize);
    // 附点：TS 有、Rust 有、相同；临时记号同
    let mut marks = (0usize, 0usize, 0usize, 0usize, 0usize, 0usize);
    for_sources(&corpus, &only, |key, pn, snap, src| {
        let Some(page) = recognize_page(src, None) else { return };
        let sp = page.frame.unit.space;
        let k = ts_scale(snap, pn, sp);
        let heads: Vec<(f64, f64, f64, u8, Option<i8>)> = page.notes.iter().flat_map(|r| r.chords.iter().flat_map(|c| c.heads.iter().map(|h| (h.x, h.y, base_of(c.ntype()), c.dots, h.acc)))).collect();
        let (mut dd, mut ad) = (Vec::new(), Vec::new());
        let mut diff = Vec::new();
        for l in stage(snap, pn, "notes").unwrap_or("").lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(l) else { continue };
            if v["rest"].as_bool() != Some(false) {
                continue;
            }
            let (Some(sym), Some(base)) = (v["sym"].as_str(), v["base"].as_f64()) else { continue };
            // "<Sym 码 #n x0,y0,x1,y1>"
            let Some(b) = sym.trim_end_matches('>').rsplit(' ').next() else { continue };
            let n: Vec<f64> = b.split(',').filter_map(|x| x.parse().ok()).collect();
            if n.len() != 4 {
                continue;
            }
            let (cx, cy) = ((n[0] + n[2]) / 2.0 * k, (n[1] + n[3]) / 2.0 * k);
            let Some(h) = heads.iter().find(|h| (h.0 - cx).abs() < sp * 0.6 && (h.1 - cy).abs() < sp * 0.45) else { continue };
            both += 1;
            // 附点、临时记号
            let ts_dots = v["dots"].as_u64().unwrap_or(0) as u8;
            let ts_acc = v["accidental"].as_i64().map(|a| a as i8);
            marks.0 += (ts_dots > 0) as usize;
            marks.1 += (h.3 > 0) as usize;
            marks.2 += (ts_dots > 0 && ts_dots == h.3) as usize;
            marks.3 += ts_acc.is_some() as usize;
            marks.4 += h.4.is_some() as usize;
            marks.5 += (ts_acc.is_some() && ts_acc == h.4) as usize;
            if ts_dots != h.3 {
                dd.push((cx.round(), cy.round(), ts_dots, h.3));
            }
            if ts_acc != h.4 {
                ad.push((cx.round(), cy.round(), ts_acc, h.4));
            }
            *table.entry(((base * 32.0).round() as i64, (h.2 * 32.0).round() as i64)).or_default() += 1;
            // 快照里的时值只留三位小数（0.063），按 1/32 取整比
            if (base * 32.0).round() == (h.2 * 32.0).round() {
                same += 1;
            } else {
                diff.push((cx.round(), cy.round(), base, h.2));
            }
        }
        if verbose && !dd.is_empty() {
            println!("{key} p{pn} 附点 (x, y, TS, Rust) {dd:?}");
        }
        if verbose && !ad.is_empty() {
            println!("{key} p{pn} 临时记号 (x, y, TS, Rust) {ad:?}");
        }
        if verbose && !diff.is_empty() {
            println!("{key} p{pn}（线距 {sp:.1}）：(x, y, TS, Rust) {diff:?}");
        }
    });
    println!("{corpus}：两边都有的头 {both}，基本时值相同 {same}（{:.1}%）", same as f64 * 100.0 / both.max(1) as f64);
    let pct = |a: usize, b: usize| a as f64 * 100.0 / b.max(1) as f64;
    println!("  附点：TS {}，Rust {}，相同 {}（查全 {:.1}%，查准 {:.1}%）", marks.0, marks.1, marks.2, pct(marks.2, marks.0), pct(marks.2, marks.1));
    println!("  临时记号：TS {}，Rust {}，相同 {}（查全 {:.1}%，查准 {:.1}%）", marks.3, marks.4, marks.5, pct(marks.5, marks.3), pct(marks.5, marks.4));
    for ((t, r), n) in table.iter().filter(|((t, r), _)| t != r) {
        println!("  TS {t}/32 ↔ Rust {r}/32：{n}");
    }
}
