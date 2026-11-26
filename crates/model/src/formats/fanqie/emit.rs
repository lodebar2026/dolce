//! `ScoreDoc` → 文本谱原文（番茄简谱 / 诗歌本文本谱），同 `fanqie/tofanqie.ts`。文本谱**唯一**的写出端。
//!
//! 映射照 `fromfanqie` 反着写，每一处写法以 `parse` 为准：
//!   - 文本谱的小节线一律「收」一个小节，没有左线：模型里的左线（123/ABC 的 `|:`）并到前一小节的右线上写；
//!   - 弧线与多连音共用**一个队列**（`)` 永远收最早开的那条），真嵌套的写不出来，按优先级留（`plan::plan_arcs`）；
//!   - 休止缺省不跟词、音符一律跟词，例外靠 `@` 翻（`0@` / `-@`）；
//!   - 一行 `Q:` 就是谱面一行（不自动断行），所以模型里没有换行的曲子先按乐句断好再写。
//!
//! 方言差异一律从 `DialectSpec` 取（`header` 管头部、`emit` 管曲行与歌词行），**不要在两套方言之间写 if**。
//!
//! 按乐句断行走排版行视图（`crate::view::phraselines::phrase_cuts`，缺省分法：按乐句、不量宽），换行本身由 `apply_breaks` 落。
//! TS 按对象身份记的「已并进上一小节右线的左线」「只罩一小节的不封口房号」改记 (小节, 小节线) 下标。

use super::ast::BarlineType;
use super::dialect::{Dialect, DialectSpec, KeyMeter, KeyStyle};
use super::plan::{is_stream_element, plan_arcs, positions, short_open_voltas, writable_marks, ArcPlan};
use crate::base::js;
use crate::breaks::{apply_breaks, ApplyBreaksOptions, LineStart, MidMode, PageMode};
use crate::deconames::deco_key;
use crate::directionmarks::{direction_marks, directions_as_marks};
use crate::emitutil::{own_ids, part_ranges, part_ranges_on_axis, system_ranges, SystemRange};
use crate::innervoice::voices_to_layers;
use crate::jianpu::{fill_degrees_from_pitch, harmony_text, quarter_tempos, top_note};
use crate::jianpuproject::project_for_jianpu;
use crate::keyshift::{degree_of_key, song_fifths, tonic_spelling};
use crate::marknames::{DYNAMIC_NAMES, TERMS};
use crate::timeaxis::axis_of_song;
use crate::*;
use crate::play::jppitch::{key_alter, tonic_step, STEPS};
use std::collections::{HashMap, HashSet};

const INF: usize = usize::MAX;

/// 按乐句断行（缺省分法：按乐句、不量宽）：各新行行首元素 id（拿不到 id 的为 `None`）；断不出来、或有行首 id 是负的临时号回 `None`
fn phrase_cuts(song: &Song) -> Option<Vec<Option<ElementId>>> {
    let doc = ScoreDoc { source_format: SourceFormat::S123, fanqie_dialect: None, source: None, songs: vec![song.clone()], diagnostics: vec![] };
    let view = crate::view::slots::doc_view(&doc, None);
    let content = crate::play::phrase::PhraseOptions::default();
    let plan = crate::view::phraselines::LinePlan::Phrase { content: &content, mid: false };
    let (cuts, _) = crate::view::phraselines::phrase_cuts(&doc, &view, 0, &plan, None).ok()?;
    cuts?.into_iter().map(|c| c.id.map(ElementId::try_from).transpose().ok()).collect()
}

#[derive(Clone, Copy, Default)]
pub struct EmitFanqieOptions {
    /// 模型来自文本谱本身：照原文的写法还原，不替它收口房号
    pub from_fanqie: bool,
    /// 模型来自 ABC：`X:` 是文件内编号、不是曲号
    pub from_abc: bool,
}

// ───────────────────────── 小工具 ─────────────────────────

/// `s.split(/\r?\n/)`
fn split_lines(s: &str) -> impl Iterator<Item = &str> {
    s.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l))
}

fn rep(s: &str, n: f64) -> String {
    s.repeat(js::repeat_count(n))
}

fn quoted(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "'"))
}

/// `\p{Script=Han}`（Unicode 16 的 Han 区段）
fn is_han(c: char) -> bool {
    const R: &[(u32, u32)] = &[
        (0x2E80, 0x2E99),
        (0x2E9B, 0x2EF3),
        (0x2F00, 0x2FD5),
        (0x3005, 0x3005),
        (0x3007, 0x3007),
        (0x3021, 0x3029),
        (0x3038, 0x303B),
        (0x3400, 0x4DBF),
        (0x4E00, 0x9FFF),
        (0xF900, 0xFA6D),
        (0xFA70, 0xFAD9),
        (0x16FE2, 0x16FE3),
        (0x16FF0, 0x16FF1),
        (0x20000, 0x2A6DF),
        (0x2A700, 0x2B739),
        (0x2B740, 0x2B81D),
        (0x2B820, 0x2CEA1),
        (0x2CEB0, 0x2EBE0),
        (0x2EBF0, 0x2EE5D),
        (0x2F800, 0x2FA1D),
        (0x30000, 0x3134A),
        (0x31350, 0x323AF),
    ];
    let u = c as u32;
    R.iter().any(|&(a, b)| (a..=b).contains(&u))
}

fn has_han(s: &str) -> bool {
    s.chars().any(is_han)
}

fn has_latin(s: &str) -> bool {
    s.chars().any(|c| c.is_ascii_alphabetic())
}

// ───────────────────────── 头部 ─────────────────────────

/// fifths → 调号名。升降号写在哪一侧由方言决定：番茄 `D:` 两种顺序都收，诗歌本的 `1=` 行只认字母在前。
pub fn key_name_of(fifths: f64, style: KeyStyle) -> String {
    let idx = tonic_step(fifths);
    let alter = key_alter(idx, fifths);
    let sign = if alter < 0.0 {
        "b"
    } else if alter > 0.0 {
        "#"
    } else {
        ""
    };
    let step = STEPS[idx as usize];
    if style == KeyStyle::Suffix {
        format!("{step}{sign}")
    } else {
        format!("{sign}{step}")
    }
}

/// 番茄 `D:` 收的调号原文；诗歌本 `1=` 行只认字母在前
fn key_display_ok(s: &str, style: KeyStyle) -> bool {
    let c: Vec<char> = s.chars().collect();
    let letter = |x: char| ('A'..='G').contains(&x);
    match style {
        // `/^(?:[A-G][#$b♭♯]?|[#$b♭♯][A-G])$/`
        KeyStyle::Prefix => {
            let acc = |x: char| "#$b♭♯".contains(x);
            match c.as_slice() {
                [a] => letter(*a),
                [a, b] => (letter(*a) && acc(*b)) || (acc(*a) && letter(*b)),
                _ => false,
            }
        }
        // `/^[A-G][b#$♭♯]?$/`
        KeyStyle::Suffix => match c.as_slice() {
            [a] => letter(*a),
            [a, b] => letter(*a) && "b#$♭♯".contains(*b),
            _ => false,
        },
    }
}

/// 调号写法。优先原文（`♭A` 这类照印），其次拼写，最后才从 fifths 推。
fn key_text(k: Option<&Key>, style: KeyStyle) -> String {
    let Some(k) = k else { return "C".into() };
    if let Some(d) = k.display.as_deref().filter(|d| key_display_ok(d, style)) {
        return d.into();
    }
    // 没有拼写的（识别出的小调只记 fifths + 主音唱名）取主音的音名，不取同调号的大调名
    let sp = match k.spelling.as_deref() {
        Some(s) if !s.is_empty() && s != "none" => s.to_string(),
        _ => tonic_spelling(k),
    };
    // `/^([#b]?)([A-G])([#b]?)$/`
    let c: Vec<char> = sp.chars().collect();
    let acc = |x: char| x == '#' || x == 'b';
    let (pre, letter, post) = match c.as_slice() {
        [l] => (None, *l, None),
        [a, l] if acc(*a) && ('A'..='G').contains(l) => (Some(*a), *l, None),
        [l, b] if ('A'..='G').contains(l) && acc(*b) => (None, *l, Some(*b)),
        [a, l, b] if acc(*a) && acc(*b) => (Some(*a), *l, Some(*b)),
        _ => return key_name_of(k.fifths, style),
    };
    if !('A'..='G').contains(&letter) {
        return key_name_of(k.fifths, style);
    }
    let sign: String = pre.or(post).map(String::from).unwrap_or_default();
    if style == KeyStyle::Suffix {
        format!("{letter}{sign}")
    } else {
        format!("{sign}{letter}")
    }
}

