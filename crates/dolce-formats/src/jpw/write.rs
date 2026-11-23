//! `.jpwabc` 写出端（同 `model/tojpw.ts::writeJpwabc`）。
//!
//! 只经输入形状（`JpwScoreIn`）读谱：形状由视图层拼（MusicXML 形状 `model/playdoc.ts::jpwInputOfDoc`、简谱形状
//! `jianpu/playsong.ts::jpwInputOfSong`，M5 再迁）。TS 的条目是三种对象混排、按有哪些字段认，过边界时由门面打上 `kind`
//! （认法的先后同 TS：先换行、再和弦、再小节线，都不是的记 `other`，只占位置）；`endingNum` 的 Set 成数组（插入次序）。
//! JP-Word 的 `.Voice` 只有单声部：只写第一声部。

use dolce_base::js;
use dolce_base::Fraction;
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JpwLyricIn {
    pub text: String,
    pub number: f64,
    pub refrain: bool,
}

/// 简谱写法的一个音：数字、八度点、面上的记号（`b` / `#` / `n` / 空）
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JpwPitchIn {
    pub number: String,
    pub jp_octave: f64,
    pub jp_alter: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JpwNoteIn {
    pub number: String,
    pub jp_octave: f64,
    pub jp_alter: String,
    pub tie_start: bool,
    pub tie_end: bool,
    pub tuplet_begin: bool,
    pub tuplet_end: bool,
    pub lyrics: Vec<JpwLyricIn>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JpwChordIn {
    /// 只读 `notes[0]`
    pub notes: Vec<JpwNoteIn>,
    pub rest: bool,
    pub dot: f64,
    pub beats: f64,
    pub beams: f64,
    pub slur_start: bool,
    pub slur_ends: f64,
    pub fermata: bool,
    pub grace_notes: Vec<JpwPitchIn>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum JpwEntryIn {
    Chord(JpwChordIn),
    /// 行内换行（`Score.LineBreak`）
    #[serde(rename_all = "camelCase")]
    LineBreak { new_page: bool, pass: Option<f64> },
    /// 小节线条目：只看位置——不在小节开头的就地写一根
    Barline { style: Option<String>, repeat: Option<String>, position: Fraction },
    /// 三种都不是（TS 里照样占一个条目位）
    Other,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JpwTimeIn {
    pub beats: f64,
    pub beat_type: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JpwKeyIn {
    pub fifths: f64,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JpwMeasureIn {
    /// 和弦、换行、小节线按原次序混排
    pub entries: Vec<JpwEntryIn>,
    pub new_system: bool,
    pub new_page: bool,
    pub repeat_forward: bool,
    pub repeat_backward: bool,
    pub ending_left: bool,
    pub ending_num: Option<Vec<f64>>,
    pub time_change: bool,
    pub key_change: bool,
    pub time: JpwTimeIn,
    pub key: JpwKeyIn,
    pub barline: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JpwPartIn {
    pub measures: Vec<JpwMeasureIn>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JpwPlayItemIn {
    pub mid: f64,
    pub end: f64,
    pub pass: f64,
    pub skip: f64,
    pub limit: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JpwPlayDataIn {
    pub no_repeat: bool,
    pub tempo: f64,
    pub measures: Vec<JpwPlayItemIn>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JpwCreditIn {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub page: f64,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JpwScoreIn {
    pub title: String,
    pub credit: Vec<JpwCreditIn>,
    pub parts: Vec<JpwPartIn>,
    pub play_data: JpwPlayDataIn,
}

/// 写不出（TS 抛错：坏 jpAlter、heavy-light 线、多房号、缺第一小节……）
#[derive(Clone, Debug, PartialEq)]
pub struct JpwWriteError(pub String);

type R<T> = Result<T, JpwWriteError>;

fn err<T>(s: &str) -> R<T> {
    Err(JpwWriteError(s.to_string()))
}

fn escape(s: &str) -> String {
    s.replace('\n', "\\n")
}

fn n(x: f64) -> String {
    js::num_to_string(x)
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn is_ascii_letter(s: &str) -> bool {
    let mut c = s.chars();
    matches!((c.next(), c.next()), (Some(ch), None) if ch.is_ascii_alphabetic())
}

// ───────────────────────── 歌词 ─────────────────────────

struct Segment {
    pass_first: f64,
    pass_last: f64,
    measure: f64,
    note_index: f64,
}

/// `LyricProcessor`：段按建立先后（TS `Map<Segment, string>` 的插入次序）
struct Lyrics<'a> {
    part: &'a JpwPartIn,
    segs: Vec<(Segment, String)>,
    refrain: Option<usize>,
    /// 段号 → 段（插入次序）
    verses: Vec<(f64, usize)>,
    num_verses: f64,
    mid: f64,
    nid: f64,
    in_verse: bool,
}

impl<'a> Lyrics<'a> {
    fn new(part: &'a JpwPartIn) -> Self {
        Lyrics { part, segs: vec![], refrain: None, verses: vec![], num_verses: 0.0, mid: 0.0, nid: 0.0, in_verse: true }
    }

    fn lines(&self, res: &mut Vec<String>) {
        for (k, v) in &self.segs {
            let mut head = format!("W{}", n(k.pass_first));
            if k.pass_first != k.pass_last {
                head += &format!("-{}", n(k.pass_last));
            }
            head += &format!("@{},{}:", n(k.measure), n(k.note_index));
            res.push(head);
            res.push(v.trim_end_matches('/').to_string());
        }
    }

    fn new_seg(&mut self, first: f64) -> usize {
        self.segs.push((Segment { pass_first: first, pass_last: first, measure: self.mid, note_index: self.nid }, String::new()));
        self.segs.len() - 1
    }

    fn append_slash(&mut self) {
        if self.in_verse {
            for &(_, i) in &self.verses {
                self.segs[i].1.push('/');
            }
        } else if let Some(r) = self.refrain {
            self.segs[r].1.push('/');
        }
    }

    fn make_text(txt: &str) -> String {
        // 单个英文字母也要包：读入端读完一串 ASCII 字母会顺手跳过下一个字符
        if utf16_len(txt) == 1 {
            return if is_ascii_letter(txt) { format!("{{{txt}}}") } else { txt.to_string() };
        }
        // /^\d\./
        let b = txt.as_bytes();
        if b.len() >= 2 && b[0].is_ascii_digit() && b[1] == b'.' {
            return format!("{{{}[{}]}}", &txt[..2], &txt[2..]);
        }
        let left: String = txt.chars().filter(|c| !"，。！？、“”：；".contains(*c)).collect();
        let quote = utf16_len(&left) != 1 || is_ascii_letter(&left);
        if quote {
            format!("{{{txt}}}")
        } else {
            txt.to_string()
        }
    }

    fn on_chord(&mut self, ch: &JpwChordIn) -> R<()> {
        let Some(n0) = ch.notes.first() else { return err("notes[0]") };
        let lrcs = &n0.lyrics;
        if lrcs.len() as f64 > self.num_verses {
            self.num_verses = lrcs.len() as f64;
        }
        let Some(lrc) = lrcs.first() else {
            self.append_slash();
            return Ok(());
        };
        if lrc.refrain {
            let r = match self.refrain {
                Some(r) => r,
                None => {
                    let r = self.new_seg(1.0);
                    self.refrain = Some(r);
                    r
                }
            };
            let t = Self::make_text(&lrc.text);
            self.segs[r].1 += &t;
            self.in_verse = false;
        } else {
            let mut present = vec![];
            for it in lrcs {
                let i = match self.verses.iter().find(|(k, _)| *k == it.number) {
                    Some(&(_, i)) => i,
                    None => {
                        let i = self.new_seg(it.number);
                        self.verses.push((it.number, i));
                        i
                    }
                };
                let t = Self::make_text(&it.text);
                self.segs[i].1 += &t;
                present.push(it.number);
            }
            // 某音符在部分段是 melisma（该段无音节）但另一段有字：给缺席的段补 "/"
            for &(num, i) in &self.verses {
                if !present.contains(&num) {
                    self.segs[i].1.push('/');
                }
            }
            self.in_verse = true;
        }
        Ok(())
    }

    fn process(&mut self) -> R<()> {
        for m in &self.part.measures {
            self.mid += 1.0;
            self.nid = 0.0;
            let last = m.entries.len().wrapping_sub(1);
            for (i, ch) in m.entries.iter().enumerate() {
                // 只有小节中间的换行才算开出一个新小节
                match ch {
                    JpwEntryIn::LineBreak { .. } => {
                        if i != last {
                            self.mid += 1.0;
                            self.nid = 0.0;
                        }
                    }
                    JpwEntryIn::Chord(c) => {
                        self.nid += 1.0;
                        self.on_chord(c)?;
                    }
                    _ => {}
                }
            }
        }
        if let Some(r) = self.refrain {
            self.segs[r].0.pass_last = self.num_verses;
        }
        Ok(())
    }
}

// ───────────────────────── 写出 ─────────────────────────

fn alter(p_alter: &str) -> R<&'static str> {
    Ok(match p_alter {
        "n" => "#b",
        "b" => "b",
        "#" => "#",
        " " | "" | "\0" => "",
        _ => return err("bad jpAlter"),
    })
}

fn octave_marks(s: &mut String, oct: f64) {
    let mut i = 0.0;
    while i < oct {
        s.push('\'');
        i += 1.0;
    }
    let mut i = 0.0;
    while i < -oct {
        s.push(',');
        i += 1.0;
    }
}

/// 倚音：`{` 一串音高 `}`，排在主音之前
fn grace_voice(ch: &JpwChordIn) -> R<String> {
    if ch.grace_notes.is_empty() {
        return Ok(String::new());
    }
    let mut s = String::new();
    for g in &ch.grace_notes {
        if matches!(g.jp_alter.as_str(), "n" | "b" | "#") {
            s += alter(&g.jp_alter)?;
        }
        s += &g.number;
        octave_marks(&mut s, g.jp_octave);
    }
    Ok(format!("{{{s}}}"))
}

fn chord_voice(ch: &JpwChordIn) -> R<String> {
    let Some(nt) = ch.notes.first() else { return err("notes[0]") };
    let mut s = alter(&nt.jp_alter)?.to_string();
    s += &nt.number;
    if !ch.rest {
        octave_marks(&mut s, nt.jp_octave);
    }
    if ch.dot == 1.0 && ch.beats <= 1.0 {
        s.push('.');
    }
    let mut i = 0.0;
    while i < ch.beams {
        s.push('_');
        i += 1.0;
    }
    let mut i = 1.0;
    while i < ch.beats {
        s.push('-');
        i += 1.0;
    }
    Ok(s)
}

fn make_barline(m: &JpwMeasureIn) -> R<&'static str> {
    if m.repeat_backward {
        return Ok(":|");
    }
    Ok(match m.barline.as_deref() {
        Some("none") => "[|]",
        Some("light-light") => "||",
        Some("light-heavy") => "|]",
        Some("heavy-light") => return err("unsupported heavy-light"),
        None | Some("dotted") | Some("regular") => "|",
        Some(_) => return err("bad barline"),
    })
}

fn voice_data(part: &JpwPartIn, lines: &mut Vec<String>) -> R<()> {
    lines.push(".Voice".into());
    let mut l = String::new();
    for (mid, m) in part.measures.iter().enumerate() {
        if mid > 0 && m.new_system && !l.is_empty() {
            l += if m.new_page { "$(true,0,0,true)" } else { "$(true)" };
            lines.push(std::mem::take(&mut l));
        }
        if m.repeat_forward {
            l += "|:";
            if m.ending_left {
                l += "[";
                let Some(nums) = &m.ending_num else { return err("endingNum") };
                if nums.len() == 1 {
                    l += &n(nums[0]);
                } else {
                    return err("multi-ending");
                }
            }
        }
        // 曲中转拍号 / 转调：写在这一小节的音符之前，只在真的变了的时候写
        let prev = if mid > 0 { part.measures.get(mid - 1) } else { None };
        if let Some(p) = prev {
            if m.time_change && (m.time.beats != p.time.beats || m.time.beat_type != p.time.beat_type) {
                l += &format!("{}/{} ", n(m.time.beats), n(m.time.beat_type));
            }
            if m.key_change && m.key.fifths != p.key.fifths {
                l += &format!("\"1={}\" ", m.key.name);
            }
        }
        let mut has_barline = false;
        let last = m.entries.len().wrapping_sub(1);
        for (idx, ch) in m.entries.iter().enumerate() {
            match ch {
                JpwEntryIn::LineBreak { new_page, .. } => {
                    if !has_barline && idx == last {
                        l += make_barline(m)?;
                        has_barline = true;
                    }
                    l += if *new_page { "$(true,0,0,true)" } else { "$(true)" };
                    lines.push(std::mem::take(&mut l));
                }
                JpwEntryIn::Chord(ch) => {
                    let Some(nt) = ch.notes.first() else { return err("notes[0]") };
                    if nt.tie_start {
                        l.push('(');
                    }
                    if ch.slur_start {
                        l.push('(');
                    }
                    if nt.tuplet_begin {
                        l += "{(3}";
                    }
                    if ch.fermata {
                        l += "{YanYin}";
                    }
                    l += &grace_voice(ch)?;
                    l += &chord_voice(ch)?;
                    if nt.tie_end {
                        l.push(')');
                    }
                    if nt.tuplet_end {
                        l.push(')');
                    }
                    l += &")".repeat(js::repeat_count(ch.slur_ends));
                    l.push(' ');
                }
                JpwEntryIn::Barline { position, .. } => {
                    if !position.equals_int(0.0) {
                        let bl = make_barline(m)?;
                        let next = part.measures.get(mid + 1);
                        if next.is_some_and(|x| x.repeat_forward) {
                            // 下一小节的反复起头自己带线
                        } else {
                            // 不画线的小节线（`[|]`）也要写出来；紧跟在另一根线后面要隔开
                            if l.ends_with('|') || l.ends_with(']') {
                                l.push(' ');
                            }
                            l += bl;
                        }
                        has_barline = true;
                    }
                }
                JpwEntryIn::Other => {}
            }
        }
        if !has_barline {
            let bl = make_barline(m)?;
            let next = part.measures.get(mid + 1);
            if !(bl == "|" && next.is_some_and(|x| x.repeat_forward)) {
                l += bl;
            }
        }
    }
    if !js::trim(&l).is_empty() {
        l += "$(true,0,0,true)";
        lines.push(l);
    }
    Ok(())
}

fn meta_data(scr: &JpwScoreIn, lines: &mut Vec<String>) -> R<()> {
    lines.push(".Title".into());
    lines.push(format!("Title = {}", escape(&scr.title)));
    let Some(first) = scr.parts.first().and_then(|p| p.measures.first()) else { return err("no first measure") };
    lines.push(format!("KeyAndMeters = {{1={},{}/{}}}", first.key.name, n(first.time.beats), n(first.time.beat_type)));
    let mut authors: Vec<String> = vec![];
    for it in &scr.credit {
        // 副标题不是著作者（`.Title` 段没有副标题字段，只能丢）
        if matches!(it.kind.as_deref(), Some("title" | "subtitle")) || it.page != 0.0 {
            continue;
        }
        authors.push(escape(js::trim(&it.text)));
    }
    let order = |s: &str| {
        if s.contains('词') {
            5
        } else if s.contains('译') {
            4
        } else if s.contains('曲') {
            3
        } else if s.contains('编') {
            2
        } else {
            1
        }
    };
    authors.sort_by_key(|a| std::cmp::Reverse(order(a)));
    lines.push(format!("WordsByAndMusicBy = {}", authors.join("\\n")));
    if scr.play_data.tempo > 0.0 {
        lines.push(format!("Expression = {{♩={}}}", n(scr.play_data.tempo)));
    }
    Ok(())
}

fn repeat_data(scr: &JpwScoreIn, lines: &mut Vec<String>) {
    if scr.play_data.no_repeat || scr.play_data.measures.is_empty() {
        return;
    }
    lines.push(".Repeat".into());
    for it in &scr.play_data.measures {
        let head = if it.skip > 0.0 { format!("{}.{}", n(it.mid + 1.0), n(it.skip + 1.0)) } else { n(it.mid + 1.0) };
        let tail = if it.limit >= 0.0 { format!("{}.{}", n(it.end), n(it.limit)) } else { n(it.end) };
        lines.push(format!("{head}-{tail}V{}", n(it.pass)));
    }
}

/// 一份满足输入形状的谱 → `.jpwabc` 文本（保留原始排版的换行）
pub fn write_jpwabc(scr: &JpwScoreIn) -> R<String> {
    let mut lines = vec!["// ************** JPW-ABC File Ver 1.0 (for JP-Word v5.50m) **************".to_string()];
    meta_data(scr, &mut lines)?;
    let Some(part) = scr.parts.first() else { return err("parts[0]") };
    voice_data(part, &mut lines)?;
    let mut lyr = Lyrics::new(part);
    lyr.process()?;
    lines.push(".Words".into());
    lyr.lines(&mut lines);
    repeat_data(scr, &mut lines);
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与 TS `writeJpwabc` 同一份输入的输出（逐字节照抄）
    #[test]
    fn small() {
        let ch = |num: &str, lyr: &str, beats: u32| {
            format!(r#"{{"kind":"chord","notes":[{{"number":"{num}","jpOctave":0,"jpAlter":"","tieStart":false,"tieEnd":false,"tupletBegin":false,"tupletEnd":false,"lyrics":[{{"text":"{lyr}","number":1,"refrain":false}}]}}],"rest":false,"dot":0,"beats":{beats},"beams":0,"slurStart":false,"slurEnds":0,"fermata":false,"graceNotes":[]}}"#)
        };
        let m = |entries: Vec<String>, bar: &str| {
            format!(r#"{{"entries":[{}],"newSystem":false,"newPage":false,"repeatForward":false,"repeatBackward":false,"endingLeft":false,"endingNum":null,"timeChange":false,"keyChange":false,"time":{{"beats":4,"beatType":4}},"key":{{"fifths":2,"name":"D"}},"barline":{bar}}}"#, entries.join(","))
        };
        let json = format!(
            r#"{{"title":"甲","credit":[{{"type":"words","page":1,"text":"某"}}],"parts":[{{"measures":[{},{}]}}],"playData":{{"noRepeat":true,"tempo":90,"measures":[]}}}}"#,
            m(vec![ch("1", "我", 1), ch("2", "们", 1), ch("3", "同", 2)], "null"),
            m(vec![ch("5", "心。", 4)], r#""light-heavy""#)
        );
        let s: JpwScoreIn = serde_json::from_str(&json).unwrap();
        let out = write_jpwabc(&s).unwrap();
        assert_eq!(
            out,
            "// ************** JPW-ABC File Ver 1.0 (for JP-Word v5.50m) **************\n.Title\nTitle = 甲\nKeyAndMeters = {1=D,4/4}\nWordsByAndMusicBy = \nExpression = {♩=90}\n.Voice\n1 2 3- |5--- |]$(true,0,0,true)\n.Words\nW1@1,1:\n我们同心。"
        );
        // 写出的再读回来：两小节
        let doc = crate::jpw::read::parse_jpw(&out).ok().flatten().unwrap();
        assert_eq!(doc.songs[0].parts[0].measures.len(), 2);
        // 认不出的字段拒收（门面打形状时漏改会立刻报出来）
        assert!(serde_json::from_str::<JpwScoreIn>(&json.replacen(r#""title""#, r#""x":1,"title""#, 1)).is_err());
    }
}
