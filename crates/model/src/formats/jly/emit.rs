//! jianpu-ly 写出端：把当前谱导出成 jianpu-ly 文本，交给上游 `jianpu-ly` 预处理器生成 LilyPond（同原 `jly/tojly.ts`）。
//!
//! **目标语法只有上游那一套**（以它 `--markdown --chinese` 生成的 README 为准，v1.890）：
//! 音符 `1`–`7`、八度 `'`/`,`、变音 `#1 b2 n3`、时值 `s`=16 分 `q`=8 分 无字母=4 分 `d`=32 分 `h`=64 分、附点 `.`、
//! 半音符及以上写增时线 `1 -`、休止 `0`、连音 `3[ q1 q1 q1 ]`、前倚音 `g[#45] 1`、圆滑线 `( )`（一字多音）/ 乐句线 `\( \)`（其余）、
//! 延音线 `~`、文字 `^"上方"`、LilyPond 指令 `\fermata` / `\bar "||"` / `\pageBreak` 原样透传、拍号 `4/4`、调号 `1=Bb`（大调）、
//! 歌词 `L:`（拉丁音节）/ `H:`（汉字，含空位占位 `""`）、注释 `%`。
//!
//! ⚠ 不要混淆方言：语料站的曲谱文件多出 `%<文件名>`、`status=`、`source=`、`%--`、`subtitle=`、收尾的 `%END`，那些不是上游语法，一律不写。
//!
//! 单向导出：不承诺能读回编辑器。装不下的东西走 `warnings` 报出来（多声部、和弦符号、演奏法、反复跳跃…），写进文件开头的 `%` 注释，不静默丢。
//! `warnings` 是写进导出文件里的注释、不是界面文字，所以不走界面语言表。
//!
//! 歌词位置与圆滑线的四条口径（都是拿真 jianpu-ly + 真 LilyPond 跑出来、再从产出 SVG 坐标读回来的，别照直觉改）：
//! ① 一个音 = 一个位置。休止、倚音跳过；增时线、附点、连音、和弦本来就是一个音，不额外占位。
//! ② 某一段在这个音上没词必须写占位 `""`，否则后面每个音节都左移一格。
//! ③ 同一段在同一个音上挂多个字：拉丁并成一个引号音节、汉字用 `_` 连写，都只占一格。
//! ④ 圆滑线 `( )` 里的音不吃音节（LilyPond `slurMelismaBusy`），所以只有真的一字多音才写 `(`，其余写乐句线 `\( \)`。

use crate::base::{js, Fraction};
use crate::marknames::is_dynamic_name;
use crate::ScoreDoc;

use super::chords::{harmony_to_chord_token, whole_to_duration};
use super::fromjly::is_bare_direction;
use super::input::{jly_input_of_doc, JChord, JDir, JEntry, JMeasure, JScore};

/// 导出结果：文本 + 装不下的东西
pub struct JlyExport {
    pub text: String,
    pub warnings: Vec<String>,
}

/// 按插入次序去重的提示集合（原 TS `Set<string>`）
#[derive(Default)]
struct Warnings(Vec<String>);

impl Warnings {
    fn add(&mut self, w: impl Into<String>) {
        let w = w.into();
        if !self.0.contains(&w) {
            self.0.push(w);
        }
    }
}

// ───────────────────────── 基础映射 ─────────────────────────

/// 减时线条数 → 时值字母（0 条即四分音符，不写字母）
const BEAM_LETTER: [&str; 5] = ["", "q", "s", "d", "h"];

/// 模型没给换行时，一行写几个小节（简谱的常规版面：`.jly` 打开后按文件里的行排版，整首挤一行会叠成一团）
const MEASURES_PER_LINE: usize = 4;

/// 调号 `fifths` → 大调主音名（jianpu-ly 的 `1=<名>`）
fn major_by_fifths(fifths: f64) -> Option<&'static str> {
    const NAMES: [&str; 15] = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
    if fifths.fract() != 0.0 || !(-7.0..=7.0).contains(&fifths) {
        return None;
    }
    Some(NAMES[(fifths + 7.0) as usize])
}

/// 变音记号：引擎输入用一个空格表示「没有记号」，不能原样拼进 token
fn alter_of(jp_alter: &str) -> &str {
    js::trim(jp_alter)
}

