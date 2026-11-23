//! `.jpwabc` 分节文件（同 `jpword/jpwfile.ts`）：按 `.节名` 切节，各节自己解析。
//!
//! TS 的「解析不了就 `fromString` 回 null」（含各节 `parse()` 抛异常）这里统一成 `None`。
//! 行、文字一律按 UTF-16 码元存（原文区间、`alignPos` 都按码元）。

use super::lex::{parse_voice_text, JpwToken};
use crate::abc::u16s::{self, U16};
use dolce_base::js;
use dolce_base::text::SourceSpan;
use indexmap::IndexMap;

/// 歌词里的一项（一个音的字）
#[derive(Clone, Debug, Default, PartialEq)]
pub struct WordsItem {
    pub text: Vec<u16>,
    /// `[` 在字里的位置（`-1` = 没有）
    pub align_pos: f64,
    /// 这个字在原文里的位置；`/` 占位的空项没有
    pub source: Option<SourceSpan>,
    /// 原文区间末尾并进了一个「“」（收尾处理把它挪给下一个字时区间跟着挪）
    quote_tail: bool,
    /// 段首自成一项的「“」
    open_quote_head: bool,
}

impl WordsItem {
    /// `new WordsItem(s)`：去掉 `[` `]`，记下 `[` 的位置
    fn from(s: &U16) -> WordsItem {
        let mut it = WordsItem { align_pos: -1.0, ..Default::default() };
        for &u in s {
            if u == b'[' as u16 {
                it.align_pos = it.text.len() as f64;
            } else if u != b']' as u16 {
                it.text.push(u);
            }
        }
        it
    }
    /// `new WordsItem()`
    fn empty() -> WordsItem {
        WordsItem { align_pos: -1.0, ..Default::default() }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct WordsSegment {
    pub pass_first: f64,
    pub pass_last: f64,
    pub measure: f64,
    pub note_index: f64,
    pub control: Option<Vec<String>>,
    pub data: Vec<WordsItem>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SectionKind {
    Voice { voice_data: Vec<JpwToken> },
    Words { segments: Vec<WordsSegment> },
    Title { values: IndexMap<String, String> },
    Layout { lines_per_page: Option<String>, break_points: Option<String> },
    Repeat { data: Vec<String> },
    Generic,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Section {
    pub name: String,
    pub lines: Vec<Vec<u16>>,
    /// `lines[i]` 在原文里的 0 基行号与行首偏移（跳过的注释与空行照算）
    pub line_nos: Vec<u32>,
    pub line_offsets: Vec<u32>,
    pub kind: SectionKind,
}

impl Section {
    /// `Section.create`：节名不认得就是 `None`（TS 抛错）
    fn create(n: &U16) -> Option<Section> {
        let low = u16s::text(n).to_lowercase();
        let nn = js::trim(low.get(low.char_indices().nth(1).map_or(low.len(), |(i, _)| i)..).unwrap_or("")).to_string();
        let kind = match nn.as_str() {
            "voice" => SectionKind::Voice { voice_data: vec![] },
            "words" => SectionKind::Words { segments: vec![] },
            "attachments" | "page" | "fonts" | "options" => SectionKind::Generic,
            "title" => SectionKind::Title { values: IndexMap::new() },
            "layout" => SectionKind::Layout { lines_per_page: None, break_points: None },
            "repeat" => SectionKind::Repeat { data: vec![] },
            _ => return None,
        };
        Some(Section { name: nn, lines: vec![], line_nos: vec![], line_offsets: vec![], kind })
    }

    fn joined(&self) -> Vec<u16> {
        self.lines.join(&(b'\n' as u16))
    }

    /// 各节的 `parse()`；`None` = 抛错或回 false
    fn parse(&mut self) -> Option<()> {
        match &self.kind {
            SectionKind::Generic => {}
            SectionKind::Voice { .. } => {
                let v = parse_voice_text(&self.joined())?;
                self.kind = SectionKind::Voice { voice_data: v };
            }
            SectionKind::Repeat { .. } => {
                let d: Vec<u16> = self.joined().into_iter().map(|u| if u == b',' as u16 { b'\n' as u16 } else { u }).collect();
                let data = d.split(|&u| u == b'\n' as u16).map(u16s::text).collect();
                self.kind = SectionKind::Repeat { data };
            }
            SectionKind::Layout { .. } => {
                let (mut lpp, mut bp) = (None, None);
                for l in &self.lines {
                    if !l.contains(&(b'=' as u16)) {
                        continue;
                    }
                    let low = js_lower(l);
                    let arr: Vec<&[u16]> = low.split(|&u| u == b'=' as u16).collect();
                    if arr.len() != 2 {
                        return None;
                    }
                    let v = u16s::text(u16s::trim(arr[1]));
                    match u16s::text(u16s::trim(arr[0])).as_str() {
                        "linesperpage" => lpp = Some(v),
                        "breakpoints" => bp = Some(v),
                        _ => return None,
                    }
                }
                self.kind = SectionKind::Layout { lines_per_page: lpp, break_points: bp };
            }
            SectionKind::Title { .. } => {
                let mut values = IndexMap::new();
                for l in &self.lines {
                    if u16s::trim(l).is_empty() {
                        continue;
                    }
                    let Some(idx) = u16s::find(l, '=', 0) else { continue };
                    if idx == 0 {
                        continue; // TS：console.error("bad line")
                    }
                    let key = u16s::text(u16s::trim(&l[..idx]));
                    let v = u16s::trim(&l[idx + 1..]);
                    let v = substring_after(v, b'{' as u16);
                    let v = substring_before_last(v, b'}' as u16);
                    values.insert(js_lower_str(&key), u16s::text(v));
                }
                self.kind = SectionKind::Title { values };
            }
            SectionKind::Words { .. } => {
                let segments = self.parse_words()?;
                self.kind = SectionKind::Words { segments };
            }
        }
        Some(())
    }

    /// `WordsSection.parse`
    fn parse_words(&self) -> Option<Vec<WordsSegment>> {
        let text = self.joined();
        // 拼接文本的位置 → 原文位置（各行行首在拼接文本里的位置，与 `line_offsets` 一一对应）
        let mut joined_starts = vec![];
        let mut at = 0usize;
        for l in &self.lines {
            joined_starts.push(at);
            at += l.len() + 1;
        }
        let span_at = |from: usize, to: usize| -> Option<SourceSpan> {
            if joined_starts.is_empty() {
                return None;
            }
            let mut i = joined_starts.len() - 1;
            while i > 0 && joined_starts[i] > from {
                i -= 1;
            }
            let line_offset = *self.line_offsets.get(i)?;
            let line = *self.line_nos.get(i)?;
            let column = (from - joined_starts[i]) as u32;
            Some(SourceSpan { line, column, offset: line_offset + column, length: (to - from) as u32 })
        };
        let item = |s: &U16, from: usize, to: usize| {
            let mut it = WordsItem::from(s);
            it.source = span_at(from, to);
            it
        };
        let punc: Vec<u16> = ".,;'!?。：，；！？“”｡､、".encode_utf16().collect();
        let open_q = '“' as u16;
        let mut segs: Vec<WordsSegment> = vec![];
        let mut pos = 0;
        let mut line_begin = true;
        while pos < text.len() {
            let ch = text[pos];
            if ch == b'\n' as u16 {
                pos += 1;
                line_begin = true;
                continue;
            }
            if line_begin {
                if let Some((seg, end)) = lrc_spec(&text, pos) {
                    segs.push(seg);
                    pos = end;
                    line_begin = false;
                    continue;
                }
            }
            line_begin = false;
            if ch == b'{' as u16 {
                let end = u16s::find(&text, '}', pos + 1)?;
                let it = item(&text[pos + 1..end], pos, end + 1);
                segs.last_mut()?.data.push(it);
                pos = end + 1;
                continue;
            }
            let seg = segs.last_mut()?;
            if u16s::one_of(Some(ch), " -()") {
                pos += 1;
                continue;
            }
            if ch == b'/' as u16 {
                pos += 1;
                seg.data.push(WordsItem::empty());
                continue;
            }
            if ch <= 0x7f && (ch as u8).is_ascii_alphabetic() {
                let mut end = pos + 1;
                while end < text.len() {
                    let c2 = text[end];
                    if c2 >= 0x7f || !(c2 as u8).is_ascii_alphabetic() {
                        break;
                    }
                    end += 1;
                }
                seg.data.push(item(&text[pos..end], pos, end));
                pos = end + 1;
                continue;
            }
            if punc.contains(&ch) {
                if let Some(prev) = seg.data.last_mut() {
                    prev.text.push(ch);
                    // 紧跟在字后的标点并进这个字的原文区间
                    if let Some(ps) = prev.source.as_mut() {
                        if Some(ps.offset + ps.length) == span_at(pos, pos + 1).map(|s| s.offset) {
                            ps.length += 1;
                            if ch == open_q {
                                prev.quote_tail = true;
                            }
                        }
                    }
                    pos += 1;
                    continue;
                }
            }
            let mut one = item(&text[pos..pos + 1], pos, pos + 1);
            if ch == open_q && seg.data.is_empty() {
                one.open_quote_head = true;
            }
            seg.data.push(one);
            pos += 1;
        }

        for s in &mut segs {
            for k in 1..s.data.len() {
                let (head, tail) = s.data.split_at_mut(k);
                let prev = &mut head[k - 1];
                let d = &mut tail[0];
                if prev.text.last() == Some(&open_q) {
                    prev.text.pop();
                    d.text.insert(0, open_q);
                    // 原文区间跟着挪：前一个字让出末尾的「“」，这个字从「“」起
                    if let (Some(ps), Some(ds)) = (prev.source.as_mut(), d.source.as_mut()) {
                        if prev.quote_tail && ps.offset + ps.length <= ds.offset && ps.line == ds.line {
                            ps.length -= 1;
                            let gap = ds.offset - (ps.offset + ps.length);
                            ds.length += gap;
                            ds.column = ds.column.wrapping_sub(gap);
                            ds.offset = ps.offset + ps.length;
                        }
                    }
                }
            }
            // 段首就是「“」：挪给下一个字后只剩一个空项，本不占音符，去掉
            if s.data.len() > 1 && s.data[0].text.is_empty() && s.data[0].open_quote_head {
                s.data.remove(0);
            }
        }
        Some(segs)
    }
}

/// `/W(\d+)(-(\d+))?(\([0-9a-zA-Z.,]+\))?(@(\d+),(\d+))?(\([0-9a-zA-Z.,]+\))?:/y`：回（段，匹配终点）
fn lrc_spec(s: &U16, i: usize) -> Option<(WordsSegment, usize)> {
    let digits = |k: usize| {
        let d = u16s::digits(s, k);
        (d > 0).then(|| (js::parse_int(&u16s::text(&s[k..k + d]), 10), k + d))
    };
    let ctrl = |k: usize| -> Option<usize> {
        if !u16s::is(s, k, '(') {
            return None;
        }
        let mut j = k + 1;
        while s.get(j).is_some_and(|&u| u <= 0x7f && ((u as u8).is_ascii_alphanumeric() || u == b'.' as u16 || u == b',' as u16)) {
            j += 1;
        }
        (j > k + 1 && u16s::is(s, j, ')')).then_some(j + 1)
    };
    if !u16s::is(s, i, 'W') {
        return None;
    }
    let (first, mut j) = digits(i + 1)?;
    let mut last = first;
    if u16s::is(s, j, '-') {
        if let Some((v, e)) = digits(j + 1) {
            last = v;
            j = e;
        }
    }
    // 第 4 组与第 8 组都是括号：前一组贪婪先拿，不带 `@` 时第二个括号归第 8 组
    if let Some(e) = ctrl(j) {
        j = e;
    }
    let mut at = None;
    if u16s::is(s, j, '@') {
        if let Some((m, e)) = digits(j + 1) {
            if u16s::is(s, e, ',') {
                if let Some((n, e2)) = digits(e + 1) {
                    at = Some((m, n));
                    j = e2;
                }
            }
        }
    }
    let mut control = None;
    if let Some(e) = ctrl(j) {
        let inner = u16s::text(&s[j + 1..e - 1]);
        control = Some(inner.split(',').map(str::to_string).collect());
        j = e;
    }
    if !u16s::is(s, j, ':') {
        return None;
    }
    let (measure, note_index) = at.unwrap_or((1.0, 1.0));
    Some((WordsSegment { pass_first: first, pass_last: last, measure, note_index, control, data: vec![] }, j + 1))
}

/// JS `toLowerCase`（按码元：ASCII 之外的字这里用不到，节名 / 键只与 ASCII 比）
fn js_lower(s: &U16) -> Vec<u16> {
    u16s::enc(&js_lower_str(&u16s::text(s)))
}

fn js_lower_str(s: &str) -> String {
    s.to_lowercase()
}

/// Kotlin `substringAfter`（找不到回整串）
fn substring_after(s: &U16, d: u16) -> &U16 {
    s.iter().position(|&u| u == d).map_or(s, |i| &s[i + 1..])
}

/// Kotlin `substringBeforeLast`
fn substring_before_last(s: &U16, d: u16) -> &U16 {
    s.iter().rposition(|&u| u == d).map_or(s, |i| &s[..i])
}

/// 整个 `.jpwabc` 文件
#[derive(Clone, Debug, PartialEq, Default)]
pub struct JpwFile {
    pub sections: Vec<Section>,
}

impl JpwFile {
    /// `JpwFile.fromString`：解析不了（正文在任何节头之前、节名不认得、某节解析失败）回 `None`
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Option<JpwFile> {
        Self::from_u16(&u16s::enc(s))
    }

    pub fn from_u16(s: &U16) -> Option<JpwFile> {
        let mut f = JpwFile::default();
        let mut offset = 0usize;
        for (no, raw) in s.split(|&u| u == b'\n' as u16).enumerate() {
            let at = offset;
            offset += raw.len() + 1;
            // JP-Word 存的是 `\r\n`：按 `\n` 切完行尾的 `\r` 去掉（偏移仍按原行长算）
            let l = if raw.last() == Some(&(b'\r' as u16)) { &raw[..raw.len() - 1] } else { raw };
            // `//` 开头是注释，歌词段里除外（那里 `/` 是跳过一个音）
            let in_words = matches!(f.sections.last().map(|s| &s.kind), Some(SectionKind::Words { .. }));
            if u16s::starts(l, 0, "//") && !in_words {
                continue;
            }
            if l.is_empty() {
                continue;
            }
            if u16s::is(l, 0, '.') {
                f.sections.push(Section::create(l)?);
                continue;
            }
            let sec = f.sections.last_mut()?;
            sec.lines.push(l.to_vec());
            sec.line_nos.push(no as u32);
            sec.line_offsets.push(at as u32);
        }
        for s in &mut f.sections {
            s.parse()?;
        }
        Some(f)
    }

    fn find(&self, pred: impl Fn(&SectionKind) -> bool) -> Option<&Section> {
        self.sections.iter().find(|s| pred(&s.kind))
    }
    pub fn voice(&self) -> Option<&Section> {
        self.find(|k| matches!(k, SectionKind::Voice { .. }))
    }
    pub fn lyric(&self) -> Option<&[WordsSegment]> {
        self.sections.iter().find_map(|s| match &s.kind {
            SectionKind::Words { segments } => Some(segments.as_slice()),
            _ => None,
        })
    }
    pub fn title(&self) -> Option<Title<'_>> {
        self.sections.iter().find_map(|s| match &s.kind {
            SectionKind::Title { values } => Some(Title { values }),
            _ => None,
        })
    }
    /// 第一个 `.Repeat` 节的行
    pub fn repeat(&self) -> Option<&[String]> {
        self.sections.iter().find_map(|s| match &s.kind {
            SectionKind::Repeat { data } => Some(data.as_slice()),
            _ => None,
        })
    }
}

/// `TitleSection` 的取值
pub struct Title<'a> {
    pub values: &'a IndexMap<String, String>,
}

/// TS 那边会抛 TypeError 的取值（`KeyAndMeters` 没有逗号时取拍号）
#[derive(Debug)]
pub struct TitleError;

impl Title<'_> {
    pub fn value(&self, key: &str) -> Option<&str> {
        self.values.get(&js_lower_str(key)).map(String::as_str)
    }
    pub fn title(&self) -> Option<&str> {
        self.value("title")
    }
    pub fn key_and_meters(&self) -> Option<&str> {
        self.value("KeyAndMeters")
    }
    pub fn words_music_by(&self) -> Option<&str> {
        self.value("WordsByAndMusicBy")
    }
    pub fn expression(&self) -> Option<&str> {
        self.value("Expression")
    }
    /// `Expression` 里 `♩=NN`（或 JP-Word 自己存的 `J=NN`）的数值；不在 20..400 回 0
    pub fn tempo(&self) -> f64 {
        let e: Vec<char> = self.expression().unwrap_or("").chars().collect();
        // /[J♩]\s*=\s*(\d+)/i
        for i in 0..e.len() {
            if !matches!(e[i], 'J' | 'j' | '♩') {
                continue;
            }
            let mut k = i + 1;
            while k < e.len() && js::is_space(e[k]) {
                k += 1;
            }
            if e.get(k) != Some(&'=') {
                continue;
            }
            k += 1;
            while k < e.len() && js::is_space(e[k]) {
                k += 1;
            }
            let d: String = e[k..].iter().take_while(|c| c.is_ascii_digit()).collect();
            if d.is_empty() {
                continue;
            }
            let v = js::parse_int(&d, 10);
            return if (20.0..=400.0).contains(&v) { v } else { 0.0 };
        }
        0.0
    }
    pub fn key(&self) -> Option<String> {
        let km = self.key_and_meters()?;
        let first = km.split(',').next().unwrap_or("");
        let after = first.find('=').map_or(first, |i| &first[i + 1..]);
        Some(js::trim(after).to_string())
    }
    pub fn meter(&self) -> Result<Option<String>, TitleError> {
        let Some(km) = self.key_and_meters() else { return Ok(None) };
        let second = km.split(',').nth(1).ok_or(TitleError)?;
        Ok(Some(js::trim(second).to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sections() {
        let f = JpwFile::from_str(".Title\r\nTitle = {主}\r\nKeyAndMeters = {1=D,3/4}\r\n.Voice\r\n1 2 3|\r\n.Words\r\nW1:我[们“爱/a主。\r\n").unwrap();
        let t = f.title().unwrap();
        assert_eq!(t.title(), Some("主"));
        assert_eq!(t.key().as_deref(), Some("D"));
        assert_eq!(t.meter().unwrap().as_deref(), Some("3/4"));
        let segs = f.lyric().unwrap();
        let texts: Vec<_> = segs[0].data.iter().map(|d| String::from_utf16_lossy(&d.text)).collect();
        // `[` 是一项（去掉括号成空字、记 alignPos 0）；读完一串 ASCII 字母顺手跳过下一个字符（「主」），句号并进前一个字
        assert_eq!(texts, ["我", "", "们", "“爱", "", "a。"]);
        assert_eq!(segs[0].data[1].align_pos, 0.0);
        assert!(JpwFile::from_str("1 2 3").is_none());
        assert!(JpwFile::from_str(".Bogus\n").is_none());
    }
}
