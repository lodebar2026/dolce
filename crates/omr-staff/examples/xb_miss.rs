//! 排查：GT 有、识别漏掉的音（判分「补音」）卡在哪一关。按系统与小节线定小节的横向范围、按谱号算音级，
//! 看那里的空心孔（二分 / 全音符）或实心种子（四分及更短）在哪一关被丢，或已认出而后面丢了，全集汇总。
//!
//! 用法：`xb_miss xinbian 漏音表.tsv [曲名子串]`；漏音表每行 `曲名\t声部(1起)\t小节(1起)\t音名八度(G4)\t时值(二分/四分…)`。
//! 声部 n 取每个系统里第 n 行谱（新编赞美诗：1 高音谱表、2 低音谱表）；小节号按系统次序、各系统小节线累计数（弱起小节算第 1 小节）。
#[path = "common/mod.rs"]
mod common;
use common::*;
use dolce_omr_sheet::music::Pitch;
use dolce_omr_staff::notes::heads::{seeds, InkSum};
use dolce_omr_staff::notes::hollow::{hollow_heads_traced, page_holes};
use dolce_omr_staff::notes::ledgers::ledger_ok;
use dolce_omr_staff::notes::stems::find_stem;
use dolce_omr_staff::page::recognize_page;
use std::collections::BTreeMap;