fn octave_marks(jp_octave: f64) -> String {
    if jp_octave > 0.0 {
        "'".repeat(jp_octave as usize)
    } else {
        ",".repeat((-jp_octave).max(0.0) as usize)
    }
}

/// 休止或音：时值字母 + 音高 + 附点（README 的写法：`s1.`）。歌词位置也按「是不是休止」同一份口径
fn chord_body(c: &JChord, letter: &str, dots: &str) -> String {
    if c.rest {
        return format!("{letter}0{dots}");
    }
    format!("{letter}{}{}{}{dots}", alter_of(&c.jp_alter), c.number, octave_marks(c.jp_octave))
}

/// 增时线：`beats` 里的 1 表示没有，多出来的每一拍一个 `-`（前面留空格，上游 #134 就是修这个）
fn sustain_of(c: &JChord) -> String {
    let beats = if c.beats == 0.0 { 1.0 } else { c.beats };
    let n = js::max(0.0, beats - 1.0) as usize;
    if n == 0 {
        String::new()
    } else {
        format!(" {}", vec!["-"; n].join(" "))
    }
}

/// 连音（`n[ `，n = 这一组几个音，缩放由 jianpu-ly 自己算）与前倚音（组内不能有空格：`g[#45] 1`）
fn ornaments_before(c: &JChord, warnings: &mut Warnings) -> String {
    let mut out = String::new();
    if c.tuplet_begin {
        let n = c.tuplet.map_or(0, |(a, b)| if b >= a { b - a + 1 } else { 0 });
        if n >= 2 {
            out += &format!("{n}[ ");
        } else {
            warnings.add("有连音组数不出音数（按三连音写出）");
            out += "3[ ";
        }
    }
    if !c.grace_notes.is_empty() {
        // 时值：未记（八分）不写字母，十六 / 三十二 / 六十四分写 `s` / `d` / `h`（读写对称，见 fromjly）
        let letter = |d: Option<f64>| match d {
            Some(16.0) => "s",
            Some(32.0) => "d",
            Some(64.0) => "h",
            _ => "",
        };
        out += "g[";
        for g in &c.grace_notes {
            out += letter(g.duration);
            out += alter_of(&g.jp_alter);
            out += &g.number;
            out += &octave_marks(g.jp_octave);
        }
        out += "] ";
    }
    out
}

/// 跳转记号的裸词（读的时候带点的 `D.C.` / `D.S.` 也认，写出去必须去掉点：`D.C.` 会被上游拒掉）
fn jump_out(text: &str) -> Option<&'static str> {
    Some(match text.to_lowercase().as_str() {
        "fine" => "Fine",
        "dc" | "d.c." => "DC",
        "ds" | "d.s." => "DS",
        "segno" => "Segno",
        "tocoda" => "ToCoda",
        _ => return None,
    })
}

fn quote_word(text: &str) -> String {
    format!(" ^\"{}\"", text.replace('"', "'"))
}

