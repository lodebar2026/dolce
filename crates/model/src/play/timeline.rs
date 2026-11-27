//! 试听时间轴（TS `score/timeline.ts` 照搬）：按展开的演唱顺序（反复 / 房号 / D.C. / D.S. / Coda，`PlayData.measures`）
//! 把各声部拍平成发声音符、光标锚点、节拍器、拍号调号变化点。MIDI 写出（[`crate::play::midi`]）与编辑器试听共用这一份，
//! 两边才对得上。时间以四分音符为单位。
//!
//! 输入形状由 TS `jianpu/playsong.ts::playSourceOf` 从 `ScoreDoc` 拼（简谱形状 `playSourceOfSong`、
//! MusicXML 形状 `model/playdoc.ts::playSourceOfDoc`），经 `src/engine/play.ts` 编成 JSON。
//! 产物里的和弦用输入里的 `ident` 指（TS 侧按对象编的号，同一个对象同一个号），由 TS 认回对象。

use std::collections::HashMap;

use crate::base::{js, Fraction};
use serde::{Deserialize, Serialize};

use crate::play::playorder::PlayItem;

/// 谱面没标速度时的 ♩=
pub const TEMPO: f64 = 90.0;
/// 力度缺省（没有力度记号时的 note-on velocity）。TS 胶水 `model/playdoc.ts` 拼输入时也用这个数。
pub const DEFAULT_VELOCITY: f64 = 100.0;

/// 混音选项（MIDI 导出与试听共用）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct PlayOptions {
    /// 各声部线性音量 `[0,1]`，下标 = 声部序；缺（JSON null）= 1
    #[serde(default)]
    pub part_volumes: Option<Vec<Option<f64>>>,
    /// 试听时打节拍器（每拍一声，小节第一拍重）
    #[serde(default)]
    pub metronome: Option<bool>,
    /// 播放速度倍率（1 = 谱面标注速度），夹在 [0.25, 3]；缺或 NaN（JSON null）= 1
    #[serde(default)]
    pub speed: Option<f64>,
}

// ───────────────────────── 输入形状 ─────────────────────────