/// 头部拍号：`4/4 (2/4 1/4)`
fn meter_text(song: &Song) -> String {
    let mut parts: Vec<String> = vec![];
    let mut in_paren = false;
    for t in song.time.iter().chain(song.extra_times.iter().flatten()) {
        let paren = t.parenthesized == Some(true);
        if !paren && in_paren {
            parts.last_mut().unwrap().push(')');
        }
        parts.push(format!("{}{}/{}", if paren && !in_paren { "(" } else { "" }, js::num_to_string(t.beats), js::num_to_string(t.beat_type)));
        in_paren = paren;
    }
    if in_paren {
        parts.last_mut().unwrap().push(')');
    }
    parts.join(" ")
}

/// 字段值里的换行会把后续内容变成裸行：一律按行拆成多条同名字段
fn push_field(l: &mut Vec<String>, name: &str, value: &str) {
    for line in split_lines(value) {
        let t = js::trim(line);
        if !t.is_empty() {
            l.push(format!("{name}:{t}"));
        }
    }
}

fn is_field_line(t: &str) -> bool {
    // `/^\s*[A-Za-z]+\s*[:：]/`
    let t = t.trim_start_matches(js::is_space);
    let n = t.chars().take_while(|c| c.is_ascii_alphabetic()).count();
    n > 0 && {
        let rest = t[n..].trim_start_matches(js::is_space);
        rest.starts_with(':') || rest.starts_with('：')
    }
}

fn is_key_line(t: &str) -> bool {
    // `/^\s*[1-7]\s*=/`
    let t = t.trim_start_matches(js::is_space);
    let mut c = t.chars();
    matches!(c.next(), Some('1'..='7')) && c.as_str().trim_start_matches(js::is_space).starts_with('=')
}

/// 这行自由文字原样写回去会不会被读成别的东西（字段、曲行、注释、分曲线）。会就不写。
fn is_safe_remark(line: &str) -> bool {
    let t = js::trim(line);
    if t.is_empty() {
        return false;
    }
    if t.starts_with('#') || (t.len() >= 5 && t.chars().all(|c| c == '-')) || t.eq_ignore_ascii_case("[fenye]") {
        return false;
    }
    if is_field_line(t) || is_key_line(t) {
        return false;
    }
    !(t.contains('|') && t.chars().any(|c| c.is_ascii_digit()))
}

fn tempo_text(t: &Tempo) -> String {
    match t {
        Tempo::Bpm(n) => js::num_to_string(*n),
        Tempo::Text(s) => s.clone(),
    }
}

fn header_lines(song: &Song, d: &DialectSpec, opts: EmitFanqieOptions) -> Vec<String> {
    let h = &d.header;
    let mut l: Vec<String> = vec![];
    if let Some(vl) = h.version_line {
        l.push(match &song.work.version {
            Some(v) if !v.is_empty() => format!("V:{v}"),
            _ => vl.into(),
        });
    }
    // 曲号：诗歌本按印在标题哪一侧写 `XL:`/`XR:`；番茄没有曲号字段，拼回标题前。ABC 的 `X:` 只是文件里的编号，不写。
    let number = if opts.from_abc { None } else { song.work.number.clone() };
    let in_title = match &number {
        Some(n) if !n.is_empty() && h.index_fields.is_none() => format!("{n} "),
        _ => String::new(),
    };
    if song.work.title.is_some() || !in_title.is_empty() {
        let title: Vec<&str> = split_lines(song.work.title.as_deref().unwrap_or("")).collect();
        l.push(format!("{}:{}{}", h.title_field, in_title, title.join(" ")));
    }
    for st in &song.work.subtitles {
        push_field(&mut l, h.title_field, st);
    }
    let pt = song.page_text.as_ref();
    if let (Some((left_f, right_f)), true) = (h.index_fields, d.emit.page_fields) {
        let left = match pt.and_then(|p| p.index_left.clone()) {
            Some(x) => Some(x),
            None if pt.and_then(|p| p.index_right.as_ref()).is_none() => number.clone(),
            None => None,
        };
        if let Some(x) = left {
            l.push(format!("{left_f}:{x}"));
        }
        if let Some(r) = pt.and_then(|p| p.index_right.as_ref()) {
            l.push(format!("{right_f}:{r}"));
        }
    }
    for c in song.identification.iter().flat_map(|i| i.creators.iter()) {
        push_field(&mut l, h.credit_field, &c.text);
    }
    let key = key_text(song.key.as_ref(), h.key_style);
    let meter = meter_text(song);
    if h.key_meter == KeyMeter::Split {
        // 番茄的 `D:` 只写音名、没有主音唱名：`6=E` 写成 `D:E` 会读成 E 大调，退成同调号的 `1=` 大调名
        let tonic_lost = song.key.as_ref().and_then(|k| k.tonic_degree.as_deref()).is_some_and(|t| t != "1");
        let k = if tonic_lost { key_text(Some(&Key { fifths: song_fifths(song), ..Default::default() }), h.key_style) } else { key };
        l.push(format!("{}:{}", h.key_field.unwrap_or("D"), k));
        if !meter.is_empty() {
            l.push(format!("{}:{}", h.meter_field.unwrap_or("P"), meter));
        }
    } else {
        let tonic = song.key.as_ref().and_then(|k| k.tonic_degree.clone()).unwrap_or_else(|| "1".into());
        let note = song.time_note.as_ref().filter(|t| !t.is_empty()).map(|t| format!(" {t}")).unwrap_or_default();
        let k = if tonic == "6" { key.to_lowercase() } else { key };
        l.push(format!("{tonic}={k}{meter}{}", if meter.is_empty() { "" } else { &note }));
    }
    if song.tempos.as_ref().is_some_and(|t| !t.is_empty()) {
        let ts: Vec<String> = quarter_tempos(song).iter().map(tempo_text).collect();
        l.push(format!("{}:{}", h.tempo_field, ts.join(" ")));
    }
    if d.emit.page_fields {
        let empty: Vec<String> = vec![];
        let get = |f: fn(&PageText) -> &Vec<String>| pt.map_or(&empty, f);
        for (field, arr) in [
            ("TL", get(|p| &p.top_left)),
            ("TR", get(|p| &p.top_right)),
            ("BL", get(|p| &p.bottom_left)),
            ("BC", get(|p| &p.bottom_center)),
            ("BR", get(|p| &p.bottom_right)),
        ] {
            // 空的 `TR:` 也要写：谱本拿空行把右侧的字往下顶
            for t in arr {
                for line in split_lines(t) {
                    l.push(format!("{field}:{}", js::trim(line)));
                }
            }
        }
        for r in song.style.iter().flat_map(|s| s.raw.iter().flatten()) {
            if ["fontsize", "margin", "space", "off"].contains(&r.key.to_ascii_lowercase().as_str()) && r.key.is_ascii() {
                l.push(format!("{}:{}", r.key, r.value));
            }
        }
    }
    for r in song.remarks.iter().flatten() {
        for line in split_lines(r) {
            if is_safe_remark(line) {
                l.push(js::trim(line).into());
            }
        }
    }
    l
}

// ───────────────────────── 音符与记号 ─────────────────────────

/// 文本谱认的记号名。不在表里的不写：写了读回也只是 unknown-command。
fn is_fanqie_command(name: &str) -> bool {
    const OTHER: &[&str] = &[
        "zkh", "ykh", "yc", "ycy", "bc", "zy", "dy", "hx", "shy", "xhy", "sby", "xby", "cy", "tr", "fine", "dc", "ds", "ty", "hs", "sbf",
    ];
    OTHER.contains(&name) || DYNAMIC_NAMES.contains(&name) || TERMS.iter().any(|(k, _)| *k == name)
}

fn command_text(o: &SourceOrnament) -> String {
    format!("&{}{}", o.name, rep("+", o.level.max(0.0)))
}

fn jump_text(name: &str) -> Option<&'static str> {
    match name {
        "fine" => Some("Fine"),
        "dc" => Some("D.C."),
        "ds" => Some("D.S."),
        _ => None,
    }
}

