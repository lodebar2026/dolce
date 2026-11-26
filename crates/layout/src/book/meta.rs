//! 书级元数据（照 `src/pdflayout/bookmeta.ts`）：原书上那些 musicxml 装不下的内容——调号拍号原文、段落词、
//! 花边框 / 线框里的注解、目录、首句索引、扉页与前言、页码标签、花边纹样。
//!
//! 输入是原书的版面规格（[`crate::book::spec::PageSpec`]），外加逐字覆盖（校对.db 的 `glyph_fix`，[`CharOverride`]）。
//! 判据、阈值照搬 TS（每条的反例与病例页号在 TS 原文注释里），JS 的口径（UTF-16 长度、`\s`/`\d` 的字符集、
//! 稳定排序、`toFixed`）逐处照抄，对拍见 dolce-cli `book-meta-check`。

use crate::book::spec::{FrameSpec, PageSpec, SChar, SRect, SongPlacement, TextRun};
use dolce_model::base::js;
use indexmap::IndexMap;
use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

/// 逐字覆盖：(形状键, 当前字) → 字（`None` 表示还是读不出）。TS `CharOverride`。
pub type CharOverride<'a> = Option<&'a dyn Fn(&str, &str) -> Option<String>>;

/// 读不出的字形
pub const UNREAD: &str = "\u{FFFD}";

// ── JS 口径的小工具（stats.rs 共用） ──

/// JS 正则 `\s` 的字符集（Rust 的 `\s` 是 Unicode White_Space，与 JS 差 U+0085 / U+FEFF）
const WS: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";

/// 把 JS 写法的正则改成 Rust 口径：`\s` → JS 空白集、`\d` → ASCII 数字
pub(crate) fn jsre(p: &str) -> Regex {
    Regex::new(&p.replace(r"\s", WS).replace(r"\d", "[0-9]")).expect("正则")
}

/// `s.length`（UTF-16 码元数）
pub(crate) fn u16len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// 汉字 `[一-鿿]`
pub(crate) fn is_cjk(c: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&c)
}

pub(crate) fn cjk_count(s: &str) -> usize {
    s.chars().filter(|c| is_cjk(*c)).count()
}

/// `Number(v.toFixed(f))`
pub(crate) fn fixed(v: f64, f: usize) -> f64 {
    js::number(&js::to_fixed(v, f))
}

/// `Math.min(...v)`（空为 Infinity）
pub(crate) fn min_of(v: impl IntoIterator<Item = f64>) -> f64 {
    v.into_iter().fold(f64::INFINITY, js::min)
}

/// `Math.max(...v)`（空为 -Infinity）
pub(crate) fn max_of(v: impl IntoIterator<Item = f64>) -> f64 {
    v.into_iter().fold(f64::NEG_INFINITY, js::max)
}