/// 一个音底下的一段歌词（一个字，收尾标点已并进 `text`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct TimelineLyric {
    pub text: String,
    /// 段号：第几遍唱它（同 `PlayItem::pass`）
    pub number: f64,
    /// 副歌：各遍共用
    #[serde(default)]
    pub refrain: bool,
    /// 续记号（123 的 `_`、MusicXML `<extend>`）：后面紧接的无字音接着唱这个字
    #[serde(default)]
    pub extend: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct TimelineNote {
    /// MIDI 音高
    pub pitch: f64,
    /// 延音线收尾：前一个同音高的音若首尾相接，就延长它、不再起音
    #[serde(default)]
    pub tie_stop: bool,
    /// 歌词（只看和弦第一个音的）
    #[serde(default)]
    pub lyrics: Vec<TimelineLyric>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct TimelineChord {
    /// 和弦的身份（TS 侧按对象编的号）：产物里用它指和弦，光标锚点的 `occ` 也按它数
    pub ident: usize,
    /// 模型里的元素 id（高亮、起播点按它认；判据不读）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<u32>,
    pub notes: Vec<TimelineNote>,
    pub rest: bool,
    /// 小节内位置（四分音符为 1）
    pub position: Fraction,
    #[serde(default)]
    pub duration: Option<Fraction>,
    /// note-on 力度 1..127，缺省 [`DEFAULT_VELOCITY`]
    #[serde(default)]
    pub velocity: Option<f64>,
    /// false = 不当光标锚点（同一声部里的副 voice）。缺省 true
    #[serde(default)]
    pub cursor: Option<bool>,
    /// 连音弧从这个和弦起 / 在这儿收几条（判一字多音用：弧里没字的音唱前一个字）
    #[serde(default)]
    pub slur_start: bool,
    #[serde(default)]
    pub slur_ends: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct TimeSig {
    pub beats: f64,
    pub beat_type: f64,
}

/// 小节的调号（导出 MIDI 写 `FF 59` 用）：实际发声的调，`minor` 是小调
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct TimelineKey {
    pub fifths: f64,
    pub minor: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct TimelineMeasure {
    /// 小节里的和弦（TS 只取 `isTimelineChord` 的那些，次序不变）
    pub chords: Vec<TimelineChord>,
    /// 小节时值（末和弦的位置 + 时值）；None = 没有和弦（按拍号算小节长）
    #[serde(default)]
    pub duration: Option<Fraction>,
    pub time: TimeSig,
    /// 调号（随曲中转调）。不给就不写调号事件
    #[serde(default)]
    pub key: Option<TimelineKey>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct TimelinePart {
    /// 按各声部共用的时间轴排：这一声部在某格没有小节就是 None
    pub measures: Vec<Option<TimelineMeasure>>,
    /// 声部名（MIDI 轨名）
    #[serde(default)]
    pub name: Option<String>,
}

/// 演唱顺序里试听要用的那几项（TS `PlayData` 的 `measures` 与 `tempo`）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct PlaySourceOrder {
    pub measures: Vec<PlayItem>,
    /// 谱面速度（♩=），0 = 未标注
    #[serde(default)]
    pub tempo: f64,
    /// `PlayItem::scope` 指的段落小节表
    #[serde(default)]
    pub scopes: Vec<Vec<f64>>,
}

/// 一份可播的谱：各声部 + 演唱顺序（含速度）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct PlaySource {
    pub parts: Vec<TimelinePart>,
    pub play_data: PlaySourceOrder,
    /// 主旋律声部（演唱顺序按它推、光标跟它、同刻起音先取它）。缺省 0
    #[serde(default)]
    pub lead: Option<usize>,
}

// ───────────────────────── 产物 ─────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct TimedNote {
    pub t0: f64,
    pub t1: f64,
    pub pitch: f64,
    pub part: usize,
    pub velocity: f64,
    /// 和弦的 `ident`
    pub chord: usize,
    /// 这一遍唱的字；一字多音的后几个音是 `-`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lyric: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct Anchor {
    pub t0: f64,
    /// 和弦的 `ident`
    pub chord: usize,
    /// 第几遍（同 `PlayItem::pass`）
    pub pass: f64,
    /// 同一个和弦、同一个 `pass` 在这份锚点表里第几次出现（0 起，0 不写）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occ: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct Signature {
    pub t: f64,
    pub time: TimeSig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<TimelineKey>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct Click {
    pub t: f64,
    pub down: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct Timeline {
    /// 拍号 / 调号的变化点（按演唱顺序展开，首项在 t=0；读主旋律声部的小节）
    pub signatures: Vec<Signature>,
    pub notes: Vec<TimedNote>,
    /// 主旋律的起音和弦（按 t0 升序），光标跟它
    pub anchors: Vec<Anchor>,
    /// 所有声部、所有 voice 的起音和弦（按 t0 升序，同刻主旋律在前、其余按声部序）。五线谱的竖直播放线跟它走
    pub all_anchors: Vec<Anchor>,
    /// 节拍器每一拍；`down` = 小节第一拍。复拍子（6/8、9/8、12/8）按附点四分打
    pub clicks: Vec<Click>,
    /// 总长（四分音符）
    pub duration: f64,
}

// ───────────────────────── 计算 ─────────────────────────

/// 实际播放速度 = 谱面 ♩=（无则 90）× 用户倍率。
pub fn play_tempo(tempo: f64, opts: Option<&PlayOptions>) -> f64 {
    let base = if tempo > 0.0 { tempo } else { TEMPO };
    let k = match opts.and_then(|o| o.speed) {
        None => 1.0,
        Some(m) if m.is_nan() => 1.0,
        Some(m) => js_max(0.25, js_min(3.0, m)),
    };
    base * k
}

/// 各声部线性音量 `[0,1]`，没设为 1。
pub fn part_gain(opts: Option<&PlayOptions>, part: usize) -> f64 {
    match opts.and_then(|o| o.part_volumes.as_ref()).and_then(|v| v.get(part).copied().flatten()) {
        None => 1.0,
        Some(v) if v.is_nan() => 1.0,
        Some(v) => js_max(0.0, js_min(1.0, v)),
    }
}

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// 去掉歌词条目前的印刷段号（`/^\d+\.(?=.)/`，`1.圣` → `圣`），再 `trim()`。
fn strip_verse_prefix(text: &str) -> &str {
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let stripped = if i > 0 && i < b.len() && b[i] == b'.' {
        // `(?=.)`：后面还有一个不是行终止符的字
        match text[i + 1..].chars().next() {
            Some(c) if !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') => &text[i + 1..],
            _ => text,
        }
    } else {
        text
    };
    js::trim(stripped)
}

/// 第 `pass` 遍唱的字：段号对上的那段，没有就取副歌。`borrow`：这一格在第 `pass` 段整首最后一个字之后
/// （这一段的词唱完了，副歌只写在第 1 段），借段号最小的、这一格写了字的那段——与投影档同一判据（`place/expand.ts::afterVerseEnd`）。
fn lyric_of_pass(note: Option<&TimelineNote>, pass: f64, borrow: bool) -> Option<(String, bool)> {
    let lyrics = &note?.lyrics;
    if lyrics.is_empty() {
        return None;
    }
    let has = |x: &TimelineLyric| !strip_verse_prefix(&x.text).is_empty();
    let mut l = lyrics.iter().find(|x| x.number == pass).or_else(|| lyrics.iter().find(|x| x.refrain));
    if borrow && !l.is_some_and(has) {
        let mut cands: Vec<&TimelineLyric> = lyrics.iter().filter(|x| has(x)).collect();
        js::sort_by(&mut cands, |a, b| a.number - b.number);
        l = cands.first().copied().or(l);
    }
    let l = l?;
    let text = strip_verse_prefix(&l.text);
    if text.is_empty() {
        return None;
    }
    Some((text.to_string(), l.extend))
}

/// 轴上第 `mid` 格的「代表小节」：主旋律的，主旋律在这一格没有小节就取第一个有的声部（拍号、按和弦截断都看它）。
fn lead_measure(src: &PlaySource, mid: usize) -> Option<&TimelineMeasure> {
    let lead = src.lead.unwrap_or(0);
    src.parts
        .get(lead)
        .and_then(|p| p.measures.get(mid))
        .and_then(|m| m.as_ref())
        .or_else(|| src.parts.iter().find_map(|p| p.measures.get(mid).and_then(|m| m.as_ref())))
}

/// 小节长（四分音符），各声部取最大，没有和弦的按拍号。
fn measure_len(src: &PlaySource, mid: usize) -> f64 {
    let mut len = 0.0;
    for part in &src.parts {
        let Some(Some(m)) = part.measures.get(mid) else { continue };
        let x = match m.duration {
            Some(d) => d.to_float(),
            None => (m.time.beats * 4.0) / m.time.beat_type,
        };
        len = js_max(len, x);
    }
    len
}

/// 第 `limit` 个和弦唱完时的小节内位置（四分音符为单位；数的是主旋律声部的和弦，同演唱顺序）。
fn chord_end(src: &PlaySource, mid: f64, limit: f64) -> f64 {
    let m = if mid >= 0.0 && mid.fract() == 0.0 { lead_measure(src, mid as usize) } else { None };
    let Some(m) = m else { return f64::INFINITY };
    let mut n = 0.0;
    for c in &m.chords {
        n += 1.0;
        if n == limit {
            return c.position.to_float() + c.duration.map_or(0.0, |d| d.to_float());
        }
    }
    f64::INFINITY
}

struct Range<'a> {
    mid: f64,
    end: f64,
    offset: f64,
    pass: f64,
    until: f64,
    scope: Option<&'a [f64]>,
    scope_key: Option<usize>,
}

/// 展开的演唱顺序：`[mid, end)` 小节段 + 起点偏移 + 遍号；`until` 截掉末小节的后半（`PlayItem::limit`）。
fn play_ranges(src: &PlaySource) -> Vec<Range<'_>> {
    let items = &src.play_data.measures;
    if !items.is_empty() {
        return items
            .iter()
            .map(|p| Range {
                mid: p.mid,
                end: p.end,
                offset: p.offset.to_float(),
                pass: p.pass,
                until: if p.limit >= 0.0 { chord_end(src, p.end - 1.0, p.limit) } else { f64::INFINITY },
                scope: p.scope.and_then(|i| src.play_data.scopes.get(i)).map(|v| v.as_slice()),
                scope_key: p.scope,
            })
            .collect();
    }
    // 没有展开的顺序：整曲一遍
    let n = src.parts.iter().map(|p| p.measures.len()).max().unwrap_or(0);
    if n > 0 {
        vec![Range { mid: 0.0, end: n as f64, offset: 0.0, pass: 1.0, until: f64::INFINITY, scope: None, scope_key: None }]
    } else {
        vec![]
    }
}

/// 各声部各段最后一个字落在哪（小节、和弦下标）。
type VerseEnds = Vec<Vec<(f64, (usize, usize))>>;

fn verse_ends_in(src: &PlaySource, scope: Option<&[f64]>) -> VerseEnds {
    src.parts
        .iter()
        .map(|part| {
            let mut end: Vec<(f64, (usize, usize))> = vec![];
            for (mid, m) in part.measures.iter().enumerate() {
                if let Some(s) = scope {
                    if !s.contains(&(mid as f64)) {
                        continue;
                    }
                }
                let Some(m) = m else { continue };
                for (i, c) in m.chords.iter().enumerate() {
                    let Some(n0) = c.notes.first() else { continue };
                    for l in &n0.lyrics {
                        if !strip_verse_prefix(&l.text).is_empty() {
                            match end.iter_mut().find(|(k, _)| *k == l.number) {
                                Some(e) => e.1 = (mid, i),
                                None => end.push((l.number, (mid, i))),
                            }
                        }
                    }
                }
            }
            end
        })
        .collect()
}

struct Sung {
    note: usize,
    pass: f64,
    /// 这条拖腔链起头的字带续记号（后面的 `-` 是谱上写明的，不撤）
    held: bool,
}

pub fn build_timeline(src: &PlaySource) -> Timeline {
    let mut notes: Vec<TimedNote> = vec![];
    let mut signatures: Vec<Signature> = vec![];
    let mut anchors: Vec<Anchor> = vec![];
    // 起音和弦 + 所在声部
    let mut all_anchors: Vec<(Anchor, usize)> = vec![];
    let mut clicks: Vec<Click> = vec![];
    let mut pos = 0.0f64;
    // 各声部各音高最近一个音（延音线收尾时找它延长）
    let mut last_by_pitch: HashMap<(usize, String), usize> = HashMap::new();
    // 各声部最近一个起音的旋律音（和弦第一个音），判一字多音用
    let mut last_sung: HashMap<usize, Sung> = HashMap::new();
    let lead = src.lead.unwrap_or(0);
    // 各声部当前开着几条弧
    let mut slur_depth: HashMap<usize, f64> = HashMap::new();
    // 记了 `-` 但不在弧里的音（行中间的 `_`）：这一遍后面要是再没有字，说明词已唱完，撤掉
    let mut loose_dash: Vec<(usize, f64)> = vec![];
    // 各声部各段最后一个字落在哪，借词判「这一段唱完了」用。按 `P:` 排的只在本段落里数，否则数整首
    let mut verse_ends: HashMap<Option<usize>, VerseEnds> = HashMap::new();
    // 各声部各遍最后一个有字的音的起点
    let mut last_word: HashMap<(usize, String), f64> = HashMap::new();
    let pass_key = |pi: usize, pass: f64| (pi, js::num_to_string(pass));

    for range in play_ranges(src) {
        let mut mid_f = range.mid;
        while mid_f < range.end {
            let start_offset = if mid_f == range.mid { range.offset } else { 0.0 };
            let end_offset = if mid_f == range.end - 1.0 { range.until } else { f64::INFINITY };
            // 小节下标不是整数或为负：TS 取不到小节，整格空过（时值也是 0）
            let mid = if mid_f >= 0.0 && mid_f.fract() == 0.0 { Some(mid_f as usize) } else { None };
            let signature = mid.and_then(|m| lead_measure(src, m));
            if let Some(sig) = signature {
                let changed = match signatures.last() {
                    None => true,
                    Some(p) => {
                        p.time.beats != sig.time.beats
                            || p.time.beat_type != sig.time.beat_type
                            || p.key.map(|k| k.fifths) != sig.key.map(|k| k.fifths)
                            || p.key.map(|k| k.minor) != sig.key.map(|k| k.minor)
                    }
                };
                if changed {
                    signatures.push(Signature { t: pos, time: sig.time, key: sig.key });
                }
            }
            for (pi, part) in src.parts.iter().enumerate() {
                let Some(Some(m)) = mid.and_then(|mid| part.measures.get(mid)) else { continue };
                let mid = mid.expect("上面取到了小节");
                for (ei, ent) in m.chords.iter().enumerate() {
                    let cp = ent.position.to_float();
                    if cp < start_offset {
                        continue; // 跳转从小节中间接入，前半截不唱
                    }
                    if cp >= end_offset {
                        continue; // `PlayItem::limit` 截掉的后半
                    }
                    let t0 = pos + (cp - start_offset);
                    let t1 = t0 + ent.duration.map_or(0.0, |d| d.to_float());
                    if pi == lead && !ent.rest && ent.cursor != Some(false) {
                        anchors.push(Anchor { t0, chord: ent.ident, pass: range.pass, occ: None });
                    }
                    if !ent.rest {
                        all_anchors.push((Anchor { t0, chord: ent.ident, pass: range.pass, occ: None }, pi));
                    }
                    if ent.rest {
                        continue;
                    }
                    let velocity = ent.velocity.unwrap_or(DEFAULT_VELOCITY);
                    // 收弧的那个音也在弧里；起弧的那个是带字的
                    let depth = slur_depth.get(&pi).copied().unwrap_or(0.0);
                    let in_slur = depth > 0.0;
                    slur_depth.insert(pi, js_max(0.0, depth + if ent.slur_start { 1.0 } else { 0.0 } - ent.slur_ends));
                    for (k, nt) in ent.notes.iter().enumerate() {
                        let key = (pi, js::num_to_string(nt.pitch));
                        let prev = if nt.tie_stop { last_by_pitch.get(&key).copied() } else { None };
                        // 只接首尾相接的那个：反复跳转、中间隔了休止都照常起音
                        if let Some(p) = prev {
                            if (notes[p].t1 - t0).abs() < 1e-6 {
                                notes[p].t1 = t1;
                                continue;
                            }
                        }
                        let mut tn = TimedNote { t0, t1, pitch: nt.pitch, part: pi, velocity, chord: ent.ident, lyric: None };
                        let idx = notes.len();
                        if k == 0 {
                            // 这一遍没字、紧接着同一遍里上一个有字（或也在拖腔）的音：一字多音，记 `-`。隔了休止、换了一遍都不算。
                            // 起头的字带续记号的是谱上写明的；没写的，在弧里、或这一遍后面还有字才算（否则是这一遍的词唱完了，见 `loose_dash`）
                            let before = last_sung.get(&pi);
                            let follows = before.is_some_and(|b| b.pass == range.pass && (notes[b.note].t1 - t0).abs() < 1e-6);
                            let after_end = {
                                let ends = verse_ends.entry(range.scope_key).or_insert_with(|| verse_ends_in(src, range.scope));
                                match ends[pi].iter().find(|(n, _)| *n == range.pass) {
                                    // 整首没这一段的词：一律借（同投影档）
                                    None => true,
                                    Some((_, (em, ei2))) => mid > *em || (mid == *em && ei > *ei2),
                                }
                            };
                            let word = lyric_of_pass(Some(nt), range.pass, after_end);
                            tn.lyric = match &word {
                                Some((text, _)) => Some(text.clone()),
                                None => {
                                    if follows && notes[before.expect("follows 已判").note].lyric.is_some() {
                                        Some("-".to_string())
                                    } else {
                                        None
                                    }
                                }
                            };
                            let held = match &word {
                                Some((_, extend)) => *extend,
                                None => tn.lyric.is_some() && before.expect("有 `-` 必有前音").held,
                            };
                            if word.is_some() {
                                last_word.insert(pass_key(pi, range.pass), t0);
                            } else if tn.lyric.is_some() && !held && !in_slur {
                                loose_dash.push((idx, range.pass));
                            }
                            // 与上一个音重叠、又没字的（同一声部里的副 voice）不顶替它，免得把主旋律的拖腔链打断
                            let replace = tn.lyric.is_some()
                                || match before {
                                    None => true,
                                    Some(b) => t0 > notes[b.note].t1 - 1e-6 || b.pass != range.pass,
                                };
                            if replace {
                                last_sung.insert(pi, Sung { note: idx, pass: range.pass, held });
                            }
                        }
                        notes.push(tn);
                        last_by_pitch.insert(key, idx);
                    }
                }
            }
            let len = js_min(mid.map_or(0.0, |m| measure_len(src, m)), end_offset);
            if let Some(time) = mid.and_then(|m| lead_measure(src, m)).map(|m| m.time) {
                let compound = time.beat_type == 8.0 && time.beats % 3.0 == 0.0 && time.beats > 3.0;
                let beat = (4.0 / time.beat_type) * if compound { 3.0 } else { 1.0 };
                // 曲首弱起小节（不满一整小节）是一小节的**后半截**：拍点从整小节的哪儿数起要往后挪，重拍不落在它头上
                let full = (time.beats * 4.0) / time.beat_type;
                let shift = if mid == Some(0) && len < full - 1e-9 { full - len } else { 0.0 };
                let mut k = ((shift + start_offset) / beat - 1e-9).ceil();
                while k * beat < shift + len - 1e-9 {
                    clicks.push(Click { t: pos + k * beat - shift - start_offset, down: k == 0.0 });
                    k += 1.0;
                }
            }
            pos += len - start_offset;
            mid_f += 1.0;
        }
    }

    for (note, pass) in loose_dash {
        let last = last_word.get(&pass_key(notes[note].part, pass)).copied().unwrap_or(f64::NEG_INFINITY);
        if notes[note].t0 > last {
            notes[note].lyric = None;
        }
    }
    js::sort_by(&mut anchors, |a, b| a.t0 - b.t0);
    // 稳定排序：同刻的主旋律在前（播放线同刻只停一处，停在它上面——投影档只画它），其余按声部序
    let rank = |p: usize| if p == lead { 0.0 } else { 1.0 };
    js::sort_by(&mut all_anchors, |a, b| {
        let d = a.0.t0 - b.0.t0;
        if d != 0.0 && !d.is_nan() {
            d
        } else {
            rank(a.1) - rank(b.1)
        }
    });
    let mut all_anchors: Vec<Anchor> = all_anchors.into_iter().map(|(a, _)| a).collect();
    for list in [&mut anchors, &mut all_anchors] {
        let mut seen: HashMap<(usize, String), f64> = HashMap::new();
        for a in list.iter_mut() {
            let c = seen.entry((a.chord, js::num_to_string(a.pass))).or_insert(0.0);
            let n = *c;
            *c = n + 1.0;
            if n > 0.0 {
                a.occ = Some(n);
            }
        }
    }
    Timeline { signatures, notes, anchors, all_anchors, clicks, duration: pos }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chord(ident: usize, pos: f64, pitch: f64, lyric: Option<&str>) -> TimelineChord {
        TimelineChord {
            id: None,
            ident,
            notes: vec![TimelineNote {
                pitch,
                tie_stop: false,
                lyrics: lyric.map(|t| vec![TimelineLyric { text: t.into(), number: 1.0, refrain: false, extend: false }]).unwrap_or_default(),
            }],
            rest: false,
            position: Fraction::new(pos, 1.0),
            duration: Some(Fraction::int(1.0)),
            velocity: None,
            cursor: None,
            slur_start: false,
            slur_ends: 0.0,
        }
    }

    #[test]
    fn one_pass() {
        let m = TimelineMeasure {
            chords: vec![chord(0, 0.0, 60.0, Some("1.圣")), chord(1, 1.0, 62.0, None), chord(2, 2.0, 64.0, Some("哉"))],
            duration: Some(Fraction::int(3.0)),
            time: TimeSig { beats: 3.0, beat_type: 4.0 },
            key: None,
        };
        let src = PlaySource { parts: vec![TimelinePart { measures: vec![Some(m)], name: None }], play_data: PlaySourceOrder::default(), lead: None };
        let tl = build_timeline(&src);
        assert_eq!(tl.duration, 3.0);
        let lyr: Vec<Option<&str>> = tl.notes.iter().map(|n| n.lyric.as_deref()).collect();
        assert_eq!(lyr, vec![Some("圣"), Some("-"), Some("哉")]);
        assert_eq!(tl.clicks.len(), 3);
        assert!(tl.clicks[0].down);
        assert_eq!(tl.anchors.len(), 3);
    }

    #[test]
    fn tempo_and_gain() {
        let o = PlayOptions { part_volumes: Some(vec![Some(0.5), None]), metronome: None, speed: Some(5.0) };
        assert_eq!(play_tempo(0.0, Some(&o)), 270.0);
        assert_eq!(part_gain(Some(&o), 0), 0.5);
        assert_eq!(part_gain(Some(&o), 1), 1.0);
        assert_eq!(strip_verse_prefix("12.x "), "x");
        assert_eq!(strip_verse_prefix("1."), "1.");
    }
}