struct Miss {
    part: usize,
    m: usize,
    pitch: Pitch,
    hollow: bool,
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let corpus = a.get(1).cloned().unwrap_or("xinbian".into());
    let table = std::fs::read_to_string(&a[2]).unwrap();
    let only = a.get(3).cloned().unwrap_or_default();
    let verbose = std::env::var("OMR_V").is_ok();
    let mut by_song: BTreeMap<String, Vec<Miss>> = BTreeMap::new();
    for l in table.lines() {
        let c: Vec<&str> = l.split('\t').collect();
        if c.len() < 5 {
            continue;
        }
        let pc: Vec<char> = c[3].chars().collect();
        let step = "CDEFGAB".find(pc[0]).unwrap_or(0) as u8;
        let octave = pc.iter().rev().find(|c| c.is_ascii_digit()).and_then(|c| c.to_digit(10)).unwrap_or(4) as i8;
        by_song.entry(c[0].to_string()).or_default().push(Miss {
            part: c[1].parse().unwrap_or(1),
            m: c[2].parse().unwrap_or(1),
            pitch: Pitch { step, octave, alter: 0 },
            hollow: c[4].contains("二分") || c[4].contains('全'),
        });
    }
    let mut tally: BTreeMap<String, usize> = BTreeMap::new();
    // 曲 → 已累计的小节数（跨页接着数）
    let mut offset: BTreeMap<String, usize> = BTreeMap::new();
    for_sources(&corpus, &only, |key, _pn, _snap, src| {
        let Some(misses) = by_song.get(key) else { return };
        let Some(page) = recognize_page(src, None) else { return };
        let frame = dolce_omr_staff::page::frame_page(src, None).unwrap();
        let f = &frame;
        let solid = f.ink.sealed((dolce_omr_staff::notes::hollow::SLIT_AREA * f.unit.space * f.unit.space).round() as usize);
        let sum = InkSum::new(&solid);
        let holes = page_holes(f);
        let scale = dolce_omr_staff::notes::head_scale(f, &page.attrs);
        let claims = dolce_omr_staff::notes::resolve::Claims::new(f);
        let mut systems: Vec<&dolce_omr_staff::frame::systems::System> = page.layout.systems.iter().collect();
        systems.sort_by(|p, q| page.layout.staves[p.staves[0]].ys[0].total_cmp(&page.layout.staves[q.staves[0]].ys[0]));
        let base = *offset.get(key).unwrap_or(&0);
        // 各系统的小节：(全曲小节号, 系统, 左, 右)
        let mut measures: Vec<(usize, usize, f64, f64)> = Vec::new();
        let mut n = base;
        for (k, sys) in systems.iter().enumerate() {
            let si = sys.staves[0];
            let s = &page.layout.staves[si];
            let sp = s.space();
            let mut left = page.attrs[si].lead_end.max(s.left);
            let mut xs: Vec<f64> = page.layout.bars[si].iter().map(|b| b.x).filter(|&x| x > left + sp).collect();
            xs.sort_by(f64::total_cmp);
            if xs.last().is_none_or(|&x| x < s.right - sp * 2.0) {
                xs.push(s.right);
            }
            for x in xs {
                n += 1;
                measures.push((n, k, left, x));
                left = x;
            }
        }
        offset.insert(key.to_string(), n);
        for ms in misses {
            let Some(&(_, k, x0, x1)) = measures.iter().find(|q| q.0 == ms.m) else { continue };
            let Some(&si) = systems[k].staves.get(ms.part - 1) else {
                *tally.entry("没有这一行谱".into()).or_default() += 1;
                continue;
            };
            let s = &page.layout.staves[si];
            let sp = s.space();
            let Some(clef) = page.attrs[si].clef else { continue };
            let pos = clef.pos_of(ms.pitch);
            let inside = |x: f64, y: f64| x >= x0 && x <= x1 && (s.pos(x, y) - pos as f64).abs() <= 0.6;
            // 已认出：最终音里那一处有头
            let got = page.notes[si].chords.iter().any(|c| c.heads.iter().any(|h| inside(h.x, h.y)));
            let why = if got {
                "页里已认出（拼整曲时丢）".to_string()
            } else if ms.hollow {
                let mut r: Option<String> = None;
                hollow_heads_traced(f, &holes, &claims, si, x0, scale, &mut |(hx, hy, hw, hh), w| {
                    // 谱线之间的大空当（两条小节线 / 干之间）不是头的孔，不算
                    if (hw as f64) < sp * 1.6 && inside(hx as f64 + hw as f64 / 2.0, hy as f64 + hh as f64 / 2.0) && r.is_none() {
                        let cat: String = w.chars().take_while(|c| !c.is_ascii_digit() && *c != '（' && *c != '-' && *c != '(').collect();
                        r = Some(format!("孔：{}", cat.trim()));
                    }
                });
                r.unwrap_or_else(|| {
                    // 没有孔：那一处的实心种子（填死的空心头）
                    let seed = seeds(f, &solid, &sum, si, x0).into_iter().find(|h| inside(h.x, h.y));
                    match seed {
                        Some(h) => format!("没有孔，有实心种子（满 {:.1}）", (h.fill * 10.0).round() / 10.0),
                        None => "没有孔也没有种子".into(),
                    }
                })
            } else {
                match seeds(f, &solid, &sum, si, x0).into_iter().find(|h| inside(h.x, h.y)) {
                    Some(h) => {
                        if !ledger_ok(f, &h, 0.65 * sp) {
                            "种子：加线不成".into()
                        } else if find_stem(&f.ink, &h, sp, f.unit.thick, None, &|x| claims.bar_col(si, x)).is_none() {
                            "种子：没有干".into()
                        } else {
                            "种子：模板或裁决丢".into()
                        }
                    }
                    None => {
                        // 那一音级沿小节最满的种子框（看是差一点还是根本没墨）
                        let (bw, bh) = (((0.8 * sp).round() as i64).max(3), ((0.6 * sp).round() as i64).max(3));
                        let mut best = 0.0f64;
                        for x in x0.round() as i64..=x1.round() as i64 {
                            let yc = s.y_of(x as f64, pos as f64).round() as i64;
                            for dy in -1..=1 {
                                let c = sum.count(x - bw / 2, yc + dy - bh / 2, x - bw / 2 + bw, yc + dy - bh / 2 + bh) as f64 / (bw * bh) as f64;
                                best = best.max(c);
                            }
                        }
                        let bucket = if best >= 0.8 { "满 0.8+" } else if best >= 0.6 { "满 0.6~0.8" } else { "满不到 0.6" };
                        let mut r = format!("没有种子（{bucket}）");
                        hollow_heads_traced(f, &holes, &claims, si, x0, scale, &mut |(hx, hy, hw, hh), w| {
                            if inside(hx as f64 + hw as f64 / 2.0, hy as f64 + hh as f64 / 2.0) && w.starts_with("二分") {
                                r = "没有种子，有空心孔（实心头当成了二分）".into();
                            }
                        });
                        r
                    }
                }
            };
            let kind = if ms.hollow { "空心" } else { "实心" };
            if verbose {
                println!("{key} P{} m{} {}{} {kind}：{why}（x {x0:.0}–{x1:.0}，行 {si}，位 {pos}）", ms.part, ms.m, ms.pitch.step_name(), ms.pitch.octave);
            }
            *tally.entry(format!("{kind} {why}")).or_default() += 1;
        }
    });
    let mut v: Vec<_> = tally.into_iter().collect();
    v.sort_by(|p, q| q.1.cmp(&p.1));
    for (k, n) in v {
        println!("{n:6}  {k}");
    }
}
