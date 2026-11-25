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

// ───────────────────────── 谱面上增删断点（规范 §9.1「在谱面上增删断点」） ─────────────────────────

/// 这一行 `%%layout` 管第几遍（`pass=N`；不带的为 None）
fn pass_of(toks: &[String]) -> Option<u32> {
    toks.iter().find(|t| key_of(t) == "pass").and_then(|t| t.split_once('=')).and_then(|(_, v)| v.parse().ok())
}

/// 段落引用 `A` / `A*2` → (段名, 第几次)
fn split_ref(r: &str) -> (&str, u32) {
    match r.split_once('*') {
        Some((n, k)) => (n, k.parse().unwrap_or(1)),
        None => (r, 1),
    }
}

fn ref_text(section: &str, nth: u32) -> String {
    if nth > 1 { format!("{section}*{nth}") } else { section.to_string() }
}

/// `break=` / `newpage=` 一项里去掉 / 改名：`f` 收各项、回新的项（None = 去掉）；改完回新的 `键=值`（空了回 None）
fn map_refs(tok: &str, f: &mut impl FnMut(&str) -> Vec<String>) -> Option<String> {
    let (k, v) = tok.split_once('=')?;
    let items: Vec<String> = v.split(',').filter(|x| !x.is_empty()).flat_map(&mut *f).collect();
    (!items.is_empty()).then(|| format!("{k}={}", items.join(",")))
}

/// 重写这一行 `%%layout`：`toks` 是版面名之后的项；只剩版面名（与 `pass=`）时 `keep_bare` 决定留不留
fn layout_line(indent: &str, name: &str, toks: &[String], keep_bare: bool) -> Option<String> {
    let meaningful = toks.iter().any(|t| key_of(t) != "pass");
    (meaningful || keep_bare).then(|| format!("{indent}%%layout {name} {}", toks.join(" ")).trim_end().to_string())
}

fn indent_of(line: &str) -> &str {
    let b = body(line);
    &b[..b.len() - b.trim_start().len()]
}

/// 在第 `song` 首版面 `layout` 加一个断点：第 `pass` 遍（None = 每一遍）在段 `section` 的第 `nth` 次出现之后换行（`page` 换页）。
/// 加在管这一遍的那行上（`pass=N` 的行；没有就新加一行），同一项在另一个键里的挪过来。已经有了回原文
pub fn add_break(text: &str, song: usize, layout: &str, pass: Option<u32>, section: &str, nth: u32, page: bool) -> String {
    let lines = lines_of(text);
    let Some(&range) = song_line_ranges(text).get(song) else { return text.to_string() };
    let name = norm_name(layout);
    let (key, other) = if page { ("newpage", "break") } else { ("break", "newpage") };
    let want = ref_text(section, nth);
    let same = |x: &str| split_ref(x) == (section, nth.max(1));
    let rows: Vec<usize> = (range.0..range.1).filter(|&i| layout_line_body(lines[i]).is_some_and(|b| split_line(b).0 == name)).collect();
    let target = rows.iter().copied().find(|&i| pass_of(&split_line(layout_line_body(lines[i]).unwrap_or("")).1) == pass);
    match target {
        Some(i) => {
            let (_, toks) = split_line(layout_line_body(lines[i]).unwrap_or(""));
            if toks.iter().any(|t| key_of(t) == key && t.split_once('=').is_some_and(|(_, v)| v.split(',').any(same))) {
                return text.to_string();
            }
            let mut out: Vec<String> = toks
                .iter()
                .filter_map(|t| if key_of(t) == other { map_refs(t, &mut |x| if same(x) { vec![] } else { vec![x.to_string()] }) } else { Some(t.clone()) })
                .collect();
            match out.iter_mut().find(|t| key_of(t) == key) {
                Some(t) => {
                    t.push(',');
                    t.push_str(&want);
                }
                None => out.push(format!("{key}={want}")),
            }
            let line = layout_line(indent_of(lines[i]), &name, &out, true);
            rejoin(&lines, text, vec![(i, line)], vec![])
        }
        None => {
            let line = match pass {
                Some(p) => format!("%%layout {name} pass={p} {key}={want}"),
                None => format!("%%layout {name} {key}={want}"),
            };
            // 带 `pass=` 的按遍号排在这个版面的行里，不带的排在最前
            let at = match pass {
                Some(p) => rows
                    .iter()
                    .copied()
                    .find(|&i| pass_of(&split_line(layout_line_body(lines[i]).unwrap_or("")).1).is_some_and(|q| q > p))
                    .or_else(|| rows.last().map(|&i| i + 1)),
                None => rows.first().copied(),
            }
            .unwrap_or_else(|| insert_at(&lines, range));
            rejoin(&lines, text, vec![], vec![(at, line)])
        }
    }
}