/// 升序排好的副本取 `[floor(n/2)]`，空为 0（TS `median`）
pub(crate) fn median(v: &[f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    let mut s = v.to_vec();
    js::sort_num(&mut s);
    s[s.len() / 2]
}

/// JS 的 `x || y`（数）：0 与 NaN 取后者
pub(crate) fn or(x: f64, y: f64) -> f64 {
    if x == 0.0 || x.is_nan() {
        y
    } else {
        x
    }
}

fn bottom(r: &SRect) -> f64 {
    r.y + r.h
}
fn right(r: &SRect) -> f64 {
    r.x + r.w
}
fn cbottom(c: &SChar) -> f64 {
    c.y + c.h
}
fn cright(c: &SChar) -> f64 {
    c.x + c.w
}

// ── 逐字文本 ──

/// 一个字形套上覆盖后的字（读不出、覆盖也给不出时为空串）
pub fn ov_text(ov: CharOverride, key: &str, ch: &str) -> String {
    ov.and_then(|f| f(key, ch)).unwrap_or_else(|| if ch == UNREAD { String::new() } else { ch.to_string() })
}

/// 左边那头算西文（`/[A-Za-z0-9.,]$/`）
fn latin_edge(s: &str) -> bool {
    s.chars().last().is_some_and(|c| c.is_ascii_alphanumeric() || c == '.' || c == ',')
}
/// 右边那头算西文（`/^[A-Za-z0-9]/`）
fn latin_head(s: &str) -> bool {
    s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
}

static COLON: LazyLock<Regex> = LazyLock::new(|| Regex::new("([0-9A-Za-z])：([0-9A-Za-z])").expect("正则"));

/// 一串字形的文本（TS `runText({chars})`）：套覆盖、读不出的留空、西文之间按本行字距补空格、夹在西文数字间的冒号写半角
pub fn run_text_chars(chars: &[SChar], ov: CharOverride) -> String {
    let mut gaps = vec![];
    for i in 1..chars.len() {
        let (a, b) = (&chars[i - 1], &chars[i]);
        if !latin_edge(&a.ch) || !latin_head(&b.ch) {
            continue;
        }
        gaps.push(b.x - (a.x + a.w));
    }
    let med_gap = if gaps.len() >= 4 { median(&gaps) } else { 0.0 };
    let mut out = String::new();
    let mut prev: Option<(String, f64, f64)> = None;
    for c in chars {
        let text = ov_text(ov, &c.key, &c.ch);
        if text.is_empty() {
            continue;
        }
        if let Some((pt, pr, ph)) = &prev {
            let digit_run = pt.chars().last().is_some_and(|x| x.is_ascii_digit()) && text.chars().next().is_some_and(|x| x.is_ascii_digit());
            if !digit_run && latin_edge(pt) && latin_head(&text) {
                let gap = c.x - pr;
                let cut = if med_gap > 0.0 { js::max(med_gap * 2.2, js::max(*ph, c.h) * 0.22) } else { js::max(*ph, c.h) * 0.22 };
                if gap > cut {
                    out.push(' ');
                }
            }
        }
        out.push_str(&text);
        prev = Some((text, c.x + c.w, c.h));
    }
    COLON.replace_all(&out, "${1}:${2}").into_owned()
}

/// TS `runText(run, ov)`
pub fn run_text(run: Option<&TextRun>, ov: CharOverride) -> String {
    run.map_or(String::new(), |r| run_text_chars(&r.chars, ov))
}

/// 逐字展开（字换成覆盖后的；TS `runChars`）
pub fn run_chars(run: &TextRun, ov: CharOverride) -> Vec<SChar> {
    run.chars.iter().map(|c| SChar { ch: ov_text(ov, &c.key, &c.ch), ..c.clone() }).collect()
}

fn sort_x(v: &mut [SChar]) {
    js::sort_by(v, |a, b| a.x - b.x);
}

// ── 调号拍号 ──

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyMeter {
    pub song_id: String,
    pub tonic: String,
    pub beats: Option<f64>,
    pub beat_type: Option<f64>,
    pub alt_tonic: Option<String>,
    pub raw: String,
    pub page: i64,
}

fn strip_accidental_head(s: &str) -> String {
    if let Some(r) = s.strip_prefix('b') {
        format!("♭{r}")
    } else if let Some(r) = s.strip_prefix('#') {
        format!("♯{r}")
    } else {
        s.to_string()
    }
}

static ALT_TONIC: LazyLock<Regex> = LazyLock::new(|| Regex::new("^([b#♭♯]?[A-G])").expect("正则"));

/// `1=♭B  4/4  (1=A)` 的原文解析（TS `parseKeyMeter`；判据见原文：`=` 读作「二」、拍号上下叠排、括号里是移调建议）
pub fn parse_key_meter(song: &SongPlacement, page: i64, ov: CharOverride) -> Option<KeyMeter> {
    let run = song.key_meter_run.as_ref()?;
    let id = song.id.as_ref()?;
    let mut cs: Vec<SChar> = run_chars(run, ov).into_iter().filter(|c| !c.ch.is_empty()).collect();
    sort_x(&mut cs);
    let raw: String = cs.iter().map(|c| c.ch.as_str()).collect();
    let is_eq = |ch: &str| ch == "=" || ch == "二";
    let eq = cs.iter().position(|c| is_eq(&c.ch))?;
    let open = cs.iter().position(|c| c.ch == "(" || c.ch == "（");
    let eq2 = cs.iter().enumerate().position(|(i, c)| i > eq && is_eq(&c.ch));
    let cut = match (open, eq2) {
        (Some(o), _) => o,
        (None, Some(e2)) => (eq + 1).max(e2 - 1),
        _ => cs.len(),
    };
    let head: &[SChar] = if cut > eq + 1 { &cs[eq + 1..cut] } else { &[] };
    let mut tonic = String::new();
    for c in head {
        if c.ch.chars().any(|x| x.is_ascii_digit()) {
            break;
        }
        tonic.push_str(&c.ch);
    }
    let tonic = js::trim(&strip_accidental_head(&tonic)).to_string();
    let digits: Vec<&SChar> = head.iter().filter(|c| c.ch.len() == 1 && c.ch.as_bytes()[0].is_ascii_digit()).collect();
    let (mut beats, mut beat_type) = (None, None);
    if digits.len() >= 2 {
        let mid = (min_of(digits.iter().map(|d| d.y)) + max_of(digits.iter().map(|d| cbottom(d)))) / 2.0;
        let mut up: Vec<SChar> = digits.iter().filter(|d| cbottom(d) <= mid + 0.5).map(|d| (*d).clone()).collect();
        let mut dn: Vec<SChar> = digits.iter().filter(|d| cbottom(d) > mid + 0.5).map(|d| (*d).clone()).collect();
        sort_x(&mut up);
        sort_x(&mut dn);
        if !up.is_empty() && !dn.is_empty() {
            let b = js::number(&up.iter().map(|d| d.ch.as_str()).collect::<String>());
            let t = js::number(&dn.iter().map(|d| d.ch.as_str()).collect::<String>());
            if (1.0..=24.0).contains(&b) && [1.0, 2.0, 4.0, 8.0, 16.0].contains(&t) {
                beats = Some(b);
                beat_type = Some(t);
            }
        }
    }
    let mut alt_tonic: Option<String> = None;
    if open.is_some() || eq2.is_some() {
        let start = match open {
            Some(o) => o + 1,
            None => eq2.expect("有第二个等号") - 1,
        };
        let tail = &cs[start..];
        if let Some(e2) = tail.iter().position(|c| is_eq(&c.ch)) {
            let s: String = tail[e2 + 1..].iter().map(|c| c.ch.as_str()).collect::<String>().replace([')', '）'], "");
            let s = js::trim(&strip_accidental_head(&s)).to_string();
            let norm = s.replacen('♭', "b", 1).replacen('♯', "#", 1);
            alt_tonic = ALT_TONIC.captures(&norm).map(|m| strip_accidental_head(&m[1]));
        }
    }
    if tonic.is_empty() {
        return None;
    }
    Some(KeyMeter {
        song_id: id.clone(),
        tonic,
        beats,
        beat_type,
        alt_tonic: alt_tonic.filter(|s| !s.is_empty()),
        raw,
        page,
    })
}

// ── 段落词 ──

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionWord {
    pub song_id: String,
    pub text: String,
    pub note_ordinal: f64,
    pub measure_index: f64,
    pub system_index: f64,
    pub page: i64,
}

static SECTION_WORDS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(副歌|间奏|前奏|尾奏|结束句|结束|齐唱|独唱|轮唱|合唱|重唱|末节|反复|尾声)").expect("正则"));

/// 一行和弦带里切出段落词，连同它在行内的 x
fn section_tokens(run: &TextRun, ov: CharOverride) -> Vec<(String, f64)> {
    let mut cs = run_chars(run, ov);
    sort_x(&mut cs);
    let mut out = vec![];
    let mut cur: Vec<&SChar> = vec![];
    let flush = |cur: &mut Vec<&SChar>, out: &mut Vec<(String, f64)>| {
        if !cur.is_empty() {
            let t: String = cur.iter().map(|c| c.ch.as_str()).collect();
            if SECTION_WORDS.is_match(&t) {
                out.push((t, cur[0].x));
            }
        }
        cur.clear();
    };
    for c in &cs {
        if c.ch.chars().any(|x| is_cjk(x) || matches!(x, '（' | '）' | '(' | ')')) {
            cur.push(c);
        } else {
            flush(&mut cur, &mut out);
        }
    }
    flush(&mut cur, &mut out);
    out
}

// ── 花边框 / 经文 ──

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub song_id: Option<String>,
    pub size: f64,
    pub framed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_outer_width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_inner_width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_gap: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_edges: Option<String>,
    pub text: String,
    #[serde(rename = "box")]
    pub bx: SRect,
    pub page: i64,
}

