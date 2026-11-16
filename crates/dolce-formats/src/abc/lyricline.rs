//! 歌词行 → 音节（同 `abcfamily/parse.ts::parseLyricLine`）。按 UTF-16 码元走（`body[i]`），源区间也按码元记。
//!
//! - **CJK 连写逐字成音节**（规范 §5.2）；拉丁按空格与 `-` 分。
//! - `_` 前一音节延长一音、跳音符（123 `/`、ABC `*`）、`~` 与 `{}` 多字一音、`|` 只为好读；`\-` `\/` 是字面字符。
//! - 收尾标点并入前一字、不占音符格（`lyricpunct`）；段首 `<1.>` 是印刷段号。
//! - `join_tilde`（Muse）：`~` 在任何音节后都把下一个音节并到同一个音；`tilde_label`（ABC）：段首 `1.~` 是段号。

use super::lyricpunct::{is_lyric_apostrophe, is_lyric_cjk, is_lyric_open_quote, is_lyric_trailing_punct, FANQIE_LYRIC_QUOTES};
use super::u16s::{digit, is, space, text};
use dolce_base::{Msg, SourceSpan};
use dolce_model::{Lyric, Syllabic};

pub struct LyricLine {
    pub syllables: Vec<Lyric>,
    pub label: Option<String>,
    /// 各音节（含空音节）在 body 里的起点，与 `syllables` 一一对应
    pub starts: Vec<usize>,
}

fn u(c: char) -> u16 {
    c as u16
}

/// `[A-Za-z0-9]`
fn alnum(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric())
}