/// 删掉第 `song` 首版面 `layout` 管第 `pass` 遍的断点「段 `section` 第 `nth` 次之后」（`break=` 与 `newpage=` 都找；
/// 不带 `pass=` 的规则管每一遍，也删）。删空的行整行去掉。没有这条回原文——是自动断行，删不掉
pub fn remove_break(text: &str, song: usize, layout: &str, pass: Option<u32>, section: &str, nth: u32) -> String {
    let lines = lines_of(text);
    let Some(&range) = song_line_ranges(text).get(song) else { return text.to_string() };
    let name = norm_name(layout);
    let same = |x: &str| split_ref(x) == (section, nth.max(1));
    let rows: Vec<usize> = (range.0..range.1).filter(|&i| layout_line_body(lines[i]).is_some_and(|b| split_line(b).0 == name)).collect();
    let mut edits: Vec<(usize, Option<String>)> = vec![];
    let mut left = rows.len();
    for &i in &rows {
        let (_, toks) = split_line(layout_line_body(lines[i]).unwrap_or(""));
        let p = pass_of(&toks);
        if p.is_some() && p != pass {
            continue;
        }
        let mut hit = false;
        let out: Vec<String> = toks
            .iter()
            .filter_map(|t| {
                if key_of(t) != "break" && key_of(t) != "newpage" {
                    return Some(t.clone());
                }
                map_refs(t, &mut |x| {
                    if same(x) {
                        hit = true;
                        vec![]
                    } else {
                        vec![x.to_string()]
                    }
                })
            })
            .collect();
        if hit {
            // 只剩版面名：内置版面或这个版面别处还有行时整行删（自定义版面的唯一一行留着，免得版面没了）
            let keep = p.is_none() && builtin_layout(&name).is_none() && left <= 1;
            let line = layout_line(indent_of(lines[i]), &name, &out, keep);
            if line.is_none() {
                left -= 1;
            }
            edits.push((i, line));
        }
    }
    if edits.is_empty() { text.to_string() } else { rejoin(&lines, text, edits, vec![]) }
}

/// 指令行：(行号, 正文)
type Rows<'t> = Vec<(usize, &'t str)>;

/// 第 `song` 首的 `%%sing` 各行与 `%%layout` 各行
fn directive_rows<'t>(lines: &[&'t str], (from, to): (usize, usize)) -> (Rows<'t>, Rows<'t>) {
    let mut sing = vec![];
    let mut layout = vec![];
    for (i, l) in lines.iter().enumerate().take(to).skip(from) {
        let t = js::trim(body(l));
        if let Some(rest) = t.strip_prefix("%%sing").or_else(|| t.strip_prefix("I:sing")) {
            if rest.is_empty() || rest.starts_with(js::is_space) {
                sing.push((i, js::trim(rest)));
            }
        } else if let Some(b) = layout_line_body(l) {
            layout.push((i, b));
        }
    }
    (sing, layout)
}

fn sing_line(indent: &str, items: &[String]) -> String {
    format!("{indent}%%sing {}", items.join(" "))
}

/// `%%sing` 一项的段名（去掉 `@段`）
fn item_name(it: &str) -> &str {
    it.split_once('@').map_or(it, |(n, _)| n)
}

fn item_verse(it: &str) -> &str {
    it.split_once('@').map_or("", |(_, v)| v)
}