/// 一串记号的写法。诗歌本的 Fine / D.C. / D.S. 写成 `"ff:Fine"`（下方）/ `"ffs:D.C."`（上方），
/// 偏几层写 `+`（三层以上写 `+6`），同位置同层的几个并成一条、`|` 分行；其余照记号 `&xx` 写。
fn commands_text<'a>(os: impl IntoIterator<Item = &'a SourceOrnament>, d: &DialectSpec) -> String {
    let mut s = String::new();
    let mut words: Vec<(String, Vec<&'static str>)> = vec![];
    for o in os {
        let text = if d.jump_words { jump_text(&o.name) } else { None };
        let Some(text) = text else {
            s += &command_text(o);
            continue;
        };
        let lv = o.level.max(0.0);
        let head = format!("ff{}{}", if o.below == Some(true) { "" } else { "s" }, if lv > 2.0 { format!("+{}", js::num_to_string(lv)) } else { rep("+", lv) });
        match words.iter_mut().find(|(h, _)| *h == head) {
            Some((_, list)) => {
                if !list.contains(&text) {
                    list.push(text);
                }
            }
            None => words.push((head, vec![text])),
        }
    }
    for (head, list) in words {
        s += &quoted(&format!("{head}:{}", list.join("|")));
    }
    s
}

/// 元素上的记号：原名优先；没有原名时从 `notations` 反查。
fn ornaments_of(ornaments: Option<&Vec<SourceOrnament>>, notations: Option<&Notations>) -> Vec<SourceOrnament> {
    if let Some(os) = ornaments.filter(|o| !o.is_empty()) {
        return os.iter().filter(|o| is_fanqie_command(&o.name)).cloned().collect();
    }
    let mut out: Vec<SourceOrnament> = vec![];
    let mut add = |name: Option<&str>| {
        if let Some(name) = name {
            if is_fanqie_command(name) && !out.iter().any(|o| o.name == name) {
                out.push(SourceOrnament { name: name.into(), level: 0.0, below: None });
            }
        }
    };
    if let Some(n) = notations {
        if n.fermata == Some(true) {
            add(Some("yc"));
        }
        // 别的来源只有 `notations` 那一侧的名字，按 `deconames` 归一成 `&xx`
        for a in n.articulations.iter().flatten() {
            add(if is_fanqie_command(a) { Some(a) } else { deco_key(a) });
        }
        for o in n.ornaments.iter().flatten() {
            add(if is_fanqie_command(o) { Some(o) } else { deco_key(o) });
        }
    }
    out
}

/// 小节里的 `<direction>` → 挂在第几个元素上的记号。小节线上的 Fine/D.S. 番茄写在本小节最后一个符号后面，诗歌本写成右线上的 `"ff:Fine"`。
fn direction_commands(mea: &Measure, d: &DialectSpec) -> HashMap<usize, Vec<SourceOrnament>> {
    let dm = direction_marks(mea);
    let mut out: HashMap<usize, Vec<SourceOrnament>> = dm.by_element.into_iter().collect();
    if !dm.bar_end.is_empty() && !mea.elements.is_empty() && !d.jump_words {
        out.entry(mea.elements.len() - 1).or_default().extend(dm.bar_end);
    }
    out
}

fn accidental_char(d: &DialectSpec, acc: Option<&Accidental>) -> &'static str {
    let Some(acc) = acc else { return "" };
    if let Some((c, _)) = d.accidentals.iter().find(|(_, sem)| sem == acc) {
        return c;
    }
    // 没有重升重降写法的方言退成单个
    let single = match acc {
        Accidental::DoubleSharp => Some(Accidental::Sharp),
        Accidental::DoubleFlat => Some(Accidental::Flat),
        _ => None,
    };
    single.and_then(|s| d.accidentals.iter().find(|(_, sem)| *sem == s)).map_or("", |(c, _)| c)
}

fn octave_text(d: &DialectSpec, shift: Option<f64>) -> String {
    match shift {
        Some(s) if s != 0.0 && !s.is_nan() => rep(&(if s > 0.0 { d.octave_up } else { d.octave_down }).to_string(), s.abs()),
        _ => String::new(),
    }
}

/// 音符/休止本体（数字、变音、八度；不含时值）
fn head_text(ch: &Chord, d: &DialectSpec, anchored: bool) -> String {
    if ch.rhythm == Some(true) {
        return d.rhythm_token.to_string();
    }
    if let Some(rest) = &ch.rest {
        if ch.print_object == Some(false) {
            return if anchored { "8".into() } else { d.emit.hidden_rest_no_lyric.unwrap_or("0").into() };
        }
        return format!("0{}", octave_text(d, rest.octave_shift));
    }
    let Some(deg) = top_note(ch).and_then(|i| ch.notes[i].degree.as_ref()) else { return "0".into() };
    format!("{}{}{}", js::num_to_string(deg.number), accidental_char(d, deg.accidental.as_ref()), octave_text(d, Some(deg.octave_shift)))
}

fn duration_text(beams: usize, dots: f64) -> String {
    "/".repeat(beams) + &rep(".", dots)
}

/// 倚音串里的一个音。**减时线少写一条**：倚音的基准时值是八分
fn grace_text(ch: &Chord, d: &DialectSpec) -> String {
    const GRACE_LINES: [NoteType; 5] = [NoteType::Quarter, NoteType::Eighth, NoteType::N16th, NoteType::N32nd, NoteType::N64th];
    let lines = match &ch.beams {
        Some(b) => b.len() as isize,
        None => {
            let t = ch.duration.kind.clone().unwrap_or(NoteType::Eighth);
            GRACE_LINES.iter().position(|g| *g == t).map_or(-1, |p| p as isize).max(1)
        }
    };
    head_text(ch, d, false) + &"/".repeat((lines - 1).max(0) as usize)
}

// ───────────────────────── 一行曲 ─────────────────────────

/// 对位格：这个位置跟的是哪几个字
struct Slot<'a> {
    lyrics: Option<&'a Vec<Lyric>>,
}

fn has_text(ls: Option<&Vec<Lyric>>) -> bool {
    ls.is_some_and(|ls| ls.iter().any(|l| !l.text.is_empty() || l.trailing_punctuation.as_deref().is_some_and(|t| !t.is_empty())))
}

/// 文本谱里这个和弦跟不跟词：音符一律跟；休止缺省不跟，`lyricAnchor` 或带着字才跟。
fn chord_anchored(ch: &Chord) -> bool {
    if ch.continued == Some(true) {
        return ch.lyric_anchor.unwrap_or(ch.rest.is_none() || ch.rhythm == Some(true));
    }
    if ch.rest.is_none() || ch.rhythm == Some(true) {
        return true;
    }
    ch.lyric_anchor == Some(true) || has_text(ch.lyrics.as_ref())
}

/// 声部级的写出状态：跨行接着用的都在这儿。
struct PartState {
    d: &'static DialectSpec,
    plan: ArcPlan,
    /// 元素 id → 全声部写出位次
    pos: HashMap<ElementId, usize>,
    /// 已开未收的房号
    open_voltas: usize,
    /// 只罩一小节的不封口房号的收尾 (小节, 小节线)：方言写不出时照封口写
    short_open: HashSet<(usize, usize)>,
    /// 当前生效的拍号
    time: Option<Time>,
    /// 首调号与当前调号的 fifths
    home: f64,
    key: f64,
    /// 是否由写出端补 `~`/`^`
    auto_boundaries: bool,
    /// 已经并到上一小节右线里写掉的左线 (小节, 小节线)
    consumed_left: HashSet<(usize, usize)>,
    /// 没有收尾记号的房号由写出端收口（文本谱读进来的不收）
    close_open_voltas: bool,
    /// 上一行开口收尾的那个小节写到的拍位（续行接着算）
    carry_beat: f64,
    /// 在 `{dsb}`/`{bz}` 层里写
    in_layer: bool,
}

/// 小节线类型（`fromfanqie` 的逆）。只有房号、没有线的返回 None。
fn barline_type(b: &Barline) -> Option<BarlineType> {
    match b.repeat {
        Some(RepeatDir::Backward) => return Some(if b.also_forward == Some(true) { BarlineType::RepeatBoth } else { BarlineType::RepeatEnd }),
        Some(RepeatDir::Forward) => return Some(BarlineType::RepeatStart),
        _ => {}
    }
    Some(match b.style.as_ref()? {
        BarStyle::LightHeavy | BarStyle::HeavyHeavy => BarlineType::End,
        BarStyle::LightLight | BarStyle::HeavyLight => BarlineType::Double,
        BarStyle::NoStyle => {
            if b.no_width == Some(true) {
                BarlineType::Hidden
            } else {
                BarlineType::Invisible
            }
        }
        _ => BarlineType::Normal,
    })
}

/// 小节线类型 → 该方言的写法：方言表按「从长到短」排，反查取**最后**一条匹配（长的是只认不写的规范外写法）
fn barline_code(d: &DialectSpec, t: BarlineType) -> &'static str {
    d.barlines.iter().rev().find(|(_, x)| *x == t).map_or("|", |(c, _)| c)
}

/// 一行里的片段：写出时按方言的 `tokenGap` 连起来。
#[derive(Default)]
struct Line {
    tokens: Vec<String>,
}

impl Line {
    fn push(&mut self, s: String) {
        if !s.is_empty() {
            self.tokens.push(s);
        }
    }
    /// 贴在上一个片段后面（记号、注释、收弧）
    fn glue(&mut self, s: &str) {
        if s.is_empty() {
            return;
        }
        match self.tokens.last_mut() {
            Some(t) => t.push_str(s),
            None => self.tokens.push(s.into()),
        }
    }
    fn is_empty(&self) -> bool {
        self.tokens.is_empty()
    }
}