#[allow(clippy::too_many_arguments)]
pub fn parse_lyric_line(
    body: &[u16],
    verse: f64,
    source: SourceSpan,
    value_offset: Option<u32>,
    skip: char,
    warn: &mut dyn FnMut(&str, Msg),
    join_tilde: bool,
    tilde_label: bool,
) -> LyricLine {
    let n = body.len();
    let mut out: Vec<Lyric> = vec![];
    let mut starts: Vec<usize> = vec![];
    let mut i = 0usize;
    let mut tok_start: usize;
    let mut label: Option<String> = None;

    // 印刷段号 `<1.>`（`/^\s*<([^>]*)>/`）
    {
        let mut k = 0;
        while k < n && space(body[k]) {
            k += 1;
        }
        if is(body, k, '<') {
            if let Some(close) = (k + 1..n).find(|&j| body[j] == u('>')) {
                label = Some(text(&body[k + 1..close]));
                i = close + 1;
            }
        }
    }

    let mut prefix: Vec<u16> = vec![];
    let trail = |c: u16| is_lyric_trailing_punct(c) && !(join_tilde && c == u('~'));
    let mut join_next = false;

    let push = |l: Lyric, out: &mut Vec<Lyric>, starts: &mut Vec<usize>, join_next: &mut bool, tok_start: usize| {
        if *join_next && !out.is_empty() && !l.text.is_empty() {
            *join_next = false;
            let prev = out.last_mut().unwrap();
            let lead = l.leading_punctuation.as_deref().unwrap_or(&l.text);
            let latin = alnum(prev.text.chars().last()) && prev.trailing_punctuation.is_none() && alnum(lead.chars().next());
            let mut t = std::mem::take(&mut prev.text);
            t.push_str(prev.trailing_punctuation.as_deref().unwrap_or(""));
            if latin {
                t.push(' ');
            }
            t.push_str(l.leading_punctuation.as_deref().unwrap_or(""));
            t.push_str(&l.text);
            prev.text = t;
            prev.trailing_punctuation = l.trailing_punctuation.clone();
            if l.syllabic.is_some() {
                prev.syllabic = l.syllabic.clone();
            }
            if let (Some(ps), Some(ls)) = (prev.source.as_mut(), l.source.as_ref()) {
                ps.length = ls.offset + ls.length - ps.offset;
            }
            return;
        }
        *join_next = false;
        out.push(l);
        starts.push(tok_start);
    };

    let mk = |t: &[u16], prefix: &mut Vec<u16>, tok_start: usize| -> Lyric {
        let mut l = Lyric { number: verse, text: text(t), ..Default::default() };
        if !prefix.is_empty() && !t.is_empty() {
            l.leading_punctuation = Some(text(prefix));
            prefix.clear();
        }
        if let Some(vo) = value_offset {
            if !t.is_empty() {
                l.source = Some(SourceSpan {
                    line: source.line,
                    column: vo - source.offset + tok_start as u32,
                    offset: vo + tok_start as u32,
                    length: t.len() as u32,
                });
            }
        }
        l
    };

    while i < n {
        let ch = body[i];
        if ch == u(' ') || ch == u('\t') {
            i += 1;
            continue;
        }
        tok_start = i;
        if tilde_label && label.is_none() && !out.iter().any(|l| !l.text.is_empty()) {
            // `/^(\d+[.．、]?)~/`
            let mut k = i;
            while k < n && digit(body[k]) {
                k += 1;
            }
            if k > i {
                let mut e = k;
                if e < n && (body[e] == u('.') || body[e] == u('．') || body[e] == u('、')) && is(body, e + 1, '~') {
                    e += 1;
                }
                if is(body, e, '~') {
                    label = Some(text(&body[i..e]));
                    i = e + 1;
                    continue;
                }
            }
        }
        if join_tilde && ch == u('~') {
            join_next = !out.is_empty();
            i += 1;
            continue;
        }
        // 跳一个音符（该音符不配字）
        if ch == skip as u16 {
            let l = mk(&[], &mut prefix, tok_start);
            push(l, &mut out, &mut starts, &mut join_next, tok_start);
            i += 1;
            continue;
        }
        if ch == u('*') {
            warn("lyric-old-skip", Msg::new("diag.j123.oldSkip"));
            let l = mk(&[], &mut prefix, tok_start);
            push(l, &mut out, &mut starts, &mut join_next, tok_start);
            i += 1;
            continue;
        }
        // 前一音节延长到这个音符
        if ch == u('_') {
            if let Some(prev) = out.last_mut() {
                prev.extend = Some(true);
            }
            let l = mk(&[], &mut prefix, tok_start);
            push(l, &mut out, &mut starts, &mut join_next, tok_start);
            i += 1;
            continue;
        }
        if ch == u('|') {
            i += 1;
            continue;
        }
        // 多字一音 `{多字}`
        if ch == u('{') {
            let Some(close) = (i..n).find(|&j| body[j] == u('}')) else {
                i += 1;
                continue;
            };
            let mut l = mk(&body[i + 1..close], &mut prefix, tok_start);
            i = close + 1;
            if is(body, i, '-') {
                l.syllabic = Some(Syllabic::Begin);
                i += 1;
            }
            push(l, &mut out, &mut starts, &mut join_next, tok_start);
            continue;
        }
        // 转义的真连字符 / 斜杠
        if ch == u('\\') && (is(body, i + 1, '-') || is(body, i + 1, '/')) {
            if let Some(prev) = out.last_mut() {
                prev.text.push(if is(body, i + 1, '-') { '-' } else { '/' });
            }
            i += 2;
            continue;
        }
        // CJK：一字一音节，随后的收尾标点并进来
        if is_lyric_cjk(ch) {
            let mut t: Vec<u16> = vec![ch];
            i += 1;
            while is(body, i, '~') && i + 1 < n {
                if trail(body[i + 1]) {
                    i += 1;
                    break;
                }
                i += 1;
                t.push(body[i]);
                i += 1;
            }
            let mut trailing: Vec<u16> = vec![];
            while i < n && trail(body[i]) {
                trailing.push(body[i]);
                i += 1;
            }
            let mut l = mk(&t, &mut prefix, tok_start);
            if !trailing.is_empty() {
                l.trailing_punctuation = Some(text(&trailing));
            }
            push(l, &mut out, &mut starts, &mut join_next, tok_start);
            continue;
        }
        // 左引号、开括号：领起后一个字
        if is_lyric_open_quote(ch) {
            if i + 1 < n && is_lyric_cjk(body[i + 1]) {
                let t = [ch, body[i + 1]];
                i += 2;
                let mut trailing: Vec<u16> = vec![];
                while i < n && trail(body[i]) {
                    trailing.push(body[i]);
                    i += 1;
                }
                let mut l = mk(&t, &mut prefix, tok_start);
                if !trailing.is_empty() {
                    l.trailing_punctuation = Some(text(&trailing));
                }
                push(l, &mut out, &mut starts, &mut join_next, tok_start);
                continue;
            }
            if !FANQIE_LYRIC_QUOTES.encode_utf16().any(|q| q == ch) {
                prefix.push(ch);
            }
            i += 1;
            continue;
        }
        // 标点并到前一音节；前面没字可并时攒着
        if trail(ch) && !is_lyric_apostrophe(body, i) {
            if let Some(prev) = out.last_mut() {
                let mut t = prev.trailing_punctuation.take().unwrap_or_default();
                t.push_str(&text(&[ch]));
                prev.trailing_punctuation = Some(t);
            } else {
                prefix.push(ch);
            }
            i += 1;
            continue;
        }
        // 拉丁：到空白 / `-` / `_` / 跳音符为止算一个音节
        {
            let mut j = i;
            let mut t: Vec<u16> = vec![];
            while j < n {
                let c = body[j];
                if c == u('\\') && (is(body, j + 1, '-') || is(body, j + 1, '/')) {
                    t.push(body[j + 1]);
                    j += 2;
                    continue;
                }
                if space(c)
                    || "-_*|{}\\".encode_utf16().any(|x| x == c)
                    || c == skip as u16
                    || is_lyric_cjk(c)
                    || (trail(c) && !is_lyric_apostrophe(body, j))
                    || (join_tilde && c == u('~'))
                {
                    break;
                }
                t.push(c);
                j += 1;
            }
            if j == i {
                i += 1;
                continue;
            }
            i = j;
            let mut syllabic = None;
            if is(body, i, '-') {
                syllabic = Some(Syllabic::Begin);
                i += 1;
            }
            let mut trailing: Vec<u16> = vec![];
            while i < n && trail(body[i]) {
                trailing.push(body[i]);
                i += 1;
            }
            let mut l = mk(&t, &mut prefix, tok_start);
            if syllabic.is_some() {
                l.syllabic = syllabic;
            }
            if !trailing.is_empty() {
                l.trailing_punctuation = Some(text(&trailing));
            }
            push(l, &mut out, &mut starts, &mut join_next, tok_start);
        }
    }
    LyricLine { syllables: out, label, starts }
}
