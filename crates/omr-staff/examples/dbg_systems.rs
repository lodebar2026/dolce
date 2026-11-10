//! 粗检系统划分：逐页各系统的行数；汇总行数分布。用法：dbg_systems chorus|solo [曲名子串] [-v]
#[path = "common/mod.rs"]
mod common;
use common::*;
use dolce_omr_staff::frame::staves::find_staves;
use dolce_omr_staff::frame::systems::find_systems;
use std::collections::BTreeMap;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let corpus = a.get(1).cloned().unwrap_or("chorus".into());
    let only = a.get(2).cloned().unwrap_or_default();
    let verbose = a.iter().any(|x| x == "-v");
    let mut hist: BTreeMap<usize, usize> = BTreeMap::new();
    // 基线归档里 TS 的版面摘要（合唱谱）：逐页各系统的行数
    let refdir = dev().join("data/rust-omr/ref-c7c02820/chorus");
    let refs: Vec<(String, serde_json::Value)> = std::fs::read_dir(&refdir)
        .map(|d| d.filter_map(|e| {
            let p = e.ok()?.path();
            let n = p.file_name()?.to_string_lossy().strip_suffix(".rec.json")?.replacen("__", "_", 1);
            Some((n, serde_json::from_str(&std::fs::read_to_string(&p).ok()?).ok()?))
        }).collect())
        .unwrap_or_default();
    let (mut same, mut diff) = (0usize, 0usize);
    for_pages(&corpus, &only, |key, pn, _snap, bin, soft| {
        let Some((unit, staves)) = find_staves(bin) else { return };
        let sys = find_systems(bin, soft, &staves, &unit);
        let sizes: Vec<usize> = sys.iter().map(|s| s.staves.len()).collect();
        for &n in &sizes {
            *hist.entry(n).or_default() += 1;
        }
        // 同页系统大小不一的列出来（多半是分错）
        let stem = key.rsplit_once('.').map_or(key, |(a, _)| a);
        let ts: Option<Vec<usize>> = refs.iter().find(|(n, _)| n == stem).map(|(_, v)| {
            v["systems"].as_array().into_iter().flatten().filter(|s| s["page"].as_u64() == Some(pn as u64)).map(|s| s["rows"].as_array().map_or(0, |r| r.len())).collect()
        });
        match &ts {
            Some(t) if t == &sizes => same += 1,
            Some(t) => {
                diff += 1;
                println!("{key} p{pn}: Rust {sizes:?} | TS {t:?}");
            }
            None if verbose => println!("{key} p{pn}: {sizes:?}"),
            None => {}
        }
    });
    println!("系统行数分布：{hist:?}；与 TS 版面摘要逐页比：相同 {same} 页，不同 {diff} 页");
}