fn ornaments_after(c: &JChord, plan: &JlyPlan, warnings: &mut Warnings) -> String {
    // 圆滑线一律后置（贴在起音后面）：前置的话 LilyPond 把 `(` 算在前一个音头上，后面的音节都错位一格。
    // 先收（内层先收）、再开；同一个音既收又开时就是这个顺序
    let mut out = plan.slur_close[c.ci].clone();
    out += plan.slur_open[c.ci];
    if c.tuplet_end {
        out += " ]";
    }
    if c.fermata {
        out += " \\fermata";
    }
    // 谱上文字（123 的 `"^渐慢"`）→ 上游的 `^"…"`
    let mut said: Vec<String> = vec![];
    if let Some(sw) = c.section_word.as_deref().filter(|s| !js::trim(s).is_empty()) {
        let word = sw.split('\n').map(js::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ");
        out += &quote_word(&word);
        said.push(word);
    }
    // 演奏法：看着像力度名的写成 jianpu-ly 的 `\mf`；其余报出来
    let mut arts: Vec<&str> = vec![];
    for a in &c.articulations {
        let name = js::trim(a);
        if name.is_empty() {
            continue;
        }
        if is_dynamic_name(name) {
            out += &format!(" \\{name}");
            continue;
        }
        arts.push(name);
    }
    if !arts.is_empty() {
        warnings.add(format!("演奏法记号尚未导出：{}", arts.join(" ")));
    }
    for d in &c.directions {
        // 字形记号（力度、segno / coda）走 jianpu-ly 的指令或裸词；写成 `^"…"` 会把私有区字形印成乱码
        match d {
            JDir::Dynamic(name) => out += &format!(" \\{name}"),
            JDir::Segno => out += " Segno",
            JDir::Coda => out += " ToCoda",
            JDir::Text(t) => {
                let text = js::trim(t);
                // 同一个字别写两遍（段落词与文字记号可能是同一件事）
                if text.is_empty() || said.iter().any(|s| s == text) {
                    continue;
                }
                if is_bare_direction(text) {
                    out += " ";
                    out += jump_out(text).unwrap_or(text);
                } else {
                    out += &quote_word(text);
                }
            }
        }
    }
    out
}

// ───────────────────────── 谱头 ─────────────────────────

const HEADER_TYPES: [&str; 6] = ["subtitle", "composer", "poet", "arranger", "copyright", "opus"];

fn header_lines(score: &JScore, first: Option<&JMeasure>) -> Vec<String> {
    let mut out = vec![];
    if !score.title.is_empty() {
        out.push(format!("title={}", score.title.replace('\n', " ")));
    }
    let mut seen: Vec<String> = vec![];
    for (kind, text) in &score.credit {
        let kind = kind.as_deref().unwrap_or("").to_lowercase();
        if !HEADER_TYPES.contains(&kind.as_str()) || text.is_empty() || seen.contains(&kind) {
            continue;
        }
        out.push(format!("{kind}={}", text.replace('\n', " ")));
        seen.push(kind);
    }
    if let Some(key) = first.and_then(|m| major_by_fifths(m.fifths)) {
        out.push(format!("1={key}"));
    }
    if let Some(m) = first {
        out.push(format!("{}/{}", js::num_to_string(m.beats), js::num_to_string(m.beat_type)));
    }
    out
}

// ───────────────────────── 歌词位置 / 圆滑线 ─────────────────────────

/// 一段歌词在这个音上没词时的占位：LilyPond 的空字符串音节（上游自己也写它）
const LYRIC_HOLD: &str = "\"\"";

fn is_han_char(c: char) -> bool {
    ('\u{3400}'..='\u{9fff}').contains(&c) || ('\u{f900}'..='\u{faff}').contains(&c)
}

fn is_han(text: &str) -> bool {
    text.chars().any(is_han_char)
}

/// 拉丁音节一律加引号：不加的话 `4`、`s0`、`r` 这种字会被 LilyPond 读成时值（实测整份报 `not a duration`）
fn latin_quote(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

/// 汉字行里一个音节的写法：上游把相邻两个汉字自动拆成两个音节，压在一个音上的多字要写 `_` 连写（汉字后紧跟左引号同理）
fn hanzi_glue(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if out.chars().last().is_some_and(is_han_char) && (is_han_char(c) || matches!(c, '\u{2018}' | '\u{201c}' | '\u{300a}')) {
            out.push('_');
        }
        out.push(c);
    }
    out
}

/// 两个音同音高（度数、八度、记号；后一个音不写记号视为沿用）
fn same_pitch(a: &JChord, b: &JChord) -> bool {
    if a.rest || b.rest {
        return false;
    }
    a.number == b.number && a.jp_octave == b.jp_octave && (js::trim(&b.jp_alter).is_empty() || b.jp_alter == a.jp_alter)
}

struct JlyPlan {
    /// 圆滑线：组首挂开括号、组尾挂闭括号（同一个音上收多条时内层在前）。按和弦次序下标
    slur_open: Vec<&'static str>,
    slur_close: Vec<String>,
    /// 延音线：在这个音后面写 `~`
    tie_after: Vec<bool>,
    /// 歌词位置：发音的和弦（一字多音的圆滑线整组算一个位置）
    slots: Vec<usize>,
    /// 段号（按首次出现的次序）
    verses: Vec<f64>,
    /// 和弦 → [(段号, 该段在这个音上的字)]
    at: Vec<Vec<(f64, Vec<String>)>>,
}

impl JlyPlan {
    fn texts(&self, ci: usize, v: f64) -> &[String] {
        self.at[ci].iter().find(|(n, _)| *n == v).map_or(&[], |(_, t)| t.as_slice())
    }
}

fn plan_jly(order: &[&JChord], warnings: &mut Warnings) -> JlyPlan {
    let n = order.len();
    // 逐段的字。不能丢同段的第二个字：那正是「一个音上两个汉字」（`一_三`）
    let mut at: Vec<Vec<(f64, Vec<String>)>> = vec![vec![]; n];
    let mut verses: Vec<f64> = vec![];
    for (i, c) in order.iter().enumerate() {
        for (num, text) in &c.lyrics {
            if text.is_empty() {
                continue;
            }
            if c.rest {
                warnings.add("有歌词挂在休止符上：jianpu-ly 那边休止不占歌词位，这个字已略过");
                continue;
            }
            let per = &mut at[i];
            let k = match per.iter().position(|(v, _)| v == num) {
                Some(k) => k,
                None => {
                    per.push((*num, vec![]));
                    per.len() - 1
                }
            };
            // 同一个字重复挂（多声部投影）只算一次
            if !per[k].1.contains(text) {
                per[k].1.push(text.clone());
            }
            if !verses.contains(num) {
                verses.push(*num);
            }
        }
    }
    let has = |ci: usize, v: f64| at[ci].iter().any(|(n, t)| *n == v && !t.is_empty());

    // 圆滑线分组：投影已把配对算好（`slur_start` + `slur_end_chords`）
    struct Group {
        start: usize,
        end: usize,
        melisma: bool,
    }
    let mut groups: Vec<Group> = vec![];
    let mut tie_after = vec![false; n];
    for (i, c) in order.iter().enumerate() {
        if !c.slur_start {
            continue;
        }
        // LilyPond 一个音上只起得了一条 `(`：同起点的几条弧只写最内那条（最先收的），外弧略过
        let j = c.slur_end_chords.first().copied();
        // 配不上对的弧线不写：写了 LilyPond 会拿到一个没有收尾的 `(`
        let Some(j) = j.filter(|&j| j < n && j >= i) else {
            warnings.add("有配不上对的圆滑线（少了收尾），已略过");
            continue;
        };
        // 一字多音：每一段在这组里至多一个音节，且落在组首——才敢用会吞音节的 `(`
        let melisma = verses.iter().all(|&v| {
            let hits: Vec<usize> = (i..=j).filter(|&x| has(x, v)).collect();
            hits.len() <= 1 && (hits.is_empty() || hits[0] == i)
        });
        // 相邻两个同音、后一个不吃字：这是延音线，写 `~`（写成 `( )` 上游会排成圆滑线、MIDI 也会重新起音）
        if melisma && j == i + 1 && same_pitch(c, order[j]) {
            tie_after[i] = true;
            continue;
        }
        groups.push(Group { start: i, end: j, melisma });
    }
    let mut slur_open = vec![""; n];
    let mut closing: Vec<Vec<(usize, bool)>> = vec![vec![]; n];
    for g in &groups {
        slur_open[g.start] = if g.melisma { " (" } else { " \\(" };
        closing[g.end].push((g.start, g.melisma));
    }
    let slur_close = closing
        .into_iter()
        .map(|mut list| {
            // 内层（后开）先收
            list.sort_by_key(|a| std::cmp::Reverse(a.0));
            list.iter().map(|&(_, m)| if m { " )" } else { " \\)" }).collect::<String>()
        })
        .collect();

    // 一字多音的弧线里，组首以外的音不吃音节；延音线接续的音也不吃
    let mut swallowed = vec![false; n];
    for g in &groups {
        if g.melisma {
            for s in swallowed.iter_mut().take(g.end + 1).skip(g.start + 1) {
                *s = true;
            }
        }
    }
    for i in 0..n {
        if tie_after[i] && i + 1 < n {
            swallowed[i + 1] = true;
        }
    }
    let slots = (0..n).filter(|&i| !order[i].rest && !swallowed[i]).collect();
    JlyPlan { slur_open, slur_close, tie_after, slots, verses, at }
}

/// 一行和弦符号（`chords=c2. g:7 c`）：时值按「持续到下一个和弦」算（最后一个到曲末）。一个都写不出返回 None
fn chord_line(measures: &[JMeasure], warnings: &mut Warnings) -> Option<String> {
    let mut chords: Vec<(&str, Fraction, Fraction)> = vec![];
    for m in measures {
        for c in m.chords() {
            let Some(h) = c.harmony.as_deref() else { continue };
            if c.rest {
                continue;
            }
            chords.push((h, m.position.plus(&c.position), c.duration));
        }
    }
    let last = chords.last()?;
    // 曲末：最后一小节最后一音之后
    let mut end = last.1.plus(&last.2);
    for m in measures {
        for c in m.chords() {
            let stop = m.position.plus(&c.position).plus(&c.duration);
            if stop.to_float() > end.to_float() {
                end = stop;
            }
        }
    }
    let mut toks: Vec<String> = vec![];
    for (i, (text, position, _)) in chords.iter().enumerate() {
        let next = chords.get(i + 1).map_or(end, |c| c.1);
        // 输入的时值 / 位置以四分音符为 1，`chords=` 的时值是「几个全音符」——不除 4 会写出 `1...`
        let whole = js::max(1.0 / 64.0, next.minus(position).to_float() / 4.0);
        match harmony_to_chord_token(text, whole) {
            Some(tok) => {
                if !whole_to_duration(whole).1 && !tok.contains('*') {
                    warnings.add(format!("和弦时值不是规整时值，已按最接近的写出（{text}）"));
                }
                toks.push(tok);
            }
            None => warnings.add(format!("和弦符号写不出（上游用 LilyPond 和弦语法，认不出的后缀没法写）：{text}")),
        }
    }
    if toks.is_empty() {
        None
    } else {
        Some(format!("chords={}", toks.join(" ")))
    }
}

/// 反复跳跃（`R{ … } A{ … }`）：上游只能表达一种形态——一次反复开始 + 一次反复收尾 + 一段第二房。
/// 别的一律退回 `\bar` 小节线（多一根 `}` 会让上游直接崩）。返回：小节下标 → 写在该小节之前 / 之后的词
fn ending_marks(measures: &[JMeasure], warnings: &mut Warnings) -> (Vec<Option<String>>, Vec<Option<String>>) {
    let n = measures.len();
    let mut before: Vec<Option<String>> = vec![None; n];
    let mut after: Vec<Option<String>> = vec![None; n];
    let fwd: Vec<usize> = (0..n).filter(|&i| measures[i].repeat_forward).collect();
    let back: Vec<usize> = (0..n).filter(|&i| measures[i].repeat_backward).collect();
    let ends: Vec<(usize, f64)> = (0..n).flat_map(|i| measures[i].ending_num.iter().flatten().map(move |&k| (i, k))).collect();
    let alt: Vec<usize> = ends.iter().filter(|e| e.1 == 2.0).map(|e| e.0).collect();
    if fwd.len() != 1 || back.len() != 1 || alt.is_empty() || ends.iter().any(|e| e.1 != 2.0) {
        if !fwd.is_empty() || !back.is_empty() || !ends.is_empty() {
            warnings.add("反复跳跃的写法不是上游能表达的那一种（一次反复 + 一段第二房），已退化成普通小节线");
        }
        return (before, after);
    }
    let add = |map: &mut Vec<Option<String>>, i: usize, word: &str| {
        map[i] = Some(map[i].take().unwrap_or_default() + word);
    };
    add(&mut before, fwd[0], "R{");
    add(&mut after, back[0], "}");
    add(&mut before, alt[0], "A{");
    add(&mut after, alt[alt.len() - 1], "}");
    (before, after)
}

/// 逐段收集歌词：逐位置填字或填占位
fn lyric_lines(plan: &JlyPlan, warnings: &mut Warnings) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    // 多段才印段号（上游多段时写 `2. `）
    let numbered = plan.verses.len() > 1;
    for &v in &plan.verses {
        let mut latin: Vec<String> = vec![];
        let mut han: Vec<String> = vec![];
        let mut last_latin: Option<usize> = None;
        let mut last_han: Option<usize> = None;
        for (i, &ci) in plan.slots.iter().enumerate() {
            let texts = plan.texts(ci, v);
            let l: Vec<&str> = texts.iter().filter(|t| !is_han(t)).map(String::as_str).collect();
            let h: Vec<&str> = texts.iter().filter(|t| is_han(t)).map(String::as_str).collect();
            if !l.is_empty() && !h.is_empty() {
                warnings.add("同一段歌词里拉丁与汉字混排：已拆成 `L:` 与 `H:` 两行（上游没有混排写法）");
            }
            latin.push(if l.is_empty() { LYRIC_HOLD.to_string() } else { latin_quote(&l.join(" ")) });
            han.push(if h.is_empty() { LYRIC_HOLD.to_string() } else { h.iter().map(|t| hanzi_glue(t)).collect::<Vec<_>>().join("_") });
            if !l.is_empty() {
                last_latin = Some(i);
            }
            if !h.is_empty() {
                last_han = Some(i);
            }
        }
        // 段号：第一格的字自己就可能带着段号（JP-Word 的 `1.圣`），那就别再叠一个
        let vs = js::num_to_string(v);
        let label = |arr: &[String]| -> String {
            let already = arr.iter().find(|t| !t.is_empty()).is_some_and(|f| f.starts_with(&format!("{vs}. ")) || f.starts_with(&format!("{vs}.")));
            if numbered && !already {
                format!("{vs}. ")
            } else {
                String::new()
            }
        };
        // 尾巴上的空位不用写（上游导出时也会把尾部的空音节剪掉）
        if let Some(k) = last_latin {
            out.push(format!("L: {}{}", label(&latin), latin[..=k].join(" ")));
        }
        if let Some(k) = last_han {
            out.push(format!("H: {}{}", label(&han), han[..=k].join(" ")));
        }
    }
    // 输入不带 `syllabic`，拉丁歌词只能按空格分音节写；连字符这一版表达不出来，报出来别静默丢
    if out.iter().any(|l| l.starts_with("L:")) {
        warnings.add("拉丁歌词的连字符（`syl- la- bles`）尚未导出，按空格分音节写出");
    }
    out
}

