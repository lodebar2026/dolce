//! 在 123 / ABC 原文上改 `%%layout`（规范 123格式 §9.1）：只动 `%%layout` 那几行，别的一个字不碰（注释、排版、`$` 都留着）。
//! 编辑器的分行三档（`linebreak=`）与谱面上增删断点都走这里，一次改动一次 `setText`、一步撤销。

use dolce_base::js;

use super::fields::builtin_layout;

/// 原文按行切开（保留各行的行尾，拼回去逐字不变）
fn lines_of(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

/// 去掉行尾换行
fn body(line: &str) -> &str {
    line.trim_end_matches(['\n', '\r'])
}

/// 这一行是不是 `%%layout …` / `I:layout …`：是的话回它的正文（版面名起）
pub fn layout_line_body(line: &str) -> Option<&str> {
    let t = js::trim(body(line));
    let rest = t.strip_prefix("%%layout").or_else(|| t.strip_prefix("I:layout"))?;
    (rest.is_empty() || rest.starts_with(js::is_space)).then(|| js::trim(rest))
}

/// 各首在第几行到第几行（`[起, 止)`）。没有 `X:` 时整篇一首；第一个 `X:` 之前的文件头不归哪一首
pub fn song_line_ranges(text: &str) -> Vec<(usize, usize)> {
    let lines = lines_of(text);
    let starts: Vec<usize> = lines.iter().enumerate().filter(|(_, l)| body(l).starts_with("X:")).map(|(i, _)| i).collect();
    if starts.is_empty() {
        return vec![(0, lines.len())];
    }
    starts.iter().enumerate().map(|(k, &s)| (s, starts.get(k + 1).copied().unwrap_or(lines.len()))).collect()
}

/// 版面名归一（内置名认 ASCII 别名）
fn norm_name(name: &str) -> String {
    builtin_layout(name).unwrap_or(name).to_string()
}

/// 一行 `%%layout` 的 (版面名, 其余 `键=值`)
fn split_line(b: &str) -> (String, Vec<String>) {
    let mut toks = b.split(js::is_space).filter(|t| !t.is_empty());
    let name = toks.next().map(norm_name).unwrap_or_default();
    (name, toks.map(String::from).collect())
}

fn key_of(tok: &str) -> &str {
    tok.split_once('=').map_or(tok, |(k, _)| k)
}

/// 新的 `%%layout` 行插在哪一行之前：这一首最后一行 `%%sing` / `%%layout` 之后，没有就在这一首最后一行非空行之后
fn insert_at(lines: &[&str], (from, to): (usize, usize)) -> usize {
    let directive = (from..to).rev().find(|&i| {
        let t = js::trim(body(lines[i]));
        layout_line_body(lines[i]).is_some() || t.starts_with("%%sing")
    });
    match directive {
        Some(i) => i + 1,
        None => (from..to).rev().find(|&i| !js::trim(body(lines[i])).is_empty()).map_or(to, |i| i + 1),
    }
}

/// 把这些行拼回原文；`at` 处插进 `extra`（行尾随文件的换行写法）
fn rejoin(lines: &[&str], text: &str, edits: Vec<(usize, Option<String>)>, inserts: Vec<(usize, String)>) -> String {
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut out = String::with_capacity(text.len() + 64);
    for i in 0..=lines.len() {
        for (at, s) in &inserts {
            if *at == i {
                // 上一行没有换行（文件末行）：先补一个
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push_str(eol);
                }
                out.push_str(s);
                out.push_str(eol);
            }
        }
        let Some(l) = lines.get(i) else { break };
        match edits.iter().find(|(k, _)| *k == i) {
            Some((_, None)) => {}
            Some((_, Some(s))) => {
                out.push_str(s);
                out.push_str(&l[body(l).len()..]);
            }
            None => out.push_str(l),
        }
    }
    out
}

