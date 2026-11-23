//! 文件名与按目录核对的报告。对应 web `omr/booksplit/index.ts` 的 `songFileNames` / `checkAgainstToc`。
use crate::plan::SongPlan;
use crate::BookPlan;
use regex::Regex;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::LazyLock;

static BAD_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"[\\/:*?"<>|\s]+"#).unwrap());

/// 文件名：`曲号 曲名`（曲号补零到全书最大号的位数，至少三位），去掉文件系统不认的字符；重名加 `(2)`。
pub fn song_file_names(songs: &[SongPlan]) -> Vec<String> {
    let max_n = songs.iter().filter_map(|s| s.number).max().unwrap_or(0);
    let width = 3.max(max_n.to_string().len());
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    songs
        .iter()
        .enumerate()
        .map(|(k, s)| {
            let num = s.number.map_or_else(|| format!("未编号{}", k + 1), |n| format!("{n:0width$}"));
            let t = BAD_NAME.replace_all(&s.title, "");
            let mut name = format!("{num} {}", if t.is_empty() { "未识别曲名" } else { &t });
            let c = seen.entry(name.clone()).or_insert(0);
            *c += 1;
            if *c > 1 {
                name += &format!("({c})");
            }
            name
        })
        .collect()
}

#[derive(Clone, Debug, Serialize)]
pub struct Missing {
    pub number: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitReport {
    /// 期望的曲号：目录最大号以内的全部号。
    pub expected: u32,
    pub written: usize,
    /// 缺：目录里有（或在号段内）却没切出来。
    pub missing: Vec<Missing>,
    /// 切出来、目录里却没有的号。
    pub extra: Vec<u32>,
    pub duplicate: Vec<u32>,
    /// 起始页与目录不符：[曲号, 目录页, 实际印页]。
    pub page_mismatch: Vec<(u32, u32, i64)>,
    /// 没认出曲名的（songs 下标）。
    pub no_title: Vec<usize>,
    #[serde(skip)]
    pub text: String,
}

/// 按目录核对，并生成可读报告。`names` 是写出的文件名（与 songs 同序）。
pub fn check_against_toc(plan: &BookPlan, names: &[String], src_name: &dyn Fn(usize) -> String) -> SplitReport {
    let (toc, songs, region) = (&plan.toc, &plan.songs, &plan.region);
    let mut counts: BTreeMap<u32, usize> = BTreeMap::new();
    for s in songs {
        if let Some(n) = s.number {
            *counts.entry(n).or_insert(0) += 1;
        }
    }
    let max_n = toc.numbers.iter().copied().max().unwrap_or(0);
    let missing: Vec<Missing> = (1..=max_n).filter(|n| !counts.contains_key(n)).map(|n| Missing { number: n, text: toc.texts.get(&n).cloned(), page: toc.pages.get(&n).copied() }).collect();
    let extra: Vec<u32> = counts.keys().copied().filter(|n| !toc.numbers.is_empty() && !toc.numbers.contains(n)).collect();
    let duplicate: Vec<u32> = counts.iter().filter(|(_, &c)| c > 1).map(|(&n, _)| n).collect();
    let mut page_mismatch = Vec::new();
    if let Some(off) = region.offset {
        for s in songs {
            let Some(n) = s.number else { continue };
            let actual = s.start_page as i64 - off;
            if let Some(&tp) = toc.pages.get(&n) {
                if tp as i64 != actual {
                    page_mismatch.push((n, tp, actual));
                }
            }
        }
    }
    let no_title: Vec<usize> = songs.iter().enumerate().filter(|(_, s)| s.title.is_empty()).map(|(k, _)| k).collect();

    let mut l: Vec<String> = Vec::new();
    let page_label = |i: usize| match region.offset {
        Some(o) => format!("{}（印页 {}）", src_name(i), i as i64 - o),
        None => src_name(i),
    };
    l.push(format!("歌谱区：{} – {}，共 {} 页", page_label(region.first), page_label(region.last), region.last - region.first + 1));
    l.push(format!(
        "目录：读自 {} 页，得 {} 条（曲号 1–{max_n}）{}",
        plan.toc_pages.len(),
        toc.numbers.len(),
        if toc.dropped.is_empty() { String::new() } else { format!("，{} 条与前后页码不单调已剔除", toc.dropped.len()) }
    ));
    l.push(format!("切出：{} 首", songs.len()));
    l.push(format!("缺：{} 首{}", missing.len(), if missing.is_empty() { " ✓" } else { "" }));
    for m in &missing {
        l.push(format!(
            "  {}{}{}",
            m.number,
            m.text.as_ref().map_or("（目录也没读到）".to_string(), |t| format!(" {t}")),
            m.page.map_or(String::new(), |p| format!(" 目录页 {p}"))
        ));
    }
    let join = |v: &[u32]| v.iter().map(u32::to_string).collect::<Vec<_>>().join("、");
    if !extra.is_empty() {
        l.push(format!("切出了、目录里却没读到的号（目录漏读或标题号读错，请抽查）：{}", join(&extra)));
    }
    if !duplicate.is_empty() {
        l.push(format!("重号：{}", join(&duplicate)));
    }
    if !page_mismatch.is_empty() {
        l.push(format!("起始页与目录不符：{} 首", page_mismatch.len()));
        for (n, tp, ap) in &page_mismatch {
            l.push(format!("  {n}：目录 {tp}，实际 {ap}"));
        }
    }
    if !no_title.is_empty() {
        l.push(format!("没认出曲名：{}", no_title.iter().map(|&k| names[k].as_str()).collect::<Vec<_>>().join("、")));
    }
    let mut no_footer = Vec::new();
    let mut bad_footer = Vec::new();
    for (i, pg) in plan.pages.iter().enumerate().take(region.last + 1).skip(region.first) {
        match pg.printed {
            None => no_footer.push(i),
            Some(p) => {
                if region.offset.is_some_and(|o| p as i64 != i as i64 - o) {
                    bad_footer.push(i);
                }
            }
        }
    }
    if !bad_footer.is_empty() {
        l.push(format!(
            "页码与前后不连贯（可能把别的数当成页码、或真页码没去掉）：{}",
            bad_footer.iter().map(|&i| format!("{} 读作 {}", src_name(i), plan.pages[i].printed.unwrap())).collect::<Vec<_>>().join("、")
        ));
    }
    if !no_footer.is_empty() {
        l.push(format!("没认出页码的页（页码可能留在图里，请抽查）：{}", no_footer.iter().map(|&i| src_name(i)).collect::<Vec<_>>().join("、")));
    }
    if !plan.orphans.is_empty() {
        l.push(format!("第一个标题之前、未归属的页：{}", plan.orphans.iter().map(|&i| src_name(i)).collect::<Vec<_>>().join("、")));
    }
    if !toc.dropped.is_empty() {
        l.push(format!(
            "剔除的目录条目：{}",
            toc.dropped.iter().map(|e| format!("{} {}/{}", e.text, e.number, e.page.map_or(String::new(), |p| p.to_string()))).collect::<Vec<_>>().join("；")
        ));
    }
    let with_issues: Vec<usize> = (0..songs.len()).filter(|&k| !songs[k].issues.is_empty()).collect();
    if !with_issues.is_empty() {
        l.push("逐首提示：".into());
        for k in with_issues {
            l.push(format!("  {}（{}）：{}", names[k], src_name(songs[k].start_page), songs[k].issues.join("；")));
        }
    }
    l.push(String::new());
    l.push("曲目清单（文件名 ← 源页）：".into());
    for (k, s) in songs.iter().enumerate() {
        l.push(format!("  {} ← {}", names[k], s.pieces.iter().map(|p| src_name(p.page)).collect::<Vec<_>>().join(" + ")));
    }
    SplitReport { expected: max_n, written: songs.len(), missing, extra, duplicate, page_mismatch, no_title, text: l.join("\n") + "\n" }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(n: Option<u32>, t: &str) -> SongPlan {
        SongPlan { number: n, title: t.into(), start_page: 0, pieces: vec![], seam_gap: 0.0, issues: vec![] }
    }

    #[test]
    fn names() {
        let v = song_file_names(&[s(Some(1), "圣 哉"), s(Some(1), "圣哉"), s(None, ""), s(Some(1203), "a/b")]);
        assert_eq!(v, vec!["0001 圣哉", "0001 圣哉(2)", "未编号3 未识别曲名", "1203 ab"]);
    }
}