// ───────────────────────── 主流程 ─────────────────────────

fn emit_jly_of_score(score: &JScore, warnings: &mut Warnings) -> String {
    let measures: &[JMeasure] = score.parts.first().map_or(&[], |p| p.as_slice());
    let mut lines = header_lines(score, measures.first());
    // 和弦符号行紧跟谱头（上游就这么写）
    if let Some(row) = chord_line(measures, warnings) {
        lines.push(row);
    }
    // 歌词位置与圆滑线写法要先算：音乐行里写 `(` 还是 `\(` 由它定，歌词行也按它填占位
    let order: Vec<&JChord> = measures.iter().flat_map(|m| m.chords()).collect();
    let plan = plan_jly(&order, warnings);

    // 行的累加器是函数级的：一行可以跨多个小节，只有遇到源谱的换行才收一行
    let mut tokens: Vec<String> = vec![];
    let flush = |tokens: &mut Vec<String>, lines: &mut Vec<String>| {
        if !tokens.is_empty() {
            lines.push(tokens.join(" "));
            tokens.clear();
        }
    };
    // 模型带了换行就听模型的；没有就每 4 小节收一行
    let mut since_break = 0usize;
    // 已经到小节末的换行 / 换页：等小节线写完再落地
    let mut pending_break: Option<&str> = None;
    let (before, after) = ending_marks(measures, warnings);
    for (mi, m) in measures.iter().enumerate() {
        if let Some(w) = &before[mi] {
            flush(&mut tokens, &mut lines);
            tokens.push(w.clone());
        }
        // 拍号 / 调号变更各占一行；只有真的变更才 flush（别每小节都换行）
        if m.time_change {
            flush(&mut tokens, &mut lines);
            lines.push(format!("{}/{}", js::num_to_string(m.beats), js::num_to_string(m.beat_type)));
            since_break = 0;
        }
        if m.key_change {
            if let Some(tonic) = major_by_fifths(m.fifths) {
                flush(&mut tokens, &mut lines);
                lines.push(format!("1={tonic}"));
                since_break = 0;
            }
        }
        // 用上 `R{ } A{ }` 时就不再写 `\bar` 反复线
        if m.repeat_forward && before[mi].is_none() {
            flush(&mut tokens, &mut lines);
            tokens.push("\\bar \".|:\"".into());
        }
        for (ei, e) in m.entries.iter().enumerate() {
            match e {
                JEntry::Chord(c) => {
                    if c.beams >= BEAM_LETTER.len() as f64 {
                        warnings.add("有超过 4 条减时线（64 分）的时值，已按 64 分写出");
                    }
                    let dots = ".".repeat(c.dot as usize);
                    let letter = BEAM_LETTER.get(c.beams as usize).copied().unwrap_or("");
                    let mut tok = ornaments_before(c, warnings);
                    tok += &chord_body(c, letter, &dots);
                    tok += &sustain_of(c);
                    tok += &ornaments_after(c, &plan, warnings);
                    tokens.push(tok);
                    // 延音线写在两音之间
                    if plan.tie_after[c.ci] {
                        tokens.push("~".into());
                    }
                }
                JEntry::Break { new_page } => {
                    // 模型里的换行都是显式的，除了收一行还得把指令写出去。写的位置要能原样读回来：
                    // 这一小节后面还有音 → 就地写；已经到小节末 → 等小节线写完再写
                    let brk = if *new_page { "\\pageBreak" } else { "\\break" };
                    let at_end = !m.entries[ei + 1..].iter().any(|x| matches!(x, JEntry::Chord(_)));
                    if at_end {
                        pending_break = Some(brk);
                    } else {
                        tokens.push(brk.into());
                        flush(&mut tokens, &mut lines);
                        since_break = 0;
                    }
                }
                JEntry::Bar => {}
            }
        }
        if m.ending_num.as_ref().is_some_and(|e| e.iter().any(|&k| k > 2.0)) {
            warnings.add("反复跳跃有第 3 房及以后：上游只能表达两房（`R{ } A{ }`）");
        }
        tokens.push(if m.repeat_backward && after[mi].is_none() { "\\bar \":|.\"".into() } else { "|".into() });
        if let Some(brk) = pending_break.take() {
            tokens.push(brk.into());
            flush(&mut tokens, &mut lines);
            since_break = 0;
        }
        if let Some(w) = &after[mi] {
            tokens.push(w.clone());
        }
        since_break += 1;
        if since_break >= MEASURES_PER_LINE {
            flush(&mut tokens, &mut lines);
            since_break = 0;
        }
    }
    flush(&mut tokens, &mut lines);

    lines.extend(lyric_lines(&plan, warnings));
    // 装不下的东西写进文件本身当注释（上游 README：「忽略：`% 注释`」）。不要写 `%END`（语料方言，不是上游语法）
    warnings
        .0
        .iter()
        .map(|w| format!("% {w}"))
        .chain(lines)
        .filter(|l| !js::trim(l).is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

/// `ScoreDoc` → jianpu-ly 文本。投影不出来时报 `noLines`（与其它写出端一致，调用方翻成界面文案）。
///
/// 两种输入形状都收：文本谱 / 123 / ABC / MusicXML 走简谱形状投影，`.jpwabc` 按原文小节投影。
pub fn emit_jly(doc: &ScoreDoc) -> Result<JlyExport, String> {
    let mut warnings = Warnings::default();
    let score = jly_input_of_doc(doc)?.ok_or_else(|| "noLines".to_string())?;
    if score.parts.len() > 1 {
        warnings.add(format!("多声部：jianpu-ly 导出只写第一声部（共 {} 个）", score.parts.len()));
    }
    // 多曲（上游 `NextScore`）：本版只写第一首
    if doc.songs.len() > 1 {
        warnings.add(format!("多曲：jianpu-ly 导出只写第一首（共 {} 首）", doc.songs.len()));
    }
    // 同一声部里的多声部不能靠投影结果判（投影只取第 1 声部），回到模型上数
    if doc.songs.iter().any(|s| s.parts.iter().any(|p| p.measures.iter().any(|m| m.elements.iter().any(|e| e.voice() > 1.0)))) {
        warnings.add("多声部：投影只取第 1 声部，第 2 及以后的声部不会出现在导出的文本里");
    }
    let text = emit_jly_of_score(&score, &mut warnings);
    Ok(JlyExport { text, warnings: warnings.0 })
}
