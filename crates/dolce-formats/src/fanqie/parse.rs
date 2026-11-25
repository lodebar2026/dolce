//! 文本谱（番茄 / 有谱）→ `FanqieDoc` → `ScoreDoc`（同 `fanqie/parse.ts`）。
//!
//! 单趟字符扫描，不额外造 token 流。方言差异集中在 `dialect` 的 `DialectSpec` 里。三类行：
//!   头部    `V:` `B:` `Z:` `D:` `P:` `J:`（番茄）/ `T:` `1=C4/4` `XL:` `BC:` …（有谱）
//!   曲      `Q:` `Q1:` `Q1"女高":` `Q1<女高>:`
//!   词/文字 `C:` `C1:` / `W:`
//! 空行分组：相邻的 Q 行（连同其下的 C 行）成为一个 VoiceGroup，上下堆叠横向对齐。
//!
//! 按 UTF-16 码元扫（TS 的 `src[i]`、`slice`、源区间都是码元），语法字符都在 ASCII / BMP；正则逐条手译、回溯次序照原式。
//! TS 靠对象身份做的「到最后没收口的跨行弧线撤掉已落下的半条」改成按 `Mark.uid` 找。

use super::ast::*;
use super::dialect::{sniff_dialect, split_lines, Dialect, DialectSpec};
use super::fromfanqie::fanqie_to_score_doc;
use crate::abc::u16s::{self, U16};
use dolce_base::{Msg, SourceSpan};
use dolce_model::marknames::DYNAMIC_NAMES;
use dolce_model::{Diagnostic, DiagnosticSeverity, ScoreDoc, Tempo};

/// 音符后可跟的记号名（`&xx`）。不在表里的会报 unknown-command 但仍保留。
fn is_note_command(name: &str) -> bool {
    const OTHER: &[&str] = &[
        "zkh", "ykh", // 伴奏括弧
        "cresc", "dim", "rit", "tempo", "atempo", // 术语
        "yc", "ycy", "bc", "zy", "dy", "hx", // 延长/保持/重音/顿音/呼吸
        "shy", "xhy", "sby", "xby", "cy", "tr", // 滑音/波音/颤音
    ];
    DYNAMIC_NAMES.contains(&name) || OTHER.contains(&name)
}

/// 小节线上可跟的记号名
const BARLINE_COMMANDS: &[&str] = &["fine", "dc", "ds", "ty", "hs", "sbf"];

/// 跳转字（`&fine` / `&dc` / `&ds`）。诗歌本不写成记号，写成小节线文字 `"ff:Fine"`
const JUMP_WORD_COMMANDS: &[&str] = &["fine", "dc", "ds"];

/// 小节线文字 → 跳转记号名（不分大小写，句点可省）
fn jump_word(w: &str) -> Option<&'static str> {
    match w {
        "fine" => Some("fine"),
        "d.c." | "d.c" => Some("dc"),
        "d.s." | "d.s" => Some("ds"),
        _ => None,
    }
}

fn all_commands() -> impl Iterator<Item = &'static str> {
    const OTHER: &[&str] = &[
        "zkh", "ykh", "cresc", "dim", "rit", "tempo", "atempo", "yc", "ycy", "bc", "zy", "dy", "hx", "shy", "xhy", "sby", "xby", "cy", "tr",
    ];
    DYNAMIC_NAMES.iter().chain(OTHER.iter()).chain(BARLINE_COMMANDS.iter()).copied()
}

pub struct Ctx {
    pub spec: &'static DialectSpec,
    pub diagnostics: Vec<Diagnostic>,
    /// 当前行号（0 基）
    pub line: u32,
    /// 当前行首在全文里的偏移
    pub line_offset: u32,
    next_uid: u32,
}

impl Ctx {
    pub fn new(dialect: Dialect) -> Ctx {
        Ctx { spec: dialect.spec(), diagnostics: vec![], line: 0, line_offset: 0, next_uid: 1 }
    }
    fn span(&self, column: usize, length: usize) -> SourceSpan {
        SourceSpan { line: self.line, column: column as u32, offset: self.line_offset + column as u32, length: length as u32 }
    }
    fn report(&mut self, code: &str, msg: Msg, column: usize, length: usize) {
        let source = self.span(column, length);
        self.diagnostics.push(Diagnostic { severity: DiagnosticSeverity::Warning, code: code.into(), msg, source });
    }
    fn uid(&mut self) -> u32 {
        let u = self.next_uid;
        self.next_uid += 1;
        u
    }
}

fn unit_str(u: u16) -> String {
    u16s::text(&[u])
}

// ---------------- 音符 ----------------

/// 变音/八度/减时线/附点可以任意顺序跟在数字后面。`ch` 是**一个码元**（TS `src[i]`）。
fn apply_modifier(ctx: &Ctx, note: &mut NoteElement, ch: u16) -> bool {
    let d = ctx.spec;
    let c = u16s::ch(ch);
    let acc = c.and_then(|c| d.accidental(c.encode_utf8(&mut [0; 4])));
    if c == Some(d.octave_up) {
        note.octave += 1;
    } else if c == Some(d.octave_down) {
        note.octave -= 1;
    } else if c == Some('/') {
        note.duration *= 2;
    } else if c == Some('.') {
        note.dots += 1;
    } else if let Some(a) = acc {
        note.accidental = Some(a);
    } else {
        return false;
    }
    note.code.push(c.unwrap());
    note.source.length += 1;
    true
}

/// 从 `src[start]` 起读一个音符。`base_duration` 给倚音用（倚音默认八分音符）。
fn scan_note(ctx: &Ctx, src: &U16, start: usize, base_duration: u32) -> (NoteElement, usize) {
    let d = ctx.spec;
    let head = u16s::at(src, start).unwrap_or(b'0' as u16);
    let mut cursor = start + 1;
    let head_c = u16s::ch(head);
    let (pitch, sound, hidden, lyric_anchor);
    if head_c == Some(d.rhythm_token) && !u16s::digit(head) {
        pitch = 9;
        sound = Sound::Rhythm;
        hidden = false;
        lyric_anchor = true;
    } else if head_c == Some('9') {
        if d.nine_is_rhythm {
            pitch = 9; // 番茄：9 是节奏音符 X
            sound = Sound::Rhythm;
            hidden = false;
            lyric_anchor = true;
        } else {
            pitch = 0; // 有谱：9 是隐藏休止，且**不跟歌词**
            sound = Sound::Rest;
            hidden = true;
            lyric_anchor = false;
        }
    } else if head_c == Some('8') {
        pitch = 0; // 两家一致：8 是隐藏休止，**跟**歌词
        sound = Sound::Rest;
        hidden = true;
        lyric_anchor = true;
    } else {
        pitch = (head - b'0' as u16) as u32;
        sound = if pitch == 0 { Sound::Rest } else { Sound::Note };
        hidden = false;
        // 显形的休止 `0` 默认不跟词（写成 `0@` 才跟）
        lyric_anchor = pitch != 0;
    }
    let mut note = NoteElement {
        pitch,
        sound,
        hidden,
        placeholder: None,
        lyric_anchor,
        octave: 0,
        duration: base_duration,
        dots: 0,
        accidental: None,
        ornaments: vec![],
        grace_before: vec![],
        grace_after: vec![],
        stack: None,
        multi_rest: None,
        annotation: None,
        chord: None,
        key_label: None,
        annotation_source: None,
        chord_source: None,
        code: unit_str(head),
        source: ctx.span(start, 1),
    };
    while cursor < src.len() && apply_modifier(ctx, &mut note, src[cursor]) {
        cursor += 1;
    }
    (note, cursor)
}

/// 倚音串：`{3,4,}` 里的内容 / `[2]` 里的内容 / `"yy:3/2/"` 冒号后的内容。
fn scan_grace_notes(ctx: &mut Ctx, body: &U16, column_base: usize) -> Vec<NoteElement> {
    let mut out = vec![];
    let mut cursor = 0;
    while cursor < body.len() {
        let ch = body[cursor];
        if u16s::digit(ch) || u16s::ch(ch) == Some(ctx.spec.rhythm_token) {
            // 子上下文：行首偏移挪到 column_base（TS `{ ...ctx, lineOffset }`），列再补回
            ctx.line_offset += column_base as u32;
            let (mut note, next) = scan_note(ctx, body, cursor, 8); // 倚音默认八分
            ctx.line_offset -= column_base as u32;
            note.source.column += column_base as u32;
            out.push(note);
            cursor = next;
            continue;
        }
        if !u16s::space(ch) {
            ctx.report("unsupported-grace-token", Msg::new("diag.fanqie.graceChar").arg("ch", unit_str(ch)), column_base + cursor, 1);
        }
        cursor += 1;
    }
    out
}

// ---------------- 双引号内容 ----------------