/// 第 `song` 首的版面 `layout` 整体选项 `key` 设成 `value`（`None` = 去掉，回到缺省）。改在这个版面第一行不带 `pass=` 的那行上；
/// 没有这样的行就新加一行。改完那行只剩版面名、且这个版面别处还有行或本来就是内置版面的，整行删掉。原文本来就是这样的回原文。
pub fn set_layout_option(text: &str, song: usize, layout: &str, key: &str, value: Option<&str>) -> String {
    let lines = lines_of(text);
    let Some(&range) = song_line_ranges(text).get(song) else { return text.to_string() };
    let name = norm_name(layout);
    let rows: Vec<usize> = (range.0..range.1).filter(|&i| layout_line_body(lines[i]).is_some_and(|b| split_line(b).0 == name)).collect();
    let head = rows.iter().copied().find(|&i| !split_line(layout_line_body(lines[i]).unwrap_or("")).1.iter().any(|t| key_of(t) == "pass"));
    let tok = value.map(|v| format!("{key}={v}"));
    match head {
        Some(i) => {
            let (_, mut toks) = split_line(layout_line_body(lines[i]).unwrap_or(""));
            match toks.iter().position(|t| key_of(t) == key) {
                Some(k) => match &tok {
                    Some(t) => toks[k] = t.clone(),
                    None => {
                        toks.remove(k);
                    }
                },
                None => match &tok {
                    Some(t) => toks.push(t.clone()),
                    None => return text.to_string(),
                },
            }
            let indent = &body(lines[i])[..body(lines[i]).len() - body(lines[i]).trim_start().len()];
            let edit = if toks.is_empty() && (rows.len() > 1 || builtin_layout(&name).is_some()) { None } else { Some(format!("{indent}%%layout {name} {}", toks.join(" ")).trim_end().to_string()) };
            if edit.as_deref() == Some(body(lines[i])) {
                return text.to_string();
            }
            rejoin(&lines, text, vec![(i, edit)], vec![])
        }
        None => {
            let Some(t) = tok else { return text.to_string() };
            // 新行插在这个版面已有的行（都带 `pass=`）之前，否则照常
            let at = rows.first().copied().unwrap_or_else(|| insert_at(&lines, range));
            rejoin(&lines, text, vec![], vec![(at, format!("%%layout {name} {t}"))])
        }
    }
}

/// 第 `song` 首版面 `layout` 的整体选项 `key` 的值（读原文，不经模型：编辑器点按钮前看当前档位用）
pub fn layout_option(text: &str, song: usize, layout: &str, key: &str) -> Option<String> {
    let lines = lines_of(text);
    let &(from, to) = song_line_ranges(text).get(song)?;
    let name = norm_name(layout);
    let mut val = None;
    for l in &lines[from..to] {
        let Some(b) = layout_line_body(l) else { continue };
        let (n, toks) = split_line(b);
        if n != name || toks.iter().any(|t| key_of(t) == "pass") {
            continue;
        }
        if let Some(v) = toks.iter().find(|t| key_of(t) == key).and_then(|t| t.split_once('=')).map(|(_, v)| v.to_string()) {
            val = Some(v);
        }
    }
    val
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: &str = "X:1\nT:a\nK:C\n1 2 3 4 |]\n%%sing A\n\nX:2\nT:b\nK:C\n1 2 3 4 |]\n";

    #[test]
    fn add_set_remove() {
        let a = set_layout_option(T, 0, "jianpu", "linebreak", Some("phrase"));
        assert_eq!(a, "X:1\nT:a\nK:C\n1 2 3 4 |]\n%%sing A\n%%layout 简谱 linebreak=phrase\n\nX:2\nT:b\nK:C\n1 2 3 4 |]\n");
        assert_eq!(layout_option(&a, 0, "简谱", "linebreak").as_deref(), Some("phrase"));
        assert_eq!(layout_option(&a, 1, "简谱", "linebreak"), None);
        let b = set_layout_option(&a, 0, "简谱", "linebreak", Some("bars:4"));
        assert!(b.contains("%%layout 简谱 linebreak=bars:4\n"), "{b}");
        let c = set_layout_option(&b, 0, "简谱", "linebreak", None);
        assert_eq!(c, T);
        // 第二首：插在最后一行非空行后；文件末没有换行也行
        let d = set_layout_option(T.trim_end(), 1, "投影", "rows", Some("3"));
        assert!(d.ends_with("1 2 3 4 |]\n%%layout 投影 rows=3\n"), "{d}");
    }

    #[test]
    fn keeps_other_keys_and_pass_lines() {
        let t = "X:1\nK:C\n1 2 |]\n%%layout 投影 pass=1 break=A\n";
        let a = set_layout_option(t, 0, "投影", "linebreak", Some("fill"));
        assert_eq!(a, "X:1\nK:C\n1 2 |]\n%%layout 投影 linebreak=fill\n%%layout 投影 pass=1 break=A\n");
        let b = set_layout_option(&a, 0, "投影", "rows", Some("5"));
        assert!(b.contains("%%layout 投影 linebreak=fill rows=5\n"), "{b}");
        assert_eq!(set_layout_option(&a, 0, "投影", "linebreak", None), t);
    }
}