/// `before` 上的夹层：`~`/`^` 连断、`{bz…}`/`{dsb…}` 临时层。
fn write_inline(items: Option<&Vec<InlineItem>>, line: &mut Line, st: &PartState) {
    for it in items.into_iter().flatten() {
        match it {
            InlineItem::Boundary { behavior, .. } => line.push(if *behavior == BoundaryBehavior::Join { "~" } else { "^" }.into()),
            InlineItem::Layer { role, measures, marks, .. } => {
                // 临时层是一段自带小节与记号的独立元素流：按主旋律的写法写一遍，弧的规划各算各的
                let mut sub = Line::default();
                let mut pos = HashMap::new();
                let mut p = 0;
                for m in measures {
                    for el in &m.elements {
                        pos.insert(el.id(), p);
                        p += 1;
                        if let Element::Chord(c) = el {
                            for su in c.sustains.iter().flatten() {
                                pos.insert(su.id, p);
                                p += 1;
                            }
                        }
                    }
                }
                let mut sub_st = PartState {
                    d: st.d,
                    plan: plan_arcs(marks, &pos),
                    pos,
                    open_voltas: 0,
                    short_open: HashSet::new(),
                    time: st.time.clone(),
                    home: st.home,
                    key: st.key,
                    auto_boundaries: false,
                    consumed_left: HashSet::new(),
                    close_open_voltas: st.close_open_voltas,
                    carry_beat: st.carry_beat,
                    in_layer: true,
                };
                for mi in 0..measures.len() {
                    let mut slots = vec![];
                    write_measure_body(&measures[mi], 0, INF, &mut sub, &mut sub_st, &mut slots, 0.0);
                    write_right_barline(measures, mi, &mut sub, &mut sub_st, true);
                }
                line.push(format!("{{{}{}}}", if *role == LayerRole::Voice { "dsb" } else { "bz" }, sub.tokens.join(" ")));
            }
        }
    }
}

/// 写 `writeTail` 要看的那几样
struct Host<'a> {
    ornaments: Option<&'a Vec<SourceOrnament>>,
    notations: Option<&'a Notations>,
    harmony: Option<&'a Harmony>,
    section_word: Option<&'a str>,
}

/// 一个可跟弧/记号的符号收尾：跟词翻转、记号、注释、收弧、渐强渐弱。
fn write_tail(id: ElementId, host: &Host, line: &mut Line, st: &PartState, at: bool, extra: &[SourceOrnament], quotes: &[String]) {
    if at {
        line.glue("@");
    }
    let os = ornaments_of(host.ornaments, host.notations);
    let cmds = commands_text(os.iter().chain(extra.iter()), st.d);
    line.glue(&cmds);
    if let Some(h) = host.harmony {
        let text = harmony_text(h);
        if !text.is_empty() {
            line.glue(&quoted(&format!("hx:{text}")));
        }
    }
    // 文本谱一个符号只挂一条注释：分行的几条用空格连成一行
    if let Some(sw) = host.section_word.filter(|s| !s.is_empty()) {
        let parts: Vec<&str> = sw.split('\n').filter(|s| !s.is_empty()).collect();
        line.glue(&quoted(&parts.join(" ")));
    }
    for q in quotes {
        line.glue(q);
    }
    for w in st.plan.wedge_start.get(&id).into_iter().flatten() {
        line.glue(w);
    }
    line.glue(&")".repeat(st.plan.closes.get(&id).copied().unwrap_or(0)));
    line.glue(&"!".repeat(st.plan.wedge_end.get(&id).copied().unwrap_or(0)));
}

fn floor(x: f64) -> f64 {
    (x + 1e-9).floor()
}

/// 本小节第 `from`–`to` 个元素（系统切在小节中间时只写一段）。对位格按写出顺序收进 `slots`。
/// `start_beat`：小节开头的拍位（上一行开口收尾的小节在这一行接着写时接着算）。回写到的末尾拍位
fn write_measure_body<'a>(mea: &'a Measure, from: usize, to: usize, line: &mut Line, st: &mut PartState, slots: &mut Vec<Slot<'a>>, start_beat: f64) -> f64 {
    let d = st.d;
    let dirs = direction_commands(mea, d);
    let mids: Vec<&Barline> = mea.barlines.iter().flatten().filter(|b| b.location == BarLocation::Middle).collect();
    let mut mid_idx = 0;
    // 等着挂到下一个音上的前倚音、`y` 占位上的和弦
    let mut pending_grace: Vec<&Chord> = vec![];
    let mut pending_harmony: Option<&Harmony> = None;
    // 上一个写出的主音：后倚音 `"hyy:…"` 挂它
    let mut last_main: Option<usize> = None;
    let mut beat = start_beat;
    let mut prev: Option<(usize, f64)> = None;
    let mut syncopated = false;
    let group_beats = match &st.time {
        Some(t) if t.beat_type == 8.0 && t.beats % 3.0 == 0.0 => 1.5,
        _ => 1.0,
    };
    let empty: Vec<SourceOrnament> = vec![];

    for (j, el) in mea.elements.iter().enumerate() {
        let dur = match el {
            Element::Chord(c) => c.duration.divisions,
            Element::Space(s) => s.duration.as_ref().map_or(0.0, |d| d.divisions),
        } / SIMPLE_DIVISIONS;
        if j < from || j >= to {
            if let Element::Chord(c) = el {
                if c.grace.is_none() {
                    beat += dur;
                }
            }
            continue;
        }
        while mid_idx < mids.len() && mids[mid_idx].after_elements.unwrap_or(0.0) <= j as f64 {
            if let Some(t) = barline_type(mids[mid_idx]) {
                line.push(barline_code(d, t).into());
            }
            mid_idx += 1;
        }
        if let Element::Chord(c) = el {
            if let Some(g) = &c.grace {
                if g.after == Some(true) {
                    if let Some(lm) = last_main {
                        line.tokens[lm] += &quoted(&format!("hyy:{}", grace_text(c, d)));
                    }
                } else {
                    pending_grace.push(c);
                }
                continue;
            }
        }
        if let Element::Space(s) = el {
            if s.spacer == Spacer::Y {
                if pending_harmony.is_none() {
                    pending_harmony = s.harmony.as_ref();
                }
                continue;
            }
        }
        if !is_stream_element(el, mea) {
            continue;
        }
        let p = st.pos.get(&el.id()).copied();
        let beams = match el {
            Element::Chord(c) => c.beams.as_ref().map_or(0, |b| b.len()),
            Element::Space(s) => s.beams.as_ref().map_or(0, |b| b.len()),
        };

        if let Element::Chord(c) = el {
            write_inline(c.before.as_ref(), line, st);
        }
        // 自动补的连断：两边都带减时线才有线可连断
        if let Some((pb, pbeat)) = prev {
            if st.auto_boundaries && !d.emit.no_auto_boundary && pb > 0 && beams > 0 && !p.is_some_and(|p| st.plan.in_tuplet.contains(&p)) {
                let same_beat = floor(pbeat) == floor(beat);
                if group_beats != 1.0 {
                    let g = floor(beat / group_beats);
                    if floor(pbeat / group_beats) != g {
                        if same_beat {
                            line.push("^".into());
                        }
                    } else if floor(pbeat - g * group_beats) != floor(beat - g * group_beats) {
                        line.push("~".into());
                    }
                } else if syncopated && pb != beams && !same_beat {
                    line.push("^".into());
                }
            }
        }
        prev = Some((beams, beat));
        let end = beat + dur;
        if beat % 1.0 != 0.0 && floor(beat) != (end - 1e-9).floor() {
            syncopated = true;
        }
        beat = end;

        let opens: String = st.plan.opens.get(&el.id()).map(|v| v.concat()).unwrap_or_default();
        let extra = dirs.get(&j).unwrap_or(&empty);
        let ch = match el {
            Element::Space(s) => {
                // 不可见休止 `x`：文本谱的隐藏休止 `8` 跟词
                line.push(format!("{opens}8{}", duration_text(beams, s.duration.as_ref().map_or(0.0, |d| d.dots))));
                slots.push(Slot { lyrics: s.lyrics.as_ref() });
                let host = Host { ornaments: None, notations: s.notations.as_ref(), harmony: s.harmony.as_ref().or(pending_harmony), section_word: None };
                write_tail(s.id, &host, line, st, false, extra, &[]);
                pending_harmony = None;
                continue;
            }
            Element::Chord(c) => c,
        };
        let anchored = chord_anchored(ch);
        let grace_quote: Vec<String> = if pending_grace.is_empty() {
            vec![]
        } else {
            let gs: Vec<String> = pending_grace.iter().map(|g| grace_text(g, d)).collect();
            vec![quoted(&format!("yy:{}", gs.join(" ")))]
        };
        pending_grace.clear();
        // 收弧的 `)` 紧跟音符**本体**，附点写在括号外（`(1.1).`）
        let tail_dots = if st.plan.closes.get(&ch.id).copied().unwrap_or(0) > 0 { ch.duration.dots } else { 0.0 };
        if ch.continued == Some(true) {
            // 承接前音的延长：行首/小节线后的 `-`
            line.push(format!("{opens}-"));
        } else {
            line.push(format!("{opens}{}{}", head_text(ch, d, anchored || st.in_layer), duration_text(beams, ch.duration.dots - tail_dots)));
        }
        last_main = Some(line.tokens.len() - 1);
        if anchored {
            slots.push(Slot { lyrics: ch.lyrics.as_ref() });
        }
        // `@` 翻的是缺省：休止与承接的 `-` 缺省不跟词
        let at = anchored && (ch.continued == Some(true) || (ch.rest.is_some() && ch.rhythm != Some(true) && ch.print_object != Some(false)));
        let host = Host {
            ornaments: ch.ornaments.as_ref(),
            notations: ch.notations.as_ref(),
            harmony: ch.harmony.as_ref().or(pending_harmony),
            section_word: ch.section_word.as_deref(),
        };
        pending_harmony = None;
        write_tail(ch.id, &host, line, st, at, extra, &grace_quote);
        line.glue(&rep(".", tail_dots));
        for su in ch.sustains.iter().flatten() {
            write_sustain(su, line, st, slots);
        }
    }
    // 小节末没等到主音的前倚音：挂到最后一个主音后面当后倚音，别丢
    if let (false, Some(lm)) = (pending_grace.is_empty(), last_main) {
        let gs: Vec<String> = pending_grace.iter().map(|g| grace_text(g, d)).collect();
        line.tokens[lm] += &quoted(&format!("hyy:{}", gs.join(" ")));
    }
    if to >= mea.elements.len() {
        while mid_idx < mids.len() {
            if let Some(t) = barline_type(mids[mid_idx]) {
                line.push(barline_code(d, t).into());
            }
            mid_idx += 1;
        }
        write_inline(mea.trailing.as_ref(), line, st);
    }
    beat
}