#[derive(Default)]
struct QuotedMeaning {
    chord: Option<String>,
    meter: Option<Meter>,
    key: Option<String>,
    key_label: Option<String>,
    grace_before: Option<Vec<NoteElement>>,
    grace_after: Option<Vec<NoteElement>>,
    annotation: Option<String>,
    jumps: Option<Vec<(&'static str, f64, bool)>>,
}

fn annotation_of(body: &U16) -> QuotedMeaning {
    QuotedMeaning { annotation: Some(u16s::text(body)), ..Default::default() }
}

/// `/^\s*(\d+)\s*\/\s*(\d+)\s*$/`
fn parse_meter(raw: &U16, parenthesized: bool) -> Option<Meter> {
    let mut i = u16s::spaces(raw, 0);
    let n1 = u16s::digits(raw, i);
    if n1 == 0 {
        return None;
    }
    let a = &raw[i..i + n1];
    i += n1;
    i += u16s::spaces(raw, i);
    if !u16s::is(raw, i, '/') {
        return None;
    }
    i += 1;
    i += u16s::spaces(raw, i);
    let n2 = u16s::digits(raw, i);
    if n2 == 0 {
        return None;
    }
    let b = &raw[i..i + n2];
    i += n2;
    i += u16s::spaces(raw, i);
    if i != raw.len() {
        return None;
    }
    let numerator = u16s::num(a);
    let denominator = u16s::num(b);
    if !numerator.is_finite() || !denominator.is_finite() || denominator == 0.0 {
        return None;
    }
    Some(Meter { numerator, denominator, parenthesized })
}

/// ASCII 不分大小写的前缀
fn starts_ci(s: &U16, i: usize, p: &str) -> bool {
    (i..).zip(p.chars()).all(|(k, c)| u16s::at(s, k).and_then(u16s::ch).is_some_and(|x| x.eq_ignore_ascii_case(&c)))
}

/// 正则 `.`：不含行终结符
fn is_line_terminator(u: u16) -> bool {
    matches!(u, 0x0A | 0x0D | 0x2028 | 0x2029)
}

/// 双引号里可能是和弦 `hx:`、临时拍号 `p:`、曲中转调 `k:`、倚音（有谱 `yy:`/`hyy:`）或普通注释。
fn interpret_quoted(ctx: &mut Ctx, body: &U16, column_base: usize) -> QuotedMeaning {
    // `/^hx:\s*/i`
    if starts_ci(body, 0, "hx:") {
        let at = 3 + u16s::spaces(body, 3);
        return QuotedMeaning { chord: Some(u16s::text(&body[at..])), ..Default::default() };
    }
    if starts_ci(body, 0, "p:") {
        let at = 2 + u16s::spaces(body, 2);
        if let Some(m) = parse_meter(&body[at..], false) {
            return QuotedMeaning { meter: Some(m), ..Default::default() };
        }
        ctx.report("bad-temporary-meter", Msg::new("diag.fanqie.tempMeter").arg("body", u16s::text(body)), column_base, body.len());
        return annotation_of(body);
    }
    // `/^k:\s*([#b]?[1-7])\s*(?:;(.*))?$/i`
    if starts_ci(body, 0, "k:") {
        let mut i = 2 + u16s::spaces(body, 2);
        let ks = i;
        if u16s::at(body, i).is_some_and(|u| u == b'#' as u16 || u == b'b' as u16 || u == b'B' as u16) {
            i += 1;
        }
        // `[#b]?` 可回溯：`b` 后不是 1–7 时当没有（`b` 本身不是 1–7，回溯也配不上，同样失败）
        if u16s::within(u16s::at(body, i), '1', '7') {
            i += 1;
            let key_end = i;
            i += u16s::spaces(body, i);
            let mut label: Option<Option<String>> = None;
            if i == body.len() {
                label = Some(None);
            } else if u16s::is(body, i, ';') && body[i + 1..].iter().all(|&u| !is_line_terminator(u)) {
                label = Some(Some(u16s::text(&body[i + 1..])));
            }
            if let Some(label) = label {
                let key = u16s::text(&body[ks..key_end]);
                let key_label = label.map(|l| dolce_base::js::trim(&l).to_string()).filter(|l| !l.is_empty());
                return QuotedMeaning { key: Some(key), key_label, ..Default::default() };
            }
        }
    }
    // 诗歌本小节线文字：`ff:` 在下方、`ffs:` 在上方；冒号前 `+` 的个数或 `+6` 是再偏几层；`|` 分行。
    // `/^ff(s?)(?:\+(\d+)|(\++))?:(.*)$/i`
    if ctx.spec.jump_words && starts_ci(body, 0, "ff") {
        if let Some((below, level, rest)) = match_ff(body) {
            let words = u16s::text(rest);
            let names: Vec<Option<&'static str>> = words.split('|').map(|w| jump_word(&dolce_base::js::trim(w).to_lowercase())).collect();
            if !names.is_empty() && names.iter().all(|n| n.is_some()) {
                return QuotedMeaning { jumps: Some(names.into_iter().map(|n| (n.unwrap(), level, below)).collect()), ..Default::default() };
            }
            return annotation_of(body);
        }
    }
    // `/^(h?yy):\s*/i`
    let gy = if starts_ci(body, 0, "yy:") {
        Some((false, 3))
    } else if starts_ci(body, 0, "hyy:") {
        Some((true, 4))
    } else {
        None
    };
    if let Some((after, n)) = gy {
        let at = n + u16s::spaces(body, n);
        let notes = scan_grace_notes(ctx, &body[at..], column_base + at);
        return if after {
            QuotedMeaning { grace_after: Some(notes), ..Default::default() }
        } else {
            QuotedMeaning { grace_before: Some(notes), ..Default::default() }
        };
    }
    annotation_of(body)
}

/// `/^ff(s?)(?:\+(\d+)|(\++))?:(.*)$/i` → (在下方, 层数, 冒号后)
fn match_ff(body: &U16) -> Option<(bool, f64, &U16)> {
    let tail_ok = |rest: &U16| rest.iter().all(|&u| !is_line_terminator(u));
    // `(s?)` 先取后不取
    for take_s in [true, false] {
        let mut i = 2;
        if take_s {
            if !starts_ci(body, i, "s") {
                continue;
            }
            i += 1;
        }
        // `(?:\+(\d+)|(\++))?`：先 `+数字`，再 `+…`，再不取
        let mut options: Vec<(usize, f64)> = vec![];
        if u16s::is(body, i, '+') {
            let n = u16s::digits(body, i + 1);
            if n > 0 {
                // `\d+` 贪婪，后面要 `:`，回吐数字也不会遇到 `:`
                options.push((i + 1 + n, u16s::num(&body[i + 1..i + 1 + n])));
            }
            let mut k = i;
            while u16s::is(body, k, '+') {
                k += 1;
            }
            // `\++` 贪婪；回吐 `+` 后下一个是 `+` 不是 `:`，不必试
            options.push((k, (k - i) as f64));
        }
        options.push((i, 0.0));
        for (j, level) in options {
            if u16s::is(body, j, ':') && tail_ok(&body[j + 1..]) {
                return Some((!take_s, level, &body[j + 1..]));
            }
        }
    }
    None
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AttachKind {
    Note,
    Sustain,
    Barline,
}

fn apply_quoted(target: &mut MusicElement, q: QuotedMeaning, source: SourceSpan) {
    let kind = match target {
        MusicElement::Note(_) => AttachKind::Note,
        MusicElement::Sustain(_) => AttachKind::Sustain,
        _ => AttachKind::Barline,
    };
    if let (Some(m), MusicElement::Barline(b)) = (&q.meter, &mut *target) {
        b.temporary_meter = Some(m.clone());
    }
    if let (Some(k), MusicElement::Barline(b)) = (&q.key, &mut *target) {
        b.temporary_key = Some(k.clone());
        if let Some(l) = &q.key_label {
            b.annotation = Some(l.clone());
        }
    }
    for (name, level, below) in q.jumps.unwrap_or_default() {
        let orn = Ornament { name: name.into(), level, source, below: if below { Some(true) } else { None } };
        ornaments_mut(target).unwrap().push(orn);
    }
    if let Some(a) = q.annotation {
        match target {
            MusicElement::Note(n) => {
                n.annotation = Some(a);
                n.annotation_source = Some(source);
            }
            MusicElement::Sustain(s) => {
                s.annotation = Some(a);
                s.annotation_source = Some(source);
            }
            MusicElement::Barline(b) => b.annotation = Some(a),
            _ => {}
        }
    }
    // 和弦既可挂音符，也可挂增时线
    if let Some(c) = q.chord {
        match target {
            MusicElement::Note(n) => {
                n.chord = Some(c);
                n.chord_source = Some(source);
            }
            MusicElement::Sustain(s) => {
                s.chord = Some(c);
                s.chord_source = Some(source);
            }
            _ => {}
        }
    }
    if kind != AttachKind::Note {
        return;
    }
    if let MusicElement::Note(n) = target {
        if let Some(g) = q.grace_before {
            n.grace_before.extend(g);
        }
        if let Some(g) = q.grace_after {
            n.grace_after.extend(g);
        }
    }
}

fn ornaments_mut(el: &mut MusicElement) -> Option<&mut Vec<Ornament>> {
    match el {
        MusicElement::Note(n) => Some(&mut n.ornaments),
        MusicElement::Sustain(s) => Some(&mut s.ornaments),
        MusicElement::Barline(b) => Some(&mut b.ornaments),
        _ => None,
    }
}

// ---------------- 行内记号栈 ----------------

#[derive(Clone, Debug)]
pub struct OpenMark {
    kind: MarkType,
    start: usize,
    level: f64,
    column: usize,
    caption: Option<String>,
    open_end: bool,
    from_previous: bool,
    /// 跨行时已经落在各行 `marks` 里的「半条弧」（按 `Mark.uid`）；到最后也没等到 `)` 就全撤掉
    pending: Vec<u32>,
}

pub struct MusicLineResult {
    pub elements: Vec<MusicElement>,
    pub marks: Vec<Mark>,
    /// 未闭合的弧线/多连音，交给下一行
    pub carried_curves: Vec<OpenMark>,
    /// 未闭合的跳房子，同样跨行
    pub carried_voltas: Vec<OpenMark>,
}

fn make_mark(open: &OpenMark, end: usize, ctx: &mut Ctx, to_next: bool) -> Mark {
    Mark {
        kind: open.kind,
        start: open.start as i64,
        end: end as i64,
        level: open.level,
        caption: open.caption.clone(),
        open_end: if open.open_end { Some(true) } else { None },
        continuation_from_previous: if open.from_previous { Some(true) } else { None },
        continuation_to_next: if to_next { Some(true) } else { None },
        source: ctx.span(open.column, 1),
        close_source: None,
        digits: None,
        uid: ctx.uid(),
    }
}

/// 下标闭区间 [from, to] 里有音的小节数
fn measures_in(elements: &[MusicElement], from: usize, to: usize) -> usize {
    let mut n = 0;
    let mut inside = false;
    let mut i = from;
    while i <= to && i < elements.len() {
        match elements[i] {
            MusicElement::Barline(_) => inside = false,
            MusicElement::Note(_) | MusicElement::Sustain(_) if !inside => {
                n += 1;
                inside = true;
            }
            _ => {}
        }
        i += 1;
    }
    n
}

/// 最后一个可挂记号的元素（音符/增时线/小节线）的下标
fn last_attachable(elements: &[MusicElement]) -> Option<usize> {
    elements.iter().rposition(|e| matches!(e, MusicElement::Note(_) | MusicElement::Sustain(_) | MusicElement::Barline(_)))
}

fn read_quoted_run(src: &U16, index: usize) -> Option<(&U16, usize)> {
    if !u16s::is(src, index, '"') {
        return None;
    }
    let end = u16s::find(src, '"', index + 1)?;
    Some((&src[index + 1..end], end + 1))
}

fn count_pluses(src: &U16, index: usize) -> (f64, usize) {
    let mut n = index;
    while u16s::is(src, n, '+') {
        n += 1;
    }
    ((n - index) as f64, n)
}

/// `/^[A-G][#b]?(?:maj|min|sus|dim|aug|add|m|M)?\d*(?:\/[A-G][#b]?)?/` 的长度
fn bare_chord_len(s: &U16, i: usize) -> Option<usize> {
    let upper = |k: usize| u16s::within(u16s::at(s, k), 'A', 'G');
    if !upper(i) {
        return None;
    }
    let mut k = i + 1;
    if u16s::one_of(u16s::at(s, k), "#b") {
        k += 1;
    }
    for q in ["maj", "min", "sus", "dim", "aug", "add", "m", "M"] {
        if u16s::starts(s, k, q) {
            k += q.len();
            break;
        }
    }
    k += u16s::digits(s, k);
    if u16s::is(s, k, '/') && upper(k + 1) {
        k += 2;
        if u16s::one_of(u16s::at(s, k), "#b") {
            k += 1;
        }
    }
    Some(k - i)
}

/// 解析一行曲。`carried_*` 传入上一行留下的未闭合记号。
pub fn parse_music_line(ctx: &mut Ctx, src: &U16, start_column: usize, carried_curves: &[OpenMark], carried_voltas: &[OpenMark]) -> MusicLineResult {
    let d = ctx.spec;
    let mut elements: Vec<MusicElement> = vec![];
    let mut marks: Vec<Mark> = vec![];
    let mut curves: Vec<OpenMark> = carried_curves.iter().map(|m| OpenMark { start: 0, from_previous: true, ..m.clone() }).collect();
    let mut voltas: Vec<OpenMark> = carried_voltas.iter().map(|m| OpenMark { start: 0, from_previous: true, ..m.clone() }).collect();
    let mut wedges: Vec<OpenMark> = vec![];
    let new_open = |kind: MarkType, start: usize, level: f64, column: usize| OpenMark {
        kind,
        start,
        level,
        column,
        caption: None,
        open_end: false,
        from_previous: false,
        pending: vec![],
    };

    let mut i = start_column;
    while i < src.len() {
        let ch = src[i];
        let c = u16s::ch(ch);

        if u16s::space(ch) {
            i += 1;
            continue;
        }

        // 数字音符 / 节奏音符
        if u16s::digit(ch) || c == Some(d.rhythm_token) {
            let (note, next) = scan_note(ctx, src, i, 4);
            elements.push(MusicElement::Note(note));
            i = next;
            continue;
        }

        // 增时线
        if c == Some('-') {
            elements.push(MusicElement::Sustain(SustainElement {
                duration: 4,
                lyric_anchor: false,
                ornaments: vec![],
                annotation: None,
                chord: None,
                annotation_source: None,
                chord_source: None,
                code: "-".into(),
                source: ctx.span(i, 1),
            }));
            i += 1;
            continue;
        }

        // `@`：强制让前一个符号跟一个歌词
        if c == Some('@') {
            match elements.last_mut() {
                Some(MusicElement::Note(n)) => {
                    n.lyric_anchor = true;
                    n.code.push('@');
                    n.source.length += 1;
                }
                Some(MusicElement::Sustain(s)) => {
                    s.lyric_anchor = true;
                    s.code.push('@');
                    s.source.length += 1;
                }
                _ => ctx.report("orphan-lyric-anchor", Msg::new("diag.fanqie.orphanAnchor"), i, 1),
            }
            i += 1;
            continue;
        }

        // 强制连/断拍
        if c == Some('~') || c == Some('^') {
            let join = c == Some('~');
            elements.push(MusicElement::BeatBoundary(BeatBoundaryElement {
                behavior: if join { Behavior::Join } else { Behavior::Split },
                code: if join { "~" } else { "^" }.into(),
                source: ctx.span(i, 1),
            }));
            i += 1;
            continue;
        }

        // 小节线（含 :| 开头的）
        if c == Some('|') || c == Some(':') {
            if let Some((code, kind)) = d.barlines.iter().find(|(code, _)| u16s::starts(src, i, code)) {
                elements.push(MusicElement::Barline(BarlineElement {
                    kind: *kind,
                    ornaments: vec![],
                    temporary_meter: None,
                    temporary_key: None,
                    annotation: None,
                    repeat_forward_after: None,
                    code: (*code).into(),
                    source: ctx.span(i, code.len()),
                }));
                i += code.len();
                continue;
            }
            ctx.report("bad-barline", Msg::new("diag.fanqie.badBarline").arg("ch", unit_str(ch)), i, 1);
            i += 1;
            continue;
        }

        // 弧线 / 多连音
        if c == Some('(') {
            let is_tuplet = u16s::is(src, i + 1, 'y');
            let level = (curves.len() + 1) as f64;
            curves.push(new_open(if is_tuplet { MarkType::Tuplet } else { MarkType::Slur }, elements.len(), level, i));
            i += if is_tuplet { 2 } else { 1 };
            continue;
        }
        if c == Some(')') {
            // **先开的先闭**（队列，不是栈）：首尾相接的几条 tie 不配成一条长弧（《太阳出来喜洋洋》末行）
            if curves.is_empty() {
                ctx.report("unmatched-slur-end", Msg::new("diag.fanqie.extraParen"), i, 1);
            } else {
                let mut open = curves.remove(0);
                // 队首闭合，它前面没有别的未闭合弧线，层号固定在第一层
                open.level = 1.0;
                let mut mk = make_mark(&open, elements.len().saturating_sub(1), ctx, false);
                mk.close_source = Some(ctx.span(i, 1));
                marks.push(mk);
            }
            i += 1;
            continue;
        }

        // 渐强渐弱：`<`/`>` 起，`!` 止；后跟的 `+` 越多位置越高
        if c == Some('<') || c == Some('>') {
            let (level, next) = count_pluses(src, i + 1);
            let kind = if c == Some('<') { MarkType::Crescendo } else { MarkType::Decrescendo };
            wedges.push(new_open(kind, elements.len().saturating_sub(1), level, i));
            i = next;
            continue;
        }
        if c == Some('!') {
            match wedges.pop() {
                None => ctx.report("unmatched-wedge-end", Msg::new("diag.fanqie.extraBang"), i, 1),
                Some(open) => {
                    let mk = make_mark(&open, elements.len().saturating_sub(1), ctx, false);
                    marks.push(mk);
                }
            }
            i += 1;
            continue;
        }

        // 倚音（番茄）：`1[2]` 前倚音、`1[h2]` 后倚音。靠**是否紧贴音符**与跳房子区分
        if c == Some('[') {
            let adjacent = matches!(elements.last(), Some(MusicElement::Note(n)) if (n.source.column + n.source.length) as usize == i);
            if adjacent {
                let Some(end) = u16s::find(src, ']', i + 1) else {
                    ctx.report("unterminated-grace", Msg::new("diag.fanqie.graceOpen"), i, 1);
                    i += 1;
                    continue;
                };
                let mut body = &src[i + 1..end];
                let mut after = false;
                if u16s::one_of(u16s::at(body, 0), "hH") {
                    after = true;
                    body = &body[1..];
                }
                let notes = scan_grace_notes(ctx, body, i + 1 + if after { 1 } else { 0 });
                let Some(MusicElement::Note(prev)) = elements.last_mut() else { unreachable!() };
                if after {
                    prev.grace_after.extend(notes);
                } else {
                    prev.grace_before.extend(notes);
                }
                prev.code.push_str(&u16s::text(&src[i..end + 1]));
                prev.source.length += (end + 1 - i) as u32;
                i = end + 1;
                continue;
            }
        }

        // 跳房子：`[` 起（可跟 `+` 抬高与 `"房号"`），`]` 止（`]/` 不封口）
        if c == Some('[') {
            let open_end = u16s::is(src, i + 1, '/');
            let (level, next) = count_pluses(src, i + if open_end { 2 } else { 1 });
            let mut cursor = next;
            let mut caption = None;
            if let Some((body, after)) = read_quoted_run(src, cursor) {
                caption = Some(u16s::text(body));
                cursor = after;
            }
            let mut open = new_open(MarkType::Volta, elements.len(), level, i);
            open.caption = caption;
            open.open_end = open_end;
            voltas.push(open);
            i = cursor;
            continue;
        }
        if c == Some(']') {
            let mut cursor = i + 1;
            let mut open_end = false;
            if u16s::is(src, cursor, '/') {
                open_end = true;
                cursor += 1;
            }
            match voltas.pop() {
                None => ctx.report("unmatched-volta-end", Msg::new("diag.fanqie.extraBracket"), i, 1),
                Some(mut open) => {
                    let end = elements.len().saturating_sub(1);
                    if open_end {
                        open.open_end = true;
                    }
                    // 番茄：只罩一小节的房 `/` 不生效（跨行来的至少两小节）
                    if d.open_volta_needs_two_measures && !open.from_previous && measures_in(&elements, open.start, end) < 2 {
                        open.open_end = false;
                    }
                    let mk = make_mark(&open, end, ctx, false);
                    marks.push(mk);
                }
            }
            i = cursor;
            continue;
        }

        // `&xx` 记号（音符或小节线上）
        if c == Some('&') {
            // 裸 `&`（其后可跟 `+`）：`/^&(\++)?(?=["\s]|$|[0-9])/`
            let (lvl, after) = count_pluses(src, i + 1);
            let la = u16s::at(src, after);
            if la.is_none() || la.is_some_and(|u| u == b'"' as u16 || u16s::space(u) || u16s::digit(u)) {
                if let Some(h) = last_attachable(&elements) {
                    if lvl > 0.0 {
                        if let Some(o) = ornaments_mut(&mut elements[h]).unwrap().last_mut() {
                            o.level += lvl;
                        }
                    }
                }
                i = after;
                continue;
            }
            // 已知命令按**最长优先**匹配，免得 `&ycd` 把八度字母 d 吞进命令名。
            let tail = &src[i + 1..];
            let lower: String = u16s::text(&tail[..tail.len().min(8)]).to_lowercase();
            let mut known = "";
            for cand in all_commands() {
                if cand.len() > known.len() && lower.starts_with(cand) {
                    known = cand;
                }
            }
            let m_len = if !known.is_empty() {
                Some(1 + known.len())
            } else {
                match_command_word(src, i)
            };
            let Some(m_len) = m_len else {
                i += 1;
                continue;
            };
            let raw_name = u16s::text(&src[i + 1..(i + m_len).min(src.len())]);
            let name: String = raw_name.chars().filter(|&c| !dolce_base::js::is_space(c)).collect::<String>().to_lowercase();
            let (level, next) = count_pluses(src, i + m_len);
            let orn = Ornament { name: name.clone(), level, source: ctx.span(i, next - i), below: None };
            match last_attachable(&elements) {
                None => ctx.report("orphan-command", Msg::new("diag.fanqie.orphanCommand").arg("name", raw_name), i, next - i),
                Some(_) if d.jump_words && JUMP_WORD_COMMANDS.contains(&name.as_str()) => {
                    // 诗歌本的跳转字只认小节线文字 `"ff:Fine"`，记号写法不认
                    ctx.report("unknown-command", Msg::new("diag.fanqie.unknownCommand").arg("name", raw_name), i, next - i)
                }
                Some(t) => {
                    if !is_note_command(&name) && !BARLINE_COMMANDS.contains(&name.as_str()) {
                        ctx.report("unknown-command", Msg::new("diag.fanqie.unknownCommand").arg("name", raw_name), i, next - i);
                    }
                    ornaments_mut(&mut elements[t]).unwrap().push(orn);
                }
            }
            i = next;
            continue;
        }

        // 双引号：注释 / 和弦 / 临时拍号 / 有谱倚音
        if c == Some('"') {
            let Some((body, next)) = read_quoted_run(src, i) else {
                ctx.report("unterminated-quote", Msg::new("diag.fanqie.quoteOpen"), i, 1);
                i = src.len();
                continue;
            };
            let mut meaning = interpret_quoted(ctx, body, i + 1);
            let target = last_attachable(&elements);
            // 转调只认写在小节线上的；挂到音符上的照普通注释印出来，并提示
            if meaning.key.is_some() && target.is_some_and(|t| !matches!(elements[t], MusicElement::Barline(_))) {
                ctx.report("key-change-off-barline", Msg::new("diag.fanqie.keyOffBarline").arg("body", u16s::text(body)), i + 1, body.len());
                meaning = annotation_of(body);
            }
            match target {
                None => ctx.report("orphan-annotation", Msg::new("diag.fanqie.orphanAnnotation").arg("body", u16s::text(body)), i, 1),
                Some(t) => {
                    let s = ctx.span(i, next - i);
                    apply_quoted(&mut elements[t], meaning, s);
                }
            }
            i = next;
            continue;
        }

        // `{bz…}` 临时伴奏 / `{dsb…}` 临时多声部
        if c == Some('{') {
            let Some(end) = u16s::find(src, '}', i + 1) else {
                ctx.report("unterminated-layer", Msg::new("diag.fanqie.layerOpen"), i, 1);
                i = src.len();
                continue;
            };
            let inner = &src[i + 1..end];
            // `/^\s*(bz|dsb)/i`
            let sp = u16s::spaces(inner, 0);
            let role_len = if starts_ci(inner, sp, "bz") {
                Some((LayerRole::Accompaniment, sp + 2))
            } else if starts_ci(inner, sp, "dsb") {
                Some((LayerRole::Voice, sp + 3))
            } else {
                None
            };
            // 不写 bz/dsb 的 `{…}` 按并排块读
            let role = role_len.map_or(LayerRole::Voice, |r| r.0);
            let mut body_start = role_len.map_or(0, |r| r.1);
            // 层首的 `|` 就是层外前面那条小节线（原谱只印一条），不进层：`/^\s*\|(?![:|/*])/`
            let rest = &inner[body_start..];
            let lsp = u16s::spaces(rest, 0);
            if u16s::is(rest, lsp, '|') && !u16s::one_of(u16s::at(rest, lsp + 1), ":|/*")
                && last_attachable(&elements).is_some_and(|t| matches!(elements[t], MusicElement::Barline(_))) {
                    body_start += lsp + 1;
                }
            let sub = parse_music_line(ctx, &src[..end], i + 1 + body_start, &[], &[]);
            elements.push(MusicElement::InlineLayer(InlineLayerElement {
                role,
                below: None,
                elements: sub.elements,
                ids: None,
                marks: sub.marks,
                code: u16s::text(&src[i..end + 1]),
                source: ctx.span(i, end + 1 - i),
            }));
            i = end + 1;
            continue;
        }

        // 不带引号的和弦名：`3Dm1`、`1Am.5/`、`3D/A2`。挂到前一个音符上，与 `"hx:…"` 等价。
        if u16s::within(Some(ch), 'A', 'G') {
            let len = bare_chord_len(src, i);
            if let (Some(len), Some(h)) = (len, last_attachable(&elements)) {
                if let MusicElement::Note(n) = &mut elements[h] {
                    n.chord = Some(u16s::text(&src[i..i + len]));
                    n.chord_source = Some(ctx.span(i, len));
                    i += len;
                    continue;
                }
            }
        }

        // `5&rit/`：落单的修饰符回补给上一个音符；`~`/`^` 跨过，小节线不跨
        let back = elements.iter().rposition(|e| !matches!(e, MusicElement::BeatBoundary(_)));
        if let Some(b) = back {
            if let MusicElement::Note(prev) = &mut elements[b] {
                if apply_modifier(ctx, prev, ch) {
                    i += 1;
                    continue;
                }
            }
        }

        ctx.report("unexpected-char", Msg::new("diag.fanqie.badChar").arg("ch", unit_str(ch)), i, 1);
        i += 1;
    }

    // 行末仍未闭合的：弧线与跳房子都支持跨行，记为「延续到下一行」
    let last_index = elements.len().saturating_sub(1);
    for open in curves.iter_mut() {
        let mark = make_mark(open, last_index, ctx, true);
        open.pending.push(mark.uid);
        marks.push(mark);
    }
    for open in &voltas {
        let mk = make_mark(open, last_index, ctx, true);
        marks.push(mk);
    }
    for open in &wedges {
        ctx.report("unclosed-wedge", Msg::new("diag.fanqie.wedgeOpen"), open.column, 1);
        let mk = make_mark(open, last_index, ctx, false);
        marks.push(mk);
    }

    MusicLineResult { elements, marks, carried_curves: curves, carried_voltas: voltas }
}

/// `/^&(?:a\s+tempo|[A-Za-z]+)/` 的长度
fn match_command_word(src: &U16, i: usize) -> Option<usize> {
    if u16s::is(src, i + 1, 'a') {
        let sp = u16s::spaces(src, i + 2);
        if sp > 0 && u16s::starts(src, i + 2 + sp, "tempo") {
            return Some(2 + sp + 5);
        }
    }
    let mut k = i + 1;
    while u16s::at(src, k).is_some_and(|u| (u as u8 as u16 == u) && (u as u8).is_ascii_alphabetic()) {
        k += 1;
    }
    if k > i + 1 {
        Some(k - i)
    } else {
        None
    }
}

// ---------------- 歌词 ----------------

/// 能自动附到前一个字后面、不占音符位的标点（`common/cjkpunct.ts::FANQIE_LYRIC_PUNCTUATION`）
pub const LYRIC_PUNCTUATION: &str = "，。！？、；：,.!?;:…—～~《》()（）";
/// 引号。左引号领起下一个字，右引号贴前一个字
pub const LYRIC_QUOTES: &str = "“”‘’\"";

fn is_cjk(cp: u32) -> bool {
    (0x3400..=0x9fff).contains(&cp) || (0xf900..=0xfaff).contains(&cp) || (0x3040..=0x30ff).contains(&cp)
}

/// `src.codePointAt(i)`（越界 `None`）与它占的码元数
fn code_point_at(src: &U16, i: usize) -> Option<(u32, usize)> {
    let hi = *src.get(i)?;
    if (0xD800..0xDC00).contains(&hi) {
        if let Some(&lo) = src.get(i + 1) {
            if (0xDC00..0xE000).contains(&lo) {
                return Some((0x10000 + ((hi as u32 - 0xD800) << 10) + (lo as u32 - 0xDC00), 2));
            }
        }
    }
    Some((hi as u32, 1))
}

fn ascii_letter_or_apos(u: u16) -> bool {
    u < 0x80 && ((u as u8).is_ascii_alphabetic() || u == b'\'' as u16)
}

/// 解析一行歌词。两家共同：一个汉字对应一个音符；标点自动附到前字；`@` 跳过一个音符。
/// 分歧：番茄用 `~` 把两字并作一个音符、`/` 分隔英文单词；有谱用 `{哆啊}` 并字、`/` 也是跳过、英文靠空格分词。
pub fn parse_lyric_body(ctx: &mut Ctx, src: &U16, start_column: usize) -> Vec<LyricSyllable> {
    let d = ctx.spec;
    let mut out: Vec<LyricSyllable> = vec![];
    let push = |out: &mut Vec<LyricSyllable>, ctx: &Ctx, text: String, column: usize, length: usize| {
        out.push(LyricSyllable { text, trailing_punctuation: None, source: ctx.span(column, length) });
    };
    let trail = |out: &mut Vec<LyricSyllable>, s: String| -> bool {
        if let Some(prev) = out.last_mut() {
            prev.trailing_punctuation = Some(prev.trailing_punctuation.take().unwrap_or_default() + &s);
            prev.source.length += 1;
            true
        } else {
            false
        }
    };

    let mut i = start_column;
    while i < src.len() {
        let ch = src[i];
        let c = u16s::ch(ch);

        if c.is_some_and(|c| d.lyric_skip.contains(&c)) {
            push(&mut out, ctx, String::new(), i, 1); // 空音节 = 跳过一个音符
            i += 1;
            continue;
        }
        if c == Some(d.word_separator) {
            i += 1;
            continue;
        }
        if u16s::space(ch) {
            i += 1;
            continue;
        }
        // `-` `0` `^` `|` `*` 是照抄曲行的增时线/休止/小节线，歌词侧直接略过。
        if u16s::one_of(Some(ch), "-0^|*") {
            i += 1;
            continue;
        }
        // 括号：左括号领起后一个字，右括号贴前一个字
        if c == Some('(') || c == Some('（') {
            let mut j = i + 1;
            while j < src.len() && u16s::space(src[j]) {
                j += 1;
            }
            let Some((_, len)) = code_point_at(src, j) else {
                i += 1;
                continue;
            };
            let text = unit_str(ch) + &u16s::text(&src[j..j + len]);
            push(&mut out, ctx, text, i, j + len - i);
            i = j + len;
            continue;
        }
        if c == Some(')') || c == Some('）') {
            trail(&mut out, unit_str(ch));
            i += 1;
            continue;
        }
        // 行中的 `<…>` 说明文字：整体略过，不占音符位。
        if c == Some('<') {
            match u16s::find(src, '>', i + 1) {
                None => {
                    ctx.report("unterminated-lyric-annotation", Msg::new("diag.fanqie.lyricNoteOpen"), i, 1);
                    i += 1;
                }
                Some(end) => i = end + 1,
            }
            continue;
        }
        // 行内的 `[hy]` / `[hy!]`：整体略过。`/^\[[A-Za-z]+!?\]/`
        if c == Some('[') {
            let mut k = i + 1;
            while u16s::at(src, k).is_some_and(|u| u < 0x80 && (u as u8).is_ascii_alphabetic()) {
                k += 1;
            }
            if k > i + 1 {
                let mut e = k;
                if u16s::is(src, e, '!') {
                    e += 1;
                }
                if u16s::is(src, e, ']') {
                    i = e + 1;
                    continue;
                }
                // `!?` 可回溯：取了 `!` 后不是 `]` 时不取（不取时下一个是 `!`，也不是 `]`）
            }
        }
        // 行末落单的 `}`：联合括号，不是并字，也不占音符位
        if c == Some('}') {
            i += 1;
            continue;
        }
        // 并字：有谱 `{哆啊}`
        if c == Some('{') {
            match u16s::find(src, '}', i + 1) {
                None => {
                    ctx.report("unterminated-lyric-group", Msg::new("diag.fanqie.lyricGroupOpen"), i, 1);
                    i += 1;
                }
                Some(end) => {
                    push(&mut out, ctx, u16s::text(&src[i + 1..end]), i, end + 1 - i);
                    i = end + 1;
                }
            }
            continue;
        }
        // 标点：附到前一个音节，不占音符位
        if c.is_some_and(|c| LYRIC_PUNCTUATION.contains(c)) {
            if !trail(&mut out, unit_str(ch)) {
                push(&mut out, ctx, unit_str(ch), i, 1);
            }
            i += 1;
            continue;
        }
        // 引号：左引号领起下一个字，右引号贴前一个字
        if c.is_some_and(|c| LYRIC_QUOTES.contains(c)) {
            // 直引号 `"` 在词首（行首，或前面是空白、分词符、标点、并字括号）且紧跟着字母或汉字时也是左引号（`say,"Come`）
            let word_start = i == start_column || {
                let p = src[i - 1];
                u16s::space(p) || u16s::ch(p).is_some_and(|p| p == d.word_separator || p == '}' || LYRIC_PUNCTUATION.contains(p))
            };
            let next_is_word = src.get(i + 1).is_some_and(|&u| ascii_letter_or_apos(u)) || code_point_at(src, i + 1).is_some_and(|(cp, _)| is_cjk(cp));
            let ascii_open = c == Some('"') && word_start && next_is_word;
            let is_open = c == Some('“') || c == Some('‘') || ascii_open;
            if is_open {
                let start = i;
                i += 1;
                while i < src.len() && u16s::space(src[i]) {
                    i += 1;
                }
                if i < src.len() {
                    // 引号领起的英文单词整个算一个音节
                    let mut end = i + 1;
                    if ascii_letter_or_apos(src[i]) {
                        while end < src.len() && ascii_letter_or_apos(src[end]) {
                            end += 1;
                        }
                    }
                    let text = unit_str(ch) + &u16s::text(&src[i..end]);
                    push(&mut out, ctx, text, start, end - start);
                    i = end;
                }
            } else {
                trail(&mut out, unit_str(ch));
                i += 1;
            }
            continue;
        }
        // 英文单词：连续 ASCII 字母算一个音节
        if ascii_letter_or_apos(ch) {
            let mut end = i;
            while end < src.len() && ascii_letter_or_apos(src[end]) {
                end += 1;
            }
            push(&mut out, ctx, u16s::text(&src[i..end]), i, end - i);
            i = end;
            continue;
        }
        // 汉字 / 其余可见字符：一个字一个音符
        let (cp, ch_len) = code_point_at(src, i).unwrap();
        let text = u16s::text(&src[i..i + ch_len]);
        if !is_cjk(cp) && cp < 0x7f {
            ctx.report("unexpected-lyric-char", Msg::new("diag.fanqie.lyricChar").arg("text", text.clone()), i, ch_len);
        }
        // 并字连接号（番茄的 `~`）：把本字并到前一个音节
        if d.join_token.is_some_and(|j| ch_len == 1 && c == Some(j)) {
            i += ch_len;
            if let Some((_, next_len)) = code_point_at(src, i) {
                let next = u16s::text(&src[i..i + next_len]);
                if let Some(prev) = out.last_mut() {
                    prev.text.push_str(&next);
                    prev.source.length += 1 + next_len as u32;
                } else {
                    push(&mut out, ctx, next, i, next_len);
                }
                i += next_len;
            }
            continue;
        }
        push(&mut out, ctx, text, i, ch_len);
        i += ch_len;
    }
    out
}

/// 歌词行前置说明：番茄 `"狼:"`（空格写作 `_`）；有谱 `<狼:1.%40>`（`%50` 为间隙）。回 (说明, 间隙, 下一处)
fn strip_lyric_annotation(ctx: &mut Ctx, src: &U16, start_column: usize) -> (Option<String>, f64, usize) {
    let mut i = start_column;
    while i < src.len() && u16s::space(src[i]) {
        i += 1;
    }
    let open = u16s::at(src, i);
    if open != Some(b'"' as u16) && open != Some(b'<' as u16) {
        return (None, 20.0, start_column);
    }
    let close = if open == Some(b'"' as u16) { '"' } else { '>' };
    let Some(end) = u16s::find(src, close, i + 1) else {
        ctx.report("unterminated-lyric-annotation", Msg::new("diag.fanqie.lyricNoteOpen"), i, 1);
        return (None, 20.0, start_column);
    };
    let mut body = &src[i + 1..end];
    let mut gap = 20.0;
    // `/%(\d+)\s*$/`
    {
        let mut b = body.len();
        while b > 0 && u16s::space(body[b - 1]) {
            b -= 1;
        }
        let mut a = b;
        while a > 0 && u16s::digit(body[a - 1]) {
            a -= 1;
        }
        if a < b && a > 0 && u16s::is(body, a - 1, '%') {
            gap = u16s::num(&body[a..b]);
            body = &body[..a - 1];
        }
    }
    // 番茄用 `_` 代替空格；有谱的 `%40` 是 URL 编码的 `@`
    let text = u16s::text(body).replace('_', " ").replace("%40", "@");
    (Some(text), gap, end + 1)
}

// ---------------- 头部 ----------------

const METADATA_KEYS: &[&str] = &["V", "B", "Z", "D", "P", "J", "T", "XL", "XR", "TL", "TR", "BL", "BC", "BR", "FONTSIZE", "MARGIN", "SPACE", "OFF"];

const KEY_ACC: &str = "b#$♭♯";

/// `1=Cb4/4 3/4 可跟文字`：有谱把调号与（多个）拍号写在一行。
fn parse_shige_key_line(meta: &mut Metadata, value: &str, tonic: &str) {
    let v: Vec<u16> = u16s::enc(dolce_base::js::trim(value));
    // `/^([b#$♭♯])([A-G])/` 或 `/^([A-Ga-g])([b#$♭♯]?)/`
    let mut consumed = 0;
    if u16s::one_of(u16s::at(&v, 0), KEY_ACC) && u16s::within(u16s::at(&v, 1), 'A', 'G') {
        meta.mode = Some(u16s::text(&v[..2]));
        consumed = 2;
    } else if u16s::within(u16s::at(&v, 0), 'A', 'G') || u16s::within(u16s::at(&v, 0), 'a', 'g') {
        let letter = unit_str(v[0]).to_uppercase();
        if u16s::one_of(u16s::at(&v, 1), KEY_ACC) {
            meta.mode = Some(unit_str(v[1]) + &letter);
            consumed = 2;
        } else {
            meta.mode = Some(letter);
            consumed = 1;
        }
    }
    if tonic != "1" {
        meta.tonic = Some(tonic.into());
    }
    let rest = &v[consumed..];
    let mut tail: Option<&U16> = None;
    // `/(\d+)\s*\/\s*(\d+)/g`
    let mut k = 0;
    while k < rest.len() {
        let n1 = u16s::digits(rest, k);
        if n1 == 0 {
            k += 1;
            continue;
        }
        // 自左往右第一处能配上的：从 k 起 \d+（贪婪，回吐数字后下一个是数字，不会是 `/` 或空白）
        let mut j = k + n1;
        j += u16s::spaces(rest, j);
        if u16s::is(rest, j, '/') {
            let mut j2 = j + 1;
            j2 += u16s::spaces(rest, j2);
            let n2 = u16s::digits(rest, j2);
            if n2 > 0 {
                meta.meters.push(Meter { numerator: u16s::num(&rest[k..k + n1]), denominator: u16s::num(&rest[j2..j2 + n2]), parenthesized: false });
                let e = j2 + n2;
                tail = Some(&rest[e..]);
                k = e;
                continue;
            }
        }
        // 这一处起配不上：从下一个码元再找（`12/x` 时从 `2` 再试）
        k += 1;
    }
    // 末个拍号后面的说明文字（「混合拍」）：短、不含数字，原样留着
    if let Some(t) = tail {
        let note = u16s::trim(t);
        if !note.is_empty() && !note.iter().any(|&u| u16s::digit(u)) && note.len() <= 8 {
            meta.time_note = Some(u16s::text(note));
        }
    }
}

fn apply_metadata(ctx: &mut Ctx, meta: &mut Metadata, key: &str, value: &str, column: usize) {
    let v = dolce_base::js::trim(value);
    let vu = u16s::enc(v);
    match key.to_ascii_uppercase().as_str() {
        "V" => meta.version = Some(v.into()),
        "B" | "T" => meta.titles.push(v.into()),
        "Z" => meta.authors.push(v.into()),
        "D" => {
            // `/^(?:[A-G][#$b♭♯]?|[#$b♭♯][A-G])$/`
            let ok = match vu.len() {
                1 => u16s::within(u16s::at(&vu, 0), 'A', 'G'),
                2 => {
                    (u16s::within(u16s::at(&vu, 0), 'A', 'G') && u16s::one_of(u16s::at(&vu, 1), "#$b♭♯"))
                        || (u16s::one_of(u16s::at(&vu, 0), "#$b♭♯") && u16s::within(u16s::at(&vu, 1), 'A', 'G'))
                }
                _ => false,
            };
            if !ok {
                ctx.report("bad-mode", Msg::new("diag.fanqie.badKey").arg("v", v), column, vu.len());
            }
            meta.mode = Some(v.into());
        }
        "P" => {
            // `P: 4/4 2/4` 或 `P: 4/4 ( 2/4 1/4 )`
            let mut in_paren = false;
            for tok in split_ws(&vu) {
                if u16s::is(tok, 0, '(') {
                    in_paren = true;
                }
                let stripped: Vec<u16> = tok.iter().copied().filter(|&u| u != b'(' as u16 && u != b')' as u16).collect();
                if let Some(m) = parse_meter(&stripped, in_paren) {
                    meta.meters.push(m);
                }
                if tok.last() == Some(&(b')' as u16)) {
                    in_paren = false;
                }
            }
            if meta.meters.is_empty() {
                ctx.report("bad-meter", Msg::new("diag.fanqie.badMeter").arg("v", v), column, vu.len());
            }
        }
        "J" => {
            // 「120 欢快的」：数字与文字可并存。`/^(\d+(?:\.\d+)?)\s*/`
            let n = u16s::digits(&vu, 0);
            if n > 0 {
                let mut e = n;
                if u16s::is(&vu, e, '.') {
                    let f = u16s::digits(&vu, e + 1);
                    if f > 0 {
                        e += 1 + f;
                    }
                }
                meta.tempos.push(Tempo::Bpm(u16s::num(&vu[..e])));
                let after = e + u16s::spaces(&vu, e);
                let text = u16s::text(u16s::trim(&vu[after..]));
                if !text.is_empty() {
                    meta.tempos.push(Tempo::Text(text));
                }
            } else if !v.is_empty() {
                meta.tempos.push(Tempo::Text(v.into()));
            }
        }
        "XL" => meta.index_left = Some(v.into()),
        "XR" => meta.index_right = Some(v.into()),
        "TL" => meta.top_left.push(v.into()),
        "TR" => meta.top_right.push(v.into()),
        "BL" => meta.bottom_left.push(v.into()),
        "BC" => meta.bottom_center.push(v.into()),
        "BR" => meta.bottom_right.push(v.into()),
        "FONTSIZE" => meta.font_sizes.push(v.into()),
        "MARGIN" => meta.margins.push(v.into()),
        "SPACE" | "OFF" => meta.options.push(KeyValue { key: key.to_ascii_uppercase(), value: v.into() }),
        _ => {
            let len = u16s::enc(key).len();
            ctx.report("unknown-metadata", Msg::new("diag.fanqie.unknownField").arg("key", key), column, len);
        }
    }
}

/// `s.split(/\s+/)`（JS 口径：空串得 `[""]`，首尾空白各留一个空段）
fn split_ws(s: &U16) -> Vec<&U16> {
    let mut out = vec![];
    let mut start = 0;
    let mut i = 0;
    while i < s.len() {
        if u16s::space(s[i]) {
            out.push(&s[start..i]);
            while i < s.len() && u16s::space(s[i]) {
                i += 1;
            }
            start = i;
        } else {
            i += 1;
        }
    }
    out.push(&s[start..]);
    out
}

// ---------------- 文档装配 ----------------

/// 行首前缀（`BODY_PREFIX`）：`/^\s*([QCW])([!+-]?)(\d*)(?:-(\d+))?([!+-]?)(?:"([^"]*)"|<([^>]*)>)?\s*[:：]/`
pub struct BodyPrefix {
    pub kind: char,
    pub variant: String,
    /// 段号前、段号后那两处变体各自的原文（`variant` 取先出现的那个；重排拼 `Q1:` 标签要两处分开）
    pub variant_before: String,
    pub variant_after: String,
    pub number: String,
    pub range_end: Option<String>,
    pub caption: Option<String>,
    /// 整个前缀的长度（UTF-16）
    pub len: usize,
}

pub fn body_prefix(s: &U16) -> Option<BodyPrefix> {
    let sp = u16s::spaces(s, 0);
    let kind = match u16s::at(s, sp).and_then(u16s::ch) {
        Some(c @ ('Q' | 'C' | 'W')) => c,
        _ => return None,
    };
    let p0 = sp + 1;
    let var_at = |k: usize| u16s::one_of(u16s::at(s, k), "!+-");
    // 按正则的优先次序枚举可选项（先取后不取）
    for take_v1 in [true, false] {
        if take_v1 && !var_at(p0) {
            continue;
        }
        let p1 = p0 + take_v1 as usize;
        let nd = u16s::digits(s, p1);
        let p2 = p1 + nd;
        let range_opts: Vec<Option<usize>> = {
            let mut v = vec![];
            if u16s::is(s, p2, '-') {
                let n = u16s::digits(s, p2 + 1);
                if n > 0 {
                    v.push(Some(n));
                }
            }
            v.push(None);
            v
        };
        for range in range_opts {
            let p3 = p2 + range.map_or(0, |n| 1 + n);
            for take_v2 in [true, false] {
                if take_v2 && !var_at(p3) {
                    continue;
                }
                let p4 = p3 + take_v2 as usize;
                // 声部名：`"…"` 或 `<…>`，先取后不取
                let mut labels: Vec<(Option<String>, usize)> = vec![];
                if u16s::is(s, p4, '"') {
                    if let Some(e) = u16s::find(s, '"', p4 + 1) {
                        labels.push((Some(u16s::text(&s[p4 + 1..e])), e + 1));
                    }
                } else if u16s::is(s, p4, '<') {
                    if let Some(e) = u16s::find(s, '>', p4 + 1) {
                        labels.push((Some(u16s::text(&s[p4 + 1..e])), e + 1));
                    }
                }
                labels.push((None, p4));
                for (caption, p5) in labels {
                    let p6 = p5 + u16s::spaces(s, p5);
                    if u16s::is(s, p6, ':') || u16s::is(s, p6, '：') {
                        let variant = if take_v1 {
                            unit_str(s[p0])
                        } else if take_v2 {
                            unit_str(s[p3])
                        } else {
                            String::new()
                        };
                        return Some(BodyPrefix {
                            kind,
                            variant,
                            variant_before: if take_v1 { unit_str(s[p0]) } else { String::new() },
                            variant_after: if take_v2 { unit_str(s[p3]) } else { String::new() },
                            number: u16s::text(&s[p1..p2]),
                            range_end: range.map(|n| u16s::text(&s[p2 + 1..p2 + 1 + n])),
                            caption,
                            len: p6 + 1,
                        });
                    }
                }
            }
        }
    }
    None
}

/// 头部前缀：`/^\s*([A-Za-z]+)\s*[:：]/` → (字段名, 前缀长度)
fn meta_prefix(s: &U16) -> Option<(String, usize)> {
    let sp = u16s::spaces(s, 0);
    let mut k = sp;
    while u16s::at(s, k).is_some_and(|u| u < 0x80 && (u as u8).is_ascii_alphabetic()) {
        k += 1;
    }
    if k == sp {
        return None;
    }
    let e = k + u16s::spaces(s, k);
    if u16s::is(s, e, ':') || u16s::is(s, e, '：') {
        Some((u16s::text(&s[sp..k]), e + 1))
    } else {
        None
    }
}

/// 解析选项：指定方言（跳过嗅探）
#[derive(Clone, Copy, Default)]
pub struct ParseOptions {
    pub dialect: Option<Dialect>,
}

/// 撤掉已经落下的半条弧（按 `uid`）
fn drop_marks(lines: &mut dyn Iterator<Item = &mut ScoreLine>, uids: &[u32]) {
    if uids.is_empty() {
        return;
    }
    for line in lines {
        line.marks.retain(|m| !uids.contains(&m.uid));
    }
}

/// 文本谱 → 语法树。只是进 `ScoreDoc` 之前的中间产物。
#[allow(unused_assignments)]
pub fn parse_fanqie_ast(text: &str, options: ParseOptions) -> FanqieDoc {
    let dialect = match options.dialect {
        Some(d) => d,
        None => {
            let sniffed = sniff_dialect(text);
            match sniffed.dialect {
                None => {
                    return FanqieDoc {
                        dialect: "tomato".into(),
                        source: text.into(),
                        songs: vec![],
                        diagnostics: vec![Diagnostic {
                            severity: DiagnosticSeverity::Error,
                            code: "unknown-dialect".into(),
                            msg: sniffed.reason,
                            source: SourceSpan { line: 0, column: 0, offset: 0, length: 0 },
                        }],
                    };
                }
                Some(d) => d,
            }
        }
    };

    let mut ctx = Ctx::new(dialect);
    let mut songs: Vec<FanqieSong> = vec![];
    let mut metadata = Metadata::default();
    let mut pages: Vec<ScorePage> = vec![];
    let mut page = ScorePage { index: 0, groups: vec![], break_source: None };
    let mut group: Option<VoiceGroup> = None;
    let mut pending_texts: Vec<TextLine> = vec![];
    let mut has_last_voice = false;
    // 跨行未闭合的弧线 / 跳房子**按声部**存放（插入次序 = TS Map 的迭代次序）
    let mut carried_curves: Vec<(f64, Vec<OpenMark>)> = vec![];
    let mut carried_voltas: Vec<(f64, Vec<OpenMark>)> = vec![];
    let mut auto_verse = 0.0;
    let mut tail_override = false;
    let mut has_last_real_voice = false;

    macro_rules! flush_group {
        () => {{
            if let Some(g) = group.take() {
                if !g.voices.is_empty() {
                    page.groups.push(g);
                }
            }
            has_last_voice = false;
        }};
    }
    macro_rules! flush_page {
        () => {{
            flush_group!();
            if !page.groups.is_empty() {
                pages.push(std::mem::replace(&mut page, ScorePage { index: 0, groups: vec![], break_source: None }));
            }
            page = ScorePage { index: pages.len(), groups: vec![], break_source: None };
        }};
    }
    macro_rules! flush_song {
        () => {{
            flush_page!();
            if !pages.is_empty() {
                songs.push(FanqieSong { index: songs.len(), metadata: std::mem::take(&mut metadata), pages: std::mem::take(&mut pages) });
                page = ScorePage { index: 0, groups: vec![], break_source: None };
            }
        }};
    }
    macro_rules! drop_unresolved {
        () => {{
            let uids: Vec<u32> = carried_curves.iter().flat_map(|(_, l)| l.iter().flat_map(|o| o.pending.iter().copied())).collect();
            let mut all = songs
                .iter_mut()
                .flat_map(|s| s.pages.iter_mut())
                .chain(pages.iter_mut())
                .chain(std::iter::once(&mut page))
                .flat_map(|p| p.groups.iter_mut())
                .chain(group.iter_mut())
                .flat_map(|g| g.voices.iter_mut());
            drop_marks(&mut all, &uids);
            carried_curves.clear();
        }};
    }

    let lines = split_lines(text);
    let mut offset = 0u32;
    let mut starts = vec![];
    {
        // `lineStarts`：每个 `\r?\n` 之后
        let u = u16s::enc(text);
        starts.push(0u32);
        for (k, &c) in u.iter().enumerate() {
            if c == b'\n' as u16 {
                starts.push(k as u32 + 1);
            }
        }
        let _ = &mut offset;
    }
    for (ln, raw_str) in lines.iter().enumerate() {
        let raw = u16s::enc(raw_str);
        ctx.line = ln as u32;
        ctx.line_offset = starts[ln];
        let trimmed = u16s::trim(&raw);

        if trimmed.is_empty() {
            flush_group!();
            continue;
        }
        if trimmed[0] == b'#' as u16 {
            continue; // 注释行
        }
        // `/^-{5,}\s*$/`
        if trimmed.len() >= 5 && trimmed.iter().all(|&u| u == b'-' as u16) {
            flush_song!();
            drop_unresolved!();
            carried_voltas.clear();
            continue;
        }
        if trimmed.len() == 7 && starts_ci(trimmed, 0, "[fenye]") {
            flush_page!();
            let col = u16s::find(&raw, '[', 0).map_or(-1i64, |c| c as i64);
            page.break_source = Some(SourceSpan {
                line: ln as u32,
                column: col as u32,
                offset: (starts[ln] as i64 + col) as u32,
                length: trimmed.len() as u32,
            });
            continue;
        }
        // `1=bD 4/4`，也有 `6=c3/2` 这样以别的音为主音的（小调）写法：`/^\s*([1-7])\s*=/`
        {
            let sp = u16s::spaces(&raw, 0);
            if u16s::within(u16s::at(&raw, sp), '1', '7') {
                let e = sp + 1 + u16s::spaces(&raw, sp + 1);
                if u16s::is(&raw, e, '=') {
                    let eq = u16s::find(&raw, '=', 0).unwrap();
                    parse_shige_key_line(&mut metadata, &u16s::text(&raw[eq + 1..]), &unit_str(raw[sp]));
                    continue;
                }
            }
        }

        if let Some(body) = body_prefix(&raw) {
            let content_at = body.len;
            if body.kind == 'W' {
                pending_texts.push(TextLine {
                    text: u16s::text(u16s::trim(&raw[content_at..])),
                    source: ctx.span(content_at, raw.len() - content_at),
                });
                continue;
            }
            if body.kind == 'Q' {
                let voice_no = if body.number.is_empty() { 1.0 } else { dolce_base::js::number(&body.number) };
                // 声部号回到已出现过的值 → 新的一组
                if group.as_ref().is_some_and(|g| g.voices.iter().any(|v| v.voice == voice_no)) {
                    flush_group!();
                }
                if group.is_none() {
                    group = Some(VoiceGroup { index: page.groups.len(), texts: std::mem::take(&mut pending_texts), voices: vec![] });
                    auto_verse = 0.0;
                }
                // `Q: Q:5d…`、`Q::3g/…` 这类重复前缀 / 多余冒号，跳过即可。
                let mut music_at = content_at;
                if let Some(dup) = body_prefix(&raw[music_at..]) {
                    if dup.kind == 'Q' {
                        music_at += dup.len;
                    }
                }
                while u16s::is(&raw, music_at, ':') || u16s::is(&raw, music_at, ' ') {
                    music_at += 1;
                }
                let cc = carried_curves.iter().find(|(v, _)| *v == voice_no).map(|(_, l)| l.clone()).unwrap_or_default();
                let cv = carried_voltas.iter().find(|(v, _)| *v == voice_no).map(|(_, l)| l.clone()).unwrap_or_default();
                let parsed = parse_music_line(&mut ctx, &raw, music_at, &cc, &cv);
                set_carry(&mut carried_curves, voice_no, parsed.carried_curves);
                set_carry(&mut carried_voltas, voice_no, parsed.carried_voltas);
                let variant = if body.variant == "!" || body.variant == "-" || body.variant == "+" { Some(body.variant.clone()) } else { None };
                let line = ScoreLine {
                    voice: voice_no,
                    variant,
                    caption: body.caption.clone(),
                    elements: parsed.elements,
                    marks: parsed.marks,
                    lyrics: vec![],
                    raw: raw_str.to_string(),
                    source: ctx.span(0, raw.len()),
                };
                if line.elements.is_empty() {
                    // 空的 `Q:` 行不成声部；让它下面的歌词回到上一行真正有音符的曲上去
                    tail_override = has_last_real_voice;
                    continue;
                }
                group.as_mut().unwrap().voices.push(line);
                has_last_voice = true;
                has_last_real_voice = true;
                tail_override = false;
                auto_verse = 0.0;
                continue;
            }
            // 'C'：歌词，挂到上一行曲
            if tail_override {
                ctx.report("lyric-without-music", Msg::new("diag.fanqie.lyricNoMusic"), 0, raw.len());
                continue;
            }
            if !has_last_voice {
                ctx.report("orphan-lyric", Msg::new("diag.fanqie.orphanLyric"), 0, raw.len());
                continue;
            }
            let (annotation, gap, next) = strip_lyric_annotation(&mut ctx, &raw, content_at);
            let verse_from = if body.number.is_empty() {
                auto_verse += 1.0;
                auto_verse
            } else {
                dolce_base::js::number(&body.number)
            };
            let verse_to = body.range_end.as_deref().map_or(verse_from, dolce_base::js::number);
            let syllables = parse_lyric_body(&mut ctx, &raw, next.max(content_at));
            // 行末的 `}`：把相邻几段歌词括在一起的联合括号
            let tr = {
                let mut b = raw.len();
                while b > 0 && u16s::space(raw[b - 1]) {
                    b -= 1;
                }
                b > 0 && raw[b - 1] == b'}' as u16
            };
            let lyric = LyricLine {
                verse_from,
                verse_to,
                annotation,
                annotation_gap: gap,
                syllables,
                join_brace: if tr { Some(true) } else { None },
                source: ctx.span(0, raw.len()),
            };
            group.as_mut().unwrap().voices.last_mut().unwrap().lyrics.push(lyric);
            continue;
        }

        if let Some((key, len)) = meta_prefix(&raw) {
            if METADATA_KEYS.contains(&key.to_ascii_uppercase().as_str()) {
                apply_metadata(&mut ctx, &mut metadata, &key, &u16s::text(&raw[len..]), 0);
                continue;
            }
        }

        // 无前缀的自由文字：注记、勘误、引用之类，原样收着即可。只有「像谱却没写前缀」的行才报警。
        if trimmed.contains(&(b'|' as u16)) && trimmed.iter().any(|&u| u16s::digit(u)) {
            let head = u16s::text(&trimmed[..trimmed.len().min(20)]);
            ctx.report("unrecognized-line", Msg::new("diag.fanqie.noQ").arg("text", head), 0, raw.len());
        } else {
            metadata.remarks.push(u16s::text(trimmed));
        }
    }
    drop_unresolved!();
    flush_song!();

    FanqieDoc { dialect: dialect.as_str().into(), source: text.into(), songs, diagnostics: ctx.diagnostics }
}

fn set_carry(list: &mut Vec<(f64, Vec<OpenMark>)>, voice: f64, v: Vec<OpenMark>) {
    if let Some(e) = list.iter_mut().find(|(k, _)| *k == voice) {
        e.1 = v;
    } else {
        list.push((voice, v));
    }
}

/// 文本谱 → `ScoreDoc`：对外的解析入口。方言嗅探失败也返回文档（无曲、带 error 级诊断）。
pub fn parse_fanqie(text: &str, options: ParseOptions) -> ScoreDoc {
    fanqie_to_score_doc(&parse_fanqie_ast(text, options))
}