/// b 是否整个落在 a 里（留 2pt 余量）
fn contains(a: &SRect, b: &SRect) -> bool {
    let m = 2.0;
    b.x >= a.x - m && b.y >= a.y - m && b.x + b.w <= a.x + a.w + m && b.y + b.h <= a.y + a.h + m
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RuleFrame {
    #[serde(rename = "box")]
    pub bx: SRect,
    pub outer: f64,
    pub inner: f64,
    pub gap: f64,
}

/// 把页面上的直线（`rule-h` / `rule-v`）聚成一圈圈矩形线框（TS `clusterRuleFrames`）
pub fn cluster_rule_frames(frames: &[FrameSpec]) -> Vec<RuleFrame> {
    let rules: Vec<&FrameSpec> = frames.iter().filter(|f| f.kind == "rule-h" || f.kind == "rule-v").collect();
    if rules.len() < 4 {
        return vec![];
    }
    let mut parent: Vec<usize> = (0..rules.len()).collect();
    fn find(p: &mut [usize], i: usize) -> usize {
        if p[i] == i {
            i
        } else {
            let r = find(p, p[i]);
            p[i] = r;
            r
        }
    }
    let near = |a: &SRect, b: &SRect| {
        let m = 4.0;
        a.x - m <= b.x + b.w && b.x - m <= a.x + a.w && a.y - m <= b.y + b.h && b.y - m <= a.y + a.h
    };
    for i in 0..rules.len() {
        for j in i + 1..rules.len() {
            if near(&rules[i].bx, &rules[j].bx) {
                let (ri, rj) = (find(&mut parent, i), find(&mut parent, j));
                parent[ri] = rj;
            }
        }
    }
    let mut by_root: IndexMap<usize, Vec<usize>> = IndexMap::new();
    for i in 0..rules.len() {
        let r = find(&mut parent, i);
        by_root.entry(r).or_default().push(i);
    }
    let lw = |f: &FrameSpec| if f.kind == "rule-h" { f.bx.h } else { f.bx.w };
    let mut out = vec![];
    for idxs in by_root.values() {
        if idxs.len() < 4 {
            continue;
        }
        let bs: Vec<&SRect> = idxs.iter().map(|&i| &rules[i].bx).collect();
        let x = min_of(bs.iter().map(|b| b.x));
        let y = min_of(bs.iter().map(|b| b.y));
        let w = max_of(bs.iter().map(|b| b.x + b.w)) - x;
        let h = max_of(bs.iter().map(|b| b.y + b.h)) - y;
        if w < 40.0 || h < 10.0 {
            continue;
        }
        let mut ws: Vec<f64> = idxs.iter().map(|&i| lw(rules[i])).collect();
        js::sort_num(&mut ws);
        let inner = ws[0];
        let outer = ws[ws.len() - 1];
        let inners: Vec<usize> = idxs.iter().copied().filter(|&i| lw(rules[i]) <= (inner + outer) / 2.0).collect();
        let gap = if inners.is_empty() { 0.0 } else { js::max(0.0, min_of(inners.iter().map(|&i| rules[i].bx.y - y)) - outer) };
        out.push(RuleFrame { bx: SRect { x, y, w, h }, outer: fixed(outer, 2), inner: fixed(inner, 2), gap: fixed(gap, 2) });
    }
    out
}

/// 注解正文里的连接号（矢量层是一条独立细横线）插回所在行（TS `withInlineDashes`）
fn with_inline_dashes(spec: &PageSpec, lines: &[TextRun]) -> Vec<TextRun> {
    let dashes: Vec<&FrameSpec> = spec.frames.iter().filter(|f| f.kind == "rule-h" && f.bx.h <= 1.2 && f.bx.w <= 30.0).collect();
    if dashes.is_empty() {
        return lines.to_vec();
    }
    lines
        .iter()
        .map(|l| {
            let add: Vec<&&FrameSpec> = dashes
                .iter()
                .filter(|f| {
                    f.bx.y > l.bx.y - 2.0
                        && bottom(&f.bx) < bottom(&l.bx) + 2.0
                        && f.bx.x > l.bx.x - 2.0
                        && right(&f.bx) < right(&l.bx) + 2.0
                        && l.chars.iter().any(|c| cright(c) <= f.bx.x + 1.0)
                        && l.chars.iter().any(|c| c.x >= right(&f.bx) - 1.0)
                })
                .collect();
            if add.is_empty() {
                return l.clone();
            }
            let size = or(l.size, 1.0);
            let mut chars = l.chars.clone();
            chars.extend(add.iter().map(|f| SChar {
                x: f.bx.x,
                y: f.bx.y,
                w: f.bx.w,
                h: f.bx.h,
                ch: if f.bx.w / size < 0.95 { "-" } else { "—" }.into(),
                key: String::new(),
            }));
            sort_x(&mut chars);
            TextRun { chars, ..l.clone() }
        })
        .collect()
}

/// 乐谱页上的注解正文行按框分组（TS `scoreAnnotationGroups`）
#[derive(Clone, Debug)]
pub struct AnnGroup {
    pub frame: Option<RuleFrame>,
    pub lines: Vec<TextRun>,
}

pub fn score_annotation_groups(spec: &PageSpec, line_boxes: &[RuleFrame], ov: CharOverride) -> Vec<AnnGroup> {
    if spec.kind != "score" || spec.text_lines.is_empty() {
        return vec![];
    }
    let mut out = vec![];
    let mut taken = vec![false; spec.text_lines.len()];
    for f in line_boxes {
        let inside: Vec<usize> = (0..spec.text_lines.len()).filter(|&i| contains(&f.bx, &spec.text_lines[i].bx)).collect();
        if inside.is_empty() {
            continue;
        }
        for &i in &inside {
            taken[i] = true;
        }
        let lines: Vec<TextRun> = inside.iter().map(|&i| spec.text_lines[i].clone()).collect();
        let all: Vec<SChar> = lines.iter().flat_map(|l| l.chars.iter().cloned()).collect();
        if cjk_count(&run_text_chars(&all, ov)) >= 8 {
            out.push(AnnGroup { frame: Some(f.clone()), lines: with_inline_dashes(spec, &lines) });
        }
    }
    let real_text = |t: &str| {
        let cjk: Vec<char> = t.chars().filter(|c| is_cjk(*c)).collect();
        let mut uniq = cjk.clone();
        uniq.sort_unstable();
        uniq.dedup();
        cjk.len() >= 8 && uniq.len() >= 4
    };
    let rest: Vec<TextRun> = spec
        .text_lines
        .iter()
        .enumerate()
        .filter(|(i, l)| !taken[*i] && real_text(&run_text(Some(l), ov)))
        .map(|(_, l)| l.clone())
        .collect();
    if !rest.is_empty() {
        out.push(AnnGroup { frame: None, lines: with_inline_dashes(spec, &rest) });
    }
    out
}

/// 框内文字重新聚行（TS `groupBoxRows`：按框内行距中位数 0.45 倍聚正文字，矮元素再按中心 y 认领最近一行）
pub fn group_box_rows(lines: &[TextRun]) -> Vec<Vec<SChar>> {
    let chars: Vec<SChar> = lines.iter().flat_map(|l| l.chars.iter().cloned()).collect();
    if chars.is_empty() {
        return vec![];
    }
    let mut baselines: Vec<f64> = vec![];
    for l in lines {
        if !baselines.contains(&l.baseline_y) {
            baselines.push(l.baseline_y);
        }
    }
    js::sort_num(&mut baselines);
    let gaps: Vec<f64> = baselines.windows(2).map(|w| w[1] - w[0]).filter(|g| *g > 2.0).collect();
    let pitch = or(median(&gaps), 12.0);
    let tol = js::max(3.0, pitch * 0.45);
    let body = or(median(&chars.iter().map(|c| c.h).collect::<Vec<_>>()), 1.0);
    let tall: Vec<SChar> = chars.iter().filter(|c| c.h >= body * 0.5).cloned().collect();
    let short: Vec<SChar> = chars.iter().filter(|c| c.h < body * 0.5).cloned().collect();
    let mut seed = if tall.is_empty() { chars.clone() } else { tall.clone() };
    js::sort_by(&mut seed, |a, b| cbottom(a) - cbottom(b));
    let mut rows: Vec<(f64, Vec<SChar>)> = vec![];
    for c in seed {
        if let Some(last) = rows.last_mut() {
            if cbottom(&c) - last.0 <= tol {
                last.0 = cbottom(&c);
                last.1.push(c);
                continue;
            }
        }
        rows.push((cbottom(&c), vec![c]));
    }
    if !tall.is_empty() {
        for c in short {
            let cy = c.y + c.h / 2.0;
            let mut best = 0usize;
            let mut best_d = f64::INFINITY;
            for (ri, r) in rows.iter().enumerate() {
                let top = min_of(r.1.iter().map(|it| it.y));
                let bot = max_of(r.1.iter().map(cbottom));
                let d = if cy < top {
                    top - cy
                } else if cy > bot {
                    cy - bot
                } else {
                    0.0
                };
                if d < best_d {
                    best_d = d;
                    best = ri;
                }
            }
            if let Some(r) = rows.get_mut(best) {
                r.1.push(c);
            }
        }
    }
    rows.into_iter()
        .map(|(_, mut items)| {
            sort_x(&mut items);
            items
        })
        .collect()
}

/// 注解正文里读不出的扁横条就是「一」（TS `hbarAsYi`）
fn hbar_as_yi(items: Vec<SChar>, ov: CharOverride) -> Vec<SChar> {
    let mut hs: Vec<f64> = items.iter().map(|c| c.h).filter(|h| *h > 2.0).collect();
    js::sort_num(&mut hs);
    let em = if hs.is_empty() { 0.0 } else { hs[hs.len() / 2] };
    if em == 0.0 || em.is_nan() {
        return items;
    }
    items
        .into_iter()
        .map(|c| {
            let cur = ov.and_then(|f| f(&c.key, &c.ch));
            if c.ch != UNREAD || cur.as_deref().is_some_and(|s| !s.is_empty() && s != "□") {
                return c;
            }
            let ratio = c.w / js::max(c.h, 0.01);
            if ratio < 5.0 || c.w < em * 0.8 || c.w > em * 1.25 {
                return c;
            }
            SChar { ch: "一".into(), key: String::new(), ..c }
        })
        .collect()
}

static LATIN_1_2: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[A-Za-z]{1,2}$").expect("正则"));

/// 框内文字重新聚行 → 逐行文本（TS `regroupBoxLines`）
pub fn regroup_box_lines(lines: &[TextRun], ov: CharOverride) -> Vec<String> {
    group_box_rows(lines)
        .into_iter()
        .map(|items| run_text_chars(&hbar_as_yi(items, ov), ov))
        .filter(|t| {
            let t = js::trim(t);
            u16len(t) >= 2 && !LATIN_1_2.is_match(t)
        })
        .collect()
}

// ── 目录 / 索引 ──

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TocRow {
    pub seq: usize,
    pub kind: &'static str,
    pub text: String,
    pub song_id: Option<String>,
    pub printed_page: Option<f64>,
    pub page: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexRow {
    pub seq: usize,
    pub kind: &'static str,
    pub index_name: &'static str,
    pub text: String,
    pub song_id: Option<String>,
    pub page: i64,
}

/// 目录条目：`1.圣哉，圣哉，圣哉(1)`（JS 的 `.` 不含行终止符）
static TOC_ENTRY: LazyLock<Regex> = LazyLock::new(|| jsre(r"^(\d+)\s*[.、·]?\s*([^\n\r\x{2028}\x{2029}]*?)[（(](\d+)[)）]\s*$"));
static TOC_TAIL: LazyLock<Regex> = LazyLock::new(|| jsre(r"[（(](\d+)[)）]\s*$"));
static DIGIT_END: LazyLock<Regex> = LazyLock::new(|| jsre(r"\d\s*$"));

/// 这一页是不是目录页（按「多少行长得像目录条目」判；TS `isTocPage`）
pub fn is_toc_page(spec: &PageSpec, ov: CharOverride) -> bool {
    if !spec.songs.is_empty() {
        return false;
    }
    let lines: Vec<String> = spec.text_lines.iter().map(|l| run_text(Some(l), ov)).collect();
    let hit = lines.iter().filter(|t| TOC_ENTRY.is_match(t)).count();
    lines.len() >= 8 && hit as f64 >= lines.len() as f64 * 0.5
}

/// 索引页：条目不带圆括号、以数字收尾（TS `isIndexPage`）
pub fn is_index_page(spec: &PageSpec, ov: CharOverride) -> bool {
    if !spec.songs.is_empty() {
        return false;
    }
    let lines: Vec<String> = spec.text_lines.iter().map(|l| run_text(Some(l), ov)).collect();
    let hit = lines.iter().filter(|t| DIGIT_END.is_match(t) && !TOC_ENTRY.is_match(t)).count();
    lines.len() >= 10 && hit as f64 >= lines.len() as f64 * 0.6
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexItem {
    pub kind: &'static str,
    pub text: String,
    pub song_id: Option<String>,
}

static IDX_HEAD: LazyLock<Regex> = LazyLock::new(|| jsre(r"^(\d+)\s*画"));
static IDX_PAIR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([^0-9]+?)([0-9]{1,3})").expect("正则"));
static IDX_COLHEAD: LazyLock<Regex> = LazyLock::new(|| Regex::new("^(首数)+$").expect("正则"));

/// `padStart(3, "0")`（数字串，ASCII）
fn pad3(s: &str) -> String {
    format!("{s:0>3}")
}

/// 索引行 → 条目与分节标题（TS `parseIndexLine`：按「一串非数字 + 一串数字」成对切，数字是曲号）
pub fn parse_index_line(text: &str) -> Vec<IndexItem> {
    let mut out = vec![];
    let t = js::trim(text);
    let mut i = 0usize;
    while i < t.len() {
        let rest = &t[i..];
        if let Some(h) = IDX_HEAD.captures(rest) {
            out.push(IndexItem { kind: "heading", text: format!("{}画", &h[1]), song_id: None });
            i += h[0].len();
            continue;
        }
        let mut it = rest.chars();
        let c0 = it.next().expect("非空");
        if c0.is_ascii_uppercase() && !it.next().is_some_and(|c| c.is_ascii_alphabetic()) {
            out.push(IndexItem { kind: "heading", text: c0.to_string(), song_id: None });
            i += 1;
            continue;
        }
        let Some(p) = IDX_PAIR.captures(rest) else { break };
        let label = js::trim(&p[1]);
        if !label.is_empty() && !IDX_COLHEAD.is_match(label) {
            out.push(IndexItem { kind: "entry", text: label.to_string(), song_id: Some(pad3(&p[2])) });
        }
        i += p[0].len();
    }
    out
}

// ── 扉页 / 前言 ──

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FrontPage {
    pub page: i64,
    pub kind: &'static str,
    pub title: String,
    pub body: String,
    pub note: Option<String>,
}

// ── 花边纹样 ──

pub const TILE_SLOTS: [&str; 8] = ["top", "bottom", "left", "right", "tl", "tr", "bl", "br"];

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct OrnamentTile {
    pub style: String,
    pub slot: &'static str,
    pub w: f64,
    pub h: f64,
    pub pitch: f64,
    pub ox: f64,
    pub oy: f64,
    pub path: String,
}

pub use crate::book::parts::translate_path;

/// 短哈希（djb2 + sdbm，与 glyphdict 的 `hash2` 同法；TS `hashHex`）
fn hash_hex(s: &str) -> String {
    let mut a: i32 = 5381;
    let mut b: i32 = 0;
    for c in s.encode_utf16() {
        let c = c as i32;
        a = a.wrapping_mul(33) ^ c;
        b = (c as i64 + b.wrapping_shl(6) as i64 + b.wrapping_shl(16) as i64 - b as i64) as i32;
    }
    let mut h = format!("{}-{}", radix36(a as u32), radix36(b as u32));
    h.truncate(14);
    h
}

fn radix36(mut v: u32) -> String {
    const D: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if v == 0 {
        return "0".into();
    }
    let mut s = vec![];
    while v > 0 {
        s.push(D[(v % 36) as usize]);
        v /= 36;
    }
    s.reverse();
    String::from_utf8(s).expect("ASCII")
}

/// 从一个花边框里取出它的八片母题：四条边 + 四个角，按位置分槽（TS `extractOrnamentTiles`）
pub fn extract_ornament_tiles(spec: &PageSpec, bx: &SRect, note_h: f64) -> Vec<OrnamentTile> {
    let orn: Vec<(&SRect, &str)> = spec
        .marks
        .iter()
        .filter(|m| {
            m.cls == "ornament"
                && m.d.as_deref().is_some_and(|d| !d.is_empty())
                && m.bx.x >= bx.x - 1.0
                && m.bx.y >= bx.y - 1.0
                && right(&m.bx) <= right(bx) + 1.0
                && bottom(&m.bx) <= bottom(bx) + 1.0
        })
        .map(|m| (&m.bx, m.d.as_deref().expect("已滤")))
        .collect();
    if orn.is_empty() {
        return vec![];
    }
    let edge = js::max(note_h * 0.8, js::min(bx.w, bx.h) * 0.06);
    let near = note_h * 1.35;
    let slot_of = |b: &SRect| -> Option<&'static str> {
        let cx = b.x + b.w / 2.0;
        let cy = b.y + b.h / 2.0;
        let at_l = cx - bx.x <= near;
        let at_r = right(bx) - cx <= near;
        let at_t = cy - bx.y <= near;
        let at_b = bottom(bx) - cy <= near;
        if at_t && at_l {
            return Some("tl");
        }
        if at_t && at_r {
            return Some("tr");
        }
        if at_b && at_l {
            return Some("bl");
        }
        if at_b && at_r {
            return Some("br");
        }
        let d_t = cy - bx.y;
        let d_b = bottom(bx) - cy;
        let d_l = cx - bx.x;
        let d_r = right(bx) - cx;
        let mn = min_of([d_t, d_b, d_l, d_r]);
        if mn > edge {
            return None;
        }
        Some(if mn == d_t {
            "top"
        } else if mn == d_b {
            "bottom"
        } else if mn == d_l {
            "left"
        } else {
            "right"
        })
    };
    let mut by_slot: IndexMap<&'static str, Vec<(&SRect, &str)>> = IndexMap::new();
    for (b, d) in &orn {
        if let Some(s) = slot_of(b) {
            by_slot.entry(s).or_default().push((b, d));
        }
    }
    let mut out: Vec<OrnamentTile> = vec![];
    for slot in TILE_SLOTS {
        let Some(a) = by_slot.get(slot).filter(|a| !a.is_empty()) else { continue };
        // 代表片：该槽里出现最多的那条路径（归一到自身原点后比；并列取先出现的）
        let mut tally: IndexMap<String, (usize, SRect)> = IndexMap::new();
        for (b, d) in a {
            let k = translate_path(d, -b.x, -b.y);
            tally.entry(k).and_modify(|e| e.0 += 1).or_insert((1, **b));
        }
        let mut best: Option<(&String, &(usize, SRect))> = None;
        for (k, e) in &tally {
            if best.is_none_or(|(_, be)| e.0 > be.0) {
                best = Some((k, e));
            }
        }
        let (path, (_, rep)) = best.expect("非空");
        let horiz = slot == "top" || slot == "bottom";
        let corner = slot.len() == 2;
        let mut pitch = 0.0;
        if !corner {
            let mut pos: Vec<f64> = a.iter().map(|(b, _)| if horiz { b.x } else { b.y }).collect();
            js::sort_num(&mut pos);
            let gaps: Vec<f64> = pos.windows(2).map(|w| w[1] - w[0]).collect();
            pitch = or(median(&gaps), if horiz { rep.w } else { rep.h });
        }
        let (mut ox, mut oy) = (0.0, 0.0);
        if corner {
            let sb = slot.as_bytes();
            ox = rep.x - if sb[1] == b'l' { bx.x } else { right(bx) - rep.w };
            oy = rep.y - if sb[0] == b't' { bx.y } else { bottom(bx) - rep.h };
        }
        out.push(OrnamentTile {
            style: String::new(),
            slot,
            w: fixed(rep.w, 3),
            h: fixed(rep.h, 3),
            pitch: fixed(pitch, 3),
            ox: fixed(ox, 3),
            oy: fixed(oy, 3),
            path: path.clone(),
        });
    }
    let id = hash_hex(&out.iter().map(|t| format!("{}:{}", t.slot, t.path)).collect::<Vec<_>>().join("|"));
    for t in &mut out {
        t.style = id.clone();
    }
    out
}

/// 哪几条边有纹样，如 `"TBLR"`（TS `edgeMask`）
pub fn edge_mask(tiles: &[OrnamentTile]) -> String {
    let has = |s: &str| tiles.iter().any(|t| t.slot == s);
    let mut m = String::new();
    for (s, c) in [("top", 'T'), ("bottom", 'B'), ("left", 'L'), ("right", 'R')] {
        if has(s) {
            m.push(c);
        }
    }
    m
}

/// 注解归给框上方最近的那一首（TS `ownerAbove`；那首没曲号时退到本页最后一首）
fn owner_above(spec: &PageSpec, y: f64) -> Option<String> {
    let mut above: Vec<&SongPlacement> = spec.songs.iter().filter(|s| s.y_from <= y).collect();
    js::sort_by(&mut above, |a, b| b.y_from - a.y_from);
    above.first().and_then(|s| s.id.clone()).or_else(|| spec.songs.last().and_then(|s| s.id.clone()))
}

// ── 总装 ──

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PageLabel {
    pub page: i64,
    pub label: String,
    pub no: Option<f64>,
    pub kind: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookMeta {
    pub key_meters: Vec<KeyMeter>,
    pub section_words: Vec<SectionWord>,
    pub annotations: Vec<Annotation>,
    pub toc: Vec<TocRow>,
    pub index: Vec<IndexRow>,
    pub front: Vec<FrontPage>,
    pub page_labels: Vec<PageLabel>,
    pub ornaments: Vec<OrnamentTile>,
    /// 提取不出来的东西逐条记账
    pub problems: Vec<String>,
}

static FIRST_DIGITS: LazyLock<Regex> = LazyLock::new(|| Regex::new("([0-9]+)").expect("正则"));
static SHOULJU: LazyLock<Regex> = LazyLock::new(|| Regex::new("首句").expect("正则"));

/// 整本的书级元数据（TS `buildBookMeta`；`note_h` 缺省 8.3，即 `noteHeightOf(profile)` 的兜底）
pub fn build_book_meta(specs: &[PageSpec], ov: CharOverride, note_h: Option<f64>) -> BookMeta {
    let note_h = note_h.unwrap_or(8.3);
    let mut meta = BookMeta::default();

    // 印刷页码：照抄页脚
    for s in specs {
        let label = run_text(s.footer.as_ref(), ov);
        let no = FIRST_DIGITS.captures(&label).map(|m| js::number(&m[1]));
        meta.page_labels.push(PageLabel { page: s.page, label, no, kind: s.kind.clone() });
    }

    // 曲目级：调号拍号、段落词、花边框
    let mut note_base: IndexMap<String, f64> = IndexMap::new();
    let mut meas_base: IndexMap<String, f64> = IndexMap::new();
    for spec in specs {
        for song in &spec.songs {
            let Some(id) = &song.id else { continue };
            if song.key_meter_run.is_some() {
                match parse_key_meter(song, spec.page, ov) {
                    Some(km) => meta.key_meters.push(km),
                    None => meta.problems.push(format!(
                        "p{} {}：调号拍号解析不出「{}」",
                        spec.page,
                        id,
                        run_text(song.key_meter_run.as_ref(), ov)
                    )),
                }
            }
            let mut n_ord = note_base.get(id).copied().unwrap_or(0.0);
            let mut n_meas = meas_base.get(id).copied().unwrap_or(0.0);
            for sys in &song.systems {
                let mut notes: Vec<&SChar> = sys
                    .notes
                    .iter()
                    .filter(|n| {
                        let t = ov.and_then(|f| f(&n.key, &n.ch)).unwrap_or_else(|| n.ch.clone());
                        t.len() == 1 && t.as_bytes()[0].is_ascii_digit()
                    })
                    .collect();
                js::sort_by(&mut notes, |a, b| a.x - b.x);
                for line in &sys.chord_lines {
                    for (text, x) in section_tokens(line, ov) {
                        let idx = notes.iter().position(|n| n.x + n.w / 2.0 >= x).unwrap_or_else(|| notes.len().saturating_sub(1));
                        let meas = sys.barline_xs.iter().filter(|b| **b < x).count();
                        meta.section_words.push(SectionWord {
                            song_id: id.clone(),
                            text,
                            note_ordinal: n_ord + idx as f64,
                            measure_index: n_meas + meas as f64,
                            system_index: sys.index,
                            page: spec.page,
                        });
                    }
                }
                n_ord += notes.len() as f64;
                n_meas += sys.barline_xs.len() as f64;
            }
            note_base.insert(id.clone(), n_ord);
            meas_base.insert(id.clone(), n_meas);
        }

        let line_boxes = cluster_rule_frames(&spec.frames);

        // 花边框：归给框上方最近的那一首
        for sb in &spec.story_boxes {
            let owner = owner_above(spec, sb.bx.y);
            let text = regroup_box_lines(&sb.lines, ov).join("\n");
            if text.chars().filter(|c| !js::is_space(*c)).map(char::len_utf16).sum::<usize>() < 4 {
                continue;
            }
            let hs: Vec<f64> = sb.lines.iter().flat_map(|l| l.chars.iter().map(|c| c.h)).filter(|h| *h > 2.0).collect();
            let tiles = extract_ornament_tiles(spec, &sb.bx, note_h);
            let (frame_style, frame_edges) = match tiles.first() {
                Some(t) => (Some(t.style.clone()), Some(edge_mask(&tiles))),
                None => (None, None),
            };
            meta.ornaments.extend(tiles);
            meta.annotations.push(Annotation {
                song_id: owner,
                framed: true,
                frame: Some("tile".into()),
                frame_outer_width: None,
                frame_inner_width: None,
                frame_gap: None,
                frame_style,
                frame_edges,
                size: fixed(median(&hs), 2),
                text,
                bx: sb.bx,
                page: spec.page,
            });
        }
        // 乐谱页上的注解正文：双细线框里的经文、没有框直接印在谱行下方的
        for grp in score_annotation_groups(spec, &line_boxes, ov) {
            let text = regroup_box_lines(&grp.lines, ov).join("\n");
            let chars: Vec<&SChar> = grp.lines.iter().flat_map(|l| l.chars.iter()).collect();
            let x = min_of(chars.iter().map(|c| c.x));
            let y = min_of(chars.iter().map(|c| c.y));
            let text_box = SRect { x, y, w: max_of(chars.iter().map(|c| c.x + c.w)) - x, h: max_of(chars.iter().map(|c| c.y + c.h)) - y };
            let hs: Vec<f64> = chars.iter().map(|c| c.h).filter(|h| *h > 2.0).collect();
            let lf = grp.frame.as_ref();
            meta.annotations.push(Annotation {
                song_id: owner_above(spec, y),
                framed: false,
                frame: Some(if lf.is_some() { "line" } else { "none" }.into()),
                frame_outer_width: lf.map(|f| f.outer),
                frame_inner_width: lf.map(|f| f.inner),
                frame_gap: lf.map(|f| f.gap),
                frame_style: None,
                frame_edges: None,
                size: fixed(median(&hs), 2),
                text,
                bx: lf.map_or(text_box, |f| f.bx),
                page: spec.page,
            });
        }
    }
    // 逐框收来的母题按 (style, slot) 去重
    let mut seen = std::collections::HashSet::new();
    meta.ornaments.retain(|t| seen.insert(format!("{}/{}", t.style, t.slot)));

    // 书级：目录 / 首句索引 / 扉页
    let mut toc_seq = 0usize;
    let mut idx_seq = 0usize;
    let mut index_name: &'static str = "title";
    for spec in specs {
        if is_toc_page(spec, ov) {
            let entry_sizes: Vec<f64> =
                spec.text_lines.iter().filter(|l| TOC_TAIL.is_match(js::trim(&run_text(Some(l), ov)))).map(|l| l.size).collect();
            let heading_cut = js::max(9.8, or(median(&entry_sizes), 8.0) * 1.15);
            for line in &spec.text_lines {
                let full = run_text(Some(line), ov);
                let text = js::trim(&full);
                if text.is_empty() {
                    continue;
                }
                let m = TOC_ENTRY.captures(text);
                let tail = TOC_TAIL.captures(text);
                if m.is_some() || tail.is_some() {
                    let (t, song_id, printed) = match &m {
                        Some(m) => (js::trim(&m[2]).to_string(), Some(pad3(&m[1])), js::number(&m[3])),
                        None => (
                            js::trim(&TOC_TAIL.replace(text, "")).to_string(),
                            None,
                            js::number(&tail.as_ref().expect("有尾页码")[1]),
                        ),
                    };
                    meta.toc.push(TocRow { seq: toc_seq, kind: "entry", text: t, song_id, printed_page: Some(printed), page: spec.page });
                    toc_seq += 1;
                    if m.is_none() {
                        meta.problems.push(format!("目录 p{}「{}」曲号没读出来", spec.page, text));
                    }
                    continue;
                }
                let cjk = cjk_count(text);
                if cjk >= 2 && !text.chars().any(|c| c.is_ascii_digit()) && line.size >= heading_cut && line.size < 16.0 {
                    meta.toc.push(TocRow {
                        seq: toc_seq,
                        kind: if line.size >= 12.5 { "category" } else { "subcategory" },
                        text: text.to_string(),
                        song_id: None,
                        printed_page: None,
                        page: spec.page,
                    });
                    toc_seq += 1;
                } else {
                    meta.problems.push(format!("目录 p{} 认不出的行「{}」", spec.page, text));
                }
            }
            continue;
        }
        if is_index_page(spec, ov) {
            for line in &spec.text_lines {
                let full = run_text(Some(line), ov);
                let text = js::trim(&full);
                if text.is_empty() {
                    continue;
                }
                if line.size >= 14.0 {
                    index_name = if SHOULJU.is_match(text) { "firstline" } else { "title" };
                    continue;
                }
                for r in parse_index_line(text) {
                    meta.index.push(IndexRow { seq: idx_seq, kind: r.kind, index_name, text: r.text, song_id: r.song_id, page: spec.page });
                    idx_seq += 1;
                }
            }
            continue;
        }
        if spec.kind == "front-matter" && !spec.text_lines.is_empty() {
            let music_marks = spec.marks.iter().filter(|m| m.cls == "barline" || m.cls == "divLine" || m.cls == "augmentLine").count();
            if music_marks >= 5 {
                meta.problems.push(format!("前置页 p{} 带谱（记号 {}），不当前言正文收", spec.page, music_marks));
                continue;
            }
            let rows: Vec<(String, f64)> = spec
                .text_lines
                .iter()
                .map(|l| (js::trim(&run_text(Some(l), ov)).to_string(), l.size))
                .filter(|r| !r.0.is_empty())
                .collect();
            if rows.is_empty() {
                continue;
            }
            let mut big = 0usize;
            for (i, r) in rows.iter().enumerate() {
                if r.1 > rows[big].1 {
                    big = i;
                }
            }
            let divider = rows.len() <= 3;
            let all: String = rows.iter().map(|r| r.0.as_str()).collect();
            let cjk_ratio = cjk_count(&all) as f64 / js::max(1.0, u16len(&all) as f64);
            if !divider && cjk_ratio < 0.5 {
                meta.problems.push(format!(
                    "前置页 p{} 汉字只占 {}%，多半是音符索引，不当前言正文收",
                    spec.page,
                    js::to_fixed(cjk_ratio * 100.0, 0)
                ));
                continue;
            }
            meta.front.push(FrontPage {
                page: spec.page,
                kind: if divider { "divider" } else { "prose" },
                title: if divider { all.clone() } else { rows[big].0.clone() },
                body: if divider {
                    String::new()
                } else {
                    rows.iter().enumerate().filter(|(i, _)| *i != big).map(|(_, r)| r.0.as_str()).collect::<Vec<_>>().join("\n")
                },
                note: spec.frames.iter().any(|f| f.kind == "image").then(|| "整页位图".to_string()),
            });
        }
    }

    for row in &meta.index {
        if row.kind == "entry" && row.song_id.is_none() {
            meta.problems.push(format!("索引 p{}「{}」没读出曲号", row.page, row.text));
        }
    }
    meta
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_path() {
        assert_eq!(translate_path("M1 2L3.5,4C1 2 3 4 5 6Z", -1.0, -2.0), "M0.00 0.00L2.50 2.00C0.00 0.00 2.00 2.00 4.00 4.00Z");
    }

    #[test]
    fn parses_index_line() {
        let r = parse_index_line("5画 一百只羊有九十九156A丰盛慈爱291");
        let got: Vec<(&str, &str, Option<&str>)> = r.iter().map(|x| (x.kind, x.text.as_str(), x.song_id.as_deref())).collect();
        assert_eq!(got, vec![("heading", "5画", None), ("entry", "一百只羊有九十九", Some("156")), ("heading", "A", None), ("entry", "丰盛慈爱", Some("291"))]);
    }
}