fn write_sustain<'a>(su: &'a Sustain, line: &mut Line, st: &PartState, slots: &mut Vec<Slot<'a>>) {
    write_inline(su.before.as_ref(), line, st);
    line.push(st.plan.opens.get(&su.id).map(|v| v.concat()).unwrap_or_default() + "-");
    let anchored = su.lyric_anchor == Some(true) || has_text(su.lyrics.as_ref());
    if anchored {
        slots.push(Slot { lyrics: su.lyrics.as_ref() });
    }
    let host = Host { ornaments: su.ornaments.as_ref(), notations: su.notations.as_ref(), harmony: su.harmony.as_ref(), section_word: su.section_word.as_deref() };
    write_tail(su.id, &host, line, st, anchored, &[], &[]);
}

/// 房号起头的写法：`["1."`（`+` 抬高）
fn volta_open_text(e: &Ending) -> String {
    let mut s = "[".to_string() + &rep("+", e.level.unwrap_or(0.0));
    if e.captionless != Some(true) {
        let t = e.text.clone().unwrap_or_else(|| e.numbers.iter().map(|n| js::num_to_string(*n)).collect::<Vec<_>>().join(","));
        s += &quoted(&t);
    }
    s
}

/// 本小节的左线（只有房号的不算线）与房号起头。左线已并进上一小节右线的就不再写。
fn write_left(mea: &Measure, mi: usize, line: &mut Line, st: &mut PartState) {
    let lefts: Vec<(usize, &Barline)> = mea.barlines.iter().flatten().enumerate().filter(|(_, b)| b.location == BarLocation::Left).collect();
    for &(bi, b) in &lefts {
        if st.consumed_left.contains(&(mi, bi)) {
            continue;
        }
        let t = barline_type(b);
        let orns = commands_text(b.ornaments.iter().flatten(), st.d);
        if let Some(t) = t {
            write_inline(b.before.as_ref(), line, st);
            line.push(barline_code(st.d, t).to_string() + &orns);
        } else if !orns.is_empty() {
            // 只挂着跳转记号的左线：挂到上一根线上；行首没有线可挂就补一条虚拟线立住它
            if line.is_empty() {
                line.push(barline_code(st.d, BarlineType::Hidden).to_string() + &orns);
            } else {
                line.glue(&orns);
            }
        }
    }
    for &(_, b) in &lefts {
        let Some(e) = &b.ending else { continue };
        if e.kind != EndingType::Start || e.collapsed == Some(true) || e.dangling_lead == Some(true) {
            continue;
        }
        // 新房号起头就是上一个房号的尽头：先收掉，别叠成嵌套
        close_voltas(line, st);
        if st.d.emit.volta_lead_barline && line.is_empty() {
            line.push(barline_code(st.d, BarlineType::Hidden).into());
        }
        line.push(volta_open_text(e));
        st.open_voltas += 1;
    }
}

/// 收掉所有开着的房号。番茄的 `]` 写在线**前**，诗歌本写在线后。
fn close_voltas(line: &mut Line, st: &mut PartState) {
    if st.open_voltas == 0 || !st.close_open_voltas {
        return;
    }
    let text = "]".repeat(st.open_voltas);
    st.open_voltas = 0;
    if st.d.emit.volta_close_after_barline {
        line.glue(&text);
        return;
    }
    match line.tokens.last() {
        Some(t) if t.starts_with('|') || t.starts_with(':') => {
            let at = line.tokens.len() - 1;
            line.tokens.insert(at, text);
        }
        _ => line.push(text),
    }
}

/// 第 `mi` 小节的右线。文本谱没有左线：下一小节的 `|:` 并到这里写（`:|` + `|:` = `:|:`）。
/// `line_end`：这是本行最后一小节——没有右线时就开口收尾，接下一行。回是否开口收尾（没写线）
fn write_right_barline(measures: &[Measure], mi: usize, line: &mut Line, st: &mut PartState, line_end: bool) -> bool {
    let d = st.d;
    let mea = &measures[mi];
    let rights: Vec<(usize, &Barline)> = mea.barlines.iter().flatten().enumerate().filter(|(_, b)| b.location == BarLocation::Right).collect();
    let bar = rights.iter().map(|&(_, b)| b).find(|b| barline_type(b).is_some());
    let next = measures.get(mi + 1);
    // 文本谱原文行首写出的左线（带 `source`）在换行处不并：留给下一行的 `write_left` 原位写
    let next_left = next.and_then(|n| {
        n.barlines.iter().flatten().enumerate().find(|(_, b)| b.location == BarLocation::Left && barline_type(b).is_some() && !(line_end && b.source.is_some()))
    });
    let mut kind = bar.and_then(barline_type);
    // MusicXML 等来源挂在小节末的 Fine / D.C. / D.S.：诗歌本写成小节线文字，挂到这根右线上
    let bar_end = if d.jump_words { direction_marks(mea).bar_end } else { vec![] };
    if let Some((nbi, nl)) = next_left {
        let lt = barline_type(nl).unwrap();
        if lt == BarlineType::RepeatStart {
            kind = Some(if matches!(kind, Some(BarlineType::RepeatEnd | BarlineType::RepeatBoth)) { BarlineType::RepeatBoth } else { BarlineType::RepeatStart });
        } else if kind.is_none() || kind == Some(BarlineType::Normal) {
            kind = Some(lt);
        }
        st.consumed_left.insert((mi + 1, nbi));
    }
    // 房号收尾：番茄写在线前（`3 ] |`），诗歌本写在线后（`3|]`）
    let mut close_text = String::new();
    for &(bi, b) in &rights {
        let Some(e) = &b.ending else { continue };
        if e.kind != EndingType::Stop && e.kind != EndingType::Discontinue {
            continue;
        }
        if st.open_voltas == 0 {
            break;
        }
        st.open_voltas -= 1;
        close_text += "]";
        if e.kind == EndingType::Discontinue && !st.short_open.contains(&(mi, bi)) {
            close_text += "/";
        }
    }
    if !close_text.is_empty() && !d.emit.volta_close_after_barline {
        line.push(std::mem::take(&mut close_text));
    }
    // 曲中转拍：`"p:3/4"` 写在线后面，自下一小节起生效
    let next_time = next.and_then(|n| n.attrs.as_ref()).and_then(|a| a.time.as_ref());
    let meter = bar.and_then(|b| b.time.as_ref()).or(next_time.filter(|nt| st.time.as_ref().is_none_or(|t| nt.beats != t.beats || nt.beat_type != t.beat_type)));
    if kind.is_none() && !line_end && next.is_some() {
        kind = Some(BarlineType::Normal);
    }
    // 曲中转调：`"k:2"` 同样写在线后面，线上的注记并进去当转调标签
    let next_key = next.and_then(|n| n.attrs.as_ref()).and_then(|a| a.key.as_ref());
    let key_code = next_key.filter(|k| k.fifths != st.key).map(|k| format!("k:{}", degree_of_key(st.home, k.fifths)));
    if kind.is_none() && (meter.is_some() || key_code.is_some()) {
        kind = Some(BarlineType::Hidden);
    }
    if let Some(t) = kind {
        if let Some(b) = bar {
            write_inline(b.before.as_ref(), line, st);
        }
        let mut s = barline_code(d, t).to_string();
        s += &close_text;
        let orns = bar.and_then(|b| b.ornaments.as_ref()).into_iter().flatten().chain(next_left.and_then(|(_, b)| b.ornaments.as_ref()).into_iter().flatten()).chain(bar_end.iter());
        s += &commands_text(orns, d);
        if let Some(m) = meter {
            s += &quoted(&format!("p:{}/{}", js::num_to_string(m.beats), js::num_to_string(m.beat_type)));
        }
        let ann = bar.and_then(|b| b.annotation.as_deref());
        if let Some(kc) = &key_code {
            s += &quoted(&match ann {
                Some(a) if !a.is_empty() => format!("{kc};{a}"),
                _ => kc.clone(),
            });
        } else if let Some(a) = ann.filter(|a| !a.is_empty()) {
            s += &quoted(a);
        }
        line.push(s);
    } else {
        // 行末开口收尾没有线可挂：跟在本小节最后一个符号后面
        line.glue(&close_text);
        line.glue(&commands_text(bar_end.iter(), d));
    }
    if let Some(nt) = next_time {
        st.time = Some(nt.clone());
    }
    if let Some(nk) = next_key {
        st.key = nk.fifths;
    }
    // 曲末还开着的房号：就地收口，免得一直开到下一首
    if next.is_none() {
        close_voltas(line, st);
    }
    kind.is_none()
}

