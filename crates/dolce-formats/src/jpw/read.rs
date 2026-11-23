//! `.jpwabc` → `ScoreDoc`（同 `model/fromjpw.ts`）。
//!
//! 两步：源文 → 源文小节（`SrcMeasure`，歌词按它数小节，照原 JP-Word 口径）；源文小节 → 模型（每根小节线都切小节、
//! 空小节的线并进下一小节左线、换行记「之后」再翻成「起」、倚音作独立 grace 元素）。
//! TS 按对象身份记的（小节 → 之后换行、源文音符 ← 歌词）这里改按下标。

use super::file::{JpwFile, Section};
use super::lex::{JpwTok, JpwToken};
use crate::abc::u16s::{self, U16};
use dolce_base::js;
use dolce_base::text::SourceSpan;
use dolce_base::Msg;
use dolce_model::helpers::{breaks_after_to_start, empty_doc, empty_song, IdGen};
use dolce_model::metakeys::creator_type_of;
use dolce_model::*;
use dolce_play::jppitch::{self, base_pitch_of_key, key_name_to_fifth, JpKeyState};
use serde::Serialize;
use std::collections::HashMap;

/// 读不出：`Model` 是带键的提示（TS `ModelError`），`Fail` 是 TS 里别的异常（`Error("")`、TypeError…）
#[derive(Clone, Debug, PartialEq)]
pub enum JpwError {
    Model(Msg),
    Fail(String),
}

fn fail<T>(why: &str) -> Result<T, JpwError> {
    Err(JpwError::Fail(why.to_string()))
}

/// 减时线 / 附点 / 增时线 → 模型时值（`durationOf`）
pub fn duration_of(beams: f64, dots: f64, beats: f64) -> Duration {
    let b = js::min(beams, 6.0);
    let base = js::to_int32(SIMPLE_DIVISIONS) >> (js::to_int32(b) & 31);
    let mut total = base as f64;
    let mut add = base as f64;
    let mut k = 0.0;
    while k < dots {
        add = (add / 2.0).floor();
        total += add;
        k += 1.0;
    }
    total += beats * SIMPLE_DIVISIONS;
    const TYPES: [NoteType; 7] = [NoteType::Quarter, NoteType::Eighth, NoteType::N16th, NoteType::N32nd, NoteType::N64th, NoteType::N128th, NoteType::N256th];
    Duration { divisions: total, kind: js::index(b).and_then(|i| TYPES.get(i)).cloned(), dots, time_mod: None }
}

/// `.jpwabc` 的 jpAlter（`b` / `n` / `#`）→ 模型的 Accidental（`accidentalOf`）
pub fn accidental_of(jp_alter: &str) -> Option<Accidental> {
    match jp_alter {
        "#" => Some(Accidental::Sharp),
        "b" => Some(Accidental::Flat),
        "n" => Some(Accidental::Natural),
        _ => None,
    }
}

/// `/^(\d+)(?:\.(\d+))?-(\d+)(?:\.(\d+))?V(\d+)(P)?$/i` → 各组原文
fn repeat_row(s: &str) -> Option<[Option<&str>; 6]> {
    let b = s.as_bytes();
    let digits = |k: usize| {
        let mut e = k;
        while e < b.len() && b[e].is_ascii_digit() {
            e += 1;
        }
        (e > k).then(|| (&s[k..e], e))
    };
    let opt_dot = |k: usize| {
        if b.get(k) == Some(&b'.') {
            if let Some((d, e)) = digits(k + 1) {
                return (Some(d), e);
            }
        }
        (None, k)
    };
    let (g1, j) = digits(0)?;
    let (g2, j) = opt_dot(j);
    if b.get(j) != Some(&b'-') {
        return None;
    }
    let (g3, j) = digits(j + 1)?;
    let (g4, j) = opt_dot(j);
    if !matches!(b.get(j), Some(b'V' | b'v')) {
        return None;
    }
    let (g5, mut j) = digits(j + 1)?;
    let mut g6 = None;
    if matches!(b.get(j), Some(b'P' | b'p')) {
        g6 = Some(&s[j..j + 1]);
        j += 1;
    }
    (j == b.len()).then_some([Some(g1), g2, Some(g3), g4, Some(g5), g6])
}

/// `.Repeat` 原文行 → `Song.playOrder`（`convertRepeat`）。`起.n` / `止.n` 落成该小节第 n 个非倚音元素的 id。
pub fn convert_repeat(rows: &[String], part: Option<&Part>) -> Vec<PlayPass> {
    let parsed: Vec<[Option<&str>; 6]> = rows.iter().flat_map(|r| r.split(',')).filter_map(|raw| repeat_row(js::trim(raw))).collect();
    let num = |x: Option<&str>| js::number(x.unwrap_or(""));
    // 小节号有 0 起与 1 起两种写法：出现 0 就整份按 0 起
    let base = if parsed.iter().any(|m| num(m[0]) == 0.0) { 1.0 } else { 0.0 };
    let mut out = vec![];
    for m in &parsed {
        let mut p = PlayPass {
            from_measure: num(m[0]) + base,
            to_measure: num(m[2]) + base,
            from_element: None,
            to_element: None,
            verse: Some(num(m[4])),
            page_break_after: None,
            from_anchor: None,
            to_anchor: None,
        };
        if m[5].is_some() {
            p.page_break_after = Some(true);
        }
        if let Some(part) = part {
            if m[1].is_some() {
                p.from_element = nth_note_id(part, p.from_measure, num(m[1]));
            }
            if m[3].is_some() {
                p.to_element = nth_note_id(part, p.to_measure, num(m[3]));
            }
        }
        out.push(p);
    }
    out
}

