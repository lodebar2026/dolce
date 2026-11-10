//! 回归：列曲目（私有仓库 `rust-omr/corpus.mjs`，与判分脚本同一套找曲规则）→ 各曲并行识别 → 产物落盘 →
//! 调判分脚本离线读（`--from`）→ 与 TS 基线（`rust-omr/archive-baseline.sh` 归档的那份）逐曲比。
use crate::recognize::{open_ocr, recognize, RecOutput};
use crate::sibling;
use rayon::prelude::*;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::time::Instant;

pub struct Opts {
    kind: String,
    only: Option<String>,
    jobs: usize,
    out: Option<PathBuf>,
    reference: PathBuf,
    web: PathBuf,
    /// 不识别，把这个目录里同名的识别产物拷过来判（拿 TS 归档的产物自测回归流程：结果应与基线逐曲相同）
    replay: Option<PathBuf>,
    /// 只比这一档（结构 / 音符 / 记号 / 歌词 / 文字 / 页眉）
    area: Option<String>,
    /// 不清产物目录、不识别，只重新判分对比
    judge_only: bool,
}

impl Opts {
    pub fn parse(args: &[String]) -> Self {
        let val = |k: &str| args.iter().find_map(|a| a.strip_prefix(&format!("--{k}=")).map(str::to_string));
        Opts {
            kind: args.iter().find(|a| !a.starts_with("--")).cloned().unwrap_or_default(),
            only: val("only"),
            jobs: val("jobs").and_then(|v| v.parse().ok()).unwrap_or(0),
            out: val("out").map(PathBuf::from),
            reference: val("ref").map(PathBuf::from).unwrap_or_else(|| sibling("dev/data/rust-omr/ref-c7c02820")),
            web: val("web").map(PathBuf::from).unwrap_or_else(|| sibling("web")),
            replay: val("replay").map(PathBuf::from),
            area: val("area"),
            judge_only: args.iter().any(|a| a == "--judge-only"),
        }
    }
}

#[derive(Deserialize)]
struct Song {
    key: String,
    inputs: Vec<String>,
    rec: String,
}

pub fn run(o: &Opts) -> Result<ExitCode, String> {
    if !["jianpu", "solo", "chorus", "xinbian"].contains(&o.kind.as_str()) {
        return Err(format!("不认识的语料档「{}」", o.kind));
    }
    if o.jobs > 0 {
        let _ = rayon::ThreadPoolBuilder::new().num_threads(o.jobs).build_global();
    }
    let out = o.out.clone().unwrap_or_else(|| sibling(&format!("dev/data/rust-omr/runs/{}", o.kind)));
    if !o.judge_only {
        let _ = fs::remove_dir_all(&out);
    }
    fs::create_dir_all(&out).map_err(|e| format!("建 {}：{e}", out.display()))?;

    let listed = node(&o.web, &["../dev/scripts/rust-omr/corpus.mjs", &o.kind])?;
    let mut songs: Vec<Song> = serde_json::from_str(&listed).map_err(|e| format!("曲目清单：{e}"))?;
    if let Some(s) = &o.only {
        songs.retain(|x| x.key.contains(s.as_str()));
    }
    println!("{}：{} 首，产物 → {}", o.kind, songs.len(), out.display());

    let ocr = open_ocr(&sibling(&format!("dev/data/rust-omr/ocr-cache/{}.json", o.kind)))?;
    let t0 = Instant::now();
    let fails: Vec<(String, String)> = songs
        .par_iter()
        .filter(|_| !o.judge_only)
        .filter_map(|s| {
            let r = match &o.replay {
                Some(dir) => replay(dir, &out, &s.rec),
                None => recognize(&o.kind, &s.inputs, &ocr).and_then(|r| write(&out, &s.rec, r)),
            };
            r.err().map(|e| (s.key.clone(), e))
        })
        .collect();
    ocr.cache.save()?;
    println!("识别 {:.1} s，失败 {} 首", t0.elapsed().as_secs_f64(), fails.len());
    for (k, e) in fails.iter().take(5) {
        println!("  ✗ {k}：{e}");
    }

    // 判分（离线读产物）
    let outs = out.to_string_lossy().to_string();
    let report = out.join("ops.json");
    let reps = report.to_string_lossy().to_string();
    let log = match o.kind.as_str() {
        "jianpu" => {
            if o.replay.is_none() {
                node(&o.web, &["../dev/scripts/rust-omr/rec-to-123.mjs", &outs])?;
            }
            node(&o.web, &["../dev/scripts/solo-ops.mjs", "--jianpu", &format!("--from={outs}"), &format!("--out={reps}")])?
        }
        "solo" => node(&o.web, &["../dev/scripts/solo-ops.mjs", "--staff", &format!("--from={outs}"), &format!("--out={reps}")])?,
        "xinbian" => node_env(&o.web, &[("STAFFIMG", "testdata/新编赞美诗五线谱")], &["../dev/scripts/solo-ops.mjs", "--staff", &format!("--from={outs}"), &format!("--out={reps}")])?,
        _ => node(&o.web, &["../dev/scripts/chorus-ops.mjs", &format!("--from={outs}"), &format!("--out-dir={outs}")])?,
    };
    fs::write(out.join("judge.txt"), &log).ok();

    compare(&report, &o.reference.join(ref_name(&o.kind)), o.only.as_deref(), o.area.as_deref())
}

/// 各档基线报告在归档目录里的文件名（合唱谱是并起来的那份 `chorus-parts/ops.json`）。
fn ref_name(kind: &str) -> String {
    if kind == "chorus" { "chorus-parts/ops.json".into() } else { format!("{kind}.ops.json") }
}