// ───────────────────────── 歌词行 ─────────────────────────

/// `/^[぀-ヿ㐀-鿿豈-﫿]$/u`
fn is_cjk_one(s: &str) -> bool {
    let mut c = s.chars();
    match (c.next(), c.next()) {
        (Some(x), None) => matches!(x as u32, 0x3040..=0x30FF | 0x3400..=0x9FFF | 0xF900..=0xFAFF),
        _ => false,
    }
}

/// 读入端会贴回前一字、不占音符位的收尾字符
fn trailing_ok(c: char) -> bool {
    super::parse::LYRIC_PUNCTUATION.contains(c) || "”’\"）)".contains(c)
}

/// 一个音节 → 文本谱写法。只有「单个汉字」（可带左引号）与「纯 ASCII 单词」能裸写；其余一律用 `{}` 裹住。尾部标点写在括号外。
fn lyric_token(l: &Lyric) -> String {
    let mut core: String = (l.leading_punctuation.clone().unwrap_or_default() + &l.text).chars().filter(|&c| c != '{' && c != '}').collect();
    let mut tail = l.trailing_punctuation.clone().unwrap_or_default();
    if tail.chars().any(|c| !trailing_ok(c)) {
        core += &tail;
        tail.clear();
    }
    // 字里连着的收尾标点也拆到括号外（`core.length > 1` 按 UTF-16 码元数）
    while core.encode_utf16().count() > 1 {
        let last = core.chars().last().unwrap();
        if (last as u32) > 0xFFFF || !trailing_ok(last) {
            break;
        }
        core.pop();
        tail.insert(0, last);
    }
    if core.is_empty() {
        return if tail.is_empty() { String::new() } else { format!("{{{tail}}}") };
    }
    let ascii_word = core.chars().all(|c| c.is_ascii_alphabetic() || c == '\'');
    // 左引号、左括号领起的单个汉字，左引号领起的英文单词，也裸写（解析时左引号、左括号领起后一个音节；用户反馈「{“我}」不要括号）
    let lead = core.chars().next().unwrap();
    let rest = &core[lead.len_utf8()..];
    let rest_word = !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphabetic() || c == '\'') && rest.starts_with(|c: char| c.is_ascii_alphabetic());
    let quote_one = ("“‘\"".contains(lead) && (is_cjk_one(rest) || rest_word)) || ("(（".contains(lead) && is_cjk_one(rest));
    let plain = is_cjk_one(&core) || ascii_word || quote_one;
    (if plain { core } else { format!("{{{core}}}") }) + &tail
}

/// 一行歌词的版式
#[derive(Clone)]
struct LyricSpec {
    from: f64,
    to: f64,
    label: Option<String>,
    gap: f64,
    join_brace: bool,
    /// 同一段号在本行出现多行时，这是第几行
    line_index: Option<f64>,
    /// 别的来源同一格同一段挂了几个字：这一行取第几个
    nth: usize,
}

fn spec_hit<'a>(s: &Slot<'a>, spec: &LyricSpec) -> Option<&'a Lyric> {
    s.lyrics?
        .iter()
        .filter(|l| {
            l.number == spec.from && l.number_to.unwrap_or(l.number) == spec.to && (spec.line_index.is_none() || l.line_index.is_none() || l.line_index == spec.line_index)
        })
        .nth(spec.nth)
}

/// 本行要写哪几行歌词：文本谱读进来的按原来的行版式（`Print.lyricLines`）；别的来源按字上的段号归行。
fn lyric_specs(slots: &[Slot], infos: Option<&Vec<LyricLineInfo>>) -> Vec<LyricSpec> {
    if let Some(infos) = infos.filter(|i| !i.is_empty()) {
        let key = |i: &LyricLineInfo| (i.verse_from.to_bits(), i.verse_to.to_bits());
        return infos
            .iter()
            .enumerate()
            .map(|(idx, i)| LyricSpec {
                from: i.verse_from,
                to: i.verse_to,
                label: i.annotation.clone(),
                gap: i.annotation_gap,
                join_brace: i.join_brace == Some(true),
                line_index: if infos.iter().filter(|x| key(x) == key(i)).count() > 1 { Some(idx as f64) } else { None },
                nth: 0,
            })
            .collect();
    }
    let mut specs: Vec<((u64, u64, usize), LyricSpec)> = vec![];
    for s in slots {
        let mut seen: Vec<((u64, u64), usize)> = vec![];
        for l in s.lyrics.into_iter().flatten() {
            if l.text.is_empty() && l.trailing_punctuation.as_deref().is_none_or(str::is_empty) {
                continue;
            }
            let to = l.number_to.unwrap_or(l.number);
            let range = (l.number.to_bits(), to.to_bits());
            let nth = match seen.iter_mut().find(|(r, _)| *r == range) {
                Some((_, n)) => {
                    *n += 1;
                    *n - 1
                }
                None => {
                    seen.push((range, 1));
                    0
                }
            };
            let k = (range.0, range.1, nth);
            let spec = match specs.iter_mut().find(|(kk, _)| *kk == k) {
                Some((_, sp)) => sp,
                None => {
                    specs.push((k, LyricSpec { from: l.number, to, label: None, gap: 20.0, join_brace: false, line_index: None, nth }));
                    &mut specs.last_mut().unwrap().1
                }
            };
            if spec.label.is_none() {
                if let Some(v) = &l.verse_label {
                    spec.label = Some(v.clone());
                }
            }
        }
    }
    let mut out: Vec<LyricSpec> = specs.into_iter().map(|(_, s)| s).collect();
    out.sort_by(|a, b| {
        js::ordering(if a.from - b.from != 0.0 {
            a.from - b.from
        } else if a.to - b.to != 0.0 {
            a.to - b.to
        } else {
            a.nth as f64 - b.nth as f64
        })
    });
    out
}

/// 这一行歌词的字
fn spec_texts(slots: &[Slot], spec: &LyricSpec) -> String {
    slots.iter().filter_map(|s| spec_hit(s, spec)).filter(|l| !l.text.is_empty()).map(|l| l.text.as_str()).collect()
}

/// 中英对照：第 1 段是汉字，后面依次是第 2、3… 段、字全是拉丁字母（译词），且都不带印刷段号与区间。
fn is_translation_set(slots: &[Slot], specs: &[LyricSpec]) -> bool {
    if specs.len() < 2 {
        return false;
    }
    if specs.iter().enumerate().any(|(i, s)| s.from != (i + 1) as f64 || s.to != s.from || s.label.is_some() || s.nth != 0 || s.line_index.is_some()) {
        return false;
    }
    let texts: Vec<String> = specs.iter().map(|s| spec_texts(slots, s)).collect();
    has_han(&texts[0]) && texts[1..].iter().all(|t| has_latin(t) && !has_han(t))
}