fn nth_note_id(part: &Part, measure_no: f64, n: f64) -> Option<ElementId> {
    let m = part.measures.get(js::index(measure_no - 1.0)?)?;
    let mut k = 0.0;
    for el in &m.elements {
        if let Element::Chord(c) = el {
            if c.grace.is_none() {
                k += 1.0;
                if k == n {
                    return Some(c.id);
                }
            }
        }
    }
    None
}

// ───────────────────────── 第一步：源文 → 源文小节 ─────────────────────────

/// 一个倚音（`{6,}`），音高照主音那样按调号与小节内临时记号落好
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SrcGrace {
    pub number: String,
    pub jp_octave: f64,
    pub jp_alter: String,
    pub pitch: f64,
    pub step: String,
    pub rest: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct SrcLyric {
    pub number: f64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceSpan>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SrcNote {
    pub number: String,
    pub jp_octave: f64,
    pub jp_alter: String,
    /// MIDI 音高（休止为 0）
    pub pitch: f64,
    pub step: String,
    pub rest: bool,
    pub beams: f64,
    /// 总拍数：初值 1，每个 `-` 再加一
    pub beats: f64,
    pub dot: f64,
    pub slur_start: bool,
    pub slur_ends: f64,
    pub fermata: bool,
    pub tuplet_begin: bool,
    pub tuplet_end: bool,
    pub graces: Vec<SrcGrace>,
    pub lyrics: Vec<SrcLyric>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceSpan>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SrcEntry {
    Note(SrcNote),
    #[serde(rename_all = "camelCase")]
    Bar {
        style: BarStyle,
        #[serde(skip_serializing_if = "Option::is_none")]
        repeat: Option<RepeatDir>,
        #[serde(skip_serializing_if = "Option::is_none")]
        also_forward: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<SourceSpan>,
    },
    Break {
        page: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<SourceSpan>,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SrcTime {
    pub beats: f64,
    pub beat_type: f64,
}

/// 源文小节：按原文的小节线切（歌词按它数小节）
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SrcMeasure {
    pub entries: Vec<SrcEntry>,
    pub fifths: f64,
    pub time: SrcTime,
    pub key_change: bool,
    pub time_change: bool,
}

/// `readJpwSource` 的结果
#[derive(Clone, Debug, Serialize)]
pub struct JpwSource {
    pub measures: Vec<SrcMeasure>,
    pub fifths: f64,
    pub time: SrcTime,
    /// 歌词的最大遍数（`.Words` 各段 `passLast` 取大；没有歌词为 0）
    pub passes: f64,
}

fn span_of(sec: &Section, t: &JpwToken) -> Option<SourceSpan> {
    let line_offset = *sec.line_offsets.get(t.line)?;
    let line_no = *sec.line_nos.get(t.line)?;
    Some(SourceSpan { line: line_no, column: t.column as u32, offset: line_offset + t.column as u32, length: (t.end - t.start) as u32 })
}

/// 小节内的调号状态（`JpKeyState`）与读 `.Voice` 时的两项跨音状态
struct KeyState {
    key: JpKeyState,
    in_tuplet: bool,
    slur_depth: f64,
}

/// `MusicCommon.getBasePitchOfKey`（调名取不到 TS 是 TypeError）
fn base_pitch(fifths: f64) -> Result<f64, JpwError> {
    base_pitch_of_key(fifths).or_else(fail)
}

/// `applyJpPitch`：回（pitch、rest）；`step` 在休止时不动
fn apply_jp_pitch(stat: &mut KeyState, number: &str, jp_octave: f64, jp_alter: &str, step: &mut String) -> Result<(f64, bool), JpwError> {
    match jppitch::apply_jp_pitch(&mut stat.key, number, jp_octave, jp_alter) {
        Ok(None) => Ok((0.0, true)),
        Ok(Some((pitch, st))) => {
            *step = st;
            Ok((pitch, false))
        }
        Err(e) => fail(e),
    }
}

fn find_sub(s: &[u16], pat: &[u16]) -> Option<usize> {
    if pat.is_empty() {
        return Some(0);
    }
    s.windows(pat.len()).position(|w| w == pat)
}

/// `/\{C:[^{}]*\}/g` 全部剥掉
fn strip_controls(s: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if u16s::starts(s, i, "{C:") {
            let mut j = i + 3;
            while j < s.len() && s[j] != b'{' as u16 && s[j] != b'}' as u16 {
                j += 1;
            }
            if u16s::is(s, j, '}') {
                i = j + 1;
                continue;
            }
        }
        out.push(s[i]);
        i += 1;
    }
    out
}

/// 去掉第一处 `[from, to)`
fn cut(s: &mut Vec<u16>, from: usize, to: usize) {
    s.drain(from..to);
}

/// 倚音 `/\{([#b0-7',gd]+)\}/`：回（起点、终点）
fn grace_match(s: &[u16]) -> Option<(usize, usize)> {
    for i in 0..s.len() {
        if s[i] != b'{' as u16 {
            continue;
        }
        let mut j = i + 1;
        while u16s::one_of(u16s::at(s, j), "#b01234567',gd") {
            j += 1;
        }
        if j > i + 1 && u16s::is(s, j, '}') {
            return Some((i, j + 1));
        }
    }
    None
}

/// `/\{(?:DunYin|BoYin|YanYin|ZhongYin)(?:,(?:…))*\}/`：回（起点、终点）
fn art_match(s: &[u16]) -> Option<(usize, usize)> {
    let art = |k: usize| ["DunYin", "BoYin", "YanYin", "ZhongYin"].iter().find_map(|w| u16s::starts(s, k, w).then(|| k + w.len()));
    for i in 0..s.len() {
        if s[i] != b'{' as u16 {
            continue;
        }
        let Some(mut j) = art(i + 1) else { continue };
        while u16s::is(s, j, ',') {
            match art(j + 1) {
                Some(e) => j = e,
                None => break,
            }
        }
        if u16s::is(s, j, '}') {
            return Some((i, j + 1));
        }
    }
    None
}

fn read_note(tok: &U16, stat: &mut KeyState) -> Result<SrcNote, JpwError> {
    let mut nt = SrcNote {
        number: "0".into(),
        jp_octave: 0.0,
        jp_alter: " ".into(),
        pitch: 0.0,
        step: " ".into(),
        rest: false,
        beams: 0.0,
        beats: 1.0,
        dot: 0.0,
        slur_start: false,
        slur_ends: 0.0,
        fermata: false,
        tuplet_begin: false,
        tuplet_end: false,
        graces: vec![],
        lyrics: vec![],
        source: None,
    };
    // 控制参数只管排版，先剥掉（留着的话里头的数字会被扫成音高、`.` 扫成附点）
    let mut txt = strip_controls(tok);
    let tup = u16s::enc("{(3}");
    if let Some(at) = find_sub(&txt, &tup) {
        if stat.in_tuplet {
            return fail("tuplet in tuplet");
        }
        nt.tuplet_begin = true;
        stat.in_tuplet = true;
        cut(&mut txt, at, at + tup.len());
    }
    // 倚音 `{6,}` / `{57}`：在 `{(3}` 剥掉之后
    if let Some((a, b)) = grace_match(&txt) {
        let g = txt[a + 1..b - 1].to_vec();
        let mut i = 0;
        // matchAll /(#b|#|b)?([0-7])([',gd]*)/g
        while i < g.len() {
            let d07 = |k: usize| u16s::within(u16s::at(&g, k), '0', '7');
            let pre = [("#b", 2), ("#", 1), ("b", 1), ("", 0)].into_iter().find(|(p, n)| u16s::starts(&g, i, p) && d07(i + n));
            let Some((p, n)) = pre else {
                i += 1;
                continue;
            };
            let num = u16s::text(&g[i + n..i + n + 1]);
            let mut k = i + n + 1;
            let mut oct = 0.0;
            while u16s::one_of(u16s::at(&g, k), "',gd") {
                if g[k] == b',' as u16 {
                    oct -= 1.0;
                } else if g[k] == b'\'' as u16 {
                    oct += 1.0;
                }
                k += 1;
            }
            let alter = match p {
                "#b" => "n",
                "#" | "b" => p,
                _ => " ",
            };
            let mut step = " ".to_string();
            let (pitch, rest) = apply_jp_pitch(stat, &num, oct, alter, &mut step)?;
            nt.graces.push(SrcGrace { number: num, jp_octave: oct, jp_alter: alter.into(), pitch, step, rest });
            i = k;
        }
        cut(&mut txt, a, b);
    }
    if let Some((a, b)) = art_match(&txt) {
        if find_sub(&txt[a..b], &u16s::enc("YanYin")).is_some() {
            nt.fermata = true;
        }
        cut(&mut txt, a, b);
    }
    let mut opened = 0.0;
    let mut acc = String::new();
    for &u in &txt {
        if u16s::digit(u) {
            nt.number = u16s::text(&[u]);
            match acc.as_str() {
                "#" => nt.jp_alter = "#".into(),
                "b" => nt.jp_alter = "b".into(),
                "#b" => nt.jp_alter = "n".into(),
                _ => {}
            }
            continue;
        }
        match u16s::ch(u) {
            Some(',') => nt.jp_octave -= 1.0,
            Some('\'') => nt.jp_octave += 1.0,
            Some('_') => nt.beams += 1.0,
            Some('-') => nt.beats += 1.0,
            Some('.') => nt.dot += 1.0,
            Some(c @ ('#' | 'b')) => acc.push(c),
            Some('(') => {
                nt.slur_start = true;
                opened += 1.0; // 本音符自己开的 `(` 要到下一个音符才轮到配对
            }
            Some(')') => {
                // 前面还欠着 `(` 就先收弧；欠完了、又正在三连音里，才是三连音的收尾
                if stat.slur_depth > 0.0 {
                    stat.slur_depth -= 1.0;
                    nt.slur_ends += 1.0;
                } else if stat.in_tuplet {
                    stat.in_tuplet = false;
                    nt.tuplet_end = true;
                } else {
                    nt.slur_ends += 1.0;
                }
            }
            _ => {}
        }
    }
    stat.slur_depth += opened;
    let mut step = nt.step.clone();
    let (pitch, rest) = apply_jp_pitch(stat, &nt.number.clone(), nt.jp_octave, &nt.jp_alter.clone(), &mut step)?;
    nt.pitch = pitch;
    nt.step = step;
    nt.rest = rest;
    Ok(nt)
}

/// `.Voice` → 源文小节（`readVoice`）
fn read_voice(sec: &Section, tokens: &[JpwToken], fifths: f64, time: &SrcTime) -> Result<Vec<SrcMeasure>, JpwError> {
    let mut out: Vec<SrcMeasure> = vec![];
    let mut cur: Option<usize> = None;
    let mut new_measure = false;
    let mut stat = KeyState { key: JpKeyState { base_pitch: base_pitch(fifths)?, fifths, alter: HashMap::new() }, in_tuplet: false, slur_depth: 0.0 };
    // 三连音首尾（tupletBegin, tupletEnd）
    let mut tup_notes: Vec<(bool, bool)> = vec![];
    let mut pending_time: Option<SrcTime> = None;
    let mut pending_key: Option<f64> = None;
    let open = |out: &mut Vec<SrcMeasure>| {
        out.push(SrcMeasure { entries: vec![], fifths, time: time.clone(), key_change: false, time_change: false });
        out.len() - 1
    };
    for tok in tokens {
        match tok.kind {
            JpwTok::Note => {
                if cur.is_none() || new_measure {
                    let mi = open(&mut out);
                    cur = Some(mi);
                    new_measure = false;
                    if let Some(t) = pending_time.take() {
                        out[mi].time = t;
                        out[mi].time_change = true;
                    }
                    if let Some(k) = pending_key.take() {
                        out[mi].fifths = k;
                        out[mi].key_change = true;
                        stat.key.base_pitch = base_pitch(k)?;
                        stat.key.fifths = k;
                        stat.key.alter.clear();
                    }
                }
                let mut nt = read_note(&tok.text, &mut stat)?;
                nt.source = span_of(sec, tok);
                if nt.tuplet_end || nt.tuplet_begin {
                    tup_notes.push((nt.tuplet_begin, nt.tuplet_end));
                }
                out[cur.unwrap()].entries.push(SrcEntry::Note(nt));
            }
            JpwTok::Barline => {
                // 曲首就写小节线：开一个小节收它，不置 newMeasure
                if cur.is_none() {
                    cur = Some(open(&mut out));
                }
                let txt = u16s::text(&strip_controls(&tok.text));
                let (style, repeat, also) = match txt.as_str() {
                    "|" => (BarStyle::Regular, None, None),
                    "|]" => (BarStyle::LightHeavy, None, None),
                    "[|]" => (BarStyle::NoStyle, None, None),
                    "||" => (BarStyle::LightLight, None, None),
                    "|:" => (BarStyle::HeavyLight, Some(RepeatDir::Forward), None),
                    ":|" => (BarStyle::LightHeavy, Some(RepeatDir::Backward), None),
                    "::" | ":|:" => (BarStyle::LightHeavy, Some(RepeatDir::Backward), Some(true)),
                    _ => return fail("bad barline"),
                };
                let m = &mut out[cur.unwrap()];
                m.entries.push(SrcEntry::Bar { style, repeat, also_forward: also, source: span_of(sec, tok) });
                new_measure = m.entries.len() > 1;
                stat.key.alter.clear();
            }
            JpwTok::Timesig => {
                // /^(\d+)\/(\d+)/
                let t = &tok.text;
                let a = u16s::digits(t, 0);
                if a > 0 && u16s::is(t, a, '/') {
                    let b = u16s::digits(t, a + 1);
                    if b > 0 {
                        pending_time = Some(SrcTime {
                            beats: js::parse_int(&u16s::text(&t[..a]), 10),
                            beat_type: js::parse_int(&u16s::text(&t[a + 1..a + 1 + b]), 10),
                        });
                    }
                }
            }
            JpwTok::String => {
                // /^"1=([#b]?[A-G])"$/
                let t = u16s::text(&tok.text);
                if let Some(inner) = t.strip_prefix("\"1=").and_then(|x| x.strip_suffix('"')) {
                    let b = inner.as_bytes();
                    let ok = match b.len() {
                        1 => (b'A'..=b'G').contains(&b[0]),
                        2 => (b[0] == b'#' || b[0] == b'b') && (b'A'..=b'G').contains(&b[1]),
                        _ => false,
                    };
                    if ok {
                        pending_key = Some(key_name_to_fifth(inner));
                    }
                }
            }
            JpwTok::Return => {
                let ret = &tok.text;
                let after = ret.iter().position(|&u| u == b'(' as u16).map_or(&ret[..], |i| &ret[i + 1..]);
                let inner = after.iter().position(|&u| u == b')' as u16).map_or(after, |i| &after[..i]);
                let args: Vec<&[u16]> = inner.split(|&u| u == b',' as u16).collect();
                let page = args.len() >= 4 && u16s::text(args[3]).to_lowercase() == "true";
                if let Some(mi) = cur {
                    out[mi].entries.push(SrcEntry::Break { page, source: span_of(sec, tok) });
                }
            }
            _ => {}
        }
    }
    // 三连音首尾两两配对，配反了抛错
    for i in 0..tup_notes.len() / 2 {
        if tup_notes[2 * i].1 || tup_notes[2 * i + 1].0 {
            return fail("tuplet pairing");
        }
    }
    // 没有标记的小节沿用上一次的调号 / 拍号
    let mut cur_time = time.clone();
    let mut cur_key = fifths;
    for m in &mut out {
        if m.time_change {
            cur_time = m.time.clone();
        } else {
            m.time = cur_time.clone();
        }
        if m.key_change {
            cur_key = m.fifths;
        } else {
            m.fifths = cur_key;
        }
    }
    Ok(out)
}

/// 歌词落点 `@m,n`（`assignLyrics`）：行末 `$` 算一个小节收尾、没有音的小节不算；这样数会落进同一段前面已写的词里的，
/// 改按只认小节线的数法（小节中间的 `$` 不算）。
fn assign_lyrics(measures: &mut [SrcMeasure], f: &JpwFile) {
    // 每个音两种数法下的（第几小节、第几个音）：`line` 行末 `$` 算收尾，`bar` 只认小节线；外加音在哪（小节、条目）
    struct Seat {
        at: (usize, usize),
        line: (f64, f64),
        bar: (f64, f64),
    }
    let mut seats: Vec<Seat> = vec![];
    let (mut line_mid, mut bar_mid) = (0.0, 0.0);
    for (mi, m) in measures.iter().enumerate() {
        let is_note = |e: &SrcEntry| matches!(e, SrcEntry::Note(_));
        if !m.entries.iter().any(is_note) {
            continue;
        }
        line_mid += 1.0;
        bar_mid += 1.0;
        let (mut line_nid, mut bar_nid) = (0.0, 0.0);
        for (i, ent) in m.entries.iter().enumerate() {
            if matches!(ent, SrcEntry::Break { .. }) && line_nid > 0.0 && m.entries[i + 1..].iter().any(is_note) {
                line_mid += 1.0;
                line_nid = 0.0;
            }
            if !is_note(ent) {
                continue;
            }
            line_nid += 1.0;
            bar_nid += 1.0;
            seats.push(Seat { at: (mi, i), line: (line_mid, line_nid), bar: (bar_mid, bar_nid) });
        }
    }
    // 各段词最后一个字落在第几个音
    let mut verse_end: Vec<(f64, f64)> = vec![];
    let get = |v: &Vec<(f64, f64)>, k: f64| v.iter().find(|(p, _)| *p == k).map(|(_, e)| *e);
    for seg in f.lyric().unwrap_or(&[]) {
        let start_by = |by_line: bool| {
            seats
                .iter()
                .position(|s| {
                    let (m, n) = if by_line { s.line } else { s.bar };
                    m > seg.measure || (m == seg.measure && n >= seg.note_index)
                })
                .unwrap_or(seats.len()) as f64
        };
        let mut end = -1.0;
        let mut pass = seg.pass_first;
        while pass <= seg.pass_last {
            end = js::max(end, get(&verse_end, pass).unwrap_or(-1.0));
            pass += 1.0;
        }
        let mut idx = start_by(true);
        if idx <= end {
            idx = start_by(false);
        }
        for it in &seg.data {
            if idx >= seats.len() as f64 {
                break;
            }
            if !it.text.is_empty() {
                let (mi, ei) = seats[idx as usize].at;
                let SrcEntry::Note(note) = &mut measures[mi].entries[ei] else { unreachable!() };
                let mut pass = seg.pass_first;
                while pass <= seg.pass_last {
                    note.lyrics.push(SrcLyric { number: pass, text: u16s::text(&it.text), source: it.source });
                    match verse_end.iter_mut().find(|(p, _)| *p == pass) {
                        Some(e) => e.1 = idx,
                        None => verse_end.push((pass, idx)),
                    }
                    pass += 1.0;
                }
            }
            idx += 1.0;
        }
    }
}

// ───────────────────────── 第二步：源文小节 → 模型 ─────────────────────────

fn chord(id: ElementId, duration: Duration) -> Chord {
    Chord { id, duration, voice: 1.0, staff: 1.0, ..Default::default() }
}

fn new_measure(n: usize) -> Measure {
    Measure { number: (n + 1).to_string(), ..Default::default() }
}

/// 照原 `fromscore.ts::convertPart`（非 `forMusicXml`）
fn build_part(src: &[SrcMeasure], ids: &mut IdGen, marks: &mut Vec<Mark>) -> Part {
    let mut part = Part { id: "P1".into(), ..Default::default() };
    // 各小节「之后」的换行（TS 按小节对象记，这里与 `part.measures` 平行；在建的小节另记）
    let mut after: Vec<Option<BreakKind>> = vec![];
    let mut prev_key: Option<f64> = None;
    let mut prev_time = String::new();
    // 开着的弧线（栈，嵌套双弧后开先闭；跨小节常见）
    let mut open_slurs: Vec<ElementId> = vec![];
    let mut open_tuplet: Option<ElementId>;
    // 刚读到的 `$`：之后同一小节里还有音符，才算小节中间换行（和弦位置 = 当前小节的元素下标）
    let mut pending_inline: Option<(usize, BreakKind)>;

    for sm in src {
        let mut mea = new_measure(part.measures.len());
        let mut mea_after: Option<BreakKind> = None;
        let time_key = format!("{}/{}", js::num_to_string(sm.time.beats), js::num_to_string(sm.time.beat_type));
        if prev_key.is_none() || sm.key_change || Some(sm.fifths) != prev_key {
            mea.attrs.get_or_insert_with(Default::default).key = Some(Key { fifths: sm.fifths, ..Default::default() });
        }
        if prev_time.is_empty() || sm.time_change || time_key != prev_time {
            mea.attrs.get_or_insert_with(Default::default).time = Some(Time { beats: sm.time.beats, beat_type: sm.time.beat_type, symbol: None, parenthesized: None });
        }
        prev_key = Some(sm.fifths);
        prev_time = time_key;
        open_tuplet = None;
        pending_inline = None;

        for ent in &sm.entries {
            match ent {
                SrcEntry::Break { page, source } => {
                    let kind = if *page { BreakKind::Page } else { BreakKind::System };
                    // `$` 是「这一小节之后」换行；小节线先到、新小节还空着时挂到刚收尾的那一个
                    let on_prev = mea.elements.is_empty() && !part.measures.is_empty();
                    if on_prev {
                        *after.last_mut().unwrap() = Some(kind.clone());
                    } else {
                        mea_after = Some(kind.clone());
                    }
                    // 写在小节中间（后面还有音符）的，另在前一个和弦上记原位
                    pending_inline = match mea.elements.last() {
                        Some(Element::Chord(_)) => Some((mea.elements.len() - 1, kind)),
                        _ => None,
                    };
                    if let Some(source) = source {
                        let els = if on_prev { &part.measures.last().unwrap().elements } else { &mea.elements };
                        part.break_sources.get_or_insert_with(Vec::new).push(BreakSource { page: *page, after: els.last().map(|e| e.id()), source: *source });
                    }
                }
                SrcEntry::Bar { style, repeat, also_forward, source } => {
                    // 每根小节线都是小节分隔；小节里还没有元素时算下一小节的左线
                    let mut b = Barline::at(BarLocation::Right);
                    b.style = Some(style.clone());
                    b.repeat = repeat.clone();
                    b.also_forward = *also_forward;
                    b.source = *source;
                    pending_inline = None;
                    if mea.elements.is_empty() {
                        let bars = mea.barlines.get_or_insert_with(Vec::new);
                        if let Some(left) = bars.iter_mut().find(|x| x.location == BarLocation::Left) {
                            if left.style.is_none() {
                                left.style = b.style.clone();
                            }
                            if left.repeat.is_none() {
                                left.repeat = b.repeat.clone();
                            }
                        } else {
                            b.location = BarLocation::Left;
                            bars.push(b);
                        }
                    } else {
                        mea.barlines.get_or_insert_with(Vec::new).push(b);
                        part.measures.push(std::mem::replace(&mut mea, new_measure(part.measures.len() + 1)));
                        after.push(mea_after.take());
                    }
                }
                SrcEntry::Note(nt) => {
                    if let Some((i, kind)) = pending_inline.take() {
                        if let Element::Chord(c) = &mut mea.elements[i] {
                            c.line_break_after = Some(kind);
                        }
                    }
                    let mut ch = chord(ids.next(), duration_of(nt.beams, nt.dot, js::max(0.0, nt.beats - 1.0)));
                    ch.source = nt.source;
                    if nt.rest {
                        ch.rest = Some(RestInfo::default());
                    }
                    let num = js::number(&nt.number);
                    if num.is_finite() && num != 0.0 {
                        // `.jpwabc` 只有简谱度数，不填绝对音高
                        ch.notes.push(Note { degree: Some(Degree { number: num, octave_shift: nt.jp_octave, accidental: accidental_of(&nt.jp_alter) }), ..Default::default() });
                    }
                    if nt.beams > 0.0 {
                        ch.beams = Some(vec![BeamVal::Continue; js::repeat_count(nt.beams)]);
                    }
                    let mut k = 0.0;
                    while k < nt.beats - 1.0 {
                        let su = Sustain {
                            id: ids.next(),
                            harmony: None,
                            notations: None,
                            ornaments: None,
                            section_word: None,
                            lyric_anchor: None,
                            lyrics: None,
                            before: None,
                            line_break_after: None,
                            attached_sources: None,
                            source: None,
                        };
                        ch.sustains.get_or_insert_with(Vec::new).push(su);
                        k += 1.0;
                    }
                    if nt.fermata {
                        ch.notations = Some(Notations { fermata: Some(true), ..Default::default() });
                    }
                    for g in &nt.graces {
                        let gnum = js::number(&g.number);
                        let mut gc = chord(ids.next(), Duration { divisions: 0.0, kind: None, dots: 0.0, time_mod: None });
                        gc.notes.push(Note {
                            degree: Some(Degree { number: if gnum.is_finite() && gnum > 0.0 { gnum } else { 1.0 }, octave_shift: g.jp_octave, accidental: accidental_of(&g.jp_alter) }),
                            ..Default::default()
                        });
                        gc.grace = Some(GraceInfo::default());
                        mea.elements.push(Element::Chord(gc));
                    }
                    for lr in &nt.lyrics {
                        ch.lyrics.get_or_insert_with(Vec::new).push(Lyric { number: lr.number, text: lr.text.clone(), source: lr.source, ..Default::default() });
                    }
                    let (id, slur_ends, slur_start, tb, te) = (ch.id, nt.slur_ends, nt.slur_start, nt.tuplet_begin, nt.tuplet_end);
                    mea.elements.push(Element::Chord(ch));

                    // 同一音符上「收上一条、再起下一条」：先收后起
                    let mut k = 0.0;
                    while k < slur_ends {
                        if let Some(start) = open_slurs.pop() {
                            let mut m = Mark::new(MarkType::Slur, start, id);
                            m.level = Some(open_slurs.len() as f64);
                            marks.push(m);
                        }
                        k += 1.0;
                    }
                    if slur_start {
                        open_slurs.push(id);
                    }
                    if tb {
                        open_tuplet = Some(id);
                    }
                    if let (Some(start), true) = (open_tuplet, te) {
                        let mut m = Mark::new(MarkType::Tuplet, start, id);
                        m.tuplet_actual = Some(3.0);
                        m.tuplet_normal = Some(2.0);
                        marks.push(m);
                        open_tuplet = None;
                    }
                }
            }
        }
        if !mea.elements.is_empty() || mea.barlines.as_ref().is_some_and(|b| !b.is_empty()) {
            part.measures.push(mea);
            after.push(mea_after);
        }
    }

    // 空小节并入下一小节的左线（`|:|` 连写）；它之后的换行挂到前一小节
    let mut merged: Vec<Measure> = vec![];
    let mut merged_after: Vec<Option<BreakKind>> = vec![];
    let mut carry: Vec<Barline> = vec![];
    for (mut m, a) in std::mem::take(&mut part.measures).into_iter().zip(after) {
        if m.elements.is_empty() {
            for b in m.barlines.iter().flatten() {
                let mut b = b.clone();
                b.location = BarLocation::Left;
                carry.push(b);
            }
            if let (Some(a), Some(prev)) = (a, merged_after.last_mut()) {
                if *prev != Some(BreakKind::Page) {
                    *prev = Some(a);
                }
            }
            continue;
        }
        if !carry.is_empty() {
            let mut bars = std::mem::take(&mut carry);
            bars.extend(m.barlines.take().unwrap_or_default());
            m.barlines = Some(bars);
        }
        merged.push(m);
        merged_after.push(a);
    }
    if !carry.is_empty() {
        if let Some(last) = merged.last_mut() {
            let bars = last.barlines.get_or_insert_with(Vec::new);
            for mut b in carry {
                b.location = BarLocation::Right;
                bars.push(b);
            }
        }
    }
    part.measures = merged;
    let after: HashMap<usize, BreakKind> = merged_after.into_iter().enumerate().filter_map(|(i, a)| a.map(|a| (i, a))).collect();
    breaks_after_to_start(&mut part, &after);
    for (i, m) in part.measures.iter_mut().enumerate() {
        m.number = (i + 1).to_string();
    }
    part
}

fn unescape(s: &str) -> String {
    s.replace("\\n", "\n")
}

/// 读 `.jpwabc` 原文的那一步（`readJpwSource`）：`.Voice` 切成源文小节、歌词落到音符上。`.Voice` 缺失或解析失败时出错。
pub fn read_jpw_source(f: &JpwFile) -> Result<JpwSource, JpwError> {
    let title = f.title();
    let key = title.as_ref().and_then(|t| t.key());
    let fifths = key_name_to_fifth(key.as_deref().unwrap_or("C"));
    let meter = match &title {
        Some(t) => t.meter().map_err(|_| JpwError::Fail("meter".into()))?,
        None => None,
    };
    let meter = meter.unwrap_or_else(|| "4/4".into());
    let mut parts = meter.split('/');
    let beats = js::parse_int(parts.next().unwrap_or(""), 10);
    let beat_type = parts.next().map_or(f64::NAN, |s| js::parse_int(s, 10));
    let time = SrcTime { beats, beat_type };
    let Some(voice) = f.voice() else { return Err(JpwError::Model(Msg::new("err.noVoice"))) };
    let super::file::SectionKind::Voice { voice_data } = &voice.kind else { unreachable!() };
    let mut measures = read_voice(voice, voice_data, fifths, &time)?;
    assign_lyrics(&mut measures, f);
    let mut passes = 0.0;
    for seg in f.lyric().unwrap_or(&[]) {
        passes = js::max(passes, seg.pass_last);
    }
    Ok(JpwSource { measures, fifths, time, passes })
}

/// `.jpwabc` 原文 → `ScoreDoc`（`JpwFile.fromString` + `jpwToScoreDoc`）。分节解析不了回 `Ok(None)`（TS `fromString` 回 null）。
pub fn parse_jpw(text: &str) -> Result<Option<ScoreDoc>, JpwError> {
    match JpwFile::from_str(text) {
        Some(f) => jpw_to_score_doc(&f).map(Some),
        None => Ok(None),
    }
}

/// `jpwToScoreDoc`
pub fn jpw_to_score_doc(f: &JpwFile) -> Result<ScoreDoc, JpwError> {
    let mut doc = empty_doc(SourceFormat::Jpwabc);
    let mut ids = IdGen::new();
    let mut song = empty_song();
    let title = f.title();
    let title_text = unescape(title.as_ref().and_then(|t| t.title()).unwrap_or(""));
    if !title_text.is_empty() {
        song.work.title = Some(title_text.clone());
    }
    if let Some(author) = title.as_ref().and_then(|t| t.words_music_by()) {
        let text = unescape(author);
        if !text.is_empty() {
            song.credits = Some(vec![Credit { text: text.clone(), ..Default::default() }]);
            // 词曲一行当作者行（类型按标签定，只在整条是一行时认）
            if text != title_text {
                let one = text.replace('\n', " ");
                let kind = if text.contains('\n') { None } else { creator_type_of(&one) };
                song.identification = Some(Identification { creators: vec![Creator { kind: kind.unwrap_or("composer").into(), text: one }], rights: None, software: None });
            }
        }
    }
    // 速度（`.Title` 的 `Expression ♩=NN`）
    if let Some(t) = &title {
        let tempo = t.tempo();
        if tempo != 0.0 {
            song.tempos = Some(vec![Tempo::Bpm(tempo)]);
        }
    }
    let src = read_jpw_source(f)?.measures;
    if let Some(m0) = src.first() {
        // `spelling` 必须一起写（引擎输入的调号走它）
        let spelling = title.as_ref().and_then(|t| t.key()).filter(|k| !k.is_empty());
        song.key = Some(Key { fifths: m0.fifths, spelling, ..Default::default() });
        song.time = Some(Time { beats: m0.time.beats, beat_type: m0.time.beat_type, symbol: None, parenthesized: None });
    }
    let mut marks = vec![];
    song.parts = vec![build_part(&src, &mut ids, &mut marks)];
    song.marks = marks;
    match f.repeat() {
        Some(rows) if !rows.is_empty() => {
            let play = convert_repeat(rows, song.parts.first());
            if !play.is_empty() {
                song.play_order = Some(play);
            }
        }
        _ => infer_endings(&mut song.parts[0]),
    }
    doc.songs.push(song);
    Ok(doc)
}

/// JP-Word 不写房号：`:|` 那一小节与紧跟着的一小节节奏逐音相同、第一个音的第 1 段词也相同时，前者是一房、后者是二房（`inferEndings`）
fn infer_endings(part: &mut Part) {
    let first_word = |m: &Measure| -> String {
        let c = m.elements.iter().find_map(|e| match e {
            Element::Chord(c) if c.grace.is_none() && c.rest.is_none() => Some(c),
            _ => None,
        });
        let ls = c.and_then(|c| c.lyrics.as_ref());
        let l = ls.and_then(|ls| ls.iter().find(|x| x.number == 1.0).or(ls.first()));
        l.map_or("", |l| l.text.as_str())
            .chars()
            .filter(|&ch| !(js::is_space(ch) || is_punct(ch)))
            .collect()
    };
    let rhythm = |m: &Measure| -> String {
        m.elements
            .iter()
            .filter_map(|e| match e {
                Element::Chord(c) if c.grace.is_none() => Some(format!("{}{}", if c.rest.is_some() { "r" } else { "n" }, js::num_to_string(c.duration.divisions))),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(" ")
    };
    let ms = &mut part.measures;
    for i in 0..ms.len().saturating_sub(1) {
        let m = &ms[i];
        let bars = m.barlines.as_deref().unwrap_or(&[]);
        let Some(back) = bars.iter().position(|b| b.location == BarLocation::Right && b.repeat == Some(RepeatDir::Backward)) else { continue };
        if bars[back].also_forward == Some(true) || bars.iter().any(|b| b.ending.is_some()) {
            continue;
        }
        let next = &ms[i + 1];
        if next.barlines.iter().flatten().any(|b| b.repeat.is_some() || b.ending.is_some()) {
            continue;
        }
        let r = rhythm(m);
        if r.is_empty() || r != rhythm(next) {
            continue;
        }
        // 两小节第一个音的第 1 段词（去标点）也得相同
        if first_word(m) != first_word(next) {
            continue;
        }
        let bars = ms[i].barlines.as_mut().unwrap();
        let mut left = Barline::at(BarLocation::Left);
        left.ending = Some(Ending::new(vec![1.0], EndingType::Start, Some("1.".into())));
        bars.push(left);
        bars[back].ending = Some(Ending::new(vec![1.0], EndingType::Stop, Some("1.".into())));
        let nb = ms[i + 1].barlines.get_or_insert_with(Vec::new);
        let mut left2 = Barline::at(BarLocation::Left);
        left2.ending = Some(Ending::new(vec![2.0], EndingType::Start, Some("2.".into())));
        nb.push(left2);
        let disc = Ending::new(vec![2.0], EndingType::Discontinue, Some("2.".into()));
        match nb.iter_mut().find(|b| b.location == BarLocation::Right) {
            Some(right) => right.ending = Some(disc),
            None => {
                let mut r = Barline::at(BarLocation::Right);
                r.ending = Some(disc);
                nb.push(r);
            }
        }
    }
}

/// `\p{P}`
fn is_punct(c: char) -> bool {
    use unicode_general_category::{get_general_category, GeneralCategory::*};
    matches!(get_general_category(c), ConnectorPunctuation | DashPunctuation | OpenPunctuation | ClosePunctuation | InitialPunctuation | FinalPunctuation | OtherPunctuation)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SONG: &str = ".Title\r\nKeyAndMeters = {1=D,4/4}\r\n.Voice\r\n{1'}2 3 4- |5--- |]\r\n.Words\r\nW1:我们同心\r\n";

    #[test]
    fn source() {
        let src = read_jpw_source(&JpwFile::from_str(SONG).unwrap()).ok().unwrap();
        assert_eq!((src.fifths, src.time.beats, src.time.beat_type, src.passes), (2.0, 4.0, 4.0, 1.0));
        let SrcEntry::Note(n) = &src.measures[0].entries[0] else { panic!() };
        assert_eq!((n.number.as_str(), n.graces.len(), n.graces[0].jp_octave), ("2", 1, 1.0));
        assert_eq!(n.lyrics[0].text, "我");
        let SrcEntry::Note(n) = &src.measures[0].entries[2] else { panic!() };
        assert_eq!(n.beats, 2.0);
    }

    #[test]
    fn errors() {
        let read = |t: &str| read_jpw_source(&JpwFile::from_str(t).unwrap());
        assert!(matches!(read(".Title\nTitle = {甲}\n"), Err(JpwError::Model(m)) if m.key == "err.noVoice"));
        assert!(matches!(read(".Title\nKeyAndMeters = {1=H,4/4}\n.Voice\n1 2 3 4|\n"), Err(JpwError::Fail(_))));
        assert!(matches!(read(".Title\nKeyAndMeters = {1=C}\n.Voice\n1 2 3 4|\n"), Err(JpwError::Fail(_))));
        assert!(matches!(parse_jpw(".Foo\n.Voice\n1|\n"), Ok(None)));
        assert!(matches!(parse_jpw("1\n.Voice\n1|\n"), Ok(None)));
        assert!(matches!(parse_jpw(".Voice\n1 [ 3|\n"), Ok(None)));
    }

    #[test]
    fn doc() {
        let doc = parse_jpw(SONG).ok().flatten().unwrap();
        assert_eq!(doc.songs.len(), 1);
        assert_eq!(doc.songs[0].parts[0].measures.len(), 2);
    }
}