/// 段 `name` 在新标记 `[P:new_name]` 处切成两段之后，跟着改第 `song` 首的 `%%sing` 与 `%%layout`：
/// `%%sing` 里 `name` 每次出现都换成 `name new_name`（`@段` 两半同带），各版面引用「`name` 之后」的断点改指 `new_name`。
/// 标记本身由调用方插（要知道音在原文里的位置）
pub fn split_section(text: &str, song: usize, name: &str, new_name: &str) -> String {
    let lines = lines_of(text);
    let Some(&range) = song_line_ranges(text).get(song) else { return text.to_string() };
    let (sing, layout) = directive_rows(&lines, range);
    let mut edits: Vec<(usize, Option<String>)> = vec![];
    for (i, b) in sing {
        let mut items: Vec<String> = vec![];
        let mut changed = false;
        for it in b.split(js::is_space).filter(|t| !t.is_empty()) {
            items.push(it.to_string());
            if item_name(it) == name {
                changed = true;
                let v = item_verse(it);
                items.push(if v.is_empty() { new_name.to_string() } else { format!("{new_name}@{v}") });
            }
        }
        if changed {
            edits.push((i, Some(sing_line(indent_of(lines[i]), &items))));
        }
    }
    for (i, b) in layout {
        let (lname, toks) = split_line(b);
        let mut changed = false;
        let out: Vec<String> = toks
            .iter()
            .filter_map(|t| {
                if key_of(t) != "break" && key_of(t) != "newpage" {
                    return Some(t.clone());
                }
                map_refs(t, &mut |x| {
                    let (n, k) = split_ref(x);
                    if n == name {
                        changed = true;
                        vec![ref_text(new_name, k)]
                    } else {
                        vec![x.to_string()]
                    }
                })
            })
            .collect();
        if changed {
            edits.push((i, layout_line(indent_of(lines[i]), &lname, &out, true)));
        }
    }
    if edits.is_empty() { text.to_string() } else { rejoin(&lines, text, edits, vec![]) }
}

/// 界面切段起的名字 `A-2` → `A`；不是这种形状回 None
pub fn auto_split_base(name: &str) -> Option<&str> {
    let (base, n) = name.rsplit_once('-')?;
    (!base.is_empty() && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())).then_some(base)
}