/// 逐段中英交替：第 1、3、5… 段是汉字，第 2、4、6… 段字全是拉丁字母（前一段的英译）
fn is_bilingual_pairs(slots: &[Slot], specs: &[LyricSpec]) -> bool {
    if specs.len() < 4 || !specs.len().is_multiple_of(2) {
        return false;
    }
    if specs.iter().enumerate().any(|(i, s)| s.from != (i + 1) as f64 || s.to != s.from || s.nth != 0 || s.line_index.is_some()) {
        return false;
    }
    specs.iter().enumerate().all(|(i, s)| {
        let t = spec_texts(slots, s);
        if i % 2 == 0 {
            has_han(&t)
        } else {
            has_latin(&t) && !has_han(&t)
        }
    })
}

/// 带段号的行下面跟着不带段号的续行（青年诗歌 178「1./无/2./无」、204「一/无/二/无」：同一段反复时第二遍唱的词印在下一行）：
/// 续行跟上一个带段号的行同号（用户定 `C1 C1 C2 C2`）。回 段号 → (写出的号, 管它的那行的段号)；不是这种排法回空。
/// 只认整齐的排法：至少两个带段号的行，各带同样多（≥1）的续行。只用在行数相同的系统上。
fn continuation_verses(part: &Part) -> HashMap<u64, (f64, f64)> {
    let mut labeled: Vec<(f64, bool)> = vec![];
    for m in &part.measures {
        for el in &m.elements {
            let ls = match el {
                Element::Chord(c) => c.lyrics.as_ref(),
                Element::Space(s) => s.lyrics.as_ref(),
            };
            for l in ls.into_iter().flatten() {
                if l.number_to.is_some_and(|t| t != l.number) {
                    return HashMap::new();
                }
                let has = l.verse_label.as_deref().is_some_and(|v| !v.is_empty());
                match labeled.iter_mut().find(|(n, _)| *n == l.number) {
                    Some((_, h)) => *h |= has,
                    None => labeled.push((l.number, has)),
                }
            }
        }
    }
    labeled.sort_by(|a, b| js::ordering(a.0 - b.0));
    let heads = labeled.iter().filter(|(_, h)| *h).count();
    if heads < 2 || heads == labeled.len() || !labeled[0].1 || !labeled.len().is_multiple_of(heads) {
        return HashMap::new();
    }
    let k = labeled.len() / heads;
    if labeled.iter().enumerate().any(|(i, (_, h))| *h != i.is_multiple_of(k)) {
        return HashMap::new();
    }
    labeled.iter().enumerate().map(|(i, (n, _))| (n.to_bits(), ((i / k + 1) as f64, labeled[i - i % k].0))).collect()
}

/// `bare`：写不带段号的 `C:`；`as_num`：照这个段号写（中英两两同号）
fn lyric_line(slots: &[Slot], spec: &LyricSpec, bare: bool, d: &DialectSpec, as_num: Option<f64>) -> Option<String> {
    let skip = d.lyric_skip.first().copied().unwrap_or('@').to_string();
    let mut pieces: Vec<String> = vec![];
    let mut pending_skips = 0;
    let mut any = false;
    let mut prev = String::new();
    for s in slots {
        let tok = spec_hit(s, spec).map(lyric_token).unwrap_or_default();
        if tok.is_empty() {
            pending_skips += 1;
            continue;
        }
        // 空位先攒着，后面真有字了再落下去（行尾的空位不必写）
        if pending_skips > 0 {
            pieces.push(skip.repeat(pending_skips));
            prev = skip.clone();
            pending_skips = 0;
        }
        // ASCII 单词紧挨着会被并成一个音节；英文词尾带半角标点的也隔开（`/[A-Za-z'][,.;:!?]*$/` 与 `/^[A-Za-z']/`）
        let prev_word = prev.trim_end_matches([',', '.', ';', ':', '!', '?']).chars().last().is_some_and(|c| c.is_ascii_alphabetic() || c == '\'');
        let tok_word = tok.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '\'');
        if prev_word && tok_word {
            pieces.push(d.word_separator.to_string());
        }
        pieces.push(tok.clone());
        prev = tok;
        any = true;
    }
    if !any {
        return None;
    }
    let mut body = pieces.concat();
    // 行末的 `}` 会被读成联合括号：真要的照写，不要的补一个跳字符隔开
    if spec.join_brace {
        body.push('}');
    } else if body.ends_with('}') {
        body += &skip;
    }
    let num = if bare {
        String::new()
    } else if let Some(a) = as_num {
        js::num_to_string(a)
    } else if spec.to != spec.from {
        format!("{}-{}", js::num_to_string(spec.from), js::num_to_string(spec.to))
    } else {
        js::num_to_string(spec.from)
    };
    let mut label = String::new();
    if let Some(lb) = &spec.label {
        let (open, close) = d.emit.label_wrap;
        let enc: String = lb.replace(' ', "_").replace('@', "%40").chars().filter(|c| !"\"<>".contains(*c)).collect();
        let gap = if spec.gap != 20.0 { format!("%{}", js::num_to_string(spec.gap)) } else { String::new() };
        label = format!("{open}{enc}{gap}{close}");
    }
    Some(format!("C{num}:{label}{body}"))
}

// ───────────────────────── 整首 ─────────────────────────

/// 兜底断行：按乐句断不出来时每几小节一行
const FALLBACK_MEASURES_PER_LINE: usize = 4;

fn has_breaks(s: &Song) -> bool {
    let p = &s.parts[0];
    p.measures.iter().enumerate().any(|(i, m)| i > 0 && m.print.as_ref().is_some_and(|pr| pr.new_system == Some(true) || pr.new_page == Some(true)))
        || p.measures.iter().any(|m| m.elements.iter().any(|el| matches!(el, Element::Chord(c) if c.line_break_after.is_some())))
}

/// 模型里没有任何行结构的曲子：先按乐句断行（文本谱一行 `Q:` 就是谱面一行、不自动断行）；断不出来的每 4 小节断一行。
fn with_lines(song: Song) -> Song {
    let Some(part) = song.parts.first() else { return song };
    if part.measures.len() <= 8 || has_breaks(&song) {
        return song;
    }
    let mut phrased = song;
    let mut changed = false;
    if let Some(cuts) = phrase_cuts(&phrased).filter(|c| !c.is_empty()) {
        let starts: Vec<LineStart> = cuts.into_iter().flatten().map(|id| LineStart { id, page: false }).collect();
        changed = apply_breaks(&mut phrased, &starts, &ApplyBreaksOptions { mid_in_any_part: false, mid: MidMode::Snap, pages: PageMode::Keep });
    }
    if changed && has_breaks(&phrased) {
        return phrased;
    }
    for p in &mut phrased.parts {
        for (i, m) in p.measures.iter_mut().enumerate() {
            if i > 0 && i % FALLBACK_MEASURES_PER_LINE == 0 {
                m.print.get_or_insert_with(Default::default).new_system = Some(true);
            }
        }
    }
    phrased
}

/// 第二声部 → `{dsb}` 层，连续段在换行处断开（一个 `{dsb…}` 不跨行）
fn with_inner_layers(song: Song) -> Song {
    let out = voices_to_layers(&song, |pi, i| {
        let ms = &song.parts[pi].measures;
        ms.get(i + 1).and_then(|n| n.print.as_ref()).is_some_and(|p| p.new_system == Some(true) || p.new_page == Some(true))
            || ms[i].elements.iter().any(|el| matches!(el, Element::Chord(c) if c.line_break_after.is_some()))
    });
    match out {
        std::borrow::Cow::Borrowed(_) => song,
        std::borrow::Cow::Owned(s) => s,
    }
}

/// 简谱形状的歌：音高要有度数。MusicXML 来的只有绝对音高时补上
fn with_degrees(mut song: Song) -> Song {
    let missing = song.parts.iter().any(|p| p.measures.iter().any(|m| m.elements.iter().any(|el| matches!(el, Element::Chord(c) if c.notes.iter().any(|n| n.pitch.is_some() && n.degree.is_none())))));
    if missing {
        fill_degrees_from_pitch(&mut song);
    }
    song
}

