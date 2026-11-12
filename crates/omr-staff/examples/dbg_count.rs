//! 排查：每首页内认出的符头数（全部谱行）。用法：dbg_count xinbian [曲名子串]
#[path = "common/mod.rs"]
mod common;
use common::*;
use dolce_omr_staff::page::recognize_page;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let only = a.get(2).cloned().unwrap_or_default();
    for_sources(&a[1], &only, |key, pn, _snap, src| {
        let Some(page) = recognize_page(src, None) else { return };
        let heads: usize = page.notes.iter().map(|r| r.chords.iter().map(|c| c.heads.len()).sum::<usize>()).sum();
        println!("{key}\t{pn}\t{heads}");
    });
}