fn write(dir: &Path, base: &str, r: RecOutput) -> Result<(), String> {
    let w = |ext: &str, s: &str| fs::write(dir.join(format!("{base}.{ext}")), s).map_err(|e| e.to_string());
    match r {
        RecOutput::Staff { musicxml, layout } => {
            w("rec.musicxml", &musicxml)?;
            w("rec.json", &layout)
        }
        RecOutput::Jianpu { recognized } => w("rec.json", &recognized),
    }
}

/// 拷一首的识别产物（`<base>.rec.*`）。
fn replay(from: &Path, to: &Path, base: &str) -> Result<(), String> {
    let mut n = 0;
    for ext in ["rec.musicxml", "rec.json", "rec.123"] {
        let f = from.join(format!("{base}.{ext}"));
        if f.exists() {
            fs::copy(&f, to.join(format!("{base}.{ext}"))).map_err(|e| e.to_string())?;
            n += 1;
        }
    }
    if n == 0 { Err(format!("{} 里没有 {base}.rec.*", from.display())) } else { Ok(()) }
}

fn node(web: &Path, args: &[&str]) -> Result<String, String> {
    node_env(web, &[], args)
}

fn node_env(web: &Path, env: &[(&str, &str)], args: &[&str]) -> Result<String, String> {
    let mut c = Command::new("node");
    c.current_dir(web).args(args);
    for (k, v) in env {
        c.env(k, v);
    }
    let o = c.output().map_err(|e| format!("起 node：{e}"))?;
    let s = String::from_utf8_lossy(&o.stdout).to_string();
    if !o.status.success() && s.is_empty() {
        return Err(format!("node {} 失败：{}", args.join(" "), String::from_utf8_lossy(&o.stderr)));
    }
    Ok(s)
}

/// 报告里一首的（步数, 从零步数, 档别）：solo-ops 的行是 `total` / `scratch` / `areas`，合唱谱的行是 `opsTotal` / `opsScratch` / `opsUsed`。
/// `area` 给了就只取那一档（「结构」「音符」…）。档别：合唱谱分 干净 / 扫描 / 矢量，其余为空。
fn rows(path: &Path, area: Option<&str>) -> Result<BTreeMap<String, (f64, f64, &'static str)>, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("读 {}：{e}", path.display()))?;
    let rows: Vec<serde_json::Value> = serde_json::from_str(&text).map_err(|e| format!("解 {}：{e}", path.display()))?;
    let mut m = BTreeMap::new();
    for r in rows {
        let key = match (r["song"].as_str(), r["file"].as_str()) {
            (Some(s), Some(f)) => format!("{s}/{f}"),
            (Some(s), None) => s.to_string(),
            _ => continue,
        };
        let chorus = r.get("opsTotal").is_some();
        let (used, scratch) = match (area, chorus) {
            (None, false) => (r["total"].as_f64(), r["scratch"].as_f64()),
            (None, true) => (r["opsTotal"].as_f64(), r["opsScratch"].as_f64()),
            (Some(a), false) => (r["areas"][a].as_f64(), r["scratchAreas"][a].as_f64()),
            (Some(a), true) => (r["opsUsed"][a].as_f64(), r["opsScratchAreas"][a].as_f64()),
        };
        let class = if !chorus {
            ""
        } else if r["vector"].as_bool() == Some(true) {
            "矢量"
        } else if r["clean"].as_bool() == Some(true) {
            "干净"
        } else {
            "扫描"
        };
        if let (Some(u), Some(s)) = (used, scratch) {
            m.insert(key, (u, s, class));
        }
    }
    Ok(m)
}

fn compare(report: &Path, reference: &Path, only: Option<&str>, area: Option<&str>) -> Result<ExitCode, String> {
    let base = rows(reference, area)?;
    let now = rows(report, area).unwrap_or_default();
    let keys: Vec<&String> = base.keys().filter(|k| only.is_none_or(|s| k.contains(s))).collect();
    // 档别 → (基线步数, 基线从零, 本次步数, 本次从零, 首数, 缺)
    let mut sums: BTreeMap<&str, [f64; 6]> = BTreeMap::new();
    let mut worse = Vec::new();
    for k in &keys {
        let (bu, bs, class) = base[*k];
        let e = sums.entry(class).or_default();
        e[4] += 1.0;
        match now.get(*k) {
            None => e[5] += 1.0,
            Some(&(nu, ns, _)) => {
                e[0] += bu;
                e[1] += bs;
                e[2] += nu;
                e[3] += ns;
                if nu > bu {
                    worse.push((k.to_string(), bu, nu, bs));
                }
            }
        }
    }
    let pct = |u: f64, s: f64| if s > 0.0 { (1.0 - u / s) * 100.0 } else { 100.0 };
    let what = area.unwrap_or("合计");
    let mut bad = false;
    for (class, e) in &sums {
        println!(
            "{}{what}：基线 {:.2}%（{}/{}）→ 本次 {:.2}%（{}/{}）；{} 首，缺产物 {}（缺的两边都不计）",
            if class.is_empty() { String::new() } else { format!("【{class}】") },
            pct(e[0], e[1]), e[0], e[1], pct(e[2], e[3]), e[2], e[3], e[4], e[5]
        );
        bad |= e[2] > e[0] || e[5] > 0.0;
    }
    println!("比基线步数多的 {} 首：", worse.len());
    worse.sort_by(|a, b| (b.2 - b.1).total_cmp(&(a.2 - a.1)));
    for (k, b, n, s) in worse.iter().take(25) {
        println!("  {k}：{b} → {n} 步（从零 {s}）");
    }
    Ok(if bad { ExitCode::from(1) } else { ExitCode::SUCCESS })
}