/// 声部行首：`Q` + 变体 + 声部号 + 声部名 + `:`
fn q_prefix(song: &Song, pi: usize, first: Option<&Measure>, first_system: bool, d: &DialectSpec, solo: bool) -> String {
    let (open, close) = d.emit.label_wrap;
    let print = first.and_then(|m| m.print.as_ref());
    let caption = print.and_then(|p| p.caption.clone()).or_else(|| if first_system { song.parts.get(pi).and_then(|p| p.name.clone()) } else { None });
    let num = if song.parts.len() > 1 && !solo { (pi + 1).to_string() } else { String::new() };
    let cap = match caption.filter(|c| !c.is_empty()) {
        Some(c) => {
            // 声部名里的换行写成空格（`/\s*\n\s*/g`）
            let c: String = c.chars().filter(|ch| !"\"<>".contains(*ch)).collect();
            let joined = c.split('\n').map(|seg| seg.trim_matches(js::is_space)).collect::<Vec<_>>();
            let mut s = String::new();
            for (k, seg) in c.split('\n').enumerate() {
                let mut seg = seg;
                if k > 0 {
                    seg = seg.trim_start_matches(js::is_space);
                }
                if k + 1 < joined.len() {
                    seg = seg.trim_end_matches(js::is_space);
                }
                if k > 0 {
                    s.push(' ');
                }
                s += seg;
            }
            format!("{open}{s}{close}")
        }
        None => String::new(),
    };
    let variant = print.and_then(|p| p.variant.as_ref()).map_or("", |v| v.as_str());
    format!("Q{variant}{num}{cap}:")
}

fn range_skipped(sys: &SystemRange, len: usize) -> bool {
    len == 0 || sys.from > sys.to.min(len - 1)
}

/// 一首歌 → 文本谱原文（不带结尾换行）。
pub fn emit_fanqie_song(src: &Song, dialect: Dialect, opts: EmitFanqieOptions) -> String {
    let d = dialect.spec();
    // 小节里的 `<direction>` 先换成简谱那套挂在符号上的写法；同一谱表的第二声部写成 `{dsb…}` 并排块，按行断开
    let projected = project_for_jianpu(&directions_as_marks(src)).into_owned();
    let song = with_degrees(with_inner_layers(with_lines(projected)));
    let mut l = header_lines(&song, d, opts);
    if d.emit.blank_between_groups {
        l.push(String::new());
    }

    // 原文就有连断记号的（文本谱读进来的）照原样写；别的来源由写出端按拍补
    let has_boundaries = song.parts.iter().any(|p| {
        p.measures.iter().any(|m| m.elements.iter().any(|el| matches!(el, Element::Chord(c) if c.before.iter().flatten().any(|it| matches!(it, InlineItem::Boundary { .. })))))
    });
    let home = if song.key.is_some() {
        song_fifths(&song)
    } else {
        song.parts.first().and_then(|p| p.measures.first()).and_then(|m| m.attrs.as_ref()).and_then(|a| a.key.as_ref()).map_or(0.0, |k| k.fifths)
    };
    let mut states: Vec<PartState> = song
        .parts
        .iter()
        .map(|part| {
            let own = own_ids(part, |el, mi| is_stream_element(el, &part.measures[mi]));
            let pos = positions(part);
            PartState {
                d,
                plan: plan_arcs(&writable_marks(&song, part, &own).0, &pos),
                pos,
                open_voltas: 0,
                short_open: if d.open_volta_needs_two_measures { short_open_voltas(part) } else { HashSet::new() },
                time: song.time.clone(),
                home,
                key: home,
                auto_boundaries: !has_boundaries,
                consumed_left: HashSet::new(),
                close_open_voltas: !opts.from_fanqie,
                carry_beat: 0.0,
                in_layer: false,
            }
        })
        .collect();

    let ranges = system_ranges(song.parts.first());
    // 别的声部的小节中间切点按拍位对到第一声部的切点上；按组排的按共用时间轴对齐，缺席的组不写
    let axis = axis_of_song(&song);
    let pranges: Vec<Vec<SystemRange>> = song
        .parts
        .iter()
        .enumerate()
        .map(|(pi, part)| {
            if pi == 0 {
                ranges.clone()
            } else if axis.grouped {
                part_ranges_on_axis(&ranges, &song.parts[0], part, &axis.slot[0], &axis.slot[pi])
            } else {
                part_ranges(&ranges, &song.parts[0], part, false)
            }
        })
        .collect();
    let conts: Vec<Option<HashMap<u64, (f64, f64)>>> = song.parts.iter().map(|p| Some(continuation_verses(p)).filter(|m| !m.is_empty())).collect();
    for ri in 0..ranges.len() {
        let mut group: Vec<String> = vec![];
        // 这一组只有第一声部：写 `Q:`，同原文
        let solo = song.parts.len() > 1 && pranges.iter().enumerate().all(|(pi, pr)| pi == 0 || range_skipped(&pr[ri], song.parts[pi].measures.len()));
        for (pi, part) in song.parts.iter().enumerate() {
            let sys = &pranges[pi][ri];
            let st = &mut states[pi];
            if range_skipped(sys, part.measures.len()) {
                continue;
            }
            let last = sys.to.min(part.measures.len() - 1);
            let first = part.measures.get(sys.from);
            // 换页：小节级的看本行首小节，小节中间的看上一行末那刀
            if pi == 0 && ri > 0 {
                let page = if sys.from_el == 0 {
                    first.and_then(|m| m.print.as_ref()).is_some_and(|p| p.new_page == Some(true))
                } else {
                    ranges[ri - 1].inline == Some(BreakKind::Page)
                };
                if page {
                    group.push("[fenye]".into());
                }
            }
            // 系统上方的说明文字行（`W:`）挂在该系统第一个声部的首小节
            if pi == 0 && sys.from_el == 0 {
                for t in first.and_then(|m| m.print.as_ref()).and_then(|p| p.texts.as_ref()).into_iter().flatten() {
                    push_field(&mut group, "W", t);
                }
            }
            let mut line = Line::default();
            let mut slots: Vec<Slot> = vec![];
            for mi in sys.from..=last {
                let mea = &part.measures[mi];
                let from_el = if mi == sys.from { sys.from_el } else { 0 };
                let to_el = if mi == sys.to { sys.to_el } else { INF };
                if from_el == 0 {
                    write_left(mea, mi, &mut line, st);
                }
                let start = if from_el == 0 { st.carry_beat } else { 0.0 };
                let end = write_measure_body(mea, from_el, to_el, &mut line, st, &mut slots, start);
                st.carry_beat = 0.0;
                if to_el >= mea.elements.len() && write_right_barline(&part.measures, mi, &mut line, st, mi == last) {
                    st.carry_beat = end;
                }
            }
            if line.is_empty() {
                continue;
            }
            group.push(q_prefix(&song, pi, first, ri == 0, d, solo) + &line.tokens.join(d.emit.token_gap));
            let infos = if sys.from_el == 0 { first.and_then(|m| m.print.as_ref()).and_then(|p| p.lyric_lines.as_ref()) } else { None };
            let specs = lyric_specs(&slots, infos);
            let translation = d.emit.bare_translation_verses && is_translation_set(&slots, &specs);
            let pairs = !translation && d.emit.bare_translation_verses && is_bilingual_pairs(&slots, &specs);
            // 段号按系统内的行序编：行数不同的系统（178 后面只有两行的）照常写
            let cont = if d.emit.bare_translation_verses && !translation && !pairs { conts[pi].as_ref().filter(|c| c.len() == specs.len()) } else { None };
            for spec in &specs {
                let bare = translation || (specs.len() == 1 && spec.from == 1.0 && spec.to == 1.0);
                let mut spec = spec.clone();
                let mut as_num = if pairs { Some((spec.from / 2.0).ceil()) } else { None };
                if let Some(&(num, head)) = cont.and_then(|c| c.get(&spec.from.to_bits())) {
                    as_num = Some(num);
                    // 续行照抄本系统里管它的那行的段号标签
                    if spec.label.is_none() && head != spec.from {
                        spec.label = specs.iter().find(|s| s.from == head).and_then(|s| s.label.clone());
                    }
                }
                if let Some(text) = lyric_line(&slots, &spec, bare, d, as_num) {
                    group.push(text);
                }
            }
        }
        if group.is_empty() {
            continue;
        }
        l.extend(group);
        if d.emit.blank_between_groups {
            l.push(String::new());
        }
    }
    while l.last().is_some_and(|s| s.is_empty()) {
        l.pop();
    }
    l.join("\n")
}

/// 整份文档 → 文本谱原文。多首之间用整行 `-----` 分隔。
pub fn emit_fanqie(doc: &ScoreDoc, dialect: Dialect) -> String {
    let opts = EmitFanqieOptions { from_fanqie: doc.source_format == SourceFormat::Fanqie, from_abc: doc.source_format == SourceFormat::Abc };
    let songs: Vec<String> = doc.songs.iter().map(|s| emit_fanqie_song(s, dialect, opts)).collect();
    songs.join("\n-----\n") + "\n"
}