/// 删断点之后试着把界面切出来的段 `name`（`A-2` 形）合回 `A`：`%%sing` 里每个 `A` 都紧跟着同段词的 `A-2`、`A-2` 也只跟在 `A` 后，
/// 且哪个版面都不再引用「`A` 之后」时，删掉谱面上的 `[P:A-2]`、`%%sing` 里的 `A-2`，引用 `A-2` 的断点改指 `A`。不合条件回原文
pub fn merge_section(text: &str, song: usize, name: &str) -> String {
    let Some(base) = auto_split_base(name) else { return text.to_string() };
    let lines = lines_of(text);
    let Some(&range) = song_line_ranges(text).get(song) else { return text.to_string() };
    let (sing, layout) = directive_rows(&lines, range);
    let mut edits: Vec<(usize, Option<String>)> = vec![];
    for (i, b) in &sing {
        let items: Vec<&str> = b.split(js::is_space).filter(|t| !t.is_empty()).collect();
        let mut out: Vec<String> = vec![];
        for (k, it) in items.iter().enumerate() {
            let is_base = item_name(it) == base;
            let is_new = item_name(it) == name;
            let next_new = items.get(k + 1).is_some_and(|n| item_name(n) == name && item_verse(n) == item_verse(it));
            let prev_base = k > 0 && item_name(items[k - 1]) == base && item_verse(items[k - 1]) == item_verse(it);
            if (is_base && !next_new) || (is_new && !prev_base) {
                return text.to_string();
            }
            if !is_new {
                out.push(it.to_string());
            }
        }
        if out.len() != items.len() {
            edits.push((*i, Some(sing_line(indent_of(lines[*i]), &out))));
        }
    }
    for (i, b) in &layout {
        let (lname, toks) = split_line(b);
        let refs = toks.iter().filter(|t| key_of(t) == "break" || key_of(t) == "newpage").flat_map(|t| t.split_once('=').map_or("", |(_, v)| v).split(','));
        let mut renamed = false;
        for r in refs {
            let n = split_ref(r).0;
            if n == base {
                return text.to_string();
            }
            renamed |= n == name;
        }
        if renamed {
            let out: Vec<String> = toks
                .iter()
                .filter_map(|t| {
                    if key_of(t) != "break" && key_of(t) != "newpage" {
                        return Some(t.clone());
                    }
                    map_refs(t, &mut |x| {
                        let (n, k) = split_ref(x);
                        vec![if n == name { ref_text(base, k) } else { x.to_string() }]
                    })
                })
                .collect();
            edits.push((*i, layout_line(indent_of(lines[*i]), &lname, &out, true)));
        }
    }
    // 谱面上的标记：音乐行里的 `[P:A-2]`（注释、指令行不动）
    let mark = format!("[P:{name}]");
    let mut found = false;
    for (i, l) in lines.iter().enumerate().take(range.1).skip(range.0) {
        let t = js::trim(body(l));
        if t.starts_with('%') || edits.iter().any(|(k, _)| *k == i) || !l.contains(&mark) {
            continue;
        }
        found = true;
        edits.push((i, Some(body(l).replace(&mark, ""))));
    }
    if !found {
        return text.to_string();
    }
    rejoin(&lines, text, edits, vec![])
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

    const S: &str = "X:1\nK:C\n[P:A]1 2 3 4 | 5 6 7 1' | [P:B]2 2 2 2 |]\n%%sing A B\n%%sing A@2 B A@2\n";

    #[test]
    fn add_remove_break() {
        let a = add_break(S, 0, "投影", Some(2), "A", 2, false);
        assert!(a.ends_with("%%sing A@2 B A@2\n%%layout 投影 pass=2 break=A*2\n"), "{a}");
        let b = add_break(&a, 0, "投影", Some(2), "B", 1, true);
        assert!(b.ends_with("%%layout 投影 pass=2 break=A*2 newpage=B\n"), "{b}");
        // 同一项换键：换行改换页
        let c = add_break(&b, 0, "投影", Some(2), "A", 2, true);
        assert!(c.ends_with("%%layout 投影 pass=2 newpage=B,A*2\n"), "{c}");
        assert_eq!(add_break(&c, 0, "投影", Some(2), "A", 2, true), c);
        let d = remove_break(&c, 0, "投影", Some(2), "A", 2);
        let d = remove_break(&d, 0, "投影", Some(2), "B", 1);
        assert_eq!(d, S);
        // 自动断行：没有这条，原文不变
        assert_eq!(remove_break(S, 0, "投影", Some(1), "A", 1), S);
        // 每一遍：不带 pass=，排在带 pass= 的行之前；删时按任一遍都删得掉
        let e = add_break(&a, 0, "投影", None, "B", 1, false);
        assert!(e.ends_with("%%layout 投影 break=B\n%%layout 投影 pass=2 break=A*2\n"), "{e}");
        assert_eq!(remove_break(&e, 0, "投影", Some(1), "B", 1), a);
    }

    #[test]
    fn split_and_merge() {
        let t = format!("{S}%%layout 投影 pass=1 break=A\n");
        // 调用方先插标记
        let marked = t.replacen("5 6 7", "5 [P:A-2]6 7", 1);
        let a = split_section(&marked, 0, "A", "A-2");
        assert!(a.contains("%%sing A A-2 B\n%%sing A@2 A-2@2 B A@2 A-2@2\n%%layout 投影 pass=1 break=A-2\n"), "{a}");
        let b = add_break(&a, 0, "投影", Some(2), "A", 1, false);
        // 还引用着 A 之后：不合
        let c = remove_break(&b, 0, "投影", Some(2), "A", 1);
        assert_eq!(c, a);
        assert_eq!(merge_section(&b, 0, "A-2"), b);
        // 不再引用 A：合回，A-2 的断点改指 A
        assert_eq!(merge_section(&c, 0, "A-2"), t);
        // 用户自己起名的不合
        assert_eq!(merge_section(&c, 0, "B"), c);
    }
}
